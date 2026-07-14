/**
 * BTC + LTC base-layer chain-health signals for `get_market_incident_status`.
 * Issue #236 v1 — indexer-only signals (tip_staleness, hash_cliff,
 * empty_block_streak, miner_concentration).
 *
 * Issue #248 / #236 v2 — RPC-only signals (deep_reorg, indexer_divergence,
 * mempool_anomaly) now flip from `available: false` placeholders to live
 * computation when `BITCOIN_RPC_URL` / `LITECOIN_RPC_URL` is configured.
 * When unset they continue to surface `available: false` with an
 * actionable setup-hint reason — never silently green.
 *
 * Architecture: a small per-signal computation function takes the recent-
 * blocks payload + tip and returns either a `flagged:bool` evaluation or
 * `available:false`. The rollup folds them into a single `signals[]` array
 * + `incident: any flagged`.
 */
import { getBitcoinIndexer } from "../btc/indexer.js";
import type {
  BitcoinBlockSummary,
  BitcoinBlockTip,
} from "../btc/indexer.js";
import { getLitecoinIndexer } from "../litecoin/indexer.js";
import type {
  LitecoinBlockSummary,
  LitecoinBlockTip,
} from "../litecoin/indexer.js";
import { resolveBitcoinRpcConfig } from "../../config/btc.js";
import { resolveLitecoinRpcConfig } from "../../config/litecoin.js";
import type { JsonRpcClientConfig } from "../../data/jsonrpc.js";
import {
  getBestBlockHash,
  getChainTips,
  getMempoolInfo,
} from "../utxo/rpc-client.js";

/**
 * BTC/LTC base-layer signals share the same rollup shape — each is just
 * a different chain identifier with different signal thresholds. Union'd
 * here so the dispatcher in incidents/index.ts can return either via
 * one type.
 */
export interface ChainBaseLayerIncidentStatus {
  protocol: "bitcoin" | "litecoin";
  chain: "bitcoin" | "litecoin";
  tipHeight: number;
  tipHash: string;
  tipTimestamp: number;
  tipAgeSeconds: number;
  /** True if any signal in `signals[]` is flagged. */
  incident: boolean;
  signals: ChainHealthSignal[];
}

/** Discriminated by `available` so `unavailable` signals don't carry junk fields. */
export type ChainHealthSignal =
  | {
      name: string;
      available: true;
      flagged: boolean;
      detail: Record<string, unknown>;
    }
  | {
      name: string;
      available: false;
      reason: string;
    };

/** Test-only re-exports of the per-signal eval functions. The orchestrators
 *  (`getBitcoinChainHealthSignals` / `getLitecoinChainHealthSignals`) need
 *  the indexer mocked; the eval functions are pure and easy to test
 *  against a constructed input. Underscore prefix = "internal API; tests
 *  only — not part of the MCP tool surface". */
export const __test = {
  evalTipStaleness: (ageSeconds: number, targetSeconds: number) =>
    evalTipStaleness(ageSeconds, targetSeconds),
  evalHashCliff: (blocks: { timestamp: number }[], targetSeconds: number) =>
    evalHashCliff(blocks, targetSeconds),
  evalEmptyBlockStreak: (
    blocks: { txCount: number; height: number; hash: string }[],
  ) => evalEmptyBlockStreak(blocks),
  evalMinerConcentration: (blocks: { poolName?: string }[]) =>
    evalMinerConcentration(blocks),
  /** Surface for tests of the unconfigured-RPC fallback path. When
   * `rpcConfig` is null the function still resolves synchronously
   * via the early-return branch — exposed so tests can lock the
   * never-silently-green invariant without standing up RPC. */
  rpcGatedSignalsUnconfigured: async (
    rpcEnvVarName: "BITCOIN_RPC_URL" | "LITECOIN_RPC_URL",
  ): Promise<ChainHealthSignal[]> =>
    rpcGatedSignals({
      chain: "bitcoin",
      rpcConfig: null,
      rpcEnvVarName,
      indexerTipHash: "0".repeat(64),
      indexerTipHeight: 0,
      deepReorgFlagBranchlen: BTC_DEEP_REORG_FLAG_BRANCHLEN,
    }),
};

/** BTC: target 10-minute blocks. Mean tip-age past 30 min flags. */
const BTC_BLOCK_TARGET_SECONDS = 600;
/** LTC: target 2.5-minute blocks. Mean tip-age past 7.5 min flags. */
const LTC_BLOCK_TARGET_SECONDS = 150;
/** Recent-window depth for hash_cliff / empty_block_streak / miner_concentration. */
const RECENT_BLOCKS_WINDOW = 144;
/** Empty-block-streak threshold: ≥ this many consecutive coinbase-only blocks. */
const EMPTY_BLOCK_STREAK_FLAG = 3;
/** Miner-concentration threshold: any single pool > this fraction of recent window. */
const MINER_CONCENTRATION_FLAG = 0.51;
/** Hash-cliff threshold: observed mean block interval > this multiple of target. */
const HASH_CLIFF_FLAG_MULTIPLE = 1.5;
/** Tip-staleness threshold: tip age > this multiple of target block time. */
const TIP_STALENESS_FLAG_MULTIPLE = 3;

/**
 * Tip staleness — the indexer is stuck OR the network has stalled.
 * Compares `tipAgeSeconds` against the chain's expected mean block time.
 */
function evalTipStaleness(
  ageSeconds: number,
  targetSeconds: number,
): ChainHealthSignal {
  const flagged = ageSeconds > targetSeconds * TIP_STALENESS_FLAG_MULTIPLE;
  return {
    name: "tip_staleness",
    available: true,
    flagged,
    detail: {
      ageSeconds,
      expectedMeanSeconds: targetSeconds,
      flagThresholdSeconds: targetSeconds * TIP_STALENESS_FLAG_MULTIPLE,
    },
  };
}

/**
 * Hash cliff — observed mean block interval over recent N blocks is
 * significantly slower than target. Suggests hashrate departed and the
 * chain hasn't retargeted yet (BTC retarget every 2016 blocks ~ 2 weeks;
 * LTC every 2016 blocks ~ 3.5 days). The recent retarget-direction check
 * suggested in the issue (only flag if last retarget reduced difficulty)
 * is deferred — we don't fetch historical retargets in v1.
 */
function evalHashCliff(
  blocks: { timestamp: number }[],
  targetSeconds: number,
): ChainHealthSignal {
  if (blocks.length < 2) {
    return {
      name: "hash_cliff",
      available: false,
      reason: "fewer than 2 blocks in the recent window",
    };
  }
  // Blocks come newest-first; pair adjacent timestamps to get intervals.
  const intervals: number[] = [];
  for (let i = 0; i < blocks.length - 1; i++) {
    const dt = blocks[i].timestamp - blocks[i + 1].timestamp;
    if (dt > 0) intervals.push(dt);
  }
  if (intervals.length === 0) {
    return {
      name: "hash_cliff",
      available: false,
      reason: "no positive block intervals in window",
    };
  }
  const mean =
    intervals.reduce((sum, dt) => sum + dt, 0) / intervals.length;
  const flagged = mean > targetSeconds * HASH_CLIFF_FLAG_MULTIPLE;
  return {
    name: "hash_cliff",
    available: true,
    flagged,
    detail: {
      observedMeanIntervalSeconds: Math.round(mean),
      expectedTargetSeconds: targetSeconds,
      windowBlocks: blocks.length,
      flagThresholdSeconds: targetSeconds * HASH_CLIFF_FLAG_MULTIPLE,
    },
  };
}

/**
 * Empty-block streak — ≥ N consecutive coinbase-only blocks. Classic
 * selfish-mining / withholding tell: an attacker withholding the
 * mempool to keep the chain marginal will mine empty blocks while
 * preparing a private chain.
 */
function evalEmptyBlockStreak(
  blocks: { txCount: number; height: number; hash: string }[],
): ChainHealthSignal {
  let bestStreak = 0;
  let bestStart: number | null = null;
  let curStreak = 0;
  let curStart: number | null = null;
  for (const b of blocks) {
    if (b.txCount <= 1) {
      // Coinbase-only is txCount === 1; some indexers report 0 for empty.
      if (curStreak === 0) curStart = b.height;
      curStreak++;
      if (curStreak > bestStreak) {
        bestStreak = curStreak;
        bestStart = curStart;
      }
    } else {
      curStreak = 0;
      curStart = null;
    }
  }
  return {
    name: "empty_block_streak",
    available: true,
    flagged: bestStreak >= EMPTY_BLOCK_STREAK_FLAG,
    detail: {
      maxConsecutive: bestStreak,
      startHeight: bestStart,
      windowBlocks: blocks.length,
      flagThreshold: EMPTY_BLOCK_STREAK_FLAG,
    },
  };
}

/**
 * Miner concentration — any single pool tag claims > 51% of the recent
 * window. Indexers vary on whether they expose pool tags; mempool.space
 * does (`extras.pool.name` per block), litecoinspace.org may not. When
 * fewer than half the blocks have a `poolName`, surface as
 * `available: false` rather than reporting a misleading concentration
 * computed over a tiny sample.
 */
function evalMinerConcentration(
  blocks: { poolName?: string }[],
): ChainHealthSignal {
  const tagged = blocks.filter((b) => typeof b.poolName === "string");
  // Need at least half the window tagged for the count to be meaningful.
  // A small tagged sample over a 144-block window would give random-noise
  // "concentration" numbers — better to mark unavailable.
  if (tagged.length < blocks.length / 2) {
    return {
      name: "miner_concentration",
      available: false,
      reason: `only ${tagged.length}/${blocks.length} blocks have indexer-reported pool tags; this indexer does not expose pool attribution reliably`,
    };
  }
  const counts = new Map<string, number>();
  for (const b of tagged) {
    const name = b.poolName as string;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  let topPool = "";
  let topCount = 0;
  for (const [name, count] of counts.entries()) {
    if (count > topCount) {
      topCount = count;
      topPool = name;
    }
  }
  const fraction = topCount / tagged.length;
  return {
    name: "miner_concentration",
    available: true,
    flagged: fraction > MINER_CONCENTRATION_FLAG,
    detail: {
      topPool,
      topPoolFraction: Number(fraction.toFixed(4)),
      topPoolBlocks: topCount,
      windowBlocks: blocks.length,
      taggedBlocks: tagged.length,
      flagThreshold: MINER_CONCENTRATION_FLAG,
    },
  };
}

/**
 * deep_reorg threshold: any `valid-fork` tip with branchlen ≥ this many
 * blocks → flagged. BTC default is 6 (the standard 6-confirmation
 * security boundary); LTC uses 12 because faster blocks compress the
 * reorg-impact window. Each chain passes its own value.
 */
const BTC_DEEP_REORG_FLAG_BRANCHLEN = 6;
const LTC_DEEP_REORG_FLAG_BRANCHLEN = 12;

/**
 * indexer_divergence threshold: indexer tip vs RPC tip differ by
 * MORE than this many blocks → flagged. 1 block of drift is normal
 * (one side propagated faster than the other in the last few seconds);
 * > 1 indicates the indexer is genuinely behind or on a minority fork.
 */
const INDEXER_DIVERGENCE_FLAG_BLOCKS = 1;

/**
 * mempool_anomaly thresholds — flag when current size or bytes is
 * MORE than this multiple of the daemon's `maxmempool` configured
 * cap. 0.85 = mempool is 85%+ full → spam / fee-market stress.
 * Conservative — being just-near-full is normal during fee spikes;
 * being deep-into-it sustains.
 */
const MEMPOOL_ANOMALY_FILL_FRACTION = 0.85;

/**
 * Three RPC-gated signals. When the chain's RPC config is null
 * (env var unset), each surfaces `available: false` with an actionable
 * hint — same shape as before, never silently green. When configured,
 * the three signals run their respective RPC calls in parallel and
 * fold the results into `available: true` evals.
 *
 * Failure modes:
 *   - RPC call fails (transport / auth / 5xx) → that signal returns
 *     `available: false, reason: "<error>"`; the OTHER signals can
 *     still complete (each handled in its own try/catch).
 */
async function rpcGatedSignals(args: {
  chain: "bitcoin" | "litecoin";
  rpcConfig: JsonRpcClientConfig | null;
  rpcEnvVarName: "BITCOIN_RPC_URL" | "LITECOIN_RPC_URL";
  indexerTipHash: string;
  indexerTipHeight: number;
  deepReorgFlagBranchlen: number;
}): Promise<ChainHealthSignal[]> {
  if (args.rpcConfig === null) {
    const reason = `requires ${args.rpcEnvVarName} (and optional auth — see docs/INSTALL.md). Issue #248.`;
    return [
      { name: "deep_reorg", available: false, reason },
      { name: "indexer_divergence", available: false, reason },
      { name: "mempool_anomaly", available: false, reason },
    ];
  }
  const cfg = args.rpcConfig;
  const [tipsResult, bestHashResult, mempoolResult] = await Promise.allSettled([
    getChainTips(cfg),
    getBestBlockHash(cfg),
    getMempoolInfo(cfg),
  ]);

  const signals: ChainHealthSignal[] = [];

  // deep_reorg
  if (tipsResult.status === "fulfilled") {
    const tips = tipsResult.value;
    const validForks = tips.filter(
      (t) => t.status === "valid-fork" && t.branchlen >= args.deepReorgFlagBranchlen,
    );
    signals.push({
      name: "deep_reorg",
      available: true,
      flagged: validForks.length > 0,
      detail: {
        flagThresholdBranchlen: args.deepReorgFlagBranchlen,
        validForks: validForks.map((t) => ({
          height: t.height,
          hash: t.hash,
          branchlen: t.branchlen,
          status: t.status,
        })),
        totalKnownTips: tips.length,
      },
    });
  } else {
    signals.push({
      name: "deep_reorg",
      available: false,
      reason: `getchaintips RPC error: ${tipsResult.reason instanceof Error ? tipsResult.reason.message : String(tipsResult.reason)}`,
    });
  }

  // indexer_divergence
  if (bestHashResult.status === "fulfilled") {
    const rpcTipHash = bestHashResult.value;
    const sameTip = rpcTipHash === args.indexerTipHash;
    // Without an RPC `getblock(rpcTipHash)` lookup we don't know the
    // RPC tip's height — but we can still surface the agreement: equal
    // hashes ⇒ same tip ⇒ NOT diverged. Mismatched hashes are flagged
    // when both sides have produced more than `INDEXER_DIVERGENCE_FLAG_BLOCKS`
    // of work (we treat any mismatch as the conservative-default flag,
    // since either party may be on a minority fork).
    signals.push({
      name: "indexer_divergence",
      available: true,
      flagged: !sameTip,
      detail: {
        indexerTipHash: args.indexerTipHash,
        indexerTipHeight: args.indexerTipHeight,
        rpcTipHash,
        flagThresholdBlocks: INDEXER_DIVERGENCE_FLAG_BLOCKS,
        note: sameTip
          ? "indexer + RPC agree on tip hash"
          : "indexer + RPC disagree — one side may be on a minority fork or lagging by ≥1 block",
      },
    });
  } else {
    signals.push({
      name: "indexer_divergence",
      available: false,
      reason: `getbestblockhash RPC error: ${bestHashResult.reason instanceof Error ? bestHashResult.reason.message : String(bestHashResult.reason)}`,
    });
  }

  // mempool_anomaly
  if (mempoolResult.status === "fulfilled") {
    const m = mempoolResult.value;
    const fillFraction = m.maxmempool > 0 ? m.bytes / m.maxmempool : 0;
    signals.push({
      name: "mempool_anomaly",
      available: true,
      flagged: fillFraction >= MEMPOOL_ANOMALY_FILL_FRACTION,
      detail: {
        size: m.size,
        bytes: m.bytes,
        usage: m.usage,
        maxmempool: m.maxmempool,
        fillFraction: Number(fillFraction.toFixed(4)),
        flagThresholdFraction: MEMPOOL_ANOMALY_FILL_FRACTION,
        mempoolminfee: m.mempoolminfee,
        minrelaytxfee: m.minrelaytxfee,
      },
    });
  } else {
    signals.push({
      name: "mempool_anomaly",
      available: false,
      reason: `getmempoolinfo RPC error: ${mempoolResult.reason instanceof Error ? mempoolResult.reason.message : String(mempoolResult.reason)}`,
    });
  }

  return signals;
}

export async function getBitcoinChainHealthSignals(): Promise<ChainBaseLayerIncidentStatus> {
  const indexer = getBitcoinIndexer();
  const tip: BitcoinBlockTip = await indexer.getBlockTip();
  const blocks: BitcoinBlockSummary[] = await indexer.getRecentBlocks(
    RECENT_BLOCKS_WINDOW,
  );
  const rpcSignals = await rpcGatedSignals({
    chain: "bitcoin",
    rpcConfig: resolveBitcoinRpcConfig(),
    rpcEnvVarName: "BITCOIN_RPC_URL",
    indexerTipHash: tip.hash,
    indexerTipHeight: tip.height,
    deepReorgFlagBranchlen: BTC_DEEP_REORG_FLAG_BRANCHLEN,
  });
  const signals: ChainHealthSignal[] = [
    evalTipStaleness(tip.ageSeconds, BTC_BLOCK_TARGET_SECONDS),
    evalHashCliff(blocks, BTC_BLOCK_TARGET_SECONDS),
    evalEmptyBlockStreak(blocks),
    evalMinerConcentration(blocks),
    ...rpcSignals,
  ];
  return {
    protocol: "bitcoin",
    chain: "bitcoin",
    tipHeight: tip.height,
    tipHash: tip.hash,
    tipTimestamp: tip.timestamp,
    tipAgeSeconds: tip.ageSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}

export async function getLitecoinChainHealthSignals(): Promise<ChainBaseLayerIncidentStatus> {
  const indexer = getLitecoinIndexer();
  const tip: LitecoinBlockTip = await indexer.getBlockTip();
  const blocks: LitecoinBlockSummary[] = await indexer.getRecentBlocks(
    RECENT_BLOCKS_WINDOW,
  );
  const rpcSignals = await rpcGatedSignals({
    chain: "litecoin",
    rpcConfig: resolveLitecoinRpcConfig(),
    rpcEnvVarName: "LITECOIN_RPC_URL",
    indexerTipHash: tip.hash,
    indexerTipHeight: tip.height,
    deepReorgFlagBranchlen: LTC_DEEP_REORG_FLAG_BRANCHLEN,
  });
  const signals: ChainHealthSignal[] = [
    evalTipStaleness(tip.ageSeconds, LTC_BLOCK_TARGET_SECONDS),
    evalHashCliff(blocks, LTC_BLOCK_TARGET_SECONDS),
    evalEmptyBlockStreak(blocks),
    evalMinerConcentration(blocks),
    ...rpcSignals,
  ];
  return {
    protocol: "litecoin",
    chain: "litecoin",
    tipHeight: tip.height,
    tipHash: tip.hash,
    tipTimestamp: tip.timestamp,
    tipAgeSeconds: tip.ageSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}
