// Shared domain types used across all modules.

/**
 * EVM chains supported by the server. Intentionally kept narrow so every
 * `Record<SupportedChain, …>` table in the codebase continues to represent
 * "per-EVM-chain" configuration — viem clients, Aave/Compound/Uniswap
 * addresses, numeric chain IDs, etc.
 *
 * Non-EVM chains (currently only TRON) live in `SupportedNonEvmChain`, and
 * the `AnyChain` union below is what cross-chain entry points (tool inputs,
 * portfolio summary) accept. This split keeps TRON strictly additive: EVM
 * internals don't need to learn that TRON exists.
 */
export type SupportedChain = "ethereum" | "arbitrum" | "polygon" | "base" | "optimism";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
  "optimism",
] as const;

/** Non-EVM chains. Kept as its own union so EVM-only tables keep their type. */
export type SupportedNonEvmChain = "tron" | "solana";

export const SUPPORTED_NON_EVM_CHAINS: readonly SupportedNonEvmChain[] = [
  "tron",
  "solana",
] as const;

/** Any chain the server knows about — EVM or non-EVM. */
export type AnyChain = SupportedChain | SupportedNonEvmChain;

export const ALL_CHAINS: readonly AnyChain[] = [
  ...SUPPORTED_CHAINS,
  ...SUPPORTED_NON_EVM_CHAINS,
] as const;

export function isEvmChain(c: AnyChain): c is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(c);
}

export type RpcProvider = "infura" | "alchemy" | "custom";

/** Numeric chain IDs for the chains we support. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  optimism: 10,
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
  137: "polygon",
  8453: "base",
  10: "optimism",
};

/**
 * TRON mainnet chain id, as used by the WalletConnect `tron:` namespace and
 * the TronGrid mainnet endpoint. The numeric value is 0x2b6653dc (728126428),
 * the first 4 bytes of the genesis block hash.
 */
export const TRON_CHAIN_ID = 728126428;

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
 * Per-subsystem status reported alongside a portfolio summary, so callers can
 * distinguish "no Aave position" (covered:true, positions empty) from "Aave
 * fetch failed" (covered:false, errored:true) from "not attempted" (covered:
 * false, errored:false — e.g. Morpho Blue, which requires caller-supplied
 * market ids and so has no on-chain enumeration path from a wallet).
 */
export interface CoverageStatus {
  covered: boolean;
  errored?: boolean;
  /** Free-form message explaining why `covered` is false when it is. */
  note?: string;
}

export interface PortfolioCoverage {
  aave: CoverageStatus;
  compound: CoverageStatus;
  morpho: CoverageStatus;
  uniswapV3: CoverageStatus;
  staking: CoverageStatus;
  /**
   * TRON balance fetch coverage. `covered:false, errored:false` means no TRON
   * address was queried (treated like Morpho's "not attempted"); errored:true
   * means a TronGrid call failed and TRX/TRC-20 are missing from totals.
   */
  tron?: CoverageStatus;
  /**
   * TRON staking fetch coverage — independent of the balance fetch so a
   * getReward/account outage doesn't mask that balances loaded fine.
   */
  tronStaking?: CoverageStatus;
  /**
   * Solana balance fetch coverage (SOL + SPL). `covered:false, errored:false`
   * means no Solana address was queried; errored:true means the Solana RPC
   * call failed and SOL/SPL are missing from totals.
   */
  solana?: CoverageStatus;
  /**
   * MarginFi position fetch coverage. Tracked separately from `solana` so a
   * MarginFi-reader failure doesn't mask a successful balance read (mirror of
   * `tronStaking` / `tron` split). Absent when no Solana address was queried.
   */
  marginfi?: CoverageStatus;
  /**
   * Kamino position fetch coverage. Same separation rationale as `marginfi` —
   * a Kamino-reader failure shouldn't mask a successful balance read. Absent
   * when no Solana address was queried.
   */
  kamino?: CoverageStatus;
  /**
   * Solana staking position fetch coverage (Marinade mSOL, Jito jitoSOL,
   * native stake accounts). Mirrors the `marginfi` split so a staking-
   * reader failure doesn't mask a successful balance read. Absent when no
   * Solana address was queried.
   */
  solanaStaking?: CoverageStatus;
  /**
   * Bitcoin balance fetch coverage. `covered:false, errored:false` means
   * no Bitcoin address(es) were queried (treated like the TRON / Solana
   * "not attempted" semantics); errored:true means the indexer call
   * failed and BTC totals are missing.
   */
  bitcoin?: CoverageStatus;
  /**
   * Litecoin balance fetch coverage. Mirrors `bitcoin` — covered:false +
   * errored:false means no LTC address was queried; errored:true means
   * the indexer call failed and LTC totals are missing. Issue #274.
   */
  litecoin?: CoverageStatus;
  /** Number of token balances whose USD valuation could not be resolved. */
  unpricedAssets: number;
  /**
   * Structured list of which specific tokens couldn't be priced — one entry
   * per affected balance. Previously only `unpricedAssets: N` (a count) was
   * surfaced, which left the agent unable to tell the user WHICH balance
   * was dropped from USD totals. With this list the agent can produce a
   * concrete warning like "705 MATIC on polygon couldn't be priced and isn't
   * included in the total" instead of a bare integer. Absent when
   * `unpricedAssets === 0` to keep happy-path responses lean (issue #94).
   */
  unpricedAssetsDetail?: UnpricedAsset[];
}

/**
 * A single unpriced balance the portfolio couldn't value in USD. The chain
 * is a string union spanning EVM + TRON + Solana so one array describes the
 * cross-chain set without needing per-chain buckets.
 */
export interface UnpricedAsset {
  chain: SupportedChain | "tron" | "solana" | "bitcoin" | "litecoin";
  symbol: string;
  /** Human-readable balance (already-decimals-applied), e.g. "705.141". */
  amount: string;
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

export interface PrivilegedRole {
  role: string;
  holder: `0x${string}`;
  isContract: boolean;
  isMultisig: boolean;
  hasTimelock: boolean;
  timelockDelaySeconds?: number;
}

export interface SecurityReport {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  admin?: `0x${string}`;
  dangerousFunctions: string[];
  privilegedRoles: PrivilegedRole[];
}

/**
 * A TRON token balance. Shaped like TokenAmount but with a base58 `token`
 * address (TRC-20 contracts are base58, starting with 'T') and a `chain`
 * discriminator so consumers can tell TRC-20 apart from ERC-20 at runtime.
 * Kept separate from TokenAmount so existing EVM readers don't grow a
 * `chain: "tron"` branch they'd never exercise.
 */
export interface TronBalance {
  chain: "tron";
  /** Base58 TRC-20 contract address (prefix `T`), or "native" for TRX. */
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  priceMissing?: boolean;
}

/**
 * Solana balance shape — a parallel to TronBalance for SOL + SPL tokens.
 * `token` is a base58 SPL mint address (~32-44 chars), or "native" for SOL.
 * SPL balances come from Associated Token Accounts but we surface them by
 * mint; the ATA is an implementation detail the caller shouldn't care about.
 */
export interface SolanaBalance {
  chain: "solana";
  /** Base58 SPL mint address, or "native" for SOL. */
  token: string;
  symbol: string;
  decimals: number;
  amount: string;
  formatted: string;
  valueUsd?: number;
  priceUsd?: number;
  priceMissing?: boolean;
}

/**
 * Solana slice of a portfolio summary. Parallel to TronPortfolioSlice.
 * Phase 1 did not enumerate native validator staking; Phase 3 adds
 * MarginFi lending.
 */
export interface SolanaPortfolioSlice {
  /** Base58 Solana address the balances were resolved for. */
  address: string;
  native: SolanaBalance[];
  spl: SolanaBalance[];
  walletBalancesUsd: number;
  /**
   * MarginFi lending positions (Phase 3). Present only when the wallet has
   * at least one MarginfiAccount with non-zero balances — probed via the
   * deterministic PDA at accountIndex 0..3. An empty/missing field means
   * no MarginFi position, not "reader errored" (errored case is surfaced
   * through PortfolioCoverage.marginfi).
   */
  marginfi?: SolanaMarginfiPositionSlice[];
  /** MarginFi aggregate net USD (sum of netValueUsd across positions). */
  marginfiNetUsd?: number;
  /**
   * Kamino lending positions on the main market. Present when the wallet
   * has Kamino userMetadata + obligation with non-zero deposits or borrows.
   * Empty/missing means no position; errored case surfaces through
   * PortfolioCoverage.kamino.
   */
  kamino?: SolanaKaminoPositionSlice[];
  /** Kamino aggregate net USD (sum of netValueUsd across positions). */
  kaminoNetUsd?: number;
  /**
   * Solana staking positions — Marinade mSOL, Jito jitoSOL, native stake
   * accounts. Present when any of the three sections is non-empty for
   * this wallet. Missing means nothing found (errored case surfaces
   * through PortfolioCoverage.solanaStaking).
   */
  staking?: SolanaStakingPositionSlice;
  /** Solana staking aggregate net USD (SOL-equivalent × SOL price). */
  stakingNetUsd?: number;
}

/**
 * Thin projection of the three staking readers' output
 * (`src/modules/positions/solana-staking.ts`). Kept in sync with
 * `SolanaStakingPositions` but stripped down — the portfolio JSON doesn't
 * need the per-reader wrapper metadata (wallet duplication, protocol
 * tags on subtotals).
 */
export interface SolanaStakingPositionSlice {
  chain: "solana";
  /** mSOL balance + SOL-equivalent via Marinade's on-chain mSolPrice. */
  marinade: {
    mSolBalance: number;
    solEquivalent: number;
    exchangeRate: number;
  };
  /** jitoSOL balance + SOL-equivalent via stake-pool's totalLamports/supply. */
  jito: {
    jitoSolBalance: number;
    solEquivalent: number;
    exchangeRate: number;
  };
  /** One entry per native stake account (SPL stake-program) with activation status. */
  nativeStakes: Array<{
    stakePubkey: string;
    validator?: string;
    stakeSol: number;
    status: "activating" | "active" | "deactivating" | "inactive";
    activationEpoch?: number;
    deactivationEpoch?: number;
  }>;
  /** Sum of SOL-equivalents across Marinade + Jito + native stakes. */
  totalSolEquivalent: number;
}

/**
 * Thin projection of the full `MarginfiPosition` type exposed by
 * `src/modules/positions/marginfi.ts`. Kept here so the portfolio types
 * module doesn't pull in the reader module's internals, matching how
 * CompoundLendingPosition / MorphoLendingPosition are projections of their
 * reader modules.
 */
export interface SolanaMarginfiPositionSlice {
  protocol: "marginfi";
  chain: "solana";
  marginfiAccount: string;
  supplied: Array<{ symbol: string; amount: string; valueUsd: number }>;
  borrowed: Array<{ symbol: string; amount: string; valueUsd: number }>;
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  healthFactor: number;
  warnings: string[];
}

/**
 * Thin projection of the full `KaminoPosition` type exposed by
 * `src/modules/positions/kamino.ts`. Same shape as MarginFi's slice; the
 * `obligation` field is Kamino's per-(wallet, market, kind) state account
 * (analogous to `marginfiAccount`).
 */
export interface SolanaKaminoPositionSlice {
  protocol: "kamino";
  chain: "solana";
  obligation: string;
  supplied: Array<{ symbol: string; amount: string; valueUsd: number }>;
  borrowed: Array<{ symbol: string; amount: string; valueUsd: number }>;
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  netValueUsd: number;
  healthFactor: number;
  warnings: string[];
}

/**
 * TRON slice of a portfolio summary. Contains the TRON-specific address the
 * balances were fetched for (base58, which can't fit into the `wallet:
 * 0x${string}` field on PortfolioSummary), TRX native balance, and TRC-20
 * balances. Wallet-level coverage for TRON is tracked via
 * PortfolioCoverage.tron.
 */
export interface TronPortfolioSlice {
  /** Base58 TRON address the balances were resolved for. */
  address: string;
  native: TronBalance[];
  trc20: TronBalance[];
  walletBalancesUsd: number;
  /**
   * Staking position (frozen TRX, pending unfreezes, claimable rewards).
   * Absent when the portfolio aggregator chose not to fetch staking (or
   * when the TRON staking fetch failed — see PortfolioCoverage.tronStaking).
   */
  staking?: TronStakingSlice;
}

/**
 * A single "frozen for resource" entry under TRON's Stake 2.0 model. Users
 * freeze TRX to obtain BANDWIDTH or ENERGY; the frozen TRX is what underlies
 * their voting rights. Amount is reported in SUN (raw) + TRX (formatted).
 */
export interface TronFrozenEntry {
  type: "bandwidth" | "energy";
  /** Raw SUN (1 TRX = 1_000_000 SUN). */
  amount: string;
  /** Human-formatted TRX. */
  formatted: string;
  valueUsd?: number;
}

/**
 * A pending unfreeze — the user initiated unstaking but the lockup window
 * (14 days on mainnet) hasn't elapsed yet. `unlockAt` is the ISO timestamp
 * after which `withdrawExpireUnfreeze` can claim the TRX back to liquid.
 */
export interface TronPendingUnfreeze {
  type: "bandwidth" | "energy";
  amount: string;
  formatted: string;
  /** ISO 8601 timestamp when the TRX becomes withdrawable. */
  unlockAt: string;
  valueUsd?: number;
}

/**
 * Claimable voting rewards (distributed by the Super Representative the user
 * voted for). Claiming requires a WithdrawBalance tx, landing in Phase 2.
 */
export interface TronClaimableReward {
  amount: string;
  formatted: string;
  valueUsd?: number;
}

/**
 * Live resource meter for a TRON account, in consumable UNITS (not TRX).
 * Units are what each contract call charges against; frozen TRX only
 * determines how many units you receive per day. `used` rolls off linearly
 * over the 24h regen window, so `available = limit - used` is the
 * instantaneous remaining headroom.
 */
export interface TronResourceMeter {
  /** Units consumed in the current 24h window. */
  usedUnits: number;
  /** Total units available per 24h window at current freeze level. */
  limitUnits: number;
  /** `limitUnits - usedUnits` — immediately consumable. */
  availableUnits: number;
}

/**
 * Live account-resource snapshot from TronGrid's `/wallet/getaccountresource`.
 * Distinct from `TronFrozenEntry`: that's the frozen TRX backing the
 * resource, this is the units-available-right-now meter.
 *
 * Bandwidth has two sub-pools: `free` (600 units/day granted to every
 * account, independent of stake) and `staked` (proportional to frozen TRX).
 * TronGrid returns them as separate fields; we expose both because a fresh
 * account with no stake still has the free pool and agents need to reason
 * about it.
 */
export interface TronAccountResources {
  bandwidth: {
    free: TronResourceMeter;
    staked: TronResourceMeter;
  };
  energy: TronResourceMeter;
  /**
   * Voting power derived from frozen TRX (1 TRX = 1 vote). `used` is how
   * many votes are currently cast across all SRs; `available` is the
   * unallocated headroom a new `prepare_tron_vote` can spend.
   */
  votingPower: TronResourceMeter;
}

/**
 * TRON staking view: frozen resources, pending unfreezes, claimable rewards.
 * Totals roll up into the portfolio's `tronUsd` via `totalStakedUsd`.
 */
export interface TronStakingSlice {
  address: string;
  claimableRewards: TronClaimableReward;
  frozen: TronFrozenEntry[];
  pendingUnfreezes: TronPendingUnfreeze[];
  /**
   * Live consumable-units meter (independent of frozen TRX). Absent only
   * when TronGrid's `/wallet/getaccountresource` fails — the rest of the
   * staking slice still returns.
   */
  resources?: TronAccountResources;
  /**
   * Per-SR vote allocation — same shape `list_tron_witnesses(address)`
   * exposes via its `userVotes` field. Surfaced here too (issue #271) so
   * an agent answering "consolidate my votes onto the SR I'm already
   * voting for" or "rebalance freshly-unlocked TRON Power onto the same
   * SRs" doesn't have to chain `list_tron_witnesses` after
   * `get_tron_staking` (or, worse, fall back to bash + curl against
   * TronGrid). Empty array when the wallet has no votes cast.
   *
   * Each entry's `address` is the base58 SR address; `count` is integer
   * votes (1 vote = 1 frozen TRX of TRON Power). `prepare_tron_vote`
   * REPLACES the entire vote allocation, so callers wanting to
   * consolidate / rebalance must include every existing entry plus
   * adjustments — this field gives them the exact baseline to mutate.
   */
  votes: TronVoteAllocation[];
  /** Frozen + pending-unfreeze + claimable, in TRX (formatted). */
  totalStakedTrx: string;
  /** USD value of everything above at current TRX price. */
  totalStakedUsd: number;
}

/**
 * A single Super Representative / SR candidate entry from TronGrid's
 * `/wallet/listwitnesses`. Ranks are 1-based by voteCount DESC; active SRs
 * are rank ≤ 27 (those that actually produce blocks and distribute voter
 * rewards). Candidates have rank > 27 and receive no voter rewards.
 */
export interface TronWitnessInfo {
  /** Base58 TRON address (prefix T). */
  address: string;
  /** SR operator URL (self-declared; not validated). */
  url?: string;
  /** Total vote weight for this SR, as a decimal string (1 frozen TRX = 1 vote). */
  voteCount: string;
  /** True iff rank ≤ 27 — this SR produces blocks. */
  isActive: boolean;
  /** 1-based rank by voteCount DESC. */
  rank: number;
  totalProduced?: number;
  totalMissed?: number;
  /**
   * Rough annualised voter APR estimate as a decimal fraction (0.04 = 4 %).
   * Computed from mainnet reward constants (160 TRX/block voter pool, ~28 800
   * blocks/day, 365 days/year) divided by the total vote weight across the
   * top 127 witnesses — the APR is therefore roughly uniform for every
   * witness in the top 127. Witnesses ranked > 127 get 0. This is an
   * ESTIMATE — actual rewards depend on per-SR commission, missed blocks,
   * chain-param changes, and competing voters joining/leaving between your
   * vote tx and reward claim.
   */
  estVoterApr?: number;
}

/** The wallet's current vote allocation from `account.votes`. */
export interface TronVoteAllocation {
  /** Base58 SR address the vote is cast for. */
  address: string;
  /** Integer vote count (1 vote = 1 frozen TRX of TRON Power). */
  count: number;
}

export interface TronWitnessList {
  witnesses: TronWitnessInfo[];
  /** Present only when the caller passed `address`. */
  userVotes?: TronVoteAllocation[];
  /**
   * Total TRON Power available to the caller's wallet (= integer TRX frozen
   * under Stake 2.0, summed across bandwidth + energy). Set when `address`
   * is passed.
   */
  totalTronPower?: number;
  /** Sum of userVotes[].count. Set when `address` is passed. */
  totalVotesCast?: number;
  /** totalTronPower − totalVotesCast, floored at 0. Set when `address` is passed. */
  availableVotes?: number;
}

/**
 * Bitcoin slice of a portfolio summary. Parallel to `TronPortfolioSlice`
 * + `SolanaPortfolioSlice`. Bitcoin has no fungible token model in
 * Phase 1 (BRC-20 / Runes / Ordinals deferred), so the slice carries
 * only per-address native balances + the rolled-up USD totals.
 *
 * Multi-address: every BTC address the caller passed via
 * `bitcoinAddress` (single) or `bitcoinAddresses` (array) is surfaced
 * here. This mirrors `get_btc_balances` shape so callers who already
 * use that tool see the same per-address projection inside the
 * portfolio response.
 */
export interface BitcoinPortfolioSlice {
  /** All addresses queried for this slice — at least one. */
  addresses: string[];
  /**
   * Per-address breakdown. Each entry carries confirmed + mempool +
   * total sats, the BTC-decimal projection, the address type, and the
   * USD valuation. Identical shape to `BitcoinBalance` from the
   * `btc/balances.ts` reader.
   */
  balances: Array<{
    address: string;
    addressType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
    confirmedSats: string;
    mempoolSats: string;
    totalSats: string;
    confirmedBtc: string;
    totalBtc: string;
    symbol: "BTC";
    decimals: 8;
    txCount: number;
    valueUsd?: number;
    /** True when DefiLlama returned no price; balance is excluded from totals. */
    priceMissing?: boolean;
  }>;
  /** Rolled-up USD value across all addresses (uses confirmed balance). */
  walletBalancesUsd: number;
}

/**
 * Litecoin slice of a portfolio summary. Mirror of `BitcoinPortfolioSlice`.
 * Same UTXO model, same balance projection, different symbol/HRP.
 */
export interface LitecoinPortfolioSlice {
  addresses: string[];
  balances: Array<{
    address: string;
    addressType: "p2pkh" | "p2sh" | "p2wpkh" | "p2wsh" | "p2tr";
    confirmedSats: string;
    mempoolSats: string;
    totalSats: string;
    confirmedLtc: string;
    totalLtc: string;
    symbol: "LTC";
    decimals: 8;
    txCount: number;
    valueUsd?: number;
    priceMissing?: boolean;
  }>;
  walletBalancesUsd: number;
}

/** Per-wallet slice of a multi-wallet portfolio, or a stand-alone single-wallet summary. */
export interface PortfolioSummary {
  wallet: `0x${string}`;
  chains: SupportedChain[];
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  totalUsd: number;
  perChain: Record<SupportedChain, number>;
  /**
   * TRON totals folded into the same number as EVM. Present when the caller
   * passed a `tronAddress` (or TRON is in the default chain set and an
   * address was resolvable).
   */
  tronUsd?: number;
  /**
   * TRON staking USD (frozen + pending-unfreeze + claimable). Already included
   * in `tronUsd` — this field surfaces it separately for UI. Present only when
   * staking was fetched successfully.
   */
  tronStakingUsd?: number;
  /**
   * Solana totals folded into the same aggregate as EVM/TRON. Present when
   * the caller passed a `solanaAddress`. Phase 1 covers balances; Phase 3
   * adds MarginFi lending (surfaced separately via `solanaLendingUsd`).
   */
  solanaUsd?: number;
  /**
   * Solana lending net USD — MarginFi (Phase 3). Parallels `tronStakingUsd`
   * as a carve-out that's separately surfaced in UIs but also folded into
   * `totalUsd`. Present only when at least one MarginfiAccount was found
   * for the wallet.
   */
  solanaLendingUsd?: number;
  /**
   * Solana staking net USD — Marinade mSOL + Jito jitoSOL + native stake
   * accounts (roadmap #2). Computed as `totalSolEquivalent * SOL price`
   * using the same SOL price that valued the native-SOL balance line.
   * Folded into `totalUsd`; carve-out here for UIs. Present only when the
   * wallet holds at least some Solana staking.
   */
  solanaStakingUsd?: number;
  /**
   * Bitcoin totals (sum across every address passed via `bitcoinAddress` /
   * `bitcoinAddresses`). Present only when the caller supplied at least
   * one BTC address. Folded into `totalUsd`.
   */
  bitcoinUsd?: number;
  /**
   * Litecoin totals (sum across every address passed via `litecoinAddress` /
   * `litecoinAddresses`). Present only when the caller supplied at least
   * one LTC address. Folded into `totalUsd`.
   */
  litecoinUsd?: number;
  breakdown: {
    native: TokenAmount[];
    erc20: TokenAmount[];
    lending: LendingPositionUnion[];
    lp: LPPosition[];
    staking: StakingPosition[];
    /** TRON slice — absent when no TRON address was queried. */
    tron?: TronPortfolioSlice;
    /** Solana slice — absent when no Solana address was queried. */
    solana?: SolanaPortfolioSlice;
    /** Bitcoin slice — absent when no BTC address(es) were queried. */
    bitcoin?: BitcoinPortfolioSlice;
    /** Litecoin slice — absent when no LTC address(es) were queried. */
    litecoin?: LitecoinPortfolioSlice;
  };
  coverage: PortfolioCoverage;
}

/** Multi-wallet portfolio aggregation. */
export interface MultiWalletPortfolioSummary {
  wallets: `0x${string}`[];
  chains: SupportedChain[];
  totalUsd: number;
  walletBalancesUsd: number;
  lendingNetUsd: number;
  lpUsd: number;
  stakingUsd: number;
  perChain: Record<SupportedChain, number>;
  perWallet: PortfolioSummary[];
  /**
   * Non-EVM holdings surfaced as PARALLEL siblings of the EVM wallets,
   * NOT folded into any specific `perWallet[i]`. Issue #201 — TRON / BTC /
   * Solana addresses on a Ledger are independent identities (different
   * BIP-44 derivation paths), so attributing them to "the first EVM
   * wallet" produced misleading per-wallet rollups.
   *
   * Each chain's slice is surfaced when the corresponding address arg
   * (`tronAddress`/`tronAddresses`, `solanaAddress`/`solanaAddresses`,
   * `bitcoinAddress`/`bitcoinAddresses`) was passed to
   * `getPortfolioSummary`. The USD rollups below sum across whichever
   * slices were fetched.
   */
  nonEvm?: {
    /** Per-address TRON slice; one entry per requested tronAddress. */
    tron?: TronPortfolioSlice[];
    /** Per-address Solana slice; one entry per requested solanaAddress. */
    solana?: SolanaPortfolioSlice[];
    /** Multi-address Bitcoin slice; aggregates every requested btc address. */
    bitcoin?: BitcoinPortfolioSlice;
    /** Multi-address Litecoin slice; aggregates every requested ltc address. */
    litecoin?: LitecoinPortfolioSlice;
  };
  /** Sum of all TRON wallet balances (TRX + TRC-20) across the queried addresses. */
  tronUsd?: number;
  /** Sum of TRON staking (frozen TRX + claimable rewards). */
  tronStakingUsd?: number;
  /** Sum of all Solana wallet balances (SOL + SPL) across queried addresses. */
  solanaUsd?: number;
  /** Sum of MarginFi + Kamino netValueUsd across queried Solana addresses. */
  solanaLendingUsd?: number;
  /** Sum of Marinade + Jito + native-stake totals across queried Solana addresses. */
  solanaStakingUsd?: number;
  /** Sum of BTC × USD-price across queried Bitcoin addresses. */
  bitcoinUsd?: number;
  /** Sum of LTC × USD-price across queried Litecoin addresses. */
  litecoinUsd?: number;
  coverage: PortfolioCoverage;
}

/**
 * Unsigned TRON transaction. Shape is unavoidably different from EVM:
 * TronGrid builds the tx server-side (raw_data + raw_data_hex) and the
 * device signs the serialized raw_data_hex. We keep the TRON tx shape
 * separate from UnsignedTx so send_transaction's EVM-only security pipeline
 * (eth_call re-simulation, chain-id check, spender allowlist) can't be
 * silently shortcut by a TRON handle masquerading as an EVM one.
 *
 * Phase 3 (this release) routes TRON handles through `send_transaction`:
 * the USB HID signer (@ledgerhq/hw-app-trx) verifies the device address
 * matches `from`, signs `rawDataHex`, and broadcasts via TronGrid.
 */
export interface UnsignedTronTx {
  chain: "tron";
  /** Discriminator for the preview + future signer branching. */
  action:
    | "native_send"
    | "trc20_send"
    | "trc20_approve"
    | "claim_rewards"
    | "freeze"
    | "unfreeze"
    | "withdraw_expire_unfreeze"
    | "vote"
    | "lifi_swap"
    | "sunswap_swap";
  /** Base58 owner address (prefix T). */
  from: string;
  /** TronGrid-returned transaction ID (sha256 of raw_data_hex, hex string). */
  txID: string;
  /**
   * TronGrid's raw_data object — opaque to us; serialized in raw_data_hex.
   * Required for the standard `/wallet/broadcasttransaction` path. ABSENT
   * for `lifi_swap` flows where we receive only `raw_data_hex` from LiFi
   * and broadcast via `/wallet/broadcasthex` instead (broadcast.ts branches
   * on this).
   */
  rawData?: unknown;
  /** Hex-encoded raw_data used by the signer. */
  rawDataHex: string;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
    /**
     * ABI-encoded parameter payload (no `0x`, no selector) for TRC-20 calls.
     * Set by the trc20_send / trc20_approve builders so the verification
     * layer can compose the full calldata (`0x<selector><parameterHex>`)
     * without re-deriving it from the human-readable args.
     */
    parameterHex?: string;
  };
  /**
   * Fee limit in SUN, present on contract calls (TRC-20 transfers require it;
   * TronGrid rejects triggersmartcontract without one). Absent on native TRX
   * sends and WithdrawBalance — those pay bandwidth only.
   */
  feeLimitSun?: string;
  /**
   * Energy units the pre-flight triggerconstantcontract call consumed. Only
   * present on contract calls where we pre-flight (TRC-20 transfers). The
   * on-chain burn will be within a few percent of this number.
   */
  estimatedEnergyUsed?: string;
  /**
   * Estimated fee in SUN that will actually burn on-chain — energy units
   * times the mainnet energy price (420 sun/energy as of 2024-10). The
   * preview shows this alongside `feeLimitSun` so the user can see
   * "expected ~15 TRX" next to "cap 100 TRX" and not think the cap is the
   * charge.
   */
  estimatedEnergyCostSun?: string;
  /** Opaque handle — see tron-tx-store.ts. Phase 3 signer consumes this. */
  handle?: string;
  /**
   * Pre-sign verification payload, stamped by `issueTronHandle` on every
   * prepared TRON tx. Optional during rollout; flipped to required after
   * all call sites are updated.
   */
  verification?: TxVerification;
  /**
   * Invariant #14 — durable-binding source-of-truth verification (issue
   * #460). Populated by `prepare_tron_vote` (one binding per Super
   * Representative voted for). Absent on other TRON op kinds.
   */
  durableBindings?: import("../security/durable-binding.js").DurableBinding[];
}

/**
 * Unsigned Solana transaction. Parallel to `UnsignedTronTx` — kept separate
 * from `UnsignedTx` so `send_transaction`'s EVM-only security pipeline
 * (eth_call re-simulation, EIP-1559 pin, spender allowlist) can't be
 * silently shortcut by a Solana handle, and parallel to `UnsignedTronTx`
 * because Solana's wire format (Ed25519 sig over a serialized tx message)
 * is its own thing.
 *
 * Signing path: USB HID via `@ledgerhq/hw-app-solana` — Ledger Live's
 * WalletConnect integration does NOT expose Solana accounts, so we mirror
 * the TRON USB HID architecture (see `project_ledger_live_solana_wc.md`).
 */
export interface UnsignedSolanaTx {
  chain: "solana";
  /**
   * Discriminator for the preview + future signer branching.
   *
   * - `native_send` / `spl_send` — user-facing transfers. Durable-nonce-
   *   protected (ix[0] = nonceAdvance); every send refuses to build until
   *   the wallet has an initialized nonce account.
   * - `nonce_init` — one-time setup: createAccountWithSeed + nonceInitialize.
   *   Runs in legacy recent-blockhash mode (no nonce to use yet).
   * - `nonce_close` — teardown: nonceAdvance + nonceWithdraw. Drains the
   *   rent-exempt balance back to the user's main wallet.
   */
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "jito_stake"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  /** Base58 owner address (44-char ed25519 pubkey). */
  from: string;
  /**
   * Base64-encoded serialized Solana tx MESSAGE (what the Ledger Solana app
   * signs). Post-sign, broadcast rebuilds the full tx = message + signature.
   * Message bytes bake the recent blockhash, fee payer, all instructions
   * and accounts — tampering with any of these at send time will cause
   * either the device address check or the on-chain signature verification
   * to fail.
   *
   * Pinned by `preview_solana_send` with a fresh blockhash, immediately before
   * signing. `prepare_solana_*` stores a draft (no blockhash); the pinned
   * form only exists after preview runs. `send_transaction` requires it.
   */
  messageBase64: string;
  /**
   * Blockhash baked into the message, pinned at `preview_solana_send` time.
   * Solana txs are valid for ~150 blocks (~60s) from this hash's slot, so
   * the preview → send window is bounded — `preview_solana_send` emits a
   * fresh hash right before broadcast so the full window is available.
   */
  recentBlockhash: string;
  /**
   * Last block height at which `recentBlockhash` remains valid. Captured
   * from `getLatestBlockhash` at pin time; carried through broadcast and
   * surfaced by `send_transaction` so the subsequent status-poller can
   * tell "dropped" (current slot > this) from "not-yet-propagated" when
   * `getSignatureStatuses` returns null.
   */
  lastValidBlockHeight?: number;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  /**
   * Rent cost in lamports when this tx includes a
   * `createAssociatedTokenAccount` instruction (recipient doesn't hold the
   * mint yet). Absent when the tx is a plain transfer. Surfaced so the
   * preview can say "+0.00204 SOL rent to create recipient's USDC account".
   */
  rentLamports?: number;
  /**
   * Priority fee (micro-lamports per compute unit) baked into the message.
   * Present only when `getRecentPrioritizationFees` indicated network
   * congestion at prepare time and we injected ComputeBudget instructions.
   * Absent means "no priority fee; base fee only".
   */
  priorityFeeMicroLamports?: number;
  /** Compute-unit limit when ComputeBudget was added. */
  computeUnitLimit?: number;
  /** Estimated total fee in lamports (base + priority). For the preview. */
  estimatedFeeLamports?: number;
  /** Opaque handle — see solana-tx-store.ts. `send_transaction` consumes this. */
  handle?: string;
  /**
   * Server-minted UUID, set by `preview_solana_send` (every pin — fresh on
   * `refresh`). Echoed back through `send_transaction`'s `previewToken`
   * arg to prove the agent actually ran preview AND surfaced the CHECKS
   * PERFORMED block before the user replied "send". Mirrors the EVM
   * `previewToken` gate — a hostile agent can still forge it after a real
   * preview, so this is a careless-mistake backstop, not a coordinated-
   * lying defense.
   */
  previewToken?: string;
  /**
   * Pre-sign verification payload, stamped by `issueSolanaHandle` on every
   * prepared Solana tx. Mirrors the TRON / EVM verification shape.
   */
  verification?: TxVerification;
  /**
   * Pre-sign simulation result. Populated by `preview_solana_send` via
   * `connection.simulateTransaction(sigVerify: false, replaceRecentBlockhash:
   * false)` against the pinned message. Absent only when the caller
   * explicitly skipped simulation (currently `nonce_init`, which is legacy
   * and has no interesting revert surface) OR when the simulation RPC
   * itself errored transiently — in both cases `preview_solana_send`
   * proceeds so a momentary network hiccup can't block a user's flow.
   *
   * When present with `ok: false` the preview handler throws BEFORE
   * returning, so this field effectively always carries `ok: true` on the
   * wire — but the shape keeps `ok: boolean` so downstream callers that
   * might loosen the throw policy (e.g. a future "force" flag) stay
   * type-correct.
   */
  simulation?: {
    ok: boolean;
    unitsConsumed?: number;
    logs?: string[];
    err?: string;
    anchorError?: { code: number; name: string; message: string };
  };
  /**
   * Durable-nonce metadata — present when ix[0] = SystemProgram.nonceAdvance.
   * For `native_send` / `spl_send` / `nonce_close` this is always set; for
   * `nonce_init` it's absent (that's the tx that CREATES the nonce account;
   * it has no nonce to consume yet). Surfaced for the summary renderer
   * (`Nonce: <short addr>` bullet) and for future nonce-aware dropped-tx
   * polling (`getNonceAccountValue` to detect advance vs. stuck).
   */
  nonce?: {
    account: string;
    authority: string;
    value: string;
  };
}

/**
 * Per-argument decode from the calldata — one entry per ABI input field.
 * `valueHuman` is populated only when we can apply decimals + symbol (known
 * ERC-20 tokens via `TOKEN_META`). For everything else, `value` is the raw
 * stringified bigint / address / bytes and callers render that directly.
 */
export interface DecodedArg {
  name: string;
  type: string;
  value: string;
  valueHuman?: string;
}

/**
 * Local decode of the exact calldata that will be signed. Built from the
 * static ABI registry in `src/abis/*` via viem's `decodeFunctionData`. Never
 * calls a network — if the destination isn't in our registry, `source` is
 * `"none"` and the user is told to rely entirely on the swiss-knife URL.
 */
export interface HumanDecode {
  /** Function name (`"supply"`), or `"nativeTransfer"` / `"unknown"`. */
  functionName: string;
  /** Full signature like `supply(address,uint256,address,uint16)`. */
  signature?: string;
  args: DecodedArg[];
  /**
   * - `"local-abi"`: full decode against an ABI in our static registry — `functionName` is the canonical on-chain name and is corroborable against 4byte.directory's selector→name mapping.
   * - `"local-abi-partial"`: the destination is in our registry but the specific selector/facet isn't (e.g. LiFi Diamond bridge facets) — we surfaced a positional decode of a known shared sub-tuple, but `functionName` is synthetic and MUST NOT be cross-checked against 4byte (a name-equality check would always fail by design).
   * - `"native"`: pure native-value transfer, no calldata.
   * - `"none"`: unknown destination, no decode possible.
   */
  source: "local-abi" | "local-abi-partial" | "native" | "none";
}

/**
 * Pre-sign verification payload — attached to EVERY prepared transaction
 * unconditionally. The user is expected to open `decoderUrl` in a browser,
 * compare what swiss-knife.xyz decodes against `humanDecode` in chat, and
 * only approve on Ledger if the two agree. The `payloadHash` is a
 * domain-tagged keccak256 that can be recomputed independently from the
 * swiss-knife URL params and is re-checked at send time against the exact
 * bytes forwarded to WalletConnect (the bytes-we-previewed == bytes-we-sign
 * proof).
 */
export interface TxVerification {
  /** keccak256 of `("VaultPilot-txverify-v1:" ‖ chainId ‖ to ‖ value ‖ data)` for EVM; `("VaultPilot-txverify-v1:tron:" ‖ rawDataHex)` for TRON. */
  payloadHash: `0x${string}`;
  /** First 8 hex chars (no `0x`) of `payloadHash` — short enough to read off a Ledger screen and eyeball-match. */
  payloadHashShort: string;
  /** swiss-knife.xyz decoder URL with calldata, address, chainId preloaded. EVM only; absent when calldata is too large to fit or on TRON. */
  decoderUrl?: string;
  /** Fallback when `decoderUrl` can't be built — short instructions telling the user to paste calldata/address/chainId manually. */
  decoderPasteInstructions?: string;
  /** Local decode of the calldata (viem + ABI registry). */
  humanDecode: HumanDecode;
  /** Canonical comparison string `<chainId>:<to>:<value>:<data>` — exactly the four fields fed into the fingerprint. */
  comparisonString: string;
  /**
   * TRC-20 calldata bytes (`0x` + 4-byte selector + ABI-encoded params) for
   * `trc20_send` / `trc20_approve` actions. Surfaced so the agent can
   * (a) decode the recipient slot itself and cross-check it against the
   * typed base58 address (mirror of EVM CHECK 1), and (b) splice into a
   * swiss-knife.xyz decoder URL the user can open in the browser. Absent
   * for native TRX sends, freeze/unfreeze, votes, and other non-ABI
   * actions — those have no calldata to decode.
   */
  tronCalldataHex?: `0x${string}`;
}

/** Unsigned transaction, ready to be sent to Ledger Live for signing. */
export interface UnsignedTx {
  chain: SupportedChain;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Value in wei as a decimal string (so JSON-safe). */
  value: string;
  from?: `0x${string}`;
  /** Human-readable description (e.g. "Supply 1.0 USDC to Aave V3 on Ethereum"). */
  description: string;
  /** Decoded function name + args for display. */
  decoded?: {
    functionName: string;
    args: Record<string, string>;
  };
  /** Estimated gas as a decimal string. */
  gasEstimate?: string;
  /** Estimated gas cost in USD. */
  gasCostUsd?: number;
  /**
   * Estimated gas cost denominated in the chain's native asset (ETH on
   * ethereum/arbitrum/base/optimism, MATIC/POL on polygon), as a string
   * formatted at 18 decimals. Stored alongside `gasCostUsd` so the cost
   * preview block (issue #636) can render the native fee even when the
   * USD price lookup degrades (no network / DefiLlama miss). Both halves
   * are populated by `enrichTx` when gas estimation succeeds; both stay
   * undefined when it fails.
   */
  gasCostNative?: string;
  /**
   * Result of an eth_call simulation against the current chain state. `ok:false`
   * with a revertReason is expected on the follow-up tx of an approve→action
   * pair at prepare time (the approve hasn't been mined yet). At sign time, the
   * same simulation is re-run and a revert aborts the signing path.
   */
  simulation?: {
    ok: boolean;
    revertReason?: string;
  };
  /** If this tx is a prerequisite (e.g. ERC-20 approve), the follow-up tx is in `next`. */
  next?: UnsignedTx;
  /**
   * Opaque handle issued by the tx-store when the prepared tx is returned to
   * the caller. `send_transaction` accepts ONLY this handle — raw calldata is
   * not acceptable, which binds the signed tx to the previewed one and closes
   * the prompt-injection → arbitrary-signing path.
   */
  handle?: string;
  /**
   * Pre-sign verification payload — decoder URL, local decode, and a
   * domain-tagged payload hash. Stamped by `issueHandles` on every prepared
   * EVM tx. Optional during rollout; flipped to required once all call
   * sites are updated.
   */
  verification?: TxVerification;
  /**
   * Address-book resolution metadata — populated by `resolveRecipient`
   * when the user's `to` arg matched a contact label, ENS, or a literal
   * address that reverse-decorated to a saved label. Threaded through to
   * the verification renderer so the user sees `to: 0xAbC… (contact: Mom
   * — verified)` instead of just the raw hex. Absent for prepares that
   * don't take a recipient (e.g. swap, lending). Issue: address-book
   * v1.0.
   */
  recipient?: {
    /** Saved label, if any (resolved-from or reverse-decorated). */
    label?: string;
    /** How the address was resolved. */
    source: "literal" | "contact" | "ens" | "unknown";
    /** Non-fatal warnings (e.g. "contacts file failed verification — recipient label not checked"). */
    warnings?: string[];
  };
  /**
   * Non-standard ERC-20 transfer-semantics flags (issue #441) — looked
   * up at `prepare_token_send` time from the curated registry in
   * `modules/execution/token-class.ts`. Absent when the token is plain
   * ERC-20 (no point surfacing `flags: ["standard"]` and adding noise
   * to every receipt). When present, the verification renderer
   * appends `warnings[]` as `⚠ <warning>` lines so the user reads
   * them before signing — caught the smoke-test case where a 0.3 stETH
   * transfer landed 1-2 wei short with no warning (script 019).
   */
  tokenClass?: {
    flags: Array<
      | "standard"
      | "rebasing"
      | "fee_on_transfer"
      | "pausable"
      | "blocklisted"
      | "upgradeable_admin"
    >;
    warnings: string[];
  };
  /**
   * Set when the tx was built by `prepare_custom_call` after the user passed
   * the affirmative `acknowledgeNonProtocolTarget: true` schema-enforced
   * gate. Read by `assertTransactionSafe` to skip ONLY the catch-all
   * "unknown destination" refusal at preview/send time — every other
   * pre-sign defense (approve-spender allowlist, transfer-on-unknown-token,
   * allowed-ABI-selector check) stays active. Issue #496.
   *
   * Trust note: this flag flows through the handle store keyed by the
   * server-minted UUID; the agent cannot fabricate it on a tx that didn't
   * come through `prepare_custom_call`'s build path. Setting it to true on
   * any other prepare path is a server bug, not a user-controllable lever.
   */
  acknowledgedNonProtocolTarget?: boolean;
  /**
   * Set when the tx was built by `prepare_safe_tx_propose`,
   * `prepare_safe_tx_approve`, or `prepare_safe_tx_execute`. Read by
   * `assertTransactionSafe` to skip ONLY the catch-all "unknown destination"
   * refusal — the OUTER `to` is the user's own Safe contract, which is by
   * definition not in any canonical allowlist. Issue #609.
   *
   * Why this is safe: the OUTER calldata is always a Safe-specific selector
   * (`approveHash(bytes32)` or `execTransaction(...)`) — neither carries
   * transferable authority on its own, and Ledger Live shows the
   * destination address on-device. The inner-action defense (binding the
   * SafeTx body to the safeTxHash) is upstream of this check.
   *
   * Trust note: like `acknowledgedNonProtocolTarget`, this flag flows
   * through the handle store keyed by the server-minted UUID. The agent
   * cannot fabricate it on a tx that didn't come through one of the three
   * prepare paths above. Setting it on any other prepare path is a server
   * bug, not a user-controllable lever.
   */
  safeTxOrigin?: boolean;
  /**
   * Set by `prepare_safe_tx_propose` ONLY when the user passed the affirmative
   * `acknowledgeSafeDelegateCall: true` gate for an inner `operation: 1`
   * (DELEGATECALL) Safe transaction. Read by the inner-action pre-sign gate
   * (issue #761): a `safeTxOrigin` tx whose inner operation is DELEGATECALL is
   * refused UNLESS this stamp is present. DELEGATECALL runs the inner target in
   * the Safe's own storage context and can rewrite its owner set (a full
   * takeover), so it must be a loud explicit opt-in rather than a plain
   * accepted literal.
   *
   * Trust note: like the sibling stamps (`safeTxOrigin`,
   * `acknowledgedNonProtocolTarget`), this flows through the server-minted
   * handle store; the agent cannot fabricate it on a tx that didn't come
   * through the propose path with the ack set. Setting it on any other path is
   * a server bug, not a user-controllable lever.
   */
  acknowledgedSafeDelegateCall?: boolean;
  /**
   * Set when the tx was built by a prepare_* tool that emits an
   * approve(spender, amount) where the spender is NOT in the canonical
   * protocol allowlist (Aave Pool, Compound Comet, Morpho Blue, Lido
   * Queue, EigenLayer, Uniswap NPM, Uniswap SwapRouter02, LiFi Diamond),
   * AND the user passed the affirmative `acknowledgeNonAllowlistedSpender:
   * true` schema-enforced gate at prepare time. Read by
   * `assertTransactionSafe` to skip ONLY the approve-spender-allowlist
   * refusal — every other pre-sign defense (chainId, simulation, payload
   * hash, ABI-selector check, transfer-on-unknown-token) stays active.
   *
   * Use case: tools like `prepare_curve_swap` that target a deep-liquidity
   * venue whose spender is well-known but isn't in the curated approve
   * allowlist. The allowlist remains a security recommendation: a warning
   * advisory is surfaced in the prepare receipt so the agent can relay
   * the trade-off to the user before they opt in.
   *
   * Trust note: like `acknowledgedNonProtocolTarget` and `safeTxOrigin`,
   * this flag flows through the handle store keyed by the server-minted
   * UUID. The agent cannot fabricate it on a tx that didn't come through
   * a prepare path that explicitly accepted the schema gate.
   */
  acknowledgedNonAllowlistedSpender?: boolean;
  /**
   * Invariant #14 — durable-binding source-of-truth verification (issue
   * #460). When the tx binds funds to a durable on-chain object selected
   * from a multi-candidate set (Compound Comet, Morpho marketId, Uniswap
   * V3 LP tokenId, allowance spender, ...) the prepare_* tool emits the
   * binding here so the skill can byte-equality-check it against the
   * prepared calldata + surface the provenance hint to the user before
   * signing. Absent for ops that don't bind to a durable identifier.
   */
  durableBindings?: import("../security/durable-binding.js").DurableBinding[];
  /**
   * Set to `true` when the prepared op falls into the Inv #12.5
   * "hard-trigger ops list" (issue #501) — op classes where the
   * second-LLM check is a precondition of `confirmed: true`, not
   * an opt-in side offer. The verification renderer surfaces a
   * `⚠ SECOND-LLM CHECK REQUIRED` line so the agent knows to call
   * `get_verification_artifact({ handle })` and relay the
   * `pasteableBlock` BEFORE asking the user to reply 'send'.
   *
   * Today's hard-trigger ops list (none currently shipped on this
   * server — the flag is scaffold for when they land):
   *   - EIP-7702 setCode (#481, deferred)
   *   - Permit2 batch grants (#453, gated on Inv #1b/#2b)
   *   - Opaque-facet bridges (#451, deferred — Wormhole / Mayan /
   *     NEAR Intents / Across V3 with non-EVM destinations)
   *   - Approval-management N-candidate selection (Inv #13 territory)
   *   - Safe enableModule / setGuard / threshold changes
   *
   * Trust note: this is a workflow flag, not a cryptographic
   * primitive. The agent could ignore it or self-attest the second-
   * LLM check happened — same self-attestation gap as
   * `userDecision: "send"`. Closing the gap requires infrastructure
   * that doesn't exist today (provider-signed responses, TEE
   * attestation, or zkML — discussed in the PR thread for #501).
   * The flag is the smallest scaffold that lets future hard-trigger
   * op classes hook into the existing verification block without
   * a coordinated schema change at flag-add time.
   */
  secondLlmRequired?: boolean;
}

/** Shape of ~/.vaultpilot-mcp/config.json. */
/**
 * Cached Ledger pairing entry — what `pair_ledger_solana` populates and
 * `get_ledger_status` reads back. Persisted to ~/.vaultpilot-mcp/config.json
 * so a server restart doesn't force a re-pair (the address is deterministic
 * for a given device + path; the cache is just a hint, not a trust
 * boundary — `send_transaction` always re-derives from the live device
 * before signing).
 */
export interface PairedSolanaEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/501'/<n>'` layout. */
  accountIndex: number | null;
}

/**
 * Unsigned Bitcoin transaction. Parallel to `UnsignedTronTx` /
 * `UnsignedSolanaTx`. Stores a PSBT (Partially Signed Bitcoin
 * Transaction, BIP-174) — the device signs it via
 * `@ledgerhq/hw-app-btc`'s `signPsbtBuffer`, we finalize, extract the
 * tx hex, and broadcast via the indexer.
 *
 * `decoded.outputs[]` and `decoded.changeOutput` carry the human-
 * readable preview the agent surfaces to the user. The PSBT bytes are
 * the source of truth — the device walks every output (including
 * change, with the "change" label when the path matches the wallet's
 * internal chain) and shows fee + total before asking for approval.
 */
export interface UnsignedBitcoinTx {
  chain: "bitcoin";
  /**
   * Discriminator for the action.
   *  - `native_send` — Phase 1 single-output send (also used by issue
   *    #264 multi-source consolidation).
   *  - `rbf_bump` — BIP-125 fee replacement of a stuck mempool tx.
   *    Same input set as the original, recipients preserved verbatim,
   *    the bump is absorbed by the change output.
   */
  action: "native_send" | "rbf_bump";
  /**
   * RBF replacement context — populated only on `action === "rbf_bump"`.
   * Lets the verification block surface "replacing TX <txid>" and the
   * old → new fee/fee-rate delta so the user reviews the bump itself,
   * not just the new tx in isolation. The original tx is identified by
   * `txid`; `oldFeeSats` + `oldFeeRateSatPerVb` come from the indexer.
   */
  replaces?: {
    txid: string;
    oldFeeSats: string;
    oldFeeRateSatPerVb: number;
  };
  /**
   * Primary source address (the first entry in `sources` for multi-source
   * sends, or the only source for single-source sends). Kept for
   * backwards compat — handlers and the verification block treat this as
   * the "from" label. Multi-source consumers should read `sources`.
   */
  from: string;
  /**
   * All source addresses contributing UTXOs to this tx. One entry per
   * unique source. Issue #264 — multi-input consolidation. For
   * single-source sends this is a one-element array; the signer treats
   * both shapes uniformly. All sources share `accountPath` +
   * `addressFormat` (Phase 1 intra-account / uniform-type constraint).
   */
  sources: Array<{
    address: string;
    /** Full leaf path of the source address, e.g. `84'/0'/0'/0/N`. */
    path: string;
    /** Compressed (or uncompressed; signer compresses) public key hex. */
    publicKey: string;
  }>;
  /**
   * Per-PSBT-input source address — `inputSources[i]` names which entry
   * in `sources` provided the i-th PSBT input. Used by the LTC legacy
   * `createPaymentTransaction` fallback to populate `associatedKeysets`
   * with the per-input path; the modern `signPsbtBuffer` path keys off
   * the witness program in each input's `witnessUtxo` script and looks
   * up the source via `knownAddressDerivations`. Length equals the PSBT
   * input count, in PSBT input order.
   */
  inputSources: string[];
  /** Base64-encoded PSBT v0 bytes. The device's `signPsbtBuffer` consumes this. */
  psbtBase64: string;
  /**
   * BIP-32 account-level path (e.g. `m/84'/0'/0'`) the PSBT signs from.
   * `signPsbtBuffer` requires this so it can populate missing BIP-32
   * derivation info on the PSBT inputs.
   */
  accountPath: string;
  /**
   * Address format the account uses — passed explicitly to
   * `signPsbtBuffer.addressFormat`. "bech32" for native segwit, etc.
   */
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
  /**
   * Internal-chain (BIP-32 chain=1) address the change output goes to,
   * plus its derivation. Threaded to the signer so it can register the
   * change output in `signPsbtBuffer.knownAddressDerivations` (and, for
   * the legacy `createPaymentTransaction` fallback, populate
   * `changePath`). Without this, the Ledger BTC app v2.x flags every
   * change output as "unusual change path". Issue #254.
   *
   * Optional only for tx envelopes built by older code paths or by
   * clients that pre-validated they want change-on-source — the modern
   * Phase-1 builder always sets it.
   */
  change?: {
    address: string;
    /** Full leaf path of the change address, e.g. `84'/0'/0'/1/0`. */
    path: string;
    /** Compressed (or uncompressed; signer compresses) public key hex. */
    publicKey: string;
  };
  /** Human-readable description for the preview. */
  description: string;
  /** Decoded outputs + fee + RBF flag. The shape Ledger's screen mirrors. */
  decoded: {
    functionName: string;
    args: Record<string, string>;
    outputs: Array<{
      address: string;
      amountSats: string;
      amountBtc: string;
      isChange: boolean;
      /** Path of the change output (when isChange=true), e.g. `m/84'/0'/0'/1/0`. */
      changePath?: string;
    }>;
    /**
     * Per-source breakdown — one entry per unique source contributing a
     * UTXO to this tx. Mirrors the verification-block "From: each source
     * address with sats pulled" line (issue #264). Always populated;
     * single-source sends produce a one-element array.
     */
    sources: Array<{
      address: string;
      /** Total sats pulled from this source across all selected inputs. */
      pulledSats: string;
      /** Same value as `pulledSats`, formatted as a BTC decimal string. */
      pulledBtc: string;
      /** How many of the PSBT's inputs come from this source. */
      inputCount: number;
    }>;
    feeSats: string;
    feeBtc: string;
    feeRateSatPerVb: number;
    /** Sequence number — < 0xFFFFFFFE marks the tx BIP-125 RBF-eligible. */
    rbfEligible: boolean;
  };
  /** Estimated tx vsize, used to derive the displayed feeRateSatPerVb. */
  vsize: number;
  /** Opaque handle — see btc-tx-store.ts. send_transaction consumes this. */
  handle?: string;
  /**
   * Domain-tagged sha256 over the PSBT base64. Pair-consistency
   * anchor between prepare → preview → sign stages. NOT shown
   * on-device (Ledger BTC clear-signs outputs; on-device anchor is
   * address + amount per output).
   */
  fingerprint?: `0x${string}`;
  /**
   * Address-book recipient metadata — see `UnsignedTx.recipient`.
   * Populated when `args.to` matched a contact label (or reverse-
   * decorated to a saved one). Threaded into the verification block.
   */
  recipient?: {
    label?: string;
    source: "literal" | "contact" | "ens" | "unknown";
    warnings?: string[];
  };
}

/**
 * Unsigned Litecoin transaction. Mirror of `UnsignedBitcoinTx` —
 * same PSBT-v0 shape, same Ledger app interface (currency:"litecoin"
 * on the SDK side selects Litecoin-specific encoding). Symbol fields
 * use LTC, but the on-wire bytes (PSBT, raw tx hex) use the same
 * format as BTC.
 */
export interface UnsignedLitecoinTx {
  chain: "litecoin";
  action: "native_send";
  from: string;
  /** See `UnsignedBitcoinTx.sources`. Issue #264. */
  sources: Array<{
    address: string;
    path: string;
    publicKey: string;
  }>;
  /** See `UnsignedBitcoinTx.inputSources`. Issue #264. */
  inputSources: string[];
  psbtBase64: string;
  accountPath: string;
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
  /** See `UnsignedBitcoinTx.change`. Issue #254. */
  change?: {
    address: string;
    path: string;
    publicKey: string;
  };
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
    outputs: Array<{
      address: string;
      amountSats: string;
      amountLtc: string;
      isChange: boolean;
      changePath?: string;
    }>;
    /** See `UnsignedBitcoinTx.decoded.sources`. Issue #264. */
    sources: Array<{
      address: string;
      pulledSats: string;
      pulledLtc: string;
      inputCount: number;
    }>;
    feeSats: string;
    feeLtc: string;
    feeRateSatPerVb: number;
    rbfEligible: boolean;
  };
  vsize: number;
  /** Opaque handle — see ltc-tx-store.ts. */
  handle?: string;
  fingerprint?: `0x${string}`;
}

/** TRON pairing entry — same shape, different BIP-44 layout (`44'/195'/<n>'/0/0`). */
export interface PairedTronEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
  accountIndex: number | null;
}

/**
 * Bitcoin pairing entry. Bitcoin has 4 standard mainnet address types,
 * each on its own BIP-44 purpose (BIP-44 / BIP-49 / BIP-84 / BIP-86).
 *
 * Pre-#189 a single account index produced exactly 4 entries — one per
 * type, all on the receive chain at index 0. After gap-limit scanning
 * lands, an account index produces N entries per (type, chain) — every
 * used address plus the first unused on each chain, for both receive
 * (chain=0) and change (chain=1). The `chain` + `addressIndex` fields
 * disambiguate the path without re-parsing.
 *
 * Backwards compat: old cached entries (pre-#189) had only the
 * `<purpose>'/0'/<account>'/0/0` leaf. Hydrate-time backfill parses the
 * path so `chain`/`addressIndex` are always present after load.
 */
export interface PairedBitcoinEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /**
   * Discriminator for the four standard mainnet address shapes:
   *   - "legacy"      → BIP-44 P2PKH (`1...`)
   *   - "p2sh-segwit" → BIP-49 P2SH-wrapped segwit (`3...`)
   *   - "segwit"      → BIP-84 native segwit P2WPKH (`bc1q...`)
   *   - "taproot"     → BIP-86 P2TR (`bc1p...`)
   */
  addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
  /** Null when the path doesn't match the standard 5-segment layout. */
  accountIndex: number | null;
  /**
   * BIP-32 chain: 0 = external/receive, 1 = internal/change. Null when
   * the path doesn't match the standard 5-segment layout.
   */
  chain?: 0 | 1 | null;
  /** BIP-32 address index (final path segment). Null when non-standard. */
  addressIndex?: number | null;
  /**
   * Last known on-chain tx count from the indexer at scan time. Optional
   * + a snapshot — goes stale immediately after pairing but useful for
   * the agent to tell at-a-glance which addresses have history. Refresh
   * by calling `pair_ledger_btc` again, or `get_btc_account_balance`
   * for a live read.
   */
  txCount?: number;
}

/**
 * Cosigner entry inside a registered multi-sig wallet policy. Carries
 * the BIP-32 extended pubkey + master fingerprint + derivation path
 * Ledger's wallet-policy descriptor needs to identify each signer slot.
 *
 * `isOurs` flags which entry corresponds to the paired Ledger device —
 * exactly one entry has it `true` after `register_btc_multisig_wallet`
 * verifies the user's master fingerprint + derived xpub against the
 * cosigners list. Foreign cosigner entries (`isOurs: false`) carry only
 * public material and are NOT touched by this server beyond shaping the
 * descriptor; their xpubs come from out-of-band coordination (each
 * cosigner exports their xpub independently).
 */
export interface PairedBitcoinMultisigCosigner {
  /** BIP-32 extended public key (xpub/Ypub/Zpub form). */
  xpub: string;
  /** 4-byte master fingerprint as 8 lowercase hex chars (no `0x`). */
  masterFingerprint: string;
  /**
   * Derivation path leading to `xpub`, no leading `m/`. Standard BIP-48
   * P2WSH multisig: `48'/0'/<account>'/2'`. The `/<change>/<index>`
   * leaves are appended at signing time via the descriptor template's
   * `@N/**` wildcard.
   */
  derivationPath: string;
  /** True for exactly one entry — the one this Ledger can sign with. */
  isOurs: boolean;
}

/**
 * Registered multi-sig wallet policy (BIP-388 Ledger descriptor). Persisted
 * across server restarts; reused by every subsequent `sign_btc_multisig_psbt`
 * call against the same setup.
 *
 * `policyHmac` is the 32-byte HMAC the Ledger BTC app issues during
 * `registerWallet` and demands on every future `signPsbt(policy, hmac)`
 * call — it cryptographically anchors the on-device policy approval to
 * this server's stored copy. Without the HMAC the device re-prompts the
 * full policy verification flow on every signature; storing it means the
 * user only walks through xpub fingerprints once per setup.
 *
 * Phase 2 scope: `wsh(sortedmulti(M,@0/**,@1/**,...))` (P2WSH native
 * segwit). Taproot multi-sig (`tr(multi_a(...))`) and `sh-wsh` wrapped
 * multi-sig are deferred — small audience, distinct script types.
 */
export interface PairedBitcoinMultisigWallet {
  /** User-chosen label, ASCII, ≤ 16 bytes (Ledger device limit). Unique within `bitcoinMultisig[]`. */
  name: string;
  /** Threshold M in M-of-N. */
  threshold: number;
  /** Total signers N. */
  totalSigners: number;
  /** Script type — Phase 2 is "wsh" only. */
  scriptType: "wsh";
  /**
   * The Miniscript descriptor template registered with the device, e.g.
   * `wsh(sortedmulti(2,@0/**,@1/**,@2/**))`. Slot indices `@N` correspond
   * to entries in `cosigners` in registration order.
   */
  descriptor: string;
  /** Cosigners in slot order. Exactly one entry has `isOurs: true`. */
  cosigners: PairedBitcoinMultisigCosigner[];
  /** 32-byte HMAC from `app.registerWallet`, hex-encoded (no `0x`). */
  policyHmac: string;
  /** Bitcoin app version at registration time, for diagnostics. */
  appVersion: string;
}

/**
 * Litecoin pairing entry. Mirror of `PairedBitcoinEntry`. The 4
 * standard mainnet address types map to Litecoin's L/M/ltc1q/ltc1p
 * forms instead of BTC's 1/3/bc1q/bc1p.
 */
export interface PairedLitecoinEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /**
   * Discriminator for the four standard mainnet address shapes:
   *   - "legacy"      → BIP-44 P2PKH (`L...`)
   *   - "p2sh-segwit" → BIP-49 P2SH-wrapped segwit (`M...`)
   *   - "segwit"      → BIP-84 native segwit P2WPKH (`ltc1q...`)
   *   - "taproot"     → BIP-86 P2TR (`ltc1p...`) — derives correctly,
   *     but Litecoin Core has not activated Taproot on mainnet, so
   *     `ltc1p…` outputs are not yet spendable.
   */
  addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
  accountIndex: number | null;
  chain?: 0 | 1 | null;
  addressIndex?: number | null;
  txCount?: number;
}

export interface UserConfig {
  rpc: {
    provider: RpcProvider;
    /** API key for infura/alchemy. Ignored when provider === "custom". */
    apiKey?: string;
    /** Only used when provider === "custom". */
    customUrls?: Partial<Record<SupportedChain, string>>;
  };
  etherscanApiKey?: string;
  /** Optional 1inch Developer Portal API key for intra-chain swap-quote comparison. */
  oneInchApiKey?: string;
  /**
   * Optional Reservoir API key for the NFT-portfolio tools (`get_nft_*`).
   * Reservoir's free tier serves anonymous requests but rate-limits at
   * a tight ceiling that doesn't survive multi-chain portfolio fan-out;
   * configuring a key avoids 429s. Free key at https://reservoir.tools/.
   * Env var `RESERVOIR_API_KEY` takes priority over this field.
   */
  reservoirApiKey?: string;
  /**
   * Safe Transaction Service API key. Required to call `get_safe_positions` and
   * the v2/v3 propose/execute Safe tools — modern `*.safe.global` endpoints
   * authenticate every request. Get one at https://developer.safe.global/.
   * Env var `SAFE_API_KEY` takes priority over this field.
   */
  safeApiKey?: string;
  /**
   * TronGrid API key (`TRON-PRO-API-KEY` header). Required to read TRX and
   * TRC-20 balances on the `tron` chain — TronGrid rate-limits unauthenticated
   * calls to ~15 req/min, which is too tight for portfolio fan-out.
   */
  tronApiKey?: string;
  /**
   * Solana mainnet RPC URL. Paste the full URL from your provider (Helius,
   * QuickNode, Alchemy Solana, Triton, etc.) — most include the API key in
   * the URL (e.g. `https://mainnet.helius-rpc.com/?api-key=KEY`). The public
   * mainnet endpoint is rate-limited and unreliable for production use;
   * configuring a provider is strongly recommended. Env var `SOLANA_RPC_URL`
   * takes priority over this field.
   */
  solanaRpcUrl?: string;
  /**
   * Bitcoin indexer base URL (Esplora-compatible REST API). Defaults to
   * mempool.space's free public API; override here when running against a
   * self-hosted Esplora / Electrs / Mempool.space instance, or any
   * privacy-preserving relay. Env var `BITCOIN_INDEXER_URL` takes priority
   * over this field.
   */
  bitcoinIndexerUrl?: string;
  /**
   * Litecoin indexer base URL (Esplora-compatible REST API). Defaults
   * to litecoinspace.org's free public API; override here when running
   * against a self-hosted Esplora / Electrs instance. Env var
   * `LITECOIN_INDEXER_URL` takes priority over this field.
   */
  litecoinIndexerUrl?: string;
  walletConnect?: {
    projectId?: string;
    /** Topic of the active WC session (so we can resume after restart). */
    sessionTopic?: string;
    pairingTopic?: string;
  };
  /**
   * Cached Ledger pairings, persisted across server restarts. Public fields
   * only (addresses, BIP-44 paths, app versions) — no private keys, no
   * secrets. The signing path always re-derives from the live device and
   * verifies the address before signing, so a planted/stale entry can at
   * worst surface a wrong address in `get_ledger_status` (which the user
   * notices when their balances don't match).
   */
  pairings?: {
    solana?: PairedSolanaEntry[];
    tron?: PairedTronEntry[];
    /**
     * Bitcoin pairings — typically four entries per accountIndex, one
     * per address type (legacy / p2sh-segwit / segwit / taproot). Same
     * write-through-to-disk semantics as the Solana / TRON slices.
     */
    bitcoin?: PairedBitcoinEntry[];
    /**
     * Registered Bitcoin multi-sig wallet policies. One entry per
     * registered wallet; each carries the descriptor + cosigner xpubs +
     * Ledger policy HMAC needed to sign subsequent PSBTs without
     * re-walking the on-device descriptor approval flow.
     */
    bitcoinMultisig?: PairedBitcoinMultisigWallet[];
    /**
     * Litecoin pairings — same shape as the Bitcoin slice, BIP-44
     * coin_type 2 instead of 0.
     */
    litecoin?: PairedLitecoinEntry[];
  };
}
