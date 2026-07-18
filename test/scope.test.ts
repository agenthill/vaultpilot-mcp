/**
 * Scope module — env-var parsing, family/protocol gating, prefix-derived
 * tool→scope mapping. The mapping table is the load-bearing piece: a typo
 * here silently moves a tool into core (always-on) and the user can't
 * narrow the surface anymore. The "every tool maps to a non-core scope
 * unless explicitly listed as core" assertion at the bottom is the
 * regression guard.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

describe("getToolScope — prefix-derived mapping", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it.each([
    // EVM, per-protocol
    ["prepare_aave_supply", "evm", "aave"],
    ["prepare_aave_borrow", "evm", "aave"],
    ["prepare_compound_supply", "evm", "compound"],
    ["get_compound_market_info", "evm", "compound"],
    ["get_compound_positions", "evm", "compound"],
    ["prepare_morpho_supply_collateral", "evm", "morpho"],
    ["get_morpho_positions", "evm", "morpho"],
    ["prepare_lido_stake", "evm", "lido"],
    ["prepare_lido_unstake", "evm", "lido"],
    ["prepare_eigenlayer_deposit", "evm", "eigenlayer"],
    ["prepare_uniswap_swap", "evm", "uniswap"],
    ["prepare_uniswap_v3_mint", "evm", "uniswap"],
    ["prepare_curve_add_liquidity", "evm", "curve"],
    ["get_curve_positions", "evm", "curve"],
    ["prepare_safe_tx_propose", "evm", "safe"],
    ["get_safe_positions", "evm", "safe"],
    ["submit_safe_tx_signature", "evm", "safe"],
    ["prepare_rocketpool_stake", "evm", "rocketpool"],
    // Solana, per-protocol
    ["prepare_marginfi_supply", "solana", "marginfi"],
    ["get_marginfi_diagnostics", "solana", "marginfi"],
    ["prepare_kamino_borrow", "solana", "kamino"],
    ["get_kamino_positions", "solana", "kamino"],
    ["prepare_marinade_stake", "solana", "marinade"],
    ["prepare_jito_stake", "solana", "jito"],
  ])("%s -> family=%s, protocol=%s", async (name, family, protocol) => {
    const { getToolScope } = await import("../src/config/scope.js");
    expect(getToolScope(name)).toEqual({ family, protocol });
  });

  it.each([
    // EVM family-only
    ["pair_ledger_live", "evm"],
    ["preview_send", "evm"],
    ["prepare_native_send", "evm"],
    ["prepare_token_send", "evm"],
    ["prepare_swap", "evm"],
    ["prepare_weth_unwrap", "evm"],
    ["prepare_revoke_approval", "evm"],
    ["resolve_ens_name", "evm"],
    ["reverse_resolve_ens", "evm"],
    ["get_lending_positions", "evm"],
    ["get_lp_positions", "evm"],
    ["get_staking_positions", "evm"],
    ["estimate_staking_yield", "evm"],
    ["compare_yields", "evm"],
    ["get_swap_quote", "evm"],
    ["check_contract_security", "evm"],
    ["get_contract_abi", "evm"],
    ["get_nft_portfolio", "evm"],
    // Solana family-only
    ["prepare_solana_native_send", "solana"],
    ["prepare_solana_spl_send", "solana"],
    ["preview_solana_send", "solana"],
    ["pair_ledger_solana", "solana"],
    ["get_solana_setup_status", "solana"],
    ["prepare_native_stake_delegate", "solana"],
    ["set_helius_api_key", "solana"],
    ["list_solana_validators", "solana"],
    // Tron
    ["prepare_tron_native_send", "tron"],
    ["prepare_tron_freeze", "tron"],
    ["get_tron_staking", "tron"],
    ["list_tron_witnesses", "tron"],
    ["pair_ledger_tron", "tron"],
    ["prepare_sunswap_swap", "tron"],
    // BTC
    ["prepare_btc_send", "btc"],
    ["combine_btc_psbts", "btc"],
    ["sign_message_btc", "btc"],
    ["get_btc_balance", "btc"],
    ["pair_ledger_btc", "btc"],
    // LTC
    ["prepare_litecoin_native_send", "ltc"],
    ["sign_message_ltc", "ltc"],
    ["get_ltc_balance", "ltc"],
    ["pair_ledger_ltc", "ltc"],
  ])("%s -> family=%s (no protocol)", async (name, family) => {
    const { getToolScope } = await import("../src/config/scope.js");
    expect(getToolScope(name)).toEqual({ family });
  });

  it.each([
    // Multi-chain / chain-agnostic — must stay always-on (empty scope).
    ["add_contact"],
    ["list_contacts"],
    ["verify_contacts"],
    ["remove_contact"],
    ["get_demo_wallet"],
    ["set_demo_wallet"],
    ["exit_demo_mode"],
    ["get_vaultpilot_config_status"],
    ["get_update_command"],
    ["get_health_alerts"],
    ["get_market_incident_status"],
    ["build_incident_report"],
    ["request_capability"],
    ["get_daily_briefing"],
    ["generate_readonly_link"],
    ["import_readonly_token"],
    ["list_readonly_invites"],
    ["revoke_readonly_invite"],
    ["import_strategy"],
    ["share_strategy"],
    ["get_pnl_summary"],
    ["get_portfolio_diff"],
    ["get_portfolio_summary"],
    ["get_protocol_risk_score"],
    ["send_transaction"],
    ["get_transaction_history"],
    ["get_transaction_status"],
    ["get_tx_verification"],
    ["get_verification_artifact"],
    ["verify_tx_decode"],
    ["explain_tx"],
    ["simulate_transaction"],
    ["simulate_position_change"],
    ["get_token_balance"],
    ["get_token_metadata"],
    ["get_token_price"],
    ["resolve_token"],
    ["get_coin_price"],
    ["get_ledger_device_info"],
    ["get_ledger_status"],
    ["verify_ledger_attestation"],
    ["verify_ledger_firmware"],
    ["verify_ledger_live_codesign"],
  ])("%s is core (no family, no protocol)", async (name) => {
    const { getToolScope } = await import("../src/config/scope.js");
    expect(getToolScope(name)).toEqual({});
  });
});

describe("isToolEnabled — env-var integration", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("default (no env vars) — every tool registered", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { isToolEnabled } = await import("../src/config/scope.js");
    expect(isToolEnabled("prepare_solana_native_send")).toBe(true);
    expect(isToolEnabled("prepare_aave_supply")).toBe(true);
    expect(isToolEnabled("prepare_btc_send")).toBe(true);
    expect(isToolEnabled("get_portfolio_summary")).toBe(true);
  });

  it("VAULTPILOT_CHAIN_FAMILIES=evm drops solana/tron/btc/ltc family tools", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "evm");
    const { isToolEnabled } = await import("../src/config/scope.js");
    expect(isToolEnabled("prepare_aave_supply")).toBe(true);
    expect(isToolEnabled("prepare_native_send")).toBe(true);
    expect(isToolEnabled("get_portfolio_summary")).toBe(true); // core stays
    expect(isToolEnabled("prepare_solana_native_send")).toBe(false);
    expect(isToolEnabled("prepare_tron_native_send")).toBe(false);
    expect(isToolEnabled("prepare_btc_send")).toBe(false);
    expect(isToolEnabled("prepare_litecoin_native_send")).toBe(false);
    expect(isToolEnabled("prepare_marginfi_supply")).toBe(false);
    expect(isToolEnabled("prepare_sunswap_swap")).toBe(false); // #726 — TRON DEX swap must gate w/ family
  });

  it("VAULTPILOT_PROTOCOLS=aave,lido,uniswap drops other DeFi protocols, keeps family-level EVM tools", async () => {
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "aave,lido,uniswap");
    const { isToolEnabled } = await import("../src/config/scope.js");
    expect(isToolEnabled("prepare_aave_supply")).toBe(true);
    expect(isToolEnabled("prepare_lido_stake")).toBe(true);
    expect(isToolEnabled("prepare_uniswap_swap")).toBe(true);
    expect(isToolEnabled("prepare_compound_supply")).toBe(false);
    expect(isToolEnabled("get_compound_positions")).toBe(false);
    expect(isToolEnabled("prepare_morpho_supply")).toBe(false);
    expect(isToolEnabled("prepare_eigenlayer_deposit")).toBe(false);
    expect(isToolEnabled("prepare_curve_add_liquidity")).toBe(false);
    expect(isToolEnabled("prepare_safe_tx_propose")).toBe(false);
    expect(isToolEnabled("prepare_rocketpool_stake")).toBe(false);
    // Family-level EVM tools (no protocol tag) stay enabled.
    expect(isToolEnabled("prepare_native_send")).toBe(true);
    expect(isToolEnabled("prepare_token_send")).toBe(true);
    expect(isToolEnabled("prepare_swap")).toBe(true);
  });

  it("intersects axes — family=evm + protocols=aave keeps only Aave + family-level EVM", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "evm");
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "aave");
    const { isToolEnabled } = await import("../src/config/scope.js");
    expect(isToolEnabled("prepare_aave_supply")).toBe(true);
    expect(isToolEnabled("prepare_native_send")).toBe(true);
    expect(isToolEnabled("prepare_lido_stake")).toBe(false); // protocol not in list
    expect(isToolEnabled("prepare_solana_native_send")).toBe(false); // family not in list
    expect(isToolEnabled("prepare_marginfi_supply")).toBe(false); // both axes block it
  });

  it("accepts chain-name aliases — bitcoin → btc, litecoin → ltc, ethereum → evm", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "ethereum,bitcoin");
    const { isToolEnabled, getEnabledFamilies } = await import("../src/config/scope.js");
    const families = [...getEnabledFamilies()].sort();
    expect(families).toEqual(["btc", "evm"]);
    expect(isToolEnabled("prepare_aave_supply")).toBe(true);
    expect(isToolEnabled("prepare_btc_send")).toBe(true);
    expect(isToolEnabled("prepare_litecoin_native_send")).toBe(false);
  });

  it("falls back to all-families when env var contains only typos", async () => {
    vi.stubEnv("VAULTPILOT_CHAIN_FAMILIES", "evms,solanaa,bogus");
    const { getEnabledFamilies } = await import("../src/config/scope.js");
    const families = [...getEnabledFamilies()].sort();
    expect(families).toEqual(["btc", "evm", "ltc", "solana", "tron"]);
  });

  it("VAULTPILOT_PROTOCOLS unset → null (all protocols allowed)", async () => {
    vi.stubEnv("VAULTPILOT_PROTOCOLS", "");
    const { getEnabledProtocols } = await import("../src/config/scope.js");
    expect(getEnabledProtocols()).toBeNull();
  });
});
