import { randomUUID } from "node:crypto";
import {
  MessageV0,
  type AddressLookupTableAccount,
  type PublicKey,
  type Transaction,
  type TransactionInstruction,
} from "@solana/web3.js";
import type { UnsignedSolanaTx } from "../types/index.js";
import { buildSolanaVerification } from "./verification.js";

/**
 * In-memory registry of prepared Solana transactions. Two-phase: `prepare_*`
 * stores a DRAFT (instruction list + fee payer, no blockhash), and
 * `preview_solana_send` later PINS the draft with a fresh blockhash and
 * serialized message bytes. `send_transaction` only accepts pinned handles.
 *
 * The split exists because Solana blockhashes expire after ~150 blocks (~60s)
 * and the prepare → CHECKS → user-approve → broadcast round-trip on a live
 * Ledger routinely runs 90+ seconds. Fetching the blockhash at prepare time
 * burned the full validity window before the device ever prompted. Pinning
 * right before broadcast gives the user a full ~60s window from seeing the
 * hash on-device to the network accepting the tx.
 *
 * Parallel to `signing/tron-tx-store.ts` and `signing/tx-store.ts` —
 * `send_transaction` routes by which store owns the handle, so Solana
 * handles flow through the USB HID Solana signer and never touch the EVM
 * pipeline or the TRON signer.
 *
 * Lifetime: 15 minutes from issue. A pinned message's on-chain validity is
 * still bounded by the baked blockhash (~60s); re-calling preview_solana_send
 * on a stale pinned handle simply re-pins with a fresh blockhash.
 */
const TX_TTL_MS = 15 * 60_000;

/**
 * Metadata about a draft Solana tx that isn't part of the draft's
 * instruction list itself — description, decoded args, fee estimate, rent
 * cost, etc. Mirrors the non-message fields of `UnsignedSolanaTx`.
 */
export interface SolanaDraftMeta {
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
  from: string;
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  rentLamports?: number;
  priorityFeeMicroLamports?: number;
  computeUnitLimit?: number;
  estimatedFeeLamports?: number;
  /**
   * Durable-nonce metadata for txs that use ix[0] = nonceAdvance. Present
   * on `native_send` / `spl_send` / `nonce_close` (all of which self-
   * protect with the existing nonce account); absent on `nonce_init` (the
   * create-nonce tx has no nonce to consume yet — uses a regular recent
   * blockhash one time only).
   *
   * The `value` field is what pinSolanaHandle writes into the message's
   * `recentBlockhash` field — not a network blockhash, but the current
   * on-chain nonce value. Agave detects the durable-nonce tx via ix[0]
   * and validates this field against the nonce account's state.
   */
  nonce?: {
    account: string;
    authority: string;
    value: string;
  };
  /**
   * Bank addresses (base58) the MarginFi risk engine will cross-check on
   * this tx — the target action bank PLUS every bank with an active balance
   * on the user's MarginfiAccount. Stamped at prepare time so
   * `preview_solana_send` can diagnose `RiskEngineInitRejected` (Anchor
   * error 6009) without re-deriving the account's balance set (issue #116).
   *
   * Absent on non-MarginFi actions. A present-but-empty array means the
   * builder saw zero active balances + target (shouldn't happen; treated
   * as "diagnosis N/A").
   */
  marginfiTouchedBanks?: string[];
  /**
   * Switchboard oracle feeds that were cranked as part of this tx —
   * populated when `prepare_marginfi_*` detects any touched
   * SwitchboardPull bank and auto-prepends `createUpdateFeedIx`
   * instructions (issue #116 ask C). Empty array means the check ran
   * but nothing needed cranking; absent means the builder skipped
   * the check (non-MarginFi action).
   */
  marginfiOracleCranks?: {
    oracles: string[];
    instructionCount: number;
  };
}

/**
 * A Solana tx draft awaiting a blockhash pin.
 *
 * Message-format discriminated union: `kind: "legacy"` for `new Transaction()`
 * (the Phase 1/2 shape), `kind: "v0"` for `VersionedMessage` / `MessageV0`
 * (Phase 3 onward). The store doesn't care which; `pinSolanaHandle` branches
 * on the discriminant to pick the right serialize path. Neither variant
 * carries a blockhash at draft time — that gets set by `preview_solana_send`
 * right before signing.
 *
 * Jupiter returns a ready-made v0 tx; Kamino/MarginFi sometimes need ALTs
 * too. Legacy Transaction has no ALT support, so those flows MUST use the
 * v0 variant. Existing native_send / spl_send / nonce_init / nonce_close
 * can stay legacy — they all fit comfortably under the 35-account legacy
 * limit.
 */
export interface SolanaLegacyDraft {
  kind: "legacy";
  draftTx: Transaction;
  meta: SolanaDraftMeta;
}

export interface SolanaV0Draft {
  kind: "v0";
  payerKey: PublicKey;
  instructions: TransactionInstruction[];
  /**
   * ALT accounts the v0 message references (if any). Empty array is fine —
   * a v0 message without lookups is still valid and distinguishable from
   * legacy by the `0x80` version prefix.
   */
  addressLookupTableAccounts: AddressLookupTableAccount[];
  meta: SolanaDraftMeta;
}

export type SolanaTxDraft = SolanaLegacyDraft | SolanaV0Draft;

interface StoredSolanaTx {
  draft: SolanaTxDraft;
  /** Present only after `pinSolanaHandle`. `send_transaction` requires it. */
  pinned?: UnsignedSolanaTx;
  /**
   * Set the instant `send_transaction` is about to hand this handle's signed
   * bytes to the network (`broadcastSolanaTx`), BEFORE the network call
   * resolves. Issue #788 — the durable-nonce double-spend guard. A broadcast
   * that errors/aborts AFTER the node already landed the tx leaves the handle
   * alive (retire is success-only) with an advanced on-chain nonce; a
   * subsequent `preview_solana_send` would otherwise silently re-fetch that
   * advanced nonce and re-pin a byte-different, independently-valid duplicate
   * transfer. This flag makes the outcome AMBIGUOUS-by-construction: once set,
   * the next preview fails closed rather than re-pinning. Never cleared —
   * a successful broadcast retires the whole entry instead.
   *
   * Keyed on the broadcast ATTEMPT, set only AFTER signing: failures BEFORE
   * the mark (preview-token / payload-hash mismatch, Ledger signing failure)
   * never reach it, so those definite non-landings never over-block a retry.
   * Once the mark is set the guard is deliberately fail-CLOSED even for some
   * definite non-landings: a `broadcastSolanaTx` that throws because the
   * `skipPreflight: false` preflight simulation REJECTED the tx never landed,
   * yet the flag is already set and the next preview refuses. That over-block
   * is the accepted price — the client cannot, in general, tell a preflight
   * reject from an abort-that-landed, so erring toward refusal is correct.
   */
  broadcastAttempted?: boolean;
  /**
   * The base58 ed25519 signature of the exact bytes handed to
   * `broadcastSolanaTx` — i.e. the Solana transaction id (`txHash`). Persisted
   * in the SAME write as `broadcastAttempted`, BEFORE the RPC, so an
   * abort-but-landed unwind leaves `preview_solana_send` able to emit an
   * EXECUTABLE recovery: the signature is the `txHash` arg the refusal routes
   * the agent to paste into `get_transaction_status`. Issue #788 / #792 —
   * without it the refusal could only wave at "check a block explorer".
   */
  signature?: string;
  expiresAt: number;
}

const store = new Map<string, StoredSolanaTx>();

/**
 * Recursively `Object.freeze` `value` and every plain-object/array it
 * reaches, so a later mutation on the object `consumeSolanaHandle` hands
 * back throws instead of silently sticking. Sibling of `tx-store.ts`'s
 * `deepFreeze` (issue #710/#730). Issue #742 — sweep the freeze across
 * every chain-specific tx-store.
 *
 * Applied lazily in `consumeSolanaHandle`, NOT inside `pinSolanaHandle`
 * itself — `previewSolanaSend` (execution/index.ts) legitimately mutates
 * `pinned.simulation = sim` in place on the very object `pinSolanaHandle`
 * returns, AFTER pinning, once the pre-sign simulation RPC resolves.
 * Freezing at pin time would make that assignment throw and break every
 * non-`nonce_init` preview. `consumeSolanaHandle` is only ever called from
 * the send path, strictly after `previewSolanaSend` has run to completion,
 * so freezing there closes the TOCTOU gap for the actual external-facing
 * read (`send_transaction`) without touching the legitimate internal
 * simulation-attach step.
 *
 * `entry.draft` is left unfrozen entirely: `previewSolanaSend` also
 * mutates `draft.meta.nonce.value` in place (via the reference
 * `getSolanaDraft` hands back) to refresh a durable nonce before
 * re-pinning, and the legacy-kind pin path mutates
 * `draft.draftTx.recentBlockhash` in place too. `draft` is this store's
 * analog of #730's "wrapper carries mutable metadata" — pre-finalization
 * working state that must stay writable, not the stored tx value itself.
 */
function deepFreeze<T>(value: T): T {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) {
    return value;
  }
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    deepFreeze((value as Record<string, unknown>)[key]);
  }
  return value;
}

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

/**
 * Register a prepared Solana tx draft. Returns the handle that callers
 * pass back to `preview_solana_send` to pin a fresh blockhash and to
 * `send_transaction` to sign + broadcast.
 */
export function issueSolanaDraftHandle(draft: SolanaTxDraft): { handle: string } {
  prune();
  const handle = randomUUID();
  store.set(handle, {
    draft,
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return { handle };
}

/**
 * Non-throwing presence check — used by demo-mode's
 * `broadcastSimulationDispatch` to decide whether the handle lives in
 * the Solana draft store before falling through to "unknown handle"
 * (issue #409 side-note). Mirrors the EVM tx-store's `hasHandle`.
 */
export function hasSolanaDraft(handle: string): boolean {
  prune();
  return store.has(handle);
}

/**
 * Look up the draft for `handle`. Used by `preview_solana_send` to
 * re-serialize with a fresh blockhash. Throws for unknown / expired
 * handles (same TTL semantics as the pinned path).
 */
export function getSolanaDraft(handle: string): SolanaTxDraft {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle. Prepared transactions expire after 15 minutes. ` +
        `Re-run the prepare_solana_* tool for a fresh handle.`,
    );
  }
  return entry.draft;
}

/**
 * Pin a draft with the given fresh blockhash (or current nonce value, for
 * durable-nonce txs). Serializes the message bytes, computes the
 * verification bundle (including the base58(sha256(…)) that the Ledger
 * Solana app displays on blind-sign), and stores the result so
 * `send_transaction` can consume it. Re-callable — a second `preview_solana_send`
 * on the same handle just re-pins with a fresher blockhash/nonce value
 * (replacing the earlier pinned form).
 *
 * For durable-nonce txs (`meta.nonce` present), the caller should pass the
 * current nonce value as `freshBlockhash` AND have already updated
 * `meta.nonce.value` to match — we assert the two agree, catching caller
 * bugs where preview forgot to refresh one or the other. For `nonce_init`
 * (the only non-nonce-protected tx in the current scheme), `freshBlockhash`
 * is a real network blockhash fetched via `getLatestBlockhash`.
 */
export function pinSolanaHandle(
  handle: string,
  freshBlockhash: string,
  lastValidBlockHeight?: number,
): UnsignedSolanaTx {
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle '${handle}'. Re-run the prepare_solana_* tool.`,
    );
  }
  const meta = entry.draft.meta;
  if (meta.nonce && meta.nonce.value !== freshBlockhash) {
    throw new Error(
      `pinSolanaHandle consistency check failed: meta.nonce.value='${meta.nonce.value}' ` +
        `does not match passed freshBlockhash='${freshBlockhash}'. The preview handler must ` +
        `refresh both in lockstep — pass the just-fetched nonce value as freshBlockhash and ` +
        `update meta.nonce.value to the same string before calling pin.`,
    );
  }

  // Serialize the message bytes. Legacy and v0 take different paths —
  // legacy mutates `draftTx.recentBlockhash` then calls `serializeMessage()`;
  // v0 compiles a fresh MessageV0 with the blockhash/nonce baked in and
  // then calls `serialize()`. Either way the downstream consumer (Ledger
  // signer, broadcast path) sees an opaque `messageBase64` and doesn't
  // need to care which version produced it.
  let messageBytes: Buffer;
  if (entry.draft.kind === "legacy") {
    entry.draft.draftTx.recentBlockhash = freshBlockhash;
    messageBytes = entry.draft.draftTx.serializeMessage();
  } else {
    const msg = MessageV0.compile({
      payerKey: entry.draft.payerKey,
      instructions: entry.draft.instructions,
      recentBlockhash: freshBlockhash,
      addressLookupTableAccounts: entry.draft.addressLookupTableAccounts,
    });
    messageBytes = Buffer.from(msg.serialize());
  }
  const messageBase64 = messageBytes.toString("base64");

  // Mint a fresh preview token on every pin. Re-calling preview_solana_send
  // (e.g. after a user pause) invalidates any prior token — mirror of the
  // EVM `refresh: true` semantics. send_transaction's gate rejects a
  // mismatched token and tells the agent to re-surface the current CHECKS
  // block.
  const previewToken = randomUUID();

  const pinnedBase: UnsignedSolanaTx = {
    chain: "solana",
    action: meta.action,
    from: meta.from,
    messageBase64,
    recentBlockhash: freshBlockhash,
    description: meta.description,
    decoded: meta.decoded,
    handle,
    previewToken,
    // lastValidBlockHeight is meaningless for durable-nonce txs (they
    // never expire via block-height) — only carry it through when meta
    // indicates this is a legacy-blockhash tx.
    ...(lastValidBlockHeight !== undefined && !meta.nonce
      ? { lastValidBlockHeight }
      : {}),
    ...(meta.rentLamports !== undefined ? { rentLamports: meta.rentLamports } : {}),
    ...(meta.priorityFeeMicroLamports !== undefined
      ? { priorityFeeMicroLamports: meta.priorityFeeMicroLamports }
      : {}),
    ...(meta.computeUnitLimit !== undefined
      ? { computeUnitLimit: meta.computeUnitLimit }
      : {}),
    ...(meta.estimatedFeeLamports !== undefined
      ? { estimatedFeeLamports: meta.estimatedFeeLamports }
      : {}),
    ...(meta.nonce ? { nonce: { ...meta.nonce } } : {}),
  };
  const verification = buildSolanaVerification(pinnedBase);
  const pinned: UnsignedSolanaTx = { ...pinnedBase, verification };
  // NOT frozen here — `previewSolanaSend` still needs to write
  // `pinned.simulation = sim` on this exact object after the pre-sign
  // simulation RPC resolves. See the `deepFreeze` doc comment above:
  // the freeze happens lazily in `consumeSolanaHandle`, once the tx is
  // truly done being built.
  entry.pinned = pinned;
  return entry.pinned;
}

/**
 * Retrieve the pinned tx for `handle`, or throw if the caller skipped
 * `preview_solana_send` (handle exists but has no blockhash pinned yet) or
 * if the handle is unknown / expired. Called by the Solana branch of
 * `send_transaction`. Does NOT delete the entry — the retire call at the
 * end of a successful broadcast handles that.
 */
export function consumeSolanaHandle(handle: string): UnsignedSolanaTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Solana tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_solana_* tool for a fresh handle.`,
    );
  }
  if (!entry.pinned) {
    throw new Error(
      `Solana tx handle '${handle}' has not been pinned yet. Call preview_solana_send(handle) ` +
        `first — it fetches a fresh blockhash, serializes the message, and emits the Message Hash ` +
        `for the user to match on-device. send_transaction cannot run without a pin.`,
    );
  }
  // Deep-freeze on first consume (issue #742, sibling of #710/#730) so a
  // mutation attempt on the object handed back here cannot alter what a
  // later `consumeSolanaHandle` on the same handle sees. This also
  // freezes `pinned.verification` all the way down — a future post-issue
  // enrichment step that tries to write into it will throw in strict
  // mode; that's a flag to route the enrichment through `pinSolanaHandle`
  // instead of mutating the consumed tx in place. Idempotent — deepFreeze
  // no-ops on an already-frozen value, so re-consuming the same handle is
  // safe.
  entry.pinned = deepFreeze(entry.pinned);
  return entry.pinned;
}

export function retireSolanaHandle(handle: string): void {
  store.delete(handle);
}

/**
 * Mark `handle` as having had a network broadcast ATTEMPTED on it, persisting
 * the broadcast `signature` (base58 txHash) alongside the flag in one write.
 * Issue #788 / #792. Called by `sendSolanaTransaction` immediately before
 * `broadcastSolanaTx`, so BOTH are already durable when an abort/timeout/RPC
 * error unwinds the send path without retiring the handle — the flag makes the
 * next preview fail closed, and the signature lets that refusal emit an
 * executable `get_transaction_status` recovery. No-op on an unknown/expired
 * handle (nothing left to protect). See `StoredSolanaTx.broadcastAttempted` /
 * `.signature` for the full rationale.
 */
export function markSolanaBroadcastAttempted(
  handle: string,
  signature: string,
): void {
  prune();
  const entry = store.get(handle);
  if (entry) {
    entry.broadcastAttempted = true;
    entry.signature = signature;
  }
}

/**
 * True if a network broadcast was ATTEMPTED on `handle` (and the handle is
 * still alive — i.e. the broadcast did NOT retire it via success). Issue
 * #788 — `previewSolanaSend` calls this to fail closed rather than re-pin an
 * advanced durable nonce into a duplicate transfer.
 */
export function wasSolanaBroadcastAttempted(handle: string): boolean {
  prune();
  return store.get(handle)?.broadcastAttempted === true;
}

/**
 * The base58 signature (txHash) persisted when the broadcast was ATTEMPTED on
 * `handle`, or `undefined` if none was recorded. Issue #788 / #792 —
 * `previewSolanaSend` reads this to put the real `txHash` inline in its
 * fail-closed refusal so the agent can paste it verbatim into
 * `get_transaction_status`.
 */
export function getSolanaBroadcastSignature(
  handle: string,
): string | undefined {
  prune();
  return store.get(handle)?.signature;
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasSolanaHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}

/** Test-only: true if `handle` has been pinned (preview_solana_send called). */
export function isSolanaHandlePinned(handle: string): boolean {
  prune();
  const entry = store.get(handle);
  return entry?.pinned != null;
}
