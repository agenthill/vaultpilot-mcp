/**
 * Regression for issue #742 — `issueBitcoinHandle` must deep-freeze the
 * stored tx, mirroring #710/#730's fix in `tx-store.ts`. Today
 * `consumeBitcoinHandle` returns `entry.tx` by reference with no freeze: a
 * mutation on the object it hands back sticks silently, so a later
 * `consumeBitcoinHandle` on the same handle sees the tampered value.
 */
import { describe, it, expect } from "vitest";
import type { UnsignedBitcoinTx } from "../src/types/index.js";
import {
  issueBitcoinHandle,
  consumeBitcoinHandle,
  __clearBitcoinTxStore,
} from "../src/signing/btc-tx-store.js";

function baseBtcTx(): Omit<UnsignedBitcoinTx, "handle" | "fingerprint"> {
  return {
    chain: "bitcoin",
    action: "native_send",
    from: "bc1qxyz",
    sources: [{ address: "bc1qxyz", path: "84'/0'/0'/0/0", publicKey: "02aa" }],
    inputSources: ["bc1qxyz"],
    psbtBase64: "cHNidP8=",
    accountPath: "84'/0'/0'",
    addressFormat: "bech32",
    description: "native BTC send",
    decoded: {
      functionName: "nativeTransfer",
      args: {},
      outputs: [
        {
          address: "bc1qrecipient",
          amountSats: "100000",
          amountBtc: "0.001",
          isChange: false,
        },
      ],
      sources: [
        { address: "bc1qxyz", pulledSats: "100500", pulledBtc: "0.001005", inputCount: 1 },
      ],
      feeSats: "500",
      feeBtc: "0.000005",
      feeRateSatPerVb: 5,
      rbfEligible: true,
    },
    vsize: 100,
  };
}

describe("btc-tx-store: issueBitcoinHandle freeze (#742)", () => {
  it("keeps the stored top-level tx field unchanged after a mutation attempt", () => {
    __clearBitcoinTxStore();
    const issued = issueBitcoinHandle(baseBtcTx());
    const handle = issued.handle!;

    const stored = consumeBitcoinHandle(handle);
    expect(() => {
      (stored as { description: string }).description = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeBitcoinHandle(handle);
    expect(rereadAfterMutationAttempt.description).toBe("native BTC send");
  });

  it("keeps the stored nested decoded field unchanged after a mutation attempt", () => {
    __clearBitcoinTxStore();
    const issued = issueBitcoinHandle(baseBtcTx());
    const handle = issued.handle!;

    const stored = consumeBitcoinHandle(handle);
    expect(() => {
      (stored.decoded.outputs[0] as { amountSats: string }).amountSats = "999999999";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeBitcoinHandle(handle);
    expect(rereadAfterMutationAttempt.decoded.outputs[0].amountSats).toBe("100000");
  });
});
