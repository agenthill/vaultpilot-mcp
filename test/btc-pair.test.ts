import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1";
import { encodeAddressForFormat } from "../src/signing/btc-bip32-derive.js";
import { setConfigDirForTesting } from "../src/config/user-config.js";

/**
 * Bitcoin USB-HID pairing tests (Phase 1 PR2). Mocks the Ledger BTC SDK
 * via `vi.mock("../src/signing/btc-usb-loader.js")` so the test never
 * touches real USB. Pairing entries persist to ~/.vaultpilot-mcp/config.json,
 * so each test redirects the config dir to a fresh tmp dir.
 *
 * Post-#192: the scanner derives leaves host-side from an account-level
 * (publicKey, chainCode) pair. Tests need REAL BIP-32 material so the
 * production code's derivation produces self-consistent results. We
 * use `@scure/bip32.fromMasterSeed` over a deterministic test seed to
 * generate the account-level fixtures, then re-derive the same leaves
 * in tests when we need to know which addresses to mock against.
 */

const LEGACY_ADDR = "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa";
const P2SH_ADDR = "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy";
const SEGWIT_ADDR = "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq";
const TAPROOT_ADDR =
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4z63cgcfr0xj0qg";

/**
 * Deterministic 32-byte seed (sha256 of "vaultpilot-btc-test-seed").
 * Drives a synthetic HD wallet whose account-level nodes feed the
 * mocked Ledger and whose leaves we can independently derive in
 * assertions.
 */
const TEST_SEED = createHash("sha256")
  .update("vaultpilot-btc-test-seed")
  .digest();
const TEST_ROOT = HDKey.fromMasterSeed(TEST_SEED);

interface AccountFixture {
  /** Uncompressed pubkey hex (130 chars), as Ledger returns. */
  publicKeyHex: string;
  /** 32-byte chain code as hex. */
  chainCodeHex: string;
  /** The HDKey at the account-level path — for re-deriving leaves in tests. */
  hd: HDKey;
}

/**
 * Build a synthetic account-level Ledger response for one BIP-44
 * purpose. Returns the same shape `getWalletPublicKey(accountPath)`
 * returns from a real device, plus the underlying HDKey so tests can
 * cross-derive leaf addresses to mock against the indexer.
 */
function makeAccountFixture(purpose: number, accountIndex: number): AccountFixture {
  const accountHd = TEST_ROOT.derive(`m/${purpose}'/0'/${accountIndex}'`);
  if (!accountHd.publicKey || !accountHd.chainCode) {
    throw new Error("test-fixture: derivation produced no pubkey/chainCode");
  }
  // @scure/bip32 returns COMPRESSED pubkey; the Ledger SDK returns
  // UNCOMPRESSED. Convert via secp256k1 point math so the fixture
  // matches the device's actual response shape.
  const point = secp256k1.ProjectivePoint.fromHex(
    Buffer.from(accountHd.publicKey).toString("hex"),
  );
  const uncompressed = point.toRawBytes(false);
  return {
    publicKeyHex: Buffer.from(uncompressed).toString("hex"),
    chainCodeHex: Buffer.from(accountHd.chainCode).toString("hex"),
    hd: accountHd,
  };
}

const PURPOSE_BY_TYPE = {
  legacy: 44,
  "p2sh-segwit": 49,
  segwit: 84,
  taproot: 86,
} as const;
type AddressType = keyof typeof PURPOSE_BY_TYPE;

/**
 * Synthetic 33-byte compressed pubkey hex for tests that write paired
 * entries directly to the cache via `setPairedBtcAddress`. The cache
 * stores the pubkey as opaque metadata — no validation, no derivation
 * — so a placeholder is fine. Real derivation tests use the
 * `makeAccountFixture` helper above instead.
 */
const FAKE_PUBKEY = "0".repeat(66);

const getWalletPublicKeyMock = vi.fn();
const signMessageMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});
const getAppAndVersionMock = vi.fn();

vi.mock("../src/signing/btc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signMessage: signMessageMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
}));

// pair_ledger_btc's gap-limit scan piggybacks on the indexer's
// getBalance() to fetch txCount per derived address. Mock the entire
// indexer module so a fresh wallet (txCount=0 for everything) walks
// the gap window without any HTTP IO.
const indexerGetBalanceMock = vi.fn(async (address: string) => ({
  address,
  confirmedSats: 0n,
  mempoolSats: 0n,
  totalSats: 0n,
  txCount: 0,
}));
vi.mock("../src/modules/btc/indexer.ts", () => ({
  getBitcoinIndexer: () => ({
    getBalance: indexerGetBalanceMock,
  }),
  resetBitcoinIndexer: () => {},
}));

let tmpHome: string;

beforeEach(async () => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-btc-pair-"));
  setConfigDirForTesting(tmpHome);
  getWalletPublicKeyMock.mockReset();
  signMessageMock.mockReset();
  transportCloseMock.mockClear();
  getAppAndVersionMock.mockReset();
  const { clearPairedBtcAddresses } = await import(
    "../src/signing/btc-usb-signer.js"
  );
  clearPairedBtcAddresses();
});

afterEach(() => {
  setConfigDirForTesting(null);
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("btcPathForAccountIndex", () => {
  it("produces the standard 5-segment BIP-44/49/84/86 paths", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(btcPathForAccountIndex(0, "legacy")).toBe("44'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "p2sh-segwit")).toBe("49'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "segwit")).toBe("84'/0'/0'/0/0");
    expect(btcPathForAccountIndex(0, "taproot")).toBe("86'/0'/0'/0/0");
    expect(btcPathForAccountIndex(7, "taproot")).toBe("86'/0'/7'/0/0");
  });

  it("rejects invalid account indices", async () => {
    const { btcPathForAccountIndex } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(() => btcPathForAccountIndex(-1, "taproot")).toThrow(/Invalid Bitcoin accountIndex/);
    expect(() => btcPathForAccountIndex(101, "taproot")).toThrow();
    expect(() => btcPathForAccountIndex(1.5, "taproot")).toThrow();
  });
});

describe("parseBtcPath", () => {
  it("decodes standard paths back into addressType + accountIndex + chain + addressIndex", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(parseBtcPath("44'/0'/0'/0/0")).toEqual({
      addressType: "legacy",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    expect(parseBtcPath("49'/0'/3'/1/5")).toEqual({
      addressType: "p2sh-segwit",
      accountIndex: 3,
      chain: 1,
      addressIndex: 5,
    });
    expect(parseBtcPath("84'/0'/7'/0/12")).toEqual({
      addressType: "segwit",
      accountIndex: 7,
      chain: 0,
      addressIndex: 12,
    });
    expect(parseBtcPath("86'/0'/12'/1/99")).toEqual({
      addressType: "taproot",
      accountIndex: 12,
      chain: 1,
      addressIndex: 99,
    });
  });

  it("returns null on non-standard paths", async () => {
    const { parseBtcPath } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Wrong purpose (mainnet only — no testnet purpose=1).
    expect(parseBtcPath("44'/1'/0'/0/0")).toBeNull();
    // Wrong segment count (account-level xpub path, not leaf).
    expect(parseBtcPath("84'/0'/0'")).toBeNull();
    // Invalid chain segment (only 0/1 allowed by BIP-44).
    expect(parseBtcPath("84'/0'/0'/2/0")).toBeNull();
    // Garbage.
    expect(parseBtcPath("not-a-path")).toBeNull();
  });
});

describe("btcLeafPath", () => {
  it("composes arbitrary BIP-32 leaf paths for receive + change chains", async () => {
    const { btcLeafPath } = await import("../src/signing/btc-usb-signer.js");
    expect(btcLeafPath(0, "segwit", 0, 0)).toBe("84'/0'/0'/0/0");
    expect(btcLeafPath(0, "segwit", 1, 5)).toBe("84'/0'/0'/1/5");
    expect(btcLeafPath(2, "taproot", 0, 12)).toBe("86'/0'/2'/0/12");
  });

  it("rejects out-of-range arguments", async () => {
    const { btcLeafPath } = await import("../src/signing/btc-usb-signer.js");
    expect(() => btcLeafPath(-1, "segwit", 0, 0)).toThrow();
    expect(() => btcLeafPath(0, "segwit", 2 as 0 | 1, 0)).toThrow(/chain/);
    expect(() => btcLeafPath(0, "segwit", 0, -1)).toThrow();
  });
});

describe("pairLedgerBitcoin (BIP44 gap-limit scan, issues #189 + #192)", () => {
  /**
   * Build account fixtures for all four address types at one
   * accountIndex. Wires `getWalletPublicKeyMock` to look responses up
   * by account-level path. Issue #192 cut the device call frequency
   * from per-leaf to per-(type, account); the mock now matches.
   */
  function setupAccountFixtures(accountIndex: number): {
    fixtures: Record<AddressType, AccountFixture>;
    /** Derive the address the production code would produce at this leaf. */
    deriveLeaf(
      addressType: AddressType,
      chain: 0 | 1,
      addressIndex: number,
    ): string;
  } {
    const fixtures: Record<AddressType, AccountFixture> = {
      legacy: makeAccountFixture(44, accountIndex),
      "p2sh-segwit": makeAccountFixture(49, accountIndex),
      segwit: makeAccountFixture(84, accountIndex),
      taproot: makeAccountFixture(86, accountIndex),
    };
    // Cross-derivation reuses the production helpers so the leaf
    // addresses we mock against are EXACTLY the ones the scanner
    // computes. Self-consistency only — not a check against external
    // BIP-84 vectors.
    const requireDerive = async () =>
      import("../src/signing/btc-bip32-derive.js");
    const formatByType: Record<AddressType, "legacy" | "p2sh" | "bech32" | "bech32m"> =
      {
        legacy: "legacy",
        "p2sh-segwit": "p2sh",
        segwit: "bech32",
        taproot: "bech32m",
      };

    getWalletPublicKeyMock.mockImplementation(async (path: string) => {
      // Map path to the matching fixture. The production scanner only
      // calls getWalletPublicKey at account-level paths; any other
      // path is a regression and should fail loudly.
      for (const [type, fixture] of Object.entries(fixtures) as [
        AddressType,
        AccountFixture,
      ][]) {
        const purpose = PURPOSE_BY_TYPE[type];
        if (path === `${purpose}'/0'/${accountIndex}'`) {
          return {
            publicKey: fixture.publicKeyHex,
            chainCode: fixture.chainCodeHex,
            // bitcoinAddress at the account level is meaningless;
            // production code ignores it.
            bitcoinAddress: "",
          };
        }
      }
      throw new Error(
        `[test fixture] unexpected getWalletPublicKey call for path "${path}" — ` +
          `the post-#192 scanner should only request account-level paths.`,
      );
    });

    void requireDerive; // unused — kept for future async-only paths
    return {
      fixtures,
      deriveLeaf(addressType, chain, addressIndex) {
        const fixture = fixtures[addressType];
        const child = fixture.hd.derive(`m/${chain}/${addressIndex}`);
        if (!child.publicKey) throw new Error("test: child no pubkey");
        return encodeAddressForFormat(child.publicKey, formatByType[addressType]);
      },
    };
  }

  beforeEach(() => {
    indexerGetBalanceMock.mockReset();
    // Default: every address is empty (fresh wallet).
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: 0,
    }));
  });

  it("walks gap-limit empty receive chains and skips change for a fresh wallet", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    setupAccountFixtures(0);

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    // Use a smaller gapLimit to keep the test fast.
    const out = await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 });

    expect(out.accountIndex).toBe(0);
    expect(out.gapLimit).toBe(5);
    expect(out.appVersion).toBe("2.4.6");
    // 4 types × 1 chain (change skipped) × 5 gap-window = 20 addresses.
    expect(out.addresses).toHaveLength(20);
    // All on receive chain.
    expect(out.addresses.every((a) => a.chain === 0)).toBe(true);
    // Indices 0..4 per type.
    const segwitWalk = out.addresses
      .filter((a) => a.addressType === "segwit")
      .map((a) => a.addressIndex);
    expect(segwitWalk).toEqual([0, 1, 2, 3, 4]);
    expect(out.summary).toEqual({ totalDerived: 20, used: 0, unused: 20 });

    // Issue #192 win: only 4 USB roundtrips total (one per address
    // type, at the account-level path) — down from 20 leaf-by-leaf
    // calls. All 20 leaves are derived host-side.
    expect(getWalletPublicKeyMock).toHaveBeenCalledTimes(4);
    expect(indexerGetBalanceMock).toHaveBeenCalledTimes(20);
    expect(transportCloseMock).toHaveBeenCalledTimes(1);
  });

  it("walks both receive and change chains when receive has activity", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    const { deriveLeaf } = setupAccountFixtures(0);
    // Mark the segwit /0/0 (receive index 0) as USED. Every other
    // address stays at txCount=0.
    const segwitReceive0 = deriveLeaf("segwit", 0, 0);
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === segwitReceive0 ? 1 : 0,
    }));

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 3 });

    // legacy/p2sh/taproot receives all empty → 3 chains × 3 = 9 entries.
    // segwit receive: index 0 used + 3 trailing empties = 4 entries.
    // segwit change: 3 empties (because receive wasn't fully empty).
    // Total: 9 + 4 + 3 = 16.
    expect(out.addresses).toHaveLength(16);
    expect(out.summary.used).toBe(1);
    // Verify the segwit change-chain was walked (chain=1 entries exist).
    const segwitChange = out.addresses.filter(
      (a) => a.addressType === "segwit" && a.chain === 1,
    );
    expect(segwitChange.length).toBe(3);
  });

  it("issues parallel indexer probes within each chunk (issue #192)", async () => {
    // Make the indexer mock track call ordering by recording when each
    // call entered and resolved. If chunks are parallel, all 5
    // entries in the first window enter together before any resolves;
    // if serial, each call resolves before the next enters.
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    setupAccountFixtures(0);
    let inFlight = 0;
    let maxInFlight = 0;
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Tiny delay so concurrent calls overlap measurably.
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 0,
      };
    });

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 });

    // Within a single (type, chain), the 5-address window is probed
    // in parallel — peak in-flight should reach the window size.
    expect(maxInFlight).toBeGreaterThanOrEqual(5);
  });

  it("rejects gapLimit out of [1, 100]", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      pairLedgerBitcoin({ accountIndex: 0, gapLimit: 0 }),
    ).rejects.toThrow(/Invalid gapLimit/);
    await expect(
      pairLedgerBitcoin({ accountIndex: 0, gapLimit: 101 }),
    ).rejects.toThrow(/Invalid gapLimit/);
  });

  it("refuses when the wrong app is open on-device", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Ethereum", version: "1.10.4" });
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 })).rejects.toThrow(
      /open app as "Ethereum".*not a known Ledger app/,
    );
  });

  it("clears stale entries for an accountIndex before re-pairing", async () => {
    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    setupAccountFixtures(0);
    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    // First pair with gap=10 → 4 types × 10 entries = 40 cached.
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 10 });
    const { getPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    expect(getPairedBtcAddresses()).toHaveLength(40);

    // Re-pair same account with smaller gap → must DROP the 40 stale
    // entries and end up with only the new 4 × 5 = 20.
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 5 });
    expect(getPairedBtcAddresses()).toHaveLength(20);
  });
});

describe("get_btc_account_balance (issue #189)", () => {
  it("aggregates confirmed sats across cached used-addresses for one account", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Two USED addresses (txCount > 0) on account 0; one UNUSED address
    // that should be skipped from the indexer fan-out.
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 5,
    });
    setPairedBtcAddress({
      address: TAPROOT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 3,
    });
    const FRESH_RECEIVE = "bc1qfreshfreshfreshfreshfreshfreshfreshfre";
    setPairedBtcAddress({
      address: FRESH_RECEIVE,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/1",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0, // unused — should be skipped from the live fan-out
    });

    indexerGetBalanceMock.mockReset();
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === SEGWIT_ADDR) {
        return {
          address,
          confirmedSats: 100_000n,
          mempoolSats: 0n,
          totalSats: 100_000n,
          txCount: 5,
        };
      }
      if (address === TAPROOT_ADDR) {
        return {
          address,
          confirmedSats: 250_000n,
          mempoolSats: 50_000n,
          totalSats: 300_000n,
          txCount: 3,
        };
      }
      throw new Error(`unexpected address fan-out: ${address}`);
    });

    const { getBitcoinAccountBalance } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await getBitcoinAccountBalance({ accountIndex: 0 });
    expect(out.accountIndex).toBe(0);
    expect(out.addressesQueried).toBe(2); // skip the unused fresh-receive
    expect(out.addressesCached).toBe(3);
    expect(out.totalConfirmedSats).toBe("350000");
    expect(out.totalConfirmedBtc).toBe("0.0035");
    expect(out.totalMempoolSats).toBe("50000");
    expect(out.breakdown).toHaveLength(2);
    expect(indexerGetBalanceMock).toHaveBeenCalledTimes(2);
  });

  it("throws when no entries are cached for the requested accountIndex", async () => {
    const { getBitcoinAccountBalance } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      getBitcoinAccountBalance({ accountIndex: 99 }),
    ).rejects.toThrow(/No paired Bitcoin entries cached/);
  });
});

describe("rescan_btc_account (issue #191)", () => {
  beforeEach(() => {
    indexerGetBalanceMock.mockReset();
  });

  it("refreshes stale txCount on cached entries without touching the device", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Cached state: an entry that was empty at original scan time.
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/2",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 2,
      txCount: 0,
    });
    // Indexer now reports 4 txs on it (user received funds).
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 100_000n,
      mempoolSats: 0n,
      totalSats: 100_000n,
      txCount: 4,
    }));

    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.addressesScanned).toBe(1);
    expect(out.txCountChanges).toBe(1);
    expect(out.fetchFailures).toBe(0);
    expect(out.refreshed[0].previousTxCount).toBe(0);
    expect(out.refreshed[0].txCount).toBe(4);
    expect(out.refreshed[0].delta).toBe(4);

    // Assert no USB activity — the rescan must NOT call openLedger.
    expect(getWalletPublicKeyMock).not.toHaveBeenCalled();
    expect(getAppAndVersionMock).not.toHaveBeenCalled();
    expect(transportCloseMock).not.toHaveBeenCalled();

    // Cache mutation persisted: subsequent get_btc_account_balance
    // skips the indexer fan-out for entries with txCount > 0 and uses
    // the now-refreshed value. We just check via getPairedBtcAddresses.
    const { getPairedBtcAddresses } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    const cached = getPairedBtcAddresses();
    expect(cached[0].txCount).toBe(4);
  });

  it("flags needsExtend when the trailing buffer empty becomes used", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Three cached segwit-receive entries: indices 0..2. The TRAILING
    // empty (index 2) is what becomes used on rescan — that means funds
    // may also exist past the original gap window.
    setPairedBtcAddress({
      address: "bc1qaaa1aaa1aaa1aaa1aaa1aaa1aaa1aaa1abcdef",
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 5,
    });
    setPairedBtcAddress({
      address: "bc1qbbb1bbb1bbb1bbb1bbb1bbb1bbb1bbb1abcdef",
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/1",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0,
    });
    const TRAILING = "bc1qccc1ccc1ccc1ccc1ccc1ccc1ccc1ccc1abcdef";
    setPairedBtcAddress({
      address: TRAILING,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/2",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 2,
      txCount: 0,
    });
    // Indexer reports the trailing empty (index 2) is now used.
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === TRAILING ? 1 : address.startsWith("bc1qaaa") ? 5 : 0,
    }));

    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(true);
    expect(out.extendChains).toEqual([
      { addressType: "segwit", chain: 0, lastAddressIndex: 2 },
    ]);
    expect(out.note).toMatch(/Run `pair_ledger_btc/);
  });

  it("does NOT flag needsExtend when only an interior empty becomes used", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    // Index 0 (used), index 1 (interior empty), index 2 (trailing empty).
    setPairedBtcAddress({
      address: "bc1qaaa2aaa2aaa2aaa2aaa2aaa2aaa2aaa2abcdef",
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 5,
    });
    const INTERIOR = "bc1qbbb2bbb2bbb2bbb2bbb2bbb2bbb2bbb2abcdef";
    setPairedBtcAddress({
      address: INTERIOR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/1",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 1,
      txCount: 0,
    });
    const TRAILING = "bc1qccc2ccc2ccc2ccc2ccc2ccc2ccc2ccc2abcdef";
    setPairedBtcAddress({
      address: TRAILING,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/2",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 2,
      txCount: 0,
    });
    // Interior gets activity; trailing stays empty.
    indexerGetBalanceMock.mockImplementation(async (address: string) => ({
      address,
      confirmedSats: 0n,
      mempoolSats: 0n,
      totalSats: 0n,
      txCount: address === INTERIOR ? 1 : address.startsWith("bc1qaaa") ? 5 : 0,
    }));

    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.needsExtend).toBe(false);
    expect(out.txCountChanges).toBe(1);
  });

  it("throws when no entries are cached for the requested accountIndex", async () => {
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    await expect(
      rescanBitcoinAccount({ accountIndex: 99 }),
    ).rejects.toThrow(/No paired Bitcoin entries cached/);
  });

  it("degrades gracefully when one indexer call fails", async () => {
    const { setPairedBtcAddress } = await import(
      "../src/signing/btc-usb-signer.js"
    );
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 7,
    });
    setPairedBtcAddress({
      address: TAPROOT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "taproot",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
      txCount: 3,
    });
    indexerGetBalanceMock.mockImplementation(async (address: string) => {
      if (address === SEGWIT_ADDR) throw new Error("indexer 502");
      return {
        address,
        confirmedSats: 0n,
        mempoolSats: 0n,
        totalSats: 0n,
        txCount: 5,
      };
    });
    const { rescanBitcoinAccount } = await import(
      "../src/modules/execution/index.js"
    );
    const out = await rescanBitcoinAccount({ accountIndex: 0 });
    expect(out.fetchFailures).toBe(1);
    // Failed entry keeps its prior txCount.
    const segwit = out.refreshed.find((r) => r.address === SEGWIT_ADDR);
    expect(segwit?.txCount).toBe(7);
    expect(segwit?.fetchOk).toBe(false);
  });
});

describe("clearPairedBtcAccount", () => {
  it("drops only entries matching the given accountIndex", async () => {
    const { setPairedBtcAddress, clearPairedBtcAccount, getPairedBtcAddresses } =
      await import("../src/signing/btc-usb-signer.js");
    setPairedBtcAddress({
      address: SEGWIT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "84'/0'/0'/0/0",
      appVersion: "2.4.6",
      addressType: "segwit",
      accountIndex: 0,
      chain: 0,
      addressIndex: 0,
    });
    setPairedBtcAddress({
      address: TAPROOT_ADDR,
      publicKey: FAKE_PUBKEY,
      path: "86'/0'/1'/0/0",
      appVersion: "2.4.6",
      addressType: "taproot",
      accountIndex: 1,
      chain: 0,
      addressIndex: 0,
    });
    expect(getPairedBtcAddresses()).toHaveLength(2);
    clearPairedBtcAccount(0);
    const remaining = getPairedBtcAddresses();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].accountIndex).toBe(1);
  });
});

describe("get_ledger_status — btc section", () => {
  it("surfaces paired BTC entries with chain/addressIndex/txCount", async () => {
    // Reset the module cache + stub walletconnect so getSessionStatus's
    // getSignClient() call doesn't try to resolve a WC project ID under
    // CI (where WALLETCONNECT_PROJECT_ID is unset). Mirrors the TRON
    // get-ledger-status test's pattern. Also re-stub the indexer + USB
    // mocks since vi.resetModules() drops the file-scope mocks.
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
      getLastPairingError: () => null,
    }));
    vi.doMock("../src/signing/btc-usb-loader.js", () => ({
      openLedger: async () => ({
        app: {
          getWalletPublicKey: getWalletPublicKeyMock,
          signMessage: signMessageMock,
        },
        transport: { close: transportCloseMock },
        rawTransport: {},
      }),
      getAppAndVersion: (rt: unknown) => getAppAndVersionMock(rt),
    }));
    vi.doMock("../src/modules/btc/indexer.ts", () => ({
      getBitcoinIndexer: () => ({
        getBalance: async (address: string) => ({
          address,
          confirmedSats: 0n,
          mempoolSats: 0n,
          totalSats: 0n,
          txCount: 0,
        }),
      }),
      resetBitcoinIndexer: () => {},
    }));

    getAppAndVersionMock.mockResolvedValue({ name: "Bitcoin", version: "2.4.6" });
    // Post-#192: scanner only calls getWalletPublicKey at account-level
    // paths. Build deterministic fixtures for all four BIP-44 purposes
    // and respond by path lookup. Leaves are derived host-side.
    const fixturesByPurpose = new Map<number, AccountFixture>();
    for (const [type, purpose] of Object.entries(PURPOSE_BY_TYPE) as [
      AddressType,
      number,
    ][]) {
      void type;
      fixturesByPurpose.set(purpose, makeAccountFixture(purpose, 0));
    }
    getWalletPublicKeyMock.mockImplementation(async (path: string) => {
      const m = path.match(/^(\d+)'\/0'\/0'$/);
      if (!m) {
        throw new Error(`unexpected path "${path}" — expected account-level only`);
      }
      const fixture = fixturesByPurpose.get(Number(m[1]));
      if (!fixture) throw new Error(`no fixture for purpose ${m[1]}`);
      return {
        publicKey: fixture.publicKeyHex,
        chainCode: fixture.chainCodeHex,
        bitcoinAddress: "",
      };
    });

    const { pairLedgerBitcoin } = await import(
      "../src/modules/execution/index.js"
    );
    await pairLedgerBitcoin({ accountIndex: 0, gapLimit: 3 });

    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeDefined();
    // 4 types × gap=3 (no change-chain walk for fresh wallet) = 12 entries.
    expect(status.bitcoin?.length).toBe(12);
    // Every entry carries the new fields.
    expect(
      status.bitcoin?.every(
        (e) => e.chain === 0 && typeof e.addressIndex === "number" && e.txCount === 0,
      ),
    ).toBe(true);
  });

  it("omits the btc section when no Bitcoin pairings are cached", async () => {
    vi.resetModules();
    vi.doMock("../src/signing/walletconnect.js", () => ({
      getSignClient: async () => ({}),
      getCurrentSession: () => null,
      getConnectedAccountsDetailed: async () => [],
      isPeerUnreachable: () => false,
      getLastPairingError: () => null,
    }));
    const { getSessionStatus } = await import("../src/signing/session.js");
    const status = await getSessionStatus();
    expect(status.bitcoin).toBeUndefined();
  });
});

/**
 * Regression tests for the `pair_ledger_btc` bs58/base-x resolution
 * chain under `@ledgerhq/hw-app-btc`. Two related bugs gated by this:
 *
 *   1. Issue #181 — `base58.decode is not a function`. Root cause:
 *      bs58@6 is ESM-default-export, breaking bs58check@2.1.2's CJS
 *      `require('bs58').decode(...)`. Fix: scoped override pinning
 *      `@ledgerhq/hw-app-btc → bs58: ^5.0.0` (CJS named exports).
 *
 *   2. Sibling regression — `xpubBuf.readUInt32BE is not a function`
 *      inside hw-app-btc's `bip32.js`. Root cause: bs58@5 transitively
 *      resolves `base-x@4`, which returns plain `Uint8Array` instead
 *      of Node `Buffer`; `Uint8Array` has `.subarray` (so chaincode /
 *      pubkey slicing succeeds and masks the issue) but no
 *      `.readUInt32BE`. Fix: extend the scoped override with
 *      `base-x: ^3.0.0` so the BTC subtree picks up base-x@3, which
 *      uses `safe-buffer` Buffer and keeps the Buffer-only methods.
 *
 * Both faults trip BEFORE the Ledger device is ever queried, so users
 * see a synchronous TypeError on `pair_ledger_btc` rather than any
 * pairing prompt. The tests below reach into the hw-app-btc subtree
 * exactly the way its CJS code resolves dependencies at runtime, so
 * if either override is ever dropped (or hw-app-btc upgrades and
 * shifts its transitive shape) we catch it in CI before it ships.
 *
 * The `vi.mock("../src/signing/btc-usb-loader.js", ...)` above mocks
 * the high-level loader but NOT `@ledgerhq/hw-app-btc` itself, so the
 * runtime `createRequire` walk below is unaffected.
 */
describe("@ledgerhq/hw-app-btc bs58/base-x subtree (issue #181 + sibling)", () => {
  const r = createRequire(import.meta.url);
  const btcRequire = createRequire(r.resolve("@ledgerhq/hw-app-btc/package.json"));
  const bs58check = btcRequire("bs58check") as {
    encode: (b: Uint8Array) => string;
    decode: (s: string) => Buffer;
  };

  it("loads bs58check.decode as a callable function from the BTC subtree", () => {
    expect(typeof bs58check.decode).toBe("function");
    expect(typeof bs58check.encode).toBe("function");

    // Round-trip a known mainnet P2PKH address so we know decode is
    // not just present but functional. Genesis-block address.
    const decoded = bs58check.decode("1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa");
    // 1-byte version + 20-byte hash160 = 21 bytes (no checksum — bs58check strips it).
    expect(decoded.length).toBe(21);
  });

  it("returns a Buffer (not bare Uint8Array) so xpub readUInt32BE works", () => {
    // hw-app-btc's `bip32.js#getXpubComponents` calls
    // `bs58check.decode(xpub).readUInt32BE(0)` to read the BIP32
    // version bytes. `readUInt32BE` is a Buffer-only method — base-x@4
    // returns Uint8Array, which would crash here.
    //
    // Use any well-formed xpub. Mainnet BIP32 version = 0x0488B21E.
    const xpub =
      "xpub661MyMwAqRbcFW31YEwpkMuc5THy2PSt5bDMsktWQcFF8syAmRUapSCGu8ED9W6oDMSgv6Zz8idoc4a6mr8BDzTJY47LJhkJ8UB7WEGuduB";
    const decoded = bs58check.decode(xpub);

    // 4-byte version + 1-byte depth + 4-byte parentFP + 4-byte childIdx
    //   + 32-byte chaincode + 33-byte pubkey = 78 bytes.
    expect(decoded.length).toBe(78);

    // The actual fault we're guarding against. If this throws with
    // "readUInt32BE is not a function", base-x@4 has slipped back into
    // the tree — re-pin the override.
    expect(typeof decoded.readUInt32BE).toBe("function");
    expect(decoded.readUInt32BE(0)).toBe(0x0488b21e);
  });
});
