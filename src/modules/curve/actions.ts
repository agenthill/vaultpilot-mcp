/**
 * Curve write-side actions — v0.1.
 *
 * Single tool: `prepare_curve_add_liquidity` for stable_ng plain pools on
 * Ethereum. Bundles ERC-20 approvals (one per non-zero deposit slot)
 * before the add_liquidity call via `chainApproval`. Per the existing
 * Aave / Compound pattern in this codebase.
 *
 * Slippage gate: caller passes either `minLpOut` (explicit) or
 * `slippageBps` (server computes via `calc_token_amount`). Refusing to
 * accept neither is the conservative-default (better to require the
 * gate explicitly than to silently default to 0 and let the user lose
 * to MEV).
 */
import { encodeFunctionData, formatUnits, getAddress, parseUnits, type Address } from "viem";
import { getClient } from "../../data/rpc.js";
import {
  buildApprovalTx,
  chainApproval,
  resolveApprovalCap,
} from "../shared/approval.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import {
  curveLegacyStableSwapAbi,
  curveStableNgFactoryAbi,
  curveStableNgPlainPoolAbi,
} from "../../abis/curve.js";
import { CONTRACTS } from "../../config/contracts.js";
import type { UnsignedTx } from "../../types/index.js";
import type {
  PrepareCurveAddLiquidityArgs,
  PrepareCurveSwapArgs,
} from "./schemas.js";

/**
 * Curve's universal sentinel for the chain's native asset, returned by
 * `coins(i)` on pools whose i-th coin is native ETH (e.g. the legacy
 * stETH/ETH pool returns this from `coins(0)`).
 */
const CURVE_NATIVE_ETH_SENTINEL =
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";

interface CuratedCurvePool {
  /** Number of coins. Pinned because legacy pools may not expose `N_COINS()` as a callable getter. */
  nCoins: number;
  /** Receipt-friendly label. */
  label: string;
}

/**
 * Curated entries for Curve pools NOT registered with the stable_ng
 * factory but still supported by `prepare_curve_swap`. Today: the
 * canonical legacy StableSwap stETH/ETH pool. Every pool here MUST
 * honor the legacy `exchange(int128 i, int128 j, uint256 dx, uint256
 * min_dy)` selector (selector identical to stable_ng's `exchange`).
 */
const CURATED_CURVE_POOLS: ReadonlyMap<string, CuratedCurvePool> = new Map([
  [
    CONTRACTS.ethereum.curve.stEthEthPool.toLowerCase(),
    { nCoins: 2, label: "legacy StableSwap stETH/ETH" },
  ],
]);

/**
 * Build a `prepare_curve_add_liquidity` UnsignedTx (with bundled
 * approvals) for a stable_ng plain pool on Ethereum.
 *
 * Validation order:
 *   1. Reject meta pools — out of v0.1 scope (different ABI).
 *   2. Confirm `amounts.length === N_COINS` of the pool.
 *   3. Resolve `minLpOut` from explicit value or slippageBps.
 *   4. Build per-asset approvals (skip slots with zero amount).
 *   5. Encode add_liquidity call.
 *   6. Return chained approval(s) + action.
 */
export async function buildCurveAddLiquidity(
  p: PrepareCurveAddLiquidityArgs,
): Promise<UnsignedTx> {
  const wallet = p.wallet as Address;
  const pool = p.pool as Address;
  const factory = CONTRACTS.ethereum.curve.stableNgFactory as Address;
  const client = getClient("ethereum");

  // Read pool metadata + N_COINS in one multicall.
  const [isMetaR, nCoinsR, coinsR] = await client.multicall({
    contracts: [
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "is_meta",
        args: [pool],
      },
      {
        address: pool,
        abi: curveStableNgPlainPoolAbi,
        functionName: "N_COINS",
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_coins",
        args: [pool],
      },
    ],
    allowFailure: false,
  });

  if (isMetaR === true) {
    throw new Error(
      `Curve pool ${pool} is a meta pool. v0.1 only supports plain stable_ng pools — meta-pool support tracked as a follow-up. Use a plain pool's address (call \`get_curve_positions\` to discover them).`,
    );
  }
  const nCoins = Number(nCoinsR as bigint);
  if (p.amounts.length !== nCoins) {
    throw new Error(
      `Pool ${pool} has N_COINS=${nCoins}, but ${p.amounts.length} amounts were provided. Pad with '0' for slots you're not depositing into.`,
    );
  }

  const amountsBig = p.amounts.map((a) => BigInt(a));

  // Resolve minLpOut.
  let minLpOut: bigint;
  if (p.minLpOut !== undefined) {
    minLpOut = BigInt(p.minLpOut);
  } else if (p.slippageBps !== undefined) {
    const expected = (await client.readContract({
      address: pool,
      abi: curveStableNgPlainPoolAbi,
      functionName: "calc_token_amount",
      args: [amountsBig, true],
    })) as bigint;
    // expected * (10000 - slippageBps) / 10000
    minLpOut = (expected * BigInt(10000 - p.slippageBps)) / 10000n;
  } else {
    throw new Error(
      "prepare_curve_add_liquidity requires either `minLpOut` (explicit) or `slippageBps`. The pool's add_liquidity refuses without a slippage floor; setting one explicitly avoids MEV-adjacent loss.",
    );
  }

  // Encode the add_liquidity call.
  const addLiquidityData = encodeFunctionData({
    abi: curveStableNgPlainPoolAbi,
    functionName: "add_liquidity",
    args: [amountsBig, minLpOut],
  });

  // Build approvals — one per non-zero deposit slot.
  const coins = (coinsR as readonly Address[]).slice(0, nCoins);
  const symbols: string[] = [];
  let chainedApproval: UnsignedTx | null = null;
  for (let i = 0; i < nCoins; i++) {
    const amt = amountsBig[i];
    if (amt === 0n) continue;
    const asset = coins[i];
    const meta = await resolveTokenMeta("ethereum", asset);
    symbols.push(`${p.amounts[i]}-raw ${meta.symbol}`);
    const { approvalAmount, display } = resolveApprovalCap(
      p.approvalCap,
      amt,
      meta.decimals,
    );
    const a = await buildApprovalTx({
      chain: "ethereum",
      wallet,
      asset,
      spender: pool,
      amountWei: amt,
      approvalAmount,
      approvalDisplay: display,
      symbol: meta.symbol,
      spenderLabel: `Curve stable_ng plain pool ${pool}`,
    });
    if (a !== null) {
      // The pool is not in the global approve-allowlist (Aave / Compound /
      // Morpho / Lido Queue / EigenLayer / Uniswap NPM+Router / LiFi), so
      // stamp the affirmative-ack on every leg of this approval sub-chain
      // (a plain approve, or a reset→approve for USDT-style coins) to skip
      // `assertTransactionSafe`'s block-2 spender-allowlist refusal. Mirrors
      // `buildCurveSwap`'s approval stamp (#618/#626). Issue #734.
      for (let leg: UnsignedTx | undefined = a; leg; leg = leg.next) {
        leg.acknowledgedNonAllowlistedSpender = true;
      }
      chainedApproval = chainedApproval === null ? a : chainApproval(chainedApproval, a);
    }
  }

  const addTx: UnsignedTx = {
    chain: "ethereum",
    to: pool,
    data: addLiquidityData,
    value: "0",
    from: wallet,
    description: `Add liquidity to Curve stable_ng pool ${pool} (${symbols.join(", ")})`,
    decoded: {
      functionName: "add_liquidity",
      args: {
        pool,
        amounts: p.amounts.join(","),
        minLpOut: minLpOut.toString(),
        ...(p.slippageBps !== undefined ? { slippageBps: String(p.slippageBps) } : {}),
      },
    },
    // Curve pool addresses are dynamic (stable_ng factory) so they can never
    // appear in `classifyDestination`'s recognized set — without an ack,
    // `assertTransactionSafe`'s block-4 catch-all refuses the add_liquidity
    // leg at preview/send. Mirror `buildCurveSwap` (#626): the destination-
    // trust source is server-side pool validation (is_meta=false + N_COINS
    // read against the stable_ng factory above). Issue #734.
    acknowledgedNonProtocolTarget: true,
  };

  return chainedApproval === null ? addTx : chainApproval(chainedApproval, addTx);
}

/**
 * Confirm `pool` is supported by the swap path: either a curated entry
 * (today: legacy stETH/ETH) OR a stable_ng factory plain pool. Reject
 * meta pools and pools outside both sets — silent dispatch onto an
 * unrecognized pool is the failure mode (cryptoswap / tricrypto /
 * older legacy stable have different `exchange` ABIs).
 *
 * Returns a brief label used in the receipt's description.
 */
async function ensureSupportedCurvePool(
  pool: Address,
  client: ReturnType<typeof getClient>,
): Promise<{ label: string; nCoins: number }> {
  const curated = CURATED_CURVE_POOLS.get(pool.toLowerCase());
  if (curated) return { label: curated.label, nCoins: curated.nCoins };

  const factory = CONTRACTS.ethereum.curve.stableNgFactory as Address;
  const [isMetaR, nCoinsR] = await client.multicall({
    contracts: [
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "is_meta",
        args: [pool],
      },
      {
        address: factory,
        abi: curveStableNgFactoryAbi,
        functionName: "get_n_coins",
        args: [pool],
      },
    ],
    allowFailure: true,
  });
  if (
    nCoinsR.status !== "success" ||
    (nCoinsR.result as bigint) === 0n
  ) {
    throw new Error(
      `Pool ${pool} is not supported by prepare_curve_swap. Recognized: legacy ` +
        `stETH/ETH at ${CONTRACTS.ethereum.curve.stEthEthPool}; any stable_ng plain ` +
        `pool at factory ${factory}. Other Curve pool generations (cryptoswap, ` +
        `tricrypto, older legacy stable) use distinct exchange ABIs and are not ` +
        `supported — file an issue if you need one of them.`,
    );
  }
  if (isMetaR.status !== "success" || isMetaR.result === true) {
    throw new Error(
      `Pool ${pool} is a stable_ng meta pool. Meta pools route swaps through ` +
        `\`exchange_underlying\` against a base-pool LP token — different ABI, out ` +
        `of scope for prepare_curve_swap.`,
    );
  }
  const nCoins = Number(nCoinsR.result as bigint);
  return { label: "stable_ng plain pool", nCoins };
}

/**
 * Locate a token in the pool's `coins` array. Native ETH matches the
 * Curve sentinel `0xeeee...eeee` — pools that don't carry the sentinel
 * at any index simply don't accept native ETH and the call will error.
 */
function indexOfTokenInCoins(
  token: "native" | string,
  coins: readonly Address[],
): number {
  const target =
    token === "native"
      ? CURVE_NATIVE_ETH_SENTINEL
      : token.toLowerCase();
  const idx = coins.findIndex((c) => c.toLowerCase() === target);
  if (idx !== -1) return idx;
  if (token === "native") {
    throw new Error(
      `Pool does not accept native ETH (no \`coins(i)\` returns the ETH sentinel ` +
        `${CURVE_NATIVE_ETH_SENTINEL}). Pass an ERC-20 token address instead. ` +
        `coins=[${coins.join(", ")}].`,
    );
  }
  throw new Error(
    `Token ${token} is not in the pool's coins array. coins=[${coins.join(", ")}]. ` +
      `Pass an address that matches one of those entries (or "native" if the pool's ` +
      `coins(i) returns the ETH sentinel at some index).`,
  );
}

/**
 * Build a `prepare_curve_swap` UnsignedTx (issue #615 v0.2). Supports
 * the canonical legacy stETH/ETH pool plus any stable_ng factory plain
 * pool. Same `exchange(int128,int128,uint256,uint256)` selector for
 * both flavors — the only per-pool dispatch is whether `coins(i)`
 * returns the ETH sentinel (then we send `value = dx`, no approval) or
 * an ERC-20 (then we chain an approval to the pool).
 *
 * Slippage gate is required: caller passes `minOut` (explicit) or
 * `slippageBps` (server computes via `get_dy * (1 - bps/10000)`). The
 * pool's exchange silently accepts `min_dy=0` — defaulting there would
 * let MEV extract the entire output.
 *
 * Pools NOT in this support set (cryptoswap, tricrypto, older legacy)
 * are rejected with an actionable error in `ensureSupportedCurvePool`.
 */
export async function buildCurveSwap(
  p: PrepareCurveSwapArgs,
): Promise<UnsignedTx> {
  const wallet = p.wallet as Address;
  const pool = getAddress(p.pool) as Address;
  const client = getClient("ethereum");

  const { label: poolLabel, nCoins } = await ensureSupportedCurvePool(pool, client);
  if (!Number.isFinite(nCoins) || nCoins < 2 || nCoins > 8) {
    throw new Error(
      `Pool ${pool} reported N_COINS=${nCoins}. Expected 2..8 — refusing to dispatch.`,
    );
  }
  const coinsR = await client.multicall({
    contracts: Array.from({ length: nCoins }, (_, idx) => ({
      address: pool,
      abi: curveLegacyStableSwapAbi as never,
      functionName: "coins" as const,
      args: [BigInt(idx)] as const,
    })),
    allowFailure: false,
  });
  const coins = coinsR as readonly Address[];

  const i = indexOfTokenInCoins(p.fromToken, coins);
  const j = indexOfTokenInCoins(p.toToken, coins);
  if (i === j) {
    throw new Error(
      `fromToken and toToken resolve to the same coin index (${i}) on pool ${pool}. ` +
        `Pick distinct tokens.`,
    );
  }

  const fromIsNative = p.fromToken === "native";
  const toIsNative = p.toToken === "native";

  const fromMeta = fromIsNative
    ? { symbol: "ETH", decimals: 18 }
    : await resolveTokenMeta("ethereum", coins[i]);
  const toMeta = toIsNative
    ? { symbol: "ETH", decimals: 18 }
    : await resolveTokenMeta("ethereum", coins[j]);

  const dx = parseUnits(p.amount, fromMeta.decimals);

  // Resolve min_dy. Mirrors `prepare_curve_add_liquidity`'s gate.
  let minDy: bigint;
  if (p.minOut !== undefined) {
    minDy = BigInt(p.minOut);
  } else if (p.slippageBps !== undefined) {
    if (p.slippageBps > 100 && p.acknowledgeHighSlippage !== true) {
      throw new Error(
        `Requested slippage is ${p.slippageBps} bps (${(p.slippageBps / 100).toFixed(2)}%). ` +
          `The default cap is 100 bps (1%) because anything higher is almost always a ` +
          `sandwich-bait misconfiguration. Retry with \`acknowledgeHighSlippage: true\` if ` +
          `genuinely intended.`,
      );
    }
    const expectedOut = (await client.readContract({
      address: pool,
      abi: curveLegacyStableSwapAbi,
      functionName: "get_dy",
      args: [BigInt(i), BigInt(j), dx],
    })) as bigint;
    minDy = (expectedOut * BigInt(10000 - p.slippageBps)) / 10000n;
  } else {
    throw new Error(
      "prepare_curve_swap requires either `minOut` (explicit decimal-string uint256) or " +
        "`slippageBps`. The pool's exchange() accepts min_dy=0 silently — defaulting to that " +
        "would let MEV extract the entire output, so the gate is mandatory.",
    );
  }

  const exchangeData = encodeFunctionData({
    abi: curveLegacyStableSwapAbi,
    functionName: "exchange",
    args: [BigInt(i), BigInt(j), dx, minDy],
  });

  const minOutFormatted = formatUnits(minDy, toMeta.decimals);
  const description =
    `Swap ${p.amount} ${fromMeta.symbol} → ≥${minOutFormatted} ${toMeta.symbol} via Curve ${poolLabel} (${pool})`;

  // Curve pools are NOT in `classifyDestination`'s recognized set
  // (Aave / Compound / Morpho / Lido / EigenLayer / Uniswap NPM+Router /
  // LiFi Diamond / known ERC-20s). Without an ack, `assertTransactionSafe`'s
  // catch-all "unknown destination" refusal blocks the swap leg at
  // preview/send time. The destination-trust source here is server-side
  // pool validation: `ensureSupportedCurvePool` already restricted `pool`
  // to a curated entry (legacy stETH/ETH) or a stable_ng factory plain
  // pool. Issue #626 — companion to #618 (which softened the spender
  // gate but left the destination gate hard-failing).
  const swapTx: UnsignedTx = {
    chain: "ethereum",
    to: pool,
    data: exchangeData,
    value: fromIsNative ? dx.toString() : "0",
    from: wallet,
    description,
    decoded: {
      functionName: "exchange",
      args: {
        pool,
        i: String(i),
        j: String(j),
        dx: `${p.amount} ${fromMeta.symbol}`,
        minOut: `${minOutFormatted} ${toMeta.symbol}`,
        ...(p.slippageBps !== undefined ? { slippageBps: String(p.slippageBps) } : {}),
      },
    },
    acknowledgedNonProtocolTarget: true,
  };

  if (fromIsNative) return swapTx;

  // ERC-20 input: prepend an approval to the pool. Curve pools (any
  // generation) are NOT in the global approve-allowlist (Aave /
  // Compound / Morpho / Lido Queue / EigenLayer / Uniswap NPM+Router /
  // LiFi Diamond), so the user must opt in via
  // `acknowledgeNonAllowlistedSpender: true` BEFORE the prepare path
  // mints a handle. With it, stamp the approval tx so
  // `assertTransactionSafe` skips the spender-allowlist refusal at
  // preview/send time. The allowlist is a security recommendation, not
  // a hard requirement (PR #618 / issue #617).
  if (p.acknowledgeNonAllowlistedSpender !== true) {
    throw new Error(
      `prepare_curve_swap builds an approve to a Curve ${poolLabel} (${pool}), which is NOT ` +
        `in the protocol approve-allowlist (Aave Pool, Compound Comet, Morpho Blue, Lido ` +
        `Queue, EigenLayer, Uniswap NPM, Uniswap SwapRouter02, LiFi Diamond). The allowlist ` +
        `is a security recommendation: it limits approvals to a small set of well-known ` +
        `spenders to keep prompt-injection drains from sliding through. Curve pools are ` +
        `well-vetted but sit outside that curated set. Surface the trade-off to the user, ` +
        `then retry with \`acknowledgeNonAllowlistedSpender: true\` to opt in.`,
    );
  }
  const fromTokenAddress = coins[i];
  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    dx,
    fromMeta.decimals,
  );
  const approval = await buildApprovalTx({
    chain: "ethereum",
    wallet,
    asset: fromTokenAddress,
    spender: pool,
    amountWei: dx,
    approvalAmount,
    approvalDisplay: display,
    symbol: fromMeta.symbol,
    spenderLabel: `Curve ${poolLabel} ${pool}`,
  });
  if (approval !== null) {
    // Surface the advisory in the description so the prepare receipt
    // tells the user (via the agent) that the spender is non-allowlisted
    // — security recommendation, not a hard requirement, but worth
    // verifying before signing.
    approval.description =
      `${approval.description} ⚠ ADVISORY: spender is a Curve ${poolLabel}, NOT in the ` +
      `protocol approve-allowlist; user opted in via acknowledgeNonAllowlistedSpender. ` +
      `Verify the on-device approve target matches ${pool}.`;
    // Flow the affirmative-ack flag through to assertTransactionSafe.
    approval.acknowledgedNonAllowlistedSpender = true;
  }
  return chainApproval(approval, swapTx);
}
