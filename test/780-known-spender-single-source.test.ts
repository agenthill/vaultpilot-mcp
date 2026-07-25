/**
 * Regression guard for issue #780: `lookupKnownSpender` must be defined
 * exactly ONCE, in `src/security/known-spenders.ts`. Before the fix,
 * `src/modules/allowances/permit2.ts` carried a byte-for-byte functional
 * duplicate (same CONTRACTS-driven loop/switch/label logic) — two
 * implementations of one security lookup that were guaranteed to drift
 * (a spender allowlisted in one path, not the other), the same failure
 * class #765 D10's single-sourcing pattern exists to prevent.
 *
 * FALSIFIER: walks every `.ts` file under `src/` and counts
 * `function lookupKnownSpender(` / `export function lookupKnownSpender(`
 * definitions. On unfixed code this finds two (the canonical export in
 * known-spenders.ts AND the local redefinition in permit2.ts) and FAILS.
 * After single-sourcing (permit2.ts imports the shared function instead
 * of redefining it) exactly one definition remains and this PASSES. A
 * future contributor who re-adds a local copy — in permit2.ts or
 * anywhere else — trips this immediately instead of silently drifting.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";

describe("#780 — lookupKnownSpender is single-sourced", () => {
  it("exactly one `function lookupKnownSpender(` definition exists under src/", () => {
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}${e.name}`;
        if (e.isDirectory()) walk(`${p}/`);
        else if (e.name.endsWith(".ts")) tsFiles.push(p);
      }
    };
    walk(srcDir);

    // Matches both `function lookupKnownSpender(` and the exported form
    // `export function lookupKnownSpender(` — the `export` keyword is
    // optional in the pattern, not a second definition.
    const defRe = /\bfunction\s+lookupKnownSpender\s*\(/;
    const definitions: string[] = [];
    for (const f of tsFiles) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (defRe.test(line)) definitions.push(`${f}:${i + 1}: ${line.trim()}`);
        });
    }

    expect(definitions, definitions.join("\n")).toHaveLength(1);
    expect(definitions[0]).toMatch(/known-spenders\.ts:/);
  });

  it("permit2.ts imports the shared lookupKnownSpender rather than defining its own", () => {
    const src = readFileSync(
      new URL("../src/modules/allowances/permit2.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(
      /import\s*\{\s*lookupKnownSpender\s*\}\s*from\s*["']\.\.\/\.\.\/security\/known-spenders\.js["']/,
    );
  });
});
