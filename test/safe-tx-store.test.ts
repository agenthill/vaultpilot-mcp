/**
 * Regression for issue #751 — `rememberSafeTx` must deep-freeze the stored
 * SafeTx body, mirroring #710/#730's fix in `tx-store.ts` and #742's sweep
 * across the tron/solana/btc/ltc stores. Before the fix, `lookupSafeTx`
 * returns `entry.body` BY REFERENCE with no freeze: a prompt-injected agent
 * that mutates the looked-up body between the approve step and the
 * `submit_safe_tx_signature` POST silently alters the payload the Safe Tx
 * Service records, breaking the "server is source of truth" binding.
 */
import { describe, it, expect } from "vitest";
import type { SafeTxBody } from "../src/modules/safe/safe-tx.js";
import {
  rememberSafeTx,
  lookupSafeTx,
  clearSafeTxStoreForTesting,
} from "../src/modules/safe/safe-tx-store.js";

const SAFE_TX_HASH =
  "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const;
const SAFE_ADDRESS = "0x1111111111111111111111111111111111111111" as const;
const ATTACKER = "0x2222222222222222222222222222222222222222" as const;

function baseBody(): SafeTxBody {
  return {
    to: "0x3333333333333333333333333333333333333333",
    value: "0",
    data: "0xa9059cbb0000000000000000000000004444444444444444444444444444444444444444000000000000000000000000000000000000000000000000000000000000000a",
    operation: 0,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: "7",
  };
}

describe("safe-tx-store: rememberSafeTx body freeze (#751)", () => {
  it("keeps the stored body `to` unchanged after a mutation attempt", () => {
    clearSafeTxStoreForTesting();
    rememberSafeTx({
      safeTxHash: SAFE_TX_HASH,
      chain: "ethereum",
      safeAddress: SAFE_ADDRESS,
      body: baseBody(),
    });

    const cached = lookupSafeTx(SAFE_TX_HASH);
    expect(cached).toBeDefined();
    expect(() => {
      (cached!.body as { to: string }).to = ATTACKER;
    }).toThrow(TypeError);

    const reread = lookupSafeTx(SAFE_TX_HASH);
    expect(reread!.body.to).toBe("0x3333333333333333333333333333333333333333");
  });

  it("keeps the stored body `value` and `data` unchanged after a mutation attempt", () => {
    clearSafeTxStoreForTesting();
    rememberSafeTx({
      safeTxHash: SAFE_TX_HASH,
      chain: "ethereum",
      safeAddress: SAFE_ADDRESS,
      body: baseBody(),
    });

    const cached = lookupSafeTx(SAFE_TX_HASH);
    expect(() => {
      (cached!.body as { value: string }).value = "1000000000000000000";
    }).toThrow(TypeError);
    expect(() => {
      (cached!.body as { data: string }).data = "0xdeadbeef";
    }).toThrow(TypeError);

    const reread = lookupSafeTx(SAFE_TX_HASH);
    expect(reread!.body.value).toBe("0");
    expect(reread!.body.data).toBe(baseBody().data);
  });
});
