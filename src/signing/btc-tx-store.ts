import { createHash, randomUUID } from "node:crypto";
import type { UnsignedBitcoinTx } from "../types/index.js";

/**
 * In-memory registry of prepared Bitcoin transactions. Parallel to
 * `tron-tx-store.ts` and `solana-tx-store.ts`. Separated deliberately:
 * the BTC send flow needs PSBT bytes, a Ledger BTC app round-trip, and
 * a different broadcast path (Esplora REST). `send_transaction` routes
 * by which store owns the handle.
 *
 * Same TTL semantics as the other stores: 15 min from issue, single-use
 * after submission. The user has 15 min to review and approve on Ledger
 * before the handle is rejected.
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredBitcoinTx {
  tx: UnsignedBitcoinTx;
  expiresAt: number;
}

const store = new Map<string, StoredBitcoinTx>();

/**
 * Recursively `Object.freeze` `value` and every plain-object/array it
 * reaches, so a later mutation on the object `consumeBitcoinHandle` hands
 * back throws instead of silently sticking. Sibling of `tx-store.ts`'s
 * `deepFreeze` (issue #710/#730) — this store has no mutable wrapper
 * metadata (no pin/attempt fields), so the whole stored tx is fair game.
 * Issue #742 — sweep the freeze across every chain-specific tx-store.
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
 * Compute a BTC fingerprint over the PSBT bytes. Domain-tagged so a
 * collision between this and other chains' fingerprints is impossible.
 * Same role as `buildSolanaVerification`'s payloadHash — pair-consistency
 * anchor the user can compare across stages, NOT shown on-device (Ledger
 * BTC clear-signs every output, so the on-device anchor is the address +
 * amount per output).
 */
function btcPayloadHash(psbtBase64: string): `0x${string}` {
  const payload = Buffer.concat([
    Buffer.from("VaultPilot-txverify-v1:btc:", "utf-8"),
    Buffer.from(psbtBase64, "utf-8"),
  ]);
  const digest = createHash("sha256").update(payload).digest("hex");
  return `0x${digest}` as `0x${string}`;
}

export function issueBitcoinHandle(
  tx: Omit<UnsignedBitcoinTx, "handle" | "fingerprint">,
): UnsignedBitcoinTx {
  prune();
  const handle = randomUUID();
  const fingerprint = btcPayloadHash(tx.psbtBase64);
  const withHandle: UnsignedBitcoinTx = { ...tx, handle, fingerprint };
  const { handle: _h, ...stored } = withHandle;
  // Deep-freeze the stored copy (issue #742, sibling of #710/#730) so a
  // mutation attempt on the object `consumeBitcoinHandle` hands back
  // cannot alter what a later `consumeBitcoinHandle` on the same handle
  // sees. This also freezes `stored.decoded` (outputs/sources arrays) all
  // the way down — a future post-issue enrichment step that tries to
  // write into it will throw in strict mode; that's a flag to route the
  // enrichment through `issueBitcoinHandle` instead of mutating in place.
  store.set(handle, {
    tx: deepFreeze(stored as UnsignedBitcoinTx),
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return withHandle;
}

export function consumeBitcoinHandle(handle: string): UnsignedBitcoinTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Bitcoin tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run prepare_btc_send for a fresh handle.`,
    );
  }
  return entry.tx;
}

export function retireBitcoinHandle(handle: string): void {
  store.delete(handle);
}

export function hasBitcoinHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}

/** Test-only — drop the entire store. */
export function __clearBitcoinTxStore(): void {
  store.clear();
}
