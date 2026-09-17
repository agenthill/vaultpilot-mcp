import type { TxVerification, UnsignedTronTx } from "../../types/index.js";
import { formatArgs, truncateHex } from "./format.js";

export function renderTronVerificationBlock(tx: UnsignedTronTx & { verification: TxVerification }): string {
  const v = tx.verification;
  // No on-device hash line for TRON. The Ledger TRON app clear-signs all
  // native actions (TransferContract, VoteWitness, FreezeBalanceV2, etc.)
  // and well-known TRC-20 transfers (USDT/USDC) — there is no blind-sign
  // hash for the user to match. The txID below is the cross-check anchor:
  // it appears on-device during clear-sign approval AND on tronscan after
  // broadcast. Adding a server-side "payload hash" here would train the
  // user to compare against something the device never shows, reinforcing
  // rubber-stamp habits rather than preventing them.
  //
  // The Tronscan line below is an AFTER-BROADCAST heads-up, not a pre-sign
  // defense — explicitly labeled so the user doesn't conflate it with the
  // preventive checks above. Redundant-by-design with the TRANSACTION
  // BROADCAST block emitted from sendTransactionHandler, which carries the
  // same explorer URL via EXPLORER_TX_URL.tron.
  return [
    "VERIFY BEFORE SIGNING (TRON) — no browser decoder URL; confirm the",
    "action + args below match what you intended, else REJECT on Ledger.",
    `  Action:  ${tx.action}`,
    `  Call:    ${v.humanDecode.functionName}`,
    ...formatArgs(v),
    `  from=${tx.from}  txID=${tx.txID}  rawData=${truncateHex(tx.rawDataHex, true)}`,
    "",
    "AFTER BROADCAST (not a pre-sign check):",
    `  Paste txID into [tronscan.org](https://tronscan.org/#/transaction/${tx.txID}) to cross-check on-network.`,
  ].join("\n");
}

/**
 * swiss-knife.xyz calldata decoder URL for a TRC-20 transfer/approve. The
 * decoder works on raw ABI-encoded bytes — selector + 32-byte address slot
 * + 32-byte uint256 — and falls back to 4byte.directory for the function
 * name when no chainId/address is supplied (TRON isn't in swiss-knife's
 * chain dropdown). The standard TRC-20 selectors `a9059cbb`/`095ea7b3`
 * are universally registered in 4byte, so the decoded view shows the
 * recipient + amount the same way it would for an EVM transfer.
 */
function tronSwissKnifeUrl(calldataHex: `0x${string}`): string {
  return `https://calldata.swiss-knife.xyz/decoder?calldata=${calldataHex}`;
}

/**
 * Per-tx instructions for the orchestrator agent — the TRON parallel of
 * EVM's `renderPreviewVerifyAgentTaskBlock`. TRON has no preview step
 * (handle goes straight to `send_transaction`), so the agent task block
 * piggybacks on the prepare response.
 *
 * Mirrors EVM's clear-sign branch: emit a structured CHECKS PERFORMED
 * template the agent fills in, splice in a swiss-knife.xyz decoder URL
 * for TRC-20 calldata, and surface a single-line `node -e ...require(
 * 'bs58check')` recipient cross-check the agent runs in Bash. Without
 * this server-authored template the agent improvises — past live
 * regressions had it shell out to a multi-line `python3 -c "..."` for
 * the base58check decode, which trips Bash approval scariness flags
 * and produces an unstructured CHECKS PERFORMED block.
 *
 * PAIR-CONSISTENCY HASH is N/A on TRON: the Ledger TRON app clear-signs
 * every supported action, so there's no blind-sign hash to recompute.
 * The agent renders that line as `⏸ N/A on TRON (clear-sign)`, mirror
 * of EVM's clear-sign branch which drops CHECK 2 entirely.
 */
export function renderTronAgentTaskBlock(
  tx: UnsignedTronTx & { verification: TxVerification },
): string {
  const v = tx.verification;
  const isTrc20Transfer = tx.action === "trc20_send";
  const isTrc20Approve = tx.action === "trc20_approve";
  const recipientB58 = isTrc20Transfer
    ? tx.decoded.args.to
    : isTrc20Approve
      ? tx.decoded.args.spender
      : undefined;
  const symbol = tx.decoded.args.symbol;
  const amount = tx.decoded.args.amount;
  const calldataHex = v.tronCalldataHex;
  const decoderUrl = calldataHex ? tronSwissKnifeUrl(calldataHex) : undefined;

  const checksPayload = {
    calldataDecode: {
      autoRun: true,
      threat: "MCP-side calldata tampering",
      keywords: ["calldata tampering"],
    },
    secondLlm: {
      autoRun: false,
      threat: "coordinated agent compromise",
      keywords: ["coordinated", "agent"],
    },
  };

  const trc20CheckLines = recipientB58 && calldataHex
    ? [
        "CHECK 1 — RECIPIENT CALLDATA DECODE",
        "  Protects against: MCP-side calldata tampering. If the server",
        "  rewrote the recipient slot inside `parameter`, the typed base58",
        "  address won't match the hex sitting in the calldata you'll sign.",
        "",
        "  Run in-process with bs58check (already a server dep). The typed",
        "  base58 address is spliced in below — feed it through the decoder",
        "  and compare to the recipient slot in the calldata:",
        "",
        `    node -e "console.log(Buffer.from(require('bs58check').decode('${recipientB58}')).slice(1).toString('hex'))"`,
        "",
        `  Calldata: ${calldataHex}`,
        "  Recipient slot in the calldata is hex chars 32–72 of the calldata",
        "  (after `0x<selector>` + 24 left-pad zeros). Compare your decoded",
        "  hex byte-for-byte. Report ✓ MATCH or ✗ MISMATCH.",
      ]
    : [
        "CHECK 1 — ACTION DECODE",
        "  Protects against: MCP-side rawData tampering. This action carries",
        "  no ABI calldata (native send / vote / freeze / unfreeze / claim).",
        "  Confirm the decoded action + args above match the user's request",
        "  byte-for-byte against the description line. Report ✓ ACTION DECODE",
        "  MATCH or ✗ MISMATCH.",
      ];

  const checksTemplateCheckLine = recipientB58
    ? "    {✓|✗|⚠} CALLDATA DECODE — <one-line verdict>."
    : "{✓|✗|⚠} ACTION DECODE — <one-line verdict>.";

  const decoderUrlLine = decoderUrl
    ? [
        `  Browser-side decode fallback: [Open in swiss-knife decoder](${decoderUrl})`,
      ]
    : [];

  const onDeviceLines = recipientB58
    ? [
        `Token: ${symbol ?? "?"}   Amount: ${amount ?? "?"}`,
        `Recipient: ${recipientB58}`,
        "Read the FULL recipient on-device, char-by-char, against the value",
        "above. Mismatch → REJECT on the device.",
      ]
    : [
        `Action: ${tx.action}`,
        "Confirm the action type + key fields shown by the device match the",
        "prepare summary. Mismatch → REJECT on the device.",
      ];

  const lines = [
    "[AGENT TASK — RUN THIS CHECK NOW, DO NOT ASK THE USER]",
    "You MUST run the integrity check below UNPROMPTED and report the result",
    "in a prominent CHECKS PERFORMED block. The user already consented to",
    "verification by calling prepare_tron_*; do NOT surface a yes/no menu.",
    "",
    "TRON clear-signs every supported action on-device, so PAIR-CONSISTENCY",
    "HASH is N/A — the hash-match path never fires. Render that line as",
    "`⏸ N/A on TRON (clear-sign)` in the template below.",
    "",
    ...trc20CheckLines,
    "",
    "CHECKS PAYLOAD (the threat taxonomy + required keywords the user-facing",
    "block below MUST cover — paraphrase naturally but every listed keyword",
    "must appear verbatim somewhere in the matching line):",
    "",
    "```json",
    JSON.stringify(checksPayload, null, 2),
    "```",
    "",
    "After the check runs, emit EXACTLY this block shape to the user — CAPS",
    "headers, ✓/✗/⚠/⏸ symbols, the keywords above embedded in each threat",
    "clause.",
    "",
    "NOTATION — READ THIS BEFORE COPYING THE BLOCK:",
    "  Placeholders you REPLACE in your output:",
    "    {✓|✗|⚠}            pick one symbol based on your verdict",
    "    <one-line verdict> your own prose describing the result",
    "  Literal characters you KEEP EXACTLY in your output:",
    "    [label](url)       Markdown hyperlink → clickable link",
    "  Do NOT \"clean up\" these Markdown characters for plain-text output.",
    "",
    "═══════ CHECKS PERFORMED ═══════",
    checksTemplateCheckLine,
    "  (protects against MCP-side calldata tampering)",
    ...decoderUrlLine,
    "⏸ PAIR-CONSISTENCY HASH — N/A on TRON (clear-sign).",
    "  (protects against MCP lying about the bytes sent to WalletConnect)",
    "□ SECOND-LLM CHECK — optional, available on request.",
    "  (protects against a coordinated agent compromise)",
    "────────────────────────────────",
    "NEXT ON-DEVICE — Ledger TRON app:",
    ...onDeviceLines,
    "════════════════════════════════",
    "",
    "If the check fails, LEAD your reply with",
    "\"FAILED — DO NOT SIGN.\" on its own line BEFORE the block.",
    ...(recipientB58
      ? [
          "",
          "Do NOT shell out to a multi-line decode script for the recipient",
          "check. The single-line node command above is the canonical form —",
          "keep it on ONE line so the Bash approval dialog stays auditable in",
          "three seconds.",
        ]
      : []),
  ];
  return lines.join("\n");
}
