/**
 * EVM chains supported by the server. Intentionally kept narrow so every
 * `Record<SupportedChain, …>` table in the codebase continues to represent
 * "per-EVM-chain" configuration — viem clients, Aave/Compound/Uniswap
 * addresses, numeric chain IDs, etc.
 *
 * Non-EVM chains (currently only TRON) live in `SupportedNonEvmChain`, and
 * the `AnyChain` union below is what cross-chain entry points (tool inputs,
 * portfolio summary) accept. This split keeps TRON strictly additive: EVM
 * internals don't need to learn that TRON exists.
 */
export type SupportedChain = "ethereum" | "arbitrum" | "polygon" | "base" | "optimism";

export const SUPPORTED_CHAINS: readonly SupportedChain[] = [
  "ethereum",
  "arbitrum",
  "polygon",
  "base",
  "optimism",
] as const;

/** Non-EVM chains. Kept as its own union so EVM-only tables keep their type. */
export type SupportedNonEvmChain = "tron" | "solana";

export const SUPPORTED_NON_EVM_CHAINS: readonly SupportedNonEvmChain[] = [
  "tron",
  "solana",
] as const;

/** Any chain the server knows about — EVM or non-EVM. */
export type AnyChain = SupportedChain | SupportedNonEvmChain;

export const ALL_CHAINS: readonly AnyChain[] = [
  ...SUPPORTED_CHAINS,
  ...SUPPORTED_NON_EVM_CHAINS,
] as const;

export function isEvmChain(c: AnyChain): c is SupportedChain {
  return (SUPPORTED_CHAINS as readonly string[]).includes(c);
}

export type RpcProvider = "infura" | "alchemy" | "custom";

/** Numeric chain IDs for the chains we support. */
export const CHAIN_IDS: Record<SupportedChain, number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  optimism: 10,
};

export const CHAIN_ID_TO_NAME: Record<number, SupportedChain> = {
  1: "ethereum",
  42161: "arbitrum",
  137: "polygon",
  8453: "base",
  10: "optimism",
};

/**
 * TRON mainnet chain id, as used by the WalletConnect `tron:` namespace and
 * the TronGrid mainnet endpoint. The numeric value is 0x2b6653dc (728126428),
 * the first 4 bytes of the genesis block hash.
 */
export const TRON_CHAIN_ID = 728126428;
