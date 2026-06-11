import { TRONGRID_BASE_URL } from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { fetchWithTimeout } from "../../data/http.js";

/**
 * TRON tx-status polling via TronGrid. Mirrors the EVM
 * get_transaction_status shape so the top-level MCP tool can route by chain
 * without the caller noticing the underlying API split.
 *
 * Endpoints used:
 *   - /wallet/gettransactionbyid — returns the signed envelope once the tx
 *     lands in the node's mempool / confirmed block. Empty object = unknown.
 *   - /wallet/gettransactioninfobyid — returns block number, fee, and the
 *     receipt (SUCCESS / REVERT / OUT_OF_ENERGY) once confirmed. Empty
 *     object = not yet confirmed.
 *
 * A fresh broadcast typically shows up in gettransactionbyid within a
 * couple of seconds and in gettransactioninfobyid after the next block
 * (~3s). The "unknown" state only persists for truly-lost tx IDs or
 * extremely fresh broadcasts.
 */

interface GetTxByIdResponse {
  txID?: string;
  raw_data?: {
    contract?: Array<{ type?: string; parameter?: unknown }>;
  };
  ret?: Array<{ contractRet?: string }>;
}

interface GetTxInfoResponse {
  id?: string;
  blockNumber?: number;
  fee?: number;
  receipt?: {
    result?: string;
    energy_usage?: number;
    energy_usage_total?: number;
    net_usage?: number;
  };
  log?: unknown;
  contractResult?: string[];
}

async function trongridPost<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const apiKey = resolveTronApiKey(readUserConfig());
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export async function getTronTransactionStatus(txHash: string): Promise<{
  chain: "tron";
  txHash: string;
  status: "success" | "failed" | "pending" | "unknown";
  blockNumber?: string;
  feeTrx?: string;
  energyUsed?: string;
  receiptResult?: string;
  note?: string;
}> {
  const normalized = txHash.replace(/^0x/, "").toLowerCase();

  const [byId, info] = await Promise.all([
    trongridPost<GetTxByIdResponse>("/wallet/gettransactionbyid", { value: normalized }),
    trongridPost<GetTxInfoResponse>("/wallet/gettransactioninfobyid", { value: normalized }),
  ]);

  const seenInMempool = Boolean(byId?.txID);
  const confirmed = Boolean(info?.blockNumber);

  if (!seenInMempool && !confirmed) {
    return {
      chain: "tron",
      txHash: normalized,
      status: "unknown",
      note: "Transaction not yet visible to TronGrid — it may still be propagating or the txID is wrong.",
    };
  }

  if (!confirmed) {
    return { chain: "tron", txHash: normalized, status: "pending" };
  }

  // Confirmed. Status comes from two places depending on tx type:
  //   - smart-contract calls (TRC-20 transfer etc.): receipt.result is
  //     "SUCCESS" / "REVERT" / "OUT_OF_ENERGY" / "OUT_OF_TIME" etc.
  //   - native transfers (TransferContract, WithdrawBalance): no receipt,
  //     check ret[0].contractRet from gettransactionbyid.
  const receiptResult = info.receipt?.result;
  const contractRet = byId.ret?.[0]?.contractRet;
  const successTag =
    receiptResult === "SUCCESS" || (!receiptResult && contractRet === "SUCCESS");
  const status: "success" | "failed" = successTag ? "success" : "failed";

  const feeTrx =
    typeof info.fee === "number"
      ? (info.fee / 1_000_000).toString()
      : undefined;

  const surfacedReceiptResult = receiptResult || contractRet;
  return {
    chain: "tron",
    txHash: normalized,
    status,
    blockNumber: info.blockNumber!.toString(),
    ...(feeTrx !== undefined ? { feeTrx } : {}),
    ...(info.receipt?.energy_usage_total !== undefined
      ? { energyUsed: info.receipt.energy_usage_total.toString() }
      : {}),
    ...(surfacedReceiptResult ? { receiptResult: surfacedReceiptResult } : {}),
  };
}
