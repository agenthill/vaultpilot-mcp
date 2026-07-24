/**
 * Hardcoded allowlist of LiFi bridge tools whose `BridgeData.destinationChainId`
 * legitimately encodes an INTERMEDIATE settlement chain rather than the user's
 * final destination chain.
 *
 * Background
 * ----------
 * The default chainId-mismatch defense in `verifyLifiBridgeIntent` refuses
 * any cross-chain bridge calldata whose encoded `destinationChainId` doesn't
 * equal the LiFi chain ID for the user's requested `toChain`. That's the
 * right default — it's the layer that catches a compromised aggregator (or
 * upstream MCP) returning calldata that secretly routes funds to an
 * attacker-controlled chain.
 *
 * Some bridge protocols legitimately settle on an intermediate chain and
 * release on the final chain off-chain (NEAR Intents was the motivating
 * case for ETH→TRON USDT: deposit into a bridge contract on Ethereum,
 * settle off-chain, relayer releases USDT-TRC20 on TRON). For such a route
 * the on-chain `destinationChainId` is a settlement-chain pseudo-id rather
 * than the user's final destination.
 *
 * IMPORTANT (#799): this allowlist is currently EMPTY. The one entry it
 * previously held mapped `bridge:"near"` to the pseudo-id `1885080386571452`
 * on the UNVERIFIED premise that that literal is NEAR's settlement-chain id.
 * It is not attested as such anywhere in this tree (and does not equal this
 * codebase's TRON LiFi id `728126428`), so it was removed — see the array
 * literal below and #237. Adding intermediate-chain support back requires a
 * separately-verified id per the "Adding a new entry" rules below.
 *
 * This module narrows the chainId-mismatch defense to permit ONLY
 * specifically-allowlisted (bridge name, intermediate chain ID) pairs. The
 * receiver-side checks in `verifyLifiBridgeIntent` still apply unchanged
 * (non-EVM sentinel for non-EVM destinations, or matching toAddress for EVM
 * destinations) — this allowlist only relaxes the chainId equality.
 *
 * Tamper resistance
 * -----------------
 * THE LITERAL CHAIN-ID VALUES BELOW ARE A SECURITY ANCHOR. They MUST be:
 *
 *   1. Hardcoded source-code constants — never loaded from env vars,
 *      `userConfig`, MCP tool args, or LiFi response data. All of those
 *      are within the compromised-MCP / hostile-aggregator threat model.
 *      A literal source-code constant is the only tamper-resistant
 *      location: an attacker cannot change it without rebuilding the
 *      binary the user is running, at which point they own everything
 *      anyway.
 *   2. Compared with `===` against an externally-supplied `bigint` —
 *      no arithmetic, no derivation. The decoded value either equals
 *      the literal or it doesn't.
 *   3. Pinned by a unit test (`intermediate-chain-bridges.test.ts`) so
 *      a developer typo / merge mishap that drifts the value is caught
 *      at CI time.
 *
 * Adding a new entry
 * ------------------
 * Adding a bridge to this allowlist materially expands the `prepare_swap`
 * trust surface. Every entry must satisfy:
 *
 *   1. The bridge is a real third-party protocol with a publicly-verifiable
 *      on-chain contract address and protocol docs.
 *   2. The intermediate chain ID is the bridge's canonical settlement
 *      chain ID as encoded by the bridge protocol itself — NOT inferred
 *      from a single LiFi response. Cross-check against the bridge's own
 *      docs and at least one independent route execution.
 *   3. The bridge name string is exactly LiFi's lowercase label for that
 *      tool (verified from a known-good LiFi response, NOT from the
 *      quote we're about to sign).
 *
 * Trust trade-off (consistent with existing non-EVM destinations)
 * ---------------------------------------------------------------
 * When this allowlist matches, we still REQUIRE
 * `receiver === NON_EVM_RECEIVER_SENTINEL` for non-EVM final destinations.
 * The actual destination address lives in the bridge-specific facet data
 * (which we do NOT decode), so we trust the bridge protocol to deliver to
 * the address LiFi packed in there. This is the SAME trust boundary we
 * already accept for ETH→Solana via Wormhole/Mayan and is documented in
 * `SECURITY.md`'s second-LLM verification flow as the user-side defense.
 */

/**
 * Allowlist entry shape. `as const` on the array literal forces the
 * `bridgeName` strings to narrow to literal types so TypeScript catches
 * accidental drift between this table and consumer code that branches on
 * the bridge name.
 */
export interface IntermediateChainBridge {
  /** Exact LiFi `BridgeData.bridge` label, case-insensitive on the wire. */
  readonly bridgeName: string;
  /** Hardcoded LiFi pseudo-chainId for the bridge's settlement chain. */
  readonly intermediateChainId: bigint;
  /** Human-friendly description for diagnostics + receipt text. */
  readonly description: string;
}

export const INTERMEDIATE_CHAIN_BRIDGES: ReadonlyArray<IntermediateChainBridge> = [
  // #799 — the former `{ bridgeName: "near", intermediateChainId:
  // 1885080386571452n }` entry was REMOVED (fail-closed). The literal
  // 1885080386571452 was never a verified NEAR settlement-chain id: it does
  // NOT match this codebase's own TRON LiFi chain id (728126428, see
  // `./lifi.ts`) and there is no captured known-good LiFi response in the
  // tree attesting that a genuine NEAR-Intents route encodes it. #799
  // reports the literal is in fact TRON's on-chain BridgeData id, not
  // NEAR's. Either way the entry relaxed the chainId-mismatch fund-routing
  // defense on an UNVERIFIED value — exactly the failure the "Adding a new
  // entry" rules above (cross-check against the bridge's own docs + at least
  // one independent route execution) exist to prevent, and which this entry
  // never satisfied. Removal is fail-closed and defensible regardless of
  // what the literal actually is.
  //
  // The original goal of this table (#237) must be reopened and closed by a
  // SEPARATELY-VERIFIED id obtained per those rules — NOT by re-adding an
  // unverified literal here. Do NOT re-derive the value from a single live
  // network call in the PR that restores it. Until then this allowlist is
  // intentionally empty and the defense is fail-closed: every
  // `destinationChainId` mismatch is refused.
] as const;

/**
 * Returns the matching allowlist entry when `decoded` corresponds to a
 * known intermediate-chain bridge encoding, null otherwise. The caller
 * must still enforce the receiver-side invariants (non-EVM sentinel for
 * non-EVM final destinations, or matching `toAddress` for EVM final
 * destinations) — this helper ONLY answers "is the destinationChainId
 * mismatch explicable by a known intermediate-chain bridge?".
 */
export function matchIntermediateChainBridge(decoded: {
  bridge: string;
  destinationChainId: bigint;
}): IntermediateChainBridge | null {
  const bridgeLower = decoded.bridge.toLowerCase();
  for (const entry of INTERMEDIATE_CHAIN_BRIDGES) {
    if (
      bridgeLower === entry.bridgeName &&
      decoded.destinationChainId === entry.intermediateChainId
    ) {
      return entry;
    }
  }
  return null;
}
