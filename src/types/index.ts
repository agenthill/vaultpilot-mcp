// Shared domain types used across all modules.

import type { SupportedChain } from "./chains.js";
import type {
  LendingPositionUnion,
  LPPosition,
  StakingPosition,
  TokenAmount,
} from "./positions.js";
import type { PortfolioCoverage } from "./portfolio.js";
import type { TxVerification } from "./tx.js";

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
}

export * from "./devices.js";

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

export * from "./config.js";
