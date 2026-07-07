import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { encodeTransferRawData } from "./helpers/tron-raw-data-encode.js";
import { maybeTronBandwidthResponse } from "./helpers/tron-bandwidth-mock.js";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Phase-3 (TRON USB HID signing) tests.
 *
 * We mock `src/signing/tron-usb-loader.ts` — a thin wrapper that loads the
 * two Ledger CJS packages — rather than trying to mock the packages
 * themselves. The Ledger SDK's ESM build has broken relative imports
 * (missing `.js` extensions), so we route through a loader module; mocking
 * the loader is also simpler and keeps the test free of SDK coupling.
 */

type TrxStub = {
  getAddress: ReturnType<typeof vi.fn>;
  signTransaction: ReturnType<typeof vi.fn>;
  getAppConfiguration: ReturnType<typeof vi.fn>;
};

let openLedgerMock: ReturnType<typeof vi.fn>;
let trxInstance: TrxStub;
let transportCloseMock: ReturnType<typeof vi.fn>;

vi.mock("../src/signing/tron-usb-loader.js", () => ({
  openLedger: () => openLedgerMock(),
}));

const DEVICE_ADDRESS = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const OTHER_ADDRESS = "TMuA6YqfCeX8EhbfYEg5y7S4DqzSJireY9";
const RAW_HEX = "0a02487b2208b6f0a4c9dd5b6c";
// Realistic Transfer protobuf for flows that exercise buildTronNativeSend +
// the verifier. Tests not going through the builder can keep using RAW_HEX.
const TRANSFER_1TRX_DEVICE_TO_OTHER = encodeTransferRawData({
  from: DEVICE_ADDRESS,
  to: OTHER_ADDRESS,
  amountSun: 1_000_000n,
});
const TRANSFER_1TRX_OTHER_TO_DEVICE = encodeTransferRawData({
  from: OTHER_ADDRESS,
  to: DEVICE_ADDRESS,
  amountSun: 1_000_000n,
});
const GOOD_SIG = "a".repeat(130);

function makeTrxStub(overrides: Partial<TrxStub> = {}): TrxStub {
  return {
    getAppConfiguration: vi.fn(async () => ({ version: "0.7.4" })),
    getAddress: vi.fn(async () => ({ publicKey: "04abcd", address: DEVICE_ADDRESS })),
    signTransaction: vi.fn(async () => GOOD_SIG),
    ...overrides,
  };
}

function installStubs(overrides: Partial<TrxStub> = {}) {
  trxInstance = makeTrxStub(overrides);
  transportCloseMock = vi.fn(async () => {});
  openLedgerMock = vi.fn(async () => ({
    app: trxInstance,
    transport: { close: transportCloseMock },
  }));
}

function statusCodeError(code: number, message = "") {
  const e = new Error(message || `TransportStatusError 0x${code.toString(16)}`);
  (e as Error & { statusCode?: number }).statusCode = code;
  return e;
}

beforeEach(() => installStubs());
afterEach(() => vi.unstubAllGlobals());

describe("tron-usb-signer", () => {
  it("getTronLedgerAddress returns {address, publicKey, path, appVersion} and closes the transport", async () => {
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    const result = await getTronLedgerAddress();
    expect(result).toEqual({
      address: DEVICE_ADDRESS,
      publicKey: "04abcd",
      path: "44'/195'/0'/0/0",
      appVersion: "0.7.4",
    });
    expect(openLedgerMock).toHaveBeenCalledOnce();
    expect(transportCloseMock).toHaveBeenCalledOnce();
    expect(trxInstance.getAddress).toHaveBeenCalledWith("44'/195'/0'/0/0", false);
  });

  it("signTronTxOnLedger signs when the device address matches `expectedFrom`", async () => {
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    const res = await signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS });
    expect(res).toEqual({ signature: GOOD_SIG, signerAddress: DEVICE_ADDRESS });
    expect(trxInstance.signTransaction).toHaveBeenCalledWith("44'/195'/0'/0/0", RAW_HEX, []);
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("signTronTxOnLedger refuses when device address does NOT match `expectedFrom`", async () => {
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: OTHER_ADDRESS })
    ).rejects.toThrow(/does not match the prepared tx's `from`/);
    expect(trxInstance.signTransaction).not.toHaveBeenCalled();
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("maps 0x6985 (user rejected) to a human-readable error", async () => {
    installStubs({
      signTransaction: vi.fn(async () => {
        throw statusCodeError(0x6985, "Conditions of use not satisfied");
      }),
    });
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS })
    ).rejects.toThrow(/User rejected the transaction/);
  });

  it("maps 0x6511 (wrong app) to 'open the TRON app'", async () => {
    installStubs({
      getAppConfiguration: vi.fn(async () => {
        throw statusCodeError(0x6511, "CLA not supported");
      }),
    });
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    await expect(getTronLedgerAddress()).rejects.toThrow(/TRON app isn't open/);
    expect(transportCloseMock).toHaveBeenCalledOnce();
  });

  it("maps a loader failure to a 'no Ledger device' error", async () => {
    installStubs();
    openLedgerMock = vi.fn(async () => {
      throw new Error("cannot open device /dev/hidraw0: No such file or directory");
    });
    const { getTronLedgerAddress } = await import("../src/signing/tron-usb-signer.js");
    await expect(getTronLedgerAddress()).rejects.toThrow(/No Ledger device detected/);
  });

  it("rejects a signature that isn't 130 hex chars", async () => {
    installStubs({ signTransaction: vi.fn(async () => "deadbeef") });
    const { signTronTxOnLedger } = await import("../src/signing/tron-usb-signer.js");
    await expect(
      signTronTxOnLedger({ rawDataHex: RAW_HEX, expectedFrom: DEVICE_ADDRESS })
    ).rejects.toThrow(/unexpected signature shape/);
  });
});

describe("broadcastTronTx", () => {
  afterEach(() => vi.unstubAllGlobals());

  const baseTx = {
    chain: "tron" as const,
    action: "native_send" as const,
    from: DEVICE_ADDRESS,
    txID: "cc".repeat(32),
    rawData: { expiration: 0 },
    rawDataHex: RAW_HEX,
    description: "Send 1 TRX",
    decoded: { functionName: "TransferContract", args: {} },
  };

  it("posts the signed envelope and returns the on-chain txID on success", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(url).toBe("https://api.trongrid.io/wallet/broadcasttransaction");
      const body = JSON.parse(init!.body as string);
      expect(body).toEqual({
        txID: baseTx.txID,
        raw_data: baseTx.rawData,
        raw_data_hex: baseTx.rawDataHex,
        signature: [GOOD_SIG],
        visible: true,
      });
      return new Response(JSON.stringify({ result: true, txid: baseTx.txID }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    const res = await broadcastTronTx(baseTx, GOOD_SIG);
    expect(res.txID).toBe(baseTx.txID);
  });

  it("decodes TronGrid's hex-encoded error messages into UTF-8", async () => {
    const hexMsg = Buffer.from("Validate signature error", "utf8").toString("hex");
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: "SIGERROR", message: hexMsg }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    await expect(broadcastTronTx(baseTx, GOOD_SIG)).rejects.toThrow(
      /SIGERROR — Validate signature error/
    );
  });

  it("surfaces plain-text messages verbatim when not hex-encoded", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ code: "CONTRACT_VALIDATE_ERROR", message: "not-hex message!" }),
          { status: 200 }
        )
    );
    vi.stubGlobal("fetch", fetchMock);
    const { broadcastTronTx } = await import("../src/modules/tron/broadcast.js");
    await expect(broadcastTronTx(baseTx, GOOD_SIG)).rejects.toThrow(
      /CONTRACT_VALIDATE_ERROR — not-hex message!/
    );
  });
});

describe("sendTransaction — TRON handle routing", () => {
  beforeEach(() => installStubs());
  afterEach(() => vi.unstubAllGlobals());

  it("signs on USB, broadcasts to TronGrid, and retires the handle on success", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      if (url === "https://api.trongrid.io/wallet/createtransaction") {
        return new Response(
          JSON.stringify({
            txID: "ab".repeat(32),
            raw_data: { expiration: 1 },
            raw_data_hex: TRANSFER_1TRX_DEVICE_TO_OTHER,
            visible: true,
          }),
          { status: 200 }
        );
      }
      if (url === "https://api.trongrid.io/wallet/broadcasttransaction") {
        return new Response(JSON.stringify({ result: true, txid: "ab".repeat(32) }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { buildTronNativeSend } = await import("../src/modules/tron/actions.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const { hasTronHandle } = await import("../src/signing/tron-tx-store.js");

    const tx = await buildTronNativeSend({
      from: DEVICE_ADDRESS,
      to: OTHER_ADDRESS,
      amount: "1",
    });
    expect(hasTronHandle(tx.handle!)).toBe(true);

    const result = await sendTransaction({ handle: tx.handle!, confirmed: true, userDecision: "send" });
    expect(result).toEqual({ txHash: "ab".repeat(32), chain: "tron" });
    expect(hasTronHandle(tx.handle!)).toBe(false);
    // Signer receives the post-expiration-patch rawDataHex, not the
    // raw TronGrid response. Assert against the live tx field rather
    // than the original TRANSFER_1TRX_DEVICE_TO_OTHER fixture.
    expect(trxInstance.signTransaction).toHaveBeenCalledWith(
      "44'/195'/0'/0/0",
      tx.rawDataHex,
      []
    );
  });

  it("keeps the handle alive when signing fails so the caller can retry", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      if (url === "https://api.trongrid.io/wallet/createtransaction") {
        return new Response(
          JSON.stringify({
            txID: "cd".repeat(32),
            raw_data: { expiration: 1 },
            raw_data_hex: TRANSFER_1TRX_DEVICE_TO_OTHER,
            visible: true,
          }),
          { status: 200 }
        );
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    installStubs({
      signTransaction: vi.fn(async () => {
        throw statusCodeError(0x6985, "Conditions of use not satisfied");
      }),
    });

    const { buildTronNativeSend } = await import("../src/modules/tron/actions.js");
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    const { hasTronHandle } = await import("../src/signing/tron-tx-store.js");

    const tx = await buildTronNativeSend({
      from: DEVICE_ADDRESS,
      to: OTHER_ADDRESS,
      amount: "1",
    });
    await expect(
      sendTransaction({ handle: tx.handle!, confirmed: true, userDecision: "send" })
    ).rejects.toThrow(/User rejected/);
    expect(hasTronHandle(tx.handle!)).toBe(true);
  });
});

describe("pair_ledger_tron + get_ledger_status", () => {
  let tmpHome: string;
  beforeEach(async () => {
    // Pairings are now persisted to ~/.vaultpilot-mcp/config.json — redirect
    // to a tmp dir so this suite doesn't write bogus entries to the
    // developer's real config (live regression: it did, before this).
    tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-tron-pair-"));
    setConfigDirForTesting(tmpHome);
    installStubs();
    // Clear pairings between tests — the module-level cache otherwise leaks
    // across cases in the describe block.
    const { clearPairedTronAddresses } = await import("../src/signing/tron-usb-signer.js");
    clearPairedTronAddresses();
  });
  afterEach(() => {
    setConfigDirForTesting(null);
    rmSync(tmpHome, { recursive: true, force: true });
  });

  it("populates the tron section of getSessionStatus after pairing (default accountIndex)", async () => {
    // Reset the module cache so `session.ts`'s transitive import of
    // `walletconnect.js` (already resolved by earlier tests via execution/index)
    // is re-evaluated and picks up the doMock below.
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
      getLastPairingError: () => null,
    }));
    const { pairLedgerTron } = await import("../src/modules/execution/index.js");
    const { getSessionStatus } = await import("../src/signing/session.js");

    const pair = await pairLedgerTron();
    expect(pair.address).toBe(DEVICE_ADDRESS);
    expect(pair.path).toBe("44'/195'/0'/0/0");
    expect(pair.accountIndex).toBe(0);

    const status = await getSessionStatus();
    expect(status.tron).toEqual([
      {
        address: DEVICE_ADDRESS,
        path: "44'/195'/0'/0/0",
        appVersion: "0.7.4",
        accountIndex: 0,
      },
    ]);
  });

  it("pairs a second TRON account via accountIndex=1 and lists both in getSessionStatus", async () => {
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
      getLastPairingError: () => null,
    }));
    // First pair returns DEVICE_ADDRESS (account 0); second returns OTHER_ADDRESS (account 1).
    installStubs();
    const addressByPath: Record<string, string> = {
      "44'/195'/0'/0/0": DEVICE_ADDRESS,
      "44'/195'/1'/0/0": OTHER_ADDRESS,
    };
    trxInstance.getAddress = vi.fn(async (path: string) => {
      const addr = addressByPath[path];
      if (!addr) throw new Error(`unexpected path ${path}`);
      return { publicKey: "04abcd", address: addr };
    });

    const { pairLedgerTron } = await import("../src/modules/execution/index.js");
    const { getSessionStatus } = await import("../src/signing/session.js");

    const first = await pairLedgerTron({ accountIndex: 0 });
    expect(first.address).toBe(DEVICE_ADDRESS);
    expect(first.path).toBe("44'/195'/0'/0/0");
    const second = await pairLedgerTron({ accountIndex: 1 });
    expect(second.address).toBe(OTHER_ADDRESS);
    expect(second.path).toBe("44'/195'/1'/0/0");
    expect(second.accountIndex).toBe(1);

    const status = await getSessionStatus();
    expect(status.tron).toHaveLength(2);
    expect(status.tron?.[0].accountIndex).toBe(0);
    expect(status.tron?.[1].accountIndex).toBe(1);
    expect(status.tron?.[0].address).toBe(DEVICE_ADDRESS);
    expect(status.tron?.[1].address).toBe(OTHER_ADDRESS);
  });

  it("rejects an out-of-range accountIndex", async () => {
    const { pairLedgerTron } = await import("../src/modules/execution/index.js");
    await expect(pairLedgerTron({ accountIndex: 999 })).rejects.toThrow(
      /Invalid TRON accountIndex/
    );
  });

  it("signing for a paired non-default account routes through the paired BIP-44 path", async () => {
    // End-to-end: pair accountIndex=1 (→ OTHER_ADDRESS), prepare+send a tx
    // from OTHER_ADDRESS, and assert `app.signTransaction` was called with
    // the corresponding `44'/195'/1'/0/0` path — not the default path.
    installStubs();
    const addressByPath: Record<string, string> = {
      "44'/195'/0'/0/0": DEVICE_ADDRESS,
      "44'/195'/1'/0/0": OTHER_ADDRESS,
    };
    trxInstance.getAddress = vi.fn(async (path: string) => {
      const addr = addressByPath[path];
      if (!addr) throw new Error(`unexpected path ${path}`);
      return { publicKey: "04abcd", address: addr };
    });
    const fetchMock = vi.fn(async (url: string) => {
      const preflight = maybeTronBandwidthResponse(url);
      if (preflight) return preflight;
      if (url === "https://api.trongrid.io/wallet/createtransaction") {
        return new Response(
          JSON.stringify({
            txID: "ef".repeat(32),
            raw_data: { expiration: 1 },
            raw_data_hex: TRANSFER_1TRX_OTHER_TO_DEVICE,
            visible: true,
          }),
          { status: 200 }
        );
      }
      if (url === "https://api.trongrid.io/wallet/broadcasttransaction") {
        return new Response(JSON.stringify({ result: true, txid: "ef".repeat(32) }), {
          status: 200,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const { pairLedgerTron, sendTransaction } = await import(
      "../src/modules/execution/index.js"
    );
    const { buildTronNativeSend } = await import("../src/modules/tron/actions.js");

    await pairLedgerTron({ accountIndex: 1 });
    const tx = await buildTronNativeSend({
      from: OTHER_ADDRESS,
      to: DEVICE_ADDRESS,
      amount: "1",
    });
    const result = await sendTransaction({ handle: tx.handle!, confirmed: true, userDecision: "send" });
    expect(result.txHash).toBe("ef".repeat(32));
    expect(trxInstance.signTransaction).toHaveBeenCalledWith(
      "44'/195'/1'/0/0",
      tx.rawDataHex,
      []
    );
  });
});
