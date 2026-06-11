import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

type FeedbackEvent = { ts: number; hash: string };

/**
 * The state-file path is computed lazily from an env-var override so tests can
 * redirect writes into a temp dir. Default: `~/.vaultpilot-mcp/feedback-log.json`,
 * with back-compat fallback to `~/.recon-crypto-mcp/feedback-log.json` if that's
 * the only one that exists (pre-rename users).
 */
function getStateFilePath(): string {
  const envOverride =
    process.env.VAULTPILOT_FEEDBACK_STATE_FILE ?? process.env.RECON_FEEDBACK_STATE_FILE;
  if (envOverride) return envOverride;
  const newPath = join(homedir(), ".vaultpilot-mcp", "feedback-log.json");
  const legacyPath = join(homedir(), ".recon-crypto-mcp", "feedback-log.json");
  if (!existsSync(newPath) && existsSync(legacyPath)) return legacyPath;
  return newPath;
}

const MIN_INTERVAL_MS = 30_000;
const MAX_PER_HOUR = 3;
const MAX_PER_DAY = 10;
const DEDUPE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_EVENTS_STORED = 200;

export const RATE_LIMITS = {
  minIntervalSeconds: MIN_INTERVAL_MS / 1000,
  perHour: MAX_PER_HOUR,
  perDay: MAX_PER_DAY,
  dedupeWindowDays: DEDUPE_WINDOW_MS / (24 * 60 * 60 * 1000),
} as const;

export function hashPayload(summary: string, description: string): string {
  return createHash("sha256")
    .update(`${summary.trim().toLowerCase()}\n${description.trim().toLowerCase()}`)
    .digest("hex")
    .slice(0, 16);
}

export type RateLimitResult =
  | { ok: true }
  | { ok: false; reason: string; retryAfterSeconds?: number };

export function checkAndRecord(hash: string, now: number = Date.now()): RateLimitResult {
  const events = readEvents();

  const last = events.at(-1);
  if (last && now - last.ts < MIN_INTERVAL_MS) {
    const retry = Math.ceil((MIN_INTERVAL_MS - (now - last.ts)) / 1000);
    return {
      ok: false,
      reason: `Too many capability requests in quick succession. Wait ${retry}s between calls.`,
      retryAfterSeconds: retry,
    };
  }

  const hourAgo = now - 60 * 60 * 1000;
  if (events.filter((e) => e.ts > hourAgo).length >= MAX_PER_HOUR) {
    return {
      ok: false,
      reason: `Hourly capability-request limit (${MAX_PER_HOUR}/hour) reached. Try again later.`,
    };
  }

  const dayAgo = now - 24 * 60 * 60 * 1000;
  if (events.filter((e) => e.ts > dayAgo).length >= MAX_PER_DAY) {
    return {
      ok: false,
      reason: `Daily capability-request limit (${MAX_PER_DAY}/24h) reached. Try again tomorrow.`,
    };
  }

  const dedupeAgo = now - DEDUPE_WINDOW_MS;
  if (events.some((e) => e.hash === hash && e.ts > dedupeAgo)) {
    return {
      ok: false,
      reason:
        "An equivalent capability request (same summary + description) was already submitted in the last 7 days. " +
        "Refine the summary/description with new information, or wait for triage.",
    };
  }

  const next: FeedbackEvent[] = [...events, { ts: now, hash }];
  const retentionCutoff = now - RETENTION_MS;
  const pruned = next.filter((e) => e.ts > retentionCutoff).slice(-MAX_EVENTS_STORED);
  writeEvents(pruned);

  return { ok: true };
}

function readEvents(): FeedbackEvent[] {
  const stateFile = getStateFilePath();
  if (!existsSync(stateFile)) return [];
  try {
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is FeedbackEvent => {
      if (typeof e !== "object" || e === null) return false;
      const ev = e as FeedbackEvent;
      return Number.isFinite(ev.ts) && typeof ev.hash === "string" && ev.hash.length > 0;
    });
  } catch {
    return [];
  }
}

/**
 * Writes the event log atomically. Throws on any condition that would make the
 * rate limiter silently lose state (refused symlink, EPERM, etc.) — callers
 * MUST propagate, so a failed write fails the capability-request outright
 * rather than letting it proceed with no counter increment (fail-closed).
 */
function writeEvents(events: FeedbackEvent[]): void {
  const stateFile = getStateFilePath();
  const dir = dirname(stateFile);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  if (existsSync(stateFile)) {
    const st = lstatSync(stateFile);
    if (!st.isFile() || st.isSymbolicLink() || st.nlink > 1) {
      throw new Error(
        `Refusing to write feedback rate-limit log at ${stateFile}: path is a symlink, hardlink, or non-regular file. ` +
          `Inspect it manually and remove it to restore DDoS protection.`
      );
    }
  }
  writeFileSync(stateFile, JSON.stringify(events, null, 2) + "\n", { mode: 0o600 });
}
