import { z } from "zod";
import { getTokenPrice, getDefillamaCoinPrice } from "../../data/prices.js";
import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";
import {
  resolveSymbolToCoingeckoId,
  allowlistSize,
} from "../../data/coin-allowlist.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(EVM_ADDRESS),
]);

export const getTokenPriceInput = z.object({
  chain: chainEnum,
  token: tokenSchema,
});

export type GetTokenPriceArgs = z.infer<typeof getTokenPriceInput>;

export async function getTokenPriceTool(args: GetTokenPriceArgs) {
  const chain = args.chain as SupportedChain;
  const token = args.token as "native" | `0x${string}`;
  const priceUsd = await getTokenPrice(chain, token);
  if (priceUsd === undefined) {
    throw new Error(
      `No DefiLlama price found for ${token} on ${chain}. The token may be unlisted, illiquid, or the address may be wrong.`
    );
  }
  return { chain, token, priceUsd, source: "defillama" as const };
}

// ===========================================================================
// get_coin_price — issue #274. EVM-agnostic price lookup by ticker symbol
// (allowlist) or CoinGecko ID (escape hatch). Closes the gap where LTC
// (and any future non-EVM native without an EVM contract) can't be
// priced via the EVM-only `get_token_price` tool.
// ===========================================================================

/**
 * Input shape — exactly one of `symbol` / `coingeckoId` must be set.
 * The XOR check lives in the handler (not as `.refine()`) because
 * the MCP SDK requires a plain `ZodObject` to extract `.shape` for the
 * tool registration; `.refine()` would wrap it in ZodEffects and
 * break that.
 */
export const getCoinPriceInput = z.object({
  symbol: z
    .string()
    .min(1)
    .max(20)
    .optional()
    .describe(
      `Ticker symbol from the curated allowlist (~${allowlistSize()} entries; case-insensitive). ` +
        `Examples: "BTC", "LTC", "SOL", "DOGE", "USDC", "stETH". The allowlist hardcodes the ` +
        `canonical CoinGecko ID for each symbol so scam tickers can't poison the result. For ` +
        `assets not on the allowlist, use the \`coingeckoId\` field instead.`,
    ),
  coingeckoId: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe(
      `CoinGecko ID (the URL slug from coingecko.com/en/coins/<id>). Examples: "litecoin", ` +
        `"bitcoin", "monero". Bypasses the allowlist for long-tail assets. Pass exactly one of ` +
        `\`symbol\` or \`coingeckoId\`.`,
    ),
});

export type GetCoinPriceArgs = z.infer<typeof getCoinPriceInput>;

export interface CoinPriceResponse {
  /** Symbol the user passed (or the resolved upstream symbol when coingeckoId was used). */
  symbol: string;
  priceUsd: number;
  /** Always "defillama-coingecko" in v1; future sources stay distinguishable. */
  source: "defillama-coingecko";
  /** Verbatim DefiLlama key the lookup used — useful for the agent to relay to the user transparently. */
  resolvedKey: string;
  /** Unix seconds — when DefiLlama observed this price. Absent on rare degraded responses. */
  asOf?: number;
  /** DefiLlama's 0–1 confidence score; absent for low-liquidity coins. */
  confidence?: number;
}

export async function getCoinPriceTool(
  args: GetCoinPriceArgs,
): Promise<CoinPriceResponse> {
  // XOR validation. Lives in the handler because the MCP SDK needs a
  // plain ZodObject for `.shape` extraction at registration time, so
  // we can't use `.refine()` on the schema.
  if (!!args.symbol === !!args.coingeckoId) {
    throw new Error(
      "Pass exactly one of `symbol` (allowlist lookup) or `coingeckoId` (escape hatch). Both or neither is invalid.",
    );
  }
  let coingeckoId: string;
  let displaySymbol: string;
  if (args.coingeckoId) {
    coingeckoId = args.coingeckoId.trim().toLowerCase();
    displaySymbol = coingeckoId; // upstream may overwrite via entry.symbol
  } else if (args.symbol) {
    const resolved = resolveSymbolToCoingeckoId(args.symbol);
    if (!resolved) {
      throw new Error(
        `"${args.symbol}" is not on the curated symbol allowlist (~${allowlistSize()} entries). ` +
          `Either use the canonical ticker (e.g. "BTC", "LTC", "SOL", "USDC", "DOGE") OR pass ` +
          `\`coingeckoId\` directly with the CoinGecko URL slug from coingecko.com/en/coins/<id>. ` +
          `Refusing to free-form-resolve symbols because tickers like "USDC" / "USDT" / "ETH" ` +
          `collide with dozens of scam tokens on CoinGecko.`,
      );
    }
    coingeckoId = resolved;
    displaySymbol = args.symbol.toUpperCase();
  } else {
    // Schema-refine should prevent this; defensive throw for invariant safety.
    throw new Error("Internal: neither symbol nor coingeckoId set after schema validation.");
  }

  const entry = await getDefillamaCoinPrice(coingeckoId);
  if (!entry) {
    throw new Error(
      `DefiLlama returned no price for "coingecko:${coingeckoId}". The coin may be unlisted, ` +
        `delisted, or the ID may be wrong (cross-check at https://www.coingecko.com/en/coins/${coingeckoId}).`,
    );
  }
  return {
    symbol: entry.symbol ?? displaySymbol,
    priceUsd: entry.price,
    source: "defillama-coingecko",
    resolvedKey: `coingecko:${coingeckoId}`,
    ...(entry.timestamp !== undefined ? { asOf: entry.timestamp } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
  };
}
