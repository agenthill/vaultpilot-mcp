/**
 * Issue #761 — Safe `execTransaction` / `approveHash` inner-payload pre-sign gate.
 *
 * Before the fix, `assertTransactionSafe` block 4 waved a `safeTxOrigin`-stamped
 * OUTER tx through on the stamp alone and never decoded the INNER action it
 * authorizes. So an inner `transfer(attacker, balance)` (recipient hidden behind
 * the 4-byte-truncated inner `data`) or an inner DELEGATECALL takeover rode
 * through unexamined. These tests are the RED→GREEN falsifiers:
 *
 *  - inner `transfer(attacker, …)` on a recognized token → REFUSE (RED on main).
 *  - inner `operation: 1` (DELEGATECALL) → refuse without the explicit ack,
 *    both at build time (prepare_safe_tx_propose) and at pre-sign (execute).
 *  - the legitimate propose → send happy path (inner routed to the Safe) still
 *    passes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encodeFunctionData } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { assertTransactionSafe } from "../src/signing/pre-sign-check.js";
import { prepareSafeTxPropose } from "../src/modules/safe/actions.js";
import { prepareSafeTxExecute } from "../src/modules/safe/execute.js";
import {
  rememberSafeTx,
  clearSafeTxStoreForTesting,
} from "../src/modules/safe/safe-tx-store.js";
import { buildSafeTxBody } from "../src/modules/safe/safe-tx.js";

// Mock the Safe SDK + RPC so the builders run without a live API key / node.
const mockKit = {
  getNextNonce: vi.fn(async () => "12"),
  getTransaction: vi.fn(),
};
vi.mock("../src/modules/safe/sdk.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/modules/safe/sdk.js")>();
  return { ...actual, getSafeApiKit: () => mockKit };
});

const mockClient = { readContract: vi.fn() };
vi.mock("../src/data/rpc.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/data/rpc.js")>();
  return { ...actual, getClient: () => mockClient };
});

const SAFE = "0x1111111111111111111111111111111111111111";
const SIGNER = "0x742d35cc6634c0532925a3b844bc9e7595f8b8b8";
const OWNER = "0x9999999999999999999999999999999999999999";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function transferCalldata(to: string, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
  });
}

function safeTxHash(): `0x${string}` {
  return `0x${"ab".repeat(32)}` as `0x${string}`;
}

function setExecuteOnChainState(): void {
  // Threshold 1, executor is the sole owner and has approved → execute builds.
  mockClient.readContract.mockImplementation(
    (req: { functionName: string; args?: unknown[] }) => {
      if (req.functionName === "getThreshold") return Promise.resolve(1n);
      if (req.functionName === "getOwners") return Promise.resolve([OWNER]);
      if (req.functionName === "approvedHashes") return Promise.resolve(1n);
      return Promise.resolve(0n);
    },
  );
}

beforeEach(() => {
  clearSafeTxStoreForTesting();
  mockKit.getNextNonce.mockReset();
  mockKit.getNextNonce.mockResolvedValue("12");
  mockClient.readContract.mockReset();
  // Default for propose nonce resolution: on-chain nonce below service nonce.
  mockClient.readContract.mockResolvedValue(11n);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("#761 propose(approveHash) — inner ERC-20 transfer", () => {
  it("REFUSES an inner transfer(attacker, balance) on a recognized token", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: USDC_ETH, value: "0", data: transferCalldata(ATTACKER, 10_000_000n), operation: 0 },
    });
    // Sanity: the OUTER is the approveHash wrapper stamped safeTxOrigin.
    expect(outer.data.slice(0, 10)).toBe("0xd4d9bdcd");
    expect(outer.safeTxOrigin).toBe(true);

    // RED on main (block 4 returned early); GREEN after (inner recipient gated).
    await expect(assertTransactionSafe(outer)).rejects.toThrow(
      /Pre-sign check: refusing transfer\(\)/,
    );
  });

  it("ACCEPTS an inner transfer routed back to the Safe (happy path)", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: USDC_ETH, value: "0", data: transferCalldata(SAFE, 10_000_000n), operation: 0 },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });

  it("ACCEPTS the documented plain-native propose → send happy path", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: SAFE, value: "1000", data: "0x", operation: 0 },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });
});

describe("#761 execute(execTransaction) — inner ERC-20 transfer", () => {
  it("REFUSES an inner transfer(attacker, balance)", async () => {
    rememberSafeTx({
      safeTxHash: safeTxHash(),
      chain: "ethereum",
      safeAddress: SAFE as `0x${string}`,
      body: buildSafeTxBody({
        to: USDC_ETH as `0x${string}`,
        value: "0",
        data: transferCalldata(ATTACKER, 10_000_000n),
        operation: 0,
        nonce: "5",
      }),
    });
    setExecuteOnChainState();
    const outer = await prepareSafeTxExecute({
      executor: OWNER,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash(),
    });
    expect(outer.data.slice(0, 10)).toBe("0x6a761202"); // execTransaction
    expect(outer.safeTxOrigin).toBe(true);

    await expect(assertTransactionSafe(outer)).rejects.toThrow(
      /Pre-sign check: refusing transfer\(\)/,
    );
  });
});

describe("#761 DELEGATECALL (operation 1) requires the explicit ack", () => {
  it("propose REFUSES operation:1 without acknowledgeSafeDelegateCall", async () => {
    await expect(
      prepareSafeTxPropose({
        signer: SIGNER,
        safeAddress: SAFE,
        chain: "ethereum",
        inner: { to: ATTACKER, value: "0", data: "0x", operation: 1 },
      }),
    ).rejects.toThrow(/acknowledgeSafeDelegateCall/);
  });

  it("propose ACCEPTS operation:1 with the ack and stamps the tx", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: SAFE, value: "0", data: "0x", operation: 1 },
      acknowledgeSafeDelegateCall: true,
    });
    expect(outer.acknowledgedSafeDelegateCall).toBe(true);
    // Inner is a plain (data-less) DELEGATECALL to the Safe → the ack unlocks it.
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });

  it("pre-sign REFUSES an execTransaction whose inner operation is DELEGATECALL (no stamp)", async () => {
    rememberSafeTx({
      safeTxHash: safeTxHash(),
      chain: "ethereum",
      safeAddress: SAFE as `0x${string}`,
      body: buildSafeTxBody({
        to: ATTACKER as `0x${string}`,
        value: "0",
        data: "0x",
        operation: 1,
        nonce: "5",
      }),
    });
    setExecuteOnChainState();
    const outer = await prepareSafeTxExecute({
      executor: OWNER,
      safeAddress: SAFE,
      chain: "ethereum",
      safeTxHash: safeTxHash(),
    });
    await expect(assertTransactionSafe(outer)).rejects.toThrow(/DELEGATECALL/);
  });
});
