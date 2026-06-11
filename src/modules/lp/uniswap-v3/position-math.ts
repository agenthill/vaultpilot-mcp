/**
 * Pure-bigint port of `Position.fromAmounts`-equivalent +
 * `mintAmounts` + `mintAmountsWithSlippage` from `@uniswap/v3-sdk`.
 * Lets us derive the amount0Min / amount1Min the on-chain
 * `INonfungiblePositionManager.mint(...)` call needs without
 * dragging in the SDK and its dep tree. See `tick-math.ts` header for
 * the why.
 *
 * Math is identical to the SDK; tests in
 * `test/uniswap-v3-mint.test.ts` continue to assert that the produced
 * amounts match what the SDK would have produced (via fixed
 * pre-computed reference values from the live pool fixtures).
 */
import {
  Q96,
  Q192,
  encodeSqrtRatioX96,
  getAmount0DeltaRoundUp,
  getAmount1DeltaRoundUp,
  getAmount0DeltaRoundDown,
  getAmount1DeltaRoundDown,
} from "./sqrt-price-math.js";
import {
  MIN_SQRT_RATIO,
  MAX_SQRT_RATIO,
  getSqrtRatioAtTick,
  getTickAtSqrtRatio,
} from "./tick-math.js";

/**
 * Pool state we read off-chain (slot0 + the (token0, token1, fee) the
 * caller already provided). We only carry what the math needs.
 */
export interface PoolState {
  fee: number;
  sqrtRatioX96: bigint;
  tickCurrent: number;
  tickSpacing: number;
}

/**
 * SDK reference: `maxLiquidityForAmount0Imprecise` —
 * `useFullPrecision: false`. The on-chain core is what the periphery
 * router uses, so this is what `mintAmountsWithSlippage` constructs
 * the "position that will be created" with.
 */
function maxLiquidityForAmount0Imprecise(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const intermediate = (sqrtRatioAX96 * sqrtRatioBX96) / Q96;
  return (amount0 * intermediate) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/**
 * SDK reference: `maxLiquidityForAmount0Precise` —
 * `useFullPrecision: true`. The user-facing call uses this for fewer
 * dust losses.
 */
function maxLiquidityForAmount0Precise(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount0: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const numerator = amount0 * sqrtRatioAX96 * sqrtRatioBX96;
  const denominator = Q96 * (sqrtRatioBX96 - sqrtRatioAX96);
  return numerator / denominator;
}

function maxLiquidityForAmount1(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  amount1: bigint,
): bigint {
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  return (amount1 * Q96) / (sqrtRatioBX96 - sqrtRatioAX96);
}

/**
 * Computes the maximum amount of liquidity received for a given amount
 * of token0, token1, and the prices at the tick boundaries. SDK
 * reference: `maxLiquidityForAmounts`.
 */
export function maxLiquidityForAmounts(args: {
  sqrtRatioCurrentX96: bigint;
  sqrtRatioAX96: bigint;
  sqrtRatioBX96: bigint;
  amount0: bigint;
  amount1: bigint;
  useFullPrecision: boolean;
}): bigint {
  let { sqrtRatioAX96, sqrtRatioBX96 } = args;
  if (sqrtRatioAX96 > sqrtRatioBX96) {
    [sqrtRatioAX96, sqrtRatioBX96] = [sqrtRatioBX96, sqrtRatioAX96];
  }
  const maxL0 = args.useFullPrecision
    ? maxLiquidityForAmount0Precise
    : maxLiquidityForAmount0Imprecise;
  if (args.sqrtRatioCurrentX96 <= sqrtRatioAX96) {
    return maxL0(sqrtRatioAX96, sqrtRatioBX96, args.amount0);
  }
  if (args.sqrtRatioCurrentX96 < sqrtRatioBX96) {
    const liquidity0 = maxL0(args.sqrtRatioCurrentX96, sqrtRatioBX96, args.amount0);
    const liquidity1 = maxLiquidityForAmount1(
      sqrtRatioAX96,
      args.sqrtRatioCurrentX96,
      args.amount1,
    );
    return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
  }
  return maxLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, args.amount1);
}

/**
 * Returns `{ amount0, amount1 }` for the position at `pool` with
 * `liquidity` over `[tickLower, tickUpper]`, using round-up math
 * (mint-side). SDK reference: `Position.mintAmounts`.
 */
export function mintAmounts(args: {
  pool: PoolState;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): { amount0: bigint; amount1: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(args.tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(args.tickUpper);
  if (args.pool.tickCurrent < args.tickLower) {
    return {
      amount0: getAmount0DeltaRoundUp(sqrtRatioAX96, sqrtRatioBX96, args.liquidity),
      amount1: 0n,
    };
  }
  if (args.pool.tickCurrent < args.tickUpper) {
    return {
      amount0: getAmount0DeltaRoundUp(
        args.pool.sqrtRatioX96,
        sqrtRatioBX96,
        args.liquidity,
      ),
      amount1: getAmount1DeltaRoundUp(
        sqrtRatioAX96,
        args.pool.sqrtRatioX96,
        args.liquidity,
      ),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1DeltaRoundUp(sqrtRatioAX96, sqrtRatioBX96, args.liquidity),
  };
}

/**
 * Compute the (token0, token1) sqrtRatio bounds after applying
 * symmetrical slippage to the pool's current price. SDK reference:
 * `Position.ratiosAfterSlippage`.
 *
 * The SDK uses fraction arithmetic via sdk-core's `Price`/`Fraction`
 * classes; here we inline the algebra. token0Price is
 * `sqrtRatioX96² / Q192`; price × (1 ± slipBps/10_000) yields:
 *   priceLower = sqrtRatioX96² × (10_000 - slipBps) / (Q192 × 10_000)
 *   priceUpper = sqrtRatioX96² × (10_000 + slipBps) / (Q192 × 10_000)
 * `encodeSqrtRatioX96(numerator, denominator)` gives the sqrtRatioX96
 * for that fraction.
 */
function ratiosAfterSlippage(
  pool: PoolState,
  slippageBps: number,
): { sqrtRatioX96Lower: bigint; sqrtRatioX96Upper: bigint } {
  const slipBpsBig = BigInt(slippageBps);
  const denominator = Q192 * 10_000n;
  const sqrtSquared = pool.sqrtRatioX96 * pool.sqrtRatioX96;

  const lowerNum = sqrtSquared * (10_000n - slipBpsBig);
  const upperNum = sqrtSquared * (10_000n + slipBpsBig);

  let sqrtRatioX96Lower = encodeSqrtRatioX96(lowerNum, denominator);
  if (sqrtRatioX96Lower <= MIN_SQRT_RATIO) {
    sqrtRatioX96Lower = MIN_SQRT_RATIO + 1n;
  }
  let sqrtRatioX96Upper = encodeSqrtRatioX96(upperNum, denominator);
  if (sqrtRatioX96Upper >= MAX_SQRT_RATIO) {
    sqrtRatioX96Upper = MAX_SQRT_RATIO - 1n;
  }
  return { sqrtRatioX96Lower, sqrtRatioX96Upper };
}

/**
 * Compute the slippage-bounded `amount0Min` / `amount1Min` for a
 * position-to-be-minted on `pool` over `[tickLower, tickUpper]` with
 * `(amount0Desired, amount1Desired)` user input. SDK reference:
 * `Position.mintAmountsWithSlippage`.
 *
 * The SDK does this in three steps:
 *   1. Resolve the position liquidity at the *imprecise* router math
 *      (so the floor matches what the router will actually mint).
 *   2. Construct counterfactual pools at the slippage-shifted sqrt
 *      ratios (one above current, one below).
 *   3. Compute `mintAmounts` against each counterfactual pool, take
 *      amount0 from the upper-price pool (where amount0 is smaller)
 *      and amount1 from the lower-price pool (where amount1 is
 *      smaller).
 */
export function mintAmountsWithSlippage(args: {
  pool: PoolState;
  tickLower: number;
  tickUpper: number;
  amount0Desired: bigint;
  amount1Desired: bigint;
  slippageBps: number;
}): { amount0: bigint; amount1: bigint; liquidity: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(args.tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(args.tickUpper);

  // Step 1: liquidity at full-precision math, then snap down to the
  // imprecise-router view. The SDK's `mintAmountsWithSlippage` builds
  // a `positionThatWillBeCreated` with `useFullPrecision: false` — to
  // mirror that, we re-derive liquidity from the round-up `mintAmounts`
  // at full-precision, then re-fit using imprecise math.
  const liquidityFullPrecision = maxLiquidityForAmounts({
    sqrtRatioCurrentX96: args.pool.sqrtRatioX96,
    sqrtRatioAX96,
    sqrtRatioBX96,
    amount0: args.amount0Desired,
    amount1: args.amount1Desired,
    useFullPrecision: true,
  });
  const desiredFromFullPrecision = mintAmounts({
    pool: args.pool,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: liquidityFullPrecision,
  });
  const liquidityImprecise = maxLiquidityForAmounts({
    sqrtRatioCurrentX96: args.pool.sqrtRatioX96,
    sqrtRatioAX96,
    sqrtRatioBX96,
    amount0: desiredFromFullPrecision.amount0,
    amount1: desiredFromFullPrecision.amount1,
    useFullPrecision: false,
  });

  // Step 2: counterfactual pools.
  const { sqrtRatioX96Lower, sqrtRatioX96Upper } = ratiosAfterSlippage(
    args.pool,
    args.slippageBps,
  );
  const tickLowerCf = getTickAtSqrtRatio(sqrtRatioX96Lower);
  const tickUpperCf = getTickAtSqrtRatio(sqrtRatioX96Upper);
  const poolLowerCf: PoolState = {
    fee: args.pool.fee,
    sqrtRatioX96: sqrtRatioX96Lower,
    tickCurrent: tickLowerCf,
    tickSpacing: args.pool.tickSpacing,
  };
  const poolUpperCf: PoolState = {
    fee: args.pool.fee,
    sqrtRatioX96: sqrtRatioX96Upper,
    tickCurrent: tickUpperCf,
    tickSpacing: args.pool.tickSpacing,
  };

  // Step 3: mintAmounts at each counterfactual; take the smaller side.
  const { amount0 } = mintAmounts({
    pool: poolUpperCf,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: liquidityImprecise,
  });
  const { amount1 } = mintAmounts({
    pool: poolLowerCf,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: liquidityImprecise,
  });
  return { amount0, amount1, liquidity: liquidityImprecise };
}

/**
 * Returns `{ amount0, amount1 }` the position would burn at the given
 * pool price for the given liquidity, using round-DOWN math (burn-side).
 * SDK reference: `Position.amount0` + `Position.amount1` getters
 * (which use `getAmount{0,1}Delta(..., roundUp: false)`).
 */
export function burnAmounts(args: {
  pool: PoolState;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
}): { amount0: bigint; amount1: bigint } {
  const sqrtRatioAX96 = getSqrtRatioAtTick(args.tickLower);
  const sqrtRatioBX96 = getSqrtRatioAtTick(args.tickUpper);
  if (args.pool.tickCurrent < args.tickLower) {
    return {
      amount0: getAmount0DeltaRoundDown(sqrtRatioAX96, sqrtRatioBX96, args.liquidity),
      amount1: 0n,
    };
  }
  if (args.pool.tickCurrent < args.tickUpper) {
    return {
      amount0: getAmount0DeltaRoundDown(
        args.pool.sqrtRatioX96,
        sqrtRatioBX96,
        args.liquidity,
      ),
      amount1: getAmount1DeltaRoundDown(
        sqrtRatioAX96,
        args.pool.sqrtRatioX96,
        args.liquidity,
      ),
    };
  }
  return {
    amount0: 0n,
    amount1: getAmount1DeltaRoundDown(sqrtRatioAX96, sqrtRatioBX96, args.liquidity),
  };
}

/**
 * Compute the slippage-bounded `amount0Min` / `amount1Min` the
 * `decreaseLiquidity(...)` call should pass — the user wants to
 * receive *at least* these amounts after slippage. SDK reference:
 * `Position.burnAmountsWithSlippage`.
 *
 * Mirrors `mintAmountsWithSlippage` but in burn direction:
 *   - construct counterfactual pools at the slippage-shifted sqrt
 *     ratios;
 *   - compute `burnAmounts` on each;
 *   - the worse-direction (smaller) amount per side is what we
 *     guarantee — amount0 from the upper-price counterfactual, amount1
 *     from the lower-price one.
 */
export function burnAmountsWithSlippage(args: {
  pool: PoolState;
  tickLower: number;
  tickUpper: number;
  liquidity: bigint;
  slippageBps: number;
}): { amount0: bigint; amount1: bigint } {
  const { sqrtRatioX96Lower, sqrtRatioX96Upper } = ratiosAfterSlippage(
    args.pool,
    args.slippageBps,
  );
  const tickLowerCf = getTickAtSqrtRatio(sqrtRatioX96Lower);
  const tickUpperCf = getTickAtSqrtRatio(sqrtRatioX96Upper);
  const poolLowerCf: PoolState = {
    fee: args.pool.fee,
    sqrtRatioX96: sqrtRatioX96Lower,
    tickCurrent: tickLowerCf,
    tickSpacing: args.pool.tickSpacing,
  };
  const poolUpperCf: PoolState = {
    fee: args.pool.fee,
    sqrtRatioX96: sqrtRatioX96Upper,
    tickCurrent: tickUpperCf,
    tickSpacing: args.pool.tickSpacing,
  };
  const { amount0 } = burnAmounts({
    pool: poolUpperCf,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: args.liquidity,
  });
  const { amount1 } = burnAmounts({
    pool: poolLowerCf,
    tickLower: args.tickLower,
    tickUpper: args.tickUpper,
    liquidity: args.liquidity,
  });
  return { amount0, amount1 };
}
