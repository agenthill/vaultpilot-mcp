/**
 * Conditional tool-surface scoping (plan: claude-work/plan-conditional-chain-context-loading.md).
 *
 * Two env-var axes, intersected — a tool is registered iff BOTH accept it:
 *
 *   VAULTPILOT_CHAIN_FAMILIES=evm,solana       (default: {evm} only)
 *   VAULTPILOT_PROTOCOLS=aave,lido,uniswap     (default: none)
 *
 * Curated-CORE default (#733, ARCHITECTURE.md §6 R7, PROD-adjudicated on
 * #721): an UNCONFIGURED install registers the EVM family plus the chain-
 * agnostic core bucket only — the other four families and all thirteen
 * protocols are opt-in. Both axes accept the literal token `all` to restore
 * the pre-#733 accept-everything surface (`VAULTPILOT_CHAIN_FAMILIES=all`,
 * `VAULTPILOT_PROTOCOLS=all`).
 *
 * Family aliases accepted (so users typing the chain name they recognize
 * still work): `ethereum|arbitrum|polygon|base|optimism` → `evm`,
 * `bitcoin` → `btc`, `litecoin` → `ltc`, `sol` → `solana`, `trx` → `tron`.
 * Unknown tokens are silently ignored — better to over-enable than to fail
 * boot on a typo.
 *
 * Tool-name → scope mapping is prefix-based to keep call-site changes at
 * zero. The wrapping `registerTool` in `src/index.ts` calls
 * `isToolEnabled(name)` and skips registration silently when false. A
 * snapshot test (`test/scope-tool-registration.test.ts`) pins which tools
 * land in which group so a future tool addition with a non-matching name
 * fails the test instead of silently defaulting to `core` (always-on).
 *
 * Why per-protocol gating exists: even an EVM-only user never touches all
 * eight integrated DeFi protocols. A user who only uses Aave + Lido +
 * Uniswap saves the description weight of Compound + Morpho + EigenLayer +
 * Curve + Safe + Rocket Pool by setting `VAULTPILOT_PROTOCOLS=aave,lido,
 * uniswap`. The per-turn token bill drops accordingly.
 */

export type ChainFamily = "evm" | "solana" | "tron" | "btc" | "ltc";

/**
 * Known protocol identifiers. Strings here must match what's emitted by
 * `getToolScope()`'s `protocol` field. Adding a new protocol means: (1) a
 * branch in `getToolScope()`, (2) a snapshot-test entry, (3) optional doc
 * blurb. The set is open — any string in `VAULTPILOT_PROTOCOLS` is accepted
 * (typos don't fail boot — they just gate nothing).
 */
export type Protocol =
  | "aave"
  | "compound"
  | "morpho"
  | "lido"
  | "eigenlayer"
  | "uniswap"
  | "curve"
  | "safe"
  | "rocketpool"
  | "marginfi"
  | "kamino"
  | "marinade"
  | "jito";

const ALL_FAMILIES: readonly ChainFamily[] = ["evm", "solana", "tron", "btc", "ltc"];

/**
 * Every known protocol id, in the same order as the `Protocol` union above.
 * Only used to ENUMERATE what an install has scoped out (the friction signal
 * on #733) — gating itself stays open-set, so a `VAULTPILOT_PROTOCOLS` typo
 * still gates nothing rather than failing boot.
 */
const ALL_PROTOCOLS: readonly Protocol[] = [
  "aave",
  "compound",
  "morpho",
  "lido",
  "eigenlayer",
  "uniswap",
  "curve",
  "safe",
  "rocketpool",
  "marginfi",
  "kamino",
  "marinade",
  "jito",
];

/**
 * Curated-CORE default (#733). An unconfigured install gets `{evm}` + the
 * chain-agnostic core bucket — ≤72 registered tools instead of all 189.
 */
const DEFAULT_FAMILIES: readonly ChainFamily[] = ["evm"];

/** Literal env-var token that restores the pre-#733 accept-everything axis. */
const ALL_TOKEN = "all";

/** One-line remediation string — the enable hint every friction surface shows. */
export const SCOPE_ENABLE_HINT =
  "Enable more by setting VAULTPILOT_CHAIN_FAMILIES (e.g. `evm,solana` or `all`) " +
  "and/or VAULTPILOT_PROTOCOLS (e.g. `aave,lido,uniswap` or `all`) in your MCP " +
  "client's env block, then restart the client — the tool surface is fixed at " +
  "server start, so a restart is required for the change to take effect.";

const FAMILY_ALIASES: Record<string, ChainFamily> = {
  evm: "evm",
  ethereum: "evm",
  arbitrum: "evm",
  polygon: "evm",
  base: "evm",
  optimism: "evm",
  solana: "solana",
  sol: "solana",
  tron: "tron",
  trx: "tron",
  btc: "btc",
  bitcoin: "btc",
  ltc: "ltc",
  litecoin: "ltc",
};

function parseFamilies(raw: string | undefined): Set<ChainFamily> {
  // UNSET → curated-CORE default (#733). An EXPLICIT value keeps its
  // pre-#733 meaning, `all` included.
  if (!raw) return new Set(DEFAULT_FAMILIES);
  const toks = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // `all` is the documented opt-back-in escape hatch. Handled explicitly
  // rather than left to the typo fallback below so it stays load-bearing.
  if (toks.includes(ALL_TOKEN)) return new Set(ALL_FAMILIES);
  const out = new Set<ChainFamily>();
  for (const tok of toks) {
    const fam = FAMILY_ALIASES[tok];
    if (fam) out.add(fam);
  }
  // Empty parse (all tokens were typos) → fall back to all families. The
  // alternative — booting with zero tools — is a worse UX than ignoring a
  // misconfigured env var.
  if (out.size === 0) return new Set(ALL_FAMILIES);
  return out;
}

/**
 * `null` = accept every protocol (only reachable via an explicit `all`).
 * An empty set = accept none, which is the #733 default when the env var is
 * unset. A set-but-content-free value (`" "`, `","`) also parses to the empty
 * set: under a deny-by-default axis, "the user wrote something empty" reads as
 * "none", not as "everything".
 */
function parseProtocols(raw: string | undefined): Set<string> | null {
  if (!raw) return new Set<string>();
  const toks = raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (toks.includes(ALL_TOKEN)) return null;
  return new Set(toks);
}

const ENABLED_FAMILIES: Set<ChainFamily> = parseFamilies(process.env.VAULTPILOT_CHAIN_FAMILIES);
const ENABLED_PROTOCOLS: Set<string> | null = parseProtocols(process.env.VAULTPILOT_PROTOCOLS);

export function getEnabledFamilies(): ReadonlySet<ChainFamily> {
  return ENABLED_FAMILIES;
}

export function getEnabledProtocols(): ReadonlySet<string> | null {
  return ENABLED_PROTOCOLS;
}

export function isFamilyEnabled(family: ChainFamily): boolean {
  return ENABLED_FAMILIES.has(family);
}

export function isProtocolEnabled(protocol: string): boolean {
  return ENABLED_PROTOCOLS === null || ENABLED_PROTOCOLS.has(protocol);
}

/**
 * Friction signal (#733). A clean scope flip UN-registers scoped-out tools,
 * so the host never sees them and there is no in-band per-call refusal to
 * count. These enumerations are the substitute: they tell the user exactly
 * what this install is NOT carrying, so "why don't I see prepare_btc_send?"
 * is answerable from `get_vaultpilot_config_status` and from one startup log
 * line instead of from the source.
 */
export function getScopedOutFamilies(): ChainFamily[] {
  return ALL_FAMILIES.filter((f) => !ENABLED_FAMILIES.has(f));
}

/**
 * Known protocols this install gates out. Empty when the axis is accept-all
 * (`VAULTPILOT_PROTOCOLS=all`). Only the KNOWN protocol ids are enumerable —
 * the gating set itself stays open, so an unknown id in the env var neither
 * appears here nor enables anything.
 */
export function getScopedOutProtocols(): Protocol[] {
  if (ENABLED_PROTOCOLS === null) return [];
  const enabled = ENABLED_PROTOCOLS;
  return ALL_PROTOCOLS.filter((p) => !enabled.has(p));
}

/**
 * One-line human-readable summary of what the active scope excludes, or
 * `null` when nothing is excluded (nothing worth logging). Used for the
 * startup stderr line; `get_vaultpilot_config_status` reports the same facts
 * structurally.
 */
export function describeScopeFriction(): string | null {
  const families = getScopedOutFamilies();
  const protocols = getScopedOutProtocols();
  if (families.length === 0 && protocols.length === 0) return null;
  const parts: string[] = [];
  if (families.length > 0) parts.push(`chain families off: ${families.join(", ")}`);
  if (protocols.length > 0) parts.push(`protocols off: ${protocols.join(", ")}`);
  return `tool scope — ${parts.join("; ")}. ${SCOPE_ENABLE_HINT}`;
}

/**
 * Map a tool name to its `(family, protocol?)` scope. Tools that aren't
 * matched by any rule fall through to `{}` (core — always-on, never gated).
 *
 * Order matters: protocol-specific matches must precede family-only catch-
 * alls, since the protocol entries are strict prefixes of the family ones
 * (e.g. `prepare_marginfi_*` would otherwise match `prepare_solana_*`'s
 * sibling family rule first if `marginfi` is registered against the family
 * catch-all alone).
 */
export function getToolScope(name: string): { family?: ChainFamily; protocol?: Protocol } {
  // ----- EVM, per-protocol -----
  if (name.startsWith("prepare_aave_")) return { family: "evm", protocol: "aave" };
  if (name.startsWith("prepare_compound_") || name.startsWith("get_compound_"))
    return { family: "evm", protocol: "compound" };
  if (name.startsWith("prepare_morpho_") || name === "get_morpho_positions")
    return { family: "evm", protocol: "morpho" };
  if (name.startsWith("prepare_lido_")) return { family: "evm", protocol: "lido" };
  if (name === "prepare_eigenlayer_deposit") return { family: "evm", protocol: "eigenlayer" };
  if (name.startsWith("prepare_uniswap_")) return { family: "evm", protocol: "uniswap" };
  if (name.startsWith("prepare_curve_") || name === "get_curve_positions")
    return { family: "evm", protocol: "curve" };
  if (
    name.startsWith("prepare_safe_") ||
    name === "get_safe_positions" ||
    name === "submit_safe_tx_signature"
  )
    return { family: "evm", protocol: "safe" };
  if (name.startsWith("prepare_rocketpool_")) return { family: "evm", protocol: "rocketpool" };

  // ----- Solana, per-protocol -----
  if (name.startsWith("prepare_marginfi_") || name.startsWith("get_marginfi_"))
    return { family: "solana", protocol: "marginfi" };
  if (name.startsWith("prepare_kamino_") || name === "get_kamino_positions")
    return { family: "solana", protocol: "kamino" };
  if (name.startsWith("prepare_marinade_")) return { family: "solana", protocol: "marinade" };
  if (name.startsWith("prepare_jito_")) return { family: "solana", protocol: "jito" };

  // ----- EVM, family-only (sends, swaps, ENS, NFTs, EVM-flavored reads) -----
  if (
    name === "pair_ledger_live" ||
    name === "preview_send" ||
    name === "prepare_native_send" ||
    name === "prepare_token_send" ||
    name === "prepare_swap" ||
    name === "prepare_weth_unwrap" ||
    name === "prepare_revoke_approval" ||
    name === "prepare_custom_call" ||
    name === "get_token_allowances" ||
    name === "resolve_ens_name" ||
    name === "reverse_resolve_ens" ||
    name === "get_lending_positions" ||
    name === "get_lp_positions" ||
    name === "get_staking_positions" ||
    name === "get_staking_rewards" ||
    name === "estimate_staking_yield" ||
    name === "compare_yields" ||
    name === "get_swap_quote" ||
    name === "set_etherscan_api_key" ||
    name === "check_contract_security" ||
    name === "check_permission_risks" ||
    name === "get_contract_abi" ||
    name.startsWith("get_nft_")
  )
    return { family: "evm" };

  // ----- Solana, family-only -----
  if (
    name.startsWith("prepare_solana_") ||
    name.startsWith("get_solana_") ||
    name.startsWith("prepare_native_stake_") ||
    name === "preview_solana_send" ||
    name === "pair_ledger_solana" ||
    name === "set_helius_api_key" ||
    name === "list_solana_validators"
  )
    return { family: "solana" };

  // ----- Tron, family-only -----
  if (
    name.startsWith("prepare_tron_") ||
    name.startsWith("get_tron_") ||
    name.startsWith("prepare_sunswap_") ||
    name === "list_tron_witnesses" ||
    name === "pair_ledger_tron"
  )
    return { family: "tron" };

  // ----- Bitcoin, family-only -----
  if (
    name.startsWith("prepare_btc_") ||
    name.startsWith("get_btc_") ||
    name === "combine_btc_psbts" ||
    name === "finalize_btc_psbt" ||
    name === "sign_btc_multisig_psbt" ||
    name === "sign_message_btc" ||
    name === "register_btc_multisig_wallet" ||
    name === "unregister_btc_multisig_wallet" ||
    name === "rescan_btc_account" ||
    name === "pair_ledger_btc"
  )
    return { family: "btc" };

  // ----- Litecoin, family-only -----
  if (
    name.startsWith("prepare_litecoin_") ||
    name.startsWith("get_ltc_") ||
    name === "sign_message_ltc" ||
    name === "rescan_ltc_account" ||
    name === "pair_ledger_ltc"
  )
    return { family: "ltc" };

  // ----- Core (chain-agnostic) — always-on -----
  return {};
}

export function isToolEnabled(name: string): boolean {
  const scope = getToolScope(name);
  if (scope.family && !isFamilyEnabled(scope.family)) return false;
  if (scope.protocol && !isProtocolEnabled(scope.protocol)) return false;
  return true;
}
