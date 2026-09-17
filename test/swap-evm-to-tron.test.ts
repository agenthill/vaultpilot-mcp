import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeAbiParameters, parseUnits } from "viem";
import {
  LIFI_BRIDGE_DATA_TUPLE,
  NON_EVM_RECEIVER_SENTINEL,
} from "../src/abis/lifi-diamond.js";

/**
 * EVM → TRON bridge via the existing `prepare_swap` / `get_swap_quote`
 * tools, plus the new `verifyLifiBridgeIntent` cross-check that fires on
 * EVERY bridge route (Solana + TRON + EVM-to-EVM cross). The check decodes
 * the LiFi BridgeData tuple from the calldata and asserts:
 *   - `destinationChainId` matches LiFi's chain ID for the requested
 *     toChain
 *   - For non-EVM destinations: receiver is the LiFi non-EVM sentinel
 *   - For EVM destinations: receiver matches the user-requested toAddress
 *     (or wallet, when toAddress omitted)
 */

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const TRON_RECIPIENT = "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE";
const SOL_RECIPIENT = "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const TRON_USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const SOL_USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const ARB_RECIPIENT = "0x2222222222222222222222222222222222222222";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  LIFI_TRON_CHAIN_ID: 728126428,
  fetchSolanaQuote: vi.fn(),
}));

vi.mock("../src/modules/swap/oneinch.js", () => ({
  fetchOneInchQuote: vi.fn(),
}));

const evmClientStub = {
  readContract: vi.fn(),
  multicall: vi.fn(),
};
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => evmClientStub,
  resetClients: () => {},
  verifyChainId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../src/config/user-config.js", () => ({
  readUserConfig: () => ({}),
  resolveOneInchApiKey: () => undefined,
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

/** Build a fake LiFi-Diamond bridge calldata with the given BridgeData. */
function makeBridgeCalldata(
  bd: BridgeDataInput,
  selector: `0x${string}` = "0xdeadbeef",
  facetSpecificData: `0x${string}` = "0xc0de",
): `0x${string}` {
  const argsHex = encodeAbiParameters(
    [LIFI_BRIDGE_DATA_TUPLE, { type: "bytes", name: "_facetData" }],
    [bd, facetSpecificData],
  );
  return (selector + argsHex.slice(2)) as `0x${string}`;
}

function makeBridgeQuote(
  options: {
    bridgeData: BridgeDataInput;
    fromAmount?: string;
    fromChainId?: number;
    toChainId?: number;
    fromAsset?: { address: string; symbol: string; decimals: number; priceUSD?: string };
    toAsset?: { address: string; symbol: string; decimals: number; priceUSD?: string };
  },
) {
  return {
    action: {
      fromToken: options.fromAsset ?? {
        address: ETH_USDT,
        symbol: "USDT",
        decimals: 6,
        priceUSD: "1",
      },
      toToken: options.toAsset ?? {
        address: TRON_USDT,
        symbol: "USDT",
        decimals: 6,
        priceUSD: "1",
      },
      fromAmount: options.fromAmount ?? "10000000",
    },
    estimate: {
      toAmount: "9950000",
      toAmountMin: "9900000",
      executionDuration: 60,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: makeBridgeCalldata(options.bridgeData),
      value: "0",
      gasLimit: "500000",
    },
    tool: options.bridgeData.bridge,
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  evmClientStub.readContract.mockReset();
  evmClientStub.multicall.mockReset();
  evmClientStub.readContract.mockImplementation(
    async (req: { functionName: string }) => {
      if (req.functionName === "allowance") return parseUnits("1000", 6);
      return 6;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("getSwapQuote — EVM → TRON", () => {
  it("requires toAddress when toChain === 'tron'", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "tron",
        fromToken: ETH_USDT,
        toToken: TRON_USDT,
        amount: "10",
      }),
    ).rejects.toThrow(/toAddress is required.*tron/);
  });

  it("rejects toAddress not in TRON base58 format", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "tron",
        fromToken: ETH_USDT,
        toToken: TRON_USDT,
        toAddress: SOL_RECIPIENT, // Solana base58, not TRON
        amount: "10",
      }),
    ).rejects.toThrow(/not a valid TRON base58 address/);
  });

  it("rejects exact-out for cross-chain to TRON", async () => {
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "tron",
        fromToken: ETH_USDT,
        toToken: TRON_USDT,
        toAddress: TRON_RECIPIENT,
        amount: "10",
        amountSide: "to",
      }),
    ).rejects.toThrow(/Exact-out.*tron/);
  });

  it("forwards toChain and toAddress to LiFi for a TRON-destination quote", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "11".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1885080386571452n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "tron",
      fromToken: ETH_USDT,
      toToken: TRON_USDT,
      toAddress: TRON_RECIPIENT,
      amount: "10",
    });
    expect(out.crossChain).toBe(true);
    expect(out.toChain).toBe("tron");

    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.toChain).toBe("tron");
    expect(lifiCall.toAddress).toBe(TRON_RECIPIENT);
  });
});

describe("prepareSwap — EVM → TRON", () => {
  it("returns an EVM UnsignedTx for a TRON-destination bridge after the intent cross-check", async () => {
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "22".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1885080386571452n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "tron",
      fromToken: ETH_USDT,
      toToken: TRON_USDT,
      toAddress: TRON_RECIPIENT,
      amount: "10",
    });
    expect(tx.chain).toBe("ethereum");
    expect(tx.to).toBe(LIFI_DIAMOND);
    expect(tx.description).toContain("tron");

    // Destination decimals read MUST NOT have fired against TRC-20 contract.
    const calls = evmClientStub.readContract.mock.calls as Array<
      [{ address?: string }]
    >;
    const dstTrcCall = calls.find((c) => c[0].address === TRON_USDT);
    expect(dstTrcCall).toBeUndefined();
  });
});

describe("verifyLifiBridgeIntent — chain-id swap detection", () => {
  it("refuses calldata whose destinationChainId disagrees with toChain (Solana → TRON swap attack)", async () => {
    // User asks for Solana destination. Calldata claims to bridge to TRON.
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "33".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: NON_EVM_RECEIVER_SENTINEL as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 1885080386571452n, // TRON, but user wants Solana
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "solana",
        fromToken: ETH_USDT,
        toToken: SOL_USDC_MINT,
        toAddress: SOL_RECIPIENT,
        amount: "10",
      }),
    ).rejects.toThrow(/destinationChainId mismatch.*encoded 1885080386571452.*toChain="solana"/);
  });

  it("refuses calldata whose encoded receiver is not the source wallet on EVM destinations (decode-time defense-in-depth)", async () => {
    // #798 defense-in-depth. The caller passes toAddress == wallet, so the
    // input gate (assertCrossChainAddressing) is satisfied — but a compromised
    // LiFi API injects a DIFFERENT EVM receiver into the calldata. The
    // decode-time gate (assertEvmReceiverIsWallet) must still refuse: the ONLY
    // authorized EVM receiver is the source wallet, fail-closed. This is the
    // exact "omitted-or-equal toAddress but tampered calldata receiver"
    // scenario the source comments call out as the reason both gates exist.
    const attackerReceiver = "0xdeaddeaddeaddeaddeaddeaddeaddeaddeaddead" as `0x${string}`;
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "44".repeat(32)) as `0x${string}`,
          bridge: "across",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: attackerReceiver,
          minAmount: 9_900_000n,
          destinationChainId: 42161n, // arbitrum (correct chain)
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
        fromChainId: 1,
        toChainId: 42161,
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "arbitrum",
        fromToken: ETH_USDT,
        toToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", // arb USDT
        // toAddress == wallet: passes the input gate, so the decode-time
        // receiver check is the sole line of defense that must reject the
        // injected non-wallet receiver.
        toAddress: EVM_WALLET,
        amount: "10",
      }),
    ).rejects.toThrow(
      /receiver mismatch.*encoded 0xdead.*authorized EVM receiver is your source wallet 0x1111/i,
    );
  });

  it("refuses calldata whose receiver is NOT the non-EVM sentinel for a non-EVM destination", async () => {
    // User asks for TRON destination. Calldata's receiver is a real EVM
    // address (= the bridge protocol forgot the sentinel, or attacker is
    // routing to an EVM account using a TRON-labeled chain ID).
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "55".repeat(32)) as `0x${string}`,
          bridge: "near",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: ARB_RECIPIENT as `0x${string}`, // an EVM address, not the sentinel
          minAmount: 9_900_000n,
          destinationChainId: 1885080386571452n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "tron",
        fromToken: ETH_USDT,
        toToken: TRON_USDT,
        toAddress: TRON_RECIPIENT,
        amount: "10",
      }),
    ).rejects.toThrow(/receiver mismatch for non-EVM destination tron.*expected the LiFi non-EVM sentinel/);
  });

  it("accepts intra-EVM same-chain swap calldata (no BridgeData → check skipped)", async () => {
    // For intra-EVM same-chain swaps, the calldata uses the swap-facet ABI
    // and tryDecodeLifiBridgeData returns null. The intent check skips
    // silently — no false positive on the existing same-chain path.
    fetchQuoteMock.mockResolvedValue({
      action: {
        fromToken: { address: ETH_USDT, symbol: "USDT", decimals: 6, priceUSD: "1" },
        toToken: {
          address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
          symbol: "WETH",
          decimals: 18,
          priceUSD: "3000",
        },
        fromAmount: parseUnits("10", 6).toString(),
      },
      estimate: {
        toAmount: parseUnits("0.0033", 18).toString(),
        toAmountMin: parseUnits("0.0032", 18).toString(),
        executionDuration: 30,
        feeCosts: [],
        gasCosts: [],
        approvalAddress: LIFI_DIAMOND,
      },
      transactionRequest: {
        to: LIFI_DIAMOND,
        // Use a swap-facet selector (swapTokensSingleV3ERC20ToERC20) plus
        // garbage args — the key invariant is that
        // tryDecodeLifiBridgeData fails to extract a tuple (so the intent
        // check skips), not that prepareSwap's other guards happen to pass.
        data: ("0x4666fc80" + "00".repeat(32)) as `0x${string}`,
        value: "0",
        gasLimit: "200000",
      },
      tool: "lifi-dex-aggregator",
    });

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    // The swap path itself may still throw on the malformed data — the
    // assertion here is that it does NOT throw the bridge-intent
    // mismatch error. (It'd be unusual for a real LiFi quote to ship
    // malformed calldata; the test is structured around the scenario
    // where the bridge-intent check correctly bypasses non-bridge calls.)
    let bridgeIntentErr: unknown = null;
    try {
      await prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDT,
        toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        amount: "10",
      });
    } catch (err) {
      bridgeIntentErr = err;
    }
    if (bridgeIntentErr instanceof Error) {
      expect(bridgeIntentErr.message).not.toMatch(/destinationChainId mismatch/);
      expect(bridgeIntentErr.message).not.toMatch(/receiver mismatch/);
    }
  });

  it("accepts a happy-path EVM-to-EVM bridge whose receiver matches the source wallet", async () => {
    // #798 fail-closed model: the only allowed EVM bridge output goes to the
    // source wallet. Both toAddress and the encoded receiver equal the wallet
    // (toAddress could equally be omitted), so the input gate and the
    // decode-time receiver check both pass and the bridge proceeds.
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "66".repeat(32)) as `0x${string}`,
          bridge: "across",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: EVM_WALLET as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 42161n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "arbitrum",
      fromToken: ETH_USDT,
      toToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
      toAddress: EVM_WALLET,
      amount: "10",
    });
    expect(tx.chain).toBe("ethereum");
    expect(tx.description).toContain("Bridge");
  });

  it("refuses an EVM-to-EVM bridge to a non-wallet toAddress (#798 fund-redirection is disabled)", async () => {
    // Locks in the #798 input-gate fix: routing a swap/bridge's EVM output to
    // any address other than the source wallet is refused up front, with no
    // acknowledge flag (a prompt-injected agent could forge one). ARB_RECIPIENT
    // (0x2222…) != source wallet (0x1111…). The encoded receiver is set to the
    // same non-wallet address so this stays a fund-redirection shape end to end.
    fetchQuoteMock.mockResolvedValue(
      makeBridgeQuote({
        bridgeData: {
          transactionId: ("0x" + "67".repeat(32)) as `0x${string}`,
          bridge: "across",
          integrator: "vaultpilot-mcp",
          referrer: "0x0000000000000000000000000000000000000000",
          sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
          receiver: ARB_RECIPIENT as `0x${string}`,
          minAmount: 9_900_000n,
          destinationChainId: 42161n,
          hasSourceSwaps: false,
          hasDestinationCall: false,
        },
      }),
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "arbitrum",
        fromToken: ETH_USDT,
        toToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9",
        toAddress: ARB_RECIPIENT, // 0x2222… != source wallet 0x1111…
        amount: "10",
      }),
    ).rejects.toThrow(
      /toAddress.*0x2222.*is not your source wallet.*0x1111.*#798 fund-redirection shape/i,
    );
  });
});

/** The requested destination alone selects the accepted on-chain IDs (#799). */
describe("verifyLifiBridgeIntent — destination chain namespace (#799)", () => {
  const destinations = [
    { toChain: "ethereum", id: 1n, toToken: ETH_USDT, toAddress: EVM_WALLET },
    { toChain: "arbitrum", id: 42161n, toToken: ETH_USDT, toAddress: EVM_WALLET },
    { toChain: "polygon", id: 137n, toToken: ETH_USDT, toAddress: EVM_WALLET },
    { toChain: "base", id: 8453n, toToken: ETH_USDT, toAddress: EVM_WALLET },
    { toChain: "optimism", id: 10n, toToken: ETH_USDT, toAddress: EVM_WALLET },
    { toChain: "solana", id: 1151111081099710n, toToken: SOL_USDC_MINT, toAddress: SOL_RECIPIENT },
    { toChain: "tron", id: 1885080386571452n, toToken: TRON_USDT, toAddress: TRON_RECIPIENT },
  ] as const;

  function quote(bridge: string, destinationChainId: bigint, receiver: `0x${string}`) {
    return makeBridgeQuote({
      bridgeData: {
        transactionId: ("0x" + "77".repeat(32)) as `0x${string}`,
        bridge,
        integrator: "vaultpilot-mcp",
        referrer: "0x0000000000000000000000000000000000000000",
        sendingAssetId: ETH_USDT.toLowerCase() as `0x${string}`,
        receiver,
        minAmount: 9_900_000n,
        destinationChainId,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      },
    });
  }

  for (const destination of destinations) {
    const { toChain, id, toToken, toAddress } = destination;
    const receiver = toChain === "solana" || toChain === "tron"
      ? NON_EVM_RECEIVER_SENTINEL : EVM_WALLET;
    const args = {
      wallet: EVM_WALLET,
      fromChain: "ethereum" as const,
      toChain,
      fromToken: ETH_USDT,
      toToken,
      toAddress,
      amount: "10",
    };

    it.each(["near", "NEAR", "symbiosis", "allbridge", "unknown-bridge"])(
      `accepts the actual ${toChain} on-chain ID with bridge=%s`, async (bridge) => {
        fetchQuoteMock.mockResolvedValue(quote(bridge, id, receiver));
        const { prepareSwap } = await import("../src/modules/swap/index.js");
        await expect(prepareSwap(args)).resolves.toMatchObject({ to: LIFI_DIAMOND });
      },
    );

    it.each(destinations.filter((other) => other.toChain !== toChain))(
      `refuses near-labelled $toChain calldata when the user requested ${toChain}`,
      async (other) => {
        // Receiver and quote metadata match the request; only calldata routes
        // elsewhere. Includes the original near + TRON-id bypass for all six
        // other destinations, and the same-chain ethereum request.
        fetchQuoteMock.mockResolvedValue(quote("near", other.id, receiver));
        const { prepareSwap } = await import("../src/modules/swap/index.js");
        await expect(prepareSwap(args)).rejects.toThrow(/destinationChainId mismatch/);
      },
    );

    it.each([728126428n, 1885080386571453n, 99999999n])(
      `refuses unaccepted ID %s for ${toChain}, even with bridge=near`, async (wrongId) => {
        fetchQuoteMock.mockResolvedValue(quote("near", wrongId, receiver));
        const { prepareSwap } = await import("../src/modules/swap/index.js");
        await expect(prepareSwap(args)).rejects.toThrow(/destinationChainId mismatch/);
      },
    );
  }
});
