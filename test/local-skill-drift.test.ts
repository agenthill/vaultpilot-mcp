import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  EXPECTED_SKILL_SHA256,
  EXPECTED_SKILL_SENTINEL_A,
  EXPECTED_SKILL_SENTINEL_B,
  EXPECTED_SKILL_SENTINEL_C,
} from "../src/diagnostics/skill-pin-drift.ts";
import {
  checkLocalSkillDrift,
  getLocalSkillDriftNotice,
  _resetLocalSkillDriftDedup,
} from "../src/diagnostics/local-skill-drift.ts";

/**
 * Tests for issue #613 finding 3 — local-skill drift detector. Uses
 * the `VAULTPILOT_SKILL_MARKER_PATH` env override to point at a tmp
 * fixture so we can exercise every status branch without touching the
 * user's real `~/.claude/skills/vaultpilot-preflight/SKILL.md`.
 */

let tmpDir: string;
let fixturePath: string;
let savedEnv: string | undefined;

function writeFixture(contents: string): void {
  writeFileSync(fixturePath, contents, "utf8");
}

/**
 * Build a SKILL.md whose SHA-256 IS `EXPECTED_SKILL_SHA256`. The only
 * way to do that without checking in a tampered upstream artifact is
 * to write a fixture and set `EXPECTED_SKILL_SHA256` to its hash —
 * but that constant is the canonical pin, so we can't override it
 * just for tests. Instead, we observe the `match` branch by writing
 * a fixture and, in the `match` test, asserting that the local hash
 * we compute matches what the function returns. The other branches
 * (`version-stale`, `content-mismatch`, `read-failed`, `skill-absent`)
 * exercise the bulk of the logic and don't need a colliding hash.
 */

beforeEach(() => {
  savedEnv = process.env.VAULTPILOT_SKILL_MARKER_PATH;
  tmpDir = mkdtempSync(join(tmpdir(), "vaultpilot-local-drift-test-"));
  fixturePath = join(tmpDir, "SKILL.md");
  process.env.VAULTPILOT_SKILL_MARKER_PATH = fixturePath;
  _resetLocalSkillDriftDedup();
});

afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env.VAULTPILOT_SKILL_MARKER_PATH;
  } else {
    process.env.VAULTPILOT_SKILL_MARKER_PATH = savedEnv;
  }
  rmSync(tmpDir, { recursive: true, force: true });
  _resetLocalSkillDriftDedup();
});

describe("checkLocalSkillDrift — issue #613 finding 3", () => {
  it("returns `skill-absent` when the marker file does not exist", () => {
    // Don't write the fixture — env points at a path that doesn't exist.
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("skill-absent");
  });

  it("returns `version-stale` when a recognizable older sentinel is present", () => {
    // v4 was the example version that triggered the original report.
    const stale = `# preflight skill v4
${EXPECTED_SKILL_SENTINEL_A}_v4_7655818578c7a044
content body that does not match the canonical v17 hash`;
    writeFixture(stale);
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("version-stale");
    if (result.status === "version-stale") {
      expect(result.localVersion).toBe("4");
      expect(result.pinnedVersion).toBe("17");
      expect(result.pinnedHash).toBe(EXPECTED_SKILL_SHA256);
      expect(result.localHash).not.toBe(EXPECTED_SKILL_SHA256);
    }
  });

  it("returns `version-stale` even for a NEWER sentinel (any version mismatch)", () => {
    // Future-skill case — user is somehow ahead of the MCP build.
    const newer = `# future skill
${EXPECTED_SKILL_SENTINEL_A}_v99_0000000000000000
content body`;
    writeFixture(newer);
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("version-stale");
    if (result.status === "version-stale") {
      expect(result.localVersion).toBe("99");
      expect(result.pinnedVersion).toBe("17");
    }
  });

  it("returns `content-mismatch` when no sentinel is parseable (pre-sentinel skill)", () => {
    // Old skill version that pre-dates the sentinel, OR a tampered file
    // with the marker stripped — server can't disambiguate.
    writeFixture("# very old skill, no sentinel here");
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("content-mismatch");
  });

  it("returns `content-mismatch` when sentinel is present but malformed", () => {
    // Marker prefix is there, but the version digits / hex tail is wrong shape.
    const malformed = `${EXPECTED_SKILL_SENTINEL_A}_vXX_notvalidhex
content`;
    writeFixture(malformed);
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("content-mismatch");
  });

  it("does NOT return `version-stale` when local sentinel happens to be the SAME version (still hash mismatch)", () => {
    // Sentinel matches version (`v17`), but content body differs from
    // canonical → hash mismatch but version-extraction yields the same
    // version. Should fall through to content-mismatch (the version
    // marker says "same version" so something else is wrong).
    const sameVersionDifferentContent = `# preflight skill
${EXPECTED_SKILL_SENTINEL_A}${EXPECTED_SKILL_SENTINEL_B}${EXPECTED_SKILL_SENTINEL_C}
this body is different from canonical so the hash does not match`;
    writeFixture(sameVersionDifferentContent);
    const result = checkLocalSkillDrift();
    expect(result.status).toBe("content-mismatch");
  });
});

describe("getLocalSkillDriftNotice — once-per-session dedup", () => {
  it("emits the version-stale notice on first call, then null on subsequent calls", () => {
    writeFixture(`${EXPECTED_SKILL_SENTINEL_A}_v4_7655818578c7a044
body`);
    const first = getLocalSkillDriftNotice();
    expect(first).not.toBeNull();
    expect(first).toContain("VAULTPILOT NOTICE — Local preflight skill is out of date (not tampered)");
    expect(first).toContain("`v4`");
    expect(first).toContain("`v17`");
    expect(first).toContain("git pull --ff-only");
    // Second call: deduped.
    expect(getLocalSkillDriftNotice()).toBeNull();
  });

  it("emits the content-mismatch notice with fail-safe wording (could be stale OR tampered)", () => {
    writeFixture("# old pre-sentinel skill\nno marker here");
    const notice = getLocalSkillDriftNotice();
    expect(notice).not.toBeNull();
    expect(notice).toContain("VAULTPILOT NOTICE — Local preflight skill content does not match");
    // Names BOTH possibilities — staleness first (common case), tampering second.
    expect(notice).toMatch(/staleness|stale/);
    expect(notice).toMatch(/tamper/);
    expect(notice).toContain("git pull --ff-only");
  });

  it("returns null when the skill is absent (missing-skill warning covers that case)", () => {
    // Don't write a fixture.
    expect(getLocalSkillDriftNotice()).toBeNull();
  });

  it("notice block carries the same defensive shape as the existing VAULTPILOT NOTICE family", () => {
    writeFixture(`${EXPECTED_SKILL_SENTINEL_A}_v4_7655818578c7a044
body`);
    const notice = getLocalSkillDriftNotice();
    expect(notice).not.toBeNull();
    if (notice === null) return;
    // Must announce itself as server-emitted.
    expect(notice).toMatch(/server-generated|server-emitted/);
    // No imperative agent-task framing.
    expect(notice).not.toMatch(/AGENT TASK/);
    expect(notice).not.toMatch(/RELAY TO USER FIRST/);
    // No fenced code blocks (defensive shape) — the recipe is shown as
    // an indented snippet, not a runnable code fence.
    expect(notice).not.toMatch(/```/);
  });

  it("does not surface the assembled sentinel literal in the notice (would short-circuit Step 0 Part 3)", () => {
    writeFixture(`${EXPECTED_SKILL_SENTINEL_A}_v4_7655818578c7a044
body`);
    const notice = getLocalSkillDriftNotice();
    expect(notice).not.toBeNull();
    if (notice === null) return;
    const assembledExpected =
      EXPECTED_SKILL_SENTINEL_A + EXPECTED_SKILL_SENTINEL_B + EXPECTED_SKILL_SENTINEL_C;
    expect(notice).not.toContain(assembledExpected);
  });
});
