import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as format from "../src/signing/render/format.js";
import * as common from "../src/signing/render/common.js";
import * as bitcoin from "../src/signing/render/bitcoin.js";
import * as litecoin from "../src/signing/render/litecoin.js";
import * as tron from "../src/signing/render/tron.js";
import * as evm from "../src/signing/render/evm.js";
import * as solana from "../src/signing/render/solana.js";
import * as notices from "../src/signing/render/notices.js";
// The barrel itself, imported directly (regression: every other import in
// this file goes straight to a chain module, so a dropped `export *` line
// in render-verification.ts would otherwise never be exercised).
import * as barrel from "../src/signing/render-verification.js";

/**
 * Structural falsifier for the render-verification.ts decomposition
 * (ARCHITECTURE §5.3, issue #718). Three things are asserted:
 *
 *  1. PURE BARREL: src/signing/render-verification.ts contains only
 *     re-export lines — no function, const, or interface declarations. If a
 *     render function drifts back into this file, this check breaks.
 *
 *  2. EXPORT-ALLOWLIST + RESOLUTION: each per-chain `src/signing/render/*.ts`
 *     module exists and exports EXACTLY its allowlisted entry points, per
 *     the split plan's inventory (issue #718 comment), AND each of those
 *     entry points resolves through the barrel (render-verification.ts) to
 *     the identical function object — the literal reading of "each
 *     per-chain render entry point resolves to its chain module" (§5.3).
 *     A dropped `export *` line in the barrel is caught here even though
 *     every other assertion in this file imports the chain modules
 *     directly and never touches render-verification.ts. This is the §5
 *     preamble's per-module allowlist that keeps the one-time split from
 *     silently un-happening.
 *
 *  3. NO BACK-IMPORT: no module under src/signing/render/ imports from
 *     render-verification.ts. The barrel depends on the chain modules, never
 *     the reverse — a back-import would reintroduce a cycle. This is a
 *     source-grep of actual import/require statements, not a plain
 *     substring search: src/signing/render/solana.ts:932 contains the
 *     literal string "…render-verification.ts" inside a rendered
 *     Markdown link (pinned byte-identical by
 *     test/solana-ledger-hash.test.ts), which is prose, not an import, and
 *     must not trip this check.
 */

const RENDER_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/signing/render",
);
const BARREL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../src/signing/render-verification.ts",
);

// Per-module export allowlist, transcribed from the #718 split-plan
// comment's per-chain inventory. Interfaces (e.g. `AutoInstallContext`,
// `RenderableSolanaPrepareResult`) are TS-only and erased at compile time,
// so they never appear as runtime module exports and are intentionally
// absent from these lists. The check below compares the module's FULL
// runtime export surface (`Object.keys`), not just its functions, so a
// future `export const` (or any other non-function export) landing outside
// the allowlist fails too — ARCHITECTURE.md §5 requires ANY new export to
// fail this check, not only new functions.
const MODULE_ALLOWLISTS: Record<string, { ns: Record<string, unknown>; allow: string[] }> = {
  "format.ts": {
    ns: format as unknown as Record<string, unknown>,
    allow: [
      "formatNativeShort",
      "renderCostPreviewBlock",
      "formatNonEvmCostPreview",
      "truncateHex",
      "formatArgs",
      "formatRecipientSuffix",
      "renderPrepareReceiptBlock",
    ],
  },
  "common.ts": {
    ns: common as unknown as Record<string, unknown>,
    allow: ["renderPostBroadcastBlock", "renderPostSendPollBlock"],
  },
  "bitcoin.ts": {
    ns: bitcoin as unknown as Record<string, unknown>,
    allow: ["renderBitcoinCostPreviewBlock", "renderBitcoinVerificationBlock"],
  },
  "litecoin.ts": {
    ns: litecoin as unknown as Record<string, unknown>,
    allow: [
      "renderLitecoinCostPreviewBlock",
      "renderLitecoinVerificationBlock",
    ],
  },
  "tron.ts": {
    ns: tron as unknown as Record<string, unknown>,
    allow: ["renderTronVerificationBlock", "renderTronAgentTaskBlock"],
  },
  "evm.ts": {
    ns: evm as unknown as Record<string, unknown>,
    allow: [
      "shouldRenderVerificationBlock",
      "isClearSignOnlyTx",
      "renderPreviewCostBlock",
      "renderVerificationBlock",
      "renderAgentTaskBlock",
      "renderLedgerHashBlock",
      "renderPreviewVerifyAgentTaskBlock",
    ],
  },
  "solana.ts": {
    ns: solana as unknown as Record<string, unknown>,
    allow: [
      "renderSolanaCostPreviewBlock",
      "renderSolanaPrepareSummaryBlock",
      "renderSolanaPrepareAgentTaskBlock",
      "renderSolanaVerificationBlock",
      "renderSolanaAgentTaskBlock",
    ],
  },
  "notices.ts": {
    ns: notices as unknown as Record<string, unknown>,
    allow: [
      "renderMissingSkillWarning",
      "renderMissingSetupSkillWarning",
      "renderPreflightSkillPinBlock",
      "renderMissingDemoWalletWarning",
      "renderUpdateAvailableNotice",
    ],
  },
};

// Matches an actual import/require of render-verification (any relative
// depth, with or without a .js/.ts extension) — never a substring inside a
// string literal, comment, or Markdown link. Four forms, each a distinct
// cycle-creating regression:
//  - `import ... from "...render-verification..."` (anchored to line start)
//  - `export ... from "...render-verification..."` — a re-export creates
//    the same cycle as an import (regression: previously only `import` was
//    in the leading-keyword alternation, so `export { x } from
//    "../render-verification.js"` evaded).
//  - bare `import "...render-verification..."` with no `from` clause
//    (regression: the import-from alternative requires a literal `from`,
//    so a side-effect-only import evaded).
//  - `import(...)`, left UNANCHORED to the line start so an assignment
//    prefix doesn't hide it (regression: `const x = await
//    import("...render-verification...")` evaded when this alternative was
//    anchored, since the line starts with `const`, not `import(`).
// `require(...)` stays anchored behind a leading const/let/var, unchanged
// from the original design (not one of the evasions above).
const BACK_IMPORT_RE =
  /^\s*(?:import|export)\b[^;]*from\s+["'][^"']*render-verification(?:\.[jt]s)?["']|^\s*import\s+["'][^"']*render-verification(?:\.[jt]s)?["']|^(?!\s*(?:\/\/|\*))[^"'\/]*import\(\s*["'][^"']*render-verification(?:\.[jt]s)?["']\s*\)|^\s*(?:const|let|var)\s+.*require\(\s*["'][^"']*render-verification(?:\.[jt]s)?["']\s*\)/m;

describe("render-verification.ts decomposition (#718, ARCHITECTURE §5.3)", () => {
  it("render-verification.ts is a pure barrel: only re-export lines, no declarations", () => {
    const src = readFileSync(BARREL_PATH, "utf8");
    const lines = src.split("\n").filter((l) => l.trim().length > 0);
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      expect(line).toMatch(
        /^export (\*|type \{[^}]*\}) from ["'][^"']+\.js["'];$/,
      );
    }
    // Belt-and-suspenders: no `function`, `const`, `class`, or bare
    // `interface` keyword anywhere in the file (re-export syntax never
    // contains any of these tokens).
    expect(src).not.toMatch(/\b(function|class|interface)\b/);
    expect(src).not.toMatch(/^\s*const\s/m);
  });

  for (const [file, { ns, allow }] of Object.entries(MODULE_ALLOWLISTS)) {
    it(`render/${file} exists and exports EXACTLY its allowlisted entry points`, () => {
      expect(existsSync(path.join(RENDER_DIR, file))).toBe(true);
      // Plain key equality against the FULL export surface (regression: a
      // `typeof === "function"` filter here would let a future
      // `export const` escape the allowlist undetected — interfaces erase
      // at runtime and never appear in Object.keys either way, so filtering
      // to functions bought nothing but a blind spot).
      expect(Object.keys(ns).sort()).toEqual([...allow].sort());
      // Barrel resolution: each allowlisted export must be the SAME
      // function object when reached through render-verification.ts
      // (regression: this file's other assertions only ever import the
      // chain module directly, so a dropped `export *` line in the barrel
      // would pass every check above while breaking every real caller).
      for (const name of allow) {
        expect(Object.is((barrel as Record<string, unknown>)[name], ns[name])).toBe(true);
      }
    });
  }

  it("all render/*.ts modules are covered by an allowlist (no untracked module)", () => {
    const actualFiles = readdirSync(RENDER_DIR).filter((f) => f.endsWith(".ts"));
    expect(actualFiles.sort()).toEqual(Object.keys(MODULE_ALLOWLISTS).sort());
  });

  it("no module under src/signing/render/ imports render-verification.ts", () => {
    const files = readdirSync(RENDER_DIR).filter((f) => f.endsWith(".ts"));
    const offenders: string[] = [];
    for (const file of files) {
      const src = readFileSync(path.join(RENDER_DIR, file), "utf8");
      for (const line of src.split("\n")) {
        if (BACK_IMPORT_RE.test(line)) offenders.push(`${file}: ${line.trim()}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("control: the back-import check actually fires on a real import statement", () => {
    // Proves the regex isn't vacuously passing — a known-bad line trips it.
    expect(BACK_IMPORT_RE.test('import { x } from "../render-verification.js";')).toBe(true);
    // Regression coverage for the three forms that evaded the prior regex:
    // export-from re-export.
    expect(
      BACK_IMPORT_RE.test('export { renderVerificationBlock } from "../render-verification.js";'),
    ).toBe(true);
    // bare side-effect import (no `from` clause).
    expect(BACK_IMPORT_RE.test('import "../render-verification.js";')).toBe(true);
    // assigned dynamic import.
    expect(
      BACK_IMPORT_RE.test('const mod = await import("../render-verification.js");'),
    ).toBe(true);

    // And the pinned Markdown-link prose in solana.ts (same substring, no
    // import/export/require keyword) must NOT trip it. Read the REAL line
    // from the actual file at test runtime rather than hand-typing a
    // paraphrase, so this control stays coupled to the exact text it is
    // meant to prove is a false-positive risk (regression: a paraphrase can
    // silently drift from render/solana.ts and stop proving anything).
    const solanaSrc = readFileSync(path.join(RENDER_DIR, "solana.ts"), "utf8");
    const verifierSourceLines = solanaSrc
      .split("\n")
      .filter((l) => l.includes("[Verifier source]"));
    expect(verifierSourceLines.length).toBeGreaterThan(0);
    for (const line of verifierSourceLines) {
      expect(BACK_IMPORT_RE.test(line)).toBe(false);
    }
  });
});
