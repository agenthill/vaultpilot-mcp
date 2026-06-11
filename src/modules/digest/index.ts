/**
 * `get_daily_briefing` — composer for the portfolio digest tool.
 * Implements `claude-work/plan-portfolio-digest.md` v1.
 *
 * Strategy: this tool owns NO new on-chain reads. Every section is
 * composed from existing tools:
 *
 *   - Current totals       → `getPortfolioSummary`
 *   - Window delta + movers → `getPortfolioDiff` (exposes per-asset
 *                             priceEffect + quantityEffect; we sort by
 *                             absolute USD change to find the movers)
 *   - Health alerts         → `getHealthAlerts` (Aave V3 only, EVM only)
 *   - Activity counts       → `getTransactionHistory` per chain, classified
 *                             into received / sent / swapped / supplied /
 *                             borrowed / repaid / withdrew / other based
 *                             on `methodName` (when 4byte resolved) and
 *                             `from`/`to` direction
 *
 * Sub-call failures degrade to per-section `notes` rather than aborting
 * the whole briefing — a Solana RPC outage shouldn't void the EVM
 * briefing. Counts default to zero when their fetchers fail; totals
 * default to whatever `getPortfolioSummary` succeeds with.
 *
 * Sections deferred at v1: `bestStablecoinYield` (depends on the
 * unshipped `compare_yields` tool) and `liquidationCalendar` (depends
 * on the unshipped `schedule_tx` tool). Both surface as `available:
 * false` with a reason rather than being silently dropped.
 */
import { getPortfolioSummary } from "../portfolio/index.js";
import { getPortfolioDiff } from "../diff/index.js";
import { getHealthAlerts } from "../positions/index.js";
import { getTransactionHistory } from "../history/index.js";
import type {
  PortfolioSummary,
  MultiWalletPortfolioSummary,
} from "../../types/index.js";
import type { PortfolioDiffSummary } from "../diff/schemas.js";
import type {
  HistoryItem,
  HistoryResponse,
} from "../history/schemas.js";
import {
  assertAtLeastOneAddress,
  type ActivityCounts,
  type DailyBriefing,
  type GetDailyBriefingArgs,
  type HealthAlertRow,
  type TopMover,
} from "./schemas.js";
import { renderBriefingNarrative } from "./render.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

/** Default cap on how many top movers to surface in the structured envelope. */
const TOP_MOVERS_LIMIT = 3;

/** Default HF threshold for the at-risk lending alert. */
const HEALTH_FACTOR_THRESHOLD = 1.5;

/**
 * History rows under this many absolute USD delta after pricing don't
 * make the top-movers cut even if there's nothing better. Filters out
 * dust + rounding-noise rows that would otherwise dominate fresh wallets.
 */
const TOP_MOVER_MIN_USD = 1;

export async function getDailyBriefing(
  args: GetDailyBriefingArgs,
): Promise<DailyBriefing> {
  assertAtLeastOneAddress(args);
  const period = args.period ?? "24h";
  const format = args.format ?? "both";
  const notes: string[] = [];

  // Fan out the four composer reads in parallel. Each is wrapped so a
  // failure becomes a `notes` entry rather than aborting the briefing.
  const [summaryResult, diffResult, healthResult, activityResult] =
    await Promise.all([
      readPortfolioSummary(args, notes),
      readPortfolioDiff(args, period, notes),
      readHealthAlerts(args, notes),
      readActivityCounts(args, period, notes),
    ]);

  const totals = computeTotals(summaryResult, diffResult);
  const topMovers = pickTopMovers(diffResult);
  const healthAlerts: { threshold: number; atRisk: HealthAlertRow[] } =
    healthResult ?? { threshold: HEALTH_FACTOR_THRESHOLD, atRisk: [] };

  const briefing: DailyBriefing = {
    period,
    // Window timestamps come from the diff when available; fall back
    // to a synthesized window from period if the diff failed.
    windowStartIso:
      diffResult?.windowStartIso ?? synthesizeWindowStartIso(period),
    windowEndIso:
      diffResult?.windowEndIso ?? new Date().toISOString(),
    addresses: pickAddresses(args),
    totals,
    topMovers,
    healthAlerts,
    activity: activityResult,
    bestStablecoinYield: {
      available: false,
      reason:
        "compare_yields tool not yet shipped — once it lands, this section " +
        "fills with the best Aave / Compound / Morpho supply rate for USDC + " +
        "USDT + USDS across the supported chains.",
    },
    liquidationCalendar: {
      available: false,
      reason:
        "schedule_tx tool not yet shipped — once it lands, this section " +
        "lists pending tx confirmations + nearest scheduled action.",
    },
    notes,
  };

  if (format !== "structured") {
    briefing.narrative = renderBriefingNarrative(briefing);
  }
  if (format === "narrative") {
    // Caller wants narrative-only; drop the structured guts to keep
    // the response payload lean (matches `getPortfolioDiff`'s same
    // semantic).
    return {
      ...briefing,
      // Keep the period + addresses + narrative; null out the bulk
      // fields. We can't drop them entirely without changing the
      // type — return zeroes/empty arrays so downstream re-mixes
      // get a coherent (if thin) object back.
      totals: { currentUsd: 0, changeUsd: 0 },
      topMovers: [],
      healthAlerts: { threshold: HEALTH_FACTOR_THRESHOLD, atRisk: [] },
      activity: emptyActivityCounts(),
      notes: [],
      narrative: briefing.narrative,
    };
  }
  return briefing;
}

// ---------- sub-reads (each is failure-tolerant) ----------

async function readPortfolioSummary(
  args: GetDailyBriefingArgs,
  notes: string[],
): Promise<PortfolioSummary | MultiWalletPortfolioSummary | null> {
  try {
    return await getPortfolioSummary(pickAddresses(args));
  } catch (e) {
    notes.push(
      `Portfolio total read failed: ${(e as Error).message ?? "unknown"}`,
    );
    return null;
  }
}

async function readPortfolioDiff(
  args: GetDailyBriefingArgs,
  period: "24h" | "7d" | "30d",
  notes: string[],
): Promise<PortfolioDiffSummary | null> {
  try {
    return await getPortfolioDiff({
      ...pickAddresses(args),
      window: period,
      // Keep the structured envelope so we can read `perAsset`; the
      // diff's narrative is the wrong voice for the digest's section
      // and would double-render.
      format: "structured",
    });
  } catch (e) {
    notes.push(
      `Window-delta read failed: ${(e as Error).message ?? "unknown"}`,
    );
    return null;
  }
}

async function readHealthAlerts(
  args: GetDailyBriefingArgs,
  notes: string[],
): Promise<{ threshold: number; atRisk: HealthAlertRow[] } | null> {
  // Issue #427: digest now mirrors the cross-protocol coverage in
  // `getHealthAlerts` (Aave / Compound V3 / Morpho / MarginFi / Kamino).
  // Without ANY wallet address (EVM or Solana) there's nothing to check —
  // return empty rather than a note (the user simply has no exposure).
  if (!args.wallet && !args.solanaAddress) {
    return { threshold: HEALTH_FACTOR_THRESHOLD, atRisk: [] };
  }
  try {
    const r = await getHealthAlerts({
      wallet: args.wallet,
      solanaWallet: args.solanaAddress,
      threshold: HEALTH_FACTOR_THRESHOLD,
    });
    if (r.notes && r.notes.length > 0) notes.push(...r.notes);
    return {
      threshold: r.threshold,
      atRisk: r.atRisk.map((a) => ({
        protocol: a.protocol,
        chain: a.chain,
        market: a.market,
        healthFactor: a.healthFactor,
        collateralUsd: a.collateralUsd,
        debtUsd: a.debtUsd,
        marginToLiquidation: a.marginToLiquidation,
      })),
    };
  } catch (e) {
    notes.push(
      `Health-alert check failed: ${(e as Error).message ?? "unknown"}`,
    );
    return null;
  }
}

async function readActivityCounts(
  args: GetDailyBriefingArgs,
  period: "24h" | "7d" | "30d",
  notes: string[],
): Promise<ActivityCounts> {
  const { startSec, endSec } = resolveWindowSeconds(period);
  const tasks: Array<Promise<HistoryResponse | null>> = [];

  // EVM: fan out per chain. The history fetcher's per-chain item cap
  // (~50) bounds latency; SUPPORTED_CHAINS gives the canonical list.
  if (args.wallet) {
    for (const chain of SUPPORTED_CHAINS) {
      tasks.push(
        fetchHistorySafely(
          {
            wallet: args.wallet,
            chain,
            startTimestamp: startSec,
            endTimestamp: endSec,
            limit: 50,
            includeExternal: true,
            includeTokenTransfers: true,
            includeInternal: true,
          },
          notes,
          chain,
        ),
      );
    }
  }
  if (args.tronAddress) {
    tasks.push(
      fetchHistorySafely(
        {
          wallet: args.tronAddress,
          chain: "tron",
          startTimestamp: startSec,
          endTimestamp: endSec,
          limit: 50,
          includeExternal: true,
          includeTokenTransfers: true,
          includeInternal: false,
        },
        notes,
        "tron",
      ),
    );
  }
  if (args.solanaAddress) {
    tasks.push(
      fetchHistorySafely(
        {
          wallet: args.solanaAddress,
          chain: "solana",
          startTimestamp: startSec,
          endTimestamp: endSec,
          limit: 50,
          includeExternal: true,
          includeTokenTransfers: true,
          includeInternal: true,
        },
        notes,
        "solana",
      ),
    );
  }
  // Bitcoin tx-history isn't currently exposed via getTransactionHistory;
  // skip rather than mis-classify.
  const responses = await Promise.all(tasks);

  const counts = emptyActivityCounts();
  for (const resp of responses) {
    if (!resp) continue;
    for (const item of resp.items) {
      classifyItem(item, args, counts);
    }
  }
  return counts;
}

async function fetchHistorySafely(
  input: Parameters<typeof getTransactionHistory>[0],
  notes: string[],
  chainLabel: string,
): Promise<HistoryResponse | null> {
  try {
    return await getTransactionHistory(input);
  } catch (e) {
    notes.push(
      `Activity read on ${chainLabel} failed: ${(e as Error).message ?? "unknown"}`,
    );
    return null;
  }
}

// ---------- composition helpers ----------

/** Extracts the optional address fields from args as a compact object. */
function pickAddresses(args: GetDailyBriefingArgs): {
  wallet?: string;
  tronAddress?: string;
  solanaAddress?: string;
  bitcoinAddress?: string;
} {
  return {
    ...(args.wallet ? { wallet: args.wallet } : {}),
    ...(args.tronAddress ? { tronAddress: args.tronAddress } : {}),
    ...(args.solanaAddress ? { solanaAddress: args.solanaAddress } : {}),
    ...(args.bitcoinAddress ? { bitcoinAddress: args.bitcoinAddress } : {}),
  };
}

function computeTotals(
  summary: PortfolioSummary | MultiWalletPortfolioSummary | null,
  diff: PortfolioDiffSummary | null,
): { currentUsd: number; changeUsd: number; changePct?: number } {
  const currentUsd = summary?.totalUsd ?? diff?.endingValueUsd ?? 0;
  const changeUsd = diff?.topLevelChangeUsd ?? 0;
  if (diff && diff.startingValueUsd > 0) {
    return {
      currentUsd,
      changeUsd,
      changePct: round2((changeUsd / diff.startingValueUsd) * 100),
    };
  }
  return { currentUsd, changeUsd };
}

function pickTopMovers(diff: PortfolioDiffSummary | null): TopMover[] {
  if (!diff) return [];
  // `perAsset` is per-chain; flatten + sort by |total change|.
  const movers = (diff.perChain ?? []).flatMap((slice) => slice.perAsset)
    .map((row) => {
      const changeUsd = row.endingValueUsd - row.startingValueUsd;
      return {
        symbol: row.symbol,
        chain: row.chain,
        startingValueUsd: row.startingValueUsd,
        endingValueUsd: row.endingValueUsd,
        changeUsd: round2(changeUsd),
        absChangeUsd: round2(Math.abs(changeUsd)),
      };
    })
    .filter((m) => m.absChangeUsd >= TOP_MOVER_MIN_USD)
    .sort((a, b) => b.absChangeUsd - a.absChangeUsd)
    .slice(0, TOP_MOVERS_LIMIT);
  return movers;
}

/**
 * Classify a history item into one of the activity buckets. Bucket
 * priority: explicit action (swap/supply/borrow/repay/withdraw) wins
 * over directional (received/sent), and directional wins over `other`.
 *
 * `methodName` resolution (4byte) is opt-in and best-effort; we lower-
 * case the lookup so "Swap" / "swapExactTokensForTokens" / etc. all
 * fold into the swap bucket.
 */
function classifyItem(
  item: HistoryItem,
  args: GetDailyBriefingArgs,
  counts: ActivityCounts,
): void {
  counts.total += 1;
  // Action-type via methodName (external txs only).
  if (item.type === "external" && item.methodName) {
    const m = item.methodName.toLowerCase();
    if (/swap/.test(m) || /exchange/.test(m)) {
      counts.swapped += 1;
      return;
    }
    if (/supply/.test(m) || /deposit/.test(m) || /^mint$/.test(m)) {
      counts.supplied += 1;
      return;
    }
    if (/borrow/.test(m)) {
      counts.borrowed += 1;
      return;
    }
    if (/repay/.test(m)) {
      counts.repaid += 1;
      return;
    }
    if (/withdraw/.test(m) || /^redeem$/.test(m)) {
      counts.withdrew += 1;
      return;
    }
  }
  // Directional fallback.
  const fromUs = matchesUserAddress(item.from, args);
  const toUs = matchesUserAddress(item.to, args);
  if (toUs && !fromUs) {
    counts.received += 1;
    return;
  }
  if (fromUs && !toUs) {
    counts.sent += 1;
    return;
  }
  // Self-send (same address) or program_interaction without a clear
  // direction → other.
  counts.other += 1;
}

function matchesUserAddress(
  candidate: string,
  args: GetDailyBriefingArgs,
): boolean {
  if (!candidate) return false;
  const lower = candidate.toLowerCase();
  if (args.wallet && args.wallet.toLowerCase() === lower) return true;
  if (args.tronAddress && args.tronAddress === candidate) return true;
  if (args.solanaAddress && args.solanaAddress === candidate) return true;
  if (args.bitcoinAddress && args.bitcoinAddress === candidate) return true;
  return false;
}

function emptyActivityCounts(): ActivityCounts {
  return {
    total: 0,
    received: 0,
    sent: 0,
    swapped: 0,
    supplied: 0,
    borrowed: 0,
    repaid: 0,
    withdrew: 0,
    other: 0,
  };
}

function resolveWindowSeconds(period: "24h" | "7d" | "30d"): {
  startSec: number;
  endSec: number;
} {
  const endSec = Math.floor(Date.now() / 1000);
  const days = period === "24h" ? 1 : period === "7d" ? 7 : 30;
  const startSec = endSec - days * 24 * 60 * 60;
  return { startSec, endSec };
}

function synthesizeWindowStartIso(period: "24h" | "7d" | "30d"): string {
  return new Date(resolveWindowSeconds(period).startSec * 1000).toISOString();
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
