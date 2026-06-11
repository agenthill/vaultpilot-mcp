/**
 * Cross-check banner — version + SHA-256 + canonical URL header for the
 * `pasteableBlock` rendered by `get_verification_artifact`.
 *
 * Why: the prior pasteableBlock body was ~80 lines of agent-task prose,
 * which a "lazy user" couldn't visually verify against prompt injection.
 * The redesigned block opens with a 3-line trust banner the user pins
 * once and skims in 3 seconds on every subsequent invocation; the full
 * audit spec moves to `docs/cross-check-v1.md` (committed to the repo,
 * referenced by URL pinned to the package version tag).
 *
 * The banner shows:
 *   1. Spec version + SHA-256 of the on-disk doc — pin once, abort on mismatch
 *   2. Canonical URL on github.com/szhygulin/vaultpilot-mcp pinned to the
 *      package's release tag, so the spec the user reads online matches
 *      the one shipped in their installed package
 *   3. End separator
 *
 * Compromise model:
 *   - Hostile MCP swaps the spec body but keeps the SHA: SHA mismatches
 *     against what the user pinned in `~/.vaultpilot-mcp/config.json` and
 *     the agent surfaces it in the prepare receipt.
 *   - Hostile MCP swaps the URL: the user notices it's not
 *     `szhygulin/vaultpilot-mcp` (the install footprint they trust).
 *   - Hostile MCP swaps both: same threat surface as a fully replaced
 *     npm package — the user's first-install verification step is the
 *     trust anchor regardless of this banner.
 */
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Compute the canonical spec doc's SHA-256 hex digest. Read at module
 * load so the result is bound to the on-disk file shipped in the
 * installed package.
 */
function readSpecSha256(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    // Compiled: dist/signing/cross-check-banner.js → ../../docs/cross-check-v1.md
    // Source:   src/signing/cross-check-banner.ts → ../../docs/cross-check-v1.md
    const docPath = join(here, "..", "..", "..", "docs", "cross-check-v1.md");
    const body = readFileSync(docPath);
    return createHash("sha256").update(body).digest("hex");
  } catch {
    // If the doc is missing (corrupt install / source-tree run from an
    // unexpected cwd), fall back to a sentinel rather than crashing the
    // server. The banner surfaces the sentinel so the user sees the
    // problem instead of a lookalike SHA.
    return "doc-missing";
  }
}

function readPackageVersion(): string {
  try {
    const here = fileURLToPath(import.meta.url);
    const pkgPath = join(here, "..", "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * Module-load constants. Computed once; same value for every artifact in
 * the process's lifetime so the user can compare across calls.
 */
export const CROSS_CHECK_SPEC_VERSION = "v1" as const;
export const CROSS_CHECK_SPEC_SHA256 = readSpecSha256();
export const PACKAGE_VERSION = readPackageVersion();
export const CROSS_CHECK_SPEC_URL =
  `https://github.com/szhygulin/vaultpilot-mcp/blob/v${PACKAGE_VERSION}/docs/cross-check-v1.md`;

const BANNER_RULE = "═".repeat(40);

/**
 * Build the 3-line banner that opens every pasteableBlock. Identical
 * across every artifact for the same chain + spec version, so a lazy
 * user's "first time I check this" effort amortizes across all future
 * calls — they pin the SHA once and skim it in 3 seconds thereafter.
 */
export function buildCrossCheckBanner(): string {
  return [
    BANNER_RULE,
    `VAULTPILOT CROSS-CHECK ${CROSS_CHECK_SPEC_VERSION} — pin SHA once, verify on every call`,
    `SHA-256: ${CROSS_CHECK_SPEC_SHA256}`,
    `Spec:    ${CROSS_CHECK_SPEC_URL}`,
    BANNER_RULE,
  ].join("\n");
}

/** Test-only helper — re-read the spec from disk + recompute SHA. Used in
 * the banner test to verify the live SHA matches what we'd compute today. */
export function _recomputeSpecSha256ForTests(): string {
  return readSpecSha256();
}
