import {
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import { resolveAddressLookupTables } from "./alt.js";
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
import {
  fetchSolanaQuote,
  type LifiSolanaQuoteRequest,
  SOLANA_WSOL_MINT,
} from "../swap/lifi.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * LiFi-on-Solana write action. The single tool wraps both:
 *   1. **In-chain swaps** (Solana → Solana): LiFi internally routes
 *      through Jupiter / Orca / similar. Useful when callers want a
 *      single tool surface for in-chain + cross-chain rather than
 *      switching between Jupiter and LiFi by hand. (`prepare_solana_swap`
 *      via Jupiter is still the more direct path for in-chain.)
 *   2. **Cross-chain bridges** (Solana → EVM): LiFi aggregates across
 *      Wormhole, deBridge, Mayan, Allbridge. The user signs the Solana
 *      source tx; the destination chain delivery is handled by the
 *      bridge protocol after the source tx confirms.
 *
 * Reverse direction (EVM → Solana) is OUT OF SCOPE this PR — that needs
 * extending `prepare_swap` (EVM-source) to accept a Solana destination
 * address and route via LiFi's existing EVM-source flow. Tracked as a
 * follow-up.
 *
 * ## Tx-shape surgery (the load-bearing piece)
 *
 * LiFi's API hands back a fully-formed `VersionedTransaction` (base64) in
 * `quote.transactionRequest.data`. To put it through our durable-nonce
 * pipeline (ix[0] = `nonceAdvance`) the builder:
 *
 *   1. Deserializes the v0 message.
 *   2. Validates: `numRequiredSignatures === 1` and `staticAccountKeys[0]`
 *      equals the user wallet. Multi-signer routes (some bridge variants
 *      use ephemeral keypairs LiFi keeps in the wallet adapter) are
 *      rejected — Ledger-only signing can't supply the extra signers.
 *   3. Resolves any external ALTs the message references (LiFi commonly
 *      uses Jupiter's group ALT for in-chain routes; bridges may
 *      reference their own).
 *   4. Decompiles the message → flat `TransactionInstruction[]`,
 *      preserving each ix's data + account refs by resolving ALT lookups
 *      against the fetched ALT contents.
 *   5. Prepends `SystemProgram.nonceAdvance(nonceAccount, walletAuthority)`
 *      at ix[0]. Reattaches the ALTs as the `addressLookupTableAccounts`
 *      argument when we re-compile a fresh `MessageV0` at pin time.
 *
 * The LiFi-returned blockhash is discarded — `pinSolanaHandle` overwrites
 * it with the current nonce value. This is fine: LiFi's bridge intent is
 * encoded in the *instructions*, not the blockhash, and our nonce-only
 * validity gate gives the user generous review time on Ledger.
 *
 * Multi-tx routes (`transactionRequest.data` returned as an array, e.g.
 * setup-tx + main-tx) are rejected with a clear error pointing at
 * Jupiter (`prepare_solana_swap`) for in-chain alternatives. Building
 * the multi-tx pipeline is roadmap #4 (deferred per the Kamino scope-
 * probe finding that Kamino's lending surface doesn't actually require
 * it).
 *
 * Treated as BLIND-SIGN on Ledger — LiFi's bridge programs aren't in the
 * Solana app's clear-sign allowlist; same posture as Jupiter / MarginFi /
 * Marinade.
 */

export interface PrepareLifiSolanaSwapParams {
  /** Base58 wallet address — source of funds + Solana tx signer. */
  wallet: string;
  /** SPL mint (base58) or the literal string "native" (= SOL via wSOL). */
  fromMint: string;
  /** Raw integer base units to sell. */
  fromAmount: string;
  /** Destination chain — "solana" (in-chain) or an EVM chain (bridge). */
  toChain: SupportedChain | "solana";
  /**
   * Destination token. SPL mint when `toChain === "solana"`; 0x-prefixed
   * EVM token address otherwise. "native" works on both (resolves to
   * wSOL on Solana, 0x0…0 on EVM).
   */
  toToken: string | "native";
  /**
   * Destination wallet. Defaults to the source wallet for in-chain
   * swaps. REQUIRED for cross-chain bridges since the source wallet's
   * format (Solana base58) won't be valid on the destination chain.
   */
  toAddress?: string;
  /** Slippage as fraction (0.005 = 50 bps). LiFi default 0.005. */
  slippage?: number;
}

export interface PreparedLifiSolanaSwapTx {
  handle: string;
  action: "lifi_solana_swap";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  /** Nonce-account PDA for this wallet (durable-nonce-protected). */
  nonceAccount: string;
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

/**
 * Deserialize LiFi's base64 v0 tx, validate single-signer / single-tx,
 * resolve ALTs, decompile to raw ixs, and prepend `nonceAdvance`. Returns
 * the assembled draft pieces ready for `issueSolanaDraftHandle`.
 */
async function spliceLifiSolanaTx(args: {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  txData: string | string[] | undefined;
}): Promise<{
  instructions: TransactionInstruction[];
  altKeys: PublicKey[];
}> {
  if (args.txData === undefined) {
    throw new Error(
      `LiFi quote returned no transaction data. The route may not be ` +
        `supported for Solana source — try a different inputMint / outputMint / outputChain combination.`,
    );
  }
  if (Array.isArray(args.txData)) {
    throw new Error(
      `LiFi route returned ${args.txData.length} transactions; this server's ` +
        `Solana signing pipeline supports single-tx routes only. For in-chain ` +
        `swaps use prepare_solana_swap (Jupiter, single-tx by design); for ` +
        `multi-tx bridges, wait until the multi-tx pipeline lands.`,
    );
  }

  const txBytes = Buffer.from(args.txData, "base64");
  const versionedTx = VersionedTransaction.deserialize(txBytes);
  const message = versionedTx.message;

  if (message.header.numRequiredSignatures !== 1) {
    throw new Error(
      `LiFi route requires ${message.header.numRequiredSignatures} signers ` +
        `but Ledger-only signing supports exactly 1. The route likely uses an ` +
        `ephemeral signer LiFi normally provides via its wallet adapter — pick ` +
        `a different bridge protocol via slippage / route preferences.`,
    );
  }
  const staticKeys = message.staticAccountKeys;
  if (staticKeys.length === 0 || !staticKeys[0].equals(args.fromPubkey)) {
    throw new Error(
      `LiFi route's fee payer (${staticKeys[0]?.toBase58() ?? "<empty>"}) ` +
        `does not match the user wallet (${args.fromPubkey.toBase58()}). ` +
        `Refusing to sign — the route was built for a different account.`,
    );
  }

  // Resolve external ALTs (LiFi commonly uses Jupiter's group ALT for
  // in-chain routes; bridges may reference their own).
  const altKeys = message.addressTableLookups.map((l) => l.accountKey);
  const conn = getSolanaConnection();
  const alts = await resolveAddressLookupTables(conn, altKeys);

  // Decompile to raw instructions, then prepend nonceAdvance.
  const txMessage = TransactionMessage.decompile(message, {
    addressLookupTableAccounts: alts,
  });
  const lifiIxs = txMessage.instructions;
  const nonceIx = buildAdvanceNonceIx(args.noncePubkey, args.fromPubkey);
  return {
    instructions: [nonceIx, ...lifiIxs],
    altKeys,
  };
}

export async function buildLifiSolanaSwap(
  p: PrepareLifiSolanaSwapParams,
): Promise<PreparedLifiSolanaSwapTx> {
  const ctx = await loadNonceContext(p.wallet);

  const quoteReq: LifiSolanaQuoteRequest = {
    fromAddress: p.wallet,
    fromToken: p.fromMint,
    fromAmount: p.fromAmount,
    toChain: p.toChain,
    toToken: p.toToken,
    ...(p.toAddress !== undefined ? { toAddress: p.toAddress } : {}),
    ...(p.slippage !== undefined ? { slippage: p.slippage } : {}),
  };
  const quote = await fetchSolanaQuote(quoteReq);

  const { instructions: actionIxs, altKeys } = await spliceLifiSolanaTx({
    fromPubkey: ctx.fromPubkey,
    noncePubkey: ctx.noncePubkey,
    txData: quote.transactionRequest?.data,
  });

  // Resolve the ALTs again for the draft (the resolver caches, so this
  // hits the cache; we keep it explicit so the draft owns the ALT list
  // for MessageV0.compile at pin time).
  const conn = getSolanaConnection();
  const addressLookupTableAccounts = await resolveAddressLookupTables(
    conn,
    altKeys,
  );

  const tool = quote.toolDetails?.name ?? quote.tool ?? "lifi";
  const inputSymbol =
    p.fromMint === SOLANA_WSOL_MINT || p.fromMint === "native"
      ? "SOL"
      : quote.action.fromToken.symbol ?? p.fromMint;
  const outputSymbol = quote.action.toToken.symbol ?? p.toToken;
  const description =
    p.toChain === "solana"
      ? `LiFi swap on Solana — ${quote.action.fromAmount} ${inputSymbol} → ~${quote.estimate.toAmount} ${outputSymbol} via ${tool}`
      : `LiFi bridge — ${quote.action.fromAmount} ${inputSymbol} (Solana) → ~${quote.estimate.toAmount} ${outputSymbol} on ${p.toChain} via ${tool}`;

  const draft: SolanaTxDraft = {
    kind: "v0",
    payerKey: ctx.fromPubkey,
    instructions: actionIxs,
    addressLookupTableAccounts,
    meta: {
      action: "lifi_solana_swap",
      from: p.wallet,
      description,
      decoded: {
        functionName: "lifi.solana.swap",
        args: {
          wallet: p.wallet,
          fromMint: p.fromMint,
          fromAmount: p.fromAmount,
          toChain: p.toChain,
          toToken: p.toToken,
          ...(p.toAddress !== undefined ? { toAddress: p.toAddress } : {}),
          inputSymbol,
          outputSymbol,
          minOutput: quote.estimate.toAmountMin,
          tool: String(tool),
          slippageBps: String(
            Math.round((p.slippage ?? Number(quote.action.slippage ?? 0.005)) * 10_000),
          ),
          nonceAccount: ctx.noncePubkey.toBase58(),
        },
      },
      nonce: {
        account: ctx.noncePubkey.toBase58(),
        authority: ctx.fromPubkey.toBase58(),
        value: ctx.nonceValue,
      },
    },
  };

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "lifi_solana_swap",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}
