import { beforeAll, describe, expect, it } from "vitest";

/**
 * Issue #707 — provider-API-key redaction on the SUCCESS path (follow-up to
 * #695/PR #703, which closed only the ERROR path via `safeErrorMessage`).
 *
 * Module adapters embed a CAUGHT upstream `err.message` in a `reason`/`note`
 * field on a SUCCESS-return object (`compare_yields` → aave/compound/marginfi;
 * the incidents chain scans; `execution/index.ts` RPC helpers;
 * `simulation/index.ts` `revertReason`). That object is JSON-serialized into a
 * SUCCESS content block by the `handler()` wrapper (and, on the demo send path,
 * by `broadcastSimulationDispatch`) WITHOUT passing through `safeErrorMessage`,
 * so a keyed Infura/Alchemy/Helius RPC URL leaks verbatim.
 *
 * These drive the two response-boundary choke points with an injected keyed
 * URL on the SUCCESS path and assert the serialized MCP response does NOT carry
 * the secret. RED on current code (raw serialization), GREEN once each boundary
 * routes its content through `redactResponseContent`.
 */
describe("issue #707 — keyed-provider URL redaction on the SUCCESS/reason path", () => {
  const SECRET = "abc123SECRETKEY";
  const INFURA_URL = `https://mainnet.infura.io/v3/${SECRET}`;
  const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${SECRET}`;
  const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;

  let handler!: typeof import("../src/index.js")["handler"];

  beforeAll(async () => {
    ({ handler } = await import("../src/index.js"));
  }, 30_000);

  it("compare_yields-style reason (Infura /v3/<key>) does NOT reach the success response", async () => {
    // Mirror the exact shape `compareYields` returns when an adapter read
    // throws: an `unavailable[].reason` built from the caught `err.message`
    // carrying the keyed RPC URL (aave.ts:62 / compound.ts:68 / marginfi.ts:106).
    const leakyResult = {
      results: [],
      unavailable: [
        {
          protocol: "aave-v3",
          chain: "ethereum",
          available: false,
          reason: `Aave V3 read failed: HTTP request failed. URL: ${INFURA_URL}`,
        },
      ],
    };
    const out = await handler(async () => leakyResult)({});
    const text = out.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v3/${SECRET}`);
  });

  it("Alchemy /v2/<key> in a success reason does NOT reach the response", async () => {
    const leakyResult = {
      simulationSkipped: true,
      reason: `RPC call failed: fetch failed for ${ALCHEMY_URL}`,
    };
    const out = await handler(async () => leakyResult)({});
    const text = out.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v2/${SECRET}`);
  });

  it("Helius ?api-key=<key> in a success reason does NOT reach the response", async () => {
    const leakyResult = {
      chainHealth: "degraded",
      reason: `RPC error during getSlot: connect ETIMEDOUT ${HELIUS_URL}`,
    };
    const out = await handler(async () => leakyResult)({});
    const text = out.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
    expect(text).not.toContain(SECRET);
  });

  it("does not over-redact a clean success response (no keyed URL survives verbatim)", async () => {
    const cleanResult = { ok: true, note: "Upstream 502 from /v2/eth — retry", apr: "0.031" };
    const out = await handler(async () => cleanResult)({});
    const text = out.content.map((c) => (c as { text?: string }).text ?? "").join("\n");
    // The clean JSON payload must survive: version-path word `/v2/eth` (< 8-char
    // segment) is not clobbered, and the apr value is intact.
    expect(text).toContain("/v2/eth");
    expect(text).toContain("0.031");
  });
});
