# Bug List & Proposed Fixes — VaultPilot MCP

Generated 2026-07-20 from the live tracker (`agenthill/vaultpilot-mcp`). This covers the **9 open issues labeled `bug`**. Every claim below was checked against a read-only clone of the code; where an issue's own claim did **not** match the current code, that is called out rather than repeated. Each entry is written to be paste-ready as a GitHub comment on its issue.

Severity key: 🔴 fund-safety / live drain · 🟠 containment or supply-chain · 🟡 cleanup / low blast radius

| # | Severity | One-line |
|---|---|---|
| [#798](https://github.com/agenthill/vaultpilot-mcp/issues/798) | 🔴 | `prepare_swap(toAddress=ATTACKER)` drains to the LiFi Diamond; the intent check compares the attacker's address to itself |
| [#799](https://github.com/agenthill/vaultpilot-mcp/issues/799) | 🔴 | A chain-ID safety exception is keyed to the wrong network number, opening a TRON path that should be closed |
| [#761](https://github.com/agenthill/vaultpilot-mcp/issues/761) | 🔴 | Safe multisig transactions are validated on the outer wrapper only — an inner "send everything to attacker" rides through |
| [#775](https://github.com/agenthill/vaultpilot-mcp/issues/775) | 🟠 | In demo mode, `submit_safe_tx_signature` still writes to Gnosis Safe's live coordination server |
| [#777](https://github.com/agenthill/vaultpilot-mcp/issues/777) | 🟠 | Contact tools are already demo-safe, but the mechanical safety-net doesn't cover message-signing sinks |
| [#785](https://github.com/agenthill/vaultpilot-mcp/issues/785) | 🟠 | Nothing grounds the hardcoded contract addresses against an external source — a typo would elevate trust |
| [#764](https://github.com/agenthill/vaultpilot-mcp/issues/764) | 🟡 | A safety comment points at a **closed** issue, implying a still-open question is settled |
| [#755](https://github.com/agenthill/vaultpilot-mcp/issues/755) | 🟡 | Send-family gate follow-ups — 2 small ready fixes, the rest re-routed |
| [#752](https://github.com/agenthill/vaultpilot-mcp/issues/752) | 🟡 | Swap cleanup — verify a native-in assumption, reorder a miscounted metric, commit test evidence |

---

## 🔴 #798 — `prepare_swap(toAddress=ATTACKER)` drains to the LiFi Diamond, unstamped

**In plain English:** A malicious or hijacked AI agent can set the swap's destination to its own wallet, and the existing safety check doesn't catch it — because it compares the attacker's requested address against itself.

**What's actually wrong:** In `src/modules/swap/index.ts:212`, `verifyLifiBridgeIntent` computes `expectedReceiver = args.toAddress ?? args.wallet` and compares it to the decoded on-chain receiver. But `toAddress` is an agent-settable field (`src/modules/execution/schemas.ts:524`), so an attacker who sets it to their own address makes the check compare their value to itself — it always passes. This defends against a tampered LiFi *response*, not a rogue *caller*. The LiFi Diamond is a "recognized" destination, so the recipient-authorization seam returns early (`src/signing/recipient-authorization.ts:706`) and doesn't fire either. On the same-chain path the generic-swap `_receiver` argument is never decoded anywhere in `src/`. #760 only closed the stamped `prepare_custom_call` path, not this unstamped `prepare_swap` one.

**Proposed fix:**
1. At `swap/index.ts:212`, require that a `toAddress` differing from `args.wallet` carry the same server-stamped, unforgeable acknowledgment already used for other recognized destinations (`acknowledgedNonProtocolTarget`) — never trust the raw agent-supplied `toAddress`.
2. Decode and surface the generic-swap `_receiver` in `src/modules/swap/vet-lifi-quote.ts` so the same-chain path stops being silent.
3. Wire the stamp check into the pre-sign flow so it runs before the swap is returned for signing.

**How we'd prove it's fixed:** A new test builds `prepare_swap` with `toAddress=ATTACKER` and no stamp and asserts it refuses — this must go **RED** on current `main` (proving the hole) and **GREEN** after. A companion test confirms a *stamped* `toAddress` to another wallet still works (legitimate "swap to my other wallet" preserved).

**Related:** #760, #799 (same function), #757 (same drain shape).

---

## 🔴 #799 — chain-ID safety exception keyed to the wrong network

**In plain English:** The code that lets a cross-chain swap through when the destination-chain number looks "wrong" was told that number belongs to NEAR — but it actually belongs to TRON, so the exception opens a door to TRON that should stay shut.

**What's actually wrong:** `INTERMEDIATE_CHAIN_BRIDGES` (`src/modules/swap/intermediate-chain-bridges.ts:88-93`) hardcodes `{ bridgeName: "near", intermediateChainId: 1885080386571452n }`, and `verifyLifiBridgeIntent` uses it to relax the `destinationChainId === expectedChainId` check. That value is **TRON's** on-chain id, not NEAR's (NEAR Intents doesn't encode an intermediate chain at all). Worse, a pinning test (`test/intermediate-chain-bridges.test.ts:18-27`) locks the wrong value in, so **CI currently enforces the bug** instead of catching it. Effect: a LiFi ETH→TRON quote with `bridge="near"` passes the chain-ID gate for all destinations, and #237 (the bug this table was meant to fix) stays unfixed.

**Proposed fix:**
1. Remove the false NEAR entry — do **not** guess a replacement id (the module's own rules forbid unverified edits).
2. Independently re-derive from a live LiFi quote whether NEAR encodes an intermediate chain id at all; if not, close #237 by a different mechanism (bridge-name allowlist with no chain-id relaxation, plus receiver checks).
3. Fix the pinning test to assert the corrected/removed value so CI enforces the truth.

**How we'd prove it's fixed:** A RED test asserting the current `1885080386571452` pin fails once removed, plus a test that a genuine TRON destination with `bridge` unset does **not** match any allowlist entry.

**Related:** #237 (original goal), #798 (same gate function).

---

## 🔴 #761 — Safe multisig transactions validated on the outer wrapper only

**In plain English:** When you sign a Safe (multi-sig wallet) transaction, the code checks the *outer* Safe call looks legitimate but never looks *inside* to see what it does — so a hidden inner instruction to send all funds to an attacker (or even take over the wallet) rides through.

**What's actually wrong:** `prepare_safe_tx_propose` validates the inner action with regex only (`src/modules/safe/schemas.ts:47-52`) and accepts `operation: 1` (DELEGATECALL — a takeover primitive) as a plain literal with no acknowledgment. At pre-sign, a Safe address isn't a "recognized destination," so block 4 is entered and returns early on `tx.safeTxOrigin === true` (`src/signing/pre-sign-check.ts:198-207`) — **before any inner calldata is decoded**. Every display path truncates the inner `data` to its 4-byte selector, so even a cooperating agent can't show the user who the inner `transfer()` actually pays.

**Proposed fix:**
1. When `tx.safeTxOrigin === true`, decode the inner `(to, value, data, operation)` (available from the cached Safe tx body) and re-apply the same recipient/spender checks a direct call would face — against the inner `to`/`data`, not just the outer wrapper.
2. Require an explicit affirmative ack for `operation === 1` (DELEGATECALL) in the schema.
3. Stop truncating: include the decoded inner recipient in the description an agent relays.

**How we'd prove it's fixed:** A test with a `safeTxOrigin`-stamped tx whose inner data is `transfer(ATTACKER, balance)` — refused (RED before, GREEN after) — plus an inner-`operation: 1` case requiring the new ack.

**Note:** High blast radius (touches the Safe path + the shared pre-sign gate). Needs careful regression coverage so the normal `propose → send` flow still works.

---

## 🟠 #775 — demo mode still writes to Gnosis Safe's live server

**In plain English:** In demo mode, the tool that posts a multisig signature to Gnosis Safe's live coordination server isn't blocked like other risky tools are — so a demo session can trigger a real write to that outside service.

**What's actually wrong:** `submit_safe_tx_signature` passes through the demo dispatcher (`src/index.ts:1113`) but matches none of its three intercepted shapes (`isAlwaysGatedTool`, `isConditionallyGatedTool`, `isBroadcastTool`), so it falls into "everything else" and runs for real. Its handler (`src/modules/safe/actions.ts:266`) calls `kit.proposeTransaction`/`confirmTransaction` — a live HTTP write to the Safe Transaction Service — gated only by an on-chain read that a demo user with a known real `(safe, signer, hash)` triple can satisfy.

**Proposed fix:**
1. Add `"submit_safe_tx_signature"` to `ALWAYS_GATED_EXPLICIT` (`src/demo/index.ts:406`) so it refuses fail-closed in demo — same precedent as `finalize_btc_psbt`.
2. Add an off-chain-write sink category to the mechanical reachability walker (`test/support/sink-reachability.ts`) so this class is detected automatically in future.

**How we'd prove it's fixed:** Under `VAULTPILOT_DEMO=true`, spy on `kit.proposeTransaction` and assert it's never invoked — RED today, green after step 1.

**Related:** #772/#774 (device-sign/broadcast containment), #776 (sink taxonomy).

---

## 🟠 #777 — contact tools are demo-safe, but the safety-net doesn't know it

**In plain English:** The issue says saving/deleting a contact triggers a real hardware-wallet signature in demo mode — but the current code already routes demo contacts to a fake in-memory list *before* any device call. The real gap is that the codebase's automated safety-net doesn't yet check this path, so only a hand-written test protects it.

**What's actually wrong (correction to the issue):** `addContact`/`removeContact` (`src/contacts/index.ts:246`, `:395`) check `isDemoMode()` first and return from the demo store immediately; the signing call sits *after* those early returns and is provably unreached in demo. So the runtime bug described **does not reproduce** on the current clone. The residual defect is structural: the mechanical sink-reachability check (`test/support/sink-reachability.ts`) doesn't list `requestPersonalSign`/`signBtcMessageOnLedger` as sinks, so nothing automatically guards against a *future* regression here.

**Proposed fix:**
1. Add those two signing functions to the sink set in `test/support/sink-reachability.ts`.
2. Add a containment predicate (e.g. `isInternallyDemoBranchedTool`) so tools that early-return on `isDemoMode()` are recognized as contained.
3. Add a spy-based regression test asserting zero signing calls under demo.

**How we'd prove it's fixed:** The spy test goes RED only if the demo early-return is ever removed — turning today's incidental safety into a mechanical guarantee.

**Note for the reporter:** flag that the clone no longer reproduces the described runtime signature; the fix here is hardening, not a live drain.

---

## 🟠 #785 — hardcoded contract addresses aren't grounded against anything external

**In plain English:** Nothing checks the hardcoded contract addresses against an outside source, so a single wrong hex character — from a typo or a bad pull request — would pass every existing test and still be treated as a fully-trusted destination.

**What's actually wrong:** `src/config/contracts.ts` pins roughly **100 addresses (about 85 unique)** across chains, each with only a source *comment*, never a machine-checked reference. The one completeness-shaped test (`test/canonical-dispatch.test.ts:23-36`) builds its expected set by walking `CONTRACTS` itself — so it can never catch the allowlist and `CONTRACTS` being wrong *together*. A recognized address skips pre-sign block 4's catch-all entirely, so membership in `CONTRACTS` is a trust **elevation** that nothing external grounds.

**Proposed fix:**
1. Add a committed provenance file (`src/config/contracts-provenance.json`) keyed by chain + protocol, each entry `{address, sourceUrl, dateVerified}`.
2. Add `test/contracts-provenance.test.ts` that walks every `0x…40-hex` value in `CONTRACTS` and asserts a matching provenance entry exists byte-for-byte.

**How we'd prove it's fixed:** Flip one hex character of any address without updating provenance → the new test goes **RED**. Today the same mutation stays green.

**Note:** Purely additive (new file + test), no runtime change. On-chain rotation checking is a separate follow-on. Related: #776.

---

## 🟡 #764 — a safety comment points at a closed issue

**In plain English:** A security-relevant code comment points readers to a ticket that's already closed, wrongly implying the underlying question is settled. The trivial part (repoint the comment) is ready now; the hard part (finding every "send funds elsewhere" pattern) is deferred to a design effort.

**What's actually wrong:** `src/security/custom-call-classifier.ts:55` and `:150` both carry a completeness caveat reading "(issue #741)" — but #741 is closed, while the completeness question is still open. Per ARCH's own adjudication, the substantive half (a flat hand-enumeration of send-family selectors can't converge, since recipient args sit at different positions across protocols) is folded into **#776's** structural-decode design and must **not** be fixed by extending the selector list.

**Proposed fix (DEV-ready part only):**
1. Repoint both caveats from `(issue #741)` to `(issue #764)`.
2. Add a lint-style test asserting no in-code comment or error string in that file references a **closed** issue number.
3. Do **not** add the 7 known-unclassified selectors here — that's #776/#757's structural seam.

**How we'd prove it's fixed:** The lint test resolves each `#NNN` reference against a known-open allowlist and fails on a closed one — RED today (points at #741), green after the repoint.

---

## 🟡 #755 — send-family gate follow-ups (mostly already re-routed)

**In plain English:** A grab-bag of six small follow-ups to the recipient-safety gate from #741. The issue's own thread already re-routed most of them; only two small fixes actually belong here.

**What's actually wrong (per the issue's own adjudication):** Items 1 & 2 (Permit2 completeness, struct-recipient model) → absorbed into #776/#757. Item 3 (misleading NFT refusal message) → **already fixed** on the clone; the message at `custom-call-classifier.ts:135-152` correctly points to the #756 recipient-verified path. Item 4 (ERC-4626 "over-refusal") → confirmed intentional product scope, not a bug. Items 5 & 6 → still open: no invariant comment near `custom-call/actions.ts:163`, and `matchSendFamilyGate(data)` is evaluated twice per call.

**Proposed fix (the 2 real items):**
1. **Item 5:** add a one-line comment above `matchSendFamilyGate(data)` (`custom-call/actions.ts:163`) stating the gate's correctness depends on `data` being built via `encodeFunctionData` — a future pre-encoded-calldata path would decouple the checked recipient from the signed one.
2. **Item 6:** dedupe the double evaluation — pass the already-matched gate entry into `assertSendFamilyRecipientIsWallet` instead of re-deriving it internally.

**How we'd prove it's fixed:** Existing `test/custom-call.test.ts` refusal tests must still pass unchanged (behavior-preserving refactor). Item 5 is comment-only.

---

## 🟡 #752 — swap cleanup follow-ups

**In plain English:** Three small leftovers from an earlier approved fix: verify an untested assumption, reorder two calls so a counter isn't double-inflated, and commit test evidence that currently exists only as prose.

**What's actually wrong:** (1) `vetGenericSwapQuote`'s topology guard (`vet-lifi-quote.ts:144`) assumes LiFi's native-token sentinel equals `fromToken.address` for a native-in swap, but no test exercises a native-in route. (2) `instrumentBridgeQuote` is called at `swap/index.ts:925`, **before** `verifyLifiBridgeIntent` at `:994` — so a bridge quote later rejected by the intent check still inflates the suspected-unreachable metric that #745's promotion trigger reads. (3) Only the probe *script* is committed; the result numbers cited in review exist only as prose.

**Proposed fix:**
1. Add a native-in ERC20-out test fixture asserting the topology guard behaves correctly.
2. Move `instrumentBridgeQuote` to run **after** `verifyLifiBridgeIntent` succeeds.
3. Run the committed probe script and commit its raw output as a durable artifact.

**How we'd prove it's fixed:** A test asserting a rejected bridge quote does **not** increment the suspected-unreachable counter — RED against the current `925-before-994` ordering, green after the reorder.

**Note:** All three are non-blocking (#746 already merged). Prioritize item 2 — #745's escalation trigger is unreliable until it lands.

---

*This document is a point-in-time proposal (2026-07-20), tracked in issue #805. It documents the 9 `bug`-labeled issues and proposes fixes — it does **not** implement them; each fix lands via its own reviewed PR. The remaining open issues (security hardening, refactors/simplifications, CI, measurement, and tracking/meta) are tracked separately.*
