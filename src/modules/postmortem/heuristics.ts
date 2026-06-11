/**
 * Post-mortem heuristics — "why might this surprise you?".
 *
 * Each rule looks at the populated `ExplainTxResult` and pushes a
 * heuristic entry when its condition matches. Rules are intentionally
 * simple and high-precision; the bar for surfacing one is "would the
 * user benefit from being told this?".
 *
 * Rules in v1:
 *   - `failed`: tx reverted on-chain.
 *   - `unlimited_approval`: any approval set MAX_UINT256 (or near it).
 *   - `dust_transfer`: outflow valueUsd < $0.01 — possible address
 *     poisoning bait (same family as #220).
 *   - `transfer_to_zero`: a Transfer event went to the zero address
 *     (token burn).
 *   - `high_gas`: fee USD > 10% of the largest absolute-USD balance
 *     change.
 *   - `no_state_change`: success status but zero state changes
 *     (suspicious noop or wallet probe).
 */

import type {
  ExplainTxApprovalChange,
  ExplainTxBalanceChange,
  ExplainTxHeuristic,
  ExplainTxResult,
  ExplainTxStep,
} from "./schemas.js";

const ZERO_ADDRESS_HEX = "0x0000000000000000000000000000000000000000";
/** TRON's hex-form null address — `41` prefix + 40 zeros. */
const ZERO_ADDRESS_TRON_HEX = "410000000000000000000000000000000000000000";

export function applyHeuristics(
  result: Omit<ExplainTxResult, "narrative" | "heuristics"> & {
    heuristics?: ExplainTxHeuristic[];
  },
): ExplainTxHeuristic[] {
  const out: ExplainTxHeuristic[] = [];

  if (result.status === "failed") {
    out.push({
      rule: "failed",
      message: `Tx REVERTED on ${result.chain}. The fee was paid (${result.feeNative ?? "?"} ${result.feeNativeSymbol ?? ""}) but no state changes took effect.`,
    });
    // The other heuristics are noisy on failed txs (e.g. "no_state_change"
    // would fire trivially); short-circuit here.
    return out;
  }

  for (const a of result.approvalChanges) {
    if (a.isUnlimited) {
      out.push({
        rule: "unlimited_approval",
        message: `Unlimited allowance granted to ${a.spender} on ${a.symbol ?? "token " + a.token.slice(0, 10)}. The spender can move any amount of this token from your wallet at any time. Revoke with a follow-up approve(0) call when no longer needed.`,
      });
    }
  }

  // Sum all USD outflows from balance changes for the dust + high-gas
  // tests. Outflow = negative delta from perspective.
  let largestAbsValueUsd = 0;
  for (const b of result.balanceChanges) {
    if (typeof b.valueUsd === "number") {
      const abs = Math.abs(b.valueUsd);
      if (abs > largestAbsValueUsd) largestAbsValueUsd = abs;
    }
    // Dust outflow rule.
    if (typeof b.valueUsd === "number" && b.deltaApprox < 0) {
      const absUsd = Math.abs(b.valueUsd);
      if (absUsd > 0 && absUsd < 0.01) {
        out.push({
          rule: "dust_transfer",
          message: `Dust outflow: ${b.delta} ${b.symbol} (~${b.valueUsd.toFixed(4)} USD). Sub-cent transfers can be address-poisoning bait — verify the recipient was intended.`,
        });
      }
    }
  }

  // Transfer-to-zero rule: walk the steps for an event to the zero
  // address (any chain).
  for (const s of result.steps) {
    if (s.kind !== "event") continue;
    const lower = s.detail.toLowerCase();
    if (
      lower.includes(ZERO_ADDRESS_HEX) ||
      lower.includes(ZERO_ADDRESS_TRON_HEX) ||
      lower.includes("11111111111111111111111111111111") // System program / Solana null
    ) {
      out.push({
        rule: "transfer_to_zero",
        message: `Token transfer to the zero address detected: "${s.detail}". This is typically a burn (the tokens are now unspendable). Verify it was intentional.`,
      });
      break; // one mention is enough
    }
  }

  // High-gas rule: fee USD > 10% of the largest absolute-USD balance
  // change. Skips when no fee USD or no priced changes.
  if (
    typeof result.feeUsd === "number" &&
    largestAbsValueUsd > 0 &&
    result.feeUsd > largestAbsValueUsd * 0.1
  ) {
    const pct = ((result.feeUsd / largestAbsValueUsd) * 100).toFixed(1);
    out.push({
      rule: "high_gas",
      message: `Fee was ${result.feeUsd.toFixed(2)} USD — ${pct}% of the largest balance change (${largestAbsValueUsd.toFixed(2)} USD). Either congestion was high or the routing was inefficient.`,
    });
  }

  // No-state-change rule: success but no balance changes AND no
  // approval changes AND no event steps.
  const hasEvents = result.steps.some((s) => s.kind === "event");
  if (
    result.status === "success" &&
    result.balanceChanges.length === 0 &&
    result.approvalChanges.length === 0 &&
    !hasEvents
  ) {
    out.push({
      rule: "no_state_change",
      message: `Tx succeeded but produced no observable state change for the wallet. Possible noop, wallet-probe, or a write that was bypassed by a contract guard. Check the contract's source for fall-through paths.`,
    });
  }

  return out;
}

// Re-export shapes the helper consumes — keeps callers' import lists short.
export type {
  ExplainTxApprovalChange,
  ExplainTxBalanceChange,
  ExplainTxHeuristic,
  ExplainTxStep,
};
