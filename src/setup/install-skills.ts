/**
 * Auto-install the two companion Claude Code skills — `vaultpilot-preflight`
 * (signing-time bytes-verification invariants) and `vaultpilot-setup`
 * (conversational `/setup` flow) — into `~/.claude/skills/`. Replaces the
 * manual `git clone` step the user would otherwise run.
 *
 * Idempotent: if a skill's directory already exists with a `SKILL.md` file,
 * we leave it alone (never `git pull` silently — the user's trust root is
 * their local clone, so an opportunistic pull would undermine that). Users
 * who want to update re-run `git pull` from the skill dir manually.
 *
 * Non-fatal: if `git` isn't on PATH, or the network is down, or the skill
 * repo is unreachable, we emit a structured error result per skill and keep
 * going. The MCP's runtime "skill missing" notice still fires, so the user
 * has a second chance to install manually — setup-time failure doesn't
 * leave them stranded.
 *
 * Both repos are intentionally separate from `vaultpilot-mcp`. An attacker
 * who compromises the MCP release pipeline cannot modify the skills this
 * flow clones — their trust roots are the user's own clones of the skill
 * repositories. Documenting this invariant here is why we do NOT `git pull`
 * after the first successful clone.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type SkillInstallStatus = "installed" | "already-present" | "error";

export interface SkillInstallResult {
  name: string;
  installPath: string;
  repoUrl: string;
  status: SkillInstallStatus;
  /** Populated for `error`; short message suitable for direct print. */
  detail?: string;
}

export interface SkillTarget {
  name: string;
  repoUrl: string;
  /** Absolute path on disk where the skill should live. */
  installPath: string;
}

/**
 * The two companion skills. Order matters only for the setup wizard's
 * printed summary — `preflight` is more important (security invariants) so
 * it surfaces first.
 */
export function getSkillTargets(): SkillTarget[] {
  const skillsRoot = join(homedir(), ".claude", "skills");
  return [
    {
      name: "vaultpilot-preflight",
      repoUrl: "https://github.com/szhygulin/vaultpilot-security-skill.git",
      installPath: join(skillsRoot, "vaultpilot-preflight"),
    },
    {
      name: "vaultpilot-setup",
      repoUrl: "https://github.com/szhygulin/vaultpilot-setup-skill.git",
      installPath: join(skillsRoot, "vaultpilot-setup"),
    },
  ];
}

/**
 * "Already present" means the directory exists AND has a `SKILL.md` inside.
 * A dangling directory (e.g. half-failed clone leaving an empty dir behind)
 * is treated as absent so the next install attempt can proceed, but we still
 * refuse to delete user files — the caller surfaces an error so they can
 * clean up manually.
 */
function skillAlreadyInstalled(installPath: string): boolean {
  return existsSync(join(installPath, "SKILL.md"));
}

/**
 * Clone a single skill repo. Blocks on `git clone` — acceptable for an
 * interactive wizard run, and keeps this module synchronous-friendly for
 * the caller. Timeout is conservative (30s) so a hung DNS or firewalled
 * environment doesn't leave the wizard indefinitely stuck.
 *
 * `stdio: "pipe"` + `encoding: "utf8"` captures git's output so we can
 * include a helpful trailer in the error detail (git's own "fatal: ..."
 * line is usually enough for the user to diagnose).
 */
export function installSkill(target: SkillTarget): SkillInstallResult {
  const { name, repoUrl, installPath } = target;
  if (skillAlreadyInstalled(installPath)) {
    return { name, installPath, repoUrl, status: "already-present" };
  }

  // If the directory exists but has no SKILL.md, refuse to clone into it —
  // `git clone` itself would fail ("destination path already exists and is
  // not an empty directory") but the error is unclear. Surface it directly.
  if (existsSync(installPath)) {
    return {
      name,
      installPath,
      repoUrl,
      status: "error",
      detail:
        `Path exists but has no SKILL.md — left untouched. Remove it manually ` +
        `and re-run setup, or clone from ${repoUrl} yourself.`,
    };
  }

  // mkdir the parent (~/.claude/skills/) so `git clone` lands somewhere
  // predictable even on a first-ever Claude Code install.
  mkdirSync(join(installPath, ".."), { recursive: true });

  try {
    execFileSync("git", ["clone", "--depth=1", repoUrl, installPath], {
      stdio: "pipe",
      encoding: "utf8",
      timeout: 30_000,
    });
    return { name, installPath, repoUrl, status: "installed" };
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer };
    // ENOENT when `git` isn't on PATH — most common on bare Windows installs
    // without Git for Windows. Separate message so the user knows what to
    // fix.
    if (err.code === "ENOENT") {
      return {
        name,
        installPath,
        repoUrl,
        status: "error",
        detail: `git is not on PATH. Install git, then clone ${repoUrl} to ${installPath}.`,
      };
    }
    const stderr =
      typeof err.stderr === "string"
        ? err.stderr.trim()
        : err.stderr instanceof Buffer
          ? err.stderr.toString("utf8").trim()
          : "";
    return {
      name,
      installPath,
      repoUrl,
      status: "error",
      detail:
        `git clone failed: ${err.message}` +
        (stderr ? `\n      ${stderr.split("\n").slice(-2).join(" | ")}` : ""),
    };
  }
}

/** Clone every target skill. Errors on one don't stop the others. */
export function installAllSkills(): SkillInstallResult[] {
  return getSkillTargets().map(installSkill);
}

/** Multi-line summary for the wizard's terminal output. */
export function summarizeSkillInstalls(results: SkillInstallResult[]): string {
  const lines: string[] = [];
  for (const r of results) {
    let tag: string;
    if (r.status === "installed") {
      tag = "✓ Installed";
    } else if (r.status === "already-present") {
      tag = "✓ Already installed";
    } else {
      tag = "✗ Error";
    }
    lines.push(`  ${tag}: ${r.name}`);
    lines.push(`      ${r.installPath}`);
    if (r.detail) lines.push(`      ${r.detail}`);
  }
  return lines.join("\n");
}
