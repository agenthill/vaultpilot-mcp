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
 *   - `api-key=` / `apikey=` query-param values.
 *
 * The `***` placeholder is left in place so the reader still sees that
 * a redaction happened.
 */
// Provider-shape-specific, NOT a general secret scrubber: these patterns match
// the exact URL shapes VaultPilot configures keys into (Infura/Alchemy path
// segment, `api-key` query param). A token embedded any other way is not
// covered — widen deliberately if a new provider adds a new shape.
const API_KEY_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // Infura `/v3/<key>` and Alchemy `/v2/<key>` path segments.
  [/(\/v[23]\/)[A-Za-z0-9_-]{8,}/g, "$1***"],
  // `api-key=<key>` / `apikey=<key>` query params (any host).
  [/([?&](?:api-?key)=)[^&#\s"')\]]+/gi, "$1***"],
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
 * at the MCP response boundary, so the leak is closed once — for every
 * provider, every tool, and every current OR future `reason`/`note` field —
 * rather than per-adapter (per ARCHITECTURE §4 INV-T2, and the #707 design
 * note). Mutates in place; every caller builds a fresh `content` array per
 * request, so the mutation is local. Idempotent — re-redacting an
 * already-safe error block is a no-op (`***` matches no key pattern).
 */
export function redactResponseContent<T extends { content: unknown[] }>(
  response: T,
): T {
  for (const block of response.content) {
    if (
      block !== null &&
      typeof block === "object" &&
      "text" in block &&
      typeof (block as { text: unknown }).text === "string"
    ) {
      const b = block as { text: string };
      b.text = redactSecrets(b.text);
    }
  }
  return response;
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
