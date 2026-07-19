import { readUserConfig } from "../config/user-config.js";
import { getRuntimeOverride, type ServiceId } from "../data/runtime-rpc-overrides.js";

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

/**
 * Exact-match configured-secret redaction (issue #771).
 *
 * The shape-based `redactSecrets` above is inherently host-keyed: its
 * path-token / bare-`?key=` patterns fire only for hosts in `PROVIDER_HOST`,
 * so a key on a CUSTOM / unlisted provider (an Ankr path token, a dRPC
 * `?dkey=`, a self-hosted endpoint) still leaks. The durable complement is to
 * scrub the user's OWN configured secret VALUES by exact substring match:
 * every configured provider is covered (listed or not) with structurally zero
 * over-redaction, because only strings the user actually configured are used
 * as needles.
 *
 * This COMPOSES WITH the shape patterns — it does not replace them. The shape
 * patterns still cover keys that surface BEFORE config is loaded, and keys in
 * URLs the user never configured (a hard-coded default, a key pasted at
 * runtime into a URL the MCP never persisted). Do NOT delete the shape
 * patterns as "superseded" (SEC R5).
 *
 * Needles are collected FRESH at call time (never a stale module snapshot) so
 * a key configured or rotated mid-session — e.g. via `set_helius_api_key` /
 * `set_etherscan_api_key`, which write the runtime-override store — is redacted
 * from the very next output (SEC R4).
 *
 * OVER-MATCH GUARD (SEC R1): a short or empty configured value is a
 * catastrophic needle — a 1-char or `""` value would redact fragments of every
 * legitimate output. Anything shorter than `MIN_SECRET_NEEDLE_LEN` is SKIPPED
 * (matching the `{8,}` floor the shape patterns already enforce).
 *
 * NO-LEAK (SEC R3): the needle set is never logged, never returned, and never
 * exposed through a getter — holding the user's plaintext secrets so they can
 * be matched is itself a new asset, and one accidental serialization would dump
 * every configured credential at once. `redactConfiguredSecrets` catches its
 * own errors and returns the (already shape-redacted) input rather than letting
 * a thrown error carry a needle out.
 *
 * Residuals (accepted, not closed here): a TRUNCATED secret (only a prefix of a
 * key in a clipped error) will not exact-match — prefix matching would fix it at
 * an over-redaction cost not worth paying; and a base64-shaped key that is
 * PERCENT-ENCODED between its configured form and the echoed form (SEC R2) is
 * matched only for the bare-key config fields (which are alphanumeric/hex/UUID
 * and never re-encoded), not inside whole-URL needles. The shape patterns remain
 * the net for the URL case on listed hosts.
 */
const REDACTION_MARKER = "***";

/**
 * Minimum length for a configured value to be used as a redaction needle.
 * Mirrors the `{8,}` floor the shape patterns enforce (error-message.ts path
 * and bare-key patterns). A value shorter than this is skipped, never matched.
 */
const MIN_SECRET_NEEDLE_LEN = 8;

/** Services whose runtime override holds a currently-configured secret value. */
const RUNTIME_OVERRIDE_SERVICES: readonly ServiceId[] = ["helius", "etherscan"];

/**
 * Env vars that carry a secret VALUE (an API key, a keyed RPC URL, or hosted-
 * provider basic-auth / header credentials). Public-fallback URLs and non-secret
 * config live elsewhere and are deliberately not enumerated here.
 */
const SECRET_ENV_VARS: readonly string[] = [
  // Keyed / custom RPC URLs (may embed a provider key in path or query).
  "ETHEREUM_RPC_URL",
  "ARBITRUM_RPC_URL",
  "POLYGON_RPC_URL",
  "BASE_RPC_URL",
  "OPTIMISM_RPC_URL",
  "SOLANA_RPC_URL",
  "RPC_API_KEY",
  // Third-party API keys.
  "ETHERSCAN_API_KEY",
  "ONEINCH_API_KEY",
  "RESERVOIR_API_KEY",
  "SAFE_API_KEY",
  "TRON_API_KEY",
  "WALLETCONNECT_PROJECT_ID",
  // Bitcoin / Litecoin JSON-RPC + indexer credentials.
  "BITCOIN_RPC_URL",
  "BITCOIN_RPC_PASSWORD",
  "BITCOIN_RPC_AUTH_HEADER_VALUE",
  "BITCOIN_INDEXER_URL",
  "LITECOIN_RPC_URL",
  "LITECOIN_RPC_PASSWORD",
  "LITECOIN_RPC_AUTH_HEADER_VALUE",
  "LITECOIN_INDEXER_URL",
];

/**
 * Collect the set of currently-configured secret VALUES to redact. Reads the
 * live user-config file, the secret env vars, and the in-memory runtime
 * overrides on every call — no cached snapshot — so a just-configured or
 * just-rotated key is covered. Values below the length floor are dropped, the
 * set is deduped, and it is sorted LONGEST-FIRST so a value that contains
 * another (a keyed URL that embeds the bare key) is redacted before its
 * substring, avoiding partial-overlap artifacts.
 *
 * NEVER logs or returns anything derived from a needle beyond the redaction
 * itself. Not exported — the needle set is not a public asset.
 */
function collectConfiguredSecretNeedles(): string[] {
  const raw: Array<string | undefined> = [];

  // Runtime overrides (in-memory; set via set_*_api_key). Read fresh.
  for (const service of RUNTIME_OVERRIDE_SERVICES) {
    raw.push(getRuntimeOverride(service) ?? undefined);
  }

  // User config file. readUserConfig can throw on malformed JSON — swallow and
  // fall through to env/overrides rather than failing the redaction path.
  try {
    const cfg = readUserConfig();
    if (cfg) {
      raw.push(cfg.rpc?.apiKey);
      if (cfg.rpc?.customUrls) {
        for (const url of Object.values(cfg.rpc.customUrls)) raw.push(url);
      }
      raw.push(
        cfg.etherscanApiKey,
        cfg.oneInchApiKey,
        cfg.reservoirApiKey,
        cfg.safeApiKey,
        cfg.tronApiKey,
        cfg.solanaRpcUrl,
        cfg.bitcoinIndexerUrl,
        cfg.litecoinIndexerUrl,
        cfg.walletConnect?.projectId,
      );
    }
  } catch {
    // Malformed config — no config-derived needles this call.
  }

  // Secret env vars.
  for (const name of SECRET_ENV_VARS) raw.push(process.env[name]);

  // Floor-filter + dedup + longest-first.
  const seen = new Set<string>();
  const needles: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const trimmed = v.trim();
    if (trimmed.length < MIN_SECRET_NEEDLE_LEN) continue; // over-match guard
    if (seen.has(trimmed)) continue;
    seen.add(trimmed);
    needles.push(trimmed);
  }
  needles.sort((a, b) => b.length - a.length);
  return needles;
}

/** Replace every exact occurrence of each needle with the redaction marker. */
function applyNeedles(str: string, needles: readonly string[]): string {
  let out = str;
  for (const needle of needles) {
    if (out.includes(needle)) out = out.split(needle).join(REDACTION_MARKER);
  }
  return out;
}

/**
 * Exact-match scrub of the user's currently-configured secret values.
 * Collects the needle set fresh, then replaces every exact occurrence. Catches
 * its own errors and returns the input unchanged (never surfaces a caught error
 * that could embed a needle). Intended to run AFTER `redactSecrets` so the two
 * layers compose (shape-based net + exact-match known-secret catch).
 */
export function redactConfiguredSecrets(str: string): string {
  try {
    return applyNeedles(str, collectConfiguredSecretNeedles());
  } catch {
    // Never let a redaction-path error escape carrying a needle.
    return str;
  }
}

export function safeErrorMessage(error: unknown): string {
  // Shape-based net first, then exact-match of the user's own configured
  // secrets (issue #771) — composed, not replacing.
  return redactConfiguredSecrets(redactSecrets(safeErrorMessageRaw(error)));
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
  // Collect the exact-match needle set ONCE per response (not per string — the
  // collector reads the config file, so per-string collection would re-read
  // disk for every field). Every string is scrubbed with the shape patterns
  // AND this set.
  let needles: string[] = [];
  try {
    needles = collectConfiguredSecretNeedles();
  } catch {
    needles = [];
  }
  for (const block of response.content) {
    redactStringsInPlace(block, 0, needles);
  }
  return response;
}

/**
 * Depth bound for `redactStringsInPlace`. Raised from the original silent
 * `depth > 4` cap (issue #770 folded observation): a credential nested deeper
 * than 4 levels in a future non-text block would have been silently missed —
 * a silent cap on a SECURITY scrub is the wrong failure direction. The bound is
 * kept (not removed) so a pathological/cyclic block shape still terminates, but
 * raised well past any realistic MCP block, and hitting it now emits a
 * diagnostic (never the value) instead of failing silent.
 */
const MAX_REDACT_DEPTH = 32;

/** One-time flag so a pathological deep block warns once, not per string. */
let depthCapDiagnosticEmitted = false;

/**
 * Redact every string reachable inside a content block, mutating in place.
 * Applies the shape-based `redactSecrets` AND the exact-match `needles`
 * (issue #771). Skips `data` / `blob` keys (base64 image/audio/resource
 * payloads — never a key carrier, and redaction could corrupt binary).
 * Depth-bounded (`MAX_REDACT_DEPTH`) to guard against a pathological/cyclic
 * block shape; the cap emits a diagnostic when hit rather than truncating
 * silently (issue #770).
 */
function redactStringsInPlace(
  value: unknown,
  depth: number,
  needles: readonly string[],
): void {
  if (value === null || typeof value !== "object") return;
  if (depth > MAX_REDACT_DEPTH) {
    if (!depthCapDiagnosticEmitted) {
      depthCapDiagnosticEmitted = true;
      // Diagnostic only — NEVER the value/secret. Signals that a
      // deeper-than-expected block was not fully scrubbed so the shape is
      // investigated rather than the leak going silent.
      // eslint-disable-next-line no-console
      console.warn(
        `[vaultpilot] redaction depth cap (${MAX_REDACT_DEPTH}) hit — a deeply ` +
          `nested content block was not fully scrubbed. This is unexpected; ` +
          `please report the tool that produced it.`,
      );
    }
    return;
  }
  const scrub = (s: string): string => applyNeedles(redactSecrets(s), needles);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const el = value[i];
      if (typeof el === "string") value[i] = scrub(el);
      else redactStringsInPlace(el, depth + 1, needles);
    }
    return;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (key === "data" || key === "blob") continue;
    const v = obj[key];
    if (typeof v === "string") obj[key] = scrub(v);
    else redactStringsInPlace(v, depth + 1, needles);
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
