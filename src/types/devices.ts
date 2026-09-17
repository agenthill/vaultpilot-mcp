/**
 * Cached Ledger pairing entry — what `pair_ledger_solana` populates and
 * `get_ledger_status` reads back. Persisted to ~/.vaultpilot-mcp/config.json
 * so a server restart doesn't force a re-pair (the address is deterministic
 * for a given device + path; the cache is just a hint, not a trust
 * boundary — `send_transaction` always re-derives from the live device
 * before signing).
 */
export interface PairedSolanaEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/501'/<n>'` layout. */
  accountIndex: number | null;
}

/** TRON pairing entry — same shape, different BIP-44 layout (`44'/195'/<n>'/0/0`). */
export interface PairedTronEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
  accountIndex: number | null;
}

/**
 * Bitcoin pairing entry. Bitcoin has 4 standard mainnet address types,
 * each on its own BIP-44 purpose (BIP-44 / BIP-49 / BIP-84 / BIP-86).
 *
 * Pre-#189 a single account index produced exactly 4 entries — one per
 * type, all on the receive chain at index 0. After gap-limit scanning
 * lands, an account index produces N entries per (type, chain) — every
 * used address plus the first unused on each chain, for both receive
 * (chain=0) and change (chain=1). The `chain` + `addressIndex` fields
 * disambiguate the path without re-parsing.
 *
 * Backwards compat: old cached entries (pre-#189) had only the
 * `<purpose>'/0'/<account>'/0/0` leaf. Hydrate-time backfill parses the
 * path so `chain`/`addressIndex` are always present after load.
 */
export interface PairedBitcoinEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /**
   * Discriminator for the four standard mainnet address shapes:
   *   - "legacy"      → BIP-44 P2PKH (`1...`)
   *   - "p2sh-segwit" → BIP-49 P2SH-wrapped segwit (`3...`)
   *   - "segwit"      → BIP-84 native segwit P2WPKH (`bc1q...`)
   *   - "taproot"     → BIP-86 P2TR (`bc1p...`)
   */
  addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
  /** Null when the path doesn't match the standard 5-segment layout. */
  accountIndex: number | null;
  /**
   * BIP-32 chain: 0 = external/receive, 1 = internal/change. Null when
   * the path doesn't match the standard 5-segment layout.
   */
  chain?: 0 | 1 | null;
  /** BIP-32 address index (final path segment). Null when non-standard. */
  addressIndex?: number | null;
  /**
   * Last known on-chain tx count from the indexer at scan time. Optional
   * + a snapshot — goes stale immediately after pairing but useful for
   * the agent to tell at-a-glance which addresses have history. Refresh
   * by calling `pair_ledger_btc` again, or `get_btc_account_balance`
   * for a live read.
   */
  txCount?: number;
}

/**
 * Cosigner entry inside a registered multi-sig wallet policy. Carries
 * the BIP-32 extended pubkey + master fingerprint + derivation path
 * Ledger's wallet-policy descriptor needs to identify each signer slot.
 *
 * `isOurs` flags which entry corresponds to the paired Ledger device —
 * exactly one entry has it `true` after `register_btc_multisig_wallet`
 * verifies the user's master fingerprint + derived xpub against the
 * cosigners list. Foreign cosigner entries (`isOurs: false`) carry only
 * public material and are NOT touched by this server beyond shaping the
 * descriptor; their xpubs come from out-of-band coordination (each
 * cosigner exports their xpub independently).
 */
export interface PairedBitcoinMultisigCosigner {
  /** BIP-32 extended public key (xpub/Ypub/Zpub form). */
  xpub: string;
  /** 4-byte master fingerprint as 8 lowercase hex chars (no `0x`). */
  masterFingerprint: string;
  /**
   * Derivation path leading to `xpub`, no leading `m/`. Standard BIP-48
   * P2WSH multisig: `48'/0'/<account>'/2'`. The `/<change>/<index>`
   * leaves are appended at signing time via the descriptor template's
   * `@N/**` wildcard.
   */
  derivationPath: string;
  /** True for exactly one entry — the one this Ledger can sign with. */
  isOurs: boolean;
}

/**
 * Registered multi-sig wallet policy (BIP-388 Ledger descriptor). Persisted
 * across server restarts; reused by every subsequent `sign_btc_multisig_psbt`
 * call against the same setup.
 *
 * `policyHmac` is the 32-byte HMAC the Ledger BTC app issues during
 * `registerWallet` and demands on every future `signPsbt(policy, hmac)`
 * call — it cryptographically anchors the on-device policy approval to
 * this server's stored copy. Without the HMAC the device re-prompts the
 * full policy verification flow on every signature; storing it means the
 * user only walks through xpub fingerprints once per setup.
 *
 * Phase 2 scope: `wsh(sortedmulti(M,@0/**,@1/**,...))` (P2WSH native
 * segwit). Taproot multi-sig (`tr(multi_a(...))`) and `sh-wsh` wrapped
 * multi-sig are deferred — small audience, distinct script types.
 */
export interface PairedBitcoinMultisigWallet {
  /** User-chosen label, ASCII, ≤ 16 bytes (Ledger device limit). Unique within `bitcoinMultisig[]`. */
  name: string;
  /** Threshold M in M-of-N. */
  threshold: number;
  /** Total signers N. */
  totalSigners: number;
  /** Script type — Phase 2 is "wsh" only. */
  scriptType: "wsh";
  /**
   * The Miniscript descriptor template registered with the device, e.g.
   * `wsh(sortedmulti(2,@0/**,@1/**,@2/**))`. Slot indices `@N` correspond
   * to entries in `cosigners` in registration order.
   */
  descriptor: string;
  /** Cosigners in slot order. Exactly one entry has `isOurs: true`. */
  cosigners: PairedBitcoinMultisigCosigner[];
  /** 32-byte HMAC from `app.registerWallet`, hex-encoded (no `0x`). */
  policyHmac: string;
  /** Bitcoin app version at registration time, for diagnostics. */
  appVersion: string;
}

/**
 * Litecoin pairing entry. Mirror of `PairedBitcoinEntry`. The 4
 * standard mainnet address types map to Litecoin's L/M/ltc1q/ltc1p
 * forms instead of BTC's 1/3/bc1q/bc1p.
 */
export interface PairedLitecoinEntry {
  address: string;
  publicKey: string;
  path: string;
  appVersion: string;
  /**
   * Discriminator for the four standard mainnet address shapes:
   *   - "legacy"      → BIP-44 P2PKH (`L...`)
   *   - "p2sh-segwit" → BIP-49 P2SH-wrapped segwit (`M...`)
   *   - "segwit"      → BIP-84 native segwit P2WPKH (`ltc1q...`)
   *   - "taproot"     → BIP-86 P2TR (`ltc1p...`) — derives correctly,
   *     but Litecoin Core has not activated Taproot on mainnet, so
   *     `ltc1p…` outputs are not yet spendable.
   */
  addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
  accountIndex: number | null;
  chain?: 0 | 1 | null;
  addressIndex?: number | null;
  txCount?: number;
}
