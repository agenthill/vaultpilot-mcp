# Installing VaultPilot

> **Agents installing on the user's behalf**: use the [one-line install](#one-line-install-for-agents-and-power-users) below. See [AGENTS.md](./AGENTS.md) for consent + post-install relay conventions.

Four paths. All converge on the same end state: a `vaultpilot-mcp` server binary your MCP client runs, plus a one-time setup wizard that writes `~/.vaultpilot-mcp/config.json`.

| Path | Best for | Prerequisites |
|---|---|---|
| **0. One-line install** | Anyone who'd rather not click through the release page; agent-driven installs | None — script handles everything |
| **A. Bundled binary** | Manual download path; users who want to inspect each step | None — runtime is bundled |
| **B. From npm** | Developers with Node already installed | Node ≥ 18.17, npm |
| **C. From source** | Contributors | Node ≥ 18.17, npm, git, OS build toolchain |

Sections **3–9** apply to all paths.

## One-line install (for agents and power users)

This is Path A scripted: detect OS+arch, download the unified `vaultpilot-mcp` binary from the latest GitHub release, place it in `~/.local/bin` (or `%LOCALAPPDATA%\Programs\vaultpilot-mcp\` on Windows), then run `vaultpilot-mcp setup --non-interactive --json`.

**Linux / macOS:**

```bash
curl -fsSL https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.sh | bash
```

**Windows (PowerShell):**

```powershell
iwr https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.ps1 -UseBasicParsing | iex
```

What happens: detect OS+arch (Linux x64, macOS x64/arm64, Windows x64; Linux arm64 falls back to "use Path B"); atomic download; macOS Gatekeeper xattr stripped; PATH checked (script prints the `export PATH="…"` line if missing — never edits your rc); wizard runs, registers with detected MCP clients (Claude Desktop, Claude Code, Cursor) and clones companion preflight + setup skills into `~/.claude/skills/`; emits `InstallEnvelope` JSON on stdout (shape in [`src/setup/output-json.ts`](./src/setup/output-json.ts)).

**Idempotent.** Re-runs re-download (this is the update path) and the wizard recognizes already-present components, emitting `status: "already_installed"`.

**Zero-config.** No keys collected. Public RPC fallbacks (PublicNode for EVM, public Solana mainnet) work out of the box. Add provider keys later via interactive `vaultpilot-mcp setup`.

**Customization** via env vars (rarely needed):

| Env var | Default | Purpose |
|---|---|---|
| `VAULTPILOT_INSTALL_DIR` | `~/.local/bin` (Unix) / `%LOCALAPPDATA%\Programs\vaultpilot-mcp\` (Windows) | Where binaries go |
| `VAULTPILOT_RELEASE_URL` | `https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download` | Source of binaries (mirrors / smoke tests) |
| `VAULTPILOT_REPO` | `szhygulin/vaultpilot-mcp` | Underlying repo (only when `VAULTPILOT_RELEASE_URL` is unset) |

**Security.** Read [`scripts/install.sh`](./scripts/install.sh) / [`scripts/install.ps1`](./scripts/install.ps1) before running. They never `sudo`, never edit your shell rc, never collect keys, never pair your Ledger.

## Path A — Bundled binary

### A1. Download

From the [latest release page](https://github.com/szhygulin/vaultpilot-mcp/releases/latest):

| Platform | Binary |
|---|---|
| Linux x64 | `vaultpilot-mcp-linux-x64-server` |
| macOS Apple silicon | `vaultpilot-mcp-macos-arm64-server` |
| macOS Intel | `vaultpilot-mcp-macos-x64-server` |
| Windows x64 | `vaultpilot-mcp-windows-x64-server.exe` |

v0.13.0+ ships one unified binary per platform; the wizard is invoked as `vaultpilot-mcp setup`.

Move to a stable location: `~/.local/bin/` (Unix) or `%LOCALAPPDATA%\Programs\vaultpilot-mcp\` (Windows). Create the dir if needed.

### A2. Make it runnable

**macOS** — Gatekeeper blocks unsigned binaries. Either strip the quarantine xattr:

```bash
chmod +x ~/.local/bin/vaultpilot-mcp-macos-*
xattr -d com.apple.quarantine ~/.local/bin/vaultpilot-mcp-macos-* 2>/dev/null
```

…or right-click in Finder → **Open** → **Open** in the dialog (one-time per file). The "could not verify" warning is Gatekeeper; binaries are built in public CI ([`.github/workflows/release-binaries.yml`](./.github/workflows/release-binaries.yml)), code-signing is on the roadmap.

**Linux:**

```bash
chmod +x ~/.local/bin/vaultpilot-mcp-linux-x64-*
```

For TRON / Solana hardware-signing, install [Ledger udev rules](https://github.com/LedgerHQ/udev-rules) (the wizard prints the one-liner if missing).

**Windows** — SmartScreen will warn on first launch. Click **More info** → **Run anyway**.

→ Skip to **section 3**.

## Path B — From npm

Prerequisites: Node ≥ 18.17 + npm (`node -v`, `npm -v`). Prefer [nvm](https://github.com/nvm-sh/nvm) on Unix to avoid `EACCES` on `/usr/local/`.

```bash
npm install -g vaultpilot-mcp
```

Linux + TRON/Solana signing: install the toolchain so `node-hid` compiles:

```bash
sudo apt install libudev-dev build-essential   # Debian / Ubuntu
sudo dnf install systemd-devel gcc-c++ make    # Fedora
```

Verify: `which vaultpilot-mcp` (Unix) or `where.exe vaultpilot-mcp` (Windows). If unresolved, check `npm bin -g` is on PATH.

→ Section 3.

## Path C — From source

Prerequisites: Node ≥ 18.17, npm, git, plus the toolchain from Path B (Linux only — macOS/Windows include theirs).

```bash
git clone https://github.com/szhygulin/vaultpilot-mcp.git
cd vaultpilot-mcp
npm install --legacy-peer-deps
npm run build
```

`--legacy-peer-deps` is required (Kamino SDK transitive peer-dep nest).

Run via `npm start` (server) / `npm run setup` (wizard) from the repo, or `npm link` to expose `vaultpilot-mcp` globally (reversible with `npm unlink -g vaultpilot-mcp`). Optional: `npm test` (~1,000 cases, ~15s).

→ Section 3.

## 3. Run the setup wizard

Mandatory configuration step. Writes `~/.vaultpilot-mcp/config.json` (or `%USERPROFILE%\.vaultpilot-mcp\config.json` on Windows).

| Path | Invocation |
|---|---|
| A — bundled binary | `~/.local/bin/vaultpilot-mcp-<platform>-<arch>-server setup` |
| A — Windows | `& "$env:LOCALAPPDATA\Programs\vaultpilot-mcp\vaultpilot-mcp-windows-x64-server.exe" setup` |
| B — npm | `vaultpilot-mcp setup` |
| C — source | `npm run setup` |

The wizard:

- Asks the use case (read balances / sign EVM / sign Solana / sign TRON) and only prompts for the keys that case needs. Read-only works with **zero** keys.
- Detects Claude Desktop / Claude Code / Cursor and offers to register vaultpilot-mcp with each.
- Offers to clone [`vaultpilot-security-skill`](https://github.com/szhygulin/vaultpilot-security-skill) (signing-time integrity invariants) and [`vaultpilot-setup-skill`](https://github.com/szhygulin/vaultpilot-setup-skill) (`/setup` flow) into `~/.claude/skills/`.

Re-run any time to add or change a key.

## 4. Verify

Restart the MCP client and try:

> "Show me my crypto portfolio."

Calls `get_portfolio_summary`. If the client doesn't know about VaultPilot, see section 5.

Sanity-check the server itself by piping a tools/list request to stdin:

```bash
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | vaultpilot-mcp | head -c 200
```

(Path A: replace `vaultpilot-mcp` with the binary path. Path C: `node dist/index.js`.)

## 5. Manual MCP client wiring (if auto-register didn't run)

Add to the client config:

```jsonc
// Path B (npm) — macOS / Linux
{ "mcpServers": { "vaultpilot-mcp": { "command": "vaultpilot-mcp" } } }

// Path B (npm) — Windows + Claude Desktop (no-shell spawn; .cmd needs cmd /c)
{ "mcpServers": { "vaultpilot-mcp": {
    "command": "cmd", "args": ["/c", "vaultpilot-mcp"] } } }

// Path A (bundled binary) — absolute path required
{ "mcpServers": { "vaultpilot-mcp": { "command": "/abs/path/to/vaultpilot-mcp-<platform>-<arch>-server" } } }

// Path C (source)
{ "mcpServers": { "vaultpilot-mcp": { "command": "node", "args": ["/abs/path/to/vaultpilot-mcp/dist/index.js"] } } }
```

Per-client config locations:

| Client | Path |
|---|---|
| Claude Desktop (macOS) | `~/Library/Application Support/Claude/claude_desktop_config.json` |
| Claude Desktop (Windows) | `%APPDATA%\Claude\claude_desktop_config.json` |
| Claude Desktop (Linux) | `~/.config/Claude/claude_desktop_config.json` |
| Claude Code | `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` |

If `mcpServers` already exists, **merge** — don't overwrite. Back up before editing.

### Claude.ai chat — won't reach external RPCs today

The wizard registers vaultpilot-mcp with the Claude.ai native desktop app, but the host environment's outbound-HTTP allowlist blocks chain RPC providers (`publicnode.com`, `mainnet-beta.solana.com`, Alchemy, Helius, Etherscan, etc.). The stdio handshake succeeds — the MCP initializes, lists tools, accepts calls — and every read that hits an external RPC then returns `403 Host not in allowlist`. The same applies to Claude Code running inside Claude.ai's cloud sandbox.

Working surfaces today:

- **Claude Code CLI in your terminal** (`claude` from a shell) — no sandbox.
- **Cursor** — runs MCP as a child process on your machine.
- **Any MCP client** on a host with unrestricted outbound HTTP.

A [hosted MCP endpoint](./ROADMAP.md#deployment-modes) is on the roadmap and will give Claude.ai chat a network-unrestricted backend (EVM-only for v1, OAuth 2.1). Not yet shipped. TRON / Solana / Bitcoin / Litecoin signing needs a local USB-HID connection to your Ledger and will continue to require terminal CLI or Cursor regardless of what the hosted backend covers.

## 6. Pair Ledger (only if signing)

VaultPilot is self-custodial; signing pairs once per chain.

- **EVM** (Ethereum / Arbitrum / Polygon / Base / Optimism, via WalletConnect): `pair_ledger_live`. Open Ledger Live mobile, complete the WC handshake.
- **Solana**: plug in, open the Solana app (enable **Allow blind signing** for SPL/MarginFi/Jupiter; SOL native sends clear-sign without it), `pair_ledger_solana`.
- **TRON**: plug in, open the Tron app, `pair_ledger_tron`.

Read-only portfolio reads need none of this.

### Optional — second-LLM cross-check pinning

`get_verification_artifact` returns a `pasteableBlock` for second-LLM verification. Each block opens with:

```
════════════════════════════════════════
VAULTPILOT CROSS-CHECK v1 — pin SHA once, verify on every call
SHA-256: <64-hex-digest>
Spec:    https://github.com/szhygulin/vaultpilot-mcp/blob/v<version>/docs/cross-check-v1.md
════════════════════════════════════════
```

Pin the SHA once: open the URL, run `sha256sum docs/cross-check-v1.md` against your local checkout (or a trusted third-party copy of the same release tag), confirm digests agree. A future mismatch means the spec doc shipped in your install no longer matches what you trusted — treat as a compromise signal and reinstall from a known-clean source.

## 7. Update

| Path | Update command |
|---|---|
| A | Re-download from the [latest release](https://github.com/szhygulin/vaultpilot-mcp/releases/latest); replace files; re-run xattr/SmartScreen on first launch |
| B | `npm update -g vaultpilot-mcp` (or `npm install -g vaultpilot-mcp@<version>`) |
| C | `git pull --ff-only && npm install --legacy-peer-deps && npm run build` |

Restart the MCP client after. `~/.vaultpilot-mcp/config.json` is preserved across all paths.

## 8. Uninstall

| Path | Remove command |
|---|---|
| A | `rm ~/.local/bin/vaultpilot-mcp-*-server` (Unix) / delete files in `%LOCALAPPDATA%\Programs\vaultpilot-mcp\` (Windows) |
| B | `npm uninstall -g vaultpilot-mcp` |
| C | `npm unlink -g vaultpilot-mcp` (if linked), then delete the source checkout |

All paths — clean up shared state:

1. `rm -rf ~/.vaultpilot-mcp/` (or `%USERPROFILE%\.vaultpilot-mcp\` on Windows).
2. Remove the `vaultpilot-mcp` entry from your MCP client's config (paths in section 5).
3. Optional: `rm -rf ~/.claude/skills/vaultpilot-{preflight,setup}/`.

## 9. Troubleshooting

- **"Permission denied" (Linux/macOS)** — missing `chmod +x`. Re-run section A2.
- **"Apple could not verify…"** — Gatekeeper. Right-click → Open, or `xattr -d com.apple.quarantine`.
- **"Windows protected your PC"** — SmartScreen. Click **More info** → **Run anyway**.
- **Wizard hangs at "Pairing Ledger Live…"** — WC relay timed out. Ensure Ledger Live mobile is open, has internet, recent build. Ctrl-C and re-run with `--skip-pairing`; pair later via `pair_ledger_live`.
- **MCP client doesn't see vaultpilot-mcp** — auto-register didn't catch your client. Add the JSON entry from section 5; restart.
- **Windows + Claude Desktop, manual entry, "Failed to start MCP server" / `ENOENT`** — `command: "npx"` (or `command: "vaultpilot-mcp"`) doesn't resolve `npx.cmd` / `.cmd` shims without a shell on Windows. Wrap with `cmd /c` (section 5) or re-run the PowerShell installer to let the wizard write the `node` + absolute-path entry.
- **Solana sends fail with "blockhash expired"** — should not happen on v0.6.1+ (durable-nonce-protected). File an issue with the preview output if it does.
- **Linux: TRON / Solana signing returns "permission denied" on USB** — missing Ledger udev rules. Re-run the wizard, or install from [Ledger's repo](https://github.com/LedgerHQ/udev-rules).
- **WalletConnect "peer not currently reachable" on `send_transaction`** — closing the WC sub-app inside Ledger Live or sleeping the host machine breaks reachability without ending the session. The MCP retains the persisted session; recovery is reopen WC in Ledger Live (Discover → WalletConnect, or Settings → Connected Apps → WalletConnect) and re-call `send_transaction` on the **same handle** within its 15-min TTL — no re-pair. If reopening doesn't restore reachability after a few seconds, the session is genuinely ended; run `pair_ledger_live` for a fresh one. Mobile drops faster than desktop because OS app suspension can outlast the relay's topic TTL.
- **Anything else** — file an issue at the [tracker](https://github.com/szhygulin/vaultpilot-mcp/issues) with OS, version (`vaultpilot-mcp --version`), failing tool name, and verbatim agent output (redact addresses/hashes you don't want public).

### Optional — bitcoind / litecoind RPC for forensic chain reads

Six BTC/LTC tools (`get_*_chain_tips`, `get_*_block_stats`, `get_*_mempool_summary`) and three incident signals (`deep_reorg`, `indexer_divergence`, `mempool_anomaly`) require a Bitcoin Core / Litecoin Core JSON-RPC endpoint — Esplora indexers (mempool.space / litecoinspace.org) cannot expose forks, mempool census, or fee percentiles. Opt-in; portfolio/wallet tools never need it.

Three backends, increasing setup cost:

1. **Hosted RPC provider** (Quicknode, Getblock, NOWNodes — LTC support thinner; Getblock + NOWNodes have it):
   ```
   BITCOIN_RPC_URL=https://btc.getblock.io/<token>/mainnet/
   BITCOIN_RPC_AUTH_HEADER_NAME=X-API-KEY
   BITCOIN_RPC_AUTH_HEADER_VALUE=<token>
   ```
2. **Self-hosted pruned bitcoind** — `bitcoind -prune=10000` ≈ 10 GB / ~2 days IBD on residential. Cookie auth:
   ```
   BITCOIN_RPC_URL=http://127.0.0.1:8332
   BITCOIN_RPC_COOKIE=/home/<user>/.bitcoin/.cookie
   ```
   Or basic auth via `BITCOIN_RPC_USER` / `BITCOIN_RPC_PASSWORD` if you set `rpcuser` / `rpcpassword` in `bitcoin.conf`.
3. **Self-hosted pruned litecoind** — `litecoind -prune=5000` ≈ 5 GB / ~6 hours IBD. An order of magnitude cheaper than bitcoind in time + disk. Same auth shape with `LITECOIN_RPC_*` prefix.

When unset, RPC-gated tools return `available: false` with a setup hint — they never silently fail. Wallet-tier tools (balances, fee estimates, tx history) keep using Esplora.

## What's bundled inside the binary

Each binary contains the Node 22 runtime, compiled `dist/` JS, every npm dep, and platform-specific native `.node` artifacts for `node-hid`, `usb`, `bufferutil`, `utf-8-validate`. Built per-OS via [`@yao-pkg/pkg`](https://github.com/yao-pkg/pkg) — see [`.github/workflows/release-binaries.yml`](./.github/workflows/release-binaries.yml). At first launch, the runtime extracts native files to a platform-specific cache (override via `PKG_NATIVE_CACHE_PATH`).
