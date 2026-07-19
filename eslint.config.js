// Minimal ESLint flat config — issue #714 / ARCHITECTURE.md §4 INV-T1.
//
// This config exists for exactly ONE rule: ban a bare `fetch(`, a bare
// `globalThis.fetch` / `window.fetch` member reference, in `src/**`. Every
// outbound HTTP call in this repo must route through `fetchWithTimeout`
// (src/data/http.ts) so a stalled/malicious upstream can't hang the process
// indefinitely (#706). This is deliberately NOT `eslint:recommended` or any
// broad ruleset — that would surface hundreds of unrelated pre-existing
// findings and blow up this unit's scope. Do not add rules here without a
// tracked issue driving them.
//
// Node-version note (#714 review nit): eslint@^10's own engine floor
// (^20.19.0 || ^22.13.0 || >=24, see its package.json) is HIGHER than this
// repo's package.json `engines.node` (>=18.17.0) — a contributor on Node
// 18.17-20.18 can install fine but can't run `npm run lint` locally. CI's
// Node 20/22 matrix already satisfies eslint's floor. Don't lower
// package.json's `engines.node` to "fix" this — that's a breaking change
// for the runtime target, unrelated to the dev-only lint tool's floor.
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

const NO_BARE_FETCH_MESSAGE =
  "Bare `fetch` is banned outside src/data/http.ts. Route network calls through " +
  "`fetchWithTimeout` (src/data/http.ts) so every outbound call carries an " +
  "AbortController-backed timeout — see ARCHITECTURE.md §4 INV-T1 / issue #714.";

/** @type {import("eslint").Linter.Config[]} */
export default [
  {
    ignores: ["dist/**", "node_modules/**", "release/**", "coverage/**"],
  },
  {
    files: ["src/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: "module",
      },
    },
    // Registered so ESLint recognizes rule IDs the codebase's pre-existing
    // `// eslint-disable-next-line @typescript-eslint/...` comments reference
    // (written in anticipation of a TS lint setup that didn't exist until
    // this issue). None of the plugin's rules are enabled below — adopting
    // its ruleset is explicitly out of scope for #714 (one targeted rule
    // only). Without this registration those comments error as "Definition
    // for rule ... was not found" rather than the intended no-op.
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // Bans any bare reference to the global `fetch` identifier — covers
      // `fetch(...)` calls and any other reference (assignment, `typeof`,
      // re-export) that resolves to the platform global rather than a
      // locally-declared symbol of the same name.
      "no-restricted-globals": ["error", { name: "fetch", message: NO_BARE_FETCH_MESSAGE }],
      // `no-restricted-globals` only catches the bare identifier `fetch` —
      // it does NOT catch `globalThis.fetch` / `window.fetch` member access,
      // which is exactly the shape the `const f = fetchOverride ??
      // globalThis.fetch` test-seam idiom uses (ARCHITECTURE.md §4 INV-T1
      // calls this idiom out by name as something a substring grep can't
      // catch). Two selectors below close that gap.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='globalThis'][property.name='fetch']",
          message: NO_BARE_FETCH_MESSAGE,
        },
        {
          selector: "MemberExpression[object.name='window'][property.name='fetch']",
          message: NO_BARE_FETCH_MESSAGE,
        },
      ],
    },
  },
  {
    // The one sanctioned caller of the platform fetch — every other module
    // routes through its `fetchWithTimeout` wrapper.
    files: ["src/data/http.ts"],
    rules: {
      "no-restricted-globals": "off",
      "no-restricted-syntax": "off",
    },
  },
];
