/**
 * Tests for the eth_call simulation path:
 *   - simulate_transaction tool runs an eth_call and decodes reverts
 *   - prepare_* populates tx.simulation so the preview carries the result
 *   - send_transaction refuses to forward a tx that simulates as a revert,
 *     preventing the user from burning gas on a guaranteed failure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { BaseError } from "viem";

describe("simulate_transaction tool", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("returns ok:true + returnData for a successful eth_call", async () => {
    const callMock = vi.fn().mockResolvedValue({ data: "0xdeadbeef" });
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ call: callMock }),
      resetClients: () => {},
    }));

    const { simulateTransaction } = await import("../src/modules/simulation/index.js");
    const result = await simulateTransaction({
      chain: "ethereum",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      value: "500000000000000000",
    });
    expect(result.ok).toBe(true);
    expect(result.returnData).toBe("0xdeadbeef");
    expect(callMock).toHaveBeenCalledWith(
      expect.objectContaining({
        account: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
        to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        data: "0x",
        value: 500000000000000000n,
      })
    );
  });

  it("returns ok:false + decoded revertReason when the call reverts", async () => {
    class FakeCallError extends BaseError {
      constructor() {
        super("Execution reverted", {
          details: "ERC20: transfer amount exceeds balance",
        });
        this.shortMessage = "Execution reverted with reason: ERC20: transfer amount exceeds balance";
      }
    }
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        call: vi.fn().mockRejectedValue(new FakeCallError()),
      }),
      resetClients: () => {},
    }));

    const { simulateTransaction } = await import("../src/modules/simulation/index.js");
    const result = await simulateTransaction({
      chain: "ethereum",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      data: "0xa9059cbb000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000ffff",
    });
    expect(result.ok).toBe(false);
    expect(result.revertReason).toContain("ERC20: transfer amount exceeds balance");
  });
});

describe("preview_send runs guards and pins fees; send_transaction consumes the pin", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("preview_send refuses when the tx will revert (guards run at preview time)", async () => {
    const requestSendMock = vi.fn().mockResolvedValue("0xhash");
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: requestSendMock,
      getConnectedAccounts: async () => [],
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        call: vi.fn().mockRejectedValue(
          Object.assign(new BaseError("Execution reverted"), {
            shortMessage: "Execution reverted with reason: insufficient allowance",
          })
        ),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/signing/pre-sign-check.js", () => ({
      assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
    }));

    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles({
      chain: "ethereum",
      to: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
      data: "0x23b872dd000000000000000000000000000000000000000000000000000000000000dead000000000000000000000000000000000000000000000000000000000000beef0000000000000000000000000000000000000000000000000000000000000064" as `0x${string}`,
      value: "0",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361" as `0x${string}`,
      description: "transferFrom test",
    });

    const { previewSend } = await import("../src/modules/execution/index.js");
    await expect(previewSend({ handle: stamped.handle! })).rejects.toThrow(
      /Pre-sign simulation failed/,
    );
    // Critical: the WalletConnect request was never made — no gas burned, no
    // user approval prompt on Ledger for a guaranteed-to-fail tx. Catching
    // the revert at preview time also means no Ledger device prompt appears
    // after the user has already matched a hash.
    expect(requestSendMock).not.toHaveBeenCalled();
  });

  it("send_transaction refuses when preview_send was skipped (no pin on the handle)", async () => {
    const requestSendMock = vi.fn().mockResolvedValue("0xhash");
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: requestSendMock,
      getConnectedAccounts: async () => [
        "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      ],
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({ call: vi.fn().mockResolvedValue({ data: "0x" }) }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/signing/pre-sign-check.js", () => ({
      assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
    }));

    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles({
      chain: "ethereum",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      data: "0x",
      value: "1",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      description: "test",
    });

    const { sendTransaction } = await import("../src/modules/execution/index.js");
    await expect(
      sendTransaction({ handle: stamped.handle!, confirmed: true }),
    ).rejects.toThrow(/Missing pinned gas/);
    // The protocol split is load-bearing: without preview_send the user never
    // saw the LEDGER BLIND-SIGN HASH block, so the on-device hash would be
    // unverifiable. Refusing to proceed is the correct action.
    expect(requestSendMock).not.toHaveBeenCalled();
  });

  it("preview_send + send_transaction: pin flows through to WalletConnect", async () => {
    const requestSendMock = vi.fn().mockResolvedValue("0xabc123");
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: requestSendMock,
      getConnectedAccounts: async () => [
        "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      ],
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        call: vi.fn().mockResolvedValue({ data: "0x" }),
        // preview_send calls these to pin fees server-side.
        getTransactionCount: vi.fn().mockResolvedValue(7),
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
        estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
        estimateGas: vi.fn().mockResolvedValue(21_000n),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/signing/pre-sign-check.js", () => ({
      assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
    }));

    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles({
      chain: "ethereum",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      data: "0x",
      value: "500000000000000000",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      description: "wrap ETH",
    });

    const { previewSend, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const preview = await previewSend({ handle: stamped.handle! });
    expect(preview.preSignHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(preview.pinned).toEqual({
      nonce: 7,
      // baseFee * 2 + max(priority, 0.05 gwei) = 20 gwei + 2 gwei = 22 gwei
      maxFeePerGas: 22_000_000_000n.toString(),
      maxPriorityFeePerGas: 2_000_000_000n.toString(),
      gas: 21_000n.toString(),
      // Issue #650 — live base fee surfaced for the preview-time cost
      // breakdown. The mock returns baseFeePerGas: 10 gwei.
      baseFeePerGas: 10_000_000_000n.toString(),
    });
    expect(preview.previewToken).toMatch(/^[0-9a-f-]{36}$/);

    const result = await sendTransaction({
      handle: stamped.handle!,
      confirmed: true,
      previewToken: preview.previewToken,
      userDecision: "send",
    });
    expect(result.txHash).toBe("0xabc123");
    expect(requestSendMock).toHaveBeenCalledTimes(1);
    // The pin forwarded to WalletConnect is the exact tuple preview_send
    // stashed — this equality is what makes the on-device hash deterministic.
    const pinned = requestSendMock.mock.calls[0][1];
    expect(pinned).toEqual({
      nonce: 7,
      maxFeePerGas: 22_000_000_000n,
      maxPriorityFeePerGas: 2_000_000_000n,
      gas: 21_000n,
    });
    expect(result.preSignHash).toBe(preview.preSignHash);
    expect(result.to).toBe("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
    expect(result.valueWei).toBe("500000000000000000");
  });

  it("priority-fee floor: bumps to 0.05 gwei when node estimate is lower", async () => {
    const requestSendMock = vi.fn().mockResolvedValue("0xabc");
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: requestSendMock,
      getConnectedAccounts: async () => [
        "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      ],
    }));
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => ({
        call: vi.fn().mockResolvedValue({ data: "0x" }),
        getTransactionCount: vi.fn().mockResolvedValue(1),
        getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 5_000_000_000n }),
        // Node reports 20 mwei priority on a quiet block — below the floor.
        estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(20_000_000n),
        estimateGas: vi.fn().mockResolvedValue(21_000n),
      }),
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/signing/pre-sign-check.js", () => ({
      assertTransactionSafe: vi.fn().mockResolvedValue(undefined),
    }));

    const { issueHandles } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles({
      chain: "ethereum",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      data: "0x",
      value: "1",
      from: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      description: "floor test",
    });

    const { previewSend } = await import("../src/modules/execution/index.js");
    const preview = await previewSend({ handle: stamped.handle! });
    // Floor applied: priority clamped to 0.05 gwei, maxFee = 5*2 + 0.05 = 10.05 gwei.
    expect(preview.pinned.maxPriorityFeePerGas).toBe("50000000");
    expect(preview.pinned.maxFeePerGas).toBe("10050000000");
  });
});

describe("prepare_* populates tx.simulation", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("attaches simulation.ok when eth_call succeeds", async () => {
    const client = {
      call: vi.fn().mockResolvedValue({ data: "0x" }),
      estimateGas: vi.fn().mockResolvedValue(21000n),
      getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => undefined,
      getTokenPrices: async () => new Map(),
    }));

    const { prepareNativeSend } = await import("../src/modules/execution/index.js");
    const tx = await prepareNativeSend({
      wallet: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      chain: "ethereum",
      to: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      amount: "0.5",
    });
    expect(tx.simulation?.ok).toBe(true);
    expect(client.call).toHaveBeenCalled();
  });

  it("attaches simulation.revertReason when eth_call reverts", async () => {
    class FakeCallError extends BaseError {
      constructor() {
        super("Execution reverted");
        this.shortMessage = "Execution reverted with reason: destination rejected";
      }
    }
    const client = {
      call: vi.fn().mockRejectedValue(new FakeCallError()),
      estimateGas: vi.fn().mockRejectedValue(new Error("estimation failed")),
      getGasPrice: vi.fn().mockResolvedValue(1_000_000_000n),
    };
    vi.doMock("../src/data/rpc.js", () => ({
      getClient: () => client,
      verifyChainId: vi.fn().mockResolvedValue(undefined),
      resetClients: () => {},
    }));
    vi.doMock("../src/data/prices.js", () => ({
      getTokenPrice: async () => undefined,
      getTokenPrices: async () => new Map(),
    }));

    const { prepareNativeSend } = await import("../src/modules/execution/index.js");
    const tx = await prepareNativeSend({
      wallet: "0x8F9dE85C01070D2762d29A6Dd7ffEcC965b34361",
      chain: "ethereum",
      to: "0x1111111111111111111111111111111111111111",
      amount: "0.01",
    });
    expect(tx.simulation?.ok).toBe(false);
    expect(tx.simulation?.revertReason).toContain("destination rejected");
  });
});
