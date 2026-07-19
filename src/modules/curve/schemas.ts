import { z } from "zod";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";
import { approvalCapSchema } from "../shared/approval.js";

const evmAddress = z.string().regex(EVM_ADDRESS);

export const getCurvePositionsInput = z.object({
  wallet: evmAddress.describe(
    "0x EVM wallet address. v0.1 only reads Ethereum stable_ng plain pools — Arbitrum / Polygon and other factory variants land in follow-up PRs.",
  ),
});
export type GetCurvePositionsArgs = z.infer<typeof getCurvePositionsInput>;

export const prepareCurveAddLiquidityInput = z.object({
  wallet: evmAddress.describe("0x EVM wallet address that will sign the tx."),
  pool: evmAddress.describe(
    "Pool address (== LP token address on stable_ng). Must be a stable_ng plain pool — meta pools rejected with a clear error in v0.1; use `get_curve_positions` to discover valid pools the wallet has access to.",
  ),
  /**
   * Per-coin deposit amounts. Length MUST match the pool's `N_COINS`.
   * Single-token deposits = pass amounts with zeros in the unused slots.
   * Use raw token units (apply per-coin decimals before passing).
   */
  amounts: z
    .array(z.string().regex(/^\d+$/))
    .min(1)
    .max(8)
    .describe(
      "Per-coin deposit amounts as decimal-string-encoded uint256, in the order returned by `get_curve_positions(...).coins`. Length must match the pool's N_COINS. Pass '0' for slots you're not depositing into (single-coin deposit).",
    ),
  /**
   * Slippage protection. Caller picks one of:
   *   - `minLpOut` — explicit minimum LP tokens to receive
   *   - `slippageBps` — server computes minLpOut = expected * (1 - slippageBps / 10000)
   *   - neither: rejected (require explicit slippage choice)
   */
  minLpOut: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Explicit minimum LP tokens to receive (decimal-string uint256). Passes through to the pool's `add_liquidity(amounts, min_mint_amount)`. Either `minLpOut` or `slippageBps` is required.",
    ),
  slippageBps: z
    .number()
    .int()
    .min(0)
    .max(1000)
    .optional()
    .describe(
      "Server-side slippage allowance in basis points (e.g. 50 = 0.5%). When set, `minLpOut = calc_token_amount * (1 - slippageBps / 10000)`. Capped at 10% (1000 bps) to prevent accidental wide gates. Either `minLpOut` or `slippageBps` is required.",
    ),
  acknowledgeNonAllowlistedSpender: z
    .literal(true)
    .optional()
    .describe(
      "AFFIRMATIVE GATE — required whenever a deposit slot is non-zero (each approve leg targets the Curve pool, which is NOT in the " +
        "global protocol approve-allowlist: Aave Pool, Compound Comet, Morpho Blue, Lido Queue, EigenLayer, Uniswap NPM, Uniswap " +
        "SwapRouter02, LiFi Diamond). The allowlist is a security recommendation, not a hard requirement: it limits approvals to a " +
        "small set of well-known spenders to keep prompt-injection drains from sliding through. Setting this flag is the user's " +
        "affirmative ack that they understand the approval target sits outside that curated set — the on-device clear-sign of " +
        "`approve(<curve-pool>, <amount>)` and the prepare-receipt warning advisory are the verification anchors. Do NOT default " +
        "this to true silently; surface the trade-off to the user first. Mirrors `prepare_curve_swap`'s identically-named gate.",
    ),
  approvalCap: approvalCapSchema.optional(),
});
export type PrepareCurveAddLiquidityArgs = z.infer<
  typeof prepareCurveAddLiquidityInput
>;

/**
 * `prepare_curve_swap` — issue #615. v0.2 supports two pool sources:
 *   1. Curated entries (the canonical legacy stETH/ETH pool today).
 *   2. Any plain pool registered with the stable_ng factory (covers
 *      crvUSD/USDC, USDe/USDC, etc.).
 *
 * Meta pools and other Curve generations (cryptoswap, tricrypto,
 * older legacy plain pools) are explicitly rejected — their `exchange`
 * ABIs differ (uint256 indices, `use_eth` flag, receiver param) and
 * silent wrong-selector encoding is the failure mode to avoid.
 *
 * Native-ETH detection comes from `coins(i)` returning the ETH
 * sentinel (`0xeeee...eeee`); pass `fromToken: "native"` for the ETH
 * leg of the legacy stETH/ETH pool.
 */
const curveTokenSchema = z.union([
  z.literal("native"),
  z.string().regex(EVM_ADDRESS),
]);

export const prepareCurveSwapInput = z.object({
  wallet: evmAddress.describe("0x EVM wallet address that will sign the tx."),
  pool: evmAddress.describe(
    "Curve pool address. Must be the canonical legacy stETH/ETH pool (0xDC24316b9AE028F1497c275EB9192a3Ea0f67022) or a stable_ng factory plain pool. Meta pools, cryptoswap, tricrypto, and older legacy stable pools are rejected with a clear error.",
  ),
  fromToken: curveTokenSchema.describe(
    "Token to spend. Pass `\"native\"` only for pools whose `coins(i)` returns the ETH sentinel (0xeeee...eeee) at some index — currently the legacy stETH/ETH pool. For ERC-20 inputs the tool chains an approval to the pool automatically.",
  ),
  toToken: curveTokenSchema.describe(
    "Token to receive. Same rules as `fromToken`. Must differ from `fromToken` and both must appear in the pool's `coins` array.",
  ),
  amount: z
    .string()
    .max(50)
    .regex(/^\d+(\.\d+)?$/)
    .describe(
      'Human-readable decimal input amount in the from-token (e.g. "1.5"). Decimals are read from the from-token contract; native = 18.',
    ),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%). When set, `min_dy = get_dy(i,j,dx) * (1 - slippageBps/10000)`. Either `slippageBps` or `minOut` is required — the pool's exchange() accepts `min_dy=0` silently and defaulting to that would let MEV extract the entire output. Capped at 5% (500 bps).",
    ),
  minOut: z
    .string()
    .regex(/^\d+$/)
    .optional()
    .describe(
      "Explicit minimum output in the to-token's wei (decimal-string uint256). Takes precedence over `slippageBps` when both are provided.",
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Required when `slippageBps > 100` (1%). Same gate as `prepare_swap` — sandwich-MEV bots target wide-slippage txs.",
    ),
  acknowledgeNonAllowlistedSpender: z
    .literal(true)
    .optional()
    .describe(
      "AFFIRMATIVE GATE — required whenever `fromToken` is an ERC-20 (the approve leg targets the Curve pool, which is NOT in the " +
        "global protocol approve-allowlist: Aave Pool, Compound Comet, Morpho Blue, Lido Queue, EigenLayer, Uniswap NPM, Uniswap " +
        "SwapRouter02, LiFi Diamond). The allowlist is a security recommendation, not a hard requirement: it limits approvals to a " +
        "small set of well-known spenders to keep prompt-injection drains from sliding through. Setting this flag is the user's " +
        "affirmative ack that they understand the approval target sits outside that curated set — the on-device clear-sign of " +
        "`approve(<curve-pool>, <amount>)` and the prepare-receipt warning advisory are the verification anchors. Do NOT default " +
        "this to true silently; surface the trade-off to the user first. Ignored when `fromToken: \"native\"` (no approval; native " +
        "ETH is sent as msg.value).",
    ),
  approvalCap: approvalCapSchema.optional(),
});
export type PrepareCurveSwapArgs = z.infer<typeof prepareCurveSwapInput>;
