/**
 * Curve v0.1 tests — pool discovery, get_curve_positions, prepareCurveAddLiquidity.
 *
 * Strategy: stub `getClient` from `data/rpc.js` to return a mock client whose
 * `multicall` + `readContract` implementations return synthetic, internally-
 * consistent fixtures. Locks in: factory iteration shape, plain-pool
 * filtering, gauge-aware position reads, slippage gate, meta-pool rejection,
 * approval bundling.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Address } from "viem";

const FACTORY = "0x6A8cbed756804B16E05E741eDaBd5cB544AE21bf" as const;
const POOL_A = "0x1111111111111111111111111111111111111111" as const;
const POOL_META = "0x2222222222222222222222222222222222222222" as const;
const POOL_B = "0x3333333333333333333333333333333333333333" as const;
const COIN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const COIN_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const GAUGE_A = "0x9999999999999999999999999999999999999999" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const WALLET = "0x4444444444444444444444444444444444444444" as const;

type MulticallCall = {
  address: Address;
  functionName: string;
  args?: readonly unknown[];
};

describe("listEthereumStableNgPools", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("enumerates plain pools, filters meta pools, trims zero-padded coin slots", async () => {
    const mockClient = {
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "pool_count") return 3n;
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
      multicall: vi.fn(async ({ contracts }: { contracts: MulticallCall[] }) => {
        const first = contracts[0];
        // Phase 1: pool_list(0..2) — 3 calls
        if (first.functionName === "pool_list") {
          return [
            { status: "success", result: POOL_A },
            { status: "success", result: POOL_META },
            { status: "success", result: POOL_B },
          ];
        }
        // Phase 2: per-pool {is_meta, get_coins, get_balances, get_gauge} × 3 pools = 12 calls
        if (first.functionName === "is_meta") {
          return [
            // POOL_A: plain, 2 coins, gauge
            { status: "success", result: false },
            {
              status: "success",
              result: [COIN_USDC, COIN_USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO],
            },
            { status: "success", result: [1_000_000n, 2_000_000n, 0n, 0n, 0n, 0n, 0n, 0n] },
            { status: "success", result: GAUGE_A },
            // POOL_META: meta — should be filtered out
            { status: "success", result: true },
            { status: "success", result: [COIN_USDC, COIN_USDT] },
            { status: "success", result: [0n, 0n] },
            { status: "success", result: ZERO },
            // POOL_B: plain, 2 coins, NO gauge
            { status: "success", result: false },
            { status: "success", result: [COIN_USDC, COIN_USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO] },
            { status: "success", result: [500_000n, 500_000n, 0n, 0n, 0n, 0n, 0n, 0n] },
            { status: "success", result: ZERO },
          ];
        }
        throw new Error(`unexpected multicall first call: ${first.functionName}`);
      }),
    };
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/data/cache.js", () => ({
      cache: { remember: async (_k: string, _t: number, fn: () => Promise<unknown>) => fn() },
    }));

    const { listEthereumStableNgPools } = await import(
      "../src/modules/curve/pools.js"
    );
    const pools = await listEthereumStableNgPools();

    expect(pools).toHaveLength(2); // POOL_META filtered
    expect(pools.map((p) => p.pool)).toEqual([POOL_A, POOL_B]);
    expect(pools[0].coins).toEqual([COIN_USDC, COIN_USDT]); // trimmed zeros
    expect(pools[0].gauge).toBe(GAUGE_A);
    expect(pools[1].gauge).toBeNull(); // ZERO → null
  });

  it("handles zero-pool factory cleanly", async () => {
    const mockClient = {
      readContract: vi.fn(async () => 0n),
      multicall: vi.fn(),
    };
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/data/cache.js", () => ({
      cache: { remember: async (_k: string, _t: number, fn: () => Promise<unknown>) => fn() },
    }));

    const { listEthereumStableNgPools } = await import(
      "../src/modules/curve/pools.js"
    );
    const pools = await listEthereumStableNgPools();
    expect(pools).toEqual([]);
    expect(mockClient.multicall).not.toHaveBeenCalled();
  });
});

describe("getCurvePositions", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns only pools where the wallet has nonzero LP / gauge / pendingCrv", async () => {
    // Stub the pools module so we don't re-test discovery here.
    vi.doMock("../src/modules/curve/pools.js", () => ({
      listEthereumStableNgPools: async () => [
        {
          pool: POOL_A,
          poolType: "stable-ng-plain" as const,
          coins: [COIN_USDC, COIN_USDT],
          balances: [1_000_000n, 2_000_000n],
          gauge: GAUGE_A,
        },
        {
          pool: POOL_B,
          poolType: "stable-ng-plain" as const,
          coins: [COIN_USDC, COIN_USDT],
          balances: [500_000n, 500_000n],
          gauge: null,
        },
      ],
    }));

    // POOL_A: lp=100, gaugeBal=200, gaugeClaim=5
    // POOL_B: lp=0 (filtered out, no gauge means no gauge calls)
    const mockClient = {
      multicall: vi.fn(async () => [
        { status: "success", result: 100n }, // POOL_A lp
        { status: "success", result: 200n }, // POOL_A gaugeBal
        { status: "success", result: 5n }, // POOL_A claimable
        { status: "success", result: 0n }, // POOL_B lp
      ]),
    };
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));

    const { getCurvePositions } = await import(
      "../src/modules/curve/positions.js"
    );
    const out = await getCurvePositions(WALLET);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      protocol: "curve",
      chain: "ethereum",
      poolAddress: POOL_A,
      poolType: "stable-ng-plain",
      lpBalance: "100",
      gaugeStakedBalance: "200",
      pendingCrv: "5",
      gaugeAddress: GAUGE_A,
    });
  });

  it("returns empty array when wallet has no positions in any discovered pool", async () => {
    vi.doMock("../src/modules/curve/pools.js", () => ({
      listEthereumStableNgPools: async () => [
        {
          pool: POOL_B,
          poolType: "stable-ng-plain" as const,
          coins: [COIN_USDC, COIN_USDT],
          balances: [500_000n, 500_000n],
          gauge: null,
        },
      ],
    }));
    const mockClient = {
      multicall: vi.fn(async () => [{ status: "success", result: 0n }]),
    };
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));

    const { getCurvePositions } = await import(
      "../src/modules/curve/positions.js"
    );
    expect(await getCurvePositions(WALLET)).toEqual([]);
  });
});

describe("buildCurveAddLiquidity", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** Standard mock client used by the happy-path tests. */
  function plainPoolClient(opts: { allowance?: bigint; calcOut?: bigint } = {}) {
    return {
      multicall: vi.fn(async ({ contracts }: { contracts: MulticallCall[] }) => {
        const fns = contracts.map((c) => c.functionName);
        if (fns.includes("is_meta")) {
          // is_meta + get_n_coins + get_coins (all read off the stable_ng
          // factory; get_n_coins=2 == a registered plain pool).
          return [
            false,
            2n,
            [COIN_USDC, COIN_USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO],
          ];
        }
        throw new Error(`unexpected multicall: ${fns.join(",")}`);
      }),
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "calc_token_amount") return opts.calcOut ?? 1_500_000n;
        if (call.functionName === "allowance") return opts.allowance ?? 0n;
        if (call.functionName === "decimals") return 6;
        if (call.functionName === "symbol") return "USDC";
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
    };
  }

  it("computes minLpOut from slippageBps using calc_token_amount", async () => {
    const mockClient = plainPoolClient({ calcOut: 1_000_000n, allowance: 10n ** 30n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    const tx = await buildCurveAddLiquidity({
      wallet: WALLET,
      pool: POOL_A,
      amounts: ["1000000", "2000000"],
      slippageBps: 50, // 0.5%
    });
    // 1_000_000 * (10000 - 50) / 10000 = 995_000
    expect(tx.decoded?.args.minLpOut).toBe("995000");
  });

  it("rejects meta pools with an actionable error", async () => {
    const mockClient = {
      multicall: vi.fn(async () => [true, 2n, [COIN_USDC, COIN_USDT]]),
      readContract: vi.fn(),
    };
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    await expect(
      buildCurveAddLiquidity({
        wallet: WALLET,
        pool: POOL_META,
        amounts: ["1000000", "1000000"],
        slippageBps: 50,
      }),
    ).rejects.toThrow(/meta pool/i);
  });

  it("requires explicit slippage — refuses when neither minLpOut nor slippageBps is set", async () => {
    const mockClient = plainPoolClient({});
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    await expect(
      buildCurveAddLiquidity({
        wallet: WALLET,
        pool: POOL_A,
        amounts: ["1000000", "2000000"],
      }),
    ).rejects.toThrow(/slippage/i);
  });

  it("rejects amounts whose length doesn't match N_COINS", async () => {
    const mockClient = plainPoolClient({});
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    await expect(
      buildCurveAddLiquidity({
        wallet: WALLET,
        pool: POOL_A,
        amounts: ["1000000"], // only 1, pool needs 2
        slippageBps: 50,
      }),
    ).rejects.toThrow(/N_COINS=2.*1 amounts/);
  });

  it("emits add_liquidity selector + chains the approval(s) when allowance is insufficient", async () => {
    const mockClient = plainPoolClient({ calcOut: 1_500_000n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    const tx = await buildCurveAddLiquidity({
      wallet: WALLET,
      pool: POOL_A,
      amounts: ["1000000", "2000000"],
      slippageBps: 100, // 1%
      // Approvals are built (allowance 0) → the non-allowlisted-spender
      // opt-in is now required (mirrors curve_swap; no silent auto-ack).
      acknowledgeNonAllowlistedSpender: true,
    });
    // chainApproval returns the approval tx with `next` pointing at the action.
    // Selector for add_liquidity(uint256[],uint256) is 0x0b4c7e4d (verified
    // via keccak256 of the canonical sig).
    // To assert without computing keccak in test code: confirm the
    // `description` reflects the action and `decoded.functionName` is
    // add_liquidity (the action tx is reachable via tx.next chain).
    // chainApproval walks the .next linked list — with 2 approvals + 1
    // action, the chain is: approval1 → approval2 → addLiquidity. Walk
    // to the tail to find the action.
    type WithNext = typeof tx & { next?: typeof tx };
    let cur: typeof tx = tx;
    while ((cur as WithNext).next !== undefined) cur = (cur as WithNext).next!;
    expect(cur.decoded?.functionName).toBe("add_liquidity");
    expect(cur.to).toBe(POOL_A);
    expect(cur.decoded?.args.minLpOut).toBe("1485000"); // 1_500_000 * (1 - 0.01)
    // ⚠ ADVISORY rides the approval receipt (mirror curve_swap).
    expect(tx.description).toMatch(/⚠ ADVISORY/);
    expect(tx.acknowledgedNonAllowlistedSpender).toBe(true);
  });

  it("refuses to build the approve when acknowledgeNonAllowlistedSpender is unset (mirror curve_swap; no silent auto-ack)", async () => {
    const mockClient = plainPoolClient({ calcOut: 1_500_000n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => mockClient }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import(
      "../src/modules/curve/actions.js"
    );
    await expect(
      buildCurveAddLiquidity({
        wallet: WALLET,
        pool: POOL_A,
        amounts: ["1000000", "2000000"],
        slippageBps: 100,
      }),
    ).rejects.toThrow(/acknowledgeNonAllowlistedSpender|approve-allowlist|recommendation/i);
  });
});

/**
 * `prepare_curve_swap` — issue #615 v0.2. Generalized to:
 *   - the canonical legacy stETH/ETH pool (curated entry, ETH at index 0)
 *   - any stable_ng factory plain pool (factory-resolved, ERC-20 only)
 * Tests pin: index resolution from coins, native-value placement on
 * native-in legs, approval chain on ERC-20-in legs, slippage gate,
 * meta-pool rejection, unknown-pool rejection, mismatched-token error.
 */
const STETH_POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022" as const;
const STETH_TOKEN = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84" as const;
const ETH_SENTINEL = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee" as const;
const NG_POOL = "0xCCCCCcccCCCCcCcCCCCcCCCCcCCcCCccCCCCCCCC" as const;
const NG_COIN_A = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const; // USDC
const NG_COIN_B = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const; // USDT

describe("buildCurveSwap (issue #615 v0.2)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /**
   * Mock client tailored to the curated stETH/ETH path:
   *   - readContract N_COINS → 2
   *   - multicall coins(0..1) → [ETH_SENTINEL, stETH]
   *   - readContract get_dy → opts.getDy
   *   - readContract allowance → opts.allowance
   *   - (CURATED — no factory multicall is fired)
   */
  function stethPoolClient(opts: { allowance?: bigint; getDy?: bigint } = {}) {
    return {
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "N_COINS") return 2n;
        if (call.functionName === "get_dy") return opts.getDy ?? 10n ** 18n;
        if (call.functionName === "allowance") return opts.allowance ?? 0n;
        if (call.functionName === "decimals") return 18;
        if (call.functionName === "symbol") return "stETH";
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
      multicall: vi.fn(
        async ({ contracts }: { contracts: MulticallCall[] }) => {
          const fns = contracts.map((c) => c.functionName);
          if (fns.every((f) => f === "coins")) {
            return [ETH_SENTINEL, STETH_TOKEN];
          }
          throw new Error(`unexpected multicall: ${fns.join(",")}`);
        },
      ),
    };
  }

  /**
   * Mock client for a stable_ng factory plain pool (USDC/USDT-like):
   *   - factory multicall {is_meta, get_n_coins} → {false, 2}
   *   - readContract N_COINS → 2
   *   - multicall coins(0..1) → [USDC, USDT]
   * The dispatch fires THREE multicalls in this path (factory → coins).
   * Distinguish by inspecting the contract list of each call.
   */
  function ngPoolClient(opts: {
    isMeta?: boolean;
    nCoinsFactory?: bigint;
    getDy?: bigint;
    allowance?: bigint;
  } = {}) {
    return {
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "N_COINS") return 2n;
        if (call.functionName === "get_dy") return opts.getDy ?? 1_000_000n;
        if (call.functionName === "allowance") return opts.allowance ?? 0n;
        if (call.functionName === "decimals") return 6;
        if (call.functionName === "symbol") return "USDC";
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
      multicall: vi.fn(
        async ({ contracts }: { contracts: MulticallCall[] }) => {
          const fns = contracts.map((c) => c.functionName);
          if (fns.includes("is_meta") && fns.includes("get_n_coins")) {
            return [
              { status: "success", result: opts.isMeta ?? false },
              { status: "success", result: opts.nCoinsFactory ?? 2n },
            ];
          }
          if (fns.every((f) => f === "coins")) {
            return [NG_COIN_A, NG_COIN_B];
          }
          throw new Error(`unexpected multicall: ${fns.join(",")}`);
        },
      ),
    };
  }

  it("legacy stETH/ETH (curated): native ETH input emits value=dx, no approval", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: STETH_POOL,
      fromToken: "native",
      toToken: STETH_TOKEN,
      amount: "1.0",
      slippageBps: 50,
    });

    expect(tx.to).toBe(STETH_POOL);
    expect(tx.value).toBe((10n ** 18n).toString());
    expect(tx.next).toBeUndefined();
    expect(tx.decoded?.functionName).toBe("exchange");
    expect(tx.decoded?.args.i).toBe("0");
    expect(tx.decoded?.args.j).toBe("1");
    expect(tx.decoded?.args.minOut).toBe("0.995 stETH");
    // Curve pool isn't in classifyDestination's recognized set; the swap leg
    // must carry acknowledgedNonProtocolTarget so assertTransactionSafe
    // accepts it at preview/send time. Issue #626.
    expect(tx.acknowledgedNonProtocolTarget).toBe(true);
  });

  it("legacy stETH/ETH (curated): stETH input chains an approval to the pool, value=0", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: STETH_POOL,
      fromToken: STETH_TOKEN,
      toToken: "native",
      amount: "1.0",
      slippageBps: 50,
      acknowledgeNonAllowlistedSpender: true,
    });

    expect(tx.to).toBe(STETH_TOKEN);
    expect(tx.decoded?.functionName).toBe("approve");
    // The approval head must carry the affirmative-ack flag so
    // assertTransactionSafe accepts the non-allowlisted spender at
    // preview/send time.
    expect(tx.acknowledgedNonAllowlistedSpender).toBe(true);
    expect(tx.description).toMatch(/ADVISORY.*Curve.*stETH\/ETH.*allowlist/i);
    type WithNext = typeof tx & { next?: typeof tx };
    let cur: typeof tx = tx;
    while ((cur as WithNext).next !== undefined) cur = (cur as WithNext).next!;
    expect(cur.to).toBe(STETH_POOL);
    expect(cur.value).toBe("0");
    expect(cur.decoded?.functionName).toBe("exchange");
    expect(cur.decoded?.args.i).toBe("1");
    expect(cur.decoded?.args.j).toBe("0");
    // Swap leg goes to the Curve pool (non-protocol target); the ack flag
    // bypasses assertTransactionSafe's catch-all destination refusal.
    // Companion to the approve leg's acknowledgedNonAllowlistedSpender
    // (#618). Issue #626.
    expect(cur.acknowledgedNonProtocolTarget).toBe(true);
  });

  it("ERC-20 input: refuses without acknowledgeNonAllowlistedSpender (Curve pool sits outside protocol allowlist)", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: STETH_POOL,
        fromToken: STETH_TOKEN,
        toToken: "native",
        amount: "1.0",
        slippageBps: 50,
        // No ack — should fail.
      }),
    ).rejects.toThrow(/acknowledgeNonAllowlistedSpender|approve-allowlist|recommendation/i);
  });

  it("native input: ignores acknowledgeNonAllowlistedSpender (no approval built)", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: STETH_POOL,
      fromToken: "native",
      toToken: STETH_TOKEN,
      amount: "1.0",
      slippageBps: 50,
      // No ack — native input path doesn't build an approval, gate is irrelevant.
    });
    expect(tx.acknowledgedNonAllowlistedSpender).toBeUndefined();
    expect(tx.next).toBeUndefined();
  });

  it("ERC-20 input + ack: approval description carries ADVISORY, ack flag flows to UnsignedTx", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: STETH_POOL,
      fromToken: STETH_TOKEN,
      toToken: "native",
      amount: "1.0",
      slippageBps: 50,
      acknowledgeNonAllowlistedSpender: true,
    });
    // Head leg is the approval; assert the ADVISORY in its description and
    // that the ack flag is stamped so `assertTransactionSafe` skips the
    // spender-allowlist refusal at preview/send.
    expect(tx.decoded?.functionName).toBe("approve");
    expect(tx.description).toMatch(/ADVISORY/);
    expect(tx.description).toMatch(/protocol approve-allowlist/i);
    expect(tx.acknowledgedNonAllowlistedSpender).toBe(true);
  });

  it("stable_ng factory plain pool: ERC-20 ↔ ERC-20, indices resolved from coins", async () => {
    const client = ngPoolClient({ getDy: 1_000_000n, allowance: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: NG_POOL,
      fromToken: NG_COIN_A,
      toToken: NG_COIN_B,
      amount: "1.0",
      slippageBps: 50,
      acknowledgeNonAllowlistedSpender: true,
    });

    // Approval head (USDC → pool) then exchange.
    expect(tx.to.toLowerCase()).toBe(NG_COIN_A.toLowerCase());
    type WithNext = typeof tx & { next?: typeof tx };
    let cur: typeof tx = tx;
    while ((cur as WithNext).next !== undefined) cur = (cur as WithNext).next!;
    expect(cur.to.toLowerCase()).toBe(NG_POOL.toLowerCase());
    expect(cur.value).toBe("0");
    expect(cur.decoded?.functionName).toBe("exchange");
    expect(cur.decoded?.args.i).toBe("0");
    expect(cur.decoded?.args.j).toBe("1");
    expect(cur.description).toMatch(/stable_ng plain pool/i);
    // Same fix as the legacy stETH/ETH path — stable_ng pools are also
    // non-protocol targets at the pre-sign destination gate.
    expect(cur.acknowledgedNonProtocolTarget).toBe(true);
  });

  it("rejects meta pools with an actionable error", async () => {
    const client = ngPoolClient({ isMeta: true });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: NG_POOL,
        fromToken: NG_COIN_A,
        toToken: NG_COIN_B,
        amount: "1.0",
        slippageBps: 50,
        acknowledgeNonAllowlistedSpender: true,
      }),
    ).rejects.toThrow(/meta pool/i);
  });

  it("rejects pools outside curated set + stable_ng factory", async () => {
    const client = ngPoolClient({ nCoinsFactory: 0n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: "0xDeadBeefDeadBeefDeadBeefDeadBeefDeadBeef",
        fromToken: NG_COIN_A,
        toToken: NG_COIN_B,
        amount: "1.0",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/not supported|not in.*set|cryptoswap/i);
  });

  it("rejects native fromToken when pool's coins carry no ETH sentinel", async () => {
    const client = ngPoolClient();
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: NG_POOL,
        fromToken: "native",
        toToken: NG_COIN_B,
        amount: "1.0",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/does not accept native/i);
  });

  it("rejects fromToken that isn't in the pool's coins array", async () => {
    const client = ngPoolClient();
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: NG_POOL,
        fromToken: "0x1111111111111111111111111111111111111111",
        toToken: NG_COIN_B,
        amount: "1.0",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/not in the pool's coins/i);
  });

  it("requires slippage gate — refuses when neither slippageBps nor minOut is set", async () => {
    const client = stethPoolClient();
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: STETH_POOL,
        fromToken: "native",
        toToken: STETH_TOKEN,
        amount: "1.0",
      }),
    ).rejects.toThrow(/min_dy=0|min_out|slippage/i);
  });

  it("explicit minOut overrides slippageBps and skips get_dy read", async () => {
    const client = stethPoolClient();
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveSwap({
      wallet: WALLET,
      pool: STETH_POOL,
      fromToken: "native",
      toToken: STETH_TOKEN,
      amount: "1.0",
      minOut: "990000000000000000",
    });
    expect(tx.decoded?.args.minOut).toBe("0.99 stETH");
    expect(client.readContract).not.toHaveBeenCalledWith(
      expect.objectContaining({ functionName: "get_dy" }),
    );
  });

  it("rejects high slippage without acknowledgement", async () => {
    const client = stethPoolClient({ getDy: 10n ** 18n });
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: STETH_POOL,
        fromToken: "native",
        toToken: STETH_TOKEN,
        amount: "1.0",
        slippageBps: 200,
      }),
    ).rejects.toThrow(/sandwich|acknowledgeHighSlippage/i);
  });

  it("rejects fromToken === toToken", async () => {
    const client = stethPoolClient();
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => client }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "stETH", decimals: 18 }),
    }));

    const { buildCurveSwap } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveSwap({
        wallet: WALLET,
        pool: STETH_POOL,
        fromToken: STETH_TOKEN,
        toToken: STETH_TOKEN,
        amount: "1.0",
        slippageBps: 50,
      }),
    ).rejects.toThrow(/same coin index|distinct tokens/i);
  });
});
