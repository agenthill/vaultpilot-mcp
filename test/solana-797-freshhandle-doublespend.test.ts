import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey } from "@solana/web3.js";

/**
 * Acceptance regression for issue #797 — the #788 sibling: a FRESH
 * `prepare_solana_*` handle after an abort-but-landed send double-spends via
 * a NEW handle the #792 guard does not cover.
 *
 * Bug (confirmed, analysis evidence — file:line from #797's report):
 * `previewSolanaSend`'s #788/#792 guard (`src/modules/solana/send.ts:556`)
 * keys on `wasSolanaBroadcastAttempted(args.handle)` — a PER-HANDLE flag set
 * in `sendSolanaTransaction` (`send.ts:794`) and stored on the
 * `StoredSolanaTx` entry (`src/signing/solana-tx-store.ts`). It fires only
 * when the SAME handle is re-previewed.
 *
 * `deriveNonceAccountAddress` (`src/modules/solana/actions.ts`,
 * `buildSolanaNativeSend`) is a deterministic PDA of the SOURCE WALLET, not
 * of the handle. So after handle A aborts-but-lands and the durable nonce
 * advances V0→V1, a totally FRESH `prepare_solana_native_send` for the SAME
 * wallet mints a NEW `randomUUID` handle B with `broadcastAttempted` unset.
 * `previewSolanaSend` for handle B re-derives the SAME nonce account,
 * re-fetches the ADVANCED nonce (V1), and silently pins a byte-different,
 * independently-valid tx that REPEATS the transfer. The #792 guard never
 * fires because it only ever looks at handle B's own (unset) flag — it has
 * no memory of handle A's aborted attempt.
 *
 * #788's own acceptance test (`test/solana-788-abort-landed-doublespend.test.ts`)
 * is scoped to SAME-handle re-preview and is correctly GREEN after #792 —
 * this file is the sibling that stays open per #797 until a fresh-handle
 * guard ships.
 *
 * These two cases encode the acceptance behaviorally, driving the real
 * prepare → preview → send → prepare(FRESH) → preview flow with no
 * reference to any fix-internal symbol:
 *
 *   CASE 1 (REFUSE / fail-closed) — RED on current main.
 *     prepare A → preview A → send A (broadcast aborts, tx landed → nonce
 *     advances) → prepare a FRESH handle B for the IDENTICAL
 *     source→destination→amount → preview B. Must NOT silently return a
 *     fresh signable tx. RED today because #792's guard is per-handle and
 *     handle B was never touched by a broadcast attempt.
 *
 *   CASE 2 (OVER-BLOCK CONTROL) — GREEN now AND must stay GREEN after any
 *     reasonable #797 fix.
 *     Same abort-but-landed precondition on wallet A, then a fresh prepare +
 *     preview for a GENUINELY UNRELATED wallet (different keypair — hence a
 *     different `deriveNonceAccountAddress` PDA — different destination,
 *     different amount). Must preview successfully. Proves a fix can't trade
 *     the double-spend for a blast-radius-unbounded refusal that blocks
 *     transfers with zero relationship to the pending ambiguous broadcast.
 *
 * DESIGN-DEPENDENT BOUNDARY (explicitly NOT this file's concern): the issue's
 * own "Fix direction" section leaves open whether the guard should key on the
 * durable-nonce account, the source wallet, or something reconciled via
 * `get_transaction_status` — SEC/DEV decide. Because `deriveNonceAccountAddress`
 * is deterministic PER SOURCE WALLET, a fresh prepare from the SAME wallet A
 * to a DIFFERENT destination would still land on A's nonce account and could
 * legitimately be refused under a per-nonce-account or per-wallet fix — that
 * is not an over-block, it's the fix working as designed. CASE 2 therefore
 * deliberately uses a wallet with NO relationship to wallet A at all (a
 * different keypair, so a different nonce-account PDA under every candidate
 * granularity), so it stays a safe control regardless of which of those
 * designs SEC/DEV pick.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const RECIPIENT = Keypair.generate().publicKey.toBase58();

// A wallet with NO relationship whatsoever to WALLET — used only in CASE 2 to
// prove the over-block boundary without presuming how a #797 fix scopes its
// guard (see DESIGN-DEPENDENT BOUNDARY above).
const WALLET_B_KEYPAIR = Keypair.generate();
const WALLET_B = WALLET_B_KEYPAIR.publicKey.toBase58();
const RECIPIENT_B = Keypair.generate().publicKey.toBase58();

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
  // refuse is a (absent-on-main) #797 fresh-handle guard. A sim failure here
  // would make case 1 throw for the wrong reason and mask the RED.
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
  // Not argument-keyed (matches the #788 template) — both wallet A and
  // wallet B share this stub; CASE 2 never asserts a specific nonce value
  // for wallet B, only that its preview resolves to a signable tx.
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
 * so the test is robust to whether a #797 fix REFUSES by throwing or by
 * returning a non-signable refusal. "Failed closed" = it did NOT hand back a
 * fresh, byte-different, signable tx.
 */
function isSignableTx(x: unknown): boolean {
  return (
    x != null &&
    typeof x === "object" &&
    typeof (x as { messageBase64?: unknown }).messageBase64 === "string" &&
    ((x as { messageBase64: string }).messageBase64).length > 0
  );
}

describe("#797 Solana fresh-handle abort-but-landed double-execution regression", () => {
  it("CASE 1 (REFUSE, RED — no fresh-handle guard yet): a FRESH prepare_solana_* handle for the SAME source→destination→amount as an abort-but-landed send must fail closed, not silently re-pin a signable duplicate", async () => {
    const { buildSolanaNativeSend } = await import(
      "../src/modules/solana/actions.js"
    );
    const { previewSolanaSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const { hasSolanaHandle } = await import(
      "../src/signing/solana-tx-store.js"
    );

    // 1. Prepare + preview + ATTEMPT-abort-but-landed on handle A — the
    //    identical precondition #788's own test drives, reproduced here to
    //    set up the world state #797 targets (the SAME-handle path stays
    //    covered by #788's test and is not re-asserted here).
    const draftA = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const firstPin = await previewSolanaSend({ handle: draftA.handle });
    expect(firstPin.recentBlockhash).toBe(NONCE_V0);
    expect(isSignableTx(firstPin)).toBe(true);

    connectionStub.sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error("Broadcast aborted after 10000ms"), {
        name: "AbortError",
      }),
    );
    await expect(
      sendTransaction({
        handle: draftA.handle,
        confirmed: true,
        previewToken: firstPin.previewToken,
        userDecision: "send",
      }),
    ).rejects.toThrow();

    // The broadcast was genuinely attempted, and the abort left handle A
    // ALIVE (not retired) — the exact precondition the bug needs.
    expect(connectionStub.sendRawTransaction).toHaveBeenCalledTimes(1);
    expect(hasSolanaHandle(draftA.handle)).toBe(true);

    // 2. The landed tx advanced the on-chain durable nonce → V1. The nonce
    //    account is a deterministic PDA of the SOURCE WALLET
    //    (`deriveNonceAccountAddress`), not of the handle — so ANY fresh
    //    prepare for this wallet re-fetches this SAME advanced value.
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_V1,
      authority: new PublicKey(WALLET),
    });

    // 3. #797: mint a FRESH handle B — a brand-new `prepare_solana_*` call,
    //    NOT a re-preview of handle A — for the IDENTICAL
    //    source→destination→amount transfer that just aborted-but-landed.
    //    #792's guard checks `wasSolanaBroadcastAttempted(args.handle)`
    //    against handle B's OWN (unset) flag; it has no memory of handle A's
    //    aborted attempt, so handle B sails through untouched.
    const draftB = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    expect(draftB.handle).not.toBe(draftA.handle);

    // 4. Preview the FRESH handle B. It MUST fail closed: throw, or return a
    //    refusal that is NOT a fresh signable tx. It must NOT silently hand
    //    back a second, byte-different, independently-valid signable tx that
    //    would repeat the 0.1 SOL transfer.
    //
    //    RED on current main: previewSolanaSend has no memory of wallet A's
    //    aborted attempt when asked about handle B, so it re-pins with V1
    //    and RESOLVES to a fresh signable tx (the double-spend) —
    //    `failedClosed` is false and this assertion fails, which is the
    //    proof of the bug.
    const outcomeB = await previewSolanaSend({ handle: draftB.handle }).then(
      (pinned) => ({ threw: false as const, pinned }),
      (err: unknown) => ({ threw: true as const, err }),
    );
    const failedClosed =
      outcomeB.threw ||
      !isSignableTx((outcomeB as { pinned?: unknown }).pinned);
    expect(
      failedClosed,
      "preview_solana_send on a FRESH handle for the same source/destination/amount must fail " +
        "closed after a prior abort-but-landed broadcast on this wallet's durable nonce: it must " +
        "not silently hand back a second signable duplicate that re-spends the landed nonce. This " +
        "is RED on current main — #792's guard is keyed on wasSolanaBroadcastAttempted(handle), a " +
        "PER-HANDLE flag the fresh handle never carries, so this resolves to a fresh signable tx " +
        "(the double-spend). Issue #797 (sibling of #788, closed by #792).",
    ).toBe(true);
  });

  it("CASE 2 (OVER-BLOCK CONTROL, GREEN now and must stay GREEN after any reasonable #797 fix): a fresh prepare_solana_* for a genuinely UNRELATED wallet/transfer must still preview successfully despite a pending ambiguous broadcast elsewhere", async () => {
    const { buildSolanaNativeSend } = await import(
      "../src/modules/solana/actions.js"
    );
    const { previewSolanaSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );

    // 1. Reproduce the SAME abort-but-landed precondition on wallet A as
    //    CASE 1 — establishes that a genuinely ambiguous broadcast really is
    //    pending somewhere in the system before we probe the unrelated
    //    wallet below, so this control is meaningful rather than vacuous.
    const draftA = await buildSolanaNativeSend({
      wallet: WALLET,
      to: RECIPIENT,
      amount: "0.1",
    });
    const firstPinA = await previewSolanaSend({ handle: draftA.handle });
    connectionStub.sendRawTransaction.mockRejectedValueOnce(
      Object.assign(new Error("Broadcast aborted after 10000ms"), {
        name: "AbortError",
      }),
    );
    await expect(
      sendTransaction({
        handle: draftA.handle,
        confirmed: true,
        previewToken: firstPinA.previewToken,
        userDecision: "send",
      }),
    ).rejects.toThrow();
    expect(connectionStub.sendRawTransaction).toHaveBeenCalledTimes(1);

    // 2. DESIGN-DEPENDENT BOUNDARY — deliberately NOT probed here (see file
    //    doc comment): `deriveNonceAccountAddress` is deterministic PER
    //    SOURCE WALLET, so a fresh prepare from the SAME wallet A to a
    //    DIFFERENT destination/amount would still land on A's own nonce
    //    account and could legitimately be refused by a per-nonce-account or
    //    per-wallet #797 fix — that would be the fix working as intended,
    //    not an over-block this test should assert against. To stay
    //    design-agnostic, this control instead uses a wallet with NO
    //    relationship whatsoever to wallet A: a different keypair, hence a
    //    different `deriveNonceAccountAddress` PDA, unrelated under every
    //    granularity (handle / nonce-account / wallet) a #797 fix might
    //    choose. A DIFFERENT destination AND amount too, so nothing about
    //    this transfer overlaps wallet A's pending ambiguous send.
    const draftB = await buildSolanaNativeSend({
      wallet: WALLET_B,
      to: RECIPIENT_B,
      amount: "0.25",
    });

    // 3. Preview the unrelated wallet's fresh handle. It MUST succeed — a
    //    #797 fix must not have blast radius wide enough to block a transfer
    //    with zero relationship to the pending ambiguous broadcast.
    const secondPin = await previewSolanaSend({ handle: draftB.handle });
    expect(isSignableTx(secondPin)).toBe(true);
  });
});
