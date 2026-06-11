/**
 * Per-chain decomposer for `get_portfolio_diff`.
 *
 * Strategy:
 *   1. Pull current balances (existing `fetchNativeBalance` + `fetchTopErc20Balances`
 *      + per-non-EVM-chain readers).
 *   2. Walk `getTransactionHistory` for the window. Items already carry
 *      `valueUsd` (priced via DefiLlama historical at the tx's own
 *      timestamp), so we sum the priced flows directly.
 *   3. Reconstruct starting quantity per held asset:
 *      `startingQty = endingQty - netFlowQty` (raw bigints).
 *      Negative results → user received the entire position within the
 *      window → clamp to 0 and flag.
 *   4. Look up historical prices at periodStart via `lookupHistoricalPrices`
 *      (one batched call per chain, parallel across chains).
 *   5. Compute per-asset:
 *        - `priceEffect = min(starting, ending) * (endingPrice - startingPrice)`
 *          — the change attributable to price movement on what was held the
 *          ENTIRE window.
 *        - `quantityEffect = endingValue - startingValue - priceEffect`
 *          — the residual, capturing deposits, withdrawals, yield, swap legs.
 *
 * Out of v1: protocol-specific buckets (Aave interest separated from spot
 * balance gain, MarginFi liquidation as its own line, etc.). The residual
 * ("other / quantity-effect") collapses these together; the narrative
 * surfaces the categories the history walk could classify (external
 * transfer, swap, lending action) for color but doesn't subtract them
 * from the price-effect line.
 */

import type {
  AssetDiffRow,
  ChainDiffSlice,
} from "./schemas.js";
import type { HistoryItem } from "../history/schemas.js";
import {
  lookupHistoricalPrices,
  nativeCoinKey,
  tokenCoinKey,
  getPrice,
  type PriceRequest,
} from "../history/prices.js";
import type { AnyChain } from "../../types/index.js";
import { getTransactionHistory } from "../history/index.js";

const NATIVE_TOKEN_KEY = "native";

interface AssetSnapshot {
  /**
   * Stable identifier — for native: "native"; for tokens: the on-chain
   * address (lowercased EVM, base58 for Solana mints, hex/base58 for TRON).
   */
  token: string;
  symbol: string;
  decimals: number;
  /** Current quantity in raw base units. */
  endingQtyRaw: bigint;
  /** Current quantity in human-formatted decimal string. */
  endingQty: string;
  /** Current price in USD. Absent if DefiLlama couldn't price it. */
  endingPriceUsd?: number;
  /** Current value (qty * price). 0 when price is missing. */
  endingValueUsd: number;
}

interface FlowAccumulator {
  /** Per-token net qty flow during window (positive = inflow). */
  netFlowQty: Map<string, bigint>;
  /** Per-token decimals (recorded from history items, used for human format). */
  decimals: Map<string, number>;
  /** Per-token symbol. */
  symbol: Map<string, string>;
  /** Sum of priced inflows in USD. */
  inflowsUsd: number;
  /** Sum of priced outflows in USD (always positive — sign in netFlowsUsd). */
  outflowsUsd: number;
}

function newFlowAccumulator(): FlowAccumulator {
  return {
    netFlowQty: new Map(),
    decimals: new Map(),
    symbol: new Map(),
    inflowsUsd: 0,
    outflowsUsd: 0,
  };
}

function addFlow(acc: FlowAccumulator, token: string, deltaRaw: bigint): void {
  const prev = acc.netFlowQty.get(token) ?? 0n;
  acc.netFlowQty.set(token, prev + deltaRaw);
}

/**
 * Walk a flat list of history items for a single wallet on a single chain.
 * Classifies each item as either inflow (to == wallet) or outflow (from ==
 * wallet), accumulates net qty + USD per token. Uses bigint everywhere on
 * the qty side to avoid JS number precision loss; valueUsd is already a
 * float and small enough to add naively.
 *
 * Solana `program_interaction` items are a special case — they carry
 * `balanceDeltas[]` rather than a single from/to/amount triple. v1 skips
 * them for net-flow accounting (their deltas mix swap legs that intra-tx
 * cancel out, which would miscount as transfers). The skipped txs are
 * tracked so the composer can flag them in `notes`.
 */
function classifyHistory(
  items: HistoryItem[],
  wallet: string,
  acc: FlowAccumulator,
): { skippedProgramInteractions: number } {
  let skippedProgramInteractions = 0;
  const lowerWallet = wallet.toLowerCase();

  for (const item of items) {
    if (item.type === "external" || item.type === "internal") {
      // Native-coin transfer.
      const valueRaw = BigInt(item.valueNative);
      if (valueRaw === 0n) continue;
      acc.symbol.set(NATIVE_TOKEN_KEY, acc.symbol.get(NATIVE_TOKEN_KEY) ?? "");
      // Decimals for native are chain-dependent; the caller fills them
      // from the snapshot side (we don't always get decimals from the
      // history schema). Native decimals are 18 (EVM), 6 (TRX), 9 (SOL),
      // 8 (BTC) — caller patches.
      const isInflow = item.to.toLowerCase() === lowerWallet;
      const isOutflow = item.from.toLowerCase() === lowerWallet;
      if (isInflow) {
        addFlow(acc, NATIVE_TOKEN_KEY, valueRaw);
        if (item.valueUsd) acc.inflowsUsd += item.valueUsd;
      } else if (isOutflow) {
        addFlow(acc, NATIVE_TOKEN_KEY, -valueRaw);
        if (item.valueUsd) acc.outflowsUsd += item.valueUsd;
      }
    } else if (item.type === "token_transfer") {
      const tokenKey = item.tokenAddress.toLowerCase();
      acc.symbol.set(tokenKey, item.tokenSymbol);
      acc.decimals.set(tokenKey, item.tokenDecimals);
      const valueRaw = BigInt(item.amount);
      if (valueRaw === 0n) continue;
      const isInflow = item.to.toLowerCase() === lowerWallet;
      const isOutflow = item.from.toLowerCase() === lowerWallet;
      if (isInflow) {
        addFlow(acc, tokenKey, valueRaw);
        if (item.valueUsd) acc.inflowsUsd += item.valueUsd;
      } else if (isOutflow) {
        addFlow(acc, tokenKey, -valueRaw);
        if (item.valueUsd) acc.outflowsUsd += item.valueUsd;
      }
    } else {
      // program_interaction — skipped in v1.
      skippedProgramInteractions += 1;
    }
  }

  return { skippedProgramInteractions };
}

function formatRaw(raw: bigint, decimals: number): string {
  if (raw === 0n) return "0";
  const negative = raw < 0n;
  const abs = negative ? -raw : raw;
  const divisor = 10n ** BigInt(decimals);
  const whole = abs / divisor;
  const frac = abs % divisor;
  let out = whole.toString();
  if (frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, "0").replace(/0+$/, "");
    if (fracStr.length > 0) out += "." + fracStr;
  }
  return (negative ? "-" : "") + out;
}

function rawToFloat(raw: bigint, decimals: number): number {
  return Number(formatRaw(raw, decimals));
}

/**
 * Compose a per-chain `ChainDiffSlice` from the chain's current snapshot,
 * its window history items, and the wallet address (used for direction
 * classification). Performs the historical-price batched lookup itself
 * — one DefiLlama call covers all assets on this chain at one timestamp.
 */
export async function buildChainSlice(args: {
  /**
   * Chain label. `AnyChain` for the EVM / TRON / Solana lookups
   * (`nativeCoinKey` / `tokenCoinKey` typecheck against it); the special
   * value `"bitcoin"` is also accepted but bypasses historical-price
   * lookups (BTC isn't in `nativeCoinKey`'s table — diff for BTC v1 is
   * current-balance-only per the index module's note).
   */
  chain: AnyChain | "bitcoin";
  wallet: string;
  /** Current per-asset snapshots (already-priced via the existing readers). */
  snapshots: AssetSnapshot[];
  /** History items for this chain in the window. */
  historyItems: HistoryItem[];
  /** Whether the underlying history fetcher truncated for this chain. */
  truncated: boolean;
  /** Window start in unix seconds. */
  windowStartSec: number;
  /** Native-coin decimals override (the caller knows the chain better than the history schema does). */
  nativeDecimals: number;
  /** Native-coin symbol for display (ETH, TRX, SOL, BTC, MATIC). */
  nativeSymbol: string;
}): Promise<{ slice: ChainDiffSlice; missedPrice: boolean }> {
  const acc = newFlowAccumulator();
  acc.symbol.set(NATIVE_TOKEN_KEY, args.nativeSymbol);
  acc.decimals.set(NATIVE_TOKEN_KEY, args.nativeDecimals);
  const { skippedProgramInteractions } = classifyHistory(
    args.historyItems,
    args.wallet,
    acc,
  );

  // Build the asset universe: every asset currently held PLUS every asset
  // that flowed in/out during the window. Both are needed because:
  //   - Currently-held: the user wants to see what they have now.
  //   - Flowed-but-zero: e.g. they held it at window start, sold all of
  //     it, and want to see the disposal in the breakdown.
  // Map keyed by token id, value = synthetic snapshot (decimals from
  // history if not currently held).
  const universe = new Map<string, AssetSnapshot>();
  for (const s of args.snapshots) universe.set(s.token, s);
  for (const tokenKey of acc.netFlowQty.keys()) {
    if (universe.has(tokenKey)) continue;
    universe.set(tokenKey, {
      token: tokenKey,
      symbol: acc.symbol.get(tokenKey) ?? "?",
      decimals:
        acc.decimals.get(tokenKey) ??
        (tokenKey === NATIVE_TOKEN_KEY ? args.nativeDecimals : 0),
      endingQtyRaw: 0n,
      endingQty: "0",
      endingValueUsd: 0,
    });
  }

  // Build a single batched price request for window start. BTC bypasses
  // the price lookup (no entry in `nativeCoinKey`'s table; v1 BTC diff is
  // current-balance-only per the index module's note).
  const priceRequests: PriceRequest[] = [];
  if (args.chain !== "bitcoin") {
    for (const asset of universe.values()) {
      priceRequests.push({
        coinKey: assetCoinKey(args.chain, asset.token),
        timestamp: args.windowStartSec,
      });
    }
  }
  const { prices, missed } = priceRequests.length
    ? await lookupHistoricalPrices(priceRequests)
    : { prices: new Map<string, number>(), missed: false };

  // Build per-asset rows.
  const rows: AssetDiffRow[] = [];
  let chainStartingValue = 0;
  let chainEndingValue = 0;
  let chainPriceEffect = 0;
  for (const asset of universe.values()) {
    const decimals = asset.decimals;
    const netFlowRaw = acc.netFlowQty.get(asset.token) ?? 0n;
    const endingQtyRaw = asset.endingQtyRaw;
    let startingQtyRaw = endingQtyRaw - netFlowRaw;
    let startedAtZero = false;
    if (startingQtyRaw < 0n) {
      // User received this entirely within the window — they had 0 at start.
      startingQtyRaw = 0n;
      startedAtZero = true;
    }
    let startingPriceUsd: number | undefined;
    if (args.chain !== "bitcoin") {
      startingPriceUsd = getPrice(
        prices,
        assetCoinKey(args.chain, asset.token),
        args.windowStartSec,
      );
    }
    const endingPriceUsd = asset.endingPriceUsd;

    const startingQtyFloat = rawToFloat(startingQtyRaw, decimals);
    const endingQtyFloat = rawToFloat(endingQtyRaw, decimals);

    const startingValueUsd =
      startingPriceUsd !== undefined ? startingQtyFloat * startingPriceUsd : 0;
    const endingValueUsd = asset.endingValueUsd;

    // Price effect = quantity held the entire window × price delta.
    let priceEffectUsd = 0;
    if (startingPriceUsd !== undefined && endingPriceUsd !== undefined) {
      const heldThroughout = Math.min(startingQtyFloat, endingQtyFloat);
      priceEffectUsd = heldThroughout * (endingPriceUsd - startingPriceUsd);
    }
    const quantityEffectUsd = endingValueUsd - startingValueUsd - priceEffectUsd;

    // Skip rows that are pure zero — neither held nor moved during window.
    if (
      endingQtyRaw === 0n &&
      startingQtyRaw === 0n &&
      netFlowRaw === 0n
    ) {
      continue;
    }

    const netFlowFloat = rawToFloat(netFlowRaw, decimals);
    let netFlowUsd = 0;
    // Approximate net-flow USD: signed inflow minus signed outflow,
    // valued at... we don't have priced-per-direction here; the
    // accumulator has aggregate inflows / outflows, which are summed
    // at the chain level. Per-asset netFlowUsd is best-effort: we
    // multiply netFlowFloat by an average of starting + ending price
    // when both exist, else fall back to whichever is available.
    if (startingPriceUsd !== undefined && endingPriceUsd !== undefined) {
      netFlowUsd = netFlowFloat * ((startingPriceUsd + endingPriceUsd) / 2);
    } else if (endingPriceUsd !== undefined) {
      netFlowUsd = netFlowFloat * endingPriceUsd;
    } else if (startingPriceUsd !== undefined) {
      netFlowUsd = netFlowFloat * startingPriceUsd;
    }

    rows.push({
      symbol: asset.symbol,
      token: asset.token,
      chain: args.chain,
      startingQty: formatRaw(startingQtyRaw, decimals),
      endingQty: formatRaw(endingQtyRaw, decimals),
      ...(startingPriceUsd !== undefined ? { startingPriceUsd } : {}),
      ...(endingPriceUsd !== undefined ? { endingPriceUsd } : {}),
      startingValueUsd: round2(startingValueUsd),
      endingValueUsd: round2(endingValueUsd),
      priceEffectUsd: round2(priceEffectUsd),
      quantityEffectUsd: round2(quantityEffectUsd),
      netFlowQty: formatRaw(netFlowRaw, decimals),
      netFlowUsd: round2(netFlowUsd),
      ...(startedAtZero ? { startedAtZero: true } : {}),
    });

    chainStartingValue += startingValueUsd;
    chainEndingValue += endingValueUsd;
    chainPriceEffect += priceEffectUsd;
  }

  const inflowsUsd = round2(acc.inflowsUsd);
  const outflowsUsd = round2(acc.outflowsUsd);
  const netFlowsUsd = round2(acc.inflowsUsd - acc.outflowsUsd);
  const topLevelChangeUsd = round2(chainEndingValue - chainStartingValue);
  const otherEffectUsd = round2(
    topLevelChangeUsd - chainPriceEffect - netFlowsUsd,
  );

  const slice: ChainDiffSlice = {
    chain: args.chain,
    startingValueUsd: round2(chainStartingValue),
    endingValueUsd: round2(chainEndingValue),
    topLevelChangeUsd,
    inflowsUsd,
    outflowsUsd,
    netFlowsUsd,
    priceEffectUsd: round2(chainPriceEffect),
    otherEffectUsd,
    perAsset: rows,
    truncated: args.truncated,
  };

  // Surface skipped Solana program-interaction count via the slice's
  // notes channel — packed into a sentinel that the composer expands.
  // Cleaner than a side channel because the composer already iterates
  // slices.
  if (skippedProgramInteractions > 0) {
    (slice as ChainDiffSlice & { _skippedProgramInteractions?: number })._skippedProgramInteractions =
      skippedProgramInteractions;
  }

  return { slice, missedPrice: missed };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Return the DefiLlama coin key for an asset on a given (non-bitcoin) chain. */
function assetCoinKey(chain: AnyChain, token: string): string {
  return token === NATIVE_TOKEN_KEY
    ? nativeCoinKey(chain)
    : tokenCoinKey(chain, token);
}

/**
 * Resolve a window enum to (startSec, endSec) timestamps.
 * `ytd` is calendar-year-to-date in UTC. Other windows are rolling.
 */
export function resolveWindow(window: "24h" | "7d" | "30d" | "ytd"): {
  startSec: number;
  endSec: number;
} {
  const endMs = Date.now();
  let startMs: number;
  switch (window) {
    case "24h":
      startMs = endMs - 24 * 3_600_000;
      break;
    case "7d":
      startMs = endMs - 7 * 86_400_000;
      break;
    case "30d":
      startMs = endMs - 30 * 86_400_000;
      break;
    case "ytd":
      startMs = Date.UTC(new Date(endMs).getUTCFullYear(), 0, 1);
      break;
  }
  return {
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000),
  };
}

/**
 * Thin wrapper around `getTransactionHistory` for diff use. Pulls the
 * full window's items at the 50-cap (the existing default) and surfaces
 * the truncated flag verbatim. Diff callers can decide whether to widen
 * the window or accept the under-count.
 */
export async function fetchChainHistory(args: {
  wallet: string;
  chain: AnyChain;
  startSec: number;
  endSec: number;
}): Promise<{ items: HistoryItem[]; truncated: boolean }> {
  const res = await getTransactionHistory({
    wallet: args.wallet,
    chain: args.chain,
    limit: 50,
    includeExternal: true,
    includeTokenTransfers: true,
    includeInternal: true,
    startTimestamp: args.startSec,
    endTimestamp: args.endSec,
  });
  return { items: res.items, truncated: res.truncated };
}

export type { AssetSnapshot };
