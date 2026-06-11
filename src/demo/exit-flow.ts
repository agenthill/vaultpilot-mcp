/**
 * Demo → operational handoff guide. The MCP server can't *invoke* the
 * setup wizard (a separate interactive binary) or modify the user's
 * `claude mcp add` config — it can only describe what to do. This module
 * builds a structured, decision-tree-shaped response the agent walks the
 * user through to leave demo mode and configure real signing.
 * bump
 *
 * Surfaced via the `exit_demo_mode` tool. The agent's job is to ASK the
 * user the relevant questions first (do you have a Ledger? which chains?),
 * then call this with their answers; the response is tailored to skip
 * sections that don't apply.
 *
 * Stateless / read-only — does NOT actually unset VAULTPILOT_DEMO or
 * mutate any process state. Demo mode is read from env at every tool call
 * and the only real "exit" is restarting the MCP server with the env var
 * absent. The tool's response makes that constraint explicit.
 */

import { isDemoMode, isLiveMode, getLiveWallet } from "./index.js";
import {
  getRuntimeSolanaRpcStatus,
  getSolanaPublicErrorCount,
} from "../data/runtime-rpc-overrides.js";

export type DemoExitChain =
  | "ethereum"
  | "arbitrum"
  | "polygon"
  | "base"
  | "optimism"
  | "solana"
  | "tron"
  | "bitcoin"
  | "litecoin";

export interface ExitDemoArgs {
  /** Whether the user confirmed they have a Ledger device. Drives whether signing
   *  prep is included in the response. Pass `false` to get a deferral message. */
  hasLedger?: boolean;
  /** Whether the user has already run `vaultpilot-mcp-setup` previously. When
   *  `true`, the response skips the setup-wizard walkthrough and points to the
   *  shorter "just unset the env var" path. */
  hasRunSetup?: boolean;
  /** Chains the user intends to use. Drives which RPC / API keys to recommend
   *  acquiring. Empty/undefined defaults to the EVM-only set. */
  chains?: DemoExitChain[];
  /** Whether the user wants help acquiring API keys. When `true`, the response
   *  includes per-provider signup links. When `false`, recommends running setup
   *  with whatever keys they already have. */
  acquireKeys?: boolean;
}

interface ProviderRec {
  service: string;
  why: string;
  signupUrl: string;
  freeTier: string;
}

const PROVIDER_RECOMMENDATIONS: Record<string, ProviderRec[]> = {
  ethereum: [
    {
      service: "Infura or Alchemy (EVM RPC)",
      why: "Ethereum reads via a free-tier provider key. Public-fallback works for evaluation but rate-limits under sustained use.",
      signupUrl: "https://app.infura.io/ — or — https://dashboard.alchemy.com/",
      freeTier: "Both cover personal-volume use comfortably.",
    },
    {
      service: "Etherscan V2",
      why: "Required for `get_transaction_history`, `get_token_allowances`, `explain_tx`, address-poisoning scoring. Public Etherscan refuses unauthed multi-chain V2 calls.",
      signupUrl: "https://etherscan.io/myapikey",
      freeTier: "Free 5 calls/sec, 100K calls/day. Enough for any personal use.",
    },
  ],
  solana: [
    {
      service: "Helius (Solana RPC)",
      why: "Public Solana RPC throttles aggressively (you'll see 429s within seconds of any real walkthrough). Helius free tier is essentially required for usable Solana reads.",
      signupUrl: "https://dashboard.helius.dev/",
      freeTier: "Free tier covers personal-volume reads + writes. Default API key auto-created on first login.",
    },
  ],
  tron: [
    {
      service: "TronGrid",
      why: "Unauthenticated TronGrid throttles to ~15 req/min. Free key raises this 10x.",
      signupUrl: "https://www.trongrid.io/dashboard/apikeys",
      freeTier: "Free tier: 100K requests/day.",
    },
  ],
  bitcoin: [
    {
      service: "BTC indexer (Esplora)",
      why: "BTC reads via litecoinspace.org / mempool.space; both have generous public limits — usually no key needed for personal use.",
      signupUrl: "(no signup needed for default; self-hosting Esplora is the upgrade path)",
      freeTier: "Public default: no rate-limit issues observed for personal use.",
    },
  ],
};

PROVIDER_RECOMMENDATIONS.litecoin = PROVIDER_RECOMMENDATIONS.bitcoin;
PROVIDER_RECOMMENDATIONS.arbitrum = PROVIDER_RECOMMENDATIONS.ethereum;
PROVIDER_RECOMMENDATIONS.polygon = PROVIDER_RECOMMENDATIONS.ethereum;
PROVIDER_RECOMMENDATIONS.base = PROVIDER_RECOMMENDATIONS.ethereum;
PROVIDER_RECOMMENDATIONS.optimism = PROVIDER_RECOMMENDATIONS.ethereum;

/**
 * Build the exit-demo-mode guide. The structure of the response is the
 * agent's script: snapshot of current state → preflight checklist → ordered
 * steps → caveats → copy-paste recipe. Same shape regardless of args; some
 * sections collapse to empty arrays / null when not applicable so the agent
 * can render uniformly.
 */
export function buildExitDemoGuide(args: ExitDemoArgs = {}): {
  currentState: {
    demoActive: boolean;
    subMode: "default" | "live" | "not-in-demo";
    activePersonaId: string | null;
    runtimeSolanaRpcSet: boolean;
    solanaPublicErrorsThisSession: number;
  };
  outcome: "ready-to-exit" | "deferred-no-ledger" | "not-in-demo";
  message: string;
  whatYoullGain: string[];
  whatYoullLose: string[];
  preflightChecklist: { item: string; reason: string }[];
  steps: { step: number; action: string; command: string | null; note?: string }[];
  recommendedProviders: ProviderRec[];
  copyPasteRecipe: string | null;
  cautions: string[];
} {
  const live = getLiveWallet();
  const runtimeSolanaRpcStatus = getRuntimeSolanaRpcStatus();
  let subMode: "default" | "live" | "not-in-demo";
  if (!isDemoMode()) {
    subMode = "not-in-demo";
  } else if (isLiveMode()) {
    subMode = "live";
  } else {
    subMode = "default";
  }
  const currentState = {
    demoActive: isDemoMode(),
    subMode,
    activePersonaId: live?.personaId ?? null,
    runtimeSolanaRpcSet: runtimeSolanaRpcStatus.active,
    solanaPublicErrorsThisSession: getSolanaPublicErrorCount(),
  };

  // Not currently in demo — return a no-op-ish response so the agent
  // can clarify with the user that there's nothing to exit.
  if (!currentState.demoActive) {
    return {
      currentState,
      outcome: "not-in-demo",
      message:
        "VAULTPILOT_DEMO is unset — the server is already in operational mode. " +
        "If signing tools aren't working, the issue is likely missing Ledger pairing or " +
        "missing RPC keys; run `vaultpilot-mcp-setup` to configure, then `pair_ledger_live` " +
        "to pair your Ledger.",
      whatYoullGain: [],
      whatYoullLose: [],
      preflightChecklist: [],
      steps: [],
      recommendedProviders: [],
      copyPasteRecipe: null,
      cautions: [],
    };
  }

  // No Ledger yet — recommend deferring the exit.
  if (args.hasLedger === false) {
    return {
      currentState,
      outcome: "deferred-no-ledger",
      message:
        "Real signing requires a Ledger hardware wallet — VaultPilot is non-custodial and " +
        "never holds private keys. Without a Ledger, exiting demo mode would leave you " +
        "with read-only access (which you already have in demo). Recommendation: stay in " +
        "demo mode, walk through more flows to evaluate, then come back to `exit_demo_mode` " +
        "after you have a Ledger device. Supported devices: Nano S Plus, Nano X, Stax, Flex.",
      whatYoullGain: [],
      whatYoullLose: [],
      preflightChecklist: [
        {
          item: "Acquire a Ledger device",
          reason:
            "Nano S Plus is the cheapest entry point (~$80). Stax / Flex are the touchscreen models. Buy ONLY from ledger.com — never from third-party resellers (compromised devices in the supply chain).",
        },
      ],
      steps: [],
      recommendedProviders: [],
      copyPasteRecipe: null,
      cautions: [
        "Buy your Ledger directly from ledger.com. Third-party resellers have shipped pre-tampered devices in past incidents.",
      ],
    };
  }

  // Standard ready-to-exit path. `hasLedger` undefined or true falls
  // here — when undefined, the response includes "verify Ledger first"
  // language so the agent can confirm before walking the user through.
  const chains: DemoExitChain[] =
    args.chains && args.chains.length > 0 ? args.chains : ["ethereum"];
  const recommendedProviders = collectProviders(chains);

  const whatYoullGain = [
    "Real signing — every prepare_* / send_transaction goes to your Ledger for physical approval.",
    "Reads run against YOUR addresses (your paired Ledger accounts), not a curated persona's.",
    "Persistent state — Ledger pairing, RPC keys, contacts, etc. all persist across MCP-server restarts via `~/.vaultpilot-mcp/config.json`.",
    "`pair_ledger_*`, `sign_message_*`, `request_capability` all become available (gated in demo).",
    "WalletConnect EVM signing via Ledger Live, USB-HID signing for Solana / TRON / BTC / LTC.",
  ];
  const whatYoullLose = [
    "Simulated-broadcast safety net — typos and incorrect tx parameters now have real on-chain consequences.",
    "The curated persona walkthrough (defi-degen / stable-saver / staking-maxi / whale).",
    "Auto-retry on the Helius nudge — once you exit, you must have a Solana RPC key (env var, config, or `set_helius_api_key` re-set per session) for usable Solana reads.",
  ];

  const preflightChecklist: { item: string; reason: string }[] = [];
  if (args.hasLedger !== true) {
    preflightChecklist.push({
      item: "Confirm your Ledger device is plugged in and unlocked",
      reason:
        "Real signing requires the device to be reachable over USB-HID (Solana / TRON / BTC / LTC) or via Ledger Live (WalletConnect for EVM).",
    });
  }
  if (chains.includes("solana")) {
    preflightChecklist.push({
      item: "Acquire a Helius API key",
      reason:
        "Public Solana RPC throttles within seconds of any real walkthrough — Helius free tier is essentially required.",
    });
  }
  if (chains.some((c) => ["ethereum", "arbitrum", "polygon", "base", "optimism"].includes(c))) {
    preflightChecklist.push({
      item: "Acquire an Etherscan V2 API key",
      reason:
        "Required for `get_transaction_history`, `get_token_allowances`, `explain_tx`, address-poisoning scoring. Public Etherscan refuses unauthed V2 calls.",
    });
  }
  preflightChecklist.push({
    item: "Acquire a WalletConnect Project ID (EVM only)",
    reason:
      "Required for `pair_ledger_live` (the WalletConnect-based Ledger Live pairing flow). Free at https://cloud.walletconnect.com/.",
  });

  const steps: { step: number; action: string; command: string | null; note?: string }[] = [];
  let stepNum = 1;
  if (args.hasRunSetup !== true) {
    steps.push({
      step: stepNum++,
      action:
        "Run the setup wizard to configure RPC URLs + API keys + WalletConnect Project ID. " +
        "Interactive — paste keys when prompted. State written to ~/.vaultpilot-mcp/config.json (mode 0600).",
      command: "npx -y vaultpilot-mcp-setup",
    });
  } else {
    steps.push({
      step: stepNum++,
      action:
        "Setup config already exists at ~/.vaultpilot-mcp/config.json — re-run the setup wizard if you want to add more keys, otherwise skip this step.",
      command: "npx -y vaultpilot-mcp-setup  # only if you want to update keys",
      note: "Re-running is idempotent — existing keys are preserved unless you explicitly overwrite them.",
    });
  }
  steps.push({
    step: stepNum++,
    action:
      "Edit your `claude mcp add` entry to remove the `--env VAULTPILOT_DEMO=true` flag (or " +
      "delete the entry and re-add without it). The MCP reads VAULTPILOT_DEMO at boot, so " +
      "the change only takes effect after a restart.",
    command: null,
    note:
      "You can also unset VAULTPILOT_DEMO globally in your shell if you prefer that pattern.",
  });
  steps.push({
    step: stepNum++,
    action:
      "Restart Claude Code (or whatever MCP client you're using). On restart, the server " +
      "boots in operational mode — every tool runs real, signing is live, demo state is gone.",
    command: null,
  });
  steps.push({
    step: stepNum++,
    action:
      "Pair your Ledger Live wallet for EVM signing. Keep your Ledger device unlocked and " +
      "Ledger Live open on your desktop during pairing.",
    command: "(call pair_ledger_live in your next conversation)",
    note:
      "For Solana / TRON, USB-HID pairing happens automatically on first signing call — no separate pair_ledger step needed.",
  });

  const copyPasteRecipe = buildClaudeMcpAddRecipe(chains);

  const cautions = [
    "Real transactions move real money. Always verify the decoded calldata + Ledger blind-sign hash before approving on-device.",
    "VaultPilot is non-custodial — your private keys never leave the Ledger. The server never sees them, and no upstream service does either.",
    "If anything looks off in the prepare-receipt block (recipient, amount, contract address), ABORT on the device. There's no recall once a tx is broadcast.",
  ];
  if (args.hasLedger !== true) {
    cautions.unshift(
      "Confirm with the user FIRST that they have a Ledger device. Without one, you cannot sign transactions and exiting demo gives you no functionality you don't already have.",
    );
  }

  return {
    currentState,
    outcome: "ready-to-exit",
    message:
      `Demo mode is currently ${currentState.subMode === "live" ? `LIVE (persona: ${currentState.activePersonaId})` : "DEFAULT"}. ` +
      `Exiting requires (a) running the setup wizard if you haven't already, (b) editing your MCP-client config to drop VAULTPILOT_DEMO=true, (c) restarting. ` +
      `Walk the user through the steps below — pause after each step to confirm before proceeding.`,
    whatYoullGain,
    whatYoullLose,
    preflightChecklist,
    steps,
    recommendedProviders,
    copyPasteRecipe,
    cautions,
  };
}

function collectProviders(chains: DemoExitChain[]): ProviderRec[] {
  const seen = new Set<string>();
  const out: ProviderRec[] = [];
  for (const chain of chains) {
    const recs = PROVIDER_RECOMMENDATIONS[chain] ?? [];
    for (const rec of recs) {
      if (seen.has(rec.service)) continue;
      seen.add(rec.service);
      out.push(rec);
    }
  }
  return out;
}

/**
 * Build a copy-paste-ready `claude mcp add` line tailored to the user's
 * chain selection. We surface the env-var slots the user will populate,
 * not literal keys (which the user has separately and we don't see).
 */
function buildClaudeMcpAddRecipe(chains: DemoExitChain[]): string {
  const envFlags: string[] = [];
  if (chains.some((c) => ["ethereum", "arbitrum", "polygon", "base", "optimism"].includes(c))) {
    envFlags.push("--env RPC_PROVIDER=alchemy");
    envFlags.push("--env RPC_API_KEY=<your-alchemy-key>");
    envFlags.push("--env ETHERSCAN_API_KEY=<your-etherscan-key>");
  }
  if (chains.includes("solana")) {
    envFlags.push("--env SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=<your-helius-key>");
  }
  if (chains.includes("tron")) {
    envFlags.push("--env TRON_API_KEY=<your-trongrid-key>");
  }
  envFlags.push("--env WALLETCONNECT_PROJECT_ID=<your-walletconnect-project-id>");
  // Note: omit VAULTPILOT_DEMO entirely — its absence is the exit signal.
  const indented = envFlags.length > 0 ? "\n  " + envFlags.join(" \\\n  ") + " \\\n  " : "";
  return `claude mcp add vaultpilot-mcp ${indented}-- npx -y vaultpilot-mcp`;
}
