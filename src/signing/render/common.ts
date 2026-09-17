/**
 * Block explorer URL template per supported chain. Only the mainnet chains
 * the server supports today — kept inline because centralizing this in a
 * helper would be premature for four entries that rarely change.
 */
const EXPLORER_TX_URL: Record<string, (hash: string) => string> = {
  ethereum: (h) => `https://etherscan.io/tx/${h}`,
  arbitrum: (h) => `https://arbiscan.io/tx/${h}`,
  polygon: (h) => `https://polygonscan.com/tx/${h}`,
  base: (h) => `https://basescan.org/tx/${h}`,
  tron: (h) => `https://tronscan.org/#/transaction/${h}`,
  bitcoin: (h) => `https://mempool.space/tx/${h}`,
};

/**
 * User-facing block emitted immediately after a successful broadcast. The
 * orchestrator must relay it VERBATIM so the txHash and explorer link land
 * in the user's chat BEFORE the polling block (which is an agent directive,
 * not user content). A live-test regression showed the agent sometimes
 * collapsed the raw JSON result and never surfaced the hash — this block
 * makes the hash impossible to miss and gives the user a one-click cross-
 * check while polling runs in the background.
 */
export function renderPostBroadcastBlock(args: {
  chain: string;
  txHash: string;
  preSignHash?: string;
}): string {
  const explorer = EXPLORER_TX_URL[args.chain];
  const explorerLine = explorer
    ? `  Explorer: [view on block explorer](${explorer(args.txHash)})`
    : `  Explorer: (open the tx hash on your chain's block explorer)`;
  const hashMatchLine = args.preSignHash
    ? `  Signed hash: ${args.preSignHash}  (same value you matched on-device at preview)`
    : null;
  // Bitcoin: ~10-min blocks make agent-side polling wasteful (issue
  // #215). End the turn after the broadcast; user checks the explorer
  // link on their own time. All other chains continue with the standard
  // "agent will report when it confirms" pattern.
  const trailingPara =
    args.chain === "bitcoin"
      ? [
          "The tx was accepted by the relay and is now propagating. Bitcoin",
          "blocks land every ~10 minutes on average — open the explorer link",
          "above when you want to check confirmation. The agent will not",
          "poll; ask it later if you want a one-shot status check.",
        ]
      : [
          "The tx was accepted by the relay and is now propagating. Inclusion polling",
          "continues below — you don't need to do anything; the agent will report the",
          "outcome when it confirms or times out.",
        ];
  return [
    "TRANSACTION BROADCAST — RELAY VERBATIM TO USER",
    `  Chain: ${args.chain}`,
    `  Tx hash: ${args.txHash}`,
    explorerLine,
    ...(hashMatchLine ? [hashMatchLine] : []),
    "",
    ...trailingPara,
  ].join("\n");
}

/**
 * Emitted as a second content block on every successful `send_transaction`
 * response. Tells the agent to poll `get_transaction_status` itself instead
 * of asking the user to type "next" — waiting on human turn-taking for a
 * routine inclusion poll is UX friction the user has to break out of.
 *
 * Cadence is per-chain: TRON blocks every ~3s, so a 5s interval adds
 * perceptible latency over the actual inclusion time; EVM L1 is ~12s,
 * where 5s is already tight. Undershooting the block time is fine — the
 * node just returns "unknown" / "pending" for the extra polls.
 *
 * For approve→action chains (`nextHandle` present), the agent must wait for
 * the approval receipt BEFORE re-simulating or sending the next step —
 * otherwise the dependent simulation fails with "insufficient allowance"
 * against pre-inclusion state.
 */
const POLL_CADENCE: Record<string, { intervalSec: number; maxPolls: number; budgetLabel: string }> = {
  ethereum: { intervalSec: 5, maxPolls: 24, budgetLabel: "~2 minutes" },
  arbitrum: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  polygon: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  base: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  tron: { intervalSec: 3, maxPolls: 20, budgetLabel: "~1 minute" },
  // Solana: 400ms slots; poll aggressively for the first ~30s (~60 polls)
  // within the ~60-90s blockhash-validity window. Past that, further
  // polling is pointless — dropped txs get surfaced by the status tool's
  // blockhash-expiry check once the baked blockhash is past.
  solana: { intervalSec: 2, maxPolls: 45, budgetLabel: "~90 seconds" },
  // No `bitcoin` entry: the BTC branch in `renderPostSendPollBlock`
  // returns a "do NOT poll, end your turn" directive (10-min blocks
  // make agent-side polling wasteful — issue #215). Don't reintroduce a
  // bitcoin cadence here; route any new BTC post-send guidance through
  // the early-return branch instead.
};

export function renderPostSendPollBlock(args: {
  chain: string;
  txHash: string;
  nextHandle?: string;
  /**
   * Solana legacy-blockhash txs only (currently just `nonce_init`). Lets
   * the status poller distinguish `dropped` (current block past this) from
   * `pending` for that specific tx kind.
   */
  lastValidBlockHeight?: number;
  /**
   * Solana durable-nonce txs (every send except nonce_init). Lets the
   * status poller authoritatively distinguish `dropped` (on-chain nonce
   * rotated past the baked value) from `pending`. Without it a dropped
   * durable-nonce tx reads as `pending` forever — a known Phase 2 UX gap.
   */
  durableNonce?: { noncePubkey: string; nonceValue: string };
}): string {
  const { chain, txHash, nextHandle, lastValidBlockHeight, durableNonce } = args;
  // Bitcoin: ~10-min average block time + heavy variance. Agent-side
  // polling (even at 30s intervals for 12 minutes) wastes context for
  // ~1 block of coverage and almost always times out without a result.
  // The user checks mempool.space themselves; the agent ends its turn.
  // Issue #215.
  if (chain === "bitcoin") {
    const lines = [
      "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
      `The tx was forwarded to Ledger and broadcast; a txHash is above.`,
      `Bitcoin confirmation takes ~10 minutes on average and often longer;`,
      `polling at this timescale wastes turns without producing a real`,
      `outcome.`,
      ``,
      `Do NOT call get_transaction_status, do NOT poll inclusion, do NOT`,
      `say "I'll watch it" — END YOUR TURN after the TRANSACTION BROADCAST`,
      `block above. The explorer link in that block is the user's path to`,
      `monitor confirmation.`,
      ``,
      `If the user later asks "did it confirm?", call`,
      `get_transaction_status({ chain: "bitcoin", txHash: "${txHash}" })`,
      `ONCE on demand and report the result. Never enter a polling loop.`,
    ];
    if (nextHandle) {
      lines.push(
        ``,
        `A follow-up handle is queued (${nextHandle}). Do NOT proceed with`,
        `it until the user confirms the prior tx has at least 1 confirmation`,
        `— Bitcoin has no mempool-chained-spend semantics worth relying on`,
        `in an interactive flow.`,
      );
    }
    return lines.join("\n");
  }
  const cadence = POLL_CADENCE[chain] ?? POLL_CADENCE.ethereum;
  const solanaHasDropDetect =
    chain === "solana" &&
    (durableNonce !== undefined || lastValidBlockHeight !== undefined);
  let statusCall: string;
  if (chain === "solana" && durableNonce !== undefined) {
    statusCall =
      `get_transaction_status({ chain: "solana", txHash: "${txHash}", durableNonce: ` +
      `{ noncePubkey: "${durableNonce.noncePubkey}", nonceValue: "${durableNonce.nonceValue}" } })`;
  } else if (chain === "solana" && lastValidBlockHeight !== undefined) {
    statusCall = `get_transaction_status({ chain: "solana", txHash: "${txHash}", lastValidBlockHeight: ${lastValidBlockHeight} })`;
  } else {
    statusCall = `get_transaction_status({ chain: "${chain}", txHash: "${txHash}" })`;
  }
  const solanaDroppedBranch = solanaHasDropDetect
    ? [
        `  5. SOLANA SPECIFIC — if status returns "dropped", the tx is`,
        durableNonce !== undefined
          ? `     permanently gone (on-chain nonce rotated past bakedNonce=${durableNonce.nonceValue};`
          : `     permanently gone (current block height is past`,
        durableNonce !== undefined
          ? `     see returned currentNonce for the post-rotation value). Tell the`
          : `     lastValidBlockHeight=${lastValidBlockHeight}). Tell the`,
        `     user the broadcast did not land and offer to re-run the`,
        `     prepare → preview → send flow. Do NOT keep polling — "dropped"`,
        `     is terminal.`,
      ]
    : [];
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `The tx was forwarded to Ledger and broadcast; a txHash is above. Do NOT`,
    `stop and ask the user to type "next" or "check status" — poll inclusion`,
    `yourself and only speak again when you have a real outcome.`,
    ``,
    `Do this, in order:`,
    `  1. Call ${statusCall}`,
    `     every ~${cadence.intervalSec} seconds until status is "success" or "failed"${chain === "solana" ? ' or "dropped"' : ''}, or until`,
    `     you have polled for ${cadence.budgetLabel} (~${cadence.maxPolls} polls). If status stays`,
    `     "pending" / "unknown" past that budget, stop polling and tell the`,
    `     user the tx is still pending with the hash so they can watch it`,
    `     on a block explorer.`,
    `  2. On "success": one short line to the user — what confirmed, the`,
    `     short hash or an explorer link, and (if relevant) the updated`,
    `     state (e.g. new allowance, new supplied balance). Do NOT re-dump`,
    `     the full tx bullet summary.`,
    `  3. On "failed": one short line naming the failure and the hash, then`,
    `     stop — do not auto-retry.`,
    nextHandle
      ? `  4. On "success", a follow-up tx is queued (nextHandle=${nextHandle}).` +
        ` Proceed with the normal prepare/send flow for that handle — the` +
        ` approval is now on-chain so the dependent simulation will pass.` +
        ` Do NOT send the nextHandle before confirmation; a pre-inclusion` +
        ` simulate reverts with "insufficient allowance".`
      : `  4. No follow-up tx is queued; end your turn after reporting.`,
    ...solanaDroppedBranch,
    ``,
    `Between polls, stay silent — no "still waiting..." chatter. The user`,
    `only needs to hear from you when the status actually changes.`,
  ];
  return lines.join("\n");
}
