/**
 * Regression for issue #742 — `issueLitecoinHandle` must deep-freeze the
 * stored tx, mirroring #710/#730's fix in `tx-store.ts`. Today
 * `consumeLitecoinHandle` returns `entry.tx` by reference with no freeze: a
 * mutation on the object it hands back sticks silently, so a later
 * `consumeLitecoinHandle` on the same handle sees the tampered value.
 */
import { describe, it, expect } from "vitest";
import type { UnsignedLitecoinTx } from "../src/types/index.js";
import {
  issueLitecoinHandle,
  consumeLitecoinHandle,
  __clearLitecoinTxStore,
} from "../src/signing/ltc-tx-store.js";

function baseLtcTx(): Omit<UnsignedLitecoinTx, "handle" | "fingerprint"> {
  return {
    chain: "litecoin",
    action: "native_send",
    from: "ltc1qxyz",
    sources: [{ address: "ltc1qxyz", path: "84'/2'/0'/0/0", publicKey: "02aa" }],
    inputSources: ["ltc1qxyz"],
    psbtBase64: "cHNidP8=",
    accountPath: "84'/2'/0'",
    addressFormat: "bech32",
    description: "native LTC send",
    decoded: {
      functionName: "nativeTransfer",
      args: {},
      outputs: [
        {
          address: "ltc1qrecipient",
          amountSats: "100000",
          amountBtc: "0.001",
          isChange: false,
        },
      ],
      sources: [
        { address: "ltc1qxyz", pulledSats: "100500", pulledBtc: "0.001005", inputCount: 1 },
      ],
      feeSats: "500",
      feeBtc: "0.000005",
      feeRateSatPerVb: 5,
      rbfEligible: true,
    },
    vsize: 100,
  };
}

describe("ltc-tx-store: issueLitecoinHandle freeze (#742)", () => {
  it("keeps the stored top-level tx field unchanged after a mutation attempt", () => {
    __clearLitecoinTxStore();
    const issued = issueLitecoinHandle(baseLtcTx());
    const handle = issued.handle!;

    const stored = consumeLitecoinHandle(handle);
    expect(() => {
      (stored as { description: string }).description = "TAMPERED";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeLitecoinHandle(handle);
    expect(rereadAfterMutationAttempt.description).toBe("native LTC send");
  });

  it("keeps the stored nested decoded field unchanged after a mutation attempt", () => {
    __clearLitecoinTxStore();
    const issued = issueLitecoinHandle(baseLtcTx());
    const handle = issued.handle!;

    const stored = consumeLitecoinHandle(handle);
    expect(() => {
      (stored.decoded.outputs[0] as { amountSats: string }).amountSats = "999999999";
    }).toThrow(TypeError);

    const rereadAfterMutationAttempt = consumeLitecoinHandle(handle);
    expect(rereadAfterMutationAttempt.decoded.outputs[0].amountSats).toBe("100000");
  });
});
