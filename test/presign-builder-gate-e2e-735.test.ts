/**
 * Issue #735 (a) — builder → REAL pre-sign-gate e2e smoke.
 *
 * The systemic gap that hid #734: a prepare_* builder can emit an UnsignedTx
 * whose `to` / selector `assertTransactionSafe` refuses, and no test exercised
 * the builder output THROUGH the real gate — so five tools shipped
 * dead-on-arrival. This file runs each covered EVM builder's actual output
 * (every leg of its approve→action `next` chain) through the REAL
 * `assertTransactionSafe`, mocking ONLY the RPC preflight the builders need
 * (allowance, pause flags, pool-address resolve, market params, balances) and
 * `resolveTokenMeta` — never the gate itself.
 *
 * ── COVERED (destination-recognized lending + staking + wrap builders) ──
 *   Aave V3:   supply, withdraw, borrow, repay            → aave-v3-pool
 *   Compound:  supply, withdraw, borrow, repay            → compound-v3-comet
 *   Morpho:    supply, withdraw, borrow, repay,
 *              supplyCollateral, withdrawCollateral        → morpho-blue
 *   Staking:   lido stake/unstake/wrap/unwrap,
 *              rocketpool stake/unstake, eigenlayer deposit
 *              → lido-stETH / lido-wstETH / lido-withdrawalQueue /
 *                rocketpool-depositPool / rocketpool-rETH /
 *                eigenlayer-strategyManager
 *   WETH:      unwrap                                      → weth9
 *
 * ── DEFERRED (explicitly NOT silently capped) ──
 *   • Swap builders (buildUniswapSwap, buildCurveSwap): need QuoterV2 quote +
 *     slippage-math + best-fee-tier mocks and (curve) stable_ng factory
 *     registration reads. Their destinations — uniswap-v3-swap-router, LiFi
 *     Diamond, curve pool (ack-stamped) — already have block-5 / catch-all
 *     coverage: swap-router in pre-sign-check.test.ts, curve add_liquidity
 *     THROUGH the real gate in presign-dead-tools-734.test.ts.
 *   • LP builders (buildUniswapMint/Increase/Decrease/Collect/Burn/Rebalance):
 *     need Position/pool-slot0/tick-math mocks. Destination uniswap-v3-npm now
 *     has block-5 accept/reject coverage in presign-block5-selector-matrix-735.
 *   • custom-call / safe-tx builders: ack-gated (acknowledgedNonProtocolTarget
 *     / safeTxOrigin) and already driven THROUGH the gate in pre-sign-check.test.ts.
 *   • Non-EVM builders (BTC / Litecoin / Tron / Solana): out of scope — the EVM
 *     `assertTransactionSafe` gate does not run on their tx shapes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseEther } from "viem";
import type { UnsignedTx } from "../src/types/index.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const WBTC_ETH = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599" as const;
const AAVE_POOL_ETH = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2" as const;
const CUSDC_V3 = "0xc3d688B66703497DAA19211EEdff47f25384cdc3" as const;
const MORPHO_MARKET_ID =
  "0x1111111111111111111111111111111111111111111111111111111111111111" as const;
const EIGEN_STRATEGY = "0x93c4b944D05dfe6df7645A86cd2206016c51564D" as const;
const ORACLE = "0x2222222222222222222222222222222222222222" as const;
const IRM = "0x3333333333333333333333333333333333333333" as const;

/** Flatten an approval → … → action `next` chain into an array of legs. */
function chainNodes(tx: UnsignedTx): UnsignedTx[] {
  const out: UnsignedTx[] = [];
  let t: UnsignedTx | undefined = tx;
  while (t) {
    out.push(t);
    t = t.next;
  }
  return out;
}

/** Assert every leg of a builder's output passes the real pre-sign guard. */
async function assertEveryLegSafe(tx: UnsignedTx): Promise<void> {
  const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
  for (const leg of chainNodes(tx)) {
    await assertTransactionSafe(leg);
  }
}

/**
 * One mock viem client covering every read the covered EVM builders issue.
 * Routes `readContract` / `multicall` by `functionName`; an unexpected read
 * throws so a builder change that adds a new read surfaces loudly instead of
 * silently returning `undefined`.
 *
 * Reserve config bit 56 (ACTIVE) is set, bits 57 (FROZEN) / 60 (PAUSED) clear
 * → Aave preflight passes. allowance = 0 → an approval leg is emitted (so the
 * approve-token/spender path is exercised, not skipped). Pool-address resolve
 * returns the pinned Aave Pool so the built `to` matches classifyDestination.
 */
function evmClient() {
  const byFn = (fn: string): unknown => {
    switch (fn) {
      case "getPool":
        return AAVE_POOL_ETH;
      case "getReserveData":
        return {
          configuration: { data: 1n << 56n },
          variableDebtTokenAddress: USDC_ETH,
        };
      case "allowance":
        return 0n;
      case "isSupplyPaused":
      case "isWithdrawPaused":
        return false;
      case "baseToken":
        return USDC_ETH;
      case "idToMarketParams":
        // [loanToken, collateralToken, oracle, irm, lltv] — loanToken must be
        // non-zero or resolveMarketParams throws "Unknown Morpho market id".
        return [USDC_ETH, WBTC_ETH, ORACLE, IRM, 0n];
      case "getMaximumDepositAmount":
        return parseEther("10000");
      case "balanceOf":
        return parseEther("100");
      case "getEthValue":
        return parseEther("1.1");
      case "getTotalCollateral":
        return parseEther("1000");
      default:
        throw new Error(`evmClient: unexpected read ${fn}`);
    }
  };
  return {
    readContract: vi.fn(async (call: { functionName: string }) => byFn(call.functionName)),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => byFn(c.functionName)),
    ),
  };
}

function mockRpc() {
  vi.doMock("../src/data/rpc.js", () => ({ getClient: () => evmClient() }));
}

function mockTokenMeta() {
  vi.doMock("../src/modules/shared/token-meta.js", () => ({
    resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
  }));
}

describe("Issue #735 (a): EVM prepare_* builders pass the real pre-sign gate", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // ── Aave V3 → aave-v3-pool ────────────────────────────────────────────
  describe("Aave V3", () => {
    const base = { wallet: WALLET, chain: "ethereum" as const, asset: USDC_ETH, decimals: 6, symbol: "USDC" };

    it("buildAaveSupply — approve(Pool) + supply()", async () => {
      mockRpc();
      const { buildAaveSupply } = await import("../src/modules/positions/actions.js");
      await assertEveryLegSafe(await buildAaveSupply({ ...base, amount: "100" }));
    });

    it("buildAaveWithdraw — withdraw()", async () => {
      mockRpc();
      const { buildAaveWithdraw } = await import("../src/modules/positions/actions.js");
      await assertEveryLegSafe(await buildAaveWithdraw({ ...base, amount: "100" }));
    });

    it("buildAaveBorrow — borrow()", async () => {
      mockRpc();
      const { buildAaveBorrow } = await import("../src/modules/positions/actions.js");
      await assertEveryLegSafe(await buildAaveBorrow({ ...base, amount: "100" }));
    });

    it("buildAaveRepay — approve(Pool) + repay()", async () => {
      mockRpc();
      const { buildAaveRepay } = await import("../src/modules/positions/actions.js");
      await assertEveryLegSafe(await buildAaveRepay({ ...base, amount: "100" }));
    });
  });

  // ── Compound V3 → compound-v3-comet ───────────────────────────────────
  describe("Compound V3", () => {
    const base = { chain: "ethereum" as const, market: CUSDC_V3, wallet: WALLET };

    it("buildCompoundSupply — approve(Comet) + supply()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildCompoundSupply } = await import("../src/modules/compound/actions.js");
      await assertEveryLegSafe(await buildCompoundSupply({ ...base, asset: USDC_ETH, amount: "100" }));
    });

    it("buildCompoundWithdraw — withdraw()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildCompoundWithdraw } = await import("../src/modules/compound/actions.js");
      await assertEveryLegSafe(await buildCompoundWithdraw({ ...base, asset: USDC_ETH, amount: "100" }));
    });

    it("buildCompoundBorrow — withdraw(base)", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildCompoundBorrow } = await import("../src/modules/compound/actions.js");
      await assertEveryLegSafe(await buildCompoundBorrow({ ...base, amount: "100" }));
    });

    it("buildCompoundRepay — approve(Comet) + supply(base)", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildCompoundRepay } = await import("../src/modules/compound/actions.js");
      await assertEveryLegSafe(await buildCompoundRepay({ ...base, amount: "100" }));
    });
  });

  // ── Morpho Blue → morpho-blue ─────────────────────────────────────────
  describe("Morpho Blue", () => {
    const base = { chain: "ethereum" as const, wallet: WALLET, marketId: MORPHO_MARKET_ID };

    it("buildMorphoSupply — approve(Morpho) + supply()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoSupply } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoSupply({ ...base, amount: "100" }));
    });

    it("buildMorphoWithdraw — withdraw()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoWithdraw } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoWithdraw({ ...base, amount: "100" }));
    });

    it("buildMorphoBorrow — borrow()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoBorrow } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoBorrow({ ...base, amount: "100" }));
    });

    it("buildMorphoRepay — approve(Morpho) + repay()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoRepay } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoRepay({ ...base, amount: "100" }));
    });

    it("buildMorphoSupplyCollateral — approve(Morpho) + supplyCollateral()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoSupplyCollateral } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoSupplyCollateral({ ...base, amount: "100" }));
    });

    it("buildMorphoWithdrawCollateral — withdrawCollateral()", async () => {
      mockRpc();
      mockTokenMeta();
      const { buildMorphoWithdrawCollateral } = await import("../src/modules/morpho/actions.js");
      await assertEveryLegSafe(await buildMorphoWithdrawCollateral({ ...base, amount: "100" }));
    });
  });

  // ── Staking → lido / rocketpool / eigenlayer ──────────────────────────
  describe("Staking", () => {
    it("buildLidoStake — submit() on stETH", async () => {
      mockRpc();
      const { buildLidoStake } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(buildLidoStake({ wallet: WALLET, amountEth: "1.0" }));
    });

    it("buildLidoUnstake — approve(Queue) + requestWithdrawals()", async () => {
      mockRpc();
      const { buildLidoUnstake } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(await buildLidoUnstake({ wallet: WALLET, amountStETH: "1.0" }));
    });

    it("buildLidoWrap — approve(wstETH) + wrap()", async () => {
      mockRpc();
      const { buildLidoWrap } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(await buildLidoWrap({ wallet: WALLET, amountStETH: "1.0" }));
    });

    it("buildLidoUnwrap — unwrap() on wstETH", async () => {
      mockRpc();
      const { buildLidoUnwrap } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(buildLidoUnwrap({ wallet: WALLET, amountWstETH: "1.0" }));
    });

    it("buildRocketPoolStake — deposit() on RocketDepositPool", async () => {
      mockRpc();
      const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(await buildRocketPoolStake({ wallet: WALLET, amountEth: "1.0" }));
    });

    it("buildRocketPoolUnstake — burn() on rETH", async () => {
      mockRpc();
      const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(await buildRocketPoolUnstake({ wallet: WALLET, amountReth: "1.0" }));
    });

    it("buildEigenLayerDeposit — approve(StrategyManager) + depositIntoStrategy()", async () => {
      mockRpc();
      const { buildEigenLayerDeposit } = await import("../src/modules/staking/actions.js");
      await assertEveryLegSafe(
        await buildEigenLayerDeposit({
          wallet: WALLET,
          strategy: EIGEN_STRATEGY,
          token: USDC_ETH,
          amount: "100",
          decimals: 6,
          symbol: "USDC",
        }),
      );
    });
  });

  // ── WETH → weth9 ──────────────────────────────────────────────────────
  describe("WETH", () => {
    it("buildWethUnwrap — withdraw() on WETH9", async () => {
      mockRpc();
      const { buildWethUnwrap } = await import("../src/modules/weth/actions.js");
      await assertEveryLegSafe(
        await buildWethUnwrap({ wallet: WALLET, chain: "ethereum", amount: "0.5" }),
      );
    });
  });
});
