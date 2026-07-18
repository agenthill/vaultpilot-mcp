# Design: #685 — `prepare_swap` (LiFi) deterministic `CumulativeSlippageTooHigh` revert

Status: VERIFIED DESIGN ARTIFACT (ARCH). DEV implements from this doc, not from the #722 comment.
Scope: fund-path (swap-class prepare-time slippage math). Gated per CLAUDE.md "Per-protocol `prepare_*` cutoff" criterion 1.
Verification base: `bf3d305` (branch `design/685-lifi-minout-ARCH`). No network / no installed `node_modules` available at design time — every claim that rests on live LiFi API behavior is labelled and the design is written safe under the pessimistic assumption (Part 4, Part 6).

**Amendment (post-adversarial-review, at `5f7e7c3`).** Two accepted findings folded in: (BLOCKER) the fee-source is RESOLVED as **opaque** — the MCP configures no integrator fee (Part 1), so the fail-closed net no longer derives its threshold **solely** from `feeCosts` (the signal R2 corrupts); a narrow disambiguation decode on the generic-swap class closes the R2-false fail-open (Part 3 Option A, Part 4 steps 2–4, residual R2). (CONCERN) R3 added to the live-verification items: `estimate.toAmountMin` must equal the calldata-baked `_minAmountOut` or the reachability check moves to the decoded value.

**Amendment 2 (Fable-consult-verified rewrite — this revision).** A Claude-Fable-5 consult (audited against the code cited below) found the step-based approach's skim measurement (old §4 steps 2/2b/4) carried two self-consistently-false-passing holes: **"the real DEX leg" is undefined for a multi-leg pipeline** (wrong pick under-counts — a source-token leg reads skim 0, an intermediate-token leg is cross-denominated nonsense), and **`requiresDeposit` is NOT a fee marker** (leg 0 of EVERY route sets `requiresDeposit:true`; #685's own FeeForwarder is leg **1** with `requiresDeposit:true`). Both quotes ran the same broken measurement, so "same feeFraction on both quotes" was necessary but NOT sufficient. This revision rewrites §4 to a **single uniform fail-closed gate `vetLifiQuote`** — the SOLE producer of a shippable quote, running the same classification catch-all and skim measurement on q1 AND q2 — closing the step-2-vs-step-4 drift the adversarial REVIEW's BLOCKER exploited. The fee-leg marker is corrected to `sendingAssetId == receivingAssetId` (pass-through leg); skim measurement becomes a leg-chain-walk with per-pass-through-leg fractions summed; the opportunistic `[BridgeData, SwapData[]]` bridge decode is added as the over-refusal cap (ships in the same PR). All prior-amendment content (fee-OPAQUE finding, R2 resolution, R3 live-check, §3.4-posture-unchanged) is preserved and folded into the gate.

---

## 1. Verified premise (what the code actually does)

DEV's #722 claim is **CORRECT in substance, with one citation error**.

- **The MCP forwards LiFi's calldata verbatim and does not own `_minAmountOut`.** `prepareSwap` reads `quote.transactionRequest` and copies `to` / `data` / `value` straight into the returned `UnsignedTx` — `src/modules/swap/index.ts:915-919` (`to: txRequest.to`, `data: txRequest.data as \`0x${string}\``, `value: txRequest.value ? … : "0"`). The `minOut` shown in the receipt (`decoded.args.minOut`, L928) is only `formatUnits(quote.estimate.toAmountMin, …)` — a **display echo of LiFi's own number**, not a value the MCP computes or can re-derive locally. There is no MCP-side min-out arithmetic on the LiFi path to "fix" as the #685 body's option 1 assumes.
  - **Citation correction:** #722 cites `src/index.ts:918`. `src/index.ts:918` is inside the generic `handler()` wrapper (skill-pin plumbing), unrelated to swaps. The real verbatim-passthrough line is **`src/modules/swap/index.ts:918`** (`data: txRequest.data …`). Same line number, different file. The substance holds.
- **How the quote is requested today.** `prepareSwap` builds `lifiReq` (`src/modules/swap/index.ts:714-738`) and calls `fetchQuote` → `getQuote` (`src/modules/swap/lifi.ts:184-194`). The only slippage input is `slippage: args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined` (L723). When `undefined`, LiFi's SDK default (0.5%) applies. **No `fee` parameter is passed** anywhere — `createConfig({ integrator: "vaultpilot-mcp" })` (`lifi.ts:9-12`) sets the integrator string only. The 0.25% integrator fee is therefore configured server-side by LiFi for that integrator (or is a LiFi default); it is **not** set or seen by our code except as a line item in `quote.estimate.feeCosts` (already summed by `sumLifiCostsUsd`, `swap/index.ts:234-263`).
  - **Fee-source verdict (resolves the adversarial BLOCKER): OPAQUE — not an MCP-owned knowable constant.** Grounded against primary code: `createConfig({ integrator: "vaultpilot-mcp" })` (`swap/lifi.ts:9-13`) passes the integrator **label only** — no `fee` parameter and no `apiKey`; every `getQuote` call in `lifi.ts` passes `fromChain/toChain/fromToken/toToken/amount/fromAddress/slippage/filter-fields` and **no `fee`**; and a grep across `src/modules/swap/` + `src/config/` finds **no** LiFi integrator-fee constant anywhere (the only `apiKey`s in the tree are 1inch/etherscan/reservoir/tron/rpc — none is a LiFi credential). So the MCP calls LiFi unauthenticated and owns no fee rate: the 0.25% skim exists only in the returned `feeCosts`/calldata, and the code cannot re-derive it from a config. The KNOWN-CONSTANT branch (pad the quote by a config-known integrator rate, one round-trip) is therefore **ruled out** — there is no such constant to pad by, and none *should* be invented as a hardcoded literal (it would drift from LiFi's actual per-route fee). Consequence: the design takes the **opaque + fail-closed** path — it must never treat "no fee visible" as "no fee present" without a positive proof (Part 4). Forward note: if an operator ever configures a real LiFi integrator fee (via `createConfig`'s `fee` + a registered `apiKey`/dashboard), *that* rate becomes a single-home constant and the zero-extra-round-trip variant reopens — but that is not today's state.
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

Compute an effective quote slippage that covers the principal-skimming fee and pass it to LiFi's quote request, so LiFi bakes a min-out reachable after the skim. The FIX lever stays the quote-request `slippage` we own — route-agnostic. The skim **magnitude** is now quantified by a **generic-swap calldata leg-walk** (per-pass-through-leg fractions summed off the decoded `_swapData[]`, §4.2), with structured `quote.estimate.feeCosts` as a **corroborating cross-check** (`feeFraction = max(decode, feeCosts)`). It is NOT sized from `feeCosts` alone: because the fee is opaque (Part 1) and `feeCosts` completeness is unverifiable (residual R2), a `feeCosts`-only threshold fails **open** — the adversarial BLOCKER. **The decode is load-bearing for quantification** — it drives how far to widen — but the fix MECHANISM is still the route-agnostic slippage lever; a route the leg-walk / bridge rule cannot classify or quantify fails **closed** (REFUSE at classification, §4.2), never fails open.

- Swap-class invariant (Part 5): **MEETS** — the returned min-out accounts for the fee skim while preserving the user's market-slippage tolerance exactly (effective = user + fee).
- Latency: **MEETS** — one *conditional* extra LiFi round-trip, only when a principal skim is present, plus one local ABI decode (cheap). Fee-free routes (decode-proven) take zero extra round-trips. Well inside R2's budget even in the two-round-trip case (one added `getQuote`). The zero-round-trip config-known-fee variant is ruled out (Part 1 — fee is opaque).
- Security posture: **UNCHANGED** — reads `feeCosts`, adds a read-only skim-detection decode reusing `lifiDiamondAbi` (the same ABI `decodeCalldata` already decodes on the signing path, `src/signing/decode-calldata.ts:545` — no new inspection-surface class), sets the `slippage` request param, and re-issues a read-only quote. The decode is min-out-correctness only, never a gate: no `classifyDestination`/B5 change, no new `allowedAbi:null` destination (§3.4 posture intact).
- Route-shape robustness: **MEETS with an explicit fail-closed boundary** — the `slippage`-widen FIX applies on every facet (single/multi/native/bridge). Skim *quantification* is reliable on the generic-swap class (leg-walk) and on source-swap bridges (the opportunistic `[BridgeData, SwapData[]]` decode, §4.2); where it cannot be quantified the route fails **closed** (REFUSE at classification, §4.2), never fails open. The 1inch-direct fallback is out of scope (computes its own min-out off net `dstAmount`, `swap/index.ts:635` — not subject to this bug).

### Option B — decode LiFi Diamond calldata + conditional re-quote (#722 scouting candidate)

Decode `transactionRequest.data` with `lifiDiamondAbi` for the baked `_minAmountOut` and the net DEX-leg `fromAmount`; re-quote with `slippage = feeFraction + userSlippage` only when baked `minOut > net-achievable`.

- Swap-class invariant: **MEETS on the covered route shapes only.**
- Latency: same conditional extra round-trip as A **plus** a local ABI decode (decode itself is cheap).
- Route-shape robustness: **FAILS.** `lifiDiamondAbi` enumerates only the seven generic-swap selectors. The decode does not cover: `swapAndStartBridgeTokensVia*` (source-swap-then-bridge — min-out lives in `BridgeData.minAmount` / facet-specific data, not the generic-swap `_minAmountOut`); any future/unknown facet selector; and the **1inch-direct fallback** (`prepareDirectOneInchSwap`, `swap/index.ts:581`) which has **no LiFi calldata at all**. On an unrecognized route the decode either fails-open (silently skips the fix → re-revert) or fails-closed (refuses a valid swap). Both are worse than A.
- Security posture: UNCHANGED if implemented as min-out-correctness-only — but it introduces a new calldata-inspection surface adjacent to the pre-sign gate, inviting future confusion with a security check (§3.4 warns against exactly this).

### Verdict

**Option A is recommended.** Named criterion: **the fix lever is the one we own route-agnostically — the quote-request `slippage`** — while a uniform fail-closed gate (`vetLifiQuote`, §4) quantifies the widen and REFUSES any route it cannot classify. A widens `slippage` and re-quotes to correct the baked min-out on the route shapes the gate quantifies (generic-swap via leg-walk; source-swap bridge via the opportunistic `[BridgeData, SwapData[]]` decode) and REFUSES the rest — it never fails open. Both A and B decode calldata, and in A the decode is now **load-bearing for quantification** (it sizes the widen); the distinction from B is that A's fix MECHANISM is still the route-agnostic slippage lever with a fail-closed REFUSE on anything un-enumerated, whereas B makes the decode the SOLE fix (it computes the corrected min-out from calldata) with coverage bounded to the seven generic-swap selectors and **no** fail-closed backstop — so on `swapAndStartBridge*`, unknown facets, and the 1inch-direct fallback (no LiFi calldata at all) B must either fail-open (re-revert) or over-refuse. A's REFUSE-on-unclassifiable posture, plus the opportunistic bridge decode shipped in the same PR to cap over-refusal, dominates B on both correctness and coverage. Push back on B as a bounded-coverage decode made load-bearing for the fix with no fail-closed backstop.

---

## 4. Recommended design (what DEV implements)

**A single uniform fail-closed gate — `vetLifiQuote` — is the SOLE producer of a shippable LiFi quote.** It replaces the earlier step-based sequence (old steps 2/2b/4), whose skim measurement drifted between the first-quote path and the re-quote-verify path: the classification and quantification ran on the first quote, but a thinner check ran on the re-quote, so a skim appearing only on the re-routed quote slipped through — the amendment-2 fail-open the adversarial REVIEW's BLOCKER exploited. The gate closes this **by construction**: the same classification catch-all and the same skim measurement run on EVERY gated quote (q1 AND q2), and `swapTx` is built ONLY from the quote the gate returned.

### 4.1 The gate and its pipeline

```
vetLifiQuote(quote, sourceToken, userSlippage) → SHIP | REQUOTE(feeFraction) | REFUSE
```

Pipeline in `prepareSwap` (mirrored in `getSwapQuote` so the preview `toAmountMin` matches what `prepare_swap` bakes):

1. Fetch `q1 = await fetchQuote(lifiReq)` with the user's slippage as today.
2. `gate(q1)`:
   - `SHIP` → q1 is the final quote.
   - `REQUOTE(f)` → fetch `q2 = fetchQuote(lifiReq with slippage = userSlippage + f)`, then `gate(q2)`: `SHIP` → q2 is the final quote; anything else → **REFUSE**.
   - `REFUSE` → refuse with a clear error (do not return calldata that will deterministically revert).
3. **Exactly one re-quote.** A `REQUOTE` verdict on `q2` never fires a third fetch; a still-unreachable `q2` REFUSES.
4. Build `swapTx` **ONLY** from the gate-returned quote (never a discarded first quote), and place the whole gate **BEFORE** the existing guard block (`swap/index.ts:781–877`) so every current guard (`verifyLifiBridgeIntent`, decimals cross-check, exact-in `fromAmount`-drift refusal, >10× sanity) validates the FINAL quote.

The **classification catch-all (§4.2 step 1) running on q1 AND q2** is the load-bearing property: it is what closes the step-2-vs-step-4 drift the BLOCKER exploited. No path ships a quote the gate did not classify and quantify.

### 4.2 Gate internals

1. **Classify by SELECTOR, never by `to`.** Pinning `to == LIFI_DIAMOND` would breach §3.4 (no new trusted destination), so classification reads the calldata selector:
   - (a) one of the **seven generic-swap selectors** (`lifi-diamond.ts:94–102`) → **leg-walk** (step 2).
   - (b) `tryDecodeLifiBridgeData` succeeds (`decode-calldata.ts:203–231`) → **bridge rule** (step 6).
   - (c) neither → **REFUSE**. An unknown / new LiFi facet selector lands here by construction.
   This catch-all runs on EVERY gated quote (q1 AND q2) — it is what kills the amendment-2 hole.
2. **Leg-walk (generic-swap class).** Normalize `_swapData` to an array (single-* selectors carry one tuple, multi-* an array). Require topology, else **REFUSE** (splits / gaps / incoherent route the gate cannot reason about):
   - `leg[0].sendingAssetId == sourceToken` (native → the zero/native sentinel LiFi encodes in `sendingAssetId`; DEV confirms the exact sentinel),
   - `leg[0].fromAmount == action.fromAmount`,
   - `leg[i+1].sendingAssetId == leg[i].receivingAssetId` for all `i`.
   **Fee-leg marker = `sendingAssetId == receivingAssetId`** — a *pass-through* leg whose token is unchanged can only forward or skim (a DEX / wrap leg always changes the token). Per pass-through leg that has a successor: `f_i = 1 − next.fromAmount / leg_i.fromAmount` (bigint, **ROUNDED UP**); `f_i < 0` → **REFUSE**; a pass-through leg as the LAST leg → **REFUSE** (its skim is unsizeable — no successor to measure against). `feeFraction_decode = Σ f_i` — a provable over-estimate, correctly denominated because each `f_i` is a same-token ratio.
3. **`feeCosts` corroboration.** Sum `feeCosts[]` entries whose `token.address` equals the source token (native when `fromToken === "native"`), over `BigInt(action.fromAmount)`; `feeFraction = max(feeFraction_decode, feeFraction_feeCosts)`, **ROUNDED UP**. Fees denominated in the output token or gas do not skim principal and are excluded. This requires widening the local `LifiCostLike` (`swap/index.ts:228–232`) to carry `token.address` — its absence today is the R2 trigger, and until it is widened this signal cannot even run.
4. **Baked min-out and applied slippage.** The baked min-out is the **DECODED** value — the generic-swap min-out field (`_minAmountOut` on the six V3 selectors, `_minAmount` on the legacy `swapTokensGeneric`) or `BridgeData.minAmount` for a bridge route — **never** `estimate.toAmountMin` until R3 confirms they are equal (the chain reverts against the calldata-baked value, not the structured field). `appliedSlippage = 1 − minOutBaked / estimate.toAmount`, **ROUNDED DOWN**. The **opposed rounding** — `feeFraction` UP, `appliedSlippage` DOWN — makes both err toward REFUSE. This is spec, not accident: float/bigint drift near equality is a classic false-pass.
5. **Decision (generic-swap class).**
   - No pass-through legs **AND** `feeFraction == 0` → **SHIP** (proven clean, zero extra round-trips).
   - Else `appliedSlippage ≥ feeFraction` → **SHIP**. **Reachability, not fee-absence, is the ship criterion**: a first quote whose LiFi-baked min-out already absorbs the skim ships without a re-quote, and this also caps double-widening / MEV give-up when LiFi's `toAmount` is already net-of-fee.
   - Else → **REQUOTE(feeFraction)** if this is q1, **REFUSE** if this is q2.
6. **Bridge rule.**
   - `hasSourceSwaps === true` → **opportunistic positional decode** of `[BridgeData, SwapData[]]` (every `swapAndStartBridgeTokensVia*` facet takes `LibSwap.SwapData[]` as its second argument — DEV MUST verify the layout against `lifinance/contracts`, but it **fails closed** regardless: a wrong layout throws or fails the leg-walk topology → REFUSE). Run the leg-walk (step 2) against `BridgeData.minAmount`; a decode/leg-walk failure with **no** source-token `feeCosts` entry → **REFUSE**. **This opportunistic decode is the over-refusal cap — ship it in the SAME PR** (§ Over-refusal, below).
   - `hasSourceSwaps === false` → assert `minAmount ≤ action.fromAmount` (**REFUSE** if greater); `minAmount == action.fromAmount` → **SHIP**; `minAmount < action.fromAmount` → the difference IS a skim signal → route through the widen path. (Strengthens R4 from "ship blind" to "ship on a calldata arithmetic statement.")
   - `hasSourceSwaps` undefined → already REFUSED at step 1 (calldata classified as neither generic-swap nor bridge).
7. **Unchanged invariants.** Overflow (`userSlippage + feeFraction` over LiFi's max accepted slippage) → **REFUSE**, never clamp below `feeFraction` (that re-reverts). The ack gate — `assertSlippageOk` (`swap/index.ts:357`) plus the >100 bps sandwich-ack — runs on the **USER's** market slippage only, NOT `effectiveSlippage`; the fee pad is a deterministic skim, not sandwich exposure, and must not trip the ack. The receipt discloses `effectiveSlippageBps` / `integratorFeeBps` (display-only; changes no signed bytes beyond the corrected min-out). **Exact-out needs NO carve-out** — the gate never branches on `amountSide`, so it subsumes the old exact-out residual. If the re-quote comes back *cleaner* (`feeFraction₂ < feeFraction₁`), ship and disclose — the over-width is bounded by `feeFraction₁` and the iteration is single.

### 4.3 What is REMOVED from the earlier design, and why it was wrong

- **The "real DEX leg" wording is REMOVED.** "The real DEX leg" is undefined for a multi-leg pipeline, and picking the wrong leg under-counts: a source-token leg reads `skim = 0`, and an intermediate-token leg makes the ratio cross-denominated nonsense. Both quotes would run the same broken measurement and self-consistently false-pass. The leg-chain-walk with per-pass-through-leg fractions summed (§4.2 step 2) replaces it.
- **The `requiresDeposit` fee marker is REMOVED.** `requiresDeposit` is **not** a fee marker: leg 0 of EVERY route sets `requiresDeposit:true` (the facet pulls the user's tokens on the first leg), and #685's own FeeForwarder is leg **1** with `requiresDeposit:true`. The marker fires on every legitimate deposit and does not structurally isolate a skim. The structural marker is `sendingAssetId == receivingAssetId` (token-unchanged pass-through).

### 4.4 §3.4 posture and where it lives

§3.4 posture is **UNCHANGED**: the gate reuses `lifiDiamondAbi` and `tryDecodeLifiBridgeData` (the ABI + parse the signing path already runs, `src/signing/decode-calldata.ts:545`), pins no destination, and touches no `classifyDestination` / B5 / `allowedAbi`. It is min-out-correctness only, never a gate on the pre-sign path.

**Where it lives:** `vetLifiQuote` and its leg-walk helper live on the LiFi quote-request path in `prepareSwap` / `getSwapQuote` (`src/modules/swap/index.ts`) — NOT the shared min-out helper (Part 7). Factor the gate as one function shared by `prepareSwap` and `getSwapQuote` so preview and prepare stay consistent. Widen the local `LifiCostLike` interface (`swap/index.ts:228–232`) with `token.address` first — signal (a) cannot run without it.

---

## 5. Swap-class invariant it must satisfy

**LiFi-baked min-out reachability under principal skims.** For any `prepare_swap` whose LiFi route skims value off the principal before the measured swap leg (integrator fee, any pre-swap bridge/DEX fee), the prepared transaction's on-chain min-out MUST be reachable at the quote-time rate after all such skims — i.e. the effective slippage requested of LiFi satisfies `effectiveSlippage ≥ Σ(principalSkimFraction) + 0` and the resulting baked min-out cannot deterministically revert on slippage — **while not over-loosening**: the market-slippage give-up beyond the skims stays bounded by the user's requested tolerance (`effectiveSlippage − Σ(skims) = userSlippage`). The tx must neither deterministically revert (min-out too high) nor silently widen MEV exposure beyond `userSlippage + fees-actually-charged` (min-out too low).

Falsifier for the invariant: the acceptance test in Part 6.

---

## 6. Falsifiable acceptance criterion

Unit tests (Vitest, mocking `../src/modules/swap/lifi.js`'s `fetchQuote` exactly as `test/swap-evm-to-solana.test.ts` does). The mock records each `fetchQuote` call's args and returns a scripted quote per call, so the tests assert on the recorded call args and the returned min-out, not on-chain execution.

**T1 — #685 fee case (RED on `main`).** First quote: exact-in 15,000 USDC → USDT on Ethereum; `action.fromAmount = "15000000000"` (6 dec), `action.fromToken.decimals = 6`, `estimate.toAmount ≈ "15000000000"`, `estimate.toAmountMin = "14985917974"` (the unreachable baked min-out), `estimate.feeCosts = [{ name: "integrator fee", token: { address: <USDC>, decimals: 6, priceUSD: "1" }, amount: "37500000" }]` (37.5 USDC, 0.25%), and `transactionRequest.data` a generic-swap calldata (`0x5fd9ae2e`) whose `_swapData[]` encodes leg 0 (deposit) plus a FeeForwarder **pass-through leg** (`sendingAssetId == receivingAssetId == USDC`) skimming the input to 14,962.5. **RED:** current `prepareSwap` calls `fetchQuote` **once** and returns `decoded.args.minOut` (14,985.917974) > net-achievable (14,962.5) — assert `> 14,962.5` AND `fetchQuote` called once, both true today. **GREEN after fix:** the gate issues a **second** `fetchQuote` whose `slippage ≥ userSlippage + 0.0025`, and the returned min-out ≤ 14,962.5. **Load-bearing assertion (the falsifier):** whenever the gate quantifies a source-token principal skim, the `slippage` passed to the FINAL LiFi quote ≥ user slippage + the skim fraction, and the returned min-out ≤ `(fromAmount − skim) × rate` — mechanically checkable against the recorded mock call args.

**T2 — decode-proven fee-free (no needless round-trip).** `feeCosts = []` AND a generic-swap calldata whose `_swapData[]` has NO pass-through leg, `leg[0].fromAmount == action.fromAmount`, and a coherent token chain → exactly **one** `fetchQuote` call, slippage unchanged. Proves no MEV give-up on a genuinely clean route and that the fail-closed rule does not over-refuse a proven-clean route.

**T3 — fail-closed (the R2-false case the BLOCKER named).** First quote with `feeCosts = []` (or only output-token/gas entries — so signal (a) `feeFraction` = 0) BUT a generic-swap calldata (`0x5fd9ae2e`) whose `_swapData[]` carries a pass-through fee leg with a real skim (`next.fromAmount < leg.fromAmount`). The gate MUST NOT ship the first quote — it either re-quotes with `slippage ≥ userSlippage + decoded-skim-fraction` and returns a reachable min-out, or REFUSES. **RED on the pre-amendment design** (which shipped the first quote when `feeFraction===0`).

**T4 — multi-leg mis-identification (added per REVIEW).** A generic-swap route with ≥3 legs where the removed "real DEX leg" heuristic would pick the wrong leg and under-count — e.g. `[DEX leg USDC→WETH, pass-through fee leg WETH→WETH, DEX leg WETH→USDT]`. Assert the leg-walk sums the pass-through leg's fraction correctly (`feeFraction` = that skim, denominated in WETH against its own leg's `fromAmount`) and REQUOTEs; assert that the wrong-leg pick (a source-token leg → skim 0, or a cross-denominated ratio) would have shipped an unreachable min-out. This is the test the step-2-vs-step-4 drift and the "real DEX leg" ambiguity fail.

**T5 — undecodable re-quote (added per REVIEW).** q1 classifies as generic-swap with a skim → REQUOTE; the mocked q2 returns calldata that classifies as **neither** generic-swap nor bridge (unknown selector). Assert the gate **REFUSES** — the classification catch-all runs on q2, not only q1, so an unclassifiable re-quote is never shipped. This is the direct regression test for the amendment-2 hole: the catch-all on the re-quote.

**Pre-merge acceptance step — fixture-replay tally.** Before merge, replay representative live-captured quote fixtures — same-chain single, same-chain multi with fee, swap-and-bridge, pure bridge — through `vetLifiQuote` and report the **SHIP / REQUOTE / REFUSE** tally. A REFUSE above the expected near-zero on the same-chain fixtures signals an over-refusal regression (or a missing ABI selector — § Ops note).

---

## 7. Interaction with #715 / §5.5 and §3.4

- **#715 / §5.5 (shared min-out helper) — the fix does NOT live there.** ARCHITECTURE §5.5's `modules/shared/slippage.ts` (`applyMinOut` / `applyMaxIn`) de-duplicates the min-out/max-in **formula for paths where the MCP computes the min-out** — the 1inch-direct fallback (`swap/index.ts:635`), uniswap, curve. On the **LiFi aggregator path the min-out is provider-baked**, so there is no local `applyMinOut` call to route through; the #685 fix is a **quote-request slippage** change, a different surface. §5.5's prose frames "#685-class priority-fee/slippage arithmetic" as the recurrence name for the copy-pasted formula — that conflates two distinct bugs sharing one symptom (unreachable min-out): (a) the copy-paste-formula drift §5.5 targets, and (b) the LiFi-baked-min-out skim this doc fixes. **Recommend** (Part 8) a one-line §5.5 clarification distinguishing them; do not block the #685 fix on the §5.5 helper extraction.
- **§3.4 (LiFi Diamond bypasses B5, `allowedAbi:null`) — security posture UNCHANGED.** The fix reads `estimate.feeCosts`, adds a read-only skim-detection decode (reusing `lifiDiamondAbi` — the same ABI `decodeCalldata` already decodes on the signing path, `src/signing/decode-calldata.ts:545`), and sets the `slippage` request param. The decode is min-out-correctness only: it does **not** act as a gate, does **not** alter `classifyDestination` / B5 / `allowedAbi`, and does **not** add a second `allowedAbi:null` destination. §3.4's exit criterion (`LIFI_DIAMOND` remains the sole `allowedAbi:null` destination) is untouched. Option A's decode is load-bearing for **quantifying** the skim (it sizes the widen), but it is min-out-correctness only — it does NOT become Option B's **fix-decode** (computing the on-chain min-out from calldata) and never a gate. §3.4 flags that surface as the widest hole and warns against growing confusable inspection there, so the decode stays skim-detection only and never becomes a security check.

---

## 8. Normative invariant to lift into ARCHITECTURE.md (recommend — do NOT do here)

Recommend ARCH file a **separate** ARCHITECTURE.md doc PR adding a normative invariant, generalizing beyond LiFi to any provider-baked-min-out aggregator:

> **Provider-baked min-out reachability.** Any aggregator/prepare path where the on-chain min-out is baked by an external provider (not computed by the MCP) MUST request the quote with an effective slippage that covers every principal skim taken before the measured output (integrator/bridge/DEX fees), so the baked min-out is reachable at the quote-time rate, while keeping the market-slippage give-up bounded by the user's requested tolerance. Falsifier: the Part 6 acceptance test (fee-covering re-quote + reachable returned min-out).

Home: alongside §5.5 (min-out slippage math) or as a §7 decision record. This is an ARCH doc-owner action per the setup's no-self-edited-spec rule — recommend, don't apply, in this DEV-facing artifact.

---

## Part 4 — Adversarial self-check (residual risks)

The single uniform gate kills the drift-class fail-open **by construction** — the same classification catch-all and the same skim measurement run on q1 AND q2, and `swapTx` is built only from the gate-returned quote. What remains are proof-limits requiring DEV live-verification, not structural holes. Every one fails toward REFUSE, never toward shipping a revert.

**R1 — does LiFi's `slippage` param monotonically lower the baked on-chain min-out? (DEV live-verify; load-bearing for the fix.)** Corroborated by the #685 body's own workaround ("widen `slippageBps` enough to absorb the fee") and by the code's existing `slippage → toAmountMin` assumption, but NOT independently verified against the live API. **Safe under the opposite assumption:** the gate re-runs on q2 and asserts `appliedSlippage ≥ feeFraction` against the DECODED baked min-out — if the widened slippage did not lower it, the gate REFUSES rather than shipping a revert. Keep as a live check.

**R2 — RESOLVED into the gate (was the adversarial BLOCKER).** The original design derived the fail-closed threshold **solely** from `estimate.feeCosts`, whose completeness R2 doubts; an omitted source-token skim gave `feeFraction=0` → fail-OPEN ship of the #685 revert. Grounded trigger: `LifiCostLike` (`swap/index.ts:228-232`) has **no `token.address`**, so source-token matching cannot even run until DEV widens the type. **Resolution:** the leg-walk decode is now the RELIABLE skim source and `feeCosts` is demoted to a cross-check (`feeFraction = max(decode, feeCosts)`, §4.2 step 3); a route whose skim cannot be quantified REFUSES. DEV still confirms the real `@lifi/types` `FeeCost` fields against the installed package, but correctness no longer DEPENDS on `feeCosts` completeness.

**R3 — is `estimate.toAmountMin` the value that drives the on-chain revert? (DEV live-verify; blocking for the generic-swap class.)** The chain reverts against the calldata-baked min-out (`_minAmountOut`/`_minAmount` for generic-swap, `BridgeData.minAmount` for bridge), not the structured `toAmountMin`. The gate reads the **DECODED** baked value (§4.2 step 4), so it is correct even if the two diverge; R3 is the check that would let a later optimization trust `toAmountMin`. On a real fee-bearing quote, decode `transactionRequest.data` and assert the decoded baked min-out equals `estimate.toAmountMin`. Until confirmed, the gate stays on the decoded value.

**R4 (narrowed) — `hasSourceSwaps === false → SHIP` now also requires `minAmount == action.fromAmount`.** The bridge rule (§4.2 step 6) no longer ships blind: it asserts `minAmount ≤ action.fromAmount` and ships only on equality (a `minAmount < fromAmount` diff is treated as a skim signal → widen path). This strengthens R4 from "ship blind" to "ship on a calldata arithmetic statement," but still rests on contract behavior — keep the DEV live-check that a `hasSourceSwaps === false` route carries no source-side principal skim. Bounded to bridge routes; failure mode is the same deterministic revert as #685 (gas-only, disclosed), never unrecoverable loss.

**R5 (restated tighter) — the linchpin is "every principal skim is visible as an amount discontinuity in the encoded `_swapData[]` OR a source-token `feeCosts` entry."** A skim hidden inside a token-CHANGING executor step, with downstream `fromAmount`s encoded as if no skim occurred, is invisible in calldata by construction — no local check closes this, for anyone. #685's own decode (leg 2 encoded at exactly 14,962.5 = post-skim) shows LiFi DOES encode skims visibly. **DEV falsifier:** on real fee-bearing quotes, assert the decoded skim ≥ the `feeCosts` skim and that the arithmetic reconciles with the baked min-out.

**Exact-out — subsumed, no carve-out.** The gate never branches on `amountSide`, so exact-out routes flow through the same classification + leg-walk + reachability check. The old exact-out residual (scope the fix to exact-in, flag exact-out separately) is removed. The approval max-in cover (`applyMaxIn`, `swap/index.ts:967`) is unchanged and orthogonal.

**1inch-direct — verified OUT OF SCOPE.** `prepareDirectOneInchSwap` derives its own min-out from the net quoted `dstAmount`; `/swap` sets only `src`/`dst`/`amount`/`from`/`slippage` (`oneinch.ts:95-103`) with no fee/referrer parameter, so it is not subject to the provider-baked-off-gross bug and never reaches the gate.

**Opportunistic bridge decode — availability only, fails closed.** The `[BridgeData, SwapData[]]` positional decode assumes every `swapAndStartBridgeTokensVia*` facet takes `LibSwap.SwapData[]` as its second argument. If that layout is wrong on some facet, the decode throws or fails the leg-walk topology → REFUSE (a coverage / over-refusal loss, never a fail-open). DEV verifies the layout against `lifinance/contracts`; a mismatch narrows coverage, it does not open a hole.

**Preserved design constraints (now gate steps, not residuals).** Hidden write paths: none — the gate reads `feeCosts`, decodes calldata read-only (the same parse `decodeCalldata` runs on the signing path, `src/signing/decode-calldata.ts:545`), sets a request param, and re-issues a read-only `getQuote`; the only signed-bytes change is the corrected min-out. Ack-gate split (§4.2 step 7) and guard ordering (§4.1 step 4) are folded into the gate — reviewer confirms both.

**Residual-risk summary.** The drift-class fail-open is closed by construction (uniform gate, catch-all on q1 AND q2). R1/R3/R4/R5 are DEV live-verify mandates, not structural holes — each fails toward REFUSE. The things DEV MUST NOT drop: (a) the classification catch-all on BOTH gated quotes; (b) the `sendingAssetId == receivingAssetId` fee-leg marker (NOT `requiresDeposit`); (c) the opposed rounding (feeFraction UP, appliedSlippage DOWN) and the DECODED baked min-out; (d) the opportunistic bridge decode shipped in the SAME PR; (e) the ack-gate-on-user-slippage split; (f) the R1/R3/R4/R5 live checks.

## Over-refusal (bounded) and ops note

- **Same-chain EVM (the dominant #685 class):** near-zero refusal.
- **Cross-chain with source swaps (the big exposure):** WITHOUT the opportunistic `[BridgeData, SwapData[]]` decode, every such route whose fee is not in `feeCosts` REFUSES (a large share). WITH it, coverage matches same-chain. **Ship the opportunistic decode in the same PR.**
- **Ops note (standing risk).** If LiFi ships a new `GenericSwapFacetV4` / new generic-swap selectors, EVERY same-chain swap REFUSES until `lifiDiamondAbi` (`src/abis/lifi-diamond.ts`) is extended with the new selectors. This is the acceptable REFUSE-worst-case, but the PR MUST carry this ops note so the failure is recognized fast — a sudden same-chain REFUSE spike means a missing selector, not an attack.

## Cross-chain siblings — out of scope, filed separately

`src/modules/{tron,solana,btc}/lifi-swap.ts` all forward LiFi `transactionRequest` artifacts **VERBATIM** under the same `vaultpilot-mcp` integrator with NO reachability proof — the SAME #685 bug class. Solana's `VersionedTransaction` and BTC's PSBT cannot run this EVM leg-walk gate at all, so a separate mechanism is needed there; whether the skim actually fires on those paths is unverifiable without live quotes. Tracked as a follow-up issue filed alongside this PR — **NOT blocking #685** (tracking issue filed alongside this PR).

## Evidence that would change the verdict

1. A live generic-swap quote whose downstream `fromAmount`s do NOT reflect a fee that `feeCosts` also omits → breaks R5 → false-pass.
2. A `hasSourceSwaps === false` route carrying a source-side skim → R4 SHIP should have REFUSED.
3. A `swapAndStartBridgeTokensVia*` facet whose 2nd arg ≠ `SwapData[]` → kills the opportunistic decode (availability only — still fails closed).
4. R1 false → the gate still refuses correctly, but the FIX stops fixing (remedy is outside this design).
5. LiFi returning non-Diamond, non-decodable calldata on common EVM routes → REFUSE at classification; if frequent, a product decision.
