import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // 152 test files × parallel forks compete for CPU/IO; a test doing
    // `await import("…")` of a heavy module (Solana web3, MarginFi, Curve)
    // can spend several seconds in import alone. The default 5s caused
    // shifting timeout flakes (issue #344). 15s leaves headroom while
    // still bounding genuinely-hung tests.
    testTimeout: 15000,
    // Auto-clean per-test stubs so a forgotten `vi.unstubAllGlobals()` /
    // `vi.unstubAllEnvs()` doesn't leak across `it` blocks within a file.
    unstubGlobals: true,
    unstubEnvs: true,
    // Pin Vitest's current defaults so a future upstream default flip can't
    // silently change pass/fail semantics (package.json allows any 4.x):
    // a zero-test run is a red flag (bad glob / missing checkout), not a pass,
    // and an unhandled rejection must fail the run rather than be swallowed.
    passWithNoTests: false,
    dangerouslyIgnoreUnhandledErrors: false,
  },
});
