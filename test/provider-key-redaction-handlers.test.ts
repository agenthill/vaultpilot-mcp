import { beforeAll, describe, expect, it } from "vitest";

/**
 * Issue #695 rework (PR #703). The choke-point redactor lives in
 * `safeErrorMessage`, but three response-rendering handler catches render
 * `error.message` RAW and bypass it — the HIGHEST-value keyed-provider paths:
 *
 *   - previewSendHandler (preview_send): re-pins gas/nonce/baseFee against the
 *     keyed Infura/Alchemy RPC; a viem HttpRequestError carries `/v3/<key>` in
 *     `.message`.
 *   - sendTransactionHandler (send_transaction): broadcast hits the keyed
 *     provider URL; a transport failure surfaces `/v3/<key>` verbatim.
 *   - previewSolanaSendHandler (preview_solana_send): pins a blockhash against
 *     Helius (`https://mainnet.helius-rpc.com/?api-key=<key>`).
 *
 * Each test drives the handler's catch path with an injected Error carrying a
 * real-shaped keyed URL and asserts the rendered MCP response text does NOT
 * carry the secret. RED on PR-head (raw `error.message`), GREEN once each
 * catch routes through `safeErrorMessage`.
 */
describe("issue #695 — keyed-provider URL redaction in handler catch paths", () => {
  const SECRET = "abc123SECRETKEY";
  const INFURA_URL = `https://mainnet.infura.io/v3/${SECRET}`;
  const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;

  let previewSendHandler!: typeof import("../src/index.js")["previewSendHandler"];
  let previewSolanaSendHandler!: typeof import("../src/index.js")["previewSolanaSendHandler"];
  let sendTransactionHandler!: typeof import("../src/index.js")["sendTransactionHandler"];

  // Pre-warm the src/index.js import once (30s budget — the module graph walk
  // is heavy on a contended worker), matching send-hash-pin.test.ts.
  beforeAll(async () => {
    ({ previewSendHandler, previewSolanaSendHandler, sendTransactionHandler } =
      await import("../src/index.js"));
  }, 30_000);

  it("preview_send: Infura key in a transport error does NOT reach the response", async () => {
    const throwingFn = async () => {
      throw new Error(`HTTP request failed. URL: ${INFURA_URL}`);
    };
    const out = await previewSendHandler(throwingFn as never)({ handle: "h" });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v3/${SECRET}`);
  });

  it("send_transaction: Infura key in a broadcast error does NOT reach the response", async () => {
    const throwingFn = async () => {
      throw new Error(`HTTP request failed. URL: ${INFURA_URL}`);
    };
    const out = await sendTransactionHandler(throwingFn as never)({
      handle: "h",
    } as never);
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v3/${SECRET}`);
  });

  it("preview_solana_send: Helius api-key in a blockhash-pin error does NOT reach the response", async () => {
    const throwingFn = async () => {
      throw new Error(`HTTP request failed. URL: ${HELIUS_URL}`);
    };
    const out = await previewSolanaSendHandler(throwingFn as never)({
      handle: "h",
    });
    const text = out.content.map((c) => c.text).join("\n");
    expect(text).not.toContain(SECRET);
  });
});
