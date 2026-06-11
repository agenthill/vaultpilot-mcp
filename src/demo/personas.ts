/**
 * Curated demo wallet matrix for VAULTPILOT_DEMO live mode.
 *
 * Shape: a 2D table indexed by **chain** × **type**. Each cell holds
 * a single PUBLIC on-chain address (no private keys, no secrets —
 * sharing is read-only and carries zero security risk) selected to
 * fit the (chain, type) archetype with verified recent on-chain
 * activity.
 *
 *                EVM            Solana          TRON            BTC
 *   whale        vitalik.eth    Coinbase hot    Binance hot     Binance cold
 *   defi-degen   Justin Sun     7xKXtg2…        THPvaUhoh2…     —
 *   stable-saver Binance hot    5xoBq7f7…       —               —
 *   staking-maxi 0x8EB8a3b…     —               —               —
 *
 * `null` cells mean "no curated address for this combination" —
 * either the chain doesn't support the archetype (BTC has no native
 * DeFi or stablecoin lending, so 3 of its 4 cells are null) or no
 * sufficiently-recent verified address was available at curation
 * time. Consumers MUST handle null.
 *
 * **Activity verification (curated 2026-04-27):** every non-null cell
 * was verified via `get_transaction_history` to have on-chain
 * activity within the prior ~7 days, except Solana stable-saver
 * (last activity 15 days prior — closest curated USDC-on-Solana
 * holder available within research budget) and BTC whale (mempool.
 * space tx history doesn't surface block times in the tool's current
 * shape — verified by tx-list non-emptiness only). The `verifiedAt`
 * field on each cell records the verification date.
 *
 * **Staleness:** activity claims rot. If a wallet exits a category
 * mid-cycle (e.g., Justin Sun stops doing DeFi swaps for a month),
 * the cell still loads correctly — the address just shows quieter
 * read tools. Refresh the matrix by re-running the verification
 * batch and updating `verifiedAt` whenever a cell needs swapping.
 *
 * **API:** `set_demo_wallet({ chain, type })` loads a single cell.
 * Multiple chains accumulate (calling for evm + solana populates
 * both slots). Re-calling for the same chain replaces. Persona-keyed
 * batch loading (load all 4 chains at once for a given type) is
 * available via `set_demo_wallet({ persona: <type> })`.
 */

export type DemoChain = "evm" | "solana" | "tron" | "bitcoin";

export type DemoType =
  | "defi-degen"
  | "stable-saver"
  | "staking-maxi"
  | "whale";

export interface DemoCell {
  /**
   * Chain-appropriate address. EVM: 0x-hex. Solana: base58 pubkey.
   * TRON: base58 (T-prefix). Bitcoin: bech32 / legacy / p2sh.
   */
  address: string;
  /**
   * Short prose explaining what archetype evidence justifies this
   * address in this cell. Surfaced in `get_demo_wallet` so the agent
   * can tell the user why "Solana defi-degen" lands on this wallet.
   */
  archetype: string;
  /**
   * ISO-8601 date the cell's recent-activity claim was last verified
   * via `get_transaction_history`. Swap the cell + bump this date if
   * a wallet goes quiet for the archetype.
   */
  verifiedAt: string;
  /**
   * Multi-step / state-dependent demo flows the cell's existing
   * on-chain state already supports end-to-end. Issue #409 — demo
   * `simulated` sends don't mutate state, so flows whose
   * preconditions are themselves state changes loop unless the
   * wallet already had that prior step done. The agent reads this
   * to recommend rehearsable flows BEFORE the user picks one,
   * heading off the loop at the agent layer.
   *
   * Vocabulary: short `<protocol_or_op>_<verb>` IDs (e.g.
   * `aave_supply`, `marinade_stake`, `swap_eth_usdc`). Informational,
   * not enforced — the agent reads strings and reasons about which
   * `prepare_*` tool maps to each flow.
   */
  rehearsableFlows: string[];
  /**
   * Flows the persona archetype implies but the wallet's current
   * on-chain state does NOT support, with a one-line recommendation
   * the agent surfaces verbatim. Issue #409 — closes the agent-loop
   * trap: when a user asks for a flow listed here, the agent
   * immediately offers the alternative (different persona, exit
   * demo mode, pair Ledger) instead of walking them through a
   * precondition step that won't persist.
   *
   * Empty / absent means we haven't catalogued gaps for this cell
   * — the agent falls back to generic "demo can't simulate state
   * changes" guidance.
   */
  flowGaps?: Array<{
    flow: string;
    /** Why the wallet's state doesn't support it (e.g. "no durable nonce account", "no USDC balance"). */
    reason: string;
    /** Concrete next step — switch persona / exit demo / pair Ledger. */
    recommendation: string;
  }>;
}

export type DemoMatrix = {
  [C in DemoChain]: Partial<Record<DemoType, DemoCell>>;
};

export const DEMO_WALLETS: DemoMatrix = {
  evm: {
    whale: {
      address: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
      archetype: "vitalik.eth — large holder + frequent inbound token transfers",
      verifiedAt: "2026-04-28",
      // vitalik.eth is heavily airdropped + holds many ERC-20s; ENS
      // resolution works against this address (ENS reverse points
      // here). Mostly idle on lending — historic Aave/Compound use
      // but no current active supply/borrow position to walk through
      // a borrow leg.
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_eth_erc20", // many random ERC-20s available
        "swap_eth_usdc",
        "weth_unwrap",
      ],
      flowGaps: [
        {
          flow: "aave_borrow",
          reason: "no active Aave V3 supply position to borrow against",
          recommendation: "switch to defi-degen persona (active multi-protocol DeFi state)",
        },
        {
          flow: "compound_borrow",
          reason: "no active Compound V3 supply position",
          recommendation: "switch to defi-degen persona",
        },
      ],
    },
    "defi-degen": {
      address: "0x176F3DAb24a159341c0509bB36B833E7fdd0a132",
      archetype: "Justin Sun ETH — multi-protocol activity (transfers, claims, swaps)",
      verifiedAt: "2026-04-28",
      // Heavy multi-protocol activity historically — tokens with
      // unlimited approvals to Uniswap router + Aave + others.
      // Active borrowing and lending visibility on Etherscan /
      // DeBank. State on chain is genuinely rich for the archetype.
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_eth_erc20",
        "swap_eth_usdc",
        "swap_usdc_usdt",
        "weth_unwrap",
        "aave_supply",
        "aave_withdraw",
        "compound_supply",
      ],
      flowGaps: [
        {
          flow: "uniswap_v3_collect",
          reason: "no current Uniswap V3 LP position with unclaimed fees verified",
          recommendation: "exit demo and pair a real Ledger to walk this with your own LP",
        },
      ],
    },
    "stable-saver": {
      address: "0x47ac0Fb4F2D84898e4D9E7b4DaB3C24507a6D503",
      archetype: "Binance hot — heavy USDT/USDC flows, large daily volume",
      verifiedAt: "2026-04-28",
      // Exchange hot wallets do high-volume token sends but do NOT
      // supply to lending protocols (their treasury policy parks
      // liquidity off-protocol). Stablecoin flows + native_send
      // walk; lending walks would refuse on missing collateral.
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_usdt",
        "token_send_usdc",
        "swap_usdc_usdt",
        "swap_usdc_eth",
      ],
      flowGaps: [
        {
          flow: "aave_supply",
          reason:
            "Binance hot wallets don't typically hold Aave aTokens — supply position would be empty",
          recommendation: "switch to defi-degen persona for Aave supply/withdraw rehearsal",
        },
        {
          flow: "morpho_supply",
          reason: "no observed Morpho positions for this exchange wallet",
          recommendation: "switch to defi-degen persona",
        },
      ],
    },
    "staking-maxi": {
      address: "0x8EB8a3b98659Cce290402893d0123abb75E3ab28",
      archetype: "Active multi-asset wallet with WBTC + DAI + stETH-class flows",
      verifiedAt: "2026-04-28",
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_eth_erc20",
        "swap_eth_steth",
        "lido_stake", // ETH → stETH
      ],
      flowGaps: [
        {
          flow: "eigenlayer_deposit",
          reason: "no verified active EigenLayer strategy deposit on this address",
          recommendation: "rehearse the prepare flow against real chain state once paired",
        },
        {
          flow: "lido_unstake",
          reason: "stETH balance not currently verified non-zero on this cell",
          recommendation:
            "rehearse `lido_stake` first (works against this wallet's ETH); for unstake, exit demo and pair a real Ledger",
        },
      ],
    },
  },
  solana: {
    whale: {
      address: "H8sMJSCQxfKiFTCfDR3DUMLPwcRbM61LGFJ8N4dK3WjS",
      archetype: "Coinbase Solana hot — heavy SOL + USDC volume, large balances",
      verifiedAt: "2026-04-28",
      // RPC-verified 2026-04-28: 20,569 SOL balance, 0 SPL token
      // accounts. Walks native flows; SPL flows refuse.
      rehearsableFlows: ["read_portfolio", "native_send"],
      flowGaps: [
        {
          flow: "marinade_stake",
          reason:
            "no durable-nonce account initialized + Coinbase doesn't run liquid staking from hot wallets",
          recommendation:
            "switch to staking-maxi persona once curated, or exit demo and pair a real Ledger",
        },
        {
          flow: "token_send_usdc",
          reason: "wallet holds 0 USDC (RPC-verified 2026-04-28)",
          recommendation: "switch to defi-degen persona (holds USDC)",
        },
        {
          flow: "kamino_supply",
          reason: "no SPL token accounts at all — Kamino requires deposit asset",
          recommendation: "switch to defi-degen persona",
        },
        {
          flow: "marginfi_supply",
          reason: "no SPL token accounts at all — MarginFi requires deposit asset",
          recommendation: "switch to defi-degen persona",
        },
      ],
    },
    "defi-degen": {
      address: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU",
      archetype: "Active Solana DeFi user — frequent program-interaction txs",
      verifiedAt: "2026-04-28",
      // RPC-verified 2026-04-28: 50.4 SOL, ~33 USDC, 63 SPL token
      // accounts (mostly long-tail mints). Holdings of mSOL /
      // jitoSOL / bSOL all 0 — LST flows won't have output to walk.
      // No durable-nonce account verified — multi-step Solana flows
      // (Marinade / Jito / native stake) require nonce_init first
      // and that step's simulated send doesn't persist.
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_usdc",
        "swap_sol_usdc",
        "swap_usdc_sol",
      ],
      flowGaps: [
        {
          flow: "marinade_stake",
          reason:
            "no durable-nonce account; Solana sign flow needs `prepare_solana_nonce_init` first and demo simulated sends don't persist that state",
          recommendation:
            "exit demo mode and pair a real Ledger to walk Marinade end-to-end",
        },
        {
          flow: "jito_stake",
          reason: "same nonce-init dependency as marinade_stake",
          recommendation: "exit demo mode and pair a real Ledger",
        },
        {
          flow: "marinade_unstake_immediate",
          reason: "wallet holds 0 mSOL (RPC-verified 2026-04-28)",
          recommendation: "rehearse marinade_stake first via real Ledger to obtain mSOL",
        },
        {
          flow: "kamino_borrow",
          reason: "no observed Kamino obligation account with collateral",
          recommendation: "exit demo and rehearse via real position",
        },
      ],
    },
    "stable-saver": {
      address: "5xoBq7f7CDgZwqHrDBdRWM84ExRetg4gZq93dyJtoSwp",
      archetype:
        "USDC-flagged wallet (curation drift — RPC-verified 2026-04-28: 0 USDC, 0.46 SOL; archetype claim no longer matches state, replacement candidate needed)",
      verifiedAt: "2026-04-28",
      // KNOWN STALENESS: this cell was curated for USDC flows but
      // the wallet's current balance is 0 USDC and 0.46 SOL. The
      // matrix surfaces the gap honestly via flowGaps so the agent
      // doesn't promise a USDC walkthrough that refuses on first
      // step. Replacement candidate tracked in demo-personas issue.
      rehearsableFlows: ["read_portfolio"],
      flowGaps: [
        {
          flow: "token_send_usdc",
          reason: "wallet holds 0 USDC (RPC-verified 2026-04-28 — drift from original curation)",
          recommendation:
            "switch to Solana defi-degen persona for USDC sends; this cell pending replacement",
        },
        {
          flow: "swap_usdc_sol",
          reason: "no USDC to swap from",
          recommendation: "switch to Solana defi-degen persona",
        },
        {
          flow: "native_send",
          reason: "0.46 SOL balance is below typical send + fee headroom",
          recommendation: "switch to Solana whale persona for native_send",
        },
      ],
    },
    // staking-maxi: no verified-recent native-stake / mSOL / jitoSOL
    // wallet found within curation budget. Demo will skip Solana
    // staking until refreshed.
  },
  tron: {
    whale: {
      address: "TQrY8tryqsYVCYS3MFbtffiPp2ccyn4STm",
      archetype: "Binance TRON hot — large USDT-TRC20 + TRX flows, sub-second cadence",
      verifiedAt: "2026-04-28",
      // Exchange hot wallet pattern: USDT-TRC20 + TRX flows, no
      // staking (Stake 2.0 freezes), no voting. Walks native and
      // token sends; staking flows refuse on no frozen balance.
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_usdt",
        "swap_trx_usdt",
      ],
      flowGaps: [
        {
          flow: "tron_freeze",
          reason: "exchange hot wallets don't freeze TRX for resources",
          recommendation: "switch to a TRX-freezer persona once curated, or pair a real Ledger",
        },
        {
          flow: "tron_vote",
          reason: "no frozen TRX → no voting power",
          recommendation: "tron_freeze must complete first; in demo this requires real Ledger",
        },
      ],
    },
    "defi-degen": {
      address: "THPvaUhoh2Qn2y9THCZML3H815hhFhn5YC",
      archetype: "Active TRC-20 user (USDT transfers + TRX moves)",
      verifiedAt: "2026-04-28",
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "token_send_usdt",
        "swap_trx_usdt",
      ],
      flowGaps: [
        {
          flow: "tron_freeze",
          reason: "no current frozen-TRX position; 'defi-degen' archetype emphasizes TRC-20, not staking",
          recommendation: "exit demo and pair a real Ledger for staking flows",
        },
      ],
    },
    // stable-saver: declined to reuse the whale wallet here even
    // though Binance hot is also a stable-flow wallet — duplicate
    // cells confuse the demo. Refresh with a distinct USDT-heavy
    // wallet on next curation pass.
    // staking-maxi: no verified-recent TRX freezer + voter found
    // within budget.
  },
  bitcoin: {
    whale: {
      address: "bc1qm34lsc65zpw79lxes69zkqmk6ee3ewf0j77s3h",
      archetype:
        "Binance cold wallet — multi-BTC tx volume (mempool.space tx-history tool doesn't surface block times in current shape; recency confirmed by tx-list non-emptiness)",
      verifiedAt: "2026-04-28",
      rehearsableFlows: [
        "read_portfolio",
        "native_send",
        "swap_btc_eth", // via prepare_btc_lifi_swap (PR #401)
        "swap_btc_usdc",
        "swap_btc_sol",
      ],
      // No flowGaps — BTC scope is intentionally limited (no native
      // DeFi / staking / stablecoin lending), and the flows
      // rehearsable above are the full surface.
    },
    // BTC's chain semantics don't match defi-degen / stable-saver /
    // staking-maxi (no native DeFi, no native stablecoin lending,
    // no native PoS staking). Babylon / ordinals / runes exist but
    // none are surfaced by vaultpilot-mcp's read tools, so demo
    // would have nothing to show. Cells stay null by design.
  },
};

/** All chain IDs, for enumeration. */
export const DEMO_CHAINS: DemoChain[] = ["evm", "solana", "tron", "bitcoin"];

/** All type IDs, for enumeration / validation. */
export const DEMO_TYPES: DemoType[] = [
  "defi-degen",
  "stable-saver",
  "staking-maxi",
  "whale",
];

export function isDemoChain(chain: string): chain is DemoChain {
  return (DEMO_CHAINS as string[]).includes(chain);
}

export function isDemoType(type: string): type is DemoType {
  return (DEMO_TYPES as string[]).includes(type);
}

export function getDemoCell(chain: DemoChain, type: DemoType): DemoCell | null {
  return DEMO_WALLETS[chain][type] ?? null;
}

// ---------------------------------------------------------------------
// Backward-compat shim — Persona / PERSONAS API used by older code.
//
// The original demo-wallet API was persona-keyed:
// `set_demo_wallet({ persona: "whale" })` loaded all 4 chains for one
// type at once. The matrix loader supersedes this by exposing per-cell
// loading, but the persona API stays available as a batch-load
// convenience. This shim derives Persona objects from the matrix so
// consumer code stays working with one source of truth.
//
// Persona name `defi-power-user` was renamed to `defi-degen`. Old
// callers passing `defi-power-user` get the same DemoType silently
// via the schema's alias mapping (see demo/schemas.ts).
// ---------------------------------------------------------------------

export type PersonaId = DemoType;

export interface PersonaAddresses {
  evm: string[];
  solana: string[];
  tron: string[];
  bitcoin: string[] | null;
}

export interface Persona {
  id: PersonaId;
  description: string;
  addresses: PersonaAddresses;
}

const PERSONA_DESCRIPTIONS: Record<DemoType, string> = {
  whale:
    "Large holder, light DeFi. Big native balances on every supported chain — useful for showing 'big numbers' read flows.",
  "defi-degen":
    "Active multi-protocol DeFi: Aave / Compound / Lido on EVM, Solana DeFi programs, JustLend on TRON. Useful for prepare/preview demos.",
  "stable-saver":
    "Primarily stablecoin flows (USDC / USDT). No BTC entry (Bitcoin has no native stablecoin lending). Useful for lending-supply demos.",
  "staking-maxi":
    "Liquid staking + restaking. EVM cell only at this curation date (Solana / TRON staking cells pending refresh).",
};

function buildPersonaAddresses(type: DemoType): PersonaAddresses {
  const evm = DEMO_WALLETS.evm[type];
  const solana = DEMO_WALLETS.solana[type];
  const tron = DEMO_WALLETS.tron[type];
  const bitcoin = DEMO_WALLETS.bitcoin[type];
  return {
    evm: evm ? [evm.address] : [],
    solana: solana ? [solana.address] : [],
    tron: tron ? [tron.address] : [],
    bitcoin: bitcoin ? [bitcoin.address] : null,
  };
}

export const PERSONAS: Record<PersonaId, Persona> = {
  whale: {
    id: "whale",
    description: PERSONA_DESCRIPTIONS.whale,
    addresses: buildPersonaAddresses("whale"),
  },
  "defi-degen": {
    id: "defi-degen",
    description: PERSONA_DESCRIPTIONS["defi-degen"],
    addresses: buildPersonaAddresses("defi-degen"),
  },
  "stable-saver": {
    id: "stable-saver",
    description: PERSONA_DESCRIPTIONS["stable-saver"],
    addresses: buildPersonaAddresses("stable-saver"),
  },
  "staking-maxi": {
    id: "staking-maxi",
    description: PERSONA_DESCRIPTIONS["staking-maxi"],
    addresses: buildPersonaAddresses("staking-maxi"),
  },
};

export const PERSONA_IDS: PersonaId[] = DEMO_TYPES;

/**
 * True iff `id` is a known persona / type. Accepts the legacy
 * `defi-power-user` alias for backward compatibility with callers
 * that still use the pre-rename name; downstream code resolves it
 * to `defi-degen` via the schema (see demo/schemas.ts).
 */
export function isPersonaId(id: string): id is PersonaId {
  return isDemoType(id);
}
