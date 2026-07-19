import { describe, expect, it, vi } from "vitest";

/**
 * Issue #707 augment site (REVIEW post-merge audit, relayed on #707): the
 * demo-mode broadcast-simulation envelope
 * (`broadcastSimulationDispatch` → `buildSimulationEnvelope` → JSON.stringify)
 * serializes `simulationResult` verbatim. A SUCCESSFUL `simulateTransaction`
 * that returns `{ ok: false, revertReason }` — a real eth_call that reverts —
 * where the enriched revert message carries the keyed RPC URL bypasses the
 * already-redacted catch branch (`reason: safeErrorMessage(err)`, PR #703) and
 * leaks through the SUCCESS envelope. RED before the boundary redaction, GREEN
 * once `broadcastSimulationDispatch` routes its content through
 * `redactResponseContent`.
 *
 * The mocks are top-level so vitest hoists them above the dynamic `await
 * import(...)` calls inside `broadcastSimulationDispatch`; a keyed URL is
 * inlined in each factory (hoisted factories cannot close over test-scope
 * variables).
 */
vi.mock("../src/signing/tx-store.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    hasHandle: () => true,
    consumeHandle: () => ({
      chain: "ethereum",
      from: "0x1111111111111111111111111111111111111111",
      to: "0x2222222222222222222222222222222222222222",
      data: "0x",
      value: "0",
    }),
    issueHandles: () => {},
  };
});

vi.mock("../src/signing/solana-tx-store.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, hasSolanaDraft: () => false };
});

vi.mock("../src/modules/simulation/index.js", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    simulateTransaction: async () => ({
      chain: "ethereum",
      ok: false,
      revertReason:
        "execution reverted (via https://mainnet.infura.io/v3/abc123SECRETKEY)",
      revert: {
        message:
          "execution reverted (via https://mainnet.infura.io/v3/abc123SECRETKEY)",
      },
    }),
  };
});

describe("issue #707 — keyed URL in the demo broadcast-simulation envelope (revertReason)", () => {
  const SECRET = "abc123SECRETKEY";

  it("revertReason keyed URL does NOT reach the serialized simulation envelope", async () => {
    const { broadcastSimulationDispatch } = await import("../src/index.js");
    const out = await broadcastSimulationDispatch(
      "send_transaction",
      { handle: "h" },
      (async () => ({ content: [] })) as never,
    );
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v3/${SECRET}`);
  });
});
