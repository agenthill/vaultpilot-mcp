/**
 * Redaction helpers for incident-report bundles (issue #425).
 *
 * Default redaction is conservative — addresses get fuzzed to
 * first-4 / last-4 of the meaningful chars so an agent can show the
 * bundle to the user without leaking full hex / base58. The user
 * explicitly opts in to `redact: "none"` when they're ready to share
 * full hex with a trusted security contact.
 *
 * `redact: "all"` additionally strips amounts to a coarse rounded
 * USD value — useful when the user wants to file an incident
 * narrative against a public repo without leaking exact balances.
 */

import {
  EVM_ADDRESS,
  SOLANA_ADDRESS,
  TRON_ADDRESS,
} from "../../shared/address-patterns.js";

export type RedactionMode = "none" | "addresses" | "all";

/**
 * Fuzz a single address to first-4 / last-4 chars of its meaningful
 * portion, joined by an ellipsis. EVM strips the `0x` prefix from the
 * fuzz window so the output is `0xABCD…1234` rather than the
 * less-recognizable `0xABCD…1234` (same shape but the first-4 stays
 * after the prefix). Non-matching strings pass through unchanged so
 * the helper is safe to apply to any string field.
 */
export function redactAddress(value: string, mode: RedactionMode): string {
  if (mode === "none") return value;
  if (typeof value !== "string") return value;
  // EVM: 0x + 40 hex chars. Fuzz inside the prefix.
  if (EVM_ADDRESS.test(value)) {
    return `0x${value.slice(2, 6)}…${value.slice(-4)}`;
  }
  // TRON: T + 33 base58. Fuzz keeps the T-prefix anchor.
  if (TRON_ADDRESS.test(value)) {
    return `T${value.slice(1, 5)}…${value.slice(-4)}`;
  }
  // Solana: 43-44 base58 chars, no prefix.
  if (SOLANA_ADDRESS.test(value)) {
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  // Bitcoin bech32: bc1q… / bc1p…. Keep the human-readable prefix
  // (`bc1q` / `bc1p` discriminates segwit vs taproot).
  if (/^bc1[qp][a-zA-HJ-NP-Z0-9]{20,80}$/.test(value)) {
    return `${value.slice(0, 6)}…${value.slice(-4)}`;
  }
  // Bitcoin legacy / p2sh.
  if (/^[13][a-km-zA-HJ-NP-Z1-9]{25,34}$/.test(value)) {
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
  // Tx hash — keep the first / last anchor for cross-referencing
  // with explorers, but show that the user has the full hash.
  if (/^0x[a-fA-F0-9]{64}$/.test(value)) {
    return `0x${value.slice(2, 6)}…${value.slice(-4)}`;
  }
  return value;
}

/**
 * Coarse-bucket a USD amount for `redact: "all"` mode. Buckets are
 * order-of-magnitude — sufficient to communicate the rough scale of
 * an incident ("~$1k" vs "~$100k") without leaking exact balances.
 */
export function redactAmountUsd(usd: number, mode: RedactionMode): string {
  if (mode !== "all") return `$${usd.toFixed(2)}`;
  if (usd <= 0) return "$0";
  if (usd < 10) return "<$10";
  if (usd < 100) return "~$10–100";
  if (usd < 1_000) return "~$100–1k";
  if (usd < 10_000) return "~$1k–10k";
  if (usd < 100_000) return "~$10k–100k";
  if (usd < 1_000_000) return "~$100k–1M";
  return "~$1M+";
}

/**
 * Apply redaction recursively to a structured envelope. Mutates a
 * fresh deep-clone — caller's input is never modified.
 *
 * Address-shaped string fields ANYWHERE in the envelope get the
 * `redactAddress` treatment; numeric `*Usd` fields get bucketed
 * under `mode === "all"`. Other fields pass through as-is.
 */
export function redactEnvelope<T>(envelope: T, mode: RedactionMode): T {
  if (mode === "none") return envelope;
  return walk(envelope, mode) as T;
}

function walk(value: unknown, mode: RedactionMode): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return redactAddress(value, mode);
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((v) => walk(v, mode));
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Bucket USD amounts under "all" mode. Field name suffix is the
      // signal — `*Usd` / `*USD` / `*usd`.
      if (
        mode === "all" &&
        typeof v === "number" &&
        /usd$/i.test(k)
      ) {
        out[k] = redactAmountUsd(v, mode);
      } else {
        out[k] = walk(v, mode);
      }
    }
    return out;
  }
  return value;
}
