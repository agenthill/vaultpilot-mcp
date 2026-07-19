/**
 * Diagnostic (issue #772): prints the full sink-reachability classification
 * so a reviewer can eyeball the analyzer's output — which tools are detected
 * as sink-reaching, whether each is gated, and the reaching path. Not an
 * assertion; kept as a committed, re-runnable audit artifact.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect } from "vitest";
import { analyzeRegisteredTools } from "./sink-reachability.js";
import { isAlwaysGatedTool, isConditionallyGatedTool, isBroadcastTool } from "../../src/demo/index.js";

describe("issue #772 — sink analysis dump (diagnostic)", () => {
  it("emits the full sink-reachability classification as an audit artifact", () => {
    const results = analyzeRegisteredTools();
    const sinks = results.filter((r) => r.sinkReaching);
    const lines = [`TOTAL tools: ${results.length}; sink-reaching: ${sinks.length}`, ""];
    for (const r of sinks) {
      const g =
        [
          isAlwaysGatedTool(r.name) ? "ALWAYS" : "",
          isConditionallyGatedTool(r.name) ? "COND" : "",
          isBroadcastTool(r.name) ? "BCAST" : "",
        ]
          .filter(Boolean)
          .join("+") || "UNGATED";
      lines.push(`${g.padEnd(12)} ${r.name.padEnd(28)} <- ${JSON.stringify(r.sinkPath)}`);
    }
    // Best-effort write for local inspection; never fail CI on an unwritable tmp.
    try {
      fs.writeFileSync(path.join(os.tmpdir(), "sink-analysis-772.txt"), lines.join("\n"));
    } catch {
      /* ignore */
    }
    // Assert the shape stays stable so this stops being a silent no-op if the
    // analyzer regresses to detecting nothing.
    expect(sinks.length).toBeGreaterThanOrEqual(4);
  });
});
