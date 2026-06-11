import {
  PublicKey,
  StakeProgram,
  Authorized,
  TransactionInstruction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import {
  buildAdvanceNonceIx,
  deriveNonceAccountAddress,
  getNonceAccountValue,
} from "./nonce.js";
import { throwNonceRequired } from "./actions.js";
import {
  issueSolanaDraftHandle,
  type SolanaTxDraft,
} from "../../signing/solana-tx-store.js";

/**
 * Native Solana stake-program write actions — `prepare_native_stake_delegate`,
 * `prepare_native_stake_deactivate`, `prepare_native_stake_withdraw`.
 *
 * Strategy mirrors `nonce.ts` for the create+initialize ceremony: derive the
 * stake account address deterministically via `createAccountWithSeed`. The
 * user wallet (basePubkey === fromPubkey) is the only signer — no ephemeral
 * keypair, Ledger-compatible. One stake account per `(wallet, validator)`
 * tuple; re-running delegate against the same validator hits an "account
 * already exists" check at preflight.
 *
 * Stake authority defaults to the user's wallet (both staker + withdrawer).
 * Lockup is `Lockup.default` (zero-lockup) — no custodian, no epoch lock.
 *
 * Treated as BLIND-SIGN on Ledger by default. `StakeInstruction` ops
 * (`Delegate`, `Deactivate`, `Withdraw`) may or may not be in the Solana
 * app's clear-sign allowlist; without device-confirmed evidence we assume
 * the most conservative path (matches Marinade / MarginFi treatment).
 *
 * For deactivate / withdraw the user passes the stake account pubkey
 * directly. Recommended discovery path: call `get_solana_staking_positions`
 * first — its `native[]` section enumerates the user's existing stakes.
 *
 * Pre-flight delegated to `simulatePinnedSolanaTx` (the Solana sim gate).
 * The on-chain stake program enforces invariant rules (deactivate requires
 * active stake; withdraw requires inactive stake; etc.) — simulation
 * surfaces a clear error before the user signs.
 */

export interface PrepareNativeStakeDelegateParams {
  /** Base58 wallet address — funds the stake account, becomes its staker + withdrawer authority. */
  wallet: string;
  /**
   * Base58 vote account address of the validator to delegate to. NOT the
   * validator's identity address — Solana's stake program delegates to a
   * vote account, which the validator publishes alongside its identity.
   */
  validator: string;
  /**
   * Human-readable SOL amount to stake. Decimals are SOL-native (9). Note:
   * the actual lamports moved from the wallet are this value PLUS the
   * stake account's rent-exempt minimum (~0.00228 SOL); the rent-exempt
   * floor is reclaimable on full withdraw after deactivation.
   */
  amountSol: string;
}

export interface PrepareNativeStakeDeactivateParams {
  /** Base58 wallet address — must be the stake account's staker authority. */
  wallet: string;
  /** Base58 stake account pubkey to deactivate. */
  stakeAccount: string;
}

export interface PrepareNativeStakeWithdrawParams {
  /** Base58 wallet address — must be the stake account's withdrawer authority + receives the SOL. */
  wallet: string;
  /** Base58 stake account pubkey to withdraw from. */
  stakeAccount: string;
  /**
   * Human-readable SOL amount to withdraw, OR the literal string "max" to
   * withdraw the full lamport balance (which closes the account and
   * reclaims the rent-exempt seed). On-chain the program enforces that
   * the stake be inactive — partial-withdraw on an active stake reverts.
   */
  amountSol: string;
}

export interface PreparedNativeStakeTx {
  handle: string;
  action:
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  /** Nonce-account PDA for this wallet (durable-nonce-protected). */
  nonceAccount: string;
  /** Rent cost of the new stake account, surfaced on delegate only. */
  rentLamports?: number;
  /** Stake account address — surfaced on delegate so the user can refer to it later. */
  stakeAccount?: string;
  /** Invariant #14 — vote pubkey on delegate; absent on deactivate/withdraw (no candidate-set selection). Issue #460. */
  durableBindings?: import("../../security/durable-binding.js").DurableBinding[];
}

const LAMPORTS_PER_SOL = 1_000_000_000;

/**
 * Per-validator stake-account seed prefix. Constant tag plus a 12-char
 * suffix derived from the validator's vote account address keeps each
 * `(wallet, validator)` pair on its own deterministic stake account
 * while staying well under the 32-char seed limit.
 */
const STAKE_SEED_PREFIX = "vps-v1-";

function deriveStakeSeed(validator: PublicKey): string {
  // 12-char suffix gives ~62-bit collision space across validators per
  // wallet. Vote-account addresses are dense enough that any 12-char prefix
  // is unique in practice; collisions don't break safety (a collision just
  // means two validators would share an address, which fails on-chain at
  // delegate time because the stake account's vote target would be wrong).
  return `${STAKE_SEED_PREFIX}${validator.toBase58().slice(0, 12)}`;
}

export async function deriveStakeAccountAddress(
  wallet: PublicKey,
  validator: PublicKey,
): Promise<PublicKey> {
  const seed = deriveStakeSeed(validator);
  return PublicKey.createWithSeed(wallet, seed, StakeProgram.programId);
}

function solToLamports(solDecimal: string): bigint {
  const bn = new BigNumber(solDecimal);
  if (!bn.isFinite() || bn.lte(0)) {
    throw new Error(
      `Invalid SOL amount "${solDecimal}" — expected a positive decimal (e.g. "1.5").`,
    );
  }
  return BigInt(
    bn.times(LAMPORTS_PER_SOL).integerValue(BigNumber.ROUND_DOWN).toString(10),
  );
}

async function loadNonceContext(walletStr: string): Promise<{
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
}> {
  const fromPubkey = assertSolanaAddress(walletStr);
  const conn = getSolanaConnection();
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(walletStr);
  return { fromPubkey, noncePubkey, nonceValue: nonceState!.nonce };
}

function buildDraft(args: {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
  walletStr: string;
  action: PreparedNativeStakeTx["action"];
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  actionIxs: TransactionInstruction[];
  rentLamports?: number;
}): SolanaTxDraft {
  const nonceIx = buildAdvanceNonceIx(args.noncePubkey, args.fromPubkey);
  const instructions: TransactionInstruction[] = [nonceIx, ...args.actionIxs];
  return {
    kind: "v0",
    payerKey: args.fromPubkey,
    instructions,
    addressLookupTableAccounts: [],
    meta: {
      action: args.action,
      from: args.walletStr,
      description: args.description,
      decoded: args.decoded,
      ...(args.rentLamports !== undefined && { rentLamports: args.rentLamports }),
      nonce: {
        account: args.noncePubkey.toBase58(),
        authority: args.fromPubkey.toBase58(),
        value: args.nonceValue,
      },
    },
  };
}

export async function buildNativeStakeDelegate(
  p: PrepareNativeStakeDelegateParams,
): Promise<PreparedNativeStakeTx> {
  const stakeLamports = solToLamports(p.amountSol);
  const validatorPk = assertSolanaAddress(p.validator);
  const ctx = await loadNonceContext(p.wallet);
  const conn = getSolanaConnection();

  const stakePubkey = await deriveStakeAccountAddress(ctx.fromPubkey, validatorPk);
  // Refuse if a stake account already exists at this deterministic address —
  // the user almost certainly meant to manage it (deactivate/withdraw) rather
  // than re-delegate. createAccountWithSeed would revert anyway, but a
  // structured pre-flight error is a better UX.
  const existing = await conn.getAccountInfo(stakePubkey);
  if (existing) {
    throw new Error(
      `Stake account ${stakePubkey.toBase58()} already exists for wallet ${p.wallet} ` +
        `+ validator ${p.validator}. Manage the existing position via prepare_native_stake_deactivate ` +
        `/ prepare_native_stake_withdraw — this tool only creates fresh stakes. ` +
        `(Stake account is deterministic per (wallet, validator); to create a second ` +
        `stake to the same validator you'd need a non-deterministic flow that isn't shipped here.)`,
    );
  }
  const rentLamports = await conn.getMinimumBalanceForRentExemption(
    StakeProgram.space,
  );

  const seed = deriveStakeSeed(validatorPk);
  // StakeProgram.createAccountWithSeed returns a Transaction containing two
  // ixs (SystemProgram.createAccountWithSeed + StakeInstruction.initialize).
  // Extract them and splice into the v0 message. lamports = stake principal
  // + rent-exempt seed; the seed is reclaimable on full withdraw after
  // deactivation.
  const createTx = StakeProgram.createAccountWithSeed({
    fromPubkey: ctx.fromPubkey,
    stakePubkey,
    basePubkey: ctx.fromPubkey,
    seed,
    authorized: new Authorized(ctx.fromPubkey, ctx.fromPubkey),
    lamports: Number(stakeLamports) + rentLamports,
  });
  const delegateTx = StakeProgram.delegate({
    stakePubkey,
    authorizedPubkey: ctx.fromPubkey,
    votePubkey: validatorPk,
  });
  const actionIxs = [...createTx.instructions, ...delegateTx.instructions];

  const description =
    `Native stake delegate: ${p.amountSol} SOL → validator ${p.validator} ` +
    `(stake account ${stakePubkey.toBase58()})`;
  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    action: "native_stake_delegate",
    description,
    decoded: {
      functionName: "stake.createWithSeed+delegate",
      args: {
        wallet: p.wallet,
        validator: p.validator,
        amountSol: p.amountSol,
        stakeAccount: stakePubkey.toBase58(),
        rentLamports: String(rentLamports),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
    rentLamports,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  const { makeDurableBinding } = await import(
    "../../security/durable-binding.js"
  );
  return {
    handle,
    action: "native_stake_delegate",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
    rentLamports,
    stakeAccount: stakePubkey.toBase58(),
    durableBindings: [
      makeDurableBinding("solana-validator-vote-pubkey", validatorPk.toBase58()),
    ],
  };
}

export async function buildNativeStakeDeactivate(
  p: PrepareNativeStakeDeactivateParams,
): Promise<PreparedNativeStakeTx> {
  const stakePubkey = assertSolanaAddress(p.stakeAccount);
  const ctx = await loadNonceContext(p.wallet);

  const deactivateTx = StakeProgram.deactivate({
    stakePubkey,
    authorizedPubkey: ctx.fromPubkey,
  });
  const description = `Native stake deactivate: ${p.stakeAccount} (takes one epoch ≈ 2-3 days before withdrawable)`;
  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    action: "native_stake_deactivate",
    description,
    decoded: {
      functionName: "stake.deactivate",
      args: {
        wallet: p.wallet,
        stakeAccount: p.stakeAccount,
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs: deactivateTx.instructions,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "native_stake_deactivate",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}

export async function buildNativeStakeWithdraw(
  p: PrepareNativeStakeWithdrawParams,
): Promise<PreparedNativeStakeTx> {
  const stakePubkey = assertSolanaAddress(p.stakeAccount);
  const ctx = await loadNonceContext(p.wallet);
  const conn = getSolanaConnection();

  let withdrawLamports: bigint;
  if (p.amountSol === "max") {
    const info = await conn.getAccountInfo(stakePubkey);
    if (!info) {
      throw new Error(
        `Stake account ${p.stakeAccount} not found on-chain. Confirm the address ` +
          `via get_solana_staking_positions.`,
      );
    }
    withdrawLamports = BigInt(info.lamports);
  } else {
    withdrawLamports = solToLamports(p.amountSol);
  }

  const withdrawTx = StakeProgram.withdraw({
    stakePubkey,
    authorizedPubkey: ctx.fromPubkey,
    toPubkey: ctx.fromPubkey,
    lamports: Number(withdrawLamports),
  });
  const amountLabel =
    p.amountSol === "max"
      ? `MAX (${(Number(withdrawLamports) / LAMPORTS_PER_SOL).toFixed(9)} SOL — closes the stake account)`
      : `${p.amountSol} SOL`;
  const description = `Native stake withdraw: ${amountLabel} from ${p.stakeAccount} → ${p.wallet}`;
  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    action: "native_stake_withdraw",
    description,
    decoded: {
      functionName: "stake.withdraw",
      args: {
        wallet: p.wallet,
        stakeAccount: p.stakeAccount,
        amountSol: p.amountSol,
        lamports: String(withdrawLamports),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs: withdrawTx.instructions,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "native_stake_withdraw",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}
