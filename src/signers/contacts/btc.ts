/**
 * BTC contacts signer — wraps the existing
 * `signBtcMessageOnLedger` (BIP-137) with the hardwired
 * `VaultPilot-contact-v1:` domain prefix. Refuses to sign any message
 * that doesn't carry the prefix; refuses taproot anchors (BIP-322 not
 * yet on Ledger BTC app).
 *
 * Anchor selection: the user's first paired non-taproot BTC address
 * with `chain === 0` becomes the anchor. We prefer segwit (lowest fees,
 * most modern format), then p2sh-segwit, then legacy. The selected
 * anchor's address is captured into the signed blob; verification on
 * read re-derives the anchor from the device and refuses if the
 * disk-resident anchor doesn't match.
 */
import {
  signBtcMessageOnLedger,
  getPairedBtcAddresses,
} from "../../signing/btc-usb-signer.js";
import type { PairedBitcoinEntry } from "../../types/index.js";
import { ContactsError } from "../../contacts/schemas.js";

/** Hardwired domain prefix — every contacts signing message MUST start with this. */
export const CONTACTS_DOMAIN_PREFIX_BTC = "VaultPilot-contact-v1:";

/** Result of selecting an anchor — exposed so callers can surface it in receipts. */
export interface BtcAnchor {
  address: string;
  path: string;
  publicKey: string;
  /** "segwit" | "p2sh-segwit" | "legacy" — taproot rejected upstream. */
  addressType: "segwit" | "p2sh-segwit" | "legacy";
  /** The Ledger app's `format` value, mapped for the SDK call. */
  addressFormat: "bech32" | "p2sh" | "legacy";
}

/**
 * Pick the anchor BTC entry from the pairings cache. Preference order:
 * segwit → p2sh-segwit → legacy. Taproot is silently skipped — the
 * caller can detect "no non-taproot pairing" and raise
 * CONTACTS_TAPROOT_UNSUPPORTED if they want to be specific about why
 * pairing didn't yield an anchor.
 *
 * Only chain=0 (receive) addresses with addressIndex=0 are eligible —
 * matches the natural anchor the user already inspects in
 * `get_ledger_status` as the first cached row per type.
 */
export function pickBtcAnchor(): BtcAnchor | null {
  const all = getPairedBtcAddresses();
  const eligible = all.filter(
    (e: PairedBitcoinEntry) =>
      e.accountIndex === 0 &&
      e.chain === 0 &&
      e.addressIndex === 0 &&
      e.addressType !== "taproot",
  );
  const formatMap: Record<BtcAnchor["addressType"], BtcAnchor["addressFormat"]> =
    { segwit: "bech32", "p2sh-segwit": "p2sh", legacy: "legacy" };
  // Preference: segwit > p2sh-segwit > legacy.
  const order = ["segwit", "p2sh-segwit", "legacy"] as const;
  for (const t of order) {
    const hit = eligible.find((e) => e.addressType === t);
    if (hit) {
      return {
        address: hit.address,
        path: hit.path,
        publicKey: hit.publicKey,
        addressType: t,
        addressFormat: formatMap[t],
      };
    }
  }
  return null;
}

/**
 * Sign the contacts blob preimage on the BTC anchor. The `preimage`
 * arg is the canonicalized JSON string from `canonicalize.ts`; we
 * prepend the hardwired domain prefix here. Throws
 * CONTACTS_LEDGER_NOT_PAIRED / CONTACTS_TAPROOT_UNSUPPORTED at the
 * call site when an anchor isn't available.
 */
export async function signContactsBlobBtc(args: {
  preimage: string;
  anchor: BtcAnchor;
}): Promise<{ signature: string }> {
  const message = `${CONTACTS_DOMAIN_PREFIX_BTC}${args.preimage}`;
  const messageHex = Buffer.from(message, "utf8").toString("hex");
  const out = await signBtcMessageOnLedger({
    expectedFrom: args.anchor.address,
    path: args.anchor.path,
    addressFormat: args.anchor.addressFormat,
    messageHex,
    addressType: args.anchor.addressType,
  });
  return { signature: out.signature };
}

/** Reports whether non-taproot BTC pairings are absent (only taproot). */
function onlyTaprootPaired(): boolean {
  const all = getPairedBtcAddresses();
  if (all.length === 0) return false;
  return all.every((e) => e.addressType === "taproot");
}

/** Throws a structured error mapping the missing-pair case. */
export function assertBtcAnchorAvailable(): BtcAnchor {
  const anchor = pickBtcAnchor();
  if (anchor) return anchor;
  if (onlyTaprootPaired()) {
    throw new Error(
      `${ContactsError.TaprootUnsupported}: only taproot BTC pairings exist. ` +
        `Taproot message-signing requires BIP-322, which the Ledger BTC app does not yet ` +
        `expose. Re-pair with \`pair_ledger_btc\` to register a non-taproot account, or ` +
        `wait for BIP-322 support.`,
    );
  }
  throw new Error(
    `${ContactsError.LedgerNotPaired}: no BTC pairing found. Run ` +
      `\`pair_ledger_btc\` first to register an anchor, then retry add_contact.`,
  );
}
