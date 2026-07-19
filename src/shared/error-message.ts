/**
 * Safely render an unknown thrown value as a human-readable string.
 *
 * The naive `error instanceof Error ? error.message : String(error)` pattern
 * (used by the txHandler wrapper in `src/index.ts` until issue #326) breaks
 * on errors whose `.message` is itself a structured object — common with
 * WalletConnect SDK errors (`{ code, message }` payloads), some viem
 * decoding errors, and a few protocol clients. Template-string
 * interpolation calls `Object.prototype.toString` and produces the
 * famously useless `"[object Object]"`.
 *
 * Live regression — issue #326, 2026-04-27 08:09 UTC: a WalletConnect
 * `eth_sendTransaction` retry surfaced as `Error: [object Object]`,
 * leaving the agent (and the user reading the agent's report) with no
 * idea what actually went wrong, which compounded the panic of the
 * adjacent retry-storm bug.
 *
 * Behavior:
 *   - `Error` with a non-empty string `.message` → the message
 *   - `Error` with an object `.message` → `<name>: <JSON-stringified>`,
 *     so the structured fields ({code, data, …}) are visible
 *   - Plain string → the string
 *   - Plain object → JSON-stringified (own props + a few common Error fields)
 *   - Anything else → `String(value)` as a last resort
 *
 * Stable, side-effect-free, no IO. Always returns a non-empty string.
 */
/**
 * Provider API keys are configured into the RPC URL PATH (Infura
 * `/v3/<key>`, Alchemy `/v2/<key>`) or as an `api-key`/`apikey` query
 * param (`src/config/chains.ts`). A viem `HttpRequestError` from a
 * transport failure carries that full URL in both its `.message` (a
 * "URL: …" line) and a `.url` own-prop — confirmed empirically against
 * the installed viem@2.54.x — so an untouched serialization leaks the
 * key into the MCP tool-error response.
 *
 * This is the choke-point redactor (issue #695): every string
 * `safeErrorMessage` is about to return passes through it, so the leak
 * is closed once for every provider and every error shape rather than
 * per-provider. It is a pure string transform — it does not know or
 * care which provider produced the URL.
 *
 * Redacts:
 *   - `/v3/<seg>` and `/v2/<seg>` path segments (the Infura/Alchemy key
 *     slot) — `<seg>` must be ≥ 8 chars to avoid clobbering short,
 *     non-secret path words like `/v2/eth`.
 *   - `api-key=` / `apikey=` query-param values (any host).
 *   - The first path segment after a known data-provider host
 *     (QuickNode `<name>.quiknode.pro/<token>`, Triton `rpcpool.com` /
 *     `triton.one`, NOWNodes `nownodes.io`, GetBlock `getblock.io`) —
 *     same ≥ 8-char floor, keyed off the PROVIDER_HOST set below so a
 *     legitimate non-provider path word is never clobbered.
 *   - Bare `?key=` / `?token=` / `?access_token=` query values, but ONLY
 *     on a known provider host (NOWNodes / GetBlock / …) — a legitimate
 *     non-provider `?token=` in unrelated text passes through untouched.
 *   - URL userinfo — `https://user:pass@host/…` basic-auth RPC endpoints
 *     (`src/config/btc.ts` hosted-provider basic auth). Userinfo before
 *     the `@` in an http(s) URL is a credential by construction, so this
 *     one is redacted on any host, not just the provider set.
 *
 * The `***` placeholder is left in place so the reader still sees that
 * a redaction happened.
 *
 * OVER-REDACTION is the primary risk (issue #768): the provider-keyed
 * shapes above deliberately anchor on PROVIDER_HOST rather than a blanket
 * "redact any path segment / any ?token=", so real 0x addresses, tx
 * hashes, non-secret path words (`/v2/eth`), block-explorer URLs
 * (`etherscan.io`), and non-provider query params survive verbatim.
 */
// Known data-provider RPC host suffixes (registrable domain, subdomains
// allowed). VaultPilot builds Infura/Alchemy/Helius URLs itself
// (src/config/chains.ts, src/setup.ts) and documents QuickNode / Triton /
// NOWNodes / GetBlock as user-pasted `SOLANA_RPC_URL` / `*_RPC_URL` custom
// endpoints (src/types/index.ts, src/setup.ts, src/config/btc.ts). The
// path-token and bare-query-key redactions below fire ONLY when a URL's host
// matches this set — that is what keeps a legitimate non-provider `?token=`
// or path word from being clobbered.
const PROVIDER_HOST = String.raw`(?:[A-Za-z0-9-]+\.)*(?:quiknode\.pro|rpcpool\.com|triton\.one|nownodes\.io|getblock\.io|helius-rpc\.com|infura\.io|alchemy\.com)`;
// URL scheme + OPTIONAL userinfo, so a provider URL that ALSO carries basic
// auth (`https://user:pass@host/<token>`) still anchors on the host whether
// the userinfo pattern has already run or not (order-independent redaction).
const URL_PREFIX = String.raw`https?:\/\/(?:[^/@\s]+@)?`;

// Provider-shape-specific, NOT a general secret scrubber: these patterns match
// the exact URL shapes VaultPilot configures keys into. A token embedded any
// other way is not covered — widen deliberately if a new provider adds a new
// shape.
const API_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Infura `/v3/<key>` and Alchemy `/v2/<key>` path segments.
  [/(\/v[23]\/)[A-Za-z0-9_-]{8,}/g, "$1***"],
  // `api-key=<key>` / `apikey=<key>` query params (any host).
  [/([?&](?:api-?key)=)[^&#\s"')\]]+/gi, "$1***"],
  // QuickNode / Triton / NOWNodes / GetBlock path token — the credential is
  // the first path segment after a KNOWN provider host
  // (`https://<name>.quiknode.pro/<token>/`). Reuses the ≥8-char floor so a
  // short non-secret path word (`/health`) survives.
  [
    new RegExp(String.raw`(${URL_PREFIX}${PROVIDER_HOST}(?::\d+)?\/)[A-Za-z0-9_-]{8,}`, "gi"),
    "$1***",
  ],
  // Bare `?key=` / `?token=` / `?access_token=` on a KNOWN provider host —
  // the `api-key`/`apikey` pattern above misses these param names. Host-keyed
  // so a legitimate non-provider `?token=` is NOT clobbered.
  [
    new RegExp(
      String.raw`(${URL_PREFIX}${PROVIDER_HOST}(?::\d+)?[^\s"')\]]*?[?&](?:access_token|token|key)=)[^&#\s"')\]]+`,
      "gi",
    ),
    "$1***",
  ],
  // URL userinfo — `https://user:pass@host/…`. Redacted on ANY host: userinfo
  // before the `@` in an http(s) URL is a credential by construction.
  [new RegExp(String.raw`(https?:\/\/)[^/?#\s@]+@`, "gi"), "$1***@"],
];

export function redactSecrets(str: string): string {
  let out = str;
  for (const [pattern, replacement] of API_KEY_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

export function safeErrorMessage(error: unknown): string {
  return redactSecrets(safeErrorMessageRaw(error));
}

/**
 * Success-path response redactor (issue #707, follow-up to #695/#703).
 *
 * #695/#703 closed the ERROR path — every string `safeErrorMessage` returns
 * is redacted before it reaches an MCP tool-error response. But on the
 * SUCCESS path, module adapters embed a CAUGHT upstream `err.message` in a
 * `reason`/`note` field (`compare_yields` → `aave.ts`/`compound.ts`/
 * `marginfi.ts`; the incidents chain scans → `chain-solana.ts`/`chain-tron.ts`/
 * `chain-utxo.ts`; `execution/index.ts` RPC helpers; `simulation/index.ts`
 * `revertReason`) and that object is JSON-serialized into a SUCCESS content
 * block WITHOUT passing through `safeErrorMessage` — leaking the keyed RPC URL
 * (Infura `/v3/<key>`, Alchemy `/v2/<key>`, Helius `?api-key=<key>`) verbatim.
 *
 * This runs the SAME `redactSecrets` transform over every text content block
 * of the response it is APPLIED to — closing the leak for every provider and
 * every `reason`/`note` field in that response, current or future, rather than
 * per-adapter (per ARCHITECTURE §4 INV-T2, and the #707 design note).
 *
 * It does NOT cover a tool "by construction" on its own: it only redacts the
 * boundaries it is wired into, so it must be applied at EVERY MCP
 * response-serialization boundary. There is no single choke point — a handler
 * that serializes its own `{ content }` return without routing through a
 * wrapped boundary is uncovered (that was the #707-rework gap: the three
 * directly-registered preview/send handlers below). The full set of wired
 * boundaries: `handler()`'s success return, `broadcastSimulationDispatch`'s
 * envelope, and the `preview_send` / `preview_solana_send` / `send_transaction`
 * handler success returns (`src/index.ts`).
 *
 * Mutates in place; every caller builds a fresh `content` array per request,
 * so the mutation is local. Idempotent — re-redacting an already-safe block
 * is a no-op (`***` matches no key pattern), so wrapping a clean preview/send
 * payload (tx hashes, addresses, amounts) leaves it untouched.
 *
 * Non-text blocks (issue #768 part C): every MCP block VaultPilot emits today
 * is `{ type: 'text' }`, but the MCP block union also has resource /
 * resource_link / image / audio shapes that carry credential-bearing strings
 * in OTHER fields (`resource.uri`, `resource.text`, `resource_link.uri`).
 * Rather than assume text-only forever, we DEFENSIVELY redact every string
 * field of every block, recursing through nested objects/arrays. Base64
 * payload fields (`data` / `blob` on image/audio/resource blocks) are SKIPPED:
 * a provider key is never base64-embedded there, and running `redactSecrets`
 * over a binary blob could corrupt a legitimate payload. This preserves the
 * existing `text`-block behavior exactly (a `text` string is still redacted)
 * while closing the non-text gap by construction.
 */
export function redactResponseContent<T extends { content: unknown[] }>(
  response: T,
): T {
  for (const block of response.content) {
    redactStringsInPlace(block, 0);
  }
  return response;
}

/**
 * Redact every string reachable inside a content block, mutating in place.
 * Skips `data` / `blob` keys (base64 image/audio/resource payloads — never a
 * key carrier, and redaction could corrupt binary). Depth-bounded to guard
 * against a pathological/cyclic block shape; MCP blocks are shallow.
 */
function redactStringsInPlace(value: unknown, depth: number): void {
  if (value === null || typeof value !== "object" || depth > 4) return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (typeof el === "string") value[i] = redactSecrets(el);
      else redactStringsInPlace(el, depth + 1);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "data" || key === "blob") continue;
    const v = obj[key];
    if (typeof v === "string") obj[key] = redactSecrets(v);
    else redactStringsInPlace(v, depth + 1);
  }
}

function safeErrorMessageRaw(error: unknown): string {
  if (typeof error === "string") {
    return error.length > 0 ? error : "Unknown error (empty string thrown)";
  }
  if (error === null || error === undefined) {
    return `Unknown error (${error === null ? "null" : "undefined"} thrown)`;
  }
  if (error instanceof Error) {
    const message = error.message;
    if (typeof message === "string" && message.length > 0 && message !== "[object Object]") {
      return message;
    }
    // .message was an object, empty, or already the stringification bug —
    // surface the structured fields. Walking own properties catches
    // SDK-thrown errors that attach `code`, `data`, `cause`, etc.
    const detail = stringifyOwnProps(error);
    const name = (error.name && typeof error.name === "string") ? error.name : "Error";
    return detail.length > 0 ? `${name}: ${detail}` : name;
  }
  if (typeof error === "object") {
    const detail = stringifyOwnProps(error);
    return detail.length > 0 ? detail : Object.prototype.toString.call(error);
  }
  return String(error);
}

/**
 * Render the most useful properties of an object to JSON. Surfaces
 * non-enumerable Error props (`name`, `message`, `code`) that
 * `JSON.stringify` would otherwise drop, while skipping `stack`
 * (carries V8 trace noise that often includes the literal
 * `"[object Object]"` from the throw site and would defeat the
 * cleanup). Returns "" when nothing useful is available.
 *
 * Implementation note: builds a plain enumerable copy first, THEN
 * JSON.stringifies it. An earlier attempt used the JSON.stringify
 * array-filter form (`JSON.stringify(value, namesArray)`) — that
 * filters AT EVERY NESTING LEVEL, which strips nested object internals
 * (e.g. `message.code` when `code` isn't in the outer Error's name
 * list). The plain-copy approach lets default recursion handle nested
 * shapes naturally.
 */
function stringifyOwnProps(value: unknown): string {
  if (value === null || typeof value !== "object") return "";
  const flat: Record<string, unknown> = {};
  for (const name of Object.getOwnPropertyNames(value as object)) {
    if (name === "stack") continue;
    flat[name] = (value as Record<string, unknown>)[name];
  }
  if (Object.keys(flat).length === 0) return "";
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(flat, (_key, v) => {
      if (typeof v === "function") return undefined;
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) {
        return { name: v.name, message: v.message };
      }
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[circular]";
        seen.add(v);
      }
      return v;
    });
  } catch {
    return "";
  }
}
