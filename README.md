# VaultPilot MCP

[![npm version](https://img.shields.io/npm/v/vaultpilot-mcp.svg)](https://www.npmjs.com/package/vaultpilot-mcp)
[![license](https://img.shields.io/npm/l/vaultpilot-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/vaultpilot-mcp.svg)](package.json)

Self-custodial DeFi for AI agents. The agent proposes, you approve on your Ledger — designed for the threat model where the agent, MCP, and host can all be compromised. Only the device is trusted; private keys never leave it.

![VaultPilot MCP demo](./demo.gif)

Read on-chain positions and prepare transactions across **Ethereum, Arbitrum, Polygon, Base, Optimism, TRON, Solana, Bitcoin, and Litecoin**. Supported protocols: **Aave V3, Compound V3, Morpho Blue, Uniswap V3 (swap + LP verbs), Curve, Lido, EigenLayer, Rocket Pool, Safe (Gnosis) multisig** on EVM, **MarginFi, Kamino, Marinade, Jito** on Solana, **SunSwap** on TRON, plus **LiFi** (EVM + EVM↔Solana + TRON + BTC swap/bridge) and **Jupiter v6** (Solana swap), with **1inch** as an optional EVM quote cross-check. EVM signs over WalletConnect → Ledger Live; TRON, Solana, Bitcoin and Litecoin sign over USB HID directly to the device (Ledger Live's WalletConnect bridge does not support those namespaces today). Works with **Claude Code** (CLI/terminal), **Cursor**, and any MCP-compatible client over stdio. **Claude.ai chat (web + native desktop app) needs a hosted MCP endpoint** — [on the roadmap](./ROADMAP.md#deployment-modes), not yet shipped.

> Agents: read **[AGENTS.md](./AGENTS.md)**. One-line prompt to paste into Claude Code / Cursor / any MCP-capable agent:
> ```
> Install VaultPilot MCP from https://github.com/szhygulin/vaultpilot-mcp following AGENTS.md.
> ```

## Features

- **Portfolio** — cross-chain balances, DeFi position aggregation, USD totals, NFT collections (EVM + Solana via Helius DAS), wallet-level PnL (`mtd` / `ytd` / `30d` / `7d` / `1d`), daily briefing
- **Positions** — Aave, Compound, Morpho, Uniswap V3 LP, Curve, MarginFi, Kamino, Safe (Gnosis) multisig; multi-protocol health-factor alerts; liquidation-risk simulation
- **Staking** — Lido (stake / unstake / stETH↔wstETH wrap) + EigenLayer + Rocket Pool (EVM); TRON Stake 2.0 (freeze / unfreeze / vote / claim); Solana (Marinade, Jito, native delegate/deactivate/withdraw)
- **Swaps + bridges** — LiFi (EVM + EVM↔Solana + TRON + BTC routes, optional 1inch cross-check), Jupiter v6 (Solana), direct Uniswap V3, Curve, SunSwap (TRON)
- **Execution** — prepare/sign for every supported protocol + native/token sends, ERC-20 approvals + revoke, WETH wrap/unwrap, `prepare_custom_call` escape hatch for arbitrary verified-contract calls. Solana sends use a per-wallet durable-nonce account so Ledger review doesn't race the ~60s blockhash window; every Solana prepare runs a `simulateTransaction` gate so program-level reverts fail at prepare time, not on broadcast.
- **Bitcoin + Litecoin** — native segwit + taproot sends, BIP-125 RBF fee-bumps, PSBT multisig (combine / sign / finalize), BIP-137 message signing, mempool.space fee estimation, optional Bitcoin Core / Litecoin Core RPC for forensic chain reads (forks, mempool census, fee percentiles)
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, DefiLlama-backed risk score, on-device Ledger attestation + firmware version pin, `verify_tx_decode` for second-LLM bytes-vs-intent cross-check, signed on-disk contacts/address-book
- **Utilities** — ENS resolution, symbol→contract `resolve_token` registry, token balances, allowance enumeration, tx status, `explain_tx` post-hoc decode, `compare_yields` across lending + LST adapters
- **Demo mode** — curated personas (`whale` / `defi-degen` / `stable-saver` / `staking-maxi`) for first contact with no RPC keys / Ledger / config file

## Security model

Compromise model: the AI agent, MCP server, and host computer can all be attacker-controlled. Only the Ledger is trusted. Every transaction is cryptographically bound across each layer so tampering — a swapped recipient, a rewritten swap route, a smuggled approval — is tamper-evident on the device screen before signing.

```
user-intent ──► agent ──► MCP server ──► WalletConnect / USB-HID ──► Ledger Live / host ──► Ledger device
```

Defense in depth: server-side prepare↔send fingerprint, independent 4byte.directory selector check, agent-side ABI decode + pre-sign hash recompute, on-device clear-sign or blind-sign-hash match, WalletConnect session-topic cross-check, `previewToken`/`userDecision` gate, and `get_verification_artifact` for second-LLM cross-verification on high-value flows. **See [SECURITY.md](./SECURITY.md)** for the full threat model, defenses table, residual risks, and verification recipes.

### Agent-side hardening (strongly recommended)

The MCP's own `CHECKS PERFORMED` directives can be silently omitted by a compromised server. Install the companion [`vaultpilot-security-skill`](https://github.com/szhygulin/vaultpilot-security-skill) so the agent enforces cryptographic-integrity invariants regardless of what the MCP says — bytes decode, dispatch-target allowlist, hash recompute, chain-must-be-explicit, bridge-recipient cross-check, approval-class surfacing, mandatory second-LLM on hard-trigger ops, set-level intent verification, durable-binding source-of-truth:

```bash
git clone https://github.com/szhygulin/vaultpilot-security-skill.git \
  ~/.claude/skills/vaultpilot-preflight
```

Restart Claude Code. The skill file's SHA-256 is pinned in the server source; on-disk tamper or plugin collision surfaces as `integrity check FAILED`.

### Conversational `/setup` (optional)

For chat-driven onboarding that detects current config and only collects keys you actually need, install the companion [`vaultpilot-setup-skill`](https://github.com/szhygulin/vaultpilot-setup-skill):

```bash
git clone https://github.com/szhygulin/vaultpilot-setup-skill.git \
  ~/.claude/skills/vaultpilot-setup
```

Restart, then type `/setup`.

## Supported chains

**EVM** — Ethereum, Arbitrum, Polygon, Base, Optimism. Lido reads on Ethereum + Arbitrum, Lido writes Ethereum-only. EigenLayer + Morpho Blue + Rocket Pool Ethereum-only. Compound V3 + Aave V3 + Uniswap V3 + LiFi + Safe multisig span all five chains; per-protocol address coverage varies — readers short-circuit cleanly where a protocol isn't deployed.

**TRON** — TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD); Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze + voting-reward claims; SunSwap (same-chain TRX↔TRC-20 swaps); LiFi-routed TRON↔EVM bridging. No lending/LP (Aave/Compound/Morpho/Uniswap aren't deployed). Pair once per session via `pair_ledger_tron`.

**Solana** — SOL + SPL balances, MarginFi + Kamino lending, Marinade / Jito / native stake-account reads with SOL-equivalent valuation, Jupiter v6 quotes, Helius DAS NFT portfolio. Writes cover SOL/SPL transfers, MarginFi + Kamino supply/withdraw/borrow/repay, Jupiter swaps, Marinade stake + immediate-unstake, Jito stake-pool deposit, native SOL delegate/deactivate/withdraw, and LiFi-routed EVM↔Solana bridging. Per-wallet durable-nonce account (~0.00144 SOL rent, reclaimable) protects sends from blockhash expiry during Ledger review (`prepare_solana_nonce_init` / `_close`). SPL / MarginFi / Kamino / Jupiter / Jito blind-sign against a Message Hash — enable **Allow blind signing** in the Solana app's Settings; SOL native transfers clear-sign. Pair once per session via `pair_ledger_solana`.

**Bitcoin + Litecoin** — balance, UTXO, fee-estimate, and tx-history readers via Esplora (mempool.space / litecoinspace.org). Native segwit + taproot sends, BIP-125 RBF fee-bumps, multisig PSBT (combine / sign / finalize), BIP-137 message signing, LiFi-routed BTC→EVM/Solana swaps. Optional Bitcoin Core / Litecoin Core JSON-RPC unlocks forensic tools that Esplora cannot serve (chain tips, block stats, mempool summary) — see [INSTALL.md §9](./INSTALL.md#9-troubleshooting) for setup. Pair once via `pair_ledger_btc` / `pair_ledger_ltc`.

Ledger Live's WalletConnect bridge does not honor the `tron:` namespace (verified 2026-04-14) or expose Solana accounts (verified 2026-04-23) or expose BTC/LTC namespaces, which is why those paths use USB HID. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

[ROADMAP.md](./ROADMAP.md).

## Tools

~190 tools across read / pair-Ledger / prepare / sign+send / verify / diagnostic categories. Highlights below; each tool has a Zod input schema and verbose description — query the MCP server's `tools/list` for the canonical surface.

**Portfolio + positions (read-only):**

- `get_portfolio_summary`, `get_portfolio_diff`, `get_pnl_summary`, `get_daily_briefing` — cross-chain USD aggregation; optional `tronAddress` / `solanaAddress` fold those chains in
- `get_lending_positions` (Aave), `get_compound_positions`, `get_morpho_positions`, `get_marginfi_positions`, `get_kamino_positions`, `get_curve_positions`, `get_safe_positions` — per-protocol positions + health factors
- `get_lp_positions` — Uniswap V3 LP + IL estimate
- `get_staking_positions`, `get_staking_rewards`, `estimate_staking_yield` — Lido + EigenLayer + Rocket Pool
- `get_solana_staking_positions` — Marinade + Jito + native stake-account enumeration with activation status and SOL-equivalent valuation
- `get_tron_staking`, `list_tron_witnesses` — TRON Stake 2.0 state + SR list
- `get_nft_portfolio` (EVM + Solana DAS), `get_nft_collection`, `get_nft_history`, `get_nft_listings` (EVM)
- `get_btc_balance` / `_balances` / `_account_balance` / `_multisig_balance` / `_multisig_utxos` / `_tx_history` / `_fee_estimates`, `get_ltc_balance` — BTC + LTC reads via Esplora
- `get_compound_market_info` — wallet-less Comet snapshot
- `get_health_alerts`, `simulate_position_change` — multi-protocol liquidation-risk tooling
- `compare_yields` — rank lending APRs across Aave / Compound / Morpho / Marinade / Jito / Kamino-lend / MarginFi
- `get_marginfi_diagnostics` — banks the bundled SDK skipped, with root cause

**Tokens, prices, history:**

- `get_token_balance`, `get_token_price`, `get_token_metadata`, `get_token_allowances`, `get_coin_price` — balances + DefiLlama prices on EVM/TRON/Solana; `get_token_metadata` detects EIP-1967 proxies
- `get_transaction_history` — merged tx reader (external / ERC-20 / internal / Solana program_interaction) with 4byte-decoded methods + historical USD
- `get_transaction_status` — poll inclusion by hash
- `explain_tx` — post-hoc decode of a historical tx
- `resolve_token`, `resolve_ens_name`, `reverse_resolve_ens`

**Forensic chain reads (require Bitcoin/Litecoin Core RPC):**

- `get_btc_block_tip` / `_block_stats` / `_blocks_recent` / `_chain_tips` / `_mempool_summary`, `get_ltc_*` equivalents
- `build_incident_report`, `get_market_incident_status` — Compound/Aave pause + utilization scan and BTC/LTC chain-tip / mempool-anomaly bundle

**Quotes + security signals:**

- `get_swap_quote` (LiFi, EVM), `get_solana_swap_quote` (Jupiter v6)
- `check_contract_security`, `check_permission_risks`, `get_protocol_risk_score`, `get_contract_abi`, `read_contract`
- `simulate_transaction` — EVM `eth_call` preview (Solana equivalent runs inside `preview_solana_send`)
- `verify_tx_decode`, `get_verification_artifact`, `get_tx_verification` — second-LLM cross-verification + 15-min-TTL handle re-emit ([details](./SECURITY.md#second-agent-verification-optional-for-the-coordinated-agent-case))

**Diagnostics:**

- `get_solana_setup_status` — probe nonce + MarginFi account PDAs
- `get_vaultpilot_config_status` — local config diagnostic (RPC sources, key presence, paired-account counts, WC topic suffix, skill state). Booleans / counts only — no secret values.
- `get_ledger_device_info`, `get_ledger_status`, `verify_ledger_attestation` / `_firmware` / `_live_codesign` — device + session discovery, on-device attestation, firmware-version pin

**Contacts + read-only sharing:**

- `add_contact` / `remove_contact` / `list_contacts` / `verify_contacts` — local Ledger-signed address book at `~/.vaultpilot-mcp/contacts.json`
- `generate_readonly_link` / `import_readonly_token` / `list_readonly_invites` / `revoke_readonly_invite` — issue scoped read-only portfolio links
- `share_strategy` / `import_strategy` — anonymized portfolio snapshots

**Execution (Ledger-signed):**

- `pair_ledger_live` (EVM/WC), `pair_ledger_tron` / `_solana` / `_btc` / `_ltc` (USB HID)
- `prepare_aave_*`, `prepare_compound_*`, `prepare_morpho_*` — EVM lending (supply / borrow / withdraw / repay)
- `prepare_lido_stake` / `_unstake` / `_wrap` / `_unwrap` (stETH↔wstETH), `prepare_eigenlayer_deposit`, `prepare_rocketpool_stake` / `_unstake`
- `prepare_swap` (LiFi), `prepare_native_send`, `prepare_token_send`, `prepare_token_approve`, `prepare_revoke_approval`, `prepare_weth_unwrap`
- `prepare_uniswap_swap` — direct V3 swap, same-chain, auto-picks fee tier across 100/500/3000/10000 bps. Use only when the user names Uniswap; otherwise prefer LiFi
- `prepare_uniswap_v3_mint` / `_increase_liquidity` / `_decrease_liquidity` / `_collect` / `_burn` / `_rebalance` — full LP verb set
- `prepare_curve_swap`, `prepare_curve_add_liquidity`
- `prepare_safe_tx_propose` / `_approve` / `_execute`, `submit_safe_tx_signature` — Safe multisig proposal flow
- `prepare_custom_call` — escape hatch for arbitrary verified-contract calls (`acknowledgeNonProtocolTarget: true` gate; bypasses the canonical-dispatch allowlist by design)
- `prepare_tron_*` — native + TRC-20 transfers, WithdrawBalance, Stake 2.0, vote, claim rewards, TRC-20 approve, LiFi swap, SunSwap swap (`prepare_sunswap_swap`)
- `prepare_solana_nonce_init` / `_close` — one-time durable-nonce PDA setup/teardown
- `prepare_solana_native_send`, `_spl_send` (auto-includes ATA create), `prepare_solana_swap` (Jupiter), `prepare_solana_lifi_swap`
- `prepare_marginfi_init`, `_supply`, `_withdraw`, `_borrow`, `_repay`
- `prepare_kamino_init_user`, `_supply`, `_withdraw`, `_borrow`, `_repay`
- `prepare_marinade_stake` / `_unstake_immediate` (fee applies; unstake-ticket delayed path deferred), `prepare_jito_stake` (stake only — unstake deferred), `list_solana_validators`
- `prepare_native_stake_delegate` / `_deactivate` / `_withdraw` — native SOL staking
- `prepare_btc_send`, `prepare_btc_rbf_bump`, `prepare_btc_multisig_send`, `register_btc_multisig_wallet` / `unregister_btc_multisig_wallet`, `combine_btc_psbts`, `sign_btc_multisig_psbt`, `finalize_btc_psbt`, `sign_message_btc`, `prepare_btc_lifi_swap`, `rescan_btc_account`
- `prepare_litecoin_native_send`, `sign_message_ltc`, `rescan_ltc_account`
- `preview_send` (EVM) — pins gas, emits `LEDGER BLIND-SIGN HASH` for pre-match, mints `previewToken`; required between every EVM `prepare_*` and `send_transaction`
- `preview_solana_send` — pins nonce/blockhash, computes Message Hash for on-device match, runs simulation, emits `CHECKS PERFORMED`; required between every `prepare_solana_*` and `send_transaction`
- `send_transaction` — forwards to Ledger (EVM via WC, TRON/Solana/BTC/LTC via USB HID)

**Meta:**

- `request_capability` — file a missing-feature GitHub issue. Default returns a pre-filled URL (no auto-submit); rate-limited 3/hour
- `set_etherscan_api_key`, `set_helius_api_key`, `set_demo_wallet`, `exit_demo_mode`, `get_demo_wallet`, `get_update_command` — runtime knobs

## Requirements

- Node.js ≥ 18.17
- **Zero-config reads:** PublicNode (EVM) + Solana public mainnet — rate-limited but enough for first contact and light use.
- **Real use:** custom RPC (Infura / Alchemy / Helius / QuickNode / Triton) via env vars or `vaultpilot-mcp setup`.
- **Optional keys** (prompted on demand): Etherscan, 1inch (enables swap-quote comparison), WalletConnect project ID (required for EVM Ledger signing), TronGrid (raises the ~15 req/min anonymous cap).
- **TRON / Solana signing:** USB HID access to a Ledger with the **Tron** / **Solana** app installed. Linux: install Ledger's [udev rules](https://github.com/LedgerHQ/udev-rules) (`vaultpilot-mcp setup` prints the exact one-liner). Debian/Ubuntu also need `sudo apt install libudev-dev build-essential` for `node-hid` to compile.

## Install

Three paths — full instructions, MCP-client wiring, Gatekeeper / SmartScreen handling, update / uninstall in **[INSTALL.md](./INSTALL.md)**.

| Path | TL;DR |
|---|---|
| **Bundled binary** (no Node) | Download from the [latest release](https://github.com/szhygulin/vaultpilot-mcp/releases/latest), `chmod +x`, `<binary> setup`. |
| **From npm** | `npm install -g vaultpilot-mcp && vaultpilot-mcp setup` |
| **From source** | `git clone https://github.com/szhygulin/vaultpilot-mcp.git && cd vaultpilot-mcp && npm install --legacy-peer-deps && npm run build && npm run setup` |

## Setup

```bash
npm run setup
```

Picks RPC providers, validates keys, optionally pairs Ledger Live, writes `~/.vaultpilot-mcp/config.json`. Env vars override the config.

## Demo mode

Try without RPC keys, Ledger pairing, or the wizard:

```bash
claude mcp add vaultpilot-mcp --env VAULTPILOT_DEMO=true -- npx -y vaultpilot-mcp
```

`--demo` is the equivalent CLI flag; explicit env wins, so `VAULTPILOT_DEMO=false` is a deterministic opt-out for scripted invocations.

- Reads run against real RPC; every wallet is a curated public persona (`whale`, `defi-degen`, `stable-saver`, `staking-maxi`).
- `send_transaction` returns a [simulation envelope](src/demo/index.ts): unsigned tx is `simulate_transaction`'d for revert detection, nothing signed, nothing broadcast.
- `pair_ledger_*`, `request_capability`, `sign_message_*` are refused outright. With no persona selected, signing-class tools refuse with a structured error pointing at `set_demo_wallet`.
- Multi-step flows whose preconditions are state changes (e.g. `prepare_solana_nonce_init` → `marinade_stake`) can't be rehearsed end-to-end — simulated sends don't mutate chain state. The MCP surfaces a one-shot hint when it detects the agent-loop trap.

`get_demo_wallet` lists personas + addresses + `rehearsableFlows`. `set_demo_wallet({ persona })` activates one. State is process-local. `exit_demo_mode` returns a handoff guide for permanent setup. Demo is a scaffold for first contact, not a sandbox — no virtual chain overlay.

For Solana RPC throttling under multi-tool fan-out, inject a [Helius](https://helius.dev) key at runtime: `set_helius_api_key({ key })`. Demo mode nudges proactively after 10 public-RPC throttle errors.

## Use with Claude Code (CLI) / Cursor / Claude Desktop

`vaultpilot-mcp setup` detects installed clients and registers vaultpilot-mcp with each (existing configs backed up to `<file>.vaultpilot.bak`). Per-project / per-workspace configs are skipped — the wizard runs from arbitrary CWD. For manual wiring or the per-client config paths, see [INSTALL.md §5](./INSTALL.md#5-manual-mcp-client-wiring-if-auto-register-didnt-run).

> **Claude.ai chat — limitation.** Local stdio MCP installed via the wizard registers cleanly with the Claude.ai native desktop app, but the host environment's outbound-HTTP allowlist blocks chain RPC providers (PublicNode, public Solana mainnet, Alchemy, Helius, etc.). The MCP initializes and processes tool calls, but every read that hits an external RPC fails with 403 / "Host not in allowlist". The same applies to Claude Code running inside Claude.ai's cloud sandbox. **Working today**: Claude Code CLI in your terminal, Cursor, Claude Desktop on a host with unrestricted outbound HTTP. **Future**: a hosted MCP endpoint ([roadmap](./ROADMAP.md#deployment-modes), not yet shipped) will give Claude.ai chat a network-unrestricted backend; TRON / Solana / Bitcoin / Litecoin USB-HID signing requires a local Ledger and stays on the terminal CLI / Cursor path regardless.

## Environment variables

All optional if the matching field is in `~/.vaultpilot-mcp/config.json`; env wins.

- `ETHEREUM_RPC_URL`, `ARBITRUM_RPC_URL`, `POLYGON_RPC_URL`, `BASE_RPC_URL`, `SOLANA_RPC_URL` — custom RPC endpoints
- `RPC_PROVIDER` (`infura` | `alchemy`) + `RPC_API_KEY` — alternative to custom URLs
- `ETHERSCAN_API_KEY`, `ONEINCH_API_KEY`, `TRON_API_KEY`, `WALLETCONNECT_PROJECT_ID`
- `RPC_BATCH=1` — opt into JSON-RPC batching (off by default; many public endpoints mishandle batched POSTs)
- `VAULTPILOT_ALLOW_INSECURE_RPC=1` — opt out of https/private-IP RPC checks (local anvil/hardhat only)
- `VAULTPILOT_FEEDBACK_ENDPOINT` — optional https proxy for `request_capability` direct POSTs. **The client does not authenticate; the proxy MUST.**
- `VAULTPILOT_SKILL_MARKER_PATH` — suppress the preflight-skill notice (read-only users opting in)
- `VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1` — skip the lazy first-run `git clone` of companion skills (air-gapped / no-egress)
- `VAULTPILOT_DEMO=true` — enable [demo mode](#demo-mode); literal `"true"` only, other values rejected
- `VAULTPILOT_DISABLE_UPDATE_CHECK=1` — skip the once-per-session `registry.npmjs.org` update check (air-gapped)

## Development

```bash
npm run dev      # tsc --watch
npm test         # vitest run
npm run test:watch
```

## Contributing

PRs welcome. The CLA Assistant bot will ask you to sign the [Contributor License Agreement](./CLA.md) on your first PR — one signature covers all future PRs. The CLA grants the project the right to relicense your contribution; without it, the BUSL-1.1 → Apache 2.0 auto-conversion in 2030 would get stuck. Repo owner and Dependabot are exempt.

## License

**Business Source License 1.1** — see [LICENSE](./LICENSE).

- **Personal self-custodial use is free**, including yield / swap / lend / stake on your own behalf.
- **Internal organizational use is free.**
- **Hosted services and embedded redistribution require a commercial license** — open an issue or contact the maintainer.
- **Auto-converts to Apache 2.0 on 2030-04-26.** Each version's restrictions expire four years after release.
- **Versions ≤ 0.8.2 remain MIT.** The license change applies to v0.9.0 onward.
