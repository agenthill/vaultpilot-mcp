import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { decodeFunctionData, encodeFunctionData } from "viem";
import { erc20Abi } from "../../src/abis/erc20.js";
import { lifiDiamondAbi } from "../../src/abis/lifi-diamond.js";

/**
 * Audit finding R-A1 (Medium): swap exact-in path trusts LiFi's
 * `quote.action.fromAmount` verbatim for the ERC-20 approval bytes and for the
 * swap-tx pull amount, while the human-readable preview text
 * (`description`, `decoded.args`) echoes the user-supplied `args.amount`.
 *
 * There is no server-side assertion that
 *   BigInt(quote.action.fromAmount) === parseUnits(args.amount, decimals)
 * on the exact-in path.
 *
 * A hostile / MITM'd / buggy LiFi response can inflate `fromAmount` (and
 * scale `toAmount` proportionally so `toUsd / fromUsd` stays < 10 and the
 * existing sanity gate does not fire). The server then:
 *   - builds `approve(Diamond, INFLATED)` with description
 *     "Approve {args.amount} ..." (the small, user-visible lie), and
 *   - builds the swap tx with description
 *     "Swap {args.amount} X → ~{quote.toAmount} Y" (same lie on fromDisplay).
 *
 * What you preview ≠ what you sign. This test reproduces the divergence.
 * Fix hypothesis: insert an assert on exact-in that the returned fromAmount
 * equals the parsed user amount (or refuses outside a tight tolerance).
 */

// USDC mainnet, USDT mainnet, LiFi Diamond.
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";

/**
 * A single clean USDC→USDT generic-swap leg (#685 `vetLifiQuote` classifies it
 * as generic-swap and SHIPs). `legFromAmount` matches the quote's
 * `action.fromAmount` so the leg-walk topology passes and the fromAmount-drift
 * guard downstream (not this gate) is what fires on an inflated quote.
 */
function makeCleanSwapCalldata(legFromAmount: bigint, minAmountOut: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: lifiDiamondAbi,
    functionName: "swapTokensSingleV3ERC20ToERC20",
    args: [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      "vaultpilot-mcp",
      "",
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075" as `0x${string}`,
      minAmountOut,
      {
        callTo: LIFI_DIAMOND as `0x${string}`,
        approveTo: LIFI_DIAMOND as `0x${string}`,
        sendingAssetId: USDC as `0x${string}`,
        receivingAssetId: USDT as `0x${string}`,
        fromAmount: legFromAmount,
        callData: "0x" as `0x${string}`,
        requiresDeposit: true,
      },
    ],
  });
}

describe("R-A1 — swap exact-in approval/description divergence (audit)", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.doMock("../../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("refuses exact-in quote whose fromAmount drifts from args.amount (post-fix)", async () => {
    // User asks for exact-in: 100 USDC → USDT.
    // Hostile LiFi returns fromAmount = 10,000 USDC (100× the ask) with
    // proportionally-scaled toAmount so the `toUsd/fromUsd > 10` check
    // does not trigger. Stablecoin pair chosen so the ratio stays near 1.
    //
    // The mitigation is a post-decimals-check invariant in prepareSwap that
    // compares `BigInt(quote.action.fromAmount)` with `parseUnits(args.amount,
    // decimals)` on the exact-in branch. If they differ, refuse to return
    // calldata — the approval + swap bytes would otherwise pull a different
    // amount than the MCP preview displays.
    const INFLATED_FROM_WEI = 10_000_000_000n; // 10,000 USDC at 6 decimals
    const SCALED_TO_WEI = 9_950_000_000n; // 9,950 USDT at 6 decimals (~0.5%)

    vi.doMock("../../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "uniswap",
        action: {
          fromToken: {
            symbol: "USDC",
            decimals: 6,
            address: USDC,
            priceUSD: "1",
          },
          toToken: {
            symbol: "USDT",
            decimals: 6,
            address: USDT,
            priceUSD: "1",
          },
          fromAmount: INFLATED_FROM_WEI.toString(),
        },
        estimate: {
          fromAmount: INFLATED_FROM_WEI.toString(),
          toAmount: SCALED_TO_WEI.toString(),
          toAmountMin: (SCALED_TO_WEI - SCALED_TO_WEI / 200n).toString(),
          approvalAddress: LIFI_DIAMOND,
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
        transactionRequest: {
          to: LIFI_DIAMOND,
          // Real generic-swap calldata whose leg fromAmount matches the
          // (inflated) action.fromAmount, so vetLifiQuote SHIPs and the
          // downstream fromAmount-drift guard is what refuses.
          data: makeCleanSwapCalldata(
            INFLATED_FROM_WEI,
            SCALED_TO_WEI - SCALED_TO_WEI / 200n,
          ),
          value: "0x0",
          gasLimit: "0x30d40",
        },
      }),
      fetchStatus: async () => ({}),
    }));

    // Stub RPC so decimals & allowance reads succeed without a network.
    vi.doMock("../../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "decimals") return 6;
          if (functionName === "allowance") return 0n;
          return 0;
        },
      }),
      resetClients: () => {},
    }));

    const { prepareSwap } = await import("../../src/modules/swap/index.js");

    await expect(
      prepareSwap({
        wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
        fromChain: "ethereum",
        toChain: "ethereum",
        fromToken: USDC,
        toToken: USDT,
        amount: "100", // user asks to swap 100 USDC, exact-in
        // no slippageBps override — defaults to 50 (LiFi default)
      }),
    ).rejects.toThrow(/fromAmount/i);
  });

  it("happy path: matching fromAmount passes the invariant", async () => {
    // Sanity check — a normal LiFi response where fromAmount equals the user's
    // parsed input should produce a valid approval + swap chain as before.
    const MATCHING_FROM_WEI = 100_000_000n; // 100 USDC

    vi.doMock("../../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "uniswap",
        action: {
          fromToken: { symbol: "USDC", decimals: 6, address: USDC, priceUSD: "1" },
          toToken: { symbol: "USDT", decimals: 6, address: USDT, priceUSD: "1" },
          fromAmount: MATCHING_FROM_WEI.toString(),
        },
        estimate: {
          fromAmount: MATCHING_FROM_WEI.toString(),
          toAmount: "99500000",
          toAmountMin: "99000000",
          approvalAddress: LIFI_DIAMOND,
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
        transactionRequest: {
          to: LIFI_DIAMOND,
          data: makeCleanSwapCalldata(MATCHING_FROM_WEI, 99_000_000n),
          value: "0x0",
          gasLimit: "0x30d40",
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async ({ functionName }: { functionName: string }) => {
          if (functionName === "decimals") return 6;
          if (functionName === "allowance") return 0n;
          return 0;
        },
      }),
      resetClients: () => {},
    }));

    const { prepareSwap } = await import("../../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: USDC,
      toToken: USDT,
      amount: "100",
    });

    expect(tx.decoded?.functionName).toBe("approve");
    const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
    const [, amountEncoded] = decoded.args as [`0x${string}`, bigint];
    expect(amountEncoded).toBe(MATCHING_FROM_WEI);
  });

});

// ## Proof Explanation
// 1. The user calls prepare_swap with amount="100" USDC (exact-in).
// 2. A hostile/MITM'd LiFi returns fromAmount=10_000_000_000 (10,000 USDC)
//    and a proportionally scaled toAmount so the existing toUsd/fromUsd > 10
//    sanity check does not trigger.
// 3. prepareSwap's exact-in invariant (added as VP-01 mitigation) asserts
//    `BigInt(quote.action.fromAmount) === BigInt(parseUnits(args.amount, decimals))`
//    right after the decimals cross-check. Any drift throws — no calldata is
//    returned, the user never signs a tx whose bytes pull a different amount
//    than the preview claims.
// 4. The first test asserts the thrown error references `fromAmount`.
// 5. The second test is a happy-path regression: when LiFi's response is
//    honest (fromAmount matches the parsed user input), the approval bytes
//    decode to the correct amount and the flow continues to produce the
//    approve + swap chain.
