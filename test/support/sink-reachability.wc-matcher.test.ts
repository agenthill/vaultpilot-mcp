/**
 * Issue #778 — positive liveness for the WalletConnect `eth_sendTransaction`
 * sink detector inside `bodyHasSink` (test/support/sink-reachability.ts).
 *
 * Every OTHER sink `bodyHasSink` matches (`.broadcastTx`, `.signPsbt`,
 * `.signPsbtBuffer`, `.signTransaction`, `broadcastSolanaTx`,
 * `broadcastTronTx`) gets exercised end-to-end today, because
 * `demo-sink-gating.structural.test.ts` runs `analyzeRegisteredTools()`
 * against the REAL `src/index.ts` call graph and at least one real tool's
 * handler reaches each of those sinks. The WC `method: "eth_sendTransaction"`
 * call-literal matcher has no such tool: `send_transaction`'s call graph
 * reaches the TRON `broadcastTronTx` sink first, and `reachesSinkFromNode`'s
 * DFS short-circuits on the first sink found (`bodyHasSink` returns as soon
 * as ANY sink matches — see sink-reachability.ts `bodyHasSink`/
 * `reachesSinkFromNode`), so the WC branch has never actually fired against
 * real code. It is an unverified matcher a future EVM-only broadcast tool
 * would silently depend on.
 *
 * This test drives `bodyHasSink` directly against a SYNTHETIC parsed AST —
 * independent of `src/index.ts`, `registerTool` extraction, or which tool
 * resolves to which sink first — so the branch gets its own positive
 * liveness proof. A regression that breaks the WC matcher (wrong property
 * name, wrong literal value, only checking bare-identifier callees, only
 * checking the first object-literal argument, etc.) goes RED here
 * regardless of what any real tool's call graph does.
 *
 * Non-vacuity (matches the discipline of the existing liveness assertions
 * in demo-sink-gating.structural.test.ts, e.g. the combine_btc_psbts
 * "does NOT flag" control): alongside the two firing cases, this file
 * asserts shape-identical NEGATIVE cases that must NOT fire, so a stub that
 * always returns `true` (or a check that matches on call shape alone,
 * ignoring the literal value) would also go RED.
 */
import ts from "typescript";
import { describe, it, expect } from "vitest";
import { bodyHasSink } from "./sink-reachability.js";

/** Parse a source snippet and return its single top-level function declaration node. */
function firstFunction(source: string): ts.Node {
  const sf = ts.createSourceFile("synthetic-wc-778.ts", source, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const fn = sf.statements[0];
  if (!fn || !ts.isFunctionDeclaration(fn)) {
    throw new Error("test fixture must be a single top-level function declaration");
  }
  return fn;
}

describe("issue #778 — WC eth_sendTransaction matcher (positive liveness, synthetic)", () => {
  it('fires on a synthetic call carrying { method: "eth_sendTransaction" } (identifier property name)', () => {
    const fn = firstFunction(`
      function relayViaWalletConnect(client, tx) {
        return client.request({
          method: "eth_sendTransaction",
          params: [tx],
        });
      }
    `);
    expect(bodyHasSink(fn)).toBe(true);
  });

  it('also fires with a string-literal property name ("method": …)', () => {
    const fn = firstFunction(`
      function relayViaWalletConnect(client, tx) {
        return client.request({
          "method": "eth_sendTransaction",
          params: [tx],
        });
      }
    `);
    expect(bodyHasSink(fn)).toBe(true);
  });

  it("does NOT fire on a shape-identical call with a different method literal (non-vacuity control)", () => {
    const fn = firstFunction(`
      function relayViaWalletConnect(client, tx) {
        return client.request({
          method: "eth_call",
          params: [tx],
        });
      }
    `);
    expect(bodyHasSink(fn)).toBe(false);
  });

  it("does NOT fire on an unrelated call with no method-literal object argument (non-vacuity control)", () => {
    const fn = firstFunction(`
      function doSomethingHarmless(x) {
        return helper(x, 42);
      }
    `);
    expect(bodyHasSink(fn)).toBe(false);
  });
});
