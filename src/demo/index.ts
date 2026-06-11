/**
 * Demo / try-before-install mode.
 *
 * Two activation paths land in the same demo-mode state machine:
 *
 *   1. **Explicit env** (`VAULTPILOT_DEMO=true`, issue #371) — the
 *      original boot-time opt-in. Useful for CI / non-interactive
 *      contexts and as an "I really mean it" override.
 *   2. **Auto / fresh-install** (issue #391/#392 follow-up) — when the
 *      env var is unset AND no config file exists, the server boots
 *      into demo mode by default. The first install of vaultpilot-mcp
 *      can offer personas + simulated signing without the user editing
 *      `.claude.json` and restarting Claude Code.
 *
 * Two sub-modes coexist behind whichever gate fired:
 *
 *   - **Default demo** (no live wallet set): every read tool runs
 *     against real chain RPC, every signing-class tool refuses with a
 *     structured `[VAULTPILOT_DEMO]` error pointing at `set_demo_wallet`.
 *   - **Live demo** (`set_demo_wallet` called): a curated persona or
 *     custom address bundle is active. Reads + prepare_* / simulate_* /
 *     preview_* run real; only `send_transaction` is intercepted and
 *     returns a simulation envelope (no signing, no broadcast).
 *
 * Mode is **latched at boot**: once `initDemoMode()` runs, the auto-
 * detection result is frozen for the rest of the process. A user who
 * pairs a Ledger or runs `vaultpilot-mcp-setup` mid-session stays in
 * their initial mode until restart. This keeps the security boundary
 * crisp — a mode change requires off-process state (env mutation OR
 * config-file write) PLUS a process restart, mirroring the original
 * env-var commitment that an in-session prompt injection couldn't
 * touch.
 *
 * Live-wallet selection (`set_demo_wallet({ persona: ... })`) is the
 * ONE runtime transition allowed within demo mode. It only changes
 * sub-mode (default → live), never crosses the demo/real boundary.
 */

import {
  getLiveWallet,
  isLiveMode,
  setLivePersona,
  setLiveCellAddress,
  setLiveCustomAddresses,
  clearLiveWallet,
  type LiveWalletState,
} from "./live-mode.js";
import {
  PERSONAS,
  DEMO_WALLETS,
  DEMO_CHAINS,
  DEMO_TYPES,
  type Persona,
  type DemoCell,
  type DemoChain,
  type DemoType,
} from "./personas.js";
import { detectAutoDemoMode } from "./auto-detect.js";

/**
 * Latched auto-detection result. `null` = not yet initialized;
 * `true` = boot detected fresh-install state (no config); `false` =
 * config was present at boot, auto-demo is off.
 *
 * `null` is treated as `false` by `getDemoModeReason()` so a forgotten
 * `initDemoMode()` call fails closed (real mode), not open (auto-demo).
 * Tests that need the latched-true behavior call `initDemoMode()` (or
 * `_setAutoDemoForTests(true)`) explicitly.
 */
let autoDemoLatched: boolean | null = null;

/**
 * Run auto-detection once at boot and latch the result. Idempotent:
 * later calls in the same process are no-ops, so the latched value is
 * frozen for the process lifetime. Call this from the entry point
 * BEFORE registering tools so the first `isDemoMode()` evaluation
 * during tool dispatch sees the resolved state.
 */
export function initDemoMode(): void {
  if (autoDemoLatched !== null) return;
  autoDemoLatched = detectAutoDemoMode();
}

/**
 * `--demo` CLI alias. Lets users write `npx vaultpilot-mcp --demo`
 * instead of `claude mcp add ... --env VAULTPILOT_DEMO=true -- ...`.
 * MUST be called BEFORE `initDemoMode()` so the env mutation is
 * visible to `getDemoModeEnvState()`.
 *
 * Idempotency rules:
 *   - If `VAULTPILOT_DEMO` is already set (any value, including
 *     `"false"`), the explicit env wins. A `--demo` + `VAULTPILOT_DEMO=
 *     false` combination is ambiguous, so we honor the explicit opt-out
 *     rather than silently overriding it.
 *   - If `--demo` is absent, no-op.
 */
export function applyDemoCliFlag(argv: readonly string[]): void {
  if (!argv.includes("--demo")) return;
  if (process.env.VAULTPILOT_DEMO !== undefined) return;
  process.env.VAULTPILOT_DEMO = "true";
}

/**
 * Test-only: reset the latch so different test cases can simulate
 * different boot states. Production code MUST NOT call this.
 */
export function _resetAutoDemoLatchForTests(): void {
  autoDemoLatched = null;
}

/**
 * Test-only: directly set the latched value without going through disk
 * detection. Useful for tests that don't want to set up tmp config dirs.
 */
export function _setAutoDemoLatchForTests(value: boolean | null): void {
  autoDemoLatched = value;
}

/**
 * Per-session dedup for the demo-mode state-precondition hint
 * (issue #409). Once an agent has been told a given prepare_* tool's
 * failure might stem from "demo can't satisfy state-changing
 * prerequisites", repeating the hint on every retry of the same tool
 * is noise. The set is keyed by tool name so different prepare_*
 * tools each get their own one-shot.
 */
const statePreconditionHintEmittedFor = new Set<string>();

export function _resetStatePreconditionHintDedup(): void {
  statePreconditionHintEmittedFor.clear();
}

/**
 * Issue #409 — the agent-loop trap. When a prepare_* tool refuses
 * because of an on-chain state precondition (durable-nonce account
 * missing, ATA not yet created, allowance still 0 because the prior
 * approve was simulated, etc.), the agent walks the user through a
 * "fix" that's itself just another simulation, then re-runs the
 * original prepare_*, hits the same refusal, and loops.
 *
 * Demo mode `simulates` sends but doesn't mutate state — neither real
 * chain state nor a virtual overlay — so any flow whose preconditions
 * ARE state changes can't be rehearsed end-to-end. This helper emits
 * a one-shot advisory note alongside the underlying error so the
 * agent and user know: the failure might be the demo-mode wall, not
 * a bug to debug.
 *
 * Intentionally advisory (NOT assertive): some prepare_* failures in
 * demo mode are real (wrong arg, RPC outage, protocol pause). The
 * agent reads BOTH the original error and this hint and chooses.
 *
 * Returns null when:
 *   - demo mode is OFF (no need to surface),
 *   - the tool isn't a prepare_* (the loop class is specific to
 *     state-changing prepare flows),
 *   - we've already emitted the hint for this tool this session
 *     (dedup keeps it from being noise on retries).
 */
export function demoStatePreconditionHint(toolName: string): string | null {
  if (!isDemoMode()) return null;
  if (!toolName.startsWith("prepare_")) return null;
  if (statePreconditionHintEmittedFor.has(toolName)) return null;
  statePreconditionHintEmittedFor.add(toolName);
  return (
    `[VAULTPILOT_DEMO] If '${toolName}' failed because of an on-chain state ` +
    `precondition (e.g. durable-nonce account not initialized, ATA not yet ` +
    `created, allowance still zero because the prior approve was simulated), ` +
    `note that demo mode CANNOT satisfy state-changing prerequisites — ` +
    `simulated sends don't mutate real chain state or a virtual demo overlay. ` +
    `Walking the user through "do step 1 first" would loop because step 1's ` +
    `simulation also doesn't land on chain. To rehearse this multi-step flow ` +
    `end-to-end: leave demo (set VAULTPILOT_DEMO=false in the MCP client config ` +
    `or run \`vaultpilot-mcp-setup\` and restart) and use a wallet whose ` +
    `precondition is already met on real chain. Demo mode remains useful for ` +
    `single-step flows (one-shot swap / send / supply on a fresh wallet). ` +
    `If the error is unrelated (wrong arg, protocol pause, RPC issue), ignore ` +
    `this hint. Surfaced once per (tool, session).`
  );
}

/**
 * Why the server is (or isn't) in demo mode. Drives error-message
 * branching: an `auto-fresh-install` user gets pointed at
 * `vaultpilot-mcp-setup` as the leave path (since they have no env var
 * to unset), an `explicit-env` user gets pointed at `unset
 * VAULTPILOT_DEMO + restart`.
 */
export type DemoModeReason =
  | "explicit-env"        // VAULTPILOT_DEMO=true
  | "auto-fresh-install"  // env unset + no config at boot → auto-demo on
  | "explicit-opt-out"    // VAULTPILOT_DEMO=false (deliberate real mode)
  | "invalid-env"         // env set to something other than true/false (#392)
  | "off";                // env unset + config present at boot

export function getDemoModeReason(): DemoModeReason {
  const envState = getDemoModeEnvState();
  if (envState === "enabled") return "explicit-env";
  if (envState === "disabled") return "explicit-opt-out";
  if (envState === "invalid") return "invalid-env";
  // env unset → auto-detection branch.
  if (autoDemoLatched === true) return "auto-fresh-install";
  return "off";
}

/**
 * True when the server is in demo mode for any reason (explicit env or
 * auto-detected fresh install). Read at tool-call time so tests can
 * flip the latched state via `_setAutoDemoLatchForTests`.
 *
 * Note: `invalid-env` (e.g. VAULTPILOT_DEMO=1) does NOT auto-fall
 * through to auto-demo even when config is absent. The user explicitly
 * tried to configure the env var; honoring that signal — by NOT
 * auto-flipping into demo — keeps the behavior predictable, and the
 * `get_demo_wallet` message tells them their literal was wrong.
 */
export function isDemoMode(): boolean {
  const reason = getDemoModeReason();
  return reason === "explicit-env" || reason === "auto-fresh-install";
}

/**
 * Four-state classifier for the VAULTPILOT_DEMO env var.
 *
 * The strict literal `=== "true"` gate is intentional — boot-time env
 * vars are the only safe place to flip demo mode (an in-session prompt
 * injection can't mutate them), and a sloppy truthy parse would expand
 * the surface for accidentally-on demo. The cost of strictness is that
 * `VAULTPILOT_DEMO=1` silently behaved as "unset" pre-#392, which
 * sent users down the wrong debugging path. Splitting "unset" /
 * "disabled" / "invalid" / "enabled" lets the response message tell
 * the user which mistake they made.
 *
 * `disabled` (env=false) is the auto-demo escape hatch — a user who
 * wants real mode on a fresh install (no config yet) sets this to
 * suppress the auto-detection.
 */
export type DemoModeEnvState = "enabled" | "disabled" | "invalid" | "unset";

export function getDemoModeEnvState(): DemoModeEnvState {
  const value = process.env.VAULTPILOT_DEMO;
  if (value === undefined) return "unset";
  if (value === "true") return "enabled";
  if (value === "false") return "disabled";
  return "invalid";
}

/**
 * Sanitize the env-var value for echo-back in the `get_demo_wallet`
 * response. Caps at 32 chars and replaces ASCII control characters
 * with `?`. The env var is arbitrary user-supplied input — an attacker
 * who can set the environment can already do worse, but the JSON
 * response shouldn't relay control bytes downstream where some logger
 * or chat renderer might mis-interpret them.
 */
export function redactInvalidDemoEnvValue(raw: string): string {
  // eslint-disable-next-line no-control-regex
  const stripped = raw.replace(/[\x00-\x1F\x7F]/g, "?");
  if (stripped.length <= 32) return stripped;
  return stripped.slice(0, 29) + "...";
}

interface PersonaSummary {
  id: Persona["id"];
  description: Persona["description"];
  addresses: Persona["addresses"];
}

/**
 * Build the `get_demo_wallet` response. Pure function (no I/O beyond
 * reading env + the in-process live-wallet state) so it's directly
 * unit-testable and the registered handler in `src/index.ts` stays a
 * one-liner.
 *
 * Issue #392 contract: personas are ALWAYS returned (regardless of
 * env state) so an agent can offer the user a choice without first
 * asking them to set an env var blind. When demo isn't active, the
 * message tells the user which mistake they made (env unset vs. set
 * to something other than the literal `"true"`).
 */
/**
 * Compact 2D matrix view surfaced in the response. Each chain row
 * carries a per-type record where present cells expose the address +
 * archetype + verifiedAt; null cells are explicitly null so the agent
 * can see "no curated address for this combination" without guessing.
 */
export type DemoMatrixView = {
  [C in DemoChain]: { [T in DemoType]: DemoCell | null };
};

function buildMatrixView(): DemoMatrixView {
  const out = {} as DemoMatrixView;
  for (const chain of DEMO_CHAINS) {
    out[chain] = {} as Record<DemoType, DemoCell | null>;
    for (const type of DEMO_TYPES) {
      out[chain][type] = DEMO_WALLETS[chain][type] ?? null;
    }
  }
  return out;
}

export type GetDemoWalletResponse =
  | {
      demoActive: true;
      mode: "default" | "live";
      reason: "explicit-env" | "auto-fresh-install";
      envState: DemoModeEnvState;
      active: LiveWalletState | null;
      matrix: DemoMatrixView;
      personas: PersonaSummary[];
    }
  | {
      demoActive: false;
      mode: null;
      reason: "explicit-opt-out" | "invalid-env" | "off";
      envState: DemoModeEnvState;
      message: string;
      matrix: DemoMatrixView;
      personas: PersonaSummary[];
    };

export function buildGetDemoWalletResponse(): GetDemoWalletResponse {
  const personas: PersonaSummary[] = Object.values(PERSONAS).map((p) => ({
    id: p.id,
    description: p.description,
    addresses: p.addresses,
  }));
  const matrix = buildMatrixView();
  const reason = getDemoModeReason();
  const envState = getDemoModeEnvState();
  if (reason === "explicit-env" || reason === "auto-fresh-install") {
    const live = getLiveWallet();
    return {
      demoActive: true,
      mode: live === null ? "default" : "live",
      reason,
      envState,
      active: live,
      matrix,
      personas,
    };
  }
  let message: string;
  if (reason === "explicit-opt-out") {
    message =
      "VAULTPILOT_DEMO is set to 'false' — server is in normal mode by " +
      "explicit opt-out (suppresses the auto-demo path that would " +
      "otherwise activate on a fresh install with no config file). The " +
      "personas below are listed for discovery; to enable demo mode, " +
      "either set `VAULTPILOT_DEMO=true` (exact literal, lowercase) or " +
      "unset the var entirely on a host with no `~/.vaultpilot-mcp/" +
      "config.json` (auto-demo). Restart Claude Code after either " +
      "change.";
  } else if (reason === "invalid-env") {
    const raw = process.env.VAULTPILOT_DEMO ?? "";
    const safe = redactInvalidDemoEnvValue(raw);
    message =
      `VAULTPILOT_DEMO is set to '${safe}' but the server expects the ` +
      `exact literal 'true' (or 'false' to explicitly opt out) — server ` +
      `is in normal mode. The personas below are listed for discovery. ` +
      `Common confusion: '1', 'yes', 'on', 'TRUE' are all rejected; ` +
      `only lowercase 'true' enables demo. Fix the value in the MCP ` +
      `client config and restart.`;
  } else {
    // reason === "off": env unset + config file detected at boot.
    // Auto-demo opted out structurally (the user has set up real-mode
    // already). Personas still listed for discovery.
    message =
      "VAULTPILOT_DEMO is unset and a user config was detected at boot — " +
      "server is in normal mode (auto-demo only fires on a fresh install " +
      "with no config). The personas below are listed for discovery; to " +
      "switch this session to demo, set `VAULTPILOT_DEMO=true` (exact " +
      "literal, lowercase) in the MCP client config and restart.";
  }
  return {
    demoActive: false,
    mode: null,
    reason,
    envState,
    message,
    matrix,
    personas,
  };
}

/**
 * Tools that are refused REGARDLESS of demo sub-mode. These either write
 * persistent state outside this process (Ledger pairing config, GitHub
 * issues) or require a real Ledger device (sign_message_*) — both
 * categories have no on-chain simulation equivalent. Keeps the contract
 * crisp: no Ledger? these never work in demo, ever.
 */
export function isAlwaysGatedTool(toolName: string): boolean {
  if (toolName.startsWith("pair_ledger_")) return true;
  if (toolName.startsWith("sign_message_")) return true;
  return ALWAYS_GATED_EXPLICIT.has(toolName);
}

const ALWAYS_GATED_EXPLICIT = new Set([
  "request_capability", // network write to GitHub via the proxy
]);

/**
 * Tools whose gating depends on the demo sub-mode. In default demo mode
 * (no live wallet set) these refuse with a structured error directing
 * the user to call `set_demo_wallet`. In live mode, prepare_* / preview_*
 * / simulate_* / verify_tx_decode run for real (read-only on-chain
 * simulation); only `send_transaction` is intercepted with a simulation
 * envelope.
 *
 * Pattern-matched so newly added prepare_* tools opt in automatically.
 */
export function isConditionallyGatedTool(toolName: string): boolean {
  if (toolName.startsWith("prepare_")) return true;
  return CONDITIONALLY_GATED_EXPLICIT.has(toolName);
}

const CONDITIONALLY_GATED_EXPLICIT = new Set([
  "send_transaction",
  "preview_send",
  "preview_solana_send",
  "verify_tx_decode",
  "get_verification_artifact",
]);

/**
 * The single tool whose live-mode behavior is "intercept + return a
 * simulation envelope" rather than "run the real handler". Every other
 * conditionally-gated tool runs real in live mode; broadcast is the
 * one thing we can never let through (would actually send funds).
 */
export function isBroadcastTool(toolName: string): boolean {
  return toolName === "send_transaction";
}

/**
 * Structured refusal for the always-gated set. Single source of truth so
 * the message is consistent across every blocked tool. Branches on
 * `getDemoModeReason()` so the leave-demo path matches how demo got
 * activated:
 *
 *   - explicit-env: "drop VAULTPILOT_DEMO from MCP-client config + restart client".
 *   - auto-fresh-install: "run vaultpilot-mcp-setup, restart, then pair"
 *     — there's no env var to unset; setup writes the config that turns
 *     auto-demo OFF on the next boot.
 */
export function alwaysGatedRefusalMessage(toolName: string): string {
  const reason = getDemoModeReason();
  const baseRefusal =
    `[VAULTPILOT_DEMO] '${toolName}' is unavailable in demo mode regardless of live-wallet ` +
    `state. This tool either writes persistent off-chain state (Ledger pairing, GitHub) or ` +
    `requires a real Ledger device — neither has an on-chain simulation equivalent. ` +
    `Ready to leave demo and use this for real? Call \`exit_demo_mode\` for a tailored ` +
    `step-by-step setup guide (asks about your Ledger + chain selection).`;
  if (reason === "auto-fresh-install") {
    return (
      baseRefusal +
      ` Auto-demo is on because no \`~/.vaultpilot-mcp/config.json\` was detected at boot — ` +
      `the leave path is to run \`npx -y -p vaultpilot-mcp vaultpilot-mcp-setup\` (writes a ` +
      `config), restart Claude Code, then pair your Ledger. Alternatively, set ` +
      `\`VAULTPILOT_DEMO=false\` in the MCP client config to explicitly opt out before pairing.`
    );
  }
  // explicit-env (or any unexpected reason — fail to the existing copy).
  return (
    baseRefusal +
    ` Otherwise: drop VAULTPILOT_DEMO from your MCP-client config and restart the client (e.g. Claude Code) with a real Ledger paired — restarting only the server process does not clear the env var, since the client re-launches the server with the same env on every reconnect.`
  );
}

/**
 * Map a `prepare_*` tool name to candidate `rehearsableFlows` IDs we
 * can search the matrix against. The matrix uses chain-agnostic flow
 * IDs (`native_send`, `aave_supply`, `marinade_stake`); tool names
 * encode the chain (`prepare_solana_native_send`, `prepare_aave_supply`,
 * `prepare_marinade_stake`). We strip the `prepare_` prefix and try
 * the bare form plus chain-prefix-stripped forms so most prepare tools
 * map cleanly. A miss just falls through to the "no persona matches"
 * branch in `defaultModeRefusalMessage`.
 */
function candidateFlowIds(toolName: string): string[] {
  if (!toolName.startsWith("prepare_")) return [];
  const tail = toolName.slice("prepare_".length);
  const set = new Set<string>([tail]);
  for (const prefix of ["solana_", "tron_", "btc_", "litecoin_"]) {
    if (tail.startsWith(prefix)) set.add(tail.slice(prefix.length));
  }
  return Array.from(set);
}

/**
 * Chain a `prepare_*` tool targets, derived from its name prefix.
 * EVM tools have no chain prefix (e.g. `prepare_aave_supply`,
 * `prepare_native_send`) and return null — those should match against
 * any chain. Returning a chain restricts the matrix search so e.g.
 * `prepare_solana_native_send` doesn't recommend `staking-maxi`
 * (which has no Solana cell) just because every EVM cell rehearses
 * `native_send`.
 */
function chainHintForTool(toolName: string): DemoChain | null {
  if (!toolName.startsWith("prepare_")) return null;
  const tail = toolName.slice("prepare_".length);
  if (tail.startsWith("solana_")) return "solana";
  if (tail.startsWith("tron_")) return "tron";
  if (tail.startsWith("btc_")) return "bitcoin";
  return null;
}

/**
 * Recommended personas for a given tool. A persona is recommended
 * when ANY of its curated cells (on the tool's chain, or any chain
 * if the tool has no chain prefix) lists a `rehearsableFlows` entry
 * matching one of the candidate flow IDs (exact match, or the cell's
 * flow starts with `<candidate>_` so `token_send` matches
 * `token_send_usdc` / `token_send_usdt`).
 *
 * The result is sorted by `DEMO_TYPES` order so the message reads
 * deterministically across runs.
 */
function recommendPersonasFor(toolName: string): DemoType[] {
  const candidates = candidateFlowIds(toolName);
  if (candidates.length === 0) return [];
  const chainHint = chainHintForTool(toolName);
  const chains: readonly DemoChain[] = chainHint ? [chainHint] : DEMO_CHAINS;
  const matched = new Set<DemoType>();
  for (const chain of chains) {
    for (const type of DEMO_TYPES) {
      const cell = DEMO_WALLETS[chain][type];
      if (!cell) continue;
      const hit = cell.rehearsableFlows.some((flow) =>
        candidates.some((c) => flow === c || flow.startsWith(c + "_")),
      );
      if (hit) matched.add(type);
    }
  }
  return DEMO_TYPES.filter((t) => matched.has(t));
}

/**
 * Structured refusal for conditionally-gated tools when no live wallet
 * is set. Points the user at `set_demo_wallet` so the upgrade path is
 * discoverable from the error itself.
 *
 * Message branches on persona-affinity (issue #371 follow-up #7): if
 * one persona's curated state matches the requested flow, recommend it
 * specifically rather than dumping the full list. Sourced from the
 * persona matrix's `rehearsableFlows`, so refreshing the matrix
 * automatically updates the recommendations — no separate table to
 * keep in sync.
 */
export function defaultModeRefusalMessage(toolName: string): string {
  const recommended = recommendPersonasFor(toolName);
  const allPersonas = DEMO_TYPES.map((t) => `\`${t}\``).join(", ");
  let recommendation: string;
  if (recommended.length === 1) {
    const others = DEMO_TYPES.filter((t) => t !== recommended[0])
      .map((t) => `\`${t}\``)
      .join(", ");
    recommendation =
      `Recommended persona: \`${recommended[0]}\` — its curated wallet's on-chain ` +
      `state already supports this flow end-to-end. ` +
      `Other personas: ${others}.`;
  } else if (recommended.length > 1 && recommended.length < DEMO_TYPES.length) {
    recommendation =
      `Recommended personas: ${recommended.map((p) => `\`${p}\``).join(", ")}. ` +
      `Other personas (${DEMO_TYPES.filter((t) => !recommended.includes(t))
        .map((t) => `\`${t}\``)
        .join(", ")}) don't have on-chain state for this specific flow.`;
  } else if (recommended.length === DEMO_TYPES.length) {
    recommendation = `Available personas: ${allPersonas}.`;
  } else {
    recommendation =
      `Available personas: ${allPersonas}. Note: no persona's curated wallet ` +
      `currently has on-chain state matching this specific flow, so the prepare ` +
      `may fail with a state-precondition error. To rehearse this flow end-to-end, ` +
      `leave demo via \`exit_demo_mode\` and pair a wallet whose state supports it.`;
  }
  return (
    `[VAULTPILOT_DEMO] '${toolName}' requires an active demo wallet — call ` +
    `\`set_demo_wallet({ persona: "<id>" })\` first to enable the simulated transaction ` +
    `flow. ${recommendation} ` +
    `In default demo mode (no live wallet), only read tools and \`set_demo_wallet\` work — ` +
    `signing-class tools refuse to avoid any chance of fake-signing or fake-broadcasting. ` +
    `If you'd rather leave demo entirely and use this tool against your real wallet, call ` +
    `\`exit_demo_mode\` for a step-by-step setup guide.`
  );
}

/**
 * Build the simulation envelope returned in place of a real broadcast
 * receipt. Visually distinct from a real send_transaction response:
 * `outcome: "simulated"` flag, no `txHash` field (only `simulatedTxHash`),
 * and a verbatim-relayable `message` directing the user that nothing
 * actually went on-chain.
 *
 * Caller is responsible for re-running `simulate_transaction` on the
 * unsigned tx and passing the result in — keeping the envelope construction
 * pure makes it easy to test independently of the simulation surface.
 */
export interface SimulationEnvelope {
  demo: true;
  outcome: "simulated";
  toolName: string;
  unsignedTxHandle: string;
  simulatedTxHash: string;
  simulation: unknown;
  preview: unknown;
  message: string;
}

export function buildSimulationEnvelope(args: {
  toolName: string;
  unsignedTxHandle: string;
  simulationResult: unknown;
  pinnedPreview?: unknown;
}): SimulationEnvelope {
  const simulatedTxHash = makeSimulatedTxHash(args.unsignedTxHandle);
  return {
    demo: true,
    outcome: "simulated",
    toolName: args.toolName,
    unsignedTxHandle: args.unsignedTxHandle,
    simulatedTxHash,
    simulation: args.simulationResult,
    preview: args.pinnedPreview ?? null,
    message:
      `[VAULTPILOT_DEMO] This transaction was NOT broadcast. The simulation field above ` +
      `shows the on-chain effect that would have occurred against the live demo wallet. ` +
      `simulatedTxHash is a deterministic placeholder derived from the unsigned-tx handle ` +
      `(prefix: 0xdemo) — it is not a real transaction hash and will return 'unknown' from ` +
      `any block explorer. To execute for real: drop VAULTPILOT_DEMO from your MCP-client ` +
      `config and restart the client (e.g. Claude Code) with a real Ledger paired, then ` +
      `re-run the prepare → preview → send flow.`,
  };
}

/**
 * Markdown narrative for the simulation envelope. Mirrors the
 * `renderVerificationBlock` / `renderPrepareReceiptBlock` pattern used
 * by the real broadcast path: agents need a verbatim-relayable
 * paragraph they can show the user without re-decoding the JSON
 * `simulation` field. Best-effort summary of the simulation outcome —
 * `simulation` is `unknown` because different chains return different
 * shapes (viem's `{ status }`, our `{ simulationDeferredToPreview }`
 * for Solana, our `{ simulationFailed | simulationSkipped, reason }`
 * for the unhandled-handle paths). The renderer pattern-matches the
 * shapes we know and falls back to "see `simulation` field" otherwise.
 */
export function renderSimulationEnvelopeBlock(envelope: SimulationEnvelope): string {
  const status = summarizeSimulationStatus(envelope.simulation);
  const lines: string[] = [];
  lines.push("**[VAULTPILOT_DEMO] Simulated broadcast — nothing on-chain**");
  lines.push("");
  lines.push(`- **Tool:** \`${envelope.toolName}\``);
  lines.push(`- **Handle:** \`${envelope.unsignedTxHandle}\``);
  lines.push(
    `- **Placeholder hash:** \`${envelope.simulatedTxHash}\` (not real — block explorers return "unknown")`,
  );
  lines.push(`- **Simulation:** ${status}`);
  lines.push("");
  lines.push(
    "To execute for real: drop `VAULTPILOT_DEMO` from your MCP-client config and restart the client (e.g. Claude Code) with a real Ledger paired, then re-run the prepare → preview → send flow.",
  );
  return lines.join("\n");
}

function summarizeSimulationStatus(simulation: unknown): string {
  if (simulation === null || simulation === undefined) {
    return "no simulation result attached";
  }
  if (typeof simulation !== "object") {
    return `see \`simulation\` field (raw: ${typeof simulation})`;
  }
  const obj = simulation as Record<string, unknown>;
  if (obj.simulationDeferredToPreview === true) {
    return "validated at `preview_solana_send` time (Solana pre-sign sim)";
  }
  if (obj.simulationFailed === true) {
    return `failed — ${formatReason(obj.reason)}`;
  }
  if (obj.simulationSkipped === true) {
    return `skipped — ${formatReason(obj.reason)}`;
  }
  if (obj.status === "success" || obj.ok === true) {
    return "would succeed";
  }
  if (obj.status === "reverted" || obj.status === "failure") {
    const reason = obj.revertReason ?? obj.error ?? obj.reason;
    return `would revert${reason ? ` — ${formatReason(reason)}` : ""}`;
  }
  return "see `simulation` field for details";
}

function formatReason(reason: unknown): string {
  if (typeof reason === "string") {
    return reason.length > 200 ? reason.slice(0, 197) + "..." : reason;
  }
  return "see `simulation` field";
}

/**
 * Deterministic placeholder hash for the simulated-broadcast envelope.
 * Prefixed `0xdemo` so an agent or downstream tool can pattern-match
 * "this is not a real tx hash" before pasting it into Etherscan.
 */
function makeSimulatedTxHash(handle: string): string {
  const seed = String(handle).slice(0, 32).padEnd(32, "0").replace(/[^a-zA-Z0-9]/g, "0");
  // 64-hex-char body after the 0xdemo prefix would be 64 chars; we use
  // `0xdemo` (6 chars) + 58 chars derived from the handle to stay
  // visually-recognizable while keeping a fixed length.
  return `0xdemo${seed}${"0".repeat(58 - seed.length)}`;
}

/**
 * Used by the setup wizard to refuse writing real config when the user
 * is experimenting under explicit demo mode. Auto-demo (fresh-install
 * with no config) explicitly ALLOWS setup — running setup IS the
 * canonical way to leave auto-demo, and refusing here would create a
 * deadlock for a brand-new user.
 *
 *   - explicit-env (`VAULTPILOT_DEMO=true`): refuse. The user is
 *     deliberately in evaluation mode; silently writing pairing state
 *     to disk is the foot-gun this guard exists to catch.
 *   - auto-fresh-install (env unset, no config): allow. This is the
 *     intended progression: fresh install → auto-demo → run setup →
 *     restart → real mode.
 */
export function assertNotDemoForSetup(): void {
  if (getDemoModeReason() === "explicit-env") {
    throw new Error(
      "[VAULTPILOT_DEMO] Setup is disabled when VAULTPILOT_DEMO=true is explicitly set — " +
        "running `vaultpilot-mcp-setup` would write a real config (pairing state, indexer " +
        "URLs) to disk while the server is operating in evaluation mode. Unset " +
        "VAULTPILOT_DEMO and re-run setup. (Auto-demo on a fresh install does NOT block " +
        "setup — running setup IS the way out of auto-demo.)",
    );
  }
}

// Re-export live-mode + matrix primitives so consumers can
// `import { ... } from "./demo/index.js"` for everything demo-related
// (one entry point).
export {
  getLiveWallet,
  isLiveMode,
  setLivePersona,
  setLiveCellAddress,
  setLiveCustomAddresses,
  clearLiveWallet,
  type LiveWalletState,
};
export {
  DEMO_WALLETS,
  DEMO_CHAINS,
  DEMO_TYPES,
  type DemoCell,
  type DemoChain,
  type DemoType,
};
