# VaultPilot Roadmap

**New protocols (EVM)**

- **Curve + Convex + Pendle + GMX V2** — stable-LP / yield-trading / perps. Direct ABI integration for Curve / Convex / GMX; `@pendle/sdk-v2` for Pendle. ([plan](./claude-work/plan-defi-expansion-roadmap.md))
- **Balancer V2 + V3 + Aura** — Vault-centric LP + V3 Hooks pools + Aura boost. ([plan](./claude-work/plan-balancer-v2-v3-aura.md))
- **DEX liquidity verb set** — Uniswap V3 `mint` / `collect` / `decrease_liquidity` / `burn` / `rebalance` (reads already shipped), Curve LP, Balancer LP. ([plan](./claude-work/plan-dex-liquidity-provision.md))
- **Canonical L1↔L2 / L2↔L2 bridges** — Optimism / Base (Bedrock, shared ABI), Arbitrum, Polygon PoS. Trust-minimized alternative to LiFi: slow (7-day proof window for OP-Stack rollups, ~30 min – 3 h for Polygon PoS exit) but L1-anchored. Phased per-bridge; Phase 1 (OP+Base) is the smallest unit. ([plan](./claude-work/plan-canonical-bridges.md))

**New chains**

- **Hyperliquid L1** — full parity (perps + spot + vaults + staking + TWAP). Ledger-per-trade blind-sign signing; no API-wallet shortcut. ([plan](./claude-work/plan-hyperliquid-full-parity.md))
- **Aptos + Sui** (Move-VM) — read first (balance + staking + Sui objects), then Ledger USB HID pair + native send + stake delegate per chain. WalletConnect doesn't carry Move namespaces, so signing follows the TRON / Solana USB precedent. Phase 1 (Aptos read-only) is the smallest unit. ([plan](./claude-work/plan-aptos-sui-chain-support.md), [Sui-only single-PR alternative design](./claude-work/archive/plan-sui-support.md))
- **More EVM chains — Avalanche, BSC, Linea, Scroll** — top-5 EVM chains by user count + dominant L2s VaultPilot doesn't yet support. Each chain is one PR (chain config + RPC + Etherscan-equivalent + per-protocol address coverage where deployed). Risk is low, well-understood; ship one at a time. ([plan](./claude-work/archive/plan-more-evm-chains.md))

**More Solana protocols**

- **Drift + Solend lending** — Kamino's `prepare_kamino_*` tools shipped; Drift / Solend are the remaining Solana lending protocols on the planned set. ([plan](./claude-work/plan-drift-solend-lending.md))
- **Jito liquid-staking writes** — reads ship today; writes blocked on the SDK's ephemeral-signer pattern, raw-ix builder workaround tracked.
- **Multi-tx send pipeline** — unblocks flows that exceed the single-v0-tx size limit (needed for parts of Kamino / Drift).

**New tools**

- **`check_liquidation_risk`** — per-asset "ETH drops X% triggers liquidation" math across Aave V3 / Compound V3 / Morpho Blue. Replaces today's raw-HF-number output with actionable price deltas. ([plan](./claude-work/plan-health-factor-monitoring.md))
- **`prepare_eth_validator_deposit`** — solo-validator activation: 32 ETH deposit to the Beacon Deposit Contract (`0x00000000219ab540356cBB839Cbe05303d7705Fa`) using a `deposit_data.json` produced off-chain by `staking-deposit-cli`. Optional batch shape for multi-validator activations. Today's `prepare_lido_stake` produces stETH (LST exposure, not validator ownership) and `prepare_eigenlayer_deposit` is restaking on top of an existing LST — neither activates a solo validator. ([#430](https://github.com/szhygulin/vaultpilot-mcp/issues/430))

**Tool follow-ups (v1 shipped, v2 backlog)**

Each entry is a parking-lot of deferred sub-items captured at v1 ship time. Pick any one when demand justifies; sub-items are mutually independent in the linked plan files.

- **`get_portfolio_diff` v2 — 6 deferred buckets** that currently lump into the v1 residual `otherEffectUsd`: (A) interest accrued, (B) borrow interest paid, (C) realized swap PnL, (D) liquidation events, (E) LP fee earnings, (F) reward claims. Each bucket needs its own per-protocol historical-state reader at window-start; ship one at a time. v1 framework in PR #196. ([plan](./claude-work/archive/plan-portfolio-diff-buckets.md))
- **`explain_tx` v2 — 7 deferred items** in roughly decreasing user-visible value per LoC: (1) Bitcoin support, (2) historical pricing replacing current-spot, (3) Solana SPL `approve`/`approveChecked` delegate pattern, (4) TRON base58check address encoding, (5) "what you signed" hash re-derivation, (6) full call-graph trace via `debug_traceTransaction`, (7) MEV / sandwich-aware analysis (cross-tx forensics is item 8, lower priority). v1 in PR #283. ([plan](./claude-work/archive/plan-tx-postmortem-followups.md))
- **Curve v0.2 — 9 follow-up PRs** after v0.1 (#320: `get_curve_positions` + `prepare_curve_add_liquidity`, Ethereum stable_ng plain pools only). Cheapest-first ordering: `get_curve_pool_info` read tool, `prepare_curve_remove_liquidity` (+ one-coin variant), gauge surface (deposit/withdraw/claim), meta-pool dispatch, factory dispatch (stable v1/v2 + crypto + twocrypto + tricrypto), Arbitrum + Polygon expansion, legacy pre-factory pools (3pool, fraxusdc, susdv2, ren, sbtc, ...), Base chain (after SDK author resolves TODOs), gauge ABI generations (v2/v3/v4 + child + rewards-only). Tracked at [#321](https://github.com/szhygulin/vaultpilot-mcp/issues/321). ([plan](./claude-work/archive/plan-curve-v2-deferred-prs.md))
- **Demo-saga remaining items** — punch list captured 2026-04-27 after the demo arc closed #371. Highest value: manual end-to-end smoke test, generalize the runtime-override + nudge mechanism to Etherscan + Reservoir. Medium: markdown-render the simulation envelope for in-chat readability, README/docs update. Lower: persona address rotation watcher, smarter default-mode refusal messages. (`--demo` CLI alias already shipped.) ([plan](./claude-work/archive/plan-demo-saga-followups.md))
- **Solana multi-tx send pipeline** — sequence primitive that lets one handle hold N ordered txs (Kamino's `buildXxxTxns` setup+main+cleanup flows; EVM approve→action one-handle UX). Today the draft store at `src/signing/solana-tx-store.ts` is one-tx-per-handle. Already mentioned under "More Solana protocols" above; cross-linked here for the v2-backlog grouping. ([plan](./claude-work/archive/plan-solana-multi-tx-pipeline.md))

**`compare_yields` adapter expansion** — v1 (Aave V3 + Compound V3 + Lido, PR #282) and v2 (DefiLlama-bundled Marinade + Jito + Kamino-lend + Morpho-Blue + on-chain MarginFi) shipped. Remaining adapters (EigenLayer, Solana native-stake) are structurally different — per-operator / per-validator rows rather than per-protocol APR — and each needs its own plan file. Full scope in [plan-yields-v2-followups.md](./claude-work/plan-yields-v2-followups.md).

**NFT tooling — Solana follow-ups to #433**

The portfolio reader landed Solana NFT support via Helius DAS in #433; the per-feature readers and pricing are deferred follow-ups.

- **Solana branch on `get_nft_history`** — wire Helius DAS `getSignaturesForAsset` (per-asset granularity), mapped to the existing `NftHistoryItem` shape (mint / sale / transfer / etc.). Probably a `solanaAsset` arg distinct from the EVM `wallet` shape. ([#474](https://github.com/szhygulin/vaultpilot-mcp/issues/474))
- **Solana branch on `get_nft_collection`** — DAS `getAssetsByGroup({groupKey: "collection"})` for collection metadata + Magic Eden's `/v2/collections/{symbol}/stats` for floor / volume / royalty. Degrades cleanly when Magic Eden is rate-limited (collection metadata still surfaces). ([#475](https://github.com/szhygulin/vaultpilot-mcp/issues/475))
- **Solana NFT portfolio floor pricing** — fan out per-collection floor lookups via Magic Eden (Tensor as fallback) so `floorEth` / `floorUsd` / `totalFloorUsd` populate on Solana rows; drops the current `notes[]` advisory that calls out the gap. ([#476](https://github.com/szhygulin/vaultpilot-mcp/issues/476))

**Bitcoin / Litecoin tooling**

- **BIP-322 message signing** — `sign_message_btc` ships BIP-137 today, which fails (or falls back to legacy-address tricks) for `bc1q` (P2WPKH) and `bc1p` (Taproot) addresses. Modern verifiers (exchanges, proof-of-reserves tools, Sparrow / Coldcard ecosystem) expect BIP-322. Deferred pending a scope probe of the Ledger BTC app's BIP-322 firmware floor + which SDK exposes the entrypoint (`@ledgerhq/hw-app-btc` vs the newer `ledger-bitcoin` v2 client) — implementing the wrong flavor (simple / full / legacy) yields valid signatures verifiers reject, and signature-flavor bugs are silent (sig generates, verifier rejects, user is confused). ([#438](https://github.com/szhygulin/vaultpilot-mcp/issues/438))
- **`dryRun` mode for `prepare_btc_send` / `prepare_ltc_send`** — `dryRun: true` synthesizes a placeholder `paired` shape (addressType inferred from prefix, source-as-change loopback, `signable: false` flag) so an agent can build + return calldata without first running `pair_ledger_btc` / `pair_ledger_ltc`. The pairing-cache lookup is woven through the build flow at multiple points (`addressType` / `accountIndex` / `path` for PSBT input + `pickChangeEntry` derivation), so this is real surgery (~80 LoC per chain), not a one-line guard. Today's pairing-required flow covers the actual signing case; `dryRun` is forward-looking inspection. ([#479](https://github.com/szhygulin/vaultpilot-mcp/issues/479))
- **BTC / LTC indexer extensions: `difficulty_timeline` + coinbase pool-tag parsing** — closes the remaining open scope from #233. The two tools that weren't in PR #266's RPC-tier ship because they need indexer-tier extensions, not RPC. Read-only against existing Esplora endpoints; ~300-450 LoC + tests including the curated pool-tag list (rots over time but that's a curation pace issue, not a correctness one). ([plan](./claude-work/archive/plan-incidents-and-utxo-rpc-followups.md) §5)

**Wallet integrations**

- **MetaMask Mobile** via WalletConnect v2 — alongside Ledger Live. Reduced final-mile anchor (software wallet) surfaced clearly in docs + pairing receipt. Browser-extension bridge deferred to a follow-up. ([plan](./claude-work/plan-metamask-mobile-walletconnect.md))
- **Multi-hardware-wallet — Trezor, Keystone, GridPlus Lattice** — VaultPilot is Ledger-only today. Each new vendor expands addressable market 10-20% and removes the single-vendor dependency. Keystone in particular has a strong air-gapped story (QR-only signing) that pairs naturally with the security positioning. Staged per device. ([plan](./claude-work/archive/plan-multi-hardware-wallet.md))

**MCP server ergonomics (fastmcp-inspired)**

Deferred per CLAUDE.md fastmcp section's "Defer until a real 'feels stuck' report justifies it." Each is non-load-bearing UX/routing polish; pick up when a concrete signal makes the cost/benefit obvious.

- **Progress notifications for long-running fanout tools** — wire MCP `_meta.progressToken` + `notifications/progress` into the registerTool wrapper, then emit at meaningful boundaries from fanout tools (`get_health_alerts`, `rescan_btc_account`, `get_portfolio_summary`, `compare_yields`, `build_incident_report`, `get_daily_briefing`). Pick up on a real "this hung" report. ([plan](./claude-work/plan-progress-notifications.md))
- **Tool description tightening per Documentation Style** — 186 `registerTool` call sites; the top offenders (≥1000 chars: `prepare_safe_tx_propose`, `share_strategy`, `generate_readonly_link`, ~15-25 tools total) fail the "state each idea once" / "lead with the strongest sentence" / "cut hedging adjectives" bar. Descriptions are the agent's routing prompt — cuts must preserve AGENT BEHAVIOR routing directives, cross-references, and refusal conditions. Ship top offenders only in PR #1; defer the rest. ([plan](./claude-work/plan-tool-description-tightening.md))
- **`UserError` typed-error split for handler responses** — distinguish user-recoverable errors (bad input, insufficient balance, market paused, missing approvals) from programmer errors (RPC schema drift, IDL layout mismatch). Today every error is a plain `Error("msg")`; the split cleans up host UI and preserves triage signal for real bugs. PR #1 ships the infra + 5-10 conversions; bulk migration in #2+. ([plan](./claude-work/plan-user-error-typed-split.md))

**Build / packaging**

- **Tier-2 binary slim — strip Kamino kliquidity** (Raydium / Orca / Meteora). Picked up only if Tier-1 mitigations (#361) + upload retry (#349) don't land enough headroom in practice. As of 2026-04-27, the linux-x64 binary is 420 MB (down from 504 MB pre-mitigation), comfortably below the empirical upload-failure threshold; Tier-2 would shave another ~100 MB but requires forking the kliquidity-sdk surface or vendoring the lending-only subset. ([plan](./claude-work/archive/plan-binary-slim-tier2-kamino.md))

**Distribution**

- **Anthropic Connectors Directory submission** — submit VaultPilot MCP to [Anthropic's Connectors Directory](https://claude.com/partners/mcp) (~280-300 entries, manual review). Listing exposes the connector to discovery from claude.ai's in-product Connectors UI, Claude Desktop, Claude Mobile, and Claude Code. Verified 2026-04-26 — VaultPilot not yet listed. ([plan](./claude-work/archive/plan-anthropic-connectors-directory-submission.md))

**Deployment modes**

- **Hosted MCP endpoint** — OAuth 2.1 + bearer tokens, operator-supplied API keys, EVM-only for v1. **Unblocks Claude.ai chat (web + native desktop app)**, where the host environment's outbound-HTTP allowlist blocks chain RPC providers (PublicNode, public Solana mainnet, Alchemy, Helius, etc.) and the local stdio MCP can't complete reads. Headless users get the same backend. TRON / Solana / Bitcoin / Litecoin USB-HID signing requires a local Ledger connection and stays on the terminal CLI / Cursor path regardless.

**Security hardening**

- **Server-integrated second-agent verification** — MCP calls an independent LLM directly on high-value sends and blocks on disagreement. Structurally closes the coordinated-agent gap that today's copy-paste `get_verification_artifact` flow only narrows.
- **Curate `KNOWN_SQUADS_GOVERNED_PROGRAMS`** — the `pending_squads_upgrade` Solana incident signal (#251 / PR #260) currently emits an empty vendor list (`scannedMultisigs: 0, note: "vendor list is empty pending curation"`). Populating it requires per-protocol governance verification: for each candidate (MarginFi v2, Marinade, Jito stake-pool, Kamino Lend, Jupiter v6, Raydium AMM v4, ...), fetch the program-data account and confirm a Squads V4 vault PDA is the `upgradeAuthority`, then derive the multisig PDA via `@sqds/multisig` `getMultisigPda`. Each entry must cite the source per the existing curation policy in `solana-known.ts`. ~30 min × 6 protocols. ([plan](./claude-work/archive/plan-incidents-and-utxo-rpc-followups.md) §1)
- **PreToolUse hook for mechanical hash enforcement** — host-side code that recomputes the pre-sign hash and blocks the MCP tool call on divergence, making the check mechanical rather than prose-based. Ships as a separate `vaultpilot-hook` repo.
- **Contacts unsigned/verified state machine** (follow-up to [#428](https://github.com/szhygulin/vaultpilot-mcp/issues/428)) — persistent on-disk unsigned entries + `promote_unsigned_contacts` sign-on-pair upgrade flow + tamper-aware merge between signed and unsigned overlays. Today's #428 fix covers the user-visible "first-run users can label addresses without a Ledger" gap with a process-local in-memory store; the deferred state machine adds restart-survivable persistence and the upgrade-on-pair semantics. ([plan](./claude-work/plan-contacts-unsigned-state-machine.md))
- **Sandwich-MEV hint expansion to L2s** — mainnet hint ships in `prepare_swap` / `prepare_uniswap_swap` (slippage × notional flagged at 0.5% on Ethereum). L2 expansion (Optimism / Base / Arbitrum / Polygon PoS / zk-rollups) needs per-chain thresholds + wording that accurately reflects the lower-but-nonzero risk on each ordering model. ([plan](./claude-work/plan-mev-hint-l2-expansion.md))
- **Proactive phishing / scam pre-tx warnings** — flip `check_contract_security` and `check_permission_risks` from on-demand to **automatic on every `prepare_*`**. If a target contract is unverified, very new, on a known-bad list, or requesting unusual approvals, the prepare-tx response gets a prepended warning block that's hard to ignore. Leverages existing infrastructure; no new tool surface. ([plan](./claude-work/archive/plan-proactive-tx-warnings.md))
- **`prepare_custom_call` selector classifier** — value-exfil pattern detection deferred from #494 / #493: refuse obviously-malicious calldata patterns when the user is calling them on a contract they own (e.g. `transferFrom(self, attacker, ...)`, `approve(attacker, max)` on a token they own). Reuses the security skill's selector classifier. Today's `prepare_custom_call` ack-gates on the user but doesn't classify the bytes. ([plan](./claude-work/archive/plan-custom-call-selector-classifier.md))
- **Device-trust verification follow-ups** — issue [#325](https://github.com/szhygulin/vaultpilot-mcp/issues/325)'s P1-P5 priorities (P0 startup self-check shipped via PR #388). Defense-in-depth checks the MCP runs independently before forwarding any signing request: Secure Element attestation, firmware/app version pinning, Ledger Live binary signature check, etc. Narrows trust surface from "all of Ledger Live + the device" to specific, individually-verifiable components. ([plan](./claude-work/archive/plan-device-trust-followups.md))
- **Skill-integrity server-side enforcement** — designs 1 / 2 / 3 of issue [#379](https://github.com/szhygulin/vaultpilot-mcp/issues/379) closing the "agent can silently skip the preflight skill's integrity check" gap. Design 4 (startup self-check) shipped via PR #388 — that's the cheap diagnostic layer. Remaining designs raise the bar (signed-attestation challenge, etc.). ([plan](./claude-work/archive/plan-skill-integrity-server-enforcement.md))
- **Per-agent scoped permissions** — when users run multiple agents (Claude Code + Cursor + Claude Desktop + a mobile agent), they want **scoped** access per agent: read-only here, propose-swaps-only there, full-power there. Limits blast radius. Pairs with the bearer-token auth in the hosted-MCP plan. ([plan](./claude-work/archive/plan-agent-scoped-permissions.md))
- **Tier-1 bridge facet decoders — MCP-side mechanical (Inv #6b hardening)** — adversarial scripts 136 / 137 confirmed outer LiFi `BridgeData` passes Inv #6 cleanly while the attacker recipient lives one decode-layer deeper (`NearData.receiverAccountId`, `MayanData.nonEvmRecipient`, etc.) and the Ledger ETH app blind-signs. Skill v8 Inv #6b mandates the agent extract + compare; the MCP-side mechanical decoder for Wormhole TokenBridge / Mayan / NEAR Intents / Across V3 (server-side `✗ BRIDGE-FACET RECIPIENT MISMATCH` regardless of agent cooperation) is the deferred half. Coordinated release: skill sentinel bump hardens Inv #6b from "agent-extracts" to "MCP-decodes-and-asserts" + MCP decoder ships in lockstep. Blocked on a per-bridge scope probe of facet tuple shapes against real explorer calldata — wrong-tuple decode parses garbage as a valid recipient and ships a silent vuln. ([#451](https://github.com/szhygulin/vaultpilot-mcp/issues/451))
- **Tier-2 bridge facet decoders** — skill v8 ships Tier-1 (Wormhole / Mayan / NEAR Intents / Across V3) recipient cross-checks under Inv #6b. Tier-2 (deBridge / DLN, Stargate composeMsg, Hop, Symbiosis) is deferred until usage data justifies the per-bridge probe + decoder cost. Falls back to best-effort agent address-extraction + mandatory second-LLM check (Inv #12.5) until shipped. ([plan](./claude-work/plan-bridge-facet-decoder-tier2.md))
- **Typed-data signing surface — gated on Inv #1b + #2b** — `prepare_eip2612_permit`, `prepare_permit2_*`, `prepare_cowswap_order`, `sign_typed_data_v4`. Today's defense is gap-by-design. Shipping any of these without paired Inv #1b (tree decode + `verifyingContract` pin + address-field surfacing) and Inv #2b (digest recompute over decoded tree) silently bypasses every existing skill defense — see [Typed-Data Signing Discipline](./CLAUDE.md#typed-data-signing-discipline) in CLAUDE.md for the full rationale. Hard precondition: Ledger must clear-sign the typed-data type. ([#453](https://github.com/szhygulin/vaultpilot-mcp/issues/453))
- **`prepare_eip7702_authorization` builder + skill v9 release** — 7702 setCode is the highest-blast-radius EOA signature (full code-execution rights, persistent, `chain_id = 0` drains every EVM chain). Skill §16 refuses unconditionally until MCP + skill v9 ship together. **MCP arm**: `prepare_eip7702_authorization({ implementation, chainId, nonce })` targeting ERC-5792 `wallet_sendCalls` (the wallet-side convergence point — bare `eth_signAuthorization` isn't standardized in WC namespaces), `chain_id ≠ 0` enforcement, paired revocation-tuple emission, Inv #12.5 mandatory second-LLM, out-of-band implementation-address re-statement. No curated allowlist needed — Ledger ETH app v1.18.0+ enforces it on-firmware. **Skill arm**: §16 lifted, `EXPECTED_SKILL_SHA256` updated in lockstep. Blocked on a Ledger Live WC-bridge ERC-5792 support probe. ([#481](https://github.com/szhygulin/vaultpilot-mcp/issues/481), [plan](./claude-work/plan-eip7702-authorization-builder.md))

**Recently shipped** (previously on this list)

2026-04-28 push:

- **`compare_yields` v2** — DefiLlama-bundled Marinade + Jito + Kamino-lend + Morpho-Blue (#500) + on-chain MarginFi adapter (#502). Closes #431 v2 + #288.
- **`get_pnl_summary`** — wallet-level net PnL across EVM / TRON / Solana with `mtd` / `ytd` / `30d` / `7d` / `1d` periods (#525). Closes #447.
- **Rocket Pool stake / unstake** — `prepare_rocketpool_stake` + `prepare_rocketpool_unstake` (rETH) on Ethereum (#490). Closes #429.
- **Lido stETH ↔ wstETH wrap** — `prepare_lido_wrap` / `prepare_lido_unwrap` (#467). Closes #442.
- **`prepare_custom_call` escape hatch** — arbitrary EVM contract calls with `acknowledgeNonProtocolTarget: true` gate, paired with `get_contract_abi` (#494, #497, #498).
- **`prepare_sunswap_swap`** (TRON) — same-chain TRX↔TRC-20 swaps via SunSwap (#510). Closes #432.
- **`resolve_token`** — symbol→contract lookup across EVM / Solana / TRON with bridged-variant disambiguation (#515). Closes #440.
- **`build_incident_report`** — read-only forensic bundle for post-incident analysis (#426).
- **`list_solana_validators`** — validator-ranking helper for `prepare_native_stake_delegate` (#512). Closes #436.
- **Solana NFT portfolio reader** — Helius DAS branch on `get_nft_portfolio` (#478, #433 partial).
- **Token-class registry** — non-standard ERC-20 transfer-semantics flags (rebasing seed: stETH + AMPL) on `prepare_token_send` (#509). Closes #441.
- **Demo auto-persona on `prepare_*`** — default-mode UX upgrade (#477). Closes #446.
- **Sandwich-MEV mainnet hint** on `prepare_swap` / `prepare_uniswap_swap` (#472, slippage × notional flagged at 0.5% on Ethereum). Closes #445. L2 expansion still on the Security-hardening list above.
- **`get_health_alerts`** multi-protocol (Compound V3 + Morpho + MarginFi + Kamino) (#466). Closes #427.
- **Schema fixes / UX**: `prepare_morpho_repay` accepts `amount: "max"` (#513, closes #437), `prepare_solana_native_send` optional memo (#506, closes #434), `prepare_btc_send` fee-priority preset enum (#473, refs #435), `add_contact` works without paired Ledger (#471, closes #428 partial), `TRON_TOKENS.USDD` corrected (#522, closes #507).
- **Security skill v8 → MCP companion** — Inv #1.a canonical-dispatch allowlist (#480, #489), Inv #14 durable-binding source-of-truth verification (#529, closes #460), Inv #8 BIP-137 message-sign hardening with byte-fingerprint + drainer-string refusal (#524, closes #454), Inv #12.5 hard-trigger-ops `secondLlmRequired` scaffold (#530, closes #501).
- **Conditional tool-surface gating** — `VAULTPILOT_CHAIN_FAMILIES` + `VAULTPILOT_PROTOCOLS` env vars narrow the registered tool set per install (#492).
- **Unified `vaultpilot-mcp setup` binary** — server + setup wizard ship as one binary (#487). Releases 0.12.0 / 0.12.1.

Earlier:

- **Bitcoin + Litecoin via Ledger USB HID** — native segwit + taproot sends (`prepare_btc_send` / `prepare_litecoin_native_send`), multisig (PSBT combine + finalize), portfolio integration (`get_btc_balances`, balance/UTXO/tx-history readers), mempool.space fee estimation, BIP-125 RBF (`prepare_btc_rbf_bump`), BIP-137 message signing.
- **`compare_yields` v1** — Aave V3 (5 chains), Compound V3 (5 chains, multi-market), Lido stETH (#282).
- **Kamino lending** (Solana) — `prepare_kamino_init_user` + supply / withdraw / borrow / repay tools.
- **Nonce-aware dropped-tx polling** (Solana) — on-chain nonce is the authoritative signal for whether a durable-nonce tx can still land; replaces the `lastValidBlockHeight` path that's meaningless for nonce-protected sends (#137).
- **Solana liquid + native staking** — Marinade / Jito / native stake-account reads (#141, portfolio fold-in #143), Marinade writes (#145), native SOL delegate / deactivate / withdraw (#149).
- **LiFi cross-chain EVM ↔ Solana routing** (#153, #155).
