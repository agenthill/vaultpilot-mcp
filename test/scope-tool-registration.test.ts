/**
 * Issue #733 — curated-CORE default tool surface (ARCHITECTURE.md §6 R7).
 *
 * R7's criterion is a COUNT over the registered surface, so this has to see
 * every `registerTool(server, …)` call site, not a sample. Booting `main()` to
 * count real SDK registrations isn't available under vitest (`src/index.ts`
 * skips `main()` when `VITEST=true`), so this walks the call sites in the
 * source and applies the production `isToolEnabled` predicate to each name —
 * the same predicate `registerTool` consults on line 1. Every call site is
 * unconditional, at top level inside `main()`, so "accepted by isToolEnabled"
 * is exactly "registered". Parse strategy borrowed from
 * `test/presign-annotation-guard-735.test.ts`.
 *
 * FALSIFIER: pre-#733 the default surface is all 189 tools (families default
 * to all five, protocols to accept-all), so the `<= 72` bound and the
 * exact-set pin both go red.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const INDEX_TS = join(__dirname, "..", "src", "index.ts");

/** R7 (ARCHITECTURE.md §6): a fresh, unconfigured install registers ≤72 tools. */
const R7_MAX_DEFAULT_TOOLS = 72;

/** Every tool name passed to `registerTool(server, "<name>", …)`, sorted. */
function registeredToolNames(): string[] {
  const src = readFileSync(INDEX_TS, "utf8");
  const re = /registerTool\(\s*server\s*,\s*"([a-zA-Z0-9_]+)"/g;
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out.sort();
}

/**
 * Exact default-surface pin ("enumerates the exact default set", #733). A tool
 * whose name matches no `getToolScope` rule silently lands in the always-on
 * core bucket — this list turns that silence into a red test. A tool added on
 * purpose updates the list in the same PR; one that shows up unexpectedly is
 * the scope-tag leak the pin exists to catch (#726's shape).
 */
const DEFAULT_TOOL_SURFACE: string[] = [
  "add_contact", "build_incident_report", "check_contract_security",
  "check_permission_risks", "compare_yields", "estimate_staking_yield",
  "exit_demo_mode", "explain_tx", "generate_readonly_link", "get_coin_price",
  "get_contract_abi", "get_daily_briefing", "get_demo_wallet",
  "get_health_alerts", "get_ledger_device_info", "get_ledger_status",
  "get_lending_positions", "get_lp_positions", "get_market_incident_status",
  "get_nft_collection", "get_nft_history", "get_nft_listings",
  "get_nft_portfolio", "get_pnl_summary", "get_portfolio_diff",
  "get_portfolio_summary", "get_protocol_risk_score", "get_staking_positions",
  "get_staking_rewards", "get_swap_quote", "get_token_allowances",
  "get_token_balance", "get_token_metadata", "get_token_price",
  "get_transaction_history", "get_transaction_status", "get_tx_verification",
  "get_update_command", "get_vaultpilot_config_status",
  "get_verification_artifact", "import_readonly_token", "import_strategy",
  "list_contacts", "list_readonly_invites", "pair_ledger_live",
  "prepare_custom_call", "prepare_native_send", "prepare_revoke_approval",
  "prepare_swap", "prepare_token_approve", "prepare_token_send",
  "prepare_weth_unwrap", "preview_send", "read_contract", "remove_contact",
  "request_capability", "resolve_ens_name", "resolve_token",
  "reverse_resolve_ens", "revoke_readonly_invite", "send_transaction",
  "set_demo_wallet", "set_etherscan_api_key", "share_strategy",
  "simulate_position_change", "simulate_transaction", "verify_contacts",
  "verify_ledger_attestation", "verify_ledger_firmware",
  "verify_ledger_live_codesign", "verify_tx_decode",
];

describe("default tool surface — curated-CORE flip (#733, R7)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it(`registers <= ${R7_MAX_DEFAULT_TOOLS} tools, matching the pinned set, with both env vars unset`, async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { isToolEnabled } = await import("../src/config/scope.js");
    const names = registeredToolNames();
    // Extraction sanity: a broken regex or a renamed wrapper would make every
    // assertion here vacuously green. 189 unique call sites today.
    expect(names.length).toBeGreaterThan(150);
    expect(new Set(names).size).toBe(names.length);
    const enabled = names.filter((n) => isToolEnabled(n));
    expect(enabled.length).toBeLessThanOrEqual(R7_MAX_DEFAULT_TOOLS);
    expect(enabled).toEqual(DEFAULT_TOOL_SURFACE);
  });

  it("default surface is exactly core + EVM-family — nothing more, no core dropped", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { isToolEnabled, getToolScope } = await import("../src/config/scope.js");
    // Derived from getToolScope rather than the pinned list above, so it stays
    // honest even if someone "fixes" a red snapshot by pasting the new output.
    const names = registeredToolNames();
    const kept = names.filter((n) => isToolEnabled(n));
    const dropped = names.filter((n) => !isToolEnabled(n));
    expect(
      kept.filter((n) => {
        const s = getToolScope(n);
        return Boolean(s.protocol) || (s.family !== undefined && s.family !== "evm");
      }),
    ).toEqual([]);
    // Fund-safety direction: a chain-agnostic core tool (`send_transaction`,
    // the contacts book, the Ledger verifiers) must never fall out.
    expect(
      dropped.filter((n) => {
        const s = getToolScope(n);
        return s.family === undefined && s.protocol === undefined;
      }),
    ).toEqual([]);
  });
});

describe("explicit `all` config restores the full surface (#733 parity)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("VAULTPILOT_CHAIN_FAMILIES=all + VAULTPILOT_PROTOCOLS=all registers every tool", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "all");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "all");
    const { isToolEnabled } = await import("../src/config/scope.js");
    const all = registeredToolNames();
    expect(all.filter((n) => isToolEnabled(n))).toEqual(all);
    // The default surface is a strict subset of this one.
    expect(all.length).toBeGreaterThan(DEFAULT_TOOL_SURFACE.length);
    for (const name of DEFAULT_TOOL_SURFACE) expect(all).toContain(name);
  });
});
