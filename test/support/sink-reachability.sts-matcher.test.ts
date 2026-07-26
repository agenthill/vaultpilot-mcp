/**
 * Issue #775 — positive liveness for the Safe Transaction Service sink names
 * added to `PROP_SINKS` in test/support/sink-reachability.ts.
 *
 * `proposeTransaction` and `confirmTransaction` are both called inside the
 * SAME function (`submitSafeTxSignature`), and `bodyHasSink` returns as soon
 * as ANY sink matches — so the real-code path only ever exercises whichever
 * appears first (`proposeTransaction`). `confirmTransaction` would be an
 * unverified matcher that a future confirm-only tool silently depends on:
 * exactly the #778 shape. This test drives `bodyHasSink` against a SYNTHETIC
 * parsed AST so each name gets its own positive liveness proof, independent
 * of `src/index.ts` or which tool resolves to which sink first.
 *
 * Non-vacuity (mirroring test/support/sink-reachability.wc-matcher.test.ts):
 * shape-identical NEGATIVE cases assert that a stub always returning `true`,
 * or a check that matches on call shape rather than the method name, would
 * also go RED here.
 */
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { bodyHasSink } from "./sink-reachability.js";

/** Parse a source snippet and return its single top-level function declaration node. */
function firstFunction(source: string): ts.Node {
  const sf = ts.createSourceFile("synthetic-sts-775.ts", source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const fn = sf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn)) {
    throw new Error("test fixture must be a single top-level function declaration");
  }
  return fn;
}

describe("issue #775 — Safe Tx Service sink matcher (positive liveness, synthetic)", () => {
  it("fires on `kit.proposeTransaction(...)`", () => {
    const fn = firstFunction(`
      function postToSafeService(kit, body) {
        return kit.proposeTransaction(body);
      }
    `);
    expect(bodyHasSink(fn)).toBe(true);
  });

  it("fires on `kit.confirmTransaction(...)` — the name the real-code DFS short-circuits past", () => {
    const fn = firstFunction(`
      function postToSafeService(kit, safeTxHash, signature) {
        return kit.confirmTransaction(safeTxHash, signature);
      }
    `);
    expect(bodyHasSink(fn)).toBe(true);
  });

  it("fires when the call is nested inside a callback (the real wrapper shape)", () => {
    // The production call sites sit inside `enrichSafeServiceError(() => kit.…)`;
    // `bodyHasSink` must descend into the arrow function, not just the top level.
    const fn = firstFunction(`
      function postToSafeService(kit, safeTxHash, signature) {
        return wrapErrors(() => kit.confirmTransaction(safeTxHash, signature), { op: "confirm" });
      }
    `);
    expect(bodyHasSink(fn)).toBe(true);
  });

  it("does NOT fire on a shape-identical call with a different method name (non-vacuity control)", () => {
    const fn = firstFunction(`
      function readSafeQueue(kit, safeAddress) {
        return kit.getPendingTransactions(safeAddress);
      }
    `);
    expect(bodyHasSink(fn)).toBe(false);
  });

  it("does NOT fire on the sink names used as plain string literals (non-vacuity control)", () => {
    // src/modules/safe/actions.ts carries `{ op: "proposeTransaction" }`
    // diagnostic context objects; those are data, not call sites.
    const fn = firstFunction(`
      function describeOp() {
        return label({ op: "proposeTransaction" }, { op: "confirmTransaction" });
      }
    `);
    expect(bodyHasSink(fn)).toBe(false);
  });
});
