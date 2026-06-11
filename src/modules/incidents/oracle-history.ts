import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/**
 * Persistent rolling-median storage for the `oracle_price_anomaly`
 * signal (issue #255). Keeps a per-feed time-series of (publishTime,
 * price) samples in a JSON file under `~/.vaultpilot-mcp/incidents/`.
 *
 * Why persistence: the MCP server runs as a stdio child of Claude
 * Desktop / Claude Code / Cursor — its lifecycle is the user's
 * session. An in-memory ring buffer would reset on every restart,
 * which would either (a) silently mask anomalies that need >24h of
 * history to detect, or (b) emit false positives in the first hour
 * after restart when only a few samples exist. Persisting across
 * restarts is the only honest way to ship rolling-median detection
 * for a stdio server.
 *
 * Storage shape — single JSON file with one entry per feed:
 *
 *   {
 *     "<feedAddress>": {
 *       "samples": [{ "t": <unix-seconds>, "p": <price> }, ...],
 *       "updatedAt": <unix-seconds>
 *     },
 *     ...
 *   }
 *
 * Samples are kept in publish-time order, trimmed to the last 24h on
 * every append. File writes are atomic (write-to-temp + rename) so a
 * crash mid-write can't leave a corrupt file. Read failures fall back
 * to an empty store — a stale or corrupt file means we lose history,
 * but we don't crash and we don't emit garbage.
 */

/** Window the median is computed over. Per the issue: 24h rolling. */
export const ORACLE_HISTORY_WINDOW_SECONDS = 24 * 60 * 60;

/** Keep at most this many samples per feed (defense against poller drift). */
const MAX_SAMPLES_PER_FEED = Math.ceil((ORACLE_HISTORY_WINDOW_SECONDS / 60) * 1.5); // ~2160

/** Default file path. Overridable via env for tests. */
const DEFAULT_HISTORY_PATH = join(
  homedir(),
  ".vaultpilot-mcp",
  "incidents",
  "oracle-medians.json",
);

interface Sample {
  /** Pyth `publishTime` as unix seconds. */
  t: number;
  /** Pyth `price` (already scaled by exponent — i.e. real USD value). */
  p: number;
}

interface FeedEntry {
  samples: Sample[];
  updatedAt: number;
}

type Store = Record<string, FeedEntry>;

let cachedStore: Store | undefined;
let cachedPath: string | undefined;

function getHistoryPath(): string {
  // Env override is for tests; reset cache when it changes so a test
  // that flips paths sees its own state, not the previous run's.
  const envPath = process.env.VAULTPILOT_ORACLE_HISTORY_PATH;
  const path = envPath && envPath.length > 0 ? envPath : DEFAULT_HISTORY_PATH;
  if (cachedPath !== undefined && cachedPath !== path) {
    cachedStore = undefined;
  }
  cachedPath = path;
  return path;
}

function readStore(): Store {
  if (cachedStore) return cachedStore;
  const path = getHistoryPath();
  if (!existsSync(path)) {
    cachedStore = {};
    return cachedStore;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Store;
    // Defensive: validate the shape so a hand-edited / corrupt file
    // doesn't propagate to callers as `undefined.samples`.
    if (typeof parsed !== "object" || parsed === null) {
      cachedStore = {};
      return cachedStore;
    }
    for (const k of Object.keys(parsed)) {
      const e = parsed[k];
      if (
        !e ||
        typeof e !== "object" ||
        !Array.isArray(e.samples) ||
        typeof e.updatedAt !== "number"
      ) {
        delete parsed[k];
      }
    }
    cachedStore = parsed;
    return cachedStore;
  } catch {
    // Corrupt / unreadable — start over rather than crash.
    cachedStore = {};
    return cachedStore;
  }
}

function writeStore(store: Store): void {
  const path = getHistoryPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: temp + rename. Same posture as user-config.ts.
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), { mode: 0o600 });
  // fs.renameSync is atomic on POSIX; Windows replaces if dest exists.
  // Both behaviors are fine for our single-writer scenario (only the
  // poller writes; concurrent agents on the same machine WOULD race
  // here — accepted limitation, the worst case is lost samples not
  // a corrupt file).
  renameSync(tmp, path);
}

/**
 * Append a sample for a feed and persist. Trims the per-feed buffer
 * to the rolling 24h window AND to MAX_SAMPLES_PER_FEED (whichever
 * is tighter). Returns the post-trim sample count for the feed.
 */
export function appendSample(
  feedAddress: string,
  publishTimeSec: number,
  price: number,
): number {
  if (!Number.isFinite(price)) {
    // Garbage in — do nothing rather than poison the median with NaN.
    return getSampleCount(feedAddress);
  }
  const store = readStore();
  const now = Math.floor(Date.now() / 1000);
  const cutoff = now - ORACLE_HISTORY_WINDOW_SECONDS;
  const existing = store[feedAddress] ?? { samples: [], updatedAt: 0 };
  // Drop samples outside the window before appending; this also self-
  // heals after a long server downtime where the file hasn't been
  // touched in days.
  let trimmed = existing.samples.filter((s) => s.t >= cutoff);
  trimmed.push({ t: publishTimeSec, p: price });
  // Cap by max count (oldest first removed).
  if (trimmed.length > MAX_SAMPLES_PER_FEED) {
    trimmed = trimmed.slice(trimmed.length - MAX_SAMPLES_PER_FEED);
  }
  store[feedAddress] = { samples: trimmed, updatedAt: now };
  writeStore(store);
  return trimmed.length;
}

/**
 * Compute the median of the in-window samples for a feed. Returns
 * undefined when:
 *  - the feed has no samples yet
 *  - all samples are older than the window (stale)
 *  - sample count is below the minimum-trustworthy threshold
 *
 * `minSamples` defaults to 60 — one hour of normal-cadence samples.
 * The threshold matters because median over very few points is noisy
 * and an early-after-restart anomaly check would be likely to fire
 * spuriously. Caller can lower it for tests.
 */
export function getMedian(
  feedAddress: string,
  opts: { minSamples?: number } = {},
): number | undefined {
  const minSamples = opts.minSamples ?? 60;
  const store = readStore();
  const entry = store[feedAddress];
  if (!entry) return undefined;
  const cutoff = Math.floor(Date.now() / 1000) - ORACLE_HISTORY_WINDOW_SECONDS;
  const inWindow = entry.samples.filter((s) => s.t >= cutoff);
  if (inWindow.length < minSamples) return undefined;
  const sorted = inWindow.map((s) => s.p).sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Read-side accessor — current count of samples for a feed. */
export function getSampleCount(feedAddress: string): number {
  const store = readStore();
  return store[feedAddress]?.samples.length ?? 0;
}

/**
 * Diagnostic accessor — return the (timestamp, count, oldestSample,
 * newestSample) for a feed. Used by the anomaly detector to surface
 * "the median is computed over N samples spanning T hours" context
 * in the signal's detail block.
 */
export function getFeedSnapshot(feedAddress: string): {
  count: number;
  updatedAt: number;
  oldestSec?: number;
  newestSec?: number;
} | undefined {
  const store = readStore();
  const entry = store[feedAddress];
  if (!entry) return undefined;
  if (entry.samples.length === 0) {
    return { count: 0, updatedAt: entry.updatedAt };
  }
  const oldest = entry.samples[0];
  const newest = entry.samples[entry.samples.length - 1];
  return {
    count: entry.samples.length,
    updatedAt: entry.updatedAt,
    oldestSec: oldest.t,
    newestSec: newest.t,
  };
}

/** Test-only: drop the in-process cache. Disk file is untouched. */
export function _resetOracleHistoryCache(): void {
  cachedStore = undefined;
  cachedPath = undefined;
}

/** Test-only: dangerously overwrite the entire store (bypasses validation). */
export function _seedOracleHistoryForTests(store: Store): void {
  cachedStore = store;
  writeStore(store);
}
