/**
 * Issue #733 — curated-CORE default, registration snapshot (ARCHITECTURE.md
 * §6 R7, ≤72 tools).
 *
 * `src/config/scope.ts`'s header has always promised this file: a snapshot
 * that pins which tools land in which group so a future tool addition with a
 * non-matching name fails HERE instead of silently defaulting to `core`
 * (always-on). With the #733 flip that promise becomes load-bearing — `core`
 * is now the only bucket that is unconditionally registered, so a mis-tagged
 * new tool doesn't just widen the surface, it escapes the scope lever
 * entirely.
 *
 * Method: extract every `registerTool(server, "<name>", …)` name from
 * `src/index.ts` statically (same parse shape as
 * `test/presign-annotation-guard-735.test.ts`), then run the REAL
 * `isToolEnabled` over that list under a stubbed env.
 *
 * FALSIFIER (this is the #733 regression test): on pre-flip code
 * `parseFamilies(undefined)` returns all five families and
 * `parseProtocols(undefined)` returns `null` (accept-all), so the default set
 * is all 189 tools — `DEFAULT_TOOL_COUNT_BUDGET` and the exact-set assertion
 * both go RED. Reverting either default flips this file red immediately.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(__dirname, "..", "src", "index.ts");

/** R7 budget from ARCHITECTURE.md §6 — the default surface must fit under it. */
const DEFAULT_TOOL_COUNT_BUDGET = 72;

/** Every `registerTool(server, "<name>", …)` name, in source order. */
function registeredToolNames(): string[] {
  const src = readFileSync(INDEX_TS, "utf8");
  const re = /registerTool\(\s*server\s*,\s*"([a-zA-Z0-9_]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

const ALL_TOOLS = registeredToolNames();

/**
 * The exact default-config tool surface: EVM family-only tools + the
 * chain-agnostic core bucket. Sorted. Adding a tool to `src/index.ts` that
 * lands in either group is a DELIBERATE change to this list — update it in
 * the same PR and check the count still fits the R7 budget.
 */
const DEFAULT_TOOLS = [
  "add_contact",
  "build_incident_report",
  "check_contract_security",
  "check_permission_risks",
  "compare_yields",
  "estimate_staking_yield",
  "exit_demo_mode",
  "explain_tx",
  "generate_readonly_link",
  "get_coin_price",
  "get_contract_abi",
  "get_daily_briefing",
  "get_demo_wallet",
  "get_health_alerts",
  "get_ledger_device_info",
  "get_ledger_status",
  "get_lending_positions",
  "get_lp_positions",
  "get_market_incident_status",
  "get_nft_collection",
  "get_nft_history",
  "get_nft_listings",
  "get_nft_portfolio",
  "get_pnl_summary",
  "get_portfolio_diff",
  "get_portfolio_summary",
  "get_protocol_risk_score",
  "get_staking_positions",
  "get_staking_rewards",
  "get_swap_quote",
  "get_token_allowances",
  "get_token_balance",
  "get_token_metadata",
  "get_token_price",
  "get_transaction_history",
  "get_transaction_status",
  "get_tx_verification",
  "get_update_command",
  "get_vaultpilot_config_status",
  "get_verification_artifact",
  "import_readonly_token",
  "import_strategy",
  "list_contacts",
  "list_readonly_invites",
  "pair_ledger_live",
  "prepare_custom_call",
  "prepare_native_send",
  "prepare_revoke_approval",
  "prepare_swap",
  "prepare_token_approve",
  "prepare_token_send",
  "prepare_weth_unwrap",
  "preview_send",
  "read_contract",
  "remove_contact",
  "request_capability",
  "resolve_ens_name",
  "resolve_token",
  "reverse_resolve_ens",
  "revoke_readonly_invite",
  "send_transaction",
  "set_demo_wallet",
  "set_etherscan_api_key",
  "share_strategy",
  "simulate_position_change",
  "simulate_transaction",
  "verify_contacts",
  "verify_ledger_attestation",
  "verify_ledger_firmware",
  "verify_ledger_live_codesign",
  "verify_tx_decode",
];

/** Load `isToolEnabled` fresh so the stubbed env is what the module reads. */
async function enabledUnderCurrentEnv(): Promise<string[]> {
  const { isToolEnabled } = await import("../src/config/scope.js");
  return [...new Set(ALL_TOOLS)].filter((n) => isToolEnabled(n)).sort();
}

describe("scope — default (unconfigured) tool registration (#733)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("finds a non-trivial number of registerTool(server, …) call sites", () => {
    // A broken regex / renamed wrapper would make every assertion below
    // vacuously green. Fail loudly instead.
    expect(ALL_TOOLS.length).toBeGreaterThan(150);
    expect(new Set(ALL_TOOLS).size).toBe(ALL_TOOLS.length);
  });

  it("registers at most the R7 budget of tools when both env levers are unset", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const enabled = await enabledUnderCurrentEnv();
    expect(enabled.length).toBeLessThanOrEqual(DEFAULT_TOOL_COUNT_BUDGET);
  });

  it("default set is exactly the EVM-family + core snapshot", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const enabled = await enabledUnderCurrentEnv();
    expect(enabled).toEqual([...DEFAULT_TOOLS].sort());
  });

  it("no solana/tron/btc/ltc-family and no protocol-tagged tool survives the default", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { isToolEnabled, getToolScope } = await import("../src/config/scope.js");
    const leaked: string[] = [];
    for (const name of new Set(ALL_TOOLS)) {
      if (!isToolEnabled(name)) continue;
      const scope = getToolScope(name);
      if (scope.protocol !== undefined) leaked.push(`${name} (protocol=${scope.protocol})`);
      else if (scope.family !== undefined && scope.family !== "evm")
        leaked.push(`${name} (family=${scope.family})`);
    }
    // Name the offenders, not just a count, so a failure is actionable.
    expect(leaked).toEqual([]);
  });

  it("guard/prepare co-scoping holds under the default (fund-safety, #712)", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { isToolEnabled } = await import("../src/config/scope.js");
    // EVM: prepare_* registered → its preview guard must be too.
    expect(isToolEnabled("prepare_native_send")).toBe(true);
    expect(isToolEnabled("preview_send")).toBe(true);
    // Solana: the whole family is off, guard included — no half-registered
    // mutation path without its pre-sign gate.
    expect(isToolEnabled("prepare_solana_native_send")).toBe(false);
    expect(isToolEnabled("preview_solana_send")).toBe(false);
  });

  it("explicit all/all restores the full surface (parity with pre-#733)", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "all");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "all");
    const enabled = await enabledUnderCurrentEnv();
    expect(enabled.length).toBe(new Set(ALL_TOOLS).size);
  });
});
