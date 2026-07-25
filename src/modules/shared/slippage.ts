/**
 * The two slippage bounds every swap preparer needs, defined exactly once.
 *
 * Both were copy-pasted across `uniswap-swap/`, `curve/`, `swap/` and
 * `tron/` (issue #715, ARCHITECTURE.md §5.5). That duplication is the
 * recurrence surface for the #685-class arithmetic bug: a fix applied to one
 * copy silently leaves the others wrong, and each copy sizes a fund-safety
 * bound baked into calldata the user signs. One definition, imported
 * everywhere, is the whole point of this file — do not re-inline either
 * formula at a call site.
 *
 * Rounding is deliberately asymmetric and always against the caller:
 *   - the floor truncates DOWN (BigInt division), so the user is never
 *     promised more output than the bound guarantees;
 *   - the ceiling adds `9_999n` before dividing to round UP, so an approval
 *     or spend cap is never one wei short of what the router will pull.
 *
 * Precondition (caller-owned, unchanged by this refactor): `slippageBps` is
 * a non-negative integer well under 10_000. Every call site already runs a
 * dedicated gate before reaching here — `assertSlippageOk` (`swap/`, reused
 * by `uniswap-swap/`), Curve's inline bps cap, and LiFi's
 * `MAX_EFFECTIVE_SLIPPAGE`. These helpers deliberately add no second gate:
 * they are pure arithmetic, byte-identical to the call-site code they
 * replace, so the consolidation changes no user-visible behaviour.
 */

/**
 * Exact-IN min-out FLOOR: the least output the caller will accept for a
 * known input. Rounds DOWN.
 */
export function applyMinOut(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

/**
 * Exact-OUT max-in CEILING: the most input the caller will spend for a known
 * output. Rounds UP so we approve/spend enough to cover the worst-case
 * in-amount.
 */
export function applyMaxIn(quotedIn: bigint, slippageBps: number): bigint {
  return (quotedIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}
