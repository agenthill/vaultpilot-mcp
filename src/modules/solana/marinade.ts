import {
  PublicKey,
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
 * Marinade liquid-staking write actions — `prepare_marinade_stake`
 * (deposit SOL → mSOL) and `prepare_marinade_unstake_immediate`
 * (liquidUnstake mSOL → SOL via Marinade's liquidity pool, with fee).
 *
 * Both flows reuse the shared durable-nonce pipeline (ix[0] =
 * nonceAdvance) — same as every other Solana send this server builds
 * except `nonce_init`. Marinade's program clear-signs nothing on the
 * Ledger Solana app (not in the app's plugin allowlist), so the device
 * displays only a Message Hash; users match it against the value the
 * server publishes in the VERIFY block.
 *
 * Delayed unstake (OrderUnstake — wait one epoch, get full SOL) is NOT
 * shipped here. The SDK's `orderUnstake` returns a
 * `ticketAccountKeypair: web3.Keypair` ephemeral signer — incompatible
 * with our Ledger-only signing model without separate ticket-account
 * derivation work. Tracked as a follow-up; immediate-via-pool covers
 * the user need for "exit my mSOL position now" with a fee disclosure.
 *
 * SDK integration:
 * - `marinade.deposit(amountLamports)` returns `{ associatedMSolTokenAccountAddress, transaction: web3.Transaction }`.
 *   We extract `transaction.instructions` and splice them into a v0
 *   message after the nonceAdvance instruction.
 * - `marinade.liquidUnstake(amountLamports)` returns the same shape.
 *
 * Read-only constructor: the SDK's `MarinadeConfig` accepts `publicKey`
 * — we pass the user's wallet so Marinade can derive the associated
 * mSOL token account (the recipient of the LST). `marinade.deposit`
 * builds an `Authorized` ix where the signer is `publicKey`; no
 * provider-side signing happens at build time. The Ledger signs the
 * resulting message bytes via our normal pipeline.
 */

export interface MarinadeStakeParams {
  /** Base58 wallet address — funds the deposit, receives mSOL. */
  wallet: string;
  /** Human-readable SOL amount (decimal string, e.g. "1.5"). */
  amountSol: string;
}

export interface MarinadeUnstakeImmediateParams {
  /** Base58 wallet address — burns mSOL, receives SOL. */
  wallet: string;
  /** Human-readable mSOL amount (decimal string). */
  amountMSol: string;
}

export interface PreparedMarinadeTx {
  handle: string;
  action: "marinade_stake" | "marinade_unstake_immediate";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  /** Nonce-account PDA for this wallet (durable-nonce-protected). */
  nonceAccount: string;
}

const LAMPORTS_PER_SOL = 1_000_000_000;
const MSOL_DECIMALS = 9;

function solToLamports(solDecimal: string): bigint {
  const bn = new BigNumber(solDecimal);
  if (!bn.isFinite() || bn.lte(0)) {
    throw new Error(
      `Invalid SOL amount "${solDecimal}" — expected a positive decimal (e.g. "1.5").`,
    );
  }
  // Round down to lamport precision to avoid floating-point overshoot.
  return BigInt(bn.times(LAMPORTS_PER_SOL).integerValue(BigNumber.ROUND_DOWN).toString(10));
}

function mSolToBaseUnits(mSolDecimal: string): bigint {
  const bn = new BigNumber(mSolDecimal);
  if (!bn.isFinite() || bn.lte(0)) {
    throw new Error(
      `Invalid mSOL amount "${mSolDecimal}" — expected a positive decimal (e.g. "1.5").`,
    );
  }
  return BigInt(
    bn
      .times(new BigNumber(10).pow(MSOL_DECIMALS))
      .integerValue(BigNumber.ROUND_DOWN)
      .toString(10),
  );
}

/**
 * Resolve `BN` from `@coral-xyz/anchor` under Node's ESM-from-CJS
 * interop. Anchor 0.30.x registers BN via `Object.defineProperty`
 * getters that `cjs-module-lexer` skips when an ESM module dynamically
 * imports the package, so the obvious `const { BN } = await import(...)`
 * resolves BN to `undefined` at runtime. `anchorMod.default` is the
 * full module.exports object (getters intact), so the fallback works.
 *
 * Empirically AnchorProvider / Program / utils ARE detected as named
 * exports — only BN and web3 fall through the cracks. The defensive
 * named-first ordering keeps test mocks and future anchor releases
 * with proper "exports" field both working without code change. See
 * issue #178.
 */
type AnchorBNCtor = typeof import("@coral-xyz/anchor").BN;

async function loadAnchorBN(): Promise<AnchorBNCtor> {
  const mod = await import("@coral-xyz/anchor");
  const fromNamed: AnchorBNCtor | undefined = (mod as { BN?: AnchorBNCtor }).BN;
  if (typeof fromNamed === "function") return fromNamed;
  const fromDefault: AnchorBNCtor | undefined = (mod as {
    default?: { BN?: AnchorBNCtor };
  }).default?.BN;
  if (typeof fromDefault === "function") return fromDefault;
  throw new Error(
    "Could not resolve BN from @coral-xyz/anchor — neither the named export " +
      "nor the default-namespace fallback returned a constructor. Anchor's " +
      "package shape may have changed; see issue #178 for the original interop " +
      "diagnosis.",
  );
}

/**
 * Construct the Marinade SDK in read-only-constructor mode. The SDK
 * needs `publicKey` to derive the associated mSOL token account and
 * encode the deposit/unstake authority field — but never invokes a
 * provider-signing path during ix construction.
 */
async function loadMarinadeForWallet(walletPk: PublicKey) {
  const { Marinade, MarinadeConfig } = await import(
    "@marinade.finance/marinade-ts-sdk"
  );
  const conn = getSolanaConnection();
  const config = new MarinadeConfig({
    connection: conn,
    publicKey: walletPk,
  });
  return new Marinade(config);
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

/**
 * Wrap an action's instructions into a durable-nonce-protected v0 draft.
 * Same pattern as `wrapWithNonce` in `marginfi.ts` — nonceAdvance at
 * ix[0] is the agave-detected marker that bypasses the ~60s blockhash
 * validity window in favor of the on-chain nonce value as the validity
 * gate.
 */
function buildDraft(args: {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
  walletStr: string;
  action: "marinade_stake" | "marinade_unstake_immediate";
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
      action: args.action,
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

export async function buildMarinadeStake(
  p: MarinadeStakeParams,
): Promise<PreparedMarinadeTx> {
  const lamports = solToLamports(p.amountSol);
  const ctx = await loadNonceContext(p.wallet);

  const marinade = await loadMarinadeForWallet(ctx.fromPubkey);
  // Bring in BN from the SDK's transitive dep tree — Marinade's SDK
  // accepts only its own BN type, not bigint.
  //
  // Anchor v0.30.x's CJS entry registers BN via `Object.defineProperty(
  // exports, "BN", { get: ... })`, which Node's cjs-module-lexer doesn't
  // pick up when this ESM module dynamically imports it — `anchorMod.BN`
  // ends up `undefined`. The `default` namespace carries the full
  // module.exports object with the working getter, so we fall back to
  // that. The named-first ordering keeps test mocks (which expose BN as
  // a real named export) and any future "exports" field on anchor
  // working without code change. See issue #178.
  const BN = await loadAnchorBN();
  const result = await marinade.deposit(new BN(lamports.toString()));

  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    action: "marinade_stake",
    description: `Marinade stake: deposit ${p.amountSol} SOL → mSOL`,
    decoded: {
      functionName: "marinade.deposit",
      args: {
        wallet: p.wallet,
        amountSol: p.amountSol,
        mSolAta: result.associatedMSolTokenAccountAddress.toBase58(),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs: result.transaction.instructions,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "marinade_stake",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}

export async function buildMarinadeUnstakeImmediate(
  p: MarinadeUnstakeImmediateParams,
): Promise<PreparedMarinadeTx> {
  const baseUnits = mSolToBaseUnits(p.amountMSol);
  const ctx = await loadNonceContext(p.wallet);

  const marinade = await loadMarinadeForWallet(ctx.fromPubkey);
  // See `buildMarinadeStake` for the rationale behind the named/default
  // fallback (issue #178).
  const BN = await loadAnchorBN();
  const result = await marinade.liquidUnstake(new BN(baseUnits.toString()));

  const draft = buildDraft({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    nonceValue: ctx.nonceValue,
    walletStr: p.wallet,
    action: "marinade_unstake_immediate",
    description: `Marinade liquid unstake: ${p.amountMSol} mSOL → SOL (via liquidity pool, with fee)`,
    decoded: {
      functionName: "marinade.liquidUnstake",
      args: {
        wallet: p.wallet,
        amountMSol: p.amountMSol,
        mSolAta: result.associatedMSolTokenAccountAddress.toBase58(),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs: result.transaction.instructions,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "marinade_unstake_immediate",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}
