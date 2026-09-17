import type { SupportedChain } from "./chains.js";

/** A token balance with optional USD valuation. */
export interface TokenAmount {
  token: `0x${string}`;
  symbol: string;
  decimals: number;
  /** Raw integer amount as a decimal string (e.g. "1000000" for 1 USDC). */
  amount: string;
  /** Human-readable amount (e.g. "1.0" for 1 USDC). */
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  /**
   * True when we could not resolve a USD price for this token. `valueUsd` is
   * `undefined` rather than 0, and portfolio totals will NOT include this
   * balance — callers should flag it to the user instead of silently treating
   * it as worthless.
   */
  priceMissing?: boolean;
}

/**
 * Curve LP position — v0.1 surface (issue stable_ng-only, plain pools only).
 *
 * Each entry is one (pool, wallet) combination where the wallet has either
 * a direct LP balance or a gauge-staked balance (or both). Pools where the
 * wallet has zero of both are filtered out at composer level so the
 * response stays scannable for users with positions in 3+ pools.
 */
export interface CurvePosition {
  protocol: "curve";
  chain: SupportedChain;
  poolAddress: `0x${string}`;
  poolType: "stable-ng-plain";
  /**
   * The pool's coin addresses, in the order add_liquidity expects.
   * For wrapped-native pools (e.g. WETH-paired), addresses point to the
   * wrapper (no native ETH special-casing yet — v2 follow-up).
   */
  coins: `0x${string}`[];
  /** User's direct LP balance (LP token == pool address on stable_ng). */
  lpBalance: string;
  /** User's gauge-staked LP balance. Zero when no gauge or not staked. */
  gaugeStakedBalance: string;
  /** Pending claimable CRV. Zero when no gauge or no rewards accrued. */
  pendingCrv: string;
  /**
   * Gauge address for this pool, when one exists. Some stable_ng pools
   * have no gauge deployed (factory.get_gauge returns zero address) —
   * `null` in that case so callers don't render a "stake in gauge" CTA.
   */
  gaugeAddress: `0x${string}` | null;
}

export interface LendingPosition {
  protocol: "aave-v3";
  chain: SupportedChain;
  collateral: TokenAmount[];
  debt: TokenAmount[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  netValueUsd: number;
  /** Aave health factor (>1 safe, <1 liquidatable). Infinity if no debt. */
  healthFactor: number;
  /** Weighted average liquidation threshold (bps, e.g. 8250 = 82.5%). */
  liquidationThreshold: number;
  /** Weighted average loan-to-value (bps). */
  ltv: number;
  /**
   * Per-asset warnings derived from reserve.isPaused / reserve.isFrozen. Scoped
   * to assets the user actually holds or borrows — a pause on a market they
   * aren't in isn't a surprise for their position. Paused = all ops blocked
   * until governance unpauses; Frozen = no new supplies/borrows but existing
   * positions can still withdraw/repay.
   */
  warnings?: string[];
}

/**
 * A Compound V3 (Comet) position, flattened enough to slot alongside Aave in a unified
 * lending bucket. Kept as a thin projection of modules/compound/index.ts#CompoundPosition
 * so the types module doesn't need to pull in compound internals.
 */
export interface CompoundLendingPosition {
  protocol: "compound-v3";
  chain: SupportedChain;
  market: string;
  marketAddress: `0x${string}`;
  baseSupplied: TokenAmount | null;
  baseBorrowed: TokenAmount | null;
  collateral: TokenAmount[];
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
  /**
   * Governance-paused actions on this Comet market. Subset of
   * {supply, transfer, withdraw, absorb, buy}. Omitted when nothing is paused
   * so the JSON shape of healthy positions doesn't change.
   */
  pausedActions?: ("supply" | "transfer" | "withdraw" | "absorb" | "buy")[];
}

/**
 * A Morpho Blue position, flattened enough to slot alongside Aave and Compound in a
 * unified lending bucket. Thin projection of modules/morpho/index.ts#MorphoPosition
 * so the types module doesn't need to pull in morpho internals.
 */
export interface MorphoLendingPosition {
  protocol: "morpho-blue";
  chain: SupportedChain;
  marketId: `0x${string}`;
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  lltv: string;
  supplied: TokenAmount | null;
  borrowed: TokenAmount | null;
  collateral: TokenAmount | null;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
}

/** Any lending/borrowing position reported by the portfolio aggregator. */
export type LendingPositionUnion =
  | LendingPosition
  | CompoundLendingPosition
  | MorphoLendingPosition;

export interface LPPosition {
  protocol: "uniswap-v3";
  chain: SupportedChain;
  tokenId: string;
  token0: TokenAmount;
  token1: TokenAmount;
  /** Fee tier in hundredths of a bip (500 = 0.05%, 3000 = 0.30%, 10000 = 1.0%). */
  feeTier: number;
  tickLower: number;
  tickUpper: number;
  currentTick: number;
  inRange: boolean;
  liquidity: string;
  /**
   * Fees that have been checkpointed into NonfungiblePositionManager.tokensOwed
   * (e.g. by a prior collect/burn touch). Fees accrued since the last
   * checkpoint are NOT included — to see the full collectable amount, the
   * caller would need to simulate collect() against fork state. Treat this as
   * a LOWER BOUND on what a collect would return.
   */
  tokensOwedCached0: TokenAmount;
  tokensOwedCached1: TokenAmount;
  /**
   * USD value derived from token amounts computed at the current tick. This
   * is an approximation: withdrawing the position at a different price would
   * yield different amounts. Flagged as `valueUsdIsApproximate: true` so
   * callers don't display this as a precise number.
   */
  totalValueUsd: number;
  valueUsdIsApproximate: true;
}

export interface StakingPosition {
  protocol: "lido" | "eigenlayer";
  chain: SupportedChain;
  stakedAmount: TokenAmount;
  /** Current APR as a decimal (0.035 = 3.5%). */
  apr?: number;
  /** Optional delegation info (for EigenLayer). */
  delegatedTo?: `0x${string}`;
  /** Extra protocol-specific details (e.g. strategy address for EigenLayer). */
  meta?: Record<string, string | number | boolean>;
}
