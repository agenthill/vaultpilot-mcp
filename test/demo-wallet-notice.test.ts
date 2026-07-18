/**
 * Demo-mode onboarding notice — rendering + dedup behavior.
 *
 * Two paths into demo mode (auto-fresh-install OR explicit-env), so
 * the notice fires under either reason. The notice copy varies by
 * reason so the leave path matches how demo got activated. Trigger
 * logic itself (env state + latched auto-detect) is exhaustively
 * covered in test/auto-demo.test.ts; here we just assert the notice
 * helper uses that machinery correctly.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";

const ENV_KEY = "VAULTPILOT_DEMO";

describe("demo-mode onboarding notice", () => {
  let savedEnv: string | undefined;

  // Deliberately narrow: only the two `src/demo/*` modules here. They
  // don't transitively pull `src/index.js` (the full server graph —
  // every prepare_* tool, every chain SDK), so this hook stays fast
  // regardless of local machine load. `_resetMissingDemoWalletDedup`
  // lives in `src/index.js`; each `it()` below already imports that
  // module for `missingDemoWalletNotice` and resets the dedup flag
  // there instead — under `testTimeout` (15s, vitest.config.ts), not
  // this hook's stricter default `hookTimeout` (10s). See issue #691.
  beforeEach(async () => {
    savedEnv = process.env[ENV_KEY];
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    const { _resetLiveWalletForTests } = await import(
      "../src/demo/live-mode.js"
    );
    _resetAutoDemoLatchForTests();
    _resetLiveWalletForTests();
  });

  afterEach(async () => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
    const { _resetAutoDemoLatchForTests } = await import("../src/demo/index.js");
    const { _resetLiveWalletForTests } = await import(
      "../src/demo/live-mode.js"
    );
    _resetAutoDemoLatchForTests();
    _resetLiveWalletForTests();
  });

  it("fires under auto-fresh-install reason with copy that names the auto path and setup as the leave route", async () => {
    delete process.env[ENV_KEY];
    const { _setAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(true);
    const { missingDemoWalletNotice, _resetMissingDemoWalletDedup } =
      await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    const notice = missingDemoWalletNotice();
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/^VAULTPILOT NOTICE — /);
    expect(notice).toContain("Auto demo mode active");
    expect(notice).toContain("vaultpilot-mcp-setup");
    // Universal discoverability handles.
    expect(notice).toContain("set_demo_wallet");
    expect(notice).toContain("get_demo_wallet");
    expect(notice).toContain("exit_demo_mode");
    // No imperative-agent / shell-paste shapes that earlier agents
    // flagged as injection.
    expect(notice).not.toMatch(/\[AGENT TASK/);
    expect(notice).not.toMatch(/^\s*git clone\b/m);
    expect(notice).not.toMatch(/^\s*npm (install|i)\b/m);
    expect(notice).toContain("not prompt injection");
  });

  it("fires under explicit-env reason with copy that names VAULTPILOT_DEMO as the leave route", async () => {
    process.env[ENV_KEY] = "true";
    const { missingDemoWalletNotice, _resetMissingDemoWalletDedup } =
      await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    const notice = missingDemoWalletNotice();
    expect(notice).not.toBeNull();
    expect(notice).toMatch(/^VAULTPILOT NOTICE — /);
    expect(notice).toContain("Demo mode active (VAULTPILOT_DEMO=true)");
    expect(notice).toContain("unset");
    expect(notice).toContain("VAULTPILOT_DEMO");
  });

  it("returns null when demo mode is OFF (env unset, latched=false)", async () => {
    delete process.env[ENV_KEY];
    const { _setAutoDemoLatchForTests } = await import("../src/demo/index.js");
    _setAutoDemoLatchForTests(false);
    const { missingDemoWalletNotice, _resetMissingDemoWalletDedup } =
      await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    expect(missingDemoWalletNotice()).toBeNull();
  });

  it("returns null when a live demo wallet is already active (path already taken)", async () => {
    process.env[ENV_KEY] = "true";
    const { setLivePersona } = await import("../src/demo/index.js");
    setLivePersona("defi-degen");
    const { missingDemoWalletNotice, _resetMissingDemoWalletDedup } =
      await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    expect(missingDemoWalletNotice()).toBeNull();
  });

  it("dedupes to once-per-session: first call returns the block, subsequent calls return null", async () => {
    process.env[ENV_KEY] = "true";
    const { missingDemoWalletNotice, _resetMissingDemoWalletDedup } =
      await import("../src/index.js");
    _resetMissingDemoWalletDedup();
    const first = missingDemoWalletNotice();
    const second = missingDemoWalletNotice();
    const third = missingDemoWalletNotice();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(third).toBeNull();
  });
});
