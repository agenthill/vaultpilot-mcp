import type { TxVerification, UnsignedTx } from "../../types/index.js";
import { NATIVE_SYMBOL } from "../../config/contracts.js";

/**
 * Trim a native-fee decimal string ("0.00114523000…") to a small number of
 * significant fractional digits without trailing zeros. Cheap UX layer over
 * `formatUnits(_, 18)`; not meant for accounting accuracy. The thresholds
 * track typical L1/L2 gas magnitudes (~$0.01–$50 of gas → 1e-7 to 1e-2 of
 * native).
 */
export function formatNativeShort(native: string): string {
  const n = Number(native);
  if (!Number.isFinite(n) || n <= 0) return native;
  const fixed = n < 0.001 ? n.toFixed(8) : n < 0.1 ? n.toFixed(6) : n.toFixed(4);
  return fixed.replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * One-line "Estimated network fee" header emitted ahead of every EVM
 * VERIFY-BEFORE-SIGNING block (issue #636). Lets the user abort on fee shock
 * before they spend attention on the verification + cross-check + agent-task
 * surfaces below — a $40 gas estimate should kill the flow without further
 * scrutiny.
 *
 * Returns `null` when `enrichTx` couldn't estimate gas (the field stays
 * undefined). Better silent than fabricated: a wrong number rendered next
 * to a real device prompt is a worse failure mode than no number.
 *
 * USD half is omitted when the native price lookup degraded; the native half
 * is always shown when the field is present so the user still has a
 * comparison anchor against their wallet balance.
 *
 * Scope: EVM only. TRON / Solana / BTC / LTC carry no equivalent
 * precomputed cost field today (different fee models — bandwidth/energy,
 * lamports + priority, sat/vB × vsize). Tracked as a follow-up.
 */
export function renderCostPreviewBlock(
  tx: Pick<UnsignedTx, "chain" | "gasCostUsd" | "gasCostNative">,
): string | null {
  const native = tx.gasCostNative;
  if (!native) return null;
  const symbol = NATIVE_SYMBOL[tx.chain];
  const nativeFmt = formatNativeShort(native);
  const usd = tx.gasCostUsd;
  if (usd !== undefined) {
    return `Estimated network fee: ~$${usd.toFixed(2)} (≈ ${nativeFmt} ${symbol})`;
  }
  return `Estimated network fee: ≈ ${nativeFmt} ${symbol} (USD price unavailable)`;
}

/**
 * Shared formatter for the non-EVM prepare-time fee preview. Mirrors
 * `renderCostPreviewBlock`'s UX exactly so the fee-shock abort signal reads
 * the same across every chain (issue #649): "Estimated network fee" headline,
 * native amount always shown when present, USD half appended when the price
 * lookup succeeded and dropped silently when it degraded.
 *
 * `usd` is the already-resolved USD-per-native price (or undefined when the
 * fetch failed) — the caller does the network read so this stays a pure
 * formatter. Returns the headline string; callers gate on a present fee field
 * before calling (this never fabricates a number).
 */
export function formatNonEvmCostPreview(
  nativeFee: number,
  symbol: string,
  usdPerNative: number | undefined,
): string {
  const nativeFmt = formatNativeShort(String(nativeFee));
  if (usdPerNative !== undefined) {
    const usd = nativeFee * usdPerNative;
    return `Estimated network fee: ~$${usd.toFixed(2)} (≈ ${nativeFmt} ${symbol})`;
  }
  return `Estimated network fee: ≈ ${nativeFmt} ${symbol} (USD price unavailable)`;
}

export function truncateHex(data: string, bytelenLabel: boolean): string {
  const normalized = data.startsWith("0x") ? data : `0x${data}`;
  if (normalized.length <= 26) return normalized;
  const head = normalized.slice(0, 14);
  const tail = normalized.slice(-8);
  const byteLen = Math.floor((normalized.length - 2) / 2);
  return bytelenLabel ? `${head}…${tail} (${byteLen} bytes)` : `${head}…${tail}`;
}

/**
 * Collapse embedded hex blobs inside a rendered arg. Nested struct args
 * (e.g. LiFi `_swapData[].callData`) carry the wrapped-DEX calldata as a
 * 0x… hex run — a single struct-arg can be 2 KB of hex. stringifyArg
 * emits it verbatim; we replace those runs with a head…tail (N bytes)
 * preview so the chat stays scannable.
 *
 * Threshold is 32 bytes (66 chars including "0x"): addresses are 42 chars
 * (already short), bytes32 hashes fit in 66, and anything longer is
 * almost certainly a nested calldata / encoded-params blob the user
 * doesn't want to eyeball here anyway.
 */
const HEX_BLOB_RE = /0x[0-9a-fA-F]{67,}/g;
function truncateNestedHex(s: string): string {
  return s.replace(HEX_BLOB_RE, (m) => {
    const byteLen = Math.floor((m.length - 2) / 2);
    return `${m.slice(0, 14)}…${m.slice(-8)} (${byteLen} bytes)`;
  });
}

export function formatArgs(v: TxVerification): string[] {
  if (v.humanDecode.source === "none") {
    // No local ABI — lean on swiss-knife. Skip the "Args:" line entirely
    // (already covered by the decoder URL below).
    return [];
  }
  if (v.humanDecode.args.length === 0) {
    return ["  Args:    (none)"];
  }
  return [
    "  Args:",
    ...v.humanDecode.args.map((a) => `    - ${a.name}: ${truncateNestedHex(a.valueHuman ?? a.value)}`),
  ];
}

/**
 * Render the source-specific suffix that decorates the recipient line.
 * Address-book v1.0. Returns "" when there's no recipient metadata
 * (legacy tx envelopes, prepares without label resolution).
 */
export function formatRecipientSuffix(
  r: UnsignedTx["recipient"] | undefined,
): string {
  if (!r) return "";
  if (r.source === "contact" && r.label) {
    return ` (contact: ${r.label} — verified)`;
  }
  if (r.source === "ens" && r.label) {
    return ` (ENS, also saved as: ${r.label})`;
  }
  if (r.source === "ens") {
    return " (resolved via ENS)";
  }
  if (r.source === "literal" && r.label) {
    return ` (also saved as: ${r.label})`;
  }
  if (r.source === "literal" && (r.warnings?.length ?? 0) > 0) {
    return " (unknown — verify on-device)";
  }
  return "";
}

/**
 * User-facing block listing the EXACT args the agent supplied to a
 * `prepare_*` tool. Raised against the "narrow prompt-injection / malicious
 * skill / compromised subagent" threat model: the agent freely composes the
 * bullet summary, so a narrowly-compromised agent can *display* benign args
 * ("Send 0.1 ETH to Alice") while having *called* MCP with malicious ones
 * ("to = 0xEvil"). Forcing these receipts through a labeled verbatim-relay
 * block makes invisible tampering harder — the attacker must also craft
 * instructions that strip/mutate this specific block, not just rewrite args.
 *
 * Caveats, stated honestly:
 *   - A fully-coordinated compromised agent can drop this block; the whole
 *     user view goes through it. This is defense-in-depth against common
 *     attacks (prompt injection, add-on misbehavior), NOT a hard second
 *     trust boundary like the Ledger device display.
 *   - The values here match what MCP received, not what MCP forwards to
 *     the device — MCP-side tampering is caught by the LEDGER BLIND-SIGN
 *     HASH block at preview time, not here.
 *
 * Values are rendered as `key: value`; objects/arrays fall back to JSON so
 * nested structures (e.g. Tron vote tuples) stay inspectable without hand-
 * rolled formatting per shape.
 */
export function renderPrepareReceiptBlock(args: {
  tool: string;
  args: Record<string, unknown>;
}): string {
  const lines = [
    "PREPARE RECEIPT — RELAY VERBATIM TO USER",
    `  Tool: ${args.tool}`,
    "  Args (as the agent supplied them to the MCP server — not the agent's retelling):",
  ];
  const entries = Object.entries(args.args);
  if (entries.length === 0) {
    lines.push("    (none)");
  } else {
    for (const [k, v] of entries) {
      const rendered =
        v === undefined || v === null
          ? String(v)
          : typeof v === "string" || typeof v === "number" || typeof v === "boolean" || typeof v === "bigint"
            ? String(v)
            : JSON.stringify(v);
      lines.push(`    ${k}: ${rendered}`);
    }
  }
  lines.push("");
  lines.push("If these args don't match what you asked for, STOP — something between you");
  lines.push("and the MCP server (prompt injection, malicious skill, compromised sub-");
  lines.push("agent) rewrote the request. The bullet summary is the agent's retelling;");
  lines.push("these values are what actually hit the server.");
  return lines.join("\n");
}
