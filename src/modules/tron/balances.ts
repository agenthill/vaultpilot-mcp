import { fetchWithTimeout } from "../../data/http.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import {
  TRONGRID_BASE_URL,
  TRX_DECIMALS,
  TRX_SYMBOL,
  TRON_TOKENS,
  isTronAddress,
} from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { formatUnits } from "../../data/format.js";
import type { TronBalance, TronPortfolioSlice } from "../../types/index.js";

/**
 * Decimals per canonical TRC-20. Hardcoded because the list is tiny and
 * stable — adding a dynamic `decimals()` call per token would double the
 * TronGrid fan-out for no practical benefit.
 */
const TOKEN_DECIMALS: Record<keyof typeof TRON_TOKENS, number> = {
  USDT: 6,
  USDC: 6,
  USDD: 18,
  TUSD: 18,
};

interface TrongridAccountsResponse {
  data?: Array<{
    balance?: number;
    trc20?: Array<Record<string, string>>;
  }>;
}

interface LlamaResponse {
  coins: Record<string, { price: number }>;
}

async function trongridGet<T>(path: string, apiKey: string | undefined): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, { headers });
  if (res.status === 429) {
    // Tag the rate-limit hit so `get_vaultpilot_config_status` can
    // surface a "set up a TronGrid API key" hint to the user. We
    // still throw — tagging is purely an observability hook.
    const { recordRateLimit } = await import(
      "../../data/rate-limit-tracker.js"
    );
    recordRateLimit({ kind: "tron" });
  }
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * Fetch USD prices for TRX + the queried TRC-20 tokens from DefiLlama.
 * Identified via the `tron:<base58>` key; native TRX via `coingecko:tron`.
 * Missing prices are simply absent from the map — callers flag them via
 * `priceMissing` on the returned balance.
 */
async function fetchTronPrices(tokenAddresses: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys: string[] = ["coingecko:tron"]; // native TRX
  for (const addr of tokenAddresses) keys.push(`tron:${addr}`);

  // Respect the same 30s cache as the EVM price path.
  const uncached: string[] = [];
  for (const k of keys) {
    const hit = cache.get<number>(`price:${k}`);
    if (hit !== undefined) out.set(k, hit);
    else uncached.push(k);
  }
  if (uncached.length === 0) return out;

  try {
    const url = `https://coins.llama.fi/prices/current/${encodeURIComponent(uncached.join(","))}`;
    const res = await fetchWithTimeout(url);
    if (!res.ok) return out;
    const body = (await res.json()) as LlamaResponse;
    for (const k of uncached) {
      const coin = body.coins[k];
      if (coin && typeof coin.price === "number") {
        out.set(k, coin.price);
        cache.set(`price:${k}`, coin.price, CACHE_TTL.PRICE);
      }
    }
  } catch {
    // Price misses are non-fatal — the balance still renders with priceMissing:true.
  }
  return out;
}

/**
 * Read TRX + canonical TRC-20 balances for a base58 TRON address via
 * TronGrid. Returns the balances alongside a total USD figure so the portfolio
 * aggregator can fold TRON into the single-number `totalUsd`.
 *
 * Throws if `address` isn't a valid mainnet base58 shape or if TronGrid's
 * accounts endpoint errors out — the portfolio aggregator wraps the call in
 * its standard catch-and-continue so a TronGrid outage doesn't kill the rest
 * of the summary.
 */
export async function getTronBalances(address: string): Promise<TronPortfolioSlice> {
  if (!isTronAddress(address)) {
    throw new Error(
      `"${address}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`
    );
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const accounts = await trongridGet<TrongridAccountsResponse>(
    `/v1/accounts/${address}`,
    apiKey
  );
  const acc = accounts.data?.[0];
  // TronGrid returns `{data: []}` for addresses with no activity — that's a
  // valid "zero balance everywhere" state, not an error.
  const trxSun = BigInt(acc?.balance ?? 0);

  // Flatten the trc20 array of single-key maps into one map, then project
  // onto our canonical TOKEN_DECIMALS (unknown TRC-20 balances are dropped
  // because we have no decimals/price reference for them).
  const trc20Map = new Map<string, bigint>();
  for (const entry of acc?.trc20 ?? []) {
    for (const [contract, amount] of Object.entries(entry)) {
      trc20Map.set(contract, BigInt(amount));
    }
  }

  const priceAddrs = Object.values(TRON_TOKENS);
  const prices = await fetchTronPrices(priceAddrs);

  const trxPrice = prices.get("coingecko:tron");
  const trxFormatted = formatUnits(trxSun, TRX_DECIMALS);
  const trxValueUsd =
    trxPrice !== undefined ? Number(trxFormatted) * trxPrice : undefined;

  const nativeBalance: TronBalance = {
    chain: "tron",
    token: "native",
    symbol: TRX_SYMBOL,
    decimals: TRX_DECIMALS,
    amount: trxSun.toString(),
    formatted: trxFormatted,
    ...(trxPrice !== undefined ? { priceUsd: trxPrice } : {}),
    ...(trxValueUsd !== undefined ? { valueUsd: trxValueUsd } : {}),
    ...(trxPrice === undefined ? { priceMissing: true } : {}),
  };

  const trc20: TronBalance[] = [];
  for (const [symbol, contract] of Object.entries(TRON_TOKENS) as [
    keyof typeof TRON_TOKENS,
    string,
  ][]) {
    const raw = trc20Map.get(contract) ?? 0n;
    if (raw === 0n) continue;
    const decimals = TOKEN_DECIMALS[symbol];
    const formatted = formatUnits(raw, decimals);
    const price = prices.get(`tron:${contract}`);
    const valueUsd = price !== undefined ? Number(formatted) * price : undefined;
    trc20.push({
      chain: "tron",
      token: contract,
      symbol,
      decimals,
      amount: raw.toString(),
      formatted,
      ...(price !== undefined ? { priceUsd: price } : {}),
      ...(valueUsd !== undefined ? { valueUsd } : {}),
      ...(price === undefined ? { priceMissing: true } : {}),
    });
  }

  const walletBalancesUsd =
    (nativeBalance.valueUsd ?? 0) +
    trc20.reduce((s, t) => s + (t.valueUsd ?? 0), 0);

  // Only include native in the `native` array when non-zero, matching the
  // EVM portfolio convention.
  const native = trxSun > 0n ? [nativeBalance] : [];

  return {
    address,
    native,
    trc20,
    walletBalancesUsd: Math.round(walletBalancesUsd * 100) / 100,
  };
}

/**
 * Fetch a single TRC-20 or TRX balance by token. Mirrors the shape of
 * get_token_balance for EVM chains. `token` can be "native" for TRX, or a
 * base58 TRC-20 contract address.
 */
export async function getTronTokenBalance(
  wallet: string,
  token: string
): Promise<TronBalance> {
  if (!isTronAddress(wallet)) {
    throw new Error(
      `"${wallet}" is not a valid TRON mainnet address (expected base58, 34 chars, prefix T).`
    );
  }

  const slice = await getTronBalances(wallet);
  if (token === "native") {
    // getTronBalances drops zero-balance native from the array, so rebuild
    // the zero case here for the single-token API.
    if (slice.native.length > 0) return slice.native[0];
    return {
      chain: "tron",
      token: "native",
      symbol: TRX_SYMBOL,
      decimals: TRX_DECIMALS,
      amount: "0",
      formatted: "0",
    };
  }

  if (!isTronAddress(token)) {
    throw new Error(
      `"${token}" is not a valid TRC-20 contract address (expected base58).`
    );
  }
  const found = slice.trc20.find((t) => t.token === token);
  if (found) return found;
  // Unknown/zero TRC-20: return a minimal zero balance with unknown decimals.
  // Phase 1 scope: we don't do a separate `decimals()` read for arbitrary
  // TRC-20s — callers asking about tokens we don't enumerate get the shape
  // they expect but with decimals:0. Full decimals resolution can land with
  // the write path in Phase 2.
  return {
    chain: "tron",
    token,
    symbol: "UNKNOWN",
    decimals: 0,
    amount: "0",
    formatted: "0",
    priceMissing: true,
  };
}
