# Research: generic tx-handling tool vs. per-protocol `prepare_*` for DeFi coverage

**Status:** research note (not code). Closes [#638](https://github.com/szhygulin/vaultpilot-mcp/issues/638).

**Recommendation: (c) hybrid — keep per-protocol `prepare_*` for flows that encode prepare-time invariants, route the long tail through the existing `prepare_custom_call`. No new entry point. No pivot.**

The catalog-growth concern is real but the right lever is conditional tool-surface gating (already shipped via `VAULTPILOT_PROTOCOLS` / `VAULTPILOT_CHAIN_FAMILIES`, [#492](https://github.com/szhygulin/vaultpilot-mcp/pull/492)), not a generic-call pivot.

## Existing scaffolding for the generic path

The "generic transaction-handling tool" the issue proposes already ships:

- **`prepare_custom_call`** ([`src/modules/custom-call/actions.ts`](../src/modules/custom-call/actions.ts), [#494](https://github.com/szhygulin/vaultpilot-mcp/pull/494) / [#497](https://github.com/szhygulin/vaultpilot-mcp/pull/497) / [#498](https://github.com/szhygulin/vaultpilot-mcp/pull/498)): `(wallet, chain, contract, fn, args, value, abi?, acknowledgeNonProtocolTarget: true)`. The literal-true ack is the user's affirmative gate to bypass the canonical-dispatch allowlist.
- **`get_contract_abi`**: Etherscan V2 fetch, 24h cache, refuses on unverified contracts, no raw-bytecode fallback. The verified-or-inline-ABI gate is the integrity anchor for the `fn` → selector mapping.
- **`read_contract`**: view/pure call wrapper for the agent to fetch protocol state when composing the call.

A `prepare_arbitrary_call` would be `prepare_custom_call` renamed. Adding it as a parallel surface duplicates the ack gate, the approve-routing refusal ([#556](https://github.com/szhygulin/vaultpilot-mcp/issues/556)), and the verified-ABI requirement — same code, two names.

## What per-protocol `prepare_*` actually carries

The per-protocol cost is real, but the value isn't "a friendly name in the audit log". Per-protocol tools concentrate invariants at **prepare time** that the generic path cannot enforce:

| Class | Invariant the tool encodes | Generic-path equivalent |
|---|---|---|
| Swaps (`prepare_swap`, `prepare_uniswap_swap`, `prepare_curve_swap`) | Slippage + min-out math; sandwich-MEV hint at 0.5% × notional on Ethereum | Agent computes; no server-side bound |
| Lending supply / borrow / repay (Aave / Compound / Morpho / MarginFi / Kamino) | `isSupplyPaused` / `isBorrowPaused`, supply/borrow caps, min-borrow thresholds, approve+action bundling | Agent fetches; the catch is on the agent |
| Selection-bound flows (Compound Comet per market, Morpho per `marketId`, Solana validator pubkey, MarginFi bank) | Inv #15 durable-binding to a verified candidate | Generic call has no per-protocol bind to verify |
| Approve+action (`prepare_aave_supply`, `prepare_lido_stake`) | Burn-address gate + spender-as-known-protocol label + unlimited-approval refusal | `prepare_custom_call` REFUSES `approve()` outright (#556) — must use dedicated approve tool |
| Token semantics (`prepare_token_send` rebasing flag for stETH / AMPL) | Token-class registry warning (#509) | Agent must know |

Pre-sign defense delta: `assertTransactionSafe` runs 5 blocks against every signing flow. Block 4 (catch-all unknown destination) and block 5 (per-destination ABI-selector check) are the most prepare-shape-aware. Block 4 is bypassed when `acknowledgeNonProtocolTarget: true` flows through; **block 5 is bypassed too** because ack-stamped txs by definition target a non-recognized destination, so the per-destination ABI dispatch table has no entry to check against. Blocks 2 (approve spender allowlist) and 3 (transfer on unknown token) still fire — those are calldata-shape checks, not destination-shape.

Net: a generic-call pivot moves the entire prepare-time invariant surface onto agent-authored script, behind a single `acknowledgeNonProtocolTarget` ack.

## Threat model delta

The trust boundary is correctly identified in the issue: rogue agent already chooses the calldata in either model, and Ledger clear-sign + MCP invariants are the anchor. **But the layers between are not equivalent.**

- **Per-protocol path**: rogue agent that calls the wrong tool (e.g. `prepare_aave_supply` with attacker spender) hits the burn-address gate, the unlimited-approval refusal, the protocol-pause check, the canonical pool address pin (`pinnedAavePool`, NOT resolved via PoolAddressesProvider — defense against hostile RPC). Multiple independent server-side cross-checks fire before the unsigned tx leaves the prepare step.
- **Generic-call path**: rogue agent stamps `acknowledgeNonProtocolTarget: true`, ABI is verified at Etherscan (so the selector-to-fn mapping is honest), but the args are unconstrained. The bytes ship to Ledger blind-sign — no plugin decodes arbitrary calldata — and the user's review-on-device + agent-side independent decode (Inv #1) + swiss-knife URL fallback are the only checks left.

The cooperating-agent threat model is fine on both paths (the agent runs the right invariants). Rogue-MCP threat model is fine on both (the skill's hash recompute + canonical-dispatch allowlist are agent-side). **The narrow-agent-compromise threat model is where they diverge** — per-protocol tools catch wrong-tool calls at prepare time; generic-call defers to in-flight blind-sign review. Issue [#494](https://github.com/szhygulin/vaultpilot-mcp/issues/494) / [#493](https://github.com/szhygulin/vaultpilot-mcp/issues/493) already tracked this gap (the deferred selector classifier on `prepare_custom_call`); pivoting to generic-as-default removes the gap-reduction the per-protocol tools provide elsewhere.

## Comparable systems

- **Safe Apps**: contract-interaction transaction builder is generic-call by design; the audit anchor is the Safe owner's manual review of decoded calldata in the Safe UI. **No AI agent in the loop.**
- **Rabby**: per-protocol decoders for top contracts (Uniswap, Aave, Curve, ...); raw fallback otherwise. Trust anchor is the user reading Rabby's pre-sign view + the device.
- **MetaMask Snaps**: protocol-specific snaps add per-protocol clear-sign; default is raw. Snap distribution is the gating layer.
- **Phantom**: per-protocol clear-sign for SPL Token program + Jupiter; raw for everything else.

The pattern in production: **per-protocol clear-sign for top-N + generic raw for the long tail**, with the user's manual pre-sign review as the trust anchor. None of the consumer wallets ship "agent writes a script per protocol" because they don't have agents — but the structural decision (per-protocol invariants where they exist, generic fallback where they don't) is exactly the hybrid this issue is pushing back against.

## Recommended cutoff rule

Keep a per-protocol `prepare_*` when the tool encodes any of:

1. **Slippage / MEV math** (swap-class)
2. **Protocol-pause / cap / threshold preconditions** (lending-class)
3. **Approve+action bundling** with burn-address + unlimited-approval gates
4. **Durable-binding to a verified candidate** (Inv #15 — validator, market, bank, comet, ATA)
5. **Non-standard token semantics** (rebasing, fee-on-transfer)

Otherwise route the agent to `prepare_custom_call`. The cutoff is **structural**, not popularity-based: a Uniswap V3 collect that doesn't take slippage args could legitimately go generic; a brand-new Layer-N farm that takes a min-out arg should not.

## Cost of the do-nothing path

The `O(N)` complaint resolves at three layers below "more tools":

- **Tool-surface load**: `VAULTPILOT_PROTOCOLS` env var ([#492](https://github.com/szhygulin/vaultpilot-mcp/pull/492)) loads only what the user uses. 60+ `prepare_*` tools today, but a typical install registers a fraction.
- **Tool-description weight**: top offenders ≥ 1000 chars are tracked at `claude-work/plan-tool-description-tightening.md`. Documentation Style discipline cuts the catalog tax without removing surface.
- **Per-protocol invariant cost**: invariants per new tool come from a small set of templates (slippage, approve-bundling, pause-flag, durable-bind). Each new tool pays the template tax once, then composes. The marginal cost is sublinear after the first ~5 tools per protocol family.

Pivoting to generic-call would not reduce the second or third — they live in the agent's reasoning surface and the per-protocol invariant library. It would reduce the first (one tool replaces N) at the cost of every prepare-time invariant the per-protocol tools encode.

## Decision

Do not implement `prepare_arbitrary_call`. Do not pivot the catalog to generic-call as the default. Continue shipping per-protocol `prepare_*` for new protocols that meet the cutoff rule above; route the long tail through `prepare_custom_call` (already shipped). Track the deferred selector classifier on `prepare_custom_call` ([`claude-work/plan-custom-call-selector-classifier.md`](../claude-work/plan-custom-call-selector-classifier.md), in ROADMAP) as defense-in-depth on the existing escape hatch.
