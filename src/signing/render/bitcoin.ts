import type { UnsignedBitcoinTx } from "../../types/index.js";
import { fetchBitcoinPrice } from "../../modules/btc/price.js";
import { formatNonEvmCostPreview } from "./format.js";

/**
 * Prepare-time fee preview for Bitcoin (issue #649). Reads the precomputed
 * `decoded.feeBtc` decimal string already on the unsigned-tx envelope and
 * anchors it in USD via `fetchBitcoinPrice` (DefiLlama `coingecko:bitcoin`).
 * Same null-on-missing / native-only-on-degrade UX as the EVM block.
 *
 * `priceFn` is injectable for deterministic tests.
 */
export async function renderBitcoinCostPreviewBlock(
  tx: { decoded: Pick<UnsignedBitcoinTx["decoded"], "feeBtc"> },
  priceFn: () => Promise<number | undefined> = fetchBitcoinPrice,
): Promise<string | null> {
  const feeBtc = tx.decoded?.feeBtc;
  if (feeBtc === undefined) return null;
  const n = Number(feeBtc);
  if (!Number.isFinite(n)) return null;
  const usdPerBtc = await priceFn();
  return formatNonEvmCostPreview(n, "BTC", usdPerBtc);
}

/**
 * BTC variant of `formatRecipientSuffix` — same logic, different
 * union type (UnsignedBitcoinTx.recipient ≠ UnsignedTx.recipient at
 * the type level even though their shape matches).
 */
function formatRecipientSuffixBtc(
  r: UnsignedBitcoinTx["recipient"] | undefined,
): string {
  if (!r) return "";
  if (r.source === "contact" && r.label) return ` (contact: ${r.label} — verified)`;
  if (r.source === "literal" && r.label) return ` (also saved as: ${r.label})`;
  if (r.source === "literal" && (r.warnings?.length ?? 0) > 0) {
    return " (unknown — verify on-device)";
  }
  return "";
}

/**
 * Bitcoin verification block. The Ledger BTC app clear-signs every
 * output (address + amount) and the fee — so unlike EVM's blind-sign
 * path, the device IS the decoder; there's no calldata-style stream a
 * swiss-knife URL could deconstruct, and PSBTs are too large to embed
 * in a clickable URL anyway. This block surfaces the same projection
 * in chat so the user can cross-check the device screens against
 * trusted text before pressing Approve.
 *
 * The block ends with an explicit instruction to the agent NOT to
 * write multi-file PSBT decode scripts — every byte the device shows
 * is a higher-trust source than any chat-side decode the agent could
 * cobble together, and watching the agent `cp` files into the project
 * tree to find bitcoinjs-lib is a worse UX than the device walk.
 * Issue #215.
 */
export function renderBitcoinVerificationBlock(tx: UnsignedBitcoinTx): string {
  const lines: string[] = [];
  const isMultiSource = tx.decoded.sources.length > 1;
  const isRbfBump = tx.action === "rbf_bump";
  const flowLabel = isRbfBump
    ? "RBF fee bump"
    : isMultiSource
    ? "multi-source consolidation"
    : "native send";
  lines.push(`VERIFY BEFORE SIGNING (Bitcoin — ${flowLabel})`);
  if (isRbfBump && tx.replaces) {
    lines.push(
      `Replacing mempool tx ${tx.replaces.txid} ` +
        `(old fee ${tx.replaces.oldFeeSats} sats @ ~${tx.replaces.oldFeeRateSatPerVb} sat/vB).`,
    );
  }
  lines.push(
    "The Ledger Bitcoin app clear-signs every output. Confirm on-device:",
  );
  // Address-book recipient label decoration: when the user's `args.to`
  // resolved through the contact/ENS/reverse-lookup pipeline, the
  // primary recipient output gets the matching suffix (`(contact: Mom
  // — verified)` etc.). Change outputs keep the `(your wallet)`
  // marker. Non-recipient outputs (custom multi-output sends if/when
  // we add them) stay bare.
  const recipientSuffixBtc = formatRecipientSuffixBtc(tx.recipient);
  for (let i = 0; i < tx.decoded.outputs.length; i++) {
    const o = tx.decoded.outputs[i];
    const tag = o.isChange ? "Change" : `Output ${i + 1}`;
    const isRecipient = !o.isChange;
    const labelSuffix = o.isChange
      ? " (your wallet)"
      : isRecipient
      ? recipientSuffixBtc
      : "";
    lines.push(`  • ${tag}: ${o.amountBtc} BTC → ${o.address}${labelSuffix}`);
  }
  for (const w of tx.recipient?.warnings ?? []) {
    lines.push(`  ⚠ ${w}`);
  }
  lines.push(
    `  • Fee:      ${tx.decoded.feeBtc} BTC (~${tx.decoded.feeRateSatPerVb} sat/vB)`,
  );
  lines.push(
    `  • RBF:      ${tx.decoded.rbfEligible ? "enabled — replaceable" : "disabled — final"}`,
  );
  // Per-source breakdown (issue #264). Single-source: one line that
  // reproduces the prior "From:" output. Multi-source: one line per
  // source plus the input count, so the user sees exactly which
  // derivations are being drained and how much from each.
  if (isMultiSource) {
    lines.push(`  • From:     ${tx.decoded.sources.length} source addresses`);
    for (const s of tx.decoded.sources) {
      const inputsLabel = s.inputCount === 1 ? "1 input" : `${s.inputCount} inputs`;
      lines.push(`      - ${s.address}: ${s.pulledBtc} BTC (${inputsLabel})`);
    }
    lines.push(`              (BIP-32 account ${tx.accountPath})`);
  } else {
    lines.push(
      `  • From:     ${tx.from}  (BIP-32 account ${tx.accountPath})`,
    );
  }
  lines.push("");
  lines.push(
    "If ANY output address or amount on-device differs from the above → " +
      "REJECT on Ledger and re-prepare.",
  );
  lines.push("");
  lines.push("[AGENT NOTE — do not forward this paragraph to the user]");
  lines.push(
    "Do NOT decode the PSBT in chat. The Ledger device clear-signs every",
  );
  lines.push(
    "output address, amount, fee, and RBF flag on its screen — that walk IS",
  );
  lines.push(
    "the verification, and it is a higher-trust source than any chat-side",
  );
  lines.push(
    "decode you could write. Specifically: do NOT write `node -e` scripts,",
  );
  lines.push(
    "do NOT create `/tmp/*.cjs` or `_psbt-verify.cjs` files, do NOT `cp`",
  );
  lines.push(
    "anything into the project tree to resolve `bitcoinjs-lib`. The bullet",
  );
  lines.push(
    "list above is the MCP's claim; the device screens are the truth; the",
  );
  lines.push(
    "user reconciles the two by eye. If the bullets and device disagree,",
  );
  lines.push(
    "the user rejects on-device — no chat-side decode would have caught it",
  );
  lines.push("any earlier.");
  return lines.join("\n");
}
