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
| **Live-capital automation / lint tooling** | Out of product scope for v1 (lint absent by choice, recon @ c1b373a); no strategy-promotion surface here. | n/a |

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
| R1 | Read-tool (`get_*`/`list_*`) p95 latency, interactive path | ≤ 3 s | §4 amplification table; O(1)-round-trip-per-chain reads | MEETS — portfolio/balance readers are multicall-batched O(1) round-trips per chain (recon: `positions/aave.ts`, `positions/uniswap.ts`, `balances/index.ts`). |
| R2 | `prepare_*` p95 latency | ≤ 8 s | chain reads + `simulateTx` eth_call + build | MEETS with one caveat — depends on R6 (no untimed transport on the path); FAILS today via the Solana/4byte timeout gaps (§4). |
| R3 | `preview_send` p95 latency | ≤ 10 s | `assertTransactionSafe` + `simulateTx` + gas pin + WC account-match | MEETS structurally; same R6 caveat. |
| R4 | `send_transaction` device-wait ceiling | ≤ 120 s hard | human-in-the-loop device approval, not a compute budget | MEETS — `WC_SEND_REQUEST_TIMEOUT_MS` ~120 s with late-broadcast probe (recon: `walletconnect.ts`). |
| R5 | Worst-case external HTTP calls per single read-tool invocation | ≤ 50 (concurrency-capped 10) | schema cap × per-item fan-out | MEETS for `get_transaction_history` (schema `.max(50)`); **FAILS** for `get_daily_briefing` (composite ~371, §4 F5) and `resolveSelectors` (unbounded, §4). |
| R6 | Every process/network-boundary call carries an explicit in-code timeout | 100% of tool-reachable transports | robustness invariant (§4) | **FAILS today** — Solana `Connection` and `4byte.directory` are untimed (§4). Convergence targets. |
| R7 | Default (unconfigured) install tool count | ≤ 64 tools | per-turn schema-text budget the host pays every turn | **FAILS today** — default is all 189 (§6). |
| R8 | Default (unconfigured) install host-visible schema text | ≤ 96 KB | context cost | **FAILS today** — ~227 KB across 189 blocks (recon @ c1b373a, §6). |
| R9 | Max lines per module (god-module smell threshold) | ≤ 800 | simplicity / deep-modules (§5) | **FAILS** — `execution/index.ts` 4013, `render-verification.ts` 2850, `types/index.ts` 1871 (§5). |
| R10 | Max branch-per-chain `switch` arms in a dispatch | ≤ 8 | data-model-before-logic (§5) | **FAILS** — `solanaActionLabel` 20+ arms (§5). |
| R11 | Max exports / lines per `types/*` domain file | ≤ 20 exports, ≤ 600 lines | one-fact-one-home (§5) | **FAILS** — `types/index.ts` 59 exports / 1871 lines (§5). |
| R12 | Handle-store TTL (prepare → send binding window) | 15 min (current) | replay/immutability window (§3) | MEETS — `TX_TTL_MS` 15 min, lazy prune (recon: `tx-store.ts`). Flag R12 to PROD: confirm 15 min is the intended UX ceiling. |
| R13 | Externally-metered-dependency spend alarm | present per 24/7 dependency | metered-resources canon | **UNKNOWN** — no usage/spend alarm found in recon; PROD must state whether a 24/7 deployment is in scope (the oracle poller, §4, is the only always-on caller). |

**R7/R8 note.** R7 is the tool-count budget; R8 is the byte budget; they are independent and both routed to PROD as the §6 product decision.

---

## 3. Trust model & the pre-sign safety spine

This is the security centerpiece. Every item is a **preserved invariant** with an enforcing `file:line`. All line citations in this section were verified against live code at `c1b373a`.

### 3.1 `assertTransactionSafe` — the 5 ordered blocks

`src/signing/pre-sign-check.ts` (375 lines). `assertTransactionSafe(tx)` at L197 reasons about **raw calldata alone** — it never trusts a `prepare_*` tool's human description. Ordered blocks:

- **B1 — native-send pass / short-calldata refuse.** `tx.data ∈ {0x, 0x0, 0x00}` returns immediately (L200); `data.length < 10` (no selector) refuses (L204).
- **B2 — `approve()` spender-allowlist.** L216-280. Requires `dest` recognized (L217) and `dest.kind ∈ {known-erc20, lido-stETH, weth9}` (L225-229, approvals target tokens not protocol contracts). Decodes spender/amount. **Revoke carve-out:** `amount === 0n` returns early (L254, issue #305 — a zero allowance grants no authority). Else `buildSpenderAllowlist(chain)` (L255, protocol contracts only). **Ack escape:** `tx.acknowledgedNonAllowlistedSpender === true` returns (L266).
- **B3 — `transfer()` on recognized-token-only.** L285-296. `dest.kind ∈ {known-erc20, lido-stETH, weth9}` or refuse.
- **B4 — catch-all unknown-destination refuse.** L315-334. Any non-recognized `dest` with non-empty calldata refuses — "exactly the shape of a prompt-injection attack." **Bypassed** by `tx.acknowledgedNonProtocolTarget === true || tx.safeTxOrigin === true` (L316-324).
- **B5 — per-destination ABI-selector check.** L338-374. For a recognized `dest` with a curated ABI, the 4-byte selector must be a function on that ABI. **LiFi Diamond is the explicit exception** — `allowedAbi === null` returns immediately (L338, see 3.4).

**Ordering invariant.** B2/B3 (approve/transfer) are decided by *selector* before the destination-class catch-all (B4) and the ABI check (B5). The three ack flags (below) open **only** B4 and the approve-allowlist; they never subsume B2's token-kind check, B3, or B5 — proven by the four bypass/non-bypass tests in `test/pre-sign-check.test.ts` (recon, tests dim). **Exit criterion:** `test/pre-sign-check.test.ts` keeps a positive+negative pair per block AND the "ack opens only B4" tests; removing any single block goes RED.

### 3.2 The ack-flag trust root (blocking invariant)

Three server-stamped flags bypass parts of the gate. Their safety rests entirely on **where they come from**, per the "state each ack flag's trust source" rule:

| Flag | Bypasses | Trust source (what makes the bypass safe) |
|---|---|---|
| `acknowledgedNonAllowlistedSpender` | B2 approve-allowlist | Stamped by a `prepare_*` tool (e.g. `curve/actions.ts` L464) only after the user passed a schema-enforced `acknowledgeNonAllowlistedSpender: true`; flows through the server-minted handle, never agent input. |
| `acknowledgedNonProtocolTarget` | B4 catch-all | Stamped by `prepareCustomCall` (`execution/index.ts` L2848) after its build-time ack gate + exfil classifier. |
| `safeTxOrigin` | B4 catch-all | Stamped by the Safe builders (`safe/execute.ts` L212); the OUTER calldata is always `approveHash`/`execTransaction`, which carries no transferable authority on its own (see 3.5). |

**The single load-bearing invariant the entire bypass system rests on** (`security:presign-ack-trust-root`, blocking): these flags are **NEVER accepted as agent input.** `send_transaction` / `preview_send` take only an **opaque `handle` string**. The tx-with-flags is stamped by server code and stored in a UUID-keyed in-memory `Map` by `issueHandles` (`tx-store.ts` L123-150); the agent gets back only the handle (the stored value even strips the handle key, L145). `consumeHandle` (L163) is a non-destructive peek; `retireHandle` (L180) deletes on successful submit; TTL 15 min (`TX_TTL_MS`).

> **Convergence guardrail (do NOT drift):** any future tool that accepts a caller-supplied tx object, or exposes any of these flags in an input schema, collapses every catch-all/selector defense behind one forgeable boolean. **Exit criterion:** no tool input schema in `src/index.ts` contains `acknowledgedNonProtocolTarget`, `safeTxOrigin`, or `acknowledgedNonAllowlistedSpender`; `send_transaction`/`preview_send` accept only `{handle, previewToken, userDecision, …}`, never a raw `tx`.

### 3.3 Guards run at preview, NOT at send (important invariant)

`runEvmPreSignGuards` (`execution/index.ts` L3027) = `assertTransactionSafe` (L3029) + `simulateTx` (L3030) + WC account-match + payload-hash recheck. It is invoked **ONLY** from `previewSend` (L3194) and tests. The EVM `sendTransaction` path (L3373-3516) does `getPinnedGas` (L3417) → `previewToken` match (L3450) → `consumeHandle` (L3480) → forward to WC → `retireHandle` (L3516). **It never re-runs the gate or simulation.** The cached-pin branch of `previewSend` (L3171-3189) also returns without re-running guards.

Send-time safety therefore rests on exactly two facts: **(a) tx-store immutability** — no code mutates `StoredTx.tx` after `issueHandles`; **(b) previewToken binding** — a matching `previewToken` proves `preview_send` ran the guards on *this exact immutable tx*.

> **MANDATORY exit criterion (write as a required regression test):** a `send_transaction` presenting a tx whose `previewToken` does not match the stored pin, OR a tx mutated in the store between preview and send, MUST be REFUSED. A regression test must go **RED** if the `previewToken` equality check (L3450) is removed or if `StoredTx.tx` becomes mutable. `test/preview-token-gate.test.ts` + `test/send-hash-pin.test.ts` (recon, tests dim) are the homes; the target is that the binding-removal falsifier is covered and stays RED-on-removal. This is a silent-failure surface: a future send path that skips preview bypasses the whole gate with no error.

### 3.4 REVIEW-FLAGGED: LiFi Diamond bypasses B5 while on the spender allowlist

`classifyDestination` returns `{kind:"lifi-diamond", allowedAbi:null}` (L148); B5 returns immediately on `allowedAbi===null` (L338) — so **any** selector/calldata to `LIFI_DIAMOND` passes B5. `LIFI_DIAMOND` is also in `buildSpenderAllowlist` (L187), so `approve(LiFi,…)` passes B2. The address is a **hardcoded lowercase literal** (L41), not sourced from `CONTRACTS` like every other pinned destination.

**Bypass condition:** `tx.to === LIFI_DIAMOND`. **Stated rationale:** LiFi's ABI is huge/dynamic; full trust in one address for arbitrary calldata is the accepted-risk trust anchor. **This is the widest hole in the selector gate.** *This doc does not declare it safe or unsafe.* It is flagged for security review; the fleet has **no SEC seat** to give that judgment. Convergence must not silently widen or narrow it. **Exit criterion:** `LIFI_DIAMOND` remains the sole `allowedAbi:null` destination; any second such destination is a review trigger.

### 3.5 REVIEW-FLAGGED: Safe `execTransaction` skips B4 though inner op may be DELEGATECALL

`buildExecTransactionTx` stamps `safeTxOrigin=true` (`safe/execute.ts` L212) on an OUTER call to the user's Safe (`to = safeAddress`), skipping B4. The inner `SafeTx` body may be `operation === 1` (DELEGATECALL, L38/L188/L204), surfaced **only** in the human description string (`⚠ DELEGATECALL`). The pre-sign gate does not inspect or gate the inner call; safety rests on the Safe's owner-threshold signatures and the upstream `safeTxHash` binding.

**Bypass condition:** `tx.safeTxOrigin === true` on a Safe `execTransaction` whose inner `operation === 1`. Correct by Safe design, but load-bearing and non-obvious. *This doc does not declare it safe or unsafe* — flagged for the absent SEC seat. **Exit criterion:** `safeTxOrigin` is stamped only by the Safe builders (`safe/actions.ts`, `safe/execute.ts`); the DELEGATECALL surfacing in the description string is preserved.

### 3.6 Demo-mode broadcast gate (important invariant)

Under `VAULTPILOT_DEMO=true`, `send_transaction` can **NEVER** reach the real broadcast handler. In the `registerTool` dispatch closure (`src/index.ts`): for a conditionally-gated + live-mode broadcast tool, `if (!broadcastTool) return realHandler(args); return broadcastSimulationDispatch(name, args, realHandler)` (L1160-1161). `broadcastSimulationDispatch` (L1182) takes `_realHandler` (L1187) and **never invokes it** (L1177 comment: "realHandler is unused here on the broadcast path because we never…") — it re-simulates via the tx-store handle and returns a simulation envelope. `isBroadcastTool(name)` is the sole gate. **Exit criterion:** a test asserting the real broadcast handler is unreachable under demo mode — a mutation making `broadcastSimulationDispatch` call `_realHandler` goes RED. (Minor: the demo path re-issues a fresh handle without retiring the original — a duplicate store entry, demo-only leak, `security:presign-demo-duplicate-handle`; fix in the convergence backlog, not a spine defect.)

---

## 4. Transport & robustness invariants

Cross-cutting rules every external call obeys, each with a falsifiable check. The repo has a **strong timeout culture** — `data/http.ts` `fetchWithTimeout(url, init, 10000)` (AbortController, 10 s default) is the load-bearing cap across TRON/BTC/LTC/DefiLlama/NFT/yields/Etherscan/history (recon, robustness dim). The invariant is universal; the two gaps below are convergence targets, not exceptions to it.

### INV-T1 — every tool-reachable transport carries an explicit in-code timeout

**Target:** NO raw `fetch(` and NO untimed SDK client sits on any tool path; every transport routes through a timeout-enforcing wrapper.

Two grounded gaps (both CONFIRMED against live code):
- **Solana `Connection` — untimed (blocking, `robustness:solana-conn-no-timeout`).** `modules/solana/rpc.ts` `getSolanaConnection()` builds `new Connection(url, {commitment:"confirmed", fetch: fetchWithRateLimitDetect})` (L133). The shim `fetchWithRateLimitDetect` (L43) does `await fetch(input, init)` with **no AbortSignal, no timeout** — every Solana RPC call, **including `broadcastSolanaTx`**, can hang indefinitely. This is the single largest robustness gap. The oracle poller (below) funnels through it.
- **`4byte.directory` — untimed on the pre-sign path (blocking, `robustness:fourbyte-no-timeout-presign`).** `data/apis/fourbyte.ts` (19 lines) `defaultFetch = (url) => fetch(url)` — raw, no timeout — reachable unguarded from `signing/verify-decode.ts` (pre-sign calldata cross-check) and `modules/history/decode.ts`.

**Exit criterion:** a grep-able assertion `grep -rn "fetch(" src/ | grep -v "fetchWithTimeout\|fetchWithRateLimitDetect\|node-fetch import"` returns only the timeout-wrapper internals and self-contained AbortController sites (`nft/helius-das.ts`); specifically `modules/solana/rpc.ts`'s shim carries an AbortSignal and `data/apis/fourbyte.ts` routes through `fetchWithTimeout`. (`data/rpc.ts` viem `http()` also relies on an implicit default timeout — pin it explicitly, `robustness:viem-timeout-implicit`.)

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

**The one poller:** `modules/incidents/oracle-poller.ts` `startOraclePoller()` — a 60 s `setInterval` (L120) over a fixed `KNOWN_PYTH_FEEDS` list. **Two grounded requirements** (`robustness:oracle-poller-overlap`, CONFIRMED): (a) it has **no in-flight overlap guard** — a slow tick can stack on the prior tick; (b) each tick funnels through the untimed Solana `Connection` (INV-T1), so one hung tick can wedge the poller. **Exit criterion:** the poller carries an in-flight boolean/skip-if-running guard AND its Solana calls are timed; a test that stalls one tick asserts the next tick is skipped, not stacked. Also record R13 (spend alarm) as the missing companion for any 24/7 deployment.

**In-memory cache bound (`reads:F6`).** `data/cache.ts` `TTLCache` is `Map`-backed with lazy-on-`get` expiry, **no LRU / no key-count cap** — a long-lived process serving many wallets accumulates an ever-growing map (30-day historical-price keys are the worst). **Target/exit criterion:** a max-key-count or size bound with a defined eviction (drop-oldest/LRU) on overflow. Never cache a safety/authorization verdict over a mutable fact — the four `SECURITY_*`-prefixed long-TTL categories (24 h verification, 1 h permissions/risk) are flagged for the security reviewer to confirm they cache facts, not verdicts.

---

## 5. Module architecture (target)

The simplified target module map. Each item: current-state evidence (`recon @ c1b373a`) + a TARGET as a falsifiable structural check. Thresholds (R9/R10/R11) are `ASSUMED` and tunable by PROD. The organizing principle is **deep modules with small interfaces**: the goal is not "smaller files" for their own sake but ending the cohabitation of unrelated responsibilities behind one edit surface.

### 5.1 UTXO chain unification (BTC/LTC Esplora indexer)

**Evidence.** `modules/btc/indexer.ts` (708 L) and `modules/litecoin/indexer.ts` (676 L) are ~90% duplicated Esplora clients — the LTC file's own header says "Mirror of src/modules/btc/indexer.ts — same Esplora API surface, same retry policy, same field shapes; only the default URL and user-config field name differ" (recon @ c1b373a). Token-normalized diff: 168 changed lines of ~700. **The precedent already exists:** `modules/utxo/rpc-client.ts` (140 L) is a chain-agnostic Bitcoin-Core-RPC client used by BOTH `incidents/chain-utxo.ts` and `execution/index.ts` — the RPC-forensics layer got the shared-adapter treatment the Esplora indexer never did.

**Target.** One parametrized Esplora client — `modules/utxo/esplora-client.ts` — taking chain (`btc`|`ltc`) as a parameter (default URL + config-field-name injected). BTC/LTC tool families become chain-parameterized, not verb-duplicated.

**Preserve as a DECISION RECORD, not dup to delete:** the LTC **signer** divergence. `ltc-usb-signer.ts` (1073 L) is ~95% structurally identical to `btc-usb-signer.ts` (843 L) EXCEPT the issue-#240 legacy-API fallback (`signLtcPsbtViaLegacyApi` L754, `encodeVarInt` L695, ~230 lines) triggered by string-matching the SDK error "signPsbtBuffer is not supported with the legacy Bitcoin app" (L678, verified). This is a load-bearing divergence for Ledger's Litecoin app v2.4.11 — **do not merge it away.** (The string-match trigger is itself fragile — `signing:ltc-legacy-fallback-string-match`, CONFIRMED bug — but that is a robustness fix, not a merge.)

**Falsifiable target.** Exactly one Esplora client module; `grep -rn "class.*Esplora\|Esplora API surface" src/modules/` finds one home, not two; no structural twin of `btc/indexer.ts` under `litecoin/`. The signer files stay two, with the divergence documented here. (Also close the LTC capability gap OR record it: LTC carries `rbfEligible` plumbing but registers no `prepare_litecoin_rbf_bump`, and has no lifi-swap/multisig — `nonevm:litecoin-capability-gap`. Target: either register the tools or state the gap as intentional in §7.)

### 5.2 `execution/index.ts` decomposition (the god module)

**Evidence.** `modules/execution/index.ts` (4013 L) + `schemas.ts` (2512 L) cohabit 6+ unrelated responsibilities in one file (recon @ c1b373a, `evm:execution-god-module`, important):
1. Ledger pairing across 5 chains (`pairLedgerLive/Tron/Bitcoin/Solana/Litecoin`);
2. BTC/LTC RPC + balance/UTXO/mempool/rescan + multisig PSBT;
3. Solana lending/staking/swap prepare + send pipeline (`sendSolanaTransaction`);
4. TRON send + swap prepare;
5. EVM `prepare_*` handlers (thin delegates to per-protocol action modules);
6. shared preview/send/verify pipeline (`runEvmPreSignGuards`, `previewSend`, `sendTransaction`, `getTransactionStatus`, `verifyTxDecode`).

**Target — decompose along those named seams:**

| Responsibility | Target module |
|---|---|
| Ledger pairing (5 chains) | `modules/pairing/index.ts` |
| EVM preview/send/verify pipeline (the §3.3 spine) | `signing/send-pipeline.ts` (co-located with the gate it enforces) |
| EVM `prepare_*` dispatch | `modules/evm-prepare/index.ts` (thin; per-protocol logic already lives in `modules/{aave,uniswap,lido,…}`) |
| BTC/LTC RPC + UTXO/rescan wrappers | fold into `modules/btc/` + `modules/litecoin/` (or the unified §5.1 layer) |
| Solana send pipeline | `modules/solana/send.ts` |
| TRON send pipeline | `modules/tron/send.ts` (partly exists — `sendTronTransaction`) |

**Trade-off (judged).** Decomposition adds ~6 files and one dispatch indirection. Tie to R9 (simplicity/context-cost) and testability: the send pipeline (§3.3) is safety-critical and today cannot be tested without importing a 4013-line module (the exact heavy-import cost behind the `hookTimeout` flake, issue #691). MEETS — the added files are removable-by-editing-one-place; the indirection is a thin dispatch, not a new abstraction layer.

**Falsifiable target.** No single module cohabits >1 of {pairing, evm-send-pipeline, evm-prepare-dispatch, utxo-rpc, solana-send, tron-send}; `execution/index.ts` is either deleted or reduced to a re-export barrel ≤ `ASSUMED 400` lines; a structural test asserts each named symbol resolves to its target file.

### 5.3 `render-verification.ts` — data-model-before-logic

**Evidence.** `signing/render-verification.ts` (2850 L) does render/verify block composition for EVM + Tron + Bitcoin + Litecoin + Solana in one file via branch-per-chain dispatch; `solanaActionLabel` alone has 20+ `case` arms (recon, `signing:render-verification-per-chain-god-module`). It also owns non-signing render helpers (`renderMissingSkillWarning`, `renderUpdateAvailableNotice`).

**Target.** Replace the branch-per-chain switch with a **per-chain render descriptor** (a data table keyed by action kind, one `RenderDescriptor` type per chain) — make the chain/action a lookup, not a conditional chain. Move the non-signing render helpers out to a render-utilities module.

**Falsifiable target.** No branch-per-chain `switch` exceeds `ASSUMED 8` arms (R10); a `RenderDescriptor` type exists per chain; `solanaActionLabel`'s arm count drops to a table lookup. Check: grep `case ` density per switch.

### 5.4 `types/index.ts` — split by domain

**Evidence.** `types/index.ts` (1871 L, 59 exports, no internal boundary) holds chain consts, per-protocol position shapes, security shapes, per-chain portfolio slices, per-chain UnsignedTx shapes, paired-device entries, and `UserConfig` — imported everywhere (recon, `infra:types-god-file`).

**Target.** Split by domain: `types/chains.ts` (SupportedChain/CHAIN_IDS), `types/positions.ts`, `types/tx.ts` (per-chain UnsignedTx), `types/devices.ts` (paired-device entries), `types/config.ts` (UserConfig). **Falsifiable target:** no single `types/*` file exceeds `ASSUMED 20` exports or `ASSUMED 600` lines (R11).

### 5.5 min-out slippage math — one shared helper

**Evidence (verified).** The exact-out floor formula `(expected * BigInt(10000 - bps)) / 10000n` is copy-pasted at **4 sites**: `curve/actions.ts` L134 and L366, `swap/index.ts` L635, `uniswap-swap/index.ts` L137. The exact-in ceiling variant `(quoted * (10_000 + bps) + 9_999n) / 10_000n` is duplicated at `uniswap-swap/index.ts` L142 and `swap/index.ts` L967. This copy-paste is the recurrence surface for the #685-class priority-fee/slippage arithmetic bug.

**Target.** One shared helper — `modules/shared/slippage.ts` exporting `applyMinOut(expected, bps)` and `applyMaxIn(quoted, bps)`. **Falsifiable target:** exactly one implementation of each formula; `grep -rn "10000 - \|10_000 - \|10_000 + " src/modules/{swap,uniswap-swap,curve}` finds only the shared helper, no sibling copy.

### 5.6 Naming collisions (docs-drift, not merges)

Three same-basename directory pairs are NOT duplication — record so DEV does not merge them: `src/shared` (server-wide generic infra) vs `src/modules/shared` (module business helpers); `src/security` (pre-sign GATE infra) vs `src/modules/security` (read-only research tools); `src/diagnostics` (dev/CI self-checks) vs `src/modules/diagnostics` (registered MCP tools). **Target:** rename the module-scoped side (e.g. `modules/shared` → `modules/_common`) OR document the split in a header comment. Falsifiable: each pair carries a one-line "not-a-duplicate-of" header, or the rename lands.

---

## 6. Tool surface & scoping (the context-cost lever)

**Evidence (verified).** A default, unconfigured install registers **all 189 tools every turn** (~227 KB of description+annotation text, recon @ c1b373a, excluding zod schema bodies) because `VAULTPILOT_CHAIN_FAMILIES` and `VAULTPILOT_PROTOCOLS` both default to "all": `parseFamilies(undefined)` returns all five families (`config/scope.ts` L73), `parseProtocols(undefined)` returns null = accept-all (L87). The `registerTool` wrapper calls `isToolEnabled(name)` and skips SDK registration when a tool's family/protocol is excluded — the mechanism exists and works; the **default** is maximal.

**Annotation coverage is already 100%** (189/189; the 191 raw `registerTool(` occurrences = 189 real `registerTool(server,` calls + the wrapper `function registerTool` + the inner `server.registerTool`). **Do NOT restate CLAUDE.md's stale "zero coverage" claim** — that is a known-stale ref. Keep the 100%-annotation invariant: **exit criterion** — `grep -c "registerTool(server," == grep -c "annotations:"` in `src/index.ts`.

**Product decision (→ ASSUMED + PROD ask, R7/R8).** Should a fresh install default to a curated CORE tool set rather than all 189? A first-run agent pays the full ~227 KB schema bill on every turn regardless of which chains the user holds. **Target:** default-config tool count ≤ `ASSUMED 64` (R7), host-visible schema text ≤ `ASSUMED 96 KB` (R8) — e.g. a CORE family (EVM + reads + send pipeline) with other families/protocols opt-in via the existing env axes. This is PROD's call, not an engineering default; routed in §2.

**Falsifiable target.** `scripts/bench-tools.mjs` (already spawns `dist/index.js` over stdio and measures the static tool surface, issue #637) is extended to assert: with no env config, registered tool count ≤ R7 and total schema text ≤ R8. The check goes RED if a future default re-inflates the surface.

---

## 7. Decision records (confirmed correct-as-is — do NOT "simplify" away)

Recon confirmed these are load-bearing or deliberate. DEV must not collapse them:

1. **`prepare_swap` (LiFi aggregator, default) vs `prepare_uniswap_swap` (explicit single-DEX opt-in) kept separate.** They already share one `assertSlippageOk` (exported from `swap/`, reused by `uniswap-swap/`) — no duplicated gate. Uniswap is explicit-ask-only per its tool description. Keep both.
2. **`@kamino-finance/kliquidity-sdk` deliberately stubbed** (`vendor/kliquidity-stub`, 8 utility symbols) to avoid the Raydium/Orca/Meteora dependency cone. The stub `Kamino` class throws on construction with restore instructions. Keep the stub; do not pull the real package for the 8 reached symbols.
3. **LTC signer legacy-API divergence** (issue #240, §5.1) — kept; a real Ledger-firmware constraint, not accidental dup.
4. **Solana's extra `preview_solana_send` blockhash-pin step** — kept. Solana is the only family needing an extra hop between `prepare_*` and `send_transaction` because the blockhash validity window (~60 s) means the pin MUST run close to send, not at prepare time (`index.ts` L1747-1749, recon). BTC/LTC/TRON correctly go straight to send. A grounded structural asymmetry, not a bug.
5. **Simulation two-layer design** — `simulateTx` (low-level `eth_call` wrapper, **load-bearing**: on every EVM `prepare_*` and in `runEvmPreSignGuards`) vs `simulateTransaction` (higher-level, advisory, backs the user-facing `simulate_transaction` tool). Keep both layers; the naming (`docs-drift`, `evm:simulation-two-tier-naming`) is the only fix owed.
6. **Centralized demo gating** — the `registerTool`/dispatch wrapper is the ONLY caller of the demo predicates; table-driven by tool name. New `prepare_*`/`send_transaction` tools need no per-tool demo code. **Preserve:** extend the predicate/table functions in `demo/index.ts` for new tools; never scatter per-module demo branches.
7. **Single-shot broadcast (no generic retry)** — TRON/BTC/LTC/Solana broadcast surface the error to the caller by design (§1 non-goal); Solana's `maxRetries:5` is web3.js's within-blockhash-window identical-bytes rebroadcast (safe by signature determinism), not a generic retry.

**Pre-registered decision criterion for future protocol-adds:** the CLAUDE.md `Per-protocol prepare_* vs prepare_custom_call cutoff` (criteria 1–5: slippage/MEV math, pause/cap/threshold preconditions, approve+action bundling, durable-binding, non-standard token semantics). Apply it at protocol-add design time. **This doc does not restate it — it points to it** (CLAUDE.md, adopted from #645/#638). A `prepare_custom_call`-only path meeting any criterion silently drops prepare-time invariants behind one ack (§3.2/§3.4).

---

## 8. Convergence backlog index (issue numbers TBD — ARCH fills after filing)

One row per convergence unit → doc section it implements → target file(s). Grouped. Robustness/bug rows are independent of the simplification rows and can land first.

| Group | Unit | Implements | Target file(s) | Issue |
|---|---|---|---|---|
| Robustness/bugs | Solana `Connection` timeout/AbortSignal | INV-T1 (R6) | `modules/solana/rpc.ts` | TBD |
| Robustness/bugs | 4byte.directory via `fetchWithTimeout` | INV-T1 (R6) | `data/apis/fourbyte.ts`, `signing/verify-decode.ts` | TBD |
| Robustness/bugs | Redact API keys from error responses | INV-T2 | `shared/error-message.ts` | TBD |
| Robustness/bugs | Oracle-poller in-flight guard + timed calls | INV-T4 (R13) | `modules/incidents/oracle-poller.ts` | TBD |
| Robustness/bugs | `get_daily_briefing` composite fan-out cap | INV-T3 (R5) | `modules/digest/index.ts` | TBD |
| Robustness/bugs | `resolveSelectors` bound + timeout | INV-T3 (R5) | `modules/history/decode.ts` | TBD |
| Robustness/bugs | `TTLCache` key-count/eviction bound | INV-T4 | `data/cache.ts` | TBD |
| Robustness/bugs | LTC legacy-fallback: replace SDK error string-match | §5.1 | `signing/ltc-usb-signer.ts` | TBD |
| Robustness/bugs | `permissions`/`verification` RPC-vs-negative catch split | INV-T2 | `modules/security/{permissions,verification}.ts` | TBD |
| Robustness/bugs | `hookTimeout` raise to match `testTimeout` (issue #691) | §5.2 test cost | `vitest.config.ts` | #691 |
| Robustness/bugs | viem `http()` explicit timeout | INV-T1 | `data/rpc.ts` | TBD |
| Robustness/bugs | Demo duplicate-handle leak | §3.6 | `src/index.ts` | TBD |
| Simplifications | UTXO Esplora client unification | §5.1 | `modules/utxo/esplora-client.ts` | TBD |
| Simplifications | `execution/index.ts` decomposition | §5.2 | `modules/{pairing,evm-prepare,solana,tron}/…`, `signing/send-pipeline.ts` | TBD |
| Simplifications | `render-verification.ts` → render descriptors | §5.3 | `signing/render-verification.ts` | TBD |
| Simplifications | `types/index.ts` domain split | §5.4 | `types/{chains,positions,tx,devices,config}.ts` | TBD |
| Simplifications | min-out shared helper | §5.5 | `modules/shared/slippage.ts` | TBD |
| Simplifications | module-scoped `shared`/`security`/`diagnostics` rename | §5.6 | `modules/_common/…` | TBD |
| Simplifications | Default CORE tool-scope + bench assertion | §6 (R7/R8) | `config/scope.ts`, `scripts/bench-tools.mjs` | TBD |
| Docs-drift | Org/path/annotation-coverage stale refs | (out of this doc) | `CLAUDE.md`, README, AGENTS, INSTALL, SECURITY, ROADMAP, `glama.json`, `server.json` | TBD |
| Docs-drift | RECON_* legacy env aliases retirement | (out of this doc) | `config/chains.ts` | TBD |
| Product intake | R1–R13 spec-value asks (§2 table) | §2 | (SPEC.md — to be created) | TBD |
