/**
 * Solana instruction decoders for native programs (System, SPL Token, Stake).
 *
 * The scope is intentionally narrow: for native programs we parse the
 * instruction data bytes into semantic fields (transfer amount, delegate
 * target, etc.) because the layouts are stable, published, and small. For
 * third-party programs (Jupiter, Marinade, Raydium, Orca) we do NOT parse
 * instruction data — per-IDL decoding is brittle across upgrades. Instead,
 * `history/solana.ts` uses the tx-level balance deltas from `meta.preTokenBalances`
 * / `meta.postTokenBalances` + `meta.preBalances` / `meta.postBalances` to
 * derive "user held X of token A before, Y of token B after" summaries,
 * labeled by the known-program name. That's robust to IDL changes and
 * more directly answers "what happened to my wallet?".
 */

/** First 4 bytes LE of the instruction discriminator the System Program uses. */
export const SYSTEM_IX = {
  CREATE_ACCOUNT: 0,
  TRANSFER: 2,
  CREATE_ACCOUNT_WITH_SEED: 3,
  ADVANCE_NONCE: 4,
  WITHDRAW_NONCE: 5,
  INITIALIZE_NONCE: 6,
  AUTHORIZE_NONCE: 7,
  ALLOCATE: 8,
  ALLOCATE_WITH_SEED: 9,
  ASSIGN_WITH_SEED: 10,
  TRANSFER_WITH_SEED: 11,
} as const;

/** First-byte discriminator for the SPL Token program. */
export const TOKEN_IX = {
  INITIALIZE_MINT: 0,
  INITIALIZE_ACCOUNT: 1,
  TRANSFER: 3,
  APPROVE: 4,
  REVOKE: 5,
  SET_AUTHORITY: 6,
  MINT_TO: 7,
  BURN: 8,
  CLOSE_ACCOUNT: 9,
  TRANSFER_CHECKED: 12,
  APPROVE_CHECKED: 13,
  MINT_TO_CHECKED: 14,
  BURN_CHECKED: 15,
} as const;

/** First-byte discriminator for the Stake program. */
export const STAKE_IX = {
  INITIALIZE: 0,
  AUTHORIZE: 1,
  DELEGATE_STAKE: 2,
  SPLIT: 3,
  WITHDRAW: 4,
  DEACTIVATE: 5,
  SET_LOCKUP: 6,
  MERGE: 7,
} as const;

/** base58-decoded instruction data helper. */
function decodeBase58(s: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let num = 0n;
  for (const c of s) {
    const v = alphabet.indexOf(c);
    if (v < 0) throw new Error(`Invalid base58 char: ${c}`);
    num = num * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (num > 0n) {
    bytes.push(Number(num & 0xffn));
    num >>= 8n;
  }
  // Leading zeros in base58 → leading zero bytes.
  for (const c of s) {
    if (c !== "1") break;
    bytes.push(0);
  }
  return new Uint8Array(bytes.reverse());
}

/** Read an 8-byte little-endian u64 from `bytes` starting at `offset`. */
function readLeU64(bytes: Uint8Array, offset: number): bigint {
  let value = 0n;
  for (let i = offset + 7; i >= offset; i--) {
    value = (value << 8n) | BigInt(bytes[i]);
  }
  return value;
}

/**
 * Classify a System Program instruction. Returns `{ kind: "transfer", lamports }`
 * for the transfer case (the only one `history/solana.ts` surfaces as an
 * `external` item); other variants return `{ kind: "other", variantCode }`
 * so the history module can log them as `program_interaction`.
 *
 * `ixDataB58` is the base58-encoded instruction data from `tx.transaction.message.instructions[i].data`.
 */
export function decodeSystemInstruction(
  ixDataB58: string,
): { kind: "transfer"; lamports: bigint } | { kind: "other"; variantCode: number } {
  try {
    const bytes = decodeBase58(ixDataB58);
    if (bytes.length < 4) return { kind: "other", variantCode: -1 };
    const variant = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    if (variant === SYSTEM_IX.TRANSFER) {
      if (bytes.length < 12) return { kind: "other", variantCode: variant };
      // 8 bytes LE u64 after the 4-byte variant tag.
      return { kind: "transfer", lamports: readLeU64(bytes, 4) };
    }
    return { kind: "other", variantCode: variant };
  } catch {
    return { kind: "other", variantCode: -1 };
  }
}

/**
 * Classify an SPL Token instruction. Returns semantic shape for
 * Transfer / TransferChecked (the two user-facing transfer variants); other
 * ops return `other` for program-interaction labeling. We do NOT resolve
 * source/destination owners — those are account-list lookups the caller
 * (history/solana.ts) does against `accountKeys` using the instruction's
 * account indexes.
 *
 * Transfer: `[opcode:u8, amount:u64]` (9 bytes).
 * TransferChecked: `[opcode:u8, amount:u64, decimals:u8]` (10 bytes).
 */
export function decodeTokenInstruction(
  ixDataB58: string,
): { kind: "transfer"; amount: bigint } | { kind: "transferChecked"; amount: bigint; decimals: number } | { kind: "other"; variantCode: number } {
  try {
    const bytes = decodeBase58(ixDataB58);
    if (bytes.length < 1) return { kind: "other", variantCode: -1 };
    const variant = bytes[0];
    if (variant === TOKEN_IX.TRANSFER && bytes.length >= 9) {
      return { kind: "transfer", amount: readLeU64(bytes, 1) };
    }
    if (variant === TOKEN_IX.TRANSFER_CHECKED && bytes.length >= 10) {
      return { kind: "transferChecked", amount: readLeU64(bytes, 1), decimals: bytes[9] };
    }
    return { kind: "other", variantCode: variant };
  } catch {
    return { kind: "other", variantCode: -1 };
  }
}

/**
 * Classify a Stake Program instruction. Returns `kind` for the three
 * user-interesting operations (delegate, deactivate, withdraw); others
 * collapse to `other`. Withdraw carries a u64 lamports amount after the
 * 4-byte variant tag.
 */
export function decodeStakeInstruction(
  ixDataB58: string,
):
  | { kind: "delegate" }
  | { kind: "deactivate" }
  | { kind: "withdraw"; lamports: bigint }
  | { kind: "other"; variantCode: number } {
  try {
    const bytes = decodeBase58(ixDataB58);
    if (bytes.length < 4) return { kind: "other", variantCode: -1 };
    const variant = bytes[0] | (bytes[1] << 8) | (bytes[2] << 16) | (bytes[3] << 24);
    if (variant === STAKE_IX.DELEGATE_STAKE) return { kind: "delegate" };
    if (variant === STAKE_IX.DEACTIVATE) return { kind: "deactivate" };
    if (variant === STAKE_IX.WITHDRAW) {
      if (bytes.length < 12) return { kind: "other", variantCode: variant };
      return { kind: "withdraw", lamports: readLeU64(bytes, 4) };
    }
    return { kind: "other", variantCode: variant };
  } catch {
    return { kind: "other", variantCode: -1 };
  }
}
