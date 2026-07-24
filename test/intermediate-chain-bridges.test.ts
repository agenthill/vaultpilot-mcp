import { describe, it, expect } from "vitest";
import {
  INTERMEDIATE_CHAIN_BRIDGES,
  matchIntermediateChainBridge,
} from "../src/modules/swap/intermediate-chain-bridges.js";

/**
 * THIS IS A SECURITY TEST.
 *
 * #799: the former NEAR entry `{ bridgeName: "near", intermediateChainId:
 * 1885080386571452n }` was an UNVERIFIED value that relaxed the
 * chainId-mismatch fund-routing defense on a false premise (the literal is
 * not this codebase's TRON LiFi id 728126428 and is not attested anywhere
 * as NEAR's genuine settlement-chain id). It was REMOVED and the allowlist
 * is now intentionally empty / fail-closed.
 *
 * These tests pin the REMOVAL: the false literal must not reappear, and
 * every entry that IS ever added must satisfy the shape invariants. If a
 * future PR restores intermediate-chain support for #237 it must add a
 * SEPARATELY-VERIFIED id (per the module's "Adding a new entry" rules) and
 * update the first test's guard deliberately — never by pasting 1885080386571452n back.
 */
describe("INTERMEDIATE_CHAIN_BRIDGES — false NEAR entry removed (security, #799)", () => {
  it("does NOT contain the unverified NEAR literal 1885080386571452", () => {
    // Regression pin for #799. RED on pre-fix source (the entry exists);
    // GREEN once the false entry is removed.
    const hasFalseLiteral = INTERMEDIATE_CHAIN_BRIDGES.some(
      (e) => e.intermediateChainId === 1885080386571452n,
    );
    expect(hasFalseLiteral).toBe(false);

    const near = INTERMEDIATE_CHAIN_BRIDGES.find(
      (e) => e.bridgeName === "near",
    );
    expect(near).toBeUndefined();
  });

  it("any entry present has a non-empty lowercase bridge name and a positive bigint chain ID (empty allowlist is valid)", () => {
    // Empty is the current fail-closed state; assert shape only for
    // whatever entries exist rather than requiring a non-empty table.
    expect(INTERMEDIATE_CHAIN_BRIDGES.length).toBeGreaterThanOrEqual(0);
    for (const entry of INTERMEDIATE_CHAIN_BRIDGES) {
      expect(entry.bridgeName).toBe(entry.bridgeName.toLowerCase());
      expect(entry.bridgeName.length).toBeGreaterThan(0);
      expect(typeof entry.intermediateChainId).toBe("bigint");
      expect(entry.intermediateChainId).toBeGreaterThan(0n);
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});

describe("matchIntermediateChainBridge", () => {
  // #799 REGRESSION FALSIFIER. On pre-fix source this pair matched the
  // allowlisted NEAR entry and returned a non-null match, relaxing the
  // chainId-mismatch defense for the unverified id 1885080386571452. With
  // the false entry removed the allowlist is empty, so the previously
  // "allowed" (bridge, chainId) pair — including any case variant of the
  // bridge label — must now return null (fail-closed). RED on unfixed code,
  // GREEN with the fix.
  it("REJECTS the removed NEAR pair — bridge='near' + 1885080386571452 no longer opens the gate (#799)", () => {
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "NEAR",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "Near",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
  });

  it("REJECTS bridge=NEAR with a non-NEAR chain ID (chain-ID tamper attempt)", () => {
    // Attacker spoofs the bridge name "near" but encodes some other
    // chain ID, hoping the allowlist match is name-only. Must be null.
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 728126428n, // TRON
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 99999999n, // arbitrary
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "near",
        destinationChainId: 0n,
      }),
    ).toBeNull();
  });

  it("REJECTS the NEAR chain ID with a non-NEAR bridge name (bridge-name tamper attempt)", () => {
    // Attacker uses NEAR's chain ID but labels the bridge as "across"
    // — hoping the allowlist match is chain-ID-only. Must be null.
    expect(
      matchIntermediateChainBridge({
        bridge: "across",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "wormhole",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "",
        destinationChainId: 1885080386571452n,
      }),
    ).toBeNull();
  });

  it("REJECTS unknown (bridge, chain) pairs entirely", () => {
    expect(
      matchIntermediateChainBridge({
        bridge: "across",
        destinationChainId: 42161n, // arbitrum, a real chain
      }),
    ).toBeNull();
    expect(
      matchIntermediateChainBridge({
        bridge: "made-up-bridge",
        destinationChainId: 1n,
      }),
    ).toBeNull();
  });
});
