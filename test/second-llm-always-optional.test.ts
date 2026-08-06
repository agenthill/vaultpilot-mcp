/**
 * The second-LLM cross-check is always optional — no op class makes it a
 * precondition of 'send'. Supersedes the Inv #12.5 hard-trigger flag
 * (`secondLlmRequired`, issue #501), which is deleted.
 *
 * Goes red if a renderer starts demanding the check: the offer wording is
 * pinned as an offer, and any "required/mandatory/must" phrasing attached
 * to a SECOND-LLM line fails.
 */
import { describe, it, expect } from "vitest";
import { CONTRACTS } from "../src/config/contracts.js";

/** Any SECOND-LLM line that reads as a demand rather than an offer. */
const DEMANDS = /SECOND-LLM[^\n]*\b(REQUIRED|MANDATORY|MUST|NOT YET RUN)\b/i;

const HEX_DATA =
  "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042b1d8d3a3f0000";

const baseTx = {
  chain: "ethereum" as const,
  to: CONTRACTS.ethereum.tokens.USDC as `0x${string}`,
  value: "0",
  data: HEX_DATA as `0x${string}`,
  verification: {
    payloadHash: "0xdeadbeef" as `0x${string}`,
    payloadHashShort: "deadbeef",
    comparisonString: "ignored",
    humanDecode: {
      functionName: "transfer" as const,
      args: [],
      source: "none" as const,
    },
  },
};

describe("second-LLM check is never rendered as a precondition", () => {
  it("verification block carries no SECOND-LLM demand, with or without other ⚠ warnings", async () => {
    const { renderVerificationBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const plain = renderVerificationBlock({ ...baseTx });
    const warned = renderVerificationBlock({
      ...baseTx,
      to: CONTRACTS.ethereum.lido.stETH as `0x${string}`,
      recipient: {
        source: "literal",
        warnings: [
          "contacts file failed verification — recipient label not checked",
        ],
      },
      tokenClass: {
        flags: ["rebasing"],
        warnings: ["stETH is rebasing — recipient may receive 1-2 wei less."],
      },
    });
    // The other ⚠ warnings still render — this pins the absence of a
    // SECOND-LLM demand, not the absence of warnings generally.
    expect(warned).toMatch(/⚠ contacts file failed verification/);
    expect(warned).toMatch(/⚠ stETH is rebasing/);
    for (const block of [plain, warned]) {
      expect(block).not.toMatch(DEMANDS);
    }
  });

  it("preview agent-task block offers the check as optional on both sign modes", async () => {
    const { renderPreviewVerifyAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const args = {
      chain: "ethereum",
      preSignHash: "0xfeed",
      pinned: {
        nonce: 7,
        maxFeePerGas: "30000000000",
        maxPriorityFeePerGas: "1500000000",
        gas: "21000",
      },
      to: CONTRACTS.ethereum.tokens.USDC,
      valueWei: "0",
      decoderUrl: "https://calldata.swiss-knife.xyz/decoder",
    };
    for (const clearSignOnly of [false, true]) {
      const block = renderPreviewVerifyAgentTaskBlock({
        ...args,
        clearSignOnly,
      });
      expect(block).toMatch(/SECOND-LLM CHECK — optional/);
      expect(block).toMatch(/Otherwise reply 'send'/);
      expect(block).not.toMatch(DEMANDS);
    }
  });
});
