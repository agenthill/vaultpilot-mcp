/**
 * Read-only diagnostic tool: report what the server knows about its config
 * without revealing any secret values. Intended for the future agent-guided
 * `/setup` skill (separate repo) but immediately useful for a user
 * diagnosing "is my server configured the way I think it is?".
 *
 * Strict no-secrets contract:
 *  - Never echoes raw API keys, RPC URLs (which may carry keys in the path),
 *    WC session symkeys, or paired-account private material.
 *  - WC session topic surfaces only as the last 8 chars (matches the
 *    existing `get_ledger_status` convention — enough to cross-check
 *    against Ledger Live's connected-apps list).
 *  - Per-key fields are reduced to `{ set: boolean; source: "env-var" |
 *    "config" | "unset" }`.
 *
 * Pure local I/O: reads `~/.vaultpilot-mcp/config.json` and inspects
 * `process.env`. No RPC calls, no network. Cheap to invoke on every
 * `/setup` step.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readUserConfig, getConfigPath } from "../../config/user-config.js";
import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";
import {
  getActiveHints,
  type SetupHint,
} from "../../data/rate-limit-tracker.js";
import { isDemoMode, getLiveWallet, isLiveMode } from "../../demo/index.js";
import { getEnabledFamilies, getEnabledProtocols } from "../../config/scope.js";
import { getRuntimeSolanaRpc } from "../../data/runtime-rpc-overrides.js";

type EvmRpcSource =
  | "env-var"
  | "provider-key-env"
  | "provider-key-config"
  | "custom-url-config"
  | "public-fallback";

type SolanaRpcSource =
  | "runtime-override"
  | "env-var"
  | "config-url"
  | "public-fallback";

type ApiKeySource = "env-var" | "config" | "unset";

const ENV_URL_VAR: Record<SupportedChain, string> = {
  ethereum: "ETHEREUM_RPC_URL",
  arbitrum: "ARBITRUM_RPC_URL",
  polygon: "POLYGON_RPC_URL",
  base: "BASE_RPC_URL",
  optimism: "OPTIMISM_RPC_URL",
};

/**
 * Determine the source of the EVM RPC URL for a given chain. Mirrors the
 * priority order in `src/config/chains.ts:resolveRpcUrlRaw`. Replicated
 * deliberately rather than refactored-and-shared so a refactor of the
 * resolver doesn't accidentally change diagnostic output.
 */
function classifyEvmRpcSource(chain: SupportedChain): EvmRpcSource {
  if (process.env[ENV_URL_VAR[chain]]) return "env-var";
  const envProvider = process.env.RPC_PROVIDER?.toLowerCase();
  if (
    (envProvider === "infura" || envProvider === "alchemy") &&
    process.env.RPC_API_KEY
  ) {
    return "provider-key-env";
  }
  const cfg = readUserConfig();
  if (cfg) {
    if (cfg.rpc.provider === "custom" && cfg.rpc.customUrls?.[chain]) {
      return "custom-url-config";
    }
    if (
      (cfg.rpc.provider === "infura" || cfg.rpc.provider === "alchemy") &&
      cfg.rpc.apiKey
    ) {
      return "provider-key-config";
    }
  }
  return "public-fallback";
}

function classifySolanaRpcSource(): SolanaRpcSource {
  if (getRuntimeSolanaRpc()) return "runtime-override";
  if (process.env.SOLANA_RPC_URL) return "env-var";
  if (readUserConfig()?.solanaRpcUrl) return "config-url";
  return "public-fallback";
}

function classifyApiKey(envName: string, configValue: unknown): { set: boolean; source: ApiKeySource } {
  if (process.env[envName]) return { set: true, source: "env-var" };
  if (typeof configValue === "string" && configValue.length > 0) {
    return { set: true, source: "config" };
  }
  return { set: false, source: "unset" };
}

interface VaultPilotConfigStatus {
  /** Where this server expects to read / write its config file. */
  configPath: string;
  /** Whether the config file exists on disk right now. */
  configFileExists: boolean;
  /** vaultpilot-mcp version (read from package.json at process start). */
  serverVersion: string;
  /** Per-chain RPC URL source classification (no URLs leaked). */
  rpc: Record<SupportedChain | "solana", { source: EvmRpcSource | SolanaRpcSource }>;
  /** Per-service API key presence + source. Boolean-only — values never leak. */
  apiKeys: {
    etherscan: { set: boolean; source: ApiKeySource };
    oneInch: { set: boolean; source: ApiKeySource };
    safe: { set: boolean; source: ApiKeySource };
    tronGrid: { set: boolean; source: ApiKeySource };
    walletConnectProjectId: { set: boolean; source: ApiKeySource };
  };
  /** Counts of paired Ledger accounts + WC session-topic suffix (last 8 chars). */
  pairings: {
    walletConnect: { sessionTopicSuffix?: string };
    solana: { count: number };
    tron: { count: number };
  };
  /**
   * Agent-side preflight skill state — checked by path, no content read.
   * Override path via VAULTPILOT_SKILL_MARKER_PATH env var (read-only sniff —
   * we don't validate the skill content here).
   */
  preflightSkill: {
    expectedPath: string;
    installed: boolean;
  };
  /**
   * Active setup-key nudges from the rate-limit tracker
   * (`src/data/rate-limit-tracker.ts`). Surfaces when a no-key
   * default RPC has been throttled past the threshold (3 hits in 5
   * min). Each entry tells the user which provider to sign up for,
   * the dashboard URL, and the wizard subcommand to add the key.
   *
   * Empty when no source has tripped (the common case). Agent-side
   * convention: when non-empty, surface the entries to the user as
   * actionable advice — these are NOT noise, they're a real
   * remediation path the user wants to act on.
   */
  setupHints: SetupHint[];
  /**
   * Demo-mode discoverability surface (issue #371). The demo feature
   * (`VAULTPILOT_DEMO=true`) lets a prospective user evaluate VaultPilot
   * without a Ledger; this field makes the env-var gate AND the live
   * sub-mode discoverable from the canonical "is my MCP set up?" tool.
   *
   *   - `active`: env-var state at request time.
   *   - `howToEnable`: activation recipe (env unset) or exit recipe
   *     (env set) — verbatim-relayable.
   *   - `liveMode`: whether `set_demo_wallet` has been called this
   *     session, the persona ID + address bundle if so. Mutates at
   *     runtime — the agent CAN toggle live-mode wallets via
   *     `set_demo_wallet`, unlike the env var which requires a restart.
   */
  demoMode: {
    active: boolean;
    envVar: "VAULTPILOT_DEMO";
    howToEnable: string;
    liveMode: {
      active: boolean;
      personaId: string | null;
      addresses: {
        evm: string[];
        solana: string[];
        tron: string[];
        bitcoin: string[] | null;
      } | null;
    };
  };
  /**
   * Active tool-surface scope (plan: claude-work/plan-conditional-chain-context-loading.md).
   *
   *   - `families`: which chain families' tools were registered this
   *     session. Matches `VAULTPILOT_CHAIN_FAMILIES` env var (default = all
   *     five). When narrower than all-five, the corresponding chains' tools
   *     don't appear in this MCP's surface — saving the per-turn token cost
   *     of carrying their description + JSON schema.
   *   - `protocols`: when set, narrows the EVM/Solana protocol-specific
   *     tools further. `null` = all protocols enabled (default).
   *
   * Surface as informational — agents don't need to act on it, but the
   * user does, when troubleshooting "why don't I see prepare_compound_*?".
   */
  scope: {
    families: string[];
    protocols: string[] | null;
  };
}

/**
 * Resolve the server version by reading `package.json` relative to this
 * file's compiled location. Falls back to `"unknown"` if the file isn't
 * found (e.g. unusual install layouts) — diagnostic output, not load-bearing.
 */
function readServerVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // Compiled location: dist/modules/diagnostics/index.js → ../../../package.json
    const pkgPath = join(here, "..", "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

const DEFAULT_SKILL_MARKER = join(
  homedir(),
  ".claude",
  "skills",
  "vaultpilot-preflight",
  "SKILL.md",
);

function skillMarkerPath(): string {
  return process.env.VAULTPILOT_SKILL_MARKER_PATH ?? DEFAULT_SKILL_MARKER;
}

export function getVaultPilotConfigStatus(_args: Record<string, never> = {}): VaultPilotConfigStatus {
  const cfg = readUserConfig();
  const configPath = getConfigPath();

  const rpc = {} as VaultPilotConfigStatus["rpc"];
  for (const chain of SUPPORTED_CHAINS) {
    rpc[chain] = { source: classifyEvmRpcSource(chain) };
  }
  rpc.solana = { source: classifySolanaRpcSource() };

  // WC session-topic last-8-chars suffix only (mirrors `get_ledger_status`).
  const sessionTopic = cfg?.walletConnect?.sessionTopic;
  const sessionTopicSuffix =
    typeof sessionTopic === "string" && sessionTopic.length >= 8
      ? sessionTopic.slice(-8)
      : undefined;

  const skillPath = skillMarkerPath();

  // Rate-limit hints. Each `evmUsingDefault[chain]` is true iff the
  // chain's RPC source classifier resolved to "public-fallback" —
  // i.e. the user is on PublicNode without a key. solanaUsingDefault
  // and tronUsingDefault use the same "no key set" check.
  const evmUsingDefault = {
    ethereum: rpc.ethereum.source === "public-fallback",
    arbitrum: rpc.arbitrum.source === "public-fallback",
    polygon: rpc.polygon.source === "public-fallback",
    base: rpc.base.source === "public-fallback",
    optimism: rpc.optimism.source === "public-fallback",
  };
  const solanaUsingDefault = rpc.solana.source === "public-fallback";
  const tronGridKey = classifyApiKey("TRON_API_KEY", cfg?.tronApiKey);
  const tronUsingDefault = !tronGridKey.set;
  const setupHints = getActiveHints({
    evmUsingDefault,
    solanaUsingDefault,
    tronUsingDefault,
  });

  // Issue #371 — first-run demo-mode hint. Fires when the user looks
  // like a fresh install (no API keys, no pairings, no custom RPC,
  // demo not already active). Self-clearing: the moment the user adds
  // a key or pairs a wallet, one of these checks flips and the hint
  // disappears without state. Suppressed when demo IS active to avoid
  // pointing the user at a feature they're already in.
  const etherscanKey = classifyApiKey("ETHERSCAN_API_KEY", cfg?.etherscanApiKey);
  const oneInchKey = classifyApiKey("ONEINCH_API_KEY", cfg?.oneInchApiKey);
  const safeKey = classifyApiKey("SAFE_API_KEY", cfg?.safeApiKey);
  const wcProjectKey = classifyApiKey(
    "WALLETCONNECT_PROJECT_ID",
    cfg?.walletConnect?.projectId,
  );
  const noKeys =
    !etherscanKey.set &&
    !oneInchKey.set &&
    !safeKey.set &&
    !tronGridKey.set &&
    !wcProjectKey.set;
  const noPairings =
    (cfg?.pairings?.solana?.length ?? 0) === 0 &&
    (cfg?.pairings?.tron?.length ?? 0) === 0 &&
    !sessionTopicSuffix;
  const allRpcDefault =
    evmUsingDefault.ethereum &&
    evmUsingDefault.arbitrum &&
    evmUsingDefault.polygon &&
    evmUsingDefault.base &&
    evmUsingDefault.optimism &&
    solanaUsingDefault;
  if (!isDemoMode() && noKeys && noPairings && allRpcDefault) {
    setupHints.push({
      kind: "demo-mode",
      source: "demo-mode-suggestion",
      message:
        "No setup detected — try demo mode to evaluate VaultPilot without a Ledger.",
      recommendation:
        "VaultPilot ships a try-before-install demo mode (`VAULTPILOT_DEMO=true`). " +
        "Activate by adding `--env VAULTPILOT_DEMO=true` to your `claude mcp add " +
        "vaultpilot-mcp` command (or edit the existing MCP entry's env), then restart " +
        "Claude Code. Reads run real chain RPC against any address (rate-limited public " +
        "fallback works without keys; RPC keys recommended for production-grade reads), " +
        "and signing-class tools refuse by default. Once active, call `set_demo_wallet" +
        "({ persona: \"defi-power-user\" })` (or stable-saver / staking-maxi / whale) to " +
        "upgrade to live mode — the broadcast step is then simulated against the persona's " +
        "real on-chain state, letting you walk a full prepare → simulate → \"broadcast\" " +
        "flow with no hardware wallet. Unset the env var and restart to exit demo mode and " +
        "proceed with real setup.",
    });
  }

  const demoActive = isDemoMode();
  const liveWallet = getLiveWallet();
  const enabledProtocols = getEnabledProtocols();

  return {
    configPath,
    configFileExists: existsSync(configPath),
    serverVersion: readServerVersion(),
    rpc,
    apiKeys: {
      etherscan: etherscanKey,
      oneInch: oneInchKey,
      safe: safeKey,
      tronGrid: tronGridKey,
      walletConnectProjectId: wcProjectKey,
    },
    pairings: {
      walletConnect: sessionTopicSuffix ? { sessionTopicSuffix } : {},
      solana: { count: cfg?.pairings?.solana?.length ?? 0 },
      tron: { count: cfg?.pairings?.tron?.length ?? 0 },
    },
    preflightSkill: {
      expectedPath: skillPath,
      installed: existsSync(skillPath),
    },
    setupHints,
    demoMode: {
      active: demoActive,
      envVar: "VAULTPILOT_DEMO",
      howToEnable: demoActive
        ? "Demo mode is active. In default sub-mode, read tools run real chain RPC and signing-class tools refuse. Call `set_demo_wallet({ persona: \"...\" })` to upgrade to live sub-mode — the broadcast step is then simulated against a curated persona's on-chain state. To exit demo mode entirely, drop VAULTPILOT_DEMO from your MCP-client config (e.g. Claude Code's `.claude.json`'s `env` block, or the `--env` flag in `claude mcp add`) and restart the client. Restarting only the MCP server process does NOT clear the env var — the client re-launches the server with the same env on every reconnect."
        : "Set VAULTPILOT_DEMO=true in your MCP-client config and restart the client (e.g. Claude Code). Add via `claude mcp add vaultpilot-mcp --env VAULTPILOT_DEMO=true -- npx -y vaultpilot-mcp` (or edit the existing MCP entry's env). In demo mode, read tools run real chain RPC against any address you pass (RPC keys recommended; falls back to public-fallback endpoints) and signing-class tools refuse. Calling `set_demo_wallet({ persona: \"defi-power-user\" | \"stable-saver\" | \"staking-maxi\" | \"whale\" })` upgrades to live mode where the broadcast step is simulated — no Ledger required.",
      liveMode: {
        active: isLiveMode(),
        personaId: liveWallet?.personaId ?? null,
        addresses: liveWallet?.addresses ?? null,
      },
    },
    scope: {
      families: [...getEnabledFamilies()].sort(),
      protocols: enabledProtocols ? [...enabledProtocols].sort() : null,
    },
  };
}
