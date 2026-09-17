/**
 * Tests for the install-path detector. Each kind is checked by patching
 * `process.argv`/`process.execPath`/env to a representative shape and
 * asserting the returned `kind` + the `recommendedCommand` shape.
 *
 * These are heuristics — the goal is to get the common cases right, not
 * to cover every package manager / Linux distro on earth. The detector
 * falls through to `unknown` when nothing matches, which is correct.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getInstallPath,
  _resetInstallPathCacheForTests,
} from "../src/shared/install-path.js";

const ORIGINAL_ARGV = [...process.argv];
const ORIGINAL_EXEC_PATH = process.execPath;
const ORIGINAL_NPM_UA = process.env.npm_config_user_agent;

function setProcessShape(opts: {
  argv0: string;
  argv1?: string;
  execPath?: string;
  npmUserAgent?: string;
}): void {
  process.argv = [opts.argv0, opts.argv1 ?? "", ...ORIGINAL_ARGV.slice(2)];
  // execPath is read-only on some Node versions, but Object.defineProperty
  // works in CI. Skip if the platform refuses.
  try {
    Object.defineProperty(process, "execPath", {
      value: opts.execPath ?? opts.argv0,
      configurable: true,
    });
  } catch {
    // Older Node — fine; the test still asserts on argv-derived kinds.
  }
  if (opts.npmUserAgent === undefined) {
    delete process.env.npm_config_user_agent;
  } else {
    process.env.npm_config_user_agent = opts.npmUserAgent;
  }
  _resetInstallPathCacheForTests();
}

beforeEach(() => {
  _resetInstallPathCacheForTests();
});

afterEach(() => {
  process.argv = ORIGINAL_ARGV;
  try {
    Object.defineProperty(process, "execPath", {
      value: ORIGINAL_EXEC_PATH,
      configurable: true,
    });
  } catch {
    // ignore
  }
  if (ORIGINAL_NPM_UA === undefined) {
    delete process.env.npm_config_user_agent;
  } else {
    process.env.npm_config_user_agent = ORIGINAL_NPM_UA;
  }
  _resetInstallPathCacheForTests();
});

describe("getInstallPath", () => {
  it("detects bundled-binary by argv[0] basename", () => {
    setProcessShape({
      argv0: "/home/user/.local/bin/vaultpilot-mcp-linux-x64-0.11.0",
    });
    const info = getInstallPath();
    expect(info.kind).toBe("bundled-binary");
    expect(info.recommendedCommand).toMatch(/install\.sh \| bash/);
    expect(info.noticeInstallBlock).toMatch(/bundled-binary install detected/);
  });

  it("detects npx via cache path", () => {
    setProcessShape({
      argv0: "/usr/bin/node",
      argv1: "/home/u/.npm/_npx/abc123/node_modules/vaultpilot-mcp/dist/index.js",
    });
    const info = getInstallPath();
    expect(info.kind).toBe("npx");
    expect(info.recommendedCommand).toMatch(/npx/);
    expect(info.recommendedCommand).toMatch(/vaultpilot-mcp@latest/);
  });

  it("detects npx via npm_config_user_agent", () => {
    setProcessShape({
      argv0: "/usr/bin/node",
      argv1: "/some/random/path/index.js",
      npmUserAgent: "npm/10.2.4 node/v20.10.0 linux x64 workspaces/false npx/10.2.4",
    });
    const info = getInstallPath();
    expect(info.kind).toBe("npx");
  });

  it("detects npm-global by /lib/node_modules/ path", () => {
    setProcessShape({
      argv0: "/usr/bin/node",
      argv1: "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js",
    });
    const info = getInstallPath();
    expect(info.kind).toBe("npm-global");
    expect(info.recommendedCommand).toBe("npm install -g vaultpilot-mcp@latest");
  });

  it("detects npm-global on homebrew prefix", () => {
    // A real /opt/homebrew can itself contain .git. Keep the global-install
    // fixture outside the host's Homebrew checkout so this tests only its shape.
    const root = mkdtempSync(join(tmpdir(), "vaultpilot-homebrew-"));
    try {
      setProcessShape({
        argv0: "/usr/bin/node",
        argv1: join(root, "homebrew/lib/node_modules/vaultpilot-mcp/dist/index.js"),
      });
      const info = getInstallPath();
      expect(info.kind).toBe("npm-global");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("detects from-source via .git ancestor", () => {
    const root = mkdtempSync(join(tmpdir(), "vaultpilot-source-"));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, "dist"));
    const argv1 = join(root, "dist", "index.js");
    try {
      setProcessShape({ argv0: "/usr/bin/node", argv1 });
      const info = getInstallPath();
      expect(info.kind).toBe("from-source");
      expect(info.recommendedCommand).toMatch(/git -C .* pull/);
      expect(info.recommendedCommand).toMatch(/npm run build/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to unknown when no heuristic matches", () => {
    setProcessShape({
      argv0: "/usr/bin/node",
      argv1: "/var/some/non-conventional/place/index.js",
    });
    const info = getInstallPath();
    expect(info.kind).toBe("unknown");
    expect(info.recommendedCommand).toMatch(/INSTALL\.md/);
  });

  it("memoizes detection — second call returns the same object", () => {
    setProcessShape({
      argv0: "/usr/bin/node",
      argv1: "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js",
    });
    const a = getInstallPath();
    const b = getInstallPath();
    expect(a).toBe(b);
  });

  it("noticeInstallBlock starts with the indented Install: alignment for every kind", () => {
    const cases: Array<{ argv0: string; argv1?: string }> = [
      { argv0: "/home/u/.local/bin/vaultpilot-mcp-linux-x64-0.11.0" },
      { argv0: "/usr/bin/node", argv1: "/usr/local/lib/node_modules/vaultpilot-mcp/dist/index.js" },
      { argv0: "/usr/bin/node", argv1: "/var/random/index.js" },
    ];
    for (const c of cases) {
      setProcessShape(c);
      const info = getInstallPath();
      // Every block starts with the 9-space indent that lines up under the
      // `Install:` label in the rendered notice.
      expect(info.noticeInstallBlock.split("\n")[0]).toMatch(/^ {9}\(/);
    }
  });
});
