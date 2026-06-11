/**
 * Detect installed agent clients (Claude Desktop, Claude Code, Cursor) and
 * patch their MCP configs to add a `vaultpilot-mcp` entry. Eliminates the
 * single biggest non-dev failure mode in `claude-work/HIGH-plan-broad-
 * audience-onboarding.md` — manual JSON-config editing — for the audience
 * we're trying to reach.
 *
 * Each patch is:
 *   - Additive (merge into existing `mcpServers` block; don't touch other keys).
 *   - Idempotent (re-running detects the existing entry and leaves it alone).
 *   - Atomic (write tmp + rename so a crashed wizard never leaves a half-
 *     written config).
 *   - Reversible (backup to `<file>.vaultpilot.bak` before overwrite).
 *
 * Per-project Claude Code (`<project>/.claude/settings.json`) and per-
 * workspace Cursor (`<workspace>/.cursor/mcp.json`) are deliberately NOT
 * touched — the wizard runs from an arbitrary CWD and patching the wrong
 * project's config is worse than leaving it alone. Only user-level configs.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type PatchStatus = "added" | "already-present" | "not-detected" | "error";

export interface ClientPatchResult {
  client: string;
  configPath: string;
  status: PatchStatus;
  /** Populated for `added` (path to backup) and `error` (message). */
  detail?: string;
}

/**
 * Build the MCP server entry to inject. Resolves the absolute path to
 * `dist/index.js` from this file's own location — works whether the user
 * `npm i -g`'d (this file lives in the global node_modules tree) or
 * cloned from source (this file is in the repo's `dist/setup/`). Using an
 * absolute `node` invocation rather than the `vaultpilot-mcp` bin is
 * deliberate: it doesn't depend on PATH and won't break if the user
 * uninstalls / reinstalls under a different prefix.
 */
function buildServerEntry(): { command: string; args: string[] } {
  // import.meta.url → file URL of this module → absolute path → dirname
  // (= dist/setup) → "../index.js" (= dist/index.js).
  const here = fileURLToPath(import.meta.url);
  const serverPath = resolve(dirname(here), "..", "index.js");
  return { command: "node", args: [serverPath] };
}

/**
 * Per-client config file paths. Returned in detection order — earlier
 * entries are surfaced first in the user-facing summary, so list the
 * common-case clients first.
 */
export function getClientConfigPaths(): { client: string; configPath: string }[] {
  const home = homedir();
  const plat = platform();
  const targets: { client: string; configPath: string }[] = [];

  if (plat === "darwin") {
    targets.push({
      client: "Claude Desktop",
      configPath: join(
        home,
        "Library",
        "Application Support",
        "Claude",
        "claude_desktop_config.json",
      ),
    });
  } else if (plat === "win32") {
    const appData = process.env.APPDATA;
    if (appData) {
      targets.push({
        client: "Claude Desktop",
        configPath: join(appData, "Claude", "claude_desktop_config.json"),
      });
    }
  } else {
    targets.push({
      client: "Claude Desktop",
      configPath: join(home, ".config", "Claude", "claude_desktop_config.json"),
    });
  }

  // Claude Code keeps its user-level config at ~/.claude.json. Per-project
  // configs live at <project>/.claude/settings.json — see module doc-comment
  // for why we skip those.
  targets.push({ client: "Claude Code", configPath: join(home, ".claude.json") });

  // Cursor user-level MCP registry. Per-workspace alt is <workspace>/.cursor/
  // mcp.json — also skipped for the same reason.
  targets.push({ client: "Cursor", configPath: join(home, ".cursor", "mcp.json") });

  return targets;
}

/** Detect whether a client is even installed by checking for either the
 * config file or its parent dir. Either signal is sufficient — Claude
 * Desktop creates the parent dir on install whether or not the user has
 * configured any MCP servers yet. */
export function detectClient(configPath: string): "configured" | "installed" | "absent" {
  if (existsSync(configPath)) return "configured";
  if (existsSync(dirname(configPath))) return "installed";
  return "absent";
}

/** Read + parse the existing config, or return an empty object if missing.
 * Throws on parse failure — the caller decides whether to abort or skip
 * this particular client. */
function readExistingConfig(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {};
  const raw = readFileSync(configPath, "utf8");
  if (raw.trim() === "") return {};
  return JSON.parse(raw) as Record<string, unknown>;
}

/** Atomic write — tmp + rename — preserving 0o600 mode (configs may carry
 * API keys). On Windows, rename across same-volume overwrite is atomic;
 * on POSIX it's atomic by definition. */
function atomicWriteJson(configPath: string, value: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const tmp = `${configPath}.vaultpilot.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, configPath);
}

interface PatchOptions {
  /** Override for tests — substitute the server entry. */
  serverEntry?: { command: string; args?: string[] };
}

/** Patch a single client config. Pure function — no console output, no
 * prompts. Returns a structured result the caller can summarise. */
export function patchClientConfig(
  client: string,
  configPath: string,
  opts: PatchOptions = {},
): ClientPatchResult {
  const state = detectClient(configPath);
  if (state === "absent") {
    return { client, configPath, status: "not-detected" };
  }

  let existing: Record<string, unknown>;
  try {
    existing = readExistingConfig(configPath);
  } catch (e) {
    return {
      client,
      configPath,
      status: "error",
      detail: `Existing config is malformed JSON; left untouched. Error: ${
        (e as Error).message
      }`,
    };
  }

  const mcpServers =
    (existing.mcpServers as Record<string, unknown> | undefined) ?? {};
  if ("vaultpilot-mcp" in mcpServers) {
    return {
      client,
      configPath,
      status: "already-present",
    };
  }

  const serverEntry = opts.serverEntry ?? buildServerEntry();
  const next = {
    ...existing,
    mcpServers: { ...mcpServers, "vaultpilot-mcp": serverEntry },
  };

  // Backup before write — only if there's something to back up.
  let backupPath: string | undefined;
  if (state === "configured") {
    backupPath = `${configPath}.vaultpilot.bak`;
    try {
      copyFileSync(configPath, backupPath);
    } catch (e) {
      return {
        client,
        configPath,
        status: "error",
        detail: `Could not write backup file ${backupPath}: ${
          (e as Error).message
        }. Refusing to overwrite original.`,
      };
    }
  }

  try {
    atomicWriteJson(configPath, next);
  } catch (e) {
    return {
      client,
      configPath,
      status: "error",
      detail: `Atomic write failed: ${(e as Error).message}`,
    };
  }

  return {
    client,
    configPath,
    status: "added",
    detail: backupPath ? `Backup at ${backupPath}` : "(no backup; file did not exist before)",
  };
}

/** Patch every detected client. Errors on one client don't stop the others. */
export function registerVaultPilotWithClients(
  opts: PatchOptions = {},
): ClientPatchResult[] {
  const targets = getClientConfigPaths();
  return targets.map(({ client, configPath }) =>
    patchClientConfig(client, configPath, opts),
  );
}

/** Format the per-client results into a multi-line summary suitable for the
 * setup wizard's terminal output. */
export function summarizePatchResults(results: ClientPatchResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    let tag: string;
    if (r.status === "added") {
      tag = "✓ Added";
    } else if (r.status === "already-present") {
      tag = "✓ Already configured";
    } else if (r.status === "not-detected") {
      tag = "·  Not detected";
    } else {
      tag = "✗ Error";
    }
    lines.push(`  ${tag}: ${r.client}`);
    if (r.status === "added" || r.status === "error") {
      lines.push(`      ${r.configPath}`);
      if (r.detail) lines.push(`      ${r.detail}`);
    }
  }
  return lines.join("\n");
}
