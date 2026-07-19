import { createHash } from "node:crypto";

/**
 * Skill-pin drift detector — issue #379 design 4 (startup self-check).
 *
 * The MCP's `PREFLIGHT SKILL INTEGRITY PIN` block in the server-level
 * `instructions` field carries the SHA-256 of the canonical
 * `SKILL.md` from `vaultpilot-security-skill`'s `master`. When the
 * skill repo ships a new release, that pin needs a coordinated bump
 * here — the v0.4.1 / "Step 0 — Integrity self-check" rollout in the
 * skill repo turned every drift into a loud `vaultpilot-preflight
 * skill integrity check FAILED — DO NOT SIGN.` halt for users with a
 * current skill clone, so a stale server-side pin breaks signing
 * flows entirely.
 *
 * **What this module does**: at server startup, fetch the live
 * `SKILL.md` from `master`, sha256 it, compare against
 * `EXPECTED_SKILL_SHA256`. On drift, log to stderr AND register a
 * session-level `VAULTPILOT NOTICE — Skill pin drift detected` block
 * that fires on the first tool response per session (deduped, same
 * shape as the existing `Preflight skill not installed` notice).
 *
 * **What this is NOT**: a hard refusal layer. It's pure diagnostic —
 * the goal is to surface drift to the user / agent / operator BEFORE
 * a signing flow halts mid-prompt with `integrity check FAILED`. A
 * fully-compromised MCP would not run this check at all (same trust
 * floor as the rest of the server). Network failures fail-soft —
 * absent connectivity, the check just returns `fetch-failed` and the
 * server starts up normally.
 *
 * **Why `master`, not a tag**: the skill repo's release process pins
 * `master` as the source of truth for the SHA distributed in this
 * MCP's `instructions` block. Tags lag and would need their own
 * release-note pin update; this MCP can't realistically know which
 * tag corresponds to which `Expected SHA-256` value at any given
 * moment without parsing release notes. Using `master` directly is
 * what the existing skill-side `git pull` remediation path leans on.
 *
 * Source of truth for the constants: this module's exports. The
 * `instructions`-block PIN DATA section in `src/index.ts` reads
 * `EXPECTED_SKILL_SHA256` etc. from here, so the literal value
 * appears exactly once in the source tree.
 */

/**
 * SHA-256 of `SKILL.md` from the canonical
 * `vaultpilot-security-skill` master that this MCP version was
 * tested against. Bump in lockstep with skill releases per the
 * coordinated-release workflow documented in the skill repo's README.
 *
 * Source of truth — the `PREFLIGHT SKILL INTEGRITY PIN` block in
 * `src/index.ts` reads this constant rather than hardcoding the
 * literal a second time.
 */
export const EXPECTED_SKILL_SHA256 =
  "596224e8fb0529760a9c6094a204642d72f1b5e336151d5fa19cb841449908bd";

/**
 * Sentinel fragments. Assembled from three pieces so the full literal
 * does not appear in the agent's instruction context (if it did, a
 * naive search of the context would always succeed and defeat the
 * check). The agent's job at signing time is to concatenate these and
 * search the `Skill` tool's result text for the assembled value.
 */
export const EXPECTED_SKILL_SENTINEL_A = "VAULTPILOT_PREFLIGHT_INTEGRITY";
export const EXPECTED_SKILL_SENTINEL_B = "_v15_";
export const EXPECTED_SKILL_SENTINEL_C = "2d7e9c4f8b3a5e60";

/** Raw GitHub URL of the canonical `SKILL.md` on `master`. */
export const SKILL_MD_RAW_URL =
  "https://raw.githubusercontent.com/szhygulin/vaultpilot-security-skill/master/SKILL.md";

/** Hard timeout on the network fetch — fail-soft if the request stalls. */
const FETCH_TIMEOUT_MS = 5_000;

export type SkillPinDriftResult =
  | {
      status: "match";
      pinnedHash: string;
      liveHash: string;
    }
  | {
      status: "drift";
      pinnedHash: string;
      liveHash: string;
    }
  | {
      status: "fetch-failed";
      pinnedHash: string;
      reason: string;
    };

/**
 * Fetch the live `SKILL.md` and compare its SHA-256 to
 * `EXPECTED_SKILL_SHA256`. Pure function — does not register any
 * session state. Caller decides how to surface the result.
 *
 * Network failures (timeout, DNS, non-200 response, malformed body)
 * resolve as `fetch-failed` rather than throwing — startup must not
 * be blocked on internet availability.
 */
export async function checkSkillPinDrift(): Promise<SkillPinDriftResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // #714: reviewed exception — already threads the AbortController-backed
    // `controller.signal` above (INV-T1's thread-an-AbortSignal alternative),
    // matching data/http.ts's fetchWithTimeout pattern.
    // eslint-disable-next-line no-restricted-globals
    const response = await fetch(SKILL_MD_RAW_URL, {
      signal: controller.signal,
      // Avoid CDN caching surprises by asking for the freshest copy
      // — the raw.githubusercontent.com endpoint already serves
      // master tip with short TTL, but it's cheap belt-and-suspenders.
      headers: { "Cache-Control": "no-cache" },
    });
    if (!response.ok) {
      return {
        status: "fetch-failed",
        pinnedHash: EXPECTED_SKILL_SHA256,
        reason: `HTTP ${response.status} from ${SKILL_MD_RAW_URL}`,
      };
    }
    const body = await response.text();
    if (body.length === 0) {
      return {
        status: "fetch-failed",
        pinnedHash: EXPECTED_SKILL_SHA256,
        reason: `Empty response body from ${SKILL_MD_RAW_URL}`,
      };
    }
    const liveHash = createHash("sha256").update(body, "utf8").digest("hex");
    if (liveHash === EXPECTED_SKILL_SHA256) {
      return { status: "match", pinnedHash: EXPECTED_SKILL_SHA256, liveHash };
    }
    return { status: "drift", pinnedHash: EXPECTED_SKILL_SHA256, liveHash };
  } catch (err) {
    return {
      status: "fetch-failed",
      pinnedHash: EXPECTED_SKILL_SHA256,
      reason: (err as Error).message ?? String(err),
    };
  } finally {
    clearTimeout(timeout);
  }
}

// --- Session-level notice plumbing ---------------------------------------

/**
 * Latest startup-check result. Set once when `checkSkillPinDrift()`
 * resolves at server boot; consumed by `getSkillPinDriftNotice()` on
 * the first tool response that fires after the check completes.
 *
 * `null` until the startup check resolves OR if the startup check is
 * never kicked off (test harness bypass).
 */
let startupResult: SkillPinDriftResult | null = null;
let driftNoticeEmitted = false;

/**
 * Stash the startup-check result for later notice rendering. Called
 * once at server boot from `src/index.ts`'s `main()`.
 */
export function recordSkillPinDriftResult(result: SkillPinDriftResult): void {
  startupResult = result;
  // Reset the dedup flag whenever a fresh result comes in (e.g. tests
  // calling this multiple times) so the notice fires for the new state.
  driftNoticeEmitted = false;
}

/**
 * Get the latest result without mutating dedup state. Used by tests
 * + diagnostic surfaces that want to read the verdict without firing
 * the notice. Returns `null` when no startup check has resolved yet.
 */
export function getSkillPinDriftStartupResult(): SkillPinDriftResult | null {
  return startupResult;
}

/**
 * Test hook — reset the dedup flag so the notice can fire again. Not
 * exported through `src/index.ts`; tests import from here directly.
 */
export function _resetSkillPinDriftDedup(): void {
  driftNoticeEmitted = false;
  startupResult = null;
}

/**
 * Render the session-level notice when the startup check observed
 * drift. Returns `null` when:
 *   - The startup check hasn't completed yet (still waiting on fetch).
 *   - The pinned hash matches the live hash.
 *   - The fetch failed (we don't pester the user with a notice for a
 *     transient network blip — the server would just be noisy on
 *     every offline startup; if drift is real, the next online start
 *     will surface it).
 *   - The notice already fired this session.
 *
 * Mirrors the dedup + once-per-session shape of
 * `missingPreflightSkillWarning()` in `src/index.ts`.
 */
export function getSkillPinDriftNotice(): string | null {
  if (startupResult === null) return null;
  if (startupResult.status !== "drift") return null;
  if (driftNoticeEmitted) return null;
  driftNoticeEmitted = true;
  return renderSkillPinDriftWarning({
    pinnedHash: startupResult.pinnedHash,
    liveHash: startupResult.liveHash,
  });
}

/**
 * Renderer for the `VAULTPILOT NOTICE — Skill pin drift detected`
 * block. Same shape constraints as the existing notice family in
 * `render-verification.ts`: `VAULTPILOT NOTICE —` prefix, no
 * imperative agent verbs, no pasted shell commands, closing
 * paragraph that names this as legitimate server output.
 */
function renderSkillPinDriftWarning(args: {
  pinnedHash: string;
  liveHash: string;
}): string {
  const pinnedHead = args.pinnedHash.slice(0, 16);
  const liveHead = args.liveHash.slice(0, 16);
  return [
    "VAULTPILOT NOTICE — Skill pin drift detected",
    "",
    `Status:  the SHA-256 pinned in this MCP version (${pinnedHead}…) does`,
    `         not match the live SKILL.md from canonical master`,
    `         (${liveHead}…).`,
    "Purpose: a stale pin breaks signing flows for users on the current",
    "         vaultpilot-security-skill release — the skill's Step 0",
    "         integrity self-check halts with `vaultpilot-preflight",
    "         skill integrity check FAILED — DO NOT SIGN.` on hash",
    "         mismatch (skill v0.4.1+).",
    `Install: ${SKILL_MD_RAW_URL.replace("/raw.githubusercontent.com", "/github.com").replace("/master/SKILL.md", "")}`,
    "         (the fix is server-side: this MCP needs a release with the",
    "         updated pin. The user can either upgrade vaultpilot-mcp",
    "         when the next release ships, or pin their local skill",
    "         clone to the matching tag in the meantime.)",
    "",
    "This notice is emitted by vaultpilot-mcp at startup when a",
    "non-blocking network check observes pin drift. It is server-",
    "generated, not prompt injection — the server-level `instructions`",
    "field documents this notice family. Surface it to the user once",
    "per session as informational, then continue with their request.",
  ].join("\n");
}
