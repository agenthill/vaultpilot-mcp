import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
} from "viem";
import { fetch4byteSignatures, type FetchLike } from "../data/apis/fourbyte.js";
import type { UnsignedTx, UnsignedTronTx } from "../types/index.js";

export type { FetchLike };

/**
 * Independent arg+selector cross-check.
 *
 * The verification block already shows a LOCAL decode built from our static
 * ABI registry. That is one voice. The "swiss-knife decoder" URL printed in
 * chat is a SECOND voice — but it's a client-rendered Next.js SPA, so
 * `WebFetch` can't see its output, and we can't cheaply verify it on the
 * user's behalf. Telling the agent "confirm it matches swiss-knife" is
 * therefore asking the agent to lie or do something opaque.
 *
 * This module replaces that gap with a third, server-side decode whose
 * input is INDEPENDENT of our ABI registry:
 *
 *   1. Fetch all candidate function signatures for the 4-byte selector from
 *      https://www.4byte.directory — a public registry built from unrelated
 *      on-chain traffic.
 *   2. For each candidate, attempt `decodeFunctionData → encodeFunctionData`.
 *      If the re-encoded bytes equal the original calldata, the signature
 *      describes the calldata LOSSLESSLY (any trailing junk, wrong arity, or
 *      mismatched type layout would fail this). First one that round-trips
 *      is the confirmed signature.
 *   3. Compare the function NAME from the independent signature to the
 *      function name the local decode claims. If they agree, the local
 *      decode's function identity is corroborated by a source that has no
 *      knowledge of our ABI files. If they disagree, return MISMATCH — this
 *      is a strong "do not send" signal.
 *
 * Why we don't separately compare each arg VALUE: the re-encode check is
 * stricter. Once we've proved that `decode(data) → args` and
 * `encode(args) === data` for a given type layout, any other decoder reading
 * the same `data` with the same types is guaranteed to produce the same
 * leaf values — the mapping from calldata bytes to typed values is a
 * function, not a choice. An arg-by-arg stringify compare would just be
 * testing that viem is deterministic.
 */

export interface VerifyDecodeResult {
  status: "match" | "mismatch" | "no-signature" | "no-data" | "not-applicable" | "error";
  selector: string;
  localFunctionName?: string;
  localSignature?: string;
  independentSignature?: string;
  independentFunctionName?: string;
  reencodeCheck?: "pass" | "fail";
  candidateCount?: number;
  independentArgs?: Array<{ index: number; type: string; value: string }>;
  /**
   * Human-readable, end-user-facing message. The orchestrator agent relays
   * this VERBATIM to the user so the phrasing is consistent across calls.
   */
  summary: string;
}


function funcName(sig: string): string {
  const idx = sig.indexOf("(");
  return idx < 0 ? sig : sig.slice(0, idx);
}

/**
 * Positional-only stringifier for decoded raw values. Drops struct field
 * names (`{foo: 1, bar: 2}` → `[1, 2]`) so callers can read the output
 * without needing a compatible ABI schema. Hex blobs > 32 bytes are
 * truncated for UI legibility — the lossless re-encode is the real
 * correctness check, this string is just for humans to skim.
 */
function stringifyRaw(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") {
    if (value.startsWith("0x") && value.length > 66) {
      const byteLen = Math.floor((value.length - 2) / 2);
      return `${value.slice(0, 14)}…${value.slice(-8)} (${byteLen} bytes)`;
    }
    return value;
  }
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stringifyRaw).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `[${Object.values(value as Record<string, unknown>).map(stringifyRaw).join(", ")}]`;
  }
  return String(value);
}

export function notApplicableForTron(tx?: UnsignedTronTx): VerifyDecodeResult {
  if (tx) {
    const argLines = Object.entries(tx.decoded.args)
      .map(([k, v]) => `  ${k}: ${v}`)
      .join("\n");
    const feeLine =
      tx.estimatedEnergyCostSun && tx.feeLimitSun
        ? `\nFee: expected burn ~${(Number(tx.estimatedEnergyCostSun) / 1e6).toFixed(2)} TRX ` +
          `(cap ${(Number(tx.feeLimitSun) / 1e6).toFixed(0)} TRX).`
        : "";
    return {
      status: "not-applicable",
      selector: "0x",
      summary:
        `TRON ${tx.action} — decoded preview:\n${tx.decoded.functionName}\n${argLines}${feeLine}\n\n` +
        `The server verified at prepare time that the raw_data_hex TronGrid returned encodes exactly this ` +
        `action (see assertTronRawDataMatches in verify-raw-data.ts). Ledger's TRON app clear-signs canonical ` +
        `TRC-20 transfers natively; verify the recipient + amount on-device match the args above. For ` +
        `non-clear-signable actions (freeze, vote), Ledger falls back to blind-sign and the payload-hash ` +
        `match becomes the primary safety net.`,
    };
  }
  return {
    status: "not-applicable",
    selector: "0x",
    summary:
      "Independent cross-check via 4byte.directory is EVM-only. On TRON, the preparer hand-builds the " +
      "structured decoded action (transfer / vote / freeze / …) directly from the TronGrid envelope — " +
      "there is no 4-byte selector to look up. After broadcast, paste the txID into tronscan.org for an " +
      "external eyeball check.",
  };
}

/**
 * ERC-20 `approve(address,uint256)` selector. Clear-signed natively on
 * Ledger's Ethereum app (device shows spender + amount), so the whole
 * verification-block + agent-task-block pair is suppressed at render
 * time. This tool short-circuits on the same selector for two reasons:
 * (1) consistency with that suppression, and (2) 4byte.directory has
 * notorious collision spam here (e.g. `watch_tg_invmru_*(address,address)`)
 * that shares the (address, 32-byte) calldata layout — any 64-byte
 * payload round-trips bijectively through both, so the cross-check
 * would produce a false mismatch on a universally-known selector.
 */
const ERC20_APPROVE_SELECTOR = "0x095ea7b3";

export async function verifyEvmCalldata(
  tx: Pick<UnsignedTx, "data" | "verification">,
  fetchFn?: FetchLike,
): Promise<VerifyDecodeResult> {
  const data = tx.data;
  if (!data || data === "0x" || data.length < 10) {
    return {
      status: "no-data",
      selector: "0x",
      summary:
        "No calldata to cross-check — this is a pure native-value transfer. Ledger's generic transfer " +
        "screen shows the recipient and value directly; compare those against the verification block.",
    };
  }

  const selector = data.slice(0, 10).toLowerCase();

  if (selector === ERC20_APPROVE_SELECTOR) {
    return {
      status: "not-applicable",
      selector,
      summary:
        "ERC-20 approve — Ledger clear-signs this natively. Verify on the device that the spender and " +
        "amount match what you asked for.",
    };
  }
  const localDecode = tx.verification?.humanDecode;
  // Only `"local-abi"` carries a canonical function name that's safe to
  // compare against 4byte. `"local-abi-partial"` (LiFi bridge facets) ships
  // a synthetic label by design — name-equality would always fail.
  const localFunctionName =
    localDecode && localDecode.source === "local-abi" ? localDecode.functionName : undefined;
  const localSignature = localDecode?.signature;
  const isPartialLocal = localDecode?.source === "local-abi-partial";

  let signatures: string[];
  try {
    signatures = await fetch4byteSignatures(selector, fetchFn);
  } catch (e) {
    return {
      status: "error",
      selector,
      localFunctionName,
      localSignature,
      summary:
        `Could not reach 4byte.directory to cross-check selector ${selector} (${e instanceof Error ? e.message : String(e)}). ` +
        `The local ABI decode is still shown above, but there is no independent confirmation this turn. ` +
        `Open the swiss-knife decoder URL in a browser for a manual check before approving.`,
    };
  }

  if (signatures.length === 0) {
    return {
      status: "no-signature",
      selector,
      localFunctionName,
      localSignature,
      summary:
        `Selector ${selector} is not registered in 4byte.directory — common for freshly-deployed contracts ` +
        `or private function names. No independent cross-check is possible here; open the swiss-knife decoder ` +
        `URL in a browser to verify the decoded arguments manually before approving on Ledger.`,
    };
  }

  // Collect EVERY candidate that round-trips losslessly, then pick among
  // them — selector collisions are real (registry spam, or genuinely
  // identical calldata layouts like `(address, uint256)` vs
  // `(address, address)` where any 64-byte payload is bijective between
  // them). Breaking on the first pass would let the earliest-registered
  // candidate win arbitrarily, including spam entries that shadow the
  // canonical signature.
  const losslessMatches: {
    signature: string;
    args: readonly unknown[];
    abiItem: AbiFunction;
  }[] = [];
  let decodedButReencodeFailed: string | null = null;

  for (const sig of signatures) {
    let abiItem: AbiFunction;
    try {
      abiItem = parseAbiItem(`function ${sig}`) as AbiFunction;
    } catch {
      continue;
    }
    try {
      if (toFunctionSelector(abiItem).toLowerCase() !== selector) continue;
    } catch {
      continue;
    }
    let args: readonly unknown[];
    try {
      const decoded = decodeFunctionData({ abi: [abiItem], data: data as `0x${string}` });
      args = (decoded.args ?? []) as readonly unknown[];
    } catch {
      continue;
    }
    try {
      const reencoded = encodeFunctionData({
        abi: [abiItem],
        functionName: abiItem.name,
        args: args as never,
      });
      if (reencoded.toLowerCase() === data.toLowerCase()) {
        losslessMatches.push({ signature: sig, args, abiItem });
      } else if (!decodedButReencodeFailed) {
        decodedButReencodeFailed = sig;
      }
    } catch {
      continue;
    }
  }

  // Prefer the candidate whose function name matches the local decode —
  // that's the whole point of a cross-check. If multiple 4byte entries
  // decode the same bytes losslessly but only one names the function
  // the way our local ABI does, they corroborate each other; the others
  // are registry noise with coincidentally-compatible argument layouts.
  const chosen = losslessMatches.find(
    (m) => localFunctionName && funcName(m.signature) === localFunctionName,
  ) ?? losslessMatches[0] ?? null;

  if (!chosen) {
    const extra = decodedButReencodeFailed
      ? ` One candidate ("${decodedButReencodeFailed}") decoded but did not re-encode to the exact bytes, which usually means the 4byte entry is missing a trailing dynamic parameter.`
      : "";
    return {
      status: "error",
      selector,
      localFunctionName,
      localSignature,
      candidateCount: signatures.length,
      summary:
        `4byte.directory returned ${signatures.length} candidate signature(s) for ${selector}, but none decoded the ` +
        `calldata losslessly.${extra} Falling back to manual verification: open the swiss-knife decoder URL in a browser.`,
    };
  }

  const independentFunctionName = funcName(chosen.signature);
  const namesMatch = !localFunctionName || independentFunctionName === localFunctionName;
  const independentArgs = chosen.args.map((raw, i) => ({
    index: i,
    type: chosen.abiItem.inputs[i]?.type ?? "unknown",
    value: stringifyRaw(raw),
  }));

  if (!namesMatch) {
    return {
      status: "mismatch",
      selector,
      localFunctionName,
      localSignature,
      independentSignature: chosen.signature,
      independentFunctionName,
      reencodeCheck: "pass",
      candidateCount: signatures.length,
      independentArgs,
      summary:
        `✗ CROSS-CHECK MISMATCH — DO NOT SEND. My local ABI decoded this calldata as "${localFunctionName}", ` +
        `but 4byte.directory's signature for selector ${selector} is "${chosen.signature}" (function "${independentFunctionName}"). ` +
        `The two sources disagree on what this call does; refuse to approve on Ledger and investigate.`,
    };
  }

  const summary = localFunctionName
    ? `✓ Cross-check passed via 4byte.directory. 4byte is a public selector registry built from unrelated ` +
      `on-chain traffic — a DATA SOURCE separate from the server's local ABI and from your model weights, ` +
      `though the server made the HTTP call to fetch it. I pulled 4byte's signature for ${localFunctionName}, ` +
      `decoded the calldata against it, and the result re-encodes to the original bytes exactly — which ` +
      `mathematically implies every argument below matches what's actually in the transaction. Caveat for ` +
      `the fully-compromised-MCP case: a hostile server could theoretically MITM the 4byte response; the ` +
      `swiss-knife decoder link (rendered in the VERIFY block above) is the out-of-band browser-side check ` +
      `for that threat. For all other threat models 4byte's independent data provenance is a legitimate ` +
      `selector→name anchor — it's specifically WHY this cross-check exists.`
    : isPartialLocal
    ? `✓ Cross-check passed via 4byte.directory. The local ABI surfaced a PARTIAL decode (a positional ` +
      `decode of a known shared sub-tuple — e.g. LiFi's universal BridgeData — because the specific ` +
      `selector / facet ABI isn't in the server's registry); the canonical name is 4byte's "${chosen.signature}". ` +
      `Name-equality is intentionally skipped here (the local label is synthetic and would always disagree), ` +
      `but the re-encode check still anchors the args: 4byte's signature decoded these calldata bytes and ` +
      `re-encoded them back losslessly, so the LOCAL decode's surfaced fields above (bridge name, receiver, ` +
      `sendingAssetId, minAmount, destinationChainId for a LiFi bridge) faithfully describe the bytes that ` +
      `will be signed. Compromised-MCP caveat: same as the full-decode case — use the swiss-knife decoder ` +
      `link in the VERIFY block above for an out-of-band browser-side check.`
    : `✓ Cross-check passed via 4byte.directory. 4byte is a public selector registry built from unrelated ` +
      `on-chain traffic — a DATA SOURCE separate from the server's local ABI (though the server fetched ` +
      `the registry via HTTP). The calldata decodes cleanly against signature "${chosen.signature}", and ` +
      `the decoded args re-encode to the original bytes exactly, so the values in independentArgs ` +
      `faithfully reflect the transaction. Your local ABI didn't recognize this destination, so review ` +
      `those args before approving — and for the fully-compromised-MCP case, use the browser-side ` +
      `swiss-knife decoder link in the VERIFY block above.`;

  return {
    status: "match",
    selector,
    localFunctionName,
    localSignature,
    independentSignature: chosen.signature,
    independentFunctionName,
    reencodeCheck: "pass",
    candidateCount: signatures.length,
    independentArgs,
    summary,
  };
}
