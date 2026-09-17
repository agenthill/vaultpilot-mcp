import type { AnyChain } from "../../types/index.js";

/**
 * Accepted BridgeData.destinationChainId values, keyed ONLY by the user's
 * requested destination. These are on-chain IDs, not the LiFi API namespace:
 * TRON's API ID is 728126428, but its BridgeData ID is 1885080386571452.
 * Bridge labels and quote metadata must never select or relax this comparison.
 *
 * Non-EVM source: LiFiData.sol, LIFI_CHAIN_ID_TRON / LIFI_CHAIN_ID_SOLANA:
 * https://github.com/lifinance/contracts/blob/8da9776d194b8e83894ea5746c059dfb8f0457f6/src/Helpers/LiFiData.sol
 * Additions require source evidence, a deliberate update to the pinned-table
 * test, and the optional live check: npm run verify:lifi-chain-ids (after build).
 */
export const LIFI_BRIDGE_CHAIN_IDS: Readonly<Record<AnyChain, readonly bigint[]>> = {
  ethereum: [1n],
  arbitrum: [42161n],
  polygon: [137n],
  base: [8453n],
  optimism: [10n],
  solana: [1151111081099710n],
  tron: [1885080386571452n],
};

/** No quote-supplied bridge name or API chain ID participates in this gate. */
export function assertLifiDestinationChain(toChain: string, encodedId: bigint): void {
  const acceptedIds = Object.prototype.hasOwnProperty.call(LIFI_BRIDGE_CHAIN_IDS, toChain)
    ? LIFI_BRIDGE_CHAIN_IDS[toChain as AnyChain]
    : undefined;
  if (!acceptedIds?.includes(encodedId)) {
    throw new Error(
      `LiFi bridge calldata destinationChainId mismatch: encoded ${encodedId} ` +
        `but user requested toChain="${toChain}" (accepted on-chain IDs: ${acceptedIds?.join(", ") ?? "none"}). ` +
        `Refusing to return calldata — this would route funds to the wrong chain. Re-run get_swap_quote.`,
    );
  }
}
