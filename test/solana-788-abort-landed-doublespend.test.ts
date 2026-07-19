import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";

/**
 * Acceptance regression for issue #788 — Solana abort-but-landed double
 * execution on a durable-nonce send handle.
 *
 * Bug (confirmed): `sendSolanaTransaction` retires the handle ONLY after a
 * successful `broadcastSolanaTx`. When the broadcast aborts (e.g. a 10s
 * timeout) but the node actually LANDED the tx, the throw skips the retire
 * and the handle stays alive within its 15-min TTL. The landed tx advanced
 * the on-chain durable nonce, so a subsequent `preview_solana_send` re-fetches
 * the ADVANCED nonce (`send.ts` durable-nonce branch), silently re-pins a
 * byte-different-but-independently-valid tx, mints a fresh preview token, and
 * hands back a second signable tx that REPEATS the transfer → double
 * execution (once per retry inside the TTL). The existing send-time guards
 * (previewToken match, payload-hash recompute) all pass tautologically over
 * the re-pinned tx, so nothing catches it.
 *
 * The DEV fix ports the EVM #232 late-broadcast guard to Solana: it keys on
 * "a broadcast has been ATTEMPTED on this handle" and makes the next preview
 * fail CLOSED (route the user to check chain status) rather than silently
 * re-pin. Crucially the guard keys on the ATTEMPT, NOT on "the nonce moved"
 * and NOT on "a second preview occurred" — otherwise it would break the
 * legitimate benign re-pin (a third party advancing the nonce while the user
 * paused, no broadcast on this handle).
 *
 * These two cases encode SEC's acceptance spec behaviorally, driving the real
 * prepare → preview → send → preview flow with no reference to the fix's
 * internal API:
 *
 *   CASE 1 (REFUSE / fail-closed) — RED on current main, GREEN after the fix.
 *     prepare → preview → send (broadcast aborts, tx landed → nonce advances)
 *     → preview again on the SAME handle. Must NOT silently return a fresh
 *     signable tx. RED today because the code silently re-pins.
 *
 *   CASE 2 (OVER-BLOCK CONTROL) — GREEN now AND after the fix.
 *     prepare → preview → [NO send] → third party advances the nonce →
 *     preview again. Must PREVIEW SUCCESSFULLY. Proves the guard keys on
 *     "broadcast attempted on THIS handle", not on the nonce having moved,
 *     so the fix can't trade the double-spend for an availability break.
 *
 * The A/B is deliberately identical EXCEPT the broadcast-attempt step (case 1
 * runs send_transaction; case 2 does not). Both advance the nonce the same
 * way, so the only variable that can flip the outcome is "was a broadcast
 * attempted on this handle".
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();

// Nonce values: V0 at prepare/first-preview; V1 after the tx "lands" and the
// on-chain durable nonce advances. Both are valid base58 32-byte values.
const NONCE_V0 = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";
const NONCE_V1 = "5a7PR3n1eTKCTgLkbkjNWTBvFu8kv1RYD9QgEQD8CAzB";

const getAddressMock = vi.fn();
const getAppConfigurationMock = vi.fn();
const signTransactionMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/solana-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getAddress: getAddressMock,
      getAppConfiguration: getAppConfigurationMock,
      signTransaction: signTransactionMock,
    },
    transport: { close: transportCloseMock },
  }),
}));

const connectionStub = {
  getBalance: vi.fn(),
  getAccountInfo: vi.fn(),
  getLatestBlockhash: vi.fn(),
  getRecentPrioritizationFees: vi.fn(),
  sendRawTransaction: vi.fn(),
  simulateTransaction: vi.fn(),
  getMinimumBalanceForRentExemption: vi.fn(),
};

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

beforeEach(async () => {
  getAddressMock.mockReset();
  getAppConfigurationMock.mockReset();
  signTransactionMock.mockReset();
  transportCloseMock.mockClear();
  for (const fn of Object.values(connectionStub)) fn.mockReset();

  connectionStub.getBalance.mockResolvedValue(5_000_000_000);
  connectionStub.getLatestBlockhash.mockResolvedValue({
    blockhash: "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh",
    lastValidBlockHeight: 123_456_789,
  });
  connectionStub.getRecentPrioritizationFees.mockResolvedValue([]);
  // Pre-sign simulation defaults to SUCCESS so it never becomes the reason a
  // preview refuses — the ONLY thing that should flip case 1 from resolve to
  // refuse is the (absent-on-main) #788 guard. A sim failure here would make
  // case 1 throw for the wrong reason and mask the RED.
  connectionStub.simulateTransaction.mockResolvedValue({
    context: { slot: 1 },
    value: {
      err: null,
      logs: ["Program 11111111111111111111111111111111 success"],
      unitsConsumed: 300,
    },
  });
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(1_447_680);
  getAppConfigurationMock.mockResolvedValue({ version: "1.10.0" });

  // Present durable-nonce account at value V0 for prepare + first preview.
  const { getNonceAccountValue } = await import("../src/modules/solana/nonce.js");
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
    nonce: NONCE_V0,
    authority: new PublicKey(WALLET),
  });

  // Ledger returns the correct wallet pubkey + a well-formed 64-byte signature
  // so the send step reaches the broadcast call.
  getAddressMock.mockResolvedValue({
    address: WALLET_KEYPAIR.publicKey.toBuffer(),
  });
  signTransactionMock.mockResolvedValue({ signature: Buffer.alloc(64, 7) });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/**
 * Classify a preview outcome without asserting a specific error/return shape,
 * so the test is robust to whether the fix REFUSES by throwing or by returning
 * a non-signable refusal. "Failed closed" = it did NOT hand back a fresh,
 * byte-different, signable tx.
 */
function isSignableTx(x: unknown): boolean {
  return (
    x != null &&
    typeof x === "object" &&
    typeof (x as { messageBase64?: unknown }).messageBase64 === "string" &&
    ((x as { messageBase64: string }).messageBase64).length > 0
  );
}

describe("#788 Solana abort-but-landed double-execution regression", () => {
  it("CASE 1 (REFUSE, RED until #232 guard ported): re-preview after a broadcast was ATTEMPTED on this handle must fail closed, not silently re-pin a second valid tx", async () => {
    const { buildSolanaNativeSend } = await import(
      "../src/modules/solana/actions.js"
    );
    const { previewSolanaSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const { hasSolanaHandle } = await import(
      "../src/signing/solana-tx-store.js"
    );

    // 1. Prepare a durable-nonce native send and pin it via preview.
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const firstPin = await previewSolanaSend({ handle: draft.handle });
    expect(firstPin.recentBlockhash).toBe(NONCE_V0);
    expect(isSignableTx(firstPin)).toBe(true);

    // 2. ATTEMPT the broadcast — it ABORTS (10s timeout) but the node LANDED
    //    the tx. Model the abort by rejecting sendRawTransaction; the real
    //    broadcastSolanaTx runs and throws, so sendSolanaTransaction never
    //    reaches retireSolanaHandle. No product code is mocked away — the fix
    //    marks "broadcast attempted" wherever it lives on the real send path.
    connectionStub.sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error("Broadcast aborted after 10000ms"), {
        name: "AbortError",
      }),
    );
    await expect(
      sendTransaction({
        handle: draft.handle,
        confirmed: true,
        previewToken: firstPin.previewToken,
        userDecision: "send",
      }),
    ).rejects.toThrow();

    // The broadcast was genuinely attempted, and the abort left the handle
    // ALIVE (not retired) — the exact precondition the bug needs.
    expect(connectionStub.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(hasSolanaHandle(draft.handle)).toBe(true);

    // 3. The landed tx advanced the on-chain durable nonce → V1.
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_V1,
      authority: new PublicKey(WALLET),
    });

    // 4. Re-preview the SAME handle. It MUST fail closed: throw, or return a
    //    refusal that is NOT a fresh signable tx. It must NOT silently hand
    //    back a second, byte-different, independently-valid signable tx.
    //
    //    RED on current main: previewSolanaSend re-pins with V1 and RESOLVES
    //    to a fresh signable tx (the double-spend), so `failedClosed` is false
    //    and this assertion fails — that RED is the proof of the bug.
    //    GREEN after the fix: the #232-style guard refuses on the attempted
    //    broadcast.
    const outcome = await previewSolanaSend({ handle: draft.handle }).then(
      (pinned) => ({ threw: false as const, pinned }),
      (err: unknown) => ({ threw: true as const, err }),
    );
    const failedClosed =
      outcome.threw || !isSignableTx((outcome as { pinned?: unknown }).pinned);
    expect(
      failedClosed,
      "preview_solana_send must fail closed after a broadcast was ATTEMPTED on this handle " +
        "(abort-but-landed): it must not silently re-pin a second valid tx repeating the transfer. " +
        "This is RED on current main (it silently re-pins) until DEV ports the #232 guard.",
    ).toBe(true);
  });

  it("CASE 2 (OVER-BLOCK CONTROL, GREEN now and after the fix): a third-party nonce advance with NO broadcast attempted on this handle must still preview successfully", async () => {
    const { buildSolanaNativeSend } = await import(
      "../src/modules/solana/actions.js"
    );
    const { previewSolanaSend } = await import(
      "../src/modules/execution/index.js"
    );

    // 1. Prepare + first preview (identical to case 1).
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const firstPin = await previewSolanaSend({ handle: draft.handle });
    expect(firstPin.recentBlockhash).toBe(NONCE_V0);

    // 2. NO send_transaction — no broadcast is ever attempted on this handle.
    //    A THIRD PARTY advances the on-chain nonce → V1 (e.g. another tx
    //    against the same nonce account while the user paused). This is the
    //    benign re-pin the durable-nonce preview branch exists to handle.
    expect(connectionStub.sendRawTransaction).not.toHaveBeenCalled();
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_V1,
      authority: new PublicKey(WALLET),
    });

    // 3. Re-preview the SAME handle. It MUST succeed and re-pin to V1 — the
    //    guard keys on "broadcast attempted on THIS handle", which never
    //    happened here. GREEN on main AND after the fix.
    const second = await previewSolanaSend({ handle: draft.handle });
    expect(isSignableTx(second)).toBe(true);
    expect(second.recentBlockhash).toBe(NONCE_V1);
    expect(second.nonce!.value).toBe(NONCE_V1);
    expect(second.messageBase64).not.toBe(firstPin.messageBase64);
  });
});

/**
 * #792 rework — the abort-but-landed guard fires correctly, but its refusal
 * message must also give the agent an EXECUTABLE recovery. These falsifiers
 * cover the three defects fixed on top of #792's guard:
 *
 *   1. The ed25519 signature (base58 txHash) is PERSISTED on the store entry in
 *      the same pre-broadcast write as `broadcastAttempted` — so it survives an
 *      abort that unwinds the send path (crash-safety), and is available at the
 *      later `previewSolanaSend` refusal site where the send-time `signature`
 *      local is long out of scope.
 *   2. The refusal names the REAL tool (`get_transaction_status`) and emits the
 *      signature + durableNonce INLINE, verbatim-acceptable to that tool's zod
 *      schema — not the nonexistent `get_solana_transaction_status`, and not a
 *      dangling "durableNonce from the send response" (there is no response at
 *      the preview site).
 *   3. The refusal no longer directs a fresh `prepare_solana_*` as clearance —
 *      that path re-spends when the original landed (#797). It is named only in
 *      a prohibition, gated behind a resolved landing verdict.
 */
describe("#792 executable abort-but-landed recovery message", () => {
  // The Ledger mock signs with 64 bytes of 0x07 (see beforeEach); base58 of
  // that IS the Solana txHash the refusal must surface.
  const EXPECTED_SIG = bs58.encode(Buffer.alloc(64, 7));

  /** Drive prepare -> preview -> send(abort-but-landed) -> nonce advances. */
  async function driveAbortLandedState(): Promise<{ handle: string }> {
    const { buildSolanaNativeSend } = await import(
      "../src/modules/solana/actions.js"
    );
    const { previewSolanaSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const draft = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const firstPin = await previewSolanaSend({ handle: draft.handle });

    connectionStub.sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error("Broadcast aborted after 10000ms"), {
        name: "AbortError",
      }),
    );
    await expect(
      sendTransaction({
        handle: draft.handle,
        confirmed: true,
        previewToken: firstPin.previewToken,
        userDecision: "send",
      }),
    ).rejects.toThrow();

    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_V1,
      authority: new PublicKey(WALLET),
    });
    return { handle: draft.handle };
  }

  it("persists the ed25519 signature (base58 txHash) in the pre-broadcast write, surviving an abort", async () => {
    const { getSolanaBroadcastSignature } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const { handle } = await driveAbortLandedState();

    // The broadcast THREW (abort), yet the signature must already be durable —
    // it is written alongside `broadcastAttempted` BEFORE broadcastSolanaTx.
    const sig = getSolanaBroadcastSignature(handle);
    expect(
      sig,
      "signature must be persisted on the store entry before the RPC, so it " +
        "survives an abort-but-landed unwind and is readable at the refusal site",
    ).toBe(EXPECTED_SIG);
    // Solana signatures are base58, 86-88 chars — the exact txHash shape
    // get_transaction_status accepts.
    expect(sig!.length).toBeGreaterThanOrEqual(86);
    expect(sig!.length).toBeLessThanOrEqual(88);
    expect(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/.test(sig!)).toBe(true);
  });

  it("emits an EXECUTABLE get_transaction_status recovery (inline signature + durableNonce, schema-valid), with no nonexistent tool and no fresh-prepare clearance", async () => {
    const { previewSolanaSend } = await import(
      "../src/modules/execution/index.js"
    );
    const { getTransactionStatusInput } = await import(
      "../src/modules/execution/schemas.js"
    );
    const { handle } = await driveAbortLandedState();

    // Re-preview the SAME handle -> the guard fires -> capture the refusal.
    const err = await previewSolanaSend({ handle }).then(
      () => {
        throw new Error("expected previewSolanaSend to refuse, but it resolved");
      },
      (e: unknown) => e as Error,
    );
    const msg = err.message;

    // Names the REAL tool; NOT the nonexistent one #792 shipped.
    expect(msg).toContain("get_transaction_status(chain='solana'");
    expect(msg).not.toContain("get_solana_transaction_status");
    // No dangling "from the send response" — there is no response at the
    // preview site.
    expect(msg).not.toMatch(/from the send response/i);

    // The signature is inline and verbatim-pasteable as the txHash arg.
    expect(msg).toContain(`txHash='${EXPECTED_SIG}'`);
    // durableNonce shape is inline.
    expect(msg).toMatch(/durableNonce=\{ noncePubkey: '[^']+', nonceValue: '[^']+' \}/);

    // Extract the emitted args and prove get_transaction_status's schema
    // accepts them VERBATIM (the strongest "executable" evidence).
    const txHash = msg.match(/txHash='([^']+)'/)?.[1];
    const noncePubkey = msg.match(/noncePubkey: '([^']+)'/)?.[1];
    const nonceValue = msg.match(/nonceValue: '([^']+)'/)?.[1];
    expect(txHash).toBe(EXPECTED_SIG);
    expect(noncePubkey).toBeTruthy();
    expect(nonceValue).toBeTruthy();
    expect(() =>
      getTransactionStatusInput.parse({
        chain: "solana",
        txHash,
        durableNonce: { noncePubkey, nonceValue },
      }),
    ).not.toThrow();

    // Fresh-prepare is no longer directed as clearance: the old unconditional
    // phrasing is gone, and prepare_solana_* survives only inside a prohibition.
    expect(msg).not.toMatch(
      /run prepare_solana_\* again for a FRESH handle and send that/i,
    );
    expect(msg).toContain("do NOT run prepare_solana_* for a fresh handle");
  });
});
