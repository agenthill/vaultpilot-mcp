import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
 * Jito stake-pool write actions — currently `prepare_jito_stake` only
 * (deposit SOL → jitoSOL). Mirrors `marinade.ts`'s shape on top of the
 * shared durable-nonce pipeline.
 *
 * Why we hand-build the ix instead of using `@solana/spl-stake-pool`'s
 * high-level `depositSol(connection, ...)`: the high-level wrapper
 * generates an ephemeral SOL-transfer keypair to satisfy the program's
 * `fundingAccount` signer requirement, which is incompatible with
 * Ledger-only signing (the ephemeral key has no signature path). The raw
 * `StakePoolInstruction.depositSol` exposed by the SDK accepts
 * `fundingAccount: PublicKey` directly and lets us pass the user's own
 * wallet — the user signs via Ledger, no ephemeral key needed.
 *
 * What's NOT shipped here (deferred follow-up):
 *
 *   - **Immediate `WithdrawSol`** — Jito's stake pool generally requires
 *     `WithdrawStake` (which yields a fresh stake-account in deactivating
 *     state, not SOL back to the wallet). `WithdrawSol` would only succeed
 *     when the pool's reserve has spare SOL AND the pool has no
 *     `solWithdrawAuthority` set, both of which are uncommon. Skipped to
 *     avoid a UX where the tool builds a tx that often reverts on chain.
 *   - **`WithdrawStake`** — produces a stake account the user then has to
 *     deactivate + withdraw across multiple epochs. The instruction needs
 *     a freshly-created destination stake account, which we can build with
 *     `CreateAccountWithSeed` (no ephemeral keypair) — same pattern as the
 *     durable-nonce account. Material additional work; tracked as a
 *     follow-up plan rather than v1.
 *
 * Stake-pool program docs: https://spl.solana.com/stake-pool. Jito's
 * pool address (mints jitoSOL): `Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb`
 * — confirmed via the existing read path at
 * `src/modules/positions/solana-staking.ts`.
 */

const JITO_STAKE_POOL = new PublicKey(
  "Jito4APyf642JPZPx3hGc6WWJ8zPKtRbRs4P815Awbb",
);

const LAMPORTS_PER_SOL = 1_000_000_000;

export interface JitoStakeParams {
  /** Base58 wallet address — funds the deposit, receives jitoSOL. */
  wallet: string;
  /** Human-readable SOL amount (decimal string, e.g. "1.5"). */
  amountSol: string;
}

export interface PreparedJitoTx {
  handle: string;
  action: "jito_stake";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  /** Nonce-account PDA for this wallet (durable-nonce-protected). */
  nonceAccount: string;
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
  return { fromPubkey, noncePubkey, nonceValue: nonceState.nonce };
}

function buildDraft(args: {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
  walletStr: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  actionIxs: TransactionInstruction[];
}): SolanaTxDraft {
  const nonceIx = buildAdvanceNonceIx(args.noncePubkey, args.fromPubkey);
  const instructions: TransactionInstruction[] = [nonceIx, ...args.actionIxs];
  return {
    kind: "v0",
    payerKey: args.fromPubkey,
    instructions,
    addressLookupTableAccounts: [],
    meta: {
      action: "jito_stake",
      from: args.walletStr,
      description: args.description,
      decoded: args.decoded,
      nonce: {
        account: args.noncePubkey.toBase58(),
        authority: args.fromPubkey.toBase58(),
        value: args.nonceValue,
      },
    },
  };
}

/**
 * Build the deposit-SOL ix list:
 *   1. (optional) `createAssociatedTokenAccountIdempotent` if the user's
 *      jitoSOL ATA doesn't exist yet — sender pays the ~0.002 SOL rent.
 *   2. `StakePoolInstruction.depositSol` with `fundingAccount = user`,
 *      so the user signs the deposit via Ledger.
 *
 * Pool state (`reserveStake`, `poolMint`, `managerFeeAccount`,
 * `withdrawAuthority`) is read from chain at prepare time so we follow
 * pool-config changes without redeploying.
 */
export async function buildJitoStake(
  p: JitoStakeParams,
): Promise<PreparedJitoTx> {
  const lamports = solToLamports(p.amountSol);
  const ctx = await loadNonceContext(p.wallet);

  const conn = getSolanaConnection();
  const {
    StakePoolInstruction,
    getStakePoolAccount,
    STAKE_POOL_PROGRAM_ID,
  } = await import("@solana/spl-stake-pool");

  const pool = await getStakePoolAccount(conn, JITO_STAKE_POOL);
  const poolMint = pool.account.data.poolMint;
  const reserveStake = pool.account.data.reserveStake;
  const managerFeeAccount = pool.account.data.managerFeeAccount;

  // PDA derivation for the pool's withdraw authority. Re-implemented
  // locally rather than imported from `@solana/spl-stake-pool/dist/utils/
  // program-address` because that helper isn't re-exported from the
  // package's public entry point — a deep import would couple us to an
  // internal subpath. The derivation itself is stable: ["<stakePoolPubkey>",
  // "withdraw"] under STAKE_POOL_PROGRAM_ID.
  const [withdrawAuthority] = PublicKey.findProgramAddressSync(
    [JITO_STAKE_POOL.toBuffer(), Buffer.from("withdraw")],
    STAKE_POOL_PROGRAM_ID,
  );

  const jitoSolAta = getAssociatedTokenAddressSync(poolMint, ctx.fromPubkey);
  const ataInfo = await conn.getAccountInfo(jitoSolAta, "confirmed");

  const actionIxs: TransactionInstruction[] = [];
  if (!ataInfo) {
    // Idempotent variant: safe even if the ATA shows up between our
    // probe and broadcast (race-free).
    actionIxs.push(
      createAssociatedTokenAccountIdempotentInstruction(
        ctx.fromPubkey, // payer
        jitoSolAta,
        ctx.fromPubkey, // owner
        poolMint,
      ),
    );
  }

  // Raw depositSol — no ephemeral keypair. The high-level wrapper uses
  // an ephemeral SOL-transfer account because of how its abstraction
  // wants to keep the user's main account out of the program's signer
  // set; we don't have that constraint (Ledger signs whatever message
  // bytes we hand it), so the user's wallet IS the fundingAccount.
  actionIxs.push(
    StakePoolInstruction.depositSol({
      stakePool: JITO_STAKE_POOL,
      depositAuthority: undefined,
      withdrawAuthority,
      reserveStake,
      fundingAccount: ctx.fromPubkey,
      destinationPoolAccount: jitoSolAta,
      managerFeeAccount,
      // Self-referral: the pool requires a referral pool account; using
      // the user's own jitoSOL ATA is the canonical no-affiliate value
      // (matches the high-level SDK's behavior when no `referrerTokenAccount`
      // is passed).
      referralPoolAccount: jitoSolAta,
      poolMint,
      lamports: Number(lamports),
    }),
  );

  const ataSuffix = ataInfo
    ? ""
    : " (+ create jitoSOL ATA, ~0.002 SOL rent, reclaimable on token-account close)";

  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    description: `Jito stake: deposit ${p.amountSol} SOL → jitoSOL${ataSuffix}`,
    decoded: {
      functionName: "spl_stake_pool.depositSol",
      args: {
        wallet: p.wallet,
        amountSol: p.amountSol,
        amountLamports: lamports.toString(),
        stakePool: JITO_STAKE_POOL.toBase58(),
        jitoSolAta: jitoSolAta.toBase58(),
        nonceAccount: ctx.noncePubkey.toBase58(),
        ...(ataInfo ? {} : { createsAta: "true" }),
      },
    },
    actionIxs,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "jito_stake",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}
