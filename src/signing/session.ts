import {
  getConnectedAccountsDetailed,
  getCurrentSession,
  getLastPairingError,
  getSignClient,
  isPeerUnreachable,
  type PairingError,
} from "./walletconnect.js";
import { getPairedTronAddresses } from "./tron-usb-signer.js";
import { getPairedSolanaAddresses } from "./solana-usb-signer.js";
import { getPairedBtcAddresses } from "./btc-usb-signer.js";
import { getPairedLtcAddresses } from "./ltc-usb-signer.js";
import type { SupportedChain } from "../types/index.js";

export interface SessionAccount {
  address: `0x${string}`;
  /** Supported chains this address is exposed on (mapped from chainIds). */
  chains: SupportedChain[];
  /** Every eip155 chainId advertised for this address, including ones the server does not support. */
  chainIds: number[];
}

export interface SessionStatus {
  paired: boolean;
  /**
   * Deduplicated list of addresses. An address that appears on multiple chains
   * shows up once here; use `accountDetails` for the per-chain breakdown.
   */
  accounts: `0x${string}`[];
  /** Per-address chain exposure — addresses paired with the networks they're advertised on. */
  accountDetails: SessionAccount[];
  topic?: string;
  expiresAt?: number;
  /** Peer-advertised app name (e.g. "Ledger Live"). Self-reported — NOT a trusted identity. */
  wallet?: string;
  /** Peer-advertised URL. Self-reported — NOT a trusted identity. */
  peerUrl?: string;
  /** Peer-advertised description. Self-reported — NOT a trusted identity. */
  peerDescription?: string;
  /**
   * Best-effort version string parsed from peer metadata (e.g. "2.80.0").
   * Self-reported by the peer just like `wallet` / `peerUrl` — not trusted
   * for any security decision, only used to tailor pairing instructions
   * for re-pair flows. Absent when no semver token could be found.
   */
  peerVersion?: string;
  /**
   * Tailored pairing instructions — emitted only when the session is
   * unreachable (re-pair likely needed) or unpaired. The string covers
   * both common Ledger Live UI paths (Discover vs Settings → Connected
   * Apps) so it works across 2.x branches; `peerVersion` adds a "try this
   * first" hint when available. Absent on healthy paired sessions.
   */
  pairingInstructions?: string;
  /**
   * Only set when the paired peer's URL host is NOT on the Ledger-first-party
   * allowlist (see `isKnownLedgerPeer`). The common case — pairing with Ledger
   * Live, which advertises a `ledger.com` host — produces no warning, so the
   * agent has nothing to surface. An unknown host flips this on and the agent
   * is expected to ask the user to confirm the peer before sending.
   *
   * NOT emitted on unpaired sessions either: there's no peer to warn about.
   */
  peerTrustWarning?: string;
  /**
   * Set when a local session record exists but the peer did not respond to the
   * liveness ping on restore. The session may still be valid (peer just
   * offline) or dead (relay didn't deliver a rejection in time) — callers
   * should treat it as unverified and avoid submitting transactions until the
   * peer comes back online or the user re-pairs.
   */
  peerUnreachable?: boolean;
  /**
   * Actionable guidance for the agent, populated only when `peerUnreachable`
   * is true. The cached `accounts` / `accountDetails` are still usable for
   * address resolution (e.g. "my first wallet" → 0x…) but any signing
   * attempt will hang on the unresponsive relay, so the agent should
   * proactively prompt the user to re-pair before proceeding to a
   * prepare_* / send flow. Kept as a string rather than a boolean so the
   * exact call-to-action lives alongside the flag and the agent can splice
   * it verbatim into its reply.
   */
  peerUnreachableGuidance?: string;
  /**
   * Populated when the most recent WalletConnect pairing attempt's
   * settle-capture promise REJECTED (issue #687). Distinguishes a genuine
   * terminal pairing failure (the relay never delivered the settled session,
   * an invalid projectId, an on-device rejection) from a fresh never-paired
   * state — both otherwise present as `paired: false`. The pairing tool
   * returns `waitingForApproval: true` and then goes fire-and-forget, so
   * without this field a rejected settle leaves `get_ledger_status`
   * indefinitely reporting an unpaired state that looks like the user simply
   * hasn't paired yet. When present, surface the error and offer a re-pair.
   * Cleared once a session is successfully adopted (promise or the durable
   * `session_connect` event).
   */
  lastPairingError?: PairingError;
  /**
   * Actionable guidance, populated only alongside `lastPairingError`. Kept as
   * a string next to the flag so the agent can splice it verbatim.
   */
  lastPairingErrorGuidance?: string;
  /**
   * Present when the user has run `pair_ledger_tron` at least once. TRON
   * doesn't share WalletConnect with EVM — signing goes over USB HID — so
   * this section is independent of the `paired`/`accounts` fields above
   * (which describe the WC session for EVM chains only). An array because
   * users can pair multiple account slots (index 0, 1, …) in the same
   * session; entries are ordered by `accountIndex`. Absent/empty means the
   * agent should ask the user to run `pair_ledger_tron` before preparing a
   * TRON tx.
   */
  tron?: Array<{
    address: string;
    path: string;
    appVersion: string;
    /** Null when the path is not in the standard `44'/195'/<n>'/0/0` layout. */
    accountIndex: number | null;
  }>;
  /**
   * Solana pairings — parallel to the TRON section above. Populated once
   * the user has run `pair_ledger_solana` (USB HID — Ledger Live does NOT
   * expose Solana accounts over WalletConnect). Ordered by `accountIndex`.
   * Absent/empty → agent should call `pair_ledger_solana` before preparing
   * any `prepare_solana_*` tx.
   */
  solana?: Array<{
    address: string;
    path: string;
    appVersion: string;
    /** Null when the path is not in the standard `44'/501'/<n>'` layout. */
    accountIndex: number | null;
  }>;
  /**
   * Bitcoin pairings — typically four entries per accountIndex, one per
   * address type (legacy / p2sh-segwit / segwit / taproot). Same
   * USB-HID rationale as Solana / TRON: Ledger Live's WalletConnect
   * relay doesn't expose `bip122`. Ordered by accountIndex then by
   * address-type purpose. Absent/empty → agent should call
   * `pair_ledger_btc` before any Bitcoin tool.
   */
  bitcoin?: Array<{
    address: string;
    path: string;
    appVersion: string;
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    /** Null when the path doesn't match the standard 5-segment layout. */
    accountIndex: number | null;
    /** BIP-32 chain: 0 = receive, 1 = change. Null for non-standard paths. */
    chain?: 0 | 1 | null;
    /** BIP-32 address index. Null for non-standard paths. */
    addressIndex?: number | null;
    /** Tx count from the indexer at last pair_ledger_btc scan. Snapshot only. */
    txCount?: number;
  }>;
  /**
   * Paired Litecoin addresses, mirror of `bitcoin` above. Same USB-HID
   * pairing flow, same shape, BIP-44 coin_type 2.
   */
  litecoin?: Array<{
    address: string;
    path: string;
    appVersion: string;
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    accountIndex: number | null;
    chain?: 0 | 1 | null;
    addressIndex?: number | null;
    txCount?: number;
  }>;
}

export const PEER_TRUST_WARNING =
  "WalletConnect peer metadata is self-reported — any app can claim to be 'Ledger Live'. " +
  "The paired wallet/URL above is NOT on the Ledger-first-party allowlist; ask the user " +
  "to confirm before calling send_transaction. The ultimate check is that the tx shows up on the " +
  "user's physical Ledger device for on-screen approval.";

export const LAST_PAIRING_ERROR_GUIDANCE =
  "The most recent WalletConnect pairing attempt failed AFTER the URI/QR was shown — " +
  "Ledger Live's approval never reached this server (relay dropped the settled session, " +
  "an invalid WalletConnect projectId, or the pairing was rejected on-device). This is a " +
  "terminal failure, not a still-pending pairing: no NEW session was persisted by that " +
  "attempt (any existing session is unaffected — this can surface on a failed re-pair " +
  "over a still-live session, not only when unpaired). " +
  "Tell the user that attempt's pairing did not complete and offer to retry via `pair_ledger_live`. " +
  "If it keeps failing, check that WALLETCONNECT_PROJECT_ID is set to a valid Cloud project.";

export const PEER_UNREACHABLE_GUIDANCE =
  "WalletConnect session is cached locally but the relay couldn't confirm Ledger Live is currently connected. " +
  "Cached addresses below are fine for referring to the user's wallet(s) — keep using them for balance/history/portfolio queries — " +
  "but any signing flow (prepare_* → send_transaction) will hang on the unresponsive peer. " +
  "Before the next signing operation, ASK the user: 'WalletConnect looks disconnected. Want me to re-pair Ledger Live now via pair_ledger_live?' " +
  "Only call pair_ledger_live on explicit confirmation. Do NOT auto-re-pair on read-only requests.";

/**
 * Best-effort Ledger Live version extraction from WalletConnect peer
 * metadata. The peer's `name`, `description`, and `url` fields are self-
 * reported and the shape varies across Ledger Live releases — sometimes the
 * version lands in `name` ("Ledger Live 2.80.0"), sometimes only in
 * `description`, sometimes absent entirely. We look for the first
 * semver-shaped token across all three fields; any match is returned
 * verbatim. Returns `undefined` when nothing looks like a version.
 *
 * This is intentionally a UX hint, not load-bearing: mismatched or
 * missing versions never affect signing — they only tailor the pairing
 * instructions we emit for re-pair flows.
 */
export function parseLedgerLiveVersion(meta: {
  name?: string;
  description?: string;
  url?: string;
} | undefined): string | undefined {
  if (!meta) return undefined;
  const haystack = [meta.name, meta.description, meta.url]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join(" ");
  // Lookbehind/ahead for "not a digit and not a dot" so we don't start the
  // match mid-version (e.g. "v2.90.1" → "2.90.1", not "90.1") and don't
  // truncate the middle-component of a three-part semver. `\b` alone was
  // insufficient because `\b` sees `v` as a word char adjacent to `2`.
  const match = haystack.match(/(?<![\d.])(\d+\.\d+(?:\.\d+)?)(?![\d.])/);
  return match ? match[1] : undefined;
}

/**
 * Produce a tailored pairing-instructions string for Ledger Live's
 * WalletConnect flow. The WC entry point moved around across Ledger Live
 * 2.x branches — older builds surfaced it under **Discover**, newer builds
 * under **Settings → Connected Apps** (sometimes nested further). Rather
 * than hard-code a single path (which rots with every Ledger Live release),
 * we emit BOTH common paths and, when we have a detected version, add a
 * best-effort "try this first" nudge. Unknown version → no nudge, both
 * paths listed so the user can find whichever applies.
 *
 * Exported so `pair_ledger_live` and `get_ledger_status` share the same
 * copy — otherwise the two surfaces would drift.
 */
export function ledgerLivePairingInstructions(
  detectedVersion: string | undefined,
): string {
  const lead = detectedVersion
    ? `Detected Ledger Live ${detectedVersion} on your last pairing. `
    : "";
  return (
    `${lead}Open Ledger Live, find the WalletConnect entry, and paste the URI ` +
    `(or scan the QR) to pair. The entry point moved across Ledger Live 2.x ` +
    `branches — try these in order: ` +
    `(1) Discover → WalletConnect (older builds), ` +
    `(2) Settings → Connected Apps → WalletConnect (newer builds), ` +
    `(3) search "WalletConnect" in Ledger Live's search bar. ` +
    `Once pairing completes, the session is persisted and this server can ` +
    `reuse it across tool calls without re-pairing.`
  );
}

/**
 * Hosts the server treats as first-party Ledger WC peers. Exact match or any
 * subdomain of `ledger.com` (so `wc.apps.ledger.com`, `ledger.com`, etc. all
 * pass). Everything else trips `peerTrustWarning`.
 */
export function isKnownLedgerPeer(peerUrl: string | undefined): boolean {
  if (!peerUrl) return false;
  try {
    const host = new URL(peerUrl).hostname.toLowerCase();
    return host === "ledger.com" || host.endsWith(".ledger.com");
  } catch {
    return false;
  }
}

export async function getSessionStatus(): Promise<SessionStatus> {
  await getSignClient(); // triggers restore + liveness check
  const session = getCurrentSession();
  // Issue #687: a rejected settle-capture leaves us with no session but a
  // recorded terminal error. Surface it on both the unpaired and paired
  // returns (a failed re-pair over a still-live old session is also useful).
  const pairingError = getLastPairingError();
  const pairingErrorSection = pairingError
    ? {
        lastPairingError: pairingError,
        lastPairingErrorGuidance: LAST_PAIRING_ERROR_GUIDANCE,
      }
    : {};
  const tronPaired = getPairedTronAddresses();
  const tronSection =
    tronPaired.length > 0
      ? {
          tron: tronPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            accountIndex: e.accountIndex,
          })),
        }
      : {};
  const solanaPaired = getPairedSolanaAddresses();
  const solanaSection =
    solanaPaired.length > 0
      ? {
          solana: solanaPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            accountIndex: e.accountIndex,
          })),
        }
      : {};
  const btcPaired = getPairedBtcAddresses();
  const btcSection =
    btcPaired.length > 0
      ? {
          bitcoin: btcPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            addressType: e.addressType,
            accountIndex: e.accountIndex,
            ...(e.chain !== undefined ? { chain: e.chain } : {}),
            ...(e.addressIndex !== undefined ? { addressIndex: e.addressIndex } : {}),
            ...(e.txCount !== undefined ? { txCount: e.txCount } : {}),
          })),
        }
      : {};
  const ltcPaired = getPairedLtcAddresses();
  const ltcSection =
    ltcPaired.length > 0
      ? {
          litecoin: ltcPaired.map((e) => ({
            address: e.address,
            path: e.path,
            appVersion: e.appVersion,
            addressType: e.addressType,
            accountIndex: e.accountIndex,
            ...(e.chain !== undefined ? { chain: e.chain } : {}),
            ...(e.addressIndex !== undefined ? { addressIndex: e.addressIndex } : {}),
            ...(e.txCount !== undefined ? { txCount: e.txCount } : {}),
          })),
        }
      : {};
  if (!session)
    return {
      paired: false,
      accounts: [],
      accountDetails: [],
      // Unpaired: no peerVersion yet, so instructions are fully generic.
      pairingInstructions: ledgerLivePairingInstructions(undefined),
      ...pairingErrorSection,
      ...tronSection,
      ...solanaSection,
      ...btcSection,
      ...ltcSection,
    };
  const accountDetails = await getConnectedAccountsDetailed();
  const accounts = accountDetails.map((a) => a.address);
  const meta = session.peer?.metadata;
  const unreachable = isPeerUnreachable();
  const warnPeer = !isKnownLedgerPeer(meta?.url);
  const version = parseLedgerLiveVersion(meta);
  return {
    paired: true,
    accounts,
    accountDetails,
    topic: session.topic,
    expiresAt: session.expiry * 1000,
    ...(meta?.name ? { wallet: meta.name } : {}),
    ...(meta?.url ? { peerUrl: meta.url } : {}),
    ...(meta?.description ? { peerDescription: meta.description } : {}),
    ...(version ? { peerVersion: version } : {}),
    ...(warnPeer ? { peerTrustWarning: PEER_TRUST_WARNING } : {}),
    ...(unreachable
      ? {
          peerUnreachable: true,
          peerUnreachableGuidance: PEER_UNREACHABLE_GUIDANCE,
          // Emit re-pair instructions on the unreachable path — the
          // healthy-paired case doesn't need them cluttering responses.
          pairingInstructions: ledgerLivePairingInstructions(version),
        }
      : {}),
    ...pairingErrorSection,
    ...tronSection,
    ...solanaSection,
    ...btcSection,
    ...ltcSection,
  };
}
