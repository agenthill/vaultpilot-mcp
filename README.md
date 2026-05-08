# VaultPilot MCP

[![npm version](https://img.shields.io/npm/v/vaultpilot-mcp.svg)](https://www.npmjs.com/package/vaultpilot-mcp)
[![license](https://img.shields.io/npm/l/vaultpilot-mcp.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/vaultpilot-mcp.svg)](package.json)

Self-custodial DeFi for AI agents. The agent proposes, you approve on your Ledger — designed for the threat model where the agent, MCP, and host can all be compromised. Only the device is trusted; private keys never leave it.

![VaultPilot MCP demo](./demo.gif)

Read on-chain positions and prepare transactions across **Ethereum, Arbitrum, Polygon, Base, Optimism, TRON, Solana, Bitcoin, and Litecoin**. Supported protocols: **Aave V3, Compound V3, Morpho Blue, Uniswap V3 LP, Lido, EigenLayer** on EVM, **MarginFi** on Solana, plus **LiFi** (EVM swap/bridge) and **Jupiter v6** (Solana swap), with **1inch** as an optional EVM quote cross-check. EVM signs over WalletConnect → Ledger Live; TRON and Solana sign over USB HID directly to the device (Ledger Live's WalletConnect bridge does not support either namespace today). Works with **Claude Code** (CLI/terminal), **Cursor**, and any MCP-compatible client over stdio. **Claude.ai chat (web + native desktop app) needs a hosted MCP endpoint** — [on the roadmap](./ROADMAP.md#deployment-modes), not yet shipped.

> Agents: read **[AGENTS.md](./AGENTS.md)**. One-line prompt to paste into Claude Code / Cursor / any MCP-capable agent:
> ```
> Install VaultPilot MCP from https://github.com/szhygulin/vaultpilot-mcp following AGENTS.md.
> ```

## Features

- **Portfolio** — cross-chain balances, DeFi position aggregation, USD totals
- **Positions** — Aave, Compound, Morpho, Uniswap V3 LP, MarginFi; health-factor alerts
- **Staking** — Lido + EigenLayer (EVM); TRON Stake 2.0; Solana (Marinade / Jito / native)
- **Swaps** — LiFi (EVM + EVM↔Solana, optional 1inch cross-check), Jupiter v6 (Solana)
- **Execution** — prepare/sign for every supported protocol + native/token sends. Solana sends use a per-wallet durable-nonce account so Ledger review doesn't race the ~60s blockhash window; every Solana prepare runs a `simulateTransaction` gate so program-level reverts fail at prepare time, not on broadcast.
- **Security** — contract verification, upgradeability checks, privileged-role enumeration, DefiLlama-backed risk score
- **Utilities** — ENS resolution, token balances, transaction status

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

**EVM** — Ethereum, Arbitrum, Polygon, Base. Lido reads on Ethereum + Arbitrum, Lido writes Ethereum-only. EigenLayer + Morpho Blue Ethereum-only.

**TRON** — TRX + canonical TRC-20 stablecoins (USDT, USDC, USDD, TUSD); Stake 2.0 freeze/unfreeze/withdraw-expire-unfreeze + voting-reward claims. No lending/LP (Aave/Compound/Morpho/Uniswap aren't deployed). Pair once per session via `pair_ledger_tron`.

**Solana** — SOL + SPL balances, MarginFi lending, Marinade / Jito / native stake-account reads with SOL-equivalent valuation, Jupiter v6 quotes. Writes cover SOL/SPL transfers, MarginFi supply/withdraw/borrow/repay, Jupiter swaps, Marinade stake + immediate-unstake, native SOL delegate/deactivate/withdraw, and LiFi-routed EVM↔Solana bridging. Per-wallet durable-nonce account (~0.00144 SOL rent, reclaimable) protects sends from blockhash expiry during Ledger review (`prepare_solana_nonce_init` / `_close`). SPL / MarginFi / Jupiter blind-sign against a Message Hash — enable **Allow blind signing** in the Solana app's Settings; SOL native transfers clear-sign. Pair once per session via `pair_ledger_solana`.

Ledger Live's WalletConnect bridge does not honor the `tron:` namespace (verified 2026-04-14) or expose Solana accounts (verified 2026-04-23), which is why both paths use USB HID. Readers short-circuit cleanly on chains where a protocol isn't deployed.

## Roadmap

[ROADMAP.md](./ROADMAP.md).

## Tools

**Read-only:**

- `get_portfolio_summary` — cross-chain USD totals; optional `tronAddress` / `solanaAddress` fold those chains in
- `get_lending_positions`, `get_compound_positions`, `get_morpho_positions`, `get_marginfi_positions` — per-protocol positions + health factors
- `get_compound_market_info` — wallet-less Comet snapshot: base-token metadata, supply/borrow/utilization/APR, pause flags, collateral list with caps + LTV factors
- `get_market_incident_status` — paused / frozen / utilization ≥ 95% scan across Compound or Aave on a chain; surfaces a top-level `incident` bit
- `get_marginfi_diagnostics` — banks the bundled SDK had to skip, with root cause
- `get_lp_positions` — Uniswap V3 LP + IL estimate
- `get_staking_positions`, `get_staking_rewards`, `estimate_staking_yield` — Lido + EigenLayer
- `get_solana_staking_positions` — Marinade + Jito + native stake-account enumeration with activation status and SOL-equivalent valuation
- `get_health_alerts`, `simulate_position_change` — liquidation-risk tooling
- `simulate_transaction` — EVM `eth_call` preview (Solana equivalent runs inside `preview_solana_send`)
- `get_token_balance`, `get_token_price`, `get_token_metadata` — balances + DefiLlama prices on EVM/TRON/Solana; `get_token_metadata` detects EIP-1967 proxies
- `get_transaction_history` — merged tx reader (external / ERC-20 / internal / Solana program_interaction) with 4byte-decoded methods + historical USD
- `get_tron_staking`, `list_tron_witnesses` — TRON staking state + SR list
- `get_solana_setup_status` — probe nonce + MarginFi account PDAs
- `get_vaultpilot_config_status` — local config diagnostic (RPC sources, key presence, paired-account counts, WC topic suffix, skill state). Booleans / counts only — no secret values.
- `get_ledger_device_info` — probe the connected Ledger and report which app is open + actionable hint. Call before `pair_ledger_*` for state-aware guidance.
- `resolve_ens_name`, `reverse_resolve_ens` — ENS forward/reverse
- `get_swap_quote` (LiFi, EVM), `get_solana_swap_quote` (Jupiter v6)
- `check_contract_security`, `check_permission_risks`, `get_protocol_risk_score`
- `get_transaction_status` — poll inclusion by hash
- `get_tx_verification` — re-emit VERIFY-BEFORE-SIGNING + tx JSON for a handle when the original prepare_* output dropped out of context (15-min TTL)
- `get_verification_artifact` — sparse JSON for second-LLM cross-verification ([details](./SECURITY.md#second-agent-verification-optional-for-the-coordinated-agent-case))

**Execution (Ledger-signed):**

- `pair_ledger_live` (EVM/WC), `pair_ledger_tron` / `_solana` (USB HID), `get_ledger_status` — session + account discovery
- `prepare_aave_*`, `prepare_compound_*`, `prepare_morpho_*` — EVM lending
- `prepare_lido_stake` / `_unstake`, `prepare_eigenlayer_deposit` — EVM staking
- `prepare_swap` (LiFi), `prepare_native_send`, `prepare_token_send` — EVM
- `prepare_uniswap_swap` — direct V3 swap, same-chain only, auto-picks fee tier across 100/500/3000/10000 bps. Use only when the user names Uniswap; otherwise prefer LiFi.
- `prepare_tron_*` — native + TRC-20 transfers, WithdrawBalance, Stake 2.0, vote
- `prepare_solana_nonce_init` / `_close` — one-time durable-nonce PDA setup/teardown
- `prepare_solana_native_send`, `_spl_send` (auto-includes ATA create), `prepare_solana_swap` (Jupiter)
- `prepare_marginfi_init`, `_supply`, `_withdraw`, `_borrow`, `_repay`
- `prepare_marinade_stake` / `_unstake_immediate` (fee applies; unstake-ticket delayed path deferred)
- `prepare_native_stake_delegate` / `_deactivate` / `_withdraw` — native SOL staking
- `preview_solana_send` — pins nonce/blockhash, computes Message Hash for on-device match, runs simulation, emits `CHECKS PERFORMED`. Required between every `prepare_solana_*` and `send_transaction`.
- `send_transaction` — forwards to Ledger (EVM via WC, TRON/Solana via USB HID)

**Meta:**

- `request_capability` — file a missing-feature GitHub issue. Default returns a pre-filled URL (no auto-submit); rate-limited 3/hour.

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
