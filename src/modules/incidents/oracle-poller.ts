import { PublicKey } from "@solana/web3.js";
import { parsePriceData, PriceStatus } from "@pythnetwork/client";
import { getSolanaConnection } from "../solana/rpc.js";
import { KNOWN_PYTH_FEEDS } from "./solana-known.js";
import { appendSample } from "./oracle-history.js";

/**
 * Background poller that maintains the rolling-median history for the
 * `oracle_price_anomaly` signal (issue #255).
 *
 * Lifecycle:
 *   - `startOraclePoller()` wires up a 60s `setInterval` that reads
 *     each KNOWN_PYTH_FEED's current price via `parsePriceData` and
 *     appends it to the per-feed ring buffer in oracle-history.ts.
 *   - Idempotent: subsequent calls are no-ops (single timer per process).
 *   - Stops on `stopOraclePoller()` or process exit.
 *
 * Failure handling: per-feed errors are silently swallowed (counted
 * for diagnostics but never logged). The poller MUST keep running
 * across transient RPC failures — a chain-incident scenario IS the
 * scenario in which RPC providers throttle or 5xx, and that's
 * exactly when we still need samples to flow. Skipping a single 60s
 * tick because one feed errored is acceptable noise.
 *
 * Cadence rationale: 60s matches the issue's recommendation. Lower
 * cadence (e.g. 10s) would catch sub-minute anomalies sooner but
 * 6× the RPC traffic for marginal latency gain. Higher cadence
 * (e.g. 5min) would risk aliasing with cross-protocol manipulation
 * windows that resolve in 1-3min.
 */

const POLL_INTERVAL_MS = 60_000;

let pollerHandle: NodeJS.Timeout | undefined;
let pollerStarted = false;
// In-flight re-entrancy guard (issue #697) — the interval callback below
// checks this before starting a new pollOnce() so an unresolved tick
// (e.g. a hung Solana RPC call) can't overlap with the next one.
let pollInFlight = false;

/**
 * Read every known feed once. Best-effort per feed — one feed's
 * `getAccountInfo` failure or a parse error doesn't stop the others.
 * Returned counts are useful for tests + diagnostics.
 */
export async function pollOnce(): Promise<{
  ok: number;
  errors: number;
  details: Array<{ feedAddress: string; status: "ok" | "skipped" | "error"; reason?: string }>;
}> {
  const conn = getSolanaConnection();
  const details: Array<{
    feedAddress: string;
    status: "ok" | "skipped" | "error";
    reason?: string;
  }> = [];
  let ok = 0;
  let errors = 0;
  await Promise.all(
    KNOWN_PYTH_FEEDS.map(async (feed) => {
      try {
        const acc = await conn.getAccountInfo(new PublicKey(feed.feedAddress));
        if (!acc) {
          details.push({
            feedAddress: feed.feedAddress,
            status: "skipped",
            reason: "account not found",
          });
          return;
        }
        const data = parsePriceData(acc.data);
        // `price` is undefined when the aggregate status isn't Trading
        // (the feed publisher is uncertain / agg failed). Skip — the
        // last good sample stays in the buffer.
        if (data.status !== PriceStatus.Trading || data.price === undefined) {
          details.push({
            feedAddress: feed.feedAddress,
            status: "skipped",
            reason: `status=${PriceStatus[data.status] ?? data.status}`,
          });
          return;
        }
        const publishTimeSec = Number(data.timestamp);
        if (!Number.isFinite(publishTimeSec) || publishTimeSec <= 0) {
          details.push({
            feedAddress: feed.feedAddress,
            status: "skipped",
            reason: `bad timestamp=${data.timestamp}`,
          });
          return;
        }
        appendSample(feed.feedAddress, publishTimeSec, data.price);
        ok += 1;
        details.push({ feedAddress: feed.feedAddress, status: "ok" });
      } catch (err) {
        errors += 1;
        details.push({
          feedAddress: feed.feedAddress,
          status: "error",
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
  return { ok, errors, details };
}

/**
 * Start the background poller. Idempotent. The first poll runs
 * immediately so the history starts accumulating without a 60s
 * cold-start delay; subsequent polls run every POLL_INTERVAL_MS.
 *
 * The interval is `unref()`'d so it doesn't keep the process alive
 * — the MCP server's stdio loop is the actual lifecycle anchor.
 */
export function startOraclePoller(): void {
  if (pollerStarted) return;
  pollerStarted = true;
  // Fire-and-forget the cold poll. Don't await — we don't want to
  // block server boot on Solana RPC reachability.
  pollInFlight = true;
  void pollOnce()
    .catch(() => {
      /* swallowed — first-tick failures are normal during cold-RPC */
    })
    .finally(() => {
      pollInFlight = false;
    });
  pollerHandle = setInterval(() => {
    if (pollInFlight) {
      // Previous tick hasn't settled (e.g. a hung RPC call) — skip this
      // tick rather than starting an overlapping pollOnce() round.
      return;
    }
    pollInFlight = true;
    void pollOnce()
      .catch(() => {
        /* swallowed — see file docstring */
      })
      .finally(() => {
        pollInFlight = false;
      });
  }, POLL_INTERVAL_MS);
  pollerHandle.unref?.();
}

/** Test-only — stop the timer + reset the started-flag. */
export function stopOraclePoller(): void {
  if (pollerHandle) {
    clearInterval(pollerHandle);
    pollerHandle = undefined;
  }
  pollerStarted = false;
  pollInFlight = false;
}
