"use strict";
/**
 * Fetch-stubbing shim for scripts/bench-latency.mjs (PR #834 review,
 * IMPORTANT 2).
 *
 * bench-latency.mjs mocks the EVM JSON-RPC surface, but two of the benched
 * tool paths also make REAL outbound HTTP calls that have nothing to do with
 * RPC latency:
 *   - `enrichTx` (all prepare_*) / `computePreviewCost` (preview_send) call
 *     `getTokenPrice` -> src/data/prices.ts `getTokenPrices`, a fetch to
 *     `https://coins.llama.fi/prices/current/...` (10s timeout, failures
 *     not cached — src/data/http.ts `fetchWithTimeout`).
 *   - `prepare_weth_unwrap`'s non-empty calldata makes `verifyEvmCalldata`
 *     call `fetch4byteSignatures` -> src/data/apis/fourbyte.ts, a fetch to
 *     `https://www.4byte.directory/api/v1/signatures/...` (also a 10s
 *     timeout on failure).
 * Left unmocked, a bench run on a network-restricted host would pay up to
 * two uncached ~10s timeouts per prepare_*/preview_send iteration, and the
 * measured p95 would be indistinguishable from "RPC too slow" even though
 * neither third-party host is on the RPC path this bench exists to measure.
 * This shim removes that ambiguity by making both hosts resolve instantly.
 *
 * ONLY `coins.llama.fi` and `www.4byte.directory` are intercepted; every
 * other host (including the mock RPC server itself — viem's http transport
 * also rides `globalThis.fetch`, dispatch here is by hostname only)
 * passes straight through to the real `fetch`.
 *
 * Wired in via the `--require` flag on the spawned child process
 * (`FETCH_SHIM_PATH`, in scripts/bench-latency.mjs's `startMcpClient`), so
 * `globalThis.fetch` is already patched before dist/index.js's own
 * top-level code runs. That spawn-side wiring landed together with this
 * file's rewritten header — an earlier revision of this shim existed but
 * was never actually passed to `--require` anywhere, so it patched
 * nothing; do not take this file's mere presence as proof it's in effect,
 * check the spawn call.
 *
 * Written as CommonJS and loaded via `--require` rather than the more
 * modern `--import` (which the review initially suggested): package.json
 * pins `engines.node: ">=18.17.0"`, and `--import` only exists from Node
 * 18.18.0 / 20.6.0 onward — a Node 18.17.x host would fail to boot the
 * bench at all with an "unknown flag" error. `--require` has preloaded
 * CommonJS ahead of an ESM entry point since early Node and needs no
 * version gate; global mutation (`globalThis.fetch = ...`) is realm-wide
 * regardless of which module system performed it, so a CJS preload still
 * successfully patches the fetch calls dist/index.js's ESM code makes
 * later. Never claimed to have been run — see the PR body for why.
 */

const STUB_HOSTS = new Set(["coins.llama.fi", "www.4byte.directory"]);

const realFetch = globalThis.fetch;
if (typeof realFetch !== "function") {
  throw new Error(
    "bench-latency fetch shim: globalThis.fetch is not available on this Node version " +
      "(dist/index.js already depends on it being global — see src/data/http.ts).",
  );
}

function jsonResponse(body) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stub for `https://coins.llama.fi/prices/current/<keys>` — DefiLlama's
 * "current price" endpoint. `keys` is a comma-separated, URL-encoded list
 * of either `coingecko:<id>` (native coin) or `<chain>:<address>` (ERC-20)
 * — see src/data/prices.ts `queryToLlamaKey`. Echoes a plausible price back
 * for every key actually requested rather than hardcoding one, so it stays
 * correct if the bench's tool/token set changes later.
 */
function stubDefiLlama(url) {
  const marker = "/prices/current/";
  const idx = url.pathname.indexOf(marker);
  const rawKeys = idx === -1 ? "" : decodeURIComponent(url.pathname.slice(idx + marker.length));
  const keys = rawKeys
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
  const nowSec = Math.floor(Date.now() / 1000);
  const coins = {};
  for (const key of keys) {
    coins[key] = { price: 2500, symbol: "MOCK", decimals: 18, timestamp: nowSec };
  }
  return jsonResponse({ coins });
}

/**
 * Stub for `https://www.4byte.directory/api/v1/signatures/?hex_signature=...`
 * — an empty result set is a valid, well-formed response (the real API
 * returns exactly this shape for an unregistered selector); `verifyEvmCalldata`
 * treats it as "no-signature" and degrades its cross-check text, which never
 * fails the underlying tool call (src/index.ts's `handler()` wraps the
 * cross-check in its own try/catch — see PR #834 review context).
 */
function stub4byte() {
  return jsonResponse({ count: 0, next: null, previous: null, results: [] });
}

globalThis.fetch = async function bench_latency_stubbed_fetch(input, init) {
  let url;
  try {
    const raw = typeof input === "string" ? input : (input && input.url) || String(input);
    url = new URL(raw);
  } catch {
    return realFetch(input, init);
  }
  if (STUB_HOSTS.has(url.hostname)) {
    if (url.hostname === "coins.llama.fi") return stubDefiLlama(url);
    return stub4byte();
  }
  return realFetch(input, init);
};
