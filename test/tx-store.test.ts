/**
 * Regression for issue #710 — `issueHandles` must deep-freeze the stored tx
 * so a later in-place mutation on the object returned by `consumeHandle`
 * cannot alter what a subsequent read of the same handle sees. Today the
 * stored copy is a plain shallow-spread object with no `Object.freeze`:
 * mutating a nested field (e.g. `verification.humanDecode`) sticks, because
 * `withHandle` (returned to the caller) and the stored `tx` share the same
 * nested `verification` reference.
 */
import { describe, it, expect } from "vitest";
import type { UnsignedTx } from "../src/types/index.js";
import { issueHandles, consumeHandle } from "../src/signing/tx-store.js";

function baseTx(): UnsignedTx {
  return {
    chain: "ethereum",
    to: "0x1111111111111111111111111111111111111111",
    data: "0x",
    value: "1000000000000000000",
    description: "native send",
  };
}

describe("tx-store: issueHandles freeze (#710)", () => {
  it("keeps the stored top-level tx field unchanged after a mutation attempt", () => {
    const issued = issueHandles(baseTx());
    const handle = issued.handle!;

    const stored = consumeHandle(handle);
    expect(() => {
      (stored as { description: string }).description = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeHandle(handle);
    expect(rereadAfterMutationAttempt.description).toBe("native send");
  });

  it("keeps the stored nested verification field unchanged after a mutation attempt", () => {
    const issued = issueHandles(baseTx());
    const handle = issued.handle!;

    const stored = consumeHandle(handle);
    const originalHumanDecode = stored.verification!.humanDecode;

    expect(() => {
      (stored.verification as { humanDecode: string }).humanDecode = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeHandle(handle);
    expect(rereadAfterMutationAttempt.verification!.humanDecode).toBe(originalHumanDecode);
    expect(rereadAfterMutationAttempt.verification!.humanDecode).not.toBe("TAMPERED");
  });
});
