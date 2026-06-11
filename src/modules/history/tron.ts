import { fetchWithTimeout } from "../../data/http.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import {
  TRONGRID_BASE_URL,
  TRX_DECIMALS,
  TRON_TOKENS,
  isTronAddress,
} from "../../config/tron.js";
import { formatUnitsFromDecimalString as formatUnitsDecimal } from "../../data/format.js";
import type {
  ExternalHistoryItem,
  TokenTransferHistoryItem,
} from "./schemas.js";

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const SERVER_ROW_CAP = 100;
const MAX_SYMBOL_LEN = 32;
const PHISHING_PATTERN = /https?|www\.|claim|visit|airdrop|\.com|\.io|\.app|\.xyz|\.net/;

const KNOWN_TOKEN_DECIMALS: Record<string, number> = {
  [TRON_TOKENS.USDT]: 6,
  [TRON_TOKENS.USDC]: 6,
  [TRON_TOKENS.USDD]: 18,
  [TRON_TOKENS.TUSD]: 18,
};
const KNOWN_TOKEN_SYMBOLS: Record<string, string> = {
  [TRON_TOKENS.USDT]: "USDT",
  [TRON_TOKENS.USDC]: "USDC",
  [TRON_TOKENS.USDD]: "USDD",
  [TRON_TOKENS.TUSD]: "TUSD",
};

interface TrongridTxListResponse {
  data?: Array<{
    txID?: string;
    block_timestamp?: number;
    raw_data?: {
      contract?: Array<{
        parameter?: {
          value?: {
            owner_address?: string;
            to_address?: string;
            amount?: number | string;
          };
        };
        type?: string;
      }>;
    };
    ret?: Array<{ contractRet?: string }>;
  }>;
}

interface TrongridTrc20Response {
  data?: Array<{
    transaction_id?: string;
    block_timestamp?: number;
    from?: string;
    to?: string;
    value?: string;
    token_info?: {
      address?: string;
      decimals?: number;
      symbol?: string;
    };
  }>;
}

async function trongridGet<T>(path: string, apiKey: string | undefined): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, { headers });
  if (!res.ok) {
    // TRON-PRO-API-KEY never lands in the URL for TronGrid, so surfacing
    // path + status is safe.
    throw new Error(`TronGrid ${path} returned ${res.status}`);
  }
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error(`TronGrid ${path} response exceeds ${MAX_RESPONSE_BYTES} bytes`);
  }
  return JSON.parse(text) as T;
}

function sanitizeDisplayString(raw: string | undefined, maxLen: number): string {
  if (!raw) return "";
  return raw.replace(/[^A-Za-z0-9 ._\-]/g, "").trim().slice(0, maxLen);
}

/**
 * TRON addresses arrive in TronGrid responses as hex (prefix `41`) OR base58;
 * which one depends on the endpoint. Convert hex-prefixed to base58 for display
 * consistency — actually TronGrid's /v1/accounts/.../transactions endpoint
 * returns hex, so we'd need a full base58check encode. To avoid pulling a new
 * dep, return whatever TronGrid gave us and flag it in the docstring.
 *
 * NOTE: from/to on external TRX txs come as hex ("41..."); TRC-20 transfers
 * come as base58 ("T..."). Agents reading the output can tell by prefix.
 */
function normalizeAddress(raw: string | undefined): string {
  return typeof raw === "string" ? raw : "";
}

export interface TronFetchResult {
  external: ExternalHistoryItem[];
  tokenTransfers: TokenTransferHistoryItem[];
  truncated: boolean;
  errors: Array<{ source: string; message: string }>;
}

export async function fetchTronHistory(args: {
  wallet: string;
  includeExternal: boolean;
  includeTokenTransfers: boolean;
}): Promise<TronFetchResult> {
  const { wallet } = args;
  if (!isTronAddress(wallet)) {
    throw new Error(`"${wallet}" is not a valid TRON mainnet address.`);
  }

  const cacheKey = `history:tron:${wallet}`;
  const cached = cache.get<TronFetchResult>(cacheKey);
  if (cached) return filterForFlags(cached, args);

  const apiKey = resolveTronApiKey(readUserConfig());
  const errors: Array<{ source: string; message: string }> = [];

  const [extResp, trcResp] = await Promise.all([
    trongridGet<TrongridTxListResponse>(
      `/v1/accounts/${wallet}/transactions?limit=${SERVER_ROW_CAP}&order_by=block_timestamp,desc`,
      apiKey
    ).catch((e: Error) => {
      errors.push({ source: "trongrid.transactions", message: e.message });
      return { data: [] } as TrongridTxListResponse;
    }),
    trongridGet<TrongridTrc20Response>(
      `/v1/accounts/${wallet}/transactions/trc20?limit=${SERVER_ROW_CAP}&order_by=block_timestamp,desc`,
      apiKey
    ).catch((e: Error) => {
      errors.push({ source: "trongrid.trc20", message: e.message });
      return { data: [] } as TrongridTrc20Response;
    }),
  ]);

  const external: ExternalHistoryItem[] = [];
  for (const tx of extResp.data ?? []) {
    const contract = tx.raw_data?.contract?.[0];
    const p = contract?.parameter?.value;
    // Only surface TransferContract (native TRX transfers) as "external" items.
    // Other types (TriggerSmartContract, WitnessVote, etc.) are signal-rich but
    // would require per-type decoding we don't yet have — include the hash
    // alone with the type name isn't useful for an agent.
    if (contract?.type !== "TransferContract") continue;
    if (!tx.txID || !tx.block_timestamp) continue;
    const failed = (tx.ret?.[0]?.contractRet ?? "SUCCESS") !== "SUCCESS";
    const amountSun = p?.amount != null ? String(p.amount) : "0";
    external.push({
      type: "external",
      hash: tx.txID,
      timestamp: Math.floor(tx.block_timestamp / 1000),
      from: normalizeAddress(p?.owner_address),
      to: normalizeAddress(p?.to_address),
      valueNative: amountSun,
      valueNativeFormatted: formatUnitsDecimal(amountSun, TRX_DECIMALS),
      status: failed ? "failed" : "success",
    });
  }

  const tokenTransfers: TokenTransferHistoryItem[] = [];
  for (const row of trcResp.data ?? []) {
    if (!row.transaction_id || !row.block_timestamp) continue;
    const contract = row.token_info?.address ?? "";
    // Prefer the canonical symbol for known stablecoins — attacker-set
    // token_info.symbol is the phishing surface we care about.
    const rawSymbol = row.token_info?.symbol ?? "";
    const rawSymbolLower = rawSymbol.toLowerCase();
    if (PHISHING_PATTERN.test(rawSymbolLower)) continue;
    const canonicalSymbol = KNOWN_TOKEN_SYMBOLS[contract];
    const tokenSymbol =
      canonicalSymbol ?? (sanitizeDisplayString(rawSymbol, MAX_SYMBOL_LEN) || "UNKNOWN");
    const canonicalDecimals = KNOWN_TOKEN_DECIMALS[contract];
    const reportedDecimals = row.token_info?.decimals;
    const tokenDecimals =
      canonicalDecimals ??
      (typeof reportedDecimals === "number" && reportedDecimals >= 0 && reportedDecimals <= 36
        ? reportedDecimals
        : null);
    if (tokenDecimals === null) continue;
    const amount = /^\d+$/.test(row.value ?? "") ? (row.value as string) : "0";
    tokenTransfers.push({
      type: "token_transfer",
      hash: row.transaction_id,
      timestamp: Math.floor(row.block_timestamp / 1000),
      from: normalizeAddress(row.from),
      to: normalizeAddress(row.to),
      tokenAddress: contract,
      tokenSymbol,
      tokenDecimals,
      amount,
      amountFormatted: formatUnitsDecimal(amount, tokenDecimals),
      status: "success",
    });
  }

  const truncated =
    (extResp.data?.length ?? 0) >= SERVER_ROW_CAP ||
    (trcResp.data?.length ?? 0) >= SERVER_ROW_CAP;

  const result: TronFetchResult = { external, tokenTransfers, truncated, errors };
  if (errors.length < 2) cache.set(cacheKey, result, CACHE_TTL.HISTORY);
  return filterForFlags(result, args);
}

function filterForFlags(
  r: TronFetchResult,
  flags: { includeExternal: boolean; includeTokenTransfers: boolean }
): TronFetchResult {
  return {
    external: flags.includeExternal ? r.external : [],
    tokenTransfers: flags.includeTokenTransfers ? r.tokenTransfers : [],
    truncated: r.truncated,
    errors: r.errors,
  };
}
