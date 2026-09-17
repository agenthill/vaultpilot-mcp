import type { UnsignedSolanaTx } from "../../types/index.js";
import { solanaLedgerMessageHash } from "../verification.js";
import { getDefillamaCoinPrice } from "../../data/prices.js";
import { formatNonEvmCostPreview } from "./format.js";

/**
 * Solana Explorer Inspector URL prefilled with the message bytes — same
 * pattern EVM uses for the swiss-knife decoder URL (calldata embedded).
 * The Inspector route accepts `?message=<base64>` (verified against
 * github.com/solana-foundation/explorer/app/components/inspector/InspectorPage.tsx,
 * which reads `decodeParam(params, 'message')` and feeds it to
 * `VersionedMessage.deserialize`). Standard base64 chars (`+`, `/`, `=`)
 * need URL-encoding so we always run the input through `encodeURIComponent`.
 *
 * The URL is rendered inside the indented CHECKS PERFORMED block as a
 * Markdown hyperlink — EXACTLY mirroring EVM CHECK 1's swiss-knife render.
 * Earlier prototypes that surfaced the link OUTSIDE the block + a paste-
 * fallback code block were called "complete mess" by the user; the EVM
 * shape (one URL line inside the block, no paste section) is the canonical
 * pattern.
 */
function solanaInspectorUrl(messageBase64: string): string {
  return `https://explorer.solana.com/tx/inspector?cluster=mainnet&message=${encodeURIComponent(messageBase64)}`;
}

/**
 * Prepare-time fee preview for Solana (issue #649). Reads the precomputed
 * `estimatedFeeLamports` already on the unsigned-tx envelope (no new fee
 * math) — base + priority fee in lamports — converts to SOL (1e9), and
 * anchors it in USD via DefiLlama's `coingecko:solana` key (the same helper
 * the Solana postmortem path uses).
 *
 * Returns `null` when the fee field is absent — silent over a fabricated
 * number next to a real device prompt, matching the EVM block. The USD half
 * is dropped (native-only) when the price lookup degrades; the render never
 * throws and never blocks the preview.
 *
 * `priceFn` is injectable for deterministic tests; defaults to the real
 * cached DefiLlama fetch.
 */
export async function renderSolanaCostPreviewBlock(
  tx: Pick<UnsignedSolanaTx, "estimatedFeeLamports">,
  priceFn: () => Promise<number | undefined> = async () =>
    (await getDefillamaCoinPrice("solana").catch(() => undefined))?.price,
): Promise<string | null> {
  const lamports = tx.estimatedFeeLamports;
  if (lamports === undefined) return null;
  const sol = lamports / 1e9;
  const usdPerSol = await priceFn();
  return formatNonEvmCostPreview(sol, "SOL", usdPerSol);
}

// TRON prepare-time cost preview deferred to a follow-up issue: its fee model
// (bandwidth/energy net of staked resources) needs a net-burn-after-stake math
// layer, not just a render + USD anchor. Out of scope for #649.

/**
 * Shape of a prepare_solana_* result — the draft is in the tx-store; this
 * is the user-visible metadata returned to the agent. Parallels UnsignedTx
 * without `messageBase64` / `recentBlockhash` (those get pinned by
 * `preview_solana_send` right before signing).
 */
export interface RenderableSolanaPrepareResult {
  handle: string;
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "jito_stake"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  rentLamports?: number;
  estimatedFeeLamports?: number;
  /** Nonce-account PDA — surfaced for send / close actions (absent for init's own decoded form, but present after init completes). */
  nonceAccount?: string;
}

/**
 * Human label for each Solana action — used in the PREPARED header and as
 * a lookup in a few other places. Keeping this in one spot avoids four
 * copies of the "native_send → 'native SOL transfer'" map scattered
 * through the render code.
 */
function solanaActionLabel(action: RenderableSolanaPrepareResult["action"]): string {
  switch (action) {
    case "native_send":
      return "native SOL transfer";
    case "spl_send":
      return "SPL token transfer";
    case "nonce_init":
      return "durable-nonce init (one-time setup)";
    case "nonce_close":
      return "durable-nonce close (reclaim rent-exempt seed)";
    case "jupiter_swap":
      return "Jupiter swap";
    case "marginfi_init":
      return "MarginFi account init (one-time setup)";
    case "marginfi_supply":
      return "MarginFi supply";
    case "marginfi_withdraw":
      return "MarginFi withdraw";
    case "marginfi_borrow":
      return "MarginFi borrow";
    case "marginfi_repay":
      return "MarginFi repay";
    case "marinade_stake":
      return "Marinade stake (SOL → mSOL)";
    case "marinade_unstake_immediate":
      return "Marinade liquid unstake (mSOL → SOL via pool)";
    case "jito_stake":
      return "Jito stake (SOL → jitoSOL via SPL stake-pool)";
    case "native_stake_delegate":
      return "Native stake delegate (create stake account + delegate to validator)";
    case "native_stake_deactivate":
      return "Native stake deactivate (one-epoch cooldown before withdrawable)";
    case "native_stake_withdraw":
      return "Native stake withdraw (from inactive stake account)";
    case "lifi_solana_swap":
      return "LiFi swap / bridge (Solana source)";
    case "kamino_init_user":
      return "Kamino account init (create LUT + userMetadata + obligation)";
    case "kamino_supply":
      return "Kamino supply";
    case "kamino_borrow":
      return "Kamino borrow";
    case "kamino_withdraw":
      return "Kamino withdraw";
    case "kamino_repay":
      return "Kamino repay";
  }
}

/**
 * User-facing block emitted from `prepare_solana_*`. DELIBERATELY does not
 * contain a Message Hash — the hash is only meaningful once a fresh
 * blockhash is pinned, which happens in `preview_solana_send`. Showing a
 * hash at prepare time would train users to match a stale value.
 */
export function renderSolanaPrepareSummaryBlock(
  r: RenderableSolanaPrepareResult,
): string {
  const actionLabel = solanaActionLabel(r.action);
  const isInit = r.action === "nonce_init";
  const rentNote = isInit
    ? " (one-time rent-exempt seed for the nonce account, reclaimable via prepare_solana_nonce_close)"
    : " (one-time, creates recipient ATA)";
  return [
    `PREPARED (Solana — ${actionLabel}) — review, then confirm to continue`,
    `  ${r.description}`,
    `  From:    ${r.from}`,
    `  Call:    ${r.decoded.functionName}`,
    "  Args:",
    ...Object.entries(r.decoded.args).map(([k, v]) => `    - ${k}: ${v}`),
    ...(r.estimatedFeeLamports !== undefined
      ? [`  Est. fee: ${r.estimatedFeeLamports} lamports`]
      : []),
    ...(r.rentLamports !== undefined
      ? [`  Rent:    ${r.rentLamports} lamports${rentNote}`]
      : []),
    ...(r.nonceAccount && !isInit
      ? [`  Nonce:   ${r.nonceAccount}`]
      : []),
    "",
    "NEXT STEP — NOT YET SIGNABLE",
    "  The Solana message is NOT serialized yet: we intentionally defer the",
    "  blockhash-or-nonce pin so the ~60s on-chain validity window isn't",
    "  burned while the user reviews (durable-nonce txs don't have that",
    "  window, but init does, and the same deferral pattern keeps the flow",
    "  uniform). When the user says 'send', call `preview_solana_send(handle)`",
    "  — that tool pins the nonce value (or a fresh blockhash for init),",
    "  returns the Message Hash, and emits the CHECKS PERFORMED agent-task",
    "  block the agent runs unprompted.",
  ].join("\n");
}

/**
 * Per-call agent-task directive for `prepare_solana_*` results. Tells the
 * agent to produce a short bullet summary and then — once the user says
 * "send" — call `preview_solana_send(handle)` to pin the blockhash. All
 * the integrity checks (CHECK 1 / CHECK 2 / second-LLM) fire from the
 * `preview_solana_send` response, not here; at prepare time there are no
 * final message bytes to decode or hash.
 */
export function renderSolanaPrepareAgentTaskBlock(
  r: RenderableSolanaPrepareResult,
): string {
  const isMarginfi = r.action.startsWith("marginfi_");
  const isMarinade = r.action.startsWith("marinade_");
  const isNativeStake = r.action.startsWith("native_stake_");
  const isLifiSolana = r.action === "lifi_solana_swap";
  const marginfiActionWord =
    r.action === "marginfi_init"
      ? "MarginFi account init"
      : r.action === "marginfi_supply"
        ? "MarginFi supply"
        : r.action === "marginfi_withdraw"
          ? "MarginFi withdraw"
          : r.action === "marginfi_borrow"
            ? "MarginFi borrow"
            : r.action === "marginfi_repay"
              ? "MarginFi repay"
              : null;
  const marinadeActionWord =
    r.action === "marinade_stake"
      ? "Marinade stake"
      : r.action === "marinade_unstake_immediate"
        ? "Marinade liquid unstake"
        : null;
  const nativeStakeActionWord =
    r.action === "native_stake_delegate"
      ? "native stake delegate"
      : r.action === "native_stake_deactivate"
        ? "native stake deactivate"
        : r.action === "native_stake_withdraw"
          ? "native stake withdraw"
          : null;
  const actionWord =
    r.action === "native_send"
      ? "native SOL send"
      : r.action === "spl_send"
        ? "SPL send"
        : r.action === "nonce_init"
          ? "durable-nonce init"
          : r.action === "nonce_close"
            ? "durable-nonce close"
            : r.action === "jupiter_swap"
              ? "Jupiter swap"
              : marginfiActionWord ?? marinadeActionWord ?? nativeStakeActionWord ?? (isLifiSolana ? "LiFi swap / bridge (Solana source)" : "Solana tx");
  const nonceBullet =
    r.nonceAccount && r.action !== "nonce_init"
      ? ["  - Nonce: <short nonce-account addr>"]
      : [];
  const summaryShape =
    r.action === "spl_send"
      ? [
          "  - Headline: \"Prepared SPL send — <amount> <symbol> to <short addr>\"",
          "  - From: <from address>",
          "  - To: <to address>",
          "  - Mint: <mint address> (<symbol if known>)",
          "  - Amount: <human amount + symbol>",
          ...nonceBullet,
          "  - Rent: <rent in SOL if ATA creation, else omit the bullet>",
          "  - Fee: <est. fee in SOL>",
        ]
      : r.action === "native_send"
        ? [
            "  - Headline: \"Prepared native SOL send — <amount> SOL to <short addr>\"",
            "  - From: <from address>",
            "  - To: <to address>",
            "  - Amount: <human SOL amount>",
            ...nonceBullet,
            "  - Fee: <est. fee in SOL>",
          ]
        : r.action === "nonce_init"
          ? [
              "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
              "  - Wallet: <from address>",
              "  - Nonce account: <deterministic PDA from createWithSeed(wallet, 'vaultpilot-nonce-v1')>",
              "  - Rent-exempt seed: <rent in SOL>",
              "  - Fee: <est. fee in SOL>",
              "  - Note: one-time setup; reclaimable via prepare_solana_nonce_close",
            ]
          : r.action === "nonce_close"
            ? [
                "  - Headline: \"Prepared durable-nonce close — returning <balance> SOL to main wallet\"",
                "  - Wallet: <from address>",
                "  - Nonce account: <will be destroyed after this tx>",
                "  - Destination: <from address (returns to the same wallet)>",
                "  - Withdraw amount: <balance in SOL>",
                ...nonceBullet,
                "  - Fee: <est. fee in SOL>",
              ]
            : r.action === "jupiter_swap"
              ? [
                  "  - Headline: \"Prepared Solana swap — <inputAmount> <inputSymbol> → <outputAmount> <outputSymbol> via Jupiter\"",
                  "  - From: <from address>",
                  "  - Input mint: <inputMint from decoded.args> (<inputSymbol if known>)",
                  "  - Output mint: <outputMint from decoded.args> (<outputSymbol if known>)",
                  "  - Expected output: <outputAmount> <outputSymbol> (min <minOutput> @ <slippageBps> bps)",
                  "  - Route: <route labels joined with →, from decoded.args.route>",
                  "  - Price impact: <priceImpactPct>%",
                  ...nonceBullet,
                  "  - Fee: <est. fee in SOL (priority + base)>",
                ]
              : r.action === "marginfi_init"
                ? [
                    "  - Headline: \"Prepared MarginFi account init — <short PDA>\"",
                    "  - Wallet: <from address>",
                    "  - MarginfiAccount PDA: <marginfiAccount from decoded.args>",
                    "  - Account index: <accountIndex from decoded.args, default 0>",
                    ...nonceBullet,
                    "  - Rent: ~0.017 SOL (rent-exempt minimum for the MarginfiAccount PDA; reclaimable when the account is closed)",
                    "  - Fee: <est. fee in SOL>",
                  ]
                : isMarginfi
                  ? [
                      // marginfi_supply / withdraw / borrow / repay — same
                      // shape; the action word differentiates the headline.
                      `  - Headline: \"Prepared ${marginfiActionWord} — <amount> <symbol>\"`,
                      "  - Wallet: <from address>",
                      "  - MarginfiAccount: <marginfiAccount from decoded.args>",
                      "  - Bank: <bank from decoded.args> (<symbol>)",
                      "  - Amount: <human amount + symbol>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "marinade_stake"
                  ? [
                      "  - Headline: \"Prepared Marinade stake — <amountSol> SOL → mSOL\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountSol> SOL (deposit)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "marinade_unstake_immediate"
                  ? [
                      "  - Headline: \"Prepared Marinade liquid unstake — <amountMSol> mSOL → SOL (pool, with fee)\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountMSol> mSOL (burned)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_delegate"
                  ? [
                      "  - Headline: \"Prepared native stake delegate — <amountSol> SOL → validator <short>\"",
                      "  - Wallet: <from address>",
                      "  - Validator: <validator from decoded.args>",
                      "  - Stake amount: <amountSol> SOL",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      "  - Rent-exempt seed: <rentLamports>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_deactivate"
                  ? [
                      "  - Headline: \"Prepared native stake deactivate — <stakeAccount short>\"",
                      "  - Wallet: <from address>",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : r.action === "native_stake_withdraw"
                  ? [
                      "  - Headline: \"Prepared native stake withdraw — <amountSol> SOL from <stakeAccount short>\"",
                      "  - Wallet: <from + recipient>",
                      "  - Stake account: <stakeAccount from decoded.args>",
                      "  - Amount: <amountSol> SOL (or 'max')",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : isLifiSolana
                  ? [
                      "  - Headline: \"Prepared LiFi <swap|bridge> — <fromAmount> <inputSymbol> → ~<minOutput> <outputSymbol> on <toChain>\"",
                      "  - From wallet: <from address>",
                      "  - Input: <fromAmount from decoded.args> <inputSymbol> (mint: <fromMint>)",
                      "  - Output: ~<minOutput> <outputSymbol> on <toChain> (token: <toToken>)",
                      "  - Tool / route: <tool from decoded.args>",
                      "  - Slippage: <slippageBps from decoded.args> bps",
                      "  - Destination wallet: <toAddress, or 'same as source' if absent>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : [
                      // Fallback for any newly-added Solana action that
                      // hasn't been wired up here yet — surface a generic
                      // shape rather than reusing the nonce_close template
                      // (which was #97's silent-mismatch bug).
                      `  - Headline: \"Prepared ${actionWord}\"`,
                      "  - From: <from address>",
                      ...nonceBullet,
                      "  - Fee: <est. fee in SOL>",
                    ];
  const closingLine =
    r.action === "nonce_init"
      ? '  "Reply \'send\' to continue — I\'ll pin a fresh blockhash (this init tx is the one exception that uses legacy-blockhash mode), run the mandatory integrity checks, and surface the Ledger Message Hash for you to match on-device."'
      : '  "Reply \'send\' to continue — I\'ll pin the current nonce value, run the mandatory integrity checks, and surface the Ledger Message Hash for you to match on-device."';
  return [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `Produce a COMPACT bullet summary of the prepared ${actionWord}. Required shape:`,
    ...summaryShape,
    "",
    "End with ONE line:",
    closingLine,
    "",
    "Do NOT call `preview_solana_send` or `send_transaction` yet — wait for",
    "the user's 'send'. When they reply, call `preview_solana_send(handle)`",
    "with the handle below; that response carries the CHECKS template and",
    "the Message Hash. Do NOT fabricate a hash here — none exists yet; the",
    "blockhash/nonce gets pinned at preview_solana_send time.",
    "",
    `Handle: ${r.handle}`,
  ].join("\n");
}

/**
 * User-facing VERIFY BEFORE SIGNING block for Solana txs. Two shapes:
 *
 * - native_send (SystemProgram.Transfer): the Ledger Solana app clear-signs
 *   these unconditionally, so we print the decoded action + amount +
 *   recipient and tell the user to confirm the on-device screens. No
 *   Message Hash — the user has nothing to match.
 *
 * - spl_send (Token.TransferChecked, possibly with createAssociatedTokenAccount
 *   prepended): empirically the Ledger Solana app drops into blind-sign here
 *   because the parser at libsol/spl_token_instruction.c requires a signed
 *   "Trusted Name" TLV descriptor that only Ledger Live supplies. In
 *   blind-sign mode the device displays base58(sha256(messageBytes)) under
 *   the label "Message Hash". We compute the same value server-side and
 *   surface it in bold+code so the user has it on-screen BEFORE the device
 *   prompt fires — same UX the EVM blind-sign flow already uses.
 */
export function renderSolanaVerificationBlock(tx: UnsignedSolanaTx): string {
  if (tx.action === "spl_send") {
    return renderSolanaSplVerificationBlock(tx);
  }
  // native_send: Ledger clear-signs SystemProgram.Transfer.
  // nonce_init / nonce_close: all-SystemProgram ixs; per source these
  //   clear-sign (memory: project_solana_durable_nonce_viability.md —
  //   "Ledger clear-signs AdvanceNonceAccount, source; not device-tested").
  //   If the device DOES drop to blind-sign for some reason, the pair-
  //   consistency check + INSTRUCTION DECODE still catch tampering; the
  //   user just won't have a hash to match. Add the hash to the render in
  //   a future pass if live testing shows blind-sign behavior.
  return renderSolanaNativeVerificationBlock(tx);
}

function formatSolanaDecodedArgs(tx: UnsignedSolanaTx): string[] {
  return Object.entries(tx.decoded.args).map(
    ([k, v]) => `    - ${k}: ${v}`,
  );
}

function renderSolanaNativeVerificationBlock(tx: UnsignedSolanaTx): string {
  const headerLabel =
    tx.action === "native_send"
      ? "native SOL transfer"
      : tx.action === "nonce_init"
        ? "durable-nonce init (one-time setup)"
        : tx.action === "nonce_close"
          ? "durable-nonce close (reclaim seed)"
          : "Solana tx"; // spl_send routes through the other branch
  const explainerLine =
    tx.action === "native_send"
      ? "The Ledger Solana app clear-signs SystemProgram.Transfer. The on-device"
      : "The Ledger Solana app clear-signs SystemProgram instructions. The on-device";
  const hashLabel = tx.nonce ? "Nonce value" : "Blockhash";
  return [
    `VERIFY BEFORE SIGNING (Solana — ${headerLabel})`,
    explainerLine,
    "screens will show the amount and recipient — confirm they match the",
    "decoded call below, else REJECT on the device.",
    "",
    `  Call:    ${tx.decoded.functionName}`,
    "  Args:",
    ...formatSolanaDecodedArgs(tx),
    `  From:    ${tx.from}`,
    ...(tx.nonce
      ? [`  Nonce account: ${tx.nonce.account}`]
      : []),
    `  ${hashLabel}: ${tx.recentBlockhash}`,
  ].join("\n");
}

function renderSolanaSplVerificationBlock(tx: UnsignedSolanaTx): string {
  const ledgerHash = solanaLedgerMessageHash(tx.messageBase64);
  return [
    "VERIFY BEFORE SIGNING (Solana — SPL token transfer)",
    "The Ledger Solana app does NOT auto clear-sign SPL transfers (the app",
    "requires a signed Trusted-Name descriptor that only Ledger Live supplies).",
    "Your device will BLIND-SIGN: it shows a 'Message Hash' and nothing else.",
    "",
    "  Required one-time setup: on your Ledger → Solana app → Settings →",
    "  enable 'Allow blind signing'. If this isn't enabled the app will",
    "  refuse to sign.",
    "",
    "LEDGER MESSAGE HASH — match this against your device screen:",
    `  **\`${ledgerHash}\`**`,
    "",
    "This is base58(sha256(messageBytes)) — the exact string the Solana app",
    "computes and displays under the 'Message Hash' label. If the device",
    "shows a different value, REJECT — something between this preview and",
    "the device is tampering with the tx.",
    "",
    `  Call:    ${tx.decoded.functionName}`,
    "  Args:",
    ...formatSolanaDecodedArgs(tx),
    `  From:    ${tx.from}`,
    `  Blockhash: ${tx.recentBlockhash}`,
  ].join("\n");
}

/**
 * Per-call agent-task directive for Solana prepare results. Mirrors the EVM
 * `renderPreviewVerifyAgentTaskBlock` shape: two mandatory integrity checks
 * (instruction-decode, and — for blind-sign SPL — pair-consistency on the
 * Ledger Message Hash) plus an optional user-prompted second-LLM check.
 *
 * Solana has no `preview_send` step (the message bytes + blockhash are
 * already pinned at prepare time), so all checks run in the prepare agent-
 * task block rather than a later preview block. Native SOL sends drop the
 * pair-consistency check — SystemProgram.Transfer clear-signs on-device so
 * the user already sees decoded fields; no hash-match path fires.
 */
export function renderSolanaAgentTaskBlock(tx: UnsignedSolanaTx): string {
  const isSpl = tx.action === "spl_send";
  const isNativeSend = tx.action === "native_send";
  const isNonceInit = tx.action === "nonce_init";
  const isNonceClose = tx.action === "nonce_close";
  const isJupiterSwap = tx.action === "jupiter_swap";
  const isMarginfi =
    tx.action === "marginfi_init" ||
    tx.action === "marginfi_supply" ||
    tx.action === "marginfi_withdraw" ||
    tx.action === "marginfi_borrow" ||
    tx.action === "marginfi_repay";
  const isMarinade =
    tx.action === "marinade_stake" ||
    tx.action === "marinade_unstake_immediate";
  const isNativeStake =
    tx.action === "native_stake_delegate" ||
    tx.action === "native_stake_deactivate" ||
    tx.action === "native_stake_withdraw";
  const isLifiSolana = tx.action === "lifi_solana_swap";
  const isKamino =
    tx.action === "kamino_init_user" ||
    tx.action === "kamino_supply" ||
    tx.action === "kamino_borrow" ||
    tx.action === "kamino_withdraw" ||
    tx.action === "kamino_repay";
  const marginfiActionLabel =
    tx.action === "marginfi_init"
      ? "account init"
      : tx.action === "marginfi_supply"
        ? "supply"
        : tx.action === "marginfi_withdraw"
          ? "withdraw"
          : tx.action === "marginfi_borrow"
            ? "borrow"
            : tx.action === "marginfi_repay"
              ? "repay"
              : null;

  // SPECIAL CASE — nonce_init is the one Solana action where ALL the
  // standard checks are pure ceremony. Why:
  //   - It's a one-time, deterministic, two-instruction tx
  //     (createAccountWithSeed + nonceInitialize).
  //   - The Ledger Solana app clear-signs both ixs on-device — the user
  //     sees the new account address, seed, authority, and rent values.
  //   - Those on-device fields ARE the integrity gate. CHECK 1 (browser-
  //     verify decode) and CHECK 2 (pair-consistency hash) add nothing
  //     a clear-sign user can't already verify with their eyes.
  //   - The cost of running the standard verification block is real:
  //     ~30s of agent prep time on a tx with a ~60s legacy blockhash
  //     window (nonce_init can't use durable-nonce protection since
  //     it's the tx CREATING the nonce). Three live attempts blew that
  //     window before this short-circuit was added.
  // For every OTHER Solana action (native_send / spl_send / nonce_close)
  // the standard CHECKS PERFORMED block + Explorer URL still applies.
  if (isNonceInit) {
    return [
      "[AGENT TASK — RUN THIS NOW, DO NOT ASK THE USER]",
      "",
      "Produce a COMPACT bullet summary of the prepared durable-nonce init.",
      "Required shape:",
      "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
      "  - Wallet: <from address>",
      "  - Nonce account: <nonce-account PDA>",
      "  - Authority: <from address (same as wallet)>",
      "  - Rent-exempt seed: <rent in SOL (~0.00144 SOL)>",
      "  - Fee: <fee in SOL>",
      "",
      "Then — do NOT emit a CHECKS PERFORMED block, do NOT surface a Solana",
      "Explorer Inspector link, do NOT compute a Message Hash. nonce_init is",
      "a deterministic two-ix System Program tx and the Ledger Solana app",
      "CLEAR-SIGNS both instructions on-device. The on-device fields are the",
      "integrity gate; an extra browser-verify step adds nothing a clear-sign",
      "user can't already see, and the legacy ~60s blockhash window makes",
      "the extra ceremony actively harmful (live regression: three failed",
      "attempts before this short-circuit was added).",
      "",
      "Lead with this on-device instruction so the user knows what to",
      "expect when they press the button on Ledger:",
      "",
      "  Ledger CLEAR-SIGN — your device will display the two System",
      "  Program instructions in plain text:",
      "    1. CreateAccountWithSeed: confirm `New Account` matches the",
      "       Nonce account bullet above, `Base` matches your Wallet,",
      "       `Seed` is exactly \"vaultpilot-nonce-v1\", and `Lamports`",
      "       matches the Rent-exempt seed bullet.",
      "    2. NonceInitialize: confirm `Nonce Authority` equals your",
      "       Wallet (so YOU stay in control of the nonce).",
      "  Any field that doesn't match → REJECT on-device.",
      "",
      "End with ONE line, no menu, no second-LLM offer:",
      "  Reply 'send' to broadcast — approve on-device when the Solana app",
      "  prompts. The legacy ~60s blockhash window starts now.",
      "",
      "SEND-CALL CONTRACT — when the user replies \"send\", call",
      "`send_transaction` with: handle: <from prepare result>, confirmed: true.",
    ].join("\n");
  }

  // Send-type txs (native_send / spl_send / nonce_close) all carry
  // ix[0] = SystemProgram.nonceAdvance for durable-nonce protection.
  // Every send-type tx (any action except nonce_init) carries nonceAdvance
  // as ix[0] — this flag drives the "DURABLE-NONCE MODE" explainer text +
  // the Nonce bullet in the summary + the expected-shape text for CHECK 1.
  const hasAdvanceNonceIx =
    isNativeSend || isSpl || isNonceClose || isJupiterSwap || isMarginfi || isMarinade || isNativeStake || isLifiSolana || isKamino;
  // The Ledger Solana app only clear-signs a small allowlist of programs
  // (System Program's transfer/advance/initialize/withdraw, and a few
  // others). Everything else falls to blind-sign, which shows only the
  // Message Hash on-device and requires the user to match it against the
  // hash the server displayed. SPL TransferChecked AND Jupiter swaps both
  // fall in that bucket.
  const isBlindSign = isSpl || isJupiterSwap || isMarginfi || isMarinade || isNativeStake || isLifiSolana || isKamino;
  const ledgerHash = isBlindSign ? solanaLedgerMessageHash(tx.messageBase64) : null;

  const checksPayload = {
    instructionDecode: {
      autoRun: true,
      threat: "MCP-side Solana message tampering",
      keywords: ["Solana", "tampering"],
    },
    ...(isBlindSign
      ? {
          pairConsistencyLedgerHash: {
            autoRun: true,
            threat: "MCP signing different bytes than it displayed",
            keywords: ["displayed"],
          },
        }
      : {}),
    secondLlm: {
      autoRun: false,
      threat: "coordinated agent compromise",
      keywords: ["coordinated", "agent"],
    },
  };

  const nonceBullet = hasAdvanceNonceIx
    ? "  - Nonce: <short nonce-account addr>"
    : null;
  const summaryShape = isSpl
    ? [
        "  - Headline: \"Prepared SPL send — <amount> <symbol> to <short addr>\"",
        "  - From: <from address>",
        "  - To: <to address>",
        "  - Mint: <mint address> (<symbol if known>)",
        "  - Amount: <human amount + symbol>",
        ...(nonceBullet ? [nonceBullet] : []),
        "  - Rent: <rent in SOL if ATA creation, else omit the bullet>",
        "  - Fee: <fee in SOL>",
      ]
    : isNativeSend
      ? [
          "  - Headline: \"Prepared native SOL send — <amount> SOL to <short addr>\"",
          "  - From: <from address>",
          "  - To: <to address>",
          "  - Amount: <human SOL amount>",
          ...(nonceBullet ? [nonceBullet] : []),
          "  - Fee: <fee in SOL>",
        ]
      : isNonceInit
        ? [
            "  - Headline: \"Prepared durable-nonce init — <short nonce addr>\"",
            "  - Wallet: <from address>",
            "  - Nonce account: <nonce-account PDA>",
            "  - Authority: <from address (same as wallet)>",
            "  - Rent-exempt seed: <rent in SOL (~0.00144 SOL)>",
            "  - Fee: <fee in SOL>",
          ]
        : isNonceClose
          ? [
              "  - Headline: \"Prepared durable-nonce close — returning <balance> SOL to <wallet short>\"",
              "  - Wallet: <from address>",
              "  - Nonce account: <nonce-account PDA, will be destroyed>",
              "  - Destination: <from address (returns to main wallet)>",
              "  - Withdraw amount: <balance in SOL>",
              ...(nonceBullet ? [nonceBullet] : []),
              "  - Fee: <fee in SOL>",
            ]
          : isJupiterSwap
            ? [
                "  - Headline: \"Prepared Solana swap — <inputAmount> <inputSymbol> → <outputAmount> <outputSymbol> via Jupiter\"",
                "  - From: <from address>",
                "  - Input mint: <inputMint> (<inputSymbol if known>)",
                "  - Output mint: <outputMint> (<outputSymbol if known>)",
                "  - Expected output: <outputAmount> <outputSymbol> (min <minOutput> @ <slippageBps> bps)",
                "  - Route: <route labels joined with →, from decoded.args.route>",
                "  - Price impact: <priceImpactPct>%",
                ...(nonceBullet ? [nonceBullet] : []),
                "  - Fee: <fee in SOL (priority + base)>",
              ]
            : tx.action === "marginfi_init"
              ? [
                  "  - Headline: \"Prepared MarginFi account init — <short PDA>\"",
                  "  - Wallet: <from address>",
                  "  - MarginfiAccount PDA: <marginfiAccount from decoded.args>",
                  "  - Account index: <accountIndex from decoded.args, default 0>",
                  ...(nonceBullet ? [nonceBullet] : []),
                  "  - Fee: <est. fee in SOL>",
                  "  - Note: one-time deterministic PDA — no rent-exempt seed moved",
                ]
              : tx.action === "marinade_stake"
                ? [
                    "  - Headline: \"Prepared Marinade stake — <amountSol> SOL → mSOL\"",
                    "  - Wallet: <from address>",
                    "  - Amount: <amountSol> SOL (deposit)",
                    "  - mSOL ATA: <mSolAta from decoded.args (created on first stake if missing)>",
                    ...(nonceBullet ? [nonceBullet] : []),
                    "  - Fee: <est. fee in SOL>",
                  ]
                : tx.action === "marinade_unstake_immediate"
                  ? [
                      "  - Headline: \"Prepared Marinade liquid unstake — <amountMSol> mSOL → SOL (via pool, with fee)\"",
                      "  - Wallet: <from address>",
                      "  - Amount: <amountMSol> mSOL (burned)",
                      "  - mSOL ATA: <mSolAta from decoded.args>",
                      "  - Note: routes via Marinade's liquidity pool — small fee, immediate (NOT delayed-unstake / OrderUnstake — that flow needs an ephemeral signer and isn't shipped here)",
                      ...(nonceBullet ? [nonceBullet] : []),
                      "  - Fee: <est. fee in SOL>",
                    ]
                  : tx.action === "native_stake_delegate"
                    ? [
                        "  - Headline: \"Prepared native stake delegate — <amountSol> SOL → validator <short>\"",
                        "  - Wallet: <from address>",
                        "  - Validator: <validator vote pubkey from decoded.args>",
                        "  - Stake amount: <amountSol> SOL (active principal)",
                        "  - Stake account: <stakeAccount from decoded.args (deterministic per (wallet, validator))>",
                        "  - Rent-exempt seed: <rentLamports from decoded.args> lamports (~0.00228 SOL — reclaimable on full withdraw)",
                        ...(nonceBullet ? [nonceBullet] : []),
                        "  - Fee: <est. fee in SOL>",
                        "  - Note: stake activates next epoch (~2-3 days); use prepare_native_stake_deactivate then prepare_native_stake_withdraw to exit",
                      ]
                    : tx.action === "native_stake_deactivate"
                      ? [
                          "  - Headline: \"Prepared native stake deactivate — <stakeAccount short>\"",
                          "  - Wallet: <from address>",
                          "  - Stake account: <stakeAccount from decoded.args>",
                          ...(nonceBullet ? [nonceBullet] : []),
                          "  - Fee: <est. fee in SOL>",
                          "  - Note: deactivation takes one epoch (~2-3 days). After it lands, prepare_native_stake_withdraw can fully drain.",
                        ]
                      : tx.action === "native_stake_withdraw"
                        ? [
                            "  - Headline: \"Prepared native stake withdraw — <amountSol> SOL from <stakeAccount short>\"",
                            "  - Wallet: <from + recipient (same address)>",
                            "  - Stake account: <stakeAccount from decoded.args>",
                            "  - Amount: <amountSol> SOL (or 'max' = full balance, closes the account)",
                            ...(nonceBullet ? [nonceBullet] : []),
                            "  - Fee: <est. fee in SOL>",
                            "  - Note: stake account must already be inactive (1 epoch after deactivate); on-chain reverts otherwise",
                          ]
                        : tx.action === "lifi_solana_swap"
                          ? [
                              "  - Headline: \"Prepared LiFi <swap|bridge> — <fromAmount> <inputSymbol> → ~<minOutput> <outputSymbol>\"",
                              "  - From wallet: <from address>",
                              "  - Input: <fromAmount> <inputSymbol> (mint: <fromMint from decoded.args>)",
                              "  - Output: ~<minOutput> <outputSymbol> on <toChain> (token: <toToken from decoded.args>)",
                              "  - Tool / route: <tool from decoded.args>",
                              "  - Slippage: <slippageBps from decoded.args> bps",
                              "  - Destination wallet: <toAddress from decoded.args, or 'same as source' if omitted>",
                              ...(nonceBullet ? [nonceBullet] : []),
                              "  - Fee: <est. fee in SOL>",
                              "  - Note: cross-chain bridges complete in 2 stages — Solana source tx confirms first; destination delivery happens after via the bridge protocol (typically 1-15 min depending on tool).",
                            ]
                          : tx.action === "kamino_init_user"
                            ? [
                                "  - Headline: \"Prepared Kamino account init — userMetadata + obligation\"",
                                "  - Wallet: <from address>",
                                "  - Market: <market from decoded.args>",
                                "  - UserMetadata PDA: <userMetadata from decoded.args>",
                                "  - User lookup table: <userLookupTable from decoded.args>",
                                "  - Obligation PDA: <obligation from decoded.args>",
                                ...(nonceBullet ? [nonceBullet] : []),
                                "  - Fee: <est. fee in SOL>",
                                "  - Note: one-time setup; after this lands, prepare_kamino_supply / borrow / withdraw / repay all work without re-initing.",
                              ]
                            : tx.action === "kamino_supply"
                              ? [
                                  "  - Headline: \"Prepared Kamino supply — <amount> <symbol>\"",
                                  "  - Wallet: <from address>",
                                  "  - Reserve: <reserve from decoded.args>",
                                  "  - Mint: <mint from decoded.args> (<symbol>)",
                                  "  - Amount: <amount> <symbol>",
                                  "  - Obligation: <obligation from decoded.args>",
                                  ...(nonceBullet ? [nonceBullet] : []),
                                  "  - Fee: <est. fee in SOL>",
                                ]
                              : [
                      // marginfi_supply / withdraw / borrow / repay — same shape,
                      // only the "Action" bullet text differs; keep one template.
                      `  - Headline: \"Prepared MarginFi ${marginfiActionLabel} — <amount> <symbol>\"`,
                      "  - Wallet: <from address>",
                      "  - MarginfiAccount: <marginfiAccount from decoded.args>",
                      "  - Bank: <bank from decoded.args> (<symbol>)",
                      "  - Amount: <human amount + symbol>",
                      ...(nonceBullet ? [nonceBullet] : []),
                      "  - Fee: <est. fee in SOL>",
                    ];

  const inspectorUrl = solanaInspectorUrl(tx.messageBase64);

  // CHECK 2 only fires for blind-sign actions (Ledger shows just the
  // Message Hash, no decoded fields). For clear-sign actions (native_send,
  // nonce_init, nonce_close) the on-device decoded fields ARE the
  // integrity gate and a server-side hash recompute adds nothing — same
  // policy EVM uses for clear-sign txs (native sends, ERC20
  // transfers/approvals).
  // CHECK 2 (pair-consistency hash recompute) fires when the device would
  // blind-sign — without the hash, the on-device screen has nothing but a
  // hash to match against, so we need to bind the displayed bytes to the
  // displayed hash. Clear-sign actions (native_send, nonce_close) skip CHECK
  // 2 because the on-device decoded fields ARE the integrity gate.
  const needsPairConsistency = isBlindSign;
  // Combined CHECK 1 + CHECK 2 script — single Bash invocation, single
  // approval prompt, two verdicts. Mirrors EVM CHECK 2's template shape
  // (multi-line `node -e "..."` with `<messageBase64 from the prepare_*
  // result>` as a JS string-literal placeholder the agent splices in).
  //
  // What the script computes:
  //   - ledgerHash = base58(sha256(msg)) — same value the Ledger Solana
  //     app derives and shows on blind-sign. PublicKey(<32-byte buffer>)
  //     .toBase58() does base58 encoding (works for raw sha256 digests).
  //   - instructions[] = per-ix { programId, accounts, dataHex } extracted
  //     via @solana/web3.js. The script auto-detects message version:
  //       - legacy (no 0x80 prefix): `Message.from(buf)` — instruction data
  //         is base58, decoded via the inline bs58→hex helper below (bs58 v6
  //         is ESM-only so `require('bs58')` fails; the decoder is one line).
  //       - v0 (0x80 prefix): `VersionedMessage.deserialize(buf)` — fetches
  //         Address Lookup Table accounts via an RPC Connection, flattens
  //         static + ALT-resolved account keys, then reads `compiledInstructions`
  //         (data is already a Uint8Array, no base58 decode needed).
  //     The v0 branch requires network access (to fetch ALTs); the script
  //     reads the RPC URL from `SOLANA_RPC_URL` env var with a fallback to
  //     the public mainnet-beta endpoint.
  //
  // The agent inspects the JSON output and reports BOTH verdicts:
  //   - CHECK 1 ✓/✗ on instruction structure (programId + accounts +
  //     dataHex tag) matching the bullet summary
  //   - CHECK 2 ✓/✗ on ledgerHash matching the displayed value
  const combinedCheckScript = [
    `    node -e "const {Message, VersionedMessage, PublicKey, Connection} = require('@solana/web3.js');`,
    `    const {createHash} = require('crypto');`,
    `    const m = '<messageBase64 from the preview_solana_send result>';`,
    `    const buf = Buffer.from(m, 'base64');`,
    `    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';`,
    `    const b58 = s => { if (!s.length) return ''; let n=0n; for (const c of s) n=n*58n+BigInt(A.indexOf(c)); let z=0; while (z<s.length&&s[z]==='1') z++; const h=n.toString(16); return '00'.repeat(z)+(h.length%2?'0'+h:h); };`,
    `    const ledgerHash = new PublicKey(createHash('sha256').update(buf).digest()).toBase58();`,
    `    (async () => {`,
    `      let instructions;`,
    `      if (buf[0] & 0x80) {`,
    `        const msg = VersionedMessage.deserialize(buf);`,
    `        const conn = new Connection(process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com');`,
    `        const alts = [];`,
    `        for (const lookup of msg.addressTableLookups) {`,
    `          const res = await conn.getAddressLookupTable(lookup.accountKey);`,
    `          if (!res.value) throw new Error('ALT not found on chain: ' + lookup.accountKey.toBase58());`,
    `          alts.push(res.value);`,
    `        }`,
    `        const keys = msg.getAccountKeys({addressLookupTableAccounts: alts}).keySegments().flat();`,
    `        instructions = msg.compiledInstructions.map(ix => ({`,
    `          programId: keys[ix.programIdIndex].toBase58(),`,
    `          accounts: ix.accountKeyIndexes.map(i => keys[i].toBase58()),`,
    `          dataHex: Buffer.from(ix.data).toString('hex'),`,
    `        }));`,
    `      } else {`,
    `        const msg = Message.from(buf);`,
    `        instructions = msg.instructions.map(ix => ({`,
    `          programId: msg.accountKeys[ix.programIdIndex].toBase58(),`,
    `          accounts: ix.accounts.map(i => msg.accountKeys[i].toBase58()),`,
    `          dataHex: b58(ix.data),`,
    `        }));`,
    `      }`,
    `      console.log(JSON.stringify({ledgerHash, instructions}, null, 2));`,
    `    })();"`,
  ];

  // v1.6 Phase 2: compressed full-path template. Input-side prose reduced
  // (threat-model rationale lives in SECURITY.md; historical context lives
  // in git log/code comments; meta-formatting hints removed). Output-side
  // CHECKS PERFORMED template reduced to structured terse lines; on-device
  // hash still rendered on its own bare line. Security content (integrity
  // checks themselves, fail-loud rule, second-LLM escape hatch, on-device
  // match) retained verbatim.
  const onDeviceLine = isBlindSign
    ? `• BLIND-SIGN — Message Hash on-device MUST equal: ${ledgerHash}  (Allow blind signing must be ON in Solana app Settings; any difference → REJECT)`
    : isNonceClose
      ? "• CLEAR-SIGN — Solana app shows nonceAdvance + nonceWithdraw; confirm destination = your wallet, lamports = full balance. Any difference → REJECT."
      : "• CLEAR-SIGN — Solana app shows amount + recipient on-device. Confirm fields match your summary. Any difference → REJECT.";
  const pairConsistencyLine = needsPairConsistency
    ? `  {✓|✗} PAIR-CONSISTENCY LEDGER HASH — <verdict>  (protects against MCP signing different bytes than displayed)`
    : null;
  const nonceNote = hasAdvanceNonceIx
    ? "This tx is durable-nonce-protected (ix[0] = nonceAdvance); no ~60s blockhash expiry."
    : null;

  const lines = [
    "[AGENT TASK — RUN THESE CHECKS NOW, DO NOT ASK THE USER]",
    needsPairConsistency
      ? "Run BOTH integrity checks UNPROMPTED; no yes/no menu."
      : "Run the INSTRUCTION-DECODE check UNPROMPTED; no yes/no menu.",
    ...(nonceNote ? [nonceNote] : []),
    "",
    "Step 1 — emit a COMPACT bullet summary of the prepared tx:",
    ...summaryShape,
    "",
    "Step 2 — BEFORE invoking Bash, surface ONE labeling line to the user so the approval prompt is not a surprise (informational, NO yes/no menu):",
    "",
    "  > VaultPilot Solana integrity check — a `node -e \"…\"` script recomputes `base58(sha256(messageBase64))` (the Ledger Message Hash) and locally decodes the message's instructions. [Verifier source](https://github.com/szhygulin/vaultpilot-mcp/blob/main/src/signing/render-verification.ts).",
    "",
    "Step 3 — run the combined check script (splice messageBase64 in place of the placeholder):",
    "",
    ...combinedCheckScript,
    "",
    "Step 4 — verify from the script's JSON output:",
    "  CHECK 1 (INSTRUCTION DECODE): every `programId` in `instructions[]` is one you",
    "    recognize for this action; `dataHex` first-byte tags match expected ops",
    "    (System 0x04=AdvanceNonce, 0x02=Transfer; SPL Token 0x0c=TransferChecked;",
    "    ComputeBudget, ATA, Switchboard, MarginFi programs self-identify); every",
    "    `accounts[]` entry appears in your bullet summary. Verdict ✓ MATCH /",
    "    ✗ MISMATCH / ⚠ DECODE PARTIAL (unrecognized programId — direct user to",
    `    the Explorer fallback link below).`,
    ...(needsPairConsistency
      ? [
          `  CHECK 2 (PAIR-CONSISTENCY LEDGER HASH): script's \`ledgerHash\` = ${ledgerHash}. Verdict ✓ MATCH / ✗ MISMATCH.`,
        ]
      : []),
    "",
    "Step 5 — emit this block to the user (keep the structure, fill in the {✓|✗|⚠} verdicts):",
    "",
    "  CHECKS PERFORMED",
    "  {✓|✗|⚠} INSTRUCTION DECODE — <verdict>  (protects against MCP-side Solana tampering)",
    ...(pairConsistencyLine ? [pairConsistencyLine] : []),
    "  □ SECOND-LLM CHECK — optional (reply 2)  (protects against coordinated agent compromise)",
    "",
    "  NEXT ON-DEVICE:",
    `  ${onDeviceLine}`,
    ...(isBlindSign
      ? [
          "",
          `  (Render the Message Hash ${ledgerHash} bare on its own line somewhere in your reply — blank line above and below, no backticks/bold — so the user can visually match it against the device screen without the CHECKS PERFORMED preformatted region leaking ** or \` as literal characters. On-⚠ DECODE PARTIAL: add line \`Browser-side decode fallback: [Open in Solana Explorer Inspector](${inspectorUrl})\` verbatim.)`,
        ]
      : [
          ...(isBlindSign
            ? []
            : [
                "",
                "  (On-⚠ DECODE PARTIAL only: add line `Browser-side decode fallback:" +
                  ` [Open in Solana Explorer Inspector](${inspectorUrl})\` verbatim.)`,
              ]),
        ]),
    "",
    "  End with: `Want an independent second-LLM check? Reply (2). Otherwise reply 'send'.`",
    "",
    "If any mandatory check ✗, LEAD your reply with `✗ <CHECK NAME> FAILED — DO NOT SIGN.` BEFORE the block.",
    "",
    "SECOND-LLM CHECK on (2): call `get_verification_artifact({handle})`, relay its",
    "`pasteableBlock` field VERBATIM (no commentary between the START/END markers, no",
    "pre-decoding). Remind the user to paste into a different-provider LLM and compare",
    isBlindSign
      ? "its description to their intent AND match the paste-block's hash to the Ledger screen."
      : "its description to their intent AND confirm on-device decoded fields match.",
    "",
    "SEND on 'send': call `send_transaction({handle, confirmed:true})`.",
  ];
  return lines.join("\n");
}
