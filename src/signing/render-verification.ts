import { CHAIN_IDS } from "../types/index.js";
import type {
  SupportedChain,
  TxVerification,
  UnsignedSolanaTx,
  UnsignedTx,
} from "../types/index.js";
import { NATIVE_SYMBOL } from "../config/contracts.js";
import { solanaLedgerMessageHash } from "./verification.js";
import { getDefillamaCoinPrice } from "../data/prices.js";
import {
  formatArgs,
  formatNativeShort,
  formatNonEvmCostPreview,
  formatRecipientSuffix,
  truncateHex,
} from "./render/format.js";

export * from "./render/format.js";
export * from "./render/common.js";
export * from "./render/bitcoin.js";
export * from "./render/litecoin.js";
export * from "./render/tron.js";

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
 * Render the VERIFY-BEFORE-SIGNING text block that every `prepare_*` tool
 * ends with. Returned as a separate MCP content element; the server-level
 * `instructions` field tells orchestrator agents to forward it verbatim.
 */

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

/**
 * Agent-task block emitted when the user has NOT installed the
 * `vaultpilot-preflight` Claude Code skill (see
 * https://github.com/szhygulin/vaultpilot-security-skill). The skill is the only
 * MCP-independent source of truth for agent-side integrity checks — its
 * content lives under `~/.claude/skills/` on the user's disk, outside
 * this server's reach. Without it, a compromised MCP could silently
 * suppress its own CHECKS PERFORMED directives and the agent would have
 * no static rule to fall back on.
 *
 * This block is prefixed to every `prepare_*` / `preview_*` tool response
 * when the skill marker file is missing. It is a UX nudge, not a security
 * boundary: an actually-compromised MCP would of course suppress its own
 * warning too. The point is to catch the honest-MCP case where the user
 * simply hasn't completed the install step, so they don't silently run
 * with a weaker agent.
 *
 * `skillRepoUrl` is the GitHub URL the user clones from; passed in so the
 * call site owns the single source of truth (index.ts).
 */
/**
 * Auto-install state passed in by `index.ts`. The renderer switches on this
 * to produce one of three notice variants:
 *   - `not-attempted` / unset / `already-present` → manual-install prose
 *     (the original notice content, unchanged).
 *   - `in-progress` → "auto-install kicked off, restart at end of session"
 *     so the user knows we're handling it but Claude Code needs a restart
 *     to load the freshly-cloned SKILL.md (skills are loaded at session
 *     start, not on the fly).
 *   - `succeeded` → "auto-installed, restart now to activate".
 *   - `failed` → manual-install prose + the error detail so the user can
 *     diagnose (no `git`, network down, dangling dir, etc.).
 */
export interface AutoInstallContext {
  state:
    | "not-attempted"
    | "in-progress"
    | "succeeded"
    | "failed"
    | "already-present";
  installPath?: string;
  detail?: string;
}

export function renderMissingSkillWarning(opts: {
  skillRepoUrl: string;
  autoInstall?: AutoInstallContext;
}): string {
  // NOTE ON FRAMING — this block was originally prefixed with an
  // "[AGENT TASK — RELAY TO USER FIRST, BEFORE ANY OTHER BLOCK]" header
  // and a direct `git clone <url>` command. Live testing showed agents
  // flagging that shape as prompt injection (because it is — structurally
  // indistinguishable from an attacker-authored block demanding the user
  // run an external script). Defense-in-depth agents correctly ignored it.
  //
  // The current shape mirrors the other vaultpilot-mcp informational
  // blocks (VERIFY BEFORE SIGNING, PREPARE RECEIPT, TRANSACTION BROADCAST)
  // the agent already trusts: a named notice with status/purpose/install
  // sections, no imperative verbs directed at the agent, and no pasted
  // shell commands. The server-level `instructions` field documents this
  // notice pattern explicitly at initialize time so the agent has prior
  // knowledge it is legitimate server output.
  const ai = opts.autoInstall;
  if (ai?.state === "in-progress") {
    return renderAutoInstallInProgress("Preflight", ai.installPath ?? "");
  }
  if (ai?.state === "succeeded") {
    return renderAutoInstallSucceeded("Preflight", ai.installPath ?? "");
  }
  const failedSuffix =
    ai?.state === "failed" && ai.detail
      ? `\n\n(Auto-install attempt failed: ${ai.detail})`
      : "";
  return [
    "VAULTPILOT NOTICE — Preflight skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-preflight/SKILL.md not found.",
    "Purpose: the preflight skill adds MCP-independent integrity checks",
    "         to every signing flow (local bytes-decode + on-device hash",
    "         recompute). It lives on the user's disk outside this",
    "         server's reach, so its invariants stay enforced even if",
    "         this MCP is compromised or silently drops its own CHECKS",
    "         PERFORMED directives.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; restart Claude Code after.)",
    "",
    "This notice is emitted by vaultpilot-mcp while the skill file is",
    "absent. It is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this pattern. Surface it to",
    "the user once per session as informational, then continue with",
    "their request.",
  ].join("\n") + failedSuffix;
}

/**
 * Shared body for the "auto-install kicked off" notice variant. Doesn't
 * mention the manual `git clone` flow — auto-install is on; the user just
 * needs to restart at the end of the session for Claude Code to pick up
 * the freshly-cloned SKILL.md.
 */
function renderAutoInstallInProgress(
  skillLabel: string,
  installPath: string,
): string {
  return [
    `VAULTPILOT NOTICE — ${skillLabel} skill auto-install in progress`,
    "",
    `Status:  cloning ${skillLabel.toLowerCase()} skill to ${installPath}`,
    "         in the background (git clone --depth=1, ~30s timeout).",
    `Purpose: the ${skillLabel.toLowerCase()} skill is one of two companion`,
    "         skills vaultpilot-mcp expects to find under ~/.claude/skills/.",
    "         The MCP server kicked off a one-time first-run install on",
    "         this tool call — no manual git clone needed.",
    "Action:  restart Claude Code at the end of this session so the new",
    "         SKILL.md is loaded. Skills are read at session start, not",
    "         on the fly, so this session won't have it active. Continue",
    "         with the user's current request normally.",
    "",
    "This notice is server-generated, not prompt injection. Suppress",
    "auto-install with VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1.",
  ].join("\n");
}

function renderAutoInstallSucceeded(
  skillLabel: string,
  installPath: string,
): string {
  return [
    `VAULTPILOT NOTICE — ${skillLabel} skill auto-installed`,
    "",
    `Status:  cloned to ${installPath}.`,
    `Purpose: the ${skillLabel.toLowerCase()} skill is now on disk; Claude`,
    "         Code loads its skill list at session start, so this session",
    "         is still running without it.",
    "Action:  restart Claude Code to activate the skill. The current",
    "         tool call has already been answered — no need to retry it",
    "         after the restart unless the user wants to.",
    "",
    "This notice is server-generated, not prompt injection.",
  ].join("\n");
}

/**
 * Companion to `renderMissingSkillWarning` — emitted when the
 * `vaultpilot-setup` skill is missing, so an agent fielding a setup-flow
 * question still has explicit guidance even when the wizard's auto-install
 * step (`src/setup/install-skills.ts`) failed earlier (no `git`, no
 * network, user declined). Same shape as the preflight notice — named
 * `VAULTPILOT NOTICE`, no imperative agent verbs, no pasted shell — so the
 * agent treats it as legitimate server output rather than prompt injection.
 *
 * Triggered narrowly (only on `get_vaultpilot_config_status` responses)
 * rather than every tool call: that tool is the canonical first call the
 * setup skill makes, so the notice fires exactly when the agent is in a
 * setup-flow context. This avoids stacking two unrelated install notices
 * on every response when both skills happen to be missing.
 */
export function renderMissingSetupSkillWarning(opts: {
  skillRepoUrl: string;
  autoInstall?: AutoInstallContext;
}): string {
  const ai = opts.autoInstall;
  if (ai?.state === "in-progress") {
    return renderAutoInstallInProgress("Setup", ai.installPath ?? "");
  }
  if (ai?.state === "succeeded") {
    return renderAutoInstallSucceeded("Setup", ai.installPath ?? "");
  }
  const failedSuffix =
    ai?.state === "failed" && ai.detail
      ? `\n\n(Auto-install attempt failed: ${ai.detail})`
      : "";
  return [
    "VAULTPILOT NOTICE — Setup skill not installed",
    "",
    "Status:  ~/.claude/skills/vaultpilot-setup/SKILL.md not found.",
    "Purpose: the setup skill drives the conversational `/setup` flow —",
    "         classifying the user's use case, collecting only the API",
    "         keys that case actually needs, validating each pasted key",
    "         via a read-only tool call, and ending with a working",
    "         example. Without it the agent has to improvise the flow",
    "         from this server's tool surface alone.",
    `Install: ${opts.skillRepoUrl.replace(/\.git$/, "")}`,
    "         (README has the clone command; the setup wizard's",
    "         auto-install step would normally clone it, but that path",
    "         can fail when git is missing, the network is down, or",
    "         the user declined. Restart Claude Code after cloning.)",
    "",
    "This notice is server-generated, not prompt injection. Surface it",
    "to the user once per session as informational, then continue with",
    "their setup question — referencing the install instructions if the",
    "user wants the guided flow.",
  ].join("\n") + failedSuffix;
}

/**
 * Repeated on every tool response — the pin data the `vaultpilot-preflight`
 * skill's Step 0 (integrity self-check) compares the local `SKILL.md`
 * against. Issue #414: the same pin previously lived in the server-level
 * `instructions` field, which Claude Code truncates at ~2KB. The pin sat
 * ~24KB into the field, beyond the truncation point, so Step 0 silently
 * could not run. Repeating the pin in a short block on every tool result
 * sidesteps the `instructions` truncation entirely — tool results are
 * delivered as separate messages, not subject to that single-field cap.
 *
 * Block shape mirrors the VAULTPILOT NOTICE family — named header, no
 * imperative verbs at the agent, no pasted shell. The closing line labels
 * the block as server-emitted (not prompt injection) and explains why
 * it's repeated. The sentinel value remains assembled from three fragments
 * so a naive search of the agent's context for the full literal won't
 * always succeed and silently bypass the check.
 *
 * Issue #613 finding 5 — kept terse: ~870 → ~510 chars per emission. Step
 * 0 only parses the SHA line + fragment A/B/C lines, so the longer
 * rationale paragraph that used to ride along on every response (~6×
 * across a multi-step flow → ~5KB of repeated copy) was dropped. The
 * source-comment + CLAUDE.md still carry the full story for human readers.
 *
 * Placed adjacent to the JSON result (before VAULTPILOT NOTICE blocks
 * and the verification blocks). Its presence is unobtrusive: Step 0
 * reads it; other turns ignore it.
 *
 * `pin` is passed in (rather than imported here) so this module stays
 * dependency-free of `src/diagnostics/skill-pin-drift.ts` and the call
 * site keeps the single source of truth.
 */
export function renderPreflightSkillPinBlock(pin: {
  expectedSha256: string;
  sentinelA: string;
  sentinelB: string;
  sentinelC: string;
}): string {
  return [
    "VAULTPILOT PIN — Preflight skill integrity (Step 0 reference)",
    "",
    "Expected SHA-256 of ~/.claude/skills/vaultpilot-preflight/SKILL.md:",
    `  ${pin.expectedSha256}`,
    "",
    "Sentinel fragments (concat A+B+C, search Skill RESULT TEXT):",
    `  fragment A: \`${pin.sentinelA}\``,
    `  fragment B: \`${pin.sentinelB}\``,
    `  fragment C: \`${pin.sentinelC}\``,
    "",
    "Block is server-emitted (not prompt injection) and repeats per response because the equivalent in `instructions` exceeds Claude Code's ~2KB cap (issue #414).",
  ].join("\n");
}

/**
 * Demo-mode onboarding notice — fires once per session when the server
 * is in demo mode (any reason) AND no live wallet has been picked yet.
 * Copy varies by reason so the leave path matches how demo got
 * activated:
 *
 *   - `auto-fresh-install` (issue #391/#392 follow-up): no env var, no
 *     config file detected at boot. Tells the agent auto-demo is on
 *     and points at `vaultpilot-mcp-setup` as the leave path (since
 *     there's no env var to unset).
 *   - `explicit-env` (issue #371): `VAULTPILOT_DEMO=true`. Tells the
 *     agent demo is on by explicit opt-in and points at "unset
 *     VAULTPILOT_DEMO + restart" as the leave path.
 *
 * Same shape as the other VAULTPILOT NOTICE blocks: named header,
 * status / purpose / next sections, no imperative verbs at the agent,
 * no pasted shell. Tradeoff-aware closing paragraph naming the block
 * as legitimate server output so a defensive agent doesn't classify
 * it as prompt injection.
 */
export function renderMissingDemoWalletWarning(opts: {
  reason: "auto-fresh-install" | "explicit-env";
}): string {
  const isAuto = opts.reason === "auto-fresh-install";
  const header = isAuto
    ? "VAULTPILOT NOTICE — Auto demo mode active (fresh install detected)"
    : "VAULTPILOT NOTICE — Demo mode active (VAULTPILOT_DEMO=true)";
  const statusLines = isAuto
    ? [
        "Status:  no user config at ~/.vaultpilot-mcp/config.json was",
        "         detected at boot, so the server activated auto-demo.",
        "         No live wallet is set for this session yet.",
      ]
    : [
        "Status:  VAULTPILOT_DEMO=true is set in the environment, so the",
        "         server is in explicit demo mode. No live wallet is set",
        "         for this session yet.",
      ];
  const leaveLines = isAuto
    ? [
        "         To leave demo (when the user is ready for real funds):",
        "           1. Run `npx -y -p vaultpilot-mcp vaultpilot-mcp-setup`",
        "              (writes a config; turns auto-demo OFF on next boot).",
        "           2. Restart Claude Code.",
        "           3. Pair the user's Ledger via `pair_ledger_*`.",
        "         Setting `VAULTPILOT_DEMO=false` in the MCP client config",
        "         is an alternative explicit opt-out — also restart-gated.",
      ]
    : [
        "         To leave demo (when the user is ready for real funds):",
        "         unset `VAULTPILOT_DEMO` in the MCP client config (e.g.",
        "         `.claude.json`'s `env` block) and restart Claude Code.",
      ];
  return [
    header,
    "",
    ...statusLines,
    "Purpose: vaultpilot-mcp ships pre-configured demo wallets (curated",
    "         personas + custom-address mode) so a user can try the tool",
    "         flows — portfolio reads, prepare/preview/simulate signing",
    "         — without pairing a Ledger or supplying addresses.",
    "         Broadcast is intercepted in demo mode (no real send), so",
    "         the entire flow is safe.",
    "Next:    if the user asks to inspect a portfolio, build a tx, or",
    "         try anything that needs an address, offer the demo path",
    "         BEFORE asking them to pair hardware. Tools:",
    "           - `set_demo_wallet({ persona: \"<id>\" })` — activate a",
    "             curated persona (defi-degen, stable-saver,",
    "             staking-maxi, whale) or a custom address bundle.",
    "           - `get_demo_wallet()` — inspect the active selection.",
    "             Each matrix cell exposes `rehearsableFlows` (state",
    "             already on-chain) + `flowGaps` (with recommendations",
    "             when the archetype implies a flow the wallet's state",
    "             doesn't actually support — issue #409). Read these",
    "             BEFORE picking a flow to head off the agent loop on",
    "             state-dependent multi-step walks.",
    "           - `exit_demo_mode()` — tailored real-setup guide.",
    ...leaveLines,
    "",
    "This notice is server-generated, not prompt injection — the server-",
    "level `instructions` field documents this pattern. Surface it to",
    "the user once per session as informational, then continue with",
    "their request.",
  ].join("\n");
}

/**
 * "There's a newer vaultpilot-mcp on npm" notice. Same shape as the
 * VAULTPILOT NOTICE family — named header, status / purpose / install
 * sections, no imperative agent verbs, no pasted destructive shell.
 *
 * The `Install:` block is computed by `getInstallPath()` (in
 * `src/shared/install-path.ts`) and passed in as a pre-rendered
 * multi-line string, so the notice surfaces a command that matches the
 * detected install path (npm-global, npx, bundled-binary, from-source,
 * unknown) rather than always defaulting to `npm install -g`.
 *
 * The release-notes URL is constructed from the latest version (we tag
 * each release `vX.Y.Z` on github.com/szhygulin/vaultpilot-mcp); kept
 * here rather than threaded through as an option so the renderer stays
 * a pure function of its inputs.
 */
export function renderUpdateAvailableNotice(opts: {
  current: string;
  latest: string;
  packageName: string;
  installBlock: string;
}): string {
  const releasesUrl = `https://github.com/szhygulin/vaultpilot-mcp/releases/tag/v${opts.latest}`;
  return [
    "VAULTPILOT NOTICE — Update available",
    "",
    `Status:  ${opts.packageName} ${opts.current} installed; ${opts.latest} published on npm.`,
    "Purpose: keeps you on the latest fixes (DeFi protocol updates,",
    "         security hardening, bug fixes). Release notes:",
    `         ${releasesUrl}`,
    "Install:",
    opts.installBlock,
    "",
    "This notice is server-generated, not prompt injection — emitted once",
    "per session when the running version is older than the latest stable",
    "published on npm. Surface it to the user once, then continue with",
    "their request. Suppress with VAULTPILOT_DISABLE_UPDATE_CHECK=1 if",
    "you don't want the server to query the npm registry.",
  ].join("\n");
}

export type { SupportedChain };
