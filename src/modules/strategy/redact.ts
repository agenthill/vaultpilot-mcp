/**
 * Redaction-verify scan for shared strategies.
 *
 * The privacy guarantee `share_strategy` and `import_strategy` give —
 * "no addresses, no tx hashes, ever" — is enforced by this scan, not by
 * the serializer's hand-crafted shape. Reasoning:
 *
 *   - The serializer can be modified without anyone remembering a
 *     privacy invariant; a regex scan catches drift mechanically.
 *   - User-supplied free-form fields (`name`, `description`,
 *     `authorLabel`) ride through the same JSON, and a user could
 *     paste a wallet address into "name" by mistake. The scan stops
 *     it before emit.
 *   - Symmetric on import — a malicious sender can't sneak an address
 *     into a field the recipient might not eyeball.
 *
 * Patterns are de-anchored variants of the canonical shapes in
 * `shared/address-patterns.ts`. False positives are acceptable: a
 * legitimate 43-char base58 string in a `description` is rare enough
 * that throwing is the safer default — the user can rephrase.
 */

/** EVM 0x-prefixed 20-byte hex address. */
const EVM_ADDRESS_GLOBAL = /0x[a-fA-F0-9]{40}/g;

/** TRON base58-check address (T-prefix, 33 base58 chars after). */
const TRON_ADDRESS_GLOBAL = /T[1-9A-HJ-NP-Za-km-z]{33}/g;

/**
 * Solana ed25519 pubkey shape: 43-44 char base58. The base58 alphabet
 * collides with TRON's 33-char body, so a TRON address technically
 * matches this regex too — order matters: TRON pattern is checked
 * first to surface a more specific reason in the error.
 */
const SOLANA_ADDRESS_GLOBAL = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

/**
 * 64-hex transaction hash (with or without 0x prefix). Covers EVM tx
 * hashes, Bitcoin/Litecoin txids, and Solana hashes that some tools
 * surface as hex (rare). Solana signatures in base58 are 86-88 chars —
 * caught by SOLANA_ADDRESS_GLOBAL's broad shape (and a 86-char base58
 * string in chat is almost certainly a signature).
 */
const HEX_HASH_GLOBAL = /(?:0x)?[a-fA-F0-9]{64}/g;

/** A 86-88 char base58 string is a Solana signature. */
const SOLANA_SIGNATURE_GLOBAL = /[1-9A-HJ-NP-Za-km-z]{86,88}/g;

interface ScanRule {
  name: string;
  pattern: RegExp;
}

const SCAN_RULES: ScanRule[] = [
  // Order matters for the error-message clarity: distinct prefixes
  // first so the recipient knows the specific leak class.
  { name: "evm_address", pattern: EVM_ADDRESS_GLOBAL },
  { name: "tron_address", pattern: TRON_ADDRESS_GLOBAL },
  { name: "hex_hash", pattern: HEX_HASH_GLOBAL },
  { name: "solana_signature", pattern: SOLANA_SIGNATURE_GLOBAL },
  { name: "solana_address", pattern: SOLANA_ADDRESS_GLOBAL },
];

export class RedactionError extends Error {
  readonly leak: { rule: string; sample: string };
  constructor(leak: { rule: string; sample: string }) {
    super(
      `Redaction scan failed: shared-strategy JSON contains a ${leak.rule} ` +
        `match ("${leak.sample}"). The share/import path refuses to emit or ` +
        `accept JSON with raw addresses or tx hashes anywhere in the payload. ` +
        `Check the strategy meta fields (name / description / authorLabel) — ` +
        `the most common cause is an address pasted into a free-form field.`,
    );
    this.name = "RedactionError";
    this.leak = leak;
  }
}

/**
 * Stringify a value (deeply, including nested arrays/objects) and
 * regex-scan against every privacy rule. Throws `RedactionError` on
 * the first match. Returns silently on clean input.
 *
 * Stringification uses `JSON.stringify` with no pretty-printing — keys
 * + values are concatenated with delimiters that don't form valid
 * address shapes, so a hostile sender can't smuggle an address across
 * a key/value boundary.
 */
export function assertNoAddressLeak(value: unknown): void {
  const serialized = JSON.stringify(value);
  if (!serialized) {
    return;
  }
  for (const rule of SCAN_RULES) {
    // RegExp with /g flag retains state via `lastIndex`; reset before
    // each scan so back-to-back calls don't skip matches.
    rule.pattern.lastIndex = 0;
    const match = rule.pattern.exec(serialized);
    if (match !== null) {
      throw new RedactionError({
        rule: rule.name,
        sample: match[0].slice(0, 80),
      });
    }
  }
}
