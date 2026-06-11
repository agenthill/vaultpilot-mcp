/**
 * `get_pnl_summary` — wallet-level net PnL over a preset time window
 * across EVM (Ethereum/Arbitrum/Polygon/Base/Optimism), TRON, and
 * Solana. Thin projection of `getPortfolioDiff`'s per-chain
 * decomposition: the diff tool computes `walletValueChange`, `netFlows`,
 * `priceEffect`, and `otherEffect`; PnL is just
 * `walletValueChange - netFlows = priceEffect + otherEffect`.
 *
 * Both tools share `composePerChainDiff` (in `../diff/index.ts`) so
 * their numbers cannot drift — same per-asset bigint accounting, same
 * historical-price fetch, same flow classification.
 *
 * v1 scope mirrors the diff tool's: wallet token balances only; DeFi
 * positions (Aave / Compound / Morpho supply yield, Lido stETH rebase,
 * Marinade/Jito/native staking accrual, MarginFi / Kamino lending
 * yield) collapse into the residual rather than getting their own
 * line. Bitcoin is intentionally omitted in v1 because the diff path
 * for BTC is "current balance only, no in-window flow accounting" —
 * a BTC PnL would be the price effect alone, which is misleading.
 *
 * `inception` is a 365-day rolling window in v1, NOT "since wallet
 * creation". The history fetcher caps at ~50 items per chain so a
 * literal "since-creation" walk would be unreliable for any
 * non-trivial wallet. The schema description says so.
 */

import { composePerChainDiff } from "../diff/index.js";
import type { ChainDiffSlice, AssetDiffRow } from "../diff/schemas.js";
import {
  assertAtLeastOneAddress,
  type GetPnlSummaryArgs,
  type PnlAssetRow,
  type PnlChainSlice,
  type PnlSummary,
} from "./schemas.js";

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Resolve a period enum to (startSec, endSec). */
function resolvePeriod(period: GetPnlSummaryArgs["period"]): {
  startSec: number;
  endSec: number;
} {
  const endMs = Date.now();
  let startMs: number;
  switch (period) {
    case "24h":
      startMs = endMs - 24 * 3_600_000;
      break;
    case "7d":
      startMs = endMs - 7 * 86_400_000;
      break;
    case "30d":
      startMs = endMs - 30 * 86_400_000;
      break;
    case "mtd": {
      const now = new Date(endMs);
      startMs = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
      break;
    }
    case "ytd":
      startMs = Date.UTC(new Date(endMs).getUTCFullYear(), 0, 1);
      break;
    case "inception":
      // 365d rolling — see file docstring for why "literal since-creation"
      // isn't honest with the current history-fetcher cap.
      startMs = endMs - 365 * 86_400_000;
      break;
  }
  return {
    startSec: Math.floor(startMs / 1000),
    endSec: Math.floor(endMs / 1000),
  };
}

/**
 * Project a diff's per-asset row to the simpler PnL row. Per-asset
 * `pnlUsd = endingValue - startingValue - netFlowUsd`.
 */
function projectAssetRow(row: AssetDiffRow): PnlAssetRow {
  const pnlUsd = round2(
    row.endingValueUsd - row.startingValueUsd - row.netFlowUsd,
  );
  return {
    symbol: row.symbol,
    token: row.token,
    startingQty: row.startingQty,
    endingQty: row.endingQty,
    ...(row.startingPriceUsd !== undefined
      ? { startingPriceUsd: row.startingPriceUsd }
      : {}),
    ...(row.endingPriceUsd !== undefined
      ? { endingPriceUsd: row.endingPriceUsd }
      : {}),
    pnlUsd,
  };
}

/**
 * Project a diff's chain slice to the PnL chain slice. The diff
 * already has `topLevelChangeUsd` and `netFlowsUsd`; per-chain PnL is
 * just their difference.
 */
function projectChainSlice(slice: ChainDiffSlice): PnlChainSlice {
  const pnlUsd = round2(slice.topLevelChangeUsd - slice.netFlowsUsd);
  return {
    chain: slice.chain,
    startingValueUsd: slice.startingValueUsd,
    endingValueUsd: slice.endingValueUsd,
    inflowsUsd: slice.inflowsUsd,
    outflowsUsd: slice.outflowsUsd,
    pnlUsd,
    perAsset: slice.perAsset.map(projectAssetRow),
    truncated: slice.truncated,
  };
}

export async function getPnlSummary(
  args: GetPnlSummaryArgs,
): Promise<PnlSummary> {
  assertAtLeastOneAddress(args);
  const { startSec, endSec } = resolvePeriod(args.period);

  const composed = await composePerChainDiff({
    wallet: args.wallet,
    tronAddress: args.tronAddress,
    solanaAddress: args.solanaAddress,
    startSec,
    endSec,
  });

  const slices = composed.slices.map(projectChainSlice);

  // Aggregate top-level numbers from chain slices. We re-aggregate from
  // the projection rather than reading the diff's pre-computed
  // top-level numbers because the projection drops some slices (none
  // currently, but the projection is the single source of truth for
  // what's surfaced — matches the Solana program-interaction skip
  // behavior that already lives in the composer).
  const startingValueUsd = round2(
    slices.reduce((s, c) => s + c.startingValueUsd, 0),
  );
  const endingValueUsd = round2(
    slices.reduce((s, c) => s + c.endingValueUsd, 0),
  );
  const inflowsUsd = round2(slices.reduce((s, c) => s + c.inflowsUsd, 0));
  const outflowsUsd = round2(slices.reduce((s, c) => s + c.outflowsUsd, 0));
  const netUserContributionUsd = round2(inflowsUsd - outflowsUsd);
  const walletValueChangeUsd = round2(endingValueUsd - startingValueUsd);
  const pnlUsd = round2(walletValueChangeUsd - netUserContributionUsd);

  const notes = [...composed.notes];
  notes.push(
    "DeFi position interest accrual (Aave / Compound / Morpho supply yield, " +
      "Lido stETH rebases, Marinade/Jito/native stake rewards, MarginFi / Kamino " +
      "lending) is collapsed into `pnlUsd` rather than separated. Per-protocol " +
      "attribution is a future enhancement.",
  );
  notes.push(
    "Gas costs are NOT subtracted — the underlying history items don't carry " +
      "`gasUsedUsd` today. v1 PnL excludes gas; for active wallets on cheap " +
      "chains this is small, on expensive ones it can be material.",
  );

  return {
    period: args.period,
    periodStartIso: new Date(startSec * 1000).toISOString(),
    periodEndIso: new Date(endSec * 1000).toISOString(),
    startingValueUsd,
    endingValueUsd,
    walletValueChangeUsd,
    inflowsUsd,
    outflowsUsd,
    netUserContributionUsd,
    pnlUsd,
    perChain: slices,
    truncated: composed.anyTruncated,
    priceCoverage: composed.anyMissedPrice ? "partial" : "full",
    notes,
  };
}
