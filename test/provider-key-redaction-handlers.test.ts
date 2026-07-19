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

/**
 * Issue #707 rework. #695/PR #703 (above) closed the CATCH branch of these
 * three directly-registered handlers; #707/PR #767 closed the `handler()` and
 * `broadcastSimulationDispatch` SUCCESS boundaries. But these same three
 * handlers are registered directly (`src/index.ts` — `previewSendHandler`,
 * `previewSolanaSendHandler`, `sendTransactionHandler` call sites), so their
 * SUCCESS `{ content }` return bypasses `handler()`'s choke point too — the
 * gap this rework closes by wrapping each success return in
 * `redactResponseContent`.
 *
 * Each test drives the handler's SUCCESS path (render blocks present, no
 * `isError`) with a keyed provider URL embedded in a serialized result field —
 * the exact leak class #695 patched on the catch side — and asserts the raw
 * key is ABSENT and the redaction marker PRESENT. RED-on-removal: revert any
 * of the three success returns to a bare `return { content }` and that
 * handler's test goes RED (the key survives). The over-redaction guard proves
 * a clean preview/send payload is untouched, so the wrap cannot clobber a real
 * tx hash / address / amount.
 */
describe("issue #707 rework — keyed-provider URL redaction on the handler SUCCESS paths", () => {
  const SECRET = "abc123SECRETKEY";
  const INFURA_URL = `https://mainnet.infura.io/v3/${SECRET}`;
  const ALCHEMY_URL = `https://eth-mainnet.g.alchemy.com/v2/${SECRET}`;
  const HELIUS_URL = `https://mainnet.helius-rpc.com/?api-key=${SECRET}`;

  let previewSendHandler!: typeof import("../src/index.js")["previewSendHandler"];
  let previewSolanaSendHandler!: typeof import("../src/index.js")["previewSolanaSendHandler"];
  let sendTransactionHandler!: typeof import("../src/index.js")["sendTransactionHandler"];

  beforeAll(async () => {
    ({ previewSendHandler, previewSolanaSendHandler, sendTransactionHandler } =
      await import("../src/index.js"));
  }, 30_000);

  it("send_transaction: Infura key in a SUCCESS result field is redacted, not leaked", async () => {
    // A relay/RPC note built upstream from a caught `err.message` and returned
    // on the SUCCESS object — JSON-serialized into the first content block.
    const leakyResult = {
      txHash: `0x${"ab".repeat(32)}`,
      chain: "ethereum",
      note: `broadcast relayed via ${INFURA_URL}`,
    };
    const out = await sendTransactionHandler(async () => leakyResult as never)({
      handle: "h",
    } as never);
    const text = out.content.map((c) => c.text).join("\n");
    // SUCCESS path taken (not the redacting catch path):
    expect(out.isError).not.toBe(true);
    expect(text).toContain("TRANSACTION BROADCAST");
    // Key scrubbed, redaction marker left in place:
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v3/${SECRET}`);
    expect(text).toContain("/v3/***");
  });

  it("preview_send: Alchemy key in a SUCCESS result field is redacted, not leaked", async () => {
    const leakyResult = {
      handle: "h",
      chain: "ethereum",
      to: `0x${"00".repeat(20)}`,
      valueWei: "0",
      preSignHash: `0x${"00".repeat(32)}`,
      pinned: {
        nonce: 0,
        maxFeePerGas: "1000000000",
        maxPriorityFeePerGas: "1000000000",
        gas: "21000",
      },
      previewToken: "tok",
      // Ledger clear-signs this shape → skips the blind-sign hash block, but
      // the SUCCESS JSON block below still serializes the whole result.
      clearSignOnly: true,
      // Keyed URL embedded upstream (e.g. a simulation note).
      simulationNote: `eth_call simulate via ${ALCHEMY_URL}`,
    };
    const out = await previewSendHandler(async () => leakyResult as never)({
      handle: "h",
    });
    const text = out.content.map((c) => c.text).join("\n");
    expect(out.isError).not.toBe(true);
    expect(text).toContain("[AGENT TASK — RUN THESE CHECKS NOW");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(`/v2/${SECRET}`);
    expect(text).toContain("/v2/***");
  });

  it("preview_solana_send: Helius api-key in a SUCCESS tx field is redacted, not leaked", async () => {
    // A native_send UnsignedSolanaTx (Ledger clear-signs it); the keyed Helius
    // URL rides in the serialized `description` field of the pinned tx.
    const FROM = "4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf";
    const leakyTx = {
      chain: "solana",
      action: "native_send",
      from: FROM,
      messageBase64: Buffer.from("example-message-bytes").toString("base64"),
      recentBlockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
      description: `Send 1 SOL — pinned via ${HELIUS_URL}`,
      decoded: {
        functionName: "solana.system.transfer",
        args: { from: FROM, to: FROM, amount: "1 SOL" },
      },
    };
    const out = await previewSolanaSendHandler(async () => leakyTx as never)({
      handle: "h",
    });
    const text = out.content.map((c) => c.text).join("\n");
    expect(out.isError).not.toBe(true);
    expect(text).toContain("VERIFY BEFORE SIGNING (Solana");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("?api-key=***");
  });

  it("does not over-redact a clean send_transaction SUCCESS payload", async () => {
    const cleanResult = {
      txHash: `0x${"cd".repeat(32)}`,
      chain: "ethereum",
      // Short `/v2/eth` version-path word (< 8-char segment) and a real tx hash
      // must survive untouched — the wrap only scrubs key-shaped segments.
      note: "upstream 502 from /v2/eth — retried, ok",
    };
    const out = await sendTransactionHandler(async () => cleanResult as never)({
      handle: "h",
    } as never);
    const text = out.content.map((c) => c.text).join("\n");
    expect(out.isError).not.toBe(true);
    expect(text).toContain("/v2/eth");
    expect(text).toContain(cleanResult.txHash);
    expect(text).not.toContain("***");
  });
});
