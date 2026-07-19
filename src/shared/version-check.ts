/**
 * Lazy, fire-and-forget npm-registry check that surfaces a once-per-session
 * `VAULTPILOT NOTICE — Update available` block when a newer stable is
 * published.
 *
 * Lifecycle:
 *   - `kickoffUpdateCheck()` is called from the top of every tool handler.
 *     The first call kicks off a single GET against
 *     `registry.npmjs.org/vaultpilot-mcp/latest`; subsequent calls are
 *     no-ops while that promise is in flight or has resolved. Tool
 *     responses do NOT await it.
 *   - `consumeUpdateNotice()` is called once per response. It returns the
 *     rendered notice text the first time the promise has resolved with
 *     an update available, then `null` forever after.
 *
 * Failure modes — network error, non-200 status, malformed JSON, missing
 * `.version` field, comparator throws — all silently fall through to "no
 * notice this session." The check is informational; never surfaces a
 * network error to the user. See `claude-work/plan-update-available-
 * notice.md` for the full threat model.
 *
 * Honors `VAULTPILOT_DISABLE_UPDATE_CHECK=1` for air-gapped operators
 * (mirrors the `VAULTPILOT_DISABLE_SKILL_AUTOINSTALL` shape).
 */
import { renderUpdateAvailableNotice } from "../signing/render-verification.js";
import { getInstallPath } from "./install-path.js";
import { isUpdateAvailable } from "./semver.js";
import { getServerVersion } from "./version.js";

const REGISTRY_URL = "https://registry.npmjs.org/vaultpilot-mcp/latest";
const FETCH_TIMEOUT_MS = 3000;
const PACKAGE_NAME = "vaultpilot-mcp";

let kickoffStarted = false;
let resolvedNotice: string | null = null;
let noticeEmitted = false;
/**
 * Latest version observed from the npm registry, regardless of whether it
 * is newer than the current. Surfaced through `getLatestKnownVersion()`
 * so the `get_update_command` tool can report a concrete latest version
 * to the agent rather than `null` when no update is needed.
 */
let latestKnownVersion: string | null = null;

function isDisabled(): boolean {
  const v = process.env.VAULTPILOT_DISABLE_UPDATE_CHECK;
  if (!v) return false;
  return v !== "0" && v.toLowerCase() !== "false";
}

/**
 * Optional fetch override for tests — lets a test plug a stub without
 * mocking `globalThis.fetch`. Returns `null` to fall through to the
 * default fetch.
 */
type FetchFn = typeof fetch;
let fetchOverride: FetchFn | null = null;

export function _setFetchForTests(fn: FetchFn | null): void {
  fetchOverride = fn;
}

export function _resetUpdateCheckForTests(): void {
  kickoffStarted = false;
  resolvedNotice = null;
  noticeEmitted = false;
  latestKnownVersion = null;
}

/**
 * Idempotent kickoff. Synchronous-returning even though it starts an async
 * fetch — callers never await this, the resolved notice flows through
 * `consumeUpdateNotice()`.
 */
export function kickoffUpdateCheck(): void {
  if (kickoffStarted) return;
  kickoffStarted = true;
  if (isDisabled()) return;
  void runCheck();
}

async function runCheck(): Promise<void> {
  try {
    // #714: reviewed exception — the `f(...)` call below threads its own
    // AbortController-backed signal (INV-T1's thread-an-AbortSignal
    // alternative); ARCHITECTURE.md §4 INV-T1 names this aliasing test seam
    // by file, must not be flagged.
    // eslint-disable-next-line no-restricted-syntax
    const f = fetchOverride ?? globalThis.fetch;
    if (typeof f !== "function") return;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    let res: Response;
    try {
      res = await f(REGISTRY_URL, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok) return;
    const body = (await res.json()) as { version?: unknown };
    if (!body || typeof body.version !== "string") return;
    const current = getServerVersion();
    const latest = body.version;
    latestKnownVersion = latest;
    if (!isUpdateAvailable(current, latest)) return;
    const install = getInstallPath();
    resolvedNotice = renderUpdateAvailableNotice({
      current,
      latest,
      packageName: PACKAGE_NAME,
      installBlock: install.noticeInstallBlock,
    });
  } catch {
    // Silent fall-through — see module header.
  }
}

/**
 * Returns the rendered notice text on the first successful resolve where
 * an update is available; subsequent calls return `null`. Safe to call on
 * every tool response.
 */
export function consumeUpdateNotice(): string | null {
  if (noticeEmitted) return null;
  if (resolvedNotice === null) return null;
  noticeEmitted = true;
  return resolvedNotice;
}

/**
 * Latest version returned by the most recent successful npm-registry
 * fetch, regardless of whether it is newer than the current. `null`
 * means the fetch hasn't resolved yet (or failed silently). Used by
 * `get_update_command` so it can surface a concrete latest version
 * even when no update is available.
 */
export function getLatestKnownVersion(): string | null {
  return latestKnownVersion;
}
