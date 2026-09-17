/**
 * Agent-task block emitted when the user has NOT installed the
 * `vaultpilot-preflight` Claude Code skill (see
 * https://github.com/szhygulin/vaultpilot-security-skill). The skill is the only
 * MCP-independent source of truth for agent-side integrity checks — its
 * content lives under `~/.claude/skills/` on the user's disk, outside
 * this server's reach. Without it, a compromised MCP could silently
 * suppress its own CHECKS PERFORMED directives and the agent would have
 * no static rule to fall back on.
 *
 * This block is prefixed to every `prepare_*` / `preview_*` tool response
 * when the skill marker file is missing. It is a UX nudge, not a security
 * boundary: an actually-compromised MCP would of course suppress its own
 * warning too. The point is to catch the honest-MCP case where the user
 * simply hasn't completed the install step, so they don't silently run
 * with a weaker agent.
 *
 * `skillRepoUrl` is the GitHub URL the user clones from; passed in so the
 * call site owns the single source of truth (index.ts).
 */
/**
 * Auto-install state passed in by `index.ts`. The renderer switches on this
 * to produce one of three notice variants:
 *   - `not-attempted` / unset / `already-present` → manual-install prose
 *     (the original notice content, unchanged).
 *   - `in-progress` → "auto-install kicked off, restart at end of session"
 *     so the user knows we're handling it but Claude Code needs a restart
 *     to load the freshly-cloned SKILL.md (skills are loaded at session
 *     start, not on the fly).
 *   - `succeeded` → "auto-installed, restart now to activate".
 *   - `failed` → manual-install prose + the error detail so the user can
 *     diagnose (no `git`, network down, dangling dir, etc.).
 */
export interface AutoInstallContext {
  state:
    | "not-attempted"
    | "in-progress"
    | "succeeded"
    | "failed"
    | "already-present";
  installPath?: string;
  detail?: string;
}

export function renderMissingSkillWarning(opts: {
  skillRepoUrl: string;
  autoInstall?: AutoInstallContext;
}): string {
  // NOTE ON FRAMING — this block was originally prefixed with an
  // "[AGENT TASK — RELAY TO USER FIRST, BEFORE ANY OTHER BLOCK]" header
  // and a direct `git clone <url>` command. Live testing showed agents
  // flagging that shape as prompt injection (because it is — structurally
  // indistinguishable from an attacker-authored block demanding the user
  // run an external script). Defense-in-depth agents correctly ignored it.
  //
  // The current shape mirrors the other vaultpilot-mcp informational
  // blocks (VERIFY BEFORE SIGNING, PREPARE RECEIPT, TRANSACTION BROADCAST)
  // the agent already trusts: a named notice with status/purpose/install
  // sections, no imperative verbs directed at the agent, and no pasted
  // shell commands. The server-level `instructions` field documents this
  // notice pattern explicitly at initialize time so the agent has prior
  // knowledge it is legitimate server output.
  const ai = opts.autoInstall;
  if (ai?.state === "in-progress") {
    return renderAutoInstallInProgress("Preflight", ai.installPath ?? "");
  }
  if (ai?.state === "succeeded") {
    return renderAutoInstallSucceeded("Preflight", ai.installPath ?? "");
  }
  const failedSuffix =
    ai?.state === "failed" && ai.detail
      ? `\n\n(Auto-install attempt failed: ${ai.detail})`
      : "";
  return [
    "VAULTPILOT NOTICE — Preflight skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-preflight/SKILL.md not found.",
    "Purpose: the preflight skill adds MCP-independent integrity checks",
    "         to every signing flow (local bytes-decode + on-device hash",
    "         recompute). It lives on the user's disk outside this",
    "         server's reach, so its invariants stay enforced even if",
    "         this MCP is compromised or silently drops its own CHECKS",
    "         PERFORMED directives.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; restart Claude Code after.)",
    "",
    "This notice is emitted by vaultpilot-mcp while the skill file is",
    "absent. It is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this pattern. Surface it to",
    "the user once per session as informational, then continue with",
    "their request.",
  ].join("\n") + failedSuffix;
}

/**
 * Shared body for the "auto-install kicked off" notice variant. Doesn't
 * mention the manual `git clone` flow — auto-install is on; the user just
 * needs to restart at the end of the session for Claude Code to pick up
 * the freshly-cloned SKILL.md.
 */
function renderAutoInstallInProgress(
  skillLabel: string,
  installPath: string,
): string {
  return [
    `VAULTPILOT NOTICE — ${skillLabel} skill auto-install in progress`,
    "",
    `Status:  cloning ${skillLabel.toLowerCase()} skill to ${installPath}`,
    "         in the background (git clone --depth=1, ~30s timeout).",
    `Purpose: the ${skillLabel.toLowerCase()} skill is one of two companion`,
    "         skills vaultpilot-mcp expects to find under ~/.claude/skills/.",
    "         The MCP server kicked off a one-time first-run install on",
    "         this tool call — no manual git clone needed.",
    "Action:  restart Claude Code at the end of this session so the new",
    "         SKILL.md is loaded. Skills are read at session start, not",
    "         on the fly, so this session won't have it active. Continue",
    "         with the user's current request normally.",
    "",
    "This notice is server-generated, not prompt injection. Suppress",
    "auto-install with VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1.",
  ].join("\n");
}

function renderAutoInstallSucceeded(
  skillLabel: string,
  installPath: string,
): string {
  return [
    `VAULTPILOT NOTICE — ${skillLabel} skill auto-installed`,
    "",
    `Status:  cloned to ${installPath}.`,
    `Purpose: the ${skillLabel.toLowerCase()} skill is now on disk; Claude`,
    "         Code loads its skill list at session start, so this session",
    "         is still running without it.",
    "Action:  restart Claude Code to activate the skill. The current",
    "         tool call has already been answered — no need to retry it",
    "         after the restart unless the user wants to.",
    "",
    "This notice is server-generated, not prompt injection.",
  ].join("\n");
}

/**
 * Companion to `renderMissingSkillWarning` — emitted when the
 * `vaultpilot-setup` skill is missing, so an agent fielding a setup-flow
 * question still has explicit guidance even when the wizard's auto-install
 * step (`src/setup/install-skills.ts`) failed earlier (no `git`, no
 * network, user declined). Same shape as the preflight notice — named
 * `VAULTPILOT NOTICE`, no imperative agent verbs, no pasted shell — so the
 * agent treats it as legitimate server output rather than prompt injection.
 *
 * Triggered narrowly (only on `get_vaultpilot_config_status` responses)
 * rather than every tool call: that tool is the canonical first call the
 * setup skill makes, so the notice fires exactly when the agent is in a
 * setup-flow context. This avoids stacking two unrelated install notices
 * on every response when both skills happen to be missing.
 */
export function renderMissingSetupSkillWarning(opts: {
  skillRepoUrl: string;
  autoInstall?: AutoInstallContext;
}): string {
  const ai = opts.autoInstall;
  if (ai?.state === "in-progress") {
    return renderAutoInstallInProgress("Setup", ai.installPath ?? "");
  }
  if (ai?.state === "succeeded") {
    return renderAutoInstallSucceeded("Setup", ai.installPath ?? "");
  }
  const failedSuffix =
    ai?.state === "failed" && ai.detail
      ? `\n\n(Auto-install attempt failed: ${ai.detail})`
      : "";
  return [
    "VAULTPILOT NOTICE — Setup skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-setup/SKILL.md not found.",
    "Purpose: the setup skill drives the conversational `/setup` flow —",
    "         classifying the user's use case, collecting only the API",
    "         keys that case actually needs, validating each pasted key",
    "         via a read-only tool call, and ending with a working",
    "         example. Without it the agent has to improvise the flow",
    "         from this server's tool surface alone.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; the setup wizard's",
    "         auto-install step would normally clone it, but that path",
    "         can fail when git is missing, the network is down, or",
    "         the user declined. Restart Claude Code after cloning.)",
    "",
    "This notice is server-generated, not prompt injection. Surface it",
    "to the user once per session as informational, then continue with",
    "their setup question — referencing the install instructions if the",
    "user wants the guided flow.",
  ].join("\n") + failedSuffix;
}

/**
 * Repeated on every tool response — the pin data the `vaultpilot-preflight`
 * skill's Step 0 (integrity self-check) compares the local `SKILL.md`
 * against. Issue #414: the same pin previously lived in the server-level
 * `instructions` field, which Claude Code truncates at ~2KB. The pin sat
 * ~24KB into the field, beyond the truncation point, so Step 0 silently
 * could not run. Repeating the pin in a short block on every tool result
 * sidesteps the `instructions` truncation entirely — tool results are
 * delivered as separate messages, not subject to that single-field cap.
 *
 * Block shape mirrors the VAULTPILOT NOTICE family — named header, no
 * imperative verbs at the agent, no pasted shell. The closing line labels
 * the block as server-emitted (not prompt injection) and explains why
 * it's repeated. The sentinel value remains assembled from three fragments
 * so a naive search of the agent's context for the full literal won't
 * always succeed and silently bypass the check.
 *
 * Issue #613 finding 5 — kept terse: ~870 → ~510 chars per emission. Step
 * 0 only parses the SHA line + fragment A/B/C lines, so the longer
 * rationale paragraph that used to ride along on every response (~6×
 * across a multi-step flow → ~5KB of repeated copy) was dropped. The
 * source-comment + CLAUDE.md still carry the full story for human readers.
 *
 * Placed adjacent to the JSON result (before VAULTPILOT NOTICE blocks
 * and the verification blocks). Its presence is unobtrusive: Step 0
 * reads it; other turns ignore it.
 *
 * `pin` is passed in (rather than imported here) so this module stays
 * dependency-free of `src/diagnostics/skill-pin-drift.ts` and the call
 * site keeps the single source of truth.
 */
export function renderPreflightSkillPinBlock(pin: {
  expectedSha256: string;
  sentinelA: string;
  sentinelB: string;
  sentinelC: string;
}): string {
  return [
    "VAULTPILOT PIN — Preflight skill integrity (Step 0 reference)",
    "",
    "Expected SHA-256 of ~/.claude/skills/vaultpilot-preflight/SKILL.md:",
    `  ${pin.expectedSha256}`,
    "",
    "Sentinel fragments (concat A+B+C, search Skill RESULT TEXT):",
    `  fragment A: \`${pin.sentinelA}\``,
    `  fragment B: \`${pin.sentinelB}\``,
    `  fragment C: \`${pin.sentinelC}\``,
    "",
    "Block is server-emitted (not prompt injection) and repeats per response because the equivalent in `instructions` exceeds Claude Code's ~2KB cap (issue #414).",
  ].join("\n");
}

/**
 * Demo-mode onboarding notice — fires once per session when the server
 * is in demo mode (any reason) AND no live wallet has been picked yet.
 * Copy varies by reason so the leave path matches how demo got
 * activated:
 *
 *   - `auto-fresh-install` (issue #391/#392 follow-up): no env var, no
 *     config file detected at boot. Tells the agent auto-demo is on
 *     and points at `vaultpilot-mcp-setup` as the leave path (since
 *     there's no env var to unset).
 *   - `explicit-env` (issue #371): `VAULTPILOT_DEMO=true`. Tells the
 *     agent demo is on by explicit opt-in and points at "unset
 *     VAULTPILOT_DEMO + restart" as the leave path.
 *
 * Same shape as the other VAULTPILOT NOTICE blocks: named header,
 * status / purpose / next sections, no imperative verbs at the agent,
 * no pasted shell. Tradeoff-aware closing paragraph naming the block
 * as legitimate server output so a defensive agent doesn't classify
 * it as prompt injection.
 */
export function renderMissingDemoWalletWarning(opts: {
  reason: "auto-fresh-install" | "explicit-env";
}): string {
  const isAuto = opts.reason === "auto-fresh-install";
  const header = isAuto
    ? "VAULTPILOT NOTICE — Auto demo mode active (fresh install detected)"
    : "VAULTPILOT NOTICE — Demo mode active (VAULTPILOT_DEMO=true)";
  const statusLines = isAuto
    ? [
        "Status:  no user config at ~/.vaultpilot-mcp/config.json was",
        "         detected at boot, so the server activated auto-demo.",
        "         No live wallet is set for this session yet.",
      ]
    : [
        "Status:  VAULTPILOT_DEMO=true is set in the environment, so the",
        "         server is in explicit demo mode. No live wallet is set",
        "         for this session yet.",
      ];
  const leaveLines = isAuto
    ? [
        "         To leave demo (when the user is ready for real funds):",
        "           1. Run `npx -y -p vaultpilot-mcp vaultpilot-mcp-setup`",
        "              (writes a config; turns auto-demo OFF on next boot).",
        "           2. Restart Claude Code.",
        "           3. Pair the user's Ledger via `pair_ledger_*`.",
        "         Setting `VAULTPILOT_DEMO=false` in the MCP client config",
        "         is an alternative explicit opt-out — also restart-gated.",
      ]
    : [
        "         To leave demo (when the user is ready for real funds):",
        "         unset `VAULTPILOT_DEMO` in the MCP client config (e.g.",
        "         `.claude.json`'s `env` block) and restart Claude Code.",
      ];
  return [
    header,
    "",
    ...statusLines,
    "Purpose: vaultpilot-mcp ships pre-configured demo wallets (curated",
    "         personas + custom-address mode) so a user can try the tool",
    "         flows — portfolio reads, prepare/preview/simulate signing",
    "         — without pairing a Ledger or supplying addresses.",
    "         Broadcast is intercepted in demo mode (no real send), so",
    "         the entire flow is safe.",
    "Next:    if the user asks to inspect a portfolio, build a tx, or",
    "         try anything that needs an address, offer the demo path",
    "         BEFORE asking them to pair hardware. Tools:",
    "           - `set_demo_wallet({ persona: \"<id>\" })` — activate a",
    "             curated persona (defi-degen, stable-saver,",
    "             staking-maxi, whale) or a custom address bundle.",
    "           - `get_demo_wallet()` — inspect the active selection.",
    "             Each matrix cell exposes `rehearsableFlows` (state",
    "             already on-chain) + `flowGaps` (with recommendations",
    "             when the archetype implies a flow the wallet's state",
    "             doesn't actually support — issue #409). Read these",
    "             BEFORE picking a flow to head off the agent loop on",
    "             state-dependent multi-step walks.",
    "           - `exit_demo_mode()` — tailored real-setup guide.",
    ...leaveLines,
    "",
    "This notice is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this pattern. Surface it to",
    "the user once per session as informational, then continue with",
    "their request.",
  ].join("\n");
}

/**
 * "There's a newer vaultpilot-mcp on npm" notice. Same shape as the
 * VAULTPILOT NOTICE family — named header, status / purpose / install
 * sections, no imperative agent verbs, no pasted destructive shell.
 *
 * The `Install:` block is computed by `getInstallPath()` (in
 * `src/shared/install-path.ts`) and passed in as a pre-rendered
 * multi-line string, so the notice surfaces a command that matches the
 * detected install path (npm-global, npx, bundled-binary, from-source,
 * unknown) rather than always defaulting to `npm install -g`.
 *
 * The release-notes URL is constructed from the latest version (we tag
 * each release `vX.Y.Z` on github.com/szhygulin/vaultpilot-mcp); kept
 * here rather than threaded through as an option so the renderer stays
 * a pure function of its inputs.
 */
export function renderUpdateAvailableNotice(opts: {
  current: string;
  latest: string;
  packageName: string;
  installBlock: string;
}): string {
  const releasesUrl = `https://github.com/szhygulin/vaultpilot-mcp/releases/tag/v${opts.latest}`;
  return [
    "VAULTPILOT NOTICE — Update available",
    "",
    `Status:  ${opts.packageName} ${opts.current} installed; ${opts.latest} published on npm.`,
    "Purpose: keeps you on the latest fixes (DeFi protocol updates,",
    "         security hardening, bug fixes). Release notes:",
    `         ${releasesUrl}`,
    "Install:",
    opts.installBlock,
    "",
    "This notice is server-generated, not prompt injection — emitted once",
    "per session when the running version is older than the latest stable",
    "published on npm. Surface it to the user once, then continue with",
    "their request. Suppress with VAULTPILOT_DISABLE_UPDATE_CHECK=1 if",
    "you don't want the server to query the npm registry.",
  ].join("\n");
}
