import qrcodeTerminal from "qrcode-terminal";
import { initiatePairing } from "../../signing/walletconnect.js";
import { getDeviceStateHint } from "../diagnostics/ledger-device-info.js";
import {
  getTronLedgerAddress,
  setPairedTronAddress,
  tronPathForAccountIndex,
} from "../../signing/tron-usb-signer.js";
import {
  getSolanaLedgerAddress,
  setPairedSolanaAddress,
  solanaPathForAccountIndex,
} from "../../signing/solana-usb-signer.js";
import type {
  PairLedgerTronArgs,
  PairLedgerSolanaArgs,
  PairLedgerBitcoinArgs,
  PairLedgerLitecoinArgs,
} from "../execution/schemas.js";

/** Render a QR code as an ASCII string (returns promise with the string). */
function qrString(uri: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(uri, { small: true }, (qr: string) => resolve(qr));
  });
}

export async function pairLedgerLive(): Promise<{
  uri: string;
  qr: string;
  instructions: string;
  waitingForApproval: true;
}> {
  const { uri, approval } = await initiatePairing();
  const qr = await qrString(uri);
  // Fire-and-forget: once approval resolves, the session is persisted automatically.
  approval.catch(() => {
    // WalletConnect will surface any error on the next call.
  });
  // If this is a re-pair (prior session exists on disk), surface the
  // cached peer version so the generated instructions lead with the UI
  // path that matched last time. Fresh first-ever pairs have no cached
  // session → version is undefined → instructions fall back to listing
  // both common UI paths.
  const { getCurrentSession } = await import("../../signing/walletconnect.js");
  const { parseLedgerLiveVersion, ledgerLivePairingInstructions } = await import(
    "../../signing/session.js"
  );
  const cached = getCurrentSession();
  const cachedVersion = parseLedgerLiveVersion(cached?.peer?.metadata);
  return {
    uri,
    qr,
    instructions:
      ledgerLivePairingInstructions(cachedVersion) +
      " VERIFY BEFORE FIRST USE: once pairing completes, the EVM addresses " +
      "Ledger Live shares are exposed via `get_ledger_status`. Before any " +
      "`prepare_*` uses one of those addresses, surface its FULL string (no " +
      "truncation) and have the user cross-check it against (a) Ledger Live " +
      "→ Settings → Connected Apps (the WC session entry shows the shared " +
      "accounts), and (b) the on-device 'Display address' screen for the " +
      "matching account in the Ethereum / chain-specific app. " +
      "On any mismatch, abort — a compromised middle layer may have " +
      "substituted addresses.",
    waitingForApproval: true,
  };
}

/**
 * Pair the host's directly-connected Ledger device for TRON signing. Unlike
 * `pair_ledger_live` (WalletConnect relay for EVM), TRON signs over USB HID —
 * the Ledger must be plugged into the host running this MCP, unlocked, with
 * the TRON app open. Reads + caches the device address at the BIP-44 path
 * derived from `accountIndex` (default 0 = first Ledger Live TRON account)
 * so subsequent `get_ledger_status` calls can report it without re-probing.
 * Call with different `accountIndex` values to expose multiple TRON accounts.
 */
export async function pairLedgerTron(args: PairLedgerTronArgs = {}): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = tronPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getTronLedgerAddress(path);
  } catch (e) {
    // Enrich the error with device-state probe data (which app is open
    // RIGHT NOW). The probe runs only on the failure path so successful
    // pairs don't pay the extra USB round-trip. If the probe itself
    // fails — likely because the same USB-HID resource is still busy —
    // we silently fall through to the original error message.
    const hint = await getDeviceStateHint("Tron");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedTronAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "TRON account paired. You can now call `prepare_tron_*` with this address and " +
      "forward the handle via `send_transaction`. Keep the Ledger plugged in with the " +
      "TRON app open — each sign re-opens USB and re-verifies the device address. " +
      "To pair a different slot, call `pair_ledger_tron` again with another `accountIndex`. " +
      "VERIFY BEFORE FIRST USE: surface this FULL address (no truncation) and have " +
      "the user verify it character-by-character against the device's 'Receive' / " +
      "'Show address' screen on the TRON app. On any mismatch, abort — a " +
      "compromised middle layer may have substituted the address.",
  };
}

/**
 * Pair the host's directly-connected Ledger device for Solana signing.
 * Unlike `pair_ledger_live` (WalletConnect relay for EVM), Solana signs
 * over USB HID because Ledger Live's WalletConnect integration does not
 * expose Solana accounts (confirmed 2026-04-23). The Ledger must be
 * plugged in, unlocked, with the Solana app open. Reads + caches the
 * device address at path `44'/501'/<accountIndex>'` (default 0 = first
 * Ledger Live Solana account).
 */
/**
 * Pair the host's directly-connected Ledger device for Bitcoin signing.
 * Same USB-HID rationale as `pair_ledger_solana` and `pair_ledger_tron`:
 * Ledger Live's WalletConnect relay does not expose `bip122` accounts
 * to dApps, so Bitcoin signing happens over USB HID. The Ledger must be
 * plugged in, unlocked, with the Bitcoin app open.
 *
 * One call enumerates ALL FOUR address types (legacy / p2sh-segwit /
 * segwit / taproot) for the given account index — the user sees their
 * full footprint per Ledger Live Bitcoin account in a single round-trip.
 * Each derivation is just `getWalletPublicKey` (read-only); no on-device
 * confirmation is requested by default. Subsequent calls with different
 * `accountIndex` values expose more accounts.
 */
export async function pairLedgerBitcoin(args: PairLedgerBitcoinArgs = {}): Promise<{
  accountIndex: number;
  gapLimit: number;
  appVersion: string;
  addresses: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    address: string;
    path: string;
    chain: 0 | 1;
    addressIndex: number;
    txCount: number;
  }>;
  summary: {
    totalDerived: number;
    used: number;
    unused: number;
  };
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const {
    scanBtcAccount,
    setPairedBtcAddress,
    clearPairedBtcAccount,
    DEFAULT_BTC_GAP_LIMIT,
  } = await import("../../signing/btc-usb-signer.js");
  const gapLimit = args.gapLimit ?? DEFAULT_BTC_GAP_LIMIT;

  // The indexer's getBalance() returns txCount alongside the balance —
  // reuse it as the gap-limit probe so we don't add a second HTTP API
  // surface. One round trip per derived address.
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const indexer = getBitcoinIndexer();
  const fetchTxCount = async (addr: string): Promise<number> => {
    const bal = await indexer.getBalance(addr);
    return bal.txCount;
  };

  let derived;
  try {
    derived = await scanBtcAccount({
      accountIndex,
      gapLimit,
      fetchTxCount,
    });
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron / pairLedgerSolana —
    // probe which app is currently open so the agent can tell the user
    // to switch to Bitcoin.
    const hint = await getDeviceStateHint("Bitcoin");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  // Drop any stale entries for this accountIndex BEFORE persisting the
  // fresh scan — protects against the case where a prior scan walked
  // further than this one (e.g. funds moved out, gap window now stops
  // earlier) and would otherwise leave dangling cached paths.
  clearPairedBtcAccount(accountIndex);
  for (const entry of derived.entries) {
    setPairedBtcAddress({
      address: entry.address,
      publicKey: entry.publicKey,
      path: entry.path,
      appVersion: entry.appVersion,
      addressType: entry.addressType,
      accountIndex: entry.accountIndex,
      chain: entry.chain,
      addressIndex: entry.addressIndex,
      txCount: entry.txCount,
    });
  }
  const used = derived.entries.filter((e) => e.txCount > 0).length;
  return {
    accountIndex,
    gapLimit,
    appVersion: derived.appVersion,
    addresses: derived.entries.map((e) => ({
      addressType: e.addressType,
      address: e.address,
      path: e.path,
      chain: e.chain,
      addressIndex: e.addressIndex,
      txCount: e.txCount,
    })),
    summary: {
      totalDerived: derived.entries.length,
      used,
      unused: derived.entries.length - used,
    },
    instructions:
      "Bitcoin account paired with BIP44 gap-limit scanning. Both the receive " +
      "(/0/i) and change (/1/i) chains were walked across all four address types " +
      "until " +
      gapLimit +
      " consecutive empty addresses were observed. Every address with on-chain " +
      "history is cached, plus the next fresh receive address per chain. Use " +
      "`get_btc_account_balance({ accountIndex })` to sum across the cached set " +
      "for this account, or `get_btc_balance` against any single cached address. " +
      "Re-run `pair_ledger_btc` to refresh the cache; previously-cached entries " +
      "for this accountIndex are dropped before the new scan persists. " +
      "VERIFY BEFORE FIRST USE: before any `prepare_btc_*_send` or " +
      "`send_transaction` uses one of these addresses, surface its FULL string " +
      "(no truncation) and have the user verify it character-by-character against " +
      "the device's 'Display address' screen (Bitcoin app → Display address → " +
      "select the matching BIP path). On any mismatch, abort — a compromised " +
      "middle layer may have substituted addresses.",
  };
}

export async function pairLedgerSolana(
  args: PairLedgerSolanaArgs = {},
): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = solanaPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getSolanaLedgerAddress(path);
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron — see comment there.
    const hint = await getDeviceStateHint("Solana");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedSolanaAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "Solana account paired. You can now call `prepare_solana_native_send` / " +
      "`prepare_solana_spl_send` with this address and forward the handle via " +
      "`send_transaction`. Keep the Ledger plugged in with the Solana app open " +
      "— each sign re-opens USB and re-verifies the device address. Native SOL " +
      "sends clear-sign (amount + recipient shown on-device). SPL token sends " +
      "BLIND-SIGN — the Ledger Solana app requires a signed Trusted-Name " +
      "descriptor that only Ledger Live supplies, so the device shows a " +
      "'Message Hash' instead of decoded fields. For SPL: (1) enable 'Allow " +
      "blind signing' in Solana app → Settings, (2) match the Message Hash " +
      "surfaced in the preview against the on-device value. To pair another " +
      "slot, call `pair_ledger_solana` again with a different `accountIndex`. " +
      "VERIFY BEFORE FIRST USE: surface this FULL address (no truncation) " +
      "and have the user verify it character-by-character against the " +
      "device's 'Public Key' / 'Show address' screen on the Solana app. " +
      "On any mismatch, abort — a compromised middle layer may have " +
      "substituted the address.",
  };
}

export async function pairLedgerLitecoin(
  args: PairLedgerLitecoinArgs = {},
): Promise<{
  accountIndex: number;
  gapLimit: number;
  appVersion: string;
  addresses: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    address: string;
    path: string;
    chain: 0 | 1;
    addressIndex: number;
    txCount: number;
  }>;
  skipped: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    reason: string;
  }>;
  summary: { totalDerived: number; used: number; unused: number };
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const {
    scanLtcAccount,
    setPairedLtcAddress,
    clearPairedLtcAccount,
    DEFAULT_LTC_GAP_LIMIT,
  } = await import("../../signing/ltc-usb-signer.js");
  const gapLimit = args.gapLimit ?? DEFAULT_LTC_GAP_LIMIT;

  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  const indexer = getLitecoinIndexer();
  const fetchTxCount = async (addr: string): Promise<number> => {
    const bal = await indexer.getBalance(addr);
    return bal.txCount;
  };

  let derived;
  try {
    derived = await scanLtcAccount({
      accountIndex,
      gapLimit,
      fetchTxCount,
    });
  } catch (e) {
    const hint = await getDeviceStateHint("Litecoin");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  // Issue #231: scanLtcAccount is per-type fault-tolerant — a single
  // type's failure (e.g. taproot's bech32m on the current Ledger LTC
  // app) records into `skipped` rather than aborting. If EVERY type
  // failed, treat that as a real pairing failure: don't drop the
  // existing cache and don't claim success.
  if (derived.entries.length === 0) {
    const reasons = derived.skipped
      .map((s) => `${s.addressType}: ${s.reason}`)
      .join("; ");
    throw new Error(
      `pair_ledger_ltc: every address-type walk failed. ${reasons || "no per-type errors recorded"}`,
    );
  }
  clearPairedLtcAccount(accountIndex);
  for (const entry of derived.entries) {
    setPairedLtcAddress({
      address: entry.address,
      publicKey: entry.publicKey,
      path: entry.path,
      appVersion: entry.appVersion,
      addressType: entry.addressType,
      accountIndex: entry.accountIndex,
      chain: entry.chain,
      addressIndex: entry.addressIndex,
      txCount: entry.txCount,
    });
  }
  const used = derived.entries.filter((e) => e.txCount > 0).length;
  const succeededTypes = new Set(derived.entries.map((e) => e.addressType)).size;
  const totalTypes = succeededTypes + derived.skipped.length;
  const skippedNote = derived.skipped.length
    ? ` Skipped ${derived.skipped.length}/${totalTypes} address types (${derived.skipped.map((s) => s.addressType).join(", ")}) — see \`skipped[]\` for per-type reasons. Common case: the Ledger Litecoin app does not support bech32m, so taproot (\`ltc1p…\`) derivation throws "Unsupported address format bech32m". Litecoin Core has not activated Taproot on mainnet anyway, so taproot pairing is effectively forward-compat only.`
    : "";
  return {
    accountIndex,
    gapLimit,
    appVersion: derived.appVersion,
    addresses: derived.entries.map((e) => ({
      addressType: e.addressType,
      address: e.address,
      path: e.path,
      chain: e.chain,
      addressIndex: e.addressIndex,
      txCount: e.txCount,
    })),
    skipped: derived.skipped,
    summary: {
      totalDerived: derived.entries.length,
      used,
      unused: derived.entries.length - used,
    },
    instructions:
      "Litecoin account paired with BIP44 gap-limit scanning. Both the receive " +
      "(/0/i) and change (/1/i) chains were walked across all four address types " +
      "until " +
      gapLimit +
      " consecutive empty addresses were observed. Use `get_ltc_balance` against " +
      "any cached address. Re-run `pair_ledger_ltc` to refresh; previously-cached " +
      "entries for this accountIndex are dropped before the new scan persists. " +
      "VERIFY BEFORE FIRST USE: before any `prepare_litecoin_*_send` or " +
      "`send_transaction` uses one of these addresses, surface its FULL string " +
      "(no truncation) and have the user verify it character-by-character " +
      "against the device's 'Display address' screen (Litecoin app → Display " +
      "address → select the matching BIP path). On any mismatch, abort — a " +
      "compromised middle layer may have substituted addresses." +
      skippedNote,
  };
}
