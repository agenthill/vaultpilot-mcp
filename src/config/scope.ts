/**
 * Conditional tool-surface scoping (plan: claude-work/plan-conditional-chain-context-loading.md).
 *
 * Two env-var axes, intersected — a tool is registered iff BOTH accept it:
 *
 *   VAULTPILOT_CHAIN_FAMILIES=evm,solana       (default: evm only)
 *   VAULTPILOT_PROTOCOLS=aave,lido,uniswap     (default: none)
 *
 * Curated-CORE default (issue #733, ARCHITECTURE.md §6 R7): an unconfigured
 * install registers the EVM family plus the chain-agnostic core bucket only —
 * Solana / TRON / BTC / LTC and all thirteen DeFi protocols are opt-in, since
 * the host pays every registered tool's description + schema text every turn.
 * Both env vars accept the literal token `all`, which restores the pre-#733
 * accept-everything behavior for that axis.
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
 * Curated-CORE default (#733) — unset means EVM only, NOT every family. Kept
 * separate from `ALL_FAMILIES` so "what a fresh install gets" and "what
 * exists" can't drift into each other by a one-token edit.
 */
const DEFAULT_FAMILIES: readonly ChainFamily[] = ["evm"];

/**
 * Every known protocol. Drives the scoped-out enumeration in the config-status
 * report and the startup log line — a protocol added to the `Protocol` union
 * but not here vanishes silently from that report.
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
 * Escape hatch accepted by both env vars, restoring the pre-#733 accept-
 * everything behavior for that axis. Before #733 `all` "worked" only by
 * accident (it parsed as a typo and hit the all-families fallback); it is a
 * first-class token now that the default is narrow.
 */
const ALL_TOKEN = "all";

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
  // Unset → curated-CORE default (#733): EVM only.
  if (!raw) return new Set(DEFAULT_FAMILIES);
  const out = new Set<ChainFamily>();
  for (const tok of raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) {
    if (tok === ALL_TOKEN) {
      for (const fam of ALL_FAMILIES) out.add(fam);
      continue;
    }
    const fam = FAMILY_ALIASES[tok];
    if (fam) out.add(fam);
  }
  // Empty parse (all tokens were typos) → fall back to all families.
  // Deliberately UNCHANGED by #733: booting a user who tried to configure
  // something with zero chain tools is worse UX than ignoring a misconfigured
  // env var. Unset is "user said nothing"; a typo is "user said something we
  // couldn't read" — different inputs, deliberately different fallbacks.
  if (out.size === 0) return new Set(ALL_FAMILIES);
  return out;
}

/**
 * `null` = accept every protocol, and after #733 it is reachable ONLY via an
 * explicit `VAULTPILOT_PROTOCOLS=all`. Unset now yields the empty set: no
 * protocol-tagged tool registers until the user names one.
 */
function parseProtocols(raw: string | undefined): Set<string> | null {
  // Unset → curated-CORE default (#733): no protocols.
  if (!raw) return new Set<string>();
  const set = new Set(
    raw.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean),
  );
  if (set.has(ALL_TOKEN)) return null;
  return set;
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
  // `null` is the explicit `VAULTPILOT_PROTOCOLS=all` accept-everything
  // sentinel — never the default (#733).
  return ENABLED_PROTOCOLS === null || ENABLED_PROTOCOLS.has(protocol);
}

/**
 * Chain families that exist but are NOT registered under the active config.
 * Sorted for a stable report/log line.
 */
export function getScopedOutFamilies(): ChainFamily[] {
  return ALL_FAMILIES.filter((fam) => !ENABLED_FAMILIES.has(fam)).sort();
}

/**
 * Protocols that exist but are NOT registered under the active config. Sorted
 * for a stable report/log line; empty under `VAULTPILOT_PROTOCOLS=all`. A
 * protocol whose FAMILY is also scoped out is listed too — it is scoped out
 * either way, and hiding it understates what the user is missing.
 */
export function getScopedOutProtocols(): Protocol[] {
  if (ENABLED_PROTOCOLS === null) return [];
  return ALL_PROTOCOLS.filter((p) => !ENABLED_PROTOCOLS.has(p)).sort();
}

/**
 * One-line, verbatim-relayable recipe for turning scoped-out capabilities back
 * on — half of #733's friction measure (scoped-out tools are un-registered, so
 * no in-band per-call refusal exists to count; `request_capability` stays the
 * demand signal). Suggested values are the union of what's on and what's
 * scoped out — paste-to-enable-everything; the text says narrower works too.
 */
export function getScopeEnableHint(): string {
  const families = getScopedOutFamilies();
  const protocols = getScopedOutProtocols();
  if (families.length === 0 && protocols.length === 0) {
    return "Nothing is scoped out — every chain family and protocol tool is registered.";
  }
  const parts: string[] = [];
  if (families.length > 0) {
    const union = [...new Set([...ENABLED_FAMILIES, ...families])].sort();
    parts.push(`VAULTPILOT_CHAIN_FAMILIES=${union.join(",")}`);
  }
  if (protocols.length > 0) {
    const enabled: string[] = ENABLED_PROTOCOLS === null ? [] : [...ENABLED_PROTOCOLS];
    const union = [...new Set([...enabled, ...protocols])].sort();
    parts.push(`VAULTPILOT_PROTOCOLS=${union.join(",")}`);
  }
  return (
    `Scoped-out tools are opt-in: set ${parts.join(" and/or ")} in your ` +
    "MCP-client config and restart the client. Comma-separated; a narrower " +
    "list works (name only what you use), and `all` accepts every value."
  );
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
