import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  EXPECTED_SKILL_SENTINEL_A,
  EXPECTED_SKILL_SENTINEL_B,
  EXPECTED_SKILL_SHA256,
} from "./skill-pin-drift.js";
import {
  isPreflightSkillInstalled,
  preflightSkillMarkerPath,
} from "../skills/presence.js";

/**
 * Local-skill drift detector — issue #613 finding 3.
 *
 * Complements `skill-pin-drift.ts`: that module checks live master vs
 * MCP-pinned (operator-side staleness signal — "this MCP build is
 * stale relative to the skill repo"). This module checks the USER's
 * local `SKILL.md` vs MCP-pinned (user-side staleness signal — "your
 * local skill clone is stale relative to this MCP build"), the case
 * the agent in #613 actually hit.
 *
 * **Why a separate notice**: when local and MCP differ, the skill's
 * Step 0 halts with `vaultpilot-preflight skill integrity check
 * FAILED — DO NOT SIGN.`. That message reads as a tamper alarm. In
 * practice, the overwhelmingly common cause is a stale `git clone`
 * the user hasn't pulled. Without a server-side hint disambiguating
 * "stale" from "tampered", the user sees the same scary halt for two
 * very different conditions.
 *
 * Disambiguation strategy: extract the version-sentinel embedded in
 * the local skill content (canonical pattern
 * `VAULTPILOT_PREFLIGHT_INTEGRITY_v<N>_<16-hex>`) and compare to the
 * MCP-pinned `EXPECTED_SKILL_SENTINEL_*`. Three branches:
 *
 *   - `match`: hash matches — no notice.
 *   - `version-stale`: hash differs AND a `_vN_` sentinel was
 *     extracted that names a different version → notice with `git
 *     pull` recipe and explicit "this is staleness, not tamper" copy.
 *   - `content-mismatch`: hash differs AND no sentinel could be
 *     extracted (e.g. pre-sentinel skill version) → notice with
 *     fail-safe wording: try `git pull` first; if hashes still
 *     differ, treat as tamper.
 *   - `read-failed` / skill absent: no notice (the missing-skill
 *     warning already covers absence; read errors fail soft).
 *
 * Read is synchronous — local FS, single small file. No async
 * scaffolding needed; called lazily from the first tool response so
 * we don't pay any cost when the skill isn't installed.
 */

/**
 * Sentinel parser — looks for `VAULTPILOT_PREFLIGHT_INTEGRITY_v<N>_<16-hex>`
 * anywhere in the content. The MCP-emitted PIN block lists the
 * fragments separately, but the canonical skill embeds the assembled
 * literal somewhere in its body so Step 0's Part 3 search succeeds.
 *
 * Returns `null` when the pattern isn't present (e.g. pre-v4 skills,
 * truncated/corrupt files, or a tampered file with the marker
 * stripped).
 */
function extractLocalSentinelVersion(content: string): {
  version: string;
  fullSentinel: string;
} | null {
  const marker = `${EXPECTED_SKILL_SENTINEL_A}_v`;
  const startIdx = content.indexOf(marker);
  if (startIdx === -1) return null;
  const tail = content.slice(startIdx + marker.length);
  const match = tail.match(/^(\d+)_([0-9a-f]{16})/);
  if (!match) return null;
  return {
    version: match[1],
    fullSentinel: `${EXPECTED_SKILL_SENTINEL_A}_v${match[1]}_${match[2]}`,
  };
}

/** MCP-pinned version, parsed once from the sentinel B fragment (e.g. `_v12_` → `12`). */
function pinnedVersion(): string | null {
  const m = EXPECTED_SKILL_SENTINEL_B.match(/^_v(\d+)_$/);
  return m ? m[1] : null;
}

export type LocalSkillDriftResult =
  | { status: "match"; pinnedHash: string; localHash: string }
  | {
      status: "version-stale";
      pinnedHash: string;
      localHash: string;
      pinnedVersion: string;
      localVersion: string;
    }
  | { status: "content-mismatch"; pinnedHash: string; localHash: string }
  | { status: "skill-absent" }
  | { status: "read-failed"; reason: string };

/**
 * Sync check — read local SKILL.md, sha256 it, compare to MCP-pinned.
 * Pure: does not register session state. Caller decides what to do
 * with the verdict.
 */
export function checkLocalSkillDrift(): LocalSkillDriftResult {
  if (!isPreflightSkillInstalled()) {
    return { status: "skill-absent" };
  }
  let content: string;
  try {
    content = readFileSync(preflightSkillMarkerPath(), "utf8");
  } catch (err) {
    return {
      status: "read-failed",
      reason: (err as Error).message ?? String(err),
    };
  }
  const localHash = createHash("sha256").update(content, "utf8").digest("hex");
  if (localHash === EXPECTED_SKILL_SHA256) {
    return { status: "match", pinnedHash: EXPECTED_SKILL_SHA256, localHash };
  }
  const local = extractLocalSentinelVersion(content);
  const pinned = pinnedVersion();
  if (local && pinned && local.version !== pinned) {
    return {
      status: "version-stale",
      pinnedHash: EXPECTED_SKILL_SHA256,
      localHash,
      pinnedVersion: pinned,
      localVersion: local.version,
    };
  }
  return {
    status: "content-mismatch",
    pinnedHash: EXPECTED_SKILL_SHA256,
    localHash,
  };
}

// --- Session-level notice plumbing ---------------------------------------

let driftNoticeEmitted = false;

/** Test hook — reset dedup so notices fire again. */
export function _resetLocalSkillDriftDedup(): void {
  driftNoticeEmitted = false;
}

/**
 * Run the check (lazy, on first tool response of the session) and
 * render a notice the first time we see drift. Returns `null` for
 * match, missing skill, read failure, and after first emission.
 *
 * Mirrors the dedup + once-per-session pattern of
 * `getSkillPinDriftNotice()` in `skill-pin-drift.ts`.
 */
export function getLocalSkillDriftNotice(): string | null {
  if (driftNoticeEmitted) return null;
  const result = checkLocalSkillDrift();
  if (result.status === "match" || result.status === "skill-absent" || result.status === "read-failed") {
    return null;
  }
  driftNoticeEmitted = true;
  return result.status === "version-stale"
    ? renderVersionStaleNotice(result)
    : renderContentMismatchNotice(result);
}

/**
 * Renderer for the recognized-stale case. Same shape as the existing
 * `VAULTPILOT NOTICE — Skill pin drift detected` block: named header,
 * status / purpose / next sections, no imperative agent verbs, no
 * pasted shell, server-emitted closing paragraph.
 */
function renderVersionStaleNotice(args: {
  pinnedHash: string;
  localHash: string;
  pinnedVersion: string;
  localVersion: string;
}): string {
  const pinnedHead = args.pinnedHash.slice(0, 16);
  const localHead = args.localHash.slice(0, 16);
  return [
    "VAULTPILOT NOTICE — Local preflight skill is out of date (not tampered)",
    "",
    `Status:  the local SKILL.md at ${preflightSkillMarkerPath()} carries`,
    `         version sentinel \`v${args.localVersion}\`, but this MCP build`,
    `         expects \`v${args.pinnedVersion}\` (SHA-256: ${pinnedHead}…;`,
    `         local: ${localHead}…). Step 0 of the skill will halt signing`,
    "         flows on this hash mismatch with `vaultpilot-preflight skill",
    "         integrity check FAILED — DO NOT SIGN.` until the local clone",
    "         is updated.",
    "Cause:   the embedded `_v<N>_` sentinel is consistent with a known",
    "         stale release, which makes staleness the most plausible",
    "         explanation — far more common than a tampered file that",
    "         coincidentally embeds a self-consistent older marker. Refresh",
    "         the clone:",
    "             cd ~/.claude/skills/vaultpilot-preflight && git pull --ff-only",
    "         (or `git fetch && git reset --hard origin/master` if the",
    "         working tree was modified.) If the post-pull hash still does",
    "         not match the MCP pin, escalate as a tamper signal rather",
    "         than retrying.",
    "Next:    suggest the user run the `git pull` recipe above and continue",
    "         once the local SKILL.md hash matches the MCP-pinned value.",
    "         If the user is on an older MCP build that pins to a SKILL",
    "         version newer than what the canonical repo currently ships,",
    "         updating vaultpilot-mcp itself (`npm update -g vaultpilot-mcp`",
    "         or equivalent) is the alternative.",
    "",
    "This notice is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this notice family. Surface it",
    "to the user once per session as informational, then continue with",
    "their request.",
  ].join("\n");
}

/**
 * Renderer for the unrecognized-content case (no `_vN_` sentinel
 * could be extracted). Wording is fail-safe: most common cause is
 * still staleness from a pre-sentinel skill version, but we can't
 * confidently rule out tampering, so we name both possibilities.
 */
function renderContentMismatchNotice(args: {
  pinnedHash: string;
  localHash: string;
}): string {
  const pinnedHead = args.pinnedHash.slice(0, 16);
  const localHead = args.localHash.slice(0, 16);
  return [
    "VAULTPILOT NOTICE — Local preflight skill content does not match the MCP-pinned hash",
    "",
    `Status:  the local SKILL.md at ${preflightSkillMarkerPath()} hashes to`,
    `         ${localHead}…; this MCP build expects ${pinnedHead}…. Step 0`,
    "         of the skill will halt signing flows on this mismatch with",
    "         `vaultpilot-preflight skill integrity check FAILED — DO NOT",
    "         SIGN.` until the local content matches.",
    "Cause:   could not extract a recognizable version sentinel from the",
    "         local file, so the server cannot positively distinguish",
    "         staleness from tampering. Most common case: a pre-sentinel",
    "         skill version that pre-dates the embedded marker.",
    "Next:    refresh the clone first — staleness is the overwhelmingly",
    "         common cause:",
    "             cd ~/.claude/skills/vaultpilot-preflight && git pull --ff-only",
    "         If the post-pull hash still does not match, treat as a",
    "         tamper signal: do not bypass the Step 0 alarm, and surface",
    "         the discrepancy to the user before any signing flow.",
    "",
    "This notice is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this notice family. Surface it",
    "to the user once per session as informational, then continue with",
    "their request.",
  ].join("\n");
}
