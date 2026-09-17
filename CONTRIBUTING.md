# Contributing

Real contributions from real people are very welcome. This document exists to filter the unreal kind.

## Before opening a PR

- **Sign the [CLA](./CLA.md).** The CLA Assistant bot prompts you on your first PR — one signature covers all future contributions.
- **Read [CLAUDE.md](./CLAUDE.md).** It documents the worktree-per-feature rule, the PR-based workflow, the chat-output conventions, and the security posture this repo cares about.
- **Run the tests.** `npm install && npm run build && npx vitest run`. PRs that don't keep the suite green won't be reviewed.
- **Use a worktree, not the main checkout.** `.claude/worktrees/<short-name>` per feature. Multiple agents share this repo and race on the index otherwise.

## What kinds of PRs land

Bug fixes against an open issue, small focused features matching an existing tracked plan, test or doc improvements, and dependency upgrades that pass the existing checks. PRs that touch fewer than ~500 lines, do one thing, and come with tests have the highest land rate.

## What kinds of comments and PRs are off-topic

Tracking issues (tagged for design discussion or roadmap follow-up, not work-ready scope) are **not bounty surfaces**. Unsolicited "I have experience with X, want me to build this?" comments will be hidden. Same for drive-by PRs from automated bounty-fishing pipelines: templated credentials, verbatim restate of the issue's own decisions table, "let me know if you'd like a PR" closer.

The filter is on the bot pattern, not on new contributors. To contribute on a tracking issue, either open a small focused PR against an actual bug first (signal that you understand the codebase) or ask a specific clarifying question that shows you read the issue and the linked code — pick an open decision and propose a defensible answer.

## Checking LiFi destination IDs

After building, run `npm run verify:lifi-chain-ids` for the optional online
check. It fetches and decodes live quotes for every destination in
`src/modules/swap/lifi-chain-ids.ts`, checks each emitted bridge/chain-ID pair,
and fails if a quote is unavailable or an accepted ID is not observed. Run it
periodically and whenever changing the table; the normal unit suite is offline.
It uses public test addresses and only fetches quotes.

TRON uses `728126428` in LiFi API requests and `1885080386571452` in on-chain
`BridgeData`. The latter is independently defined in
[LiFiData.sol](https://github.com/lifinance/contracts/blob/8da9776d194b8e83894ea5746c059dfb8f0457f6/src/Helpers/LiFiData.sol).
The destination gate compares against the user-requested chain for every bridge;
bridge names cannot waive the comparison. The live probes include NEAR to
Arbitrum and Symbiosis to TRON to check this distinction.

## Testing demo mode locally

Demo mode runs the server without RPC keys, Ledger pairing, or a config file:

```bash
VAULTPILOT_DEMO=true node dist/index.js
```

Or wire it into a local Claude Code session:

```bash
claude mcp add vaultpilot-mcp-dev --env VAULTPILOT_DEMO=true -- node /absolute/path/to/vaultpilot-mcp/dist/index.js
```

Useful when changing `src/demo/`, the `prepare_*` refusal/simulation paths, or `buildSimulationEnvelope` — unit tests cover contract correctness, but the agent-UX class of regressions (persona drift, simulation envelope readability, nudge timing) only surface in a live walkthrough.

## Reporting security issues

Do **not** open a public issue for vulnerabilities. See [SECURITY.md](./SECURITY.md) for the disclosure process.
