import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, encodeAbiParameters, parseUnits, getAddress } from "viem";
import { lifiDiamondAbi, LIFI_BRIDGE_DATA_TUPLE } from "../src/abis/lifi-diamond.js";

/**
 * Issue #798 — `prepare_swap` trusted the raw agent-supplied `toAddress` as the
 * expected on-chain receiver.
 *
 *   - EVM bridge path: `verifyLifiBridgeIntent` compared the decoded
 *     `BridgeData.receiver` to `args.toAddress ?? args.wallet`. An attacker who
 *     set `toAddress` to their own address compared it to itself → always passed.
 *   - Same-chain generic-swap path: the generic-swap `_receiver` (index 3) was
 *     never decoded at all, so an attacker `toAddress` set the on-chain recipient
 *     with no cross-check.
 *
 * The LiFi Diamond is a recognized destination, so the recipient-authorization
 * pre-sign seam returns early on it (D8), leaving these swap-module checks as
 * the only receiver cross-check. #760 only closed the stamped
 * `prepare_custom_call` path (pre-sign block 4b).
 *
 * Fix: `assertEvmReceiverAuthorized` requires the receiver to be the source
 * `wallet` UNLESS the caller affirmatively set `acknowledgeNonWalletRecipient`
 * for a differing `toAddress` (preserving the "swap to a wallet I own" case).
 *
 * Mocks mirror `swap-evm-to-solana.test.ts` / `swap-lifi-minout.test.ts`.
 */

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const ATTACKER = "0x2222222222222222222222222222222222222222";
const MY_OTHER_WALLET = "0x3333333333333333333333333333333333333333";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";
const ZERO = "0x0000000000000000000000000000000000000000";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  fetchSolanaQuote: vi.fn(),
}));

vi.mock("../src/modules/swap/oneinch.js", () => ({
  fetchOneInchQuote: vi.fn(),
  fetchOneInchSwap: vi.fn(),
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

/**
 * Single-leg generic-swap (`swapTokensSingleV3ERC20ToERC20`) calldata with a
 * caller-chosen `_receiver` (index 3). A large `_transactionId` makes the
 * positional bridge decode throw, so it classifies as a generic swap.
 */
function makeGenericSwapCalldata(receiver: `0x${string}`): `0x${string}` {
  return encodeFunctionData({
    abi: lifiDiamondAbi,
    functionName: "swapTokensSingleV3ERC20ToERC20",
    args: [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      "vaultpilot-mcp",
      "",
      receiver,
      9_950_000n, // baked min-out (USDT, 6-dec)
      {
        callTo: LIFI_DIAMOND as `0x${string}`,
        approveTo: LIFI_DIAMOND as `0x${string}`,
        sendingAssetId: ETH_USDC as `0x${string}`,
        receivingAssetId: ETH_USDT as `0x${string}`,
        fromAmount: 10_000_000n, // 10 USDC
        callData: "0x" as `0x${string}`,
        requiresDeposit: true,
      },
    ],
  });
}

/** Bridge-shaped calldata (BridgeData tuple) with a caller-chosen receiver. */
function makeBridgeCalldata(receiver: `0x${string}`, destChainId: bigint): `0x${string}` {
  const argsHex = encodeAbiParameters(
    [LIFI_BRIDGE_DATA_TUPLE, { type: "bytes", name: "_facetData" }],
    [
      {
        transactionId: ("0x" + "22".repeat(32)) as `0x${string}`,
        bridge: "across",
        integrator: "vaultpilot-mcp",
        referrer: ZERO as `0x${string}`,
        sendingAssetId: ETH_USDC as `0x${string}`,
        receiver,
        minAmount: 9_900_000n,
        destinationChainId: destChainId,
        hasSourceSwaps: false,
        hasDestinationCall: false,
      },
      "0xc0de",
    ],
  );
  return ("0xabcdef12" + argsHex.slice(2)) as `0x${string}`;
}

/** Same-chain generic-swap quote (USDC → USDT on Ethereum). */
function makeGenericQuote(receiver: `0x${string}`) {
  return {
    action: {
      fromToken: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { address: ETH_USDT, symbol: "USDT", decimals: 6, priceUSD: "1" },
      fromAmount: "10000000", // 10 USDC
    },
    estimate: {
      toAmount: "10000000",
      toAmountMin: "9950000",
      executionDuration: 30,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: makeGenericSwapCalldata(receiver),
      value: "0",
      gasLimit: "300000",
    },
    tool: "lifi-dex-aggregator",
  };
}

/** Cross-chain (ethereum → arbitrum) bridge quote. */
function makeBridgeQuote(receiver: `0x${string}`) {
  return {
    action: {
      fromToken: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
      fromAmount: "10000000",
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
      data: makeBridgeCalldata(receiver, 42161n), // arbitrum
      value: "0",
      gasLimit: "500000",
    },
    tool: "across",
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  evmClientStub.readContract.mockReset();
  evmClientStub.multicall.mockReset();
  // decimals → 6 (both USDC/USDT); allowance → high so no approve is prepended.
  evmClientStub.readContract.mockImplementation(async (req: { functionName: string }) => {
    if (req.functionName === "allowance") return parseUnits("1000", 6);
    return 6;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#798 — prepare_swap refuses a non-wallet toAddress without an ack", () => {
  it("REFUSES a same-chain swap with toAddress=<attacker> and no ack (the closed hole)", async () => {
    // Attacker sets toAddress to their own address; LiFi legitimately bakes it
    // as the generic-swap `_receiver`. On unfixed code this arg is never
    // decoded, so prepareSwap returns signable calldata that drains to ATTACKER.
    fetchQuoteMock.mockResolvedValue(makeGenericQuote(ATTACKER as `0x${string}`));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_USDT,
        toAddress: ATTACKER,
        amount: "10",
      }),
    ).rejects.toThrow(/is not your source wallet/);
  });

  it("REFUSES a cross-chain bridge with toAddress=<attacker> and no ack (self-referential compare)", async () => {
    // On unfixed code `expectedReceiver = toAddress ?? wallet = ATTACKER`, so the
    // decoded receiver (also ATTACKER) matches itself and passes.
    fetchQuoteMock.mockResolvedValue(makeBridgeQuote(ATTACKER as `0x${string}`));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "arbitrum",
        fromToken: ETH_USDC,
        toToken: ETH_USDC,
        toAddress: ATTACKER,
        amount: "10",
      }),
    ).rejects.toThrow(/is not your source wallet/);
  });
});

describe("#798 — legitimate flows preserved", () => {
  it("PROCEEDS on a same-chain swap to a different wallet WITH the ack, and surfaces the receiver", async () => {
    fetchQuoteMock.mockResolvedValue(makeGenericQuote(MY_OTHER_WALLET as `0x${string}`));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_USDT,
      toAddress: MY_OTHER_WALLET,
      amount: "10",
      acknowledgeNonWalletRecipient: true,
    });

    expect(tx.to).toBe(LIFI_DIAMOND);
    // Companion: the same-chain `_receiver` now appears in the decoded output.
    expect((tx.decoded!.args as Record<string, unknown>).receiver).toBe(
      getAddress(MY_OTHER_WALLET),
    );
  });

  it("PROCEEDS on a same-chain swap with no toAddress (defaults to source wallet)", async () => {
    fetchQuoteMock.mockResolvedValue(makeGenericQuote(EVM_WALLET as `0x${string}`));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_USDT,
      amount: "10",
    });

    expect(tx.to).toBe(LIFI_DIAMOND);
    expect((tx.decoded!.args as Record<string, unknown>).receiver).toBe(
      getAddress(EVM_WALLET),
    );
  });

  it("still REFUSES a non-wallet receiver even WITH the ack if the calldata receiver disagrees with toAddress", async () => {
    // Ack present + toAddress = MY_OTHER_WALLET, but the baked calldata receiver
    // is ATTACKER — a compromised aggregator swapping the receiver post-ack.
    fetchQuoteMock.mockResolvedValue(makeGenericQuote(ATTACKER as `0x${string}`));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_USDT,
        toAddress: MY_OTHER_WALLET,
        amount: "10",
        acknowledgeNonWalletRecipient: true,
      }),
    ).rejects.toThrow(/receiver mismatch/);
  });
});
