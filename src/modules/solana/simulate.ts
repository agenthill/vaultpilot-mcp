import {
  VersionedMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";

/**
 * Pre-sign simulation result for a pinned Solana VersionedTransaction. Mirrors
 * the shape of EVM's `SimulationResult` in spirit — `ok: false` means the
 * network WOULD reject this tx if broadcast as-is, and the preview step
 * should abort before the user's Ledger prompts.
 *
 * `anchorError` is best-effort: when the logs carry an Anchor-style error
 * frame ("AnchorError thrown in … Error Code: X. Error Number: Y. Error
 * Message: Z."), we extract it so agents can relay a structured code +
 * human message instead of asking users to read raw logs. Falls back to
 * `err` (the raw RPC err object stringified) when no Anchor frame is
 * present.
 */
export interface SolanaSimulationResult {
  ok: boolean;
  unitsConsumed?: number;
  /** Program logs from the simulation (full array when present). */
  logs?: string[];
  /** Raw stringified err object when ok === false. */
  err?: string;
  /** Parsed Anchor error from the logs, if any. */
  anchorError?: {
    code: number;
    name: string;
    message: string;
  };
}

/**
 * Simulate a pinned Solana message via `Connection.simulateTransaction` —
 * NO signature needed because we pass `sigVerify: false`. Also
 * `replaceRecentBlockhash: false` so the pinned nonce / blockhash stays
 * exactly what the Ledger will see at sign time; otherwise the RPC would
 * substitute a fresh blockhash and the simulated tx wouldn't reflect the
 * durable-nonce branch Agave takes on-chain.
 *
 * Caller is responsible for deciding what to do with `ok: false` — this
 * function just reports. The wiring in `previewSolanaSend` turns a
 * failed simulation into a preview-level throw so the agent never
 * surfaces a Ledger hash for a guaranteed-revert tx (issue #115).
 *
 * Handles both legacy and v0 messages — `VersionedMessage.deserialize`
 * dispatches on the high bit of the first byte (0x80 = v0, 0x00 = legacy)
 * and returns the right concrete message type. Native/SPL sends are
 * legacy; MarginFi / Jupiter txs are v0. Both shapes wrap into a
 * `VersionedTransaction` which is what `Connection.simulateTransaction`
 * expects as its first arg under the `sigVerify: false` config overload.
 */
export async function simulatePinnedSolanaTx(
  conn: Connection,
  messageBase64: string,
): Promise<SolanaSimulationResult> {
  const msgBytes = Buffer.from(messageBase64, "base64");
  const message = VersionedMessage.deserialize(msgBytes);
  const tx = new VersionedTransaction(message);
  const { value } = await conn.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: false,
    commitment: "confirmed",
  });
  const logs = value.logs ?? undefined;
  const shared: Pick<SolanaSimulationResult, "unitsConsumed" | "logs"> = {
    ...(value.unitsConsumed !== undefined
      ? { unitsConsumed: value.unitsConsumed }
      : {}),
    ...(logs ? { logs } : {}),
  };
  if (value.err === null) {
    return { ok: true, ...shared };
  }
  const anchorError = extractAnchorError(logs);
  return {
    ok: false,
    ...shared,
    err: JSON.stringify(value.err),
    ...(anchorError ? { anchorError } : {}),
  };
}

/**
 * Scrape an Anchor error frame from the last matching log line. Anchor
 * programs emit a line like:
 *   "Program log: AnchorError thrown in programs/marginfi/src/…:1142. Error
 *    Code: RiskEngineInitRejected. Error Number: 6009. Error Message:
 *    RiskEngine rejected due to either bad health or stale oracles."
 *
 * Scanning from the end catches the deepest (most specific) error when
 * multiple programs log errors in the same sim.
 */
function extractAnchorError(
  logs: string[] | undefined,
): { code: number; name: string; message: string } | undefined {
  if (!logs || logs.length === 0) return undefined;
  // Match "Error Code: X. Error Number: Y." with an OPTIONAL
  // "Error Message: Z." trailing segment. MarginFi's Anchor errors always
  // include the message; Switchboard's `NotEnoughSamples` and some others
  // omit it entirely (issue #125 — the log ends right after "Error Number: 6030.").
  // An earlier version required the message and used `[^.]*` up to the
  // first dot — that broke on MarginFi because the source-file path
  // ("marginfi_account.rs:1142.") contains dots, AND on Switchboard because
  // the whole "Error Message:" suffix is absent. Both call sites care more
  // about the code than the message text, so message is optional.
  const re =
    /Error Code:\s*(\w+)\.\s*Error Number:\s*(\d+)\.(?:\s*Error Message:\s*(.+?)\.?)?\s*$/;
  for (let i = logs.length - 1; i >= 0; i--) {
    const m = logs[i]!.match(re);
    if (m) {
      return {
        name: m[1]!,
        code: Number(m[2]),
        message: m[3] ? m[3].trim() : "(no message provided by program)",
      };
    }
  }
  return undefined;
}

/**
 * Detect whether a Switchboard `NotEnoughSamples` (Anchor 6030 / 0x178e)
 * failure is due to an active oracle-set rotation on the feed. The
 * on-chain Switchboard program logs `Rotating mega slot` immediately
 * before throwing `NotEnoughSamples` when the feed is between oracle
 * sets — a transient state lasting seconds to ~2 minutes during which
 * consensus can't be reached regardless of how many samples we
 * requested from the gateway (issue #125).
 *
 * Distinguishing this from the plain-stale-samples case matters for
 * user guidance: stale-samples → "re-prepare to retry" (re-fetching
 * gateway samples gets fresh ones); rotating → "wait ~60–120s, don't
 * loop-retry" (no amount of re-fetching produces a valid consensus
 * payload until rotation completes).
 *
 * Pure log-string scan: no side effects, no RPC calls. The caller is
 * responsible for confirming the AnchorError is actually 6030 before
 * acting on this signal.
 */
export function isSwitchboardRotation(logs: string[] | undefined): boolean {
  if (!logs || logs.length === 0) return false;
  return logs.some((l) => /Rotating mega slot/.test(l));
}
