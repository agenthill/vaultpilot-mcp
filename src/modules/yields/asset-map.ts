/**
 * Asset symbol → per-chain canonical address resolver for `compare_yields`.
 *
 * Lifts addresses from the existing per-chain registries — `CONTRACTS` for
 * EVM chains (`src/config/contracts.ts`), `SOLANA_TOKENS` for Solana
 * (`src/config/solana.ts`) — rather than re-encoding. This means a token
 * added to either registry shows up in `compare_yields` automatically.
 *
 * The `"stables"` alias expands to USDC + USDT per chain (the two
 * stables every adapter knows how to price). Adding more aliases here
 * would expand the meta-asset semantics; v1 keeps it tight.
 *
 * For ETH on EVM we return the canonical WETH address since lending
 * markets supply against WETH, not native ETH. The display label stays
 * "ETH" so the user sees what they recognize.
 */
import { CONTRACTS } from "../../config/contracts.js";
import { SOLANA_TOKENS } from "../../config/solana.js";
import type { SupportedChain, AnyChain } from "../../types/index.js";

export type SupportedAsset = "USDC" | "USDT" | "ETH" | "SOL" | "BTC" | "stables";

/** A resolved (asset, chain) → on-chain identifier mapping. */
export interface AssetMapEntry {
  /** Canonical display symbol (echoes input, e.g. "USDC"). */
  symbol: string;
  /** EVM-chain ERC-20 contract OR Solana SPL mint OR null if N/A. */
  address: string | null;
  /** Decimals for human-readable amount conversion. */
  decimals: number;
  /** True for native-asset rows where supplying means using a wrapper (ETH→WETH). */
  isWrappedNative?: boolean;
}

const EVM_CHAINS: ReadonlyArray<SupportedChain> = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
  "optimism",
];

/** Per-asset EVM token-registry key + wire properties. */
const EVM_ASSET_SPEC: Record<string, { tokenKey: string; decimals: number; isWrappedNative?: true }> = {
  USDC: { tokenKey: "USDC", decimals: 6 },
  USDT: { tokenKey: "USDT", decimals: 6 },
  ETH:  { tokenKey: "WETH", decimals: 18, isWrappedNative: true },
  BTC:  { tokenKey: "WBTC", decimals: 8,  isWrappedNative: true },
};

/**
 * Resolve `(asset, chain)` to the canonical address + decimals on that
 * chain. Returns `null` when the asset isn't deployed on the chain
 * (e.g. SOL on ethereum, ETH/WETH on solana, BTC on EVM).
 *
 * Implementation notes:
 *   - "stables" is a meta-asset; callers should expand it via
 *     `expandStables()` before calling this.
 *   - "ETH" on EVM resolves to WETH (wrapped) — Aave/Compound supply
 *     markets use WETH, not native ETH.
 *   - "BTC" only resolves on EVM as WBTC; native BTC isn't a supply-
 *     side yield asset on any of the integrated lending protocols.
 */
export function resolveAsset(
  asset: SupportedAsset,
  chain: AnyChain,
): AssetMapEntry | null {
  if (asset === "stables") return null; // expand first via expandStables()

  if (chain === "solana") {
    if (asset === "SOL") {
      // SOL is native; lending protocols on Solana expose it directly
      // (no wrapping). The address `null` signals "native asset".
      return { symbol: "SOL", address: null, decimals: 9 };
    }
    if (asset === "USDC" || asset === "USDT") {
      return { symbol: asset, address: SOLANA_TOKENS[asset], decimals: 6 };
    }
    return null;
  }

  if (chain === "tron") {
    // No integrated lending on TRON today — yields tool returns empty
    // rather than 404'ing the whole request. Bitcoin/Litecoin aren't
    // even in the AnyChain union so they can't reach this branch.
    return null;
  }

  // EVM chain
  if (!EVM_CHAINS.includes(chain as SupportedChain)) return null;
  const tokens = CONTRACTS[chain as SupportedChain].tokens as Record<string, string>;

  const spec = EVM_ASSET_SPEC[asset];
  if (!spec) return null;
  const addr = tokens[spec.tokenKey];
  if (!addr) return null;
  return {
    symbol: asset,
    address: addr,
    decimals: spec.decimals,
    ...(spec.isWrappedNative ? { isWrappedNative: true } : {}),
  };
}

/**
 * Expand the "stables" meta-asset into the concrete underlying assets the
 * adapters can each price. v1 = USDC + USDT (the two stables every
 * lending protocol on every supported chain has a market for).
 */
export function expandStables(): SupportedAsset[] {
  return ["USDC", "USDT"];
}

/**
 * Default chain set when the caller doesn't restrict. EVM mainnets +
 * Solana for the Solana-native protocols.
 */
export const DEFAULT_YIELDS_CHAINS: ReadonlyArray<AnyChain> = [
  ...EVM_CHAINS,
  "solana",
];
