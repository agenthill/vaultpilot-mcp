import { describe, expect, it } from "vitest";
import { assertLifiDestinationChain, LIFI_BRIDGE_CHAIN_IDS } from "../src/modules/swap/lifi-chain-ids.js";

describe("LiFi on-chain destination IDs (#799)", () => {
  it("pins the entire accepted table so additions require review", () => {
    expect(LIFI_BRIDGE_CHAIN_IDS).toEqual({
      ethereum: [1n],
      arbitrum: [42161n],
      polygon: [137n],
      base: [8453n],
      optimism: [10n],
      solana: [1151111081099710n],
      tron: [1885080386571452n],
    });
  });

  it.each(["unknown", "constructor", "__proto__"])("refuses unsupported destination %s", (chain) => {
    expect(() => assertLifiDestinationChain(chain, 1n))
      .toThrow(/destinationChainId mismatch/);
  });
});
