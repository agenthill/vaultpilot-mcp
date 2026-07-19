import {
  buildSolanaNativeSend,
  buildSolanaSplSend,
  buildSolanaNonceInit,
  buildSolanaNonceClose,
  type PreparedSolanaTx,
} from "./actions.js";
import { getSolanaConnection } from "./rpc.js";
import {
  consumeSolanaHandle,
  retireSolanaHandle,
  getSolanaDraft,
  pinSolanaHandle,
} from "../../signing/solana-tx-store.js";
import { solanaPayloadFingerprint } from "../../signing/verification.js";
import {
  signSolanaTxOnLedger,
  getPairedSolanaByAddress,
} from "../../signing/solana-usb-signer.js";
import { broadcastSolanaTx } from "./broadcast.js";
import type { UnsignedSolanaTx } from "../../types/index.js";
import type {
  PrepareSolanaNativeSendArgs,
  PrepareSolanaSplSendArgs,
  PrepareSolanaNonceInitArgs,
  PrepareSolanaNonceCloseArgs,
  GetSolanaSwapQuoteArgs,
  PrepareSolanaSwapArgs,
  PrepareMarginfiInitArgs,
  PrepareMarginfiSupplyArgs,
  PrepareMarginfiWithdrawArgs,
  PrepareMarginfiBorrowArgs,
  PrepareMarginfiRepayArgs,
  PrepareMarinadeStakeArgs,
  PrepareMarinadeUnstakeImmediateArgs,
  PrepareJitoStakeArgs,
  PrepareNativeStakeDelegateArgs,
  PrepareNativeStakeDeactivateArgs,
  PrepareNativeStakeWithdrawArgs,
  PrepareSolanaLifiSwapArgs,
  PrepareKaminoInitUserArgs,
  PrepareKaminoSupplyArgs,
  PrepareKaminoBorrowArgs,
  PrepareKaminoWithdrawArgs,
  PrepareKaminoRepayArgs,
  GetKaminoPositionsArgs,
  GetMarginfiPositionsArgs,
  GetSolanaStakingPositionsArgs,
  SendTransactionArgs,
} from "../execution/schemas.js";

export async function prepareSolanaNativeSend(
  args: PrepareSolanaNativeSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
  });
}

export async function prepareSolanaSplSend(
  args: PrepareSolanaSplSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaSplSend({
    wallet: args.wallet,
    mint: args.mint,
    to: args.to,
    amount: args.amount,
  });
}

export async function prepareSolanaNonceInit(
  args: PrepareSolanaNonceInitArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceInit({ wallet: args.wallet });
}

export async function prepareSolanaNonceClose(
  args: PrepareSolanaNonceCloseArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceClose({ wallet: args.wallet });
}

export async function getSolanaSwapQuote(args: GetSolanaSwapQuoteArgs) {
  const { getJupiterQuote } = await import("../solana/jupiter.js");
  return getJupiterQuote({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    slippageBps: args.slippageBps,
    swapMode: args.swapMode,
    ...(args.dexes !== undefined ? { dexes: args.dexes } : {}),
    ...(args.excludeDexes !== undefined ? { excludeDexes: args.excludeDexes } : {}),
  });
}

export async function prepareMarginfiInit(
  args: PrepareMarginfiInitArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiInit } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiInit({
    wallet: args.wallet,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiSupply(
  args: PrepareMarginfiSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiSupply } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiSupply({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiWithdraw(
  args: PrepareMarginfiWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiWithdraw } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiWithdraw({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.withdrawAll !== undefined ? { withdrawAll: args.withdrawAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiBorrow(
  args: PrepareMarginfiBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiBorrow } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiBorrow({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiRepay(
  args: PrepareMarginfiRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiRepay } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiRepay({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.repayAll !== undefined ? { repayAll: args.repayAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeStake(
  args: PrepareMarinadeStakeArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeStake } = await import("../solana/marinade.js");
  const prepared = await buildMarinadeStake({
    wallet: args.wallet,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeUnstakeImmediate(
  args: PrepareMarinadeUnstakeImmediateArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeUnstakeImmediate } = await import(
    "../solana/marinade.js"
  );
  const prepared = await buildMarinadeUnstakeImmediate({
    wallet: args.wallet,
    amountMSol: args.amountMSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareJitoStake(
  args: PrepareJitoStakeArgs,
): Promise<PreparedSolanaTx> {
  const { buildJitoStake } = await import("../solana/jito.js");
  const prepared = await buildJitoStake({
    wallet: args.wallet,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDelegate(
  args: PrepareNativeStakeDelegateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDelegate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDelegate({
    wallet: args.wallet,
    validator: args.validator,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDeactivate(
  args: PrepareNativeStakeDeactivateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDeactivate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDeactivate({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeWithdraw(
  args: PrepareNativeStakeWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeWithdraw } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeWithdraw({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareSolanaLifiSwap(
  args: PrepareSolanaLifiSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildLifiSolanaSwap } = await import("../solana/lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  const prepared = await buildLifiSolanaSwap({
    wallet: args.wallet,
    fromMint: args.fromMint,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildLifiSolanaSwap>[0]["toChain"],
    toToken: args.toToken,
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    ...(slippage !== undefined ? { slippage } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoInitUser(
  args: PrepareKaminoInitUserArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoInitUser } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoInitUser({ wallet: args.wallet });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoSupply(
  args: PrepareKaminoSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoSupply } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoSupply({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoBorrow(
  args: PrepareKaminoBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoBorrow } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoBorrow({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoWithdraw(
  args: PrepareKaminoWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoWithdraw } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoWithdraw({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoRepay(
  args: PrepareKaminoRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoRepay } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoRepay({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function getKaminoPositions(args: GetKaminoPositionsArgs) {
  const { getKaminoPositions: reader } = await import(
    "../positions/kamino.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getMarginfiPositions(args: GetMarginfiPositionsArgs) {
  const { getMarginfiPositions: reader } = await import(
    "../positions/marginfi.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getSolanaStakingPositions(
  args: GetSolanaStakingPositionsArgs,
) {
  const { getSolanaStakingPositions: reader } = await import(
    "../positions/solana-staking.js"
  );
  const conn = getSolanaConnection();
  return reader(conn, args.wallet);
}

/**
 * Read-only diagnostic surface for the hardened MarginFi client load.
 * Returns per-bank skip records (address, best-effort mint, step, reason)
 * from the last `fetchGroupData` pass in this process — the data that
 * powers `findBankForMint`'s "bank listed but skipped" branch (issue #107).
 *
 * Triggers a fresh load if the cache is cold so the snapshot is always
 * recent on demand.
 */
export async function getMarginfiDiagnostics(
  _args?: Record<string, never>,
): Promise<{
  group: string;
  fetchedAt: number | null;
  addressesFetched: number;
  banksHydrated: number;
  skippedIntegrator: number;
  skipped: Array<{
    address: string;
    mint: string | null;
    symbol: string;
    step: "decode" | "hydrate" | "tokenData" | "priceInfo";
    reason: string;
  }>;
}> {
  const marginfi = await import("../solana/marginfi.js");
  const conn = getSolanaConnection();
  let snap = marginfi.getLastMarginfiGroupDiagnostics();
  if (!snap) {
    // Warm the cache — picks a valid pubkey as the stub authority since
    // the hardened fetch doesn't actually use it, only the SDK's wallet
    // type-check does.
    const { PublicKey } = await import("@solana/web3.js");
    await marginfi.getHardenedMarginfiClient(
      conn,
      new PublicKey("11111111111111111111111111111111"),
    );
    snap = marginfi.getLastMarginfiGroupDiagnostics();
  }
  if (!snap) {
    return {
      group: marginfi.__internals.MAINNET_GROUP.toBase58(),
      fetchedAt: null,
      addressesFetched: 0,
      banksHydrated: 0,
      skippedIntegrator: 0,
      skipped: [],
    };
  }
  return {
    group: marginfi.__internals.MAINNET_GROUP.toBase58(),
    fetchedAt: snap.fetchedAt,
    addressesFetched: snap.addressesFetched,
    banksHydrated: snap.banksHydrated,
    skippedIntegrator: snap.skippedIntegrator,
    skipped: snap.records.map((r) => ({
      address: r.address,
      mint: r.mint,
      symbol: r.mint
        ? marginfi.__internals.resolveMintSymbol(r.mint)
        : "UNKNOWN",
      step: r.step,
      reason: r.reason,
    })),
  };
}

/**
 * Read-only setup probe for a Solana wallet. Returns which one-time-setup
 * prerequisites are already in place (durable-nonce account + MarginFi
 * PDAs) so agents planning a supply/borrow/etc. don't re-propose a
 * redundant prepare_solana_nonce_init or prepare_marginfi_init step.
 *
 * Mirrors `get_ledger_status` in spirit: a cheap inspection tool that
 * turns "ask the user what's set up" into "read the chain". Issue #101.
 */
export async function getSolanaSetupStatus(args: {
  wallet: string;
}): Promise<{
  wallet: string;
  nonce: {
    exists: boolean;
    address: string;
    lamports?: number;
    currentNonce?: string;
    authority?: string;
  };
  marginfi: {
    accounts: Array<{ index: number; address: string }>;
  };
}> {
  const { assertSolanaAddress } = await import("../solana/address.js");
  const { deriveNonceAccountAddress, getNonceAccountValue } = await import(
    "../solana/nonce.js"
  );
  const { deriveMarginfiAccountPda } = await import("../solana/marginfi.js");

  const authority = assertSolanaAddress(args.wallet);
  const conn = getSolanaConnection();

  // Nonce lookup — one RPC + one decode.
  const noncePubkey = await deriveNonceAccountAddress(authority);
  const nonceInfo = await conn.getAccountInfo(noncePubkey, "confirmed");
  let nonceState: { nonce: string; authority: string } | undefined;
  let nonceLamports: number | undefined;
  if (nonceInfo) {
    nonceLamports = nonceInfo.lamports;
    try {
      const v = await getNonceAccountValue(conn, noncePubkey);
      if (v) {
        nonceState = { nonce: v.nonce, authority: v.authority.toBase58() };
      }
    } catch {
      // Account exists but isn't a System-owned nonce — surface as
      // exists:true without the nonce value. Caller should inspect the
      // lamports + our own nonce tool's refusal to explain.
    }
  }

  // MarginFi PDA probe — same 4-slot pattern as getMarginfiPositions, but
  // stops at the existence check. No SDK load, no oracle fetch — cheap.
  const marginfiAccounts: Array<{ index: number; address: string }> = [];
  const MAX_SLOTS = 4;
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    const pda = deriveMarginfiAccountPda(authority, idx);
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      if (marginfiAccounts.length === 0 && idx === 0) break; // common: none
      break; // gap in the slot sequence
    }
    marginfiAccounts.push({ index: idx, address: pda.toBase58() });
  }

  return {
    wallet: args.wallet,
    nonce: {
      exists: nonceInfo !== null,
      address: noncePubkey.toBase58(),
      ...(nonceLamports !== undefined ? { lamports: nonceLamports } : {}),
      ...(nonceState
        ? {
            currentNonce: nonceState.nonce,
            authority: nonceState.authority,
          }
        : {}),
    },
    marginfi: { accounts: marginfiAccounts },
  };
}

export async function prepareSolanaSwap(
  args: PrepareSolanaSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildJupiterSwap } = await import("../solana/jupiter.js");
  // The `quote` arg is the full Jupiter QuoteResponse — typed loosely as
  // Record<string, unknown> at the schema boundary, narrowed here by the
  // Jupiter module (which expects a JupiterQuote shape).
  const prepared = await buildJupiterSwap({
    wallet: args.wallet,
    quote: args.quote as never, // JupiterQuote is a superset of Record<string, unknown>
    ...(args.prioritizationFeeLamports !== undefined
      ? { prioritizationFeeLamports: args.prioritizationFeeLamports }
      : {}),
  });
  // buildJupiterSwap returns a narrower type (PreparedJupiterSwap). The
  // handlers all converge on PreparedSolanaTx, and jupiter_swap is already
  // in that action union, so the assignment is shape-compatible.
  return prepared as PreparedSolanaTx;
}

/**
 * Pin a prepared Solana tx's draft with a fresh blockhash, serialize the
 * message bytes, compute the Ledger Message Hash (base58(sha256(bytes))),
 * and return the fully-pinned tx the user must match on-device.
 *
 * Why this step exists: blockhashes expire after ~150 blocks (~60s), and
 * prepare → CHECKS → user-approve → broadcast routinely runs 90+ seconds.
 * Fetching the blockhash at prepare time burned the full window before the
 * device ever prompted. This step refreshes the blockhash right before the
 * user matches the hash on the device, giving the full ~60s window for the
 * broadcast path.
 *
 * Re-callable on the same handle — the store overwrites the pinned form
 * with the newer blockhash. Useful if the user paused between the first
 * preview and the actual "send".
 */
export async function previewSolanaSend(args: {
  handle: string;
}): Promise<UnsignedSolanaTx> {
  // Verify the handle exists before hitting the RPC so we fail fast on stale
  // handles without burning a network call.
  const draft = getSolanaDraft(args.handle);
  const conn = getSolanaConnection();

  let pinned: UnsignedSolanaTx;
  if (draft.meta.nonce) {
    // Durable-nonce path: refresh the nonce value in case someone else
    // advanced it between prepare and preview (edge case — another tx
    // against the same nonce in flight — but cheap to handle correctly).
    // The nonce account pubkey never changes, so we just re-fetch.
    const { PublicKey } = await import("@solana/web3.js");
    const { getNonceAccountValue } = await import("../solana/nonce.js");
    const noncePubkey = new PublicKey(draft.meta.nonce.account);
    const fresh = await getNonceAccountValue(conn, noncePubkey);
    if (!fresh) {
      throw new Error(
        `Nonce account ${draft.meta.nonce.account} has disappeared between prepare and preview. ` +
          `Did it get closed mid-flight? Re-run prepare_solana_nonce_init and then re-prepare the send.`,
      );
    }
    // Update meta so pinSolanaHandle's consistency check passes.
    draft.meta.nonce.value = fresh.nonce;
    pinned = pinSolanaHandle(args.handle, fresh.nonce);
  } else {
    // Legacy recent-blockhash path — only reachable for `nonce_init` now,
    // since every send/close is durable-nonce-protected.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
      "confirmed",
    );
    pinned = pinSolanaHandle(args.handle, blockhash, lastValidBlockHeight);
  }

  // Pre-sign simulation gate (issue #115). Run `simulateTransaction` on the
  // pinned versioned tx so program-level reverts (MarginFi OperationBorrowOnly,
  // stale-oracle rejects, bank-paused asserts, etc.) surface BEFORE the user
  // is asked to blind-sign on Ledger. Mirrors the EVM enrichTx path which
  // runs eth_call at prepare_* time.
  //
  // Skip for `nonce_init`: that's a legacy-message one-time setup (createAccount
  // + nonceInitialize) with no interesting revert surface worth a pre-sign
  // RPC. Every other Solana action here is v0.
  if (pinned.action !== "nonce_init") {
    const { simulatePinnedSolanaTx } = await import("../solana/simulate.js");
    try {
      const sim = await simulatePinnedSolanaTx(conn, pinned.messageBase64);
      if (!sim.ok) {
        const header = sim.anchorError
          ? `Pre-sign simulation REJECTED the ${pinned.action} tx — ` +
            `${sim.anchorError.name} (${sim.anchorError.code}): ${sim.anchorError.message}.`
          : `Pre-sign simulation REJECTED the ${pinned.action} tx. Raw err: ${sim.err ?? "(unknown)"}.`;
        const logTail = sim.logs && sim.logs.length
          ? `\nLast program logs:\n  ${sim.logs.slice(-8).join("\n  ")}`
          : "";
        // Issue #116 — enrich with a targeted root-cause diagnosis for
        // ambiguous MarginFi errors (currently just 6009 RiskEngineInitRejected,
        // which collapses "stale oracle" and "bad health" into one message).
        // Best-effort: diagnosis failure must NOT mask the real sim error.
        let diagnosis = "";
        if (
          pinned.action.startsWith("marginfi_") &&
          sim.anchorError &&
          draft.meta.marginfiTouchedBanks
        ) {
          try {
            const { diagnoseMarginfiSimRejection } = await import(
              "../solana/marginfi.js"
            );
            const result = await diagnoseMarginfiSimRejection(
              draft.meta.marginfiTouchedBanks,
              sim.anchorError,
            );
            if (result) diagnosis = `\n${result}`;
          } catch {
            // Swallow — diagnosis is additive, not gating.
          }
        }
        // Issue #125 — split the two NotEnoughSamples failure modes. A
        // "Rotating mega slot" log line immediately before the Anchor
        // 6030 means the feed is mid oracle-set rotation: consensus can't
        // be reached for ~60–120s regardless of how many samples we
        // requested (#120's N=3 tuning doesn't help during rotation).
        // The right user action is to WAIT, not loop-retry. The plain
        // stale-samples branch still tells the user to re-prepare.
        const isNotEnoughSamples = sim.anchorError?.code === 6030;
        const { isSwitchboardRotation } = await import(
          "../solana/simulate.js"
        );
        const rotating =
          isNotEnoughSamples && isSwitchboardRotation(sim.logs);
        const remediation = rotating
          ? `\nThis is a transient SWITCHBOARD ORACLE ROTATION ("Rotating mega slot" ` +
            `in the logs) — the feed is between oracle sets and consensus is ` +
            `temporarily unreachable. Wait 60–120s before retrying; tight retry ` +
            `loops will fail identically until rotation completes. No code bug ` +
            `on our side; no fix on retry. Durable nonce was not advanced.`
          : isNotEnoughSamples
            ? `\nOracle samples fetched at preview time are already past their ` +
              `max-staleness window. This is unusual at preview time (the fetch ` +
              `is seconds-old) and typically indicates extreme RPC lag or a ` +
              `freshly-rotated feed. Call prepare_* again to fetch fresh samples.`
            : `\nRefusing to surface the Ledger hash — the tx would revert on broadcast. ` +
              `Resolve the underlying issue (e.g. withdraw conflicting collateral, wait for oracle freshness, ` +
              `pick a different bank) and call prepare_* again.`;
        throw new Error(header + logTail + diagnosis + remediation);
      }
      pinned.simulation = sim;
    } catch (e) {
      // Distinguish our own throw (preview-level rejection — re-raise) from
      // an RPC-level error (transient — swallow and proceed without the
      // simulation field; broadcast-side preflight is the backstop).
      if (
        e instanceof Error &&
        /Pre-sign simulation REJECTED/.test(e.message)
      ) {
        throw e;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[vaultpilot/solana] pre-sign simulate RPC failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Proceeding without simulation — broadcast-side preflight will still catch reverts.`,
      );
    }
  }

  return pinned;
}

/**
 * Send a Solana tx: consume handle, re-hash the stored message bytes and
 * compare against the preview fingerprint, sign over USB HID, stitch the
 * signature into the serialized tx, broadcast via RPC. Mirror of
 * `sendTronTransaction`.
 */
export async function sendSolanaTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "solana";
  lastValidBlockHeight?: number;
  durableNonce?: { noncePubkey: string; nonceValue: string };
}> {
  const tx: UnsignedSolanaTx = consumeSolanaHandle(args.handle);
  // Preview-gate enforcement (parity with the EVM path). These two args
  // prove the agent ran `preview_solana_send` AND surfaced the CHECKS
  // PERFORMED block before the user replied "send". Missing / mismatched
  // values mean the agent either skipped preview entirely, collapsed
  // preview + send into one silent step, or replayed an old token after
  // a refresh — in all three cases the user hasn't had a chance to match
  // the on-device Message Hash against the chat-side value and the
  // defense collapses for blind-sign flows (SPL / MarginFi / Jupiter).
  // Error text is verbose on purpose — the agent reads it and self-corrects.
  if (!args.previewToken) {
    throw new Error(
      "Missing `previewToken` arg on send_transaction. preview_solana_send " +
        "returned a `previewToken` field in its top-level JSON response — " +
        "pass it back here verbatim. This is the schema-enforced proof " +
        "that the preview step actually ran and that the CHECKS PERFORMED " +
        "block was surfaced to the user. If you skipped preview_solana_send, " +
        "call it first.",
    );
  }
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the CHECKS PERFORMED block from preview_solana_send " +
        "and receiving the user's explicit 'send' reply. The literal proves " +
        "the preview-time gate was shown to the user rather than silently " +
        "bypassed.",
    );
  }
  if (tx.previewToken && args.previewToken !== tx.previewToken) {
    throw new Error(
      "SECURITY: `previewToken` does not match the current pin on this " +
        "Solana handle. The benign explanation is that preview_solana_send " +
        "was re-called after the token was captured (e.g. to refresh a stale " +
        "nonce) — in that case, the new pin has a new token AND a new Message " +
        "Hash the user MUST re-match on-device. Do NOT retry with the old " +
        "token: call preview_solana_send again, surface the fresh CHECKS " +
        "PERFORMED block and the new blind-sign hash to the user, and pass " +
        "the new token.",
    );
  }
  // Proof-of-identity guard: same logic as the TRON sender. Recompute the
  // domain-tagged hash of the exact message bytes the Ledger will sign
  // and require equality with the hash the user previewed.
  if (tx.verification) {
    const rehash = solanaPayloadFingerprint(tx.messageBase64);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: Solana payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The message bytes changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare from scratch and compare ` +
          `the new preview carefully.`,
      );
    }
  }
  // Use the paired path for `from` if available; otherwise fall through to
  // the default (`44'/501'/0'`) and let the device-address check inside
  // `signSolanaTxOnLedger` surface a "pair the right slot" error.
  const paired = getPairedSolanaByAddress(tx.from);
  const messageBytes = Buffer.from(tx.messageBase64, "base64");
  const { signature } = await signSolanaTxOnLedger({
    messageBytes,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });

  // Assemble the final serialized tx: one signature count byte (0x01), the
  // 64-byte signature, then the message bytes. Matches what
  // `Transaction.serialize()` produces for a single-signer tx after
  // `addSignature` — but we construct it by hand so we never need a
  // `Keypair`/`Signer` object (which would imply a key in the server).
  const signedTxBytes = Buffer.concat([
    Buffer.from([1]), // signature count = 1 (single signer)
    signature,
    messageBytes,
  ]);

  const txSignature = await broadcastSolanaTx(signedTxBytes);
  // Retire the handle only after successful broadcast. A signing or
  // broadcast failure leaves the handle valid for retry within its 15-min
  // TTL (though on-chain validity is bounded by the ~60s blockhash window).
  retireSolanaHandle(args.handle);
  return {
    txHash: txSignature,
    chain: "solana",
    // `lastValidBlockHeight` is for legacy-blockhash txs (nonce_init only);
    // `durableNonce` is for every other send. The status poller uses one
    // or the other to distinguish dropped from pending — always surface
    // the applicable field so the agent can hand it back to
    // `get_transaction_status` verbatim.
    ...(tx.lastValidBlockHeight !== undefined
      ? { lastValidBlockHeight: tx.lastValidBlockHeight }
      : {}),
    ...(tx.nonce
      ? {
          durableNonce: {
            noncePubkey: tx.nonce.account,
            nonceValue: tx.nonce.value,
          },
        }
      : {}),
  };
}
