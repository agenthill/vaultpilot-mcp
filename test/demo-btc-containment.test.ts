/**
 * Issue #772 — Part 1 (behavioral falsifier).
 *
 * Demo mode's contract is that NOTHING real happens. Three BTC tools
 * reached a real signing / broadcast sink under `isDemoMode()`:
 *
 *   - `sign_btc_multisig_psbt` → `app.signPsbt(...)` (real Ledger signature)
 *   - `finalize_btc_psbt({ broadcast: true })` → `indexer.broadcastTx(...)`
 *     (real mainnet broadcast)
 *   - `prepare_btc_multisig_send` → `signBitcoinMultisigPsbt` → `app.signPsbt(...)`
 *     (real Ledger signature — a combined prepare+SIGN tool; the 3rd
 *     sink-reacher, surfaced by Part 2's structural check)
 *
 * The first two matched neither demo gate list (dispatcher fell through);
 * the third matched only the CONDITIONAL `prepare_*` gate, which runs the
 * real handler in live demo. All three are now ALWAYS-gated (fail-closed).
 *
 * These tests drive the EXACT production dispatch decision via the
 * extracted `makeDemoDispatch` factory, wiring a spy in place of the real
 * handler. The real handler is the sole code path that reaches the sink;
 * proving the gate never invokes it in demo mode proves the sink is
 * unreachable.
 *
 * RED before the fix: both tools matched neither gate, so `dispatch` fell
 * through to `realHandler` and the spy WAS called (the two "does not reach"
 * expectations fail). GREEN after: both are always-gated, so the spy is
 * never called. The "positive control" (demo OFF) proves the spy is wired
 * to a live path, so a GREEN "not called" is real containment, not a dead
 * test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

async function resetLatch() {
  const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
  _resetAutoDemoLatchForTests();
}

describe("issue #772 — demo mode never reaches the BTC signing / broadcast sinks", () => {
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

  it("classifier: all three BTC signing/broadcast tools are always-gated (fail-closed)", async () => {
    const { isAlwaysGatedTool } = await import("../src/demo/index.js");
    expect(isAlwaysGatedTool("sign_btc_multisig_psbt")).toBe(true);
    expect(isAlwaysGatedTool("finalize_btc_psbt")).toBe(true);
    // prepare_btc_multisig_send is the 3rd sink-reacher: a combined prepare+SIGN
    // tool that reaches `app.signPsbt` unconditionally. Gated explicitly even
    // though `prepare_*` is the conditional-gate prefix — the always-gate check
    // runs first in the dispatcher, so this refuses fail-closed in demo.
    expect(isAlwaysGatedTool("prepare_btc_multisig_send")).toBe(true);
    // The broadened `sign_` prefix still covers the pre-existing family.
    expect(isAlwaysGatedTool("sign_message_btc")).toBe(true);
    expect(isAlwaysGatedTool("sign_message_ltc")).toBe(true);
    // And does not over-reach into read tools or inspection-only prepare_* tools.
    expect(isAlwaysGatedTool("get_btc_multisig_balance")).toBe(false);
    expect(isAlwaysGatedTool("combine_btc_psbts")).toBe(false);
    expect(isAlwaysGatedTool("prepare_native_send")).toBe(false);
  });

  it("demo mode: sign_btc_multisig_psbt dispatch never invokes the real handler (no app.signPsbt)", async () => {
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");
    const { isDemoMode } = await import("../src/demo/index.js");
    expect(isDemoMode()).toBe(true);

    const realHandler = vi.fn(async () => ({ content: [{ type: "text", text: "SIGNED" }] }));
    const dispatch = makeDemoDispatch("sign_btc_multisig_psbt", realHandler);
    const res = await dispatch({ walletName: "w", psbtBase64: "cHNidP8=" });

    expect(realHandler).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toContain("VAULTPILOT_DEMO");
  });

  it("demo mode: finalize_btc_psbt({broadcast:true}) dispatch never invokes the real handler (no indexer.broadcastTx)", async () => {
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");

    const realHandler = vi.fn(async () => ({ content: [{ type: "text", text: "BROADCAST" }] }));
    const dispatch = makeDemoDispatch("finalize_btc_psbt", realHandler);
    const res = await dispatch({ psbtBase64: "cHNidP8=", broadcast: true });

    expect(realHandler).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toContain("VAULTPILOT_DEMO");
  });

  it("demo mode: prepare_btc_multisig_send dispatch never invokes the real handler (no app.signPsbt)", async () => {
    // The 3rd sink-reacher: a combined prepare+SIGN tool whose real handler
    // calls signBitcoinMultisigPsbt → app.signPsbt UNCONDITIONALLY. Because
    // `prepare_*` is only CONDITIONALLY gated, live demo would auto-whale and
    // run the real handler — a REAL Ledger signature. Always-gating it (checked
    // before the conditional branch) must intercept before the handler runs.
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");
    const { isDemoMode } = await import("../src/demo/index.js");
    expect(isDemoMode()).toBe(true);

    const realHandler = vi.fn(async () => ({ content: [{ type: "text", text: "SIGNED" }] }));
    const dispatch = makeDemoDispatch("prepare_btc_multisig_send", realHandler);
    const res = await dispatch({ walletName: "w", to: "bc1qexample", amountSats: 1000 });

    expect(realHandler).not.toHaveBeenCalled();
    expect(JSON.stringify(res)).toContain("VAULTPILOT_DEMO");
  });

  it("live demo (persona set) still refuses all three — always-gated ignores sub-mode", async () => {
    process.env[ENV_KEY] = "true";
    const { makeDemoDispatch } = await import("../src/index.js");
    const { setLivePersona } = await import("../src/demo/index.js");
    setLivePersona("whale");

    const signSpy = vi.fn(async () => ({ content: [] }));
    const finalizeSpy = vi.fn(async () => ({ content: [] }));
    // prepare_* normally runs the REAL handler in live demo (auto-whale); the
    // always-gate must override that for this signing prepare_ tool too.
    const prepareSpy = vi.fn(async () => ({ content: [] }));
    await makeDemoDispatch("sign_btc_multisig_psbt", signSpy)({ walletName: "w", psbtBase64: "cHNidP8=" });
    await makeDemoDispatch("finalize_btc_psbt", finalizeSpy)({ psbtBase64: "cHNidP8=", broadcast: true });
    await makeDemoDispatch("prepare_btc_multisig_send", prepareSpy)({ walletName: "w", to: "bc1qexample", amountSats: 1000 });

    expect(signSpy).not.toHaveBeenCalled();
    expect(finalizeSpy).not.toHaveBeenCalled();
    expect(prepareSpy).not.toHaveBeenCalled();
  });

  it("positive control: with demo OFF the same dispatch passes through to the real handler", async () => {
    delete process.env[ENV_KEY];
    const { makeDemoDispatch } = await import("../src/index.js");
    const { isDemoMode } = await import("../src/demo/index.js");
    expect(isDemoMode()).toBe(false);

    const signHandler = vi.fn(async () => ({ content: [] }));
    const finalizeHandler = vi.fn(async () => ({ content: [] }));
    const prepareHandler = vi.fn(async () => ({ content: [] }));
    await makeDemoDispatch("sign_btc_multisig_psbt", signHandler)({ walletName: "w", psbtBase64: "cHNidP8=" });
    await makeDemoDispatch("finalize_btc_psbt", finalizeHandler)({ psbtBase64: "cHNidP8=", broadcast: true });
    await makeDemoDispatch("prepare_btc_multisig_send", prepareHandler)({ walletName: "w", to: "bc1qexample", amountSats: 1000 });

    // Absent the demo gate the handler (the sink-bearing path) IS reached —
    // this is exactly the fall-through the demo gate must intercept.
    expect(signHandler).toHaveBeenCalledOnce();
    expect(finalizeHandler).toHaveBeenCalledOnce();
    expect(prepareHandler).toHaveBeenCalledOnce();
  });
});
