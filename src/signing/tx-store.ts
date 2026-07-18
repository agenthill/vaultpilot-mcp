import { randomUUID } from "node:crypto";
import type { UnsignedTx } from "../types/index.js";
import { buildVerification } from "./verification.js";

/**
 * In-memory registry of prepared transactions keyed by an opaque handle.
 *
 * Purpose: bind `send_transaction` to the exact tx built by a `prepare_*` tool.
 * Without this, `send_transaction` accepts raw calldata — a prompt-injected
 * agent (e.g. via a malicious Etherscan source comment or ENS reverse record)
 * could convince the model to sign arbitrary bytes while the user thinks they
 * approved the previewed tx.
 *
 * Each prepared tx and every node in its `.next` chain gets its own handle.
 * The signing path looks up by handle and refuses anything not in the store.
 *
 * Lifetime: 15 minutes from issue, enough for a user to review and approve on
 * their Ledger. Expired entries are lazily pruned on every access.
 */
const TX_TTL_MS = 15 * 60_000;

/**
 * Nonce + EIP-1559 fees + gas limit the server pinned at `preview_send` time,
 * plus the EIP-1559 pre-sign RLP hash derived from them. Stashed on the handle
 * so `send_transaction` can forward the EXACT same tuple the user already
 * matched on-device, keeping the on-device hash deterministic.
 *
 * `pinnedAt` is a Date.now() timestamp — if you want a staleness check
 * (e.g. "pin older than 90s, refuse"), use this. For now we don't, relying on
 * the 15-minute handle TTL plus the bumped fee multiplier (2x baseFee) to
 * keep fees live enough.
 */
export interface StashedPin {
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
  /**
   * Live base fee from `latestBlock.baseFeePerGas` at pin time. Stored so the
   * preview-time cost block (issue #650) can render the EIP-1559 breakdown
   * (`base fee X gwei · priority Y gwei`) without re-querying the chain on a
   * cached re-pin. Not used by `send_transaction` — it's purely a UX field
   * for the cost-preview render. `0n` when the chain doesn't expose a base
   * fee (pre-London, but we reject those at simulation time anyway).
   */
  baseFeePerGas: bigint;
  preSignHash: `0x${string}`;
  pinnedAt: number;
  /**
   * Opaque token minted by `preview_send` and echoed back by `send_transaction`.
   * Closes the UX gap where the chat agent silently collapses the preview step
   * (the one that surfaces the EXTRA-CHECKS menu and the LEDGER BLIND-SIGN
   * HASH) into a single "send" call. A send_transaction that does not carry
   * a matching token proves preview_send never ran for this pin — the agent
   * skipped the gate — and the server refuses. Re-pinning (preview_send with
   * refresh: true) mints a fresh token, invalidating any captured-earlier
   * token the agent might try to reuse.
   */
  previewToken: string;
}

/**
 * Discriminator for the three timeout-path outcomes that produce an
 * ambiguous send_transaction result. Issue #326 P3 — when any of these
 * fires, the handle is marked so a subsequent `send_transaction` call
 * on the same handle refuses unless the agent passes
 * `acknowledgeRetryRiskAfterAmbiguousFailure: true`. Different kinds
 * carry different recovery guidance:
 *
 *   - `no_broadcast` → cross-checked safe to retry, but retry CAN
 *     queue a duplicate device prompt if WC silently completed signing
 *     in the background. User must understand the duplicate-prompt
 *     risk before retrying.
 *   - `consumed_unmatched` → the slot was consumed by SOME tx in the
 *     last 16 blocks but its pre-sign hash didn't match ours. Retrying
 *     with the same pin will fail at the chain level (nonce too low);
 *     the user must investigate via block explorer.
 *   - `ambiguous_disagreement` → local RPC and Etherscan disagree on
 *     the pending nonce. The tx may have broadcast through Ledger
 *     Live's RPC. User must verify on a block explorer before any
 *     retry.
 */
export type AmbiguousAttemptKind =
  | "no_broadcast"
  | "consumed_unmatched"
  | "ambiguous_disagreement";

export interface AmbiguousAttempt {
  kind: AmbiguousAttemptKind;
  /** Date.now() at which the ambiguous outcome was recorded. */
  at: number;
}

interface StoredTx {
  tx: UnsignedTx;
  expiresAt: number;
  pin?: StashedPin;
  /**
   * Set when a previous `send_transaction` on this handle returned a
   * timeout-with-probe-result. Cleared on `retireHandle` (successful
   * submission) or when the agent retries with the explicit ack flag.
   * Issue #326 P3.
   */
  ambiguousAttempt?: AmbiguousAttempt;
}

const store = new Map<string, StoredTx>();

/**
 * Recursively `Object.freeze` `value` and every plain-object/array it
 * reaches, so a later `entry.tx.foo = x` (or a nested `entry.tx.verification.x
 * = y`) throws in strict mode instead of silently sticking. Issue #710 —
 * stored-tx immutability was assumed, not enforced.
 *
 * Deliberately targets only the `tx` field's VALUE, never the `StoredTx`
 * wrapper itself: `attachPinnedGas` / `markAmbiguousAttempt` /
 * `clearAmbiguousAttempt` mutate `entry.pin` / `entry.ambiguousAttempt` in
 * place on the wrapper, and freezing the wrapper would break those paths.
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
 * Recursively assign handles to `tx` and every node in its `.next` chain.
 * Returns a new tx tree with `handle` populated on each node.
 *
 * Each handle stores ONLY the one tx node it names — not the full chain.
 * The agent must call `send_transaction` once per handle, walking the chain
 * explicitly. This makes every signature an independent, auditable event.
 */
export function issueHandles(tx: UnsignedTx): UnsignedTx {
  prune();
  const now = Date.now();
  const expiresAt = now + TX_TTL_MS;

  const nextWithHandles = tx.next ? issueHandles(tx.next) : undefined;
  const handle = randomUUID();
  // Stamp verification metadata unconditionally — every tx carries a
  // payloadHash, a swiss-knife decoder URL (when calldata fits), and a
  // local decode. The send-time guard in execution/index.ts re-hashes the
  // exact bytes handed to WalletConnect and asserts equality with this
  // `verification.payloadHash`, giving the user end-to-end certainty that
  // what they preview is what they sign.
  const verification = tx.verification ?? buildVerification(tx);
  const withHandle: UnsignedTx = {
    ...tx,
    handle,
    verification,
    ...(nextWithHandles ? { next: nextWithHandles } : {}),
  };
  // Store a copy without `handle` on the stored value itself (not needed at
  // lookup time) to avoid the tautology of storing the key inside the value.
  const { handle: _h, next: _n, ...stored } = withHandle;
  const storedTx: UnsignedTx = {
    ...stored,
    ...(nextWithHandles ? { next: nextWithHandles } : {}),
  };
  // Deep-freeze the stored copy so a mutation attempt on the object
  // `consumeHandle` hands back (by reference — see below) cannot alter what
  // a later `consumeHandle` on the same handle sees. Enforces the
  // immutability `execution/index.ts`'s send path relies on, rather than
  // resting on "nothing currently mutates it" (issue #710).
  store.set(handle, { tx: deepFreeze(storedTx), expiresAt });
  return withHandle;
}

/**
 * Retrieve the tx named by `handle`, or throw if unknown/expired. Does NOT
 * delete the entry — we need retry-on-device-disconnect to work, so the handle
 * stays valid until either:
 *   (a) the tx is successfully submitted to the relay (caller invokes
 *       `retireHandle` after the WalletConnect request resolves), or
 *   (b) the TTL expires.
 * Callers must call `retireHandle(handle)` on successful submission so replays
 * fail loudly instead of silently re-submitting the same payload.
 */
export function consumeHandle(handle: string): UnsignedTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired tx handle. Prepared transactions expire after 15 minutes and ` +
        `are single-use after a successful submission. Re-run the prepare_* tool to get a fresh handle.`
    );
  }
  return entry.tx;
}

/**
 * Mark a handle as used. Called after the tx has been successfully submitted
 * so the same handle cannot replay the submission. Safe to call on a handle
 * that was already pruned.
 */
export function retireHandle(handle: string): void {
  store.delete(handle);
}

/**
 * Attach a pinned gas tuple + its pre-sign hash to the handle. Called by
 * `preview_send` after fetching current nonce/fees/gas from the chain. The
 * tuple is what `send_transaction` must forward to WalletConnect verbatim —
 * if it doesn't, the hash the user matched on-device will not equal Ledger's
 * on-device hash and the user will reject.
 *
 * Overwrites any prior pin on the same handle (user may call preview_send
 * twice if they paused for minutes and want fresh fees).
 */
export function attachPinnedGas(handle: string, pin: StashedPin): void {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      "Unknown or expired tx handle. Prepared transactions expire after 15 minutes. " +
        "Re-run the prepare_* tool to get a fresh handle.",
    );
  }
  entry.pin = pin;
}

/**
 * Read a previously-stashed pin. Returns undefined if the handle was never
 * preview_send'd — callers in the signing path must treat that as an error
 * ("call preview_send first") rather than silently fall back to an unpinned
 * send, which would leave the on-device hash unpredictable.
 */
export function getPinnedGas(handle: string): StashedPin | undefined {
  prune();
  return store.get(handle)?.pin;
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}

/**
 * Mark `handle` as having had an ambiguous-outcome send attempt. Called
 * from `sendTransaction`'s catch block when `requestSendTransaction`
 * raises a `WalletConnectRequestTimeoutError` whose `kind` is one of
 * the post-probe outcomes. The mark survives until `retireHandle`
 * (successful submission) or `clearAmbiguousAttempt` (explicit
 * acknowledged retry). Issue #326 P3.
 */
export function markAmbiguousAttempt(handle: string, kind: AmbiguousAttemptKind): void {
  prune();
  const entry = store.get(handle);
  if (!entry) return;
  entry.ambiguousAttempt = { kind, at: Date.now() };
}

/**
 * Read the ambiguous-attempt mark on `handle`, or undefined if none.
 * Called at the top of `sendTransaction` to gate retries behind the
 * `acknowledgeRetryRiskAfterAmbiguousFailure` flag. Does NOT clear
 * the mark — clearing is the caller's choice (only after a fresh
 * acknowledged attempt completes or starts).
 */
export function getAmbiguousAttempt(handle: string): AmbiguousAttempt | undefined {
  prune();
  return store.get(handle)?.ambiguousAttempt;
}

/**
 * Clear the ambiguous-attempt mark. Called when the agent retries with
 * the ack flag — the next attempt is a fresh slate (one ack per
 * ambiguity); a SECOND ambiguous outcome on the retry will set the
 * mark again and require ANOTHER explicit ack.
 */
export function clearAmbiguousAttempt(handle: string): void {
  prune();
  const entry = store.get(handle);
  if (!entry) return;
  delete entry.ambiguousAttempt;
}
