import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Structural falsifier for the `types/index.ts` decomposition (ARCHITECTURE
 * §5.4, issue #717). `index.ts` (1871L / 59 exports, no internal boundary)
 * was split across ten stacked PRs into seven domain files; this test is
 * the acceptance criterion transcribed on #717:
 *
 *   Types split by named domain — chain consts, position shapes, tx
 *   shapes, device entries, config each own a file; a structural test
 *   asserts types/index.ts (if kept) is a re-export barrel with no domain
 *   type defined inline.
 *
 * Interfaces and type aliases erase at compile time, so this can't check
 * the compiled module's own runtime exports the way
 * test/execution-decomposition.test.ts does for functions — there is
 * nothing left at runtime to inspect. It reads the .ts SOURCE TEXT
 * directly instead and pattern-matches top-level `export` declarations,
 * which is the only place a type's name still exists.
 *
 * Per the §5 preamble this unit also carries a per-module EXPORT-ALLOWLIST:
 * each domain file must export EXACTLY its assigned #717 surface, no more.
 */

const here = fileURLToPath(import.meta.url);
const typesDir = join(here, "..", "..", "src", "types");

function read(file: string): string {
  return readFileSync(join(typesDir, file), "utf8");
}

/** Strips /* ... *\/ block-comment spans (non-greedy, multiline) before line-scanning,
 * so a JSDoc header or commented-out code can't be mistaken for live source. */
function stripBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "");
}

/**
 * Every top-level exported declaration name in a file's source text (block comments
 * stripped first, per stripBlockComments above). Covers interface|type|const|function|
 * enum|class plus declare/namespace/abstract class/async function/let/var, and treats
 * `const enum` as one keyword so its name isn't misread as the literal word "enum".
 */
function declaredNames(src: string): string[] {
  const names: string[] = [];
  const re =
    /^export (?:declare )?(?:abstract )?(?:async )?(?:const enum|interface|type|const|function|enum|class|namespace|let|var) (\w+)/gm;
  let m: RegExpExecArray | null;
  const stripped = stripBlockComments(src);
  while ((m = re.exec(stripped))) names.push(m[1]);
  return names.sort();
}

const CHAINS = [
  "SupportedChain",
  "SUPPORTED_CHAINS",
  "SupportedNonEvmChain",
  "SUPPORTED_NON_EVM_CHAINS",
  "AnyChain",
  "ALL_CHAINS",
  "isEvmChain",
  "RpcProvider",
  "CHAIN_IDS",
  "CHAIN_ID_TO_NAME",
  "TRON_CHAIN_ID",
].sort();

const POSITIONS = [
  "TokenAmount",
  "CurvePosition",
  "LendingPosition",
  "CompoundLendingPosition",
  "MorphoLendingPosition",
  "LendingPositionUnion",
  "LPPosition",
  "StakingPosition",
].sort();

const PORTFOLIO = [
  "CoverageStatus",
  "PortfolioCoverage",
  "UnpricedAsset",
  "SolanaBalance",
  "SolanaPortfolioSlice",
  "SolanaStakingPositionSlice",
  "SolanaMarginfiPositionSlice",
  "SolanaKaminoPositionSlice",
  "TronBalance",
  "TronPortfolioSlice",
  "TronFrozenEntry",
  "TronPendingUnfreeze",
  "TronClaimableReward",
  "TronResourceMeter",
  "TronAccountResources",
  "TronStakingSlice",
  "TronWitnessInfo",
  "TronVoteAllocation",
  "TronWitnessList",
  "BitcoinPortfolioSlice",
  "LitecoinPortfolioSlice",
  "PortfolioSummary",
  "MultiWalletPortfolioSummary",
].sort();

const SECURITY = ["PrivilegedRole", "SecurityReport"].sort();

const TX = [
  "DecodedArg",
  "HumanDecode",
  "TxVerification",
  "UnsignedTronTx",
  "UnsignedSolanaTx",
  "UnsignedTx",
  "UnsignedBitcoinTx",
  "UnsignedLitecoinTx",
].sort();

const DEVICES = [
  "PairedSolanaEntry",
  "PairedTronEntry",
  "PairedBitcoinEntry",
  "PairedBitcoinMultisigCosigner",
  "PairedBitcoinMultisigWallet",
  "PairedLitecoinEntry",
].sort();

const CONFIG = ["UserConfig"].sort();

/** The #717 split plan's seven domain files, each with its EXPORT-ALLOWLIST. */
const DOMAIN_ALLOWLISTS: Record<string, string[]> = {
  "chains.ts": CHAINS,
  "positions.ts": POSITIONS,
  "portfolio.ts": PORTFOLIO,
  "security.ts": SECURITY,
  "tx.ts": TX,
  "devices.ts": DEVICES,
  "config.ts": CONFIG,
};

describe("types/index.ts decomposition (#717, ARCHITECTURE §5.4)", () => {
  it("sanity: the allowlists cover exactly the documented 59 exports (#717 issue body)", () => {
    const total = Object.values(DOMAIN_ALLOWLISTS).reduce((n, l) => n + l.length, 0);
    expect(total).toBe(59);
  });

  it("src/types/ contains exactly the seven domain files plus index.ts — no undeclared file slips the allowlist net", () => {
    // Regression: an unlisted file (e.g. misc.ts) added under src/types/ with its own
    // `export *` line is never iterated by the per-file checks below and would pass
    // silently, widening the barrel's surface outside the #717 split plan.
    const actual = readdirSync(typesDir)
      .filter((f) => f.endsWith(".ts"))
      .sort();
    const expected = [...Object.keys(DOMAIN_ALLOWLISTS), "index.ts"].sort();
    expect(actual).toEqual(expected);
  });

  it("index.ts is a pure re-export barrel — no domain type defined inline", () => {
    const src = read("index.ts");
    expect(declaredNames(src)).toEqual([]);

    const codeLines = stripBlockComments(src)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("//"));
    for (const line of codeLines) {
      expect(line, `unexpected non-barrel line in index.ts: ${line}`).toMatch(
        /^export \* from "\.\/[\w-]+\.js";$/,
      );
    }
  });

  it("index.ts re-exports every domain file (barrel completeness)", () => {
    const src = read("index.ts");
    for (const file of Object.keys(DOMAIN_ALLOWLISTS)) {
      const specifier = `./${file.replace(/\.ts$/, ".js")}`;
      expect(src, `index.ts is missing export * from "${specifier}"`).toContain(
        `export * from "${specifier}";`,
      );
    }
  });

  it("liveness: a domain type re-added to index.ts is detected (proves the barrel check isn't vacuous)", () => {
    const tampered = read("index.ts") + `\nexport interface Bogus717 {\n  x: number;\n}\n`;
    expect(declaredNames(tampered)).toEqual(["Bogus717"]);
  });

  for (const [file, allowlist] of Object.entries(DOMAIN_ALLOWLISTS)) {
    it(`${file} exports EXACTLY its allowlisted #717 surface`, () => {
      expect(declaredNames(read(file))).toEqual(allowlist);
    });
  }

  it("domain files declare, never re-export — no `export *` or `export type { ... }` widening the barrel", () => {
    // Regression: a domain file containing `export * from "./other.js"` or
    // `export type { X } from "./other.js"` satisfies every allowlist-name check above
    // (declaredNames only looks for declarations) while silently widening what that
    // file publicly exposes.
    for (const file of Object.keys(DOMAIN_ALLOWLISTS)) {
      const codeLines = stripBlockComments(read(file))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 0 && !l.startsWith("//"));
      for (const line of codeLines) {
        expect(line, `${file} re-exports instead of declaring: ${line}`).not.toMatch(
          /^export (type )?(\*|\{)/,
        );
      }
    }
  });

  it("no file under src/types/ imports its own barrel (./index.js) — no reintroduced cycle", () => {
    const files = readdirSync(typesDir).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((f) =>
      /from\s+["']\.\/index\.js["']/.test(stripBlockComments(read(f))),
    );
    expect(
      offenders,
      `files under src/types/ importing ./index.js (would reintroduce a barrel cycle): ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
