/**
 * Cross-DEX preflight helpers shared across Uniswap V3, Curve, and
 * Balancer LP builders. Mirrors the role of `src/modules/shared/approval.ts`
 * — one place for invariants every protocol consumer needs, so future
 * tightening (e.g. raising the slippage soft-cap, adding a new ack flag)
 * happens in one diff rather than fanning out.
 *
 * Currently houses just `parseSlippageBps`. The plan
 * (`claude-work/plan-dex-liquidity-provision.md`) names two more helpers
 * for this module — `assertLpPoolReadable` and `assertPoolNotPaused` —
 * but both require protocol-specific dispatch that has no consumers
 * yet. They land in their respective protocol-phase PRs alongside the
 * pool-type knowledge they depend on.
 */

/**
 * Resolve and validate an LP slippage tolerance. Mirrors the swap
 * module's `assertSlippageOk` pattern at `src/modules/swap/index.ts:315`:
 *
 *   - Hard ceiling at 500 bps (5%). Anything above this is rejected
 *     unconditionally — there is no production scenario where a 5%+
 *     slippage on an LP deposit is benign rather than a misconfiguration.
 *   - Soft cap at 100 bps (1%). Above this requires the caller to set
 *     `acknowledgeHighSlippage: true`. MEV sandwich bots target wide-
 *     slippage txs, so every unnecessary basis point is paid straight
 *     to a searcher; the ack flag forces the agent to surface the
 *     trade-off to the user before signing.
 *   - Default 50 bps (0.5%) when omitted, matching LiFi's default for
 *     swaps and the mainstream Uniswap UI default.
 *
 * Callers can override the default via `defaultBps` if their protocol
 * has a different convention (e.g. a stableswap pool where 0.1% would
 * be tighter than the deposit-rounding noise).
 */
export function parseSlippageBps({
  slippageBps,
  acknowledgeHighSlippage,
  defaultBps,
}: {
  slippageBps: number | undefined;
  acknowledgeHighSlippage: boolean | undefined;
  defaultBps?: number;
}): number {
  const bps = slippageBps ?? defaultBps ?? 50;
  if (!Number.isInteger(bps) || bps < 0) {
    throw new Error(
      `slippageBps must be a non-negative integer (got ${bps}). ` +
        `Pass e.g. 50 for 0.5%.`,
    );
  }
  if (bps > 500) {
    throw new Error(
      `slippageBps ${bps} exceeds the 500 bps (5%) ceiling. ` +
        `Higher slippage masks bad fills; refusing as a safety check.`,
    );
  }
  if (bps > 100 && !acknowledgeHighSlippage) {
    throw new Error(
      `Requested slippage is ${bps} bps (${(bps / 100).toFixed(2)}%). ` +
        `The default cap is 100 bps (1%) because higher values are almost ` +
        `always sandwich-bait misconfigurations. If a thin-liquidity LP ` +
        `genuinely needs this, retry with \`acknowledgeHighSlippage: true\` ` +
        `and confirm with the user first.`,
    );
  }
  return bps;
}
