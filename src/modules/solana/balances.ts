import { fetchWithTimeout } from "../../data/http.js";
import { PublicKey } from "@solana/web3.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import {
  SOL_DECIMALS,
  SOL_SYMBOL,
  SOLANA_TOKENS,
  SOLANA_TOKEN_DECIMALS,
  WSOL_MINT,
} from "../../config/solana.js";
import { getSolanaConnection } from "./rpc.js";
import { assertSolanaAddress } from "./address.js";
import { formatUnits } from "../../data/format.js";
import type { SolanaBalance, SolanaPortfolioSlice } from "../../types/index.js";

const SPL_TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);

interface LlamaResponse {
  coins: Record<string, { price: number }>;
}

/** Reverse map: mint → canonical symbol (for the canonical list in SOLANA_TOKENS). */
const MINT_TO_SYMBOL = new Map<string, keyof typeof SOLANA_TOKENS>(
  (Object.entries(SOLANA_TOKENS) as [keyof typeof SOLANA_TOKENS, string][]).map(
    ([sym, addr]) => [addr, sym],
  ),
);

/**
 * Fetch SOL + canonical SPL prices from DefiLlama. Uses `solana:<mint>`
 * coin keys and `coingecko:solana` for native SOL. 30s cache (reuses the
 * existing PRICE TTL). Missing prices are simply absent — balances render
 * with `priceMissing: true` instead of crashing the whole response.
 */
async function fetchSolanaPrices(mints: string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys: string[] = ["coingecko:solana"];
  for (const addr of mints) keys.push(`solana:${addr}`);

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
    // Best-effort — price misses render as priceMissing, not a fatal error.
  }
  return out;
}

/**
 * Read SOL + SPL balances for a base58 Solana address. Returns the slice the
 * portfolio aggregator folds into `breakdown.solana` and `solanaUsd`.
 *
 * SPL enumeration uses `getTokenAccountsByOwner` over both the SPL Token
 * program AND the Token-2022 program (the two live programs minting spl-
 * compatible tokens). We parse the token account raw bytes directly — the
 * layout is 165 bytes fixed: [mint:32][owner:32][amount:u64 LE][...]. Only
 * non-zero balances for mints we recognize make it into the returned slice
 * (Phase 1 scope), matching the TRON precedent.
 *
 * Throws if `address` doesn't pass the strict pubkey validator, or if the
 * Solana RPC errors out — the portfolio aggregator wraps the call in its
 * standard catch-and-continue so an RPC outage doesn't kill the rest of the
 * summary.
 */
export async function getSolanaBalances(address: string): Promise<SolanaPortfolioSlice> {
  const pubkey = assertSolanaAddress(address);

  const cacheKey = `solana:balances:${address}`;
  const cached = cache.get<SolanaPortfolioSlice>(cacheKey);
  if (cached) return cached;

  const conn = getSolanaConnection();

  // Parallel fan-out: native SOL + SPL-Token + Token-2022.
  const [lamports, splTokenAccounts, token2022Accounts] = await Promise.all([
    conn.getBalance(pubkey),
    conn.getTokenAccountsByOwner(pubkey, { programId: SPL_TOKEN_PROGRAM_ID }),
    conn.getTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);

  // Aggregate SPL holdings by mint. A wallet can in theory hold multiple
  // token accounts for the same mint (main ATA + a non-ATA token account);
  // sum the raw amounts so the displayed balance matches the user's
  // economic holding.
  const mintAmounts = new Map<string, bigint>();
  for (const entry of [...splTokenAccounts.value, ...token2022Accounts.value]) {
    const data = entry.account.data;
    if (!(data instanceof Buffer) || data.length < 72) continue;
    const mint = new PublicKey(data.subarray(0, 32)).toBase58();
    const amount = data.readBigUInt64LE(64);
    mintAmounts.set(mint, (mintAmounts.get(mint) ?? 0n) + amount);
  }

  const priceMints = Object.values(SOLANA_TOKENS);
  const prices = await fetchSolanaPrices(priceMints);

  const solPrice = prices.get("coingecko:solana");
  const solFormatted = formatUnits(BigInt(lamports), SOL_DECIMALS);
  const solValueUsd =
    solPrice !== undefined ? Number(solFormatted) * solPrice : undefined;

  const nativeBalance: SolanaBalance = {
    chain: "solana",
    token: "native",
    symbol: SOL_SYMBOL,
    decimals: SOL_DECIMALS,
    amount: String(lamports),
    formatted: solFormatted,
    ...(solPrice !== undefined ? { priceUsd: solPrice } : {}),
    ...(solValueUsd !== undefined ? { valueUsd: solValueUsd } : {}),
    ...(solPrice === undefined ? { priceMissing: true } : {}),
  };

  const spl: SolanaBalance[] = [];
  for (const [symbol, mint] of Object.entries(SOLANA_TOKENS) as [
    keyof typeof SOLANA_TOKENS,
    string,
  ][]) {
    const raw = mintAmounts.get(mint) ?? 0n;
    if (raw === 0n) continue;
    const decimals = SOLANA_TOKEN_DECIMALS[symbol];
    const formatted = formatUnits(raw, decimals);
    const price = prices.get(`solana:${mint}`);
    const valueUsd = price !== undefined ? Number(formatted) * price : undefined;
    spl.push({
      chain: "solana",
      token: mint,
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
    spl.reduce((s, t) => s + (t.valueUsd ?? 0), 0);

  const native = BigInt(lamports) > 0n ? [nativeBalance] : [];

  const slice: SolanaPortfolioSlice = {
    address,
    native,
    spl,
    walletBalancesUsd: Math.round(walletBalancesUsd * 100) / 100,
  };

  cache.set(cacheKey, slice, CACHE_TTL.POSITION);
  return slice;
}

/**
 * Fetch a single SPL or native SOL balance by mint. Mirrors the shape of
 * `getTokenBalance` for EVM + TRON. `token` is "native" for SOL, the WSOL
 * mint (handled as a regular SPL), or any SPL mint address.
 */
export async function getSolanaTokenBalance(
  wallet: string,
  token: string,
): Promise<SolanaBalance> {
  const pubkey = assertSolanaAddress(wallet);

  if (token === "native") {
    const slice = await getSolanaBalances(wallet);
    if (slice.native.length > 0) return slice.native[0];
    return {
      chain: "solana",
      token: "native",
      symbol: SOL_SYMBOL,
      decimals: SOL_DECIMALS,
      amount: "0",
      formatted: "0",
    };
  }

  const mintPubkey = assertSolanaAddress(token);

  // Known canonical mint → use the pre-enumerated slice (saves an RPC call).
  const knownSymbol = MINT_TO_SYMBOL.get(token);
  if (knownSymbol) {
    const slice = await getSolanaBalances(wallet);
    const hit = slice.spl.find((t) => t.token === token);
    if (hit) return hit;
    return {
      chain: "solana",
      token,
      symbol: knownSymbol,
      decimals: SOLANA_TOKEN_DECIMALS[knownSymbol],
      amount: "0",
      formatted: "0",
      priceMissing: true,
    };
  }

  // Unknown mint — do a direct ATA lookup rather than enumerating all holdings.
  // Query both SPL Token and Token-2022 programs; whichever returns an account
  // wins. We don't call `getAssociatedTokenAddressSync` because that would
  // require pulling in `@solana/spl-token`; instead we list owner-filtered
  // accounts and pick the one matching the mint.
  const conn = getSolanaConnection();
  const [spl, spl2022] = await Promise.all([
    conn.getTokenAccountsByOwner(pubkey, { programId: SPL_TOKEN_PROGRAM_ID }),
    conn.getTokenAccountsByOwner(pubkey, { programId: TOKEN_2022_PROGRAM_ID }),
  ]);
  let raw = 0n;
  for (const entry of [...spl.value, ...spl2022.value]) {
    const data = entry.account.data;
    if (!(data instanceof Buffer) || data.length < 72) continue;
    const mint = new PublicKey(data.subarray(0, 32)).toBase58();
    if (mint !== token) continue;
    raw += data.readBigUInt64LE(64);
  }
  // Without a canonical decimals entry, fetch via getTokenSupply.
  let decimals = 0;
  try {
    const supply = await conn.getTokenSupply(mintPubkey);
    decimals = supply.value.decimals;
  } catch {
    decimals = 0;
  }
  const symbol = token === WSOL_MINT ? "WSOL" : "UNKNOWN";
  return {
    chain: "solana",
    token,
    symbol,
    decimals,
    amount: raw.toString(),
    formatted: formatUnits(raw, decimals),
    priceMissing: true,
  };
}
