/**
 * DefiLlama-backed yields adapter — bundles four protocols whose APY
 * data DefiLlama already publishes:
 *
 *   - Marinade liquid staking  (MSOL, Solana)        project: marinade-liquid-staking
 *   - Jito liquid staking      (JITOSOL, Solana)     project: jito-liquid-staking
 *   - Kamino lending           (USDC/USDT/SOL+, Solana) project: kamino-lend
 *   - Morpho Blue vaults       (curated MetaMorpho, EVM) project: morpho-blue
 *
 * Pattern mirrors `getLidoApr()` in `src/modules/staking/lido.ts`: one
 * cached fetch of `https://yields.llama.fi/pools`, filtered by
 * (project, chain, symbol). Trade-off vs. on-chain: DefiLlama refreshes
 * every ~5 min so rates lag a fresh on-chain read by minutes — fine for
 * a "where should I park USDC" comparison; the user's actual supply
 * goes through `prepare_*` tools which read fresh on-chain rates.
 *
 * Why bundled instead of per-protocol adapters: the DefiLlama endpoint
 * is one HTTP call covering all four protocols. Splitting into four
 * adapters means four cache keys, four fetches, same data. The
 * cache-amortized cost of one fetch + four filter passes is strictly
 * smaller.
 *
 * MarginFi borrow-lend is intentionally out of scope here — DefiLlama
 * only publishes `marginfi-lst` (MarginFi's LST product), not the
 * borrow-lend platform. MarginFi banks need an on-chain wallet-less
 * reader (issue #288).
 */
import { cache } from "../../../data/cache.js";
import { CACHE_TTL } from "../../../config/cache.js";
import { fetchWithTimeout } from "../../../data/http.js";
import type { AnyChain, SupportedChain } from "../../../types/index.js";
import type { YieldRow, UnavailableProtocolEntry } from "../types.js";
import type { SupportedAsset } from "../asset-map.js";
import { aprToApy } from "../types.js";

interface DefiLlamaPool {
  project: string;
  chain: string;
  symbol: string;
  apy: number | null;
  apyBase: number | null;
  tvlUsd: number | null;
  poolMeta: string | null;
}

interface DefiLlamaResponse {
  data: DefiLlamaPool[];
}

const DEFILLAMA_URL = "https://yields.llama.fi/pools";

/** Fetch + cache the full DefiLlama yields catalog. Single shared key —
 * every protocol filter below reuses the same cached payload, so the
 * adapter does at most one network call per `CACHE_TTL.YIELD` window
 * regardless of how many protocols / chains / assets the caller asks
 * for. */
async function fetchDefiLlamaPools(): Promise<DefiLlamaPool[] | undefined> {
  return cache.remember("yields:defillama-pools", CACHE_TTL.YIELD, async () => {
    try {
      const res = await fetchWithTimeout(DEFILLAMA_URL);
      if (!res.ok) return undefined;
      const body = (await res.json()) as DefiLlamaResponse;
      return Array.isArray(body?.data) ? body.data : undefined;
    } catch {
      return undefined;
    }
  });
}

/** DefiLlama uses display-cased chain names — map to our `AnyChain`. */
const DEFILLAMA_CHAIN_TO_OURS: Record<string, AnyChain> = {
  Ethereum: "ethereum",
  Arbitrum: "arbitrum",
  Polygon: "polygon",
  Base: "base",
  Optimism: "optimism",
  Solana: "solana",
};

/** Reverse of DEFILLAMA_CHAIN_TO_OURS — our `AnyChain` to DefiLlama display name. */
const OURS_TO_DEFILLAMA_CHAIN: Record<string, string> = Object.fromEntries(
  Object.entries(DEFILLAMA_CHAIN_TO_OURS).map(([llama, ours]) => [ours, llama]),
);

/** EVM chains we'll emit Morpho Blue rows on. Other DefiLlama-listed
 * Morpho chains (Hyperliquid L1, Katana, Unichain, etc.) aren't in our
 * `SupportedChain` union, so we'd have nowhere to render them. */
const MORPHO_EVM_CHAINS: ReadonlyArray<SupportedChain> = [
  "ethereum",
  "base",
  "arbitrum",
  "polygon",
  "optimism",
];

/** TVL floor for Morpho Blue vault rows. The catalog includes thousands
 * of dust pools (sub-$10k); they bottom-rank automatically but pollute
 * the row count. Top-N per (asset, chain) above this floor keeps the
 * comparison readable. */
const MORPHO_VAULT_TVL_FLOOR_USD = 5_000_000;

/** Max Morpho vault rows surfaced per (asset, chain). The composer
 * ranks by APY descending; the user sees the strongest few rather than
 * a 50-row vault table. */
const MORPHO_VAULTS_PER_ASSET_CHAIN = 3;

/** Map our `SupportedAsset` to a substring matcher for Morpho Blue
 * vault token symbols. Vault names embed the underlying asset
 * (STEAKUSDC, GTUSDC, GTWETH, …); a case-insensitive substring catches
 * the bulk without false matches into LST-flavored vaults (stETH,
 * weETH, wstETH — these have separate yields elsewhere on DefiLlama
 * via lido / ether.fi / etc.). */
function morphoSymbolMatcher(asset: SupportedAsset): RegExp | null {
  switch (asset) {
    case "USDC":
      return /USDC/i;
    case "USDT":
      return /USDT/i;
    case "ETH":
      // Match WETH-flavored vaults only — bare /ETH/ catches stETH,
      // weETH, oseth, etc. which are LST vaults with their own yield
      // sources, not pure ETH supply.
      return /WETH/i;
    case "BTC":
      return /WBTC/i;
    default:
      return null;
  }
}

/**
 * Emit `YieldRow`s from DefiLlama for the protocols this adapter
 * covers. The composer applies risk-score enrichment, filters, and
 * ranking after — same as every other adapter.
 */
export async function readDefiLlamaYields(
  asset: SupportedAsset,
  requestedChains: ReadonlyArray<AnyChain>,
): Promise<{ rows: YieldRow[]; unavailable: UnavailableProtocolEntry[] }> {
  const pools = await fetchDefiLlamaPools();

  if (!pools) {
    // One fetch covers all four protocols — surface the failure once
    // per protocol×chain that the caller actually requested, so the
    // user sees the coverage gap explicitly rather than silent absence.
    const unavailable: UnavailableProtocolEntry[] = [];
    if (requestedChains.includes("solana")) {
      unavailable.push(
        {
          protocol: "marinade",
          chain: "solana",
          available: false,
          reason: "DefiLlama yields endpoint unreachable — try again or check connectivity",
        },
        {
          protocol: "jito",
          chain: "solana",
          available: false,
          reason: "DefiLlama yields endpoint unreachable — try again or check connectivity",
        },
        {
          protocol: "kamino",
          chain: "solana",
          available: false,
          reason: "DefiLlama yields endpoint unreachable — try again or check connectivity",
        },
      );
    }
    for (const c of MORPHO_EVM_CHAINS) {
      if (requestedChains.includes(c)) {
        unavailable.push({
          protocol: "morpho-blue",
          chain: c,
          available: false,
          reason: "DefiLlama yields endpoint unreachable — try again or check connectivity",
        });
      }
    }
    return { rows: [], unavailable };
  }

  const rows: YieldRow[] = [];

  // Marinade and Jito — only emit for asset=SOL on Solana.
  if (asset === "SOL" && requestedChains.includes("solana")) {
    const marinade = pools.find(
      (p) =>
        p.project === "marinade-liquid-staking" &&
        p.chain === "Solana" &&
        p.symbol === "MSOL",
    );
    const marinadeRow = poolToRow(marinade, "marinade", "solana", "MSOL");
    if (marinadeRow) rows.push(marinadeRow);

    const jito = pools.find(
      (p) =>
        p.project === "jito-liquid-staking" &&
        p.chain === "Solana" &&
        p.symbol === "JITOSOL",
    );
    const jitoRow = poolToRow(jito, "jito", "solana", "JITOSOL");
    if (jitoRow) rows.push(jitoRow);
  }

  // Kamino lending — exact-symbol match for USDC/USDT/SOL on Solana.
  // Kamino has multiple markets (Main, JLP, etc.); each appears as a
  // separate row keyed by `(symbol, poolMeta)` so the user sees market
  // diversity rather than one collapsed APR.
  if (requestedChains.includes("solana")) {
    const targetSymbol = kaminoSymbolFor(asset);
    if (targetSymbol) {
      const matches = pools.filter(
        (p) =>
          p.project === "kamino-lend" &&
          p.chain === "Solana" &&
          p.symbol === targetSymbol,
      );
      for (const pool of matches) {
        const market = pool.poolMeta
          ? `Kamino ${pool.poolMeta} · ${pool.symbol}`
          : `Kamino · ${pool.symbol}`;
        const row = poolToRow(pool, "kamino", "solana", market);
        if (row) rows.push(row);
      }
    }
  }

  // Morpho Blue — top-N curated vaults per (asset, EVM chain) above
  // TVL floor. Substring match on vault token symbol; full vault label
  // surfaced in `market`.
  const morphoMatcher = morphoSymbolMatcher(asset);
  if (morphoMatcher) {
    for (const evmChain of MORPHO_EVM_CHAINS) {
      if (!requestedChains.includes(evmChain)) continue;
      const llamaChain = OURS_TO_DEFILLAMA_CHAIN[evmChain];
      if (!llamaChain) continue;

      const vaults = pools
        .filter(
          (p) =>
            p.project === "morpho-blue" &&
            p.chain === llamaChain &&
            morphoMatcher.test(p.symbol) &&
            (p.tvlUsd ?? 0) >= MORPHO_VAULT_TVL_FLOOR_USD &&
            (p.apy ?? 0) > 0,
        )
        .sort((a, b) => (b.apy ?? 0) - (a.apy ?? 0))
        .slice(0, MORPHO_VAULTS_PER_ASSET_CHAIN);

      for (const pool of vaults) {
        const market = `Morpho · ${pool.symbol}`;
        const row = poolToRow(pool, "morpho-blue", evmChain, market);
        if (row) rows.push(row);
      }
    }
  }

  return { rows, unavailable: [] };
}

function kaminoSymbolFor(asset: SupportedAsset): string | null {
  switch (asset) {
    case "USDC":
      return "USDC";
    case "USDT":
      return "USDT";
    case "SOL":
      return "SOL";
    default:
      return null;
  }
}

/** Build a `YieldRow` from a DefiLlama pool, or null if the pool is
 * absent / has no usable rate. DefiLlama's `apy` field is already a
 * percentage (4.28 = 4.28%); we store it as a fraction (0.0428) to
 * match the rest of the codebase. */
function poolToRow(
  pool: DefiLlamaPool | undefined,
  protocol: YieldRow["protocol"],
  chain: AnyChain,
  market: string,
): YieldRow | null {
  if (!pool) return null;
  const apy = pool.apy;
  if (typeof apy !== "number" || apy <= 0) return null;
  const apr = apy / 100;
  return {
    protocol,
    chain,
    market,
    supplyApr: apr,
    supplyApy: aprToApy(apr),
    tvl: typeof pool.tvlUsd === "number" ? pool.tvlUsd : null,
    riskScore: null, // enriched by composer
  };
}
