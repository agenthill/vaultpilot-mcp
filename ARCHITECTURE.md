# VaultPilot MCP — Architecture (target design)

**Status:** normative target design. Where code and this doc disagree, the disagreement is a convergence task, not a licence to rewrite this doc to match the code. **Precedence:** a `SPEC.md` (none exists yet) would outrank this doc; this doc outranks the code.

**Pin:** all current-state evidence is labelled `recon @ c1b373a` (commit `c1b373a479022846e8fff7f87cb89c7edc7fa1bc`) and is a snapshot, not a realized fact. Every architectural target below carries a **falsifiable exit criterion** — a grep, per-file structural check, call-count, or regression test that goes RED when the code drifts off target. A target with no such criterion is a doc defect.

**Reading contract for this doc:** it declares itself ground truth for the module boundaries, the trust model, and the transport invariants. It carries stated constraints (§2) and cross-cutting invariants (§3, §4) and must be read in full when a change alters architecture. The requirements in §2 are almost all `ASSUMED:` — there is no spec that owns them yet, and every one is a routed intake ask (§2 table).

---

## 1. Overview & context

VaultPilot MCP is a **single-process stdio MCP server** (`@modelcontextprotocol/sdk`) that exposes crypto-wallet capability to an LLM agent. It builds, guards, signs, and broadcasts transactions across five chain families — EVM (viem; ethereum/arbitrum/polygon/base/optimism), Solana (`@solana/web3.js` + klend/kliquidity/marginfi/marinade SDKs), Bitcoin, Litecoin, TRON — and reads positions/prices/history for all of them.

**Tool surface (recon @ c1b373a):** 189 registered tools (`registerTool(server, …)` call sites in `src/index.ts`), all unique, 100% MCP-annotated. Verb families: `prepare_*` (77, build unsigned-tx draft), `get_*` (61, read), plus `preview_send`/`preview_solana_send`, `sign_*`, `send_transaction` (the single broadcast tool), `verify_*`, `pair_ledger_*`, and config/contact tools.

**Operator model.** The agent drives; the server enforces. A tool call flows:

```
agent → prepare_*  → server builds UnsignedTx, issues an OPAQUE handle (never raw calldata)
agent → preview_send(handle) → server runs the pre-sign safety gate + simulation, pins gas, mints a previewToken
agent → send_transaction(handle, previewToken, userDecision:"send") → server forwards to Ledger via WalletConnect; device screen is the final human check
```

Solana inserts one extra hop (`preview_solana_send`, blockhash pin); BTC/LTC/TRON go `prepare_* → send_transaction` directly (§3, §7).

**The agent context is untrusted.** The canonical attack is prompt-injection convincing the model to sign `approve(attacker, MAX)` or `transfer(attacker, …)`. The server is the enforcement boundary; the Ledger device screen is the final human-verification boundary; the WalletConnect peer is untrusted. §3 is the whole defense.

### Non-goals (deliberate, defended)

| Non-goal | Why it is out of scope | Enforcing guard |
|---|---|---|
| **Typed-data signing** (`eth_signTypedData_v4`, EIP-2612 permit, Permit2, CowSwap order) | One permit signature grants perpetual transfer authority for `deadline`'s lifetime; hash-recompute alone passes tautologically over a tampered tree. The gap is the defense. | `REQUIRED_NAMESPACES` in `signing/walletconnect.ts` explicitly EXCLUDES `eth_signTypedData_v4` (recon @ c1b373a, L93-96). Re-adding any typed-data tool requires paired Inv #1b (tree decode) + Inv #2b (digest recompute) in the same release — CLAUDE.md §Typed-Data Signing Discipline (#453). **Exit criterion:** `grep -rn "signTypedData\|eth_signTypedData" src/` surfaces only comments/exclusions, never a `registerTool` or a WC method entry. |
| **Solana multisig prepare/send** | `@sqds/multisig` is wired read-only (pending-upgrade incident monitoring). No signing flow exists, asymmetric with BTC's full cosigner flow — by design for v1. | **Exit criterion:** `grep -rn "@sqds/multisig" src/` matches only `modules/incidents/{solana-known,squads-pending}.ts`; no `prepare_squads_*` tool registered. |
| **Server-side key custody** | The server never holds a private key. All signing is on the Ledger device (USB `hw-app-*`) or the WalletConnect peer (Ledger Live). | **Exit criterion:** no seed/mnemonic/privkey field in any schema or config; `grep -rn "mnemonic\|privateKey\|seedPhrase" src/` finds no persisted-secret path. |
| **Generic retry/backoff wrapper** | Only viem's transport retries (transient-classified). TRON/BTC/LTC/Solana broadcast are single-shot by design — explicit failure beats silent retry-storms (issue #326 context). | **Exit criterion:** no exponential-backoff retry helper outside `data/rpc.ts`'s viem transport; broadcast paths surface the error to the caller. |
| **Live-capital automation / strategy promotion** | No autonomous strategy-promotion or scheduled-trading surface exists in v1; the agent proposes, the human signs on-device. | **Exit criterion (import/call-graph via `madge`, `dependency-cruiser`, or `ts-morph` — NOT grep):** no scheduler/timer (`setInterval`/cron) has a value-moving symbol in its call graph. Paste-runnable, e.g.: `dependency-cruiser`'s `forbidden`-rule `reachable: true` check pinning `{from: <timer module>, to: <signing/broadcast module>}` as a violation; `madge --extensions ts --json src` plus a scripted reachability walk of its module graph; or a `ts-morph` script walking each `setInterval`/cron call site's containing function for a reachable call to a signing/broadcast symbol. The value-moving surface is the signing/broadcast path — `sendTransaction`, `broadcastSolanaTx`, `sendTronTransaction`, any `prepare_*` builder, `finalize_*_psbt` broadcast — **NOT** `src/modules/strategy` (verified advisory: `share_strategy`/`import_strategy` project+redact portfolio JSON, module header "No on-chain side effects, no signing, no broadcast"). A bare `grep setInterval` is holed — it false-matches the two legitimate read/ping pollers (oracle poller → Solana RPC read; WC keepalive → relay ping, §4) and would false-GREEN. The call-graph check goes RED only if a timer's reachable-symbol set ever includes a signing/broadcast symbol; GREEN for the current two pollers. (Lint-tooling absence is a gap, not a non-goal — it is the INV-T1 lint-rule convergence unit, §4/§8, not a defended boundary.) |

---

## 2. Requirements & constraints

No `SPEC.md` exists. Every driving number below is `ASSUMED:` and is a doc defect to route to the product owner (PROD). Each is judged as a stand-in requirement (MEETS/FAILS the design that rests on it). Nothing downstream may treat an `ASSUMED:` value as settled.

### Trust boundary (the one constraint that is NOT assumed — it is grounded in code, §3)

- **Agent context = UNTRUSTED.** Prompt-injectable. May request any tool with any args.
- **MCP server = the enforcement boundary.** `assertTransactionSafe`, the handle store, the demo gate, the canonical-dispatch allowlist all live here and reason about raw calldata independent of any agent-supplied description.
- **Ledger device screen = the final human-verification boundary.** What the user approves on-device is the last line; the server's job is to make on-screen intent match built intent (payloadFingerprint / previewToken binding).
- **WalletConnect peer = UNTRUSTED.** Peer-pin mismatch is a non-blocking warning only; on-device approval is the trust root (recon @ c1b373a, `walletconnect-peer-pin.ts`).

### Driving numbers (all ASSUMED — PROD intake asks)

| # | Constraint | ASSUMED value | Rests on | Verdict |
|---|---|---|---|---|
| R1 | Read-tool (`get_*`/`list_*`) p95 latency, interactive path | ≤ 3 s | §4 amplification table; O(1)-round-trip-per-chain reads | **structurally plausible, UNMEASURED** — readers are multicall-batched O(1) round-trips per chain (recon: `positions/aave.ts`, `positions/uniswap.ts`, `balances/index.ts`), but **no p95 has been timed on the live path**; the verdict is a round-trip count, not a measurement (circular). Convergence: p95 latency bench (§8). |
| R2 | `prepare_*` p95 latency | ≤ 8 s | chain reads + `simulateTx` eth_call + build | **structurally plausible, UNMEASURED** — no p95 timed. Rests on R6 (no untimed transport) AND on the viem retry backoff being bounded (`data/rpc.ts` `retryCount 4` / `retryDelay 700` ≈ 10.5 s worst-case backoff, **no per-attempt timeout pinned** — §4). The Solana/4byte timeout gaps (§4) put a possible hang on this path today. |
| R3 | `preview_send` p95 latency | ≤ 10 s | `assertTransactionSafe` + `simulateTx` + gas pin + WC account-match | **structurally plausible, UNMEASURED** — no p95 timed; same R6 + viem-backoff caveats as R2. |
| R4 | `send_transaction` device-wait ceiling | ≤ 120 s hard | human-in-the-loop device approval, not a compute budget | **MEETS** — checks a real enforced constant `WC_SEND_REQUEST_TIMEOUT_MS` ~120 s with late-broadcast probe (recon: `walletconnect.ts`). A structural falsifier for a hard ceiling, not a circular latency claim. |
| R5 | Worst-case external HTTP calls per single read-tool invocation | ≤ 50 (concurrency-capped 10) | schema cap × per-item fan-out | MEETS for `get_transaction_history` (schema `.max(50)`); **FAILS** for `get_daily_briefing` (composite ~371, §4 F5) and `resolveSelectors` (unbounded, §4). |
| R6 | Every process/network-boundary call carries an explicit in-code timeout | 100% of tool-reachable transports | robustness invariant (§4) | **FAILS today** — Solana `Connection` and `4byte.directory` are untimed (§4). Convergence targets. |
| R7 | Default (unconfigured) install tool count | **≤72 tools** — curated-CORE-by-default flip: default chain families = `{evm}`, default protocols = ∅; other families/protocols opt-in via `VAULTPILOT_CHAIN_FAMILIES`/`VAULTPILOT_PROTOCOLS` | per-turn schema-text budget the host pays every turn | **SETTLED** — PROD adjudicated on #721; implementation tracked at #733. A real target now, no longer OPEN. |
| R8 | Default (unconfigured) install host-visible schema text | **PENDING #719** — set once #719's real `tools/list` bench measures actual payload (schema + inputSchema JSON) + headroom | context cost | **PENDING MEASUREMENT** — the ~227 KB desc-only figure (recon @ c1b373a, §6) was rejected as an unprovable proxy (it omits inputSchema JSON). No KB number is asserted here; #719 sets the budget from a live measurement. |
| R9 | Module cohabits >1 named responsibility (god-module smell) | structural, not numeric | deep-modules / one-responsibility (§5) | **FAILS structurally** — `execution/index.ts`, `render-verification.ts`, `types/index.ts` each cohabit multiple unrelated responsibilities (§5). Recon line counts (4013 / 2850 / 1871 L @ c1b373a) are EVIDENCE of bloat, not the gate. |
| R10 | Cross-chain dispatch is a conditional chain rather than a per-chain table/registry | structural | data-model-before-logic (§5.3) | see §5.3 — the render layer's per-chain logic is ~50 already-separated functions, not one big switch; the real target is grouping them into per-chain modules behind a thin dispatch (recon @ c1b373a: exactly one `switch`, Solana-internal, not cross-chain). |
| R11 | `types/*` not split by named domain | structural | one-fact-one-home (§5.4) | **FAILS structurally** — `types/index.ts` holds chain consts + position shapes + tx shapes + device entries + config with no internal boundary (recon: 59 exports / 1871 L @ c1b373a — evidence, not gate). |
| R12 | Handle-store TTL (prepare → send binding window) | 15 min (current) | replay/immutability window (§3) | MEETS — `TX_TTL_MS` 15 min, lazy prune (recon: `tx-store.ts`). Flag R12 to PROD: confirm 15 min is the intended UX ceiling. |
| R13 | Externally-metered-dependency spend alarm | present per 24/7 dependency | metered-resources canon | **UNKNOWN** — no usage/spend alarm found in recon; PROD must state whether a 24/7 deployment is in scope. Two always-on `setInterval` loops exist (§4): the oracle poller (metered Solana RPC each tick) and the WC keepalive (relay ping); the poller is the metered-spend concern. |

**R7/R8 note.** R7 (tool count) is now SETTLED — PROD adjudicated #721 to a ≤72-tool curated-CORE default (impl #733); see the R7 row for the number. R8 (schema bytes) stays PENDING #719's real `tools/list` bench — this doc still asserts no KB number for it.

**R1/R2/R3 note.** All three latency verdicts rest on static round-trip counting, not any live-measured p95 — the same code-shape that set the target certifies it, which is circular. They are relabelled UNMEASURED and the p95 latency bench (§8) is the convergence unit that would make them measurable. R4 is the exception: it checks an enforced hard-ceiling constant, a legitimate structural falsifier.

---

## 3. Trust model & the pre-sign safety spine

This is the security centerpiece. Every item is a **preserved invariant** named by its enforcing **symbol/module** — the normative anchor is the named symbol (`assertTransactionSafe`, `runEvmPreSignGuards`, `previewSend`, `sendTransaction`, `issueHandles`, `applyCustomCallClassifier`, …), never a raw line number. Line numbers self-invalidate under the §5.2 decomposition that moves these very files, so **every `Lxxxx` in §3 is a `recon @ c1b373a` evidence pointer, not a normative anchor.** Citations were spot-checked against live code at `c1b373a`; the check was not exhaustive — one omission the recon missed is called out in §3.2 (the `transferFrom` recipient gap).

### 3.1 `assertTransactionSafe` — the 5 ordered blocks

`src/signing/pre-sign-check.ts` (375 lines). `assertTransactionSafe(tx)` at L197 reasons about **raw calldata alone** — it never trusts a `prepare_*` tool's human description. Ordered blocks:

- **B1 — native-send pass / short-calldata refuse.** `tx.data ∈ {0x, 0x0, 0x00}` returns immediately (L200); `data.length < 10` (no selector) refuses (L204).
- **B2 — `approve()` spender-allowlist.** L216-280. Requires `dest` recognized (L217) and `dest.kind ∈ {known-erc20, lido-stETH, weth9}` (L225-229, approvals target tokens not protocol contracts). Decodes spender/amount. **Revoke carve-out:** `amount === 0n` returns early (L254, issue #305 — a zero allowance grants no authority). Else `buildSpenderAllowlist(chain)` (L255, protocol contracts only). **Ack escape:** `tx.acknowledgedNonAllowlistedSpender === true` returns (L266).
- **B3 — `transfer()` on recognized-token-only.** L285-296. `dest.kind ∈ {known-erc20, lido-stETH, weth9}` or refuse.
- **B4 — catch-all unknown-destination refuse.** L315-334. Any non-recognized `dest` with non-empty calldata refuses — "exactly the shape of a prompt-injection attack." **Bypassed** by `tx.acknowledgedNonProtocolTarget === true || tx.safeTxOrigin === true` (L316-324).
- **B5 — per-destination ABI-selector check.** L338-374. For a recognized `dest` with a curated ABI, the 4-byte selector must be a function on that ABI. **LiFi Diamond is the explicit exception** — `allowedAbi === null` returns immediately (L338, see 3.4). **B5 runs ONLY on the recognized-`dest` path:** the `if (!dest)` branch (B4) either returns via an ack (L323) or throws (L325) before control can reach L336, so **no ack flag reaches B5** — an ack-stamped `prepare_custom_call` to a *recognized* destination with a bogus selector is still REFUSED here.

**Ordering invariant + precise ack→block mapping.** B2/B3 (approve/transfer) are decided by *selector* before the destination-class catch-all (B4) and the ABI check (B5). Each ack flag opens **exactly one block** — the mapping is per-flag, not a shared "acks open B4/B5":
- `acknowledgedNonAllowlistedSpender` → opens **only** B2's spender-allowlist *membership* check (L266). It does NOT relax B2's `!dest` refuse (L217) or the token-kind refuse (L225-229), and touches no other block.
- `acknowledgedNonProtocolTarget` / `safeTxOrigin` → open **only** B4 (the `if (!dest)` catch-all, L317-318), for an *unrecognized* destination.
- **No flag opens B5.** B5 is unreachable on the ack's `!dest` path (control returned at L323) and un-consulted on the recognized-`dest` path (the ack fields are never read there). Grounded in the stamp site's own comment: `built.acknowledgedNonProtocolTarget = true` "skips ONLY its catch-all 'unknown destination' refusal" (`execution/index.ts` L2846-2848).

**Resolves the recon/CLAUDE.md conflict:** the project CLAUDE.md "Pre-Sign Gate Surface Sweeps" / "Per-protocol cutoff" threat-model phrasing — *"blocks 4 AND 5 are bypassed for ack-stamped `prepare_custom_call`"* — is imprecise. The ack opens **B4 only**; B5 is never bypassed. (This doc reflects B4-only; the project CLAUDE.md text is corrected separately.) **Exit criterion:** `test/pre-sign-check.test.ts` keeps a positive+negative pair per block AND an explicit "ack opens B4 only — a recognized-`dest` call with a bogus selector under an ack is still REFUSED by B5" test; removing any single block, or making any ack flag reach B5, goes RED.

### 3.2 The ack-flag trust root (blocking invariant)

Three server-stamped flags bypass parts of the gate. Their safety rests entirely on **where they come from**, per the "state each ack flag's trust source" rule:

| Flag | Bypasses (block, precise) | Trust source (what makes the bypass safe) |
|---|---|---|
| `acknowledgedNonAllowlistedSpender` | B2 spender-allowlist *membership* check only | Stamped by a `prepare_*` tool (`curve/actions.ts` L464) only after the user passed a schema-enforced `acknowledgeNonAllowlistedSpender: true`; flows through the server-minted handle, never agent input. |
| `acknowledgedNonProtocolTarget` | B4 catch-all only (never B5, §3.1) | **TWO stamp sites with DISTINCT trust roots — an audit/decomposition must treat both:** <br>• **`prepareCustomCall`** (`execution/index.ts` L2848) — trust root is the build-time ack gate + the `applyCustomCallClassifier` exfil check. <br>• **`prepareCurveSwap`** (`curve/actions.ts` L412) — trust root is **`ensureSupportedCurvePool`** (a curated-pool check restricting `pool` to legacy stETH/ETH or a `stable_ng` factory plain pool, issue #626), **NOT** the custom-call exfil classifier. **OPEN ITEM (no SEC seat):** whether `ensureSupportedCurvePool` is a sufficient trust root to license the B4 bypass has no security-reviewer to adjudicate — flagged, not resolved. <br>**CAVEAT — custom-call classifier recipient gap** (`security:transferfrom-recipient-unchecked`, CONFIRMED — custom-call site only): the classifier's `transferFromSelfAsFrom` is computed from `args[0]` (the `from`) only (`modules/custom-call/actions.ts` L132-135) — a `transferFrom` whose `from == wallet` is refused outright as value-exfil through a pre-existing approval (no bypass; there is no legitimate self-pull flow, L127-131) — but the recipient `args[1]` (`to`) is **never inspected**, so `transferFrom(from=X≠wallet, to=ATTACKER)` falls outside the self-pull flag and its recipient rides through unchecked. ARCH files this as a security convergence unit (§8). |
| `safeTxOrigin` | B4 catch-all only (never B5, §3.1) | Stamped by the Safe builders (`safe/actions.ts` L91, `safe/execute.ts` L212); the OUTER calldata is always `approveHash`/`execTransaction`, which carries no transferable authority on its own (see 3.5). |

**The single load-bearing invariant the entire bypass system rests on** (`security:presign-ack-trust-root`, blocking): these flags are **NEVER accepted as agent input.** `send_transaction` / `preview_send` take only an **opaque `handle` string**. The tx-with-flags is stamped by server code and stored in a UUID-keyed in-memory `Map` by `issueHandles` (`tx-store.ts` L123-150); the agent gets back only the handle (the stored value even strips the handle key, L145). `consumeHandle` (L163) is a non-destructive peek; `retireHandle` (L180) deletes on successful submit; TTL 15 min (`TX_TTL_MS`).

> **Convergence guardrail (do NOT drift):** any future tool that accepts a caller-supplied tx object, or exposes any of these flags in an input schema, collapses every catch-all/selector defense behind one forgeable boolean. **Exit criterion:** no tool input schema in `src/index.ts` contains `acknowledgedNonProtocolTarget`, `safeTxOrigin`, or `acknowledgedNonAllowlistedSpender`; `send_transaction`/`preview_send` accept only `{handle, previewToken, userDecision, …}`, never a raw `tx`.

> **Classifier-specific exit criterion** (`security:transferfrom-recipient-unchecked`): a regression test asserting a `transferFrom` custom call is ack-bypassable **only when its recipient (`args[1]`) equals the wallet** — `transferFrom(from=X, to=ATTACKER)` with `to≠wallet` must be REFUSED or non-ack-bypassable, checked **independently of the schema-absence check above**. RED today: the recipient is unchecked, so an arbitrary `to` currently passes the ack bypass.

### 3.3 Guards run at preview, NOT at send (important invariant)

`runEvmPreSignGuards` (`execution/index.ts` L3027) = `verifyChainId` (L3028) + `assertTransactionSafe` (L3029) + `simulateTx` (L3030) + WC account-match + payload-hash recheck. It is invoked **ONLY** from `previewSend` (L3194) and tests. The EVM `sendTransaction` path (L3373-3516) does `getPinnedGas` (L3417) → `previewToken` match (L3450) → `consumeHandle` (L3480) → forward to WC → `retireHandle` (L3516). **It never re-runs the gate or simulation.** The cached-pin branch of `previewSend` (L3171-3189) also returns without re-running guards.

Send-time safety therefore rests on two facts that ARE enforced, plus one commonly-assumed property that is **NOT** enforced today:

- **(a) the agent cannot substitute a tx.** `send_transaction`/`preview_send` take only the opaque handle; the tx-with-flags lives server-side, keyed by `randomUUID` in `issueHandles`. The agent never holds the tx object, so it cannot swap it — this, not immutability, is why a substitute tx cannot be sent.
- **(b) the previewToken + gas-pin binding.** The send path refuses with "Missing pinned gas … Call `preview_send(handle)` first" (`getPinnedGas` in `sendTransaction`, recon @ c1b373a L3417-3420) unless `preview_send` ran the guards and pinned gas for THIS handle, and the `previewToken` equality check binds the pin to the previewed tx. This is the real send-time guarantee.
- **(c) NOT enforced — deep immutability of the stored tx.** `issueHandles` stores the tx via a shallow spread into a plain `Map` with **no `Object.freeze`** (verified — no freeze in `tx-store.ts`); nested fields are shared by reference and `consumeHandle` returns the live object by reference. The EVM `sendTransaction` path does **no** send-time content re-check between `consumeHandle` and the WC forward. So "the stored tx is immutable" is an ASSUMPTION the code does not perform; today it holds only because no path mutates it and the agent cannot reach it — there is no refusal that would fire if it were mutated.

> **Exit criterion for (a)+(b) — already enforceable:** a `send_transaction` whose `previewToken` does not match the stored pin, or which has no pinned gas, MUST be REFUSED; `test/preview-token-gate.test.ts` + `test/send-hash-pin.test.ts` (recon, tests dim) go **RED** if the `previewToken` equality check or the "Missing pinned gas" backstop is removed. Silent-failure surface: a future send path that skips preview bypasses the whole gate with no error.
> **Convergence target for (c)** (`security:tx-store-deep-freeze`, to-be-added — a real security-spine improvement, ARCH is filing it, §8): add a deep `Object.freeze` in `issueHandles` AND a regression test that mutates a stored tx between preview and send and asserts the send uses the **pre-mutation** values — RED without the freeze. The immutability invariant is stated here as this **to-be-added** test, NOT as an already-passing one.

### 3.4 REVIEW-FLAGGED: LiFi Diamond bypasses B5 while on the spender allowlist

`classifyDestination` returns `{kind:"lifi-diamond", allowedAbi:null}` (L148); B5 returns immediately on `allowedAbi===null` (L338) — so **any** selector/calldata to `LIFI_DIAMOND` passes B5. `LIFI_DIAMOND` is also in `buildSpenderAllowlist` (L187), so `approve(LiFi,…)` passes B2. The address is a **hardcoded lowercase literal** (L41), not sourced from `CONTRACTS` like every other pinned destination.

**Bypass condition:** `tx.to === LIFI_DIAMOND`. **Stated rationale:** LiFi's ABI is huge/dynamic; full trust in one address for arbitrary calldata is the accepted-risk trust anchor. **This is the widest hole in the selector gate.** *This doc does not declare it safe or unsafe.* It is flagged for security review; the fleet has **no SEC seat** to give that judgment. Convergence must not silently widen or narrow it. **Exit criterion:** `LIFI_DIAMOND` remains the sole `allowedAbi:null` destination; any second such destination is a review trigger.

### 3.5 REVIEW-FLAGGED: Safe `execTransaction` skips B4 though inner op may be DELEGATECALL

`buildExecTransactionTx` stamps `safeTxOrigin=true` (`safe/execute.ts` L212) on an OUTER call to the user's Safe (`to = safeAddress`), skipping B4. The inner `SafeTx` body may be `operation === 1` (DELEGATECALL, L38/L188/L204), surfaced **only** in the human description string (`⚠ DELEGATECALL`). The pre-sign gate does not inspect or gate the inner call; safety rests on the Safe's owner-threshold signatures and the upstream `safeTxHash` binding.

**Bypass condition:** `tx.safeTxOrigin === true` on a Safe `execTransaction` whose inner `operation === 1`. Correct by Safe design, but load-bearing and non-obvious. *This doc does not declare it safe or unsafe* — flagged for the absent SEC seat. **Exit criterion:** `safeTxOrigin` is stamped only by the Safe builders (`safe/actions.ts`, `safe/execute.ts`); the DELEGATECALL surfacing in the description string is preserved.

### 3.6 Demo-mode broadcast gate (important invariant)

Under `VAULTPILOT_DEMO=true`, `send_transaction` can **NEVER** reach the real broadcast handler. Routing to the simulation envelope is a **3-predicate chain** in the `registerTool` dispatch closure (`src/index.ts`), not `isBroadcastTool` alone: (1) `isDemoMode()` true (L1133 — a non-demo call passes straight to `realHandler`); (2) the tool is conditionally-gated and NOT always-gated (`isConditionallyGatedTool(name)` true at L1135, after the `isAlwaysGatedTool` refuse at L1134); (3) `isBroadcastTool(name)` true (L1160) → `return broadcastSimulationDispatch(name, args, realHandler)` (L1161). A demo sub-mode branch sits between (2) and (3): in default demo mode (`!isLiveMode()`) a non-`prepare_*` tool like `send_transaction` is refused outright via `refuseDefaultMode` (L1153); only the live-persona demo sub-mode reaches the broadcast branch. `broadcastSimulationDispatch` (L1182) takes `_realHandler` (L1187) and **never invokes it** (L1177 comment: "realHandler is unused here on the broadcast path because we never…") — it re-simulates via the tx-store handle and returns a simulation envelope. Both demo paths (default-refuse and live-persona-simulate) keep the real broadcast handler unreachable. **Exit criterion:** a test asserting the real broadcast handler is unreachable under demo mode — a mutation making `broadcastSimulationDispatch` call `_realHandler` goes RED. (Minor: the demo path re-issues a fresh handle without retiring the original — a duplicate store entry, demo-only leak, `security:presign-demo-duplicate-handle`; fix in the convergence backlog, not a spine defect.)

---

## 4. Transport & robustness invariants

Cross-cutting rules every external call obeys, each with a falsifiable check. The repo has a **strong timeout culture** — `data/http.ts` `fetchWithTimeout(url, init, 10000)` (AbortController, 10 s default) is the load-bearing cap across TRON/BTC/LTC/DefiLlama/NFT/yields/Etherscan/history (recon, robustness dim). The invariant is universal; the two gaps below are convergence targets, not exceptions to it.

### INV-T1 — every tool-reachable transport carries an explicit in-code timeout

**Target:** NO raw `fetch(` and NO untimed SDK client sits on any tool path; every transport routes through a timeout-enforcing wrapper.

Two grounded gaps (both CONFIRMED against live code):
- **Solana `Connection` — untimed (blocking, `robustness:solana-conn-no-timeout`).** `modules/solana/rpc.ts` `getSolanaConnection()` builds `new Connection(url, {commitment:"confirmed", fetch: fetchWithRateLimitDetect})`. The shim `fetchWithRateLimitDetect` does `await fetch(input, init)` with **no AbortSignal, no timeout** — every Solana RPC call, **including `broadcastSolanaTx`**, can hang indefinitely. This is the single largest robustness gap; the oracle poller (below) funnels through it. (`robustness:solana-conn-cache-race` — **RESOLVED, non-issue; do not relitigate.** `getSolanaConnection()` rebuilds `cachedConnection` when the resolved URL changes, but the cache-check → rebuild path is fully synchronous — no `await`/yield point sits between the `cachedConnectionUrl === url` check (L146-148) and the `new Connection(...)` rebuild (L152-157) — so on JS's single event loop the URL swap cannot interleave with an in-flight call; that call holds its already-dereferenced `Connection` reference, which stays valid after the module-level variable is reassigned. No race. Verified against `origin/main`; adjudicated and #713 CLOSED. A guard test (PR #728) keeps this RED-safe if a future async gap is ever introduced between the check and the rebuild — see §8.)
- **`4byte.directory` — untimed on the pre-sign path (blocking, `robustness:fourbyte-no-timeout-presign`).** `data/apis/fourbyte.ts` (19 lines) `defaultFetch = (url) => fetch(url)` — raw, no timeout — reachable unguarded from `signing/verify-decode.ts` (pre-sign calldata cross-check) and `modules/history/decode.ts`.

**Exit criterion (structural lint rule, NOT a grep — `robustness:lint-ban-bare-fetch`, to be added as a convergence unit):** an ESLint rule bans bare `fetch(` / `globalThis.fetch` outside `data/http.ts`, OR requires every exported fetch-wrapping function to thread an `AbortSignal`. **A substring grep does not work here and must not be used as the gate:** the `const f = fetchOverride ?? globalThis.fetch; f(url)` aliasing idiom (live in `nft/helius-das.ts` and `shared/version-check.ts`) evades any `fetch(` match by identifier-aliasing, and a bare `fetch(` grep also floods with SDK-method noise (`MarginfiClient.fetch()`, `MarginfiAccountWrapper.fetch()`). The target is structural: every transport routes through a timeout-enforcing wrapper, enforced by lint rule X — specifically `modules/solana/rpc.ts`'s shim must carry an `AbortSignal` and `data/apis/fourbyte.ts` must route through `fetchWithTimeout`. (`data/rpc.ts` viem `http()` sets `retryCount: 4` / `retryDelay: 700` — up to ~10.5 s of exponential backoff — with **no per-attempt request timeout pinned** (recon @ c1b373a L214-215); pin an explicit per-attempt timeout, `robustness:viem-timeout-implicit`. This backoff is a **second untimed latency risk** on the prepare/preview path, feeding the now-UNMEASURED R2/R3.)

### INV-T2 — upstream error objects are never serialized verbatim into tool responses

Secrets (Infura/Alchemy keys) live in RPC URLs and leak via error text. **Target:** every upstream error (RPC/SDK/HTTP) is mapped to a stable, non-revealing shape before it reaches an MCP response.

**Grounded gap (`robustness:error-msg-leaks-api-key`, CONFIRMED).** `shared/error-message.ts` `safeErrorMessage` / `stringifyOwnProps` (95 lines) walk an error's own enumerable props (`code`, `data`, `cause`, …) and JSON-stringify them, but perform **no redaction of URL-embedded API keys.** A viem/web3 error whose `.message` or nested `.cause` carries the key-bearing RPC URL is surfaced verbatim through the single MCP error boundary (`index.ts` `handler()` wrapper). This is the FAILURE-path leak the security-by-default canon names ("where a secret is stored does not tell where it is emitted").

**Exit criterion (positive falsifier — goes RED when the leak is present):** a test that triggers an RPC error carrying a key-bearing URL (e.g. `https://mainnet.infura.io/v3/DEADBEEF…`) through a tool and asserts the key substring is **absent** from the tool response. The test must fail if the redaction step is removed. (Also flag: `permissions.ts`/`verification.ts` catch blocks conflate RPC failure with negative result, under-reporting admin roles during an RPC blip — `robustness:permissions-rpc-conflation`.)

### INV-T3 — every external-input loop / fan-out has a named bound; every read tool's amplification factor is named

Per the "name the amplification factor" canon: requests-per-minute × concurrent users × O(N) data terms.

| Read tool | Amplification factor (worst case) | Bound | Verdict |
|---|---|---|---|
| `get_token_balance` / `get_token_metadata` | 1 multicall (≈3 calls) | O(1) | MEETS |
| `get_portfolio_summary` | W wallets × ≤5 EVM chains × ~8 protocol readers, **each O(1) multicall round-trip**; Morpho discovery OFF by default (~300 chunked `eth_getLogs`/wallet/chain when `VAULTPILOT_MORPHO_DISCOVERY` on) | round-trips O(1) per chain; payload grows with position count; **latent:** unbounded NFT count per LP wallet | MEETS (the one N+1, Morpho discovery, is off-by-default and self-documented) |
| `get_transaction_history` | 3 Etherscan calls + up to 50 DefiLlama historical-price calls | schema `.max(50)`, concurrency 10 (F4) | MEETS |
| `get_daily_briefing` | `readActivityCounts` fans out one `getTransactionHistory` per EVM chain (≤5) + TRON + Solana, each `limit:50` → **~7 × (3+50) ≈ 371 external calls** | **NOT capped as a composite (F5)** | **FAILS** — target: a named composite cap on the briefing fan-out. |
| `resolveSelectors` (history decode) | unbounded, untimed `Promise.all` over every unique 4byte selector in a batch | **none (`robustness:history-decode-fanout`)** | **FAILS** — target: bound by the batch's schema cap + route through `fetchWithTimeout`. |
| `compare_yields` | 1 shared DefiLlama pools payload (cached 10 min) + per-protocol risk enrichment (~10, cached) | well-bounded | MEETS |

**Exit criterion:** this table's worst-case number is re-derivable per tool; `get_daily_briefing` and `resolveSelectors` acquire a named constant + overflow behavior (the two FAILS become MEETS). Reference bounded-loop pattern to preserve: `btc/indexer.ts` `getRecentBlocks` (`want = min(…,200)`, three independent loop exits — `robustness:btc-indexer-pagination-ok`).

### INV-T4 — metered/RPC reads are schedule-driven where 24/7, request-driven only for O(1) fresh reads

Origin-of-call is the boundary, not caller identity. **Target:** no mount/timer/auto-refresh originates a metered call; explicit user action may hit a metered dependency only for genuinely fresh O(1) data.

**Two always-on `setInterval` loops** (the only always-on timers in the repo; a third `setInterval` mention at `src/index.ts` L6257 is prose on the `startOraclePoller()` call site — noting the interval's `unref()` and the 24h rolling-median persistence, both already covered under "Oracle poller" below — not an independent loop):
- **Oracle poller** — `modules/incidents/oracle-poller.ts` `startOraclePoller()`, a 60 s interval over a fixed `KNOWN_PYTH_FEEDS` list. **Two grounded requirements** (`robustness:oracle-poller-overlap`, CONFIRMED): (a) **no in-flight overlap guard** — a slow tick can stack on the prior tick; (b) each tick funnels through the untimed Solana `Connection` (INV-T1), so one hung tick can wedge the poller. **Exit criterion:** the poller carries an in-flight boolean/skip-if-running guard AND its Solana calls are timed; a test that stalls one tick asserts the next tick is skipped, not stacked. Filed as a convergence unit (§8).
- **WalletConnect keepalive** — `signing/walletconnect.ts` `startKeepalive()` (`KEEPALIVE_INTERVAL_MS` = 30 s), running for the life of any paired WC session. **COMPLIANT — no unit owed:** each tick calls `probeSessionLiveness`, which carries its own `PING_TIMEOUT_MS` = 5 s bound (recon @ c1b373a), so a hung tick cannot wedge it, and the timer does not block clean process exit. Named here so both always-on loops are accounted for.

Also record R13 (spend alarm) as the missing companion for any 24/7 deployment; the metered-spend concern is the oracle poller, not the WC keepalive (relay ping, not a metered RPC quota).

**In-memory cache bound (`reads:F6`).** `data/cache.ts` `TTLCache` is `Map`-backed with lazy-on-`get` expiry, **no LRU / no key-count cap** — a long-lived process serving many wallets accumulates an ever-growing map (30-day historical-price keys are the worst). **Target/exit criterion:** a max-key-count or size bound with a defined eviction (drop-oldest/LRU) on overflow. Never cache a safety/authorization verdict over a mutable fact — **the `SECURITY_*`-prefixed long-TTL categories were adjudicated (call sites read) and CLOSED as compliant**, not punted: `SECURITY_PERMISSIONS` (1 h) caches the Aave Pool address + `getUserAccountData` aggregates (a position READ); `SECURITY_VERIFICATION` (24 h) caches Etherscan contract-info (isVerified/isProxy/abi). These cache **facts, not authorization verdicts**, and none sits on the signing path — compliant with the canon, no security-reviewer flag owed. Standing note: any FUTURE cache added on the signing path must re-run this fact-vs-verdict check before it lands.

---

## 5. Module architecture (target)

The simplified target module map. Each item: current-state evidence (`recon @ c1b373a`) + a TARGET as a falsifiable **structural** check — never a line/export/arm count. The organizing principle is **deep modules with small interfaces**: the goal is not "smaller files" for their own sake but ending the cohabitation of unrelated responsibilities behind one edit surface. R9/R10/R11 are **demoted from exit criteria to non-binding evidence**: recon line/arm/export counts appear below only as EVIDENCE of current bloat (`recon @ c1b373a`), never as the gate — a module passes when it stops cohabiting unrelated responsibilities, whatever its line count.

**Drift-catching exit criterion (applies to every §5 decomposition unit — §5.2/5.3/5.4).** The structural falsifiers below each verify the *one-time* split (a named symbol resolves to its target module); none of them goes RED when a module later **re-accumulates** responsibility — the exact drift the §Pin "goes RED when code drifts off target" promise must catch. Pair each one-time check with a per-module **EXPORT-ALLOWLIST**: each target module declares its permitted export surface (an explicit allowlist enforced by a structural test / lint rule), and any new export outside that allowlist — a re-accumulated responsibility landing back in the module — fails the check. The one-time structural check proves the split happened; the export-allowlist keeps it from silently un-happening.

### 5.1 UTXO chain unification (BTC/LTC Esplora indexer)

**Evidence.** `modules/btc/indexer.ts` (708 L) and `modules/litecoin/indexer.ts` (676 L) are ~90% duplicated Esplora clients — the LTC file's own header says "Mirror of src/modules/btc/indexer.ts — same Esplora API surface, same retry policy, same field shapes; only the default URL and user-config field name differ" (recon @ c1b373a). Token-normalized diff: 168 changed lines of ~700. **The precedent already exists:** `modules/utxo/rpc-client.ts` (140 L) is a chain-agnostic Bitcoin-Core-RPC client used by BOTH `incidents/chain-utxo.ts` and `execution/index.ts` — the RPC-forensics layer got the shared-adapter treatment the Esplora indexer never did.

**Target.** One parametrized Esplora client — `modules/utxo/esplora-client.ts` — taking chain (`btc`|`ltc`) as a parameter (default URL + config-field-name injected). BTC/LTC tool families become chain-parameterized, not verb-duplicated. **Asymmetry to PRESERVE, not flatten:** `BitcoinIndexer` exposes `getTx(txid)` (recon @ c1b373a — interface L221, impl L549) that `LitecoinIndexer` **lacks**; it backs the BTC RBF fee-bump builder. The parametrized client must keep `getTx` available for BTC — do NOT drop or stub it to force a symmetric interface. The related LTC RBF capability gap (below) is a CONNECTED item (LTC could later gain the tool + `getTx`), not part of this dedup.

**Preserve as a DECISION RECORD, not dup to delete:** the LTC **signer** divergence. `ltc-usb-signer.ts` (1073 L) is ~95% structurally identical to `btc-usb-signer.ts` (843 L) EXCEPT the issue-#240 legacy-API fallback (`signLtcPsbtViaLegacyApi` L754, `encodeVarInt` L695, ~230 lines) triggered by string-matching the SDK error "signPsbtBuffer is not supported with the legacy Bitcoin app" (L678, verified). This is a load-bearing divergence for Ledger's Litecoin app v2.4.11 — **do not merge it away.** (The string-match trigger is itself fragile — `signing:ltc-legacy-fallback-string-match`, CONFIRMED bug — but that is a robustness fix, not a merge.)

**Falsifiable target.** Exactly one Esplora client module with a chain parameter; no structural twin of `btc/indexer.ts` under `litecoin/`; `getTx` remains reachable for BTC. The signer files stay two, with the divergence documented here. (**Connected, NOT part of the dedup** — the LTC capability gap: LTC carries `rbfEligible` plumbing but registers no `prepare_litecoin_rbf_bump`, and has no lifi-swap/multisig — `nonevm:litecoin-capability-gap`. Target: either register the tools or state the gap as intentional in §7. Do not conflate closing this gap with the indexer dedup.)

### 5.2 `execution/index.ts` decomposition (the god module)

**Evidence.** `modules/execution/index.ts` (4013 L) + `schemas.ts` (2512 L) cohabit 6+ unrelated responsibilities in one file (recon @ c1b373a, `evm:execution-god-module`, important):
1. Ledger pairing across 5 chains (`pairLedgerLive/Tron/Bitcoin/Solana/Litecoin`);
2. BTC/LTC RPC + balance/UTXO/mempool/rescan + multisig PSBT;
3. Solana lending/staking/swap prepare + send pipeline (`sendSolanaTransaction`);
4. TRON send + swap prepare;
5. EVM `prepare_*` handlers (thin delegates to per-protocol action modules);
6. EVM-only preview/send pipeline (`runEvmPreSignGuards`, `previewSend`, `sendTransaction` — the §3.3 spine);
7. **cross-chain** status/verification dispatch (`getTransactionStatus`, `verifyTxDecode`, `getVerificationArtifact` — each branches tron/EVM/Solana, recon @ c1b373a L3527 / L4000 / L3849; these are NOT EVM-scoped and must not fold into the EVM send-pipeline).

**Target — decompose along those named seams:**

| Responsibility | Target module |
|---|---|
| Ledger pairing (5 chains) | `modules/pairing/index.ts` |
| EVM preview/send pipeline (the §3.3 spine) | `signing/send-pipeline.ts` (co-located with the gate it enforces) |
| Cross-chain status/verification dispatch | `signing/status-dispatch.ts` + `signing/verification-artifact.ts` (compose the per-chain status/verify modules; NOT folded into the EVM send-pipeline — each branches tron/EVM/Solana) |
| EVM `prepare_*` dispatch | `modules/evm-prepare/index.ts` (thin; per-protocol logic already lives in `modules/{aave,uniswap,lido,…}`) |
| BTC/LTC RPC + UTXO/rescan wrappers | fold into `modules/btc/` + `modules/litecoin/` (or the unified §5.1 layer) |
| Solana send pipeline | `modules/solana/send.ts` |
| TRON send pipeline | `modules/tron/send.ts` (partly exists — `sendTronTransaction`) |

**Trade-off (judged).** Decomposition adds ~7 files and one dispatch indirection. Tie to simplicity/context-cost and testability: the send pipeline (§3.3) is safety-critical and today cannot be tested without importing a 4013-line module (the exact heavy-import cost behind the `hookTimeout` flake, issue #691). Worth it — the added files are removable-by-editing-one-place; the indirection is a thin dispatch, not a new abstraction layer.

**Falsifiable target (structural AND spine-gated).** No single module cohabits >1 of {pairing, evm-send-pipeline, evm-prepare-dispatch, utxo-rpc, solana-send, tron-send} — with **one named allowed exception**: `signing/status-dispatch.ts` / `signing/verification-artifact.ts` legitimately compose per-chain status/verify modules; cross-chain dispatch IS their single responsibility, not a god-module relapse (this exception is named explicitly because live code already routes these three symbols across chains — a blanket "no module is multi-chain" assertion would be false on day one). `execution/index.ts` ends deleted or reduced to a thin re-export barrel; a structural test asserts each named symbol resolves to its target file. **AND — the decomposition is DONE only if ALL §3 spine falsifiers still pass AND still go RED-on-removal after the move:** the preview-token gate + gas-pin backstop (§3.3), the per-block `assertTransactionSafe` tests (§3.1), and the ack-flag tests (§3.2). This relocation splits the ack-flag STAMP sites from the ack CONSUME/gate site across new module boundaries. There are **TWO `acknowledgedNonProtocolTarget` stamp sites**, both of which the decomposition must keep gate-bound: `prepareCustomCall`'s `built.acknowledgedNonProtocolTarget = true` (`execution/index.ts`, recon @ c1b373a L2848) AND `prepareCurveSwap`'s `acknowledgedNonProtocolTarget: true` (`curve/actions.ts`, recon @ c1b373a L412, trust root `ensureSupportedCurvePool` — §3.2). A structural-only "symbol resolves to its new file" check is **NOT** sufficient to accept the move — the spine tests must be re-run and stay RED-on-removal, and a decomposition that moves *either* stamp away from its gate must keep the §3 falsifiers RED-on-removal for **both** stamp→gate splits.

### 5.3 `render-verification.ts` — data-model-before-logic

**Evidence (corrected).** `signing/render-verification.ts` (2850 L, recon @ c1b373a) composes render/verify blocks for EVM + Tron + Bitcoin + Litecoin + Solana. The file's real bloat is **~50 already-separated per-chain named render functions living in one file** — NOT one giant cross-chain switch: a live grep finds exactly **one** `switch` statement (`solanaActionLabel`, recon @ c1b373a L1588), and it is **Solana-internal** (action→label), not cross-chain dispatch. It also owns non-signing render helpers (`renderMissingSkillWarning`, `renderUpdateAvailableNotice`). (The prior draft's "branch-per-chain switch / RenderDescriptor replaces the switch" framing was wrong — there is no big cross-chain switch to flatten.)

**Target.** GROUP the ~50 per-chain render functions into **per-chain render modules** (`signing/render/{evm,tron,bitcoin,litecoin,solana}.ts`) behind a thin dispatch, and move the non-signing render helpers out to a render-utilities module. This is a co-location fix (per-chain logic into per-chain files), not a switch-to-table rewrite.

**Falsifiable target (structural).** Per-chain render logic lives in a per-chain module, not one 2850-L file; a structural test asserts each per-chain render entry point resolves to its chain module. NOT gated on a switch-arm count.

### 5.4 `types/index.ts` — split by domain

**Evidence.** `types/index.ts` (1871 L, 59 exports, no internal boundary) holds chain consts, per-protocol position shapes, security shapes, per-chain portfolio slices, per-chain UnsignedTx shapes, paired-device entries, and `UserConfig` — imported everywhere (recon, `infra:types-god-file`).

**Target.** Split by domain: `types/chains.ts` (SupportedChain/CHAIN_IDS), `types/positions.ts`, `types/tx.ts` (per-chain UnsignedTx), `types/devices.ts` (paired-device entries), `types/config.ts` (UserConfig). **Falsifiable target (structural).** Types split by named domain — chain consts, position shapes, tx shapes, device entries, config each own a file; a structural test asserts `types/index.ts` (if kept) is a re-export barrel with no domain type defined inline. NOT gated on an export or line count (the recon 59 exports / 1871 L is evidence of the bloat, not the gate).

### 5.5 min-out slippage math — one shared helper

**Evidence (verified, labels corrected).** Two slippage formulas are copy-pasted across the swap modules. The **exact-IN min-out floor** `(quotedOut * BigInt(10000 - bps)) / 10000n` — named `applySlippageExactIn` in live code (`uniswap-swap/index.ts`, recon @ c1b373a L136-138) — recurs at `curve/actions.ts` L134 and L366, `swap/index.ts` L635, `uniswap-swap/index.ts` L137. The **exact-OUT max-in ceiling** `(quotedIn * (10_000 + bps) + 9_999n) / 10_000n` — named `applySlippageExactOut` (`uniswap-swap/index.ts` L140-143) — recurs at `uniswap-swap/index.ts` L142 and `swap/index.ts` L967. (The prior draft had these two labels inverted — it called the first the "exact-out floor" and the second the "exact-in ceiling"; live code names them the opposite way.) This copy-paste is the recurrence surface for the #685-class priority-fee/slippage arithmetic bug.

**Target.** One shared helper — `modules/shared/slippage.ts` exporting `applyMinOut(expected, bps)` and `applyMaxIn(quoted, bps)`. **Falsifiable target:** exactly one implementation of each formula. Prefer a **lint/AST check** that flags the min-out/max-in arithmetic *shape* — `(x * (10000 - bps)) / 10000` and `(x * (10000 + bps) + 9999) / 10000`, in either `10000` or `10_000` separator spelling — anywhere except the shared helper. The prior grep was holed two ways and must not be used as-is: (a) it matched `10_000 +` but not `10000 +` (asymmetric numeric alternation misses the underscore-less exact-OUT ceiling), and (b) it scoped `{swap,uniswap-swap,curve}` but **not** `modules/shared/`, where the helper actually lands — so it could neither see the canonical copy nor catch a stray duplicate dropped there. If kept as a grep it MUST cover both separator spellings AND both operators AND include the helper's own directory, e.g. `grep -rnE '10_?000 *[-+]' src/modules/{shared,swap,uniswap-swap,curve}` returns exactly the two shared-helper definitions — any third hit is a duplicate. RED over a real duplicated formula.

### 5.6 Naming collisions (docs-drift — tracked in §8, not an architecture task)

Three same-basename directory pairs are NOT duplication — distinct layers: `src/shared` (server-wide infra) vs `src/modules/shared` (module business helpers); `src/security` (pre-sign GATE infra) vs `src/modules/security` (read-only research tools); `src/diagnostics` (dev/CI self-checks) vs `src/modules/diagnostics` (registered MCP tools). The fix (rename the module-scoped side or add a "not-a-duplicate-of" header) is comment-linting below §5's altitude; tracked as a docs-drift row in §8, not carried as a §5 architecture unit.

---

## 6. Tool surface & scoping (the context-cost lever)

**Evidence (verified).** A default, unconfigured install registers **all 189 tools every turn** (~227 KB of description+annotation text, recon @ c1b373a, excluding zod schema bodies) because `VAULTPILOT_CHAIN_FAMILIES` and `VAULTPILOT_PROTOCOLS` both default to "all": `parseFamilies(undefined)` returns all five families (`config/scope.ts` L73), `parseProtocols(undefined)` returns null = accept-all (L87). The `registerTool` wrapper calls `isToolEnabled(name)` and skips SDK registration when a tool's family/protocol is excluded — the mechanism exists and works; the **default** is maximal.

**Annotation coverage is already 100%** (189/189; the 191 raw `registerTool(` occurrences = 189 real `registerTool(server,` calls + the wrapper `function registerTool` + the inner `server.registerTool`). **Do NOT restate CLAUDE.md's stale "zero coverage" claim** — that is a known-stale ref. Keep the 100%-annotation invariant: **exit criterion** — `grep -c "registerTool(server," == grep -c "annotations:"` in `src/index.ts`.

**Product decision — ADOPTED (PROD #721).** The PROBLEM: a default, unconfigured install registers all ~189 tools every turn (measured ~227 KB schema text, recon @ c1b373a), regardless of which chains the user holds. The LEVER already exists: `VAULTPILOT_CHAIN_FAMILIES` / `VAULTPILOT_PROTOCOLS` (`config/scope.ts`, default `'all'`) already gate registration via `isToolEnabled`. PROD adjudicated #721: a fresh install defaults to a curated CORE set via the clean EVM-default flip — default chain families = `{evm}`, default protocols = ∅, other families/protocols opt-in via `VAULTPILOT_CHAIN_FAMILIES`/`VAULTPILOT_PROTOCOLS` — target **≤72 tools** (R7, §2), implementation tracked at #733. The previously-considered ~44-tool FLOOR (a further per-protocol `VAULTPILOT_EXTRAS` purpose-sub-filter, narrower than the family cut) is **PARKED** pending evidence gathered after the flip ships — not adopted now. R8 (schema-byte budget) stays gated on #719's real `tools/list` bench measurement; this doc asserts no KB number.

**Primary falsifiable target (fund-safety — guard/prepare co-scoping).** A guard/preview tool and the mutation tools it gates MUST be registered together in EVERY scope config. `preview_send` (scope `{family: evm}`, `config/scope.ts` L155) and `preview_solana_send` (`{family: solana}`, L185) are the pre-sign safety gates for the EVM/Solana `prepare_*` + `send_transaction` tools; a default-scope reduction that drops a guard/preview tool while still registering that family's `prepare_*`/`send_transaction` is a **FUND-SAFETY REGRESSION** — the mutation path loads without its safety gate. **Exit criterion:** a test asserting that for every scope config, if any `prepare_*`/`send_transaction` for a family is registered, that family's `preview_*`/guard tools are too — RED if a scoping change de-couples them. This gates any §6 default-scope change and is PRIMARY over the count/size bench below.

**Secondary target (context-cost bench).** `scripts/bench-tools.mjs` (already spawns `dist/index.js` over stdio and measures the static tool surface, issue #637) records the default-config tool count and total schema text so a regression is visible; now that PROD has adopted the curated default (R7, #721/#733), the bench asserts against the ≤72-tool budget, and against #719's byte budget once R8 is set. Secondary to the co-scoping invariant above.

---

## 7. Decision records (confirmed correct-as-is — do NOT "simplify" away)

Recon confirmed these are load-bearing or deliberate. DEV must not collapse them. Per the §Pin contract each record now carries a **Falsifier** — a mechanical check that goes RED if the record is "simplified" away — except where a record is genuinely rationale-only (marked as such):

1. **`prepare_swap` (LiFi aggregator, default) vs `prepare_uniswap_swap` (explicit single-DEX opt-in) kept separate.** They already share one `assertSlippageOk` (exported from `swap/`, reused by `uniswap-swap/`) — no duplicated gate. Uniswap is explicit-ask-only per its tool description. Keep both. **Falsifier:** `swap/` and `uniswap-swap/` remain distinct modules AND both `prepare_swap` + `prepare_uniswap_swap` stay registered in `src/index.ts`, with `assertSlippageOk` defined exactly once (in `swap/`) and imported by `uniswap-swap/` — RED if either module/tool is deleted or the slippage gate is duplicated.
2. **`@kamino-finance/kliquidity-sdk` deliberately stubbed** (`vendor/kliquidity-stub`, 8 utility symbols) to avoid the Raydium/Orca/Meteora dependency cone. The stub `Kamino` class throws on construction with restore instructions. Keep the stub; do not pull the real package for the 8 reached symbols. **Falsifier:** `grep -rn "@kamino-finance/kliquidity-sdk" src/` matches no import outside `vendor/kliquidity-stub` — RED if the real package is imported anywhere in `src/`.
3. **LTC signer legacy-API divergence** (issue #240, §5.1) — kept; a real Ledger-firmware constraint, not accidental dup. **Falsifier:** `signing/ltc-usb-signer.ts` stays a separate file from `btc-usb-signer.ts` AND retains the `signLtcPsbtViaLegacyApi` legacy-fallback symbol (grep) — RED if the two signers are merged or the fallback path is deleted. (The error-string trigger is a tracked robustness fix, §5.1, not a merge.)
4. **Solana's extra `preview_solana_send` blockhash-pin step** — kept. Solana is the only family needing an extra hop between `prepare_*` and `send_transaction` because the blockhash validity window (~60 s) means the pin MUST run close to send, not at prepare time (`index.ts` L1747-1749, recon). BTC/LTC/TRON correctly go straight to send. A grounded structural asymmetry, not a bug. **Falsifier:** `preview_solana_send` stays registered AND a test asserts a Solana `send_transaction` with no fresh blockhash-pin preview is REFUSED — RED if the extra hop is removed or made optional.
5. **Simulation two-layer design** — `simulateTx` (low-level `eth_call` wrapper, **load-bearing**: on every EVM `prepare_*` and in `runEvmPreSignGuards`) vs `simulateTransaction` (higher-level, advisory, backs the user-facing `simulate_transaction` tool). Keep both layers; the naming (`docs-drift`, `evm:simulation-two-tier-naming`) is the only fix owed. **Falsifier:** both `simulateTx` and `simulateTransaction` exist as distinct symbols AND `runEvmPreSignGuards` calls `simulateTx` (§3.3) — RED if the two collapse into one or the guard stops calling the low-level layer.
6. **Centralized demo gating** — the `registerTool`/dispatch wrapper is the ONLY caller of the demo predicates; table-driven by tool name. New `prepare_*`/`send_transaction` tools need no per-tool demo code. **Preserve:** extend the predicate/table functions in `demo/index.ts` for new tools; never scatter per-module demo branches. **Falsifier:** the demo predicates (`isBroadcastTool`/`isAlwaysGatedTool`/`isConditionallyGatedTool`) are referenced only from the `registerTool` dispatch closure AND no `isDemoMode()` gate appears inside `modules/*/` — RED if a per-module demo branch appears.
7. **Single-shot broadcast (no generic retry)** — TRON/BTC/LTC/Solana broadcast surface the error to the caller by design (§1 non-goal); Solana's `maxRetries:5` is web3.js's within-blockhash-window identical-bytes rebroadcast (safe by signature determinism), not a generic retry. **Falsifier:** shares the §1 non-goal / §4 INV-T1 falsifier — no exponential-backoff/generic-retry wrapper on the TRON/BTC/LTC/Solana broadcast paths — RED if a retry wrapper wraps a broadcast call.

**Pre-registered decision criterion for future protocol-adds:** the CLAUDE.md `Per-protocol prepare_* vs prepare_custom_call cutoff` (criteria 1–5: slippage/MEV math, pause/cap/threshold preconditions, approve+action bundling, durable-binding, non-standard token semantics). Apply it at protocol-add design time. **This doc does not restate it — it points to it** (CLAUDE.md, adopted from #645/#638). A `prepare_custom_call`-only path meeting any criterion silently drops prepare-time invariants behind one ack (§3.2/§3.4).

---

## 8. Convergence backlog index (thin pointer)

Pointer index ONLY: one row per convergence unit → the doc section that OWNS its exit criterion → target file(s). Exit criteria live once, in their section (§2–§6), and are **not restated here** — read the section for the falsifier. Robustness/bug rows are independent of the simplification rows and can land first.

| Group | Unit | Owning section | Target file(s) | Issue |
|---|---|---|---|---|
| Security | `transferFrom` recipient classifier fix + `to==wallet` test | §3.2 | `security/custom-call-classifier.ts`, `modules/custom-call/actions.ts` | #711 |
| Security | tx-store deep `Object.freeze` + mutation regression test | §3.3 | `signing/tx-store.ts` | #710 |
| Robustness/bugs | Lint rule: ban bare `fetch`/`globalThis.fetch` outside `data/http.ts` | §4 INV-T1 | eslint config, `data/http.ts` | #714 |
| Robustness/bugs | Solana `Connection` timeout/AbortSignal | §4 INV-T1 (R6) | `modules/solana/rpc.ts` | #693 — closed |
| Robustness/bugs | 4byte.directory via `fetchWithTimeout` | §4 INV-T1 (R6) | `data/apis/fourbyte.ts`, `signing/verify-decode.ts` | #694 — closed |
| Robustness/bugs | viem `http()` explicit per-attempt timeout | §4 INV-T1 | `data/rpc.ts` | TBD (ARCH files) |
| Robustness/bugs | Redact API keys from error responses | §4 INV-T2 | `shared/error-message.ts` | #695 — closed (follow-up #707 open) |
| Robustness/bugs | Oracle-poller in-flight guard + timed calls | §4 INV-T4 (R13) | `modules/incidents/oracle-poller.ts` | #697 — closed |
| Robustness/bugs | `get_daily_briefing` composite fan-out cap | §4 INV-T3 (R5) | `modules/digest/index.ts` | TBD (ARCH files) |
| Robustness/bugs | `resolveSelectors` bound + timeout | §4 INV-T3 (R5) | `modules/history/decode.ts` | TBD (ARCH files) |
| Robustness/bugs | `TTLCache` key-count/eviction bound | §4 INV-T4 | `data/cache.ts` | TBD (ARCH files) |
| Robustness/bugs | LTC legacy-fallback: replace SDK error string-match | §5.1 | `signing/ltc-usb-signer.ts` | #698 — closed |
| Robustness/bugs | `permissions`/`verification` RPC-vs-negative catch split | §4 INV-T2 | `modules/security/{permissions,verification}.ts` | #696 — closed |
| Robustness/bugs | `hookTimeout` raise to match `testTimeout` | §5.2 test cost | `vitest.config.ts` | #691 |
| Robustness/bugs | Demo duplicate-handle leak | §3.6 | `src/index.ts` | TBD (ARCH files) |
| Measurement | p95 latency bench (R1/R2/R3 UNMEASURED) | §2 | `scripts/bench-tools.mjs` or new bench-latency script | #719 |
| Fund-safety | Guard/prepare co-scoping test | §6 | `config/scope.ts`, scope test | #712 |
| Scope | `prepare_sunswap_swap` escapes family scoping in `getToolScope` | (scope — no owning § yet) | `config/scope.ts`, `src/index.ts` | #726 |
| Simplifications | UTXO Esplora client unification (preserve BTC `getTx`) | §5.1 | `modules/utxo/esplora-client.ts` | #716 |
| Simplifications | `execution/index.ts` decomposition (7 seams, spine-gated) | §5.2 | `modules/{pairing,evm-prepare,solana,tron}/…`, `signing/{send-pipeline,status-dispatch,verification-artifact}.ts` | #720 |
| Simplifications | `render-verification.ts` → per-chain render modules | §5.3 | `signing/render/{evm,tron,bitcoin,litecoin,solana}.ts` | #718 |
| Simplifications | `types/index.ts` domain split | §5.4 | `types/{chains,positions,tx,devices,config}.ts` | #717 |
| Simplifications | min-out / max-in shared helper | §5.5 | `modules/shared/slippage.ts` | #715 |
| Simplifications | Default CORE tool-scope flip — EVM-default, ≤72 tools (ADOPTED, §6) | §6 (R7/R8) | `config/scope.ts`, `scripts/bench-tools.mjs` | #733 |
| Docs-drift | module-scoped `shared`/`security`/`diagnostics` rename or header | §5.6 | `modules/_common/…` | TBD (ARCH files) |
| Docs-drift | Org/path/annotation-coverage stale refs | (out of this doc) | `CLAUDE.md`, README, AGENTS, INSTALL, SECURITY, ROADMAP, `glama.json`, `server.json` | TBD (ARCH files) |
| Docs-drift | RECON_* legacy env aliases retirement | (out of this doc) | `config/chains.ts` | TBD (ARCH files) |
| Product intake | R1–R13 spec-value asks (§2 table) | §2 | (SPEC.md — to be created) | #721 |

**Landed.** Five §4/§5 robustness bugs already shipped (closed) — see the rows above for the doc-section mapping: timeouts #693/#694 → PR #706; api-key leak #695 → #703 (follow-up #707 open); permission conflation #696 → #705; oracle poller #697 → #702; LTC drift #698 → #704.

**Dropped (resolved non-issue).** `robustness:solana-conn-cache-race` no longer appears as an open unit — it is a verified non-issue, not a convergence target. See §4 INV-T1 for the decision record (#713 CLOSED; guard test PR #728 keeps it RED-safe against future drift).
