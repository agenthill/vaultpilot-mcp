import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import { decodeCalldata } from "../src/signing/decode-calldata.js";

/**
 * Regression coverage for issue #573 — `decodeCalldata` must surface
 * the operator address on `setApprovalForAll(address,bool)` even when
 * the destination is absent from the curated `CONTRACTS` map. A C.2
 * collude attack (smoke-test batch-3 finding `expert-x104-C.2`) routes
 * an NFT operator-approval to an uncurated marketplace/aggregator while
 * the cooperating MCP narrates a benign label; without this fallback
 * the operator field is invisible to the user and Inv #1 cannot flag
 * the label/calldata mismatch.
 */

const SET_APPROVAL_FOR_ALL_ABI = [
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const SAFE_TRANSFER_FROM_3_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const SAFE_TRANSFER_FROM_4_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const UNCURATED_DESTINATION = getAddress(
  "0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf",
);
const ATTACKER_OPERATOR = getAddress(
  "0xBaDC0DeBADc0DeBaDc0DeBaDc0DeBaDc0DeBaDc0",
);
const NFT_OWNER = getAddress(
  "0x1111111111111111111111111111111111111111",
);
const ATTACKER_RECIPIENT = getAddress(
  "0xBaDC0DeBADc0DeBaDc0DeBaDc0DeBaDc0DeBaDc0",
);

describe("decodeCalldata — high-risk standard selector fallback (issue #573)", () => {
  it("decodes setApprovalForAll(operator, true) on an uncurated destination as local-abi-partial", () => {
    const data = encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: [ATTACKER_OPERATOR, true],
    });
    expect(data.slice(0, 10)).toBe("0xa22cb465");

    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");

    // Partial — we know the standard ABI shape, but the destination is
    // uncurated, so name-equality with 4byte is not safe to claim.
    expect(decoded.source).toBe("local-abi-partial");
    expect(decoded.functionName).toBe("setApprovalForAll");
    expect(decoded.signature).toBe("setApprovalForAll(address,bool)");

    // The whole point: the operator address surfaces in CHECKS PERFORMED.
    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    expect(named.operator).toBeDefined();
    expect(named.operator.type).toBe("address");
    expect(named.operator.value).toBe(ATTACKER_OPERATOR);
    expect(named.approved.type).toBe("bool");
    expect(named.approved.value).toBe("true");
  });

  it("decodes setApprovalForAll(operator, false) — revoke flow surfaces operator too", () => {
    // The revoke variant must also decode: a malicious agent could route
    // a `revoke` UI to a `false` calldata while having previously sent a
    // `true` to a different (attacker) operator. Surfacing the operator
    // on revoke lets the user sanity-check that the revoke targets the
    // contract they thought.
    const data = encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: [ATTACKER_OPERATOR, false],
    });
    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");
    expect(decoded.source).toBe("local-abi-partial");
    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    expect(named.operator.value).toBe(ATTACKER_OPERATOR);
    expect(named.approved.value).toBe("false");
  });

  it("operator address is checksum-cased so it matches the swiss-knife render", () => {
    // viem's encodeFunctionData accepts lowercase, but our decode pipeline
    // re-applies EIP-55 casing on address args. The user compares the
    // value rendered in chat against the swiss-knife browser decode — both
    // should be checksummed identically.
    const lowercaseOperator =
      "0xbadc0debadc0debadc0debadc0debadc0debadc0" as `0x${string}`;
    const data = encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: [lowercaseOperator, true],
    });
    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");
    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    expect(named.operator.value).toBe(getAddress(lowercaseOperator));
  });

  it("rejects truncated setApprovalForAll calldata (length guard, no silent decode)", () => {
    // Selector + only one 32-byte word is not a valid (address, bool)
    // payload. The fallback must NOT swallow this — it should fall through
    // to source:'none' rather than fabricate args.
    const truncated = ("0xa22cb465" + "00".repeat(32)) as `0x${string}`;
    const decoded = decodeCalldata(
      "ethereum",
      UNCURATED_DESTINATION,
      truncated,
      "0",
    );
    expect(decoded.source).toBe("none");
    expect(decoded.functionName).toBe("unknown");
  });

  it("rejects setApprovalForAll calldata with trailing junk (length guard)", () => {
    // Real fixed-shape ABI calldata for this selector is exactly 4 + 64
    // bytes. Trailing bytes mean either a different function with a
    // coincidentally-matching selector prefix, or a malformed attacker
    // payload — either way, refuse to surface a "decoded" args list.
    const validData = encodeFunctionData({
      abi: SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: [ATTACKER_OPERATOR, true],
    });
    const padded = (validData + "deadbeef") as `0x${string}`;
    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, padded, "0");
    expect(decoded.source).toBe("none");
    expect(decoded.functionName).toBe("unknown");
  });

  it("uncurated destination + non-listed selector still falls through to source:none", () => {
    // Unknown selector on an unknown destination — the fallback must not
    // pretend to decode anything. Pre-fix behavior is the safe default
    // here; we only WIDEN to local-abi-partial when the selector matches
    // a high-risk standard.
    const decoded = decodeCalldata(
      "ethereum",
      UNCURATED_DESTINATION,
      "0xdeadbeef00000000" as `0x${string}`,
      "0",
    );
    expect(decoded.source).toBe("none");
    expect(decoded.functionName).toBe("unknown");
  });

  it("preserves full local-abi decode when destination is curated (regression pin)", async () => {
    // setApprovalForAll on a curated destination should still be processed
    // by the existing classifyDestination path — but no curated contract
    // in our registry exposes `setApprovalForAll`, so we instead pin the
    // adjacent regression: a curated ERC-20 transfer call still produces
    // source: 'local-abi' (NOT 'local-abi-partial'), proving the new
    // fallback only fires on the uncurated branch.
    const { CONTRACTS } = await import("../src/config/contracts.js");
    const { erc20Abi } = await import("../src/abis/erc20.js");
    const usdc = CONTRACTS.ethereum.tokens.USDC as `0x${string}`;
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [
        getAddress("0x1111111111111111111111111111111111111111"),
        1_000_000n,
      ],
    });
    const decoded = decodeCalldata("ethereum", usdc, data, "0");
    expect(decoded.source).toBe("local-abi");
  });
});

/**
 * Regression coverage for issue #670 (rogue-MCP-only / cooperating-agent
 * slice) — `decodeCalldata` must surface the ERC-721 `safeTransferFrom`
 * recipient (`to`) and `tokenId` even when the destination NFT contract is
 * absent from the curated `CONTRACTS` map. A rogue MCP can route an NFT
 * transfer to an attacker-controlled `to` on an uncurated collection while
 * narrating a benign recipient; without this fallback the recipient is
 * invisible in CHECKS PERFORMED and Inv #1 cannot flag the label/calldata
 * mismatch. Mirrors the #573 setApprovalForAll high-risk-selector fallback.
 */
describe("decodeCalldata — ERC-721 safeTransferFrom selector fallback (issue #670)", () => {
  it("decodes safeTransferFrom(from, to, tokenId) — 3-arg form — on an uncurated NFT contract", () => {
    const data = encodeFunctionData({
      abi: SAFE_TRANSFER_FROM_3_ABI,
      functionName: "safeTransferFrom",
      args: [NFT_OWNER, ATTACKER_RECIPIENT, 1337n],
    });
    expect(data.slice(0, 10)).toBe("0x42842e0e");

    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");

    expect(decoded.source).toBe("local-abi-partial");
    expect(decoded.functionName).toBe("safeTransferFrom");
    expect(decoded.signature).toBe("safeTransferFrom(address,address,uint256)");

    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    // The whole point: the recipient and tokenId surface in CHECKS PERFORMED.
    expect(named.to).toBeDefined();
    expect(named.to.type).toBe("address");
    expect(named.to.value).toBe(ATTACKER_RECIPIENT);
    expect(named.tokenId).toBeDefined();
    expect(named.tokenId.type).toBe("uint256");
    expect(named.tokenId.value).toBe("1337");
    // `from` is also surfaced so the user can confirm the sender.
    expect(named.from.type).toBe("address");
    expect(named.from.value).toBe(NFT_OWNER);
  });

  it("decodes safeTransferFrom(from, to, tokenId, data) — 4-arg form with bytes tail — on an uncurated NFT contract", () => {
    const data = encodeFunctionData({
      abi: SAFE_TRANSFER_FROM_4_ABI,
      functionName: "safeTransferFrom",
      args: [NFT_OWNER, ATTACKER_RECIPIENT, 42n, "0xdeadbeef"],
    });
    expect(data.slice(0, 10)).toBe("0xb88d4fde");

    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");

    expect(decoded.source).toBe("local-abi-partial");
    expect(decoded.functionName).toBe("safeTransferFrom");
    expect(decoded.signature).toBe(
      "safeTransferFrom(address,address,uint256,bytes)",
    );

    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    // Recipient + tokenId must surface despite the dynamic bytes tail.
    expect(named.to.type).toBe("address");
    expect(named.to.value).toBe(ATTACKER_RECIPIENT);
    expect(named.tokenId.type).toBe("uint256");
    expect(named.tokenId.value).toBe("42");
    expect(named.from.value).toBe(NFT_OWNER);
    // The trailing bytes payload is surfaced too (presence/value), so a
    // hook-bearing transfer can't hide an arbitrary data blob from the user.
    expect(named.data).toBeDefined();
    expect(named.data.type).toBe("bytes");
    expect(named.data.value).toBe("0xdeadbeef");
  });

  it("recipient address is checksum-cased so it matches the swiss-knife render", () => {
    const lowercaseRecipient =
      "0xbadc0debadc0debadc0debadc0debadc0debadc0" as `0x${string}`;
    const data = encodeFunctionData({
      abi: SAFE_TRANSFER_FROM_3_ABI,
      functionName: "safeTransferFrom",
      args: [NFT_OWNER, lowercaseRecipient, 1n],
    });
    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, data, "0");
    const named = Object.fromEntries(decoded.args.map((a) => [a.name, a]));
    expect(named.to.value).toBe(getAddress(lowercaseRecipient));
  });

  it("rejects truncated 3-arg safeTransferFrom calldata (length guard)", () => {
    // Selector + only two 32-byte words is not a valid (address, address,
    // uint256) payload. Fall through to source:'none' rather than fabricate.
    const truncated = ("0x42842e0e" + "00".repeat(64)) as `0x${string}`;
    const decoded = decodeCalldata(
      "ethereum",
      UNCURATED_DESTINATION,
      truncated,
      "0",
    );
    expect(decoded.source).toBe("none");
    expect(decoded.functionName).toBe("unknown");
  });

  it("rejects 3-arg safeTransferFrom calldata with trailing junk (length guard)", () => {
    const validData = encodeFunctionData({
      abi: SAFE_TRANSFER_FROM_3_ABI,
      functionName: "safeTransferFrom",
      args: [NFT_OWNER, ATTACKER_RECIPIENT, 7n],
    });
    const padded = (validData + "deadbeef") as `0x${string}`;
    const decoded = decodeCalldata("ethereum", UNCURATED_DESTINATION, padded, "0");
    expect(decoded.source).toBe("none");
    expect(decoded.functionName).toBe("unknown");
  });
});
