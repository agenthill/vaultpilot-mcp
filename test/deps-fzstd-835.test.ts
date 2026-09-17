import { describe, it, expect } from "vitest";
import { createRequire } from "node:module";

/**
 * Issue #835 — `fzstd` is required directly by
 * `@kamino-finance/farms-sdk/dist/Farms.js`, but no published farms-sdk
 * version declares it as a dependency, so a tree installed without an
 * explicit top-level `fzstd` entry omits the module and
 * `get_kamino_positions` throws `Cannot find module 'fzstd'` at runtime.
 *
 * This is a resolution smoke test, not a mock: it fails RED on an
 * `fzstd`-less install and passes once the module resolves.
 */
describe("fzstd dependency resolution", () => {
  it("resolves from the top-level require graph", () => {
    const requireCjs = createRequire(import.meta.url);
    expect(() => requireCjs.resolve("fzstd")).not.toThrow();
  });
});
