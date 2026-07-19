/**
 * Selector classifier for `prepare_custom_call` value-exfil patterns
 * (issue #652, deferred from #493 / PR #494).
 *
 * `prepare_custom_call` is the explicit escape hatch — it BYPASSES the
 * canonical-dispatch allowlist on purpose, gated by
 * `acknowledgeNonProtocolTarget: true`. The v1 user-side defenses
 * (swiss-knife decoder URL, simulation revert reason, on-device
 * blind-sign hash) cover the threat model where the attacker is the
 * agent or a prompt-injection that rewrites args. They do NOT cover
 * the threat model where the user themselves has been social-
 * engineered into running a custom call that drains their wallet.
 *
 * The classifier inspects the encoded calldata's 4-byte selector
 * against a hardcoded ruleset of known value-exfil patterns. Hard
 * "refuse" matches throw a structured error pointing at the safer
 * protocol-specific tool; soft "warn" matches attach a non-fatal
 * annotation to the decoded preview so the user sees the warning
 * before signing without the call being blocked outright.
 *
 * Approve(`0x095ea7b3`) is intentionally NOT in this ruleset — it's
 * already gated by the dedicated `assertApproveRoutedToDedicatedTool`
 * check (issue #556) which carries protocol-spender resolution and
 * its own `acknowledgeRawApproveBypass` escape hatch.
 *
 * Out-of-scope (deferred): cross-contract reentrancy detection
 * (claimAirdrop → transferFrom via pre-existing approval), arg-shape
 * filtering against the contacts address-book, per-protocol
 * allowlists for the target contract.
 */

// ── STUB (issue #741) — replaced by the real gate in the next commit. ──
export interface SendFamilyGateEntry {
  selector: `0x${string}`;
  signature: string;
  recipientArgIndex: number;
}
export const SEND_FAMILY_RECIPIENT_GATE: readonly SendFamilyGateEntry[] = [];
export function matchSendFamilyGate(
  _data: `0x${string}`,
): SendFamilyGateEntry | null {
  return null;
}
export function assertSendFamilyRecipientIsWallet(
  _data: `0x${string}`,
  _recipientIsWallet: boolean,
): void {
  /* stub: no gate yet */
}

export type ClassifierHardness = "refuse" | "warn";

export interface ClassifierRule {
  /** 4-byte function selector, lowercase hex with 0x prefix. */
  selector: `0x${string}`;
  /** Canonical function signature, used in error messages and the warning annotation. */
  signature: string;
  /** Hard refuse blocks the call; soft warn surfaces an annotation but allows the call. */
  hardness: ClassifierHardness;
  /** Human-readable error / annotation message — explains what to do instead. */
  message: string;
}

/**
 * Selectors and signatures verified against viem's keccak — see the
 * test suite for bit-exact assertions.
 *
 * - `transfer(address,uint256)` 0xa9059cbb — ERC-20 transfer; bypasses
 *   `prepare_token_send`'s recipient-label resolution and contacts-tamper
 *   layer.
 * - `transferFrom(address,address,uint256)` 0x23b872dd — ERC-20 pull;
 *   wraps an existing allowance. Self-as-from is pull-style draining
 *   with no per-protocol equivalent (refused outright by the wiring
 *   layer); other-as-from is rare-but-legitimate (ack-bypassable).
 * - `safeTransferFrom(address,address,uint256)` 0x42842e0e and
 *   `safeTransferFrom(address,address,uint256,bytes)` 0xb88d4fde —
 *   ERC-721 transfer. Less commonly abused than ERC-20 since each
 *   tokenId is unique, but worth surfacing.
 * - `setApprovalForAll(address,bool)` 0xa22cb465 — ERC-721 operator
 *   approval. Known phishing vector ("collection-wide drain") but the
 *   legitimate marketplace-listing flow still uses it; warn rather
 *   than refuse. (Selector verified bit-exact against viem in the
 *   test suite — the archive plan's 0xa22cba26 was a typo.)
 */
export const CUSTOM_CALL_CLASSIFIER_RULES: readonly ClassifierRule[] = [
  {
    selector: "0xa9059cbb",
    signature: "transfer(address,uint256)",
    hardness: "refuse",
    message:
      "ERC-20 transfer via prepare_custom_call bypasses prepare_token_send's recipient " +
      "label resolution and contacts-tamper layer. Use prepare_token_send instead — it " +
      "looks up the recipient against the address book, surfaces a friendly label, and " +
      "applies the address-poisoning checks. If you genuinely need a raw transfer through " +
      "this escape hatch (e.g. testing a non-standard ERC-20 fork), retry with " +
      "`acknowledgeKnownExfilPattern: true`.",
  },
  {
    selector: "0x23b872dd",
    signature: "transferFrom(address,address,uint256)",
    hardness: "refuse",
    message:
      "ERC-20 transferFrom via prepare_custom_call is pull-style draining when the `from` " +
      "argument is your own wallet — a rogue agent or social-engineering attempt can use a " +
      "pre-existing approval to drain the wallet through this call. If you intend to spend " +
      "an existing allowance via a protocol contract, use the protocol-specific prepare_* " +
      "tool (Aave Pool, Uniswap Router, etc.) instead. The escape-hatch override " +
      "(`acknowledgeKnownExfilPattern: true`) is available only when `from` is NOT your " +
      "wallet — pulling someone else's allowance to yourself is rare-but-legitimate; " +
      "pulling your own wallet is refused outright.",
  },
  {
    selector: "0x42842e0e",
    signature: "safeTransferFrom(address,address,uint256)",
    hardness: "warn",
    message:
      "ERC-721 transfer detected — the on-device blind-sign hash is your only verification " +
      "anchor for the recipient and tokenId. Decode the calldata via the swiss-knife URL " +
      "before signing.",
  },
  {
    selector: "0xb88d4fde",
    signature: "safeTransferFrom(address,address,uint256,bytes)",
    hardness: "warn",
    message:
      "ERC-721 transfer with data detected — the trailing `bytes` arg can carry arbitrary " +
      "executable payload to the recipient's onERC721Received hook. Decode the calldata " +
      "via the swiss-knife URL before signing.",
  },
  {
    selector: "0xa22cb465",
    signature: "setApprovalForAll(address,bool)",
    hardness: "warn",
    message:
      "ERC-721 setApprovalForAll detected — when the second arg is `true`, ALL NFTs of " +
      "this collection become controllable by the operator. This is a well-known phishing " +
      "vector (`Blur`/`OpenSea`-shaped fake-listing drains). Verify the operator address " +
      "against your intended marketplace via the swiss-knife URL before signing.",
  },
];

/**
 * Classify the encoded calldata's 4-byte selector. Returns the matched
 * rule or null. Pure function — no I/O, no async.
 */
export function classifyCustomCallSelector(
  data: `0x${string}`,
): ClassifierRule | null {
  // Selector is 4 bytes = 8 hex chars + the leading "0x" = 10 chars
  // total. Anything shorter has no selector to classify.
  if (data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase() as `0x${string}`;
  return CUSTOM_CALL_CLASSIFIER_RULES.find((r) => r.selector === sel) ?? null;
}

export interface ClassifierVerdict {
  /** The matched rule, or null if no rule matched. */
  rule: ClassifierRule | null;
  /** Annotation text to attach to the decoded preview (warn case, or refuse-with-bypass). */
  annotation?: string;
}

/**
 * Apply the classifier verdict and either throw a refusal, return an
 * annotation for the warn case, or return null for unmatched
 * selectors. The caller decides what to do with the annotation.
 *
 * Bypass semantics:
 *   - `acknowledgeKnownExfilPattern: true` downgrades a "refuse" verdict
 *     to a warn-equivalent annotation (still surfaced, not blocked).
 *   - `transferFromSelfAsFrom: true` (computed by the caller from the
 *     decoded args) makes the `transferFrom` refusal NON-bypassable —
 *     pulling your own wallet via a pre-existing approval is an
 *     architectural mismatch with the user's intent, not a legitimate
 *     advanced flow.
 *   - `transferFromRecipientIsWallet` (computed by the caller from the
 *     decoded `to` arg, `args[1]`) gates the ack override for
 *     `transferFrom`: the rule's only legitimate ack case is pulling a
 *     pre-existing allowance TO YOUR OWN WALLET. When the recipient is
 *     any other address the pulled tokens never land back at the wallet
 *     — that is pure value-exfil, so the ack is NON-bypassable (issue
 *     #711). Recipient goes unchecked → deny-by-default (treated as not
 *     the wallet).
 */
export function applyCustomCallClassifier(
  data: `0x${string}`,
  ack: boolean | undefined,
  transferFromSelfAsFrom: boolean,
  transferFromRecipientIsWallet: boolean,
): ClassifierVerdict {
  const rule = classifyCustomCallSelector(data);
  if (!rule) return { rule: null };

  if (rule.hardness === "refuse") {
    const isTransferFrom = rule.selector === "0x23b872dd";
    if (isTransferFrom && transferFromSelfAsFrom) {
      throw new Error(
        `CUSTOM_CALL_REFUSED [${rule.signature}]: pulling your own wallet via ` +
          `transferFrom is value-exfil through a pre-existing approval and is NOT ` +
          `bypassable through this escape hatch. If you intend to move tokens from ` +
          `your own wallet, use prepare_token_send (no allowance required). If you're ` +
          `revoking an approval, use prepare_revoke_approval.`,
      );
    }
    if (isTransferFrom && !transferFromRecipientIsWallet) {
      throw new Error(
        `CUSTOM_CALL_REFUSED [${rule.signature}]: the transferFrom recipient (args[1]) ` +
          `is not your wallet — pulling an allowance to an arbitrary address is ` +
          `value-exfil and is NOT bypassable through this escape hatch. The ` +
          `\`acknowledgeKnownExfilPattern\` override applies only to the legitimate case ` +
          `it describes: pulling a pre-existing allowance TO YOUR OWN WALLET (to == your ` +
          `wallet). If you intended to send tokens to someone else, use prepare_token_send.`,
      );
    }
    if (ack !== true) {
      throw new Error(
        `CUSTOM_CALL_REFUSED [${rule.signature}]: ${rule.message}`,
      );
    }
    // Ack-bypassed: surface the rule's message as a warning annotation
    // so the verification block still shows the user what they're
    // overriding.
    return {
      rule,
      annotation: `[exfil-pattern bypassed via ack] ${rule.signature}: ${rule.message}`,
    };
  }

  // Warn case — attach annotation, don't throw.
  return {
    rule,
    annotation: `[warning] ${rule.signature}: ${rule.message}`,
  };
}
