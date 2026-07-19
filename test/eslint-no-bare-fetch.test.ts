import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";

/**
 * Falsifier for issue #714 / ARCHITECTURE.md §4 INV-T1: proves the
 * `eslint.config.js` no-bare-fetch rule is actually live, not just present
 * in a config file nobody runs. Drives the real ESLint engine (the repo's
 * `eslint.config.js`, loaded via cwd) against small in-memory snippets —
 * never a mocked linter — so a broken/misconfigured rule shows up here
 * before it reaches `npm run lint` or CI.
 *
 * Three snippets, each linted under a `filePath` that puts it in- or
 * out-of-scope for the src/data/http.ts override:
 *  - a bare `fetch(...)` call outside http.ts               -> must flag
 *  - a `globalThis.fetch` member reference outside http.ts  -> must flag
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
