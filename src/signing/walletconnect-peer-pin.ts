import type { SessionTypes } from "@walletconnect/types";

/**
 * WalletConnect peer pinning (issue #325 P5).
 *
 * The MCP's WalletConnect role is "dApp"; it proposes a session and
 * the wallet (Ledger Live) approves. Once approved, every signing
 * request flows over a relayed encrypted channel between the two —
 * the MCP submits txs/messages, the wallet signs.
 *
 * Today's trust assumption: "the WC peer that approved our session is
 * Ledger Live, because the user scanned the QR with Ledger Live and
 * approved on the Ledger device." The MCP can't verify the wallet
 * binary itself (P4 covers that), but it CAN verify the WC peer's
 * advertised identity matches what Ledger Live publishes — name and
 * canonical URL. A different wallet
 * (Sparrow, MetaMask, an attacker's wallet) advertises different
 * metadata, and the user would notice the prompt on the wrong app
 * — but only if they look. This pin makes the discrepancy
 * machine-checkable.
 *
 * What this catches:
 *   - Another wallet impersonating Ledger Live at the WC peer level
 *     (i.e., the user accidentally scanned the QR with the wrong app
 *     and approved without noticing)
 *   - A malicious WC relay swapping the peer metadata (the relay sees
 *     metadata in the session_propose payload; if compromised it
 *     could rewrite — but the MCP would notice the mismatch)
 *
 * What this misses (covered by other layers):
 *   - A real-Ledger-Live version that's been tampered with (P4)
 *   - A WC peer that lies about its name/url AND happens to spoof
 *     Ledger Live's exact metadata (impossible to detect at this
 *     layer alone; user's eyes on the device are the trust root)
 *
 * Pinning policy (re-scoped by issue #831 — real Ledger Live was
 * failing 2 of the original 3 checks on every genuine pairing):
 *   - `url` hostname is the load-bearing anchor: must be `ledger.com`
 *     or a `*.ledger.com` subdomain. All three fields are equally
 *     peer-self-reported — none is more spoof-resistant than another
 *     — so this pin's real value is catching an ACCIDENTAL
 *     wrong-wallet pairing (the user scanned the QR with the wrong
 *     app), not a deliberate spoof (out of scope regardless, see
 *     "What this misses" above). `url` is the one field that actually
 *     identified the genuine peer in #831's observed metadata, so it
 *     alone carries that job now. A narrow exception: an EMPTY url is
 *     tolerated, but only when `name` is already allowlisted (see
 *     below) — see the in-function comment for why.
 *   - `name` is checked against a small allowlist of names Ledger
 *     Live has been observed to publish (`"Ledger Live"`,
 *     `"Ledger Wallet"`; exact match, case-sensitive) but is a
 *     WARNING CONTRIBUTOR, not a sole trigger: an unrecognized name
 *     still produces a `mismatch` verdict even when `url` is good
 *     (metadata drift is worth surfacing), but the message names
 *     exactly which field disagreed so the operator can judge.
 *   - The icon-host check is REMOVED (issue #831). Real Ledger Live's
 *     sole icon is served from `avatars.githubusercontent.com` — a
 *     GitHub avatar URL Ledger doesn't control and could change any
 *     time a GitHub org avatar changes. Pinning it added churn, not
 *     identification, so it's dropped rather than allowlisted.
 *
 * On mismatch we WARN-LOUDLY rather than refuse. Refusal would brick
 * legitimate users running self-built Ledger Live or development
 * builds where metadata sometimes differs. The verdict is surfaced to
 * the agent so it can flag to the user; the user retains the on-device
 * approval as the actual trust root.
 */

export type LedgerLivePinVerdict = "match" | "mismatch" | "missing-metadata";

export interface PeerPinResult {
  verdict: LedgerLivePinVerdict;
  /** Peer's reported name. Empty string if missing. */
  reportedName: string;
  /** Peer's reported URL. Empty string if missing. */
  reportedUrl: string;
  /** Human-readable line for the agent to surface on `mismatch`. */
  message: string;
}

/**
 * Names observed as genuine Ledger Live WalletConnect metadata.
 * Exact match, case-sensitive. `"Ledger Live"` is the name from the
 * original #325 pin; `"Ledger Wallet"` was added by #831 after a real
 * pairing showed current Ledger Live advertising that name instead.
 */
const LEDGER_LIVE_NAMES: ReadonlySet<string> = new Set([
  "Ledger Live",
  "Ledger Wallet",
]);
/** Hostname suffixes Ledger publishes from. */
const LEDGER_HOST_SUFFIXES: ReadonlyArray<string> = [".ledger.com"];

function hostMatchesLedger(host: string): boolean {
  const lc = host.toLowerCase();
  // Exact match for the bare apex (defensive — Ledger doesn't currently
  // serve from the bare apex, but accepting it future-proofs).
  if (lc === "ledger.com") return true;
  return LEDGER_HOST_SUFFIXES.some((suffix) => lc.endsWith(suffix));
}

function safeUrlHostname(raw: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).hostname;
  } catch {
    return null;
  }
}

/**
 * Validate a WC session's peer metadata against the Ledger Live
 * pin. Returns a structured verdict; does NOT throw.
 */
export function pinLedgerLivePeer(session: SessionTypes.Struct): PeerPinResult {
  // SessionTypes.Struct.peer.metadata.{name, url} are the standard
  // WC v2 fields the wallet advertises. `icons` is no longer read —
  // the icon-host check was dropped by #831 (see module doc).
  const metadata = session.peer?.metadata;
  const reportedName = metadata?.name ?? "";
  const reportedUrl = metadata?.url ?? "";

  if (!reportedName && !reportedUrl) {
    return {
      verdict: "missing-metadata",
      reportedName,
      reportedUrl,
      message:
        `WalletConnect peer reported no metadata (name + url both empty). ` +
        `Verify the connection on-device before approving signing prompts — the ` +
        `MCP cannot identify the peer.`,
    };
  }

  // Name check: small allowlist (issue #831). A warning contributor,
  // not a sole trigger — see module doc.
  const nameOk = LEDGER_LIVE_NAMES.has(reportedName);

  // URL check: the load-bearing anchor (issue #831). A scheme-less
  // url fails `new URL()` parsing (safeUrlHostname returns null), so
  // it mismatches like any other unparseable/non-Ledger url — no
  // special-casing needed for that.
  //
  // Empty url is tolerated, but ONLY when name is already allowlisted
  // (re-narrowed per #831 review). The pre-#831 pin (afcf211) claimed
  // "Ledger Live mobile sometimes omits url" with zero evidence cited; we can't verify or refute that
  // claim here either. So the code stays safe under BOTH readings:
  // if the claim is true, an unconditional url requirement would cry
  // wolf on every mobile pairing — the exact #831 defect class; if
  // it's false, tolerating empty url when the name is recognized
  // buys an attacker nothing against this pin's actual threat model
  // (accidental wrong-wallet pairing — a mis-scanned MetaMask isn't
  // self-reported as "Ledger Wallet"), so gating the tolerance on
  // `nameOk` closes that gap without reintroducing #831.
  const urlHost = safeUrlHostname(reportedUrl);
  const urlMatchesLedger = urlHost !== null && hostMatchesLedger(urlHost);
  const urlOk = urlMatchesLedger || (!reportedUrl && nameOk);

  if (nameOk && urlOk) {
    return {
      verdict: "match",
      reportedName,
      reportedUrl,
      message: `WalletConnect peer matches Ledger Live pin.`,
    };
  }

  const reasons: string[] = [];
  if (!nameOk) {
    const expected = [...LEDGER_LIVE_NAMES].map((n) => `"${n}"`).join(", ");
    reasons.push(
      `name "${reportedName}" is not a recognized Ledger Live name (expected one of: ${expected})`,
    );
  }
  if (!urlOk) {
    if (!reportedUrl) {
      reasons.push(
        `url is empty, which is only tolerated when name is a recognized Ledger Live name`,
      );
    } else {
      reasons.push(
        `url "${reportedUrl}" doesn't match a ledger.com hostname`,
      );
    }
  }

  return {
    verdict: "mismatch",
    reportedName,
    reportedUrl,
    message:
      `WalletConnect peer does NOT match the Ledger Live pin: ${reasons.join("; ")}. ` +
      `If you intentionally connected via a non-Ledger-Live wallet (development ` +
      `build, Sparrow, etc.), this is expected — but if you scanned the QR with ` +
      `Ledger Live and see this warning, the peer may not be what it claims to be. ` +
      `Verify on-device before approving any signing prompts.`,
  };
}
