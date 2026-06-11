#!/usr/bin/env node
/**
 * Interactive setup for VaultPilot MCP.
 *
 *   - Picks an RPC provider (Infura / Alchemy / custom) and validates the API key
 *     against a live eth_chainId call.
 *   - Optionally captures an Etherscan API key (improves contract-verification tools).
 *   - Optionally captures a WalletConnect Cloud project ID.
 *   - Optionally pairs Ledger Live over WalletConnect right now.
 *   - Persists everything to ~/.vaultpilot-mcp/config.json (0600) and prints a
 *     Claude Desktop config snippet the user can copy.
 *
 * Env vars always override the config file at runtime — the setup flow is for
 * users who'd rather not manage env vars.
 */
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, http } from "viem";
import { mainnet } from "viem/chains";
import qrcodeTerminal from "qrcode-terminal";
import {
  patchUserConfig,
  readUserConfig,
  getConfigPath,
} from "./config/user-config.js";
import { reportLedgerUdevStatus } from "./setup/linux-udev.js";
import {
  getSkillTargets,
  installAllSkills,
  summarizeSkillInstalls,
} from "./setup/install-skills.js";
import {
  detectClient,
  getClientConfigPaths,
  registerVaultPilotWithClients,
  summarizePatchResults,
} from "./setup/register-clients.js";
import { buildInstallEnvelope } from "./setup/output-json.js";
import type { RpcProvider, SupportedChain, UserConfig } from "./types/index.js";

/**
 * Parsed CLI flags — see plan
 * `claude-work/HIGH-plan-agent-driven-install.md` for the rationale.
 *
 * - `--non-interactive` skips every prompt; we register clients and
 *   install skills with zero-config defaults (PublicNode RPC, no API
 *   keys, no Ledger pairing). This is the agent-driven install path.
 * - `--json` switches stdout from prose to a single structured
 *   `InstallEnvelope`. Implies `--non-interactive` (the prompt loop
 *   would corrupt the JSON output).
 * - `--idempotent` is the non-interactive default; surfaced as a flag
 *   so a script can pass it explicitly. When set, a re-run that did
 *   no new work exits with `status: "already_installed"` instead of
 *   re-attempting work that's already done.
 */
export interface SetupFlags {
  nonInteractive: boolean;
  json: boolean;
  idempotent: boolean;
}

export function parseSetupFlags(argv: readonly string[]): SetupFlags {
  let nonInteractive = false;
  let json = false;
  let idempotent = false;
  for (const a of argv) {
    if (a === "--non-interactive") nonInteractive = true;
    else if (a === "--json") json = true;
    else if (a === "--idempotent") idempotent = true;
  }
  // --json without --non-interactive would block on `readline` and
  // emit broken JSON; promote silently so the flag is forgiving.
  if (json) nonInteractive = true;
  // Non-interactive mode is implicitly idempotent (a script that
  // re-runs the installer should be safe). Surface as a flag for
  // callers that want to be explicit, but default it on.
  if (nonInteractive) idempotent = true;
  return { nonInteractive, json, idempotent };
}

/** Thin readline wrapper so each prompt is a single awaited call. */
class Prompt {
  private rl: ReadlineInterface;
  constructor() {
    this.rl = createInterface({ input: process.stdin, output: process.stdout });
  }
  ask(question: string): Promise<string> {
    return new Promise((resolve) => this.rl.question(question, (a) => resolve(a.trim())));
  }
  async askDefault(question: string, def: string): Promise<string> {
    const answer = await this.ask(`${question} [${def}]: `);
    return answer === "" ? def : answer;
  }
  async askYesNo(question: string, def: boolean): Promise<boolean> {
    const hint = def ? "Y/n" : "y/N";
    const answer = (await this.ask(`${question} (${hint}): `)).toLowerCase();
    if (answer === "") return def;
    return answer === "y" || answer === "yes";
  }
  async askChoice(question: string, choices: string[], def: number): Promise<number> {
    console.log(question);
    choices.forEach((c, i) => console.log(`  ${i + 1}) ${c}`));
    const raw = await this.ask(`Choose [${def + 1}]: `);
    if (raw === "") return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > choices.length) {
      console.log(`  Invalid selection — defaulting to ${choices[def]}.`);
      return def;
    }
    return n - 1;
  }
  close() {
    this.rl.close();
  }
}

const PROVIDER_URLS: Record<"infura" | "alchemy", Record<SupportedChain, (k: string) => string>> = {
  infura: {
    ethereum: (k) => `https://mainnet.infura.io/v3/${k}`,
    arbitrum: (k) => `https://arbitrum-mainnet.infura.io/v3/${k}`,
    polygon: (k) => `https://polygon-mainnet.infura.io/v3/${k}`,
    base: (k) => `https://base-mainnet.infura.io/v3/${k}`,
    optimism: (k) => `https://optimism-mainnet.infura.io/v3/${k}`,
  },
  alchemy: {
    ethereum: (k) => `https://eth-mainnet.g.alchemy.com/v2/${k}`,
    arbitrum: (k) => `https://arb-mainnet.g.alchemy.com/v2/${k}`,
    polygon: (k) => `https://polygon-mainnet.g.alchemy.com/v2/${k}`,
    base: (k) => `https://base-mainnet.g.alchemy.com/v2/${k}`,
    optimism: (k) => `https://opt-mainnet.g.alchemy.com/v2/${k}`,
  },
};

/** Make a minimal eth_chainId call against the URL. Returns the numeric chain ID on success. */
async function validateRpcUrl(url: string): Promise<number> {
  const client = createPublicClient({ chain: mainnet, transport: http(url, { retryCount: 0 }) });
  const id = await client.getChainId();
  return id;
}

async function configureRpc(p: Prompt): Promise<UserConfig["rpc"]> {
  console.log("\n--- RPC Provider ---");
  console.log(
    "Optional for first-time portfolio reads — the zero-config path uses",
  );
  console.log(
    "shared public endpoints (PublicNode). Heavy use / fan-out will rate-",
  );
  console.log(
    "limit on the public path; set a provider below for real headroom.",
  );
  // Default to the currently-configured provider if any, so re-running the
  // wizard doesn't force the user to re-pick every time. Index order matches
  // the `providerOrder` array below.
  const providerOrder = ["infura", "alchemy", "custom"] as const satisfies readonly RpcProvider[];
  const existing = readUserConfig();
  const defaultIdx = existing ? providerOrder.indexOf(existing.rpc.provider) : 0;
  const providerIdx = await p.askChoice(
    "Select an RPC provider:",
    ["Infura", "Alchemy", "Custom (bring your own URLs)"],
    defaultIdx >= 0 ? defaultIdx : 0
  );
  const provider = providerOrder[providerIdx];

  if (provider === "custom") {
    const ethUrl = await p.ask("Ethereum RPC URL: ");
    const arbUrl = await p.ask("Arbitrum RPC URL (leave blank to skip): ");
    const polyUrl = await p.ask("Polygon RPC URL (leave blank to skip): ");
    const baseUrl = await p.ask("Base RPC URL (leave blank to skip): ");
    if (ethUrl) {
      try {
        const id = await validateRpcUrl(ethUrl);
        if (id !== 1) console.warn(`  Warning: Ethereum URL returned chain ID ${id}, expected 1.`);
        else console.log("  Ethereum URL OK.");
      } catch (e) {
        console.warn(`  Warning: could not validate Ethereum URL — ${(e as Error).message}`);
      }
    }
    return {
      provider: "custom",
      customUrls: {
        ...(ethUrl ? { ethereum: ethUrl } : {}),
        ...(arbUrl ? { arbitrum: arbUrl } : {}),
        ...(polyUrl ? { polygon: polyUrl } : {}),
        ...(baseUrl ? { base: baseUrl } : {}),
      },
    };
  }

  // infura / alchemy
  const prevKey = existing?.rpc.provider === provider ? existing.rpc.apiKey : undefined;
  let apiKey = prevKey ?? "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const prompt = prevKey
      ? `${provider} API key [press enter to keep existing]: `
      : `${provider} API key: `;
    const entered = await p.ask(prompt);
    apiKey = entered || prevKey || "";
    if (!apiKey) {
      console.log("  An API key is required.");
      continue;
    }
    const testUrl = PROVIDER_URLS[provider].ethereum(apiKey);
    try {
      const id = await validateRpcUrl(testUrl);
      if (id === 1) {
        console.log(`  ${provider} API key OK — Ethereum chain ID ${id}.`);
        return { provider, apiKey };
      }
      console.warn(`  Unexpected chain ID ${id} from ${provider}.`);
    } catch (e) {
      console.warn(`  Validation failed: ${(e as Error).message}`);
    }
  }
  throw new Error(`Could not validate ${provider} API key after 3 attempts.`);
}

/**
 * Ask for an optional API key or URL. If the user presses enter without
 * typing anything and there is an existing value, returns the existing value.
 * Returns undefined when the user explicitly clears or skips the field.
 */
async function askOptionalKey(
  p: Prompt,
  label: string,
  existing: string | undefined,
): Promise<string | undefined> {
  const prompt = existing
    ? `${label} [press enter to keep existing]: `
    : `${label} (or blank to skip): `;
  const answer = await p.ask(prompt);
  if (!answer && existing) return existing;
  return answer || undefined;
}

async function configureEtherscan(p: Prompt): Promise<string | undefined> {
  console.log("\n--- Etherscan (optional) ---");
  console.log("Improves contract-verification tools. Skip with empty input.");
  const existing = readUserConfig()?.etherscanApiKey;
  return askOptionalKey(p, "Etherscan API key", existing);
}

async function configureOneInch(p: Prompt): Promise<string | undefined> {
  console.log("\n--- 1inch (optional — enables swap-quote comparison vs LiFi) ---");
  // Deep link to the new-key form; landing on the dashboard root makes users
  // hunt through nav. Marketing pages are also click-wastage for this audience.
  console.log("Create a free key at https://portal.1inch.dev/dashboard/api/keys. Skip with empty input.");
  const existing = readUserConfig()?.oneInchApiKey;
  return askOptionalKey(p, "1inch API key", existing);
}

async function configureSafe(p: Prompt): Promise<string | undefined> {
  console.log("\n--- Safe (optional — enables Safe / Gnosis Safe multisig tools) ---");
  console.log("Required for `get_safe_positions` and the propose/execute Safe tools.");
  console.log("The modern `*.safe.global` Transaction Service authenticates every request,");
  console.log("so portfolio reads against a Safe are gated on this key. Skip if you don't");
  console.log("use Safe.");
  console.log("Create a free key at https://developer.safe.global/.");
  const existing = readUserConfig()?.safeApiKey;
  return askOptionalKey(p, "Safe API key", existing);
}

async function validateTronApiKey(apiKey: string): Promise<void> {
  // USDT-TRC20 address — well-known, always returns 200 on a healthy grid.
  const url = "https://api.trongrid.io/v1/accounts/TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
  const res = await fetch(url, { headers: { "TRON-PRO-API-KEY": apiKey } });
  if (!res.ok) {
    throw new Error(`TronGrid returned ${res.status} ${res.statusText}`);
  }
}

async function configureTron(p: Prompt): Promise<string | undefined> {
  console.log("\n--- TRON (optional — enables TRX + TRC-20 balance reads) ---");
  console.log("TRON is non-EVM: no Aave/Compound/Uniswap there, but TRC-20 USDT");
  console.log("dominates the chain and is worth folding into your portfolio total.");
  console.log("Create a free key at https://www.trongrid.io/dashboard/apikeys (deep link to the API-Keys page).");
  console.log("Skip with empty input — TRON reads will be disabled.");
  const existing = readUserConfig()?.tronApiKey;
  const answer = await p.ask(
    existing
      ? "TronGrid API key [press enter to keep existing]: "
      : "TronGrid API key (or blank to skip): "
  );
  const apiKey = answer || existing;
  if (!apiKey) return undefined;

  try {
    await validateTronApiKey(apiKey);
    console.log("  TronGrid API key OK.");
  } catch (e) {
    console.warn(`  Warning: could not validate TronGrid key — ${(e as Error).message}`);
    console.warn("  Saving anyway; TRON reads will surface the error at query time.");
  }
  return apiKey;
}

const HELIUS_HOST = "mainnet.helius-rpc.com";

function heliusUrlFromKey(apiKey: string): string {
  return `https://${HELIUS_HOST}/?api-key=${apiKey}`;
}

/** Extract the api-key query param from a Helius URL. Returns undefined if the URL isn't Helius or lacks the param. */
function extractHeliusKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== HELIUS_HOST) return undefined;
    return parsed.searchParams.get("api-key") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Light liveness check: JSON-RPC `getVersion` with a 5s timeout. A working
 * Solana RPC always returns `result.solana-core` — anything else (HTTP
 * error, 401 from a bad Helius key, timeout) throws a descriptive error.
 */
async function validateSolanaRpcUrl(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5_000);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getVersion" }),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`RPC returned ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      result?: { "solana-core"?: string };
      error?: { message?: string };
    };
    if (body.error) {
      throw new Error(`getVersion RPC error: ${body.error.message ?? "unknown"}`);
    }
    const version = body.result?.["solana-core"];
    if (!version) throw new Error(`no solana-core version in response`);
    return version;
  } finally {
    clearTimeout(timer);
  }
}

async function configureSolana(p: Prompt): Promise<string | undefined> {
  console.log("\n--- Solana (optional — enables SOL + SPL balance reads and history) ---");
  console.log("Solana is non-EVM with its own ecosystem: SPL tokens via Associated Token");
  console.log("Accounts, native validator staking, and DeFi protocols like Jupiter/Marinade/");
  console.log("Jito/Raydium/Orca. Public mainnet RPC is rate-limited — use a provider.");

  const existing = readUserConfig()?.solanaRpcUrl;
  const existingHeliusKey = extractHeliusKey(existing);

  const providerIdx = await p.askChoice(
    "Select a Solana RPC provider:",
    [
      "Helius (recommended — enter API key, we build the URL)",
      "Custom URL (paste full URL from QuickNode / Alchemy / Triton / etc.)",
      "Skip — disable Solana reads",
    ],
    existing && !existingHeliusKey ? 1 : 0
  );

  if (providerIdx === 2) return undefined;

  if (providerIdx === 0) {
    // Helius flow — mirrors the Infura/Alchemy key-based path for EVM RPC.
    console.log("Create a free Helius API key at https://dashboard.helius.dev/api-keys (deep link to the API-Keys page).");
    for (let attempt = 0; attempt < 3; attempt++) {
      const prompt = existingHeliusKey
        ? "Helius API key [press enter to keep existing]: "
        : "Helius API key: ";
      const entered = await p.ask(prompt);
      const apiKey = entered || existingHeliusKey || "";
      if (!apiKey) {
        console.log("  An API key is required. Try again or pick 'Skip'.");
        continue;
      }
      const url = heliusUrlFromKey(apiKey);
      try {
        const version = await validateSolanaRpcUrl(url);
        console.log(`  Helius API key OK — solana-core ${version}.`);
        return url;
      } catch (e) {
        console.warn(`  Validation failed: ${(e as Error).message}`);
      }
    }
    throw new Error("Could not validate Helius API key after 3 attempts.");
  }

  // Custom URL — user pastes the whole thing. Validate lightly.
  const existingCustom = !existingHeliusKey ? existing : undefined;
  const answer = await p.ask(
    existingCustom
      ? "Solana RPC URL [press enter to keep existing]: "
      : "Solana RPC URL: "
  );
  const url = answer || existingCustom;
  if (!url) return undefined;
  try {
    const version = await validateSolanaRpcUrl(url);
    console.log(`  Solana RPC OK — solana-core ${version}.`);
  } catch (e) {
    console.warn(`  Warning: could not validate Solana RPC — ${(e as Error).message}`);
    console.warn("  Saving anyway; balance reads will surface the error at query time.");
  }
  return url;
}

async function configureWalletConnect(p: Prompt): Promise<string | undefined> {
  console.log("\n--- WalletConnect (optional — required for Ledger Live signing) ---");
  // Reown is WalletConnect's rebranded dashboard. Deep link goes straight to
  // the new-project form; the /app route below it would require navigating
  // the main dashboard manually.
  console.log("Create a free project at https://cloud.reown.com/app/new-project.");
  const existing = readUserConfig()?.walletConnect?.projectId;
  return askOptionalKey(p, "WalletConnect project ID", existing);
}

async function pairLedgerLiveFlow(p: Prompt): Promise<void> {
  console.log("\n--- Ledger Live pairing ---");
  const proceed = await p.askYesNo("Pair Ledger Live now via WalletConnect?", false);
  if (!proceed) return;

  // Dynamically import so the setup still runs cleanly when WC fails to initialize.
  const { initiatePairing } = await import("./signing/walletconnect.js");
  let pairing: { uri: string; approval: Promise<unknown> };
  try {
    pairing = await initiatePairing();
  } catch (e) {
    console.error(`  Could not initiate pairing: ${(e as Error).message}`);
    return;
  }

  console.log("\nScan this QR in Ledger Live → Discover → WalletConnect, or paste the URI:\n");
  await new Promise<void>((resolve) =>
    qrcodeTerminal.generate(pairing.uri, { small: true }, (qr: string) => {
      console.log(qr);
      resolve();
    })
  );
  // The URI carries the WalletConnect topic + a one-shot symmetric key. It
  // isn't long-lived key material, but anyone who pairs with it first wins
  // the session, so keep it out of long-lived logs and terminal scrollback
  // shared with others.
  console.log(`URI (sensitive — don't share; one-time pairing secret): ${pairing.uri}\n`);
  console.log("Waiting for you to approve the session in Ledger Live (Ctrl-C to cancel)...");

  try {
    await pairing.approval;
    console.log("Paired. Session persisted to config.");
  } catch (e) {
    console.error(`Pairing failed: ${(e as Error).message}`);
  }
}

function printClaudeDesktopSnippet(): void {
  const binPath = "vaultpilot-mcp"; // installed via `npm i -g vaultpilot-mcp`
  const snippet = {
    mcpServers: {
      "vaultpilot-mcp": {
        command: binPath,
      },
    },
  };
  console.log("\n--- Claude Desktop config snippet ---");
  console.log("Add the following to `claude_desktop_config.json`:\n");
  console.log(JSON.stringify(snippet, null, 2));
  console.log(
    "\nIf you're running from source rather than a global install, use:\n" +
      JSON.stringify(
        {
          mcpServers: {
            "vaultpilot-mcp": {
              command: "node",
              args: [`${process.cwd()}/dist/index.js`],
            },
          },
        },
        null,
        2
      )
  );
}

/**
 * Print a redacted summary of the current config so the user can decide what
 * (if anything) to change. API keys are shown as "set" / "not set" rather
 * than the raw value — this file gets shown in terminals with scrollback and
 * we don't want the keys hanging around up there.
 */
function summarizeConfig(cfg: UserConfig): void {
  console.log("\n--- Current configuration ---");
  if (cfg.rpc.provider === "custom") {
    console.log(`  RPC provider:        custom`);
    const urls = cfg.rpc.customUrls ?? {};
    const chains = Object.keys(urls).filter((c) => (urls as Record<string, string>)[c]);
    if (chains.length > 0) {
      console.log(`    chains configured: ${chains.join(", ")}`);
    }
  } else {
    console.log(
      `  RPC provider:        ${cfg.rpc.provider}${cfg.rpc.apiKey ? " (API key set)" : " (API key MISSING)"}`
    );
  }
  console.log(`  Etherscan API key:   ${cfg.etherscanApiKey ? "set" : "not set"}`);
  console.log(`  1inch API key:       ${cfg.oneInchApiKey ? "set" : "not set"}`);
  console.log(`  Safe API key:        ${cfg.safeApiKey ? "set" : "not set"}`);
  console.log(`  TronGrid API key:    ${cfg.tronApiKey ? "set" : "not set"}`);
  let solanaLabel: string;
  if (!cfg.solanaRpcUrl) {
    solanaLabel = "not set";
  } else if (extractHeliusKey(cfg.solanaRpcUrl)) {
    solanaLabel = "Helius (API key set)";
  } else {
    solanaLabel = "custom URL set";
  }
  console.log(`  Solana RPC URL:      ${solanaLabel}`);
  console.log(
    `  WalletConnect:       ${cfg.walletConnect?.projectId ? "project ID set" : "not set"}`
  );
}

/**
 * Section-by-section edit loop. The user picks a setting, we call the
 * corresponding `configure*` function (which already supports "press enter
 * to keep existing" for API-key fields), and loop until the user picks
 * "Done". This is the ergonomic path for updating one setting without
 * re-entering the whole wizard.
 */
async function editSectionMenu(p: Prompt): Promise<void> {
  const sections = [
    { label: "RPC provider / API key", action: "rpc" as const },
    { label: "Etherscan API key", action: "etherscan" as const },
    { label: "1inch API key", action: "oneinch" as const },
    { label: "Safe API key", action: "safe" as const },
    { label: "TronGrid API key", action: "tron" as const },
    { label: "Solana RPC URL", action: "solana" as const },
    { label: "WalletConnect project ID", action: "wc" as const },
    { label: "Pair Ledger Live now", action: "pair" as const },
    { label: "Done — exit setup", action: "done" as const },
  ];
  while (true) {
    const idx = await p.askChoice(
      "\nWhich setting would you like to edit?",
      sections.map((s) => s.label),
      sections.length - 1
    );
    const action = sections[idx].action;
    if (action === "done") return;
    switch (action) {
      case "rpc": {
        const rpc = await configureRpc(p);
        patchUserConfig({ rpc });
        break;
      }
      case "etherscan": {
        const k = await configureEtherscan(p);
        if (k !== undefined) patchUserConfig({ etherscanApiKey: k });
        break;
      }
      case "oneinch": {
        const k = await configureOneInch(p);
        if (k !== undefined) patchUserConfig({ oneInchApiKey: k });
        break;
      }
      case "safe": {
        const k = await configureSafe(p);
        if (k !== undefined) patchUserConfig({ safeApiKey: k });
        break;
      }
      case "tron": {
        const k = await configureTron(p);
        if (k !== undefined) patchUserConfig({ tronApiKey: k });
        break;
      }
      case "solana": {
        const url = await configureSolana(p);
        if (url !== undefined) patchUserConfig({ solanaRpcUrl: url });
        break;
      }
      case "wc": {
        const k = await configureWalletConnect(p);
        if (k !== undefined) patchUserConfig({ walletConnect: { projectId: k } });
        break;
      }
      case "pair": {
        await pairLedgerLiveFlow(p);
        break;
      }
    }
    console.log(`  Saved to ${getConfigPath()}.`);
  }
}

/**
 * Full first-time (or opt-in re-run) wizard. Walks every section in order.
 * Extracted from main() so the edit-mode branch can skip it cleanly.
 */
async function runFullWizard(p: Prompt): Promise<void> {
  const rpc = await configureRpc(p);
  patchUserConfig({ rpc });

  const etherscanApiKey = await configureEtherscan(p);
  if (etherscanApiKey !== undefined) {
    patchUserConfig({ etherscanApiKey });
  }

  const oneInchApiKey = await configureOneInch(p);
  if (oneInchApiKey !== undefined) {
    patchUserConfig({ oneInchApiKey });
  }

  const safeApiKey = await configureSafe(p);
  if (safeApiKey !== undefined) {
    patchUserConfig({ safeApiKey });
  }

  const tronApiKey = await configureTron(p);
  if (tronApiKey !== undefined) {
    patchUserConfig({ tronApiKey });
  }

  const solanaRpcUrl = await configureSolana(p);
  if (solanaRpcUrl !== undefined) {
    patchUserConfig({ solanaRpcUrl });
  }

  const wcProjectId = await configureWalletConnect(p);
  if (wcProjectId !== undefined) {
    patchUserConfig({ walletConnect: { projectId: wcProjectId } });
  }

  // Pairing needs the project ID to be in config already (getSignClient reads it).
  if (wcProjectId) {
    await pairLedgerLiveFlow(p);
  } else {
    console.log("\nSkipping Ledger Live pairing (no WalletConnect project ID set).");
  }

  // Linux-only: surface Ledger udev-rules status at the end. No-op on
  // macOS / Windows. If rules are missing on Linux, prints the install
  // one-liner for the user to run separately (no sudo during the wizard).
  reportLedgerUdevStatus();

  // Auto-register the MCP entry into installed agent-client configs so
  // the user doesn't have to find + edit the JSON file by hand. Asks
  // permission first — even with backups, touching another app's config
  // file should be opt-in.
  await offerClientAutoRegister(p);

  // Offer to clone the two companion Claude Code skills (preflight + setup)
  // into `~/.claude/skills/`. Opt-in because we're writing to a
  // Claude Code-owned directory. Skipping is safe — the MCP's runtime
  // detection still fires a missing-skill notice.
  await offerSkillInstall(p);
}

/**
 * Detect which agent clients are installed on the host and offer to add
 * the `vaultpilot-mcp` entry to each of their MCP-server configs. Only
 * touches user-level configs (Claude Desktop's per-OS path, Claude Code's
 * `~/.claude.json`, Cursor's `~/.cursor/mcp.json`) — per-project / per-
 * workspace configs are skipped because the wizard runs from an arbitrary
 * CWD and patching the wrong project's config is worse than skipping.
 */
async function offerClientAutoRegister(p: Prompt): Promise<void> {
  console.log("\n--- Agent client registration ---");
  const targets = getClientConfigPaths();
  const detected = targets.filter(
    ({ configPath }) => detectClient(configPath) !== "absent",
  );
  if (detected.length === 0) {
    console.log("  No agent clients detected (Claude Desktop / Claude Code / Cursor).");
    console.log("  Skipping auto-registration. If you install one later, re-run this");
    console.log("  setup or add the snippet from the README manually.");
    return;
  }
  console.log("  Detected: " + detected.map((d) => d.client).join(", "));
  console.log("  We can add a `vaultpilot-mcp` entry to each detected client's");
  console.log("  MCP-server config so the server starts automatically when you");
  console.log("  open the client. Each existing config is backed up to");
  console.log("  `<file>.vaultpilot.bak` before any change.");
  const ans = (await p.ask("  Auto-register now? [Y/n]: ")).trim().toLowerCase();
  if (ans === "n" || ans === "no") {
    console.log("  Skipped. Re-run the wizard to register later.");
    return;
  }
  const results = registerVaultPilotWithClients();
  console.log("\n  Result:");
  console.log(summarizePatchResults(results));
}

/**
 * Offer to clone the companion Claude Code skills (preflight + setup) into
 * `~/.claude/skills/`. Idempotent — already-cloned skills are left alone;
 * this function just surfaces their state. Both skills are intentionally
 * hosted in separate repos so the user's local clones are the trust root,
 * not the MCP release pipeline — we never `git pull` here, only an
 * initial clone. The user updates them manually with `git pull --ff-only`.
 */
async function offerSkillInstall(p: Prompt): Promise<void> {
  console.log("\n--- Companion skills ---");
  const targets = getSkillTargets();
  const already = targets.filter((t) => existsSync(join(t.installPath, "SKILL.md")));
  const missing = targets.filter((t) => !existsSync(join(t.installPath, "SKILL.md")));
  if (already.length > 0) {
    console.log(
      `  Already installed: ${already.map((t) => t.name).join(", ")}`,
    );
  }
  if (missing.length === 0) {
    console.log("  Nothing to install.");
    return;
  }
  console.log(
    `  Missing: ${missing.map((t) => t.name).join(", ")}. These are two small`,
  );
  console.log("  Claude Code skills the MCP expects at `~/.claude/skills/`:");
  for (const m of missing) {
    console.log(`    - ${m.name} → ${m.repoUrl}`);
  }
  console.log("  We can `git clone` them now (depth-1, one-time).");
  const ans = (await p.ask("  Install now? [Y/n]: ")).trim().toLowerCase();
  if (ans === "n" || ans === "no") {
    console.log(
      "  Skipped. You can clone them later with the snippets in the README.",
    );
    return;
  }
  const results = installAllSkills();
  console.log("\n  Result:");
  console.log(summarizeSkillInstalls(results));
}

/**
 * Read the package version once at module load. Resolved relative to
 * this file so it works for both global-install (`dist/setup.js` next
 * to `package.json` in node_modules) and source runs (`dist/setup.js`
 * with the source `package.json` two dirs up).
 */
function readPackageVersion(): string {
  // The `package.json` always lives in the package root, which is the
  // parent of `dist/`. From this module's URL we can resolve there
  // without depending on the cwd. ESM lacks a built-in `require`, so
  // we go through `createRequire` to pick the file up.
  const here = fileURLToPath(import.meta.url);
  const req = createRequire(here);
  try {
    const pkg = req("../package.json") as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Non-interactive install flow — the agent-driven path. Skips every
 * prompt: no RPC provider configured (PublicNode falls in at runtime),
 * no API keys collected, no Ledger pairing. We only do the two steps
 * that don't need user input and aren't sensitive: register MCP
 * clients and clone the companion skills.
 *
 * Both `registerVaultPilotWithClients` and `installAllSkills` are
 * already idempotent — re-running them re-uses the existing entries
 * — so we don't need a separate "is it installed" probe up front.
 * The envelope's `status` derives from the per-step results.
 */
async function runNonInteractive(opts: {
  json: boolean;
}): Promise<void> {
  const patches = registerVaultPilotWithClients();
  const skills = installAllSkills();

  const envelope = buildInstallEnvelope({
    version: readPackageVersion(),
    binaries: {
      // process.argv[1] is the entry of the running process — the
      // setup binary the user invoked. The server binary lives next
      // to it after the release pipeline (e.g. `vaultpilot-mcp`).
      // Best-effort: if we can resolve the registered server path
      // from the patches, prefer it; else echo what we know.
      setup: process.argv[1] ?? "",
      server:
        patches
          .map((p) => p.detail)
          .find((d) => typeof d === "string" && d.length > 0 && d.endsWith("index.js")) ?? "",
    },
    patches,
    skills,
  });

  if (opts.json) {
    // Emit ONLY the envelope on stdout — no other output. Anything
    // else would corrupt the JSON for the script consuming it.
    process.stdout.write(JSON.stringify(envelope, null, 2) + "\n");
    return;
  }

  // Human-readable summary for direct CLI use of `--non-interactive`.
  console.log("VaultPilot MCP — non-interactive install");
  console.log(`Version: ${envelope.version}`);
  console.log("");
  console.log(summarizePatchResults(patches));
  console.log("");
  console.log(summarizeSkillInstalls(skills));
  console.log("");
  if (envelope.status === "already_installed") {
    console.log("Status: already installed (no new work performed).");
  } else {
    console.log("Status: installed.");
  }
  console.log("");
  console.log("Next steps:");
  for (const s of envelope.next_steps) console.log(`  - ${s}`);
}

export async function runSetup(): Promise<void> {
  // Demo mode is a try-before-install switch — the server runs against
  // fixture data and never touches a real Ledger or RPC. Running the
  // setup wizard while VAULTPILOT_DEMO is active would write real config
  // (Ledger pairing state, API keys, indexer URLs) to disk and silently
  // create a misleading mismatch between what the user sees in chat
  // (fixture data) and what's actually configured. Refuse with a clear
  // message instead — runs BEFORE non-interactive flag handling so the
  // demo guard short-circuits both interactive and `--non-interactive`
  // entry points.
  const { assertNotDemoForSetup } = await import("./demo/index.js");
  try {
    assertNotDemoForSetup();
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  const flags = parseSetupFlags(process.argv.slice(2));

  if (flags.nonInteractive) {
    try {
      await runNonInteractive({ json: flags.json });
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (flags.json) {
        // Emit a structured error envelope so the script consuming
        // stdout can still parse it. Distinct shape from the success
        // envelope (no clients/skills arrays) so the parser can branch
        // on the presence of `error`.
        process.stdout.write(
          JSON.stringify(
            { status: "error", error: message, version: readPackageVersion() },
            null,
            2,
          ) + "\n",
        );
      } else {
        console.error(`Non-interactive install failed: ${message}`);
      }
      process.exitCode = 1;
    }
    return;
  }

  console.log("VaultPilot MCP — interactive setup\n");
  console.log(`Config path: ${getConfigPath()}`);

  const p = new Prompt();
  try {
    const existing = readUserConfig();
    if (existing) {
      // Re-run with existing config: show what's there and offer a menu so
      // the user can tweak one thing without re-entering everything. The
      // previous behavior (no branch) forced a full re-run and relied on
      // per-prompt "keep existing" affordances, which was confusing for
      // users who just wanted to update one API key.
      summarizeConfig(existing);
      const mode = await p.askChoice(
        "\nConfig already exists. What would you like to do?",
        [
          "Edit specific settings",
          "Re-run the full setup wizard",
          "Skip to Ledger Live pairing",
          "Exit without changes",
        ],
        0
      );
      if (mode === 0) {
        await editSectionMenu(p);
      } else if (mode === 1) {
        await runFullWizard(p);
      } else if (mode === 2) {
        await pairLedgerLiveFlow(p);
      } else {
        console.log("\nNo changes.");
        return;
      }
    } else {
      await runFullWizard(p);
    }

    console.log(`\nConfig written to ${getConfigPath()}.`);
    printClaudeDesktopSnippet();
  } catch (err) {
    console.error(`\nSetup aborted: ${(err as Error).message}`);
    process.exitCode = 1;
  } finally {
    p.close();
  }
}

// Only invoke main() when this module is the entrypoint (i.e. the
// user ran `vaultpilot-mcp-setup` or `node dist/setup.js`). Without
// this guard, importing `parseSetupFlags` from a unit test also runs
// the wizard, which then blocks on stdin and corrupts test output
// (issue surfaced by the parser tests in #PR opening this).
const invokedDirectly = (() => {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  // import.meta.url is a file:// URL; argv[1] is a filesystem path.
  // Compare both as URLs to handle symlinks + extension differences.
  const fileUrl = new URL(`file://${argv1}`).href;
  return fileUrl === import.meta.url;
})();

if (invokedDirectly) {
  runSetup().then(() => {
    // WalletConnect's SignClient keeps websocket/relay handles open that prevent
    // a natural event-loop exit. Force-exit so the CLI returns control to the
    // shell; process.exitCode (set on error) is honored.
    process.exit();
  });
}
