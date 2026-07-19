/**
 * Issue #772 — Part 2 (structural, recurrence-prevention).
 *
 * The bug's ROOT SHAPE (its 3rd instance after #757 / #764) is a
 * hand-maintained enumeration guarding a fund path, where an omission fails
 * OPEN. This test replaces "trust the list" with a MECHANICAL binding: it
 * walks the function-level call graph of every registered tool (see
 * `test/support/sink-reachability.ts` for the analysis + its documented
 * bounds) and asserts:
 *
 *     any tool whose handler reaches a device-signing / broadcast sink
 *     MUST be CONTAINED in demo mode.
 *
 * CONTAINMENT is stricter than "appears in a gate set". The demo dispatcher
 * (`makeDemoDispatch` in src/index.ts) contains a sink in exactly two ways:
 *   - `isAlwaysGatedTool(name)` → the tool is refused outright; OR
 *   - `isBroadcastTool(name)` (send_transaction) → the real handler is
 *     bypassed and a simulation envelope is returned.
 * Being merely `isConditionallyGatedTool` is NOT containment: every
 * conditionally-gated tool EXCEPT the broadcast tool runs the REAL handler
 * in live demo mode (prepare_* auto-selects the whale persona and executes),
 * so any signing/broadcast sink it reaches fires for real. Encoding that
 * distinction is what makes this check sound rather than security theater.
 *
 * LIVENESS (not vacuous): the analysis is proven to detect the two known
 * escapees and the gated control as sink-reaching. If Part 1's gating is
 * reverted, `sign_btc_multisig_psbt` and `finalize_btc_psbt` are
 * sink-reaching and no longer contained → the main assertion goes RED. That
 * RED-on-revert is what proves the check is live, not a re-worded name list.
 */
import { describe, it, expect } from "vitest";
import { analyzeRegisteredTools } from "./support/sink-reachability.js";
import { isAlwaysGatedTool, isBroadcastTool } from "../src/demo/index.js";

const results = analyzeRegisteredTools();
const byName = new Map(results.map((r) => [r.name, r]));

/** A sink is genuinely unreachable in demo only for these two dispatch outcomes. */
function contained(name: string): boolean {
  return isAlwaysGatedTool(name) || isBroadcastTool(name);
}

/**
 * Sink-reaching tools that are NOT yet contained but are OUT OF SCOPE for
 * #772 (SEC named exactly two). Each is a real demo-mode signing/broadcast
 * hole of the SAME class, quarantined here with a tracking note rather than
 * silently passed. The staleness guard below forces an entry to be removed
 * the moment it becomes contained, so this can never rot into a silent
 * permanent bypass.
 */
const KNOWN_UNCONTAINED_OUT_OF_SCOPE = new Set<string>([
  // prepare_btc_multisig_send is a combined prepare+SIGN tool: its handler
  // calls signBitcoinMultisigPsbt → Ledger `app.signPsbt` (multisig.ts:1043).
  // prepare_* runs the REAL handler in live demo (auto-whale), so a demo
  // user with a Ledger + a registered multisig wallet + UTXOs would get a
  // REAL device signature. Same class as #772; needs its own gating decision
  // (surfaced for follow-up — NOT changed in this PR per its scope).
  "prepare_btc_multisig_send",
]);

describe("issue #772 — structural sink-gating binding", () => {
  it("discovers a non-trivial number of registered tools (sanity)", () => {
    // If registration extraction silently breaks, everything below passes
    // vacuously. Anchor it to the real surface (~189 tools).
    expect(results.length).toBeGreaterThan(150);
  });

  it("mechanically detects the two known escapees as sink-reaching (liveness)", () => {
    const sign = byName.get("sign_btc_multisig_psbt");
    const fin = byName.get("finalize_btc_psbt");
    expect(sign?.sinkReaching, `sign_btc_multisig_psbt path: ${JSON.stringify(sign?.sinkPath)}`).toBe(true);
    expect(fin?.sinkReaching, `finalize_btc_psbt path: ${JSON.stringify(fin?.sinkPath)}`).toBe(true);
  });

  it("mechanically detects the broadcast control (send_transaction) as sink-reaching", () => {
    const send = byName.get("send_transaction");
    expect(send?.sinkReaching, `send_transaction path: ${JSON.stringify(send?.sinkPath)}`).toBe(true);
  });

  it("does NOT flag a pure local-artifact neighbour (combine_btc_psbts) — proves function-granularity", () => {
    // combine_btc_psbts lives in the same file as finalize but calls
    // `combinePsbts` (no broadcast), so module-granularity would false-flag it.
    const combine = byName.get("combine_btc_psbts");
    expect(combine?.sinkReaching).toBe(false);
  });

  it("the two #772 tools are CONTAINED (always-gated), not merely conditionally-gated", () => {
    expect(contained("sign_btc_multisig_psbt")).toBe(true);
    expect(contained("finalize_btc_psbt")).toBe(true);
    expect(isAlwaysGatedTool("sign_btc_multisig_psbt")).toBe(true);
    expect(isAlwaysGatedTool("finalize_btc_psbt")).toBe(true);
  });

  it("every sink-reaching tool is contained in demo mode (the security invariant)", () => {
    const escapees = results
      .filter((r) => r.sinkReaching && !contained(r.name) && !KNOWN_UNCONTAINED_OUT_OF_SCOPE.has(r.name))
      .map((r) => ({ name: r.name, sinkPath: r.sinkPath }));
    expect(
      escapees,
      `Sink-reaching tools NOT contained in demo mode (fail-OPEN — issue #772 class). ` +
        `Contain each by always-gating it (or intercepting its broadcast), then remove ` +
        `from the known-gap list if present:\n${JSON.stringify(escapees, null, 2)}`,
    ).toEqual([]);
  });

  it("known-uncontained allowlist has no stale entries (self-cleaning)", () => {
    for (const name of KNOWN_UNCONTAINED_OUT_OF_SCOPE) {
      const r = byName.get(name);
      expect(r, `${name} is not a registered tool — remove from known-gap list`).toBeDefined();
      expect(
        r?.sinkReaching,
        `${name} is no longer detected as sink-reaching — remove from known-gap list`,
      ).toBe(true);
      expect(
        contained(name),
        `${name} is now CONTAINED — remove it from the known-gap list so the invariant guards it`,
      ).toBe(false);
    }
  });
});
