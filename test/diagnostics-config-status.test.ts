/**
 * Tests for `get_vaultpilot_config_status`. Mounts a temp HOME so the
 * config-file resolver lands somewhere we control, then exercises every
 * source-classification branch by combining env-var presence and config-
 * file content.
 *
 * The strict no-secrets contract is verified by sweeping the output for
 * known secret-shaped values that were planted in env/config — none of
 * them should appear anywhere in the structured response.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-config-status-test-"));
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.VAULTPILOT_CONFIG_DIR = join(tmpHome, ".vaultpilot-mcp");
  // Make sure no leftover process env from another test affects classification.
  delete process.env.ETHEREUM_RPC_URL;
  delete process.env.ARBITRUM_RPC_URL;
  delete process.env.POLYGON_RPC_URL;
  delete process.env.BASE_RPC_URL;
  delete process.env.OPTIMISM_RPC_URL;
  delete process.env.SOLANA_RPC_URL;
  delete process.env.RPC_PROVIDER;
  delete process.env.RPC_API_KEY;
  delete process.env.ETHERSCAN_API_KEY;
  delete process.env.ONEINCH_API_KEY;
  delete process.env.SAFE_API_KEY;
  delete process.env.TRON_API_KEY;
  delete process.env.WALLETCONNECT_PROJECT_ID;
  delete process.env.VAULTPILOT_SKILL_MARKER_PATH;
  delete process.env.VAULTPILOT_DEMO;
});

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true });
  delete process.env.VAULTPILOT_CONFIG_DIR;
});

/**
 * Force a fresh module load so each test sees its own env / fs state. The
 * diagnostics module reads `process.env` and the config file at call time
 * rather than at module-eval, so this isn't strictly required, but it's
 * cheap insurance against module-cache surprises.
 */
async function loadFresh() {
  return await import(
    "../src/modules/diagnostics/index.js?ts=" + Date.now()
  );
}

function writeConfig(content: Record<string, unknown>): void {
  const dir = join(tmpHome, ".vaultpilot-mcp");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(content, null, 2), { mode: 0o600 });
  // The reader rejects symlinks/hardlinks; ensure mode is 0o600.
  chmodSync(path, 0o600);
}

describe("get_vaultpilot_config_status — RPC source classification", () => {
  it("reports public-fallback for every chain when nothing is configured", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.ethereum.source).toBe("public-fallback");
    expect(status.rpc.arbitrum.source).toBe("public-fallback");
    expect(status.rpc.polygon.source).toBe("public-fallback");
    expect(status.rpc.base.source).toBe("public-fallback");
    expect(status.rpc.optimism.source).toBe("public-fallback");
    expect(status.rpc.solana.source).toBe("public-fallback");
  });

  it("reports env-var when ETHEREUM_RPC_URL is set", async () => {
    process.env.ETHEREUM_RPC_URL = "https://my-eth-rpc.example.com/SECRET";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.ethereum.source).toBe("env-var");
    // Other chains stay public-fallback.
    expect(status.rpc.arbitrum.source).toBe("public-fallback");
  });

  it("reports provider-key-env when RPC_PROVIDER + RPC_API_KEY are set", async () => {
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = "secret-key-do-not-leak";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.ethereum.source).toBe("provider-key-env");
    expect(status.rpc.arbitrum.source).toBe("provider-key-env");
  });

  it("reports provider-key-config when config has infura+key but no env", async () => {
    writeConfig({ rpc: { provider: "infura", apiKey: "config-key-secret" } });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.ethereum.source).toBe("provider-key-config");
  });

  it("reports custom-url-config when config has a custom URL for that chain", async () => {
    writeConfig({
      rpc: {
        provider: "custom",
        customUrls: { ethereum: "https://node.example.com/" },
      },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.ethereum.source).toBe("custom-url-config");
    // Chains without a custom URL fall back to public.
    expect(status.rpc.arbitrum.source).toBe("public-fallback");
  });

  it("reports env-var for Solana when SOLANA_RPC_URL is set", async () => {
    process.env.SOLANA_RPC_URL = "https://mainnet.helius-rpc.com/?api-key=SECRET";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.solana.source).toBe("env-var");
  });

  it("reports config-url for Solana when only the config field is set", async () => {
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      solanaRpcUrl: "https://mainnet.helius-rpc.com/?api-key=CONFIG-SECRET",
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.rpc.solana.source).toBe("config-url");
  });
});

describe("get_vaultpilot_config_status — API key source classification", () => {
  it("all keys unset when nothing is set", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.apiKeys.etherscan).toEqual({ set: false, source: "unset" });
    expect(status.apiKeys.oneInch).toEqual({ set: false, source: "unset" });
    expect(status.apiKeys.safe).toEqual({ set: false, source: "unset" });
    expect(status.apiKeys.tronGrid).toEqual({ set: false, source: "unset" });
    expect(status.apiKeys.walletConnectProjectId).toEqual({
      set: false,
      source: "unset",
    });
  });

  it("reports safe key from SAFE_API_KEY env var", async () => {
    process.env.SAFE_API_KEY = "safe-env-secret";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.apiKeys.safe).toEqual({ set: true, source: "env-var" });
  });

  it("reports safe key from config file when env var unset", async () => {
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      safeApiKey: "config-safe-secret",
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.apiKeys.safe).toEqual({ set: true, source: "config" });
  });

  it("env-var source wins over config", async () => {
    process.env.ETHERSCAN_API_KEY = "env-secret";
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      etherscanApiKey: "config-secret",
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.apiKeys.etherscan.set).toBe(true);
    expect(status.apiKeys.etherscan.source).toBe("env-var");
  });

  it("falls back to config when env var is unset", async () => {
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      tronApiKey: "config-tron-secret",
      walletConnect: { projectId: "config-wc-secret" },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.apiKeys.tronGrid).toEqual({ set: true, source: "config" });
    expect(status.apiKeys.walletConnectProjectId).toEqual({
      set: true,
      source: "config",
    });
  });
});

describe("get_vaultpilot_config_status — pairings + WC topic suffix", () => {
  it("returns zero counts + no topic suffix when nothing is paired", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.pairings.solana.count).toBe(0);
    expect(status.pairings.tron.count).toBe(0);
    expect(status.pairings.walletConnect).toEqual({});
  });

  it("returns pairings count from the persisted config", async () => {
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      pairings: {
        solana: [
          {
            address: "wallet1",
            path: "44'/501'/0'",
            accountIndex: 0,
            appVersion: "1",
          },
          {
            address: "wallet2",
            path: "44'/501'/1'",
            accountIndex: 1,
            appVersion: "1",
          },
        ],
        tron: [
          { address: "T1", path: "44'/195'/0'", accountIndex: 0, appVersion: "1" },
        ],
      },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.pairings.solana.count).toBe(2);
    expect(status.pairings.tron.count).toBe(1);
  });

  it("surfaces only the LAST 8 chars of the WC session topic, never the full value", async () => {
    const fullTopic =
      "abcdef0123456789abcdef0123456789abcdef0123456789a1b2c3d4";
    writeConfig({
      rpc: { provider: "infura", apiKey: "k" },
      walletConnect: { projectId: "wc-secret", sessionTopic: fullTopic },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.pairings.walletConnect.sessionTopicSuffix).toBe("a1b2c3d4");
    // Sweep the entire output for the full topic — must not appear anywhere.
    expect(JSON.stringify(status)).not.toContain(fullTopic.slice(0, 16));
  });
});

describe("get_vaultpilot_config_status — preflight skill detection", () => {
  it("reports installed:false when the marker file doesn't exist", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.preflightSkill.installed).toBe(false);
    expect(status.preflightSkill.expectedPath).toContain("vaultpilot-preflight");
  });

  it("respects VAULTPILOT_SKILL_MARKER_PATH override", async () => {
    const marker = join(tmpHome, "fake-skill-marker");
    writeFileSync(marker, "x");
    process.env.VAULTPILOT_SKILL_MARKER_PATH = marker;
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.preflightSkill.expectedPath).toBe(marker);
    expect(status.preflightSkill.installed).toBe(true);
  });
});

describe("get_vaultpilot_config_status — strict no-secrets contract", () => {
  it("never echoes any planted secret value anywhere in the output", async () => {
    const SECRETS = {
      etherscan: "ETHSCAN-PLANT-SECRET-DO-NOT-LEAK",
      oneInch: "ONEINCH-PLANT-SECRET-DO-NOT-LEAK",
      safe: "SAFE-PLANT-SECRET-DO-NOT-LEAK",
      tron: "TRON-PLANT-SECRET-DO-NOT-LEAK",
      wcProject: "WC-PLANT-SECRET-DO-NOT-LEAK",
      ethRpc: "https://mainnet.example.com/PLANT-RPC-SECRET",
      providerKey: "ALCHEMY-PLANT-PROVIDER-KEY-SECRET",
      solanaRpc: "https://helius.example.com/?api-key=PLANT-SOLANA-SECRET",
      wcTopic: "topic_with_secret_session_keying_material_do_not_leak",
    } as const;
    process.env.ETHERSCAN_API_KEY = SECRETS.etherscan;
    process.env.ONEINCH_API_KEY = SECRETS.oneInch;
    process.env.SAFE_API_KEY = SECRETS.safe;
    process.env.TRON_API_KEY = SECRETS.tron;
    process.env.WALLETCONNECT_PROJECT_ID = SECRETS.wcProject;
    process.env.ETHEREUM_RPC_URL = SECRETS.ethRpc;
    process.env.RPC_PROVIDER = "alchemy";
    process.env.RPC_API_KEY = SECRETS.providerKey;
    process.env.SOLANA_RPC_URL = SECRETS.solanaRpc;
    writeConfig({
      rpc: { provider: "infura", apiKey: "irrelevant-env-overrides" },
      walletConnect: {
        projectId: "config-irrelevant-env-overrides",
        sessionTopic: SECRETS.wcTopic,
      },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    const serialized = JSON.stringify(status);
    for (const planted of Object.values(SECRETS)) {
      expect(serialized).not.toContain(planted);
    }
    // But the source classifications are still correct.
    expect(status.apiKeys.etherscan.source).toBe("env-var");
    expect(status.rpc.solana.source).toBe("env-var");
  });
});

describe("get_vaultpilot_config_status — demo-mode discoverability (issue #371)", () => {
  it("reports demoMode.active=false and the activation recipe when VAULTPILOT_DEMO is unset", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.demoMode.active).toBe(false);
    expect(status.demoMode.envVar).toBe("VAULTPILOT_DEMO");
    // The recipe must include the env-var name + the canonical `claude mcp add` form
    // so an agent can relay it verbatim without paraphrasing the activation steps.
    expect(status.demoMode.howToEnable).toContain("VAULTPILOT_DEMO=true");
    expect(status.demoMode.howToEnable).toContain("claude mcp add");
    expect(status.demoMode.howToEnable).toContain("restart");
  });

  it("reports demoMode.active=true with an exit recipe when VAULTPILOT_DEMO=true", async () => {
    process.env.VAULTPILOT_DEMO = "true";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.demoMode.active).toBe(true);
    expect(status.demoMode.envVar).toBe("VAULTPILOT_DEMO");
    expect(status.demoMode.howToEnable).toContain("active");
    // #613 — exit recipe must point at the MCP-CLIENT restart, not just the
    // server, since restarting the server alone preserves the env var the
    // client re-launches it with.
    expect(status.demoMode.howToEnable).toContain("MCP-client config");
    expect(status.demoMode.howToEnable).toContain("restart the client");
  });

  it("does NOT treat truthy-ish values like '1' or 'TRUE' as enabled — strict 'true' only", async () => {
    process.env.VAULTPILOT_DEMO = "1";
    let { getVaultPilotConfigStatus } = await loadFresh();
    expect(getVaultPilotConfigStatus().demoMode.active).toBe(false);

    process.env.VAULTPILOT_DEMO = "TRUE";
    ({ getVaultPilotConfigStatus } = await loadFresh());
    expect(getVaultPilotConfigStatus().demoMode.active).toBe(false);
  });

  it("surfaces demoMode.liveMode sub-object reflecting set_demo_wallet state (PR 4)", async () => {
    process.env.VAULTPILOT_DEMO = "true";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const { _resetLiveWalletForTests, setLivePersona } = await import(
      "../src/demo/live-mode.js"
    );
    _resetLiveWalletForTests();
    // Default sub-mode: liveMode.active=false, no persona, no addresses.
    let status = getVaultPilotConfigStatus();
    expect(status.demoMode.liveMode.active).toBe(false);
    expect(status.demoMode.liveMode.personaId).toBeNull();
    expect(status.demoMode.liveMode.addresses).toBeNull();

    // After set_demo_wallet({persona}), liveMode reflects it.
    setLivePersona("defi-degen");
    status = getVaultPilotConfigStatus();
    expect(status.demoMode.liveMode.active).toBe(true);
    expect(status.demoMode.liveMode.personaId).toBe("defi-degen");
    expect(status.demoMode.liveMode.addresses).not.toBeNull();
    expect(status.demoMode.liveMode.addresses!.evm.length).toBeGreaterThan(0);
    _resetLiveWalletForTests();
  });
});

describe("get_vaultpilot_config_status — first-run demo-mode hint (issue #371 Option 3)", () => {
  it("emits a demo-mode setupHint when nothing is configured (no keys, no pairings, no custom RPC, demo off)", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    const demoHint = status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode");
    expect(demoHint).toBeDefined();
    expect(demoHint.source).toBe("demo-mode-suggestion");
    // The recommendation carries the activation recipe inline since
    // demo hints don't use the rate-limit `setupCommand` field.
    expect(demoHint.recommendation).toContain("VAULTPILOT_DEMO=true");
    expect(demoHint.recommendation).toContain("claude mcp add");
    expect(demoHint.recommendation).toContain("restart");
    // Demo hints should NOT carry rate-limit-specific fields.
    expect(demoHint.hits).toBeUndefined();
    expect(demoHint.providers).toBeUndefined();
    expect(demoHint.setupCommand).toBeUndefined();
  });

  it("does NOT emit the demo-mode hint when VAULTPILOT_DEMO is already active", async () => {
    process.env.VAULTPILOT_DEMO = "true";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    const demoHint = status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode");
    expect(demoHint).toBeUndefined();
  });

  it("self-clears when the user adds an Etherscan API key", async () => {
    process.env.ETHERSCAN_API_KEY = "k";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode")).toBeUndefined();
  });

  it("self-clears when the user adds a Safe API key", async () => {
    process.env.SAFE_API_KEY = "k";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode")).toBeUndefined();
  });

  it("self-clears when the user has a Solana pairing", async () => {
    writeConfig({
      rpc: { provider: "infura", apiKey: "irrelevant-but-flips-rpc-source" },
      pairings: {
        solana: [
          {
            address: "wallet1",
            path: "44'/501'/0'",
            accountIndex: 0,
            appVersion: "1",
          },
        ],
      },
    });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode")).toBeUndefined();
  });

  it("self-clears when any chain has a custom RPC URL", async () => {
    process.env.ETHEREUM_RPC_URL = "https://my-eth.example.com/";
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.setupHints.find((h: { kind: string }) => h.kind === "demo-mode")).toBeUndefined();
  });
});

describe("get_vaultpilot_config_status — basic shape", () => {
  it("includes serverVersion + configPath + configFileExists", async () => {
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.configPath).toContain(".vaultpilot-mcp");
    expect(status.configFileExists).toBe(false);
    expect(typeof status.serverVersion).toBe("string");
    expect(status.serverVersion.length).toBeGreaterThan(0);
  });

  it("flips configFileExists when the file is written", async () => {
    writeConfig({ rpc: { provider: "infura", apiKey: "k" } });
    const { getVaultPilotConfigStatus } = await loadFresh();
    const status = getVaultPilotConfigStatus();
    expect(status.configFileExists).toBe(true);
  });
});

/**
 * Issue #733 — scope-friction observability. Scoped-out tools are never
 * registered, so no per-call refusal exists to report; this block is the
 * in-band friction signal: what is on, what is scoped out, how to widen it.
 *
 * `vi.resetModules()` before the import is load-bearing — `src/config/scope.ts`
 * reads its env vars once at module eval, and the query-string `loadFresh()`
 * used elsewhere in this file re-instantiates only the diagnostics module.
 */
describe("get_vaultpilot_config_status — tool scope block (#733)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  async function loadWithScope(families: string, protocols: string) {
    vi.resetModules();
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", families);
    vi.stubEnv("VAULTPILOT_PROTOCOLS", protocols);
    return await import("../src/modules/diagnostics/index.js");
  }

  it("reports the curated-CORE default + a one-line enable hint", async () => {
    const { getVaultPilotConfigStatus } = await loadWithScope("", "");
    const status = getVaultPilotConfigStatus();
    expect(status.scope.families).toEqual(["evm"]);
    expect(status.scope.protocols).toEqual([]);
    expect(status.scope.scopedOutFamilies).toEqual(["btc", "ltc", "solana", "tron"]);
    expect(status.scope.scopedOutProtocols.length).toBe(13);
    expect(status.scope.scopedOutProtocols).toContain("marginfi");
    expect(status.scope.enableHint).toContain("VAULTPILOT_CHAIN_FAMILIES=");
    expect(status.scope.enableHint).toContain("VAULTPILOT_PROTOCOLS=");
    expect(status.scope.enableHint).toContain("restart the client");
    expect(status.scope.enableHint).not.toContain("\n");
  });

  it("reports nothing scoped out under the explicit all/all config", async () => {
    const { getVaultPilotConfigStatus } = await loadWithScope("all", "all");
    const status = getVaultPilotConfigStatus();
    expect(status.scope.protocols).toBeNull(); // accept-all sentinel passthrough
    expect(status.scope.scopedOutFamilies).toEqual([]);
    expect(status.scope.scopedOutProtocols).toEqual([]);
    expect(status.scope.enableHint).toContain("Nothing is scoped out");
  });
});
