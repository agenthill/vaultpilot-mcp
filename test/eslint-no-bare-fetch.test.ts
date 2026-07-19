import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Falsifier for issue #714 / ARCHITECTURE.md §4 INV-T1: proves the
 * `eslint.config.js` no-bare-fetch rule is actually live, not just present
 * in a config file nobody runs. Drives the real ESLint engine (the repo's
 * `eslint.config.js`, loaded via cwd) against small in-memory snippets —
 * never a mocked linter — so a broken/misconfigured rule shows up here
 * before it reaches `npm run lint` or CI.
 *
 * Four snippets, each linted under a `filePath` that puts it in- or
 * out-of-scope for the src/data/http.ts override:
 *  - a bare `fetch(...)` call outside http.ts               -> must flag
 *  - a `globalThis.fetch` member reference outside http.ts  -> must flag
 *  - a `window.fetch` member reference outside http.ts      -> must flag
 *  - the same bare `fetch(...)` call INSIDE http.ts          -> must NOT flag
 */

const BARE_FETCH_SNIPPET = `export async function callOut(url: string): Promise<Response> {
  return await fetch(url);
}
`;

const GLOBALTHIS_FETCH_SNIPPET = `export async function callOut(url: string): Promise<Response> {
  const f = globalThis.fetch;
  return await f(url);
}
`;

const WINDOW_FETCH_SNIPPET = `export async function callOut(url: string): Promise<Response> {
  const f = window.fetch;
  return await f(url);
}
`;

const FETCH_RULE_IDS = new Set(["no-restricted-globals", "no-restricted-syntax"]);

function fetchRelatedMessages(messages: ESLint.LintResult["messages"]) {
  return messages.filter((m) => m.ruleId !== null && FETCH_RULE_IDS.has(m.ruleId));
}

describe("eslint no-bare-fetch rule (#714)", () => {
  it("RED: bare `fetch(...)` outside src/data/http.ts is flagged", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(BARE_FETCH_SNIPPET, {
      filePath: "src/modules/example/not-http.ts",
    });
    const flagged = fetchRelatedMessages(result.messages);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.ruleId).toBe("no-restricted-globals");
  });

  it("RED: `globalThis.fetch` outside src/data/http.ts is flagged (the aliasing idiom substring grep can't catch)", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(GLOBALTHIS_FETCH_SNIPPET, {
      filePath: "src/modules/example/not-http-alias.ts",
    });
    const flagged = fetchRelatedMessages(result.messages);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.ruleId).toBe("no-restricted-syntax");
  });

  it("RED: `window.fetch` outside src/data/http.ts is flagged (mirrors the globalThis.fetch selector — nit-4)", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(WINDOW_FETCH_SNIPPET, {
      filePath: "src/modules/example/not-http-window.ts",
    });
    const flagged = fetchRelatedMessages(result.messages);
    expect(flagged).toHaveLength(1);
    expect(flagged[0]?.ruleId).toBe("no-restricted-syntax");
  });

  it("GREEN: the identical bare `fetch(...)` call inside src/data/http.ts is allowed", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const [result] = await eslint.lintText(BARE_FETCH_SNIPPET, {
      filePath: "src/data/http.ts",
    });
    expect(fetchRelatedMessages(result.messages)).toHaveLength(0);
  });

  it("GREEN: the real src/data/http.ts file lints clean of fetch findings", async () => {
    const eslint = new ESLint({ cwd: process.cwd() });
    const results = await eslint.lintFiles(["src/data/http.ts"]);
    const flagged = results.flatMap((r) => fetchRelatedMessages(r.messages));
    expect(flagged).toHaveLength(0);
  });
});

/**
 * Falsifier for the CI gate's DIRECTORY discovery, not just the rule
 * (#714 review nit). Every test above proves the rule fires when ESLint is
 * pointed at a GIVEN file (`lintText`, or `lintFiles(["src/data/http.ts"])`)
 * — none of them prove the actual CI command works: `npm run lint` runs
 * `eslint src`, which discovers files by walking the `src` DIRECTORY and
 * matching the flat config's `files: ["src/**\/*.ts"]` glob. If that glob
 * ever regressed — typo'd pattern, an `ignores` entry widened to swallow
 * all of src/, `files` accidentally scoped to one subfolder — `eslint src`
 * would silently match zero files, exit 0, and the whole Lint CI gate
 * would become a green no-op with nothing above catching it.
 *
 * This drives the REAL `eslint.config.js`, unmodified, via
 * `overrideConfigFile`, against a disposable temp directory, and lints it
 * by DIRECTORY path (`lintFiles(["src"])`) — mirroring `eslint src`
 * exactly, never naming an explicit file. Passing `overrideConfigFile` as
 * an explicit path forces ESLint's `basePath` to equal `cwd` (verified
 * against `eslint`'s own `lib/config/config-loader.js#locateConfigFileToUse`
 * — `useConfigFile` as a string sets `basePath = cwd`, not the config
 * file's own directory), so the config's `files: ["src/**\/*.ts"]` pattern
 * resolves against the temp dir's `src/` subtree exactly as it resolves
 * against the repo's real `src/` when `cwd` is the repo root. That keeps
 * this test a faithful stand-in for the real CI command while never
 * writing into the actual src/ tree (avoiding the artifact/race risk of
 * planting a fixture there directly).
 */
describe("eslint src directory discovery (#714 nit)", () => {
  const REAL_CONFIG_FILE = join(process.cwd(), "eslint.config.js");

  function makeFixtureTree(): string {
    const root = mkdtempSync(join(tmpdir(), "eslint-src-discovery-"));
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    writeFileSync(join(root, "src", "nested", "violation.ts"), BARE_FETCH_SNIPPET);
    mkdirSync(join(root, "src", "clean"), { recursive: true });
    writeFileSync(join(root, "src", "clean", "ok.ts"), "export const ok = 1;\n");
    return root;
  }

  it("RED: directory discovery (`eslint src`-equivalent) finds and flags a violation nested under src/, and leaves a clean sibling untouched", async () => {
    const root = makeFixtureTree();
    try {
      const eslint = new ESLint({ cwd: root, overrideConfigFile: REAL_CONFIG_FILE });
      const results = await eslint.lintFiles(["src"]);

      // Directory discovery must have actually visited files. An empty
      // result set here — rather than a thrown error — is exactly the
      // silent-no-op failure mode this test exists to catch: assert on it
      // explicitly rather than relying on a later assertion to fail for
      // the same reason.
      expect(results.length).toBeGreaterThan(0);

      const flagged = results.flatMap((r) => fetchRelatedMessages(r.messages));
      expect(flagged.length).toBeGreaterThan(0);
      expect(flagged.some((m) => m.ruleId === "no-restricted-globals")).toBe(true);

      const cleanResult = results.find((r) =>
        r.filePath.endsWith(join("src", "clean", "ok.ts")),
      );
      expect(cleanResult).toBeDefined();
      expect(fetchRelatedMessages(cleanResult!.messages)).toHaveLength(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
