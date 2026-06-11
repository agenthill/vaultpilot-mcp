/**
 * Narrative renderer for `get_portfolio_diff`. Turns the structured
 * envelope into a human-readable string the agent can relay verbatim.
 *
 * The narrative deliberately leans on plain prose rather than markdown
 * tables so it reads naturally in chat regardless of the client's
 * markdown support. Agents can still re-mix the structured envelope for
 * their own table-rendering when appropriate.
 */
import type {
  PortfolioDiffSummary,
  ChainDiffSlice,
  AssetDiffRow,
} from "./schemas.js";

const WINDOW_LABELS: Record<PortfolioDiffSummary["window"], string> = {
  "24h": "the last 24 hours",
  "7d": "the last 7 days",
  "30d": "the last 30 days",
  ytd: "year-to-date",
};

function formatUsd(n: number): string {
  if (Math.abs(n) < 0.01) return "$0";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(2)}M`;
  if (abs >= 10_000) return `${sign}$${Math.round(abs).toLocaleString("en-US")}`;
  if (abs >= 100) return `${sign}$${abs.toFixed(0)}`;
  return `${sign}$${abs.toFixed(2)}`;
}

function formatSignedUsd(n: number): string {
  if (Math.abs(n) < 0.01) return "$0";
  return (n < 0 ? "" : "+") + formatUsd(n);
}

function formatPct(value: number, base: number): string {
  if (Math.abs(base) < 0.01) return "(no baseline)";
  const pct = (value / base) * 100;
  if (!Number.isFinite(pct)) return "(no baseline)";
  const sign = pct >= 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/** Top contributors (largest absolute USD effect) across all chains. */
function topAssetMovers(
  slices: ChainDiffSlice[],
  limit: number,
): Array<AssetDiffRow & { totalEffectUsd: number }> {
  const all = slices.flatMap((s) =>
    s.perAsset.map((a) => ({
      ...a,
      totalEffectUsd: a.priceEffectUsd + a.quantityEffectUsd,
    })),
  );
  all.sort((a, b) => Math.abs(b.totalEffectUsd) - Math.abs(a.totalEffectUsd));
  return all.slice(0, limit);
}

/**
 * Render the narrative. Structure:
 *   1. One-line headline: total change + percentage.
 *   2. Decomposition sentence: how the change splits across price moves,
 *      net flows, and "other" (interest accrual, swap PnL, etc.).
 *   3. Top movers: 1–3 bullet sentences naming the largest contributors.
 *   4. Caveats: only when truncated / partial coverage / notable skip.
 */
export function renderPortfolioDiffNarrative(
  summary: PortfolioDiffSummary,
): string {
  const lines: string[] = [];

  // 1. Headline.
  const windowLabel = WINDOW_LABELS[summary.window];
  const changeUsd = summary.topLevelChangeUsd;
  const pct = formatPct(changeUsd, summary.startingValueUsd);
  const verb = changeUsd >= 0 ? "up" : "down";
  if (summary.startingValueUsd === 0 && summary.endingValueUsd > 0) {
    lines.push(
      `Over ${windowLabel}, your portfolio went from ${formatUsd(0)} to ${formatUsd(summary.endingValueUsd)} — entirely from inflows in the window.`,
    );
  } else {
    lines.push(
      `Over ${windowLabel}, your portfolio is ${verb} ${formatUsd(Math.abs(changeUsd))} (${pct}), ` +
        `now at ${formatUsd(summary.endingValueUsd)} (was ${formatUsd(summary.startingValueUsd)} at window start).`,
    );
  }

  // 2. Decomposition sentence.
  const components: string[] = [];
  if (Math.abs(summary.priceEffectUsd) >= 0.5) {
    components.push(`${formatSignedUsd(summary.priceEffectUsd)} from price moves`);
  }
  if (Math.abs(summary.netFlowsUsd) >= 0.5) {
    if (summary.netFlowsUsd >= 0) {
      components.push(`${formatSignedUsd(summary.netFlowsUsd)} in net deposits`);
    } else {
      components.push(`${formatSignedUsd(summary.netFlowsUsd)} in net withdrawals`);
    }
  }
  if (Math.abs(summary.otherEffectUsd) >= 0.5) {
    components.push(
      `${formatSignedUsd(summary.otherEffectUsd)} from other on-chain activity (interest accrual, swap legs, MEV, etc.)`,
    );
  }
  if (components.length > 0) {
    lines.push(`Decomposition: ${components.join("; ")}.`);
  }

  // 3. Top movers.
  const top = topAssetMovers(summary.perChain, 5).filter(
    (a) => Math.abs(a.totalEffectUsd) >= 0.5,
  );
  if (top.length > 0) {
    lines.push("Largest contributors:");
    for (const a of top) {
      const direction = a.totalEffectUsd >= 0 ? "+" : "";
      const priceNote =
        Math.abs(a.priceEffectUsd) >= 0.5 ? ` (price ${formatSignedUsd(a.priceEffectUsd)})` : "";
      const flowNote =
        Math.abs(a.netFlowUsd) >= 0.5 ? ` (flow ${formatSignedUsd(a.netFlowUsd)})` : "";
      lines.push(
        `  - ${a.symbol} on ${a.chain}: ${direction}${formatUsd(a.totalEffectUsd)}${priceNote}${flowNote}`,
      );
    }
  }

  // 4. Caveats.
  const caveats: string[] = [];
  if (summary.truncated) {
    caveats.push(
      "On-chain history was truncated for at least one chain (50-row cap); flow accounting may under-count for very active wallets.",
    );
  }
  if (summary.priceCoverage === "partial") {
    caveats.push(
      "Some assets couldn't be priced at the historical or current timestamp; their effect on the totals may be 0 or approximate.",
    );
  }
  if (caveats.length > 0) {
    lines.push(`Caveats: ${caveats.join(" ")}`);
  }

  return lines.join("\n");
}
