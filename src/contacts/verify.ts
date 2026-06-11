/**
 * Contacts blob signature verification. Two paths:
 *
 *   - BTC: BIP-137 — base64 65-byte sig (header || r || s); recover
 *     pubkey, derive address per the header-encoded format, compare to
 *     anchor address.
 *   - EVM: EIP-191 — viem's `verifyMessage`; address recovery already
 *     handled by the lib.
 *
 * Both paths consume the same canonical preimage built by
 * `canonicalize.buildSigningPreimage` and prepended with the
 * `VaultPilot-contact-v1:` domain prefix.
 */
import { createRequire } from "node:module";
import { secp256k1 } from "@noble/curves/secp256k1";
import { sha256 } from "@noble/hashes/sha256";
import { ripemd160 } from "@noble/hashes/ripemd160";
import { verifyMessage } from "viem";
import {
  CONTACTS_DOMAIN_PREFIX_BTC,
} from "../signers/contacts/btc.js";
import {
  CONTACTS_DOMAIN_PREFIX_EVM,
} from "../signers/contacts/evm.js";
import { canonicalize, buildSigningPreimage } from "./canonicalize.js";
import type { ChainBlob } from "./schemas.js";

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  address: { toBech32(data: Buffer, version: number, prefix: string): string };
  payments: {
    p2pkh(opts: { pubkey: Buffer }): { address?: string };
    p2sh(opts: { redeem: { output: Buffer } }): { address?: string };
    p2wpkh(opts: { pubkey: Buffer }): { address?: string; output?: Buffer };
  };
};

/**
 * Build the message that was signed. Same shape on both chains —
 * domain prefix concatenated with the canonical JSON preimage.
 */
function buildMessage(blob: ChainBlob, chainTag: "btc" | "evm"): string {
  const preimage = canonicalize(
    buildSigningPreimage({
      chainId: chainTag,
      version: blob.version,
      anchorAddress: blob.anchorAddress,
      signedAt: blob.signedAt,
      entries: blob.entries,
    }),
  );
  const prefix =
    chainTag === "btc" ? CONTACTS_DOMAIN_PREFIX_BTC : CONTACTS_DOMAIN_PREFIX_EVM;
  return `${prefix}${preimage}`;
}

// ---------- BIP-137 (BTC) verification ----------

/** Bitcoin Signed Message double-sha256 hash. */
function bip137MessageHash(message: string): Uint8Array {
  const magic = "Bitcoin Signed Message:\n";
  const messageBytes = Buffer.from(message, "utf8");
  // varint(len(message))
  const len = messageBytes.length;
  let lenBytes: Buffer;
  if (len < 0xfd) {
    lenBytes = Buffer.from([len]);
  } else if (len <= 0xffff) {
    lenBytes = Buffer.alloc(3);
    lenBytes[0] = 0xfd;
    lenBytes.writeUInt16LE(len, 1);
  } else {
    lenBytes = Buffer.alloc(5);
    lenBytes[0] = 0xfe;
    lenBytes.writeUInt32LE(len, 1);
  }
  const concat = Buffer.concat([
    Buffer.from(magic, "utf8"),
    lenBytes,
    messageBytes,
  ]);
  return sha256(sha256(concat));
}

/** hash160 = ripemd160(sha256(x)). */
function hash160(buf: Uint8Array): Uint8Array {
  return ripemd160(sha256(buf));
}

/**
 * Decode a BIP-137 base64 signature into its components. The header
 * byte encodes `addressType + recid`:
 *   31..34 (= 27 + 4 + recid) — legacy P2PKH compressed
 *   35..38                   — P2SH-wrapped segwit (BIP-137 ext)
 *   39..42                   — native segwit P2WPKH (BIP-137 ext)
 */
function decodeBip137(signature: string): {
  recid: 0 | 1;
  addressType: "legacy" | "p2sh-segwit" | "segwit";
  r: Uint8Array;
  s: Uint8Array;
} | null {
  let buf: Buffer;
  try {
    buf = Buffer.from(signature, "base64");
  } catch {
    return null;
  }
  if (buf.length !== 65) return null;
  const header = buf[0];
  let addressType: "legacy" | "p2sh-segwit" | "segwit";
  if (header >= 31 && header <= 34) addressType = "legacy";
  else if (header >= 35 && header <= 38) addressType = "p2sh-segwit";
  else if (header >= 39 && header <= 42) addressType = "segwit";
  else return null;
  const baseByType = { legacy: 31, "p2sh-segwit": 35, segwit: 39 } as const;
  const base = baseByType[addressType];
  const recid = ((header - base) & 1) as 0 | 1;
  return {
    recid,
    addressType,
    r: buf.subarray(1, 33),
    s: buf.subarray(33, 65),
  };
}

/**
 * Recover the compressed pubkey from a BIP-137 signature + message.
 * Returns null on any decode/recover failure.
 */
function recoverCompressedPubkey(args: {
  message: string;
  signature: string;
}): { pubkey: Buffer; addressType: "legacy" | "p2sh-segwit" | "segwit" } | null {
  const decoded = decodeBip137(args.signature);
  if (!decoded) return null;
  const msgHash = bip137MessageHash(args.message);
  // Build the @noble/curves Signature from the raw r/s + recid.
  // `Signature.fromCompact(r||s)` parses 64-byte form; then
  // `addRecoveryBit(recid)` makes it recoverable.
  const compact = Buffer.concat([
    Buffer.from(decoded.r),
    Buffer.from(decoded.s),
  ]);
  let sig;
  try {
    sig = secp256k1.Signature.fromCompact(compact).addRecoveryBit(decoded.recid);
  } catch {
    return null;
  }
  let pub;
  try {
    pub = sig.recoverPublicKey(msgHash);
  } catch {
    return null;
  }
  const compressed = Buffer.from(pub.toRawBytes(true));
  return { pubkey: compressed, addressType: decoded.addressType };
}

/**
 * Derive the canonical mainnet BTC address for a compressed pubkey at
 * the given format. `p2sh-segwit` produces an `M`-prefix... wait, no,
 * BTC uses `3` prefix. Modern addresses for non-taproot:
 *   - legacy: P2PKH (`1...`)
 *   - p2sh-segwit: P2SH(P2WPKH) (`3...`)
 *   - segwit: P2WPKH (`bc1q...`)
 */
function deriveBtcAddress(
  pubkey: Buffer,
  addressType: "legacy" | "p2sh-segwit" | "segwit",
): string | null {
  try {
    if (addressType === "legacy") {
      const p = bitcoinjs.payments.p2pkh({ pubkey });
      return p.address ?? null;
    }
    if (addressType === "segwit") {
      const p = bitcoinjs.payments.p2wpkh({ pubkey });
      return p.address ?? null;
    }
    // p2sh-segwit = P2SH(P2WPKH)
    const witness = bitcoinjs.payments.p2wpkh({ pubkey });
    if (!witness.output) return null;
    const p = bitcoinjs.payments.p2sh({ redeem: { output: witness.output } });
    return p.address ?? null;
  } catch {
    return null;
  }
}

/**
 * Verify a BTC contacts blob's signature. Returns true iff the
 * signature is valid AND the derived address matches `blob.anchorAddress`.
 */
export function verifyBtcBlob(blob: ChainBlob): boolean {
  const message = buildMessage(blob, "btc");
  const recovered = recoverCompressedPubkey({
    message,
    signature: blob.signature,
  });
  if (!recovered) return false;
  // The header byte encodes the address type — but we ALSO have
  // `blob.anchorAddressType` in storage. They must agree, otherwise
  // a sig was reused across types.
  if (blob.anchorAddressType && blob.anchorAddressType !== recovered.addressType) {
    return false;
  }
  const derived = deriveBtcAddress(recovered.pubkey, recovered.addressType);
  if (!derived) return false;
  return derived === blob.anchorAddress;
}

// ---------- EIP-191 (EVM) verification ----------

/**
 * Verify an EVM contacts blob's signature. Wraps viem's
 * `verifyMessage` — already handles the keccak256 + EIP-191 prefix
 * + signature recovery internally.
 */
export async function verifyEvmBlob(blob: ChainBlob): Promise<boolean> {
  const message = buildMessage(blob, "evm");
  try {
    return await verifyMessage({
      address: blob.anchorAddress as `0x${string}`,
      message,
      signature: blob.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

// Hardcoded re-export so consumers can build the message preimage
// without re-importing the canonicalize helpers piecemeal.
export { buildMessage as buildContactsSigningMessage };
