/**
 * `get_update_command` — surfaces the recommended upgrade flow for the
 * running install path so the agent has a concrete answer when the user
 * sees the `VAULTPILOT NOTICE — Update available` block (or asks
 * proactively, "is there a new version?").
 *
 * Returns a structured result the agent can act on:
 *   - `current`: this server's package.json version.
 *   - `latest`: the latest version returned by the most recent
 *     successful npm-registry fetch, or `null` if the lazy
 *     `version-check` kickoff hasn't resolved yet (or the env-var
 *     disabled it).
 *   - `updateAvailable`: strict-newer comparator, false when `latest`
 *     is `null`.
 *   - `installPath`: detected kind (`npm-global` / `npx` /
 *     `bundled-binary` / `from-source` / `unknown`) so the agent can
 *     judge how confident the recommendation is.
 *   - `command`: ready-to-paste upgrade command for the detected path.
 *   - `restartHint`: short note about the post-upgrade restart.
 *   - `note`: optional caveat — surfaces when `installPath` is
 *     `unknown` (defer to INSTALL.md) or `latest` is unknown (the
 *     agent should call back later or re-run when the registry is
 *     reachable).
 *
 * Pure local introspection plus a read of cached version-check state.
 * Never throws, never re-fetches the registry (the kickoff already
 * does that); safe to call any number of times.
 */
import { isUpdateAvailable } from "../../shared/semver.js";
import {
  getInstallPath,
  type InstallKind,
} from "../../shared/install-path.js";
import { getLatestKnownVersion } from "../../shared/version-check.js";
import { getServerVersion } from "../../shared/version.js";

export interface UpdateCommandResult {
  current: string;
  latest: string | null;
  updateAvailable: boolean;
  installPath: InstallKind;
  command: string;
  restartHint: string;
  note?: string;
}

export function getUpdateCommand(
  _args: Record<string, never> = {},
): UpdateCommandResult {
  const current = getServerVersion();
  const latest = getLatestKnownVersion();
  const install = getInstallPath();
  const updateAvailable =
    latest !== null && isUpdateAvailable(current, latest);

  let note: string | undefined;
  if (latest === null) {
    note =
      "The npm-registry version check hasn't resolved yet (or VAULTPILOT_DISABLE_UPDATE_CHECK is set). " +
      "The `command` is still correct for the detected install path; the agent can re-run this tool " +
      "after a few seconds or check https://www.npmjs.com/package/vaultpilot-mcp directly.";
  } else if (install.kind === "unknown") {
    note =
      "Install path could not be detected from process.argv / process.execPath. " +
      "Ask the user how they installed vaultpilot-mcp (npm, bundled binary, source, Docker) " +
      "and refer to docs/INSTALL.md for the matching update flow.";
  }

  return {
    current,
    latest,
    updateAvailable,
    installPath: install.kind,
    command: install.recommendedCommand,
    restartHint: install.restartHint,
    ...(note ? { note } : {}),
  };
}
