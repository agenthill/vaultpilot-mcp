/**
 * Issue #411 — protocol-routing preference on `prepare_swap` /
 * `get_swap_quote`. The user said "swap on 1inch", LiFi silently
 * routed via SushiSwap, and the prepare receipt didn't surface that
 * the named protocol was not honoured.
 *
 * Coverage:
 *   - `exchanges` filter is forwarded to LiFi as `allowExchanges`.
 *   - `bridges` filter is forwarded as `allowBridges`.
 *   - Filter omitted ⇒ LiFi receives no allowExchanges/allowBridges
 *     fields (default routing).
 *   - Response carries a `routedVia` field naming the resolved tool +
 *     whether it matched the requested filter.
 *   - Prepare-tx description includes a routing note when the filter
 *     matched, and a clear MISMATCH note when it didn't.
 *   - LiFi NotFound errors get rephrased to mention the filter so
 *     the agent can offer to retry without it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseUnits, encodeFunctionData } from "viem";
import { lifiDiamondAbi } from "../src/abis/lifi-diamond.js";

const fetchQuoteMock = vi.fn();
vi.mock("../src/modules/swap/lifi.js", () => ({
  fetchQuote: (...args: unknown[]) => fetchQuoteMock(...args),
  fetchStatus: vi.fn(),
  initLifi: () => {},
  LIFI_SOLANA_CHAIN_ID: 1151111081099710,
  fetchSolanaQuote: vi.fn(),
}));

const fetchOneInchMock = vi.fn();
const fetchOneInchSwapMock = vi.fn();
vi.mock("../src/modules/swap/oneinch.js", () => ({
  fetchOneInchQuote: (...args: unknown[]) => fetchOneInchMock(...args),
  fetchOneInchSwap: (...args: unknown[]) => fetchOneInchSwapMock(...args),
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

// Module-level handle for tests that exercise the 1inch fallback path
// (issue #615): tests assign and clear `oneInchKeyOverride` to flip the
// "API key configured" condition without busting the module cache.
let oneInchKeyOverride: string | undefined;
vi.mock("../src/config/user-config.js", () => ({
  readUserConfig: () => (oneInchKeyOverride ? { oneInchApiKey: oneInchKeyOverride } : {}),
  resolveOneInchApiKey: () => oneInchKeyOverride,
}));

const EVM_WALLET = "0x1111111111111111111111111111111111111111";
const ETH_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ETH_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

function makeIntraChainQuote(tool: string) {
  return {
    action: {
      fromToken: {
        address: ETH_USDC,
        symbol: "USDC",
        decimals: 6,
        priceUSD: "1",
      },
      toToken: {
        address: ETH_WETH,
        symbol: "WETH",
        decimals: 18,
        priceUSD: "3000",
      },
      fromAmount: "100000000", // 100 USDC
    },
    estimate: {
      toAmount: "33000000000000000", // 0.033 WETH
      toAmountMin: "32700000000000000",
      executionDuration: 60,
      feeCosts: [],
      gasCosts: [],
      approvalAddress: LIFI_DIAMOND,
    },
    transactionRequest: {
      to: LIFI_DIAMOND,
      // Intra-chain generic-swap calldata: a single clean USDC→WETH leg with
      // no principal skim. `vetLifiQuote` (#685) classifies it as generic-swap
      // and SHIPs it (baked min-out 0.0327 ≤ 0.033 WETH, no fee leg), and
      // `verifyLifiBridgeIntent` returns silently (no BridgeData tuple).
      data: makeCleanIntraChainSwapCalldata(),
      value: "0",
      gasLimit: "200000",
    },
    tool,
  };
}

/** A single clean USDC→WETH generic-swap leg matching `makeIntraChainQuote`. */
function makeCleanIntraChainSwapCalldata(): `0x${string}` {
  return encodeFunctionData({
    abi: lifiDiamondAbi,
    functionName: "swapTokensSingleV3ERC20ToERC20",
    args: [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      "vaultpilot-mcp",
      "",
      EVM_WALLET as `0x${string}`,
      32_700_000_000_000_000n, // baked _minAmountOut = toAmountMin (0.0327 WETH)
      {
        callTo: LIFI_DIAMOND as `0x${string}`,
        approveTo: LIFI_DIAMOND as `0x${string}`,
        sendingAssetId: ETH_USDC as `0x${string}`,
        receivingAssetId: ETH_WETH as `0x${string}`,
        fromAmount: 100_000_000n, // == action.fromAmount (100 USDC)
        callData: "0x" as `0x${string}`,
        requiresDeposit: true,
      },
    ],
  });
}

beforeEach(() => {
  fetchQuoteMock.mockReset();
  fetchOneInchMock.mockReset();
  fetchOneInchSwapMock.mockReset();
  oneInchKeyOverride = undefined;
  evmClientStub.readContract.mockReset();
  evmClientStub.readContract.mockImplementation(
    async (req: { functionName: string; address?: string }) => {
      if (req.functionName === "allowance") return parseUnits("1000", 6);
      if (req.functionName === "decimals") {
        // USDC = 6, WETH = 18 — the on-chain decimals cross-check
        // refuses if these don't match LiFi's reported metadata.
        return req.address?.toLowerCase() === ETH_WETH.toLowerCase() ? 18 : 6;
      }
      return 0;
    },
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("issue #411 — exchanges/bridges filter forwarding", () => {
  it("forwards `exchanges: ['1inch']` to LiFi as allowExchanges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowExchanges).toEqual(["1inch"]);
  });

  it("forwards `bridges` to LiFi as allowBridges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("across"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      bridges: ["across", "stargate"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowBridges).toEqual(["across", "stargate"]);
  });

  it("does NOT set allowExchanges/allowBridges when filter is omitted (default routing preserved)", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowExchanges).toBeUndefined();
    expect(lifiCall.allowBridges).toBeUndefined();
  });
});

describe("issue #411 — routedVia surfacing in getSwapQuote", () => {
  it("response carries `routedVia.tool` matching LiFi's resolved tool", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    expect(out.routedVia.tool).toBe("sushiswap");
    expect(out.routedVia.matchedRequestedExchanges).toBeUndefined();
  });

  it("when filter matches, routedVia.matchedRequestedExchanges = true", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(out.routedVia.tool).toBe("1inch");
    expect(out.routedVia.matchedRequestedExchanges).toBe(true);
    expect(out.routedVia.requestedExchanges).toEqual(["1inch"]);
  });

  it("when filter set but resolved tool is aliased differently, matchedRequestedExchanges = false", async () => {
    // LiFi sometimes exposes a tool name aliased differently from the
    // filter input. Filter forwarding still narrows the routing graph;
    // this just records the post-resolution mismatch so the receipt
    // can flag it.
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("oneinch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const out = await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(out.routedVia.tool).toBe("oneinch");
    expect(out.routedVia.matchedRequestedExchanges).toBe(false);
  });
});

describe("issue #439 — excludeExchanges/excludeBridges/order forwarding", () => {
  it("forwards `excludeExchanges` to LiFi as denyExchanges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("uniswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      excludeExchanges: ["sushiswap", "0x"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.denyExchanges).toEqual(["sushiswap", "0x"]);
    expect(lifiCall.allowExchanges).toBeUndefined();
  });

  it("forwards `excludeBridges` to LiFi as denyBridges", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("across"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      excludeBridges: ["hop"],
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.denyBridges).toEqual(["hop"]);
  });

  it("forwards `order: \"CHEAPEST\"` to LiFi as order", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      order: "CHEAPEST",
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.order).toBe("CHEAPEST");
  });

  it("allows allow-list + deny-list + order to be combined", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("uniswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["uniswap", "1inch"],
      excludeExchanges: ["sushiswap"],
      order: "FASTEST",
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.allowExchanges).toEqual(["uniswap", "1inch"]);
    expect(lifiCall.denyExchanges).toEqual(["sushiswap"]);
    expect(lifiCall.order).toBe("FASTEST");
  });

  it("does NOT set deny lists or order when omitted (defaults preserved)", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await getSwapQuote({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    const lifiCall = fetchQuoteMock.mock.calls[0][0] as Record<string, unknown>;
    expect(lifiCall.denyExchanges).toBeUndefined();
    expect(lifiCall.denyBridges).toBeUndefined();
    expect(lifiCall.order).toBeUndefined();
  });
});

describe("issue #411 — prepareSwap description carries the routing note", () => {
  it("description includes 'via <tool>' even with no filter", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("sushiswap"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
    });
    expect(tx.description).toContain("via sushiswap");
  });

  it("filter matches: description appends '(matched requested exchange filter: ...)'", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("1inch"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(tx.description).toContain("via 1inch");
    expect(tx.description).toMatch(/matched requested exchange filter/);
  });

  it("filter set but resolved tool different: description carries an explicit MISMATCH note", async () => {
    fetchQuoteMock.mockResolvedValue(makeIntraChainQuote("oneinch"));
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });
    expect(tx.description).toContain("via oneinch");
    expect(tx.description).toContain("did not match");
    // Decoded args also carry the mismatch flag for structured consumers.
    expect(tx.decoded?.args.matchedRequestedExchanges).toBe("no");
    expect(tx.decoded?.args.requestedExchanges).toBe("1inch");
  });
});

describe("issue #411 — LiFi no-route error gets rephrased to name the filter", () => {
  it("when filter is set, NotFound error is wrapped with filter context", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("No available routes for the requested swap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/no route satisfying exchanges=\[1inch\]/);
  });

  it("when filter is omitted, LiFi error is passed through unchanged", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("No available routes for the requested swap"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
      }),
    ).rejects.toThrow(/No available routes/);
  });

  it("non-no-route LiFi errors pass through even when filter is set (don't mis-rephrase)", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("rate limit exceeded"));
    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    await expect(
      getSwapQuote({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/rate limit exceeded/);
  });
});

/**
 * Issue #615 — direct 1inch /swap fallback inside `prepareSwap`.
 * Triggers when LiFi rejects an `exchanges: ["1inch"]` filter, the call
 * is intra-EVM + exact-in, and a 1inch API key is configured. Without
 * the key the fallback stays inert and the rephrased LiFi error
 * propagates.
 */
describe("issue #615 — 1inch /swap direct fallback", () => {
  const ONEINCH_ROUTER = "0x111111125421ca6dc452d289314280a0f8842a65";

  function makeOneInchSwapResponse(opts: { dstAmount?: string } = {}) {
    return {
      dstAmount: opts.dstAmount ?? "33000000000000000",
      srcToken: { address: ETH_USDC, symbol: "USDC", decimals: 6 },
      dstToken: { address: ETH_WETH, symbol: "WETH", decimals: 18 },
      tx: {
        from: EVM_WALLET,
        to: ONEINCH_ROUTER,
        data: "0xdeadbeef",
        value: "0",
        gas: 200000,
      },
    };
  }

  it("falls back to 1inch /swap when LiFi fails AND filter is exclusively ['1inch'] AND key is configured", async () => {
    fetchQuoteMock.mockRejectedValue(
      new Error("No available routes for exchanges=[1inch]"),
    );
    fetchOneInchSwapMock.mockResolvedValue(makeOneInchSwapResponse());
    oneInchKeyOverride = "test-key";

    // Allowance returns 0 so the approval leg is emitted.
    evmClientStub.readContract.mockImplementation(
      async (req: { functionName: string; address?: string }) => {
        if (req.functionName === "allowance") return 0n;
        if (req.functionName === "decimals") {
          return req.address?.toLowerCase() === ETH_WETH.toLowerCase() ? 18 : 6;
        }
        return 0;
      },
    );

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: EVM_WALLET,
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: ETH_USDC,
      toToken: ETH_WETH,
      amount: "100",
      exchanges: ["1inch"],
    });

    // Approval leg first — spender is the 1inch Router.
    expect(tx.to.toLowerCase()).toBe(ETH_USDC.toLowerCase());
    expect(tx.decoded?.functionName).toBe("approve");
    type WithNext = typeof tx & { next?: typeof tx };
    let cur: typeof tx = tx;
    while ((cur as WithNext).next !== undefined) cur = (cur as WithNext).next!;
    expect(cur.to.toLowerCase()).toBe(ONEINCH_ROUTER);
    expect(cur.decoded?.functionName).toBe("1inch_swap_v6");
    expect(cur.description).toContain("via 1inch direct");
  });

  it("does NOT fall back when filter contains a second exchange (1inch is not exclusive)", async () => {
    fetchQuoteMock.mockRejectedValue(
      new Error("No available routes for the requested swap"),
    );
    oneInchKeyOverride = "test-key";

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch", "uniswap"],
      }),
    ).rejects.toThrow(/no route satisfying/);
    expect(fetchOneInchSwapMock).not.toHaveBeenCalled();
  });

  it("does NOT fall back when no 1inch API key is configured", async () => {
    fetchQuoteMock.mockRejectedValue(
      new Error("No available routes for the requested swap"),
    );
    // resolveOneInchApiKey is already returning undefined via the
    // top-of-file mock — no override needed.
    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/no route satisfying/);
    expect(fetchOneInchSwapMock).not.toHaveBeenCalled();
  });

  it("does NOT fall back for exact-out (1inch v6 has no toAmount endpoint)", async () => {
    fetchQuoteMock.mockRejectedValue(
      new Error("No available routes for the requested swap"),
    );
    oneInchKeyOverride = "test-key";

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        amountSide: "to",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/no route satisfying/);
    expect(fetchOneInchSwapMock).not.toHaveBeenCalled();
  });

  it("surfaces both errors when 1inch fallback also fails", async () => {
    fetchQuoteMock.mockRejectedValue(new Error("LiFi NotFoundError"));
    fetchOneInchSwapMock.mockRejectedValue(new Error("1inch 400: bad pair"));
    oneInchKeyOverride = "test-key";

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    await expect(
      prepareSwap({
        wallet: EVM_WALLET,
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: ETH_USDC,
        toToken: ETH_WETH,
        amount: "100",
        exchanges: ["1inch"],
      }),
    ).rejects.toThrow(/LiFi:.*1inch:/);
  });
});
