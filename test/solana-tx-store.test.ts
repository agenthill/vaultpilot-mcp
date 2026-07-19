/**
 * Regression for issue #742 — `pinSolanaHandle` must deep-freeze the pinned
 * tx it stores, mirroring #710/#730's fix in `tx-store.ts`. Today
 * `consumeSolanaHandle` returns `entry.pinned` by reference with no freeze:
 * a mutation on the object it hands back sticks silently, so a later
 * `consumeSolanaHandle` on the same handle sees the tampered value.
 *
 * `entry.draft` stays intentionally unfrozen — `previewSolanaSend`
 * (execution/index.ts) legitimately mutates `draft.meta.nonce.value` in
 * place on the object `getSolanaDraft` hands back, to refresh the nonce
 * before re-pinning a durable-nonce tx. That's this store's version of
 * #730's "wrapper carries mutable metadata" carve-out — freezing `draft`
 * would break that live path, so only the finalized `pinned` tx is frozen.
 */
import { describe, it, expect } from "vitest";
import { PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import type { SolanaDraftMeta } from "../src/signing/solana-tx-store.js";
import {
  issueSolanaDraftHandle,
  pinSolanaHandle,
  consumeSolanaHandle,
  getSolanaDraft,
} from "../src/signing/solana-tx-store.js";

const WALLET = new PublicKey("4FLpszPQR1Cno8TDnEwYHzxhQSJQAWvb7mMzynArAQGf");
const BLOCKHASH = "HXSG2e3m7nYQL1LkRKksi2r1EH1Sd5sCQqTeyBJVeKkh";

function legacyDraft(meta: SolanaDraftMeta) {
  const draftTx = new Transaction().add(
    SystemProgram.transfer({ fromPubkey: WALLET, toPubkey: WALLET, lamports: 1 }),
  );
  draftTx.feePayer = WALLET;
  return { kind: "legacy" as const, draftTx, meta };
}

describe("solana-tx-store: pinSolanaHandle freeze (#742)", () => {
  it("keeps the stored pinned tx's top-level field unchanged after a mutation attempt", () => {
    const { handle } = issueSolanaDraftHandle(
      legacyDraft({
        action: "native_send",
        from: WALLET.toBase58(),
        description: "Send 1 SOL",
        decoded: { functionName: "solana.system.transfer", args: { amount: "1 SOL" } },
      }),
    );
    pinSolanaHandle(handle, BLOCKHASH);

    const stored = consumeSolanaHandle(handle);
    expect(() => {
      (stored as { description: string }).description = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeSolanaHandle(handle);
    expect(rereadAfterMutationAttempt.description).toBe("Send 1 SOL");
  });

  it("keeps the stored pinned tx's nested verification field unchanged after a mutation attempt", () => {
    const { handle } = issueSolanaDraftHandle(
      legacyDraft({
        action: "native_send",
        from: WALLET.toBase58(),
        description: "Send 1 SOL",
        decoded: { functionName: "solana.system.transfer", args: { amount: "1 SOL" } },
      }),
    );
    pinSolanaHandle(handle, BLOCKHASH);

    const stored = consumeSolanaHandle(handle);
    const originalArgs = stored.verification!.humanDecode.args;

    expect(() => {
      (stored.verification!.humanDecode as { args: unknown }).args = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeSolanaHandle(handle);
    expect(rereadAfterMutationAttempt.verification!.humanDecode.args).toBe(originalArgs);
  });

  it("regression: draft.meta.nonce.value stays mutable so preview can refresh a durable nonce before pinning", () => {
    const { handle } = issueSolanaDraftHandle(
      legacyDraft({
        action: "native_send",
        from: WALLET.toBase58(),
        description: "Send 1 SOL (durable nonce)",
        decoded: { functionName: "solana.system.transfer", args: { amount: "1 SOL" } },
        nonce: { account: WALLET.toBase58(), authority: WALLET.toBase58(), value: BLOCKHASH },
      }),
    );

    const draft = getSolanaDraft(handle);
    const freshNonce = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    // This is the exact mutation `previewSolanaSend` performs in
    // execution/index.ts before re-calling pinSolanaHandle for a
    // durable-nonce refresh — must NOT throw.
    expect(() => {
      draft.meta.nonce!.value = freshNonce;
    }).not.toThrow();

    const pinned = pinSolanaHandle(handle, freshNonce);
    expect(pinned.recentBlockhash).toBe(freshNonce);
  });
});
