/**
 * Issue #790 — pin the `acknowledgedNonProtocolTarget` stamp-writer set BY
 * IDENTITY (follow-on to #786 / #789, pre-sign block `4b`).
 *
 * Block 4b (`src/signing/pre-sign-check.ts`) refuses any STAMPED transaction
 * to the LiFi Diamond. Its soundness rests on one invariant:
 *
 *     only `prepare_custom_call` both STAMPS `acknowledgedNonProtocolTarget`
 *     AND can target the LiFi Diamond
 *
 * — true today because the flag has exactly three server writers, and the two
 * Curve builders can only target factory-validated Curve pools, never the
 * Diamond. That invariant lives in a PR/source COMMENT. If a FUTURE stamp
 * writer is added that legitimately targets the Diamond, 4b silently
 * OVER-BLOCKS it (a false refuse — availability, not a drain), and nothing
 * mechanical forces anyone to notice.
 *
 * RELATION TO THE EXISTING #757 U1 GUARD
 * `test/757-recipient-authorization.test.ts` already pins the writer COUNT at
 * three with a line-oriented regex. This file is the identity half #790 asks
 * for, and is deliberately kept separate rather than folded into #757's guard:
 *   - it pins WHICH sites stamp (file + enclosing function + stamped value),
 *     so a count-preserving relocation — one writer deleted, a different one
 *     added elsewhere — goes RED where a count check stays green;
 *   - it reads the TypeScript AST rather than raw lines, so a `//` comment or
 *     a string literal that happens to look like an assignment can neither
 *     false-positive nor mask a real site;
 *   - its failure message names block 4b, so whoever trips it is pointed at
 *     the decision they actually owe.
 *
 * BOUNDS (documented, same spirit as `test/support/sink-reachability.ts`):
 * writes are matched syntactically — object-literal property assignment,
 * shorthand property, and assignment (`=`, `??=`, `||=`, `&&=`) to a
 * property/element access named the flag. A write performed reflectively
 * (`Object.assign`, a computed key held in a variable, a spread of an object
 * built elsewhere) is NOT detected. Those forms appear nowhere in `src/`
 * today; the liveness fixture below proves the detector fires on every form
 * that does.
 */
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import ts from "typescript";

const FLAG = "acknowledgedNonProtocolTarget";

/** A discovered site that SETS the flag (not one that reads or declares it). */
type StampWriter = {
  /** Path relative to `src/`, e.g. `modules/curve/actions.ts`. */
  file: string;
  /** Enclosing function name (`<module>` for a top-level site). */
  fn: string;
  /** Source text of the stamped value, e.g. `true`. */
  value: string;
  /** 1-based line, for the failure message only — NOT part of the pinned key. */
  line: number;
};

/** Stable identity of a writer. Deliberately excludes the line number: an
 *  unrelated edit above a site must not turn this guard red. */
const keyOf = (w: StampWriter) => `${w.file} :: ${w.fn} = ${w.value}`;

/**
 * THE PIN. Exactly these sites may stamp `acknowledgedNonProtocolTarget`.
 *
 * Adding, moving or removing a stamp writer makes this list wrong ON PURPOSE.
 * Before you update it, answer block 4b's question for the new writer:
 * CAN IT TARGET THE LIFI DIAMOND? If it can, block 4b
 * (`src/signing/pre-sign-check.ts`, "4b) LiFi Diamond stamped-partition
 * refusal") will refuse it — the stamp no longer partitions rogue
 * `prepare_custom_call` from legitimate traffic, and 4b needs a narrower
 * discriminator, not a widened ack.
 */
const PINNED_STAMP_WRITERS = [
  // prepare_custom_call — the ack-gated arbitrary-call path. STAMPED and able
  // to name any destination, so 4b's refusal is aimed exactly here.
  "modules/execution/index.ts :: prepareCustomCall = true",
  // Curve builders — destinations are validated against the stable_ng FACTORY
  // (get_n_coins > 0), so they can only ever be Curve pools, never the Diamond.
  "modules/curve/actions.ts :: buildCurveAddLiquidity = true",
  "modules/curve/actions.ts :: buildCurveSwap = true",
].sort();

const SRC_DIR = new URL("../src/", import.meta.url).pathname;

function tsFilesUnderSrc(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = `${dir}${e.name}`;
      if (e.isDirectory()) walk(`${p}/`);
      else if (e.name.endsWith(".ts")) out.push(p);
    }
  };
  walk(SRC_DIR);
  return out;
}

/** Assignment operators that WRITE the left-hand side. */
const ASSIGN_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
]);

/**
 * Parse one module and return every site that SETS the flag. Exported shape is
 * pure (fileName + text in, writers out) so the liveness fixture below can
 * exercise it on a synthetic module.
 */
function collectStampWriters(file: string, text: string): StampWriter[] {
  // Cheap pre-filter: a write site must mention the identifier literally.
  if (!text.includes(FLAG)) return [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ true);
  const found: StampWriter[] = [];

  const nameIsFlag = (n: ts.PropertyName): boolean =>
    (ts.isIdentifier(n) || ts.isStringLiteral(n)) && n.text === FLAG;

  const targetsFlag = (e: ts.Expression): boolean => {
    if (ts.isPropertyAccessExpression(e)) return e.name.text === FLAG;
    if (ts.isElementAccessExpression(e)) {
      const a = e.argumentExpression;
      return (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) && a.text === FLAG;
    }
    return false;
  };

  const enclosingFn = (node: ts.Node): string => {
    for (let n: ts.Node | undefined = node.parent; n; n = n.parent) {
      if (ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n)) {
        return n.name ? n.name.getText(sf) : "<anonymous>";
      }
      if (ts.isFunctionExpression(n) || ts.isArrowFunction(n)) {
        const p = n.parent;
        if (p && ts.isVariableDeclaration(p)) return p.name.getText(sf);
        if (p && ts.isPropertyAssignment(p)) return p.name.getText(sf);
        return n.name ? n.name.getText(sf) : "<anonymous>";
      }
    }
    return "<module>";
  };

  const record = (node: ts.Node, value: string) => {
    found.push({
      file,
      fn: enclosingFn(node),
      value,
      line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    });
  };

  const visit = (node: ts.Node) => {
    if (ts.isPropertyAssignment(node) && nameIsFlag(node.name)) {
      record(node, node.initializer.getText(sf));
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === FLAG) {
      record(node, "<shorthand>");
    } else if (
      ts.isBinaryExpression(node) &&
      ASSIGN_OPS.has(node.operatorToken.kind) &&
      targetsFlag(node.left)
    ) {
      record(node, node.right.getText(sf));
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sf, visit);
  return found;
}

const srcFiles = tsFilesUnderSrc();
const writers = srcFiles.flatMap((abs) =>
  collectStampWriters(abs.slice(SRC_DIR.length), readFileSync(abs, "utf8")),
);
const detail = writers
  .map((w) => `  ${w.file}:${w.line}  ${w.fn}()  ->  ${FLAG} = ${w.value}`)
  .join("\n");

describe("issue #790 — the acknowledgedNonProtocolTarget stamp-writer set is pinned by identity", () => {
  it("walks a non-trivial src/ tree and finds the flag at all (not vacuous)", () => {
    // If the walk or the pre-filter silently breaks, the pin below passes on an
    // empty set. Anchor both halves to the real surface (~318 .ts files today).
    expect(srcFiles.length).toBeGreaterThan(250);
    expect(
      srcFiles.filter((f) => readFileSync(f, "utf8").includes(FLAG)).length,
    ).toBeGreaterThan(0);
  });

  it("detects every syntactic write form and no read/declaration (detector liveness)", () => {
    // A synthetic module exercising each supported form plus the shapes that
    // MUST NOT count: a read, an interface field, and a comment.
    const fixture = [
      `interface T { ${FLAG}?: boolean }`,
      `export function readsOnly(tx: T) {`,
      `  // ${FLAG}: true — a comment, not a write`,
      `  return tx.${FLAG} === true;`,
      `}`,
      `export function objectLiteralWriter(): T {`,
      `  return { ${FLAG}: true };`,
      `}`,
      `export function wrappedWriter(): T {`,
      `  return {`,
      `    ${FLAG}:`,
      `      true,`,
      `  };`,
      `}`,
      `export function assignmentWriter(tx: T) {`,
      `  tx.${FLAG} = true;`,
      `}`,
      `export function elementAccessWriter(tx: T) {`,
      `  tx["${FLAG}"] = true;`,
      `}`,
      `export const arrowWriter = (tx: T) => {`,
      `  tx.${FLAG} = false;`,
      `};`,
    ].join("\n");
    const got = collectStampWriters("fixture.ts", fixture).map(keyOf).sort();
    expect(got).toEqual(
      [
        "fixture.ts :: objectLiteralWriter = true",
        "fixture.ts :: wrappedWriter = true",
        "fixture.ts :: assignmentWriter = true",
        "fixture.ts :: elementAccessWriter = true",
        "fixture.ts :: arrowWriter = false",
      ].sort(),
    );
  });

  it("src/ contains EXACTLY the pinned stamp writers — no more, no fewer, none moved", () => {
    expect(
      writers.map(keyOf).sort(),
      `The set of ${FLAG} stamp writers changed.\n\n` +
        `Discovered:\n${detail || "  (none)"}\n\n` +
        `STOP AND ANSWER THIS BEFORE UPDATING PINNED_STAMP_WRITERS: can the new / moved ` +
        `writer target the LiFi Diamond? Pre-sign block 4b ` +
        `(src/signing/pre-sign-check.ts, "4b) LiFi Diamond stamped-partition refusal", #786) ` +
        `REFUSES every stamped tx to the Diamond on the assumption that prepare_custom_call ` +
        `is the only stamped path that can reach it. A stamp writer that legitimately targets ` +
        `the Diamond would be silently OVER-BLOCKED (false refuse). The fix in that case is a ` +
        `narrower discriminator in 4b — never a widened ack.`,
    ).toEqual(PINNED_STAMP_WRITERS);
  });

  it("block 4b still keys on the stamp (the invariant this pin protects)", () => {
    // Two-way binding: if 4b is removed or re-keyed, this pin's rationale
    // changed and the reviewer should be told, not left with a stale guard.
    const preSign = readFileSync(`${SRC_DIR}signing/pre-sign-check.ts`, "utf8");
    expect(
      /dest\.kind\s*===\s*"lifi-diamond"\s*&&\s*tx\.acknowledgedNonProtocolTarget\s*===\s*true/.test(
        preSign,
      ),
      `Pre-sign block 4b's stamped-LiFi refusal was not found in src/signing/pre-sign-check.ts. ` +
        `If 4b was intentionally reworked, revisit issue #790's rationale for pinning the ` +
        `stamp-writer set (and update this anchor); if it was dropped, the #786 drain is open.`,
    ).toBe(true);
  });
});
