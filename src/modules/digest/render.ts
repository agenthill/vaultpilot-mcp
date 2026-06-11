/**
 * Narrative renderer for the portfolio digest. Produces a markdown
 * string suitable for verbatim relay to the user. Voice tightens for
 * the 24h window (single short paragraph) and loosens for 7d/30d
 * (still concise but with more "this week / this month" framing).
 *
 * Style invariants:
 *
 *   - Lead with the punchline: total + delta + direction emoji-free
 *     ("up" / "down" / "flat"). Never bury what the user asked about.
 *   - Top-movers list as 2-column markdown bullets with USD-formatted
 *     amounts; cap at the structured envelope's pre-applied limit.
 *   - Health-factor warnings get a CAPITALIZED prefix when any HF<1.5
 *     row is present — agents have been observed under-flagging risk
 *     when warnings were nested in normal prose.
 *   - Activity bullet collapses to a one-liner when total ≤ 1; an
 *     enumerated split when > 1.
 *   - Zero-everything wallets (cold address with no history) get a
 *     coherent "You have nothing yet." reply rather than a wall of
 *     zeroes.
 */
import type { DailyBriefing } from "./schemas.js";

export function renderBriefingNarrative(briefing: DailyBriefing): string {
  // Empty-wallet escape hatch — when no value AND no activity, render
  // a one-liner instead of the templated layout.
  if (
    briefing.totals.currentUsd < 0.01 &&
    briefing.activity.total === 0 &&
    briefing.healthAlerts.atRisk.length === 0 &&
    briefing.topMovers.length === 0
  ) {
    return [
      `**Portfolio briefing — ${formatPeriod(briefing.period)}**`,
      "",
      "You have nothing yet — no balances, no recent activity. Once funds " +
        "land in any of the addresses you passed, the next briefing will " +
        "have something to say.",
      ...formatNotes(briefing.notes),
    ].join("\n");
  }

  const lines: string[] = [];

  // Header + headline.
  lines.push(`**Portfolio briefing — ${formatPeriod(briefing.period)}**`);
  lines.push("");
  lines.push(formatHeadline(briefing));
  lines.push("");

  // Top movers.
  if (briefing.topMovers.length > 0) {
    lines.push("**Top movers**");
    for (const m of briefing.topMovers) {
      const direction = m.changeUsd >= 0 ? "+" : "−";
      const abs = formatUsd(Math.abs(m.changeUsd));
      lines.push(
        `- ${m.symbol} on ${m.chain}: ${direction}${abs} ` +
          `(${formatUsd(m.startingValueUsd)} → ${formatUsd(m.endingValueUsd)})`,
      );
    }
    lines.push("");
  }

  // Health-factor alerts. Capitalized prefix when ANY at-risk row.
  if (briefing.healthAlerts.atRisk.length > 0) {
    lines.push(
      `**LIQUIDATION RISK** — ${briefing.healthAlerts.atRisk.length} ` +
        `lending position(s) below health-factor ${briefing.healthAlerts.threshold}:`,
    );
    for (const a of briefing.healthAlerts.atRisk) {
      const label = formatProtocolLabel(a.protocol, a.chain);
      lines.push(
        `- ${label}: HF ${a.healthFactor.toFixed(2)} ` +
          `(collateral ${formatUsd(a.collateralUsd)} / debt ${formatUsd(a.debtUsd)}, ` +
          `${a.marginToLiquidation.toFixed(1)}% margin to liquidation)`,
      );
    }
    lines.push("");
  } else {
    lines.push(
      `**Health:** all lending positions above HF ${briefing.healthAlerts.threshold} (no liquidation risk).`,
    );
    lines.push("");
  }

  // Recent activity.
  lines.push(formatActivityLine(briefing));
  lines.push("");

  // Punted sections — surface honestly so the user knows the digest
  // isn't quietly hiding signals it never even tried to compute.
  lines.push(
    `_Best-yield section unavailable: ${briefing.bestStablecoinYield.reason}_`,
  );
  lines.push(
    `_Pending / scheduled section unavailable: ${briefing.liquidationCalendar.reason}_`,
  );

  // Notes (per-section read failures).
  for (const note of formatNotes(briefing.notes)) lines.push(note);

  return lines.join("\n");
}

function formatHeadline(briefing: DailyBriefing): string {
  const total = formatUsd(briefing.totals.currentUsd);
  const change = briefing.totals.changeUsd;
  const dir = change > 0 ? "up" : change < 0 ? "down" : "flat";
  const abs = formatUsd(Math.abs(change));
  const pctPart =
    briefing.totals.changePct !== undefined
      ? ` (${briefing.totals.changePct > 0 ? "+" : ""}${briefing.totals.changePct.toFixed(2)}%)`
      : "";
  if (dir === "flat") {
    return `Total **${total}** — flat${pctPart} over the ${formatPeriodTail(briefing.period)}.`;
  }
  return `Total **${total}** — ${dir} ${abs}${pctPart} over the ${formatPeriodTail(briefing.period)}.`;
}

function formatActivityLine(briefing: DailyBriefing): string {
  const a = briefing.activity;
  if (a.total === 0) {
    return `**Activity:** no transactions in the ${formatPeriodTail(briefing.period)}.`;
  }
  if (a.total === 1) {
    return `**Activity:** 1 transaction in the ${formatPeriodTail(briefing.period)}.`;
  }
  const parts: string[] = [];
  if (a.received) parts.push(`${a.received} received`);
  if (a.sent) parts.push(`${a.sent} sent`);
  if (a.swapped) parts.push(`${a.swapped} swap${a.swapped === 1 ? "" : "s"}`);
  if (a.supplied) parts.push(`${a.supplied} supplied`);
  if (a.borrowed) parts.push(`${a.borrowed} borrowed`);
  if (a.repaid) parts.push(`${a.repaid} repaid`);
  if (a.withdrew) parts.push(`${a.withdrew} withdrawn`);
  if (a.other) parts.push(`${a.other} other`);
  return `**Activity:** ${a.total} transaction${a.total === 1 ? "" : "s"} (${parts.join(", ")}) in the ${formatPeriodTail(briefing.period)}.`;
}

function formatPeriod(p: "24h" | "7d" | "30d"): string {
  return p === "24h" ? "last 24h" : p === "7d" ? "last 7 days" : "last 30 days";
}

function formatPeriodTail(p: "24h" | "7d" | "30d"): string {
  return p === "24h" ? "last 24h" : p === "7d" ? "past week" : "past month";
}

function formatProtocolLabel(protocol: string, chain: string): string {
  switch (protocol) {
    case "aave-v3":
      return `Aave V3 on ${chain}`;
    case "compound-v3":
      return `Compound V3 on ${chain}`;
    case "morpho-blue":
      return `Morpho Blue on ${chain}`;
    case "marginfi":
      return "MarginFi on Solana";
    case "kamino":
      return "Kamino on Solana";
    default:
      return `${protocol} on ${chain}`;
  }
}

function formatUsd(n: number): string {
  if (!Number.isFinite(n)) return "$?";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `$${(n / 1_000).toFixed(2)}K`;
  if (abs >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

function formatNotes(notes: string[]): string[] {
  if (notes.length === 0) return [];
  const out: string[] = ["", "_Notes:_"];
  for (const n of notes) out.push(`- ${n}`);
  return out;
}
