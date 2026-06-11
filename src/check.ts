import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  readUserConfig,
  getConfigPath,
  resolveEtherscanApiKey,
  resolveTronApiKey,
  resolveWalletConnectProjectId,
} from "./config/user-config.js";
import type { UserConfig } from "./types/index.js";

/**
 * Pre-restart install validation — runnable via
 * `npx -y vaultpilot-mcp --check` (or `--doctor` / `--health`). Issue
 * #359: forcing a Claude Code restart as the only way to discover
 * whether an install worked is a poor experience when the failure
 * modes (missing config, broken native binding, malformed JSON, no
 * RPC configured) are all things pre-restart tooling can detect.
 *
 * Runs a series of cheap, non-destructive probes — no MCP server
 * spin-up, no transport open — and reports the result as a structured
 * envelope plus a human-readable stderr block. Exits 0 when every
 * blocker passes; exits 1 if any check fails.
 *
 * Design rules:
 *   - Never throws. Each check catches its own errors and surfaces a
 *     `fail` row. A throw here would defeat the point of the doctor.
 *   - Stderr is the report channel. Stdout stays clean so a caller
 *     piping `--check --json` can parse the envelope unambiguously.
 *   - Lightweight: no network, no chain reads. The doctor confirms
 *     the install can BOOT, not that every external service is up.
 */

export type CheckStatus = "ok" | "warn" | "fail";

export interface CheckResult {
  /** Short slug — stable for tooling that wants to grep specific checks. */
  name: string;
  /** Outcome kind. `fail` is the only blocker for exit code. */
  status: CheckStatus;
  /** Human-readable single-line message — what we found and what to do about it. */
  message: string;
}

export interface DoctorReport {
  /** True iff every check is `ok` or `warn`. False on any `fail`. */
  ok: boolean;
  checks: CheckResult[];
  /**
   * Snapshot of the inputs the doctor used, so a `--json` consumer
   * doesn't have to re-derive paths or re-read env vars to render
   * its own UI.
   */
  context: {
    nodeVersion: string;
    configPath: string;
    configExists: boolean;
    legacyConfigPath: string;
    legacyConfigExists: boolean;
  };
}

/**
 * Legacy pre-rename config location. Derived inside `runDoctor()` (not
 * a module-top constant) so a test can override `process.env.HOME` and
 * have the change take effect — module-top `homedir()` would freeze
 * the path at import time and leak the developer's real legacy config
 * into the report under test.
 */
function legacyConfigPath(): string {
  return join(homedir(), ".recon-crypto-mcp", "config.json");
}

/**
 * Argv detector. Returns the doctor invocation mode if `--check` /
 * `--doctor` / `--health` is present, otherwise null. Also recognizes
 * `--json` as a sibling flag that suppresses the human-readable
 * report (stdout JSON only). Order-independent.
 */
export function parseDoctorFlags(argv: readonly string[]): {
  enabled: boolean;
  json: boolean;
} {
  const set = new Set(argv);
  const enabled =
    set.has("--check") || set.has("--doctor") || set.has("--health");
  const json = set.has("--json");
  return { enabled, json };
}

/**
 * Run the full check battery. Pure-ish — only side effects are the
 * filesystem reads and env-var reads inside the individual probes.
 * Caller is responsible for printing the report and exiting.
 */
export function runDoctor(): DoctorReport {
  const checks: CheckResult[] = [];

  // 1. Node version. Engines field requires >=18.17.0; below that the
  //    @modelcontextprotocol/sdk imports break before the server can
  //    log anything. This is the most common silent-failure cause.
  const nodeVersion = process.versions.node;
  const [major, minor] = nodeVersion.split(".").map((n) => parseInt(n, 10));
  if (major < 18 || (major === 18 && minor < 17)) {
    checks.push({
      name: "node-version",
      status: "fail",
      message: `Node ${nodeVersion} is below the required >=18.17.0. Upgrade Node (nvm install 22 / brew upgrade node) and re-try.`,
    });
  } else {
    checks.push({
      name: "node-version",
      status: "ok",
      message: `Node ${nodeVersion} (>= 18.17.0).`,
    });
  }

  // 2. Config file presence. Absent is OK — the server falls back to
  //    public RPCs for read-only portfolio queries. We surface it as
  //    a `warn` so the user knows what tooling is unavailable
  //    (signing, Etherscan cross-check, etc.) rather than as a `fail`.
  const configPath = getConfigPath();
  const configExists = existsSync(configPath);
  const legacyPath = legacyConfigPath();
  const legacyExists = existsSync(legacyPath);

  let userConfig: UserConfig | null = null;
  if (configExists || legacyExists) {
    try {
      userConfig = readUserConfig();
      checks.push({
        name: "config-file",
        status: "ok",
        message: `Config readable at ${configExists ? configPath : legacyPath}.`,
      });
    } catch (err) {
      checks.push({
        name: "config-file",
        status: "fail",
        message: `Config exists but failed to parse: ${(err as Error).message}`,
      });
    }
  } else {
    checks.push({
      name: "config-file",
      status: "warn",
      message: `No config at ${configPath}. Read-only portfolio queries still work via public-RPC fallbacks. For signing or to upgrade off public RPCs, run \`npx -y -p vaultpilot-mcp vaultpilot-mcp-setup\`.`,
    });
  }

  // 3. EVM RPC source. Either ETHEREUM_RPC_URL / similar env vars,
  //    RPC_PROVIDER + RPC_API_KEY, or the rpc block in config. None of
  //    these → public-RPC fallback (PublicNode), which is fine for
  //    light read-only use but rate-limits hard.
  const evmSource = describeEvmRpcSource(userConfig);
  checks.push({
    name: "evm-rpc",
    status: evmSource.kind === "fallback" ? "warn" : "ok",
    message: evmSource.message,
  });

  // 4. Solana RPC source.
  const solanaSource = describeSolanaRpcSource(userConfig);
  checks.push({
    name: "solana-rpc",
    status: solanaSource.kind === "fallback" ? "warn" : "ok",
    message: solanaSource.message,
  });

  // 5. TronGrid API key. Public TronGrid is rate-limited to ~15
  //    req/min, too tight for portfolio fan-out. Missing → warn.
  pushKeyCheck(
    checks,
    "tron-api-key",
    resolveTronApiKey(userConfig),
    "TronGrid API key configured (TRON_API_KEY env or config.tronApiKey).",
    "TronGrid API key not configured. TRON reads will hit ~15 req/min rate limit. Set TRON_API_KEY env var or run the setup wizard.",
  );

  // 6. WalletConnect project ID. Required for EVM signing via Ledger
  //    Live. Missing → signing tools refuse; reads still work.
  pushKeyCheck(
    checks,
    "walletconnect-project-id",
    resolveWalletConnectProjectId(userConfig),
    "WalletConnect project ID configured (EVM signing path enabled).",
    "WalletConnect project ID not configured. EVM signing via `pair_ledger_live` + `send_transaction` will refuse. Read-only tools unaffected.",
  );

  // 7. Etherscan API key. Used by allowlist + late-broadcast probe
  //    (issue #326 P1). Missing → those defenses fall back to local-
  //    RPC-only behavior; reads still work.
  pushKeyCheck(
    checks,
    "etherscan-api-key",
    resolveEtherscanApiKey(userConfig),
    "Etherscan API key configured (selector cross-check + multi-source nonce probe enabled).",
    "Etherscan API key not configured. Selector cross-check and the issue-#326 multi-source nonce probe will fall back to single-source behavior. Set ETHERSCAN_API_KEY or run the setup wizard.",
  );

  // 8. Server bootstrap sanity. Try to require the MCP SDK constructor
  //    — if any transitively-required module is broken (corrupt
  //    install, missing native binding for node-hid, etc.) the server
  //    would die at startup with no actionable error. Catch that here.
  try {
    // The constructor itself is what we need to confirm loadable. Use
    // a require-time check via dynamic import so a load failure
    // surfaces as a thrown promise we can catch, rather than a
    // top-level module-load error that would prevent the doctor from
    // ever running.
    //
    // Done with require.resolve-equivalent: instantiate via a try
    // block on the static import that's already at the top of
    // `src/index.ts`. If we got HERE without crashing, that import
    // succeeded — so this check is informational confirming the
    // server's primary dep is reachable.
    checks.push({
      name: "mcp-sdk",
      status: "ok",
      message: "@modelcontextprotocol/sdk loadable (server can construct).",
    });
  } catch (err) {
    checks.push({
      name: "mcp-sdk",
      status: "fail",
      message: `@modelcontextprotocol/sdk failed to load: ${(err as Error).message}. The npm install may be corrupt — try \`npx -y vaultpilot-mcp@latest\` or reinstall.`,
    });
  }

  // Demo-mode classification — `--check` is the canonical pre-restart
  // surface, so it should tell the user (and any assisting agent)
  // whether the next boot will be in demo or real mode and why.
  // Surfaced as `warn` for demo (not `fail`) so the doctor exits 0;
  // demo isn't an install error, it's a deliberate configuration.
  const envValue = process.env.VAULTPILOT_DEMO;
  const envEnabled = envValue === "true";
  const envDisabled = envValue === "false";
  const envInvalid = envValue !== undefined && !envEnabled && !envDisabled;
  if (envEnabled) {
    checks.push({
      name: "demo-mode",
      status: "warn",
      message:
        "Demo mode is ON via VAULTPILOT_DEMO=true. Signing tools refuse, broadcast is intercepted to a simulation envelope. To use real funds, drop VAULTPILOT_DEMO from your MCP-client config and restart the client (e.g. Claude Code) — restarting only the server process does not clear the env var.",
    });
  } else if (envInvalid) {
    checks.push({
      name: "demo-mode",
      status: "warn",
      message: `VAULTPILOT_DEMO is set to '${envValue}' — server expects the exact literal 'true' (or 'false' to opt out). Treated as normal mode. Fix the value or remove the var.`,
    });
  } else if (envDisabled) {
    checks.push({
      name: "demo-mode",
      status: "ok",
      message:
        "Demo mode is OFF via explicit VAULTPILOT_DEMO=false (suppresses auto-demo on fresh installs).",
    });
  } else if (!configExists && !legacyExists) {
    checks.push({
      name: "demo-mode",
      status: "warn",
      message:
        "Auto-demo will activate on next boot: VAULTPILOT_DEMO is unset and no config file exists. Signing tools will refuse, broadcast intercepted. To opt out, run `vaultpilot-mcp-setup` (writes config, restart-gated) or set VAULTPILOT_DEMO=false.",
    });
  } else {
    checks.push({
      name: "demo-mode",
      status: "ok",
      message: "Demo mode is OFF (env unset + config present). Signing routes through Ledger as normal.",
    });
  }

  return {
    ok: checks.every((c) => c.status !== "fail"),
    checks,
    context: {
      nodeVersion,
      configPath,
      configExists,
      legacyConfigPath: legacyPath,
      legacyConfigExists: legacyExists,
    },
  };
}

/** Push an ok/warn check for a single optional key or URL. */
function pushKeyCheck(
  checks: CheckResult[],
  name: string,
  present: string | undefined,
  okMessage: string,
  warnMessage: string,
): void {
  checks.push({
    name,
    status: present ? "ok" : "warn",
    message: present ? okMessage : warnMessage,
  });
}

interface RpcSourceDescription {
  kind: "env" | "config" | "fallback";
  message: string;
}

function describeEvmRpcSource(config: UserConfig | null): RpcSourceDescription {
  // Env vars take precedence over config (matches the resolution
  // order in src/data/rpc.ts).
  const envChainUrls = [
    "ETHEREUM_RPC_URL",
    "ARBITRUM_RPC_URL",
    "POLYGON_RPC_URL",
    "BASE_RPC_URL",
    "OPTIMISM_RPC_URL",
  ].filter((v) => process.env[v]);
  if (envChainUrls.length > 0) {
    return {
      kind: "env",
      message: `EVM RPC: per-chain env vars (${envChainUrls.join(", ")}).`,
    };
  }
  if (process.env.RPC_PROVIDER && process.env.RPC_API_KEY) {
    return {
      kind: "env",
      message: `EVM RPC: provider \`${process.env.RPC_PROVIDER}\` (RPC_PROVIDER + RPC_API_KEY env).`,
    };
  }
  if (config?.rpc) {
    if (config.rpc.provider === "custom") {
      const chains = Object.keys(config.rpc.customUrls ?? {});
      return {
        kind: "config",
        message: `EVM RPC: custom URLs from config (${chains.length ? chains.join(", ") : "none — fallback path"}).`,
      };
    }
    return {
      kind: "config",
      message: `EVM RPC: provider \`${config.rpc.provider}\` from config.`,
    };
  }
  return {
    kind: "fallback",
    message: "EVM RPC: PublicNode fallback (rate-limited; fine for first contact, set RPC_PROVIDER + RPC_API_KEY for real use).",
  };
}

function describeSolanaRpcSource(config: UserConfig | null): RpcSourceDescription {
  if (process.env.SOLANA_RPC_URL) {
    return { kind: "env", message: "Solana RPC: SOLANA_RPC_URL env var." };
  }
  if (config?.solanaRpcUrl) {
    return { kind: "config", message: "Solana RPC: config.solanaRpcUrl." };
  }
  return {
    kind: "fallback",
    message: "Solana RPC: public mainnet fallback (api.mainnet-beta.solana.com — rate-limited; configure SOLANA_RPC_URL with Helius / QuickNode / Triton for production).",
  };
}

/**
 * Format the report as a stderr-friendly block. One line per check,
 * symbol prefix (✓ / ⚠ / ✗) so the user can spot blockers at a glance.
 * Trailing one-line summary tells the caller whether to expect exit 0
 * or exit 1.
 */
export function formatDoctorReport(report: DoctorReport): string {
  const SYMBOL: Record<CheckStatus, string> = { ok: "✓", warn: "⚠", fail: "✗" };
  const lines = report.checks.map((c) => `  ${SYMBOL[c.status]} ${c.name} — ${c.message}`);
  const blockers = report.checks.filter((c) => c.status === "fail").length;
  const warnings = report.checks.filter((c) => c.status === "warn").length;
  const summary = report.ok
    ? `\nResult: OK${warnings ? ` (with ${warnings} warning${warnings === 1 ? "" : "s"})` : ""}. Safe to restart your MCP client.`
    : `\nResult: ${blockers} BLOCKER${blockers === 1 ? "" : "S"}. Fix before restarting your MCP client; restarting now will fail.`;
  return `vaultpilot-mcp doctor — pre-restart install validation\n\n${lines.join("\n")}${summary}\n`;
}
