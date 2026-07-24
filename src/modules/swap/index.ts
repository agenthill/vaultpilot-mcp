import { parseUnits, formatUnits, encodeFunctionData, getAddress } from "viem";
import { fetchQuote } from "./lifi.js";
import { fetchOneInchQuote, fetchOneInchSwap } from "./oneinch.js";
import type { GetSwapQuoteArgs, PrepareSwapArgs } from "./schemas.js";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { readUserConfig, resolveOneInchApiKey } from "../../config/user-config.js";
import { SOLANA_ADDRESS, TRON_ADDRESS } from "../../shared/address-patterns.js";
import {
  tryDecodeLifiBridgeData,
  type DecodedLifiBridgeData,
} from "../../signing/decode-calldata.js";
import { NON_EVM_RECEIVER_SENTINEL } from "../../abis/lifi-diamond.js";
import { matchIntermediateChainBridge } from "./intermediate-chain-bridges.js";
import {
  classifyLifiQuote,
  vetGenericSwapQuote,
  bridgeSuspectedUnreachable,
  decodeGenericSwapReceiver,
  LIFI_DEFAULT_SLIPPAGE,
  MAX_EFFECTIVE_SLIPPAGE,
  type LifiQuoteLike,
} from "./vet-lifi-quote.js";
import { mevExposureNote } from "./mev-hint.js";
import { buildApprovalTx, chainApproval, resolveApprovalCap } from "../shared/approval.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * LiFi-internal numeric chain IDs for non-EVM destinations. Source: the
 * chain IDs returned by `https://li.quest/v1/chains` (also surfaced as
 * the `ChainId` enum in `@lifi/types`). Hardcoding here avoids a
 * cross-module import for what is, conceptually, a small lookup table
 * specific to bridge-intent verification.
 *
 * Same constants are duplicated in `decode-calldata.describeBridgeChainId` —
 * those tables stay in lockstep manually; the test
 * `swap-evm-to-solana.test.ts` pins both via the LiFi public chain ID.
 */
const LIFI_CHAIN_ID: Record<SupportedChain | "solana" | "tron", number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  optimism: 10,
  solana: 1151111081099710,
  tron: 728126428,
};

/**
 * Validate destination addressing for cross-chain-type bridges. The schema
 * widens `toChain` to include `"solana"` and `toAddress` to a free-form
 * string, but zod can't cross-reference fields within a union — so this
 * helper enforces:
 *
 *   - When `toChain === "solana"`, `toAddress` is REQUIRED and must be
 *     base58 (43-44 chars). EVM destinations don't need this — LiFi
 *     defaults to the source wallet.
 *   - When `toAddress` is supplied for an EVM destination, it must match
 *     EVM hex format (defense-in-depth: catches a Solana-format address
 *     accidentally landing on an EVM-destination call).
 *   - Reject exact-out (`amountSide: "to"`) for cross-chain-type bridges.
 *     LiFi's quote API has no reliable exact-out for cross-chain routes
 *     and the bridge-protocol-side delivery introduces additional fee
 *     drift the user would not see in the quote.
 */
function assertCrossChainAddressing(
  args: GetSwapQuoteArgs | PrepareSwapArgs,
): void {
  const toIsSolana = args.toChain === "solana";
  const toIsTron = args.toChain === "tron";
  const toIsNonEvm = toIsSolana || toIsTron;
  if (toIsNonEvm) {
    if (!args.toAddress) {
      throw new Error(
        `toAddress is required when toChain === "${args.toChain}" — the source EVM wallet ` +
          `is not a valid recipient on a non-EVM chain. Pass an explicit destination ` +
          `address (Solana base58 for "solana", T-prefixed base58 for "tron").`,
      );
    }
    if (toIsSolana && !SOLANA_ADDRESS.test(args.toAddress)) {
      throw new Error(
        `toAddress "${args.toAddress}" is not a valid Solana base58 address ` +
          `(expected 43-44 chars). Refusing to prepare a bridge to an unparseable destination.`,
      );
    }
    if (toIsTron && !TRON_ADDRESS.test(args.toAddress)) {
      throw new Error(
        `toAddress "${args.toAddress}" is not a valid TRON base58 address ` +
          `(expected T-prefixed, 34 chars total). Refusing to prepare a bridge to an ` +
          `unparseable destination.`,
      );
    }
    if (args.amountSide === "to") {
      throw new Error(
        `Exact-out (amountSide: "to") is not supported for cross-chain bridges to ${args.toChain}. ` +
          `LiFi's quote API has no reliable exact-out for cross-chain routes; the bridge ` +
          `protocol's delivery side adds fee drift the quote can't account for. Use ` +
          `amountSide: "from" (default) and inspect the quote's toAmountMin.`,
      );
    }
  } else if (args.toAddress) {
    // EVM destination with explicit toAddress — must be EVM hex.
    if (!/^0x[a-fA-F0-9]{40}$/.test(args.toAddress)) {
      throw new Error(
        `toAddress "${args.toAddress}" is not a valid EVM address. ` +
          `For toChain="${args.toChain}" pass a 0x-prefixed 40-hex-char address, ` +
          `or omit toAddress to default to the source wallet.`,
      );
    }
    // #798 fail-closed — an EVM destination address that is NOT the source
    // wallet is refused. The on-chain receiver baked into the LiFi calldata
    // would route the swap output to that address, and at this layer there is
    // no user-confirmed, unforgeable signal that a non-wallet recipient is
    // intentional: the caller is a (potentially prompt-injected) agent that
    // controls every arg, so any "acknowledge" flag it could set it would set
    // for its own address too — the original #798 self-referential drain. We
    // therefore drop the swap-to-a-different-EVM-wallet convenience rather than
    // gate it on an agent-forgeable flag. (A redundant `toAddress === wallet`
    // is harmless and allowed.) The decode-time `assertEvmReceiverIsWallet`
    // check below is the defense-in-depth partner: it catches a compromised
    // LiFi API that injects a non-wallet receiver even when `toAddress` is
    // omitted or equal to the wallet.
    if (getAddress(args.toAddress as `0x${string}`) !== getAddress(args.wallet as `0x${string}`)) {
      throw new Error(
        `prepare_swap: toAddress (${getAddress(args.toAddress as `0x${string}`)}) is not your ` +
          `source wallet (${getAddress(args.wallet as `0x${string}`)}). Routing a swap/bridge's ` +
          `EVM output to a different address is refused (#798 fund-redirection shape). There is ` +
          `no acknowledge flag: a prompt-injected agent could set it for its own address, so the ` +
          `swap-to-another-wallet path is disabled until a user-confirmed, unforgeable signal ` +
          `exists. Omit toAddress (defaults to the source wallet) to proceed.`,
      );
    }
  }
}

/**
 * Cross-check the LiFi quote's encoded bridge intent against what the user
 * asked for. Catches a compromised MCP that swaps `toChain` or `toAddress`
 * between the prepare call and the calldata it returns — even though the
 * prepare receipt would still print the user-requested fields, the bytes
 * that go to Ledger would carry the attacker's destination.
 *
 * Decode strategy is the same as `decode-calldata.tryDecodeLifiBridgeData`:
 * positional decode of the universal `BridgeData` tuple, ignoring the
 * facet-specific second arg. Returns silently when the calldata is NOT
 * bridge-shaped (e.g. intra-EVM swap-facet calls — those don't carry a
 * BridgeData tuple, and the existing source-side guards already cover them).
 *
 * Asserts:
 *   1. `BridgeData.destinationChainId` matches LiFi's chain ID for the
 *      requested `args.toChain`. Catches a `toChain` swap.
 *   2. `BridgeData.receiver` (and, #798, the same-chain generic-swap
 *      `_receiver`):
 *      - For EVM destinations: MUST be the source wallet, fail-closed —
 *        see `assertEvmReceiverIsWallet`. Trusting the raw agent-supplied
 *        `toAddress` as the expected value was the #798 self-referential
 *        hole: an attacker who set `toAddress` to their own address
 *        compared it to itself and always passed. There is no
 *        acknowledge-flag exception: an agent-set flag is forgeable by the
 *        same attacker, so a non-wallet EVM recipient is refused outright.
 *      - For non-EVM destinations: is the LiFi non-EVM sentinel. The
 *        actual non-EVM address lives in the bridge-specific second arg
 *        (Wormhole-style `bytes32`, etc.) which we don't decode; the
 *        user's prepare receipt + Etherscan + the destinationChainId
 *        invariant above are the layered defenses there.
 */
function verifyLifiBridgeIntent(
  args: PrepareSwapArgs,
  data: `0x${string}`,
): void {
  const decoded = tryDecodeLifiBridgeData(data);
  const isCrossChain = args.fromChain !== args.toChain;
  if (!decoded) {
    // No BridgeData → swap-facet calldata. Legitimate for same-chain
    // swaps; suspicious for cross-chain asks (a same-chain swap disguised
    // as a bridge would execute on-chain as a swap, leaving the user's
    // funds in the source wallet as the "to" token rather than delivering
    // them to the destination chain — funds aren't stealable but the
    // user's intent is undermined).
    if (isCrossChain) {
      throw new Error(
        `LiFi quote returned swap-facet calldata for a cross-chain request ` +
          `(${args.fromChain} → ${args.toChain}) — expected bridge-facet ` +
          `calldata carrying a BridgeData tuple. Refusing to return calldata; ` +
          `re-run get_swap_quote.`,
      );
    }
    // #798 — same-chain generic-swap facet. The `_receiver` (index 3) is the
    // on-chain recipient of the swap output; it was previously never decoded,
    // so an attacker-supplied `toAddress` routed the proceeds away with no
    // cross-check. Decode it and apply the same wallet/ack authorization the
    // EVM bridge path uses. `undefined` = not a recognized generic-swap facet
    // (nothing further to assert here).
    const genericReceiver = decodeGenericSwapReceiver(data);
    if (genericReceiver) {
      assertEvmReceiverIsWallet(args, genericReceiver);
    }
    return;
  }
  const expectedChainId = BigInt(LIFI_CHAIN_ID[args.toChain as keyof typeof LIFI_CHAIN_ID]);
  if (decoded.destinationChainId !== expectedChainId) {
    // Some bridges legitimately encode an intermediate settlement chain
    // ID (NEAR Intents being the canonical case for ETH→TRON USDT —
    // funds settle on NEAR and are released on TRON off-chain by a
    // relayer). The match must satisfy BOTH the bridge name AND the
    // intermediate chain ID, both of which are hardcoded source-code
    // constants in INTERMEDIATE_CHAIN_BRIDGES — no env / userConfig /
    // LiFi-response input is consulted, so neither value is tamperable
    // by a compromised MCP / hostile aggregator within our threat
    // model. Issue #237.
    const intermediate = matchIntermediateChainBridge(decoded);
    if (!intermediate) {
      throw new Error(
        `LiFi bridge calldata destinationChainId mismatch: encoded ${decoded.destinationChainId.toString()} ` +
          `but user requested toChain="${args.toChain}" (= ${expectedChainId.toString()}). ` +
          `Refusing to return calldata — this would route funds to the wrong chain. Re-run get_swap_quote.`,
      );
    }
    // Intermediate-chain bridges only make sense for cross-chain
    // requests. On a same-chain request the user wanted no bridging at
    // all, so a NEAR-Intents-shaped calldata represents wrong intent
    // (the swap-facet path is what handles same-chain swaps; bridge
    // facets shouldn't fire there).
    if (args.fromChain === args.toChain) {
      throw new Error(
        `LiFi quote returned ${intermediate.description} calldata for a same-chain ` +
          `request (${args.fromChain} → ${args.toChain}). Intermediate-chain bridges ` +
          `are only valid for cross-chain routes; refusing to return calldata.`,
      );
    }
    // Allowed: fall through to receiver-side checks below. The
    // receiver MUST still be the non-EVM sentinel for non-EVM final
    // destinations, since the actual destination address is in the
    // bridge-specific facet data we do not decode.
  }

  const toIsNonEvm = args.toChain === "solana" || args.toChain === "tron";
  if (toIsNonEvm) {
    if (decoded.receiver.toLowerCase() !== NON_EVM_RECEIVER_SENTINEL) {
      throw new Error(
        `LiFi bridge calldata receiver mismatch for non-EVM destination ${args.toChain}: ` +
          `expected the LiFi non-EVM sentinel (${NON_EVM_RECEIVER_SENTINEL}), got ${decoded.receiver.toLowerCase()}. ` +
          `Refusing to return calldata. The actual ${args.toChain} destination is encoded in ` +
          `the bridge-specific data; the sentinel is how LiFi marks this is a non-EVM route.`,
      );
    }
    return;
  }

  // EVM destination — receiver must be the source wallet, fail-closed (#798).
  assertEvmReceiverIsWallet(args, decoded.receiver as `0x${string}`);
}

/**
 * #798 — enforce that the decoded EVM receiver of a LiFi route (bridge
 * `BridgeData.receiver` OR same-chain generic-swap `_receiver`, index 3) is the
 * source `wallet`. Fail-closed: there is NO exception.
 *
 * The expected receiver is `args.wallet` alone — never the agent-supplied
 * `args.toAddress`. `wallet` is the one trusted anchor on this path: it is the
 * address whose key must sign the returned tx, so a prompt-injected agent that
 * forges it merely produces a tx it cannot sign, not a drain. Comparing the
 * receiver to `toAddress` (the original bug) was self-referential — the attacker
 * set `toAddress` to its own address and it matched itself — and NO agent-set
 * "acknowledge" flag can repair that, because the same attacker sets the flag.
 *
 * The prior rework tried to gate a non-wallet receiver on
 * `acknowledgeNonWalletRecipient`; that flag lives in the zod input schema, so
 * the threat actor just sends `{toAddress: attacker, acknowledgeNonWalletRecipient: true}`
 * and the check passes — identical to the original hole. The only sound outcome
 * at this layer is to refuse a non-wallet EVM receiver outright (option (b) of
 * the reviewer's note); option (a), a distinct server-set stamp, is not cleanly
 * achievable here (any marker `prepareSwap` sets is a pure function of the same
 * agent-controlled args, and the one genuine server stamp,
 * `acknowledgedNonProtocolTarget`, is refused on the LiFi Diamond by
 * `pre-sign-check.ts` block 4b). A non-wallet EVM `toAddress` is also refused
 * earlier, at input, in `assertCrossChainAddressing`; this decode-time check is
 * the defense-in-depth partner that also catches a compromised LiFi API which
 * injects a non-wallet receiver even when `toAddress` was omitted or == wallet.
 *
 * The LiFi Diamond is a recognized destination, so the recipient-authorization
 * pre-sign seam returns early on it (`recipient-authorization.ts` D8 /
 * `dest.kind === "lifi-diamond"`) and this is the ONLY receiver cross-check on
 * the swap path — hence it must be sound on its own.
 */
function assertEvmReceiverIsWallet(
  args: PrepareSwapArgs,
  decodedReceiver: `0x${string}`,
): void {
  const wallet = getAddress(args.wallet as `0x${string}`);
  const receiver = getAddress(decodedReceiver);
  if (receiver !== wallet) {
    throw new Error(
      `LiFi calldata receiver mismatch: encoded ${receiver} but the only authorized ` +
        `EVM receiver is your source wallet ${wallet}. Refusing to return calldata — ` +
        `this would route funds to a different recipient (#798 fund-redirection shape). ` +
        `A non-wallet EVM destination is not supported; re-run get_swap_quote without a ` +
        `differing toAddress.`,
    );
  }
}

/**
 * Sum LiFi fee/gas cost entries into a USD number.
 *
 * LiFi's `amountUSD` is unreliable on some bridge routes (notably Polygon PoS): the
 * field has been observed containing raw token units rather than a USD decimal, which
 * inflates the reported fee by ~6 orders of magnitude for stablecoins (a real 0.25 USDC
 * fee shows as ~$250,000). To sidestep this, always prefer deriving USD from the raw
 * `amount` + `token.priceUSD` + `token.decimals`. Fall back to `amountUSD` only when
 * the token price is missing, and sanity-clamp if both are available but disagree by
 * more than 10×.
 */
interface LifiCostLike {
  amount?: string;
  amountUSD?: string;
  // `token.address` + `included` added for #685: the source-token skim
  // detection (`vetGenericSwapQuote` / `bridgeSuspectedUnreachable`) matches
  // fee entries by token and excludes fees charged on top of the principal.
  token?: { address?: string; decimals?: number; priceUSD?: string };
  included?: boolean;
}

/**
 * #685 — process-lifetime monotonic counter of bridge routes flagged
 * suspected-unreachable by the source-side-only proxy (`bridgeSuspectedUnreachable`).
 * A read-only diagnostic: the route still SHIPS status quo. A rising count (or one
 * confirmed live bridge revert of this class) is the measured demand that promotes
 * #745 (destination-chain-aware bridge reachability) and reopens the disable
 * question. Exported as a live binding; `resetLifiBridgeSuspectedUnreachableCount`
 * is for test isolation only.
 */
export let lifiBridgeSuspectedUnreachableCount = 0;

export function resetLifiBridgeSuspectedUnreachableCount(): void {
  lifiBridgeSuspectedUnreachableCount = 0;
}

/**
 * Bridge-class instrumentation (PROD option (C), design §4.2 step 6). Computes
 * the SOURCE-side-only suspected-unreachable signal; on a flag, emits a
 * structured stderr line (stdout is the MCP stdio channel) and increments the
 * module counter. Read-only: never REFUSEs, never adjusts a min-out, never sits
 * before or throws within the existing bridge guards. Returns whether it fired.
 */
function instrumentBridgeQuote(
  quote: LifiQuoteLike,
  sourceToken: string,
  ctx: { fromChain: string; toChain: string },
): boolean {
  const flagged = bridgeSuspectedUnreachable(quote, sourceToken);
  if (flagged) {
    lifiBridgeSuspectedUnreachableCount++;
    const bridge = tryDecodeLifiBridgeData(
      (quote.transactionRequest?.data ?? "0x") as `0x${string}`,
    );
    console.warn("[vaultpilot-mcp] lifi.bridge_suspected_unreachable", {
      fromChain: ctx.fromChain,
      toChain: ctx.toChain,
      bridge: bridge?.bridge,
      hasSourceSwaps: bridge?.hasSourceSwaps,
      destinationChainId: bridge?.destinationChainId?.toString(),
    });
  }
  return flagged;
}

/**
 * #685 — the same-chain generic-swap REFUSE copy. MUST NOT steer the user to
 * `prepare_custom_call` (PROD condition 4): that bypasses the pre-sign selector
 * check behind a single ack WITHOUT solving reachability, so the same
 * `CumulativeSlippageTooHigh` revert still fires with this gate silenced. Route
 * the user to re-run `get_swap_quote` for a fresh route instead.
 */
function genericSwapRefuseError(reason: string): Error {
  return new Error(
    `prepare_swap: LiFi's baked min-out for this route cannot be proven reachable ` +
      `at prepare time (${reason}). Returning this calldata would risk a deterministic ` +
      `CumulativeSlippageTooHigh revert, so it is refused. Re-run get_swap_quote to fetch ` +
      `a fresh route.`,
  );
}

function sumLifiCostsUsd(items: readonly LifiCostLike[] | undefined): number | undefined {
  if (!items || items.length === 0) return undefined;
  let total = 0;
  for (const item of items) {
    const stated = item.amountUSD !== undefined ? Number(item.amountUSD) : NaN;
    const rawAmt = item.amount !== undefined ? Number(item.amount) : NaN;
    const priceUsd =
      item.token?.priceUSD !== undefined ? Number(item.token.priceUSD) : NaN;
    const decimals = item.token?.decimals ?? 18;

    const derived =
      Number.isFinite(rawAmt) && Number.isFinite(priceUsd)
        ? (rawAmt / 10 ** decimals) * priceUsd
        : NaN;

    if (Number.isFinite(derived)) {
      // Both available: trust derived if they disagree wildly (stated is the known-bad
      // source). 10× threshold catches the "raw-units-as-USD" class of bug.
      const statedOk = Number.isFinite(stated) && stated >= 0;
      if (statedOk && !(derived > 0 && stated / derived > 10)) {
        total += stated;
      } else {
        total += derived;
      }
    } else if (Number.isFinite(stated) && stated >= 0) {
      total += stated;
    }
  }
  return total;
}

/** Resolve ERC-20 decimals (native = 18). */
async function resolveDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native",
  fallback?: number
): Promise<number> {
  if (token === "native") return 18;
  if (fallback !== undefined) return fallback;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return 18;
  }
}

/**
 * On-chain decimals read with no fallback path. Returns undefined for native (no
 * contract to read) and undefined on RPC failure so callers can distinguish "known
 * to match" from "couldn't verify". Used by prepareSwap to cross-check LiFi's
 * reported token metadata before returning signable calldata.
 */
async function readOnchainDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native"
): Promise<number | undefined> {
  if (token === "native") return undefined;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return undefined;
  }
}

/**
 * Issue #411 — when an `exchanges` / `bridges` filter is set and LiFi
 * can't satisfy it, the SDK throws a generic "No available routes"
 * error that doesn't tell the user the filter was the cause. Wrap
 * the original error with context naming the filter so the agent can
 * relay an actionable message ("no route via 1inch — retry without
 * the filter to use the best-output route").
 *
 * Pass-through unchanged when no filter was set.
 */
function rephraseLifiNoRouteError(
  err: unknown,
  args: { exchanges?: string[]; bridges?: string[] },
): Error {
  const baseErr = err instanceof Error ? err : new Error(String(err));
  const noFilter =
    (!args.exchanges || args.exchanges.length === 0) &&
    (!args.bridges || args.bridges.length === 0);
  if (noFilter) return baseErr;
  // LiFi's no-route errors carry messages like "No available routes" /
  // "NotFoundError". Match liberally — false positives just add a hint
  // to the message, no harm.
  const msg = baseErr.message.toLowerCase();
  const looksLikeNoRoute =
    msg.includes("no available") ||
    msg.includes("notfound") ||
    msg.includes("no route") ||
    msg.includes("not found");
  if (!looksLikeNoRoute) return baseErr;
  const filterParts = [
    ...(args.exchanges && args.exchanges.length > 0 ? [`exchanges=[${args.exchanges.join(", ")}]`] : []),
    ...(args.bridges && args.bridges.length > 0 ? [`bridges=[${args.bridges.join(", ")}]`] : []),
  ];
  return new Error(
    `LiFi found no route satisfying ${filterParts.join(" + ")}. ` +
      `Original LiFi error: ${baseErr.message}. ` +
      `Try without the filter to use the best-output route across all ` +
      `aggregators, or pick a different exchange/bridge.`,
  );
}

/**
 * Reject slippage configurations that are almost certainly user/agent error.
 * The schema already caps at 500 bps (5%); this adds a soft-cap at 100 bps
 * (1%) that requires an explicit ack. MEV sandwich bots target open-slippage
 * txs, so every unnecessary basis point is paid straight to a searcher.
 */
export function assertSlippageOk(slippageBps: number | undefined, ack: boolean | undefined): void {
  if (slippageBps === undefined) return;
  if (slippageBps > 100 && !ack) {
    throw new Error(
      `Requested slippage is ${slippageBps} bps (${(slippageBps / 100).toFixed(2)}%). ` +
        `The default cap is 100 bps (1%) because anything higher is almost always a ` +
        `sandwich-bait misconfiguration. If a thin-liquidity route genuinely needs this, ` +
        `retry with \`acknowledgeHighSlippage: true\` and confirm with the user first.`
    );
  }
}

export async function getSwapQuote(args: GetSwapQuoteArgs) {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  assertCrossChainAddressing(args);
  const chain = args.fromChain as SupportedChain;
  const toIsSolana = args.toChain === "solana";
  const amountSide = args.amountSide ?? "from";
  const isExactOut = amountSide === "to";

  // Resolve decimals for the side `amount` refers to. For exact-in this is
  // always the source-chain (EVM) read. For exact-out we read the
  // destination side — but exact-out is rejected for cross-chain-type
  // bridges in `assertCrossChainAddressing`, so this branch is intra-EVM
  // only and `toChain` is safely castable to `SupportedChain`.
  const sideDecimals = isExactOut
    ? await resolveDecimals(
        args.toChain as SupportedChain,
        args.toToken as `0x${string}` | "native",
        args.toTokenDecimals,
      )
    : await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const amountWei = parseUnits(args.amount, sideDecimals).toString();

  // Intra-chain only: 1inch has no cross-chain aggregator. Skip silently when no
  // API key is configured so users without a 1inch portal account still get LiFi.
  // Also skip for exact-out: 1inch v6 has no toAmount/exact-out endpoint, so a
  // fromAmount comparison would be against a different quantity entirely.
  const intraChain = args.fromChain === args.toChain;
  const oneInchApiKey =
    intraChain && !isExactOut ? resolveOneInchApiKey(readUserConfig()) : undefined;

  const lifiReq = {
    fromChain: chain,
    toChain: toIsSolana ? "solana" : (args.toChain as SupportedChain),
    fromToken: args.fromToken as `0x${string}` | "native",
    // Destination token format depends on chain type — LiFi accepts both.
    // The cast is widened so Solana base58 mints aren't rejected.
    toToken: args.toToken as `0x${string}` | "native",
    fromAddress: args.wallet as `0x${string}`,
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    ...(isExactOut ? { toAmount: amountWei } : { fromAmount: amountWei }),
    ...(args.exchanges && args.exchanges.length > 0
      ? { allowExchanges: args.exchanges }
      : {}),
    ...(args.bridges && args.bridges.length > 0
      ? { allowBridges: args.bridges }
      : {}),
    ...(args.excludeExchanges && args.excludeExchanges.length > 0
      ? { denyExchanges: args.excludeExchanges }
      : {}),
    ...(args.excludeBridges && args.excludeBridges.length > 0
      ? { denyBridges: args.excludeBridges }
      : {}),
    ...(args.order !== undefined ? { order: args.order } : {}),
  } as Parameters<typeof fetchQuote>[0];

  const [quoteInitial, oneInchRaw] = await Promise.all([
    fetchQuote(lifiReq).catch((err: unknown) => {
      throw rephraseLifiNoRouteError(err, args);
    }),
    oneInchApiKey
      ? fetchOneInchQuote({
          chain,
          fromToken: args.fromToken as `0x${string}` | "native",
          toToken: args.toToken as `0x${string}` | "native",
          fromAmount: amountWei,
          apiKey: oneInchApiKey,
        }).catch((err: unknown) => ({ __error: (err as Error).message }) as const)
      : Promise.resolve(undefined),
  ]);

  // #685 — mirror the reachability gate on the read-only preview so the shown
  // toAmountMin matches what prepare_swap would bake. getSwapQuote produces no
  // signable calldata, so this NEVER throws (PROD condition 5): a generic-swap
  // REQUOTE re-fetches to preview the reachable min-out; every unreachable /
  // unclassifiable case attaches a SOFT `reachabilityNote` and keeps LiFi's
  // toAmountMin as-is. A same-chain generic-swap note MUST NOT steer to
  // prepare_custom_call. Bridges ship status quo + a source-side-only signal.
  let quote = quoteInitial;
  let reachabilityNote: string | undefined;
  const previewFirstData = quote.transactionRequest?.data;
  if (previewFirstData) {
    const previewSourceToken = quote.action.fromToken.address as string;
    const previewClass = classifyLifiQuote(previewFirstData as `0x${string}`);
    if (previewClass === "bridge") {
      const flagged = instrumentBridgeQuote(quote as unknown as LifiQuoteLike, previewSourceToken, {
        fromChain: args.fromChain,
        toChain: args.toChain,
      });
      if (flagged) {
        reachabilityNote =
          "min-out may be unreachable on this cross-chain route; bridge reachability is pending #745.";
      }
    } else if (previewClass === "generic") {
      const v1 = vetGenericSwapQuote(quote as unknown as LifiQuoteLike, previewSourceToken);
      if (v1.kind === "REQUOTE") {
        const userSlip =
          args.slippageBps !== undefined ? args.slippageBps / 10_000 : LIFI_DEFAULT_SLIPPAGE;
        const effective = userSlip + v1.feeFraction;
        let previewed = false;
        if (effective <= MAX_EFFECTIVE_SLIPPAGE) {
          try {
            const q2 = await fetchQuote({ ...lifiReq, slippage: effective });
            const q2Data = q2.transactionRequest?.data;
            if (
              q2Data &&
              classifyLifiQuote(q2Data as `0x${string}`) === "generic" &&
              vetGenericSwapQuote(q2 as unknown as LifiQuoteLike, q2.action.fromToken.address as string)
                .kind === "SHIP"
            ) {
              quote = q2;
              previewed = true;
            }
          } catch {
            // Re-quote failed — fall through to the soft note below.
          }
        }
        if (!previewed) {
          reachabilityNote =
            "LiFi's baked min-out for this route may be unreachable after the integrator fee " +
            "(prepare_swap would re-quote or refuse). Re-run get_swap_quote for a fresh route.";
        }
      } else if (v1.kind === "REFUSE") {
        reachabilityNote =
          "LiFi's baked min-out for this route cannot be proven reachable at prepare time — " +
          "prepare_swap would refuse it. Re-run get_swap_quote for a fresh route.";
      }
    } else {
      reachabilityNote =
        "this route's calldata is unrecognized; prepare_swap would refuse it. " +
        "Re-run get_swap_quote for a fresh route.";
    }
  }

  const fromTokenDecimals = quote.action.fromToken.decimals;
  const toTokenDecimals = quote.action.toToken.decimals;
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);

  const fromAmountFormatted = formatUnits(BigInt(quote.action.fromAmount), fromTokenDecimals);
  const rawToAmount = formatUnits(BigInt(quote.estimate.toAmount), toTokenDecimals);
  const rawToAmountMin = formatUnits(BigInt(quote.estimate.toAmountMin), toTokenDecimals);

  const fromAmountUsd = Number.isFinite(fromPriceUsd)
    ? Number(fromAmountFormatted) * fromPriceUsd
    : undefined;
  const statedToAmountUsd = Number.isFinite(toPriceUsd)
    ? Number(rawToAmount) * toPriceUsd
    : undefined;

  // Sanity-check the output amount. LiFi has been observed returning toAmount scaled
  // wrong for some aggregator integrations (100 USDC → supposedly 1288 WBTC). When
  // priced out, the implied output USD vastly exceeds the input USD — no rational
  // route pays >10× the input. When that happens, we re-derive the displayed amount
  // from prices and attach a warning so the caller doesn't sign a malformed tx.
  let toAmountExpected = rawToAmount;
  let toAmountMin = rawToAmountMin;
  let toAmountUsd = statedToAmountUsd;
  let warning: string | undefined;

  if (
    fromAmountUsd !== undefined &&
    statedToAmountUsd !== undefined &&
    fromAmountUsd > 0 &&
    statedToAmountUsd / fromAmountUsd > 10
  ) {
    // Derive what the output *should* be from prices.
    const impliedToAmount = fromAmountUsd / toPriceUsd;
    // Preserve the route's stated slippage ratio when re-deriving the min.
    const rawRatio =
      Number(rawToAmount) > 0 ? Number(rawToAmountMin) / Number(rawToAmount) : 1;
    toAmountExpected = impliedToAmount.toString();
    toAmountMin = (impliedToAmount * rawRatio).toString();
    toAmountUsd = fromAmountUsd;
    warning =
      `LiFi returned toAmount=${rawToAmount} ${quote.action.toToken.symbol} (~$${statedToAmountUsd.toFixed(2)}) ` +
      `which is >10× the input value ($${fromAmountUsd.toFixed(2)}). Displayed output re-derived from ` +
      `token prices. Do NOT sign a prepared tx using this quote — fetch a fresh one.`;
  }

  // Intra-chain comparison against 1inch. Quote in the same token, so a direct
  // numeric comparison of output amounts is meaningful. USD is derived from the
  // LiFi-provided toToken price (1inch doesn't return priceUSD) so both sides
  // use the same reference price and only the route differs.
  let alternatives: Array<
    | { source: "1inch"; toAmountExpected: string; toAmountUsd?: number; gasEstimate?: number }
    | { source: "1inch"; error: string }
  > | undefined;
  let bestSource: "lifi" | "1inch" | "tie" | undefined;
  let savingsVsLifi: { source: "1inch"; outputDeltaPct: number; outputDeltaUsd?: number } | undefined;

  if (intraChain && oneInchRaw) {
    if ("__error" in oneInchRaw) {
      alternatives = [{ source: "1inch", error: oneInchRaw.__error }];
    } else {
      const oiDecimals = oneInchRaw.dstToken?.decimals ?? toTokenDecimals;
      const oiFormatted = formatUnits(BigInt(oneInchRaw.dstAmount), oiDecimals);
      const oiOut = Number(oiFormatted);
      const oiUsd = Number.isFinite(toPriceUsd) ? oiOut * toPriceUsd : undefined;
      alternatives = [
        {
          source: "1inch",
          toAmountExpected: oiFormatted,
          toAmountUsd: oiUsd,
          gasEstimate: oneInchRaw.gas,
        },
      ];

      // Compare against the *raw* LiFi toAmount (not the re-derived one). If LiFi's
      // quote was flagged by the >10× sanity check, the raw number is the one the
      // aggregator actually advertised — that's what we're comparing route quality on.
      const lifiOut = Number(rawToAmount);
      if (lifiOut > 0 && oiOut > 0) {
        const delta = (oiOut - lifiOut) / lifiOut;
        if (Math.abs(delta) < 0.0005) bestSource = "tie";
        else bestSource = delta > 0 ? "1inch" : "lifi";
        savingsVsLifi = {
          source: "1inch",
          outputDeltaPct: delta * 100,
          outputDeltaUsd: Number.isFinite(toPriceUsd) ? (oiOut - lifiOut) * toPriceUsd : undefined,
        };
      }
    }
  }

  // Issue #411 — top-level `routedVia` makes the actual route prominent
  // in the response so an agent can compare against the user's stated
  // protocol preference before relaying. `requestedExchanges` /
  // `requestedBridges` echo the filter that was applied so the
  // structured shape carries both intent + result.
  const routedVia = {
    tool: quote.tool,
    requestedExchanges: args.exchanges,
    requestedBridges: args.bridges,
    matchedRequestedExchanges:
      args.exchanges && args.exchanges.length > 0
        ? args.exchanges.some(
            (e) => e.toLowerCase() === quote.tool.toLowerCase(),
          )
        : undefined,
  };

  return {
    fromChain: args.fromChain,
    toChain: args.toChain,
    fromToken: quote.action.fromToken,
    toToken: quote.action.toToken,
    fromAmount: fromAmountFormatted,
    toAmountMin,
    toAmountExpected,
    fromAmountUsd,
    toAmountUsd,
    tool: quote.tool,
    routedVia,
    executionDurationSeconds: quote.estimate.executionDuration,
    feeCostsUsd: sumLifiCostsUsd(quote.estimate.feeCosts),
    gasCostsUsd: sumLifiCostsUsd(quote.estimate.gasCosts),
    crossChain: args.fromChain !== args.toChain,
    ...(alternatives ? { alternatives } : {}),
    ...(bestSource ? { bestSource } : {}),
    ...(savingsVsLifi ? { savingsVsLifi } : {}),
    ...(warning ? { warning } : {}),
    ...(reachabilityNote ? { reachabilityNote } : {}),
  };
}

/**
 * Issue #615 — direct 1inch /swap fallback for `prepareSwap`. Invoked
 * when LiFi rejects an `exchanges: ["1inch"]` filter and the call is
 * intra-chain + exact-in + the user has a 1inch API key. The endpoint
 * returns calldata against the 1inch Aggregation Router V6; for ERC-20
 * inputs that same address is the spender, so we approve `tx.to`
 * directly. Mirrors the LiFi path's decimals cross-check and
 * sandwich-MEV hint, and surfaces in the description that this is the
 * direct-1inch path (not LiFi).
 */
async function prepareDirectOneInchSwap(
  args: PrepareSwapArgs,
  fromAmountWei: string,
  apiKey: string,
  lifiErr: Error,
): Promise<UnsignedTx> {
  const chain = args.fromChain as SupportedChain;
  const fromToken = args.fromToken as `0x${string}` | "native";
  const toToken = args.toToken as `0x${string}` | "native";
  const slippageBps = args.slippageBps ?? 50;

  const oi = await fetchOneInchSwap({
    chain,
    fromToken,
    toToken,
    fromAmount: fromAmountWei,
    fromAddress: args.wallet as `0x${string}`,
    slippageBps,
    apiKey,
  }).catch((err: unknown) => {
    const oneInchMsg = err instanceof Error ? err.message : String(err);
    throw new Error(
      `prepare_swap: LiFi route failed AND direct 1inch fallback also failed. ` +
        `LiFi: ${lifiErr.message} | 1inch: ${oneInchMsg}`,
    );
  });

  // Decimals cross-check — refuse on mismatch, mirrors the LiFi path.
  const fromDecimalsOnchain = await readOnchainDecimals(chain, fromToken);
  const toDecimalsOnchain = await readOnchainDecimals(chain, toToken);
  if (
    fromDecimalsOnchain !== undefined &&
    fromDecimalsOnchain !== oi.srcToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for fromToken ${oi.srcToken.symbol} (${oi.srcToken.address}): ` +
        `1inch reports ${oi.srcToken.decimals}, on-chain says ${fromDecimalsOnchain}. ` +
        `Refusing to return calldata.`,
    );
  }
  if (
    toDecimalsOnchain !== undefined &&
    toDecimalsOnchain !== oi.dstToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for toToken ${oi.dstToken.symbol} (${oi.dstToken.address}): ` +
        `1inch reports ${oi.dstToken.decimals}, on-chain says ${toDecimalsOnchain}. ` +
        `Refusing to return calldata.`,
    );
  }

  const fromSym = oi.srcToken.symbol;
  const toSym = oi.dstToken.symbol;
  const dstAmount = BigInt(oi.dstAmount);
  const minOut = (dstAmount * BigInt(10000 - slippageBps)) / 10000n;
  const quotedToAmount = formatUnits(dstAmount, oi.dstToken.decimals);
  const minOutFormatted = formatUnits(minOut, oi.dstToken.decimals);

  // 1inch doesn't return priceUSD, so the MEV hint runs without a USD
  // notional and falls back to its percent-only message.
  const mevNote = mevExposureNote(chain, slippageBps, undefined);

  const description =
    `Swap ${args.amount} ${fromSym} → ~${quotedToAmount} ${toSym} on ${chain} ` +
    `via 1inch direct (LiFi could not build a route under exchanges=["1inch"])`;

  const swapTx: UnsignedTx = {
    chain,
    to: getAddress(oi.tx.to),
    data: oi.tx.data as `0x${string}`,
    value: BigInt(oi.tx.value || "0").toString(),
    from: args.wallet as `0x${string}`,
    description,
    decoded: {
      functionName: "1inch_swap_v6",
      args: {
        from: `${args.amount} ${fromSym}`,
        expectedOut: `${quotedToAmount} ${toSym}`,
        minOut: `${minOutFormatted} ${toSym}`,
        slippageBps: String(slippageBps),
        ...(mevNote ? { mev: mevNote } : {}),
      },
    },
    gasEstimate: oi.tx.gas ? BigInt(oi.tx.gas).toString() : undefined,
  };

  if (fromToken === "native") return swapTx;

  // ERC-20 input: prepend approval. Spender is the Aggregation Router V6
  // (same address as `tx.to`). Match LiFi-path semantics: exact-amount
  // approval, USDT-style reset on existing nonzero allowance handled by
  // `buildApprovalTx`.
  const fromAmountBig = BigInt(fromAmountWei);
  const { approvalAmount, display } = resolveApprovalCap(
    "exact",
    fromAmountBig,
    oi.srcToken.decimals,
  );
  const approval = await buildApprovalTx({
    chain,
    wallet: args.wallet as `0x${string}`,
    asset: fromToken,
    spender: getAddress(oi.tx.to),
    amountWei: fromAmountBig,
    approvalAmount,
    approvalDisplay: display,
    symbol: fromSym,
    spenderLabel: "1inch Aggregation Router V6",
  });
  return chainApproval(approval, swapTx);
}

export async function prepareSwap(args: PrepareSwapArgs): Promise<UnsignedTx> {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);
  assertCrossChainAddressing(args);
  const chain = args.fromChain as SupportedChain;
  const toIsSolana = args.toChain === "solana";
  const toIsTron = args.toChain === "tron";
  const toIsNonEvm = toIsSolana || toIsTron;
  const amountSide = args.amountSide ?? "from";
  const isExactOut = amountSide === "to";

  // Exact-out is rejected for non-EVM destinations in
  // assertCrossChainAddressing, so the cast in this branch is safe.
  const sideDecimals = isExactOut
    ? await resolveDecimals(
        args.toChain as SupportedChain,
        args.toToken as `0x${string}` | "native",
        args.toTokenDecimals,
      )
    : await resolveDecimals(chain, args.fromToken as `0x${string}` | "native", args.fromTokenDecimals);
  const amountWei = parseUnits(args.amount, sideDecimals).toString();

  const lifiReq = {
    fromChain: chain,
    toChain: toIsNonEvm
      ? (args.toChain as "solana" | "tron")
      : (args.toChain as SupportedChain),
    fromToken: args.fromToken as `0x${string}` | "native",
    toToken: args.toToken as `0x${string}` | "native",
    fromAddress: args.wallet as `0x${string}`,
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined,
    ...(isExactOut ? { toAmount: amountWei } : { fromAmount: amountWei }),
    ...(args.exchanges && args.exchanges.length > 0
      ? { allowExchanges: args.exchanges }
      : {}),
    ...(args.bridges && args.bridges.length > 0
      ? { allowBridges: args.bridges }
      : {}),
    ...(args.excludeExchanges && args.excludeExchanges.length > 0
      ? { denyExchanges: args.excludeExchanges }
      : {}),
    ...(args.excludeBridges && args.excludeBridges.length > 0
      ? { denyBridges: args.excludeBridges }
      : {}),
    ...(args.order !== undefined ? { order: args.order } : {}),
  } as Parameters<typeof fetchQuote>[0];
  // Issue #615 — when the user's exchange filter is exclusively
  // ["1inch"] and LiFi can't build the route (common for stETH→ETH and
  // other long-tail intra-chain pairs LiFi exposes as 1inch
  // alternatives but can't actually compose), fall back to calling
  // 1inch's /swap endpoint directly. Only attempted intra-chain,
  // exact-in, with a configured 1inch API key — 1inch has no bridge
  // and no exact-out endpoint.
  const intraChainEvm = args.fromChain === args.toChain && !toIsNonEvm;
  const oneInchOnlyFilter =
    args.exchanges?.length === 1 &&
    args.exchanges[0]?.toLowerCase() === "1inch";
  const oneInchKey =
    intraChainEvm && !isExactOut && oneInchOnlyFilter
      ? resolveOneInchApiKey(readUserConfig())
      : undefined;
  let quote: Awaited<ReturnType<typeof fetchQuote>>;
  try {
    quote = await fetchQuote(lifiReq);
  } catch (err: unknown) {
    if (oneInchKey) {
      return await prepareDirectOneInchSwap(
        args,
        amountWei,
        oneInchKey,
        err instanceof Error ? err : new Error(String(err)),
      );
    }
    throw rephraseLifiNoRouteError(err, args);
  }

  // #685 — provider-baked min-out reachability gate (vetLifiQuote). The SOLE
  // producer of a shippable GENERIC-SWAP quote: classify the first quote and,
  // for the generic-swap class, re-quote once with a fee-padded slippage when
  // LiFi's baked min-out is unreachable after a principal skim (integrator fee
  // / pre-swap fee-forwarder). Placed BEFORE the guard block below so every
  // existing guard (verifyLifiBridgeIntent, decimals cross-check, fromAmount
  // drift, >10× sanity) validates the FINAL quote. Bridges are NOT gated — they
  // ship via the existing prepare path and carry a source-side-only
  // suspected-unreachable counter. The classification catch-all runs on q1 AND
  // q2, so an unclassifiable re-quote is never shipped.
  const firstData = quote.transactionRequest?.data;
  if (!firstData) {
    throw new Error("LiFi did not return a transactionRequest for this quote.");
  }
  let effectiveSlippageBps: number | undefined;
  let integratorFeeBps: number | undefined;
  const sourceTokenAddr = quote.action.fromToken.address as string;
  const swapClass = classifyLifiQuote(firstData as `0x${string}`);
  if (swapClass === "bridge") {
    // Status-quo bridge flow, now instrumented (read-only, never REFUSEs).
    instrumentBridgeQuote(quote as unknown as LifiQuoteLike, sourceTokenAddr, {
      fromChain: args.fromChain,
      toChain: args.toChain,
    });
  } else if (swapClass === "generic") {
    const v1 = vetGenericSwapQuote(quote as unknown as LifiQuoteLike, sourceTokenAddr);
    if (v1.kind === "REFUSE") {
      throw genericSwapRefuseError(v1.reason);
    }
    if (v1.kind === "REQUOTE") {
      const userSlip =
        args.slippageBps !== undefined ? args.slippageBps / 10_000 : LIFI_DEFAULT_SLIPPAGE;
      const effective = userSlip + v1.feeFraction;
      if (effective > MAX_EFFECTIVE_SLIPPAGE) {
        throw genericSwapRefuseError(
          `fee-padded slippage ${(effective * 100).toFixed(2)}% exceeds the ` +
            `${(MAX_EFFECTIVE_SLIPPAGE * 100).toFixed(0)}% ceiling`,
        );
      }
      let q2: Awaited<ReturnType<typeof fetchQuote>>;
      try {
        q2 = await fetchQuote({ ...lifiReq, slippage: effective });
      } catch (err: unknown) {
        throw rephraseLifiNoRouteError(err, args);
      }
      const q2Data = q2.transactionRequest?.data;
      if (!q2Data) {
        throw genericSwapRefuseError("re-quote returned no transactionRequest calldata");
      }
      // Catch-all on q2 — an unclassifiable / bridge re-quote is never shipped.
      if (classifyLifiQuote(q2Data as `0x${string}`) !== "generic") {
        throw genericSwapRefuseError("re-quote returned a non-generic-swap route");
      }
      const v2 = vetGenericSwapQuote(
        q2 as unknown as LifiQuoteLike,
        q2.action.fromToken.address as string,
      );
      if (v2.kind !== "SHIP") {
        throw genericSwapRefuseError(
          "re-quote's baked min-out is still unreachable after fee-padded slippage",
        );
      }
      quote = q2;
      effectiveSlippageBps = Math.round(effective * 10_000);
      integratorFeeBps = Math.round(v1.feeFraction * 10_000);
    } else if (v1.feeFraction > 0) {
      // SHIP on q1 whose baked min-out already absorbs the skim — disclose it.
      integratorFeeBps = Math.round(v1.feeFraction * 10_000);
    }
  } else {
    // Unknown / new facet — neither a recognized generic-swap selector nor a
    // decodable bridge. REFUSE rather than ship an unproven min-out.
    throw genericSwapRefuseError(
      "route calldata is neither a recognized generic-swap facet nor a decodable bridge",
    );
  }

  const txRequest = quote.transactionRequest;
  if (!txRequest || !txRequest.to || !txRequest.data) {
    throw new Error("LiFi did not return a transactionRequest for this quote.");
  }

  // Bridge-intent cross-check. For routes whose calldata embeds a LiFi
  // BridgeData tuple (= every cross-chain bridge facet), assert the encoded
  // destinationChainId + receiver match what the user requested. Closes the
  // attack vector where a compromised MCP returns calldata that bridges to
  // a different chain or address than the prepare receipt advertises.
  // Intra-EVM swap facets don't carry BridgeData and the helper returns null
  // there — no false positives on the existing same-chain swap path.
  verifyLifiBridgeIntent(args, txRequest.data as `0x${string}`);

  // Cross-check LiFi's reported token decimals against on-chain reads. A mismatch
  // would mean either LiFi has stale metadata or the route targets a token different
  // from what we asked for — in either case, the formatted expectedOut/minOut shown
  // to the user would be wrong, so refuse. Native assets are skipped (no contract).
  //
  // Non-EVM destination (Solana / TRON cross-chain bridge): we cannot read SPL
  // or TRC-20 decimals via EVM RPC. The user's signature only authorizes the
  // EVM-side action; the bridge protocol delivers tokens on the destination
  // chain with whatever decimals LiFi reports. The destination cross-check is
  // dropped here — the source-side check (what the user's signed bytes pull)
  // still fires, and `verifyLifiBridgeIntent` below cross-checks the encoded
  // destination chain ID + receiver against the user's request.
  const fromToken = args.fromToken as `0x${string}` | "native";
  const fromDecimalsOnchain = await readOnchainDecimals(chain, fromToken);
  const toDecimalsOnchain = toIsNonEvm
    ? undefined
    : await readOnchainDecimals(
        args.toChain as SupportedChain,
        args.toToken as `0x${string}` | "native",
      );
  if (
    fromDecimalsOnchain !== undefined &&
    fromDecimalsOnchain !== quote.action.fromToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for fromToken ${quote.action.fromToken.symbol} (${quote.action.fromToken.address}): ` +
        `LiFi reports ${quote.action.fromToken.decimals}, on-chain says ${fromDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }
  if (
    toDecimalsOnchain !== undefined &&
    toDecimalsOnchain !== quote.action.toToken.decimals
  ) {
    throw new Error(
      `Decimals mismatch for toToken ${quote.action.toToken.symbol} (${quote.action.toToken.address}): ` +
        `LiFi reports ${quote.action.toToken.decimals}, on-chain says ${toDecimalsOnchain}. ` +
        `Refusing to return calldata.`
    );
  }

  // Exact-in invariant: the approval amount and the swap tx's transferFrom target
  // are both derived from `quote.action.fromAmount`, while the preview text
  // (description, decoded.args) echoes the user's `args.amount`. If LiFi returns
  // a `fromAmount` different from what we asked for, those two values drift and
  // the user signs bytes that pull more (or less) than the MCP preview shows.
  // The existing `toUsd / fromUsd > 10` gate is asymmetric and does not catch
  // proportional inflation. Refuse on any drift — we literally passed
  // `fromAmount` in, any different value in the response is hostile or buggy.
  if (!isExactOut) {
    const quotedFromWei = BigInt(quote.action.fromAmount);
    if (quotedFromWei !== BigInt(amountWei)) {
      throw new Error(
        `LiFi returned fromAmount=${quotedFromWei} for an exact-in quote of ${amountWei} ` +
          `(${args.amount} ${quote.action.fromToken.symbol}). The approval and swap bytes ` +
          `would pull a different amount than the MCP preview displays — refusing to return ` +
          `calldata. Re-run get_swap_quote.`
      );
    }
  }

  // Sanity-check the quote before returning signable calldata. LiFi has been observed
  // returning toAmount scaled wrong on certain aggregator integrations (e.g. 10 USDC →
  // ~4500 ETH). The calldata embeds the bogus minOut and won't execute, but we refuse
  // up front so the user doesn't waste a signature on a broken quote. Mirrors the
  // warning path in getSwapQuote.
  const fromPriceUsd = Number(quote.action.fromToken.priceUSD ?? NaN);
  const toPriceUsd = Number(quote.action.toToken.priceUSD ?? NaN);
  const quotedFromAmount = formatUnits(
    BigInt(quote.action.fromAmount),
    quote.action.fromToken.decimals
  );
  const quotedToAmount = formatUnits(
    BigInt(quote.estimate.toAmount),
    quote.action.toToken.decimals
  );
  const fromAmountFormatted = Number(quotedFromAmount);
  const toAmountFormatted = Number(quotedToAmount);
  if (
    Number.isFinite(fromPriceUsd) &&
    Number.isFinite(toPriceUsd) &&
    fromPriceUsd > 0 &&
    toPriceUsd > 0
  ) {
    const fromUsd = fromAmountFormatted * fromPriceUsd;
    const toUsd = toAmountFormatted * toPriceUsd;
    if (fromUsd > 0 && toUsd / fromUsd > 10) {
      throw new Error(
        `LiFi returned a malformed quote: toAmount=${toAmountFormatted} ${quote.action.toToken.symbol} ` +
          `(~$${toUsd.toFixed(2)}) for input ~$${fromUsd.toFixed(2)} (route: ${quote.tool}). ` +
          `Output is >10× the input value, so the calldata is not safe to sign. ` +
          `Re-run get_swap_quote to fetch a fresh route.`
      );
    }
  }

  const fromSym = quote.action.fromToken.symbol;
  const toSym = quote.action.toToken.symbol;
  const crossChain = args.fromChain !== args.toChain;
  const fromDisplay = isExactOut ? `~${quotedFromAmount}` : args.amount;
  const toDisplay = isExactOut ? args.amount : `~${quotedToAmount}`;
  // Issue #411 — when the agent passed an `exchanges` filter and the
  // route matches, surface it so the receipt confirms the preference
  // was honoured. When the filter was set but the resolved tool
  // differs (LiFi sometimes exposes a tool name aliased differently
  // from the filter input — e.g. "1inch" vs "oneinch"), the prepare
  // receipt notes the mismatch even though no error was raised.
  const exchangeFilterApplied = args.exchanges && args.exchanges.length > 0;
  const matchedFilter = exchangeFilterApplied
    ? args.exchanges!.some((e) => e.toLowerCase() === quote.tool.toLowerCase())
    : undefined;
  const routingNote = exchangeFilterApplied
    ? matchedFilter
      ? ` (matched requested exchange filter: ${args.exchanges!.join(", ")})`
      : ` (NOTE: requested exchange filter ${JSON.stringify(args.exchanges)} did not match resolved tool '${quote.tool}' — verify before signing)`
    : "";
  const description = crossChain
    ? `Bridge ${fromDisplay} ${fromSym} from ${args.fromChain} to ${toDisplay} ${toSym} on ${args.toChain} via ${quote.tool}${routingNote}`
    : `Swap ${fromDisplay} ${fromSym} → ${toDisplay} ${toSym} on ${args.fromChain} via ${quote.tool}${routingNote}`;

  // Sandwich-MEV hint — same-chain swaps on Ethereum mainnet only. Skipped
  // on cross-chain routes because a bridge facet's output value isn't
  // sandwich-extractable in the same way (slippage there bounds bridge
  // delivery, not pool-state reordering).
  const fromAmountUsd =
    Number.isFinite(fromAmountFormatted) && Number.isFinite(fromPriceUsd)
      ? fromAmountFormatted * fromPriceUsd
      : undefined;
  const mevNote = !crossChain
    ? mevExposureNote(chain, args.slippageBps ?? 50, fromAmountUsd)
    : undefined;

  // #798 — surface the on-chain recipient in the prepare receipt for BOTH the
  // same-chain generic-swap path (`_receiver`, index 3) and the cross-chain
  // bridge path (`BridgeData.receiver`). It was verified to equal the source
  // wallet by `verifyLifiBridgeIntent` above (EVM destinations, fail-closed);
  // showing it lets the user see the on-chain receiver of the tx they are about
  // to sign. Non-EVM bridge receivers are the LiFi sentinel (the real address
  // lives in facet-specific data we don't decode), so they are not surfaced
  // here — the receipt's destination fields and the destinationChainId
  // invariant cover that path.
  const bridgeDecoded = tryDecodeLifiBridgeData(txRequest.data as `0x${string}`);
  const toIsNonEvmDest = args.toChain === "solana" || args.toChain === "tron";
  const decodedReceiver =
    decodeGenericSwapReceiver(txRequest.data as `0x${string}`) ??
    (bridgeDecoded && !toIsNonEvmDest
      ? (bridgeDecoded.receiver as `0x${string}`)
      : undefined);

  const swapTx: UnsignedTx = {
    chain,
    to: txRequest.to as `0x${string}`,
    data: txRequest.data as `0x${string}`,
    value: txRequest.value ? BigInt(txRequest.value).toString() : "0",
    from: args.wallet as `0x${string}`,
    description,
    decoded: {
      functionName: "lifi",
      args: {
        tool: quote.tool,
        from: `${fromDisplay} ${fromSym}`,
        expectedOut: `${quotedToAmount} ${toSym}`,
        minOut: `${formatUnits(BigInt(quote.estimate.toAmountMin), quote.action.toToken.decimals)} ${toSym}`,
        ...(decodedReceiver
          ? { receiver: getAddress(decodedReceiver) }
          : {}),
        // #685 — disclose the fee-aware slippage adjustment when a principal
        // skim was detected (display-only; changes no signed bytes beyond the
        // corrected min-out the re-quote already baked).
        ...(integratorFeeBps !== undefined ? { integratorFeeBps: String(integratorFeeBps) } : {}),
        ...(effectiveSlippageBps !== undefined
          ? { effectiveSlippageBps: String(effectiveSlippageBps) }
          : {}),
        ...(exchangeFilterApplied
          ? {
              requestedExchanges: args.exchanges!.join(", "),
              matchedRequestedExchanges: matchedFilter ? "yes" : "no",
            }
          : {}),
        ...(mevNote ? { mev: mevNote } : {}),
      },
    },
    gasEstimate: txRequest.gasLimit ? BigInt(txRequest.gasLimit).toString() : undefined,
  };

  // ERC-20 inputs require an allowance on `approvalAddress` (LiFi Diamond for most
  // routes, but some tools use a different executor). Without this, the swap reverts
  // on the Diamond's transferFrom — Ledger Live shows "Continue" disabled with $0
  // estimated cost because eth_estimateGas fails. Native inputs skip this step.
  if (fromToken !== "native") {
    const approvalAddress = (quote.estimate.approvalAddress ??
      (txRequest.to as `0x${string}`)) as `0x${string}`;
    const client = getClient(chain);
    const allowance = (await client.readContract({
      address: fromToken,
      abi: erc20Abi,
      functionName: "allowance",
      args: [args.wallet as `0x${string}`, approvalAddress],
    })) as bigint;

    // Approval sizing:
    //  - exact-in: `quote.action.fromAmount` is exactly what the router will pull.
    //  - exact-out: the router may need up to ~fromAmount*(1+slippage) if the pool
    //    state drifts between quote and execution (inverse of toAmountMin protection
    //    on the exact-in side). LiFi does not expose a fromAmountMax field, so we
    //    derive the cap from the same slippageBps that was passed into the quote.
    //    Under-approving here means the swap reverts on transferFrom for any pool
    //    move against the user, even by 1 wei.
    const slippageBpsEffective = args.slippageBps ?? 50; // LiFi default is 0.5% (50 bps)
    const quotedFromWei = BigInt(quote.action.fromAmount);
    const amountWeiBig = isExactOut
      ? (quotedFromWei * BigInt(10_000 + slippageBpsEffective) + 9_999n) / 10_000n
      : quotedFromWei;
    const approvalDisplay = isExactOut
      ? `≤${formatUnits(amountWeiBig, quote.action.fromToken.decimals)}`
      : fromDisplay;
    const approvalQualifier = isExactOut
      ? `(covers up to ${slippageBpsEffective / 100}% input drift)`
      : "(exact amount)";
    if (allowance < amountWeiBig) {
      const approveTx: UnsignedTx = {
        chain,
        to: fromToken,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [approvalAddress, amountWeiBig],
        }),
        value: "0",
        from: args.wallet as `0x${string}`,
        description: `Approve ${approvalDisplay} ${fromSym} for ${quote.tool} via LiFi ${approvalQualifier}`,
        decoded: {
          functionName: "approve",
          args: { spender: approvalAddress, amount: `${approvalDisplay} ${fromSym}` },
        },
        next: swapTx,
      };
      if (allowance > 0n) {
        // USDT-style reset: tokens like USDT revert on approve(nonzero→nonzero).
        // Chain approve(0) → approve(amount) → swap so we don't silently fail on
        // the first tx of the triple.
        const resetTx: UnsignedTx = {
          chain,
          to: fromToken,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [approvalAddress, 0n],
          }),
          value: "0",
          from: args.wallet as `0x${string}`,
          description: `Reset ${fromSym} allowance to 0 (required by USDT-style tokens before re-approval)`,
          decoded: {
            functionName: "approve",
            args: { spender: approvalAddress, amount: "0" },
          },
          next: approveTx,
        };
        return resetTx;
      }
      return approveTx;
    }
  }

  return swapTx;
}
