/**
 * Issue #734 regression — 5 EVM prepare_* tools are dead-on-arrival because
 * their tx `to` isn't recognized by `classifyDestination`, so
 * `assertTransactionSafe` refuses them at preview/send (block 4 catch-all for
 * the action leg, block 2 spender-allowlist for the approve leg).
 *
 * Each test runs a builder's real output — every leg of its `next` chain —
 * through the REAL `assertTransactionSafe` and asserts NONE throw. RED on
 * pre-fix code (throws for all 5); GREEN once the destinations are recognized
 * (lido/rocketpool: added to classifyDestination + spender-allowlist) or the
 * ack is stamped (curve_add_liquidity mirrors curve_swap).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseEther, toFunctionSelector } from "viem";
import type { UnsignedTx } from "../src/types/index.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const POOL_A = "0x2222222222222222222222222222222222222222" as const;
const COIN_USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const COIN_USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7" as const;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** Flatten an approval → ... → action `next` chain into an array of legs. */
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

describe("Issue #734: dead-on-arrival prepare_* tools pass the real pre-sign gate", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  /** Mock client for the staking builders (allowance / rocketpool reads). */
  function stakingClient() {
    return {
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "allowance") return 0n;
        if (call.functionName === "getMaximumDepositAmount") return parseEther("10000");
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
      multicall: vi.fn(async () => [
        // buildRocketPoolUnstake: [balanceOf, getEthValue, getTotalCollateral]
        parseEther("100"), // balance >= burn amount
        parseEther("1.1"), // ETH value of the burn
        parseEther("1000"), // collateral >= ETH value
      ]),
    };
  }

  it("prepare_lido_wrap — approve(stETH→wstETH) + wrap(wstETH)", { timeout: 15000 }, async () => {
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => stakingClient() }));
    const { buildLidoWrap } = await import("../src/modules/staking/actions.js");
    const tx = await buildLidoWrap({ wallet: WALLET, amountStETH: "1.0" });
    await assertEveryLegSafe(tx);
  });

  it("prepare_lido_unwrap — unwrap(wstETH)", { timeout: 15000 }, async () => {
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => stakingClient() }));
    const { buildLidoUnwrap } = await import("../src/modules/staking/actions.js");
    const tx = buildLidoUnwrap({ wallet: WALLET, amountWstETH: "1.0" });
    await assertEveryLegSafe(tx);
  });

  it("prepare_rocketpool_stake — deposit() on RocketDepositPool", { timeout: 15000 }, async () => {
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => stakingClient() }));
    const { buildRocketPoolStake } = await import("../src/modules/staking/actions.js");
    const tx = await buildRocketPoolStake({ wallet: WALLET, amountEth: "1.0" });
    await assertEveryLegSafe(tx);
  });

  it("prepare_rocketpool_unstake — burn(uint256) on rETH", { timeout: 15000 }, async () => {
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => stakingClient() }));
    const { buildRocketPoolUnstake } = await import("../src/modules/staking/actions.js");
    const tx = await buildRocketPoolUnstake({ wallet: WALLET, amountReth: "1.0" });
    await assertEveryLegSafe(tx);
  });

  /**
   * Factory multicall mock keyed by function name (order-independent) so it
   * exercises the SAME builder against both the pre-fix shape (pool `N_COINS`)
   * and the post-fix shape (factory `get_n_coins` registration anchor).
   * `registered=true` → get_n_coins returns 2 (a genuine stable_ng plain
   * pool); `registered=false` → get_n_coins returns 0 (unregistered/attacker
   * address the factory never minted).
   */
  function curveFactoryClient(registered: boolean) {
    return {
      multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
        contracts.map((c) => {
          switch (c.functionName) {
            case "is_meta":
              return false;
            case "N_COINS": // pool self-report (pre-fix trust source)
              return 2n;
            case "get_n_coins": // factory registration (post-fix trust anchor)
              return registered ? 2n : 0n;
            case "get_coins":
              return [COIN_USDC, COIN_USDT, ZERO, ZERO, ZERO, ZERO, ZERO, ZERO];
            default:
              throw new Error(`unexpected multicall fn: ${c.functionName}`);
          }
        }),
      ),
      readContract: vi.fn(async (call: { functionName: string }) => {
        if (call.functionName === "allowance") return 0n;
        throw new Error(`unexpected readContract: ${call.functionName}`);
      }),
    };
  }

  it("prepare_curve_add_liquidity — approve(pool) + add_liquidity(pool)", { timeout: 15000 }, async () => {
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => curveFactoryClient(true) }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import("../src/modules/curve/actions.js");
    const tx = await buildCurveAddLiquidity({
      wallet: WALLET,
      pool: POOL_A,
      amounts: ["1000000", "0"], // deposit only the USDC slot → one approval
      minLpOut: "1",
      // Mirror curve_swap: the approve leg targets a non-allowlisted Curve
      // pool, so the user must opt in — the tool no longer auto-acks.
      acknowledgeNonAllowlistedSpender: true,
    });
    await assertEveryLegSafe(tx);
  });

  it("prepare_curve_add_liquidity — REJECTS an unregistered/attacker pool at the factory registration check", { timeout: 15000 }, async () => {
    // The pool self-reports N_COINS=2 (attacker-controllable) but the
    // stable_ng factory never registered it → get_n_coins == 0. Pre-fix the
    // builder trusted the pool's self-report and stamped
    // acknowledgedNonProtocolTarget (RED: no throw). Post-fix it mirrors
    // curve_swap's `ensureSupportedCurvePool` factory anchor and rejects.
    vi.doMock("../src/data/rpc.js", () => ({ getClient: () => curveFactoryClient(false) }));
    vi.doMock("../src/modules/shared/token-meta.js", () => ({
      resolveTokenMeta: async () => ({ symbol: "USDC", decimals: 6 }),
    }));

    const { buildCurveAddLiquidity } = await import("../src/modules/curve/actions.js");
    await expect(
      buildCurveAddLiquidity({
        wallet: WALLET,
        pool: POOL_A,
        amounts: ["1000000", "0"],
        minLpOut: "1",
        acknowledgeNonAllowlistedSpender: true,
      }),
    ).rejects.toThrow(/not registered with the Curve stable_ng factory/);
  });

  it("does NOT newly recognize any destination beyond the exact fixed contracts", { timeout: 15000 }, async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const wrapSelector = toFunctionSelector("wrap(uint256)");

    // An arbitrary contract carrying wstETH's `wrap` selector must STILL be
    // refused — recognition is by exact address, not by selector shape.
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        data: wrapSelector,
        value: "0",
        from: WALLET,
        description: "wrap() on an unknown contract",
      }),
    ).rejects.toThrow(/unknown contract/);

    // wstETH IS recognized now, but block 5 (per-destination selector check)
    // must still reject a selector that is not on the wstETH ABI.
    const bogusSelector = toFunctionSelector("attack(uint256)");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: "0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0", // wstETH
        data: bogusSelector,
        value: "0",
        from: WALLET,
        description: "bogus selector on wstETH",
      }),
    ).rejects.toThrow(/not a known function/);
  });
});
