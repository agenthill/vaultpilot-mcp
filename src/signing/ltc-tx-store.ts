import { createHash, randomUUID } from "node:crypto";
import type { UnsignedLitecoinTx } from "../types/index.js";

/**
 * In-memory registry of prepared Litecoin transactions. Mirror of
 * `btc-tx-store.ts`. Separate store so `send_transaction` can route
 * BTC vs LTC handles to the correct signing path.
 *
 * Same TTL semantics: 15 min from issue, single-use after submission.
 */
const TX_TTL_MS = 15 * 60_000;

interface StoredLitecoinTx {
  tx: UnsignedLitecoinTx;
  expiresAt: number;
}

const store = new Map<string, StoredLitecoinTx>();

function prune(now = Date.now()): void {
  for (const [handle, entry] of store) {
    if (entry.expiresAt < now) store.delete(handle);
  }
}

/**
 * Compute an LTC fingerprint over the PSBT bytes. Domain tag includes
 * `:ltc:` so a collision with the BTC fingerprint scheme is
 * cryptographically impossible.
 */
function ltcPayloadHash(psbtBase64: string): `0x${string}` {
  const payload = Buffer.concat([
    Buffer.from("VaultPilot-txverify-v1:ltc:", "utf-8"),
    Buffer.from(psbtBase64, "utf-8"),
  ]);
  const digest = createHash("sha256").update(payload).digest("hex");
  return `0x${digest}` as `0x${string}`;
}

export function issueLitecoinHandle(
  tx: Omit<UnsignedLitecoinTx, "handle" | "fingerprint">,
): UnsignedLitecoinTx {
  prune();
  // Distinct prefix avoids collision with BTC handle namespace; the
  // execution dispatcher uses `hasLitecoinHandle` / `hasBitcoinHandle`
  // to route, so prefixes aren't load-bearing for routing — but they
  // help debug-log readability.
  const handle = `ltc-${randomUUID()}`;
  const fingerprint = ltcPayloadHash(tx.psbtBase64);
  const withHandle: UnsignedLitecoinTx = { ...tx, handle, fingerprint };
  const { handle: _h, ...stored } = withHandle;
  store.set(handle, {
    tx: stored as UnsignedLitecoinTx,
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return withHandle;
}

export function consumeLitecoinHandle(handle: string): UnsignedLitecoinTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired Litecoin tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run prepare_litecoin_native_send for a fresh handle.`,
    );
  }
  return entry.tx;
}

export function retireLitecoinHandle(handle: string): void {
  store.delete(handle);
}

export function hasLitecoinHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}

/** Test-only — drop the entire store. */
export function __clearLitecoinTxStore(): void {
  store.clear();
}
