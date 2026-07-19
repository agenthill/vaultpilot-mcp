import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, encodeAbiParameters, parseUnits } from "viem";
import { lifiDiamondAbi, LIFI_BRIDGE_DATA_TUPLE } from "../src/abis/lifi-diamond.js";
import {
  classifyLifiQuote,
  vetGenericSwapQuote,
  bridgeSuspectedUnreachable,
} from "../src/modules/swap/vet-lifi-quote.js";

/**
 * #685 — LiFi generic-swap baked-min-out reachability gate (`vetLifiQuote`).
 *
 * The gate is the sole producer of a shippable GENERIC-SWAP quote: it runs the
 * same classification catch-all + skim leg-walk on q1 AND q2, and prepareSwap
 * builds swapTx only from the gate-returned quote. Bridges ship status quo +
 * a source-side-only suspected-unreachable counter (PROD option (C)).
 *
 * Mocks `../src/modules/swap/lifi.js`'s `fetchQuote` exactly as
 * `swap-evm-to-solana.test.ts` does — the mock records each call's args and
 * returns a scripted quote per call.
 */

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
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

type Leg = {
  sendingAssetId: `0x${string}`;
  receivingAssetId: `0x${string}`;
  fromAmount: bigint;
};

/** Encode a generic-swap (`swapTokensMultipleV3ERC20ToERC20`) calldata with the given legs + baked min-out. */
function makeGenericSwapCalldata(minAmountOut: bigint, legs: Leg[]): `0x${string}` {
  return encodeFunctionData({
    abi: lifiDiamondAbi,
    functionName: "swapTokensMultipleV3ERC20ToERC20",
    args: [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      "vaultpilot-mcp",
      "",
      EVM_WALLET as `0x${string}`,
      minAmountOut,
      legs.map((l) => ({
        callTo: LIFI_DIAMOND as `0x${string}`,
        approveTo: LIFI_DIAMOND as `0x${string}`,
        sendingAssetId: l.sendingAssetId,
        receivingAssetId: l.receivingAssetId,
        fromAmount: l.fromAmount,
        callData: "0x" as `0x${string}`,
        requiresDeposit: true,
      })),
    ],
  });
}

/** Bridge-shaped calldata via the universal BridgeData tuple. */
function makeBridgeCalldata(opts: {
  sendingAssetId: `0x${string}`;
  receiver: `0x${string}`;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
}): `0x${string}` {
  const argsHex = encodeAbiParameters(
    [LIFI_BRIDGE_DATA_TUPLE, { type: "bytes", name: "_facetData" }],
    [
      {
        transactionId: ("0x" + "22".repeat(32)) as `0x${string}`,
        bridge: "across",
        integrator: "vaultpilot-mcp",
        referrer: ZERO as `0x${string}`,
        sendingAssetId: opts.sendingAssetId,
        receiver: opts.receiver,
        minAmount: opts.minAmount,
        destinationChainId: opts.destinationChainId,
        hasSourceSwaps: opts.hasSourceSwaps,
        hasDestinationCall: false,
      },
      "0xc0de",
    ],
  );
  // Selector for a hypothetical swapAndStartBridgeTokensViaAcross — any
  // non-generic-swap selector routes to the positional bridge decode.
  return ("0xabcdef12" + argsHex.slice(2)) as `0x${string}`;
}

/**
 * Build a same-chain generic-swap quote. `legs` drives both the calldata and
 * the reachability arithmetic; `toAmount`/`minAmountOut` are the output-token
 * (USDT, 6-dec) reference and baked min-out.
 */
function makeGenericQuote(opts: {
  fromAmount: bigint;
  toAmount: bigint;
  minAmountOut: bigint;
  legs: Leg[];
  feeCosts?: Array<Record<string, unknown>>;
}) {
  return {
    action: {
      fromToken: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { address: ETH_USDT, symbol: "USDT", decimals: 6, priceUSD: "1" },
      fromAmount: opts.fromAmount.toString(),
    },
    estimate: {
      toAmount: opts.toAmount.toString(),
      toAmountMin: opts.minAmountOut.toString(),
      executionDuration: 30,
      feeCosts: opts.feeCosts ?? [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: makeGenericSwapCalldata(opts.minAmountOut, opts.legs),
      value: "0",
      gasLimit: "300000",
    },
    tool: "lifi-dex-aggregator",
  };
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  evmClientStub.readContract.mockReset();
  evmClientStub.multicall.mockReset();
  // Source (USDC) + destination (USDT) both 6-dec; allowance high so no approve prepend.
  evmClientStub.readContract.mockImplementation(async (req: { functionName: string }) => {
    if (req.functionName === "allowance") return parseUnits("100000", 6);
    return 6;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const commonArgs = {
  wallet: EVM_WALLET,
  fromChain: "ethereum" as const,
  toChain: "ethereum" as const,
  fromToken: ETH_USDC,
  toToken: ETH_USDT,
  amount: "15000",
};

describe("#685 T1 — deterministic-revert fee case (RED on main)", () => {
  it("re-quotes with fee-padded slippage and returns a reachable min-out", async () => {
    const gross = 15_000_000_000n; // 15,000 USDC (6-dec)
    const net = 14_962_500_000n; // 14,962.5 USDC after 0.25% FeeForwarder skim
    // q1: baked min-out 14,985.917974 USDT — sized off gross, UNREACHABLE.
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_985_917_974n,
      legs: [
        // leg 0: FeeForwarder pass-through USDC→USDC, skims 0.25%
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        // leg 1: real DEX USDC→USDT on the post-skim 14,962.5
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: net },
      ],
      feeCosts: [
        {
          name: "integrator fee",
          description: "",
          percentage: "0.0025",
          token: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
          amount: "37500000",
          amountUSD: "37.5",
          included: true,
        },
      ],
    });
    // q2: widened slippage → baked min-out 14,850 USDT ≤ 14,962.5 (reachable).
    const q2 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_850_000_000n,
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: net },
      ],
    });
    fetchQuoteMock.mockResolvedValueOnce(q1).mockResolvedValueOnce(q2);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap(commonArgs);

    // A second fetchQuote fired (the re-quote), with slippage ≥ default + 0.0025.
    expect(fetchQuoteMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchQuoteMock.mock.calls[1][0] as { slippage?: number };
    expect(secondCall.slippage).toBeGreaterThanOrEqual(0.005 + 0.0025 - 1e-9);

    // Final baked min-out ≤ the net-achievable 14,962.5 USDT.
    const minOut = Number(String(tx.decoded.args.minOut).split(" ")[0]);
    expect(minOut).toBeLessThanOrEqual(14_962.5);
    // Receipt discloses the fee-aware adjustment.
    expect(tx.decoded.args.integratorFeeBps).toBe("25");
  });
});

describe("#685 T2 — decode-proven fee-free route (no needless round-trip)", () => {
  it("ships q1 with a single fetchQuote when the calldata proves no skim", async () => {
    const gross = 15_000_000_000n;
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_925_000_000n, // 0.5% below toAmount, reachable, no fee leg
      legs: [{ sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: gross }],
    });
    fetchQuoteMock.mockResolvedValueOnce(q1);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap(commonArgs);

    expect(fetchQuoteMock).toHaveBeenCalledTimes(1); // no re-quote
    expect(tx.decoded.args.integratorFeeBps).toBeUndefined();
  });
});

describe("#685 T3 — fail-closed on feeCosts:[] but a real calldata skim", () => {
  it("does not ship the first quote when a pass-through fee leg skims (R2-false case)", async () => {
    const gross = 15_000_000_000n;
    const net = 14_962_500_000n;
    // feeCosts EMPTY, but the calldata carries a real FeeForwarder skim.
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_985_917_974n,
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: net },
      ],
      feeCosts: [],
    });
    const q2 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_850_000_000n,
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: net },
      ],
    });
    fetchQuoteMock.mockResolvedValueOnce(q1).mockResolvedValueOnce(q2);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap(commonArgs);

    // The decode drives the fix even with feeCosts empty → re-quote, reachable.
    expect(fetchQuoteMock).toHaveBeenCalledTimes(2);
    const minOut = Number(String(tx.decoded.args.minOut).split(" ")[0]);
    expect(minOut).toBeLessThanOrEqual(14_962.5);
  });
});

describe("#685 T4 — multi-leg: fee leg mid-chain, correctly summed", () => {
  it("sums the intermediate pass-through leg's own-token skim (not a wrong-leg pick)", async () => {
    // [DEX USDC→WETH, pass-through WETH→WETH skim, DEX WETH→USDT]. The skim is
    // in WETH against the WETH leg's own fromAmount — a same-token ratio. A
    // wrong-leg (source-token) pick would read skim 0 and ship an unreachable
    // min-out.
    const gross = 15_000_000_000n; // USDC 6-dec
    const wethMid = 5_000_000_000_000_000_000n; // 5 WETH out of leg 1
    const wethNet = 4_975_000_000_000_000_000n; // 4.975 WETH after 0.5% skim
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_990_000_000n, // ~0.07% applied < 0.5% skim → REQUOTE
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_WETH, fromAmount: gross },
        { sendingAssetId: ETH_WETH, receivingAssetId: ETH_WETH, fromAmount: wethMid },
        { sendingAssetId: ETH_WETH, receivingAssetId: ETH_USDT, fromAmount: wethNet },
      ],
    });
    const q2 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_800_000_000n, // reachable after widening
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_WETH, fromAmount: gross },
        { sendingAssetId: ETH_WETH, receivingAssetId: ETH_WETH, fromAmount: wethMid },
        { sendingAssetId: ETH_WETH, receivingAssetId: ETH_USDT, fromAmount: wethNet },
      ],
    });
    fetchQuoteMock.mockResolvedValueOnce(q1).mockResolvedValueOnce(q2);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap(commonArgs);

    expect(fetchQuoteMock).toHaveBeenCalledTimes(2);
    const secondCall = fetchQuoteMock.mock.calls[1][0] as { slippage?: number };
    // WETH skim ≈ 0.5% → effective slippage ≥ default 0.5% + 0.5%.
    expect(secondCall.slippage).toBeGreaterThanOrEqual(0.005 + 0.005 - 1e-6);
    const minOut = Number(String(tx.decoded.args.minOut).split(" ")[0]);
    expect(minOut).toBeLessThanOrEqual(14_800);
  });
});

describe("#685 T5 — undecodable re-quote REFUSES (catch-all on q2)", () => {
  it("refuses when q1 requotes but q2 classifies as neither generic-swap nor bridge", async () => {
    const gross = 15_000_000_000n;
    const net = 14_962_500_000n;
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_985_917_974n,
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: net },
      ],
    });
    // q2 has an unknown selector — not a generic-swap, not a decodable bridge.
    const q2 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_850_000_000n,
      legs: [{ sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: gross }],
    });
    q2.transactionRequest.data = ("0x1234abcd" + "00".repeat(4)) as `0x${string}`;
    fetchQuoteMock.mockResolvedValueOnce(q1).mockResolvedValueOnce(q2);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(prepareSwap(commonArgs)).rejects.toThrow(/non-generic-swap route/i);
    expect(fetchQuoteMock).toHaveBeenCalledTimes(2);
  });
});

describe("#685 — same-chain REFUSE copy does NOT steer to prepare_custom_call", () => {
  it("an unclassifiable same-chain route refuses without mentioning prepare_custom_call", async () => {
    const gross = 15_000_000_000n;
    const q1 = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_925_000_000n,
      legs: [{ sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: gross }],
    });
    q1.transactionRequest.data = ("0x1234abcd" + "00".repeat(4)) as `0x${string}`;
    fetchQuoteMock.mockResolvedValueOnce(q1);

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(prepareSwap(commonArgs)).rejects.toThrow(/get_swap_quote/i);
    await expect(prepareSwap(commonArgs)).rejects.not.toThrow(/prepare_custom_call/i);
  });
});

const ARB_DAI = "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1"; // 18-dec dest token

function makeBridgeQuote(opts: {
  fromAmount: bigint;
  toAmount: bigint;
  minAmount: bigint;
  sendingAssetId?: `0x${string}`;
  hasSourceSwaps?: boolean;
  feeCosts?: Array<Record<string, unknown>>;
  destinationChainId?: bigint;
  receiver?: `0x${string}`;
}) {
  return {
    action: {
      fromToken: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { address: ARB_DAI, symbol: "DAI", decimals: 18, priceUSD: "1" },
      fromAmount: opts.fromAmount.toString(),
    },
    estimate: {
      toAmount: opts.toAmount.toString(),
      toAmountMin: (opts.toAmount - opts.toAmount / 100n).toString(),
      executionDuration: 120,
      feeCosts: opts.feeCosts ?? [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      data: makeBridgeCalldata({
        sendingAssetId: opts.sendingAssetId ?? (ETH_USDC as `0x${string}`),
        receiver: opts.receiver ?? (EVM_WALLET as `0x${string}`),
        minAmount: opts.minAmount,
        destinationChainId: opts.destinationChainId ?? 42161n, // arbitrum
        hasSourceSwaps: opts.hasSourceSwaps ?? true,
      }),
      value: "0",
      gasLimit: "600000",
    },
    tool: "across",
  };
}

const bridgeArgs = {
  wallet: EVM_WALLET,
  fromChain: "ethereum" as const,
  toChain: "arbitrum" as const,
  fromToken: ETH_USDC,
  toToken: ARB_DAI,
  amount: "15000",
};

describe("#685 T6 — bridge with source-side skim SHIPS status quo + fires the counter", () => {
  beforeEach(() => {
    // USDC (6) on source, DAI (18) on destination — decimals-up bridge.
    evmClientStub.readContract.mockImplementation(
      async (req: { functionName: string; address?: string }) => {
        if (req.functionName === "allowance") return parseUnits("100000", 6);
        return req.address?.toLowerCase() === ARB_DAI.toLowerCase() ? 18 : 6;
      },
    );
  });

  it("ships via the existing bridge path (no re-quote), increments the counter, logs", async () => {
    const swap = await import("../src/modules/swap/index.js");
    swap.resetLifiBridgeSuspectedUnreachableCount();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const gross = 15_000_000_000n; // 15,000 USDC
    // BridgeData.minAmount (source USDC) sized off gross; a 37.5 USDC source
    // skim means only 14,962.5 reaches the bridge → suspected unreachable.
    const q = makeBridgeQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000_000_000_000_000n, // 15,000 DAI (18-dec)
      minAmount: gross, // 15,000 USDC — exceeds the post-skim 14,962.5
      feeCosts: [
        {
          name: "integrator fee",
          token: { address: ETH_USDC, symbol: "USDC", decimals: 6, priceUSD: "1" },
          amount: "37500000",
          included: true,
        },
      ],
    });
    fetchQuoteMock.mockResolvedValueOnce(q);

    const tx = await swap.prepareSwap(bridgeArgs);

    expect(fetchQuoteMock).toHaveBeenCalledTimes(1); // no re-quote, no REFUSE
    expect(tx.description).toContain("Bridge");
    expect(swap.lifiBridgeSuspectedUnreachableCount).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(
      "[vaultpilot-mcp] lifi.bridge_suspected_unreachable",
      expect.objectContaining({ fromChain: "ethereum", toChain: "arbitrum" }),
    );
  });

  it("a bridge with no source-side skim SHIPS and does NOT fire the counter", async () => {
    const swap = await import("../src/modules/swap/index.js");
    swap.resetLifiBridgeSuspectedUnreachableCount();

    const gross = 15_000_000_000n;
    const q = makeBridgeQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000_000_000_000_000n,
      minAmount: 14_900_000_000n, // ≤ fromAmount, no un-absorbed skim
      feeCosts: [],
    });
    fetchQuoteMock.mockResolvedValueOnce(q);

    const tx = await swap.prepareSwap(bridgeArgs);

    expect(fetchQuoteMock).toHaveBeenCalledTimes(1);
    expect(tx.description).toContain("Bridge");
    expect(swap.lifiBridgeSuspectedUnreachableCount).toBe(0);
  });

  it("the bridge signal is source-side only — never a cross-denominated ratio", async () => {
    // Flipping estimate.toAmount across any scale MUST NOT change the flag: the
    // predicate reads only source-denominated operands (proves no
    // minAmount/toAmount ratio is computed on a bridge route).
    const gross = 15_000_000_000n;
    const skimmed = {
      action: { fromToken: { address: ETH_USDC }, fromAmount: gross.toString() },
      estimate: {
        toAmount: "1", // absurdly small
        feeCosts: [
          { token: { address: ETH_USDC }, amount: "37500000", included: true },
        ],
      },
      transactionRequest: {
        data: makeBridgeCalldata({
          sendingAssetId: ETH_USDC as `0x${string}`,
          receiver: EVM_WALLET as `0x${string}`,
          minAmount: gross,
          destinationChainId: 42161n,
          hasSourceSwaps: true,
        }),
      },
    };
    const flagSmall = bridgeSuspectedUnreachable(skimmed, ETH_USDC);
    skimmed.estimate.toAmount = "999999999999999999999999999"; // absurdly large
    const flagLarge = bridgeSuspectedUnreachable(skimmed, ETH_USDC);
    expect(flagSmall).toBe(true);
    expect(flagLarge).toBe(true); // unchanged — source-side only
  });
});

describe("#685 — fixture-replay tally (classifier + gate + bridge signal)", () => {
  it("classifies and gates representative fixtures with the expected tally", () => {
    const gross = 15_000_000_000n;
    // Same-chain single clean → generic SHIP.
    const cleanSingle = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_925_000_000n,
      legs: [{ sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: gross }],
    });
    // Same-chain multi with fee → generic REQUOTE.
    const feeMulti = makeGenericQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000n,
      minAmountOut: 14_985_917_974n,
      legs: [
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDC, fromAmount: gross },
        { sendingAssetId: ETH_USDC, receivingAssetId: ETH_USDT, fromAmount: 14_962_500_000n },
      ],
    });
    // Bridge with source skim → bridge class + counter.
    const bridgeSkim = makeBridgeQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000_000_000_000_000n,
      minAmount: gross,
      feeCosts: [{ token: { address: ETH_USDC }, amount: "37500000", included: true }],
    });
    // Pure bridge, clean → bridge class, no counter.
    const bridgeClean = makeBridgeQuote({
      fromAmount: gross,
      toAmount: 15_000_000_000_000_000_000_000n,
      minAmount: 14_900_000_000n,
      hasSourceSwaps: false,
    });

    let ship = 0;
    let requote = 0;
    let refuse = 0;
    let bridge = 0;
    let bridgeFlagged = 0;
    for (const q of [cleanSingle, feeMulti, bridgeSkim, bridgeClean]) {
      const cls = classifyLifiQuote(q.transactionRequest.data as `0x${string}`);
      if (cls === "generic") {
        const v = vetGenericSwapQuote(q, q.action.fromToken.address);
        if (v.kind === "SHIP") ship++;
        else if (v.kind === "REQUOTE") requote++;
        else refuse++;
      } else if (cls === "bridge") {
        bridge++;
        if (bridgeSuspectedUnreachable(q, q.action.fromToken.address)) bridgeFlagged++;
      } else {
        refuse++;
      }
    }
    // Same-chain generic: near-zero REFUSE. Bridges ship (never REFUSE).
    expect({ ship, requote, refuse, bridge, bridgeFlagged }).toEqual({
      ship: 1,
      requote: 1,
      refuse: 0,
      bridge: 2,
      bridgeFlagged: 1,
    });
  });
});
