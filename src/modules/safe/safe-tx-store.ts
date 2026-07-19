import type { SafeTxBody } from "./safe-tx.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * In-memory registry of proposed Safe transactions, keyed by safeTxHash.
 *
 * Purpose: bind `submit_safe_tx_signature` to the EXACT SafeTx body that
 * `prepare_safe_tx_propose` constructed. Without this, the submit step
 * would have to re-derive `(to, value, data, nonce, ...)` from caller input
 * — at which point a prompt-injected agent could substitute different inner
 * args between approve and submit, making the on-chain `approveHash` tx the
 * user signed cover one inner call but the Safe Tx Service post a different
 * one. The server is the source of truth; the agent only passes the
 * safeTxHash forward.
 *
 * Lifetime: 30 minutes. Long enough for an `approveHash` tx to land on
 * mainnet under high gas competition (the `prepare_safe_tx_propose` returns
 * an UnsignedTx whose own handle has 15-minute TTL — so the user has 15 min
 * to broadcast, then up to ~15 min for inclusion before submit fails). Past
 * the TTL the SafeTx body is gone from the server and the user re-runs
 * `prepare_safe_tx_propose` to rebuild it.
 */
const SAFE_TX_TTL_MS = 30 * 60_000;

interface SafeTxEntry {
  chain: SupportedChain;
  safeAddress: `0x${string}`;
  body: SafeTxBody;
  /**
   * Original handle of the prepare receipt that produced this SafeTx —
   * exposed back to the caller so the verification block can cross-link
   * the on-chain `approveHash` tx with the SafeTx body it represents.
   */
  proposeHandle?: string;
  expiresAt: number;
}

const store = new Map<string, SafeTxEntry>();

/**
 * Recursively `Object.freeze` `value` and every plain-object/array it
 * reaches, so a later `entry.body.to = x` throws in strict mode instead of
 * silently sticking. Sibling of `signing/tx-store.ts`'s `deepFreeze`
 * (issue #710/#730, swept across tron/solana/btc/ltc by #742) — the Safe
 * store was the one #742 missed. Issue #751.
 *
 * Applied to the `body` VALUE only, never the `SafeTxEntry` wrapper: the
 * wrapper's `expiresAt` and future metadata stay mutable for the store's own
 * bookkeeping, matching how the sibling stores freeze only the stored tx.
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
  for (const [hash, entry] of store) {
    if (entry.expiresAt < now) store.delete(hash);
  }
}

export function rememberSafeTx(args: {
  safeTxHash: `0x${string}`;
  chain: SupportedChain;
  safeAddress: `0x${string}`;
  body: SafeTxBody;
  proposeHandle?: string;
}): void {
  prune();
  store.set(args.safeTxHash.toLowerCase(), {
    chain: args.chain,
    safeAddress: args.safeAddress,
    // Deep-freeze the body so a mutation of the object `lookupSafeTx` hands
    // back (by reference) cannot alter what a later `lookupSafeTx` on the
    // same hash — or the `submit_safe_tx_signature` POST — sees. Enforces the
    // "server is source of truth" binding this store's doc comment relies on,
    // rather than resting on "nothing currently mutates it" (issue #751).
    body: deepFreeze(args.body),
    proposeHandle: args.proposeHandle,
    expiresAt: Date.now() + SAFE_TX_TTL_MS,
  });
}

/**
 * Look up a remembered SafeTx body. Returns `undefined` when the entry has
 * expired or was never proposed through this server (the caller decides
 * whether to error out or fall back to a Safe Tx Service round-trip).
 */
export function lookupSafeTx(safeTxHash: `0x${string}`): SafeTxEntry | undefined {
  prune();
  return store.get(safeTxHash.toLowerCase());
}

/** Test-only: reset the store between cases. */
export function clearSafeTxStoreForTesting(): void {
  store.clear();
}
