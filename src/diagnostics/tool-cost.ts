/**
 * Per-tool token-cost analyzer for the static MCP surface (issue #637).
 *
 * The agent loads every registered tool's `name`, `description`, and
 * `inputSchema` (JSON Schema) into context on every `tools/list` call —
 * once per conversation, but persistent across every subsequent turn.
 * That static surface is the largest single contributor to per-session
 * Claude token spend on this server, and we have no measurement of it
 * today.
 *
 * This module computes per-tool size breakdowns from a `tools/list`
 * response and ranks them. It is deliberately runtime-free: callers
 * pass in tool metadata they obtained however they want (spawned
 * server, fixture, snapshot), and get back sized rows + a formatted
 * table. The runner script in `scripts/bench-tools.mjs` does the
 * actual server spawn.
 *
 * **Tokenizer choice**: Anthropic's tokenizer is closed-source. cl100k
 * is the standard public proxy and would require ~5MB of BPE tables.
 * For *relative ranking* — which is what this benchmark needs — raw
 * character count works fine (the issue itself notes "cl100k is a
 * serviceable proxy for relative ranking"; we go one step lighter by
 * using char/4 as a proxy for cl100k). When absolute counts matter
 * later (e.g. to ground a CI budget rule in real-tokenizer output),
 * swap `approxTokens` for a `gpt-tokenizer` import. Until then, the
 * `approxTokens` column is "tokens, approximately" — not a contract.
 *
 * **Scope**: static surface (description + inputSchema JSON). Response
 * sizes (CHECKS PERFORMED blocks, NOTICE blocks, payload bodies) are a
 * follow-on; they require fixtures or live RPC and live in a separate
 * harness.
 */

/**
 * Each registered tool, as it appears in an MCP `tools/list` response.
 * Mirrors the SDK's `Tool` shape but keeps this module's types
 * independent of the SDK so the analyzer can be exercised in tests
 * without pulling the server in.
 */
export interface ToolDescriptor {
  name: string;
  description?: string;
  inputSchema?: unknown;
}

export interface ToolCostRow {
  name: string;
  /** Length in UTF-8 bytes — canonical, locale-free. */
  nameBytes: number;
  descriptionBytes: number;
  inputSchemaBytes: number;
  /** Sum of name + description + inputSchema bytes. */
  totalBytes: number;
  /** Approximate token count (chars/4 proxy — see module header). */
  approxTokens: number;
}

export interface ToolCostSummary {
  rows: ToolCostRow[];
  totalBytes: number;
  totalApproxTokens: number;
  toolCount: number;
}

/** Approximate cl100k tokens. Chars / 4, rounded up. */
export function approxTokens(s: string): number {
  if (s.length === 0) return 0;
  return Math.ceil(s.length / 4);
}

/** UTF-8 byte length, matching what the JSON-RPC transport puts on the wire. */
export function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/**
 * Serialize the inputSchema the way the MCP SDK does on the wire — the
 * canonical JSON form, no pretty-printing. This is what the agent
 * actually sees in its tools/list payload.
 */
export function serializeInputSchema(schema: unknown): string {
  if (schema === undefined || schema === null) return "";
  return JSON.stringify(schema);
}

export function analyzeTool(tool: ToolDescriptor): ToolCostRow {
  const nameBytes = utf8Bytes(tool.name);
  const descriptionBytes = utf8Bytes(tool.description ?? "");
  const inputSchemaJson = serializeInputSchema(tool.inputSchema);
  const inputSchemaBytes = utf8Bytes(inputSchemaJson);
  const totalBytes = nameBytes + descriptionBytes + inputSchemaBytes;
  // Approx tokens computed off the combined char count, which matches
  // how a tokenizer would chew the concatenated payload.
  const totalChars =
    tool.name.length + (tool.description ?? "").length + inputSchemaJson.length;
  return {
    name: tool.name,
    nameBytes,
    descriptionBytes,
    inputSchemaBytes,
    totalBytes,
    approxTokens: Math.ceil(totalChars / 4),
  };
}

export function analyzeToolList(tools: ToolDescriptor[]): ToolCostSummary {
  const rows = tools.map(analyzeTool).sort((a, b) => b.totalBytes - a.totalBytes);
  const totalBytes = rows.reduce((acc, r) => acc + r.totalBytes, 0);
  const totalApproxTokens = rows.reduce((acc, r) => acc + r.approxTokens, 0);
  return {
    rows,
    totalBytes,
    totalApproxTokens,
    toolCount: rows.length,
  };
}

/**
 * Format the analyzer output as a Markdown report. Top-N tools are
 * shown by total bytes (descending); summary footer carries the global
 * static-surface total.
 */
export function formatRankingTable(
  summary: ToolCostSummary,
  options: { top?: number } = {},
): string {
  const top = options.top ?? 10;
  const limited = summary.rows.slice(0, top);
  const lines: string[] = [];
  lines.push("# MCP tool static-surface token cost");
  lines.push("");
  lines.push(
    `Generated: ${new Date().toISOString()} — ${summary.toolCount} tools registered`,
  );
  lines.push("");
  lines.push(
    `**Per-conversation static cost**: ${summary.totalBytes.toLocaleString()} bytes ≈ ${summary.totalApproxTokens.toLocaleString()} tokens (chars/4 proxy).`,
  );
  lines.push("");
  lines.push(`## Top ${limited.length} by total bytes`);
  lines.push("");
  lines.push("| Rank | Tool | Total bytes | ≈ tokens | Description bytes | Schema bytes |");
  lines.push("|-----:|------|------------:|---------:|------------------:|-------------:|");
  for (const [i, row] of limited.entries()) {
    lines.push(
      `| ${i + 1} | \`${row.name}\` | ${row.totalBytes.toLocaleString()} | ${row.approxTokens.toLocaleString()} | ${row.descriptionBytes.toLocaleString()} | ${row.inputSchemaBytes.toLocaleString()} |`,
    );
  }
  lines.push("");
  lines.push("## Section breakdown across all tools");
  lines.push("");
  const totalDescBytes = summary.rows.reduce((a, r) => a + r.descriptionBytes, 0);
  const totalSchemaBytes = summary.rows.reduce((a, r) => a + r.inputSchemaBytes, 0);
  const totalNameBytes = summary.rows.reduce((a, r) => a + r.nameBytes, 0);
  lines.push("| Section | Bytes | % of total |");
  lines.push("|---------|------:|-----------:|");
  const pct = (n: number): string =>
    summary.totalBytes === 0 ? "0%" : `${((n / summary.totalBytes) * 100).toFixed(1)}%`;
  lines.push(`| Tool names | ${totalNameBytes.toLocaleString()} | ${pct(totalNameBytes)} |`);
  lines.push(
    `| Descriptions | ${totalDescBytes.toLocaleString()} | ${pct(totalDescBytes)} |`,
  );
  lines.push(
    `| Input schemas | ${totalSchemaBytes.toLocaleString()} | ${pct(totalSchemaBytes)} |`,
  );
  lines.push("");
  lines.push(
    "_Token counts are an approximation (chars/4) — accurate for relative ranking, not for absolute budget claims. See `src/diagnostics/tool-cost.ts` header for details._",
  );
  return lines.join("\n");
}
