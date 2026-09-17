// Shared domain types used across all modules.

import type { SupportedChain } from "./chains.js";
import type {
  LendingPositionUnion,
  LPPosition,
  StakingPosition,
  TokenAmount,
} from "./positions.js";
import type { PortfolioCoverage } from "./portfolio.js";

export * from "./chains.js";

export * from "./positions.js";

export * from "./portfolio.js";

export * from "./security.js";

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

export * from "./tx.js";

export * from "./devices.js";

export * from "./config.js";
