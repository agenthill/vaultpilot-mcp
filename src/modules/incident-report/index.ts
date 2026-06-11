/**
 * Incident-report builder (issue #425, v1).
 *
 * Read-only forensic-bundle generator. Gathers session-level context
 * (demo-mode state, paired Ledger summary, notice flags fired this
 * session, skill-pin drift status) plus optional on-chain context
 * for a wallet (recent tx history). Applies redaction per the
 * caller's chosen mode and renders both a structured envelope and a
 * markdown narrative the user can paste into a security ticket /
 * disclosure / GitHub issue.
 *
 * v1 scope (this file): single read tool. Submission channel
 * (`submit_incident_report`) and prepared-tx ring buffer are deferred
 * — see `claude-work/plan-incident-report-v2.md` for the v2 design.
 */

import { createHash } from "node:crypto";
import { readUserConfig } from "../../config/user-config.js";
import {
  getDemoModeReason,
  getDemoModeEnvState,
  isLiveMode,
  getLiveWallet,
} from "../../demo/index.js";
import { getSkillPinDriftStartupResult } from "../../diagnostics/skill-pin-drift.js";
import {
  isPreflightSkillInstalled,
  isSetupSkillInstalled,
} from "../../skills/presence.js";
import { getTransactionHistory } from "../history/index.js";
import type { BuildIncidentReportArgs } from "./schemas.js";
import { redactEnvelope, type RedactionMode } from "./redact.js";

/**
 * Server version, captured at module load. Embedded in every report
 * so a maintainer reading the bundle later can correlate behavior to
 * a specific release. Static import (vs reading package.json at
 * runtime) keeps the snapshot consistent with the build artifact.
 */
const SERVER_VERSION = "0.14.4";

interface PairingSummary {
  chain: "solana" | "tron" | "bitcoin" | "litecoin";
  count: number;
  /** Address-prefixed-suffixed for the bundle. Uses the redaction helper. */
  addresses: string[];
}

interface IncidentReportEnvelope {
  incident_id: string;
  generated_at: string;
  server_version: string;
  scope: BuildIncidentReportArgs["scope"];
  incident_class: BuildIncidentReportArgs["incident_class"] | null;
  redaction_mode: RedactionMode;
  txHash: string | null;
  evidence: {
    demo_mode: {
      reason: ReturnType<typeof getDemoModeReason>;
      env_state: ReturnType<typeof getDemoModeEnvState>;
      live_wallet_active: boolean;
      live_wallet?: ReturnType<typeof getLiveWallet>;
    };
    pairings: PairingSummary[];
    notices: {
      preflight_skill_installed: boolean;
      setup_skill_installed: boolean;
      skill_pin_drift_status: string | null;
    };
    wallet_context?: {
      wallet: string;
      chain: string;
      recent_history_count: number;
      most_recent_timestamp: number | null;
      sample_items?: unknown[];
    };
    wallet_context_error?: string;
  };
}

/**
 * Deterministic incident ID — sha256 of (scope, txHash, wallet,
 * timestamp-rounded-to-minute). Same inputs in the same minute return
 * the same ID, which lets a user re-run after redacting differently
 * and reference the same incident in follow-up correspondence.
 */
function makeIncidentId(args: BuildIncidentReportArgs, generatedAt: number): string {
  const minuteBucket = Math.floor(generatedAt / 60_000);
  const seed = JSON.stringify({
    scope: args.scope,
    incident_class: args.incident_class,
    wallet: args.wallet,
    txHash: args.txHash,
    minuteBucket,
  });
  const hash = createHash("sha256").update(seed).digest("hex");
  return `incident-${hash.slice(0, 12)}`;
}

/**
 * Read paired Ledger wallets from the user config. Returns empty
 * lists when no config exists (auto-demo / fresh install) or when
 * config exists but has no `pairings` field. Failures are caught and
 * surfaced as an empty list — incident-report generation must NOT
 * crash on a malformed config.
 */
function readPairings(): PairingSummary[] {
  let cfg: ReturnType<typeof readUserConfig>;
  try {
    cfg = readUserConfig();
  } catch {
    return [];
  }
  if (!cfg?.pairings) return [];
  const out: PairingSummary[] = [];
  const chains = ["solana", "tron", "bitcoin", "litecoin"] as const;
  for (const chain of chains) {
    const entries = cfg.pairings[chain];
    if (entries && entries.length > 0) {
      out.push({ chain, count: entries.length, addresses: entries.map((p) => p.address) });
    }
  }
  return out;
}

/**
 * Render a markdown narrative summary of the envelope. Designed for
 * verbatim paste into a GitHub issue or security disclosure email —
 * sections + headings, no tool-call notation, no internal jargon
 * outside of the explicitly-incident-relevant fields.
 */
function renderNarrative(envelope: IncidentReportEnvelope): string {
  const lines: string[] = [];
  lines.push(`# VaultPilot incident report — \`${envelope.incident_id}\``);
  lines.push("");
  lines.push(`**Generated:** ${envelope.generated_at}`);
  lines.push(`**Server version:** ${envelope.server_version}`);
  lines.push(`**Scope:** \`${envelope.scope}\``);
  if (envelope.incident_class) {
    lines.push(`**Incident class:** \`${envelope.incident_class}\``);
  }
  lines.push(`**Redaction:** \`${envelope.redaction_mode}\``);
  if (envelope.txHash) {
    lines.push(`**Anchor tx hash:** \`${envelope.txHash}\``);
  }
  lines.push("");

  lines.push("## Demo-mode state");
  lines.push("");
  lines.push(`- **Reason:** \`${envelope.evidence.demo_mode.reason}\``);
  lines.push(`- **Env state:** \`${envelope.evidence.demo_mode.env_state}\``);
  lines.push(
    `- **Live wallet active:** ${envelope.evidence.demo_mode.live_wallet_active ? "yes" : "no"}`,
  );
  if (envelope.evidence.demo_mode.live_wallet) {
    const lw = envelope.evidence.demo_mode.live_wallet;
    lines.push(`  - persona: \`${lw.personaId ?? "(custom)"}\``);
  }
  lines.push("");

  lines.push("## Paired Ledger wallets");
  lines.push("");
  if (envelope.evidence.pairings.length === 0) {
    lines.push("_No paired wallets._");
  } else {
    for (const p of envelope.evidence.pairings) {
      lines.push(`- **${p.chain}** — ${p.count} entr${p.count === 1 ? "y" : "ies"}`);
      for (const addr of p.addresses) {
        lines.push(`  - \`${addr}\``);
      }
    }
  }
  lines.push("");

  lines.push("## Skill / integrity notices");
  lines.push("");
  lines.push(
    `- **Preflight skill installed:** ${envelope.evidence.notices.preflight_skill_installed ? "yes" : "no"}`,
  );
  lines.push(
    `- **Setup skill installed:** ${envelope.evidence.notices.setup_skill_installed ? "yes" : "no"}`,
  );
  lines.push(
    `- **Skill-pin drift status:** \`${envelope.evidence.notices.skill_pin_drift_status ?? "(check did not run yet)"}\``,
  );
  lines.push("");

  if (envelope.evidence.wallet_context) {
    const wc = envelope.evidence.wallet_context;
    lines.push("## Wallet context");
    lines.push("");
    lines.push(`- **Wallet:** \`${wc.wallet}\``);
    lines.push(`- **Chain:** \`${wc.chain}\``);
    lines.push(
      `- **Recent history items:** ${wc.recent_history_count}` +
        (wc.most_recent_timestamp
          ? ` (most recent: \`${new Date(wc.most_recent_timestamp * 1000).toISOString()}\`)`
          : ""),
    );
    lines.push("");
  } else if (envelope.evidence.wallet_context_error) {
    lines.push("## Wallet context");
    lines.push("");
    lines.push(`_Could not fetch on-chain history: ${envelope.evidence.wallet_context_error}_`);
    lines.push("");
  }

  lines.push("---");
  lines.push("");
  lines.push(
    "_This bundle was generated by `build_incident_report` (issue #425). " +
      "If you believe a security issue is involved, forward it to the " +
      "vaultpilot-mcp maintainers — review redacted output before sharing " +
      "publicly. To submit programmatically once v2 ships, use " +
      "`submit_incident_report`._",
  );

  return lines.join("\n");
}

/**
 * Build the incident-report envelope. The handler in `src/index.ts`
 * thin-wraps this and returns both the envelope (structured) and the
 * narrative (markdown) so an agent can choose which to relay.
 */
export async function buildIncidentReport(
  args: BuildIncidentReportArgs,
): Promise<{ envelope: IncidentReportEnvelope; narrative: string }> {
  const generatedAt = Date.now();
  const incident_id = makeIncidentId(args, generatedAt);
  const redaction_mode = args.redact;

  // ---------- Always-included evidence ----------
  const demo_mode = {
    reason: getDemoModeReason(),
    env_state: getDemoModeEnvState(),
    live_wallet_active: isLiveMode(),
    ...(isLiveMode() ? { live_wallet: getLiveWallet() ?? undefined } : {}),
  };
  const pairings = readPairings();
  const driftResult = getSkillPinDriftStartupResult();
  const notices = {
    preflight_skill_installed: isPreflightSkillInstalled(),
    setup_skill_installed: isSetupSkillInstalled(),
    skill_pin_drift_status: driftResult?.status ?? null,
  };

  // ---------- Optional wallet-context evidence ----------
  let wallet_context: IncidentReportEnvelope["evidence"]["wallet_context"];
  let wallet_context_error: string | undefined;
  const wantsWalletEvidence = args.scope === "wallet" || args.scope === "custom";
  if (wantsWalletEvidence) {
    if (!args.wallet) {
      wallet_context_error =
        "scope='wallet' or 'custom' requires a `wallet` arg.";
    } else {
      const chain = args.chain ?? "ethereum";
      try {
        const history = await getTransactionHistory({
          wallet: args.wallet,
          chain,
          limit: 10,
          // Defaults: include external + token transfers + internal so the
          // address-poisoning suffix-lookalike heuristic surfaces in the bundle
          // (the `suspectedPoisoning` field on each item is the agent's primary
          // forensic signal).
          includeExternal: true,
          includeTokenTransfers: true,
          includeInternal: true,
        });
        const items = history.items ?? [];
        const mostRecent = items[0];
        wallet_context = {
          wallet: args.wallet,
          chain,
          recent_history_count: items.length,
          most_recent_timestamp:
            mostRecent && typeof (mostRecent as { timestamp?: number }).timestamp === "number"
              ? (mostRecent as { timestamp: number }).timestamp
              : null,
          // Cap the sample at the 5 most recent items — enough to characterize
          // a poisoning campaign or suspicious recent activity without the
          // bundle ballooning past paste-friendly size.
          sample_items: items.slice(0, 5),
        };
      } catch (err) {
        wallet_context_error = err instanceof Error ? err.message : String(err);
      }
    }
  }

  const envelope: IncidentReportEnvelope = {
    incident_id,
    generated_at: new Date(generatedAt).toISOString(),
    server_version: SERVER_VERSION,
    scope: args.scope,
    incident_class: args.incident_class ?? null,
    redaction_mode,
    txHash: args.txHash ?? null,
    evidence: {
      demo_mode,
      pairings,
      notices,
      ...(wallet_context ? { wallet_context } : {}),
      ...(wallet_context_error ? { wallet_context_error } : {}),
    },
  };

  // Apply redaction LAST so all evidence-gathering paths see the
  // unredacted shape (some helpers care about exact addresses, e.g.
  // for pairing-count comparisons in tests). The redacted clone is
  // the user-facing artifact; the unredacted envelope is never
  // returned.
  const redactedEnvelope = redactEnvelope(envelope, redaction_mode);
  const narrative = renderNarrative(redactedEnvelope);
  return { envelope: redactedEnvelope, narrative };
}
