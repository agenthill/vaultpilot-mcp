/**
 * `resolve_token` — symbol+chain → canonical contract address (issue
 * #440). Read-only lookup against the existing per-chain registries
 * (`CONTRACTS[chain].tokens`, `SOLANA_TOKENS`, `TRON_TOKENS`). Lets
 * agents stop hardcoding token contracts and surfaces the
 * native-vs-bridged ambiguity (USDC vs USDC.e on Arbitrum/Polygon/
 * Optimism, USDC vs USDbC on Base) before the user commits to a
 * contract via `prepare_token_send`.
 *
 * Why this is a separate tool, not a `prepare_token_send` parameter
 * (per the issue's Option 2): keeping the resolution step explicit
 * lets the agent surface bridged-vs-native warnings to the user FIRST
 * — collapsing it into prepare_token_send would silently pick one
 * variant and bury the disambiguation downstream.
 *
 * No on-chain probing. The resolver is canonical-registry-only by
 * design; going on-chain to resolve unknown symbols would open up
 * phishing-token name-collision risk (an attacker can deploy a
 * contract that returns "USDC" from `symbol()` but is wholly
 * unrelated to the real Circle stablecoin).
 */
import { z } from "zod";
import { CONTRACTS } from "../../config/contracts.js";
import {
  SOLANA_TOKENS,
  SOLANA_TOKEN_DECIMALS,
} from "../../config/solana.js";
import { TRON_TOKENS } from "../../config/tron.js";
import { isEvmChain, type AnyChain, type SupportedChain } from "../../types/index.js";

/**
 * Chains the resolver knows tokens for. BTC + LTC have no token
 * registries (they're UTXO chains; "tokens" is a misnomer there) so
 * they're excluded from the schema.
 */
const RESOLVABLE_CHAINS = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
  "optimism",
  "solana",
  "tron",
] as const;
type ResolvableChain = (typeof RESOLVABLE_CHAINS)[number];

export const resolveTokenInput = z.object({
  chain: z
    .enum(RESOLVABLE_CHAINS)
    .describe(
      "Chain the symbol is on. Restricted to the chains with curated token tables. BTC + LTC have no token concept and aren't accepted."
    ),
  symbol: z
    .string()
    .min(1)
    .max(40)
    .describe(
      "Token symbol to resolve (case-insensitive, but the canonical-registry key casing wins on output). Examples: \"USDC\", \"USDC.e\", \"USDbC\", \"WETH\", \"BONK\". The resolver does NOT probe on-chain — only canonical-registry hits succeed, by design (stops phishing-token symbol collisions from being resolved silently)."
    ),
});

export type ResolveTokenArgs = z.infer<typeof resolveTokenInput>;

/**
 * Per-chain bridged-sibling map. When the user asks for one symbol
 * and a bridged sibling exists on the same chain, surface a warning
 * with the alternative contract — the agent passes both options to
 * the user before the user commits to a contract.
 *
 * Origin notes:
 *   - Arbitrum / Polygon / Optimism: USDC.e is the legacy bridged
 *     USDC; native Circle USDC ships under the bare USDC symbol.
 *   - Base: USDbC is the bridged Coinbase-wrapped legacy USDC;
 *     native Circle USDC ships under the bare USDC symbol.
 */
const BRIDGED_SIBLINGS: Record<SupportedChain, Record<string, string>> = {
  ethereum: {},
  arbitrum: { USDC: "USDC.e", "USDC.e": "USDC" },
  polygon: { USDC: "USDC.e", "USDC.e": "USDC" },
  base: { USDC: "USDbC", USDbC: "USDC" },
  optimism: { USDC: "USDC.e", "USDC.e": "USDC" },
};

/**
 * Per-symbol decimals for EVM tokens we publish in `CONTRACTS`. The
 * registry holds addresses only; decimals here. Verified against
 * each token's on-chain `decimals()` at registry-add time.
 */
const EVM_DECIMALS: Record<string, number> = {
  USDC: 6,
  USDT: 6,
  "USDC.e": 6,
  "USDT.e": 6,
  USDbC: 6,
  DAI: 18,
  WETH: 18,
  WBTC: 8,
  WMATIC: 18,
  AAVE: 18,
  ARB: 18,
  OP: 18,
  UNI: 18,
  LDO: 18,
  LINK: 18,
  cbETH: 18,
  wstETH: 18,
};

/**
 * Per-symbol decimals for TRON tokens. All four current entries are
 * 6-decimal stables; verified at registry-add time.
 */
const TRON_DECIMALS: Record<string, number> = {
  USDT: 6,
  USDC: 6,
  USDD: 18,
  TUSD: 18,
};

/**
 * Possible warning kinds attached to a successful resolution. Agents
 * surface these verbatim to the user before calling
 * `prepare_token_send` so the user picks the variant they actually
 * want.
 */
export type ResolveTokenWarning =
  | "hasBridgedVariant"
  | "isBridgedVariant";

export interface ResolveTokenAlternative {
  symbol: string;
  contract: string;
  decimals: number;
}

export interface ResolveTokenResult {
  chain: ResolvableChain;
  /** Canonical-registry symbol (preserves the registry's casing — `USDC.e`, `cbETH`, etc.). */
  symbol: string;
  contract: string;
  decimals: number;
  warnings: ResolveTokenWarning[];
  /** Other contracts that ALSO match this symbol on the same chain after warning resolution. Empty array when there's no ambiguity. */
  alternatives: ResolveTokenAlternative[];
  source: "canonical-registry";
}

/** Case-insensitive lookup that returns the canonical-registry key. */
function findRegistryKey(
  registry: Record<string, unknown>,
  symbol: string,
): string | null {
  const lower = symbol.toLowerCase();
  for (const k of Object.keys(registry)) {
    if (k.toLowerCase() === lower) return k;
  }
  return null;
}

export async function resolveToken(
  args: ResolveTokenArgs,
): Promise<ResolveTokenResult> {
  const { chain, symbol } = args;

  if (chain === "solana") {
    const key = findRegistryKey(SOLANA_TOKENS, symbol);
    if (!key) {
      throw new Error(unknownSymbolError(symbol, chain, Object.keys(SOLANA_TOKENS)));
    }
    const mint = (SOLANA_TOKENS as Record<string, string>)[key];
    const decimals =
      (SOLANA_TOKEN_DECIMALS as Record<string, number>)[key] ?? null;
    if (decimals === null) {
      throw new Error(
        `Solana mint for ${key} is registered but its decimals aren't — file an issue (regression in SOLANA_TOKEN_DECIMALS).`,
      );
    }
    return {
      chain: "solana",
      symbol: key,
      contract: mint,
      decimals,
      warnings: [],
      alternatives: [],
      source: "canonical-registry",
    };
  }

  if (chain === "tron") {
    const key = findRegistryKey(TRON_TOKENS, symbol);
    if (!key) {
      throw new Error(unknownSymbolError(symbol, chain, Object.keys(TRON_TOKENS)));
    }
    const contract = (TRON_TOKENS as Record<string, string>)[key];
    const decimals = TRON_DECIMALS[key];
    if (decimals === undefined) {
      throw new Error(
        `TRON token ${key} is registered but its decimals aren't — file an issue (TRON_DECIMALS table out of sync with TRON_TOKENS).`,
      );
    }
    return {
      chain: "tron",
      symbol: key,
      contract,
      decimals,
      warnings: [],
      alternatives: [],
      source: "canonical-registry",
    };
  }

  // EVM path.
  if (!isEvmChain(chain as AnyChain)) {
    // unreachable given the schema enum, but kept as a guard.
    throw new Error(`unexpected chain: ${chain}`);
  }
  const evmChain = chain as SupportedChain;
  const tokens = CONTRACTS[evmChain].tokens as Record<string, string>;
  const key = findRegistryKey(tokens, symbol);
  if (!key) {
    throw new Error(unknownSymbolError(symbol, evmChain, Object.keys(tokens)));
  }
  const contract = tokens[key];
  const decimals = EVM_DECIMALS[key];
  if (decimals === undefined) {
    throw new Error(
      `${evmChain}/${key} is in CONTRACTS but its decimals aren't in EVM_DECIMALS — file an issue.`,
    );
  }

  const warnings: ResolveTokenWarning[] = [];
  const alternatives: ResolveTokenAlternative[] = [];
  const siblingSymbol = BRIDGED_SIBLINGS[evmChain]?.[key];
  if (siblingSymbol) {
    const siblingContract = tokens[siblingSymbol];
    const siblingDecimals = EVM_DECIMALS[siblingSymbol];
    if (siblingContract && typeof siblingDecimals === "number") {
      // The "lower" form (with .e or USDbC) is the bridged variant; the
      // "bare" symbol is the native one. Distinguish so the warning
      // tells the agent which side the user is on.
      const isBridged = key.endsWith(".e") || key === "USDbC";
      warnings.push(isBridged ? "isBridgedVariant" : "hasBridgedVariant");
      alternatives.push({
        symbol: siblingSymbol,
        contract: siblingContract,
        decimals: siblingDecimals,
      });
    }
  }

  return {
    chain: evmChain,
    symbol: key,
    contract,
    decimals,
    warnings,
    alternatives,
    source: "canonical-registry",
  };
}

function unknownSymbolError(
  symbol: string,
  chain: string,
  knownSymbols: string[],
): string {
  const sample = knownSymbols.slice(0, 12).join(", ");
  const more = knownSymbols.length > 12 ? `, …(${knownSymbols.length - 12} more)` : "";
  return (
    `Unknown token symbol "${symbol}" on ${chain}. The resolver only matches canonical-registry entries; ` +
    `going on-chain to resolve arbitrary symbols would open phishing-token risk. Known symbols on ${chain}: ${sample}${more}. ` +
    `If the token you want is missing, look up its contract address on a block explorer and pass it directly to prepare_token_send.`
  );
}
