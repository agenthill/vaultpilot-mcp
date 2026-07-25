/**
 * Issue #775 — behavioral falsifier for the off-chain-write sink class.
 *
 * `submit_safe_tx_signature` POSTs to the real Safe Transaction Service
 * (`kit.proposeTransaction` / `kit.confirmTransaction` in
 * src/modules/safe/actions.ts) once its on-chain
 * `approvedHashes(signer, safeTxHash) != 0` precondition holds. That is a
 * REAL network write producing off-chain state — a pending Safe multisig tx
 * gains a signature, visible to every co-signer — while the user believes
 * demo mode means nothing real happens.
 *
 * REACHABILITY (issue #775 step 1): #772 gated the device-signing tools, but
 * this tool does not consume a device signature — it derives an
 * approved-hash sender signature from the signer address and only requires
 * that the `approveHash` approval already exists ON CHAIN. That approval can
 * predate demo mode, or come from the Safe Web UI / a co-signer entirely
 * outside this server, so #772's gates do NOT make this unreachable.
 *
 * These tests drive the EXACT production dispatch decision via the extracted
 * `makeDemoDispatch` factory (same pattern as
 * test/demo-btc-containment.test.ts), wiring a spy in place of the real
 * handler. The real handler is the sole path that reaches the STS POST;
 * proving the gate never invokes it in demo mode proves the sink is
 * unreachable.
 *
 * RED before the fix: `submit_safe_tx_signature` matched NEITHER gate list
 * (not `sign_`/`pair_ledger_`/`prepare_`-prefixed, absent from both explicit
 * sets), so `makeDemoDispatch` fell through to `realHandler` and the spy WAS
 * called. GREEN after: it is always-gated, so the spy is never called. The
 * "positive control" (demo OFF) proves the spy is wired to a live path, so a
 * GREEN "not called" is real containment, not a dead test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

/** Valid-shaped args for `submitSafeTxSignatureInput` (never validated on this path). */
const ARGS = {
  signer: "0x1111111111111111111111111111111111111111",
  safeAddress: "0x2222222222222222222222222222222222222222",
  chain: "ethereum",
  safeTxHash: "0x" + "ab".repeat(32),
};

async function resetLatch() {
  const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
  _resetAutoDemoLatchForTests();
}

describe("issue #775 — demo mode never reaches the Safe Transaction Service POST", () => {
  let savedEnv: string | undefined;

  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    await resetLatch();
    const { clearLiveWallet } = await import("../src/demo/index.js");
    clearLiveWallet();
  });
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    await resetLatch();
    const { clearLiveWallet } = await import("../src/demo/index.js");
    clearLiveWallet();
  });

  it("classifier: submit_safe_tx_signature is always-gated (fail-closed)", async () => {
    const { isAlwaysGatedTool, isConditionallyGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("submit_safe_tx_signature")).toBe(true);
    // It must be ALWAYS-gated, not merely conditionally gated: every
    // conditionally-gated tool except the broadcast tool runs the REAL
    // handler in live demo mode.
    expect(isConditionallyGatedTool("submit_safe_tx_signature")).toBe(false);
    // And the gate must not over-reach into the neighbouring read-only /
    // inspection-only Safe tools.
    expect(isAlwaysGatedTool("get_safe_positions")).toBe(false);
    expect(isAlwaysGatedTool("prepare_safe_tx_execute")).toBe(false);
  });

  it("demo mode: dispatch never invokes the real handler (no STS propose/confirm POST)", async () => {
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");
    const { isDemoMode } = await import("../src/demo/index.js");
    expect(isDemoMode()).toBe(true);

    const realHandler = vi.fn(async () => ({ content: [{ type: "text", text: "POSTED" }] }));
    const dispatch = makeDemoDispatch("submit_safe_tx_signature", realHandler);
    const res = await dispatch(ARGS);

    expect(realHandler).not.toHaveBeenCalled();
    // Structured refusal, not a silent no-op.
    expect(JSON.stringify(res)).toContain("VAULTPILOT_DEMO");
  });

  it("live demo (persona set) still refuses — always-gated ignores the sub-mode", async () => {
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");
    const { setLivePersona } = await import("../src/demo/index.js");
    setLivePersona("whale");

    const realHandler = vi.fn(async () => ({ content: [] }));
    const res = await makeDemoDispatch("submit_safe_tx_signature", realHandler)(ARGS);

    expect(realHandler).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toContain("VAULTPILOT_DEMO");
  });

  it("positive control: with demo OFF the same dispatch passes through to the real handler", async () => {
    delete process.env[ENV_KEY];
    const { makeDemoDispatch } = await import("../src/index.js");
    const { isDemoMode } = await import("../src/demo/index.js");
    expect(isDemoMode()).toBe(false);

    const realHandler = vi.fn(async () => ({ content: [] }));
    await makeDemoDispatch("submit_safe_tx_signature", realHandler)(ARGS);

    // Absent the demo gate the handler (the STS-POST-bearing path) IS
    // reached — exactly the fall-through the demo gate must intercept.
    expect(realHandler).toHaveBeenCalledOnce();
  });
});
