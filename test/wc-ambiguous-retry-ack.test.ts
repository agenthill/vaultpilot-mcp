/**
 * Issue #326 P3 — handle-state ambiguous-attempt mark + the
 * `acknowledgeRetryRiskAfterAmbiguousFailure` ack gate on
 * `send_transaction`. Unit tests for the tx-store helpers and the
 * end-to-end gate behavior in the EVM `sendTransaction` handler.
 *
 * The full WalletConnect SDK isn't stubbed here — `requestSendTransaction`
 * is mocked at the module boundary so each test exercises the gate
 * logic in isolation, the way `walletconnect-send-liveness.test.ts`
 * does for the pre-publish liveness probe.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { CONTRACTS } from "../src/config/contracts.js";

const USDC = getAddress(CONTRACTS.ethereum.tokens.USDC);
const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");
const SENDER = getAddress("0x1111111111111111111111111111111111111111");

const PIN_FIELDS = {
  nonce: 7,
  maxFeePerGas: 30_000_000_000n,
  maxPriorityFeePerGas: 1_000_000_000n,
  gas: 100_000n,
  preSignHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
  pinnedAt: Date.now(),
};

beforeEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
});

function buildTx() {
  return {
    chain: "ethereum" as const,
    to: USDC,
    data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [RECIPIENT, 100n] }),
    value: "0",
    from: SENDER,
    description: "Send 100 USDC",
  };
}

describe("tx-store ambiguous-attempt helpers (P3)", () => {
  it("markAmbiguousAttempt + getAmbiguousAttempt round-trip on an issued handle", async () => {
    const { issueHandles } = await import("../src/signing/tx-store.js");
    const { markAmbiguousAttempt, getAmbiguousAttempt } = await import(
      "../src/signing/tx-store.js"
    );
    const stamped = issueHandles(buildTx());
    expect(getAmbiguousAttempt(stamped.handle!)).toBeUndefined();
    markAmbiguousAttempt(stamped.handle!, "no_broadcast");
    const out = getAmbiguousAttempt(stamped.handle!);
    expect(out?.kind).toBe("no_broadcast");
    expect(out?.at).toBeGreaterThan(0);
  });

  it("clearAmbiguousAttempt drops the mark", async () => {
    const { issueHandles, markAmbiguousAttempt, clearAmbiguousAttempt, getAmbiguousAttempt } =
      await import("../src/signing/tx-store.js");
    const stamped = issueHandles(buildTx());
    markAmbiguousAttempt(stamped.handle!, "ambiguous_disagreement");
    expect(getAmbiguousAttempt(stamped.handle!)).toBeDefined();
    clearAmbiguousAttempt(stamped.handle!);
    expect(getAmbiguousAttempt(stamped.handle!)).toBeUndefined();
  });

  it("getAmbiguousAttempt on an unknown handle returns undefined (no throw)", async () => {
    const { getAmbiguousAttempt } = await import("../src/signing/tx-store.js");
    expect(getAmbiguousAttempt("00000000-0000-0000-0000-000000000000")).toBeUndefined();
  });

  it("retireHandle clears the mark transitively (the entry is gone)", async () => {
    const { issueHandles, markAmbiguousAttempt, retireHandle, getAmbiguousAttempt } =
      await import("../src/signing/tx-store.js");
    const stamped = issueHandles(buildTx());
    markAmbiguousAttempt(stamped.handle!, "no_broadcast");
    retireHandle(stamped.handle!);
    expect(getAmbiguousAttempt(stamped.handle!)).toBeUndefined();
  });
});

describe("WalletConnectRequestTimeoutError carries a `kind` discriminator (P3)", () => {
  it("default kind is `unknown` for back-compat with legacy callers", async () => {
    const { WalletConnectRequestTimeoutError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectRequestTimeoutError("legacy");
    expect(e.kind).toBe("unknown");
  });

  it("kind round-trips for each post-probe outcome", async () => {
    const { WalletConnectRequestTimeoutError } = await import(
      "../src/signing/walletconnect.js"
    );
    const kinds = ["no_broadcast", "consumed_unmatched", "ambiguous_disagreement"] as const;
    for (const k of kinds) {
      const e = new WalletConnectRequestTimeoutError("msg", k);
      expect(e.kind).toBe(k);
      expect(e.name).toBe("WalletConnectRequestTimeoutError");
    }
  });
});

describe("sendTransaction (EVM) — ambiguous-retry ack gate (P3)", () => {
  /**
   * Mock the WC layer at the module boundary. The first call rejects
   * with a tagged timeout error (simulating the live #326 incident);
   * the second call resolves with a hash. The gate logic is what we're
   * testing — the WC mock just lets the gate run.
   */
  function stubWalletConnect(opts: {
    firstError?: { message: string; kind: "no_broadcast" | "consumed_unmatched" | "ambiguous_disagreement" } | null;
    secondHash?: `0x${string}`;
  }) {
    const requestSendTransaction = vi.fn();
    if (opts.firstError) {
      requestSendTransaction.mockImplementationOnce(async () => {
        const wc = await import("../src/signing/walletconnect.js");
        throw new wc.WalletConnectRequestTimeoutError(
          opts.firstError!.message,
          opts.firstError!.kind,
        );
      });
    }
    if (opts.secondHash) {
      requestSendTransaction.mockResolvedValueOnce(opts.secondHash);
    }
    vi.doMock("../src/signing/walletconnect.js", async () => {
      const actual = await vi.importActual<typeof import("../src/signing/walletconnect.js")>(
        "../src/signing/walletconnect.js",
      );
      return {
        ...actual,
        requestSendTransaction,
        // send_transaction now re-reads the connected-account set at send time
        // (recipient-authorization seam, #757/#760 design §5). Expose SENDER so
        // the fail-closed account-set precondition passes and these tests keep
        // exercising the ambiguous-retry gate rather than tripping the new one.
        getConnectedAccounts: async () => [SENDER],
      };
    });
    return { requestSendTransaction };
  }

  it("first attempt that times out with `no_broadcast` marks the handle and the second attempt without ack is refused", async () => {
    stubWalletConnect({
      firstError: { message: "no_broadcast — safe to retry but ambiguous", kind: "no_broadcast" },
    });
    const { issueHandles, attachPinnedGas, getAmbiguousAttempt } = await import(
      "../src/signing/tx-store.js"
    );
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(buildTx());
    attachPinnedGas(stamped.handle!, { ...PIN_FIELDS, previewToken: "tok-1" });

    // First attempt — WC timeout error propagates, handle gets marked.
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow(/no_broadcast/i);
    expect(getAmbiguousAttempt(stamped.handle!)?.kind).toBe("no_broadcast");

    // Second attempt without ack — refused with the recovery guidance,
    // WC layer NOT called again (the gate fires before
    // requestSendTransaction).
    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow(/acknowledgeRetryRiskAfterAmbiguousFailure/);
    // Mark survives (still not retired) — the gate refused without
    // clearing.
    expect(getAmbiguousAttempt(stamped.handle!)?.kind).toBe("no_broadcast");
  });

  it("second attempt WITH the ack flag clears the mark and proceeds; success retires the handle", async () => {
    const successHash = ("0x" + "ee".repeat(32)) as `0x${string}`;
    stubWalletConnect({
      firstError: { message: "no_broadcast", kind: "no_broadcast" },
      secondHash: successHash,
    });
    const { issueHandles, attachPinnedGas, getAmbiguousAttempt, hasHandle } = await import(
      "../src/signing/tx-store.js"
    );
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(buildTx());
    attachPinnedGas(stamped.handle!, { ...PIN_FIELDS, previewToken: "tok-1" });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow();
    expect(getAmbiguousAttempt(stamped.handle!)?.kind).toBe("no_broadcast");

    // Acknowledged retry succeeds.
    const result = await sendTransaction({
      handle: stamped.handle!,
      confirmed: true,
      previewToken: "tok-1",
      userDecision: "send",
      acknowledgeRetryRiskAfterAmbiguousFailure: true,
    });
    expect(result.txHash).toBe(successHash);
    expect(hasHandle(stamped.handle!)).toBe(false);
    expect(getAmbiguousAttempt(stamped.handle!)).toBeUndefined();
  });

  it("ambiguous_disagreement on attempt 1 → refusal copy mentions block explorer + 5-min wait + re-prepare path", async () => {
    stubWalletConnect({
      firstError: { message: "sources disagree", kind: "ambiguous_disagreement" },
    });
    const { issueHandles, attachPinnedGas } = await import("../src/signing/tx-store.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(buildTx());
    attachPinnedGas(stamped.handle!, { ...PIN_FIELDS, previewToken: "tok-1" });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow();

    // Second attempt without ack — refused; verify the per-kind copy.
    let captured: Error | null = null;
    try {
      await sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured!.message).toMatch(/block explorer/i);
    expect(captured!.message).toMatch(/re-prepare/i);
    expect(captured!.message).toMatch(/ambiguous_disagreement/);
    expect(captured!.message).toMatch(/#326/);
  });

  it("consumed_unmatched on attempt 1 → refusal copy says re-prepare, same-pin retry would fail at chain level", async () => {
    stubWalletConnect({
      firstError: { message: "slot consumed by another tx", kind: "consumed_unmatched" },
    });
    const { issueHandles, attachPinnedGas } = await import("../src/signing/tx-store.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(buildTx());
    attachPinnedGas(stamped.handle!, { ...PIN_FIELDS, previewToken: "tok-1" });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow();

    let captured: Error | null = null;
    try {
      await sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      });
    } catch (e) {
      captured = e as Error;
    }
    expect(captured).toBeInstanceOf(Error);
    expect(captured!.message).toMatch(/nonce too low/i);
    expect(captured!.message).toMatch(/re-prepare/i);
    expect(captured!.message).toMatch(/consumed_unmatched/);
  });

  it("legacy `unknown` kind (pre-probe path) does NOT set the mark (only structured probe outcomes do)", async () => {
    stubWalletConnect({
      firstError: { message: "raw timeout", kind: "no_broadcast" }, // placeholder
    });
    // Re-stub with `unknown`-kind error specifically.
    vi.resetModules();
    const wc = await import("../src/signing/walletconnect.js");
    vi.doMock("../src/signing/walletconnect.js", async () => {
      const actual = await vi.importActual<typeof import("../src/signing/walletconnect.js")>(
        "../src/signing/walletconnect.js",
      );
      return {
        ...actual,
        requestSendTransaction: vi.fn(async () => {
          throw new wc.WalletConnectRequestTimeoutError("legacy timeout, no probe ran");
          // default kind = "unknown"
        }),
        // Send-time account-set re-read (recipient-authorization seam) — expose
        // SENDER so the fail-closed precondition passes before the WC forward.
        getConnectedAccounts: async () => [SENDER],
      };
    });
    const { issueHandles, attachPinnedGas, getAmbiguousAttempt } = await import(
      "../src/signing/tx-store.js"
    );
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const stamped = issueHandles(buildTx());
    attachPinnedGas(stamped.handle!, { ...PIN_FIELDS, previewToken: "tok-1" });

    await expect(
      sendTransaction({
        handle: stamped.handle!,
        confirmed: true,
        previewToken: "tok-1",
        userDecision: "send",
      }),
    ).rejects.toThrow(/legacy timeout/);
    // Unknown-kind timeouts are NOT marked — they pre-date the probe
    // and only surface in test/legacy callers without pin or hash.
    expect(getAmbiguousAttempt(stamped.handle!)).toBeUndefined();
  });
});
