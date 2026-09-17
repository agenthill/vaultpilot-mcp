import { CHAIN_IDS } from "../../types/index.js";
import type { SupportedChain, TxVerification, UnsignedTx } from "../../types/index.js";
import { NATIVE_SYMBOL } from "../../config/contracts.js";
import { formatArgs, formatNativeShort, formatRecipientSuffix, truncateHex } from "./format.js";

/**
 * ERC-20 `approve(address,uint256)` selector. Ledger's Ethereum app
 * clear-signs approvals natively (showing spender + amount on-device), so
 * the swiss-knife cross-check adds no security here and just lengthens
 * the chat. The send-time payload-hash guard still runs — only the
 * user-visible block is suppressed.
 */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

/**
 * ERC-20 `transfer(address,uint256)` selector. Same reason as
 * `approve`: Ledger's Ethereum app + ERC-20 plugin clear-signs token
 * transfers on-device (shows recipient + amount + token symbol). The
 * blind-sign hash-match check never fires for these, and the
 * pair-consistency recompute adds no information that the clear-sign
 * screens don't already give the user.
 */
const ERC20_TRANSFER_SELECTOR = "0xa9059cbb";

/** Returns false for txs whose verification block should be suppressed. */
export function shouldRenderVerificationBlock(
  tx: Pick<UnsignedTx, "data">,
): boolean {
  return !tx.data.toLowerCase().startsWith(ERC20_APPROVE_SELECTOR);
}

/**
 * True for txs the Ledger Ethereum app is guaranteed to clear-sign —
 * native-value sends (empty calldata), ERC-20 `transfer`, and ERC-20
 * `approve`. For these, the CHECKS PERFORMED block should be trimmed:
 *
 *   - drop the PAIR-CONSISTENCY HASH line entirely (no value; clear-sign
 *     screens + 4byte-decode cover intent),
 *   - drop the BLIND-SIGN branch of the NEXT ON-DEVICE section (it
 *     never fires for these txs, so the instruction is noise under
 *     device-screen time pressure),
 *   - expand the CLEAR-SIGN branch to explicitly list native + ERC-20
 *     transfer + approve so the user sees their tx type named.
 *
 * DOES NOT change security guarantees — the server still pins the tuple,
 * computes the preSignHash, and enforces the payload-hash match at send
 * time. Only the user-facing render is simplified for the three cases
 * where extra lines create confusion rather than signal.
 */
export function isClearSignOnlyTx(tx: Pick<UnsignedTx, "data">): boolean {
  const data = tx.data.toLowerCase();
  // Empty calldata = native send (SystemProgram-equivalent). Any form of
  // "0x" / "" / "0x0" (some older paths emit without the prefix) counts.
  if (data === "" || data === "0x") return true;
  if (data.startsWith(ERC20_APPROVE_SELECTOR)) return true;
  if (data.startsWith(ERC20_TRANSFER_SELECTOR)) return true;
  return false;
}

/**
 * Trim a wei-denominated fee to a short gwei string. Single source of
 * truth so the preview-cost breakdown line keeps consistent precision
 * across base fee (typically 1–100 gwei) and priority fee (typically
 * 0.01–5 gwei).
 *
 *   - n ≥ 10:    rounded to integer gwei (e.g. "18")
 *   - 1 ≤ n < 10: 1 fractional digit, trailing 0 trimmed (e.g. "1.5")
 *   - n < 1:     2 fractional digits, trailing zeros trimmed (e.g. "0.05")
 *
 * Number(BigInt) is safe here — typical gwei wei values are well under
 * 2^53 (1000 gwei = 1e12 wei).
 */
function weiToGweiShort(wei: string): string {
  const n = Number(BigInt(wei)) / 1e9;
  if (!Number.isFinite(n) || n < 0) return wei;
  if (n >= 10) return n.toFixed(0);
  if (n >= 1) return n.toFixed(1).replace(/\.0$/, "");
  return n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * Preview-time cost block (issue #650). Surfaced as the FIRST content of
 * every successful EVM `preview_send` so the user can abort on a fee spike
 * that happened between prepare and preview, without scrolling back through
 * the LEDGER BLIND-SIGN HASH + agent-task surfaces below.
 *
 * Differs from prepare-time `renderCostPreviewBlock` (render/format.ts):
 *   - values come from the SERVER-PINNED tuple (the exact maxFeePerGas /
 *     maxPriorityFeePerGas / gas that go on-chain, not a prepare-time
 *     estimate that may now be stale),
 *   - adds a breakdown line (`base fee X gwei · priority Y gwei · gas N
 *     units`) so the user sees what changed if the cost spiked,
 *   - leads with "Pinned" rather than "Estimated" to communicate the
 *     commitment — these are the values the user is signing for.
 *
 * Returns null when `gasCostNative` is missing — better silent than a
 * fabricated number adjacent to a real device prompt. Native + breakdown
 * always shown together when present; USD line is degraded silently when
 * the price lookup failed.
 */
export function renderPreviewCostBlock(args: {
  chain: SupportedChain;
  gasCostNative?: string;
  gasCostUsd?: number;
  baseFeePerGas: string;
  maxPriorityFeePerGas: string;
  gas: string;
}): string | null {
  if (!args.gasCostNative) return null;
  const symbol = NATIVE_SYMBOL[args.chain];
  const nativeFmt = formatNativeShort(args.gasCostNative);
  const headline =
    args.gasCostUsd !== undefined
      ? `Pinned network fee: ~$${args.gasCostUsd.toFixed(2)} (≈ ${nativeFmt} ${symbol})`
      : `Pinned network fee: ≈ ${nativeFmt} ${symbol} (USD price unavailable)`;
  const breakdown =
    `  base fee ${weiToGweiShort(args.baseFeePerGas)} gwei` +
    ` · priority ${weiToGweiShort(args.maxPriorityFeePerGas)} gwei` +
    ` · gas ${args.gas} units`;
  return `${headline}\n${breakdown}`;
}

function dataByteLen(data: string): number {
  const normalized = data.startsWith("0x") ? data.slice(2) : data;
  return Math.floor(normalized.length / 2);
}

function formatCall(v: TxVerification): string {
  if (v.humanDecode.source === "none") {
    return "  Call:    (decoded by swiss-knife only — open the link above)";
  }
  return `  Call:    ${v.humanDecode.signature ?? v.humanDecode.functionName}`;
}

/**
 * Markdown-style clickable link for the decoder URL. Keeps the chat short
 * (4 KB URLs no longer render as a wall of hex) while still exposing the
 * raw URL inside the parens so non-markdown clients stay readable.
 */
function formatDecoder(v: TxVerification): string {
  if (v.decoderUrl) {
    return `  Decoder: [open in swiss-knife](${v.decoderUrl})`;
  }
  return `  Decoder: (paste manually) ${v.decoderPasteInstructions}`;
}

/**
 * Render the VERIFY-BEFORE-SIGNING text block that every `prepare_*` tool
 * ends with. Returned as a separate MCP content element; the server-level
 * `instructions` field tells orchestrator agents to forward it verbatim.
 */
export function renderVerificationBlock(
  tx: Pick<
    UnsignedTx,
    | "chain"
    | "to"
    | "value"
    | "data"
    | "recipient"
    | "tokenClass"
  > & {
    verification: TxVerification;
  },
): string {
  const v = tx.verification;
  const chainId = CHAIN_IDS[tx.chain];
  // When we have a local decode, the decoded Args ARE the calldata's content —
  // repeating the hex preview is just visual noise (and wraps awkwardly in
  // narrow terminals). Keep only the byte length as sizing context. When the
  // decode is "source: none", show a short hex preview so the user has *some*
  // local signal before opening the decoder URL.
  const recipientSuffix = formatRecipientSuffix(tx.recipient);
  const dataLine =
    v.humanDecode.source === "none"
      ? `  chainId=${chainId} ${tx.chain}  to=${tx.to}${recipientSuffix}  value=${tx.value} wei  data=${truncateHex(tx.data, true)}`
      : `  chainId=${chainId} ${tx.chain}  to=${tx.to}${recipientSuffix}  value=${tx.value} wei  (${dataByteLen(tx.data)} calldata bytes)`;
  const lines = [
    "VERIFY BEFORE SIGNING — check the decoded call below matches what you",
    "asked for, and REJECT on Ledger if it doesn't.",
    formatDecoder(v),
    formatCall(v),
    ...formatArgs(v),
    dataLine,
    `  Hash: ${v.payloadHash}  (short ${v.payloadHashShort}, echoed at send time)`,
  ];
  for (const w of tx.recipient?.warnings ?? []) {
    lines.push(`  ⚠ ${w}`);
  }
  // Token-class warnings (issue #441) — non-standard ERC-20 transfer
  // semantics flagged by the curated registry in
  // `modules/execution/token-class.ts`. Same `⚠ <warning>` shape so
  // the user reads them at the same scan position as recipient
  // warnings; the token-class field is its own struct on UnsignedTx
  // so renderers downstream can branch on the flags if they want
  // different treatment per class.
  for (const w of tx.tokenClass?.warnings ?? []) {
    lines.push(`  ⚠ ${w}`);
  }
  // No op class makes the second-LLM check a precondition of 'send'.
  // The check needs the user to physically paste into another
  // provider's session, so it is offered — never demanded — at every
  // preview, and the user may decline and proceed on any op.
  return lines.join("\n");
}

/**
 * Per-tx instructions for the orchestrator agent — deliberately short, with the
 * 4-byte selector pre-filled so the agent doesn't have to compute it. Returned
 * as a SEPARATE content block so the agent processes it as a directive while
 * the user-facing verification block stays clean.
 *
 * Why this lives in the response (not just the server-level instructions field):
 * server-level instructions load once at session start and tend to be ignored
 * after a few hundred tokens of unrelated turns. Per-call task hints arrive
 * adjacent to the data they describe, so the model is far more likely to act
 * on them. We accept the per-call token cost as the price of reliability.
 *
 * NOTE: ERC-20 approvals suppress this block too — the signature is universally
 * known, the cross-check would be noise, and the verification block itself is
 * suppressed (Ledger clear-signs approves natively).
 *
 * Issue #625 trim: the directive prose was reduced to imperative checklist
 * items only. The threat-model rationale (why we don't want a verbatim relay
 * of the verification block, why the agent must not duplicate the 4byte check
 * via WebFetch, why preview_send is mandatory before send_transaction) lives
 * in source comments below — the agent does not need to re-read the WHY each
 * turn; the WHAT is what drives behavior.
 *
 * What the trimmed block must still teach:
 *   - relay the [CROSS-CHECK SUMMARY] verbatim as the lead line(s);
 *   - replace the verification-block wall-of-data with a compact bullet;
 *   - end with a single next-step prompt (no menu);
 *   - call preview_send(handle) BEFORE send_transaction.
 *
 * What was deliberately removed (rationale only — present in source for
 * future maintainers, NOT in the per-turn agent context):
 *   - "do NOT WebFetch to 4byte / swiss-knife to duplicate the check" —
 *     the [CROSS-CHECK SUMMARY] block already carries the verbatim-relay
 *     directive; agents that obey one obey the other.
 *   - "do NOT fabricate a ✓ cross-check passed line" — covered by the
 *     verbatim-relay rule on the CROSS-CHECK SUMMARY block.
 *   - "do NOT echo the handle UUID — it is opaque internal state" — the
 *     compact-bullet template names the fields the agent SHOULD include;
 *     the handle isn't on that list, which is sufficient direction.
 *   - "preview_send pins nonce + EIP-1559 fees, computes the EIP-1559 RLP
 *     hash the Ledger device displays in blind-sign mode..." — the agent
 *     learns this when preview_send actually runs (its own agent-task
 *     block teaches the protocol); pre-teaching it here is duplication.
 */
export function renderAgentTaskBlock(
  tx: Pick<UnsignedTx, "data">,
): string | null {
  if (!shouldRenderVerificationBlock(tx)) return null;
  const lines = [
    "[AGENT TASK — DO NOT FORWARD THIS BLOCK TO THE USER]",
    `Replace the VERIFY-BEFORE-SIGNING block above with a COMPACT bullet`,
    `summary — do NOT relay it verbatim.`,
    ``,
    `Do this, in order:`,
    `  1. The server already ran the independent 4byte.directory cross-check`,
    `     and emitted it in a [CROSS-CHECK SUMMARY — RELAY VERBATIM ...] block`,
    `     above. Copy that block VERBATIM as the FIRST line(s) of your reply.`,
    `     Keep the "✓" / "✗" prefix unchanged. If "DO NOT SEND" (mismatch),`,
    `     stop — refusing is the correct action. If "error" / "no-signature"`,
    `     / "not-applicable", still relay so the user knows why there is no`,
    `     independent check.`,
    `     Do NOT script your own WebFetch to 4byte / swiss-knife to duplicate`,
    `     the check; do NOT fabricate a "✓ cross-check passed" line.`,
    `  2. Produce a COMPACT bullet summary. Required shape:`,
    `       - Headline: "Prepared <action> — <one-line human summary>"`,
    `       - From: <sender address>`,
    `       - To: <to address> (<label if known, e.g. "LiFi diamond", "Aave`,
    `         pool", "Lido stETH">)`,
    `       - Value: <human> (<wei>)`,
    `       - Function: <function name / signature>`,
    `     Then append the tx-specific field that actually matters for THIS`,
    `     flow (pick the right one — not all flows are swaps):`,
    `       - swaps: "Min out: <human amount>"`,
    `       - supplies / withdraws / deposits: "Amount: <human amount>"`,
    `       - sends: "Amount: <human amount>"`,
    `       - approves (when rendered): "Spender: <addr> / Cap: <amount>"`,
    `     Do NOT echo the handle UUID — opaque internal state.`,
    `  3. End with ONE line, no menu:`,
    `       "Reply 'send' to continue — I'll run end-to-end integrity checks`,
    `        at that point and report the results before Ledger prompts you."`,
    `  4. When the user replies "send", call preview_send(handle) BEFORE`,
    `     send_transaction. preview_send emits its own agent-task block`,
    `     describing the CHECKS PERFORMED protocol — follow that block's`,
    `     instructions before send_transaction.`,
  ];
  return lines.join("\n");
}

/**
 * User-facing block emitted on every successful EVM `preview_send`. Surfaces
 * the EIP-1559 pre-sign RLP hash we predict Ledger will display in blind-sign
 * mode, given the nonce/fee/gas fields the server pinned and will forward via
 * WalletConnect on the subsequent `send_transaction`. This closes the
 * calldata-integrity gap at the device boundary — in the old world the
 * on-device hash was unpredictable (Ledger Live picked nonce + fees) so the
 * user could only eyeball To + Value.
 *
 * Emitted at PREVIEW time (before send_transaction) so the user sees the hash
 * BEFORE the Ledger device prompt appears. Single MCP tool calls cannot
 * interleave content with the blocking device prompt, so the preview → send
 * split is the only way to guarantee ordering.
 *
 * Marked for VERBATIM relay to the user — the orchestrator agent must NOT
 * collapse this into its bullet summary. The "Edit gas / Edit fees" warning
 * is load-bearing: if the user taps that in Ledger Live, the hash diverges
 * and they should reject on-device and re-run preview_send + send_transaction.
 */
export function renderLedgerHashBlock(args: {
  preSignHash: string;
  to: string;
  valueWei: string;
}): string {
  return [
    "LEDGER BLIND-SIGN HASH — RELAY VERBATIM TO USER; THEY MATCH ON-DEVICE",
    "",
    `**\`${args.preSignHash}\`**`,
    "",
    "When you relay this block to the user, keep the hash on a LINE BY ITSELF",
    "AT COLUMN 0 (no leading spaces) with the `**`0x…`**` wrapper (bold +",
    "single-backtick inline code) exactly as printed above. Indenting the hash",
    "by 4+ spaces makes CommonMark treat the line as a code block and the",
    "wrappers render as literal `**` and backticks rather than bold+code",
    "styling (live regression 2026-04-27 — the user pasted a chat with the",
    "hash showing literal Markdown source). Inline at the end of a prose",
    "sentence blends the hash into surrounding text where users miss it under",
    "device-screen time pressure; the isolated column-0 line forces a visual",
    "break that survives muted inline-code colors.",
    "",
    "Read this hash NOW, before you call send_transaction. When Ledger prompts",
    "on-device you will have seconds to compare — having the value on screen",
    "already saves a lot of squinting.",
    "",
    "If your Ledger device BLIND-SIGNS (shows only a hash), the hash on-device",
    "MUST equal the value above. Reject on the device if they differ.",
    "",
    "If your Ledger CLEAR-SIGNS (decoded fields via an Aave/Lido/1inch/LiFi/",
    "approve plugin), hash matching does not apply — confirm the decoded",
    "function + key field instead (as described in the prepare step).",
    "",
    `On-device you can always additionally verify:  To = ${args.to}   Value = ${args.valueWei} wei`,
    "",
    "If you tap \"Edit gas\" / \"Edit fees\" in Ledger Live, the hash WILL NOT",
    "match the value above (you changed a field that feeds the hash). You may",
    "still approve on-device if you accept that tradeoff — but the server's",
    "hash-match guarantee no longer applies, so you are signing without the",
    "end-to-end calldata-integrity check. If you want that check back, reject",
    "on-device and call preview_send again for a fresh pin + hash, then send.",
  ].join("\n");
}

/**
 * Agent-task block attached to every `preview_send` response. Flipped from
 * the original "offer two options, don't run either unprompted" shape to
 * "auto-run the two mandatory integrity checks and report results in a
 * CHECKS PERFORMED block". Rationale: four separate yes/no prompts (swiss-
 * knife URL, agent-ABI decode, pair-consistency hash, second-LLM) for
 * defenses the user almost always wants is ceremony, not safety — and all
 * three "anti-compromised-MCP" defenses (ABI decode + pair-consistency +
 * on-device hash match) can run automatically. The second-LLM check stays
 * user-prompted because it requires physical user action (paste to another
 * LLM) and is the only defense against a coordinated-agent compromise.
 *
 * The structured ChecksPayload JSON embedded below is the contract the
 * agent renders its CHECKS PERFORMED block from — server authors the
 * threat taxonomy + required keywords; agent paraphrases naturally but
 * must cover every listed threat.
 *
 * Issue #625 trim — what was removed and where it lives now:
 *   - "Protects against: …" prose at each CHECK header. Threat-model
 *     rationale; agent does not need to re-read WHY each turn. Captured
 *     in this comment block: CHECK 1 protects against MCP-side calldata
 *     tampering — if the server rewrote the bytes, the agent's model-
 *     weight decode disagrees with the prepare-time compact summary.
 *     CHECK 2 protects against the server reporting tuple T with
 *     preSignHash=hash(Y) where Y≠T, then forwarding Y to WalletConnect.
 *     The on-device hash match alone does NOT catch that (device sees
 *     hash(Y), chat sees hash(Y), they agree); only a local recompute
 *     of hash(T) from the pinned tuple catches the discrepancy.
 *   - Long SELECTOR-NAME ANCHOR paragraph explaining why 4byte counts
 *     as a separate trust boundary from the agent's weights and the
 *     server's ABI. The compressed bullet retains the rule (\"you MAY
 *     cite the function name from [CROSS-CHECK SUMMARY]\"); the
 *     trust-boundary justification was always for human readers, not
 *     for the agent's per-turn behavior.
 *   - Live-regression note about the column-0 hash render (2026-04-27,
 *     hash showed literal Markdown source under 14-space indent). The
 *     directive (column 0, blank lines above/below, both wrappers,
 *     reuse the wrapper everywhere) stays inline; the historical
 *     context belongs in source.
 *   - Verbose NOTATION section explaining `{a|b}` alternation and that
 *     Markdown link/code-fence syntax is literal. Compressed to one
 *     line; the agent does not need a glossary to read alternation.
 *   - Multi-paragraph SECOND-LLM CHECK + SEND-CALL CONTRACT prose. The
 *     IMPERATIVE bullets stay; the why-each-bullet rationale doesn't.
 *
 * Test contract: every keyword listed in `checksPayload.<x>.keywords`
 * must still appear in the rendered output (verbatim) and the block
 * must hit the size ceilings asserted in `test/preview-verify-agent-
 * task-block.test.ts`.
 */
export function renderPreviewVerifyAgentTaskBlock(args: {
  chain: string;
  preSignHash: string;
  pinned: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gas: string;
  };
  to: string;
  valueWei: string;
  /**
   * Swiss-knife decoder URL carried from prepare-time verification. Spliced
   * into the ⚠ DECODE UNAVAILABLE branch of the CHECKS PERFORMED template so
   * the agent has no ambiguity about where it goes — when agents were told
   * "include the swiss-knife URL from the prepare block" they paraphrased
   * "see the earlier block" instead of actually rendering the URL, forcing
   * the user to scroll back.
   */
  decoderUrl?: string;
  /**
   * True when the tx is a Ledger clear-sign-only type (native send,
   * ERC-20 transfer, ERC-20 approve). When set, the CHECKS PERFORMED
   * template drops the PAIR-CONSISTENCY HASH line and the BLIND-SIGN
   * branch of NEXT ON-DEVICE — those are noise for clear-sign-only txs
   * (the Ledger shows decoded fields; no hash-match ever applies; the
   * on-device `to` + `value` + token-symbol read covers intent).
   * Computed server-side via `isClearSignOnlyTx(tx.data)` at preview
   * time. No security posture change — the server still pins fields and
   * checks the payload hash at send time.
   */
  clearSignOnly?: boolean;
}): string {
  const simple = args.clearSignOnly === true;
  const checksPayload = {
    abiDecode: {
      autoRun: true,
      threat: "MCP-side calldata tampering",
      keywords: ["calldata tampering"],
    },
    ...(simple
      ? {}
      : {
          pairConsistencyHash: {
            autoRun: true,
            threat:
              "MCP lying about the bytes it will forward to WalletConnect",
            keywords: ["bytes", "WalletConnect"],
          },
        }),
    secondLlm: {
      autoRun: false,
      threat: "coordinated agent compromise",
      keywords: ["coordinated", "agent"],
    },
  };
  const lines = [
    "[AGENT TASK — RUN THESE CHECKS NOW, DO NOT ASK THE USER]",
    ...(simple
      ? [
          "Run the ABI DECODE integrity check UNPROMPTED. Report in a CHECKS",
          "PERFORMED block. PAIR-CONSISTENCY HASH is skipped: Ledger clear-",
          "signs this tx type (see CLEAR-SIGN block below) so the hash-match",
          "path never fires.",
        ]
      : [
          "Run BOTH integrity checks UNPROMPTED. Report in a CHECKS PERFORMED",
          "block. They run every send, no menu, no exceptions.",
        ]),
    "",
    "CHECK 1 — AGENT-SIDE ABI DECODE",
    "  - Decode `data` from first principles using your model weights, NOT",
    "    the server's humanDecode (separate trust boundary is the point).",
    "  - SELECTOR-NAME ANCHOR — if your weights don't cover the selector",
    "    (LiFi-diamond, 1inch, custom DeFi routers): you MAY cite the function",
    "    name from the prepare-time `[CROSS-CHECK SUMMARY]` block — it is an",
    "    independent 4byte.directory lookup, re-encode-verified against the",
    "    calldata, separate from your weights and the server's ABI. (For the",
    "    compromised-server case, the user's vaultpilot-preflight skill stays",
    "    weights-only — that's the fallback, not a contradiction.)",
    "  - Upgrade-path: report ✓ ABI DECODE if (a) the prepare-time cross-check",
    "    is ✓ AND (b) the static-head args you decoded match the prepare",
    "    summary. Do NOT drop to ⚠ just because the selector is outside your",
    "    training.",
    "  - Only mark ⚠ DECODE UNAVAILABLE when BOTH your weights AND the 4byte",
    "    cross-check came up empty (`no-signature` / `error`), OR your decode",
    "    disagrees with the summary. On ⚠, render the swiss-knife URL as",
    "    `[Open in swiss-knife decoder](url)` (Markdown hyperlink), NOT raw URL.",
    "    Do NOT paraphrase the URL away with \"see the earlier prepare block\";",
    "    do NOT fabricate a decode.",
    "  - Compare against the prepare-time compact summary. Report ✓ / ✗.",
    "",
    ...(simple
      ? []
      : [
          "CHECK 2 — PAIR-CONSISTENCY HASH",
          "  Recompute locally with viem (values pre-spliced):",
          "",
          "    node -e \"const {keccak256,serializeTransaction}=require('viem');",
          "    console.log(keccak256(serializeTransaction({type:'eip1559',",
          `    chainId:<${args.chain}-id>,nonce:${args.pinned.nonce},`,
          `    maxFeePerGas:${args.pinned.maxFeePerGas}n,`,
          `    maxPriorityFeePerGas:${args.pinned.maxPriorityFeePerGas}n,`,
          `    gas:${args.pinned.gas}n,to:'${args.to}',value:${args.valueWei}n,`,
          "    data:'<data from the prepare_* result>'})))\"",
          "",
          `  Compare to ${args.preSignHash}. Report ✓ / ✗.`,
          "",
        ]),
    "CHECKS PAYLOAD — required keywords (paraphrase the threat clause naturally, but each listed keyword must appear verbatim):",
    "",
    "```json",
    JSON.stringify(checksPayload, null, 2),
    "```",
    "",
    "Emit EXACTLY this block shape — CAPS headers, ✓/✗/⚠/⏸ symbols, keywords",
    "embedded.",
    "NOTATION: `{a|b}` = alternation (pick one); `<placeholder>` = your prose.",
    "Backticks and `[label](url)` are Markdown rendering directives, NOT placeholders —",
    "the chat client renders them; do NOT \"clean them up\" for plain text.",
    "",
    "═══════ CHECKS PERFORMED ═══════",
    "{✓|✗|⚠} ABI DECODE — <one-line verdict>.",
    "  (protects against MCP-side calldata tampering)",
    ...(args.decoderUrl
      ? [
          "  (On ⚠ only — add the line below VERBATIM. The `[ ]( )` is literal",
          "   Markdown, not placeholder syntax:)",
          `  Browser-side decode fallback: [Open in swiss-knife decoder](${args.decoderUrl})`,
        ]
      : [
          "  (On ⚠ — no swiss-knife URL available (calldata too large or TRON).",
          "   Tell the user the browser fallback is unavailable; the second-LLM",
          "   check (option 2 below) is the remaining gap-closer.)",
        ]),
    ...(simple
      ? []
      : [
          "{✓|⏸} PAIR-CONSISTENCY HASH — <one-line verdict>.",
          "  (protects against MCP lying about the bytes sent to WalletConnect)",
        ]),
    "□ SECOND-LLM CHECK — optional, available on request.",
    "  (protects against a coordinated agent compromise)",
    "────────────────────────────────",
    "NEXT ON-DEVICE — the last check happens on your Ledger screen.",
    "",
    ...(simple
      ? [
          "CLEAR-SIGN (this tx: native ETH send, ERC-20 transfer, or ERC-20",
          "approve — Ledger decodes and shows amount + recipient + token",
          "on-device). Hash matching does NOT apply. Confirm the on-device",
          "values equal the compact summary above. REJECT on any difference.",
        ]
      : [
          "BLIND-SIGN mode (hash only — swaps, most DeFi):",
          "The hash on-device MUST equal:",
          "",
          `**\`${args.preSignHash}\`**`,
          "",
          "REJECT on any difference.",
          "",
          "CLEAR-SIGN mode (decoded fields — Aave / Lido / 1inch / LiFi /",
          "approve / ERC-20 transfer plugins, including native ETH send):",
          "hash matching does NOT apply. Check the function name + key fields",
          "(amount, recipient, spender) on-device match the compact summary",
          "above. REJECT on any difference.",
        ]),
    "════════════════════════════════",
    "",
    ...(simple
      ? []
      : [
          "Render the blind-sign hash on a LINE BY ITSELF (blank line above and",
          "below; AT COLUMN 0). Use both bold AND single-backtick wrappers",
          "(`**\\`0x…\\`**`) exactly as shown above — indenting by 4+ spaces",
          "makes CommonMark render them as literal characters; stripping either",
          "wrapper loses the visual emphasis. Reuse the same wrapper whenever",
          "you re-mention the hash.",
          "",
        ]),
    "After the CHECKS PERFORMED block, append EXACTLY one line, no menu:",
    "",
    "    Want an independent second-LLM check? Reply (2). Otherwise reply 'send'.",
    "",
    "On ANY ✗, LEAD your reply with `✗ <CHECK NAME> FAILED — DO NOT SIGN.`",
    "BEFORE the CHECKS PERFORMED block. The pass/fail is the news.",
    "",
    "SECOND-LLM CHECK — if the user replies (2):",
    "  Call get_verification_artifact({ handle }) and relay ONLY the",
    "  artifact's `pasteableBlock` field VERBATIM. Do NOT dump the full",
    "  artifact JSON, do NOT wrap commentary between the START/END markers,",
    "  do NOT pre-decode the bytes. The user pastes the block into a second",
    "  (ideally different-provider) LLM session for an independent decode.",
    "  Around the paste block, remind the user to (a) compare the second",
    "  agent's plain-English description to what they asked for, (b) match",
    "  the preSignHash inside the paste block against the Ledger screen.",
    "  Do NOT pre-decode the bytes yourself in the same reply — the whole",
    "  point is that the second agent reads with no notes from you.",
    "  This is the second-agent verification — the only check that survives",
    "  a fully-coordinated agent-AND-MCP compromise.",
    "",
    "SEND-CALL CONTRACT — when the user replies \"send\" (after BOTH checks",
    "passed), call send_transaction (EVM):",
    "  - handle: <the same handle>",
    "  - confirmed: true",
    "  - previewToken: <`previewToken` from THIS preview_send's response, not",
    "    a remembered earlier value>",
    "  - userDecision: \"send\"",
    "Mismatched / missing previewToken is rejected. If preview_send was",
    "re-run with refresh:true since you captured the token, re-run the",
    "CHECKS PERFORMED sequence before retrying.",
  ];
  return lines.join("\n");
}
