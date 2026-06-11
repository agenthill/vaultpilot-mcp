/**
 * Pure-bigint port of the slice of Uniswap V3's `SqrtPriceMath` +
 * `FullMath` + `encodeSqrtRatioX96` + `sqrt` helpers used across LP
 * flows. Originally in `@uniswap/v3-sdk` and `@uniswap/sdk-core`.
 *
 * Round-up variants serve the mint side (deposit a hair more than
 * the strict minimum so a 1-wei rounding never reverts). Round-down
 * variants serve the burn / decrease side (never overclaim what the
 * protocol's accounting actually allocated).
 */

/** Q64.96 fixed-point unit. */
export const Q96 = 1n << 96n;
/** Q192 — used by `encodeSqrtRatioX96` to position the price in 192 bits before sqrt. */
export const Q192 = 1n << 192n;

/**
 * Floor square root of a non-negative bigint. Babylonian-method port
 * matching the SDK's `sqrt` in `sdk-core/dist/.../utils/sqrt.js` —
 * uses `Math.sqrt` for small inputs and Newton iteration for large ones.
 */
export function sqrtBigInt(value: bigint): bigint {
  if (value < 0n) {
    throw new Error("sqrtBigInt: negative input");
  }
  if (value < BigInt(Number.MAX_SAFE_INTEGER)) {
    return BigInt(Math.floor(Math.sqrt(Number(value))));
  }
  let z = value;
  let x = value / 2n + 1n;
  while (x < z) {
    z = x;
    x = (value / x + x) / 2n;
  }
  return z;
}

/**
 * Computes (a × b) ÷ denominator, rounding the result up. Used by
 * `getAmount0Delta` in the round-up branch. Verbatim shape of the
 * SDK's `FullMath.mulDivRoundingUp`.
 */
export function mulDivRoundingUp(
  a: bigint,
  b: bigint,
  denominator: bigint,
): bigint {
  const product = a * b;
  let result = product / denominator;
  if (product % denominator !== 0n) result += 1n;
  return result;
}

/**
 * Returns the sqrt ratio as Q64.96 corresponding to a price ratio
 * `amount1 / amount0`. Inversely used by `ratiosAfterSlippage` to
 * convert a slippage-shifted price back to a sqrtRatio for tick
 * lookup.
 */
export function encodeSqrtRatioX96(
  amount1: bigint,
  amount0: bigint,
): bigint {
  const numerator = amount1 << 192n;
  const ratioX192 = numerator / amount0;
  return sqrtBigInt(ratioX192);
}

/** Ensure sqrtRatioA ≤ sqrtRatioB; swaps in-place if needed. */
function sortSqrtRatios(
  a: bigint,
  b: bigint,
): [bigint, bigint] {
  return a <= b ? [a, b] : [b, a];
}

/**
 * Δamount0 across a price range, rounded up. Used at mint time to
 * determine how much token0 the position needs.
 *
 * SDK reference: `SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, L, true)`.
 */
export function getAmount0DeltaRoundUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  [sqrtRatioAX96, sqrtRatioBX96] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  // Two nested mulDivRoundingUp calls — first divides by sqrtRatioBX96,
  // then by sqrtRatioAX96, mirroring the SDK.
  return mulDivRoundingUp(
    mulDivRoundingUp(numerator1, numerator2, sqrtRatioBX96),
    1n,
    sqrtRatioAX96,
  );
}

/**
 * Δamount1 across a price range, rounded up.
 * SDK reference: `SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, L, true)`.
 */
export function getAmount1DeltaRoundUp(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  [sqrtRatioAX96, sqrtRatioBX96] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  return mulDivRoundingUp(liquidity, sqrtRatioBX96 - sqrtRatioAX96, Q96);
}

/**
 * Δamount0 across a price range, rounded down. Used at burn /
 * decrease time — the protocol's accounting only credits what its
 * own rounding allocated, never more.
 *
 * SDK reference: `SqrtPriceMath.getAmount0Delta(sqrtA, sqrtB, L, false)`.
 */
export function getAmount0DeltaRoundDown(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  [sqrtRatioAX96, sqrtRatioBX96] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  const numerator1 = liquidity << 96n;
  const numerator2 = sqrtRatioBX96 - sqrtRatioAX96;
  // Round-down: integer divide; no rounding-up correction.
  return (numerator1 * numerator2) / sqrtRatioBX96 / sqrtRatioAX96;
}

/**
 * Δamount1 across a price range, rounded down.
 * SDK reference: `SqrtPriceMath.getAmount1Delta(sqrtA, sqrtB, L, false)`.
 */
export function getAmount1DeltaRoundDown(
  sqrtRatioAX96: bigint,
  sqrtRatioBX96: bigint,
  liquidity: bigint,
): bigint {
  [sqrtRatioAX96, sqrtRatioBX96] = sortSqrtRatios(sqrtRatioAX96, sqrtRatioBX96);
  return (liquidity * (sqrtRatioBX96 - sqrtRatioAX96)) / Q96;
}
