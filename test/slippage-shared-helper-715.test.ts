/**
 * Issue #715 / ARCHITECTURE.md §5.5 — one shared implementation of the
 * min-out floor and the max-in ceiling.
 *
 * Two halves, both required:
 *
 * 1. BEHAVIOUR (the consolidation changed nothing). `applyMinOut` /
 *    `applyMaxIn` must return byte-identical values to the inline formulas
 *    they replaced, including the asymmetric rounding — floor truncates
 *    DOWN, ceiling rounds UP via the `+ 9_999n` bias. Pinned against literal
 *    expected values (not just a second copy of the same expression) for the
 *    cases where the rounding direction is the whole point.
 *
 * 2. STRUCTURE (the duplication cannot come back). Transcribes the issue's
 *    falsifiable acceptance criterion — `grep -rnE '10_?000 *[-+]'` over
 *    `src/modules/{shared,swap,uniswap-swap,curve}` returns exactly the two
 *    shared-helper definitions, any third hit is a duplicate — as a real
 *    file walk, and extends it with `src/modules/tron` (a 5th call site the
 *    issue's enumeration predates). Both separator spellings (`10000` and
 *    `10_000`) and both operators are covered, per the criterion's own note
 *    that the earlier grep was holed on exactly those axes.
 *
 * RED on unfixed code: `src/modules/shared/slippage.ts` does not exist, so
 * half 1 fails at import; half 2 sees the seven pre-refactor arithmetic
 * sites instead of two. RED again if any future call site re-inlines either
 * formula rather than importing the helper.
 *
 * NOT vacuous: the scan is asserted to actually match the helper's own two
 * definitions, so a broken regex (which would make "no duplicates found"
 * trivially true) fails loudly instead of passing.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";
import { applyMinOut, applyMaxIn } from "../src/modules/shared/slippage.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const SHARED_HELPER = join("src", "modules", "shared", "slippage.ts");

/**
 * The exact arithmetic that lived at each call site before this
 * consolidation, kept here as the equivalence oracle.
 */
function inlineMinOut(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}
function inlineMaxIn(quotedIn: bigint, slippageBps: number): bigint {
  return (quotedIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

/** (amount, bps) pairs spanning dust, exact multiples, and 18-decimal size. */
const CASES: Array<[bigint, number]> = [
  [0n, 0],
  [0n, 50],
  [1n, 0],
  [1n, 1],
  [1n, 50],
  [3n, 5000],
  [999n, 50],
  [1_000_000n, 0],
  [1_000_000n, 50],
  [1_000_000n, 100],
  [1_000_000n, 9999],
  [123_456_789_012_345_678n, 37],
  [1_000_000_000_000_000_000n, 50],
  [2n ** 128n - 1n, 250],
];

describe("#715 — shared slippage helper matches the inline formulas it replaced", () => {
  it("applyMinOut equals the pre-refactor exact-IN floor on every case", () => {
    for (const [amount, bps] of CASES) {
      expect(applyMinOut(amount, bps), `applyMinOut(${amount}, ${bps})`).toBe(
        inlineMinOut(amount, bps),
      );
    }
  });

  it("applyMaxIn equals the pre-refactor exact-OUT ceiling on every case", () => {
    for (const [amount, bps] of CASES) {
      expect(applyMaxIn(amount, bps), `applyMaxIn(${amount}, ${bps})`).toBe(
        inlineMaxIn(amount, bps),
      );
    }
  });

  it("pins the floor's literal values, including truncation DOWN", () => {
    expect(applyMinOut(1_000_000n, 50)).toBe(995_000n);
    expect(applyMinOut(1_000_000n, 0)).toBe(1_000_000n);
    // 0.995 wei -> 0: never promise more output than the bound guarantees.
    expect(applyMinOut(1n, 50)).toBe(0n);
    // 1.5 wei -> 1.
    expect(applyMinOut(3n, 5000)).toBe(1n);
    expect(applyMinOut(0n, 50)).toBe(0n);
  });

  it("pins the ceiling's literal values, including rounding UP", () => {
    expect(applyMaxIn(1_000_000n, 50)).toBe(1_005_000n);
    // 1.0001 wei -> 2: an approval cap is never one wei short.
    expect(applyMaxIn(1n, 1)).toBe(2n);
    // No slippage must not inflate an exact amount.
    expect(applyMaxIn(1n, 0)).toBe(1n);
    expect(applyMaxIn(1_000_000n, 0)).toBe(1_000_000n);
    expect(applyMaxIn(0n, 50)).toBe(0n);
  });

  it("bounds always sit on the safe side of the quote", () => {
    for (const [amount, bps] of CASES) {
      expect(applyMinOut(amount, bps) <= amount, `floor <= quote at bps=${bps}`).toBe(true);
      expect(applyMaxIn(amount, bps) >= amount, `ceiling >= quote at bps=${bps}`).toBe(true);
    }
  });
});

/** Every `.ts` file under `dir`, recursively. */
function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** The acceptance criterion's shape regex: both spellings, both operators. */
const SHAPE = /10_?000 *[-+]/;

type Hit = { file: string; line: number; text: string };

function scanShape(dirs: readonly string[]): Hit[] {
  const hits: Hit[] = [];
  for (const dir of dirs) {
    for (const file of tsFiles(join(REPO_ROOT, dir))) {
      const lines = readFileSync(file, "utf8").split("\n");
      lines.forEach((text, i) => {
        if (SHAPE.test(text)) {
          hits.push({ file: relative(REPO_ROOT, file), line: i + 1, text: text.trim() });
        }
      });
    }
  }
  return hits;
}

const SCANNED_DIRS = [
  "src/modules/shared",
  "src/modules/swap",
  "src/modules/uniswap-swap",
  "src/modules/curve",
  // Beyond the issue's enumeration: SunSwap V2 carried a 5th copy of the
  // exact-IN floor. Scanned so it cannot regrow one either.
  "src/modules/tron",
];

/** Files whose slippage bounds must come from the shared helper, not inline math. */
const CALL_SITES = [
  "src/modules/uniswap-swap/index.ts",
  "src/modules/curve/actions.ts",
  "src/modules/swap/index.ts",
  "src/modules/tron/sunswap-swap.ts",
];

describe("#715 — exactly one implementation of each slippage formula", () => {
  const hits = scanShape(SCANNED_DIRS);

  it("the scan is live: it matches the shared helper's own two definitions", () => {
    const inHelper = hits.filter((h) => h.file === SHARED_HELPER);
    expect(inHelper).toHaveLength(2);
    expect(inHelper.some((h) => /BigInt\(10_000 - slippageBps\)/.test(h.text))).toBe(true);
    expect(inHelper.some((h) => /BigInt\(10_000 \+ slippageBps\)/.test(h.text))).toBe(true);
  });

  it("no third hit anywhere in the scanned modules", () => {
    const strays = hits.filter((h) => h.file !== SHARED_HELPER);
    expect(
      strays.map((h) => `${h.file}:${h.line}: ${h.text}`),
      "min-out/max-in arithmetic must live only in src/modules/shared/slippage.ts",
    ).toEqual([]);
    expect(hits).toHaveLength(2);
  });

  it("every call site imports the shared helper", () => {
    for (const relPath of CALL_SITES) {
      const src = readFileSync(join(REPO_ROOT, relPath), "utf8");
      expect(src, `${relPath} must import from ../shared/slippage.js`).toMatch(
        /from "\.\.\/shared\/slippage\.js"/,
      );
    }
  });
});
