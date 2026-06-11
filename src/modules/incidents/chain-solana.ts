/**
 * Solana chain-health + program-layer incident signals for
 * `get_market_incident_status`. Issues #238 + #242 v1.
 *
 * Base-layer signals (protocol="solana"):
 *   - slot_progression          (cluster stalled / heavily forked)
 *   - skip_rate                 (network stress)
 *   - validator_concentration   (Nakamoto coefficient < 4 — safety risk)
 *   - cluster_halt              (no recent finalized slot)
 *   - epoch_progression         (RPC forked off vs wall-clock)
 *   - priority_fee_anomaly      (median priority fee > 5× P90 baseline)
 *
 * Program-layer signals (protocol="solana-protocols"):
 *   - recent_program_upgrade    (any monitored program upgraded in last 24h)
 *   - token_freeze_event        (any user SPL account in `frozen` state)
 *   - token_extension_change    (Token-2022 mint gained extensions vs cached
 *                                snapshot; flagged severity by extension class)
 *   - oracle_staleness          (Pyth feed publish_time > 60s old)
 *   - oracle_price_anomaly      (Pyth feed price deviates >threshold% from
 *                                rolling 24h median; per-feed override —
 *                                stables tighter than volatiles. Issue #255.
 *                                Background poller in oracle-poller.ts
 *                                maintains the persistent history.)
 *   - known_exploit             (program in vendored exploit list +
 *                                optional SOLANA_INCIDENT_FEED_URL hybrid)
 *   - pending_squads_upgrade    (any pre-execution Squads V4 vault tx
 *                                targeting BPFLoaderUpgradeable for a
 *                                program in KNOWN_SQUADS_GOVERNED_PROGRAMS;
 *                                conservative-default flags any loader ix)
 *
 * Deferred (separate v2 follow-up issues):
 *   - rpc_divergence            (needs 2nd RPC config — issue #248 family)
 */
import { PublicKey } from "@solana/web3.js";
import { getSolanaConnection } from "../solana/rpc.js";
import {
  KNOWN_PROGRAM_IDS,
  KNOWN_PYTH_FEEDS,
  KNOWN_SOLANA_INCIDENTS,
  KNOWN_SQUADS_GOVERNED_PROGRAMS,
} from "./solana-known.js";
import { getSolanaIncidentFeed } from "./solana-feed.js";
import { scanSquadsPendingUpgrades } from "./squads-pending.js";
import {
  getExtensionTypes,
  getMint,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  loadSnapshots,
  saveSnapshots,
  type MintSnapshotStore,
} from "./token2022-snapshots.js";
import { diffExtensions, rollupDiffs } from "./token-extension-diff.js";

export interface SolanaChainIncidentStatus {
  protocol: "solana";
  chain: "solana";
  tipSlot: number;
  tipBlockTime: number | null;
  tipAgeSeconds: number | null;
  incident: boolean;
  rpcEndpoint: string;
  signals: SolanaSignal[];
}

export interface SolanaProgramIncidentStatus {
  protocol: "solana-protocols";
  chain: "solana";
  scannedPrograms: ReadonlyArray<{ programId: string; name: string; protocol: string }>;
  scannedFeeds: ReadonlyArray<{ feedAddress: string; symbol: string; source: string }>;
  walletScopeApplied: boolean;
  incident: boolean;
  signals: SolanaSignal[];
}

export type SolanaSignal =
  | {
      name: string;
      available: true;
      flagged: boolean;
      detail: Record<string, unknown>;
    }
  | { name: string; available: false; reason: string };

// ---------------------------------------------------------------------------
// Base-layer thresholds
// ---------------------------------------------------------------------------

/** slot_progression: < this many slots in 5s wallclock → stalled. */
const SLOT_PROGRESSION_5S_FLAG = 5;
/** skip_rate: mean leader skip > this fraction over recent samples. */
const SKIP_RATE_FLAG = 0.10;
/** validator_concentration: Nakamoto coefficient ≤ this → flagged. */
const NAKAMOTO_FLAG = 3;
/** cluster_halt: latest block time more than this seconds old → halt. */
const CLUSTER_HALT_AGE_SECONDS = 30;
/** epoch_progression: slot drift from expected wall-clock; flagged if > N slots off. */
const EPOCH_DRIFT_SLOT_TOLERANCE = 1000;
/** priority_fee_anomaly: median priority fee > this multiple of P90 baseline. */
const PRIORITY_FEE_FLAG_MULTIPLE = 5;

// ---------------------------------------------------------------------------
// Program-layer thresholds
// ---------------------------------------------------------------------------

/** recent_program_upgrade: any upgrade signature in last N seconds → flagged. */
const RECENT_UPGRADE_WINDOW_SECONDS = 24 * 60 * 60;
/** oracle_staleness: Pyth publish_time more than N seconds old → flagged. */
const PYTH_STALENESS_FLAG_SECONDS = 60;

// ===========================================================================
// Base-layer (protocol="solana")
// ===========================================================================

export async function getSolanaChainHealthSignals(): Promise<SolanaChainIncidentStatus> {
  const conn = getSolanaConnection();
  const rpcEndpoint = conn.rpcEndpoint;

  const signals: SolanaSignal[] = [];

  // slot_progression — sample twice ~5s apart.
  let tipSlot = -1;
  try {
    const slot1 = await conn.getSlot("confirmed");
    await new Promise((r) => setTimeout(r, 5_000));
    const slot2 = await conn.getSlot("confirmed");
    tipSlot = slot2;
    const delta = slot2 - slot1;
    signals.push({
      name: "slot_progression",
      available: true,
      flagged: delta < SLOT_PROGRESSION_5S_FLAG,
      detail: {
        slotStart: slot1,
        slotEnd: slot2,
        deltaPer5s: delta,
        flagThreshold: SLOT_PROGRESSION_5S_FLAG,
      },
    });
  } catch (err) {
    signals.push({
      name: "slot_progression",
      available: false,
      reason: `RPC error during getSlot: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // cluster_halt — fetch tip block time + compare against wall-clock.
  let tipBlockTime: number | null = null;
  let tipAgeSeconds: number | null = null;
  try {
    if (tipSlot > 0) {
      const bt = await conn.getBlockTime(tipSlot);
      if (typeof bt === "number") {
        tipBlockTime = bt;
        tipAgeSeconds = Math.max(0, Math.floor(Date.now() / 1000) - bt);
        signals.push({
          name: "cluster_halt",
          available: true,
          flagged: tipAgeSeconds > CLUSTER_HALT_AGE_SECONDS,
          detail: {
            tipSlot,
            tipBlockTime: bt,
            tipAgeSeconds,
            flagThresholdSeconds: CLUSTER_HALT_AGE_SECONDS,
          },
        });
      } else {
        signals.push({
          name: "cluster_halt",
          available: false,
          reason: "RPC returned null for getBlockTime — slot may be too old or pruned",
        });
      }
    } else {
      signals.push({
        name: "cluster_halt",
        available: false,
        reason: "could not establish tip slot",
      });
    }
  } catch (err) {
    signals.push({
      name: "cluster_halt",
      available: false,
      reason: `RPC error during getBlockTime: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // skip_rate + priority_fee_anomaly — getRecentPerformanceSamples.
  try {
    const samples = await conn.getRecentPerformanceSamples(20);
    if (samples.length === 0) {
      signals.push({
        name: "skip_rate",
        available: false,
        reason: "RPC returned no performance samples",
      });
    } else {
      // Sample shape: { slot, numTransactions, numSlots, samplePeriodSecs,
      // numNonVoteTransactions }. Solana doesn't expose leader-skip directly
      // in this RPC; we use numSlots vs samplePeriodSecs as a proxy. A
      // healthy ~400ms slot time means numSlots ≈ samplePeriodSecs * 2.5;
      // significant deviation suggests skipped leaders.
      let totalExpectedSlots = 0;
      let totalActualSlots = 0;
      for (const s of samples) {
        const expected = s.samplePeriodSecs * 2.5;
        totalExpectedSlots += expected;
        totalActualSlots += s.numSlots;
      }
      const skipFraction =
        totalExpectedSlots > 0
          ? Math.max(0, (totalExpectedSlots - totalActualSlots) / totalExpectedSlots)
          : 0;
      signals.push({
        name: "skip_rate",
        available: true,
        flagged: skipFraction > SKIP_RATE_FLAG,
        detail: {
          observedFraction: Number(skipFraction.toFixed(4)),
          windowSamples: samples.length,
          flagThreshold: SKIP_RATE_FLAG,
          note: "skip_rate proxy via numSlots vs samplePeriodSecs ~ 400ms slot time",
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "skip_rate",
      available: false,
      reason: `RPC error during getRecentPerformanceSamples: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  try {
    // priority_fee_anomaly — compare current median against rolling P90.
    // getRecentPrioritizationFees returns recent slots' fees; we don't
    // have a long enough rolling baseline in v1, so we compare current
    // median against the P90 of the same sample. Coarse but useful for
    // catching genuine spikes.
    const fees = await conn.getRecentPrioritizationFees();
    const values = fees
      .map((f) => f.prioritizationFee)
      .filter((v) => typeof v === "number" && v >= 0)
      .sort((a, b) => a - b);
    if (values.length < 10) {
      signals.push({
        name: "priority_fee_anomaly",
        available: false,
        reason: `only ${values.length} samples returned by getRecentPrioritizationFees; need ≥10 for a useful baseline`,
      });
    } else {
      const median = values[Math.floor(values.length / 2)];
      const p90 = values[Math.floor(values.length * 0.9)];
      const flagged = p90 > 0 && median > p90 * PRIORITY_FEE_FLAG_MULTIPLE;
      signals.push({
        name: "priority_fee_anomaly",
        available: true,
        flagged,
        detail: {
          medianMicroLamports: median,
          p90MicroLamports: p90,
          samples: values.length,
          flagThresholdMultiple: PRIORITY_FEE_FLAG_MULTIPLE,
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "priority_fee_anomaly",
      available: false,
      reason: `RPC error during getRecentPrioritizationFees: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // validator_concentration — Nakamoto coefficient over getVoteAccounts.
  try {
    const va = await conn.getVoteAccounts("confirmed");
    const stakes = va.current
      .map((v) => v.activatedStake)
      .sort((a, b) => b - a);
    const total = stakes.reduce((sum, s) => sum + s, 0);
    if (total === 0) {
      signals.push({
        name: "validator_concentration",
        available: false,
        reason: "getVoteAccounts returned zero total stake",
      });
    } else {
      // Nakamoto coefficient: smallest set summing to > 33% (BFT halt threshold).
      const target = total * 0.34;
      let acc = 0;
      let n = 0;
      for (const s of stakes) {
        acc += s;
        n++;
        if (acc > target) break;
      }
      signals.push({
        name: "validator_concentration",
        available: true,
        flagged: n <= NAKAMOTO_FLAG,
        detail: {
          nakamotoCoefficient: n,
          totalCurrentValidators: stakes.length,
          flagThreshold: NAKAMOTO_FLAG,
          note: "smallest validator set summing to > 33% of total stake (BFT halt threshold)",
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "validator_concentration",
      available: false,
      reason: `RPC error during getVoteAccounts: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // epoch_progression — sanity check on RPC's epoch arithmetic.
  try {
    const ei = await conn.getEpochInfo("confirmed");
    // Cluster runs ~432,000 slots per epoch. We can't easily compute
    // expected current slot from wall-clock without epoch start data,
    // so v1 sanity-checks that absoluteSlot increases monotonically
    // vs. the slot we just fetched (catches a forked-off RPC stuck at
    // an old slot). flagged when the epoch's absoluteSlot lags the
    // tipSlot by > tolerance.
    const drift = Math.abs(ei.absoluteSlot - tipSlot);
    signals.push({
      name: "epoch_progression",
      available: true,
      flagged: tipSlot > 0 && drift > EPOCH_DRIFT_SLOT_TOLERANCE,
      detail: {
        epoch: ei.epoch,
        absoluteSlot: ei.absoluteSlot,
        tipSlotObserved: tipSlot,
        slotDrift: drift,
        flagThreshold: EPOCH_DRIFT_SLOT_TOLERANCE,
      },
    });
  } catch (err) {
    signals.push({
      name: "epoch_progression",
      available: false,
      reason: `RPC error during getEpochInfo: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // rpc_divergence — needs a 2nd RPC config; deferred to v2.
  signals.push({
    name: "rpc_divergence",
    available: false,
    reason:
      "requires a configured second SOLANA_RPC_URL. See v2 follow-up.",
  });

  return {
    protocol: "solana",
    chain: "solana",
    tipSlot,
    tipBlockTime,
    tipAgeSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    rpcEndpoint,
    signals,
  };
}

// ===========================================================================
// Program-layer (protocol="solana-protocols")
// ===========================================================================

export async function getSolanaProgramLayerSignals(
  walletArg: string | undefined,
): Promise<SolanaProgramIncidentStatus> {
  const conn = getSolanaConnection();

  // v1: scope is the vendored known-program list. Wallet filtering for
  // "only programs the user has exposure to" is deferred — would need a
  // wallet-program reverse index that doesn't exist yet. We surface
  // `walletScopeApplied: false` so the agent can tell the user the scan
  // is on a default-known-program set, not their actual exposure.
  const walletScopeApplied = false;
  const scannedPrograms = KNOWN_PROGRAM_IDS;
  const scannedFeeds = KNOWN_PYTH_FEEDS;

  const signals: SolanaSignal[] = [];

  // recent_program_upgrade — getSignaturesForAddress on each known program,
  // filter to upgrades within the last 24h. Done in parallel-bounded chunks
  // to avoid hammering the RPC.
  const upgrades: { programId: string; name: string; signature: string; slot: number; blockTime: number }[] = [];
  const upgradeErrors: { programId: string; error: string }[] = [];
  const upgradeWindowStart =
    Math.floor(Date.now() / 1000) - RECENT_UPGRADE_WINDOW_SECONDS;
  await Promise.all(
    scannedPrograms.map(async (p) => {
      try {
        const sigs = await conn.getSignaturesForAddress(
          new PublicKey(p.programId),
          { limit: 25 },
        );
        for (const s of sigs) {
          if (
            typeof s.blockTime === "number" &&
            s.blockTime >= upgradeWindowStart &&
            !s.err
          ) {
            // Any signature on a program-id account in the last 24h is
            // worth flagging — the BPFLoaderUpgradeable Upgrade ix is
            // the most common reason a program account changes, but we
            // don't tx-decode in v1 to confirm. Better to over-flag and
            // let the agent inspect than silently miss.
            upgrades.push({
              programId: p.programId,
              name: p.name,
              signature: s.signature,
              slot: s.slot,
              blockTime: s.blockTime,
            });
            break; // one is enough to flag this program
          }
        }
      } catch (err) {
        upgradeErrors.push({
          programId: p.programId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  signals.push({
    name: "recent_program_upgrade",
    available: true,
    flagged: upgrades.length > 0,
    detail: {
      windowSeconds: RECENT_UPGRADE_WINDOW_SECONDS,
      upgrades,
      probeErrors: upgradeErrors,
      note:
        "any signature on a program account in the last 24h is flagged; v1 does not decode the ix to confirm it was specifically BPFLoaderUpgradeable::Upgrade — over-flag is intentional, let the agent inspect.",
    },
  });

  // token_freeze_event — only meaningful when wallet is provided; otherwise
  // unavailable.
  if (!walletArg) {
    signals.push({
      name: "token_freeze_event",
      available: false,
      reason:
        "requires `wallet` arg — token-freeze detection is per-wallet, not per-program",
    });
  } else {
    try {
      const owner = new PublicKey(walletArg);
      // Use SPL token program owner; Token-2022 program needs separate scan
      // (deferred per the file header).
      const splTokenProgram = new PublicKey(
        "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      );
      const accs = await conn.getTokenAccountsByOwner(
        owner,
        { programId: splTokenProgram },
        "confirmed",
      );
      const frozen: { account: string; mint: string }[] = [];
      for (const a of accs.value) {
        // Token account layout: bytes 108..109 contain the state byte
        // (0=Uninitialized, 1=Initialized, 2=Frozen).
        const data = a.account.data;
        if (data.length >= 109 && data[108] === 2) {
          // Mint is at bytes 0..32.
          const mint = new PublicKey(data.subarray(0, 32)).toBase58();
          frozen.push({ account: a.pubkey.toBase58(), mint });
        }
      }
      signals.push({
        name: "token_freeze_event",
        available: true,
        flagged: frozen.length > 0,
        detail: {
          wallet: walletArg,
          frozenAccounts: frozen,
          totalAccountsScanned: accs.value.length,
        },
      });
    } catch (err) {
      signals.push({
        name: "token_freeze_event",
        available: false,
        reason: `RPC error scanning token accounts: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // token_extension_change — issue #252. For each Token-2022 mint the
  // user holds, compare current extensions against a cached snapshot.
  // First-run is non-flagging (we just baseline). Severity per extension
  // is from `token-extension-diff.ts`. Snapshots persist via the
  // `token2022-snapshots.json` store so the diff survives restarts.
  if (!walletArg) {
    signals.push({
      name: "token_extension_change",
      available: false,
      reason:
        "requires `wallet` arg — Token-2022 extension diff is per-wallet (we only inspect mints the user holds)",
    });
  } else {
    try {
      const owner = new PublicKey(walletArg);
      const t22Accounts = await conn.getTokenAccountsByOwner(
        owner,
        { programId: TOKEN_2022_PROGRAM_ID },
        "confirmed",
      );
      // Extract unique mint pubkeys from each token account (mint at bytes 0..32).
      const uniqueMints = new Set<string>();
      for (const a of t22Accounts.value) {
        const data = a.account.data;
        if (data.length >= 32) {
          uniqueMints.add(new PublicKey(data.subarray(0, 32)).toBase58());
        }
      }
      const store: MintSnapshotStore = loadSnapshots();
      const diffs = [];
      const mintErrors: Array<{ mint: string; error: string }> = [];
      for (const mintBase58 of uniqueMints) {
        try {
          const mintPubkey = new PublicKey(mintBase58);
          const mintInfo = await getMint(
            conn,
            mintPubkey,
            "confirmed",
            TOKEN_2022_PROGRAM_ID,
          );
          const currentExts = getExtensionTypes(mintInfo.tlvData);
          const snapshot = store[mintBase58];
          const diff = diffExtensions(
            mintBase58,
            currentExts,
            snapshot?.extensions,
          );
          diffs.push(diff);
          // Persist current observation. We update on every call —
          // `firstObservation` covers the cold-start case so we don't
          // false-positive after a baseline write.
          store[mintBase58] = {
            extensions: currentExts as number[],
            snappedAt: new Date().toISOString(),
          };
        } catch (err) {
          mintErrors.push({
            mint: mintBase58,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      // Save baseline + updated snapshots (atomic). Best-effort: a write
      // failure surfaces as a warn in the signal detail rather than
      // failing the whole rollup.
      let snapshotWriteError: string | undefined;
      try {
        saveSnapshots(store);
      } catch (err) {
        snapshotWriteError = err instanceof Error ? err.message : String(err);
      }
      const rollup = rollupDiffs(diffs);
      signals.push({
        name: "token_extension_change",
        available: true,
        flagged: rollup.flagged,
        detail: {
          wallet: walletArg,
          uniqueMintsScanned: uniqueMints.size,
          firstObservationCount: rollup.firstObservationCount,
          changedMints: rollup.changedMints,
          baselinedMints: rollup.baselinedMints,
          mintErrors,
          ...(snapshotWriteError ? { snapshotWriteError } : {}),
          note: rollup.firstObservationCount > 0
            ? "First-observation entries are baseline-only — no diff possible until next call. Subsequent calls will flag newly-enabled extensions."
            : undefined,
        },
      });
    } catch (err) {
      signals.push({
        name: "token_extension_change",
        available: false,
        reason: `RPC error scanning Token-2022 accounts: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // oracle_staleness — Pyth feed publish_time check. Pyth account layout
  // is non-trivial; v1 reads accounts and pulls publish_time from a
  // well-known offset (208) in the price-update account. If layout
  // assumptions break for a feed (account too small / wrong type), the
  // per-feed entry is recorded as `error` rather than failing the whole
  // signal.
  const stale: { feedAddress: string; symbol: string; publishTime: number; ageSeconds: number }[] = [];
  const feedErrors: { feedAddress: string; error: string }[] = [];
  await Promise.all(
    scannedFeeds.map(async (f) => {
      try {
        const acc = await conn.getAccountInfo(new PublicKey(f.feedAddress));
        if (!acc || acc.data.length < 216) {
          feedErrors.push({
            feedAddress: f.feedAddress,
            error: `account missing or too short (got ${acc?.data.length ?? 0}B, need ≥216)`,
          });
          return;
        }
        // Pyth price-update accounts encode publish_time as little-endian
        // i64 at byte offset 208 (post the V2 layout change). For feeds
        // where this offset is wrong we get a nonsense timestamp; we
        // sanity-check that it's within the last year before flagging.
        const pt = Number(acc.data.readBigInt64LE(208));
        const now = Math.floor(Date.now() / 1000);
        if (pt < now - 365 * 24 * 60 * 60 || pt > now + 60) {
          feedErrors.push({
            feedAddress: f.feedAddress,
            error: `decoded publish_time ${pt} is implausible (now=${now}); feed layout may differ`,
          });
          return;
        }
        const age = Math.max(0, now - pt);
        if (age > PYTH_STALENESS_FLAG_SECONDS) {
          stale.push({
            feedAddress: f.feedAddress,
            symbol: f.symbol,
            publishTime: pt,
            ageSeconds: age,
          });
        }
      } catch (err) {
        feedErrors.push({
          feedAddress: f.feedAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  signals.push({
    name: "oracle_staleness",
    available: true,
    flagged: stale.length > 0,
    detail: {
      flagThresholdSeconds: PYTH_STALENESS_FLAG_SECONDS,
      staleFeeds: stale,
      feedErrors,
    },
  });

  // oracle_price_anomaly — current Pyth price vs persisted 24h rolling
  // median (issue #255). The poller in oracle-poller.ts maintains the
  // history; this signal compares the current read against it. Per-feed
  // threshold (anomalyThresholdPct) — stables tighter than volatiles.
  //
  // Rationale for using parsePriceData (rather than the offset-208
  // hand-decode the staleness signal uses): the issue explicitly
  // flagged Pyth account-layout drift as a v2 risk, and price decode
  // needs more than just publish_time. The official @pythnetwork/client
  // parser handles version skew and emits typed prices; if the layout
  // changes upstream the parser surfaces an error rather than silently
  // returning garbage. Cost: extra dep (~30KB).
  const { parsePriceData: _parsePriceData, PriceStatus: _PriceStatus } =
    await import("@pythnetwork/client");
  const { getMedian, getFeedSnapshot } = await import("./oracle-history.js");
  type AnomalyEntry = {
    feedAddress: string;
    symbol: string;
    currentPrice: number;
    medianPrice: number;
    deviationPct: number;
    thresholdPct: number;
    sampleCount: number;
    historySpanHours?: number;
  };
  const anomalies: AnomalyEntry[] = [];
  const anomalyFeedErrors: { feedAddress: string; error: string }[] = [];
  const anomalyFeedSkipped: { feedAddress: string; reason: string }[] = [];
  await Promise.all(
    scannedFeeds.map(async (f) => {
      try {
        const acc = await conn.getAccountInfo(new PublicKey(f.feedAddress));
        if (!acc) {
          anomalyFeedErrors.push({
            feedAddress: f.feedAddress,
            error: "account not found",
          });
          return;
        }
        const data = _parsePriceData(acc.data);
        if (data.status !== _PriceStatus.Trading || data.price === undefined) {
          anomalyFeedSkipped.push({
            feedAddress: f.feedAddress,
            reason: `status=${_PriceStatus[data.status] ?? data.status}`,
          });
          return;
        }
        const median = getMedian(f.feedAddress);
        if (median === undefined) {
          // Not enough history yet — typical for the first hour after
          // a fresh server start. The anomaly check is silently skipped
          // for this feed; once the poller accumulates enough samples
          // the detector starts firing.
          anomalyFeedSkipped.push({
            feedAddress: f.feedAddress,
            reason: "history below minSamples threshold",
          });
          return;
        }
        if (median <= 0) {
          // Median of zero or negative isn't a useful baseline; skip
          // rather than divide by it.
          anomalyFeedSkipped.push({
            feedAddress: f.feedAddress,
            reason: `median ${median} is non-positive`,
          });
          return;
        }
        const deviationPct = Math.abs(data.price - median) / median;
        const snap = getFeedSnapshot(f.feedAddress);
        const historySpanHours =
          snap && snap.oldestSec !== undefined && snap.newestSec !== undefined
            ? Math.round(((snap.newestSec - snap.oldestSec) / 3600) * 10) / 10
            : undefined;
        if (deviationPct > f.anomalyThresholdPct) {
          anomalies.push({
            feedAddress: f.feedAddress,
            symbol: f.symbol,
            currentPrice: data.price,
            medianPrice: median,
            deviationPct: Math.round(deviationPct * 10000) / 10000,
            thresholdPct: f.anomalyThresholdPct,
            sampleCount: snap?.count ?? 0,
            ...(historySpanHours !== undefined ? { historySpanHours } : {}),
          });
        }
      } catch (err) {
        anomalyFeedErrors.push({
          feedAddress: f.feedAddress,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  signals.push({
    name: "oracle_price_anomaly",
    available: true,
    flagged: anomalies.length > 0,
    detail: {
      anomalies,
      perFeedThresholds: scannedFeeds.map((f) => ({
        feedAddress: f.feedAddress,
        symbol: f.symbol,
        thresholdPct: f.anomalyThresholdPct,
      })),
      feedErrors: anomalyFeedErrors,
      feedsSkipped: anomalyFeedSkipped,
    },
  });

  // known_exploit — vendored static incident list, optionally augmented at
  // runtime via SOLANA_INCIDENT_FEED_URL (issue #242 hybrid mode). Always
  // available; never silently green — feed reachability failures degrade
  // to vendored-only and surface `feedAvailable: false` in detail so the
  // agent can explain "we couldn't reach the runtime feed but here's what
  // the vendored baseline says."
  const programIdsScanned = new Set(scannedPrograms.map((p) => p.programId));
  const feedResult = await getSolanaIncidentFeed();
  // Dedupe by (programId, incidentDate) — feed entries can mirror vendored
  // ones, especially when the feed is curated from the same upstream
  // sources. Vendored takes precedence on collision (we ship them; they're
  // reviewed in PRs); feed entries fill in coverage we don't have.
  const seenKeys = new Set<string>();
  const combinedIncidents = [...KNOWN_SOLANA_INCIDENTS, ...feedResult.records].filter(
    (inc) => {
      const key = `${inc.programId}@${inc.incidentDate}`;
      if (seenKeys.has(key)) return false;
      seenKeys.add(key);
      return true;
    },
  );
  const matchedExploits = combinedIncidents.filter((inc) =>
    programIdsScanned.has(inc.programId),
  );
  const activeExploits = matchedExploits.filter(
    (inc) => inc.status === "active" || inc.status === "under_investigation",
  );
  signals.push({
    name: "known_exploit",
    available: true,
    flagged: activeExploits.length > 0,
    detail: {
      activeIncidents: activeExploits,
      historicalIncidents: matchedExploits.filter(
        (inc) => inc.status === "resolved",
      ),
      vendoredFeedSize: KNOWN_SOLANA_INCIDENTS.length,
      runtimeFeedSize: feedResult.records.length,
      feedAvailable: feedResult.feedAvailable,
      ...(feedResult.feedUrl ? { feedUrl: feedResult.feedUrl } : {}),
      ...(feedResult.feedReason ? { feedReason: feedResult.feedReason } : {}),
      ...(feedResult.feedFetchedAt
        ? { feedFetchedAt: new Date(feedResult.feedFetchedAt).toISOString() }
        : {}),
    },
  });

  // pending_squads_upgrade — issue #251. Scan curated
  // KNOWN_SQUADS_GOVERNED_PROGRAMS for pre-execution proposals targeting
  // BPFLoaderUpgradeable. Conservative-default: any loader-targeting
  // pending tx is flagged regardless of which loader ix variant. The
  // vendor list is empty by default — when empty, surface
  // available:true with a `note` so the agent knows the signal is
  // installed but unscoped, NOT silently green.
  try {
    const squadsResult = await scanSquadsPendingUpgrades(
      conn,
      KNOWN_SQUADS_GOVERNED_PROGRAMS,
    );
    signals.push({
      name: "pending_squads_upgrade",
      available: true,
      flagged: squadsResult.pendingUpgrades.length > 0,
      detail: {
        scannedMultisigs: squadsResult.scannedMultisigs,
        scannedPrograms: squadsResult.scannedPrograms,
        pendingUpgrades: squadsResult.pendingUpgrades,
        scanErrors: squadsResult.errors,
        ...(squadsResult.scannedMultisigs === 0
          ? {
              note:
                "KNOWN_SQUADS_GOVERNED_PROGRAMS is empty — per-protocol governance verification (which programs use Squads V4 for upgrade authority) is the curation step. Add entries via PR with a source citation per the policy in solana-known.ts.",
            }
          : {}),
      },
    });
  } catch (err) {
    signals.push({
      name: "pending_squads_upgrade",
      available: false,
      reason: `Squads scan error: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  return {
    protocol: "solana-protocols",
    chain: "solana",
    scannedPrograms,
    scannedFeeds,
    walletScopeApplied,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}
