import { Connection } from "@solana/web3.js";
import { resolveSolanaRpcUrl } from "../../config/chains.js";
import { readUserConfig } from "../../config/user-config.js";
import { recordRateLimit } from "../../data/rate-limit-tracker.js";
import {
  getRuntimeSolanaRpc,
  recordProactivePublicAccess,
  recordSolanaPublicError,
} from "../../data/runtime-rpc-overrides.js";

/**
 * Canonical public Solana mainnet endpoint. Hardcoded here (mirrors the
 * `SOLANA_PUBLIC_MAINNET` constant in `src/config/chains.ts`) so this
 * module can detect the public-fallback path locally without re-importing
 * the chain config. Kept in sync by hand — both must change together if
 * the public endpoint URL ever shifts.
 */
const SOLANA_PUBLIC_MAINNET_URL = "https://api.mainnet-beta.solana.com";

/**
 * Cached `Connection` for Solana mainnet. Lazy-initialized on first use.
 * Mirrors the EVM `getClient(chain)` pattern in src/data/rpc.ts — one client
 * per process, reused across calls. Reset on config change (future hook
 * alongside the EVM `resetClients` listener).
 */
let cachedConnection: Connection | undefined;
/** URL the cached connection was constructed against — when the runtime
 * override flips this changes, and `getSolanaConnection` rebuilds. */
let cachedConnectionUrl: string | undefined;

/**
 * fetch shim handed to web3.js's `Connection({ fetch })`. Forwards
 * to the platform `fetch`, then peeks at the response status for 429
 * before returning. We touch the response WITHOUT consuming the body
 * so the caller still gets the full Response intact — `Response.status`
 * is on the wire-headers side and is safe to read repeatedly.
 *
 * Done at the Connection-fetch layer (rather than wrapping every
 * `connection.getXxx()` call) because web3.js has dozens of methods
 * and a centralized hook is the only sustainable choice. Same pattern
 * the EVM transport-wrapper uses in src/data/rpc.ts.
 */
async function fetchWithRateLimitDetect(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  const res = await fetch(input, init);
  // HTTP-status side: api.mainnet-beta.solana.com returns 429 most often,
  // but occasionally surfaces 410 (Gone — restricted method on the public
  // endpoint) and 503 (overloaded) for the same throttling reason. Issue
  // #410: counting only 429 silently dropped a real-session 9-error
  // streak so the nudge never fired.
  let throttled = res.status === 429 || res.status === 410 || res.status === 503;
  // JSON-RPC-body side: some Solana public-endpoint operators return HTTP
  // 200 with a JSON-RPC error body carrying a rate-limit code. Peek via
  // res.clone() so the original response stays unconsumed for the caller.
  // Fail-open on any parse error — counting fewer events is preferable to
  // serving a corrupted body to the SDK.
  if (!throttled) {
    try {
      const cloned = res.clone();
      const ctype = cloned.headers.get("content-type") ?? "";
      if (ctype.includes("application/json")) {
        const body = (await cloned.json()) as
          | { error?: { code?: number; message?: string } }
          | undefined;
        const code = body?.error?.code;
        const message = body?.error?.message ?? "";
        // -32429: custom Solana rate-limit code (some public proxies use it).
        // -32005: Alchemy-style "rate limit exceeded" — mirrors the same code
        // the EVM tracker watches for.
        // Substring match guards against operators that pick a different
        // numeric code but still send a recognizable message.
        throttled =
          code === -32429 ||
          code === -32005 ||
          /rate.?limit|too many requests|quota|throttl/i.test(message);
      }
    } catch {
      // body wasn't JSON, or already consumed elsewhere — leave throttled false.
    }
  }
  if (throttled) {
    recordRateLimit({ kind: "solana" });
    // Increment the demo-mode Helius nudge counter — only counts when no
    // runtime override is set, so the nudge doesn't fire after the user
    // adds a key. First error of the session AND every multiple of 10
    // thereafter trip the pending-nudge flag the registerTool wrapper
    // picks up on the next response.
    recordSolanaPublicError();
  }
  return res;
}

/**
 * Test-only export. The fetch shim is otherwise hidden behind the
 * cached `Connection` constructor, but issue #410's broadened detection
 * (HTTP 410 / 503 / JSON-RPC body codes) needs unit-level coverage that
 * doesn't go through web3.js's Connection internals. Calling this is the
 * cheapest way to assert "given a Response shaped like X, did the
 * Helius error counter increment by 1?"
 */
export function _fetchWithRateLimitDetectForTests(
  input: Parameters<typeof fetch>[0],
  init?: Parameters<typeof fetch>[1],
): Promise<Response> {
  return fetchWithRateLimitDetect(input, init);
}

export function getSolanaConnection(): Connection {
  const url = resolveSolanaRpcUrl(readUserConfig());
  // Issue #410: when the resolved URL is the public-fallback mainnet
  // endpoint (no override, no env, no config), proactively queue the
  // Helius setup nudge so the user gets a heads-up on their first read
  // tool — instead of after 9 confusing rate-limit errors. No-op when an
  // override is set or the proactive notice has already fired this
  // session. Done at connection-resolve time (not at fetch time) so the
  // nudge fires on the first tool that touches Solana RPC, regardless of
  // whether that tool happens to trip a 429 immediately.
  if (url === SOLANA_PUBLIC_MAINNET_URL) {
    recordProactivePublicAccess("helius");
  }
  // Issue #371 follow-up: when `set_helius_api_key` flips the runtime
  // override, the resolved URL changes mid-process. Rebuild the cached
  // Connection if the URL no longer matches what we built it against —
  // otherwise the override has no effect until restart.
  if (cachedConnection && cachedConnectionUrl === url) {
    return cachedConnection;
  }
  // `confirmed` is the sweet spot for read-only portfolio/history queries —
  // `processed` is racy (may return state rolled back a slot later) and
  // `finalized` adds ~13s of latency for no meaningful safety win on reads.
  cachedConnection = new Connection(url, {
    commitment: "confirmed",
    fetch: fetchWithRateLimitDetect as never,
  });
  cachedConnectionUrl = url;
  return cachedConnection;
}

/** Test-only: drop the cached connection so a mocked `@solana/web3.js` is picked up on next call. */
export function resetSolanaConnection(): void {
  cachedConnection = undefined;
  cachedConnectionUrl = undefined;
}

// Suppress unused-import linter on getRuntimeSolanaRpc — kept imported so
// future Solana paths that don't go through the cached `Connection` (e.g.
// a `@solana/kit` createSolanaRpc call) can also pick up the override
// without re-deriving the precedence chain. Removing this unused import
// would force re-add work later.
void getRuntimeSolanaRpc;

/**
 * Resolve the mainnet RPC URL string. Same source-of-truth as
 * `getSolanaConnection`, but exposes the URL to callers that need to
 * construct a non-web3.js RPC client (e.g. `@solana/kit`'s `createSolanaRpc`
 * for the Kamino SDK).
 */
export function getSolanaRpcUrl(): string {
  return resolveSolanaRpcUrl(readUserConfig());
}
