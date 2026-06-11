import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { makeConnectionStub } from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
} from "./fixtures/solana-nonce-mock.js";

/**
 * MarginFi builder tests. Strategy mirrors solana-jupiter.test.ts: mock the
 * RPC (getAccountInfo for nonce + MarginfiAccount existence), mock the
 * MarginfiClient + wrapper via a fake we install into the module's cache
 * with `__setMarginfiClientCacheEntry`. No live network, no SDK import of
 * heavy transitive deps at test time.
 *
 * The fake surfaces the same `getBankByMint` shape the real client exposes,
 * plus a MarginfiAccountWrapper.fetch hook (via vi.mock on the SDK module).
 * Each builder test asserts: (1) ix[0] is SystemProgram.nonceAdvance,
 * (2) the bank ix list is appended, (3) the draft meta carries the right
 * action/bank/mint, (4) pre-flight failures produce clear errors.
 */

const WALLET_KEYPAIR = Keypair.generate();
const WALLET = WALLET_KEYPAIR.publicKey.toBase58();
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const BANK_USDC = new PublicKey("2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB");
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

// Shared Solana connection stub from fixtures/. `getAccountInfo` is the
// main method both the nonce preflight AND the marginfi-account existence
// check call.
const connectionStub = makeConnectionStub();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
}));

// Mock ALT resolution — MarginFi's group-wide ALTs are pulled via
// `resolveAddressLookupTables`. We don't care about the real lookup here;
// asserting we pass the right pubkeys is enough.
const resolveAltMock = vi.fn();
vi.mock("../src/modules/solana/alt.js", () => ({
  resolveAddressLookupTables: (...args: unknown[]) => resolveAltMock(...args),
  clearAltCache: () => {},
  invalidateAlt: () => {},
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return { ...actual, getNonceAccountValue: vi.fn() };
});

// Fake MarginfiAccountWrapper + SDK surface. The real SDK module is heavy
// (it pulls in Pyth + Switchboard transitively); mocking lets us run the
// suite without the 147MB transitive footprint on each test.
const wrapperFetchMock = vi.fn();
const makeInitIxMock = vi.fn();
// Switchboard crank mocks (issue #116 ask C / #120). The production path
// reaches @switchboard-xyz/on-demand directly (bypassing MarginFi's
// createUpdateFeedIx wrapper so it can pass numSignatures=3 instead of
// the wrapper's hardcoded 1). Tests intercept at the Switchboard module
// boundary to exercise wrapWithNonce's branching without pulling in the
// real Crossbar HTTP client.
const fetchUpdateManyIxMock = vi.fn();
vi.mock("@switchboard-xyz/on-demand", () => {
  class PullFeedStub {
    public program: unknown;
    public pubkey: PublicKey;
    constructor(program: unknown, pubkey: PublicKey) {
      this.program = program;
      this.pubkey = pubkey;
    }
    async fetchGatewayUrl(): Promise<string> {
      return "https://gateway.test";
    }
    static fetchUpdateManyIx(...args: unknown[]): unknown {
      return fetchUpdateManyIxMock(...args);
    }
  }
  return {
    PullFeed: PullFeedStub,
    AnchorUtils: {
      loadProgramFromConnection: vi.fn().mockResolvedValue({}),
    },
  };
});
vi.mock("@switchboard-xyz/common", () => ({
  CrossbarClient: {
    default: () => ({}),
  },
}));

vi.mock("@mrgnlabs/marginfi-client-v2", () => ({
  MarginfiClient: {
    fetch: vi.fn(),
  },
  MarginfiAccountWrapper: {
    fetch: (...args: unknown[]) => wrapperFetchMock(...args),
  },
  instructions: {
    makeInitMarginfiAccountPdaIx: (...args: unknown[]) => makeInitIxMock(...args),
  },
  getConfig: () => ({
    programId: new PublicKey("MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA"),
    groupPk: new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
    environment: "production",
    cluster: "mainnet",
  }),
  ADDRESS_LOOKUP_TABLE_FOR_GROUP: {
    "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8": [
      new PublicKey("BrWF8J3CEuHaXsWk3kqGZ6VHvRp4SJuG9AzvB6ei2kbV"),
    ],
  },
  MARGINFI_IDL: { address: "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA" },
  // Stubs the hardened fetchGroupData destructures from the SDK. Only used
  // by the issue-#106 fetch-path test; every other test mocks the whole
  // MarginfiClient and never reaches hardenedFetchGroupData.
  MarginfiGroup: { fromBuffer: vi.fn() },
  Bank: { fromAccountParsed: vi.fn() },
  BankConfig: { fromAccountParsed: vi.fn() },
  AssetTag: { KAMINO: 3 },
  parseOracleSetup: vi.fn(),
  parsePriceInfo: vi.fn(),
  findOracleKey: vi.fn(),
}));

// Minimal mock of @coral-xyz/anchor — only `buildMarginfiProgram` uses it,
// and only for the init path. AnchorProvider + Program don't need to be
// real since `makeInitIxMock` intercepts the SDK call.
vi.mock("@coral-xyz/anchor", () => ({
  AnchorProvider: class {},
  Program: class {},
}));

// Bind the wallet pubkey so callers don't have to repeat it.
async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(WALLET_KEYPAIR.publicKey);
}

function buildFakeBank(mint: string, address = BANK_USDC): unknown {
  return {
    address,
    mint: new PublicKey(mint),
    config: {
      assetWeightInit: new BigNumber(0.9),
      liabilityWeightInit: new BigNumber(1.1),
    },
    tokenSymbol: "USDC",
    isPaused: false,
  };
}

async function installFakeClient(
  bankLookup: (mint: PublicKey) => unknown | null,
): Promise<void> {
  // The module's cache is keyed on the mainnet group; we poke the fake in
  // via the test-only hook so `getMarginfiClient` returns this without
  // ever calling the real `MarginfiClient.fetch`.
  const mfn = await import("../src/modules/solana/marginfi.js");
  mfn.__setMarginfiClientCacheEntry({
    getBankByMint: bankLookup,
    banks: new Map(),
    oraclePrices: new Map(),
  });
}

function dummyIx(label: string): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(
      "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
    ),
    keys: [],
    data: Buffer.from(label, "utf-8"),
  });
}

function installFakeWrapperFor(kind: "healthy" | "noCollateral"): void {
  // Legacy recompute stub — this is the path the pre-flight (issue #110)
  // reads from. `healthy` = supplied collateral with no debt; `noCollateral`
  // = debt matches supply exactly (free = 0). The cache-reading
  // `computeHealthComponents` / `computeFreeCollateral` stubs are kept so
  // tests that pre-date the #110 fix still have a value to read, but the
  // pre-flight no longer calls them.
  const legacyAssets = new BigNumber(1000);
  const legacyLiabs =
    kind === "noCollateral" ? new BigNumber(1000) : new BigNumber(0);
  const cacheFree =
    kind === "noCollateral" ? new BigNumber(0) : new BigNumber(1000);
  wrapperFetchMock.mockResolvedValue({
    address: new PublicKey(
      // Any valid base58 pubkey works here — the builder just passes it
      // through to the draft meta as marginfiAccount.
      "11111111111111111111111111111111",
    ),
    // activeBalances drives the touched-banks stamp used by the #116
    // diagnosis path. Empty array is the common fresh-account case;
    // tests that need to assert on touched banks inject a non-empty
    // list via a bespoke wrapper mock.
    activeBalances: [],
    makeDepositIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
    makeWithdrawIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
    makeBorrowIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
    makeRepayIx: vi
      .fn()
      .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
    computeHealthComponents: () => ({
      assets: new BigNumber(1100),
      liabilities: new BigNumber(100),
    }),
    computeHealthComponentsLegacy: () => ({
      assets: legacyAssets,
      liabilities: legacyLiabs,
    }),
    computeFreeCollateral: () => cacheFree,
  });
}

beforeEach(async () => {
  connectionStub.getAccountInfo.mockReset();
  connectionStub.getMinimumBalanceForRentExemption.mockReset();
  // Rent-exempt minimum for the 2312-byte MarginfiAccount PDA (live mainnet
  // value 2026-04-24). Tests rely on the exact value to assert the surfaced
  // rent cost (issue #103).
  connectionStub.getMinimumBalanceForRentExemption.mockResolvedValue(16_982_400);
  resolveAltMock.mockReset();
  resolveAltMock.mockResolvedValue([]);
  wrapperFetchMock.mockReset();
  makeInitIxMock.mockReset();
  makeInitIxMock.mockResolvedValue(dummyIx("init"));
  fetchUpdateManyIxMock.mockReset();
  // Default: empty ixs + empty LUTs + empty report tuple. Matches
  // PullFeed.fetchUpdateManyIx's `[ixns, luts, report]` return shape.
  // Tests that exercise the crank path override with real-ish
  // secp256k1 + submit ixs.
  fetchUpdateManyIxMock.mockResolvedValue([[], [], {}]);

  const mfn = await import("../src/modules/solana/marginfi.js");
  mfn.__clearMarginfiClientCache();
  // Drop any injected/real 0.1.8 decode coder so a per-test injection
  // (issue-#107 decode-skip test) can't leak into other tests.
  mfn.__clearBank018DecodeProgram();

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("deriveMarginfiAccountPda", () => {
  it("is deterministic — same inputs always yield the same PDA", async () => {
    const { deriveMarginfiAccountPda } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const pda1 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    const pda2 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    expect(pda1.toBase58()).toBe(pda2.toBase58());
  });

  it("different accountIndex yields different PDA", async () => {
    const { deriveMarginfiAccountPda } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const pda0 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 0);
    const pda1 = deriveMarginfiAccountPda(WALLET_KEYPAIR.publicKey, 1);
    expect(pda0.toBase58()).not.toBe(pda1.toBase58());
  });
});

describe("buildMarginfiInit", () => {
  it("refuses when nonce account is missing (clear error pointing to init)", async () => {
    await setNonceMissing();
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    await expect(buildMarginfiInit({ wallet: WALLET })).rejects.toThrow(
      /nonce account not initialized/i,
    );
  });

  it("refuses if a MarginfiAccount already exists at the derived PDA", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    await expect(buildMarginfiInit({ wallet: WALLET })).rejects.toThrow(
      /already exists at PDA/i,
    );
  });

  it("builds a v0 draft with ix[0]=nonceAdvance, ix[1]=init, action=marginfi_init", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue(null); // PDA doesn't exist yet
    const { buildMarginfiInit } = await import("../src/modules/solana/marginfi.js");
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiInit({ wallet: WALLET });
    expect(res.action).toBe("marginfi_init");
    expect(res.chain).toBe("solana");
    expect(res.handle).toMatch(/^[0-9a-f-]+$/);
    expect(res.nonceAccount).toBeTruthy();
    // Issue #103 — rent MUST be surfaced so the agent can tell the user
    // their wallet is funding ~0.017 SOL (not "only a fee" as the prior
    // wording claimed).
    expect(res.rentLamports).toBe(16_982_400);
    expect(res.description).toContain("rent-exempt minimum");
    expect(res.decoded.args.rentLamports).toBe("16982400");
    const draft = getSolanaDraft(res.handle);
    expect(draft.kind).toBe("v0");
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions).toHaveLength(2);
    // ix[0] is nonceAdvance (System Program, 32-byte programId of all-1s)
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.meta.action).toBe("marginfi_init");
  });
});

describe("buildMarginfiSupply / Withdraw / Borrow / Repay", () => {
  async function setupHappyPath(): Promise<void> {
    await setNoncePresent();
    // PDA exists (user has run init). Simulate account info so both the
    // nonce preflight and MarginfiAccount existence check pass.
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("healthy");
  }

  it("supply: ix[0]=nonceAdvance, ix[1]=deposit (from SDK), action=marginfi_supply", async () => {
    await setupHappyPath();
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiSupply({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1.5",
    });
    expect(res.action).toBe("marginfi_supply");
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions).toHaveLength(2);
    expect(draft.meta.decoded.args.symbol).toBe("USDC");
    expect(draft.meta.decoded.args.amount).toContain("1.5 USDC");
    expect(draft.meta.action).toBe("marginfi_supply");
  });

  it("withdraw with zero free collateral → refuses with health-factor error", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("noCollateral");
    const { buildMarginfiWithdraw } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiWithdraw({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/free collateral/i);
  });

  /**
   * Issue #110 — the borrow/withdraw pre-flight used to read the
   * `healthCache`-backed `computeFreeCollateral()`, which returns 0 on
   * MarginfiAccounts where the on-chain health cache hasn't been written
   * (common after a fresh supply in SDK v6.4.1). With the cache-reading
   * path, a borrow against $87 of live collateral was refused with
   * "zero free collateral". The fix switches the pre-flight to the
   * Legacy recompute path. This test reproduces the exact scenario:
   * cache reports zero, Legacy recomputes positive — pre-flight must
   * pass and the borrow ix must build.
   */
  it("borrow against live collateral succeeds even when healthCache is all-zero", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    // Install a wrapper that simulates the #110 scenario exactly:
    // healthCache-reading APIs return zeroes (as they would on-chain
    // when the program hasn't refreshed), but the Legacy recompute
    // reports a real balance. The pre-flight should trust Legacy.
    wrapperFetchMock.mockResolvedValue({
      address: new PublicKey("11111111111111111111111111111111"),
      activeBalances: [],
      makeDepositIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
      makeWithdrawIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
      makeBorrowIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
      makeRepayIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
      computeHealthComponents: () => ({
        assets: new BigNumber(0),
        liabilities: new BigNumber(0),
      }),
      computeHealthComponentsLegacy: () => ({
        assets: new BigNumber(70.11),
        liabilities: new BigNumber(0),
      }),
      computeFreeCollateral: () => new BigNumber(0),
    });
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1",
    });
    expect(res.action).toBe("marginfi_borrow");
  });

  it("borrow: passes the amount through to makeBorrowIx and prepends nonceAdvance", async () => {
    await setupHappyPath();
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "5",
    });
    expect(res.action).toBe("marginfi_borrow");
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0 draft");
    expect(draft.meta.action).toBe("marginfi_borrow");
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
  });

  it("repay: action=marginfi_repay + decoded.args.amount carries symbol", async () => {
    await setupHappyPath();
    const { buildMarginfiRepay } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const res = await buildMarginfiRepay({
      wallet: WALLET,
      symbol: "USDC",
      amount: "2",
    });
    expect(res.action).toBe("marginfi_repay");
    expect(res.decoded.args.symbol).toBe("USDC");
    expect(res.decoded.args.amount).toContain("USDC");
  });

  it("refuses when the bank is not listed on MarginFi (actionable error)", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    // getBankByMint always returns null → "not in any bank" path.
    await installFakeClient(() => null);
    installFakeWrapperFor("healthy");
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiSupply({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/No MarginFi bank found/i);
  });

  it("refuses when the MarginfiAccount hasn't been initialized yet", async () => {
    await setNoncePresent();
    // First getAccountInfo call returns null → MarginfiAccount doesn't exist.
    connectionStub.getAccountInfo.mockResolvedValue(null);
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
    installFakeWrapperFor("healthy");
    const { buildMarginfiSupply } = await import(
      "../src/modules/solana/marginfi.js"
    );
    await expect(
      buildMarginfiSupply({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/No MarginfiAccount exists|prepare_marginfi_init/i);
  });
});

/**
 * Issue #105 — `getMarginfiClient` must pass `fetchGroupDataOverride` to
 * `MarginfiClient.fetch` so the SDK's default per-bank decode (which
 * throws on the first layout mismatch between on-chain state and the
 * bundled IDL 0.1.7) is replaced with our resilient variant. We assert
 * behaviourally: construct a real call to `MarginfiClient.fetch` (mocked
 * at the module boundary) and verify the override is present.
 */
describe("hardened MarginfiClient.fetch (issue #105)", () => {
  // Issue #108 — guard the exact shape the hardened override touches on
  // a real Anchor `Program` instance. `program.coder` is a `BorshCoder`
  // (top-level facade) whose account decoding lives at
  // `coder.accounts.decode(name, data)`, NOT at a flat `coder.decode`.
  //
  // The prior version of this test constructed a `BorshAccountsCoder`
  // directly (which IS the accounts coder and DOES have a top-level
  // `.decode`) and concluded the same was true of `program.coder`. It
  // wasn't — #108 caught 188/188 banks failing with
  // `p.coder.decode is not a function` because we'd flattened the call
  // based on that wrong premise. This version instantiates a real
  // Program so the shape that matters (program.coder) is the one
  // under assertion.
  it("program.coder decodes accounts through .accounts.decode (not a flat .decode)", async () => {
    const { Program, AnchorProvider, BorshAccountsCoder } = await vi.importActual<
      typeof import("@coral-xyz/anchor")
    >("@coral-xyz/anchor");
    // Real Anchor Program needs a valid IDL + provider. Minimal struct
    // account is enough; we never actually decode anything here.
    const minimalIdl = {
      address: "11111111111111111111111111111111",
      metadata: { name: "probe", version: "0.1.0", spec: "0.1.0" },
      instructions: [],
      accounts: [{ name: "Thing", discriminator: [1, 2, 3, 4, 5, 6, 7, 8] }],
      types: [{ name: "Thing", type: { kind: "struct", fields: [] } }],
    };
    const provider = {
      connection: {},
      publicKey: undefined,
    } as unknown as InstanceType<typeof AnchorProvider>;
    const program = new Program(minimalIdl as never, provider);
    // The invariant that drove #108: flat .decode does NOT exist on
    // program.coder — any call site reaching for it regresses to the
    // 188/188-banks-skipped failure.
    expect(
      (program.coder as unknown as { decode?: unknown }).decode,
    ).toBeUndefined();
    // And the correct path IS a function.
    expect(typeof program.coder.accounts.decode).toBe("function");
    // Cross-check: a free-standing BorshAccountsCoder (what 44408ed's
    // "verification" probe actually inspected) does expose a flat
    // .decode — that's why the probe was misleading. Keep this line
    // so future readers see why it was easy to get wrong.
    const standaloneAccountsCoder = new BorshAccountsCoder(
      minimalIdl as never,
    );
    expect(typeof standaloneAccountsCoder.decode).toBe("function");
  });

  it("passes fetchGroupDataOverride to MarginfiClient.fetch", async () => {
    // Re-mock MarginfiClient.fetch for this test to capture the options.
    const captured: { clientOptions?: Record<string, unknown> } = {};
    const mfn = await import("@mrgnlabs/marginfi-client-v2");
    (mfn.MarginfiClient.fetch as ReturnType<typeof vi.fn>).mockImplementation(
      async (_cfg: unknown, _wallet: unknown, _conn: unknown, opts: unknown) => {
        captured.clientOptions = opts as Record<string, unknown>;
        // Return a minimal object that passes through to the reader.
        return {
          getBankByMint: () => null,
          banks: new Map(),
          oraclePrices: new Map(),
        };
      },
    );

    // Clear our module cache so getHardenedMarginfiClient actually calls fetch.
    const marginfi = await import("../src/modules/solana/marginfi.js");
    marginfi.__clearMarginfiClientCache();

    await marginfi.getHardenedMarginfiClient(
      connectionStub as never,
      WALLET_KEYPAIR.publicKey,
    );
    expect(captured.clientOptions).toBeDefined();
    expect(typeof captured.clientOptions?.fetchGroupDataOverride).toBe(
      "function",
    );
    // Also sanity-check readOnly carries through (we never sign via the
    // position reader, and sending read-only mode to the SDK disables a
    // handful of sign-related checks upstream).
    expect(captured.clientOptions?.readOnly).toBe(true);
  });
});

/**
 * Issue #106 — the hardened `fetchGroupData` must fetch account infos via
 * plain `connection.getMultipleAccountsInfo` (one non-batched JSON-RPC
 * call per ≤100-key chunk), NOT via mrgn-common's
 * `chunkedGetRawMultipleAccountInfoOrdered` which internally calls
 * `connection._rpcBatchRequest`. JSON-RPC 2.0 batch requests are rejected
 * by many Solana RPC providers; the SDK's retry loop swallows the real
 * error and surfaces the opaque `"Failed to fetch account infos after 3
 * retries"`. Regression guard: the stub Connection deliberately does NOT
 * define `_rpcBatchRequest`, so any reach for it throws with a clear
 * message instead of silently regressing.
 */
describe("hardenedFetchGroupData fetch path (issue #106)", () => {
  it("uses plain getMultipleAccountsInfo, does NOT reach for _rpcBatchRequest", async () => {
    const getMultipleAccountsInfo = vi.fn().mockResolvedValue([null]);
    // _rpcBatchRequest deliberately absent — if the code reaches for it, the
    // stub throws "not a function" and the test fails with a clear signal.
    const conn = { getMultipleAccountsInfo };

    const program = {
      provider: { connection: conn },
      coder: { accounts: { decode: () => ({}) } },
      programId: new PublicKey(SYSTEM_PROGRAM),
      idl: {},
    };

    const { __hardenedFetchGroupDataForTest } = await import(
      "../src/modules/solana/marginfi.js"
    );

    const groupAddress = new PublicKey(SYSTEM_PROGRAM);
    const bankAddresses = [new PublicKey(SYSTEM_PROGRAM)];

    // With no bank data (null) and no group data (null on the 2nd fetch),
    // the function throws on the MarginfiGroup fetch check. Fine — the
    // assertion is about fetch-method selection, not end-to-end success.
    await expect(
      __hardenedFetchGroupDataForTest(
        program as never,
        groupAddress,
        undefined,
        bankAddresses,
        undefined,
      ),
    ).rejects.toThrow(/MarginfiGroup/i);
    expect(getMultipleAccountsInfo).toHaveBeenCalled();
  });
});

/**
 * Issue #102 — getMarginfiPositions must short-circuit BEFORE loading the
 * SDK client when no MarginfiAccount exists. Prior behaviour threw an
 * opaque `Cannot read properties of null (reading 'property')` because
 * MarginfiClient.fetch was called unconditionally.
 */
describe("getMarginfiPositions short-circuit (issues #102, #101)", () => {
  it("returns [] without invoking the MarginFi SDK when no PDA exists", async () => {
    connectionStub.getAccountInfo.mockResolvedValue(null); // no PDA at any slot
    const { getMarginfiPositions } = await import(
      "../src/modules/positions/marginfi.js"
    );
    const results = await getMarginfiPositions(
      connectionStub as never,
      WALLET,
    );
    expect(results).toEqual([]);
  });
});

/**
 * Issue #107 — when a bank IS listed on-chain but the hardened fetch path
 * had to skip it (Borsh decode failure, oracle parse failure, etc.),
 * `findBankForMint` must distinguish that case from "mint truly not listed",
 * so the user isn't told MarginFi dropped a token that's actually live.
 * Exercised via the test-only diagnostic-store setter + the real
 * `findBankForMint` path on the `__internals` export.
 */
describe("findBankForMint diagnostic branch (issue #107)", () => {
  const BANK_USDC_ADDR = BANK_USDC.toBase58();

  beforeEach(async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__clearMarginfiGroupDiagnostics();
  });

  it("points at the skipped bank + reason when decode-phase drop is recorded", async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiGroupDiagnosticsForTest({
      fetchedAt: Date.now(),
      addressesFetched: 1,
      banksHydrated: 0,
      skippedIntegrator: 0,
      records: [
        {
          address: BANK_USDC_ADDR,
          mint: USDC_MINT,
          step: "hydrate",
          reason: "Invalid risk tier \"{ uncharted: {} }\"",
        },
      ],
    });
    // Empty client — no bank in the map for USDC. findBankForMint should
    // consult the diagnostic store and fall into the distinct branch.
    const client = {
      getBankByMint: () => null,
      banks: new Map(),
      oraclePrices: new Map(),
    };
    expect(() =>
      mfn.__internals.findBankForMint(client, USDC_MINT),
    ).toThrow(/IS listed on-chain but was skipped.*hydrate.*Invalid risk tier/s);
  });

  it("falls through to the generic 'not listed' message when diagnostic has no record for the mint", async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiGroupDiagnosticsForTest({
      fetchedAt: Date.now(),
      addressesFetched: 5,
      banksHydrated: 5,
      skippedIntegrator: 0,
      records: [], // nothing skipped
    });
    const client = {
      getBankByMint: () => null,
      banks: new Map(),
      oraclePrices: new Map(),
    };
    expect(() =>
      mfn.__internals.findBankForMint(client, USDC_MINT),
    ).toThrow(/No MarginFi bank found.*not every mainnet SPL is supported/s);
  });

  it("prepare_marginfi_supply surfaces the skip reason when USDC was dropped at decode", async () => {
    await setNoncePresent();
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    // Client comes up with no USDC bank (simulating the post-#106 live
    // failure mode) but the diagnostic flags that USDC was the mint of
    // the skipped bank.
    await installFakeClient(() => null);
    installFakeWrapperFor("healthy");
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiGroupDiagnosticsForTest({
      fetchedAt: Date.now(),
      addressesFetched: 1,
      banksHydrated: 0,
      skippedIntegrator: 0,
      records: [
        {
          address: BANK_USDC_ADDR,
          mint: USDC_MINT,
          step: "decode",
          reason: "Unexpected discriminant value",
        },
      ],
    });
    await expect(
      mfn.buildMarginfiSupply({ wallet: WALLET, symbol: "USDC", amount: "1" }),
    ).rejects.toThrow(/USDC.*skipped by the hardened client load.*decode/s);
  });
});

/**
 * Issue #107 — the hardened fetch populates the diagnostic store with the
 * address, mint (even when decode fails — recovered from raw bytes), step,
 * and reason for each skipped bank. Tested against the direct hardened
 * path with crafted AccountInfo buffers so we don't pay for a live fetch.
 */
describe("hardenedFetchGroupData diagnostic recording (issue #107)", () => {
  it("records a decode-phase skip with mint recovered from raw bytes", async () => {
    // Build a buffer with the right shape for mint recovery: 8 bytes
    // discriminator (junk) + 32 bytes = the USDC mint pubkey, then
    // arbitrary extra bytes so the decoder has something to chew on.
    const mintBytes = new PublicKey(USDC_MINT).toBuffer();
    const fakeBankData = Buffer.concat([
      Buffer.alloc(8, 0xff),
      mintBytes,
      Buffer.alloc(64, 0),
    ]);

    const getMultipleAccountsInfo = vi
      .fn()
      // First call: bank account data.
      .mockResolvedValueOnce([
        {
          data: fakeBankData,
          owner: new PublicKey(SYSTEM_PROGRAM),
          lamports: 1,
          executable: false,
        },
      ])
      // Second call: group + oracles + mints. With zero hydrated banks
      // the oracle/mint lists are empty so we only need one element —
      // the group account — which we return as a dummy buffer; the
      // parse will fail downstream but our try/catch on MarginfiGroup
      // is the only place the error propagates out of the function.
      .mockResolvedValueOnce([
        {
          data: Buffer.alloc(128, 0),
          owner: new PublicKey(SYSTEM_PROGRAM),
          lamports: 1,
          executable: false,
        },
      ]);

    const conn = { getMultipleAccountsInfo };
    // Since the issue-#156 retarget, the decode runs through the dedicated
    // 0.1.8 coder (getBank018DecodeProgram), NOT `program.coder`. This file
    // mocks `@coral-xyz/anchor` wholesale, so we inject a throwing decode
    // coder via the test hook to force the skip path.
    const program = {
      provider: { connection: conn },
      programId: new PublicKey(SYSTEM_PROGRAM),
      idl: {},
    };

    const marginfi = await import("../src/modules/solana/marginfi.js");
    marginfi.__clearMarginfiGroupDiagnostics();
    marginfi.__setBank018DecodeProgramForTest({
      coder: {
        accounts: {
          decode: () => {
            throw new Error("probe-induced decode failure");
          },
        },
      },
    });

    // MarginfiGroup.fromBuffer gets called; return anything — we don't
    // assert on the return value, only on the diagnostic side-effect.
    const mfnMod = await import("@mrgnlabs/marginfi-client-v2");
    (mfnMod.MarginfiGroup.fromBuffer as ReturnType<typeof vi.fn>).mockReturnValue(
      {},
    );

    const bankAddresses = [BANK_USDC];
    const groupAddress = new PublicKey(
      "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8",
    );
    await marginfi.__hardenedFetchGroupDataForTest(
      program as never,
      groupAddress,
      undefined,
      bankAddresses,
      undefined,
    );

    const snap = marginfi.getLastMarginfiGroupDiagnostics();
    expect(snap).not.toBeNull();
    expect(snap!.addressesFetched).toBe(1);
    expect(snap!.banksHydrated).toBe(0);
    expect(snap!.records).toHaveLength(1);
    const rec = snap!.records[0]!;
    expect(rec.address).toBe(BANK_USDC.toBase58());
    expect(rec.mint).toBe(USDC_MINT);
    expect(rec.step).toBe("decode");
    expect(rec.reason).toMatch(/probe-induced decode failure/);
  });
});

/**
 * Issue #156 — banks whose `OracleSetup` is JuplendPythPull (15) or
 * JuplendSwitchboardPull (16) cannot be decoded by IDL 0.1.7 (13 variants):
 * `coder.accounts.decode("bank", …)` throws the opaque
 * `Cannot read properties of null (reading 'property')`, so the hardened
 * fetch records a step=decode skip and ~7 mainnet banks (USDC/USDT/SOL/
 * USDS/JupSOL) silently vanish. marginfi-client-v2 6.4.2 ships IDL 0.1.8
 * (18 variants) but STILL exports `MARGINFI_IDL` = 0.1.7, so the decode
 * path has to load 0.1.8 explicitly (`getBank018DecodeProgram`).
 *
 * These tests build the 0.1.7 and 0.1.8 account coders the SAME way the
 * production helper does — a real Anchor `Program` from the bundled IDL
 * JSON (via `vi.importActual`, since this file otherwise mocks
 * `@coral-xyz/anchor` + the SDK module) — and decode a real on-chain-shaped
 * Bank buffer whose `oracleSetup` byte is 16. The falsifier is genuine:
 * the 0.1.8 coder decodes it to `juplendSwitchboardPull`; the 0.1.7 coder
 * throws the exact issue-#156 error. A revert of the decode-IDL retarget
 * (back to 0.1.7) flips the pass-after assertion to the fail-before throw.
 */
describe("Bank decode for OracleSetup variants 15/16 (issue #156)", () => {
  // The `Bank` account is 1856 bytes in both 0.1.7 and 0.1.8; `oracleSetup`
  // (a single enum-discriminant byte inside the byte-identical `BankConfig`)
  // sits at offset 609 from the account-data start (8-byte Anchor
  // discriminator + leading Bank fields). Live-located against
  // @coral-xyz/anchor@0.30.1 by sweeping each byte until the decoded
  // `config.oracleSetup` flipped to the variant under test.
  const ORACLE_SETUP_OFFSET = 609;
  const PROGRAM_ID = "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA";

  /** Build a real Bank account buffer (8-byte disc + 1856-byte zeroed Bank)
   *  with `oracleSetup` set to `variant`. Discriminator pulled from the IDL
   *  so the Anchor coder recognizes the account. */
  function bankBufferWithOracleSetup(
    idl: { accounts: Array<{ name: string; discriminator: number[] }> },
    variant: number,
  ): Buffer {
    const disc = idl.accounts.find((a) => a.name === "Bank")!.discriminator;
    const buf = Buffer.alloc(8 + 1856, 0);
    Buffer.from(disc).copy(buf, 0);
    buf[ORACLE_SETUP_OFFSET] = variant;
    return buf;
  }

  async function makeAccountsCoder(
    idl: object,
  ): Promise<{ decode(name: string, data: Buffer): { config: { oracleSetup: Record<string, unknown> } } }> {
    const { Program } = await vi.importActual<typeof import("@coral-xyz/anchor")>(
      "@coral-xyz/anchor",
    );
    // A full Program (not a free-standing BorshAccountsCoder) camelCases
    // account-layout keys, so the decode key is the lowercase "bank" the
    // production path uses — identical construction to
    // getBank018DecodeProgram.
    const program = new Program(
      { ...idl, address: PROGRAM_ID } as never,
      { connection: {}, publicKey: undefined } as never,
    );
    return program.coder.accounts as never;
  }

  it("0.1.8 IDL's OracleSetup enum carries 18 variants including indices 15/16", async () => {
    const idl018 = (
      await vi.importActual<{ default: { types: Array<{ name: string; type: { variants?: Array<{ name: string }> } }> } }>(
        "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.8.json",
      )
    ).default;
    const oracleSetup = idl018.types.find((t) => t.name === "OracleSetup");
    expect(oracleSetup).toBeDefined();
    const variants = oracleSetup!.type.variants!.map((v) => v.name);
    expect(variants).toHaveLength(18);
    expect(variants[15]).toBe("JuplendPythPull");
    expect(variants[16]).toBe("JuplendSwitchboardPull");
  });

  it("a variant-16 (JuplendSwitchboardPull) bank decodes under 0.1.8 — fail-before/pass-after the retarget", async () => {
    const idl018 = (
      await vi.importActual<{ default: object & { accounts: Array<{ name: string; discriminator: number[] }> } }>(
        "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.8.json",
      )
    ).default;
    const idl017 = (
      await vi.importActual<{ default: object & { accounts: Array<{ name: string; discriminator: number[] }> } }>(
        "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.7.json",
      )
    ).default;

    const coder018 = await makeAccountsCoder(idl018);
    const coder017 = await makeAccountsCoder(idl017);
    const buf = bankBufferWithOracleSetup(idl018, 16);

    // PASS-AFTER: the retargeted (0.1.8) decode succeeds and names the
    // wider variant.
    const decoded = coder018.decode("bank", buf);
    expect(Object.keys(decoded.config.oracleSetup)[0]).toBe(
      "juplendSwitchboardPull",
    );

    // FAIL-BEFORE: the SDK-default (0.1.7) coder throws the exact opaque
    // error issue #156 reported. If the production code regressed to
    // 0.1.7, the variant-16 bank would hit precisely this and be dropped
    // at step=decode.
    expect(() => coder017.decode("bank", buf)).toThrow(
      /Cannot read properties of null \(reading 'property'\)/,
    );
  });

  it("a variant-15 (JuplendPythPull) bank also decodes under 0.1.8", async () => {
    const idl018 = (
      await vi.importActual<{ default: object & { accounts: Array<{ name: string; discriminator: number[] }> } }>(
        "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.8.json",
      )
    ).default;
    const coder018 = await makeAccountsCoder(idl018);
    const buf = bankBufferWithOracleSetup(idl018, 15);
    const decoded = coder018.decode("bank", buf);
    expect(Object.keys(decoded.config.oracleSetup)[0]).toBe("juplendPythPull");
  });

  /**
   * Wiring falsifier: prove the PRODUCTION `hardenedFetchGroupData` routes
   * the Bank decode through the 0.1.8 coder. We inject the real 0.1.8 coder
   * via the test hook (production fetches it from `getBank018DecodeProgram`),
   * feed a real variant-16 bank buffer, and assert it is NOT recorded as a
   * decode skip. If production regressed to decoding via the SDK-default
   * `program.coder` (0.1.7), the injected coder would be bypassed and the
   * variant-16 bank would land in the skip log at step=decode.
   */
  it("hardenedFetchGroupData decodes a variant-16 bank without a decode skip (wiring)", async () => {
    const idl018 = (
      await vi.importActual<{ default: object & { accounts: Array<{ name: string; discriminator: number[] }> } }>(
        "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.8.json",
      )
    ).default;
    const realAccountsCoder = await makeAccountsCoder(idl018);

    const marginfi = await import("../src/modules/solana/marginfi.js");
    marginfi.__clearMarginfiGroupDiagnostics();
    // Inject the REAL 0.1.8 coder — this is what production resolves to via
    // getBank018DecodeProgram (the global @coral-xyz/anchor mock otherwise
    // breaks the real build, so the hook stands in for it). The hook takes
    // the `{ coder: { accounts } }` shape production reaches through.
    marginfi.__setBank018DecodeProgramForTest({
      coder: { accounts: realAccountsCoder },
    } as never);

    const bankBuf = bankBufferWithOracleSetup(idl018, 16);
    const getMultipleAccountsInfo = vi
      .fn()
      // Bank account data (real variant-16 buffer).
      .mockResolvedValueOnce([
        {
          data: bankBuf,
          owner: new PublicKey(SYSTEM_PROGRAM),
          lamports: 1,
          executable: false,
        },
      ])
      // Group + oracle + mint fetch. One kept bank ⇒ [group, oracle, mint].
      .mockResolvedValueOnce([
        { data: Buffer.alloc(128, 0), owner: new PublicKey(SYSTEM_PROGRAM), lamports: 1, executable: false },
        { data: Buffer.alloc(128, 0), owner: new PublicKey(SYSTEM_PROGRAM), lamports: 1, executable: false },
        { data: Buffer.alloc(128, 0), owner: new PublicKey(SYSTEM_PROGRAM), lamports: 1, executable: false },
      ]);

    // Downstream SDK helpers the kept-bank path touches — configure the
    // module-mocked stubs so the function runs to completion.
    const mfnMod = await import("@mrgnlabs/marginfi-client-v2");
    (mfnMod.BankConfig.fromAccountParsed as ReturnType<typeof vi.fn>).mockReturnValue({});
    (mfnMod.findOracleKey as ReturnType<typeof vi.fn>).mockReturnValue({
      oracleKey: new PublicKey(SYSTEM_PROGRAM),
    });
    (mfnMod.MarginfiGroup.fromBuffer as ReturnType<typeof vi.fn>).mockReturnValue({});
    (mfnMod.Bank.fromAccountParsed as ReturnType<typeof vi.fn>).mockReturnValue({});
    (mfnMod.parseOracleSetup as ReturnType<typeof vi.fn>).mockReturnValue("JuplendSwitchboardPull");
    (mfnMod.parsePriceInfo as ReturnType<typeof vi.fn>).mockReturnValue({});

    const program = {
      provider: { connection: { getMultipleAccountsInfo } },
      programId: new PublicKey(SYSTEM_PROGRAM),
      idl: {},
    };

    await marginfi.__hardenedFetchGroupDataForTest(
      program as never,
      new PublicKey("4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8"),
      undefined,
      [BANK_USDC],
      undefined,
    );

    const snap = marginfi.getLastMarginfiGroupDiagnostics();
    expect(snap).not.toBeNull();
    expect(snap!.addressesFetched).toBe(1);
    // The variant-16 bank decoded — no decode skip recorded, and it
    // hydrated into the banks map.
    const decodeSkips = snap!.records.filter((r) => r.step === "decode");
    expect(decodeSkips).toHaveLength(0);
    expect(snap!.banksHydrated).toBe(1);
  });
});

/**
 * Issue #116 — when MarginFi's risk engine rejects a borrow/withdraw
 * with `RiskEngineInitRejected` (Anchor error 6009), the raw message
 * ("bad health or stale oracles") is ambiguous. `diagnoseMarginfiSimRejection`
 * probes each touched bank's oracle age against its configured oracleMaxAge
 * and reports which one is the actual culprit.
 */
describe("diagnoseMarginfiSimRejection (issue #116)", () => {
  const SOL_BANK = "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh";
  const USDC_BANK = "2s37akK2eyBbp8DZgCm7RtsaEz8eJP3Nxd4urLHQv7yB";

  beforeEach(async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__clearMarginfiClientCache();
  });

  function installPricedClient(
    priced: Array<{
      bank: string;
      symbol: string;
      oracleMaxAge: number;
      oracleSetup: string;
      oracleAgeSeconds: number;
    }>,
  ): void {
    const banks = new Map<string, unknown>();
    const oraclePrices = new Map<string, unknown>();
    const nowSec = Math.round(Date.now() / 1000);
    for (const p of priced) {
      banks.set(p.bank, {
        address: new PublicKey(p.bank),
        mint: new PublicKey(USDC_MINT),
        tokenSymbol: p.symbol,
        config: {
          oracleMaxAge: p.oracleMaxAge,
          oracleSetup: p.oracleSetup,
        },
        isPaused: false,
      });
      const ts = nowSec - p.oracleAgeSeconds;
      oraclePrices.set(p.bank, { timestamp: { toNumber: () => ts } });
    }
    // Poke the fake client into the module cache so
    // getHardenedMarginfiClient returns it — the diagnosis helper
    // fetches lazily via that path.
    (async () => {
      const mfn = await import("../src/modules/solana/marginfi.js");
      mfn.__setMarginfiClientCacheEntry({
        getBankByMint: () => null,
        banks,
        oraclePrices,
      });
    })();
    // installPricedClient is async-under-the-hood but awaited in tests
    // via a separate statement; this pattern matches installFakeClient.
  }

  it("names a stale SwitchboardPull SOL oracle as the rejection cause", async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiClientCacheEntry({
      getBankByMint: () => null,
      banks: new Map([
        [
          SOL_BANK,
          {
            address: new PublicKey(SOL_BANK),
            mint: new PublicKey(USDC_MINT),
            tokenSymbol: "SOL",
            config: {
              oracleMaxAge: 70,
              oracleSetup: "SwitchboardPull",
            },
            isPaused: false,
          },
        ],
        [
          USDC_BANK,
          {
            address: new PublicKey(USDC_BANK),
            mint: new PublicKey(USDC_MINT),
            tokenSymbol: "USDC",
            config: {
              oracleMaxAge: 300,
              oracleSetup: "PythPushOracle",
            },
            isPaused: false,
          },
        ],
      ]),
      oraclePrices: new Map([
        // SOL oracle 1696 seconds old — well past the 70-second window.
        [
          SOL_BANK,
          {
            timestamp: {
              toNumber: () => Math.round(Date.now() / 1000) - 1696,
            },
          },
        ],
        // USDC oracle fresh (10 seconds old, within 300 max).
        [
          USDC_BANK,
          {
            timestamp: {
              toNumber: () => Math.round(Date.now() / 1000) - 10,
            },
          },
        ],
      ]),
    });
    const diagnosis = await mfn.diagnoseMarginfiSimRejection(
      [SOL_BANK, USDC_BANK],
      { code: 6009, name: "RiskEngineInitRejected", message: "bad health or stale oracles" },
    );
    expect(diagnosis).not.toBeNull();
    expect(diagnosis!).toMatch(/STALE ORACLE/);
    expect(diagnosis!).toMatch(/SOL \(SwitchboardPull\)/);
    expect(diagnosis!).toMatch(/1696s old, maxAge 70s/);
    // USDC is fresh — should NOT appear as stale.
    expect(diagnosis!).not.toMatch(/USDC \(PythPushOracle\) — oracle \d+s old, maxAge 300s/);
  });

  it("rules out staleness when all touched oracles are fresh — flags bad-health", async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiClientCacheEntry({
      getBankByMint: () => null,
      banks: new Map([
        [
          SOL_BANK,
          {
            address: new PublicKey(SOL_BANK),
            mint: new PublicKey(USDC_MINT),
            tokenSymbol: "SOL",
            config: { oracleMaxAge: 70, oracleSetup: "SwitchboardV2" },
            isPaused: false,
          },
        ],
      ]),
      oraclePrices: new Map([
        [
          SOL_BANK,
          {
            timestamp: {
              toNumber: () => Math.round(Date.now() / 1000) - 5,
            },
          },
        ],
      ]),
    });
    const diagnosis = await mfn.diagnoseMarginfiSimRejection(
      [SOL_BANK],
      { code: 6009, name: "RiskEngineInitRejected", message: "x" },
    );
    expect(diagnosis).not.toBeNull();
    expect(diagnosis!).toMatch(/stale oracle is RULED OUT/);
    expect(diagnosis!).toMatch(/BAD HEALTH/);
  });

  it("returns null for unrelated Anchor codes EVEN when a priced client + stale oracle are present", async () => {
    // Install a priced client with a stale SOL oracle — if the helper
    // ever stopped gating on the Anchor code, it would produce a
    // misleading diagnosis for unrelated failures like
    // OperationBorrowOnly (which already has a self-explanatory name
    // and nothing to do with oracle freshness).
    const mfn = await import("../src/modules/solana/marginfi.js");
    mfn.__setMarginfiClientCacheEntry({
      getBankByMint: () => null,
      banks: new Map([
        [
          SOL_BANK,
          {
            address: new PublicKey(SOL_BANK),
            mint: new PublicKey(USDC_MINT),
            tokenSymbol: "SOL",
            config: { oracleMaxAge: 70, oracleSetup: "SwitchboardPull" },
            isPaused: false,
          },
        ],
      ]),
      oraclePrices: new Map([
        [
          SOL_BANK,
          {
            timestamp: {
              toNumber: () => Math.round(Date.now() / 1000) - 9999,
            },
          },
        ],
      ]),
    });
    const diagnosis = await mfn.diagnoseMarginfiSimRejection(
      [SOL_BANK],
      { code: 6021, name: "OperationBorrowOnly", message: "x" },
    );
    expect(diagnosis).toBeNull();
  });

  it("returns null when no banks were stamped (empty touched set)", async () => {
    const mfn = await import("../src/modules/solana/marginfi.js");
    const diagnosis = await mfn.diagnoseMarginfiSimRejection(
      [],
      { code: 6009, name: "RiskEngineInitRejected", message: "x" },
    );
    expect(diagnosis).toBeNull();
  });
});

/**
 * Issue #116 — `wrapWithNonce` must stamp `marginfiTouchedBanks` on the
 * draft meta so `preview_solana_send` knows which banks to probe for
 * oracle freshness on simulation rejection.
 */
describe("marginfiTouchedBanks stamping on draft meta (issue #116)", () => {
  async function setupHappyPath(): Promise<void> {
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9",
      authority: WALLET_KEYPAIR.publicKey,
    });
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installFakeClient((mint) =>
      mint.toBase58() === USDC_MINT ? buildFakeBank(USDC_MINT) : null,
    );
  }

  it("includes both the target bank and every active-balance bank, deduped", async () => {
    await setupHappyPath();
    const OTHER_BANK = new PublicKey(
      "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh",
    );
    // Wrapper reports two active balances — one matches the target USDC
    // bank (should dedupe), the other is a different (SOL) bank.
    wrapperFetchMock.mockResolvedValue({
      address: new PublicKey("11111111111111111111111111111111"),
      activeBalances: [
        { active: true, bankPk: BANK_USDC },
        { active: true, bankPk: OTHER_BANK },
        { active: false, bankPk: new PublicKey("11111111111111111111111111111112") },
      ],
      makeDepositIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
      makeWithdrawIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
      makeBorrowIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
      makeRepayIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
      computeHealthComponents: () => ({
        assets: new BigNumber(0),
        liabilities: new BigNumber(0),
      }),
      computeHealthComponentsLegacy: () => ({
        assets: new BigNumber(1000),
        liabilities: new BigNumber(0),
      }),
      computeFreeCollateral: () => new BigNumber(1000),
    });
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1",
    });
    const draft = getSolanaDraft(res.handle);
    expect(draft.meta.marginfiTouchedBanks).toBeDefined();
    // Target USDC bank + non-target SOL active bank; duplicate USDC +
    // inactive entry excluded.
    expect(draft.meta.marginfiTouchedBanks!.sort()).toEqual(
      [BANK_USDC.toBase58(), OTHER_BANK.toBase58()].sort(),
    );
  });
});

/**
 * Issue #116 ask C — when a MarginFi action touches a SwitchboardPull
 * bank, auto-prepend a Switchboard crank ix so the SOL/etc. oracle is
 * fresh at risk-engine check time. Without this, every borrow/withdraw
 * against SOL collateral hits RiskEngineInitRejected until a foreign
 * cranker happens to have run recently.
 */
describe("Switchboard crank prepend (issue #116 ask C)", () => {
  const SECP256K1_PROGRAM = "KeccakSecp256k11111111111111111111111111111";
  const SWB_PROGRAM = "SBondMDrcV3K4kxZR1HNVT7osZxAHVHgYXL5Ze1oMUv";
  const NONCE_VALUE = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";
  const SOL_BANK_PK = new PublicKey(
    "CCKtUs6Cgwo4aaQUmBPmyoApH2gUDErxNZCAntD6LYGh",
  );
  const SOL_ORACLE_PK = new PublicKey(
    "4Hmd6PdjVA9auCoScE12iaBogfwS4ZXQ6VZoBeqanwWW",
  );

  /** Build a plausible-shaped Secp256k1 ix — 129 bytes of data, num_sigs=1,
   *  all three instruction_index fields initialized to 0 (SDK default). */
  function fakeSecp256k1Ix(): TransactionInstruction {
    const data = Buffer.alloc(129, 0);
    data.writeUInt8(1, 0); // num_signatures
    data.writeUInt16LE(12, 1); // signature_offset
    data.writeUInt8(0, 3); // signature_instruction_index (hardcoded 0 by SDK)
    data.writeUInt16LE(77, 4); // eth_address_offset
    data.writeUInt8(0, 6); // eth_address_instruction_index
    data.writeUInt16LE(97, 7); // message_data_offset
    data.writeUInt16LE(32, 9); // message_data_size
    data.writeUInt8(0, 11); // message_instruction_index
    return new TransactionInstruction({
      programId: new PublicKey(SECP256K1_PROGRAM),
      keys: [],
      data,
    });
  }

  function fakeSwbSubmitIx(): TransactionInstruction {
    return new TransactionInstruction({
      programId: new PublicKey(SWB_PROGRAM),
      keys: [{ pubkey: SOL_ORACLE_PK, isSigner: false, isWritable: true }],
      data: Buffer.alloc(36, 0),
    });
  }

  /** Install a client whose `banks` map carries an oracleSetup the
   *  crank helper will recognize as SwitchboardPull. */
  async function installClientWithSwbBank(): Promise<void> {
    const mfn = await import("../src/modules/solana/marginfi.js");
    const banks = new Map<string, unknown>();
    banks.set(SOL_BANK_PK.toBase58(), {
      address: SOL_BANK_PK,
      mint: new PublicKey(USDC_MINT),
      tokenSymbol: "SOL",
      oracleKey: SOL_ORACLE_PK,
      config: {
        oracleSetup: "SwitchboardPull",
        oracleKeys: [SOL_ORACLE_PK],
        oracleMaxAge: 70,
        assetWeightInit: new BigNumber(0.8),
        liabilityWeightInit: new BigNumber(1.1),
      },
      isPaused: false,
    });
    // Also add the target USDC bank (findBankForMint reaches for this).
    banks.set(BANK_USDC.toBase58(), {
      address: BANK_USDC,
      mint: new PublicKey(USDC_MINT),
      tokenSymbol: "USDC",
      oracleKey: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
      config: {
        oracleSetup: "PythPushOracle",
        oracleKeys: [
          new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
        ],
        oracleMaxAge: 300,
        assetWeightInit: new BigNumber(0.9),
        liabilityWeightInit: new BigNumber(1.1),
      },
      isPaused: false,
    });
    mfn.__setMarginfiClientCacheEntry({
      getBankByMint: (mint: PublicKey) =>
        mint.toBase58() === USDC_MINT ? banks.get(BANK_USDC.toBase58()) : null,
      banks,
      oraclePrices: new Map(),
    });
  }

  async function setupWithActiveSolBalance(): Promise<void> {
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_VALUE,
      authority: WALLET_KEYPAIR.publicKey,
    });
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    await installClientWithSwbBank();
    // Wrapper reports an active balance on the SOL bank so the touched-
    // banks set includes both USDC (target) and SOL (SwitchboardPull).
    wrapperFetchMock.mockResolvedValue({
      address: new PublicKey("11111111111111111111111111111111"),
      activeBalances: [{ active: true, bankPk: SOL_BANK_PK }],
      makeDepositIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
      makeWithdrawIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
      makeBorrowIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
      makeRepayIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
      computeHealthComponents: () => ({
        assets: new BigNumber(0),
        liabilities: new BigNumber(0),
      }),
      computeHealthComponentsLegacy: () => ({
        assets: new BigNumber(70),
        liabilities: new BigNumber(0),
      }),
      computeFreeCollateral: () => new BigNumber(70),
    });
  }

  it("prepends secp256k1 + submit ixs, patches instruction_index to the new position", async () => {
    await setupWithActiveSolBalance();
    // Crank helper returns 2 ixs: fake secp256k1 (indices hardcoded to 0)
    // + a fake submit ix. PullFeed.fetchUpdateManyIx's tuple return:
    // [instructions, luts, report].
    fetchUpdateManyIxMock.mockResolvedValue([
      [fakeSecp256k1Ix(), fakeSwbSubmitIx()],
      [],
      {},
    ]);
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1",
    });
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0");
    // Final layout: nonceAdvance(0), ComputeBudget(1), secp256k1(2), swb-submit(3), borrow(4)
    expect(draft.instructions).toHaveLength(5);
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[1]!.programId.toBase58()).toBe(
      "ComputeBudget111111111111111111111111111111",
    );
    expect(draft.instructions[2]!.programId.toBase58()).toBe(SECP256K1_PROGRAM);
    expect(draft.instructions[3]!.programId.toBase58()).toBe(SWB_PROGRAM);
    // Patched ix at position 2 should have its three instruction_index bytes
    // rewritten from 0 (SDK default) to 2 (actual position).
    const secp = draft.instructions[2]!;
    expect(secp.data.readUInt8(3)).toBe(2); // signature_instruction_index
    expect(secp.data.readUInt8(6)).toBe(2); // eth_address_instruction_index
    expect(secp.data.readUInt8(11)).toBe(2); // message_instruction_index
    // Meta carries the crank info for verification-block rendering.
    expect(draft.meta.marginfiOracleCranks).toBeDefined();
    expect(draft.meta.marginfiOracleCranks!.oracles).toEqual([
      SOL_ORACLE_PK.toBase58(),
    ]);
    expect(draft.meta.marginfiOracleCranks!.instructionCount).toBe(2);
    // Description includes the user-visible cue.
    expect(res.description).toMatch(/auto-cranking 1 Switchboard oracle/);
  });

  it("skips the crank (no ComputeBudget prepend) when no SwitchboardPull bank is touched", async () => {
    const { getNonceAccountValue } = await import(
      "../src/modules/solana/nonce.js"
    );
    (getNonceAccountValue as ReturnType<typeof vi.fn>).mockResolvedValue({
      nonce: NONCE_VALUE,
      authority: WALLET_KEYPAIR.publicKey,
    });
    connectionStub.getAccountInfo.mockResolvedValue({
      data: Buffer.alloc(0),
      owner: new PublicKey("11111111111111111111111111111111"),
      lamports: 1,
      executable: false,
    });
    // Install a client whose touched banks are ALL PythPushOracle — the
    // crank helper's filter should match none and return empty.
    const mfn = await import("../src/modules/solana/marginfi.js");
    const banks = new Map<string, unknown>();
    banks.set(BANK_USDC.toBase58(), {
      address: BANK_USDC,
      mint: new PublicKey(USDC_MINT),
      tokenSymbol: "USDC",
      oracleKey: new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
      config: {
        oracleSetup: "PythPushOracle",
        oracleKeys: [
          new PublicKey("Dpw1EAVrSB1ibxiDQyTAW6Zip3J4Btk2x4SgApQCeFbX"),
        ],
        oracleMaxAge: 300,
        assetWeightInit: new BigNumber(0.9),
        liabilityWeightInit: new BigNumber(1.1),
      },
      isPaused: false,
    });
    mfn.__setMarginfiClientCacheEntry({
      getBankByMint: () => banks.get(BANK_USDC.toBase58()),
      banks,
      oraclePrices: new Map(),
    });
    wrapperFetchMock.mockResolvedValue({
      address: new PublicKey("11111111111111111111111111111111"),
      activeBalances: [],
      makeDepositIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("deposit")], keys: [] }),
      makeWithdrawIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("withdraw")], keys: [] }),
      makeBorrowIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("borrow")], keys: [] }),
      makeRepayIx: vi
        .fn()
        .mockResolvedValue({ instructions: [dummyIx("repay")], keys: [] }),
      computeHealthComponents: () => ({
        assets: new BigNumber(0),
        liabilities: new BigNumber(0),
      }),
      computeHealthComponentsLegacy: () => ({
        assets: new BigNumber(1000),
        liabilities: new BigNumber(0),
      }),
      computeFreeCollateral: () => new BigNumber(1000),
    });
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1",
    });
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0");
    // Bare: nonceAdvance + borrow, nothing else. No ComputeBudget bloat.
    expect(draft.instructions).toHaveLength(2);
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    // Ensure PullFeed.fetchUpdateManyIx was never called — not just that
    // nothing came back. (Calls an HTTP gateway; must skip for Pyth-only
    // flows.)
    expect(fetchUpdateManyIxMock).not.toHaveBeenCalled();
    expect(draft.meta.marginfiOracleCranks!.oracles).toEqual([]);
    expect(draft.meta.marginfiOracleCranks!.instructionCount).toBe(0);
  });

  it("falls through without crank when the Switchboard gateway throws (gateway failure)", async () => {
    await setupWithActiveSolBalance();
    fetchUpdateManyIxMock.mockRejectedValue(
      new Error("crossbar gateway unreachable"),
    );
    const { buildMarginfiBorrow } = await import(
      "../src/modules/solana/marginfi.js"
    );
    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const res = await buildMarginfiBorrow({
      wallet: WALLET,
      symbol: "USDC",
      amount: "1",
    });
    // Tx still built — just without crank. The sim gate + #116 diagnosis
    // remain as backstops for the resulting stale-oracle revert.
    const draft = getSolanaDraft(res.handle);
    if (draft.kind !== "v0") throw new Error("expected v0");
    expect(draft.instructions[0]!.programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.meta.marginfiOracleCranks!.oracles).toEqual([]);
    expect(draft.meta.marginfiOracleCranks!.instructionCount).toBe(0);
    // No secp256k1 ix in the final tx.
    for (const ix of draft.instructions) {
      expect(ix.programId.toBase58()).not.toBe(SECP256K1_PROGRAM);
    }
  });

  it("patchSecp256k1CrankIxPosition: rewrites the three instruction_index bytes in place", async () => {
    const { patchSecp256k1CrankIxPosition } = await import(
      "../src/modules/solana/swb-crank.js"
    );
    const ix = fakeSecp256k1Ix();
    // SDK-built default: all indices = 0 (ix at tx position 0).
    expect(ix.data.readUInt8(3)).toBe(0);
    expect(ix.data.readUInt8(6)).toBe(0);
    expect(ix.data.readUInt8(11)).toBe(0);
    const patched = patchSecp256k1CrankIxPosition(ix, 7);
    expect(patched.data.readUInt8(3)).toBe(7);
    expect(patched.data.readUInt8(6)).toBe(7);
    expect(patched.data.readUInt8(11)).toBe(7);
    // All other bytes are untouched — num_sigs, offsets, etc.
    expect(patched.data.readUInt8(0)).toBe(1); // num_sigs
    expect(patched.data.readUInt16LE(1)).toBe(12); // signature_offset
    // Original ix is NOT mutated.
    expect(ix.data.readUInt8(3)).toBe(0);
  });

  it("patchSecp256k1CrankIxPosition: no-op for non-secp256k1 programs", async () => {
    const { patchSecp256k1CrankIxPosition } = await import(
      "../src/modules/solana/swb-crank.js"
    );
    const other = new TransactionInstruction({
      programId: new PublicKey(SWB_PROGRAM),
      keys: [],
      data: Buffer.alloc(129, 0xaa),
    });
    const result = patchSecp256k1CrankIxPosition(other, 7);
    // Same object back, data unchanged.
    expect(result).toBe(other);
    expect(result.data.readUInt8(3)).toBe(0xaa);
  });

  it("patchSecp256k1CrankIxPosition: patches ALL N offset blocks for multi-sig payloads (issue #120)", async () => {
    const { patchSecp256k1CrankIxPosition } = await import(
      "../src/modules/solana/swb-crank.js"
    );
    // Build a plausible 3-signature payload. Count byte = 3, followed by
    // 3 × 11-byte offset blocks (all instruction_index bytes initialized
    // to 0, mirroring what the SDK emits), then a fake signatures area
    // + common message. The patch function doesn't touch anything past
    // the offset section, so the tail can stay zeroed.
    const N = 3;
    const offsetsAreaSize = 1 + N * 11;
    const signatureBlockSize = 64 + 1 + 20; // sig + recoveryId + ethAddress
    const messageSize = 32;
    const data = Buffer.alloc(offsetsAreaSize + N * signatureBlockSize + messageSize, 0);
    data.writeUInt8(N, 0);
    // Populate the three index bytes in each offset block with SDK's
    // default (0). The patch should rewrite every one of them.
    for (let k = 0; k < N; k++) {
      const base = 1 + k * 11;
      data.writeUInt8(0, base + 2);
      data.writeUInt8(0, base + 5);
      data.writeUInt8(0, base + 10);
    }
    const multi = new TransactionInstruction({
      programId: new PublicKey(SECP256K1_PROGRAM),
      keys: [],
      data,
    });
    const patched = patchSecp256k1CrankIxPosition(multi, 7);
    for (let k = 0; k < N; k++) {
      const base = 1 + k * 11;
      expect(patched.data.readUInt8(base + 2)).toBe(7);
      expect(patched.data.readUInt8(base + 5)).toBe(7);
      expect(patched.data.readUInt8(base + 10)).toBe(7);
    }
    // Original is untouched.
    for (let k = 0; k < N; k++) {
      const base = 1 + k * 11;
      expect(multi.data.readUInt8(base + 2)).toBe(0);
    }
  });

  it("patchSecp256k1CrankIxPosition: throws on truncated buffer (declared N > actual size)", async () => {
    const { patchSecp256k1CrankIxPosition } = await import(
      "../src/modules/solana/swb-crank.js"
    );
    // Claim 3 signatures but only carry enough bytes for 1 offset block.
    // A silently-wrong patch would stop at the buffer end and leave
    // blocks 1..2 with the SDK default (0) — the exact regression we
    // want this guard to catch.
    const data = Buffer.alloc(12, 0);
    data.writeUInt8(3, 0); // num_sigs=3 (needs 1 + 3*11 = 34 bytes)
    const truncated = new TransactionInstruction({
      programId: new PublicKey(SECP256K1_PROGRAM),
      keys: [],
      data,
    });
    expect(() => patchSecp256k1CrankIxPosition(truncated, 2)).toThrow(
      /too short.*num_signatures=3/,
    );
  });
});
