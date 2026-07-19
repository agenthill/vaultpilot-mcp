# Implementation plan: #757 / #760 — recipient-authorization seam (pre-sign)

**Status: PREP ARTIFACT. BUILD HELD.** This plan is written off the SEC-approved
v5 design (`docs/design/759-recipient-authorization-seam.md`, #765 v5). The spine
build is gated on **#765 reaching v6 + REVIEW re-approval** — the instant both
land, GO (no fresh gate; SEC already cleared the spine per the #757 PM ruling).
The impl PR takes the full REVIEW + SEC review at PR time.

**Locus re-resolution note.** The v5 design's `execution/index.ts` line-anchors
predate the #758 (#720) decomposition. Re-resolved against branch base
`origin/main` @ `24156172`: `runEvmPreSignGuards` = `src/modules/execution/index.ts:1819`
(private), `previewSend` = `:1896`, `sendTransaction` = `:2165`, the account-set
match = `:1842-1852`, `consumeHandle` in `sendTransaction` around `:2272`.
`assertTransactionSafe` / `classifyDestination` = `src/signing/pre-sign-check.ts`
(404 L, `classifyDestination` at `:105` — module-private today). **Symbol names,
not line numbers, are load-bearing** — re-resolve at build time.

**Acceptance criterion = the committed falsifiers.** `test/757-760-recipient-drain.test.ts`
is RED against `main` today (proof the drains are signable). The falsifiers there
DEFINE DONE. See §"Falsifier → increment mapping" for which increment turns each
GREEN.

---

## 1. What the first spine PR builds (SEC-v5-approved buckets only)

The first PR implements the recipient dimension the SEC v5 verdict cleared. It
does **not** build the two v6-pending legs (§3).

### 1.1 D1 — locus + fail-closed account-set precondition
- **Export `classifyDestination`** from `pre-sign-check.ts` so `runEvmPreSignGuards`
  can classify the destination independently. `dest === null` (unrecognized)
  defers to today's block-4 catch-all (D9) — no hard gate, unchanged.
- **Add the recipient/authority check inside `runEvmPreSignGuards`, AFTER the
  existing WalletConnect account-set match (`:1842-1852`)** — never inside
  `assertTransactionSafe`, which only sees agent-supplied `tx.from` (D1). The
  check resolves recipients against `tx.from` only once `tx.from` has been
  confirmed a member of `getConnectedAccounts()`.
- **A4 — honest trust root.** The account-set match proves membership in the
  peer-advertised account set of the most-recently-adopted WalletConnect session
  — NOT a device binding. Sound against THIS threat model (rogue agent cannot
  forge peer-advertised membership). The peer-vs-device gap is a recorded residual
  (design §7), not a blocker; the recommended companion hardening
  (`probeSessionLiveness` before the match, blocking peer-pin) is **not** in this PR.
- **Precondition (co-merge, both loci).** Make the account-set match fail-closed
  on ALL its fail-open branches, not skip-and-fall-through:
  - Branch (1) — empty account set via any of four producer states: (a) no session
    survives restore, (b) settled session with no `eip155` namespace, (c) empty
    `eip155.accounts`, (d) every entry failing the CAIP-10/`EVM_ADDRESS` filter.
    A real-signing non-demo call hitting any of the four → REFUSE.
  - Branch (2) — falsy/missing `tx.from` on a real-signing non-demo path → REFUSE.
  - Branch (3) — `isDemoMode()` stays exempt, on the narrow ground that every
    EVM/TRON/Solana broadcast funnels through the one demo-intercepted
    `send_transaction` (NOT the false "demo never really signs" premise).
  - **Meta-falsifier:** reverting to today's `accounts.length > 0 && !accounts.includes(from)`
    must redden ALL FOUR producer-state tests.

### 1.2 D2 — fail-closed four-bucket authorization over every address-typed argument
- For every recognized-destination selector that passes block 5, decode the call
  and enumerate **every address-typed argument path** — including nested tuples
  and arrays-of-tuples (Uniswap `ExactInputSingleParams.recipient`, Morpho
  `MarketParams`, etc.). Each address falls into exactly one bucket:
  1. **NON_RECIPIENT_ALLOWLIST** — admission by the **stated test** (cannot spend
     the caller's value to a third party, cannot confer authority), NOT a name
     list. Includes the v5 per-entry evidence set: Lido `submit.referral`; Aave
     `borrow.onBehalfOf` (passes by direction); every Morpho `marketParams.*`; the
     eight further bucket-1 paths added at v5 (Aave `asset` ×4, Compound Comet
     `asset` ×2, EigenLayer `token`); EigenLayer `strategy` + Morpho
     `marketParams.oracle` kept as **named-exemption-on-unverified-premise** (§7
     residual), NOT proven-property.
  2. **Wallet-only (D4)** — resolves to the account-set-verified `tx.from`.
  3. **Authority designation (D6)** — **v6-PENDING, deferred (§3).**
  4. **USER_DIRECTED_RECIPIENT** — `transfer.to`, Uniswap `mint`/`collect.recipient`,
     `prepare_swap`'s user `toAddress`: pass-through governed by resolver +
     on-device render, **conditioned on absence of the server `acknowledgedNonProtocolTarget`
     provenance stamp** (D3).
- **Any address that classifies into none → REFUSE.** Adding a new ABI fails
  toward a human-clearable refusal, never a silent drain.

### 1.3 D2-rot — module-load anti-rot enumeration (completeness mechanism)
- At module load, recursively enumerate every address-typed argument path across
  every recognized ABI and assert each is a member of the union of the four maps.
  **Throw at startup / fail a unit test RED** on any unclassified path — "new
  recognized ABI silently ungated" becomes "won't boot."
- Enumerator domain = the **per-kind block-5 accepted-selector UNION**, re-derived
  from block 5's own kind→selector switch (weth9/stETH/rETH + one further kind
  are unions, not the narrower `allowedAbi` field). `lifi-diamond` (`allowedAbi:null`)
  is EXCLUDED from this domain and routed to D8. **Boot falsifier:** enumerator
  domain set-equal to the per-kind union block 5 accepts; fail boot on divergence
  either direction.
- Scope to `stateMutability ∈ {nonpayable, payable}` **inputs** only (a read-only
  address has no bucket by construction). Fail-closed on opaque `bytes`/`bytes32`
  containers via an explicit MUST-DECODE / MUST-RECURSE / REQUIRE-EMPTY list
  (Morpho `data` = REQUIRE-EMPTY; both Uniswap `multicall(bytes[])` = MUST-RECURSE,
  D7). Top-level `decodeFunctionData` throw on a recognized dest → REFUSE.

### 1.4 D3 — hard-gate scope + bucket-4 provenance condition
- **Wallet-only hard gate applies to protocol-embedded recipients only** (the
  builder sets them to wallet by construction, so any other value is an anomaly):
  Aave `withdraw.to`; Morpho `withdraw`/`borrow`/`withdrawCollateral.receiver` and
  `.onBehalf`; Uniswap `exactInputSingle`/`exactOutputSingle.recipient`,
  `unwrapWETH9.recipient`; Lido `requestWithdrawals.owner`; self-funded-credit
  (Aave `supply.onBehalfOf`, Morpho `supply`/`supplyCollateral.onBehalf`); Aave
  `repay.onBehalfOf` + Morpho `repay.onBehalf` (moved to hard-gate — spends
  caller's tokens to reduce a third party's debt).
- **Dropped from the hard gate → bucket 4:** ERC-20/native `transfer`/send; Uniswap
  `mint`/`collect.recipient` (user-choosable on the live standalone tools). Bucket-4
  pass-through is **conditioned on the ABSENCE of the server `acknowledgedNonProtocolTarget`
  stamp** — a `prepare_custom_call` reaching these WITH the stamp is evaluated
  hard-gated instead (closes the #757 shape on these protocols).
- **U1 SETTLED** (SEC-verified): `acknowledgedNonProtocolTarget` is not
  agent-settable — three server writers, one reader, no schema exposure. **CI
  assertion (in this PR):** no fourth writer of the flag ever appears.
- **Residual (named honestly):** `prepare_token_send(to=ATTACKER)` is defended
  ONLY by the on-device render — no provenance backstop at this seam.

### 1.5 D4 — wallet-only predicate (signed-contact leg deferred)
- Hard-gate predicate is `getAddress(recipient) === getAddress(tx.from)` — ONLY.
  Normalize BOTH operands via `getAddress` (or equivalent checksum
  canonicalization); one-sided/missing normalization fails CLOSED. Matches the
  repo's existing comparison convention (`execution/index.ts:1843-1844`,
  `swap/index.ts:214`).
- **Signed-contact leg is DEFERRED to #773**, not dropped — its v5 trust root
  (`verifyEvmBlob` recovering against a self-asserted `blob.anchorAddress`) is
  unsound; it needs a real device-anchor binding + single-entry-delta approval +
  a BTC-path parallel first. No protocol-embedded hard-gated argument is ever set
  to a contact by any live tool, so wallet-only costs nothing here.

### 1.6 D7 — multicall per-leg (recipient dimension, in scope)
- `multicall(bytes[])` (both Uniswap ABIs): decode every sub-call and apply the
  WHOLE D2 mechanism to **every leg** (universal per-leg, not existential),
  **threading the tx-level `acknowledgedNonProtocolTarget` stamp down into every
  per-leg bucket-4 evaluation** (a leg has no provenance signal of its own).
  Router-self exception is conjunctive + asset-bound + positional (the qualifying
  `unwrapWETH9(amountMinimum>0, wallet)` terminal-release leg must appear AFTER the
  router-self leg; `refundETH()` does not satisfy it; terminal release is
  wallet-only). Fail-closed on unrecognized sub-call selectors. Total decoded
  sub-call budget (breadth-bound). Contact-blob caching is #773's, build nothing
  from it here.

### 1.7 D10 + §5 send-time re-check (co-merge, not optional)
- **D10** — the #741-family prepare-time classifier and this pre-sign gate consume
  ONE recipient/authority map (one derived from the other).
- **§5 send-time re-check (N4)** — ships in the **SAME PR**. Inside
  `sendTransaction`, AFTER `consumeHandle` and BEFORE `requestSendTransaction`,
  **re-run the FULL D2/D3/D7 classification on the frozen tx bytes with a freshly
  read `getConnectedAccounts()` substituted as the wallet input** — NOT a bare
  recipient-vs-accounts compare (that would over-block bucket-4 sends or under-enforce
  D6/D7). Fail-closed on the same D1 precondition (empty refreshed set / falsy
  `tx.from` → REFUSE at send). The tx-store deep-freeze this rests on (#710/#742)
  is already landed — **#751 is NOT a dependency** (design §5).

---

## 2. Falsifier → increment mapping

`test/757-760-recipient-drain.test.ts` (RED today) turns GREEN as follows:

| Falsifier(s) | Increment that turns it GREEN |
|---|---|
| `#757` Aave/Morpho/Lido/Uniswap `...=ATTACKER` (×4), SHARP INSTANCE (Aave), TUPLE-NESTED (Uniswap) | **First spine PR (§1)** — recipient dimension |
| `#757` over-block controls `...=wallet` (×4) | GREEN now; must STAY green (over-block guard) |
| `#760` LiFi `_receiver=ATTACKER` + native value | **v6-PENDING D8 increment (§3.2)** — NOT the first spine PR |
| `#760` LiFi `_receiver=wallet` control | GREEN now; must STAY green |
| `#760-core` (skipped) | **Separate track** (§4) — not #759 at all |

The first spine PR's DONE = the six `#757` RED falsifiers turn GREEN and the five
controls stay GREEN. The `#760` LiFi falsifier is written now as proof-of-drain but
is the D8 increment's acceptance, per the task's v6-pending split.

---

## 3. v6-PENDING — DO NOT build in the first spine PR

REVIEW's §4-grounding stop (v6) overlaps these two legs; both await #765 v6 +
REVIEW re-approval. SEC re-gates the authority leg at the impl PR per its
conditions.

### 3.1 Bucket-3 authority-designation leg (D2 bucket 3 / D6)
- The unified authority policy for spend/operator arguments
  (`setApprovalForAll` operator, Permit2 `approve`/`permit` spender). **Its only
  live-today authority coverage is ERC-20 `approve` spender, which already runs
  through PRE-EXISTING block 2** — D6 adds no second wallet-only check on top of
  block 2 in this increment. `setApprovalForAll` and Permit2 `approve`/`permit`
  are **forward-looking** (both refused pre-decode at block 5 today; gated on a
  curated-ABI addition D6 must first specify). Deferred as a forward-looking
  follow-on; SEC re-gates.

### 3.2 D8 — LiFi extractable-`_receiver` discriminator
- Extract `_receiver` from LiFi bridge/swap calldata (via the already-imported
  `lifiDiamondAbi` + `tryDecodeLifiBridgeData`) and classify per D2's buckets
  using the provenance-stamp discriminator: UNSTAMPED + `_receiver==wallet` →
  bucket 2; UNSTAMPED + `_receiver!=wallet` → bucket 4 (user `toAddress`);
  STAMPED (custom-call-reachable) → hard-gated, refuse unless `_receiver==wallet`.
  Route shapes with no extractable receiver → ack-gated + fail-closed with
  `_receiver` surfaced. `NON_EVM_RECEIVER_SENTINEL` exemption conditioned on
  provenance. Closes the `#760` LiFi falsifier. Deferred to the v6 increment.

---

## 4. Scope boundary — separate mitigation tracks (NOT this design)

Per design §5, these are their own artifacts, each its own SEC + REVIEW verdict.
Sequencing (PM-confirmed): #759 → §3.4/#760-core → §3.5/#761 → Curve/#762 — touch
the pre-sign spine once per track.

- **#760-core / §3.4** — arbitrary UNDECODABLE calldata + arbitrary native value to
  LiFi Diamond (block-5-exempt, blind-sign class). #759 closes only the `_receiver`
  dimension (D8). Recorded as the skipped test in the falsifier file.
- **#761 / §3.5** — Safe `execTransaction` `safeTxOrigin` skip of block 4; inner
  `SafeTx` body (incl. `operation===1` DELEGATECALL) undecoded. D9 residual.
- **#762 / Curve** — Curve ack-stamp trust root (UNSETTLED external premise + repo
  defects + "three stamp sites, not two").
- **`SwapData.callTo`** nested LiFi struct — currently UNOWNED, untracked.
- **Asset dimension** (D9) — this gate authorizes the recipient ADDRESS, never the
  asset/price; out of claimed scope by design.

---

## 5. Merge gate + surface sweep

- **Merge gate:** REVIEW PASS + SEC verdict at PR time (a pre-sign exception-surface
  change takes a SEC verdict beside REVIEW's per the standing convention).
- **Pre-Sign Gate Surface Sweep (project CLAUDE.md).** This change modifies the
  recognized-destination path of blocks 4/5. The sweep is executed by the falsifier
  file: every `prepare_*` whose outer `to` lands in the modified class
  (Aave/Morpho/Lido/Uniswap recognized dests, plus LiFi) is exercised via
  `preview_send`, with the wallet-recipient over-block controls proving the fix
  covers the class without regressing legitimate flows. `prepare_token_send` /
  `mint` / `collect` / `prepare_swap(toAddress)` remain bucket-4 pass-through
  (device-render-defended) — the named, intentional non-hard-gated cases.
- **Cross-repo split (project CLAUDE.md).** This is an MCP-code defense layer (new
  pre-sign block behavior), not a skill-rendered block shape or a cooperating-agent
  rule — no `vaultpilot-security-skill` companion issue is owed by this change on
  its face; re-run the four-question sweep at PR-write time to confirm.
