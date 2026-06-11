import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import type { UnsignedTronTx } from "../../types/index.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * `/wallet/broadcasttransaction` response. TronGrid encodes failures as
 * `{code: "SIGERROR" | "CONTRACT_VALIDATE_ERROR" | ..., message: hex-utf8}` —
 * note `message` is hex-encoded UTF-8, not plain text. Success is
 * `{result: true, txid}`.
 */
interface BroadcastResponse {
  result?: boolean;
  txid?: string;
  code?: string;
  message?: string;
}

/** Decode TronGrid's hex-encoded UTF-8 error message into plain text. */
function decodeHexMessage(hex: string): string {
  if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) return hex;
  try {
    return Buffer.from(hex, "hex").toString("utf8");
  } catch {
    return hex;
  }
}

function throwBroadcastRejection(label: string, data: BroadcastResponse): never {
  const decoded = data.message ? decodeHexMessage(data.message) : "unknown error";
  throw new Error(`${label}: ${data.code ?? "unknown code"} — ${decoded}`);
}

/**
 * Encode a base-128 varint per protobuf wire format. TRON's Transaction
 * envelope uses one for each length-delimited field. ~4 bytes max for the
 * sizes we encode (raw_data is hundreds-of-bytes, signature is exactly 65).
 */
function encodeVarintHex(n: number): string {
  if (n < 0) throw new Error("varint underflow");
  let hex = "";
  let value = n;
  while (value > 0x7f) {
    hex += (0x80 | (value & 0x7f)).toString(16).padStart(2, "0");
    value >>>= 7;
  }
  hex += value.toString(16).padStart(2, "0");
  return hex;
}

/**
 * Build the full hex of a signed TRON `Transaction` protobuf message from
 * its two parts:
 *
 *   message Transaction {
 *     Transaction.raw raw_data = 1;     // tag 0x0a, length-delimited
 *     bytes signature = 2;              // tag 0x12, length-delimited (repeated; single entry for our flow)
 *   }
 *
 * `/wallet/broadcasthex` takes this assembled envelope and accepts no
 * other shape. Used for LiFi-on-TRON broadcasts where we don't have the
 * deserialized `raw_data` JSON object — only the wire-form raw_data_hex.
 */
function buildSignedTransactionHex(rawDataHex: string, signatureHex: string): string {
  const rawData = rawDataHex.startsWith("0x") ? rawDataHex.slice(2) : rawDataHex;
  const sig = signatureHex.startsWith("0x") ? signatureHex.slice(2) : signatureHex;
  if (!/^[0-9a-fA-F]*$/.test(rawData) || rawData.length % 2 !== 0) {
    throw new Error("buildSignedTransactionHex: raw_data_hex is not valid hex");
  }
  if (!/^[0-9a-fA-F]+$/.test(sig) || sig.length % 2 !== 0) {
    throw new Error("buildSignedTransactionHex: signature is not valid hex");
  }
  const rawLen = rawData.length / 2;
  const sigLen = sig.length / 2;
  return "0a" + encodeVarintHex(rawLen) + rawData + "12" + encodeVarintHex(sigLen) + sig;
}

/**
 * Broadcast a signed TRON transaction via TronGrid.
 *
 * The signature is appended to the raw tx envelope in the `signature[]`
 * field. TronGrid multi-sig would use multiple entries; for single-sig
 * (the only flow we support) it's always exactly one.
 *
 * Two endpoint paths:
 *   - `/wallet/broadcasttransaction` — used when `tx.rawData` (the
 *     deserialized JSON) is present. Standard TronGrid-built txs from
 *     `prepare_tron_*` actions.
 *   - `/wallet/broadcasthex` — used when `tx.rawData` is absent (LiFi-
 *     routed flows). We encode the Transaction envelope ourselves from
 *     `raw_data_hex` + `signature` and post the assembled hex.
 *
 * Returns the on-chain txID on success. Throws with the decoded error
 * message on validation / signature failures.
 */
export async function broadcastTronTx(
  tx: UnsignedTronTx,
  signatureHex: string
): Promise<{ txID: string }> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;

  // No deserialized raw_data → use the broadcasthex endpoint instead. The
  // LiFi quote response for TRON-source flows returns only
  // raw_data_hex; reconstructing the JSON object from the protobuf would
  // need a per-contract-type deserializer (TriggerSmartContract /
  // TransferContract / FreezeBalanceV2 / ...) which is a parallel
  // codebase to verify-raw-data.ts. /broadcasthex sidesteps that work.
  if (tx.rawData === undefined) {
    const fullHex = buildSignedTransactionHex(tx.rawDataHex, signatureHex);
    const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}/wallet/broadcasthex`, {
      method: "POST",
      headers,
      body: JSON.stringify({ transaction: fullHex }),
    });
    if (!res.ok) {
      throw new Error(`TronGrid /wallet/broadcasthex returned ${res.status} ${res.statusText}`);
    }
    const data = (await res.json()) as BroadcastResponse;
    if (data.result === true) {
      return { txID: data.txid ?? tx.txID };
    }
    throwBroadcastRejection("TronGrid /broadcasthex rejected the transaction", data);
  }

  const body = {
    txID: tx.txID,
    raw_data: tx.rawData,
    raw_data_hex: tx.rawDataHex,
    signature: [signatureHex],
    visible: true,
  };

  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}/wallet/broadcasttransaction`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid /wallet/broadcasttransaction returned ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as BroadcastResponse;
  if (data.result === true) {
    return { txID: data.txid ?? tx.txID };
  }
  throwBroadcastRejection("TronGrid broadcast rejected the transaction", data);
}

// Internal export for tests. The signed-tx-hex builder is pure, no I/O,
// and worth pinning given it's protobuf wire-format glue.
export const __test_buildSignedTransactionHex = buildSignedTransactionHex;
