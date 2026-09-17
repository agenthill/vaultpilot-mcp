import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

import * as btcIndexer from "../src/modules/btc/indexer.js";
import * as ltcIndexer from "../src/modules/litecoin/indexer.js";

/**
 * Structural falsifier for the BTC/LTC Esplora indexer decomposition
 * (ARCHITECTURE.md §5.1, issue #716). Both `src/modules/btc/indexer.ts`
 * and `src/modules/litecoin/indexer.ts` are now delegation-only barrels
 * over the parametrized client in `src/modules/utxo/esplora-client.ts` —
 * this pins that shape so neither barrel can silently re-accumulate a
 * local implementation or a local type block.
 *
 * Checked via source text plus two live namespace imports (no tsc in this
 * environment): the barrels' own exports are TYPE aliases for the most
 * part, which are erased at runtime, so a plain `import *` + `Object.keys`
 * check (as `test/execution-decomposition.test.ts` uses for its
 * value-only exports) can't see the full type-level surface on its own —
 * it's used here too, but only to pin the runtime (value) subset; the
 * type-only names are still pinned via regex extraction over the source.
 *
 * Three things are asserted:
 *
 *  1. DELEGATION-ONLY: neither indexer file declares a `class` (including
 *     class expressions in expression position — assigned, returned,
 *     passed as an argument, etc.), and neither calls `fetchWithTimeout`
 *     directly or imports it from `data/http` — all HTTP + retry logic
 *     lives once, in the shared client.
 *
 *  2. EXPORT-ALLOWLIST: each indexer file exports EXACTLY its permitted
 *     surface — no more, no fewer. This is checked two ways: a regex
 *     extraction over the source text for the full surface (types
 *     included, since those are erased at runtime and a plain namespace
 *     import can't see them), and a live `import * as ns` + `Object.keys`
 *     check for the runtime (value/function) subset, which also catches
 *     export forms the regex doesn't parse (`export { X }` with no
 *     `from`, `export * from`, `export default`). Accepted residual: an
 *     unexported helper (function or type) could still be reintroduced
 *     into a barrel without moving either check — that's a real gap, but
 *     chasing every unexported local addition is not this test's job.
 *
 *  3. SINGLE-IMPLEMENTATION: `esplora-client.ts` is the only file under
 *     `src/modules/{btc,litecoin,utxo}` (searched recursively) that
 *     defines an Esplora-shaped indexer client — detected structurally
 *     (declares `implements EsploraClient`/`implements BtcEsploraClient`,
 *     or has the `baseUrl` + HTTP-request-call shape of one) rather than
 *     by the class's own name containing "Esplora", so a rename can't
 *     evade the check.
 */

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function readSrc(relPath: string): string {
  return readFileSync(`${REPO_ROOT}${relPath}`, "utf8");
}

/** Recursively list every `.ts` file under `relDir` (relative to repo root). */
function listTsFilesRecursive(relDir: string): string[] {
  const out: string[] = [];
  const walk = (rel: string) => {
    for (const entry of readdirSync(`${REPO_ROOT}${rel}`, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile() && entry.name.endsWith(".ts")) {
        out.push(childRel);
      }
    }
  };
  walk(relDir);
  return out;
}

/**
 * Strip `/* *\/` and `//` comments before running any structural regex
 * over source text, so prose that happens to mention "class" can't fire a
 * check meant to catch real declarations.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/**
 * Matches a `class` keyword in declaration position (`class Foo`) OR in
 * expression position: assigned (`= class`, including anonymous class
 * expressions with no name), passed as an argument or array/object
 * element (`(class`, `[class`, `, class`, `: class`, `? class`),
 * returned, arrow-bodied, `new`-constructed inline, or in a `default`
 * export — so an anonymous/expression-position class can't dodge the
 * declaration-only regex the way `\bclass\s+\w+` alone would let it.
 */
const CLASS_RE =
  /\bclass\s+\w+\b|(?:=>|=|\(|\[|,|:|\?|\bnew\b|\breturn\b|\bdefault\b)\s*class\b/;

/**
 * The repo's HTTP primitive (`src/data/http.ts`) — the dead-fetch check
 * this replaces asserted `not.toMatch(/\bfetch\s*\(/)`, which fires on
 * nothing because no file under btc/litecoin/utxo calls raw `fetch(`
 * directly; they all go through this wrapper. The regression this guards
 * against is an HTTP call re-implemented in a barrel instead of staying
 * delegated to the shared client.
 */
const FETCHWITHTIMEOUT_RE = /\bfetchWithTimeout\s*\(/;
const HTTP_IMPORT_RE = /from\s+["'][^"']*\bdata\/http(?:\.js)?["']/;

/**
 * Structural markers for "this file defines an Esplora-shaped indexer
 * client" — deliberately not keyed off the class's own name (a rename,
 * e.g. to `IndexerConnector`, must not silently evade this):
 *
 *  - IMPLEMENTS_IFACE_RE: declares `implements EsploraClient` or
 *    `implements BtcEsploraClient` — the two indexer contracts defined in
 *    `esplora-client.ts`. Catches any class fulfilling the contract under
 *    any name.
 *  - HAS_BASE_URL_RE + HAS_REQUEST_CALL_RE (combined): a `baseUrl`
 *    field/param together with a call through `fetchWithTimeout(` or raw
 *    `fetch(` in the same file — catches a duck-typed client that never
 *    declares `implements` at all.
 */
const IMPLEMENTS_IFACE_RE =
  /\bimplements\s+(?:(?:Esplora|Btc\w*Esplora\w*)Client|(?:Bitcoin|Litecoin)Indexer)\b/;
const HAS_BASE_URL_RE = /\bbaseUrl\b/;
const HAS_REQUEST_CALL_RE = /\b(?:fetchWithTimeout|fetch)\s*\(/;

function definesEsploraLikeClient(source: string): boolean {
  const src = stripComments(source);
  if (IMPLEMENTS_IFACE_RE.test(src)) return true;
  // Duck-type branch requires an actual class token: a class-less file with
  // a hoisted baseUrl const plus a fetch call (e.g. btc/price.ts one
  // refactor away) is not a client and must not turn this guard red.
  if (!CLASS_RE.test(src)) return false;
  return HAS_BASE_URL_RE.test(src) && HAS_REQUEST_CALL_RE.test(src);
}

/**
 * Extract every top-level exported name from a TypeScript source file:
 * `export type X = ...`, `export function X`, `export const X`, and
 * `export type { A, B as C } from "..."` re-export lists (the alias
 * target name, matching what an importer actually sees). Covers the
 * full surface including type-only names, which are erased at runtime
 * and so invisible to a namespace-import check.
 */
function exportedNames(source: string): string[] {
  const names = new Set<string>();
  const declRe =
    /^export\s+(?:type|interface|function|const|let|var|class)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;
  for (const m of source.matchAll(declRe)) names.add(m[1]);
  const reExportRe = /^export\s+(?:type\s+)?\{([^}]+)\}\s+from/gm;
  for (const m of source.matchAll(reExportRe)) {
    for (const part of m[1].split(",")) {
      const trimmed = part.trim();
      if (!trimmed) continue;
      const asMatch = trimmed.match(/\bas\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      names.add(asMatch ? asMatch[1] : trimmed.replace(/^type\s+/, ""));
    }
  }
  return [...names].sort();
}

/**
 * Runtime (value) exports of an already-imported module namespace —
 * mirrors `test/execution-decomposition.test.ts`'s `exportedNames`. Sees
 * every export form regardless of syntax (`export { X }` with no `from`,
 * `export * from`, `export default`, ...), unlike the regex extraction
 * above, at the cost of being blind to type-only names (erased at
 * runtime) — the two checks are complementary, not redundant.
 */
function valueExportedNames(ns: Record<string, unknown>): string[] {
  return Object.keys(ns)
    .sort();
}

const BTC_INDEXER_ALLOWLIST = [
  "BitcoinAddressBalance",
  "BitcoinBlockSummary",
  "BitcoinBlockTip",
  "BitcoinFeeEstimates",
  "BitcoinIndexer",
  "BitcoinTxHistoryEntry",
  "BitcoinUtxo",
  "EsploraTx",
  "EsploraVin",
  "EsploraVout",
  "getBitcoinIndexer",
  "resetBitcoinIndexer",
].sort();

const LTC_INDEXER_ALLOWLIST = [
  "LitecoinAddressBalance",
  "LitecoinBlockSummary",
  "LitecoinBlockTip",
  "LitecoinFeeEstimates",
  "LitecoinIndexer",
  "LitecoinTxHistoryEntry",
  "LitecoinUtxo",
  "getLitecoinIndexer",
  "resetLitecoinIndexer",
].sort();

const BTC_INDEXER_VALUE_ALLOWLIST = ["getBitcoinIndexer", "resetBitcoinIndexer"].sort();
const LTC_INDEXER_VALUE_ALLOWLIST = ["getLitecoinIndexer", "resetLitecoinIndexer"].sort();

const UTXO_MODULE_DIRS = ["src/modules/btc", "src/modules/litecoin", "src/modules/utxo"];

describe("BTC/LTC Esplora indexer decomposition (#716, ARCHITECTURE §5.1)", () => {
  it("btc/indexer.ts is a delegation-only barrel (no class, no direct HTTP call)", () => {
    const src = stripComments(readSrc("src/modules/btc/indexer.ts"));
    expect(src).not.toMatch(CLASS_RE);
    expect(src).not.toMatch(FETCHWITHTIMEOUT_RE);
    expect(src).not.toMatch(HTTP_IMPORT_RE);
  });

  it("litecoin/indexer.ts is a delegation-only barrel (no class, no direct HTTP call)", () => {
    const src = stripComments(readSrc("src/modules/litecoin/indexer.ts"));
    expect(src).not.toMatch(CLASS_RE);
    expect(src).not.toMatch(FETCHWITHTIMEOUT_RE);
    expect(src).not.toMatch(HTTP_IMPORT_RE);
  });

  it("btc/indexer.ts exports EXACTLY its allowlisted surface (source-text, types included)", () => {
    expect(exportedNames(readSrc("src/modules/btc/indexer.ts"))).toEqual(
      BTC_INDEXER_ALLOWLIST,
    );
  });

  it("litecoin/indexer.ts exports EXACTLY its allowlisted surface (source-text, types included)", () => {
    expect(exportedNames(readSrc("src/modules/litecoin/indexer.ts"))).toEqual(
      LTC_INDEXER_ALLOWLIST,
    );
  });

  it("btc/indexer.ts's runtime (value) exports match EXACTLY the function subset of the allowlist", () => {
    expect(valueExportedNames(btcIndexer as Record<string, unknown>)).toEqual(
      BTC_INDEXER_VALUE_ALLOWLIST,
    );
  });

  it("litecoin/indexer.ts's runtime (value) exports match EXACTLY the function subset of the allowlist", () => {
    expect(valueExportedNames(ltcIndexer as Record<string, unknown>)).toEqual(
      LTC_INDEXER_VALUE_ALLOWLIST,
    );
  });

  it("esplora-client.ts is the only Esplora-shaped indexer client under btc/litecoin/utxo", () => {
    const classFiles: string[] = [];
    for (const dir of UTXO_MODULE_DIRS) {
      for (const rel of listTsFilesRecursive(dir)) {
        if (definesEsploraLikeClient(readSrc(rel))) classFiles.push(rel);
      }
    }
    expect(classFiles).toEqual(["src/modules/utxo/esplora-client.ts"]);
  });
});
