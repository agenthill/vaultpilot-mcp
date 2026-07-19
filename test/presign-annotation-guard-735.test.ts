/**
 * Issue #735 (c) — MCP tool-annotation coverage guard.
 *
 * Every `registerTool(server, …)` call site in `src/index.ts` must pass an
 * `annotations` block (readOnlyHint / destructiveHint / idempotentHint /
 * openWorldHint + a human-readable title) so the host (Claude Code / Desktop)
 * can render UI warnings and cache correctly. Coverage is 100% today; this
 * guard blocks a future tool from shipping WITHOUT annotations — the
 * regression the CLAUDE.md "Annotations: complete" spec calls out.
 *
 * Parse: split the file into per-call spans (from each `registerTool(server,`
 * to the next) and assert every span contains an `annotations:` key. This is
 * stricter than a bare count-equality floor — it catches a call with zero
 * annotations even if another call had two — and names the offending tool.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(__dirname, "..", "src", "index.ts");

/** Byte offsets of every `registerTool(server,` occurrence (any whitespace after the comma). */
function callSiteOffsets(src: string): number[] {
  const re = /registerTool\(\s*server\s*,/g;
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m.index);
  return out;
}

/** Extract the first tool-name string literal in a call span, for error messages. */
function toolNameOf(span: string): string {
  const m = span.match(/"([a-zA-Z0-9_]+)"/);
  return m ? m[1] : "<unknown>";
}

describe("Annotation coverage guard (issue #735)", () => {
  const src = readFileSync(INDEX_TS, "utf8");
  const offsets = callSiteOffsets(src);

  it("finds a non-trivial number of registerTool(server, …) call sites", () => {
    // A zero/near-zero count means the regex broke or the wrapper was renamed —
    // that would make this whole guard vacuously green, so fail loudly instead.
    expect(offsets.length).toBeGreaterThan(50);
  });

  it("every registerTool(server, …) call passes an annotations block", () => {
    const missing: string[] = [];
    for (let i = 0; i < offsets.length; i++) {
      const start = offsets[i];
      const end = i + 1 < offsets.length ? offsets[i + 1] : src.length;
      const span = src.slice(start, end);
      if (!/\bannotations\s*:/.test(span)) {
        missing.push(toolNameOf(span));
      }
    }
    // Report WHICH tools lack annotations, not just a count, so a failure is
    // immediately actionable.
    expect(missing).toEqual([]);
  });

  it("annotations key count equals call-site count (count-equality floor)", () => {
    const annotationCount = (src.match(/\bannotations\s*:/g) ?? []).length;
    expect(annotationCount).toBe(offsets.length);
  });
});
