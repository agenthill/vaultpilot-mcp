# Design: #759 — recipient/authority authorization seam at pre-sign

Status: ARCH-CONVERGED DESIGN ARTIFACT — awaits SEC + REVIEW verdict before DEV implements. Not yet a verified design (that gate has not run); this is the converged proposal the verdict is taken against.
Scope: fund-path (EVM pre-sign gate). Closes the #757/#760 incident class.
Evidence base: recon @ `origin/main` `32e001b`, cross-checked through two adversarial review rounds against `main` `c1b373a`. `src/signing/pre-sign-check.ts` is unchanged across that range (still 404 lines; every cited line below was re-checked live and matches). `src/modules/execution/index.ts` is **not** stable — the ARCHITECTURE.md §5.2 decomposition (#720, PR #758) landed after this design's evidence base and shrank it from 4013 to 2805 lines, moving `runEvmPreSignGuards`/`previewSend`/`sendTransaction` to new line numbers (currently ~1819/1896/2165). Every `execution/index.ts` citation below is an **evidence pointer against the recon commit, not a normative anchor** (same convention as ARCHITECTURE.md §3's own header) — DEV re-resolves each named symbol against current `HEAD` before implementing; the symbol names, not the line numbers, are load-bearing.

---

## 1. Problem & threat model

**Threat actor.** A rogue or prompt-injected agent — in-model for this repo, which treats all agent-supplied input (tool arguments, `prepare_*` call shape, even which tool is called) as attacker-influenced. No user social-engineering is assumed beyond the user's ordinary Ledger confirm; the device screen is the only thing the threat model treats as trustworthy, and only for what it actually renders.

**The structural gap.** `assertTransactionSafe`'s block 5 (`src/signing/pre-sign-check.ts:338-403`) validates **which function is being called** — the 4-byte selector must belong to the destination's curated ABI — and never validates **where the value or authority goes**. For any recognized destination (`classifyDestination` returns non-null), block 4's argument-agnostic catch-all (`if (!dest)`, `pre-sign-check.ts:336`) is skipped entirely, because it only fires on *unrecognized* destinations. Block 5 then passes any selector on the ABI with no `decodeFunctionData`, no argument read, on the recognized-destination path. The result inverts the intended security model: being on the protocol allowlist makes a recipient-bearing call **more** likely to reach signature than an unrecognized one, not less — an unknown destination is refused unless acked; a recognized one with a free `to`/`receiver`/`owner` argument is not gated at all.

**Asset at risk.** Whatever the recognized protocol call moves: Aave collateral (`withdraw.to`), Morpho supplied/borrowed assets (`withdraw`/`borrow`/`withdrawCollateral.receiver`), Uniswap LP/swap output (`mint`/`collect`/`exactInput*`/`exactOutput*.recipient`), Lido withdrawal NFTs (`requestWithdrawals.owner`), Permit2-authorized third-party token balances (`transferFrom.to`), ERC-4626 vault shares/assets (`deposit`/`mint`/`withdraw`/`redeem.receiver`), and self-funded credit positions (Aave `supply.onBehalfOf`, Morpho `supply`/`supplyCollateral.onBehalf`). No acknowledgement flag anywhere in the chain is load-bearing against this — the schema-required `acknowledgeNonProtocolTarget: true` literal cannot distinguish a benign call from a drain because every call sets it, and per block 4's skip, the pre-sign layer does not even consult it on this path.

---

## 2. The failure class — one substrate, four incidents

This is not a new bug class; it is the fourth occurrence of the same substrate defect surfacing in a different corner of the recognized-destination surface:

- **#711** (closed → PR #727) — `applyCustomCallClassifier`'s `transferFrom` ack-bypass checked only `args[0]` (the `from`); the recipient `args[1]` (`to`) was never inspected, so an ack-stamped `transferFrom(from=X≠wallet, to=ATTACKER)` rode through unchecked.
- **#737** (sibling, found at #727's review) — the *same* classifier's `transfer(address to, uint256)` path, which moves the **wallet's own** tokens, could still be ack-bypassed to an arbitrary recipient.
- **#741** (untracked sibling, found by REVIEW's post-merge sweep) — ERC-777 `operatorSend(address,address,uint256,bytes,bytes)` has identical drain semantics to `transferFrom` and was outside the classifier's ruleset entirely.
- **#757 / #760** (this design's trigger, found by SEC's 28-agent adversarial fan-out while adjudicating #737) — the same substrate, one layer up: it is not the `custom_call` classifier that misses the recipient, it is `assertTransactionSafe` block 5 itself, for **every** recognized protocol destination, not just `custom_call`-reachable selectors. #757 is selector-membership-without-argument-check; #760 (LiFi Diamond, `allowedAbi: null`) is the same gap with no selector check at all.

The recurring pattern across all four: a gate keys on **which selector/rule matched**, and treats "selector recognized" as suflicient without ever decoding **which argument carries the recipient**. #759 is ARCH's design to close this at its true locus — the pre-sign argument level — rather than patching the next selector that surfaces it.

---

## 3. Design

The core idea — argument-level recipient/authority authorization at the pre-sign chokepoint — survived both review rounds unchanged. The *mechanism* was rebuilt twice: v1 was an inclusion map (fails open on any selector not on the map, reproducing #757 in miniature); v2 inverted to a fail-closed exemption model; v3 folds round-2's one new blocker (the contact predicate) plus mechanical residuals. What follows is v2 with all v3 deltas applied, as one design — not a base plus a changelog.

### D1 — Locus: `runEvmPreSignGuards`, after a fail-closed device-account match

The check does **not** live inside `assertTransactionSafe`. That function receives only `tx.from`, which is agent-supplied (`buildCustomCall` sets `from: p.wallet`, and `p.wallet` is `args.wallet` off the tool call — nothing pins it to the connected device before `assertTransactionSafe` runs). Resolving a recipient against `tx.from` at that point is resolving against a value the attacker also controls: set `wallet = to = ATTACKER`, Ledger still signs from the real victim account, and `recipient === tx.from` passes.

The check instead runs in `runEvmPreSignGuards` (`execution/index.ts`, evidence-pointer L1819 at recon), **after** the existing device-account match (evidence-pointer L3050-3059 in the recon commit — re-resolve by reading the account-match call site relative to `runEvmPreSignGuards`'s own body post-decomposition). At that point `tx.from` has been validated `== connected device account`, so comparing a decoded recipient to `tx.from` is sound.

**Precondition — the account-match itself must be fail-closed.** Today it fail-opens when `getConnectedAccounts()` returns an empty array (no paired session) — a real-signing path with no verified device set must **refuse**, not silently skip the comparison and fall through to an unvalidated `tx.from`. Demo mode (simulated, no real signature ever produced) is exempt from this precondition.

**Ack-independence, not code-ordering, is the bypass-proof.** The recipient check's non-bypassability comes from the check being **structurally independent of the ack flags** — it never reads `acknowledgedNonProtocolTarget`, `safeTxOrigin`, or `acknowledgedNonAllowlistedSpender` — not from running after `pre-sign-check.ts:336` in source order (it runs in a different function, `runEvmPreSignGuards`, not `assertTransactionSafe`). Falsifier: an ack-stamped call to a recognized destination with an unauthorized recipient must still REFUSE.

**Enforcement point.** `runEvmPreSignGuards` is invoked only from `previewSend`; `sendTransaction` never re-runs it, inheriting the guard only through the mandatory-preview gas-pin + `previewToken` binding (ARCHITECTURE.md §3.3). Soundness of that inheritance depends on the preview→send binding being tamper-proof end to end — see §5 below (freeze dependency).

**Export requirement.** `classifyDestination` is currently module-private to `pre-sign-check.ts` (defined at line 105). It must be exported (or its recipient-relevant logic re-derived) so `runEvmPreSignGuards` can classify the destination independently. `dest === null` (unrecognized) defers entirely to D9 — no hard gate; an ack-stamped unknown-destination call escapes this seam by design, unchanged from today.

### D2 — Fail-closed authorization gate over every address-typed argument

Replaces v1's inclusion map. For every recognized-destination selector that passes block 5, decode the call and enumerate **every address-typed argument path**, including nested tuples and arrays-of-tuples (e.g. Uniswap's `ExactInputSingleParams.recipient`, Morpho's `MarketParams` tuple, Permit2's `AllowanceTransferDetails[]`). Each such address must fall into exactly one of four buckets:

1. **NON_RECIPIENT_ALLOWLIST** — an explicit, curated exemption: venue/token/pool/oracle/irm/referral arguments known by construction not to be a value or authority destination (e.g. Aave `repay`/`borrow.onBehalfOf` when a caller sets it, Lido `submit.referral`, EigenLayer `depositIntoStrategy`, every Morpho `marketParams.{loanToken, collateralToken, oracle, irm}`).
2. **Wallet-or-signed-contact (D4)** — resolves to the connected device wallet or a device-signed saved contact — the authorization policy for value/beneficiary recipients.
3. **Authority designation (D6)** — an authorization-conferring argument (spender/operator), handled by the unified authority policy, not the recipient policy.
4. **USER_DIRECTED_RECIPIENT** — a new, fourth bucket (below) for arguments the tool's whole purpose is to route to an address the *user*, not the protocol, names — pass-through at this gate, governed by the existing resolver+device-display defense instead.

**Any address argument that does not classify into one of these four buckets → REFUSE.** Adding a new ABI thus fails toward a human-clearable refusal, never a silent drain — the opposite failure mode from v1's inclusion map and from #757 itself.

**The fourth bucket, and why it must exist (reconciling D2 with D3).** `erc20Abi.transfer.to` (and the stETH/WETH9 `transfer` unions) is a user-directed recipient by the tool's own design — `prepare_token_send` exists precisely to let the user name a fresh address, and that flow is governed by `resolveRecipient` labeling plus the on-device address render (§D3), not a pre-sign hard refusal. Without a fourth bucket, `transfer.to` fits none of buckets 1-3: bucketing it as a recipient (2) reopens the over-block this design deliberately removes (§D3); leaving it unbucketed fails the anti-rot enumerator below, which throws on any unclassified path. The fourth bucket is what lets the module-load enumerator pass while runtime still treats `transfer.to` as PASS, defended by the resolver/device-render layer — D2 and D3 are explicitly reconciled on this argument, not left in tension.

### D2-rot — Module-load anti-rot enumeration (the completeness mechanism)

A hand-seeded classification map rots the moment a new ABI or a new selector on an existing ABI is recognized without a matching entry — exactly the #757 failure mode, recreated one layer down. The anti-rot mechanism: **at module load**, recursively enumerate every address-typed argument path across every recognized ABI and assert each path is a member of `NON_RECIPIENT_ALLOWLIST ∪ RECIPIENT_MAP ∪ AUTHORITY_MAP ∪ USER_DIRECTED_MAP`. **Throw at startup / fail a unit test red** on any unclassified path — this converts "new recognized ABI silently ungated" into "won't boot," a machine-checkable falsifier rather than a hand-maintained completeness obligation.

Three scoping corrections, all load-bearing for the enumerator to be buildable at all:

- **Scope to state-mutating function inputs only.** Restrict enumeration to `stateMutability ∈ {nonpayable, payable}` function **inputs**; exclude `view`/`pure` functions and all address-typed **outputs** (e.g. Comet `getAssetInfo`'s output, Aave `getUserAccountData.user` input is fine but its output tuple is not a signing-path concern, Uniswap `positions()` outputs, ERC-20 `balanceOf`/`allowance` reads). Enumerating every address anywhere in every recognized ABI, including read-only surface, makes the server unable to boot — this scoping is what makes the check buildable.
- **Fail-closed on opaque byte containers, not just typed addresses.** The enumerator as stated above only walks statically-typed `address` arguments. A recipient can be smuggled inside a `bytes`/`bytes32` argument on a state-mutating function, invisible to that static walk — concretely, Uniswap's **Universal Router `execute(bytes commands, bytes[] inputs)`** has zero top-level address arguments; every swap recipient lives inside the opaque `inputs` blob, and would pass the enumerator clean, boot fine, and leave every recipient it carries completely ungated. Any state-mutating function carrying a `bytes`/`bytes32` parameter is **unclassified-unless-explicitly-exempted** — it must be on an explicit MUST-DECODE/MUST-RECURSE list (with the decode wired in) or the module fails to boot. `multicall(bytes[])` (D7 below) is one such explicit must-recurse entry, not an exception to this rule.
- **The top-level decode failure also refuses.** Mirror the existing approve-decode catch (`pre-sign-check.ts:262-266`): a top-level `decodeFunctionData` throw on a recognized-destination call is a REFUSE, the same posture v2 already specified for multicall sub-calls (D7) but must be stated explicitly at the top level too.

A structural falsifier accompanies the enumerator itself: a test asserting it finds `.recipient` nested inside `exactInputSingle`'s tuple parameter, proving the tuple/array-of-tuple walk actually works, not just that it compiles.

### D3 — Scope of the hard gate: protocol-embedded recipients, not user-directed sends

The wallet-or-signed-contact **hard gate** (non-ack-bypassable) applies only to **protocol-embedded recipient arguments** — arguments where the `prepare_*` tool sets the value to the wallet address by construction, so any other value is a genuine anomaly, never a legitimate call shape the tool itself would produce:

- Aave `withdraw.to`
- Morpho `withdraw`/`borrow`/`withdrawCollateral.receiver`
- Uniswap tuple `mint`/`collect`/`exactInput`/`exactOutput.recipient`, `unwrapWETH9.recipient` (**not** `sweepToken` — absent from `swapRouter02Abi`, so unreachable by decode; already refused via D7's absent-selector-throw rule, not by being on this list)
- Lido `requestWithdrawals.owner`
- Permit2 `transferFrom.to` and batch `.to[]`
- ERC-4626 `deposit`/`mint`/`withdraw`/`redeem.receiver`
- Self-funded-credit arguments: Aave `supply.onBehalfOf`, Morpho `supply`/`supplyCollateral.onBehalf` — these are real drains (an attacker-controlled `onBehalf` deposits the user's funds into the attacker's position, withdrawable later by the attacker) even though the *transfer* direction is inbound, because the position/aToken lands at the named address, not the caller.

**Dropped from the hard gate: ERC-20/native `transfer`/send.** A hard refusal on `prepare_token_send` to a fresh, unsaved address contradicts the tool's entire purpose — sending to an address the user names for the first time is the normal case, and block 1 already lets a **native** send to any address through on the strength of the on-device recipient display alone; refusing the equivalent ERC-20 `transfer` at this gate is an inconsistency the pre-sign layer cannot resolve (it cannot distinguish a user-directed send from a rogue one from calldata alone — that distinguishing signal, which tool built the call and what the user was shown, lives above this gate). `transfer`-via-`custom_call` is already closed by the #741-family classifier; a `transfer` reaching this point legitimately came from `prepare_token_send`, device-confirmed and resolver-labeled. User-directed transfer/native sends remain governed by `resolveRecipient` labeling and the on-device address render, unchanged — not this hard refusal. (This is exactly the fourth D2 bucket, above.)

### D4 — Contact predicate: bind to a signed-verified match only

**The predicate that decides "is this a saved contact" must be `resolved.address === tx.from` (device wallet) OR a **signed-verified** contact match — never `resolved.label !== undefined`.** `label` is set by `resolveRecipient` on **both** a signed and an unsigned match (the unsigned, in-memory store `add_contact` writes to when no Ledger is paired) — an agent-mintable carve-out: `add_contact("savings", ATTACKER)` followed by a gated call naming that address would satisfy `label !== undefined` and pass, entirely without device involvement. This was round-2's one new blocker, found unanimously by all three reviewing lenses.

Implement either as (a) calling `reverseLookup` directly and requiring `state === "match"` (a state only reached after `verifyEvmBlob`/`verifyBtcBlob` succeeds), or (b) adding a `signedContact: boolean` field to `ResolvedRecipient`, true only on a verified-blob match, and gating on that field. `resolveRecipient`'s `label` must not be the key in either implementation.

**Signed contacts are device-anchored and not agent-forgeable** — this was the one open question the design carried into round 2. `signContactsBlobEvm` (`signers/contacts/evm.ts:67-77`) drives a WalletConnect `personal_sign` request that requires a physical Ledger button press; `verifyEvmBlob` (`contacts/verify.ts:221-232`) recovers the signer against the device's own EVM address; there is no host-side signing key an agent could invoke unattended. This settles the question in favor of **wallet-or-signed-contact** as the trust root — it does not drop to wallet-only.

**Tamper handling differs by path.** On the hard gate, a tampered signed-contact blob refuses (fail-closed). For user-directed sends (§D3, not hard-gated), tamper stays non-fatal warn-and-proceed — the existing prepare-time behavior, unchanged; no regression there.

**Residual, not a #759 regression — flag for SEC (Inv #7).** The signed device prompt shows the **entire** `VaultPilot-contact-v1:{JSON}` blob (`signers/contacts/evm.ts:5-14`), not a per-address confirmation screen. "Signed contact" therefore means "the device holder approved this whole blob," not "the device holder confirmed this specific address" — an inattentive user signing a multi-entry blob could be social-engineered into authorizing an attacker entry alongside legitimate ones. The hard-gate contact leg inherits this pre-existing property; it is not introduced by #759, but the hard gate's soundness now depends on it and it should be named as such. See §6.

### D5 — Permit2: exact-selector scope, not a broad ABI grant

Add Permit2 to the recognized-destination set with an ABI scoped to **transfer selectors only**: `AllowanceTransfer.transferFrom(address,address,uint160,address)` (`0x36c78516`, recipient = `args[1]`) and its batch form (`transferFrom(AllowanceTransferDetails[])`, recipient = each element's `.to`; verify the batch selector hex against viem before landing — v2 flagged this as unverified). `approve`/`permit` (authority grants) are **excluded** from this ABI grant and instead route through D6 (the unified authority policy) — admitting them here would open an authority grant ack-free. **The recognized ABI must be exact-selector, not the full Permit2 interface**: `SignatureTransfer.permitTransferFrom`/its batch form (`transferDetails.to`, tuple/array-nested) and `lockdown` must either be mapped with their own nested `.to` paths or remain outside the recognized ABI so block 5 fail-closes them — do not admit a broader Permit2 ABI than these named selectors.

### D6 — Unified authority-designation policy

The gate covers value/credit recipients **and** authority designations — an address argument that confers spend/transfer authority without itself receiving anything is drain-equivalent and must be covered by the same policy: ERC-20 `approve` spender, ERC-721/1155 `setApprovalForAll` operator, Permit2 `approve`/`permit` spender. This reconciles with block 2's existing `approve` spender-allowlist (`pre-sign-check.ts:216-280`) — authority designation is **one** policy consumed from both loci (see D10), not two independently-maintained lists that can drift apart.

### D7 — Multicall: universal per-leg, bounded, cached

`multicall(bytes[])` (`0xac9650d8`, present on both Uniswap ABIs) requires four properties together, not any one alone:

1. **Universal per-leg invariant.** Decode every sub-call and apply D2 to **every leg**, not an existential "does *some* later leg release to the wallet" check — that shape is launderable: `multicall([exactInputSingle(recipient=router), exactInputSingle(A→B, recipient=ATTACKER), unwrapWETH9(min,wallet)])` satisfies "a later leg releases to wallet" while draining through the unchecked middle leg.
2. **Router-self exception, narrowly scoped.** A swap-leg `recipient == the exact chain SwapRouter address` (the literal router constant a specific swap module hardcodes, not a blanket `recipient == tx.to`) is permitted **only** as a documented intermediate hop, and it never sanitizes sibling legs — the terminal value-release leg (`unwrapWETH9`/`refundETH`) must itself independently pass D2 (wallet or signed contact). Whenever any leg uses the router-self exception, at least one leg in the same call must be a terminal wallet/contact-releasing leg, or refuse — a router-self leg with no terminal release strands funds in the router rather than draining them, but is still refused as malformed.
3. **Fail-closed on unrecognized sub-call selectors.** Re-validate every sub-call selector against block 5's `allowedSelectors` for the destination ABI; a selector absent from that ABI (e.g. SwapRouter02's `sweepToken`/`sweepTokenWithFee`/`unwrapWETH9WithFee`, which are absent from `swapRouter02Abi`) must throw on decode and REFUSE, never silently fall through as unchecked.
4. **Bounded recursion depth and single contact-blob resolution.** Refuse beyond a small fixed recursion depth (bounded-loop canon — never "recurse or refuse unboundedly"). Resolve the signed-contacts blob **once** per `assertTransactionSafe`/gate invocation and thread it through every leg's check, rather than re-reading disk and re-running `verifyEvmBlob` once per leg.

### D8 — LiFi: gate the extractable receiver, ack-gate (fail-closed) the remainder

LiFi Diamond is `allowedAbi: null` and therefore block-5-exempt (ARCHITECTURE.md §3.4) — but it still carries `_receiver` in bridge/swap calldata that the signing layer already decodes and discards (via the already-imported `lifiDiamondAbi` + `tryDecodeLifiBridgeData`). Enumerate the LiFi route shapes whose `_receiver` those decoders can extract, and apply the wallet-or-signed-contact invariant to it on those shapes. For any LiFi route shape where receiver extraction is not feasible, that shape is downgraded to **ack-gated and fail-closed** with `_receiver` surfaced to the user — never silently exempted the way it is today. Confirm the generic-swap and bridge decoders cover every route facet `prepare_swap` itself can emit, so no route the MCP's own tool produces is silently downgraded to the ack path for lack of decoder coverage.

This closes only the recipient dimension of LiFi's exposure. The broader arbitrary-calldata-to-LiFi-Diamond bypass — `prepare_custom_call` reaching the same address with arbitrary calldata and arbitrary native value, no selector check at all — is ARCHITECTURE.md §3.4, ruled **UNSOUND — REQUIRES MITIGATION** by SEC (#760) as a wider, separate mitigation thread. #759 does not close #760; it closes the recipient-visibility gap on the routes LiFi's own decoders can read.

### D9 — Explicit residual scope: what this seam does not see

State plainly, not imply coverage: a top-level-argument seam cannot see **nested** calldata. Two named gaps stay open, owned by separate mitigation threads:

- **Safe `execTransaction`** (ARCHITECTURE.md §3.5) — the outer call carries `safeTxOrigin: true` and skips block 4, but the inner `SafeTx` body (`to`/`data`, potentially `operation === 1` DELEGATECALL) is never decoded by anything. SEC ruled this UNSOUND — REQUIRES MITIGATION.
- **LiFi `SwapData.callTo`** nested inside a struct, beyond what D8's receiver extraction covers.

Both are separate mitigation threads, not covered by #759's seam. The design artifact states this explicitly so a reader does not assume the argument-authorization gate reaches everywhere a `to`/`data` pair can appear.

### D10 — Single-source the recipient/authority map across both loci

The #741-family prepare-time custom-call classifier and this pre-sign gate must consume **one** recipient/authority map (one derived from the other, not two independently maintained), reconciling the one deliberate divergence between them: the prepare-time gate is wallet-**only** (no contact allowance), while the pre-sign gate is wallet-**or-signed-contact**. Single-sourcing the map prevents the two loci's selector/argument lists from drifting apart the way the #741 send-family list and this design's map would otherwise, independently, over time — and prevents the early prepare-time UX refusal from ever contradicting the authoritative pre-sign verdict.

---

## 4. Falsifier set

**Positive falsifiers (per blast-radius row) — ack-stamped call to a real recognized destination:**

| Row | Refuse condition | Pass condition |
|---|---|---|
| Aave `withdraw.to` | `to` ∉ {wallet, signed contact} | `to == wallet` |
| Morpho `withdraw`/`borrow.receiver` (tuple) | same | same |
| Uniswap `collect`/`mint`/`exactInputSingle.recipient` (tuple) | same | same |
| Lido `requestWithdrawals.owner` | same | same |
| Permit2 `transferFrom.to` + batch `.to[]` | same | same |
| ERC-4626 `deposit`/`mint`/`withdraw`/`redeem.receiver` | same | same |
| Aave/Morpho `supply`/`supplyCollateral.onBehalf(Of)` | same | same |
| LiFi `_receiver` (extractable routes) | same | same |

**Over-block negatives (were missing from v1 — must be present as tests, not just asserted):**

- `prepare_token_send` → a fresh, never-saved literal address → PASSES.
- `prepare_token_send` → an ENS name resolving to a non-contact address → PASSES.
- Native-out swap `multicall([exactInputSingle(recipient=router), unwrapWETH9(min,wallet)])` → PASSES.
- `repay(onBehalf=other)` (a C-list-exempt argument) → PASSES.
- A normal Morpho `supply` call (exercising all four `marketParams.*` addresses, §Δ4 below) → PASSES.
- A send to a **signed** contact → PASSES.
- A send to an **unsigned-only** contact, on a hard-gated argument → REFUSES (this is the D4 fix under direct test — an unsigned label must not satisfy the hard gate).

**Structural falsifiers (module-load / boot-time, not per-transaction):**

- The address-path enumerator finds `.recipient` nested inside `exactInputSingle`'s tuple parameter (proves the tuple/array-of-tuple walk, not just that it compiles).
- The server refuses to boot if any recognized-ABI, state-mutating-function address or opaque-bytes path is left unclassified (D2-rot).
- An ack-stamped call to a recognized destination with a bad recipient still REFUSES (proves ack-independence, D1).

---

## 5. Dependencies & sequencing

**#751 (Safe-tx-store / broader tx-store freeze work) is a hard co-merge prerequisite for this design as specified**, or is replaced by the send-time re-check below. This gate's soundness depends on the preview-checked recipient verdict still applying at send time — if `tx.from`/`tx.data` can diverge between `preview_send` (where this check runs) and `send_transaction` (which forwards without re-running it), an attacker who can mutate the stored tx between the two calls bypasses the gate entirely. `#710`/`#742` (the tx-store deep-freeze work, ARCHITECTURE.md §3.3(c)) landed; #751 is the still-open sibling closing the remaining freeze gap this design's soundness rests on. This is not a unique dependency #759 introduces — it is the same freeze dependency every other pre-sign verdict (the approve-allowlist, the selector check) already rests on (ARCHITECTURE.md §3.3(a)) — but it is a hard prerequisite given this gate's blast radius.

**Recommended alternative that removes the dependency for this gate specifically:** add a cheap **send-time recipient re-check** inside `sendTransaction` — re-decode the stored `tx.data`, re-compare the recipient against `getConnectedAccounts()` immediately before forwarding to WalletConnect. `sendTransaction` already holds the stored tx and can call `getConnectedAccounts()`; this re-check is tamper-proof by construction and independent of whether the freeze work has landed. If adopted, #751 becomes non-load-bearing for *this* gate specifically (the freeze work is still wanted for the rest of the pre-sign spine, unrelated to #759).

**Relation to #756.** #756 (recipient-verified send path) is the legitimate feature this seam's refusal message should point users toward for a genuinely new non-wallet recipient on a protocol-embedded argument — it is the durable-binding alternative to "just widen the hard gate," not a #759 dependency. The refusal message this design specifies ("recipient X is not your wallet or a saved contact — save it via `add_contact` (signed) then retry, or send from Ledger Live") should be revisited once #756 ships a third legitimate path.

**Implementation and verdict sequencing.** DEV implements #757/#760 from this document, not from either incident's own comment thread. The pre-sign exception surface (D8's LiFi decode-coverage claim, D9's residual-scope claims) requires a SEC verdict alongside REVIEW's structural/completeness verdict before DEV starts — this is explicitly the kind of design-gates-implementation case where building ahead of the verdict risks a wasted cycle or a shipped non-fix.

### Explicit scope boundary — separate mitigation tracks

**#759 COVERS:** the #757 recipient-args-on-recognized-destinations class in full, plus LiFi's `_receiver` dimension (D8).

**#759 does NOT cover — each is a separate mitigation track, its own artifact, its own SEC + REVIEW verdict:**

- **#760-core / §3.4** — arbitrary calldata + arbitrary native value to LiFi Diamond (block-5-exempt, blind-sign class); #759 closes only the `_receiver` dimension (D8). SEC-ruled UNSOUND — REQUIRES MITIGATION (92/100 exploitability).
- **#761 / §3.5** — Safe `execTransaction`'s `safeTxOrigin` skip of block 4; the inner `SafeTx` body (including `operation === 1` DELEGATECALL) is undecoded, compounded by a remote Safe Tx Service fetch of that inner body on a cache miss (`src/modules/safe/execute.ts:28-43`). SEC-ruled UNSOUND — REQUIRES MITIGATION (61/100 exploitability).
- **#762 / Curve** — the Curve ack-stamp trust root, UNSETTLED pending one unverified external premise, plus four repo-side defects, a "three ack-stamp sites, not two" correction, and doc defects.

**Sequencing (PM-confirmed): #759 → §3.4/#760-core → §3.5/#761 → Curve/#762.** Rationale: touch the pre-sign spine once per track, not once per issue — this boundary exists to end the per-issue spine thrash the substrate review was called to stop (repo CLAUDE.md "Pre-Sign Gate Surface Sweeps" + the cross-issue ≥3-same-failure-class trigger).

---

## 6. Open items for SEC

1. **Signed-contact blob trust model (Inv #7).** The device prompt for `add_contact`'s signed path shows the entire multi-entry `VaultPilot-contact-v1:{JSON}` blob, not a per-address confirmation screen (`signers/contacts/evm.ts:5-14`). D4 makes "signed contact" a load-bearing trust root for the hard gate; SEC should confirm whether this whole-blob signing model is an acceptable trust anchor for that role, independent of the #759 mechanism itself (this property predates #759 and is not introduced by it).
2. **Ledger clear-sign vs. blind-sign of the `personal_sign` request.** D4's non-forgeability claim rests on the device rendering the signed blob's content, not blind-signing an opaque digest — a vendor firmware behavior claim that needs device-layer confirmation, not just the WalletConnect call-site code reading correctly.
3. **LiFi extractable-route enumeration (D8).** Confirmation that the generic-swap and bridge decoders (`tryDecodeLifiBridgeData` and siblings) cover every route facet `prepare_swap` itself can emit today, so no route the MCP's own tool produces is silently downgraded to the ack-gated fallback path for lack of decoder coverage — this is a completeness claim about the decoder set, not about the design shape.
