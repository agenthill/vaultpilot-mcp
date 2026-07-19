import { randomUUID } from "node:crypto";
import {
  patchExpirationInRawData,
  txIdFromRawDataHex,
} from "../modules/tron/patch-expiration.js";
import type { UnsignedTronTx } from "../types/index.js";
import { buildTronVerification } from "./verification.js";

/**
 * In-memory registry of prepared TRON transactions. Parallel to
 * signing/tx-store.ts but stores `UnsignedTronTx` rather than EVM
 * `UnsignedTx`. Separated deliberately: the EVM send flow runs an
 * eth_call re-simulation, chain-id check, and spender allowlist that are
 * all meaningless on TRON. `send_transaction` routes by which store owns
 * the handle — TRON handles go to the USB HID signer in
 * tron-usb-signer.ts, EVM handles stay on the WalletConnect path.
 *
 * Lifetime matches the EVM store (15 min from issue).
 */
const TX_TTL_MS = 15 * 60_000;

/**
 * On-chain expiration window we apply to every TronGrid-built tx. TronGrid's
 * default ~60s is too tight for the prepare → CHECKS PERFORMED display →
 * Ledger character-walk → broadcast loop. The TRON protocol caps expiration
 * at 24h after `timestamp`; we set it to the max so the user-facing
 * verification step is never the thing that races the network.
 *
 * The agent-side handle TTL above (15 min) is independent — that bounds
 * how long a stored handle remains valid for `send_transaction`, which is
 * orthogonal to how long the signed-and-broadcast tx itself stays
 * acceptable to the network. Issue #280.
 */
const TRON_TX_EXPIRATION_MS = 24 * 60 * 60 * 1000;

interface StoredTx {
  tx: UnsignedTronTx;
  expiresAt: number;
}

const store = new Map<string, StoredTx>();

/**
 * Recursively `Object.freeze` `value` and every plain-object/array it
 * reaches, so a later mutation on the object `consumeTronHandle` hands back
 * throws instead of silently sticking. Sibling of `tx-store.ts`'s
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

export function issueTronHandle(tx: UnsignedTronTx): UnsignedTronTx {
  prune();
  const handle = randomUUID();
  // Widen the on-chain expiration to TRON's 24h max for every tx we own
  // the rawData for. LiFi-swap txs (action: "lifi_swap", rawData absent)
  // carry bytes built by LiFi with their own intent-binding window; we
  // don't patch those — patching would invalidate LiFi's quote.
  const widened = tx.rawData !== undefined ? widenExpiration(tx) : tx;
  const verification = widened.verification ?? buildTronVerification(widened);
  const withHandle: UnsignedTronTx = { ...widened, handle, verification };
  const { handle: _h, ...stored } = withHandle;
  // Deep-freeze the stored copy (issue #742, sibling of #710/#730) so a
  // mutation attempt on the object `consumeTronHandle` hands back cannot
  // alter what a later `consumeTronHandle` on the same handle sees. This
  // also freezes `stored.verification` and `stored.decoded` all the way
  // down — a future post-issue enrichment step that tries to write into
  // either (e.g. attaching a simulation result after the fact) will throw
  // in strict mode; that's a flag to route the enrichment through
  // `issueTronHandle` instead of mutating the stored tx in place.
  store.set(handle, {
    tx: deepFreeze(stored as UnsignedTronTx),
    expiresAt: Date.now() + TX_TTL_MS,
  });
  return withHandle;
}

/**
 * Patch rawDataHex's expiration field to 24h from now, then re-derive
 * txID and the rawData JSON so all three stay in sync. The contract
 * fields (addresses, amounts, parameter) are byte-identical before and
 * after — patchExpirationInRawData touches only the field-8 varint, so
 * the prior `assertTronRawDataMatches` verdict still holds for the
 * patched bytes.
 *
 * Returns the original tx unchanged when:
 *   - rawData.expiration is undefined (test stubs that don't simulate
 *     a full TronGrid response — production responses always set it)
 *   - rawDataHex isn't valid protobuf (test stubs with synthetic bytes)
 *
 * Both cases are test-only; in production every TronGrid response has
 * a real protobuf rawDataHex and a numeric expiration, so the patch
 * always applies.
 */
function widenExpiration(tx: UnsignedTronTx): UnsignedTronTx {
  const oldRawData = tx.rawData as Record<string, unknown>;
  if (typeof oldRawData.expiration !== "number") return tx;
  const newExpirationMs = BigInt(Date.now() + TRON_TX_EXPIRATION_MS);
  let newRawDataHex: string;
  try {
    newRawDataHex = patchExpirationInRawData(tx.rawDataHex, newExpirationMs);
  } catch {
    return tx;
  }
  const newTxID = txIdFromRawDataHex(newRawDataHex);
  // rawData is the JSON object TronGrid returned alongside rawDataHex;
  // broadcast.ts forwards it to /wallet/broadcasttransaction. Update its
  // `expiration` field too so the broadcast body matches the bytes we
  // signed. Use Number() — TronGrid returns expiration as a JSON number
  // (ms-since-epoch fits comfortably in Number's 53-bit safe range until
  // ~year 287000).
  const newRawData = { ...oldRawData, expiration: Number(newExpirationMs) };
  return {
    ...tx,
    rawDataHex: newRawDataHex,
    rawData: newRawData,
    txID: newTxID,
  };
}

export function consumeTronHandle(handle: string): UnsignedTronTx {
  prune();
  const entry = store.get(handle);
  if (!entry) {
    throw new Error(
      `Unknown or expired TRON tx handle. Prepared transactions expire after 15 minutes ` +
        `and are single-use after submission. Re-run the prepare_tron_* tool for a fresh handle.`
    );
  }
  return entry.tx;
}

export function retireTronHandle(handle: string): void {
  store.delete(handle);
}

/** Test-only: true if `handle` is still active (not retired, not expired). */
export function hasTronHandle(handle: string): boolean {
  prune();
  return store.has(handle);
}
