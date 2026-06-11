import type { HistoryItem, SuspectedPoisoning } from "./schemas.js";

/**
 * Address-poisoning detection for `get_transaction_history` results.
 * Issue #220.
 *
 * Three precision-tuned heuristics — see `SuspectedPoisoning` in
 * `schemas.ts` for the rules and rationale.
 *
 * The detection is post-hoc: it runs after items are fetched, sorted,
 * truncated to the user's `limit`, and priced. Running after the
 * `valueUsd` annotation matters for rule 2/3 — the dust signal can
 * fire on EITHER native-amount-too-small OR USD-too-small, and we
 * want both paths.
 *
 * EVM-only for the suffix rules. TRON / Solana addresses have
 * different shapes (T-prefix base58 / raw base58); vanity-mining is
 * possible there too but the "first-4 AND last-4 hex" comparison
 * doesn't transfer cleanly. The zero-amount rule is chain-agnostic
 * and runs everywhere.
 */

/** Native-amount threshold for "dust": ≤ 10 gwei (1e10 wei). */
const DUST_NATIVE_WEI = 10_000_000_000n;
/** USD threshold for "dust": ≤ $0.01. */
const DUST_USD = 0.01;

function isDust(item: HistoryItem): boolean {
  if (item.type === "external" || item.type === "internal") {
    try {
      if (BigInt(item.valueNative) <= DUST_NATIVE_WEI) return true;
    } catch {
      // valueNative may not parse for chains where it's a non-decimal
      // string; the USD path below is the fallback.
    }
  }
  // valueUsd is present on external/internal/token_transfer; absent on
  // program_interaction (which uses per-delta valueUsd instead). Narrow
  // before reading so TS picks up the union arm.
  if (item.type === "program_interaction") return false;
  if (typeof item.valueUsd === "number" && item.valueUsd <= DUST_USD) {
    return true;
  }
  return false;
}

/**
 * Counterparty for a history item w.r.t. the wallet being queried.
 * Returns null if the item is a self-send (from === to === wallet) —
 * which would always trip the self-suffix rule otherwise.
 *
 * Comparison is lowercase. The returned counterparty is always
 * lowercased so downstream rule matches are case-insensitive.
 */
function counterpartyOf(item: HistoryItem, walletLc: string): string | null {
  const fromLc = item.from.toLowerCase();
  const toLc = item.to.toLowerCase();
  if (fromLc === walletLc && toLc === walletLc) return null;
  return fromLc === walletLc ? toLc : fromLc;
}

/**
 * Detect whether `addr` looks vanity-mined to mimic `target`. Both
 * inputs are EVM lowercase 0x-prefixed (the caller normalizes).
 * Match on first-4 AND last-4 hex chars after the `0x`. Returns false
 * if the addresses are equal (a true match isn't an impersonation).
 */
function suffixLookalike(addr: string, target: string): boolean {
  if (addr === target) return false;
  if (addr.length < 6 || target.length < 6) return false;
  if (!addr.startsWith("0x") || !target.startsWith("0x")) return false;
  return (
    addr.slice(2, 6) === target.slice(2, 6) &&
    addr.slice(-4) === target.slice(-4)
  );
}

/** EVM-shape check used to gate the suffix rules. */
function isEvmAddr(a: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(a);
}

/**
 * Mutates each item in place — attaches `suspectedPoisoning` when a
 * rule fires. Items without flags are untouched. Pure (deterministic
 * given inputs); no I/O.
 */
export function annotatePoisoning(
  items: HistoryItem[],
  wallet: string,
): void {
  const walletLc = wallet.toLowerCase();
  const walletIsEvm = isEvmAddr(walletLc);

  // Counterparty set across the result. Used for rule 2 — find a
  // distinct counterparty in this same wallet's history that matches
  // the suspect's first-4/last-4. Wallet itself is excluded (rule 3
  // covers that case).
  const counterpartySet = new Set<string>();
  for (const item of items) {
    const cp = counterpartyOf(item, walletLc);
    if (cp && cp !== walletLc) counterpartySet.add(cp);
  }

  for (const item of items) {
    const reasons: SuspectedPoisoning["reasons"] = [];
    let mimics: string | undefined;

    // Rule 1: zero-amount token_transfer. Chain-agnostic.
    if (item.type === "token_transfer" && item.amount === "0") {
      reasons.push("zero_amount_transfer");
    }

    // Rules 2 & 3 require EVM (hex shape). Skip the rest on non-EVM.
    if (!walletIsEvm) {
      if (reasons.length > 0) {
        item.suspectedPoisoning = { reasons };
      }
      continue;
    }

    const cp = counterpartyOf(item, walletLc);
    if (cp && isEvmAddr(cp) && isDust(item)) {
      // Rule 2: vanity-suffix lookalike of another counterparty. Skip
      // matches against the wallet itself — that's rule 3.
      for (const other of counterpartySet) {
        if (other === cp) continue;
        if (other === walletLc) continue;
        if (suffixLookalike(cp, other)) {
          reasons.push("vanity_suffix_lookalike");
          mimics = other;
          break;
        }
      }
      // Rule 3: self-suffix lookalike of the wallet.
      if (suffixLookalike(cp, walletLc)) {
        reasons.push("self_suffix_lookalike");
        // If both rule 2 and rule 3 fire, prefer the wallet as
        // `mimics` — the self-impersonation is the more specific /
        // more dangerous claim and is what the user would care about
        // in chat.
        mimics = walletLc;
      }
    }

    if (reasons.length > 0) {
      item.suspectedPoisoning = { reasons, ...(mimics ? { mimics } : {}) };
    }
  }
}
