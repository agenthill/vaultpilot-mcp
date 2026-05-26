> **Generic process rules live in `~/.claude/CLAUDE.md`** (auto-loaded by Claude Code from the private [claude-md-global](https://github.com/szhygulin/claude-md-global) repo). The rules below are project-specific or override global defaults.

## Chat Output — WalletConnect Pairing
- Don't print the ASCII QR block from `pair_ledger_live` into chat. Surface the `wc:` URI only — Ledger Live accepts a pasted URI, and the QR floods terminal scrollback.

## Crypto/DeFi Transaction Preflight Checks
- Before preparing any on-chain tx, verify: native gas/bandwidth (TRX bandwidth on TRON), lending pause flags (`isWithdrawPaused` / `isSupplyPaused`), min borrow/supply thresholds, ERC-20 approval status.
- Never use `uint256.max` for collateral withdrawal — fetch the exact balance.
- Multi-step (approve + action): wait for the approval to confirm before sending the dependent tx.

## Pre-Sign Gate Surface Sweeps
- **When modifying behavior at any block of `assertTransactionSafe` (block 2 approve-allowlist, block 3 transfer-on-unknown-token, block 4 catch-all unknown-destination, block 5 per-destination ABI-selector check), audit every `prepare_*` path that targets the modified gate's destination class — not just the case the user/issue named.** A pre-sign block is a horizontal line through the prepare surface; it fails the same way for every prepare_* whose `to` lands in that class. Fixing only the named direction ships a half-fix.
- Tells: the issue/PR names a single direction (`steth_to_eth`) when the same `to` is reachable by multiple directions (`eth_to_steth` too); the broken path has no `preview_send`/`send_transaction` test exercising the modified block; the proposed fix is gated on a flag only the named direction passes (rogue-agent-aside, the other directions don't pass the flag because the user had no reason to).
- Format: before committing the fix, list every `prepare_*` path whose outer `to` lands in the modified block's class. For each, decide: does the new behavior cover this path, OR does the path remain blocked by the same gate? If blocked, either widen the fix or surface the gap explicitly in the PR description as out-of-scope. The exercise either widens the fix (one edit covers both) or confirms the named scope is intentional.

## Per-protocol `prepare_*` vs. `prepare_custom_call` cutoff
- **Keep a per-protocol `prepare_*` tool when the flow encodes any of these prepare-time invariants; otherwise route the agent to `prepare_custom_call`:**
  1. **Slippage / MEV math** (swap-class — `min_out`, deadline, sqrt-price-limit).
  2. **Protocol-pause / cap / threshold preconditions** (lending-class — `isWithdrawPaused` / `isSupplyPaused`, supply cap, min-borrow).
  3. **Approve+action bundling** with burn-address + unlimited-approval gates.
  4. **Durable-binding to a verified candidate** (Inv #15 — validator, market, bank, comet, ATA).
  5. **Non-standard token semantics** (rebasing, fee-on-transfer).
- The cutoff is **structural, not popularity-based**: a Uniswap V3 `collect` that takes no slippage args can legitimately go generic; a brand-new Layer-N farm that takes a `min_out` cannot, even if it has only a handful of users.
- **Threat-model rationale.** `assertTransactionSafe` blocks 4 (catch-all unknown destination) and 5 (per-destination ABI-selector check) are bypassed for ack-stamped `prepare_custom_call` txs; only blocks 2 (approve spender allowlist) and 3 (transfer on unknown token) still fire. Per-protocol tools concentrate prepare-time invariants the generic path cannot enforce — picking `prepare_custom_call` for a new protocol that meets criteria 1–5 silently drops those invariants behind a single ack.
- Apply at protocol-add design time, before scope is locked. If a proposed `prepare_custom_call`-only path meets any criterion, push back with the specific criterion named; if a proposed `prepare_*` meets none, push back with "this belongs on the generic path." Adopted from research deliverable [#645](https://github.com/szhygulin/vaultpilot-mcp/issues/645) (parent [#638](https://github.com/szhygulin/vaultpilot-mcp/issues/638)). Complementary to `VAULTPILOT_PROTOCOLS` ([#492](https://github.com/szhygulin/vaultpilot-mcp/issues/492) — catalog-growth lever, not a cutoff replacement).

## Git/PR Workflow — project-specific
- Repo root: `/home/szhygulin/dev/recon-mcp`. Worktree path template: `.claude/worktrees/<branch-name>` (relative). Past incidents 2026-04-28 of nested worktrees from a chained `cd` not landing back at the repo root: SunSwap → readme-roadmap, pnl-mtd → claude-md-close-keyword. Run `pwd` after `cd /home/szhygulin/dev/recon-mcp` if uncertain.
- Default base for new branches: `origin/main`. No stacking — the global "branch every new PR off the base branch" rule applies; second-to-merge resolves at PR time via rebase + `--force-with-lease`.

## Cross-Repo Scope Splits
- **When an issue's solution splits between MCP code and skill rendering / agent-flow guidance, file the skill half as a tracked issue in [`vaultpilot-security-skill`](https://github.com/szhygulin/vaultpilot-security-skill) before merging the MCP PR — and link both ways.** "Skill-side, out of scope" buried in a PR-description bullet drops the work. A real issue with the proposed rules + explicit scope statement keeps it visible and lets the skill repo pull it in on its next release.
- **Run the cross-repo sweep at PR-write time, not when the user asks.** Before opening the MCP PR, walk: (a) does this change a behavior the skill cross-checks? (b) does it add/remove a tool the skill's `Scope` section enumerates? (c) does it change MCP-emitted block shapes the skill expects verbatim? (d) does it add a defense layer worth mirroring as skill-side ground truth (Inv #6 / Inv #1.a / Inv #11 patterns)? Yes to any → file the skill issue NOW. Past incident 2026-05-01: PR [#618](https://github.com/szhygulin/vaultpilot-mcp/pull/618) softened the MCP approve-allowlist; the skill-side companion (mirrored spender allowlist + ⚠ NON-CANONICAL SPENDER advisory) was foreseeable from the diff but filed at [vaultpilot-security-skill#26](https://github.com/szhygulin/vaultpilot-security-skill/issues/26) only after the user asked.
- Tells the split is happening: the issue's suggested fix names a tool the MCP doesn't expose (`list_contacts(label=…)` re-derivation before a non-recipient-parameter tool); the proposed defense is "agent should call X first" (skill rules bind cooperating agents); the proposed defense is "emit a CHECKS PERFORMED block listing …" (skill renders the block, not the MCP).
- Format for the skill issue: link the MCP issue + PR; one-paragraph context on what MCP-side shipped; the proposed rules in numbered sections; explicit scope label "cooperating-agent guidance only — rogue agent ignores any rule" (per Rogue-Agent-Only Finding Triage).

## Typed-Data Signing Discipline
- **No typed-data signing tool ships without paired Inv #1b (typed-data tree decode) + Inv #2b (digest recompute) in the same release.** Tools: `prepare_eip2612_permit`, `prepare_permit2_*`, `prepare_cowswap_order`, `sign_typed_data_v4`, any `eth_signTypedData_v4` exposure. Tracked at [#453](https://github.com/szhygulin/vaultpilot-mcp/issues/453).
- Why: hash-recompute alone passes tautologically over a tampered tree — a rogue MCP swaps `spender` inside `Permit{owner, spender, value, nonce, deadline}` and the digest still matches because it's computed over the swap. Worst blast radius in EVM signing: ONE permit signature → perpetual transfer authority for `deadline`'s lifetime (Permit2 batch with 5-year USDT expiration, smoke-test 126, irrevocable once signed).
- Hard precondition: Ledger must clear-sign the typed-data type. If it blind-signs the digest, the agent has no on-device intent verification — the tool MUST refuse (user can't tell `Permit{spender: TRUST_ROUTER}` from `Permit{spender: ATTACKER}` on screen).
- Inv #1b: decode `domain` / `types` / `primaryType` / `message` locally; surface every address-typed field (`spender`, `to`, `receiver`, `verifyingContract`) in CHECKS PERFORMED with bold + inline-code; surface `deadline` / `validTo` / `expiration` with delta-from-now and flag if > 90 days; pin `verifyingContract` against a curated map (Permit2 = `0x000000000022D473030F116dDEE9F6B43aC78BA3`, USDC permit, CowSwap settlement) and refuse on mismatch; apply Inv #11 unlimited / long-lived rules per entry when `primaryType` ∈ `{Permit, PermitSingle, PermitBatch, Order}`.
- Inv #2b: independently recompute `keccak256("\x19\x01" || domainSeparator || hashStruct(message))` from the decoded tree, match against MCP-reported digest.
- Apply at PR-review and design time — push back on plans that bundle "ship the tool, add invariants later." Today's defense is gap-by-design (no typed-data tools); the moment that gap closes without #1b + #2b, every existing skill defense is silently bypassed.

## Rogue-Agent-Only Finding Triage
- **When the threat is "rogue agent generates harmful advisory text" or "rogue agent fabricates/suppresses MCP results" with no signing flow, close as architectural — don't ship MCP/skill mitigations pretending to fix it.** The skill is text in the agent's context; a hostile agent reads any rule and ignores it. Real defenses live at model-safety-tuning (Anthropic) or chat-client output-filter (Claude Code / Cursor / Desktop) — neither in scope here.
- Tells: output is purely advisory text (no `prepare_*` / `preview_send` / `send_transaction`); agent fabricates a security UI (fake `CHECKS PERFORMED` with `{✓}` verdicts); agent suppresses or falsifies MCP results; proposed fix is "add a rule to SKILL.md" with no other layer.
- **Don't confuse with rogue-MCP + cooperating-agent (Role B).** Skill rules genuinely bind a cooperating agent; read-only response-spoofing, fabricated `compare_yields` rows are real targets for skill-side guidance.
- **Don't confuse with device-layer architectural** (e.g. Ledger blind-sign) — different escalation path (vendor, not model/UI safety).
- Closing template: brief comment naming the architectural gap, citing #536 (canonical) + vaultpilot-mcp-smoke-test#21 (Role A scope-reframing methodology), one-line recap of why skill rules don't help.
- Cooperating-agent guidance with an explicit honest scope label IS acceptable (skill v0.7.0 / vaultpilot-security-skill PR #20). The rule above forbids dressing it up as a defense against the rogue case it isn't actually defending — security theater. Scope label "guides cooperating agents; does NOT defend against a rogue agent that ignores it" must be in the rule body, not just the PR description.

## Reference framework: fastmcp
- When writing MCP server code, consult [punkpeye/fastmcp](https://github.com/punkpeye/fastmcp) for ergonomic patterns. **Don't take the dependency** — its transitive surface (`hono`, `undici`, `execa`, `file-type`, `fuse.js`, `mcp-proxy`) re-inflates the slim binary, and its value sits in HTTP/SSE/OAuth/edge layers irrelevant to a stdio server. Stay on `@modelcontextprotocol/sdk` directly.
- **Apply now: MCP tool annotations on every `registerTool` call (currently zero coverage in `src/index.ts`).** The wrapper passes `opts` through to `server.registerTool`, which accepts `{ title?, description?, inputSchema?, outputSchema?, annotations?, _meta? }`. `annotations` carries `{ title?, readOnlyHint?, destructiveHint?, idempotentHint?, openWorldHint? }` and the SDK forwards them to the host (Claude Code / Desktop) for UI warnings and caching. Defaults by family:
  - `get_*` / `list_*` / `preview_*` / `explain_*` / `check_*` / `resolve_*` / `verify_*` / `simulate_*` / `read_*` → `readOnly + openWorld`.
  - `prepare_*` → `destructive + idempotent` (returns unsigned tx; re-prepare just rebuilds a draft).
  - `send_transaction` → `destructive + openWorld`, NOT idempotent (nonce-bound; rebroadcasting a confirmed tx reverts).
  - `pair_ledger_*` / `set_*_api_key` / `add_contact` / `register_btc_multisig_wallet` / `import_*` → `idempotent`, local config only (`openWorldHint: false`).
  - `request_capability` → `openWorld`, NOT idempotent (creates a GitHub issue).
  - `combine_*` / `finalize_*` / `sign_*` / `submit_*` (PSBT/signature plumbing) → `destructive + idempotent`, NOT openWorld (local artifact ops; broadcast happens elsewhere). Exception: `finalize_btc_psbt` with `broadcast=true` is effectively `send_transaction`-class — annotate the safer default branch and document the broadcast path in `description`.
  - `revoke_*` / `remove_*` / `unregister_*` → `destructive + idempotent`, local-only (re-delete is a no-op).
  - `rescan_*` → `readOnly + openWorld` (cache write is a memoization detail; observable behavior = fetch from indexer).
  - `share_*` → read family (`readOnly + openWorld`); the snapshot is an anonymized read+transform of on-chain state, no mutation.
  - Per-tool overrides:
    - `prepare_solana_nonce_init` / `prepare_solana_nonce_close` → NOT idempotent (consume a one-shot account slot; re-running fails).
    - `exit_demo_mode` → read family but local-only (`readOnly + idempotent + NOT openWorld`); produces a guide, no chain read, no state change.
    - `generate_readonly_link` → `destructive + NOT idempotent + NOT openWorld` (mints a fresh token per call and writes its sha256 to the issuer-side store; no chain interaction).
  - Always set `annotations.title` for a human-readable label distinct from the snake_case name.
- **Don't replace the `registerTool` wrapper with fastmcp's `server.addTool` builder.** The wrapper carries demo-mode dispatch (whale-persona auto-select for `prepare_*`, broadcast-tool simulation envelope, always-/conditionally-gated refusal branches) and conditional scope-loading via `isToolEnabled` — fastmcp's API has no slot for either.
- **Defer until a real "feels stuck" report justifies it:** progress notifications (`_meta.progressToken` + `notifications/progress` via the handler `extra` arg) for fanout tools, and `UserError`-style typed user-vs-programmer error split.
