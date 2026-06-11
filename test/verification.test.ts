import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress, parseEther } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import {
  buildTronVerification,
  buildVerification,
  payloadFingerprint,
  swissKnifeDecoderUrl,
  tronPayloadFingerprint,
} from "../src/signing/verification.js";
import { decodeCalldata } from "../src/signing/decode-calldata.js";
import {
  renderBitcoinCostPreviewBlock,
  renderCostPreviewBlock,
  renderLitecoinCostPreviewBlock,
  renderPostSendPollBlock,
  renderPreviewCostBlock,
  renderSolanaCostPreviewBlock,
  renderTronAgentTaskBlock,
  renderTronVerificationBlock,
  renderVerificationBlock,
  shouldRenderVerificationBlock,
} from "../src/signing/render-verification.js";
import { collectVerificationBlocks } from "../src/index.js";
import { issueHandles } from "../src/signing/tx-store.js";
import { issueTronHandle } from "../src/signing/tron-tx-store.js";
import { CONTRACTS } from "../src/config/contracts.js";
import { CHAIN_IDS } from "../src/types/index.js";
import type { UnsignedTronTx, UnsignedTx } from "../src/types/index.js";

const USDC = getAddress(CONTRACTS.ethereum.tokens.USDC);
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const SENDER = getAddress("0x1111111111111111111111111111111111111111");

/**
 * Canned cross-check stub for tests so collectVerificationBlocks doesn't
 * hit 4byte.directory over the network. Returns a `match` summary with
 * a recognizable marker so tests can assert the block was auto-emitted.
 */
async function stubVerify() {
  return {
    status: "match" as const,
    selector: "0xdeadbeef",
    summary: "✓ Cross-check passed. (stub summary for tests)",
  };
}

function usdcTransferTx(amount: bigint): UnsignedTx {
  return {
    chain: "ethereum",
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, amount] }),
    value: "0",
    from: SENDER,
    description: "Send USDC",
  };
}

describe("payloadFingerprint", () => {
  it("is deterministic over (chain, to, value, data)", () => {
    const tx = usdcTransferTx(1_000_000n);
    const a = payloadFingerprint(tx);
    const b = payloadFingerprint(tx);
    expect(a).toBe(b);
    expect(a).toMatch(/^0x[0-9a-f]{64}$/);
  });

  it("changes when any field flips a single byte", () => {
    const tx = usdcTransferTx(1_000_000n);
    const base = payloadFingerprint(tx);
    expect(payloadFingerprint({ ...tx, value: "1" })).not.toBe(base);
    expect(payloadFingerprint({ ...tx, to: getAddress("0x0000000000000000000000000000000000000001") })).not.toBe(base);
    // Flip the amount arg.
    const mutated = usdcTransferTx(1_000_001n);
    expect(payloadFingerprint(mutated)).not.toBe(base);
  });

  it("is domain-separated between EVM and TRON", () => {
    const evm = payloadFingerprint(usdcTransferTx(1n));
    const tron = tronPayloadFingerprint("0x00");
    expect(evm).not.toBe(tron);
  });
});

describe("swissKnifeDecoderUrl", () => {
  it("produces ?calldata=&address=&chainId= — all three params", () => {
    const { decoderUrl, decoderPasteInstructions } = swissKnifeDecoderUrl(1, USDC, "0xa9059cbb0000");
    expect(decoderPasteInstructions).toBeUndefined();
    expect(decoderUrl).toBeDefined();
    expect(decoderUrl).toMatch(/^https:\/\/calldata\.swiss-knife\.xyz\/decoder\?/);
    expect(decoderUrl).toContain(`calldata=0xa9059cbb0000`);
    expect(decoderUrl).toContain(`address=${USDC}`);
    expect(decoderUrl).toContain(`chainId=1`);
  });

  it("falls back to paste-instructions when calldata is too large to fit", () => {
    // 7 000 bytes = 14 000 hex chars, comfortably past the 12 000-char URL budget.
    const bigCalldata = `0x${"aa".repeat(7000)}` as `0x${string}`;
    const out = swissKnifeDecoderUrl(1, USDC, bigCalldata);
    expect(out.decoderUrl).toBeUndefined();
    expect(out.decoderPasteInstructions).toBeDefined();
    expect(out.decoderPasteInstructions).toContain("calldata");
  });

  it("fits typical LiFi intra-chain swap calldata (~2 kB) into a preloaded URL", () => {
    // Regression: under the old 3 500-char budget, 2 kB calldata fell back
    // to paste-only. A 12 000-char budget comfortably covers it.
    const realisticLifiSwap = `0x${"bc".repeat(2200)}` as `0x${string}`;
    const out = swissKnifeDecoderUrl(1, USDC, realisticLifiSwap);
    expect(out.decoderUrl).toBeDefined();
    expect(out.decoderPasteInstructions).toBeUndefined();
  });
});

describe("buildVerification (EVM)", () => {
  it("always populates payloadHash, payloadHashShort, humanDecode, comparisonString", () => {
    const tx = usdcTransferTx(1_000_000n);
    const v = buildVerification(tx);
    expect(v.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(v.payloadHashShort).toMatch(/^[0-9a-f]{8}$/);
    expect(v.payloadHashShort).toBe(v.payloadHash.slice(2, 10));
    expect(v.decoderUrl).toBeDefined();
    expect(v.humanDecode.source).toBe("local-abi");
    expect(v.humanDecode.functionName).toBe("transfer");
    expect(v.humanDecode.signature).toBe("transfer(address,uint256)");
    expect(v.comparisonString).toBe(`${CHAIN_IDS.ethereum}:${USDC.toLowerCase()}:0:${tx.data}`);
  });

  it("renders valueHuman with decimals + symbol for known ERC-20 amount args", () => {
    const v = buildVerification(usdcTransferTx(1_000_000n));
    const amountArg = v.humanDecode.args.find((a) => a.name === "amount");
    expect(amountArg).toBeDefined();
    expect(amountArg?.valueHuman).toBe("1 USDC");
  });

  it("native-send (data = 0x) decodes as nativeTransfer with ETH formatting", () => {
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: RECIPIENT,
      data: "0x",
      value: parseEther("0.5").toString(),
      from: SENDER,
      description: "Send 0.5 ETH",
    };
    const v = buildVerification(tx);
    expect(v.humanDecode.source).toBe("native");
    expect(v.humanDecode.functionName).toBe("nativeTransfer");
    expect(v.humanDecode.args[0].valueHuman).toContain("ETH");
  });

  it("unknown destination returns source:none (no decode, user relies on swiss-knife)", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: "0xa9059cbb0000000000000000000000000000000000000000000000000000000000000001",
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const v = buildVerification(tx);
    expect(v.humanDecode.source).toBe("none");
    expect(v.humanDecode.args).toEqual([]);
  });
});

describe("collectVerificationBlocks — approve→action chain only renders the action block", () => {
  it("skips the ERC-20 approve node and renders the swap node only", async () => {
    const swap: UnsignedTx = {
      chain: "ethereum",
      to: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), // LiFi Diamond
      data: "0x2c57e88400000000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "LiFi swap",
    };
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
      next: swap,
    };
    const stamped = issueHandles(approve);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    // verify block + cross-check summary + agent-task block for the swap.
    // The approve node is suppressed entirely (all three blocks).
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[0]).not.toContain("approve(address,uint256)");
    expect(blocks[0]).toContain("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
    expect(blocks[1]).toContain("[CROSS-CHECK SUMMARY");
    expect(blocks[1]).toContain("stub summary for tests");
    expect(blocks[2]).toContain("[AGENT TASK");
    // Task block points at the auto-emitted cross-check summary rather than
    // instructing the agent to call verify_tx_decode itself.
    expect(blocks[2]).toContain("CROSS-CHECK SUMMARY");
    expect(blocks[2]).toContain("4byte.directory");
  });

  it("renders the single tx with its verification + cross-check + agent task blocks", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[1]).toContain("[CROSS-CHECK SUMMARY");
    expect(blocks[2]).toContain("[AGENT TASK");
  });

  it("suppresses all three blocks for ERC-20 approves (Ledger clear-signs natively)", async () => {
    const approveOnly: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
    };
    const stamped = issueHandles(approveOnly);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    expect(blocks).toHaveLength(0);
  });

  it("auto-emitted cross-check summary relays the stub verifier's result verbatim", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    const crossCheck = blocks[1];
    expect(crossCheck).toContain("[CROSS-CHECK SUMMARY");
    expect(crossCheck).toContain("RELAY VERBATIM TO USER");
    expect(crossCheck).toContain("✓ Cross-check passed.");
    expect(crossCheck).toContain("stub summary for tests");
  });

  it("cross-check block surfaces a degraded-state message when the verifier throws", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const throwingVerify = async () => {
      throw new Error("network offline");
    };
    const blocks = await collectVerificationBlocks(stamped, { verify: throwingVerify });
    expect(blocks[1]).toContain("[CROSS-CHECK SUMMARY");
    expect(blocks[1]).toContain("network offline");
    expect(blocks[1]).toMatch(/Could not run the independent calldata cross-check/);
  });

  it("agent task block points at the auto-emitted cross-check and drops the hash-match claim", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    const task = blocks[2];
    // Points the agent at the auto-emitted CROSS-CHECK SUMMARY block.
    expect(task).toMatch(/CROSS-CHECK SUMMARY/);
    expect(task).toMatch(/VERBATIM/);
    // Still forbids ad-hoc scraping of 4byte / swiss-knife.
    expect(task).toMatch(/do NOT script your own WebFetch/i);
    // Still forbids fabricating a passing cross-check line.
    expect(task).toMatch(/do NOT fabricate/i);
    // Prescribes the compact bullet shape.
    expect(task).toMatch(/COMPACT bullet summary/);
    expect(task).toMatch(/do NOT relay it verbatim/i);
    expect(task).toMatch(/Headline:/);
    expect(task).toMatch(/Min out/);
    expect(task).toMatch(/Amount/);
    expect(task).toMatch(/Spender/);
    expect(task).toMatch(/LiFi diamond/);
    // The bullet summary must NOT include a Short hash line any more — our
    // payloadHash does not match what Ledger displays, and leading the user
    // to expect a match trains rubber-stamping.
    expect(task).not.toMatch(/- Short hash:/);
    // Prepare-time no longer surfaces the (a)/(b)/(c) trust-boundary menu.
    // The mandatory integrity checks (agent-side ABI decode + pair-
    // consistency hash) now auto-run at preview_send time, so the prepare
    // reply just ends with one line pointing at "send".
    expect(task).not.toMatch(/OFFER/);
    expect(task).not.toMatch(/\(a\)/);
    expect(task).not.toMatch(/\(b\)/);
    expect(task).not.toMatch(/\(c\)/);
    // Openchain signature-lookup fallback prose is gone — the server's
    // auto-emitted CROSS-CHECK SUMMARY already covers the signature check,
    // so the agent has no "do an extra signature lookup" task to offer.
    expect(task).not.toMatch(/openchain/);
    // Next-step directive is a single "Reply 'send'" line; the on-device
    // hash reminder moved into preview_send's LEDGER BLIND-SIGN HASH block.
    expect(task).toMatch(/Reply 'send' to continue/);
    expect(task).toMatch(/preview_send/);
    // Mandatory checks are described as running at preview time, not here.
    expect(task).toMatch(/CHECKS PERFORMED/);
    // The prepare-time shortHash placeholder must not be substituted anywhere
    // — our payloadHash does not match what Ledger displays and we do not
    // want to train rubber-stamping.
    expect(task).not.toContain(stamped.verification!.payloadHashShort);
  });

  // Issue #625: the prepare-time agent-task block previously rendered to
  // ~3.5 KB per emission, dominated by step-4 preview_send pre-teaching
  // and inline step-3 caveat prose. Trimmed by moving rationale to source
  // comments and compressing step 4 to a one-line pointer at preview_send's
  // own task block. The ceiling leaves headroom for minor wording while
  // catching a reflation regression.
  it("renderAgentTaskBlock stays under 2.3 KB (#625 size regression guard)", async () => {
    const { renderAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const block = renderAgentTaskBlock({
      data: ("0x12345678" + "00".repeat(64)) as `0x${string}`,
    });
    expect(block).not.toBeNull();
    expect(block!.length).toBeLessThan(2300);
  });

  it("truncates long nested hex blobs inside struct args (no 2KB callData wall)", () => {
    // 1 KB of hex (2048 chars after 0x) — emulates LiFi _swapData[].callData.
    const longHex = "0x" + "ab".repeat(1024);
    const v = {
      chainId: 1,
      signature: "foo(tuple[] data)",
      humanDecode: {
        source: "local-abi",
        functionName: "foo",
        signature: "foo(tuple[] data)",
        args: [
          {
            name: "data",
            type: "tuple[]",
            value: `[{callData: ${longHex}}]`,
          },
        ],
      },
      payloadHash: "0x" + "0".repeat(64),
      payloadHashShort: "00000000",
      decoderUrl: "https://calldata.swiss-knife.xyz/decoder?calldata=0xabcd",
      decoderPasteInstructions: "paste",
    } as const;
    const rendered = renderVerificationBlock({
      chain: "ethereum",
      to: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
      value: "0",
      data: "0x617ba0370000" as `0x${string}`,
      verification: v as never,
    });
    // The raw 2 KB hex must not leak verbatim.
    expect(rendered).not.toContain(longHex);
    // Instead we get a head…tail (N bytes) preview.
    expect(rendered).toMatch(/0x(?:ab)+…(?:ab)+ \(1024 bytes\)/);
  });
});

describe("renderCostPreviewBlock — issue #636 fee-shock abort signal", () => {
  it("renders ~$ + native amount when both fields are populated", () => {
    const out = renderCostPreviewBlock({
      chain: "ethereum",
      gasCostUsd: 3.42,
      gasCostNative: "0.00114",
    });
    expect(out).toBe("Estimated network fee: ~$3.42 (≈ 0.00114 ETH)");
  });

  it("falls back to native-only when USD price was unavailable", () => {
    const out = renderCostPreviewBlock({
      chain: "ethereum",
      gasCostNative: "0.00114",
    });
    expect(out).toBe("Estimated network fee: ≈ 0.00114 ETH (USD price unavailable)");
  });

  it("uses the chain's native symbol (POL on polygon)", () => {
    const out = renderCostPreviewBlock({
      chain: "polygon",
      gasCostUsd: 0.02,
      gasCostNative: "0.04",
    });
    // NATIVE_SYMBOL.polygon currently spells the asset MATIC; the test
    // pins whatever the central map declares so the cost block stays in
    // sync if/when that flips to POL.
    expect(out).toMatch(/Estimated network fee: ~\$0\.02 \(≈ 0\.04 (MATIC|POL)\)/);
  });

  it("returns null when gas estimation failed (no native field)", () => {
    expect(
      renderCostPreviewBlock({
        chain: "ethereum",
      }),
    ).toBeNull();
  });

  it("trims trailing zeros and picks fractional precision by magnitude", () => {
    // Mid-range fee (0.001 ≤ n < 0.1): 6 fractional digits, trailing zeros trimmed.
    const mid = renderCostPreviewBlock({
      chain: "ethereum",
      gasCostUsd: 41.5,
      gasCostNative: "0.012000",
    });
    expect(mid).toContain("0.012 ETH");
    // Tiny fee (n < 0.001): 8 fractional digits to keep significant precision.
    const small = renderCostPreviewBlock({
      chain: "arbitrum",
      gasCostUsd: 0.05,
      gasCostNative: "0.0000234",
    });
    expect(small).toContain("0.0000234 ETH");
    // Big fee (n ≥ 0.1): 4 fractional digits, trailing zeros trimmed.
    const big = renderCostPreviewBlock({
      chain: "ethereum",
      gasCostUsd: 1234.5,
      gasCostNative: "0.5000",
    });
    expect(big).toContain("0.5 ETH");
  });
});

describe("renderPreviewCostBlock — issue #650 preview-time fee surface", () => {
  it("renders headline + EIP-1559 breakdown when all fields are populated", () => {
    const out = renderPreviewCostBlock({
      chain: "ethereum",
      gasCostUsd: 4.12,
      gasCostNative: "0.00195",
      // 18 gwei base fee, 1.5 gwei priority, 100k gas
      baseFeePerGas: "18000000000",
      maxPriorityFeePerGas: "1500000000",
      gas: "100000",
    });
    expect(out).toBe(
      "Pinned network fee: ~$4.12 (≈ 0.00195 ETH)\n" +
        "  base fee 18 gwei · priority 1.5 gwei · gas 100000 units",
    );
  });

  it("falls back to native-only when USD price was unavailable", () => {
    const out = renderPreviewCostBlock({
      chain: "ethereum",
      gasCostNative: "0.00195",
      baseFeePerGas: "18000000000",
      maxPriorityFeePerGas: "1500000000",
      gas: "100000",
    });
    expect(out).toMatch(/^Pinned network fee: ≈ 0\.00195 ETH \(USD price unavailable\)/);
    expect(out).toContain("base fee 18 gwei · priority 1.5 gwei · gas 100000 units");
  });

  it("returns null when gasCostNative is missing (silent over fabricated)", () => {
    expect(
      renderPreviewCostBlock({
        chain: "ethereum",
        baseFeePerGas: "18000000000",
        maxPriorityFeePerGas: "1500000000",
        gas: "100000",
      }),
    ).toBeNull();
  });

  it("formats sub-gwei priority fees with 2 fractional digits trimmed", () => {
    // 0.5 gwei priority fee floor — still readable.
    const out = renderPreviewCostBlock({
      chain: "arbitrum",
      gasCostUsd: 0.05,
      gasCostNative: "0.0000234",
      baseFeePerGas: "100000000",
      maxPriorityFeePerGas: "500000000", // 0.5 gwei
      gas: "200000",
    });
    expect(out).toContain("base fee 0.1 gwei · priority 0.5 gwei · gas 200000 units");
  });

  it("uses the chain's native symbol (POL/MATIC on polygon)", () => {
    const out = renderPreviewCostBlock({
      chain: "polygon",
      gasCostUsd: 0.02,
      gasCostNative: "0.04",
      baseFeePerGas: "30000000000",
      maxPriorityFeePerGas: "30000000000",
      gas: "21000",
    });
    expect(out).toMatch(/Pinned network fee: ~\$0\.02 \(≈ 0\.04 (MATIC|POL)\)/);
  });
});

describe("renderSolanaCostPreviewBlock — issue #649 non-EVM fee-shock signal", () => {
  // Deterministic stub prices so no test hits DefiLlama over the network.
  const solPrice = async () => 150; // $150 / SOL
  const priceDown = async () => undefined;

  it("renders native + USD when fee present and price available", async () => {
    // 0.000005 SOL = 5000 lamports; × $150 = $0.00075 → rounds to $0.00.
    const out = await renderSolanaCostPreviewBlock(
      { estimatedFeeLamports: 5000 },
      solPrice,
    );
    expect(out).toBe("Estimated network fee: ~$0.00 (≈ 0.000005 SOL)");
  });

  it("anchors a larger fee in USD with 2-decimal rounding", async () => {
    // 0.01 SOL = 10_000_000 lamports; × $150 = $1.50.
    const out = await renderSolanaCostPreviewBlock(
      { estimatedFeeLamports: 10_000_000 },
      solPrice,
    );
    expect(out).toBe("Estimated network fee: ~$1.50 (≈ 0.01 SOL)");
  });

  it("falls back to native-only when the price lookup degrades", async () => {
    const out = await renderSolanaCostPreviewBlock(
      { estimatedFeeLamports: 5000 },
      priceDown,
    );
    expect(out).toBe(
      "Estimated network fee: ≈ 0.000005 SOL (USD price unavailable)",
    );
  });

  it("returns null when estimatedFeeLamports is absent", async () => {
    expect(await renderSolanaCostPreviewBlock({}, solPrice)).toBeNull();
  });
});

describe("renderBitcoinCostPreviewBlock — issue #649 non-EVM fee-shock signal", () => {
  const btcPrice = async () => 60_000; // $60k / BTC
  const priceDown = async () => undefined;

  it("renders native + USD when fee present and price available", async () => {
    // 0.0001 BTC × $60k = $6.00.
    const out = await renderBitcoinCostPreviewBlock(
      { decoded: { feeBtc: "0.0001" } },
      btcPrice,
    );
    expect(out).toBe("Estimated network fee: ~$6.00 (≈ 0.0001 BTC)");
  });

  it("falls back to native-only when the price lookup degrades", async () => {
    const out = await renderBitcoinCostPreviewBlock(
      { decoded: { feeBtc: "0.0001" } },
      priceDown,
    );
    expect(out).toBe(
      "Estimated network fee: ≈ 0.0001 BTC (USD price unavailable)",
    );
  });

  it("returns null when feeBtc is absent", async () => {
    expect(
      await renderBitcoinCostPreviewBlock(
        { decoded: {} as { feeBtc?: string } },
        btcPrice,
      ),
    ).toBeNull();
  });
});

describe("renderLitecoinCostPreviewBlock — issue #649 non-EVM fee-shock signal", () => {
  const ltcPrice = async () => 80; // $80 / LTC
  const priceDown = async () => undefined;

  it("renders native + USD when fee present and price available", async () => {
    // 0.001 LTC × $80 = $0.08.
    const out = await renderLitecoinCostPreviewBlock(
      { decoded: { feeLtc: "0.001" } },
      ltcPrice,
    );
    expect(out).toBe("Estimated network fee: ~$0.08 (≈ 0.001 LTC)");
  });

  it("falls back to native-only when the price lookup degrades", async () => {
    const out = await renderLitecoinCostPreviewBlock(
      { decoded: { feeLtc: "0.001" } },
      priceDown,
    );
    expect(out).toBe(
      "Estimated network fee: ≈ 0.001 LTC (USD price unavailable)",
    );
  });

  it("returns null when feeLtc is absent", async () => {
    expect(
      await renderLitecoinCostPreviewBlock(
        { decoded: {} as { feeLtc?: string } },
        ltcPrice,
      ),
    ).toBeNull();
  });
});

describe("collectVerificationBlocks — cost preview prepended (issue #636)", () => {
  it("renders cost as the FIRST block when gasCostNative is populated", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
      gasEstimate: "150000",
      gasCostUsd: 3.42,
      gasCostNative: "0.00114",
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    // 4 blocks now: cost preview + verification + cross-check + agent task.
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatch(/^Estimated network fee:/);
    expect(blocks[1]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[2]).toContain("[CROSS-CHECK SUMMARY");
    expect(blocks[3]).toContain("[AGENT TASK");
  });

  it("omits the cost block when enrichTx couldn't estimate gas", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
      // Deliberately no gasCostNative — enrichTx swallowed the failure.
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    // Same 3-block shape as before issue #636 — defends against double-counting.
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
  });

  it("approve→action chain: cost block fires for the action node only", async () => {
    const swap: UnsignedTx = {
      chain: "ethereum",
      to: getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"),
      data: "0x2c57e88400000000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "LiFi swap",
      gasCostUsd: 12.5,
      gasCostNative: "0.004",
    };
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
      // Approve also has a cost in reality, but the verification block is
      // suppressed for clear-sign-only approves and we keep cost paired
      // with verification for a quiet response shape.
      gasCostUsd: 1.2,
      gasCostNative: "0.0004",
      next: swap,
    };
    const stamped = issueHandles(approve);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toMatch(/^Estimated network fee:/);
    expect(blocks[0]).toContain("12.50");
    expect(blocks[1]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[1]).toContain("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");
  });
});

describe("issueHandles stamps verification on every node of approve→action chains", () => {
  it("stamps both the approve and the action", () => {
    const action: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const approve: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [CONTRACTS.ethereum.aave.pool as `0x${string}`, 1_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to Aave",
      next: action,
    };
    const stamped = issueHandles(approve);
    expect(stamped.verification).toBeDefined();
    expect(stamped.next?.verification).toBeDefined();
    expect(stamped.verification!.payloadHash).not.toBe(stamped.next!.verification!.payloadHash);
  });
});

describe("issueTronHandle stamps verification on TRON tx", () => {
  const baseTron: UnsignedTronTx = {
    chain: "tron",
    action: "native_send",
    from: "TXYZabc000000000000000000000000000",
    txID: "a".repeat(64),
    rawData: {},
    rawDataHex: "0a02b63922080102030405060708",
    description: "send 1 TRX",
    decoded: { functionName: "transfer", args: { to: "Tabc", amount: "1 TRX" } },
  };

  it("produces a fingerprint and paste instructions (no swiss-knife URL on TRON)", () => {
    const stamped = issueTronHandle(baseTron);
    expect(stamped.verification).toBeDefined();
    expect(stamped.verification!.payloadHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(stamped.verification!.decoderUrl).toBeUndefined();
    expect(stamped.verification!.decoderPasteInstructions).toBeDefined();
  });

  it("buildTronVerification hash is reproducible from rawDataHex alone", () => {
    const v = buildTronVerification(baseTron);
    expect(v.payloadHash).toBe(tronPayloadFingerprint(baseTron.rawDataHex));
  });
});

describe("renderVerificationBlock includes URL, hash, and the encouragement nudge", () => {
  it("EVM block contains all required elements", () => {
    const tx = usdcTransferTx(1_000_000n);
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toContain("VERIFY BEFORE SIGNING");
    // Markdown-linkified so large URLs don't visually bloat chat; raw URL still
    // present inside the parens for clients that don't render markdown.
    expect(rendered).toContain(`[open in swiss-knife](${stamped.verification!.decoderUrl})`);
    expect(rendered).toContain(stamped.verification!.payloadHash);
    expect(rendered).toContain(stamped.verification!.payloadHashShort);
    expect(rendered).toContain("REJECT");
    expect(rendered).toContain("transfer(address,uint256)");
    expect(rendered).not.toContain("SHOW THIS ENTIRE BLOCK TO THE USER VERBATIM");
    expect(rendered.split("\n").length).toBeLessThanOrEqual(10);
    // When local decode succeeds, the calldata's *content* is shown via Args:
    // re-printing a hex preview duplicates the same information and crowds the
    // chat. Show only byte length as sizing context.
    expect(rendered).toContain("calldata bytes)");
    // Negative lookbehind to ignore the URL's `?calldata=0x...` param — only
    // the standalone `data=0x...` on the chainId line should be absent.
    expect(rendered).not.toMatch(/(?<!call)data=0x[0-9a-f]/i);
  });

  it("includes a hex preview when source: 'none' (no local decode = user has no other local signal)", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: ("0x2c57e884" + "ab".repeat(120)) as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toMatch(/data=0x2c57e884/);
    expect(rendered).toMatch(/\(\d+ bytes\)/);
  });

  it("unknown-destination block tells the user swiss-knife is the decode source, not '(unknown)'", () => {
    const unknown = getAddress("0xdeaDBEefDEadBEefdEAdbeefdEAdbeEFdeaDbeEf");
    const tx: UnsignedTx = {
      chain: "ethereum",
      to: unknown,
      data: "0x2c57e88400000000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "unknown call",
    };
    const stamped = issueHandles(tx);
    const rendered = renderVerificationBlock(
      stamped as UnsignedTx & { verification: NonNullable<UnsignedTx["verification"]> },
    );
    expect(rendered).toContain("decoded by swiss-knife only");
    // We no longer emit the literal scary word "unknown" in the Call line.
    expect(rendered).not.toMatch(/Call:\s+unknown/);
  });

  it("TRON block tells the user there's no browser decoder URL and points at Tronscan", () => {
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TXYZ",
      txID: "b".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "send 5 USDT",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "5 USDT" } },
    });
    const rendered = renderTronVerificationBlock(
      stamped as UnsignedTronTx & { verification: NonNullable<UnsignedTronTx["verification"]> },
    );
    expect(rendered).toContain("TRON");
    expect(rendered).toContain("no browser decoder URL");
    expect(rendered).toContain("tronscan");
    // Tronscan reference is reframed as an AFTER-BROADCAST heads-up, not a
    // pre-sign defense. Lock the sub-header so future edits don't silently
    // revert to the old "pre-sign check" framing where the line sat inline
    // with the VERIFY body.
    expect(rendered).toMatch(/AFTER BROADCAST/);
    expect(rendered).not.toMatch(/After signing, paste/);
    // No payload-hash line: TRON app clear-signs every supported action,
    // so there's no on-device hash for the user to match. txID (below)
    // is the cross-check anchor.
    expect(rendered).not.toContain(stamped.verification!.payloadHash);
    expect(rendered).not.toContain("echoed at send time");
    expect(rendered).toContain(stamped.txID);
    expect(rendered).not.toContain("SHOW THIS ENTIRE BLOCK TO THE USER VERBATIM");
  });
});

describe("renderTronAgentTaskBlock — TRON parallel of EVM CHECK 1 + CHECKS PERFORMED template", () => {
  // Canonical TRC-20 transfer parameter (recipient = TR2r4...Far1, amount = 5929 USDT).
  // Address slot is the last 20 bytes of base58check decode left-padded to 32.
  const TRC20_PARAM_HEX =
    "000000000000000000000000a53a13412d0e415ead45c09752ee1676faef03fa" +
    "0000000000000000000000000000000000000000000000000000000161655c40";

  it("trc20_send carries swiss-knife URL, recipient cross-check one-liner, and CHECKS PERFORMED template", () => {
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TPoaKtYTEPMj4LxWE3J5q3NdZVcX6HYUay",
      txID: "d".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "Send 5929 USDT to TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1",
      decoded: {
        functionName: "transfer(address,uint256)",
        args: {
          to: "TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1",
          amount: "5929",
          symbol: "USDT",
          contract: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
        },
        parameterHex: TRC20_PARAM_HEX,
      },
      feeLimitSun: "100000000",
    });
    const block = renderTronAgentTaskBlock(
      stamped as UnsignedTronTx & { verification: NonNullable<UnsignedTronTx["verification"]> },
    );

    // EVM-mirror header — agent runs the check unprompted, no menu.
    expect(block).toMatch(/^\[AGENT TASK — RUN THIS CHECK NOW/);
    expect(block).toContain("CHECKS PERFORMED");

    // Single-line node -e recipient cross-check (mirror of EVM CHECK 2's
    // viem one-liner). MUST be on one Bash line — multi-line scripts trip
    // scary approval dialogs and "don't ask again" stops working.
    expect(block).toMatch(
      /node -e "console\.log\(Buffer\.from\(require\('bs58check'\)\.decode\('TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1'\)\)\.slice\(1\)\.toString\('hex'\)\)"/,
    );
    const nodeLine = block
      .split("\n")
      .find((l) => l.includes("require('bs58check')"));
    expect(nodeLine).toBeDefined();
    expect(nodeLine!.split("\n").length).toBe(1);

    // Swiss-knife decoder URL — calldata-only mode (no chainId/address)
    // since TRON isn't in swiss-knife's chain dropdown; selector falls
    // back to 4byte.directory.
    expect(block).toContain(
      `[Open in swiss-knife decoder](https://calldata.swiss-knife.xyz/decoder?calldata=0xa9059cbb${TRC20_PARAM_HEX})`,
    );

    // PAIR-CONSISTENCY HASH — N/A on TRON (clear-sign), mirror of EVM
    // clear-sign branch dropping CHECK 2.
    expect(block).toContain("⏸ PAIR-CONSISTENCY HASH — N/A on TRON (clear-sign)");

    // Second-LLM check carried through unchanged from EVM template.
    expect(block).toContain("□ SECOND-LLM CHECK");

    // NEXT ON-DEVICE branch — clear-sign, char-by-char read.
    expect(block).toContain("Recipient: TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1");
    expect(block).toMatch(/Token: USDT.*Amount: 5929/);

    // Anti-regression: do NOT instruct the agent to use python3 or any
    // multi-line script — past live runs improvised a python base58check
    // decode that produced a scary multi-line Bash approval dialog.
    expect(block).not.toMatch(/python3?/);
    expect(block).not.toContain("<<");
  });

  it("native_send falls back to ACTION DECODE — no calldata, no swiss-knife URL", () => {
    const stamped = issueTronHandle({
      chain: "tron",
      action: "native_send",
      from: "TPoaKtYTEPMj4LxWE3J5q3NdZVcX6HYUay",
      txID: "e".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "Send 1 TRX",
      decoded: {
        functionName: "TransferContract",
        args: { to: "TR2r4r7VzQrBopR9xpUU75HUijyLwcFar1", amount: "1" },
      },
    });
    const block = renderTronAgentTaskBlock(
      stamped as UnsignedTronTx & { verification: NonNullable<UnsignedTronTx["verification"]> },
    );
    expect(block).toContain("ACTION DECODE");
    expect(block).not.toContain("require('bs58check')");
    expect(block).not.toContain("calldata.swiss-knife.xyz");
    // Still emits the CHECKS PERFORMED template + clear-sign on-device branch.
    expect(block).toContain("CHECKS PERFORMED");
    expect(block).toContain("⏸ PAIR-CONSISTENCY HASH — N/A on TRON (clear-sign)");
  });
});

describe("renderPostSendPollBlock — auto-poll directive after send_transaction", () => {
  it("tells the agent to poll get_transaction_status itself, not ask the user", () => {
    const block = renderPostSendPollBlock({
      chain: "ethereum",
      txHash: "0xabc123",
    });
    expect(block).toMatch(/AGENT TASK/);
    expect(block).toMatch(/get_transaction_status/);
    expect(block).toMatch(/chain: "ethereum"/);
    expect(block).toMatch(/txHash: "0xabc123"/);
    expect(block).toMatch(/do NOT forward this block to the user/i);
    expect(block).toMatch(/ask the user/i);
    expect(block).toMatch(/type "next"/i);
    expect(block).toMatch(/~5 seconds/);
    expect(block).toMatch(/~2 minutes/);
  });

  it("instructs the agent to wait for inclusion before sending a queued follow-up tx", () => {
    const block = renderPostSendPollBlock({
      chain: "ethereum",
      txHash: "0xabc123",
      nextHandle: "next-handle-uuid",
    });
    expect(block).toMatch(/nextHandle=next-handle-uuid/);
    expect(block).toMatch(/approval is now on-chain/);
    expect(block).toMatch(/insufficient allowance/);
  });

  it("omits the follow-up section when no nextHandle is present", () => {
    const block = renderPostSendPollBlock({
      chain: "ethereum",
      txHash: "0xabc123",
    });
    expect(block).not.toMatch(/nextHandle=/);
    expect(block).toMatch(/No follow-up tx is queued/);
  });

  it("uses a faster cadence on TRON (3s blocks) than on Ethereum (12s blocks)", () => {
    const tronBlock = renderPostSendPollBlock({
      chain: "tron",
      txHash: "a".repeat(64),
    });
    expect(tronBlock).toMatch(/every ~3 seconds/);
    expect(tronBlock).toMatch(/~1 minute/);
    expect(tronBlock).not.toMatch(/every ~5 seconds/);
  });
});

describe("shouldRenderVerificationBlock — approvals are suppressed (Ledger clear-signs them)", () => {
  it("returns false for ERC-20 approve(address,uint256) calldata", () => {
    const approveData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [RECIPIENT, 1_000_000n],
    });
    expect(shouldRenderVerificationBlock({ data: approveData })).toBe(false);
  });

  it("returns true for ERC-20 transfer (not approve)", () => {
    const transferData = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 1_000_000n],
    });
    expect(shouldRenderVerificationBlock({ data: transferData })).toBe(true);
  });

  it("is case-insensitive on the selector", () => {
    expect(shouldRenderVerificationBlock({ data: "0x095EA7B3deadbeef" as `0x${string}` })).toBe(false);
  });
});

describe("decodeCalldata — LiFi Diamond", () => {
  const LIFI_DIAMOND = getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE");

  it("decodes swapTokensMultipleV3ERC20ToNative (selector 0x2c57e884)", () => {
    // Round-trip: encode a call, then pass the bytes through the decoder and
    // assert we get the function name + a non-empty args list back. Locks in
    // the 0x2c57e884 selector that previously rendered "Call: unknown".
    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "swapTokensMultipleV3ERC20ToNative",
          stateMutability: "payable",
          inputs: [
            { name: "_transactionId", type: "bytes32" },
            { name: "_integrator", type: "string" },
            { name: "_referrer", type: "string" },
            { name: "_receiver", type: "address" },
            { name: "_minAmountOut", type: "uint256" },
            {
              name: "_swapData",
              type: "tuple[]",
              components: [
                { name: "callTo", type: "address" },
                { name: "approveTo", type: "address" },
                { name: "sendingAssetId", type: "address" },
                { name: "receivingAssetId", type: "address" },
                { name: "fromAmount", type: "uint256" },
                { name: "callData", type: "bytes" },
                { name: "requiresDeposit", type: "bool" },
              ],
            },
          ],
          outputs: [],
        },
      ],
      functionName: "swapTokensMultipleV3ERC20ToNative",
      args: [
        `0x${"00".repeat(32)}` as `0x${string}`,
        "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
        "",
        SENDER,
        42_000_000_000_000_000n,
        [],
      ],
    });
    expect(data.slice(0, 10)).toBe("0x2c57e884");
    const d = decodeCalldata("ethereum", LIFI_DIAMOND, data, "0");
    expect(d.source).toBe("local-abi");
    expect(d.functionName).toBe("swapTokensMultipleV3ERC20ToNative");
    expect(d.signature).toContain("swapTokensMultipleV3ERC20ToNative(");
    expect(d.args.find((a) => a.name === "_receiver")?.value).toBe(SENDER);
  });

  it("unknown LiFi selector on the same address falls through to source:none", () => {
    // Not a real LiFi function — ensures un-whitelisted selectors gracefully
    // fall back to the swiss-knife-only path rather than misdecoding.
    const d = decodeCalldata("ethereum", LIFI_DIAMOND, "0xdeadbeef00000000" as `0x${string}`, "0");
    expect(d.source).toBe("none");
    expect(d.functionName).toBe("unknown");
  });
});

describe("decodeCalldata", () => {
  it("extracts a checksummed `to` arg on ERC-20 transfer", () => {
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [RECIPIENT, 123n],
    });
    const d = decodeCalldata("ethereum", USDC, data, "0");
    const toArg = d.args.find((a) => a.name === "to");
    expect(toArg?.value).toBe(RECIPIENT);
  });
});

describe("get_tx_verification recovers a verification block by handle", () => {
  it("EVM handle round-trips through the same JSON + rendered block", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(usdcTransferTx(1_000_000n));
    const handle = stamped.handle!;

    const recovered = getTxVerification({ handle }) as UnsignedTx;
    // The store strips the root handle to avoid storing the key in the value;
    // the rest of the tx (and its verification) is the same instance.
    expect(recovered.to).toBe(stamped.to);
    expect(recovered.data).toBe(stamped.data);
    expect(recovered.value).toBe(stamped.value);
    expect(recovered.verification?.payloadHash).toBe(stamped.verification?.payloadHash);

    // The handler() wrapper renders the verification block from the result —
    // proving that get_tx_verification slots into the same render path as prepare_*.
    const blocks = await collectVerificationBlocks(recovered, { verify: stubVerify });
    // verification block + cross-check summary + agent task block (EVM non-approve tx)
    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING");
    expect(blocks[0]).toContain(stamped.verification!.payloadHash);
    expect(blocks[1]).toContain("[CROSS-CHECK SUMMARY");
    expect(blocks[2]).toContain("[AGENT TASK");
  });

  it("TRON handle returns the TRON-rendered block (separate code path)", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    const stamped = issueTronHandle({
      chain: "tron",
      action: "trc20_send",
      from: "TXYZ",
      txID: "c".repeat(64),
      rawData: {},
      rawDataHex: "ff00",
      description: "send 5 USDT",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "5 USDT" } },
    });
    const handle = stamped.handle!;

    const recovered = getTxVerification({ handle }) as UnsignedTronTx;
    expect(recovered.txID).toBe(stamped.txID);
    expect(recovered.verification?.payloadHash).toBe(stamped.verification?.payloadHash);

    const blocks = await collectVerificationBlocks(recovered, { verify: stubVerify });
    // verification block + agent-task block (the TRON parallel of EVM's
    // preview-time CHECKS PERFORMED scaffolding — emitted at prepare time
    // since TRON has no preview step).
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toContain("VERIFY BEFORE SIGNING (TRON)");
    expect(blocks[1]).toContain("[AGENT TASK");
    expect(blocks[1]).toContain("CHECKS PERFORMED");
  });

  it("unknown handle throws with a single clear 'expired or unknown' message", async () => {
    const { getTxVerification } = await import("../src/modules/execution/index.js");
    expect(() => getTxVerification({ handle: "nonexistent-handle-uuid" })).toThrow(
      /Unknown or expired tx handle/
    );
  });
});

describe("verifyEvmCalldata — independent cross-check via 4byte.directory", () => {
  type MockFetch = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
  const mockFetch = (signatures: string[], opts: { ok?: boolean; status?: number } = {}): MockFetch => {
    return async () => ({
      ok: opts.ok ?? true,
      status: opts.status ?? 200,
      json: async () => ({ results: signatures.map((s) => ({ text_signature: s })) }),
    });
  };

  it("returns status=match with a user-facing summary when the 4byte signature round-trips and function name agrees", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1_000_000n));
    const result = await verifyEvmCalldata(
      tx,
      mockFetch(["transfer(address,uint256)"]),
    );
    expect(result.status).toBe("match");
    expect(result.reencodeCheck).toBe("pass");
    expect(result.independentFunctionName).toBe("transfer");
    expect(result.localFunctionName).toBe("transfer");
    expect(result.summary).toMatch(/Cross-check passed/);
    expect(result.summary).toMatch(/re-encod/);
    // The phrasing the user specifically asked to keep.
    expect(result.summary).toMatch(/mathematically implies/);
    // Accurate trust-model framing — 4byte is a DATA SOURCE separate
    // from the server's ABI and from the agent's model weights; the
    // server's role is only the HTTP fetch. Earlier wording said
    // "MCP-side — same trust boundary as the local decode; NOT an
    // external check" which is too strict and led agents to
    // downgrade the 4byte anchor to worthless. The current wording
    // explicitly names 4byte as an independent data source and
    // acknowledges the narrow compromised-MCP MITM caveat.
    expect(result.summary).toMatch(/DATA SOURCE separate/);
    expect(result.summary).toMatch(/compromised[- ]MCP/i);
    expect(result.summary).toMatch(/swiss-knife/);
    // Summary is longer now (by design — the trust-model framing is
    // load-bearing) but still bounded so a future regression that
    // balloons it to wall-of-text still fails.
    expect(result.summary.length).toBeLessThan(1000);
    // Args are recovered positionally.
    expect(result.independentArgs).toHaveLength(2);
    expect(result.independentArgs?.[0].type).toBe("address");
    expect(result.independentArgs?.[1].type).toBe("uint256");
    expect(result.independentArgs?.[1].value).toBe("1000000");
  });

  it("skips 4byte candidates whose selector doesn't match the calldata's first 4 bytes", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(42n));
    const result = await verifyEvmCalldata(
      tx,
      // First result is a known selector-collision that shares NO prefix with transfer's 0xa9059cbb.
      // Second one is the real signature.
      mockFetch(["watch_tg_invmru_d89c2fcf()", "transfer(address,uint256)"]),
    );
    expect(result.status).toBe("match");
    expect(result.independentSignature).toBe("transfer(address,uint256)");
  });

  it("returns status=mismatch when the 4byte function name disagrees with the local ABI decode", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    // Construct a bogus signature whose 4-byte selector happens to equal transfer's selector
    // by finding a colliding function name. We don't actually have such a collision in the
    // test fixtures — so simulate the mismatch path by stubbing verification.humanDecode
    // to claim a different function name.
    const bogusTx = {
      ...tx,
      verification: {
        ...tx.verification!,
        humanDecode: {
          ...tx.verification!.humanDecode,
          functionName: "transferWithDrain",
          signature: "transferWithDrain(address,uint256)",
        },
      },
    };
    const result = await verifyEvmCalldata(
      bogusTx,
      mockFetch(["transfer(address,uint256)"]),
    );
    expect(result.status).toBe("mismatch");
    expect(result.summary).toMatch(/MISMATCH/);
    expect(result.summary).toMatch(/DO NOT SEND/);
    expect(result.localFunctionName).toBe("transferWithDrain");
    expect(result.independentFunctionName).toBe("transfer");
  });

  it("returns status=no-signature when 4byte has no entry for the selector", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    const result = await verifyEvmCalldata(tx, mockFetch([]));
    expect(result.status).toBe("no-signature");
    expect(result.summary).toMatch(/not registered/);
    expect(result.summary).toMatch(/swiss-knife/);
  });

  it("returns status=error and a human-readable summary on a network failure", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1n));
    const failingFetch: MockFetch = async () => {
      throw new Error("connect ETIMEDOUT");
    };
    const result = await verifyEvmCalldata(tx, failingFetch);
    expect(result.status).toBe("error");
    expect(result.summary).toMatch(/Could not reach 4byte/);
    expect(result.summary).toMatch(/ETIMEDOUT/);
  });

  it("returns status=no-data for a pure native transfer with empty calldata", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const nativeTx: UnsignedTx = {
      chain: "ethereum",
      to: RECIPIENT,
      data: "0x",
      value: "1000000000000000000",
      from: SENDER,
      description: "Send 1 ETH",
    };
    // fetchFn should never be invoked — assert by handing it a throwing impl.
    const shouldNotCall: MockFetch = async () => {
      throw new Error("fetch should not be called for no-data path");
    };
    const result = await verifyEvmCalldata(issueHandles(nativeTx), shouldNotCall);
    expect(result.status).toBe("no-data");
    expect(result.summary).toMatch(/native-value/);
  });

  it("handles the 4byte signature-collision case: rejects candidates that don't re-encode losslessly", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1_000n));
    // First candidate is parseable and selector-matching, but takes the wrong arg layout —
    // picking a non-colliding alternative that will fail re-encode. Using `transfer(uint256)`
    // which has a different selector and will be filtered by the selector check before re-encode.
    // To exercise the re-encode fallback, we'd need an actual collision; here we just verify
    // that multiple candidates are tried and the right one wins.
    const result = await verifyEvmCalldata(
      tx,
      mockFetch([
        "some_other_function(bytes)",
        "transfer(address,uint256)",
      ]),
    );
    expect(result.status).toBe("match");
    expect(result.independentSignature).toBe("transfer(address,uint256)");
  });

  it("short-circuits on the ERC-20 approve selector (0x095ea7b3) — clear-signed on Ledger, notorious 4byte spam collisions", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const approveTx: UnsignedTx = {
      chain: "ethereum",
      to: USDC,
      data: encodeFunctionData({
        abi: erc20Abi,
        functionName: "approve",
        args: [getAddress("0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"), 100_000_000n],
      }),
      value: "0",
      from: SENDER,
      description: "Approve USDC to LiFi",
    };
    // fetchFn must not be called — assert by handing it a throwing impl.
    const shouldNotCall: MockFetch = async () => {
      throw new Error("fetch should not be called for approve selector");
    };
    const result = await verifyEvmCalldata(issueHandles(approveTx), shouldNotCall);
    expect(result.status).toBe("not-applicable");
    expect(result.selector).toBe("0x095ea7b3");
    expect(result.summary).toMatch(/clear-sign/);
    expect(result.summary).toMatch(/spender/);
    // Summary must stay short — no 4byte tangent for end users.
    expect(result.summary.length).toBeLessThan(200);
    expect(result.summary).not.toMatch(/4byte/);
  });

  it("prefers the 4byte candidate whose function name matches the local decode when multiple candidates re-encode losslessly (fixes approve-selector spam-collision false mismatch)", async () => {
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    // Use `transfer(address,uint256)` bytes as the test payload — it shares
    // the exact (address, 32-byte) calldata layout with spam collisions like
    // `watch_tg_invmru_*(address,address)`. Any 64-byte payload round-trips
    // bijectively through both, so breaking on the first re-encode match
    // would pick whichever candidate the registry returned first — arbitrary
    // noise. The fix prefers the candidate whose name agrees with the local
    // ABI decode.
    const tx = issueHandles(usdcTransferTx(1_000_000n));
    const result = await verifyEvmCalldata(
      tx,
      // Spam-style collision listed FIRST, canonical signature SECOND —
      // mirrors the real-world 4byte response ordering.
      mockFetch([
        "watch_tg_invmru_abcdef12(address,address)",
        "transfer(address,uint256)",
      ]),
    );
    expect(result.status).toBe("match");
    expect(result.independentSignature).toBe("transfer(address,uint256)");
    expect(result.independentFunctionName).toBe("transfer");
  });

  it("treats source='local-abi-partial' as opt-out of the function-name comparison (fixes LiFi bridge false-positive mismatch)", async () => {
    // The LiFi Diamond ships dozens of bridge facets (across, wormhole,
    // mayan, …) keyed by per-facet selectors that aren't in our local ABI.
    // We surface a positional decode of the universal BridgeData tuple and
    // mark it `source: "local-abi-partial"` with a synthetic
    // `functionName: "lifiBridge"`. 4byte resolves the same selector to the
    // canonical facet name (e.g. `swapAndStartBridgeTokensViaAcrossV4`).
    // Pre-fix: cross-check reported MISMATCH because names differ —
    // refused legitimate bridge calldata. Fix: name-equality is intentionally
    // skipped for partial sources; re-encode lossless still anchors the args.
    const { verifyEvmCalldata } = await import("../src/signing/verify-decode.js");
    const tx = issueHandles(usdcTransferTx(1_000_000n));
    const partialTx = {
      ...tx,
      verification: {
        ...tx.verification!,
        humanDecode: {
          ...tx.verification!.humanDecode,
          functionName: "lifiBridge",
          signature: "lifiBridge(BridgeData) — facet: across",
          source: "local-abi-partial" as const,
        },
      },
    };
    const result = await verifyEvmCalldata(
      partialTx,
      // 4byte's canonical name for the selector; deliberately != "lifiBridge".
      mockFetch(["transfer(address,uint256)"]),
    );
    expect(result.status).toBe("match");
    expect(result.localFunctionName).toBeUndefined();
    expect(result.independentFunctionName).toBe("transfer");
    expect(result.summary).toMatch(/PARTIAL decode/);
    expect(result.summary).toMatch(/Name-equality is intentionally skipped/);
    expect(result.summary).toMatch(/swiss-knife/);
    expect(result.summary).not.toMatch(/MISMATCH/);
    expect(result.summary).not.toMatch(/DO NOT SEND/);
  });
});

describe("verifyTxDecode (MCP handler) — routes by handle origin", () => {
  it("returns not-applicable for TRON handles (no 4-byte selector concept on TRON)", async () => {
    const { verifyTxDecode } = await import("../src/modules/execution/index.js");
    const stamped = issueTronHandle({
      chain: "tron",
      action: "native_send",
      from: "TXYZ",
      txID: "e".repeat(64),
      rawData: {},
      rawDataHex: "aa",
      description: "send 1 TRX",
      decoded: { functionName: "transfer", args: { to: "Tabc", amount: "1 TRX" } },
    });
    const result = await verifyTxDecode({ handle: stamped.handle! });
    expect(result.status).toBe("not-applicable");
    expect(result.summary).toMatch(/decoded preview/);
    expect(result.summary).toMatch(/assertTronRawDataMatches/);
    expect(result.summary).toContain("transfer");
    expect(result.summary).toContain("to: Tabc");
  });

  it("throws a clear 'Unknown or expired' error for an unrecognized handle", async () => {
    const { verifyTxDecode } = await import("../src/modules/execution/index.js");
    await expect(verifyTxDecode({ handle: "not-a-real-handle" })).rejects.toThrow(
      /Unknown or expired tx handle/,
    );
  });
});

describe("agent task block: cross-check relay + on-device guidance", () => {
  it("points at the auto-emitted CROSS-CHECK SUMMARY, forbids ad-hoc scraping, hides the handle", async () => {
    const supply: UnsignedTx = {
      chain: "ethereum",
      to: CONTRACTS.ethereum.aave.pool as `0x${string}`,
      data: "0x617ba0370000" as `0x${string}`,
      value: "0",
      from: SENDER,
      description: "Aave supply",
    };
    const stamped = issueHandles(supply);
    const blocks = await collectVerificationBlocks(stamped, { verify: stubVerify });
    const task = blocks[2];
    expect(task).toMatch(/CROSS-CHECK SUMMARY/);
    // Must relay the cross-check summary verbatim, not paraphrase.
    expect(task).toMatch(/VERBATIM/);
    // Explicit don't-scrape rule.
    expect(task).toMatch(/do NOT script your own WebFetch/i);
    // Handle-secrecy rule still applies — opaque internal state.
    expect(task).toMatch(/Do NOT echo the handle/);
    // The on-device reminder moved out of prepare-time and into the
    // LEDGER BLIND-SIGN HASH block emitted by preview_send.
    expect(task).toMatch(/preview_send/);
  });
});
