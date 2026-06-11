/**
 * Tron base-layer chain-health signals for `get_market_incident_status`.
 * Issue #238 v1 + small-wins follow-up (sr_rotation_anomaly,
 * tronGrid_divergence) + #249/#250 v2 (usdt_blacklist_event,
 * network_resource_exhaustion).
 *
 * Signals:
 *   - block_progression           (tip ageSeconds > 9 → production stalled)
 *   - missed_blocks_rate          (last ~1h: > 10% missed → SR liveness degraded)
 *   - sr_concentration            (Nakamoto on SR vote-weight ≤ 6 → BFT halt risk)
 *   - sr_rotation_anomaly         (≥ 3 unknown producers in last 30 blocks →
 *                                  non-active-SR producing, or encoding mismatch
 *                                  we surface honestly via available:false)
 *   - tronGrid_divergence         (block-height gap > 5 vs an optional second
 *                                  TronGrid-compatible endpoint set via
 *                                  TRON_RPC_URL_SECONDARY; mirror of the Solana
 *                                  rpc_divergence pattern)
 *   - usdt_blacklist_event        (issue #249 — user counterparties on USDT-TRC20
 *                                  blacklist; requires `wallet` arg)
 *   - network_resource_exhaustion (issue #250 — chain-wide energy / bandwidth
 *                                  unit price > 2× P90 baseline; persistent
 *                                  ring buffer of /wallet/getaccountresource
 *                                  totals)
 */
import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { fetchWithTimeout } from "../../data/http.js";
import { listTronWitnesses } from "../tron/witnesses.js";
import { isTronAddress } from "../../config/tron.js";
import { checkUsdtBlacklist } from "../tron/usdt-blacklist.js";
import { evaluateResourceExhaustion } from "../tron/resource-baseline.js";
import { fetchTronHistory } from "../history/tron.js";

/** Tron target block time: 3 seconds. */
const TRON_BLOCK_TARGET_SECONDS = 3;
/** block_progression: tip ageSeconds > 3× target → flagged. */
const BLOCK_PROGRESSION_FLAG_SECONDS = TRON_BLOCK_TARGET_SECONDS * 3;
/** missed_blocks_rate: > this fraction → flagged. */
const MISSED_BLOCKS_FLAG = 0.10;
/** Window for missed-block computation. ~1h at 3s blocks ≈ 1200 blocks. */
const MISSED_BLOCKS_WINDOW = 1200;
/** sr_concentration Nakamoto threshold: ≤ this many SRs hold > 33% → halt risk. */
const SR_NAKAMOTO_FLAG = 6;
/** sr_rotation_anomaly: scan last N blocks for unknown producers. */
const SR_ROTATION_WINDOW = 30;
/** sr_rotation_anomaly: ≥ this many unknown producers in window → flagged. */
const SR_ROTATION_UNKNOWN_FLAG = 3;
/** tronGrid_divergence: tip-block height gap > this vs secondary endpoint → flagged. */
const TRONGRID_DIVERGENCE_BLOCK_GAP = 5;

export interface TronChainIncidentStatus {
  protocol: "tron";
  chain: "tron";
  tipBlock: number;
  tipBlockTimestamp: number;
  tipAgeSeconds: number;
  incident: boolean;
  signals: TronSignal[];
}

export type TronSignal =
  | {
      name: string;
      available: true;
      flagged: boolean;
      detail: Record<string, unknown>;
    }
  | { name: string; available: false; reason: string };

interface TronGridGetNowBlockResponse {
  block_header?: {
    raw_data?: {
      number?: number;
      timestamp?: number;
    };
  };
}

interface TronGridGetBlockByLimitNextResponse {
  block?: {
    block_header?: {
      raw_data?: {
        number?: number;
        timestamp?: number;
        // Producer field is present in /wallet/getblockbylimitnext responses;
        // encoding depends on whether `?visible=true` was passed (base58 vs
        // hex). The sr_rotation_anomaly path uses `?visible=true` so we get
        // base58, matching the SR set returned by listTronWitnesses.
        witness_address?: string;
      };
    };
  }[];
}

async function trongridPost<T>(
  path: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<T> {
  return trongridPostUrl<T>(`${TRONGRID_BASE_URL}${path}`, body, apiKey);
}

/**
 * Like `trongridPost` but takes a full URL instead of a path. Used by
 * `tronGrid_divergence` which queries a user-configured secondary endpoint
 * (`TRON_RPC_URL_SECONDARY`) — that endpoint may not be the canonical
 * `api.trongrid.io` host. The API-key header is still forwarded; if the
 * secondary endpoint doesn't honor TRON-PRO-API-KEY (most TronGrid-compat
 * RPCs do, some private nodes don't) the call still succeeds — the header
 * is just ignored.
 */
async function trongridPostUrl<T>(
  fullUrl: string,
  body: unknown,
  apiKey: string | undefined,
): Promise<T> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(fullUrl, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${fullUrl} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * `wallet` (optional, TRON base58) — when supplied, the
 * `usdt_blacklist_event` signal scopes its scan to recent counterparties
 * from the user's TRON tx history. Without it, that signal returns
 * `available: false` (the others run unaffected).
 */
export async function getTronChainHealthSignals(
  wallet?: string,
): Promise<TronChainIncidentStatus> {
  const apiKey = resolveTronApiKey(readUserConfig());

  // Fetch tip via getNowBlock; fail-fast if unreachable.
  const tip = await trongridPost<TronGridGetNowBlockResponse>(
    "/wallet/getnowblock",
    {},
    apiKey,
  );
  const tipNumber = tip.block_header?.raw_data?.number;
  const tipTimestampMs = tip.block_header?.raw_data?.timestamp;
  if (typeof tipNumber !== "number" || typeof tipTimestampMs !== "number") {
    throw new Error(
      `TronGrid /wallet/getnowblock returned malformed response (number=${tipNumber}, timestamp=${tipTimestampMs}).`,
    );
  }
  // Tron timestamps are milliseconds.
  const tipTimestampSeconds = Math.floor(tipTimestampMs / 1000);
  const tipAgeSeconds = Math.max(
    0,
    Math.floor(Date.now() / 1000) - tipTimestampSeconds,
  );

  const signals: TronSignal[] = [];

  // block_progression
  signals.push({
    name: "block_progression",
    available: true,
    flagged: tipAgeSeconds > BLOCK_PROGRESSION_FLAG_SECONDS,
    detail: {
      tipBlock: tipNumber,
      tipAgeSeconds,
      targetBlockSeconds: TRON_BLOCK_TARGET_SECONDS,
      flagThresholdSeconds: BLOCK_PROGRESSION_FLAG_SECONDS,
    },
  });

  // missed_blocks_rate — fetch the last MISSED_BLOCKS_WINDOW blocks and
  // compare the observed timespan against the expected (window × 3s).
  // If the chain produced fewer blocks than expected over the same wall-
  // clock interval, blocks were missed. /wallet/getblockbylimitnext takes
  // [startNum, endNum) and returns the slice; cap at 100 per call (the
  // node's hard limit) and concat.
  try {
    const startNum = Math.max(1, tipNumber - MISSED_BLOCKS_WINDOW);
    // Fetch the OLDEST block in the window, plus the tip; the timespan
    // between them tells us how many blocks COULD have been produced
    // in that wall-clock interval. We don't need every block in between.
    const startBlock = await trongridPost<TronGridGetBlockByLimitNextResponse>(
      "/wallet/getblockbylimitnext",
      { startNum, endNum: startNum + 1 },
      apiKey,
    );
    const startTs = startBlock.block?.[0]?.block_header?.raw_data?.timestamp;
    if (typeof startTs !== "number") {
      signals.push({
        name: "missed_blocks_rate",
        available: false,
        reason: `could not fetch start block ${startNum} for window analysis`,
      });
    } else {
      const startTsSec = Math.floor(startTs / 1000);
      const wallclockSpan = tipTimestampSeconds - startTsSec;
      const expectedBlocks = Math.floor(wallclockSpan / TRON_BLOCK_TARGET_SECONDS);
      const actualBlocks = tipNumber - startNum;
      const missedFraction =
        expectedBlocks > 0
          ? Math.max(0, (expectedBlocks - actualBlocks) / expectedBlocks)
          : 0;
      signals.push({
        name: "missed_blocks_rate",
        available: true,
        flagged: missedFraction > MISSED_BLOCKS_FLAG,
        detail: {
          windowBlocks: MISSED_BLOCKS_WINDOW,
          wallclockSeconds: wallclockSpan,
          expectedBlocks,
          actualBlocks,
          missedFraction: Number(missedFraction.toFixed(4)),
          flagThreshold: MISSED_BLOCKS_FLAG,
        },
      });
    }
  } catch (err) {
    signals.push({
      name: "missed_blocks_rate",
      available: false,
      reason: `TronGrid error during window block fetch: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  // Fetch the active SR set ONCE — both sr_concentration and
  // sr_rotation_anomaly need it. On failure both signals degrade to
  // available:false rather than each retrying.
  let activeWitnessAddresses: string[] | null = null;
  let activeWitnessStakes: number[] | null = null;
  let witnessFetchError: string | null = null;
  try {
    const witnessList = await listTronWitnesses(undefined, true);
    // listTronWitnesses(_, includeCandidates=true) returns the full set;
    // top-27 (by witness rank) are the active SRs. The witnesses array is
    // pre-sorted by vote weight, so slicing 0..27 gives the active set.
    const top27 = witnessList.witnesses.slice(0, 27);
    activeWitnessAddresses = top27.map((w) => w.address);
    activeWitnessStakes = top27
      .map((w) => Number(w.voteCount))
      .filter((v) => Number.isFinite(v))
      .sort((a, b) => b - a);
  } catch (err) {
    witnessFetchError = err instanceof Error ? err.message : String(err);
  }

  // sr_concentration — Nakamoto coefficient over witness vote-weight.
  if (witnessFetchError !== null) {
    signals.push({
      name: "sr_concentration",
      available: false,
      reason: `listTronWitnesses error: ${witnessFetchError}`,
    });
  } else {
    const stakes = activeWitnessStakes!;
    const total = stakes.reduce((sum, s) => sum + s, 0);
    if (total === 0) {
      signals.push({
        name: "sr_concentration",
        available: false,
        reason: "listTronWitnesses returned zero total stake across active SRs",
      });
    } else {
      const target = total * 0.34;
      let acc = 0;
      let n = 0;
      for (const s of stakes) {
        acc += s;
        n++;
        if (acc > target) break;
      }
      signals.push({
        name: "sr_concentration",
        available: true,
        flagged: n <= SR_NAKAMOTO_FLAG,
        detail: {
          nakamotoCoefficient: n,
          activeSrCount: stakes.length,
          flagThreshold: SR_NAKAMOTO_FLAG,
          note: "smallest SR set summing to > 33% of active-SR vote weight (BFT halt threshold; needs 19/27 to commit, so 9 colluding can halt)",
        },
      });
    }
  }

  // sr_rotation_anomaly — fetch last SR_ROTATION_WINDOW blocks and check
  // each producer against the active SR set. Producers OUTSIDE the active
  // set indicate rotation anomalies (or, if the encoding mismatches,
  // we surface that as available:false rather than silently flag-everything).
  // Uses ?visible=true so witness_address comes back base58, matching the
  // base58 addresses in the SR list.
  if (witnessFetchError !== null) {
    signals.push({
      name: "sr_rotation_anomaly",
      available: false,
      reason: `requires the SR list; listTronWitnesses error: ${witnessFetchError}`,
    });
  } else {
    try {
      const startNum = Math.max(1, tipNumber - SR_ROTATION_WINDOW + 1);
      const blocks = await trongridPost<TronGridGetBlockByLimitNextResponse>(
        "/wallet/getblockbylimitnext?visible=true",
        { startNum, endNum: tipNumber + 1 },
        apiKey,
      );
      const producers = (blocks.block ?? [])
        .map((b) => b.block_header?.raw_data?.witness_address)
        .filter((w): w is string => typeof w === "string" && w.length > 0);
      if (producers.length === 0) {
        signals.push({
          name: "sr_rotation_anomaly",
          available: false,
          reason:
            "TronGrid /wallet/getblockbylimitnext returned no decodable witness_address fields",
        });
      } else {
        const activeSet = new Set(activeWitnessAddresses!);
        const knownProducers = producers.filter((p) => activeSet.has(p));
        const unknownProducers = producers.filter((p) => !activeSet.has(p));
        // Defensive sanity check: if NONE of the producers match the
        // active SR set, that almost certainly means address-encoding
        // mismatch (block returned hex, SR list returned base58, or vice
        // versa) rather than every block being produced by a non-SR.
        // Surface the ambiguity rather than flagging the full window.
        if (knownProducers.length === 0) {
          signals.push({
            name: "sr_rotation_anomaly",
            available: false,
            reason: `0/${producers.length} block producers matched the active SR set — likely an address-encoding mismatch between TronGrid block witness_address and listTronWitnesses output. Skipping rotation analysis to avoid a false-positive flood.`,
          });
        } else {
          signals.push({
            name: "sr_rotation_anomaly",
            available: true,
            flagged: unknownProducers.length >= SR_ROTATION_UNKNOWN_FLAG,
            detail: {
              windowBlocks: SR_ROTATION_WINDOW,
              producersObserved: producers.length,
              knownProducers: knownProducers.length,
              unknownProducers: unknownProducers.length,
              flagThreshold: SR_ROTATION_UNKNOWN_FLAG,
              ...(unknownProducers.length > 0
                ? { unknownProducerSamples: unknownProducers.slice(0, 5) }
                : {}),
            },
          });
        }
      }
    } catch (err) {
      signals.push({
        name: "sr_rotation_anomaly",
        available: false,
        reason: `TronGrid error during producer-window fetch: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // tronGrid_divergence — when TRON_RPC_URL_SECONDARY is set, probe the
  // secondary endpoint for its tip block and flag if it disagrees with
  // the primary tip by > TRONGRID_DIVERGENCE_BLOCK_GAP blocks. Mirrors
  // the Solana rpc_divergence shape; degrades to available:false when
  // the env var is unset.
  const secondaryUrl = process.env.TRON_RPC_URL_SECONDARY;
  if (!secondaryUrl) {
    signals.push({
      name: "tronGrid_divergence",
      available: false,
      reason: "requires TRON_RPC_URL_SECONDARY env var pointing at a second TronGrid-compatible endpoint",
    });
  } else {
    try {
      const secondaryTip = await trongridPostUrl<TronGridGetNowBlockResponse>(
        `${secondaryUrl.replace(/\/$/, "")}/wallet/getnowblock`,
        {},
        apiKey,
      );
      const secondaryNumber = secondaryTip.block_header?.raw_data?.number;
      if (typeof secondaryNumber !== "number") {
        signals.push({
          name: "tronGrid_divergence",
          available: false,
          reason: "secondary endpoint returned malformed getnowblock response",
        });
      } else {
        const gap = Math.abs(tipNumber - secondaryNumber);
        signals.push({
          name: "tronGrid_divergence",
          available: true,
          flagged: gap > TRONGRID_DIVERGENCE_BLOCK_GAP,
          detail: {
            primaryTip: tipNumber,
            secondaryTip: secondaryNumber,
            blockGap: gap,
            flagThreshold: TRONGRID_DIVERGENCE_BLOCK_GAP,
            secondaryEndpoint: secondaryUrl,
          },
        });
      }
    } catch (err) {
      signals.push({
        name: "tronGrid_divergence",
        available: false,
        reason: `secondary endpoint error: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
  }

  // network_resource_exhaustion — issue #250. Persistent ring buffer of
  // chain-wide TotalEnergy*/TotalNet* counters; flag current sample
  // > 2× P90 of recent window. Always available (chain-wide, no per-
  // user scope) but emits available:false when the buffer is too small
  // for a meaningful percentile or when the snapshot fetch fails.
  try {
    const exhaustion = await evaluateResourceExhaustion();
    if (exhaustion.available) {
      signals.push({
        name: "network_resource_exhaustion",
        available: true,
        flagged: exhaustion.flagged,
        detail: {
          windowSize: exhaustion.detail.windowSize,
          thresholdMultiple: exhaustion.detail.thresholdMultiple,
          energy: exhaustion.detail.energy,
          bandwidth: exhaustion.detail.bandwidth,
          // Surface the raw sample so the agent can show the user
          // exact numbers if asked. Drop the timestamp; not actionable.
          sample: {
            totalEnergyLimit: exhaustion.detail.sample.totalEnergyLimit,
            totalEnergyWeight: exhaustion.detail.sample.totalEnergyWeight,
            totalNetLimit: exhaustion.detail.sample.totalNetLimit,
            totalNetWeight: exhaustion.detail.sample.totalNetWeight,
          },
        },
      });
    } else {
      signals.push({
        name: "network_resource_exhaustion",
        available: false,
        reason: exhaustion.reason,
      });
    }
  } catch (err) {
    signals.push({
      name: "network_resource_exhaustion",
      available: false,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  // usdt_blacklist_event — issue #249. Pulls last N counterparties from
  // the user's TRON tx history; probes USDT-TRC20.isBlackListed for
  // each; flags any hit. Without `wallet`, returns available:false —
  // the signal is fundamentally per-user (a blacklist event the user
  // never interacted with isn't actionable for them).
  await pushUsdtBlacklistSignal(signals, wallet);

  return {
    protocol: "tron",
    chain: "tron",
    tipBlock: tipNumber,
    tipBlockTimestamp: tipTimestampSeconds,
    tipAgeSeconds,
    incident: signals.some((s) => s.available === true && s.flagged),
    signals,
  };
}

/**
 * Counterparty-window for the blacklist scan. The last N entries from
 * `get_transaction_history` give us the addresses the user has touched
 * recently. 50 covers ~a week of typical activity and bounds the
 * triggerconstantcontract fan-out (each call is ~5k energy + 1 RPC
 * roundtrip; 50 calls = ~250k energy budget on the dry-run path).
 */
const BLACKLIST_COUNTERPARTY_WINDOW = 50;

/**
 * Compute and push the usdt_blacklist_event signal. Extracted to keep
 * the main function readable — same shape (mutates `signals` in place,
 * never throws) as the other signal blocks above.
 */
async function pushUsdtBlacklistSignal(
  signals: TronSignal[],
  wallet: string | undefined,
): Promise<void> {
  if (!wallet) {
    signals.push({
      name: "usdt_blacklist_event",
      available: false,
      reason:
        "wallet arg required — this signal scopes the blacklist scan to YOUR " +
        "recent TRC-20 counterparties. Pass `wallet: <T...>` (your TRON address) " +
        "to enable.",
    });
    return;
  }
  if (!isTronAddress(wallet)) {
    signals.push({
      name: "usdt_blacklist_event",
      available: false,
      reason: `wallet "${wallet}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`,
    });
    return;
  }
  let history;
  try {
    history = await fetchTronHistory({
      wallet,
      includeExternal: true,
      includeTokenTransfers: true,
    });
  } catch (err) {
    signals.push({
      name: "usdt_blacklist_event",
      available: false,
      reason: `failed to fetch tx history: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  // Walk recent history in time order; collect unique counterparties
  // with direction tags. We probe the union of `external` (TRX-native
  // sends) and `tokenTransfers` (TRC-20 transfers including USDT
  // itself). The blacklist is for USDT specifically, but a blacklisted
  // EVM-style address also wouldn't be safe to send TRX to (Tether
  // can blacklist any address regardless of whether it currently holds
  // USDT — and the wallet flag persists across receipts).
  type Direction = "outgoing" | "incoming";
  const counterparties = new Map<string, Direction[]>();
  const edges = [...history.external, ...history.tokenTransfers]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, BLACKLIST_COUNTERPARTY_WINDOW);
  for (const edge of edges) {
    const isFromUs = edge.from === wallet;
    const isToUs = edge.to === wallet;
    let counterparty: string | null;
    if (isFromUs) {
      counterparty = edge.to;
    } else if (isToUs) {
      counterparty = edge.from;
    } else {
      counterparty = null;
    }
    if (counterparty === null || counterparty === wallet) continue;
    if (!isTronAddress(counterparty)) continue;
    const direction: Direction = isFromUs ? "outgoing" : "incoming";
    const existing = counterparties.get(counterparty);
    if (existing) {
      if (!existing.includes(direction)) existing.push(direction);
    } else {
      counterparties.set(counterparty, [direction]);
    }
  }

  if (counterparties.size === 0) {
    signals.push({
      name: "usdt_blacklist_event",
      available: true,
      flagged: false,
      detail: {
        scannedCounterparties: 0,
        windowSize: BLACKLIST_COUNTERPARTY_WINDOW,
        note: "no TRON counterparties in recent history",
      },
    });
    return;
  }

  let probeResults;
  try {
    probeResults = await checkUsdtBlacklist([...counterparties.keys()]);
  } catch (err) {
    signals.push({
      name: "usdt_blacklist_event",
      available: false,
      reason: `USDT.isBlackListed probe failed: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }

  const hits = probeResults
    .filter((r) => r.blacklisted)
    .map((r) => ({
      address: r.address,
      directions: counterparties.get(r.address) ?? [],
    }));

  signals.push({
    name: "usdt_blacklist_event",
    available: true,
    flagged: hits.length > 0,
    detail: {
      scannedCounterparties: counterparties.size,
      windowSize: BLACKLIST_COUNTERPARTY_WINDOW,
      contractAddress: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
      hits,
    },
  });
}
