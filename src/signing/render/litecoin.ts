import type { UnsignedLitecoinTx } from "../../types/index.js";
import { fetchLitecoinPrice } from "../../modules/litecoin/price.js";
import { formatNonEvmCostPreview } from "./format.js";

/**
 * Prepare-time fee preview for Litecoin (issue #649). Reads the precomputed
 * `decoded.feeLtc` decimal string already on the unsigned-tx envelope and
 * anchors it in USD via `fetchLitecoinPrice` (DefiLlama `coingecko:litecoin`).
 * Same null-on-missing / native-only-on-degrade UX as the EVM block.
 *
 * `priceFn` is injectable for deterministic tests.
 */
export async function renderLitecoinCostPreviewBlock(
  tx: { decoded: Pick<UnsignedLitecoinTx["decoded"], "feeLtc"> },
  priceFn: () => Promise<number | undefined> = fetchLitecoinPrice,
): Promise<string | null> {
  const feeLtc = tx.decoded?.feeLtc;
  if (feeLtc === undefined) return null;
  const n = Number(feeLtc);
  if (!Number.isFinite(n)) return null;
  const usdPerLtc = await priceFn();
  return formatNonEvmCostPreview(n, "LTC", usdPerLtc);
}

/**
 * Litecoin verification block — mirror of `renderBitcoinVerificationBlock`.
 * The Ledger Litecoin app uses the same clear-sign UX as the Bitcoin
 * app (it's the same SDK) so the review surface is identical:
 * per-output address+amount + fee + RBF + source.
 */
export function renderLitecoinVerificationBlock(tx: UnsignedLitecoinTx): string {
  const lines: string[] = [];
  const isMultiSource = tx.decoded.sources.length > 1;
  lines.push(
    `VERIFY BEFORE SIGNING (Litecoin — ${isMultiSource ? "multi-source consolidation" : "native send"})`,
  );
  lines.push(
    "The Ledger Litecoin app clear-signs every output. Confirm on-device:",
  );
  for (let i = 0; i < tx.decoded.outputs.length; i++) {
    const o = tx.decoded.outputs[i];
    const tag = o.isChange ? "Change" : `Output ${i + 1}`;
    const labelSuffix = o.isChange ? " (your wallet)" : "";
    lines.push(`  • ${tag}: ${o.amountLtc} LTC → ${o.address}${labelSuffix}`);
  }
  lines.push(
    `  • Fee:      ${tx.decoded.feeLtc} LTC (~${tx.decoded.feeRateSatPerVb} litoshi/vB)`,
  );
  lines.push(
    `  • RBF:      ${tx.decoded.rbfEligible ? "enabled — replaceable" : "disabled — final"}`,
  );
  if (isMultiSource) {
    lines.push(`  • From:     ${tx.decoded.sources.length} source addresses`);
    for (const s of tx.decoded.sources) {
      const inputsLabel = s.inputCount === 1 ? "1 input" : `${s.inputCount} inputs`;
      lines.push(`      - ${s.address}: ${s.pulledLtc} LTC (${inputsLabel})`);
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
    "decode you could write. Same agent-side rule as Bitcoin: do NOT write",
  );
  lines.push("`node -e` scripts or `_psbt-verify.cjs` files.");
  return lines.join("\n");
}
