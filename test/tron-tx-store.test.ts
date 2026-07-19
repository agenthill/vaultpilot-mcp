/**
 * Regression for issue #742 — `issueTronHandle` must deep-freeze the stored
 * tx, mirroring #710/#730's fix in `tx-store.ts`. Today `consumeTronHandle`
 * returns `entry.tx` by reference with no freeze: a mutation on the object
 * it hands back sticks silently, so a later `consumeTronHandle` on the same
 * handle sees the tampered value.
 */
import { describe, it, expect } from "vitest";
import type { UnsignedTronTx } from "../src/types/index.js";
import {
  issueTronHandle,
  consumeTronHandle,
} from "../src/signing/tron-tx-store.js";

function baseTronTx(): UnsignedTronTx {
  return {
    chain: "tron",
    action: "native_send",
    from: "TXYZabc1234567890abcdef1234567890abcd",
    txID: "deadbeef",
    rawDataHex: "0a",
    description: "native TRX send",
    decoded: { functionName: "nativeTransfer", args: {} },
  };
}

describe("tron-tx-store: issueTronHandle freeze (#742)", () => {
  it("keeps the stored top-level tx field unchanged after a mutation attempt", () => {
    const issued = issueTronHandle(baseTronTx());
    const handle = issued.handle!;

    const stored = consumeTronHandle(handle);
    expect(() => {
      (stored as { description: string }).description = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeTronHandle(handle);
    expect(rereadAfterMutationAttempt.description).toBe("native TRX send");
  });

  it("keeps the stored nested verification field unchanged after a mutation attempt", () => {
    const issued = issueTronHandle(baseTronTx());
    const handle = issued.handle!;

    const stored = consumeTronHandle(handle);
    const originalHumanDecode = stored.verification!.humanDecode;

    expect(() => {
      (stored.verification as { humanDecode: unknown }).humanDecode = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeTronHandle(handle);
    expect(rereadAfterMutationAttempt.verification!.humanDecode).toBe(originalHumanDecode);
    expect(rereadAfterMutationAttempt.verification!.humanDecode).not.toBe("TAMPERED");
  });
});
