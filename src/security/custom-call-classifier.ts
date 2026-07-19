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

/**
 * Issue #741 — send-family recipient gate. A selector belongs here IFF its
 * ABI moves tokens/assets held or authorized by a THIRD PARTY (a
 * from/owner/sender param the ABI allows to differ from the wallet,
 * requiring a prior allowance/operator/approval) TO a recipient supplied as
 * a call parameter. Such a call is the structural sibling of ERC-20
 * `transferFrom` (#711/#727): the ack escape hatch is legitimate ONLY when
 * the pulled value lands back at the wallet, so the gate asserts
 * `recipient == wallet` and refuses anything else NON-bypassably (the ack
 * cannot launder a non-wallet recipient; a missing recipient arg is
 * deny-by-default — treated as not the wallet).
 *
 * `transferFrom(address,address,uint256)` 0x23b872dd is DELIBERATELY absent:
 * its selector collides with ERC-20/721 `transferFrom` and is already gated
 * by the #711/#727 branch in `applyCustomCallClassifier`. Double-handling
 * would fork one verdict across two code paths.
 *
 * Every member's recipient is arg index 1 (the `to`/`receiver` param),
 * verified selector-and-index-exact against viem —
 * scripts/verify-send-family-selectors.mjs and the bit-exact test block.
 *
 * COMPLETENESS: this set reflects ARCH's threat-model enumeration; other
 * third-party-source→recipient selectors may exist and are pending a
 * qualified security review (issue #741).
 */
export interface SendFamilyGateEntry {
  /** 4-byte function selector, lowercase hex with 0x prefix. */
  selector: `0x${string}`;
  /** Canonical function signature, surfaced in the refusal message. */
  signature: string;
  /** Index into the decoded args of the recipient (to/receiver) param. */
  recipientArgIndex: number;
}

export const SEND_FAMILY_RECIPIENT_GATE: readonly SendFamilyGateEntry[] = [
  {
    selector: "0x62ad1b83",
    signature: "operatorSend(address,address,uint256,bytes,bytes)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xd8fbe994",
    signature: "transferFromAndCall(address,address,uint256)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xc1d34b89",
    signature: "transferFromAndCall(address,address,uint256,bytes)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xb460af94",
    signature: "withdraw(uint256,address,address)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xba087652",
    signature: "redeem(uint256,address,address)",
    recipientArgIndex: 1,
  },
  {
    selector: "0x42842e0e",
    signature: "safeTransferFrom(address,address,uint256)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xb88d4fde",
    signature: "safeTransferFrom(address,address,uint256,bytes)",
    recipientArgIndex: 1,
  },
  {
    selector: "0xf242432a",
    signature: "safeTransferFrom(address,address,uint256,uint256,bytes)",
    recipientArgIndex: 1,
  },
  {
    selector: "0x2eb2c2d6",
    signature: "safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)",
    recipientArgIndex: 1,
  },
];

/**
 * Match the calldata's 4-byte selector against the send-family gate set.
 * Returns the matched entry or null. Pure function — no I/O, no async.
 */
export function matchSendFamilyGate(
  data: `0x${string}`,
): SendFamilyGateEntry | null {
  if (data.length < 10) return null;
  const sel = data.slice(0, 10).toLowerCase() as `0x${string}`;
  return SEND_FAMILY_RECIPIENT_GATE.find((e) => e.selector === sel) ?? null;
}

/**
 * Throw a NON-bypassable refusal when a send-family selector's recipient is
 * not the wallet. `recipientIsWallet` is computed by the caller from the
 * decoded recipient arg (deny-by-default when the arg is missing). Mirrors
 * the #727 `transferFrom` recipient block: the `acknowledgeKnownExfilPattern`
 * escape hatch cannot launder a non-wallet recipient. No-op for selectors
 * outside the gate set. Runs BEFORE `applyCustomCallClassifier`, which it
 * leaves untouched — strictly-additive defense-in-depth.
 */
export function assertSendFamilyRecipientIsWallet(
  data: `0x${string}`,
  recipientIsWallet: boolean,
): void {
  const entry = matchSendFamilyGate(data);
  if (!entry) return;
  if (recipientIsWallet) return;
  throw new Error(
    `CUSTOM_CALL_REFUSED [${entry.signature}]: the recipient (args[${entry.recipientArgIndex}]) ` +
      `is not your wallet. This selector moves a third party's pre-authorized tokens/assets ` +
      `(via a prior allowance/operator/approval), so sending them to an arbitrary address is ` +
      `value-exfil and is NOT bypassable through this escape hatch — the ` +
      `\`acknowledgeKnownExfilPattern\` override cannot launder it. The only legitimate case is ` +
      `pulling to YOUR OWN WALLET (recipient == your wallet). If you intended to send to ` +
      `someone else, use the protocol-specific prepare_* tool. (issue #741)`,
  );
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
