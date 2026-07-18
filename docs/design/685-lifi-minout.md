# Design: #685 — `prepare_swap` (LiFi) deterministic `CumulativeSlippageTooHigh` revert

Status: VERIFIED DESIGN ARTIFACT (ARCH). DEV implements from this doc, not from the #722 comment.
Scope: fund-path (swap-class prepare-time slippage math). Gated per CLAUDE.md "Per-protocol `prepare_*` cutoff" criterion 1.
Verification base: `bf3d305` (branch `design/685-lifi-minout-ARCH`). No network / no installed `node_modules` available at design time — every claim that rests on live LiFi API behavior is labelled and the design is written safe under the pessimistic assumption (Part 4, Part 6).

---

## 1. Verified premise (what the code actually does)

DEV's #722 claim is **CORRECT in substance, with one citation error**.

- **The MCP forwards LiFi's calldata verbatim and does not own `_minAmountOut`.** `prepareSwap` reads `quote.transactionRequest` and copies `to` / `data` / `value` straight into the returned `UnsignedTx` — `src/modules/swap/index.ts:915-919` (`to: txRequest.to`, `data: txRequest.data as \`0x${string}\``, `value: txRequest.value ? … : "0"`). The `minOut` shown in the receipt (`decoded.args.minOut`, L928) is only `formatUnits(quote.estimate.toAmountMin, …)` — a **display echo of LiFi's own number**, not a value the MCP computes or can re-derive locally. There is no MCP-side min-out arithmetic on the LiFi path to "fix" as the #685 body's option 1 assumes.
  - **Citation correction:** #722 cites `src/index.ts:918`. `src/index.ts:918` is inside the generic `handler()` wrapper (skill-pin plumbing), unrelated to swaps. The real verbatim-passthrough line is **`src/modules/swap/index.ts:918`** (`data: txRequest.data …`). Same line number, different file. The substance holds.
- **How the quote is requested today.** `prepareSwap` builds `lifiReq` (`src/modules/swap/index.ts:714-738`) and calls `fetchQuote` → `getQuote` (`src/modules/swap/lifi.ts:184-194`). The only slippage input is `slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined` (L723). When `undefined`, LiFi's SDK default (0.5%) applies. **No `fee` parameter is passed** anywhere — `createConfig({ integrator: "vaultpilot-mcp" })` (`lifi.ts:9-12`) sets the integrator string only. The 0.25% integrator fee is therefore configured server-side by LiFi for that integrator (or is a LiFi default); it is **not** set or seen by our code except as a line item in `quote.estimate.feeCosts` (already summed by `sumLifiCostsUsd`, `swap/index.ts:234-263`).
- **The patch is irrelevant to the bug.** `patches/@lifi+sdk+3.16.3.patch` only stubs out the Sui re-exports (`Sui = undefined`, `isSui = () => false`) to keep `@mysten/sui` out of the bundle (~25 MB). It does **not** touch quote/fee/slippage logic. It does not affect #685.

**Verdict on the premise:** GROUNDED against primary code. The issue's "derive `_minAmountOut` from the net input" fix (option 1) is architecturally infeasible as stated — we hold no such value. The design must act at the **quote-request layer** (the one lever we own that shapes LiFi's baked min-out), which is exactly what #722 asks ARCH to decide.

---

## 2. Root cause

The revert mechanism, reconstructed from the #685 on-chain decode plus the LiFi Diamond ABI:

- The route (`swapTokensMultipleV3ERC20ToERC20`, selector `0x5fd9ae2e`) is a **GenericSwapFacetV3** entry point (`src/abis/lifi-diamond.ts:24,99`). Its ABI carries a **single top-level `_minAmountOut` (uint256)** after the four common inputs, plus a `_swapData[]` array where each leg has its own `fromAmount` (`lifi-diamond.ts:66-102`). GenericSwapFacetV3 measures the receiving-asset balance delta across all legs and reverts **`CumulativeSlippageTooHigh`** when the received amount `< _minAmountOut`.
- Leg 1 is a **FeeForwarder** (`forwardERC20Fees`, `requiresDeposit:true`) that skims 0.25% (37.5 USDC) off the 15,000 USDC principal **before** the swap. Leg 2 (the real DEX swap) therefore receives only **14,962.5 USDC**.
- The baked `_minAmountOut` decoded from the calldata is **14,985.92 USDT** — sized off the **gross 15,000** notional, not the post-fee 14,962.5. Even at a perfect 1:1 with zero DEX slippage, leg 2 can return at most ~14,962.5 USDT, i.e. **~23.4 USDT below the required min-out**. Unreachable by construction, independent of live price — matching the reporter's observation that the expected output did not move between attempts.
- **Grounding grade:** the *arithmetic* (14,985.92 baked min-out vs 14,962.5 net input) is DECODED from the failed tx's calldata — well-grounded. The error *name* `CumulativeSlippageTooHigh` is INFERRED from GenericSwapFacetV3 semantics (Etherscan shows only generic `execution reverted` because LiFi uses custom errors). The facet-name-to-error mapping is corroborated by the ABI's own source pin (`GenericSwapFacetV3.sol`). Residual: the exact effective-bps figure implied by 14,985.92 (~9 bps off gross) does not fully reconcile with LiFi's 50 bps default, so the precise LiFi-internal min-out formula is not fully pinned — see Part 4 R1/R2. This does not change the fix, which is robust to the internal formula (Part 4).

**One-line cause:** the on-chain min-out LiFi bakes is not loosened enough to absorb a principal skim (the integrator fee) that is deducted before the measured swap leg, so whenever `integratorFee > appliedSlippage` the swap reverts deterministically.

---

## 3. Options evaluated

Judged against: simplicity-first (fewest moving parts on the fund path), no latency regression vs R2 (`prepare_*` p95 ≤ 8 s, ASSUMED/UNMEASURED — ARCHITECTURE §2), and **no change to security posture** (the LiFi §3.4 B5-skip stays exactly as-is; any decode is for min-out correctness only, never a gate).

### Option A — fee-aware quote slippage (RECOMMENDED)

Compute an effective quote slippage that covers the principal-skimming integrator fee and pass it to LiFi's quote request, so LiFi bakes a min-out that is reachable after the skim. The fee magnitude comes from the **structured `quote.estimate.feeCosts`** field (decode-free — the code already sums it), not from decoding calldata.

- Swap-class invariant (Part 5): **MEETS** — the returned min-out accounts for the fee skim while preserving the user's market-slippage tolerance exactly (effective = user + fee).
- Latency: **MEETS** — one *conditional* extra LiFi round-trip, only when a nonzero principal-skimming fee is present; a config-known fee rate collapses it to zero extra round-trips (Part 4 R2, optional). Well inside R2's budget even in the two-round-trip case (one added `getQuote`).
- Security posture: **UNCHANGED** — reads `feeCosts`, sets the `slippage` request param, re-issues a read-only quote. No calldata decode, no `classifyDestination`/B5 change, no new `allowedAbi:null` destination.
- Route-shape robustness: **MEETS** — `feeCosts` is present on every quote regardless of facet (single/multi/native/bridge) and applies even to the 1inch-direct fallback path.

### Option B — decode LiFi Diamond calldata + conditional re-quote (#722 scouting candidate)

Decode `transactionRequest.data` with `lifiDiamondAbi` for the baked `_minAmountOut` and the net DEX-leg `fromAmount`; re-quote with `slippage = feeFraction + userSlippage` only when baked `minOut > net-achievable`.

- Swap-class invariant: **MEETS on the covered route shapes only.**
- Latency: same conditional extra round-trip as A **plus** a local ABI decode (decode itself is cheap).
- Route-shape robustness: **FAILS.** `lifiDiamondAbi` enumerates only the seven generic-swap selectors. The decode does not cover: `swapAndStartBridgeTokensVia*` (source-swap-then-bridge — min-out lives in `BridgeData.minAmount` / facet-specific data, not the generic-swap `_minAmountOut`); any future/unknown facet selector; and the **1inch-direct fallback** (`prepareDirectOneInchSwap`, `swap/index.ts:581`) which has **no LiFi calldata at all**. On an unrecognized route the decode either fails-open (silently skips the fix → re-revert) or fails-closed (refuses a valid swap). Both are worse than A.
- Security posture: UNCHANGED if implemented as min-out-correctness-only — but it introduces a new calldata-inspection surface adjacent to the pre-sign gate, inviting future confusion with a security check (§3.4 warns against exactly this).

### Verdict

**Option A is recommended.** Named criterion: **simplicity-first on the fund path** — A operates entirely on two signals the code already handles (structured `feeCosts` + the `slippage` request param) at the quote-request layer, with **route-shape-agnostic** coverage and **no ABI-decode whose correctness is bounded to enumerated selectors**. It attacks the cause (the baked min-out is a monotonic function of the `slippage` we control) and **degrades safely whether or not LiFi already nets the fee** (Part 4). Option B does strictly more work (bounded-coverage decode + re-quote) for the same outcome and FAILS route-shape robustness — push back on it as added complexity with no compensating benefit.

---

## 4. Recommended design (what DEV implements)

**Fee-aware effective quote slippage on the LiFi path, sourced from structured `feeCosts`, with a mandatory re-quote-and-verify when a principal skim is present.** Implemented in `prepareSwap` (and mirrored in `getSwapQuote` so the preview `toAmountMin` matches what `prepare_swap` will bake).

Step sequence, placed **before** the existing guard/return block so all current guards run on the FINAL quote (see Part 4 residual #5):

1. **First quote (unchanged).** Fetch `quote = await fetchQuote(lifiReq)` with the user's slippage as today.
2. **Compute the principal-skim fraction from structured fields (no decode).** Sum `quote.estimate.feeCosts[]` entries whose fee token is the **source token** (`token.address` equals `fromToken`, or native when `fromToken === "native"`) — these are the skims taken off principal before the swap leg. `feeFraction = Σ(feeAmount) / BigInt(quote.action.fromAmount)`, in the source token's base units. Fees denominated in the output token or gas do **not** skim principal and are excluded.
   - If `feeCosts` yields **no** usable source-token fee (`feeFraction === 0`), the route has no principal skim → **return the first quote unchanged** (zero extra round-trip; e.g. native-in routes, fee-free tools).
3. **Re-quote with fee-covering slippage.** When `feeFraction > 0`, set `effectiveSlippage = userSlippageFraction + feeFraction` (user default 0.5% when `slippageBps` unset) and re-issue `fetchQuote` with `slippage: effectiveSlippage`. Use the second quote for everything downstream.
   - `userSlippageFraction` is `args.slippageBps / 10_000` (or LiFi's 0.5% default) — the market-slippage tolerance. `feeFraction` is the deterministic skim. They are additive because LiFi's baked min-out ≈ `expectedOut × (1 − slippage)`; adding `feeFraction` lowers the min-out by exactly the skim, restoring reachability while leaving the user's market-slippage protection intact on the post-fee output.
4. **Verify reachability on the second quote (fail-closed).** Recompute `feeFraction` on the second quote and assert `appliedSlippage ≥ feeFraction` (i.e. `1 − toAmountMin/toAmount ≥ feeFraction`, computed from the second quote's structured `toAmount`/`toAmountMin`). If it still fails — e.g. the fee grew on the re-route, or LiFi ignored the widened slippage — **refuse with a clear error** ("LiFi min-out remains unreachable after fee-aware re-quote; the integrator fee (X bps) exceeds the achievable tolerance — widen `slippageBps` and retry"), rather than returning calldata that will deterministically revert. This is the falsifier that keeps the fix from silently shipping a still-broken tx.
5. **Ack-gate boundary (do NOT regress).** `assertSlippageOk` (`swap/index.ts:357`) and the >100 bps sandwich-ack gate must keep operating on the **user's market slippage**, NOT on `effectiveSlippage`. The fee pad is a deterministic skim, not sandwich exposure, and must not trip the ack. Concretely: run `assertSlippageOk(args.slippageBps, ack)` on the user value (as today, unchanged) and use `effectiveSlippage` only as the `fetchQuote` argument.
6. **Overflow edge (must handle explicitly).** If `userSlippageFraction + feeFraction` exceeds LiFi's max accepted slippage, do NOT silently clamp below `feeFraction` (that re-reverts). Refuse with the message in step 4. This is an edge only when the user already set slippage near the cap.

Surface, for the receipt: add the applied fee fraction and the fact that slippage was fee-adjusted to `decoded.args` (e.g. `integratorFeeBps`, `effectiveSlippageBps`) so the user sees why the tolerance differs from what they passed. This is display-only; it does not change the signed bytes beyond the corrected min-out.

**Where it lives:** the LiFi-specific quote-request path in `prepareSwap` / `getSwapQuote` (`src/modules/swap/index.ts`) — NOT the shared min-out helper (Part 7). Factor the fee-fraction computation as a small local helper (e.g. `principalSkimFraction(quote, fromToken)`) shared between `prepareSwap` and `getSwapQuote` so preview and prepare stay consistent.

---

## 5. Swap-class invariant it must satisfy

**LiFi-baked min-out reachability under principal skims.** For any `prepare_swap` whose LiFi route skims value off the principal before the measured swap leg (integrator fee, any pre-swap bridge/DEX fee), the prepared transaction's on-chain min-out MUST be reachable at the quote-time rate after all such skims — i.e. the effective slippage requested of LiFi satisfies `effectiveSlippage ≥ Σ(principalSkimFraction) + 0` and the resulting baked min-out cannot deterministically revert on slippage — **while not over-loosening**: the market-slippage give-up beyond the skims stays bounded by the user's requested tolerance (`effectiveSlippage − Σ(skims) = userSlippage`). The tx must neither deterministically revert (min-out too high) nor silently widen MEV exposure beyond `userSlippage + fees-actually-charged` (min-out too low).

Falsifier for the invariant: the acceptance test in Part 6.

---

## 6. Falsifiable acceptance criterion

A unit test (Vitest, mocking `../src/modules/swap/lifi.js`'s `fetchQuote` exactly as `test/swap-evm-to-solana.test.ts` does) reproducing the #685 fee case:

- **Fixture — first quote:** exact-in 15,000 USDC → USDT on Ethereum; `action.fromAmount = "15000000000"` (6 dec), `action.fromToken.decimals = 6`, `estimate.toAmount ≈ "15000000000"`, `estimate.toAmountMin = "14985917974"` (the unreachable baked min-out), and **`estimate.feeCosts = [{ name: "integrator fee", token: { address: <USDC>, decimals: 6, priceUSD: "1" }, amount: "37500000", included: … }]`** (37.5 USDC, 0.25%). `transactionRequest.data` may be any bytes — the test asserts on the recorded `fetchQuote` call args and the returned min-out, not on-chain execution.
- **RED against current code:** current `prepareSwap` calls `fetchQuote` **exactly once** and returns a tx whose min-out (14,985.917974) exceeds net-achievable (`fromAmount − fee = 14,962.5`). Assert the returned `decoded.args.minOut` > 14,962.5 USDT AND `fetchQuote` was called once — both true today, so the test fails (RED) on `main`.
- **GREEN after fix:** `prepareSwap` issues a **second** `fetchQuote` whose `slippage` argument **≥ userSlippageFraction + 0.0025** (the 0.25% fee fraction); the mock's second response carries a reachable baked min-out (≤ 14,962.5 USDT at the mocked rate); and the returned tx's min-out ≤ net-achievable.
- **Single load-bearing assertion (the falsifier):** *whenever `feeCosts` shows a principal-skimming source-token fee, the `slippage` passed to the final LiFi quote ≥ requested user slippage + integrator-fee fraction, and the returned min-out ≤ (fromAmount − fee) × rate.* Mechanically checkable against the recorded mock call args. RED on current code (which never adds the fee fraction and never re-quotes).

Add a companion negative test: `feeCosts = []` (fee-free route) → exactly **one** `fetchQuote` call, slippage unchanged (proves no needless round-trip / no MEV give-up on clean routes).

---

## 7. Interaction with #715 / §5.5 and §3.4

- **#715 / §5.5 (shared min-out helper) — the fix does NOT live there.** ARCHITECTURE §5.5's `modules/shared/slippage.ts` (`applyMinOut` / `applyMaxIn`) de-duplicates the min-out/max-in **formula for paths where the MCP computes the min-out** — the 1inch-direct fallback (`swap/index.ts:635`), uniswap, curve. On the **LiFi aggregator path the min-out is provider-baked**, so there is no local `applyMinOut` call to route through; the #685 fix is a **quote-request slippage** change, a different surface. §5.5's prose frames "#685-class priority-fee/slippage arithmetic" as the recurrence name for the copy-pasted formula — that conflates two distinct bugs sharing one symptom (unreachable min-out): (a) the copy-paste-formula drift §5.5 targets, and (b) the LiFi-baked-min-out skim this doc fixes. **Recommend** (Part 8) a one-line §5.5 clarification distinguishing them; do not block the #685 fix on the §5.5 helper extraction.
- **§3.4 (LiFi Diamond bypasses B5, `allowedAbi:null`) — security posture UNCHANGED.** The fix reads `estimate.feeCosts` and sets the `slippage` request param. It does **not** decode calldata as a gate, does **not** alter `classifyDestination` / B5 / `allowedAbi`, and does **not** add a second `allowedAbi:null` destination. §3.4's exit criterion (`LIFI_DIAMOND` remains the sole `allowedAbi:null` destination) is untouched. Recommended Option A deliberately avoids the calldata-decode that Option B would add precisely because §3.4 flags that surface as the widest hole and warns against growing confusable inspection there.

---

## 8. Normative invariant to lift into ARCHITECTURE.md (recommend — do NOT do here)

Recommend ARCH file a **separate** ARCHITECTURE.md doc PR adding a normative invariant, generalizing beyond LiFi to any provider-baked-min-out aggregator:

> **Provider-baked min-out reachability.** Any aggregator/prepare path where the on-chain min-out is baked by an external provider (not computed by the MCP) MUST request the quote with an effective slippage that covers every principal skim taken before the measured output (integrator/bridge/DEX fees), so the baked min-out is reachable at the quote-time rate, while keeping the market-slippage give-up bounded by the user's requested tolerance. Falsifier: the Part 6 acceptance test (fee-covering re-quote + reachable returned min-out).

Home: alongside §5.5 (min-out slippage math) or as a §7 decision record. This is an ARCH doc-owner action per the setup's no-self-edited-spec rule — recommend, don't apply, in this DEV-facing artifact.

---

## Part 4 — Adversarial self-check (residual risks)

1. **R1 — does LiFi's `slippage` param monotonically lower the baked on-chain `_minAmountOut`?** Load-bearing for Option A. **Corroborated** by (a) the #685 body's own stated workaround ("widen `slippageBps` enough to absorb the fee") — the reporter asserts widening slippage avoids the revert; (b) the code's entire existing design assuming `slippage → toAmountMin`. **NOT independently verified** against the live API (no network at design time). *Safe under the opposite assumption:* step 4's fail-closed reachability re-check on the second quote catches the case where the widened slippage did NOT lower the baked min-out — the tool refuses rather than shipping a reverting tx. So even if R1 is false on some route, the design fails safe (refuse), never ships a deterministic revert.

2. **R2 — is the principal fee always readable from `estimate.feeCosts` with a source-token amount, and is that amount the pre-swap skim?** The local `LifiCostLike` interface (`swap/index.ts:228-232`) types only `amount`/`amountUSD`/`token{decimals,priceUSD}`; the real `@lifi/types` `FeeCost` also carries `token.address`, `name`, `percentage`, and `included`. DEV must confirm those fields against the installed `@lifi/types` (unavailable at design time — `node_modules` not installed). *Safe under the opposite assumption:* if `feeCosts` does not yield a usable source-token principal fee, the design must **not** silently skip (that re-reverts on a hidden skim). Pessimistic fallback DEV must implement: when a route is known to carry a fee (e.g. a FeeForwarder leg is present) but `feeFraction` can't be derived from `feeCosts`, fall back to the fail-closed reachability re-check (step 4) — refuse if the min-out is unreachable. Optionally, DEV may verify `feeCosts` completeness against a one-off decode of the `_swapData[]` `fromAmount` legs during implementation (not in the shipped hot path). The optional zero-round-trip variant (pad the first quote by a config-known fee rate, then verify) is **contingent on PROD confirming the "vaultpilot-mcp" integrator fee rate is a stable constant** — unverified here; default to the data-driven re-quote.

3. **Hidden write paths — none.** The design reads `feeCosts`, sets a request param, and re-issues a read-only `getQuote`. No new mutation, no new signable artifact, no handle-store write. The only signed bytes change is the corrected (lower) min-out inside LiFi's own calldata.

4. **Invariant loss (ack gate).** If DEV naively runs the sandwich-ack gate on `effectiveSlippage` instead of the user's value, the fee pad could trip the >100 bps ack (breaking UX) or, worse, mask a genuinely high user slippage. Design step 5 fixes the boundary: ack gate on user slippage, `effectiveSlippage` only as the quote arg. Reviewer must confirm this split.

5. **Guard ordering.** All existing post-quote guards (`verifyLifiBridgeIntent`, decimals cross-check, exact-in `fromAmount`-drift refusal, >10× sanity) validate `quote`. If DEV places the fee-aware re-quote AFTER those guards, they validate the discarded first quote, not the returned one. Design mandates the re-quote **before** the guard block so guards run on the FINAL quote. Reviewer must confirm placement.

6. **Exact-out (`amountSide:"to"`).** #685 is exact-in. On exact-out, LiFi sizes `fromAmount` to hit `toAmount`; the analogous concern is the approval max-in cover, which the code already pads via `applyMaxIn` (`swap/index.ts:967`). Scope the min-out fix to exact-in. Flag for DEV: confirm the exact-out path's baked min-out (if any) also nets the fee, or that exact-out routes carry no pre-swap principal skim; if they do, extend the same effective-slippage logic.

7. **Cross-chain bridge routes.** The FeeForwarder pattern can also appear on `swapAndStartBridge*` routes; there the reachability bound is `BridgeData.minAmount`, governed by the same `slippage` request param, so Option A's mechanism covers it without a decode. NOT verified that the fee-forwarder sits on the source-swap leg for bridges (no network). The fail-closed re-check (step 4) still applies if `feeCosts` surfaces the skim. Flag for DEV: verify on a live bridge quote; the fix is source-token-fee-driven and route-agnostic by construction, but the reachability check for bridges reads `BridgeData.minAmount` rather than `toAmountMin` and DEV should confirm the structured `toAmountMin` still reflects it.

8. **Over-engineering guard.** Do not add the Option B calldata decode "to be sure." The structured `feeCosts` + fail-closed re-check is sufficient and route-agnostic; a decode only narrows coverage and grows the §3.4-adjacent surface.

**Residual-risk summary:** the design is safe under the pessimistic assumption on both unverifiable external claims (R1: LiFi slippage→min-out monotonicity; R2: `feeCosts` completeness) because step 4's fail-closed reachability re-check refuses rather than ships a deterministic revert. The one thing DEV MUST NOT drop is that fail-closed re-check — without it, an unverified LiFi-internals assumption becomes a silent fund-path revert.
