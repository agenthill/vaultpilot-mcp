/**
 * Top-level calldata decoder for `explain_tx`. Resolves the 4-byte
 * selector via 4byte.directory and tries each candidate signature with
 * viem's `decodeFunctionData`. The chosen signature is the first one
 * whose decoded args re-encode to the exact original bytes — selector
 * collisions are real (registry spam + genuinely identical parameter
 * layouts), so the round-trip equality check is the integrity gate.
 *
 * When the selector is unregistered or no candidate round-trips, the
 * caller surfaces `rawInput` only and the agent falls back to manual
 * decode (Etherscan / swiss-knife / contract source).
 */

import {
  decodeFunctionData,
  encodeFunctionData,
  parseAbiItem,
  toFunctionSelector,
  type AbiFunction,
  type Hex,
} from "viem";
import { fetch4byteSignatures } from "../../data/apis/fourbyte.js";
import { cache } from "../../data/cache.js";
import type { ExplainTxDecodedCall } from "./schemas.js";

const SIGNATURES_TTL = 86_400_000;

async function getSignaturesForSelector(selector: string): Promise<string[]> {
  const key = `4byte-sigs:${selector.toLowerCase()}`;
  const cached = cache.get<string[]>(key);
  if (cached) return cached;
  try {
    const sigs = await fetch4byteSignatures(selector);
    cache.set(key, sigs, SIGNATURES_TTL);
    return sigs;
  } catch {
    return [];
  }
}

/**
 * Convert viem-decoded arg values into JSON-friendly equivalents.
 * Bigints become decimal strings, hex stays hex, tuples / arrays
 * recurse. Anything we don't recognize passes through.
 */
function jsonifyArg(v: unknown): unknown {
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return v.map(jsonifyArg);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = jsonifyArg(val);
    }
    return out;
  }
  return v;
}

export async function decodeCallArgs(
  calldata: string,
): Promise<ExplainTxDecodedCall | undefined> {
  if (!calldata || calldata === "0x" || calldata.length < 10) return undefined;
  const selector = calldata.slice(0, 10).toLowerCase();
  if (!/^0x[0-9a-f]{8}$/.test(selector)) return undefined;

  const signatures = await getSignaturesForSelector(selector);
  if (signatures.length === 0) {
    return { selector };
  }

  const ambiguous = signatures.length > 1;
  const data = calldata as Hex;

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
      const decoded = decodeFunctionData({ abi: [abiItem], data });
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
      if (reencoded.toLowerCase() !== data.toLowerCase()) continue;
    } catch {
      continue;
    }
    const result: ExplainTxDecodedCall = {
      selector,
      signature: sig,
      args: args.map(jsonifyArg),
    };
    if (ambiguous) result.ambiguous = true;
    return result;
  }

  const fallback: ExplainTxDecodedCall = { selector };
  if (ambiguous) fallback.ambiguous = true;
  return fallback;
}
