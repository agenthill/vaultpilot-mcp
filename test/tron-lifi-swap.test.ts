import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeAbiParameters } from "viem";
import {
  LIFI_BRIDGE_DATA_TUPLE,
  NON_EVM_RECEIVER_SENTINEL,
} from "../src/abis/lifi-diamond.js";
import { __test_buildSignedTransactionHex } from "../src/modules/tron/broadcast.js";
import { base58ToHex } from "../src/modules/tron/address.js";

/**
 * TRON-source LiFi swap / bridge tests. The two load-bearing pieces:
 *
 *   1. The TRON protobuf decoder (`decodeTronTriggerSmartContract`) extracts
 *      the inner ABI calldata so the BridgeData cross-check can run.
 *   2. `buildSignedTransactionHex` assembles a signed Transaction envelope
 *      hex from `raw_data_hex` + `signature` per protobuf wire format —
 *      `/wallet/broadcasthex` accepts no other shape.
 *
 * Plus the end-to-end: synthetic LiFi quote → buildTronLifiSwap → assert the
 * resulting UnsignedTronTx has the expected action / from / txID / decoded
 * args, and that bridge-intent mismatches are refused.
 */

const TRON_WALLET = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const TRON_LIFI_DIAMOND = "TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const SOL_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_RECIPIENT = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const EVM_RECIPIENT = "0x1111111111111111111111111111111111111111";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  LIFI_TRON_CHAIN_ID: 728126428,
  fetchSolanaQuote: vi.fn(),
}));

interface BridgeDataInput {
  transactionId: `0x${string}`;
  bridge: string;
  integrator: string;
  referrer: `0x${string}`;
  sendingAssetId: `0x${string}`;
  receiver: `0x${string}`;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}

function makeAbiCalldata(bd: BridgeDataInput): `0x${string}` {
  const argsHex = encodeAbiParameters(
    [LIFI_BRIDGE_DATA_TUPLE, { type: "bytes", name: "_facetData" }],
    [bd, "0xc0de"],
  );
  return ("0xdeadbeef" + argsHex.slice(2)) as `0x${string}`;
}

/**
 * Encode a fake TRON `Transaction.raw` protobuf wrapping a TriggerSmartContract
 * that calls the LiFi Diamond on TRON with the given ABI calldata. Just
 * enough wire-format to satisfy `decodeTronTriggerSmartContract`:
 *
 *   raw_data:
 *     contract[0] (tag 11):
 *       Contract:
 *         type = TriggerSmartContract = 31
 *         parameter (Any):
 *           type_url (omitted — only `value` is required)
 *           value:
 *             owner_address = walletHex (21 bytes)
 *             contract_address = diamondHex (21 bytes)
 *             call_value = 0
 *             data = abiCalldata
 *     fee_limit (tag 18) = 100_000_000 (100 TRX)
 */
function encodeTronTriggerSmartContractRawData(
  walletHex: string,
  diamondHex: string,
  abiCalldata: `0x${string}`,
): string {
  function varint(n: number): string {
    let s = "";
    let v = n;
    while (v > 0x7f) {
      s += (0x80 | (v & 0x7f)).toString(16).padStart(2, "0");
      v >>>= 7;
    }
    s += v.toString(16).padStart(2, "0");
    return s;
  }
  function tagBytes(tag: number, wireType: number): string {
    // Tag itself is varint-encoded; for tag>=16 it needs multi-byte form.
    return varint((tag << 3) | wireType);
  }
  function lenDelim(tag: number, payloadHex: string): string {
    const len = payloadHex.length / 2;
    return tagBytes(tag, 2) + varint(len) + payloadHex;
  }
  function tagVarint(tag: number, value: number): string {
    return tagBytes(tag, 0) + varint(value);
  }

  // TriggerSmartContract.value fields:
  //   1: owner_address (bytes)
  //   2: contract_address (bytes)
  //   3: call_value (varint, omitted = 0)
  //   4: data (bytes)
  const triggerInner =
    lenDelim(1, walletHex) +
    lenDelim(2, diamondHex) +
    lenDelim(4, abiCalldata.slice(2));

  // Any: { type_url (1, omitted), value (2, bytes) }
  const anyMessage = lenDelim(2, triggerInner);

  // Contract: { type (1, varint=31), parameter (2, Any) }
  const contractInner = tagVarint(1, 31) + lenDelim(2, anyMessage);

  // Transaction.raw: contract[0] (tag 11), fee_limit (tag 18, varint)
  return lenDelim(11, contractInner) + tagVarint(18, 100_000_000);
}

function makeTronLifiQuote(opts: {
  bridgeData: BridgeDataInput;
  walletBase58?: string;
  diamondBase58?: string;
}) {
  const walletHex = base58ToHex(opts.walletBase58 ?? TRON_WALLET);
  const diamondHex = base58ToHex(opts.diamondBase58 ?? TRON_LIFI_DIAMOND);

  const rawDataHex = encodeTronTriggerSmartContractRawData(
    walletHex,
    diamondHex,
    makeAbiCalldata(opts.bridgeData),
  );
  return {
    action: {
      fromToken: {
        address: TRON_USDT,
        symbol: "USDT",
        decimals: 6,
        priceUSD: "1",
      },
      toToken: {
        address: ETH_USDT,
        symbol: "USDT",
        decimals: 6,
        priceUSD: "1",
      },
      fromAmount: "10000000",
    },
    estimate: {
      toAmount: "9950000",
      toAmountMin: "9900000",
      executionDuration: 60,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: TRON_LIFI_DIAMOND,
    },
    transactionRequest: {
      to: TRON_LIFI_DIAMOND,
      data: ("0x" + rawDataHex) as `0x${string}`,
      value: "0",
      chainId: 728126428,
    },
    tool: opts.bridgeData.bridge,
    toolDetails: { name: opts.bridgeData.bridge },
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildTronLifiSwap — happy path", () => {
  it("returns an UnsignedTronTx with action=lifi_swap and the right decoded args (TRON → EVM)", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "11".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: EVM_RECIPIENT as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1n, // ethereum
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    const tx = await buildTronLifiSwap({
      wallet: TRON_WALLET,
      fromToken: TRON_USDT,
      fromAmount: "10000000",
      toChain: "ethereum",
      toToken: ETH_USDT,
      toAddress: EVM_RECIPIENT,
    });

    expect(tx.chain).toBe("tron");
    expect(tx.action).toBe("lifi_swap");
    expect(tx.from).toBe(TRON_WALLET);
    expect(tx.txID).toMatch(/^[0-9a-f]{64}$/);
    expect(tx.rawData).toBeUndefined(); // /broadcasthex path
    expect(tx.rawDataHex).toMatch(/^[0-9a-f]+$/);
    expect(tx.feeLimitSun).toBe("100000000");
    expect(tx.description).toContain("LiFi bridge");
    expect(tx.description).toContain("ethereum");
    expect(tx.description).toContain("near");
    expect(tx.decoded.functionName).toBe("lifi.tron.bridge");
    expect(tx.decoded.args.toChain).toBe("ethereum");
    expect(tx.decoded.args.toAddress).toBe(EVM_RECIPIENT);
    expect(tx.decoded.args.diamond).toBe(TRON_LIFI_DIAMOND);
    expect(tx.handle).toBeDefined(); // issueTronHandle stamps it
  });

  it("accepts Solana destination + non-EVM sentinel receiver", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "22".repeat(32)) as `0x${string}`,
          bridge: "wormhole",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1151111081099710n, // solana
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    const tx = await buildTronLifiSwap({
      wallet: TRON_WALLET,
      fromToken: TRON_USDT,
      fromAmount: "10000000",
      toChain: "solana",
      toToken: SOL_USDC,
      toAddress: SOL_RECIPIENT,
    });
    expect(tx.action).toBe("lifi_swap");
    expect(tx.decoded.args.toChain).toBe("solana");
    expect(tx.decoded.args.toAddress).toBe(SOL_RECIPIENT);
  });
});

describe("buildTronLifiSwap — destination namespace (#799)", () => {
  const destinations = [
    { toChain: "ethereum", id: 1n },
    { toChain: "arbitrum", id: 42161n },
    { toChain: "polygon", id: 137n },
    { toChain: "base", id: 8453n },
    { toChain: "optimism", id: 10n },
    { toChain: "solana", id: 1151111081099710n },
  ] as const;

  for (const { toChain, id } of destinations) {
    it.each([
      { bridge: "near", encodedId: id, accepted: true },
      { bridge: "near", encodedId: 1885080386571452n, accepted: false },
      { bridge: "NEAR", encodedId: 1885080386571452n, accepted: false },
      { bridge: "symbiosis", encodedId: 1885080386571452n, accepted: false },
    ])(`checks ${toChain} against $encodedId with bridge=$bridge`, async ({ bridge, encodedId, accepted }) => {
      fetchQuoteMock.mockResolvedValue(makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "33".repeat(32)) as `0x${string}`,
          bridge,
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: toChain === "solana" ? NON_EVM_RECEIVER_SENTINEL : EVM_RECIPIENT,
          minAmount: 9_900_000n,
          destinationChainId: encodedId,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }));
      const { buildTronLifiSwap } = await import("../src/modules/tron/lifi-swap.js");
      const result = buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: TRON_USDT,
        fromAmount: "10000000",
        toChain,
        toToken: toChain === "solana" ? SOL_USDC : ETH_USDT,
        toAddress: toChain === "solana" ? SOL_RECIPIENT : EVM_RECIPIENT,
      });
      if (accepted) {
        await expect(result).resolves.toMatchObject({ action: "lifi_swap" });
      } else {
        await expect(result).rejects.toThrow(/destinationChainId mismatch/);
      }
    });
  }
});

describe("buildTronLifiSwap — rejection paths", () => {
  it("rejects malformed wallet (not TRON base58)", async () => {
    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: "0xnotvalidtron",
        fromToken: "native",
        fromAmount: "1000000",
        toChain: "ethereum",
        toToken: ETH_USDT,
        toAddress: EVM_RECIPIENT,
      }),
    ).rejects.toThrow(/not a valid TRON base58/);
  });

  it("rejects toAddress format mismatch (Solana base58 for EVM destination)", async () => {
    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: "native",
        fromAmount: "1000000",
        toChain: "ethereum",
        toToken: ETH_USDT,
        toAddress: SOL_RECIPIENT, // Solana base58 — wrong for ethereum dest
      }),
    ).rejects.toThrow(/not a valid EVM address/);
  });

  it("rejects calldata whose contract_address isn't the LiFi Diamond on TRON", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "33".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: EVM_RECIPIENT as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
        diamondBase58: TRON_USDT, // any valid TRON address that isn't the LiFi Diamond
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: TRON_USDT,
        fromAmount: "10000000",
        toChain: "ethereum",
        toToken: ETH_USDT,
        toAddress: EVM_RECIPIENT,
      }),
    ).rejects.toThrow(/contract_address mismatch.*expected the LiFi Diamond/);
  });

  it("rejects destinationChainId mismatch (user asked Solana, calldata bridges to TRON)", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "44".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 728126428n, // tron, not solana
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: TRON_USDT,
        fromAmount: "10000000",
        toChain: "solana",
        toToken: SOL_USDC,
        toAddress: SOL_RECIPIENT,
      }),
    ).rejects.toThrow(/destinationChainId mismatch.*encoded 728126428.*toChain="solana"/);
  });

  it("rejects EVM-destination calldata whose receiver doesn't match toAddress", async () => {
    const attackerReceiver = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as `0x${string}`;
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "55".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: attackerReceiver,
          minAmount: 9_900_000n,
          destinationChainId: 1n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: TRON_USDT,
        fromAmount: "10000000",
        toChain: "ethereum",
        toToken: ETH_USDT,
        toAddress: EVM_RECIPIENT,
      }),
    ).rejects.toThrow(/receiver mismatch/);
  });

  it("rejects Solana-destination calldata whose receiver isn't the non-EVM sentinel", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeTronLifiQuote({
        bridgeData: {
          transactionId: ("0x" + "66".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: "0x0000000000000000000000000000000000000001",
          receiver: EVM_RECIPIENT as `0x${string}`, // not the sentinel
          minAmount: 9_900_000n,
          destinationChainId: 1151111081099710n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { buildTronLifiSwap } = await import(
      "../src/modules/tron/lifi-swap.js"
    );
    await expect(
      buildTronLifiSwap({
        wallet: TRON_WALLET,
        fromToken: TRON_USDT,
        fromAmount: "10000000",
        toChain: "solana",
        toToken: SOL_USDC,
        toAddress: SOL_RECIPIENT,
      }),
    ).rejects.toThrow(/receiver mismatch for non-EVM destination solana/);
  });
});

describe("buildSignedTransactionHex — protobuf envelope encoder", () => {
  it("wraps raw_data + signature into a Transaction protobuf hex", () => {
    const rawData = "0a02583722"; // 5 bytes
    const sig = "11".repeat(65); // 65-byte signature
    const out = __test_buildSignedTransactionHex(rawData, sig);
    // Field 1 (raw_data, length-delim): tag 0x0a + varint(5) + raw bytes
    // Field 2 (signature, length-delim): tag 0x12 + varint(65) + sig bytes
    expect(out).toBe("0a05" + rawData + "12" + "41" + sig);
  });

  it("encodes long-form varint length when raw_data exceeds 127 bytes", () => {
    const rawData = "ab".repeat(200); // 200-byte raw_data
    const sig = "11".repeat(65);
    const out = __test_buildSignedTransactionHex(rawData, sig);
    // varint(200) = 0xc8 0x01 (200 = 0x80 | 0x48, then 1)
    expect(out.startsWith("0ac801" + rawData)).toBe(true);
  });

  it("strips 0x prefix from inputs", () => {
    const rawData = "ab".repeat(5);
    const sig = "11".repeat(65);
    const withPrefix = __test_buildSignedTransactionHex("0x" + rawData, "0x" + sig);
    const withoutPrefix = __test_buildSignedTransactionHex(rawData, sig);
    expect(withPrefix).toBe(withoutPrefix);
  });

  it("rejects malformed hex inputs", () => {
    expect(() => __test_buildSignedTransactionHex("notvalidhex", "11".repeat(65))).toThrow(
      /not valid hex/,
    );
    expect(() => __test_buildSignedTransactionHex("ab".repeat(5), "notvalidhex")).toThrow(
      /not valid hex/,
    );
  });
});
