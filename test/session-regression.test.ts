import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAddress, encodeFunctionData } from "viem";
import { CONTRACTS } from "../src/config/contracts.js";
import { lifiDiamondAbi } from "../src/abis/lifi-diamond.js";

/**
 * A single clean USDC→WETH generic-swap leg (280 USDC → 0.1 WETH, baked
 * min-out 0.0995 WETH) — #685 `vetLifiQuote` classifies it as generic-swap and
 * SHIPs (no principal skim, min-out ≤ toAmount). Replaces the pre-#685
 * `0xdeadbeef` placeholder, which now classifies as an unknown facet and is
 * refused before the approval-sizing logic under test runs.
 */
function makeCleanUsdcWethSwapCalldata(): `0x${string}` {
  return encodeFunctionData({
    abi: lifiDiamondAbi,
    functionName: "swapTokensSingleV3ERC20ToERC20",
    args: [
      ("0x" + "11".repeat(32)) as `0x${string}`,
      "vaultpilot-mcp",
      "",
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075" as `0x${string}`,
      99_500_000_000_000_000n, // baked _minAmountOut = toAmountMin (0.0995 WETH)
      {
        callTo: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as `0x${string}`,
        approveTo: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE" as `0x${string}`,
        sendingAssetId: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as `0x${string}`,
        receivingAssetId: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2" as `0x${string}`,
        fromAmount: 280_000_000n, // == action.fromAmount (280 USDC)
        callData: "0x" as `0x${string}`,
        requiresDeposit: true,
      },
    ],
  });
}

/**
 * Regression tests that mirror the calls made during a live Claude Code session where
 * three production bugs were uncovered:
 *   1. EigenLayer delegationManager address failed viem's EIP-55 checksum validation.
 *   2. Aave V3 get_lending_positions crashed on Arbitrum because the UiPoolDataProvider
 *      struct shape had drifted (stable-rate fields removed in 3.2). Aggregate totals
 *      (HF, collateral, debt) come from Pool.getUserAccountData and were still valid —
 *      we should keep them and just skip the per-reserve breakdown.
 *   3. get_compound_positions failed when ANY market in the registry reverted — one bad
 *      market address blew up the entire call. Should be best-effort per market.
 *
 * These are unit-level regression tests: we mock the viem PublicClient so we don't need
 * a live RPC. Each test asserts the bug's specific failure mode is now handled.
 */

describe("Bug 1: all registered contract addresses have valid EIP-55 checksums", () => {
  // viem's readContract calls getAddress() on the `to` field and throws InvalidAddressError
  // if the checksum is wrong. Every address in our registry must round-trip through
  // getAddress(). This would have caught the EigenLayer `F37A` typo at test time.
  const walk = (obj: unknown, path: string[] = []): Array<[string, string]> => {
    const out: Array<[string, string]> = [];
    if (typeof obj === "string" && /^0x[0-9a-fA-F]{40}$/.test(obj)) {
      out.push([path.join("."), obj]);
    } else if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        out.push(...walk(v, [...path, k]));
      }
    }
    return out;
  };

  const entries = walk(CONTRACTS);

  it("registry has at least a dozen addresses (sanity)", () => {
    expect(entries.length).toBeGreaterThan(12);
  });

  it.each(entries)("%s (%s) passes EIP-55 checksum", (_path, addr) => {
    // Passes if getAddress(addr) === addr. Throws otherwise.
    expect(getAddress(addr)).toBe(addr);
  });
});

describe("Bug 2: Aave lending returns aggregate-only when UiPoolDataProvider ABI drifts", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns aggregate position (HF, totals, LTV) even if getUserReservesData throws", async () => {
    // Mock getClient to return a client whose Pool.getUserAccountData succeeds but
    // UiPoolDataProvider reads throw (simulating ABI mismatch). After the
    // ABI-drift refactor, UiPoolDataProvider reads go through `client.call`
    // (raw eth_call + decode-by-trial), not `client.readContract`.
    const { _resetAaveAbiCacheForTest } = await import(
      "../src/abis/aave-ui-pool-data-provider.js"
    );
    _resetAaveAbiCacheForTest();
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        if (params.functionName === "getUserAccountData") {
          // [collateralBase, debtBase, availableBorrows, liqThreshold, ltv, healthFactor]
          // 10,000 USD collateral, 5,000 debt, 8250 bps liqThresh, 8000 LTV, HF=1.65e18.
          return [
            1_000_000_000_000n,
            500_000_000_000n,
            300_000_000_000n,
            8250n,
            8000n,
            1_650_000_000_000_000_000n,
          ];
        }
        throw new Error(`unexpected readContract: ${params.functionName}`);
      }),
      call: vi.fn(async () => {
        throw new Error(
          `Bytes value "..." is not a valid boolean.`,
        );
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const pos = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "arbitrum"
    );
    expect(pos).not.toBeNull();
    expect(pos!.totalCollateralUsd).toBe(10_000);
    expect(pos!.totalDebtUsd).toBe(5_000);
    expect(pos!.healthFactor).toBeCloseTo(1.65, 2);
    expect(pos!.ltv).toBe(8000);
    expect(pos!.liquidationThreshold).toBe(8250);
    // Per-reserve breakdown degraded to empty — acceptable fallback.
    expect(pos!.collateral).toEqual([]);
    expect(pos!.debt).toEqual([]);
  });

  it("returns null when the user has no Aave activity (totals are zero)", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        if (params.functionName === "getUserAccountData") {
          return [0n, 0n, 0n, 0n, 0n, 0n];
        }
        throw new Error("should not be called when totals are zero");
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const pos = await getAaveLendingPosition(
      "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      "ethereum"
    );
    expect(pos).toBeNull();
  });
});

describe("Bug 4: EigenLayer revert does not crash getStakingPositions", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns [] when StrategyManager.getDeposits reverts", async () => {
    // Regression: we previously called `stakerStrategyList(address)` — a signature that
    // doesn't exist (the public mapping's auto-getter is (address, uint256)), so the call
    // reverts with no data. Even after switching to the correct `getDeposits`, contract
    // upgrades or RPC flakiness shouldn't blow up the whole portfolio call.
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error(
          `The contract function "getDeposits" reverted.\nDetails: execution reverted`
        );
      }),
      multicall: vi.fn(),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getEigenLayerPositions } = await import("../src/modules/staking/eigenlayer.js");
    const positions = await getEigenLayerPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075"
    );
    expect(positions).toEqual([]);
  });

  it("returns [] when a user has no EigenLayer deposits (empty strategies array)", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getDeposits") {
          return [[], []]; // empty strategies + shares
        }
        if (params.functionName === "delegatedTo") {
          return "0x0000000000000000000000000000000000000000";
        }
        throw new Error(`unexpected: ${params.functionName}`);
      }),
      multicall: vi.fn(),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));

    const { getEigenLayerPositions } = await import("../src/modules/staking/eigenlayer.js");
    const positions = await getEigenLayerPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075"
    );
    expect(positions).toEqual([]);
    expect(mockClient.multicall).not.toHaveBeenCalled();
  });
});

describe("Bug 3: Compound positions isolate per-market read failures", () => {
  beforeEach(() => {
    vi.resetModules();
    // These tests mock the readMarketPosition multicall shape directly;
    // bypass the #88 exposure probe so the mock's 4-call response layout
    // stays valid without having to re-mock a 2N-call probe first.
    process.env.VAULTPILOT_COMPOUND_FULL_READ = "1";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_COMPOUND_FULL_READ;
  });

  it("reads healthy markets successfully while flagging the failing one via the errored list (one bad market doesn't nuke the whole call)", async () => {
    // Market 1's baseToken read fails — previously we silently skipped this
    // case, which was how issue #34 hid a six-figure cUSDCv3 supply. Now
    // readMarketPosition throws on ANY of {baseToken, balanceOf,
    // borrowBalanceOf} failing, getCompoundPositions collects the throw via
    // allSettled, and healthy markets still return.
    let callCount = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callCount++;
        if (contracts.length === 4) {
          if (callCount === 1) {
            return [
              { status: "failure", error: new Error("returned no data") },
              { status: "success", result: 0 },
              { status: "success", result: 0n },
              { status: "success", result: 0n },
            ];
          }
          if (callCount === 2) {
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 0 },
              { status: "success", result: 2_000_000_000n },
              { status: "success", result: 0n },
            ];
          }
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        return [
          { status: "success", result: 6 },
          { status: "success", result: "USDC" },
        ];
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const result = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    // Healthy market with a position still returns.
    expect(result.positions.length).toBeGreaterThanOrEqual(1);
    expect(result.positions[0].baseSupplied?.symbol).toBe("USDC");
    expect(result.positions[0].baseSupplied?.formatted).toBe("2000");
    // The failing market is surfaced rather than silently dropped.
    expect(result.errored).toBe(true);
    expect(result.erroredMarkets!.length).toBeGreaterThanOrEqual(1);
    expect(result.erroredMarkets![0].error).toMatch(/baseToken/);
  });
});

describe("Bug 4: RPC transport batching is opt-in (public endpoints mishandle batched POSTs)", () => {
  // We don't have a clean hook to intercept viem.http from inside the test runner, so
  // we assert directly on the source: batching must be env-gated, not unconditional.
  it("rpc.ts gates batching on RPC_BATCH env, with batch:false as default path", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("../src/data/rpc.ts", import.meta.url), "utf8");
    expect(src).toMatch(/process\.env\.RPC_BATCH/);
    // Must NOT have an unconditional `batch: true,`
    expect(src).not.toMatch(/\bbatch:\s*true\s*,/);
  });
});

describe("Bug 5: Aave reader returns null on 0x / transient RPC failures (not throws)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("getAaveLendingPosition returns null when getPool returns 0x (simulated as throw)", async () => {
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const result = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toBeNull();
  });

  it("getAaveLendingPosition returns null when getUserAccountData returns 0x", async () => {
    const mockClient = {
      readContract: vi.fn(async (params: { functionName: string }) => {
        if (params.functionName === "getPool") {
          return "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
        }
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getAaveLendingPosition } = await import("../src/modules/positions/aave.js");
    const result = await getAaveLendingPosition(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toBeNull();
  });
});

describe("Bug 6: Uniswap V3 reader returns [] on transient RPC failures (not throws)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns [] when NPM.balanceOf throws", async () => {
    const mockClient = {
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
      multicall: vi.fn(async () => []),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    const { getUniswapPositions } = await import("../src/modules/positions/uniswap.js");
    const result = await getUniswapPositions(
      "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      "ethereum"
    );
    expect(result).toEqual([]);
  });
});

describe("Bug 7: Portfolio summary degrades gracefully when subqueries fail", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns a valid summary with zeroed sub-totals when Aave/LP/staking all throw", async () => {
    // Native + ERC-20 balance path still works; every position reader throws.
    const mockClient = {
      getBalance: vi.fn(async () => 1_000_000_000_000_000_000n), // 1 ETH
      multicall: vi.fn(async () => []), // no ERC-20 positions
      readContract: vi.fn(async () => {
        throw new Error('returned no data ("0x")');
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 2000,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });
    // Force every position module to throw.
    vi.doMock("../src/modules/positions/index.js", () => ({
      getLendingPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
      getLpPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
    }));
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: async () => {
        throw new Error('returned no data ("0x")');
      },
    }));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>> & { walletBalancesUsd: number };

    // Native balance priced at $2000 should survive; the three position readers zero out.
    expect(summary.walletBalancesUsd).toBe(2000);
    expect(summary.lendingNetUsd).toBe(0);
    expect(summary.lpUsd).toBe(0);
    expect(summary.stakingUsd).toBe(0);
    expect(summary.totalUsd).toBe(2000);
  });
});

describe("Bug 8: Compound V3 reader surfaces base balance even when a getAssetInfo call fails", () => {
  // Reproduces the live-session bug where wallet C0f5...4075 had 184874 cUSDCv3
  // supplied but get_compound_positions returned an empty array. Root cause: the
  // downstream metaCalls multicall used allowFailure:false, so one flaky getAssetInfo
  // (out of ~8 collateral assets) threw → outer .catch(() => null) swallowed → the
  // whole healthy position disappeared. Fix: allowFailure:true everywhere downstream.
  beforeEach(() => {
    vi.resetModules();
    // Bug 7 above mocks the compound module; clear that so we exercise the real reader.
    vi.doUnmock("../src/modules/compound/index.js");
    // Bypass the #88 exposure probe; mocks below target readMarketPosition's
    // 4-call multicall shape directly.
    process.env.VAULTPILOT_COMPOUND_FULL_READ = "1";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_COMPOUND_FULL_READ;
  });

  it("returns the supplied base balance when one collateral's getAssetInfo reverts", async () => {
    let callIdx = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callIdx++;
        // Only simulate ONE market (ethereum cUSDCv3); ignore additional ones.
        if (contracts.length === 4) {
          if (callIdx === 1) {
            // Baseline reads: healthy base supply, 3 collateral assets declared.
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 3 },
              { status: "success", result: 184_874_394_340n },
              { status: "success", result: 0n },
            ];
          }
          // Any further market reads: empty so the outer loop filters them out.
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        // Meta multicall: decimals + symbol for base, then 3 getAssetInfo calls.
        // Simulate that the MIDDLE getAssetInfo reverts (the bug's trigger).
        if ((contracts[0] as { functionName: string }).functionName === "decimals") {
          return [
            { status: "success", result: 6 },
            { status: "success", result: "USDC" },
            {
              status: "success",
              result: { asset: "0xbe9895146f7AF43049ca1c1AE358B0541Ea49704" as const },
            },
            { status: "failure", error: new Error('returned no data ("0x")') },
            {
              status: "success",
              result: { asset: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as const },
            },
          ];
        }
        // Collateral balances multicall: 2 surviving assets * 3 calls each.
        // Both have zero balance → we just want to confirm base survives.
        return Array.from({ length: contracts.length }, (_, i) => {
          const mod = i % 3;
          if (mod === 0) return { status: "success", result: 0n };
          if (mod === 1) return { status: "success", result: 18 };
          return { status: "success", result: "COL" };
        });
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const { positions } = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    expect(positions.length).toBeGreaterThanOrEqual(1);
    const ethMarket = positions.find((p) => p.chain === "ethereum");
    expect(ethMarket).toBeDefined();
    expect(ethMarket!.baseSupplied?.symbol).toBe("USDC");
    expect(ethMarket!.baseSupplied?.formatted).toBe("184874.39434");
  });

  it("surfaces a nonzero-base-balance decimals-read failure via the errored flag (issue #36)", async () => {
    // Live-session bug: wallet C0f5...4075 held 184377 USDC in cUSDCv3, but
    // get_portfolio_summary rendered it as ~0.0000002 USDC because the base
    // token's decimals() multicall entry transiently failed and the code fell
    // back to decimals=18. A 6-decimal USDC supply formatted as 18 decimals
    // looks like dust. PR #35 blocked the wrong-scale number but still
    // `return null`'d — the aggregator then reported clean coverage with the
    // six-figure supply silently missing. Issue #36: throw instead so the
    // Promise.allSettled wrapper classifies the market as errored.
    let callIdx = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callIdx++;
        if (contracts.length === 4) {
          if (callIdx === 1) {
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 0 },
              { status: "success", result: 184_377_830_000n },
              { status: "success", result: 0n },
            ];
          }
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        if ((contracts[0] as { functionName: string }).functionName === "decimals") {
          // decimals() fails; symbol() also flaky. This is the transient condition.
          return [
            { status: "failure", error: new Error('returned no data ("0x")') },
            { status: "failure", error: new Error('returned no data ("0x")') },
          ];
        }
        return [];
      }),
    };

    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const result = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    const ethMarket = result.positions.find((p) => p.chain === "ethereum");
    expect(ethMarket).toBeUndefined();
    expect(result.errored).toBe(true);
    expect(result.erroredMarkets).toBeDefined();
    const ethFailure = result.erroredMarkets!.find(
      (m) => m.chain === "ethereum" && /decimals read failed/i.test(m.error),
    );
    expect(ethFailure).toBeDefined();
  });
});

describe("Bug 9: Portfolio summary aggregates Compound alongside Aave", () => {
  // Live bug: user held 184874 cUSDCv3 but get_portfolio_summary showed $0 lending because
  // only Aave was wired into the aggregator. Fix wires getCompoundPositions in parallel
  // and merges into the `lending` bucket.
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("includes Compound netValueUsd in lendingNetUsd and per-chain totals", async () => {
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        getBalance: async () => 0n,
        multicall: async () => [],
        readContract: async () => {
          throw new Error("no data");
        },
      }),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => 0,
      getTokenPrices: async () => new Map(),
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });
    // Aave returns nothing; Compound returns one ethereum position worth $184874.
    vi.doMock("../src/modules/positions/index.js", () => ({
      getLendingPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
      getLpPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
      }),
    }));
    vi.doMock("../src/modules/compound/index.js", () => ({
      getCompoundPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [
          {
            protocol: "compound-v3" as const,
            chain: "ethereum" as const,
            market: "cUSDCv3",
            marketAddress: "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as `0x${string}`,
            baseSupplied: null,
            baseBorrowed: null,
            collateral: [],
            totalCollateralUsd: 0,
            totalDebtUsd: 0,
            totalSuppliedUsd: 184874,
            netValueUsd: 184874,
          },
        ],
      }),
    }));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum", "arbitrum"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>>;

    // Single-wallet summary → has a breakdown.
    const single = summary as Extract<typeof summary, { breakdown: unknown }>;
    expect(single.lendingNetUsd).toBe(184874);
    expect(single.perChain.ethereum).toBe(184874);
    expect(single.perChain.arbitrum).toBe(0);
    expect(single.totalUsd).toBe(184874);
    expect(single.breakdown.lending).toHaveLength(1);
    expect(single.breakdown.lending[0].protocol).toBe("compound-v3");
  });
});

describe("Bug 10: LiFi fee cost aggregation ignores amountUSD when it contradicts amount*priceUSD", () => {
  // Live session: a 100 USDC → Polygon bridge reported feeCostsUsd ≈ $249,940. LiFi
  // returned feeCosts[0].amountUSD as "249940000" (raw 6-decimal token units) while the
  // token price and amount said the real fee was ~$0.25. Reading amountUSD verbatim
  // inflated the number by 6 orders of magnitude. Fix: derive USD from amount + priceUSD
  // when both are available and clamp stated amountUSD that disagrees by more than 10×.
  beforeEach(() => {
    vi.resetModules();
    // Isolate from a dev-machine 1inch key so these tests don't hit the network.
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("prefers amount*priceUSD over amountUSD when amountUSD is raw-units-shaped", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "polygon-pos-bridge",
        action: {
          fromToken: { symbol: "USDC", decimals: 6 },
          toToken: { symbol: "USDC.e", decimals: 6 },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          toAmount: "99750000",
          toAmountMin: "99500000",
          executionDuration: 1140,
          feeCosts: [
            {
              // The bug: amountUSD is actually raw token units. Derived USD (~$0.25) is
              // ~6 orders of magnitude smaller — must be preferred.
              amountUSD: "249940000",
              amount: "250000",
              token: { decimals: 6, priceUSD: "1" },
            },
          ],
          gasCosts: [
            {
              amountUSD: "0.14",
              amount: "50000000000000000",
              token: { decimals: 18, priceUSD: "2800" },
            },
          ],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async () => 6,
      }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "polygon",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      amount: "100",
    });

    // Fee should be $0.25 (the derived value), not $249,940,000.
    expect(quote.feeCostsUsd).toBeCloseTo(0.25, 2);
    // Gas stated USD ($0.14) roughly matches derived ($0.14), so we accept the stated value.
    expect(quote.gasCostsUsd).toBeCloseTo(0.14, 2);
  });

  it("falls back to amountUSD when token priceUSD is missing", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-dex",
        action: {
          fromToken: { symbol: "WETH", decimals: 18 },
          toToken: { symbol: "DAI", decimals: 18 },
          fromAmount: "1000000000000000000",
        },
        estimate: {
          fromAmount: "1000000000000000000",
          toAmount: "2800000000000000000000",
          toAmountMin: "2790000000000000000000",
          executionDuration: 30,
          feeCosts: [
            {
              amountUSD: "1.5",
              amount: "500000000000000",
              // No token.priceUSD → derivation impossible → trust amountUSD.
              token: { decimals: 18 },
            },
          ],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async () => 18,
      }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "native",
      toToken: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      amount: "1",
    });
    expect(quote.feeCostsUsd).toBeCloseTo(1.5, 2);
  });
});

describe("Bug 11: LiFi toAmount scale check — re-derive displayed output when it implies >10× input USD", () => {
  // Live session: a 100 USDC → WBTC swap came back with toAmount=128815483595 at
  // 8 decimals — i.e. the tool claimed the user would receive 1288.15 WBTC for $100.
  // With WBTC priced around $70k, that implies ~$90M of output for $100 of input, which
  // is obviously an aggregator scaling bug. The MCP must not display that number
  // verbatim: instead re-derive toAmountExpected / toAmountMin from token prices and
  // attach a warning telling the caller not to sign a prepared tx built from this quote.
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/modules/compound/index.js");
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
  });
  afterEach(() => vi.restoreAllMocks());

  it("re-derives toAmountExpected from prices and emits a warning when output USD >10× input USD", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-aggregator",
        action: {
          fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
          toToken: { symbol: "WBTC", decimals: 8, priceUSD: "70588" },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          // 128815483595 at 8 decimals = 1288.15483595 WBTC — the bug.
          toAmount: "128815483595",
          toAmountMin: "127527328759",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      amount: "100",
    });

    // Expected output derived from prices: 100 / 70588 ≈ 0.001416 WBTC.
    expect(Number(quote.toAmountExpected)).toBeCloseTo(100 / 70588, 6);
    // Min preserves the route's stated slippage ratio (~0.99).
    const ratio = 127527328759 / 128815483595;
    expect(Number(quote.toAmountMin)).toBeCloseTo((100 / 70588) * ratio, 6);
    // USD of output should be the input USD, not the inflated stated value.
    expect(quote.toAmountUsd).toBeCloseTo(100, 2);
    expect(quote.fromAmountUsd).toBeCloseTo(100, 2);
    // Warning must be present so the model/user doesn't sign a prepared tx built from this quote.
    expect(quote.warning).toBeDefined();
    expect(quote.warning).toMatch(/Do NOT sign/i);
  });

  it("passes the quote through unchanged when output USD is within a sane range of input USD", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "some-aggregator",
        action: {
          fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
          toToken: { symbol: "WBTC", decimals: 8, priceUSD: "70588" },
          fromAmount: "100000000",
        },
        estimate: {
          fromAmount: "100000000",
          // 0.001416 WBTC — the correct expected output.
          toAmount: "141600",
          toAmountMin: "140184",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      amount: "100",
    });

    expect(Number(quote.toAmountExpected)).toBeCloseTo(0.001416, 6);
    expect(quote.warning).toBeUndefined();
  });
});

describe("Feature: intra-chain swap quote compares LiFi against 1inch", () => {
  // Users often ask "is this the best price?" — for intra-chain swaps we can answer
  // by also quoting 1inch and returning a side-by-side comparison. The aggregator
  // with the higher output amount is flagged as `bestSource`; cross-chain swaps
  // skip 1inch entirely (it has no bridge support).
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  const lifiQuoteBody = {
    tool: "uniswap",
    action: {
      fromToken: { symbol: "USDC", decimals: 6, priceUSD: "1" },
      toToken: { symbol: "WETH", decimals: 18, priceUSD: "3500" },
      fromAmount: "1000000000", // 1000 USDC
    },
    estimate: {
      fromAmount: "1000000000",
      // 1000 USDC at $3500/ETH = 0.2857 WETH. LiFi returns 0.2850 WETH.
      toAmount: "285000000000000000",
      toAmountMin: "284000000000000000",
      executionDuration: 30,
      feeCosts: [],
      gasCosts: [],
    },
  };

  it("flags 1inch as bestSource when its output exceeds LiFi's", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => ({
        // 1inch returns 0.2865 WETH — slightly better than LiFi.
        dstAmount: "286500000000000000",
        dstToken: { address: "0x0", symbol: "WETH", decimals: 18 },
        gas: 180000,
      }),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(quote.alternatives).toBeDefined();
    expect(quote.alternatives).toHaveLength(1);
    const alt = quote.alternatives![0] as { source: string; toAmountExpected: string; toAmountUsd?: number; gasEstimate?: number };
    expect(alt.source).toBe("1inch");
    expect(Number(alt.toAmountExpected)).toBeCloseTo(0.2865, 4);
    expect(alt.toAmountUsd).toBeCloseTo(0.2865 * 3500, 1);
    expect(alt.gasEstimate).toBe(180000);
    expect(quote.bestSource).toBe("1inch");
    // (0.2865 - 0.285) / 0.285 ≈ 0.526% better.
    expect(quote.savingsVsLifi!.outputDeltaPct).toBeCloseTo(0.526, 2);
    expect(quote.savingsVsLifi!.outputDeltaUsd).toBeCloseTo((0.2865 - 0.285) * 3500, 2);
  });

  it("flags LiFi as bestSource when 1inch's output is worse", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => ({
        // 1inch returns 0.2800 WETH — worse than LiFi's 0.285.
        dstAmount: "280000000000000000",
        dstToken: { address: "0x0", symbol: "WETH", decimals: 18 },
      }),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(quote.bestSource).toBe("lifi");
    expect(quote.savingsVsLifi!.outputDeltaPct).toBeLessThan(0);
  });

  it("skips 1inch entirely for cross-chain swaps", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      // Even with a key configured, cross-chain must not call 1inch.
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    const oneInchSpy = vi.fn();
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: oneInchSpy,
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "polygon",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
      amount: "1000",
    });

    expect(oneInchSpy).not.toHaveBeenCalled();
    expect(quote.alternatives).toBeUndefined();
    expect(quote.bestSource).toBeUndefined();
    expect(quote.crossChain).toBe(true);
  });

  it("skips 1inch when no API key is configured", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => undefined,
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    const oneInchSpy = vi.fn();
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: oneInchSpy,
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    expect(oneInchSpy).not.toHaveBeenCalled();
    expect(quote.alternatives).toBeUndefined();
    expect(quote.bestSource).toBeUndefined();
  });

  it("surfaces a 1inch error as an alternatives entry without failing the whole quote", async () => {
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => null,
      resolveOneInchApiKey: () => "test-key",
    }));
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => lifiQuoteBody,
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async () => {
        throw new Error("1inch quote 401: Unauthorized");
      },
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "1000",
    });

    // LiFi result still present.
    expect(Number(quote.toAmountExpected)).toBeCloseTo(0.285, 3);
    expect(quote.alternatives).toHaveLength(1);
    const alt = quote.alternatives![0] as { source: string; error?: string };
    expect(alt.source).toBe("1inch");
    expect(alt.error).toMatch(/401/);
    // No bestSource when the comparison couldn't run.
    expect(quote.bestSource).toBeUndefined();
  });
});

describe("Bug 13: exact-out swap quotes (amountSide: 'to')", () => {
  // When the user asks for "~100 USDC output", the schema's `amount` is interpreted
  // as the toToken amount and passed to LiFi's toAmount endpoint. The 1inch comparison
  // is skipped because 1inch v6 has no exact-out route — comparing apples to oranges
  // would mislead route-selection. Approval sizing must come from the quote's
  // returned fromAmount, not the user-supplied (toToken) amount.
  beforeEach(() => {
    vi.resetModules();
    vi.doUnmock("../src/modules/compound/index.js");
    vi.doMock("../src/config/user-config.js", () => ({
      readUserConfig: () => ({ apiKeys: { oneinch: "test-key" } }),
      resolveOneInchApiKey: () => "test-key",
    }));
  });

  it("passes toAmount (not fromAmount) to LiFi and skips the 1inch comparison", async () => {
    const lifiCalls: unknown[] = [];
    const oneInchCalls: unknown[] = [];
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async (req: unknown) => {
        lifiCalls.push(req);
        return {
          tool: "uniswap",
          action: {
            fromToken: {
              symbol: "WETH",
              decimals: 18,
              address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
              priceUSD: "2800",
            },
            toToken: {
              symbol: "USDC",
              decimals: 6,
              address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              priceUSD: "1",
            },
            fromAmount: "35714285714285714", // ~0.0357 WETH
          },
          estimate: {
            fromAmount: "35714285714285714",
            toAmount: "100000000", // 100 USDC
            toAmountMin: "99500000",
            executionDuration: 30,
            feeCosts: [],
            gasCosts: [],
          },
        };
      },
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/modules/swap/oneinch.js", () => ({
      fetchOneInchQuote: async (req: unknown) => {
        oneInchCalls.push(req);
        return {};
      },
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ readContract: async () => 6 }),
      resetClients: () => {},
    }));

    const { getSwapQuote } = await import("../src/modules/swap/index.js");
    const quote = await getSwapQuote({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      toToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      amount: "100",
      amountSide: "to",
    });

    expect(lifiCalls).toHaveLength(1);
    const lifiReq = lifiCalls[0] as { toAmount?: string; fromAmount?: string };
    expect(lifiReq.toAmount).toBe("100000000");
    expect(lifiReq.fromAmount).toBeUndefined();
    // 1inch has no exact-out endpoint → comparison must be skipped.
    expect(oneInchCalls).toHaveLength(0);
    expect(quote.alternatives).toBeUndefined();
    expect(Number(quote.toAmountExpected)).toBeCloseTo(100, 6);
  });

  it("sizes the ERC-20 approval from the quote's fromAmount padded by slippage, not the user-supplied toAmount", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "uniswap",
        action: {
          fromToken: {
            symbol: "USDC",
            decimals: 6,
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            priceUSD: "1",
          },
          toToken: {
            symbol: "WETH",
            decimals: 18,
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            priceUSD: "2800",
          },
          // Need ~280 USDC to produce 0.1 WETH.
          fromAmount: "280000000",
        },
        estimate: {
          fromAmount: "280000000",
          toAmount: "100000000000000000", // 0.1 WETH
          toAmountMin: "99500000000000000",
          approvalAddress: "0x1111111254EEB25477B68fb85Ed929f73A960582",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
        transactionRequest: {
          to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
          data: makeCleanUsdcWethSwapCalldata(),
          value: "0x0",
          gasLimit: "0x30d40",
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async ({
          functionName,
          address,
        }: {
          functionName: string;
          address: string;
        }) => {
          if (functionName === "decimals") {
            // USDC=6, WETH=18.
            return address.toLowerCase() ===
              "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
              ? 6
              : 18;
          }
          if (functionName === "allowance") return 0n;
          return 0;
        },
      }),
      resetClients: () => {},
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "0.1",
      amountSide: "to",
      slippageBps: 100, // 1%
    });

    // First tx in the chain is the approval (ERC-20 input, no existing allowance).
    expect(tx.decoded?.functionName).toBe("approve");
    // Approval must cover quote.fromAmount * (1 + slippage). At 1% slippage: 280 → 282.8.
    // The cap is shown with a ≤ prefix so the user knows it is a ceiling, not an exact pull.
    expect(tx.decoded?.args?.amount).toBe("≤282.8 USDC");
    // Swap tx description still shows the *expected* input (not the cap) so the user sees
    // the route's quoted price, with the approval cap separately on the approve tx.
    expect(tx.next?.description).toContain("~280 USDC → 0.1 WETH");
  });

  it("exact-in approval sizing is unchanged (exact amount, no slippage padding)", async () => {
    vi.doMock("../src/modules/swap/lifi.js", () => ({
      fetchQuote: async () => ({
        tool: "uniswap",
        action: {
          fromToken: {
            symbol: "USDC",
            decimals: 6,
            address: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
            priceUSD: "1",
          },
          toToken: {
            symbol: "WETH",
            decimals: 18,
            address: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
            priceUSD: "2800",
          },
          fromAmount: "280000000",
        },
        estimate: {
          fromAmount: "280000000",
          toAmount: "100000000000000000",
          toAmountMin: "99500000000000000",
          approvalAddress: "0x1111111254EEB25477B68fb85Ed929f73A960582",
          executionDuration: 30,
          feeCosts: [],
          gasCosts: [],
        },
        transactionRequest: {
          to: "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE",
          data: makeCleanUsdcWethSwapCalldata(),
          value: "0x0",
          gasLimit: "0x30d40",
        },
      }),
      fetchStatus: async () => ({}),
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        readContract: async ({
          functionName,
          address,
        }: {
          functionName: string;
          address: string;
        }) => {
          if (functionName === "decimals") {
            return address.toLowerCase() ===
              "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"
              ? 6
              : 18;
          }
          if (functionName === "allowance") return 0n;
          return 0;
        },
      }),
      resetClients: () => {},
    }));

    const { prepareSwap } = await import("../src/modules/swap/index.js");
    const tx = await prepareSwap({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      fromChain: "ethereum",
      toChain: "ethereum",
      fromToken: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "280",
      slippageBps: 100,
    });

    expect(tx.decoded?.functionName).toBe("approve");
    // Exact-in: the approval equals the user-specified input exactly — no slippage pad.
    expect(tx.decoded?.args?.amount).toBe("280 USDC");
    expect(tx.description).toContain("(exact amount)");
  });
});

describe("Bug 14: Compound per-market RPC failures surface as coverage.errored (issue #34)", () => {
  // Live bug: wallet held 184k cUSDCv3 but get_portfolio_summary showed
  // lendingNetUsd=0 with coverage.compound={covered:true}. Root cause: per-market
  // readMarketPosition promises were caught silently, so a transient RPC blip on
  // cUSDCv3 dropped the market and the aggregator still claimed clean coverage.
  // The user literally could not tell "no position" from "position hidden by RPC
  // blip" without cross-checking against get_compound_positions.
  //
  // Fix: readMarketPosition now throws when baseToken succeeds but
  // balanceOf/borrowBalanceOf fail (the market IS deployed, the read just
  // flaked). getCompoundPositions collects those failures via allSettled and
  // returns { errored: true, erroredMarkets: [...] }. The portfolio aggregator
  // flips errors.compound → coverage.compound.errored = true so the user sees
  // a warning note instead of silent $0.
  beforeEach(() => {
    vi.resetModules();
    // Bypass the #88 exposure probe so these tests reach
    // readMarketPosition's mocked 4-call multicall shape directly.
    process.env.VAULTPILOT_COMPOUND_FULL_READ = "1";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VAULTPILOT_COMPOUND_FULL_READ;
  });

  it("getCompoundPositions returns errored:true when baseToken succeeds but balanceOf fails on a deployed market", async () => {
    let callCount = 0;
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        callCount++;
        if (contracts.length === 4) {
          if (callCount === 1) {
            // Market 1: baseToken OK, balanceOf FAILS — flaky RPC on a
            // deployed market. Must bubble up as errored, NOT silently drop.
            return [
              { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
              { status: "success", result: 0 },
              { status: "failure", error: new Error("returned no data") },
              { status: "success", result: 0n },
            ];
          }
          // Other markets: wallet has no position (clean read).
          return [
            { status: "success", result: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        return [
          { status: "success", result: 6 },
          { status: "success", result: "USDC" },
        ];
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const result = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    expect(result.errored).toBe(true);
    expect(result.erroredMarkets).toBeDefined();
    expect(result.erroredMarkets!.length).toBeGreaterThanOrEqual(1);
    // The error message should name the specific market that failed, not a
    // generic "compound failed" — useful for the user to know WHICH read blew up.
    expect(result.erroredMarkets![0].error).toMatch(/balanceOf/);
    expect(result.erroredMarkets![0].error).toMatch(/curated-registry/);
  });

  it("getCompoundPositions flags errored:true when baseToken fails too — registry is curated, so a baseToken read failure on a listed market is an RPC problem, not 'not deployed'", async () => {
    // Rationale: CONTRACTS[chain].compound only lists known-deployed markets
    // (cUSDCv3, cWETHv3 on ethereum, etc.). A baseToken read failing on one
    // of those is an RPC flake, not an absent contract — so surface it
    // rather than silently skipping. The user needs to distinguish "wallet
    // has no position" from "an RPC blip hid my position."
    const mockClient = {
      multicall: vi.fn(async ({ contracts }: { contracts: unknown[] }) => {
        if (contracts.length === 4) {
          return [
            { status: "failure", error: new Error("returned no data") },
            { status: "success", result: 0 },
            { status: "success", result: 0n },
            { status: "success", result: 0n },
          ];
        }
        return [
          { status: "success", result: 6 },
          { status: "success", result: "USDC" },
        ];
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => mockClient,
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });

    const { getCompoundPositions } = await import("../src/modules/compound/index.js");
    const result = await getCompoundPositions({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    });
    expect(result.errored).toBe(true);
    expect(result.erroredMarkets![0].error).toMatch(/baseToken/);
  });

  it("portfolio aggregator flips coverage.compound.errored when getCompoundPositions reports per-market failures", async () => {
    // Stub the compound reader directly — we're testing the aggregator's
    // handling of the new { errored } flag, not the multicall plumbing.
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        multicall: async () => [],
        readContract: async () => 0n,
        getBalance: async () => 0n,
        getBlockNumber: async () => 1n,
      }),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/format.js", async () => {
      const actual = await vi.importActual<typeof import("../src/data/format.js")>(
        "../src/data/format.js"
      );
      return { ...actual, priceTokenAmounts: async () => {} };
    });
    vi.doMock("../src/modules/wallet/index.js", () => ({
      fetchNativeBalance: async (wallet: string, chain: string) => ({
        wallet,
        chain,
        symbol: "ETH",
        amount: "0",
        priceMissing: false,
      }),
      fetchTopErc20Balances: async () => [],
    }));
    vi.doMock("../src/modules/aave/index.js", () => ({
      getLendingPositions: async ({ wallet }: { wallet: string }) => ({ wallet, positions: [] }),
    }));
    vi.doMock("../src/modules/morpho/index.js", () => ({
      getMorphoPositions: async ({ wallet }: { wallet: string }) => ({ wallet, positions: [] }),
    }));
    vi.doMock("../src/modules/uniswap/index.js", () => ({
      getLpPositions: async ({ wallet }: { wallet: string }) => ({ wallet, positions: [] }),
    }));
    vi.doMock("../src/modules/staking/index.js", () => ({
      getStakingPositions: async ({ wallet }: { wallet: string }) => ({ wallet, positions: [] }),
    }));
    vi.doMock("../src/modules/compound/index.js", () => ({
      // Simulate the "silent drop" scenario: positions array is EMPTY, but
      // errored is TRUE because a per-market read flaked. Pre-fix, the
      // aggregator had no way to know this happened.
      getCompoundPositions: async ({ wallet }: { wallet: string }) => ({
        wallet,
        positions: [],
        errored: true,
        erroredMarkets: [{ chain: "ethereum", market: "cUSDCv3", error: "balanceOf failed" }],
      }),
    }));

    const { getPortfolioSummary } = await import("../src/modules/portfolio/index.js");
    const summary = (await getPortfolioSummary({
      wallet: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      chains: ["ethereum"],
    })) as Awaited<ReturnType<typeof getPortfolioSummary>>;
    const single = summary as Extract<typeof summary, { breakdown: unknown }>;
    expect(single.coverage.compound.covered).toBe(false);
    expect(single.coverage.compound.errored).toBe(true);
    expect(single.coverage.compound.note).toMatch(/Compound V3/);
    expect(single.coverage.compound.note).toMatch(/some positions may be missing/);
  });
});
