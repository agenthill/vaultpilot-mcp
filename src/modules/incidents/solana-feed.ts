/**
 * Optional runtime augmentation for the vendored Solana incident list.
 * Issue #242 v2 — option (c) hybrid mode from the parent scope discussion.
 *
 * When `SOLANA_INCIDENT_FEED_URL` is set, we fetch a JSON document of the
 * same shape as `KNOWN_SOLANA_INCIDENTS` and merge it with the vendored
 * baseline. Reachability failures degrade gracefully — never silently
 * green: callers receive `feedAvailable: false` and a `feedReason` string
 * so the response can surface "we couldn't fetch the runtime feed but
 * here's what the vendored list says." When the env var is unset the
 * call is a no-op (no fetch, `feedAvailable: false` with reason
 * "feed not configured").
 *
 * Cache TTL is 15 minutes — incident feeds change rarely; aggressive
 * polling would just generate noise + load on whoever hosts the feed.
 */
import { fetchWithTimeout } from "../../data/http.js";
import type { SolanaIncidentRecord } from "./solana-known.js";

const FEED_CACHE_TTL_MS = 15 * 60 * 1000;
const FEED_FETCH_TIMEOUT_MS = 5_000;

interface CachedFeed {
  records: SolanaIncidentRecord[];
  fetchedAt: number;
}

let cache: CachedFeed | null = null;

export interface SolanaFeedResult {
  records: readonly SolanaIncidentRecord[];
  feedAvailable: boolean;
  feedUrl?: string;
  feedReason?: string;
  feedFetchedAt?: number;
}

function isValidIncidentRecord(x: unknown): x is SolanaIncidentRecord {
  if (typeof x !== "object" || x === null) return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.programId === "string" &&
    typeof r.protocol === "string" &&
    typeof r.incidentDate === "string" &&
    (r.severity === "critical" ||
      r.severity === "high" ||
      r.severity === "medium" ||
      r.severity === "low") &&
    (r.status === "active" ||
      r.status === "under_investigation" ||
      r.status === "resolved") &&
    typeof r.summary === "string" &&
    typeof r.source === "string"
  );
}

/** Test-only hook: drop the in-memory cache between tests. */
export function _resetSolanaFeedCacheForTests(): void {
  cache = null;
}

export async function getSolanaIncidentFeed(): Promise<SolanaFeedResult> {
  const url = process.env.SOLANA_INCIDENT_FEED_URL;
  if (!url) {
    return { records: [], feedAvailable: false, feedReason: "SOLANA_INCIDENT_FEED_URL not set" };
  }
  const now = Date.now();
  if (cache && now - cache.fetchedAt < FEED_CACHE_TTL_MS) {
    return {
      records: cache.records,
      feedAvailable: true,
      feedUrl: url,
      feedFetchedAt: cache.fetchedAt,
    };
  }
  try {
    const res = await fetchWithTimeout(
      url,
      { method: "GET", headers: { Accept: "application/json" } },
      FEED_FETCH_TIMEOUT_MS,
    );
    if (!res.ok) {
      return {
        records: cache?.records ?? [],
        feedAvailable: false,
        feedUrl: url,
        feedReason: `feed responded with HTTP ${res.status} ${res.statusText}`,
        ...(cache ? { feedFetchedAt: cache.fetchedAt } : {}),
      };
    }
    const json = (await res.json()) as unknown;
    if (!Array.isArray(json)) {
      return {
        records: cache?.records ?? [],
        feedAvailable: false,
        feedUrl: url,
        feedReason: "feed returned non-array JSON; expected SolanaIncidentRecord[]",
        ...(cache ? { feedFetchedAt: cache.fetchedAt } : {}),
      };
    }
    const validated = json.filter(isValidIncidentRecord);
    const dropped = json.length - validated.length;
    cache = { records: validated, fetchedAt: now };
    return {
      records: validated,
      feedAvailable: true,
      feedUrl: url,
      feedFetchedAt: now,
      ...(dropped > 0
        ? { feedReason: `${dropped}/${json.length} feed entries failed schema validation and were dropped` }
        : {}),
    };
  } catch (err) {
    return {
      records: cache?.records ?? [],
      feedAvailable: false,
      feedUrl: url,
      feedReason: `fetch error: ${err instanceof Error ? err.message : String(err)}`,
      ...(cache ? { feedFetchedAt: cache.fetchedAt } : {}),
    };
  }
}
