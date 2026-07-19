import { decodeFunctionData } from "viem";
import { lifiDiamondAbi } from "../../abis/lifi-diamond.js";
import { tryDecodeLifiBridgeData } from "../../signing/decode-calldata.js";

/**
 * #685 — LiFi provider-baked min-out reachability gate.
 *
 * On the LiFi aggregator path the on-chain `_minAmountOut` is baked by LiFi,
 * not computed by the MCP. When a principal skim (integrator fee, pre-swap
 * fee-forwarder leg) is deducted BEFORE the measured swap leg, LiFi can bake a
 * min-out sized off the GROSS input while only the NET reaches the swap — the
 * facet then reverts `CumulativeSlippageTooHigh` by construction, independent
 * of live price (issue #685).
 *
 * The only lever the MCP owns route-agnostically is the quote-request
 * `slippage`. `vetGenericSwapQuote` decodes the calldata, quantifies every
 * principal skim as a same-denomination fraction, and decides whether LiFi's
 * baked min-out is reachable (SHIP), needs a fee-padded re-quote (REQUOTE), or
 * cannot be proven reachable (REFUSE). It runs on the GENERIC-SWAP class only —
 * the sole class with a same-denomination local reference (`estimate.toAmount`,
 * the output token, same token as the baked `_minAmountOut`/`_minAmount`).
 *
 * Bridges have no same-denomination local reference (their baked
 * `BridgeData.minAmount` is source-side; the achievable reference is on the
 * destination chain, unreadable at prepare time), so they are NOT gated here —
 * they ship via their existing prepare path and carry a source-side-only
 * suspected-unreachable signal (`bridgeSuspectedUnreachable`). No
 * cross-denominated `minAmount / toAmount` ratio is ever computed.
 *
 * Security posture (§3.4) is UNCHANGED: this reuses `lifiDiamondAbi` +
 * `tryDecodeLifiBridgeData` (the ABI + parse the signing path already runs),
 * pins no destination, and touches no `classifyDestination` / B5 / `allowedAbi`.
 * It is min-out-correctness only, never a gate on the pre-sign path.
 */

/** Fixed-point scale for skim/slippage fractions (bigint arithmetic, no float drift). */
const SCALE = 10n ** 18n;

/** LiFi SDK default slippage when the caller passes none (0.5%). */
export const LIFI_DEFAULT_SLIPPAGE = 0.005;

/**
 * Effective slippage (user + fee pad) beyond this is REFUSED, never clamped —
 * clamping below the fee fraction re-reverts. `userSlippage` is already
 * schema-capped at 500 bps (5%); a fee pad pushing the effective past 50% means
 * a pathological route, not a fee. Live-verify item R1-adjacent: LiFi's exact
 * max accepted slippage is not pinned, so this is a conservative sanity ceiling.
 */
export const MAX_EFFECTIVE_SLIPPAGE = 0.5;

export type VetVerdict =
  | { kind: "SHIP"; feeFraction: number }
  | { kind: "REQUOTE"; feeFraction: number }
  | { kind: "REFUSE"; reason: string };

/** Minimal shape the gate reads off a LiFi quote (mock-friendly, SDK-compatible). */
export interface LifiQuoteLike {
  action: { fromToken: { address: string }; fromAmount: string };
  estimate: {
    toAmount: string;
    feeCosts?: ReadonlyArray<{
      token?: { address?: string };
      amount?: string;
      included?: boolean;
    }>;
  };
  transactionRequest?: { data?: string } | null;
}

interface DecodedSwapLeg {
  sendingAssetId: string;
  receivingAssetId: string;
  fromAmount: bigint;
}

/** `ceil(a / b)` for a ≥ 0, b > 0. */
function ceilDiv(a: bigint, b: bigint): bigint {
  return (a + b - 1n) / b;
}

/**
 * Classify a LiFi calldata by SELECTOR (never by `to` — pinning
 * `to == LIFI_DIAMOND` would breach §3.4). Selector-first ordering is
 * load-bearing: a generic-swap calldata is classified as "generic" before the
 * positional bridge decode can mis-read it.
 *
 *   - "generic": one of the seven generic-swap selectors → same-denomination
 *     reachability class (run the leg-walk).
 *   - "bridge":  NOT a generic-swap selector but a decodable `BridgeData` tuple
 *     → ships via the existing prepare path + source-side instrumentation.
 *   - "unknown": neither → REFUSE (unknown / new facet).
 */
export function classifyLifiQuote(data: `0x${string}`): "generic" | "bridge" | "unknown" {
  try {
    decodeFunctionData({ abi: lifiDiamondAbi, data });
    return "generic";
  } catch {
    // Not a generic-swap selector — fall through to the bridge decode.
  }
  if (tryDecodeLifiBridgeData(data)) return "bridge";
  return "unknown";
}

/**
 * The reachability gate for the GENERIC-SWAP class. Decodes `_swapData[]`,
 * walks the leg chain, sizes every principal skim as a same-token fraction, and
 * compares the applied slippage (baked min-out vs `estimate.toAmount`, both in
 * the output token) against the summed skim fraction.
 *
 * Opposed rounding — `feeFraction` UP, `appliedSlippage` DOWN — makes both err
 * toward REFUSE, killing float/bigint false-passes near equality.
 */
export function vetGenericSwapQuote(
  quote: LifiQuoteLike,
  sourceToken: string,
): VetVerdict {
  const data = quote.transactionRequest?.data;
  if (!data) return { kind: "REFUSE", reason: "quote carries no transactionRequest calldata" };

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: lifiDiamondAbi, data: data as `0x${string}` });
  } catch {
    return { kind: "REFUSE", reason: "could not decode generic-swap calldata" };
  }
  const rawArgs = decoded.args ?? [];
  // ABI shape: [_transactionId, _integrator, _referrer, _receiver, minOut, _swapData]
  const minOutBaked = rawArgs[4] as bigint | undefined;
  const rawSwapData = rawArgs[5];
  if (typeof minOutBaked !== "bigint" || rawSwapData === undefined) {
    return { kind: "REFUSE", reason: "generic-swap calldata missing min-out / swapData" };
  }
  const legs = (Array.isArray(rawSwapData) ? rawSwapData : [rawSwapData]) as DecodedSwapLeg[];
  if (legs.length === 0) {
    return { kind: "REFUSE", reason: "generic-swap route has no swap legs" };
  }

  const src = sourceToken.toLowerCase();
  const actionFromAmount = BigInt(quote.action.fromAmount);

  // Topology: first leg sells the source token at the quoted amount, and each
  // successor sells the token its predecessor produced. A split / gap / drift
  // the gate cannot reason about → REFUSE.
  if (legs[0].sendingAssetId.toLowerCase() !== src) {
    return { kind: "REFUSE", reason: "first swap leg does not sell the source token" };
  }
  if (legs[0].fromAmount !== actionFromAmount) {
    return { kind: "REFUSE", reason: "first swap leg fromAmount ≠ quote fromAmount" };
  }
  for (let i = 0; i < legs.length - 1; i++) {
    if (legs[i + 1].sendingAssetId.toLowerCase() !== legs[i].receivingAssetId.toLowerCase()) {
      return { kind: "REFUSE", reason: "swap-leg token chain is broken (incoherent route)" };
    }
  }

  // Fee-leg marker = `sendingAssetId == receivingAssetId` (a token-unchanged
  // pass-through can only forward or skim; a DEX/wrap leg always changes the
  // token). NOT `requiresDeposit` — that fires on leg 0 of every route.
  let feeDecodeScaled = 0n;
  let passThroughCount = 0;
  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    if (leg.sendingAssetId.toLowerCase() !== leg.receivingAssetId.toLowerCase()) continue;
    passThroughCount++;
    if (i === legs.length - 1) {
      // Trailing pass-through: its skim is unsizeable (no successor amount).
      return { kind: "REFUSE", reason: "route ends on a pass-through fee leg (unsizeable skim)" };
    }
    const next = legs[i + 1];
    if (leg.fromAmount === 0n) {
      return { kind: "REFUSE", reason: "pass-through fee leg has zero fromAmount" };
    }
    if (next.fromAmount > leg.fromAmount) {
      return { kind: "REFUSE", reason: "pass-through fee leg has a negative skim (successor amount grew)" };
    }
    feeDecodeScaled += ceilDiv((leg.fromAmount - next.fromAmount) * SCALE, leg.fromAmount);
  }

  // Corroboration only (never a standalone ship signal): source-token fee
  // entries that are actually skimmed from the principal (`included !== false`;
  // an `included: false` fee is charged on top, not deducted from swap input).
  let sourceFeeSum = 0n;
  for (const fc of quote.estimate.feeCosts ?? []) {
    if (fc.included === false) continue;
    if ((fc.token?.address ?? "").toLowerCase() !== src) continue;
    sourceFeeSum += BigInt(fc.amount ?? "0");
  }
  const feeCostsScaled =
    actionFromAmount > 0n ? ceilDiv(sourceFeeSum * SCALE, actionFromAmount) : 0n;
  const feeFractionScaled = feeDecodeScaled > feeCostsScaled ? feeDecodeScaled : feeCostsScaled;
  const feeFraction = Number(feeFractionScaled) / Number(SCALE);

  // Applied slippage from the DECODED baked min-out (the value the chain
  // reverts against), against `estimate.toAmount` — same output token, so the
  // ratio is a valid dimensionless slippage. ROUNDED DOWN (bigint floor).
  const toAmount = BigInt(quote.estimate.toAmount);
  if (toAmount <= 0n) {
    return { kind: "REFUSE", reason: "quote reports non-positive expected output" };
  }
  if (minOutBaked > toAmount) {
    // Negative applied slippage — unreachable at the quote rate even with no
    // skim detected. Fee-absence is never sufficient; reachability is.
    return {
      kind: "REFUSE",
      reason: "baked min-out exceeds the quoted output amount (unreachable at the quote rate)",
    };
  }
  const appliedScaled = ((toAmount - minOutBaked) * SCALE) / toAmount;

  if (passThroughCount === 0 && feeFractionScaled === 0n) {
    // Proven clean, zero extra round-trips.
    return { kind: "SHIP", feeFraction: 0 };
  }
  if (appliedScaled >= feeFractionScaled) {
    // The baked min-out already absorbs the skim — reachability, not
    // fee-absence, is the ship criterion (caps double-widening / MEV give-up).
    return { kind: "SHIP", feeFraction };
  }
  return { kind: "REQUOTE", feeFraction };
}

/**
 * Source-side-only suspected-unreachable proxy for a BRIDGE-class route
 * (PROD option (C), design §4.2 step 6; predicate is DEV live-verify item R6).
 *
 * Every operand is denominated in the SOURCE token — `BridgeData.minAmount`
 * (source-side, sits with `sendingAssetId`), `action.fromAmount`, and
 * source-token `feeCosts`. It NEVER reads `estimate.toAmount`, so no
 * cross-denominated ratio is ever computed and it cannot fail open on a
 * decimals-up bridge. It only ever LOGS + COUNTS — it never REFUSEs and never
 * adjusts a min-out; a wrong predicate mis-counts a read-only diagnostic.
 *
 * Predicate: flag when the bridge's baked source-side min-out exceeds what
 * remains of the principal after the detectable source-side skim — i.e. the
 * baked minimum cannot be met by the amount actually reaching the bridge.
 * Evaluated ONLY when `sendingAssetId == sourceToken` (so `minAmount` shares a
 * denomination with `action.fromAmount`); when a source swap changes the token
 * there is no same-denomination source reference and the route is not flagged.
 */
export function bridgeSuspectedUnreachable(
  quote: LifiQuoteLike,
  sourceToken: string,
): boolean {
  const data = quote.transactionRequest?.data;
  if (!data) return false;
  const decoded = tryDecodeLifiBridgeData(data as `0x${string}`);
  if (!decoded) return false;

  const src = sourceToken.toLowerCase();
  // Denomination guard: only comparable when the bridged (baked) token is the
  // source token. Otherwise `minAmount` and `action.fromAmount` differ in
  // denomination — do not flag (under-counting a diagnostic is safe).
  if (decoded.sendingAssetId.toLowerCase() !== src) return false;

  const actionFromAmount = BigInt(quote.action.fromAmount);
  let sourceFeeSum = 0n;
  for (const fc of quote.estimate.feeCosts ?? []) {
    if (fc.included === false) continue;
    if ((fc.token?.address ?? "").toLowerCase() !== src) continue;
    sourceFeeSum += BigInt(fc.amount ?? "0");
  }
  const netSource = actionFromAmount - sourceFeeSum;
  return decoded.minAmount > netSource;
}
