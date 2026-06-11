/**
 * Lazy first-run auto-install of the two companion skills (`vaultpilot-
 * preflight`, `vaultpilot-setup`) at MCP server startup, instead of (or in
 * addition to) the interactive `vaultpilot-mcp-setup` wizard.
 *
 * Why "first tool call" and not npm `postinstall`:
 *   - npm postinstall runs at install time, often as root when global npm
 *     has a rooted prefix → skills end up root-owned and Claude Code (user)
 *     can't update them.
 *   - postinstall doesn't fire under `--ignore-scripts` (a common security
 *     default in CI / corporate networks).
 *   - The bundled binary, brew, and Docker install paths skip npm entirely.
 *   - Silent network calls during `npm install` / `npx` cold-starts surprise
 *     users who didn't ask for github.com egress.
 * Lazy first-call install runs as the user across every install vector,
 * makes the network call when the user is actually using the MCP, and
 * preserves the deliberate "skills are an independent trust root" property
 * (still git-cloned from github, never bundled with this package).
 *
 * State machine (per skill):
 *
 *   not-attempted ──► in-progress ──► succeeded
 *           │                  │
 *           │                  └────► failed
 *           ▼
 *      already-present (skill dir + SKILL.md exist before kickoff)
 *
 * `not-attempted` covers the disabled-via-env-var case AND the pre-kickoff
 * state. `already-present` is terminal and quiet (skill is there; no notice).
 *
 * Honors `VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1` for users who want
 * air-gapped / no-egress operation. When set, kickoff is a no-op and the
 * existing manual-install notice fires (today's behavior).
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { getSkillTargets, type SkillTarget } from "./install-skills.js";

const execFileAsync = promisify(execFile);

export type AutoInstallState =
  | "not-attempted"
  | "in-progress"
  | "succeeded"
  | "failed"
  | "already-present";

export interface AutoInstallEntry {
  state: AutoInstallState;
  target: SkillTarget;
  /** Populated for `failed`; short message suitable for direct print. */
  detail?: string;
}

const states = new Map<string, AutoInstallEntry>();
let kickoffStarted = false;

function isDisabled(): boolean {
  const v = process.env.VAULTPILOT_DISABLE_SKILL_AUTOINSTALL;
  return v === "1" || v === "true";
}

/**
 * Idempotent: only the first call does work; subsequent calls are no-ops.
 * Called from the top of every tool handler so the MCP doesn't need to
 * pre-compute when the "first tool call" actually is.
 *
 * Synchronous-returning even though it kicks off async git-clones — callers
 * never need to await this, the state map is the only observable surface.
 */
export function kickoffSkillAutoInstall(): void {
  if (kickoffStarted) return;
  kickoffStarted = true;
  if (isDisabled()) return;
  for (const target of getSkillTargets()) {
    if (existsSync(join(target.installPath, "SKILL.md"))) {
      states.set(target.name, { state: "already-present", target });
      continue;
    }
    if (existsSync(target.installPath)) {
      // Dangling dir (half-failed clone left an empty dir, or user interrupted
      // a prior wizard run). Refuse to clone into it — git would fail anyway,
      // and we never delete user files. Treat as terminal failed so the
      // existing manual-install notice fires with a concrete fix.
      states.set(target.name, {
        state: "failed",
        target,
        detail:
          `Path exists but has no SKILL.md — left untouched. ` +
          `Remove it manually, then either re-run vaultpilot-mcp-setup or ` +
          `git clone ${target.repoUrl} ${target.installPath}.`,
      });
      continue;
    }
    states.set(target.name, { state: "in-progress", target });
    void runInstall(target);
  }
}

async function runInstall(target: SkillTarget): Promise<void> {
  try {
    // mkdir the parent (~/.claude/skills/) so git clone lands somewhere
    // predictable on a first-ever Claude Code install.
    mkdirSync(join(target.installPath, ".."), { recursive: true });
    await execFileAsync(
      "git",
      ["clone", "--depth=1", target.repoUrl, target.installPath],
      { timeout: 30_000 },
    );
    states.set(target.name, { state: "succeeded", target });
  } catch (e) {
    const err = e as NodeJS.ErrnoException & { stderr?: string | Buffer };
    let detail: string;
    if (err.code === "ENOENT") {
      detail =
        `git is not on PATH. Install git, then clone ${target.repoUrl} ` +
        `to ${target.installPath}.`;
    } else {
      const stderr =
        typeof err.stderr === "string"
          ? err.stderr.trim()
          : err.stderr instanceof Buffer
            ? err.stderr.toString("utf8").trim()
            : "";
      const lastLine = stderr ? stderr.split("\n").slice(-1)[0] : "";
      detail =
        `git clone failed: ${err.message}` +
        (lastLine ? ` (${lastLine})` : "");
    }
    states.set(target.name, { state: "failed", target, detail });
  }
}

/**
 * Returns the current state for a named skill. Unknown name → `not-attempted`
 * with a synthesized target (caller is the renderer, which only needs the
 * state + detail; target is a defensive default).
 */
export function getAutoInstallState(skillName: string): AutoInstallEntry {
  const existing = states.get(skillName);
  if (existing) return existing;
  const targets = getSkillTargets();
  const target = targets.find((t) => t.name === skillName);
  if (!target) {
    throw new Error(
      `getAutoInstallState: unknown skill '${skillName}'. ` +
        `Known: ${targets.map((t) => t.name).join(", ")}.`,
    );
  }
  return { state: "not-attempted", target };
}

/** Test-only: reset the kickoff flag and state map between cases. */
export function _resetAutoInstallForTests(): void {
  states.clear();
  kickoffStarted = false;
}
