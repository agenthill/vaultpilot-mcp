/**
 * Issue #761 — Safe `execTransaction` / `approveHash` inner-payload pre-sign gate.
 *
 * Before the fix, `assertTransactionSafe` block 4 waved a `safeTxOrigin`-stamped
 * OUTER tx through on the stamp alone and never decoded the INNER action it
 * authorizes. These tests are the RED→GREEN falsifiers for every shape the
 * reviewer named, and the ALLOW cases that prove the gate does not over-block
 * legitimate Safe payments:
 *
 *  BLOCKING — an inner NATIVE send `{to: attacker, value: balance, data: "0x"}`
 *    drains the Safe: it skips block 1 (empty data) AND the recipient seam
 *    (null dest). It MUST be refused; a native send to your own wallet / the
 *    Safe is still allowed.
 *  IMPORTANT — the inner gate must apply the SAME rules a DIRECT call receives
 *    (comparand = connected wallet, NOT the Safe): a legit `transfer(vendor)` or
 *    `Aave withdraw(..., to=your wallet)` is ACCEPTED, while a protocol
 *    recipient-drain `Aave withdraw(..., to=attacker)` is REFUSED.
 *  IMPORTANT — an `approveHash` whose SafeTx body is NOT in this server's
 *    custody (externally proposed / expired) cannot be decoded, so it FAILS
 *    CLOSED (a prior revision accepted it blind).
 *  DELEGATECALL (operation 1) is refused without the explicit ack.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { aavePoolAbi } from "../src/abis/aave-pool.js";
import { safeMultisigAbi } from "../src/abis/safe-multisig.js";
import { assertTransactionSafe } from "../src/signing/pre-sign-check.js";
import { prepareSafeTxPropose } from "../src/modules/safe/actions.js";
import { prepareSafeTxExecute } from "../src/modules/safe/execute.js";
import {
  rememberSafeTx,
  clearSafeTxStoreForTesting,
} from "../src/modules/safe/safe-tx-store.js";
import { buildSafeTxBody } from "../src/modules/safe/safe-tx.js";
import type { UnsignedTx } from "../src/types/index.js";

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
const AAVE_POOL = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const VENDOR = "0xcccccccccccccccccccccccccccccccccccccccc";

function transferCalldata(to: string, amount: bigint): `0x${string}` {
  return encodeFunctionData({
    abi: erc20Abi,
    functionName: "transfer",
    args: [to as `0x${string}`, amount],
  });
}

function aaveWithdrawCalldata(to: string): `0x${string}` {
  return encodeFunctionData({
    abi: aavePoolAbi as Abi,
    functionName: "withdraw",
    args: [USDC_ETH as `0x${string}`, 1_000_000n, to as `0x${string}`],
  });
}

function safeTxHash(): `0x${string}` {
  return `0x${"ab".repeat(32)}` as `0x${string}`;
}

/** An OUTER approveHash tx for a hash whose body was NEVER stashed here. */
function externalApproveHashTx(): UnsignedTx {
  return {
    chain: "ethereum",
    to: SAFE as `0x${string}`,
    data: encodeFunctionData({
      abi: safeMultisigAbi,
      functionName: "approveHash",
      args: [safeTxHash()],
    }),
    value: "0",
    from: SIGNER as `0x${string}`,
    description: "Approve externally-proposed Safe tx (body not in local cache).",
    safeTxOrigin: true,
  };
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

describe("#761 BLOCKING — inner NATIVE-value drain", () => {
  it("propose REFUSES an inner native send {to: attacker, value: balance, data: 0x}", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: ATTACKER, value: "1000000000000000000", data: "0x", operation: 0 },
    });
    expect(outer.safeTxOrigin).toBe(true);
    // RED before rework: block 1 (empty data) + null-dest recipient seam both
    // early-returned, so the native drain rode through. GREEN after.
    await expect(assertTransactionSafe(outer)).rejects.toThrow(/NATIVE transfer/);
  });

  it("execute REFUSES an inner native send {to: attacker, value: balance, data: 0x}", async () => {
    rememberSafeTx({
      safeTxHash: safeTxHash(),
      chain: "ethereum",
      safeAddress: SAFE as `0x${string}`,
      body: buildSafeTxBody({
        to: ATTACKER as `0x${string}`,
        value: "1000000000000000000",
        data: "0x",
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
    await expect(assertTransactionSafe(outer)).rejects.toThrow(/NATIVE transfer/);
  });

  it("ACCEPTS an inner native send to the connected wallet", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: SIGNER, value: "1000000000000000000", data: "0x", operation: 0 },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });

  it("ACCEPTS the documented plain-native send back to the Safe (happy path)", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: SAFE, value: "1000", data: "0x", operation: 0 },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });
});

describe("#761 IMPORTANT — inner recipient rules match a DIRECT call (no Safe-only comparand)", () => {
  it("ACCEPTS an inner user-directed transfer(vendor) on a recognized token", async () => {
    // A direct `transfer(vendor)` passes the pre-sign gate (user-directed); the
    // inner is treated identically, and the real recipient is surfaced to the
    // user by describeSafeTxBody's #761 inner-target line.
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: { to: USDC_ETH, value: "0", data: transferCalldata(VENDOR, 10_000_000n), operation: 0 },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });

  it("ACCEPTS an inner Aave withdraw(..., to=connected wallet)", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: {
        to: AAVE_POOL,
        value: "0",
        data: aaveWithdrawCalldata(getAddress(SIGNER)),
        operation: 0,
      },
    });
    await expect(assertTransactionSafe(outer)).resolves.toBeUndefined();
  });

  it("REFUSES an inner Aave withdraw(..., to=attacker) — protocol recipient drain", async () => {
    const outer = await prepareSafeTxPropose({
      signer: SIGNER,
      safeAddress: SAFE,
      chain: "ethereum",
      inner: {
        to: AAVE_POOL,
        value: "0",
        data: aaveWithdrawCalldata(ATTACKER),
        operation: 0,
      },
    });
    await expect(assertTransactionSafe(outer)).rejects.toThrow(
      /not your connected wallet/,
    );
  });
});

describe("#761 IMPORTANT — fail closed on an unresolvable inner body", () => {
  it("REFUSES an approveHash whose SafeTx body is not in this server's custody", async () => {
    // Externally-proposed / expired: nothing stashed for this hash, so the inner
    // action cannot be decoded. A prior revision accepted it blind (fail-open).
    const outer = externalApproveHashTx();
    await expect(assertTransactionSafe(outer)).rejects.toThrow(
      /not in this server's custody/,
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
