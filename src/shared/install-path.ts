/**
 * Heuristic detection of how this `vaultpilot-mcp` process was installed,
 * so the update-available notice and the `get_update_command` tool can
 * surface the right upgrade command for the running install path —
 * not just the npm-global default.
 *
 * Returns one of five kinds based on `process.argv[0]` (the binary or
 * `node`), `process.argv[1]` (the script under node), `process.execPath`,
 * and the npm user-agent env var. Each kind ships a recommended
 * upgrade command + restart hint.
 *
 * Heuristics, not gospel: agent should still surface the answer to the
 * user rather than execute the upgrade autonomously. The `kind` field
 * lets the agent distinguish "I confidently know the path" (`npm-global`,
 * `bundled-binary`, etc.) from `unknown` (defer to INSTALL.md).
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export type InstallKind =
  | "npm-global"
  | "npx"
  | "bundled-binary"
  | "from-source"
  | "unknown";

export interface InstallPathInfo {
  kind: InstallKind;
  /**
   * Path the heuristic latched onto. Returned for diagnostic use only —
   * not surfaced in the user-facing notice.
   */
  detectedFrom: string;
  /** Recommended upgrade command, ready to render verbatim. */
  recommendedCommand: string;
  /**
   * Multi-line install block formatted for the VAULTPILOT NOTICE — Update
   * available block. Indented to line up under the `Install:` label.
   */
  noticeInstallBlock: string;
  /** Short restart hint shown alongside the command. */
  restartHint: string;
}

let cached: InstallPathInfo | null = null;

export function getInstallPath(): InstallPathInfo {
  if (cached !== null) return cached;
  cached = detect();
  return cached;
}

/** For tests — clears the memoized detection so test fixtures can swap argv. */
export function _resetInstallPathCacheForTests(): void {
  cached = null;
}

function detect(): InstallPathInfo {
  const argv0 = process.argv[0] ?? "";
  const argv1 = process.argv[1] ?? "";
  const execPath = process.execPath ?? "";
  const ua = process.env.npm_config_user_agent ?? "";

  const argv0Base = baseName(argv0);
  const argv1Norm = argv1.replace(/\\/g, "/");
  const isNodeArgv0 = /^node(\.exe)?$/i.test(argv0Base);

  // Bundled binary: argv[0] is the SEA binary itself, not `node`. The
  // binary name carries `vaultpilot-mcp` (per INSTALL.md Path A naming).
  if (!isNodeArgv0 && /vaultpilot-mcp/i.test(argv0Base)) {
    return {
      kind: "bundled-binary",
      detectedFrom: argv0,
      recommendedCommand:
        "curl -fsSL https://github.com/szhygulin/vaultpilot-mcp/releases/latest/download/install.sh | bash",
      noticeInstallBlock: [
        "         (bundled-binary install detected)",
        "         curl -fsSL https://github.com/szhygulin/vaultpilot-mcp/releases/",
        "           latest/download/install.sh | bash",
        "         Windows PowerShell: iwr <same path>/install.ps1 -UseBasicParsing | iex.",
        "         Or download the new binaries from the GitHub releases page.",
        "         Restart Claude Code after the new binary is in place.",
      ].join("\n"),
      restartHint: "Restart Claude Code after the new binary is in place.",
    };
  }

  // npx: argv[1] resolves under an npx cache dir, or the npm user-agent
  // explicitly says npx.
  if (
    /\/_npx\//.test(argv1Norm) ||
    /\/\.npm\/_npx\//.test(argv1Norm) ||
    /\bnpx\b/i.test(ua)
  ) {
    return {
      kind: "npx",
      detectedFrom: argv1 || ua,
      recommendedCommand:
        "npx --prefer-online -y vaultpilot-mcp@latest  # or just restart Claude Code",
      noticeInstallBlock: [
        "         (npx-launched install detected)",
        "         Restart Claude Code — `npx -y vaultpilot-mcp@latest` will fetch",
        "         the new version on the next launch (npm registry cache may delay",
        "         this up to ~10 minutes; pass --prefer-online for immediate refresh).",
      ].join("\n"),
      restartHint: "Restart Claude Code; npx pulls the new version on next launch.",
    };
  }

  // From source: argv[1] sits inside a checked-out git tree. Walk up at
  // most 6 levels looking for `.git/`. Distinct from npm-global because
  // npm never installs into a directory with a `.git/` ancestor.
  if (argv1) {
    let dir = dirname(argv1);
    for (let i = 0; i < 6 && dir.length > 1; i++) {
      if (existsSync(join(dir, ".git"))) {
        return {
          kind: "from-source",
          detectedFrom: argv1,
          recommendedCommand: `git -C ${dir} pull && npm install --legacy-peer-deps && npm run build`,
          noticeInstallBlock: [
            "         (from-source install detected)",
            `         git -C ${dir} pull \\`,
            "           && npm install --legacy-peer-deps \\",
            "           && npm run build",
            "         Restart Claude Code after the rebuild completes.",
          ].join("\n"),
          restartHint: "Restart Claude Code after the rebuild completes.",
        };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }

  // npm-global: argv[1] sits under a known global node_modules path. Check
  // AFTER the from-source walk so a developer running `npm link` from a
  // checked-out repo lands on `from-source` instead.
  if (
    /\/lib\/node_modules\//.test(argv1Norm) ||
    /\/node_modules\/\.bin\//.test(argv1Norm) ||
    /\/\.npm\//.test(argv1Norm) ||
    /\/npm\/node_modules\//.test(argv1Norm) ||
    /\/homebrew\/.*node_modules\//.test(argv1Norm)
  ) {
    return {
      kind: "npm-global",
      detectedFrom: argv1,
      recommendedCommand: "npm install -g vaultpilot-mcp@latest",
      noticeInstallBlock: [
        "         (npm-global install detected)",
        "         npm install -g vaultpilot-mcp@latest",
        "         Restart Claude Code after upgrading so the new binary loads.",
      ].join("\n"),
      restartHint:
        "Restart Claude Code after upgrading so the new binary loads.",
    };
  }

  return {
    kind: "unknown",
    detectedFrom: argv0 || execPath,
    recommendedCommand:
      "See https://github.com/szhygulin/vaultpilot-mcp/blob/main/docs/INSTALL.md",
    noticeInstallBlock: [
      "         (install path could not be detected — check docs/INSTALL.md)",
      "         https://github.com/szhygulin/vaultpilot-mcp/blob/main/docs/INSTALL.md",
      "         covers npm, bundled-binary, source, and Docker update flows.",
      "         Restart Claude Code after upgrading.",
    ].join("\n"),
    restartHint: "Restart Claude Code after upgrading.",
  };
}

function baseName(p: string): string {
  return p.split(/[/\\]/).pop() ?? "";
}
