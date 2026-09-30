import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import { makeConnectionStub } from "./fixtures/solana-rpc-mock.js";
import {
  setNoncePresent as setNoncePresentFor,
  setNonceMissing,
} from "./fixtures/solana-nonce-mock.js";

/**
 * Consolidated Kamino tests (formerly solana-kamino-actions.test.ts +
 * solana-kamino-pr3-pr4.test.ts). Mocks the SDK + KaminoMarket at module
 * boundary; the Solana RPC connection isn't reached by any path here.
 *
 * Coverage:
 *   - PR2: buildKaminoInitUser (LUT + userMetadata + obligation init)
 *   - PR2: buildKaminoSupply (deposit)
 *   - PR3+PR4: buildKaminoBorrow / Withdraw / Repay
 *   - PR3+PR4: getKaminoPositions reader
 *   - render-verification: blind-sign treatment for all kamino actions
 */

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const FAKE_BLOCKHASH = "GfnhkAa2iy8cZV7X5SyyYmCHxFQjEbBuyyUSCBokixB9";
const WALLET_KP = Keypair.generate();
const WALLET = WALLET_KP.publicKey.toBase58();
const FAKE_MARKET_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_PROGRAM_ID = "KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD";
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOL_MINT = "So11111111111111111111111111111111111111112";
// Generic single-reserve constant used by the supply tests; the per-mint
// reserves below back the borrow/withdraw/repay tests.
const FAKE_RESERVE_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_USDC_RESERVE = Keypair.generate().publicKey.toBase58();
const FAKE_SOL_RESERVE = Keypair.generate().publicKey.toBase58();
const FAKE_USER_METADATA_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_USER_LUT_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_OBLIGATION_ADDR = Keypair.generate().publicKey.toBase58();
const FAKE_KAMINO_PROGRAM = Keypair.generate().publicKey;

const connectionStub = makeConnectionStub();

vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => connectionStub,
  resetSolanaConnection: () => {},
  getSolanaRpcUrl: () => "https://test",
}));

vi.mock("../src/modules/solana/nonce.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/modules/solana/nonce.js")>();
  return {
    ...actual,
    getNonceAccountValue: vi.fn(),
  };
});

interface FakeReserve {
  address: string;
  state: { liquidity: { mintDecimals: bigint }; config: { status: number } };
  getTokenSymbol: () => string;
  getLiquidityMint: () => string;
}

function makeReserve(
  address: string,
  mint: string,
  opts: { decimals?: bigint; symbol?: string; status?: number } = {},
): FakeReserve {
  return {
    address,
    state: {
      liquidity: { mintDecimals: opts.decimals ?? 6n },
      config: { status: opts.status ?? 0 },
    },
    getTokenSymbol: () => opts.symbol ?? "USDC",
    getLiquidityMint: () => mint,
  };
}

const fakeUsdcReserve = makeReserve(FAKE_USDC_RESERVE, USDC_MINT);
const fakeSolReserve = makeReserve(FAKE_SOL_RESERVE, SOL_MINT, {
  decimals: 9n,
  symbol: "SOL",
});

const fakeMarket = {
  programId: FAKE_PROGRAM_ID,
  getAddress: () => FAKE_MARKET_ADDR,
  getUserMetadata: vi.fn(),
  reserves: new Map<string, FakeReserve>(),
  // Mirrors KaminoMarket.getReserveByMint: first match in `reserves` insertion
  // order — the behavior the reserve pin relies on.
  getReserveByMint(mint: string): FakeReserve | undefined {
    for (const r of this.reserves.values()) {
      if (r.getLiquidityMint() === mint) return r;
    }
    return undefined;
  },
  getReserveByAddress: vi.fn(),
};

function setReserves(...reserves: FakeReserve[]): void {
  fakeMarket.reserves.clear();
  for (const r of reserves) fakeMarket.reserves.set(r.address, r);
}

vi.mock("../src/modules/solana/kamino.js", () => ({
  loadKaminoMainMarket: async () => fakeMarket,
  KAMINO_MAIN_MARKET: FAKE_MARKET_ADDR,
  RECENT_SLOT_DURATION_MS: 410,
  createKaminoRpc: () => ({}),
}));

const KaminoActionBuildBorrowTxnsMock = vi.fn();
const KaminoActionBuildWithdrawTxnsMock = vi.fn();
const KaminoActionBuildRepayTxnsMock = vi.fn();
const KaminoActionBuildDepositTxnsMock = vi.fn();
const KaminoActionActionToIxsMock = vi.fn();
const KaminoObligationLoadMock = vi.fn();
const VanillaObligationToPdaMock = vi.fn();
const getUserLutAddressAndSetupIxsMock = vi.fn();
const initObligationMock = vi.fn();

vi.mock("@kamino-finance/klend-sdk", () => {
  class VanillaObligation {
    constructor(public programId: unknown) {}
    toArgs() {
      return {
        tag: 0,
        id: 0,
        seed1: SYSTEM_PROGRAM,
        seed2: SYSTEM_PROGRAM,
      };
    }
    toPda(market: unknown, user: unknown) {
      return VanillaObligationToPdaMock(market, user);
    }
  }
  class KaminoObligation {
    static load(...args: unknown[]) {
      return KaminoObligationLoadMock(...args);
    }
  }
  class KaminoAction {
    static buildBorrowTxns(...args: unknown[]) {
      return KaminoActionBuildBorrowTxnsMock(...args);
    }
    static buildWithdrawTxns(...args: unknown[]) {
      return KaminoActionBuildWithdrawTxnsMock(...args);
    }
    static buildRepayTxns(...args: unknown[]) {
      return KaminoActionBuildRepayTxnsMock(...args);
    }
    static actionToIxs(...args: unknown[]) {
      return KaminoActionActionToIxsMock(...args);
    }
    static buildDepositTxns(...args: unknown[]) {
      return KaminoActionBuildDepositTxnsMock(...args);
    }
  }
  return {
    KaminoMarket: class {},
    KaminoAction,
    KaminoObligation,
    VanillaObligation,
    initObligation: (...args: unknown[]) => initObligationMock(...args),
    getUserLutAddressAndSetupIxs: (...args: unknown[]) =>
      getUserLutAddressAndSetupIxsMock(...args),
  };
});

vi.mock("@solana/kit", () => ({
  createNoopSigner: (addr: unknown) => ({ address: addr }),
  address: (s: unknown) => s,
  none: () => ({ __option: "none" }),
  some: (v: unknown) => ({ __option: "some", value: v }),
  isSome: (v: { __option?: string }) => v.__option === "some",
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
}));

vi.mock("@solana/sysvars", () => ({
  SYSVAR_RENT_ADDRESS: "SysvarRent111111111111111111111111111111111",
}));

vi.mock("@solana-program/system", () => ({
  SYSTEM_PROGRAM_ADDRESS: "11111111111111111111111111111111",
}));

async function setNoncePresent(): Promise<void> {
  await setNoncePresentFor(WALLET_KP.publicKey, FAKE_BLOCKHASH);
}

function fakeKitInstruction(label: string, extraAccounts: string[] = []) {
  return {
    programAddress: FAKE_KAMINO_PROGRAM.toBase58(),
    accounts: [
      { address: WALLET_KP.publicKey.toBase58(), role: 3 },
      ...extraAccounts.map((address) => ({ address, role: 0 })),
    ],
    data: new Uint8Array([0xab, 0xcd, label.charCodeAt(0)]),
  };
}

function makeFakeObligation(opts: {
  deposits?: { reserveAddress: string; mintAddress: string; amount: string; valueUsd: string }[];
  borrows?: { reserveAddress: string; mintAddress: string; amount: string; valueUsd: string }[];
  totalDepositUsd?: string;
  totalBorrowAdjustedUsd?: string;
  liquidationLimitUsd?: string;
}) {
  const depositsMap = new Map();
  const borrowsMap = new Map();
  const decimal = (s: string) => ({ toString: () => s });
  for (const d of opts.deposits ?? []) {
    depositsMap.set(d.reserveAddress, {
      reserveAddress: d.reserveAddress,
      mintAddress: d.mintAddress,
      amount: decimal(d.amount),
      marketValueRefreshed: decimal(d.valueUsd),
    });
  }
  for (const b of opts.borrows ?? []) {
    borrowsMap.set(b.reserveAddress, {
      reserveAddress: b.reserveAddress,
      mintAddress: b.mintAddress,
      amount: decimal(b.amount),
      marketValueRefreshed: decimal(b.valueUsd),
    });
  }
  return {
    obligationAddress: FAKE_OBLIGATION_ADDR,
    deposits: depositsMap,
    borrows: borrowsMap,
    refreshedStats: {
      userTotalBorrowBorrowFactorAdjusted: decimal(opts.totalBorrowAdjustedUsd ?? "0"),
      borrowLiquidationLimit: decimal(opts.liquidationLimitUsd ?? "0"),
    },
  };
}

beforeEach(async () => {
  fakeMarket.getUserMetadata.mockReset();
  fakeMarket.reserves.clear();
  fakeMarket.getReserveByAddress.mockReset();
  KaminoActionBuildBorrowTxnsMock.mockReset();
  KaminoActionBuildWithdrawTxnsMock.mockReset();
  KaminoActionBuildRepayTxnsMock.mockReset();
  KaminoActionBuildDepositTxnsMock.mockReset();
  KaminoActionActionToIxsMock.mockReset();
  KaminoObligationLoadMock.mockReset();
  VanillaObligationToPdaMock.mockReset();
  VanillaObligationToPdaMock.mockResolvedValue(FAKE_OBLIGATION_ADDR);
  getUserLutAddressAndSetupIxsMock.mockReset();
  initObligationMock.mockReset();
  // Defaults so the borrow/withdraw/repay tests below see the same behavior
  // the inline `vi.mock` arrows previously provided. Init/supply tests
  // override per-test.
  initObligationMock.mockReturnValue({
    programAddress: FAKE_KAMINO_PROGRAM.toBase58(),
  });
  getUserLutAddressAndSetupIxsMock.mockResolvedValue([FAKE_USER_LUT_ADDR, []]);

  const { getNonceAccountValue } = await import(
    "../src/modules/solana/nonce.js"
  );
  (getNonceAccountValue as ReturnType<typeof vi.fn>).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildKaminoBorrow", () => {
  it("builds a borrow tx with nonceAdvance + the SDK's ix list", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(fakeUsdcReserve);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: [{ reserveAddress: FAKE_SOL_RESERVE, mintAddress: SOL_MINT, amount: "100000000000", valueUsd: "1500" }],
    }));
    KaminoActionBuildBorrowTxnsMock.mockResolvedValue({});
    KaminoActionActionToIxsMock.mockReturnValue([fakeKitInstruction("B")]);

    const { buildKaminoBorrow } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const tx = await buildKaminoBorrow({
      wallet: WALLET,
      mint: USDC_MINT,
      amount: "50",
    });

    expect(tx.action).toBe("kamino_borrow");
    expect(tx.description).toContain("50 USDC");
    expect(tx.decoded.functionName).toBe("kamino.borrow");
    expect(tx.decoded.args.amount).toBe("50");
    expect(tx.decoded.args.amountBaseUnits).toBe("50000000");
    expect(tx.decoded.args.symbol).toBe("USDC");

    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    expect(draft.instructions.length).toBe(2);
  });

  it("refuses when userMetadata is missing", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    setReserves(fakeUsdcReserve);

    const { buildKaminoBorrow } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoBorrow({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino userMetadata.*prepare_kamino_init_user/);
  });
});

describe("buildKaminoWithdraw", () => {
  it("builds a withdraw tx when the wallet has a deposit in the reserve", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(fakeUsdcReserve);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: [{ reserveAddress: FAKE_USDC_RESERVE, mintAddress: USDC_MINT, amount: "100000000", valueUsd: "100" }],
    }));
    KaminoActionBuildWithdrawTxnsMock.mockResolvedValue({});
    KaminoActionActionToIxsMock.mockReturnValue([fakeKitInstruction("W")]);

    const { buildKaminoWithdraw } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const tx = await buildKaminoWithdraw({
      wallet: WALLET,
      mint: USDC_MINT,
      amount: "30",
    });
    expect(tx.action).toBe("kamino_withdraw");
    expect(tx.decoded.functionName).toBe("kamino.withdraw");
  });

  it("refuses when the wallet has no deposit in the named reserve", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(fakeUsdcReserve);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      // No USDC deposit; only SOL.
      deposits: [{ reserveAddress: FAKE_SOL_RESERVE, mintAddress: SOL_MINT, amount: "1000000000", valueUsd: "150" }],
    }));

    const { buildKaminoWithdraw } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoWithdraw({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino deposit in reserve.*Nothing to withdraw/);
  });
});

describe("buildKaminoRepay", () => {
  it("builds a repay tx when the wallet has debt in the reserve", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(fakeUsdcReserve);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      borrows: [{ reserveAddress: FAKE_USDC_RESERVE, mintAddress: USDC_MINT, amount: "50000000", valueUsd: "50" }],
    }));
    KaminoActionBuildRepayTxnsMock.mockResolvedValue({});
    KaminoActionActionToIxsMock.mockReturnValue([fakeKitInstruction("R")]);

    const { buildKaminoRepay } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const tx = await buildKaminoRepay({
      wallet: WALLET,
      mint: USDC_MINT,
      amount: "20",
    });
    expect(tx.action).toBe("kamino_repay");
    expect(tx.decoded.functionName).toBe("kamino.repay");

    // Sanity: repay's positional signature differs from supply
    // (currentSlot before payer). Verify our handler passes them correctly.
    const args = KaminoActionBuildRepayTxnsMock.mock.calls[0];
    expect(args[7]).toBe(0n); // currentSlot
    // payer (slot 8) should equal owner (slot 3) — same noopSigner.
    expect(args[8]).toBe(args[3]);
  });

  it("refuses when the wallet has no debt in the reserve", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(fakeUsdcReserve);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({}));

    const { buildKaminoRepay } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoRepay({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino debt in reserve.*Nothing to repay/);
  });
});

describe("getKaminoPositions reader", () => {
  it("returns empty list when wallet has no userMetadata", async () => {
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    const { getKaminoPositions } = await import(
      "../src/modules/positions/kamino.js"
    );
    const positions = await getKaminoPositions(connectionStub as never, WALLET);
    expect(positions).toEqual([]);
  });

  it("returns empty list when userMetadata exists but obligation doesn't (partial init)", async () => {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    KaminoObligationLoadMock.mockResolvedValue(null);
    const { getKaminoPositions } = await import(
      "../src/modules/positions/kamino.js"
    );
    const positions = await getKaminoPositions(connectionStub as never, WALLET);
    expect(positions).toEqual([]);
  });

  it("projects deposits + borrows + healthFactor for an active obligation", async () => {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: [
        { reserveAddress: FAKE_SOL_RESERVE, mintAddress: SOL_MINT, amount: "10000000000", valueUsd: "1500" }, // 10 SOL @ $150
      ],
      borrows: [
        { reserveAddress: FAKE_USDC_RESERVE, mintAddress: USDC_MINT, amount: "300000000", valueUsd: "300" }, // 300 USDC
      ],
      totalBorrowAdjustedUsd: "300",
      liquidationLimitUsd: "1200", // 80% LTV → HF = 1200/300 = 4
    }));
    fakeMarket.getReserveByAddress.mockImplementation((addr: unknown) => {
      if (addr === FAKE_SOL_RESERVE) return fakeSolReserve;
      if (addr === FAKE_USDC_RESERVE) return fakeUsdcReserve;
      return undefined;
    });

    const { getKaminoPositions } = await import(
      "../src/modules/positions/kamino.js"
    );
    const positions = await getKaminoPositions(connectionStub as never, WALLET);
    expect(positions).toHaveLength(1);
    const p = positions[0];
    expect(p.protocol).toBe("kamino");
    expect(p.obligation).toBe(FAKE_OBLIGATION_ADDR);
    expect(p.supplied).toHaveLength(1);
    expect(p.supplied[0].symbol).toBe("SOL");
    expect(p.supplied[0].amount).toBe("10"); // 10000000000 / 10^9
    expect(p.supplied[0].valueUsd).toBe(1500);
    expect(p.borrowed).toHaveLength(1);
    expect(p.borrowed[0].symbol).toBe("USDC");
    expect(p.borrowed[0].amount).toBe("300"); // 300000000 / 10^6
    expect(p.totalSuppliedUsd).toBe(1500);
    expect(p.totalBorrowedUsd).toBe(300);
    expect(p.netValueUsd).toBe(1200);
    expect(p.healthFactor).toBe(4); // 1200 / 300
    expect(p.warnings).toEqual([]);
  });

  it("returns Infinity health factor when there's no debt", async () => {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: [{ reserveAddress: FAKE_SOL_RESERVE, mintAddress: SOL_MINT, amount: "1000000000", valueUsd: "150" }],
      totalBorrowAdjustedUsd: "0",
      liquidationLimitUsd: "120",
    }));
    fakeMarket.getReserveByAddress.mockReturnValue(fakeSolReserve);

    const { getKaminoPositions } = await import(
      "../src/modules/positions/kamino.js"
    );
    const positions = await getKaminoPositions(connectionStub as never, WALLET);
    expect(positions[0].healthFactor).toBe(Number.POSITIVE_INFINITY);
  });

  it("flags reserves with non-active config status", async () => {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: [{ reserveAddress: FAKE_SOL_RESERVE, mintAddress: SOL_MINT, amount: "1000000000", valueUsd: "150" }],
    }));
    fakeMarket.getReserveByAddress.mockReturnValue({
      ...fakeSolReserve,
      state: { ...fakeSolReserve.state, config: { status: 2 } }, // hidden
    });

    const { getKaminoPositions } = await import(
      "../src/modules/positions/kamino.js"
    );
    const positions = await getKaminoPositions(connectionStub as never, WALLET);
    expect(positions[0].warnings.length).toBe(1);
    expect(positions[0].warnings[0]).toMatch(/non-active status \(2\)/);
  });
});

describe("renderSolanaAgentTaskBlock — borrow / withdraw / repay", () => {
  it("renders kamino_borrow as blind-sign with the right action label", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "kamino_borrow" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "Kamino borrow: 50 USDC",
      decoded: {
        functionName: "kamino.borrow",
        args: { amount: "50", symbol: "USDC" },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain(expectedHash);
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("durable-nonce-protected");
  });

  it("renders kamino_withdraw + kamino_repay as blind-sign", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const baseTx = {
      chain: "solana" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const withdraw = renderSolanaAgentTaskBlock({
      ...baseTx,
      action: "kamino_withdraw",
      description: "Kamino withdraw: 30 USDC",
      decoded: { functionName: "kamino.withdraw", args: {} },
    });
    expect(withdraw).toContain("BLIND-SIGN");
    expect(withdraw).toContain("PAIR-CONSISTENCY LEDGER HASH");
    const repay = renderSolanaAgentTaskBlock({
      ...baseTx,
      action: "kamino_repay",
      description: "Kamino repay: 20 USDC",
      decoded: { functionName: "kamino.repay", args: {} },
    });
    expect(repay).toContain("BLIND-SIGN");
    expect(repay).toContain("PAIR-CONSISTENCY LEDGER HASH");
  });
});

describe("buildKaminoInitUser — happy path", () => {
  it("composes nonceAdvance + createLut + initUserMetadata + initObligation, in order", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    getUserLutAddressAndSetupIxsMock.mockResolvedValue([
      FAKE_USER_LUT_ADDR,
      [[fakeKitInstruction("L"), fakeKitInstruction("U")]],
    ]);
    initObligationMock.mockReturnValue(fakeKitInstruction("O"));

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const prepared = await buildKaminoInitUser({ wallet: WALLET });

    expect(prepared.action).toBe("kamino_init_user");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("Kamino setup");
    expect(prepared.decoded.functionName).toBe("kamino.initUser");
    expect(prepared.decoded.args.wallet).toBe(WALLET);
    expect(prepared.decoded.args.userMetadata).toBe(FAKE_USER_METADATA_ADDR);
    expect(prepared.decoded.args.userLookupTable).toBe(FAKE_USER_LUT_ADDR);
    expect(prepared.decoded.args.obligation).toBe(FAKE_OBLIGATION_ADDR);

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");

    // ix[0] = SystemProgram.nonceAdvance, tag 04000000
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");

    // ix[1..3] = the three Kamino kit ixs converted to web3.js v1
    expect(draft.instructions.length).toBe(4);
    expect(draft.instructions[1].programId.toBase58()).toBe(
      FAKE_KAMINO_PROGRAM.toBase58(),
    );
    expect(draft.instructions[1].data.toString("hex")).toBe(
      "abcd" + Buffer.from("L").toString("hex"),
    );
    expect(draft.instructions[2].data.toString("hex")).toBe(
      "abcd" + Buffer.from("U").toString("hex"),
    );
    expect(draft.instructions[3].data.toString("hex")).toBe(
      "abcd" + Buffer.from("O").toString("hex"),
    );

    expect(draft.meta.action).toBe("kamino_init_user");
    expect(draft.meta.nonce?.value).toBe(FAKE_BLOCKHASH);
  });

  it("calls getUserLutAddressAndSetupIxs with withExtendLut=false (no LUT activation lag)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    getUserLutAddressAndSetupIxsMock.mockResolvedValue([
      FAKE_USER_LUT_ADDR,
      [[fakeKitInstruction("L"), fakeKitInstruction("U")]],
    ]);
    initObligationMock.mockReturnValue(fakeKitInstruction("O"));

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await buildKaminoInitUser({ wallet: WALLET });

    expect(getUserLutAddressAndSetupIxsMock).toHaveBeenCalledTimes(1);
    const callArgs = getUserLutAddressAndSetupIxsMock.mock.calls[0];
    // Args: (kaminoMarket, owner, referrer, withExtendLut)
    expect(callArgs[3]).toBe(false);
  });
});

describe("buildKaminoInitUser — rejection paths", () => {
  it("refuses re-init when userMetadata already exists", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR }, // non-null state = already initialized
    ]);

    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(buildKaminoInitUser({ wallet: WALLET })).rejects.toThrow(
      /already has Kamino userMetadata/,
    );
  });

  it("throws nonce-required when wallet has no durable-nonce account", async () => {
    await setNonceMissing();
    const { buildKaminoInitUser } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(buildKaminoInitUser({ wallet: WALLET })).rejects.toThrow(
      /nonce account not initialized/i,
    );
  });
});

describe("buildKaminoSupply — happy path", () => {
  function setupSupplyHappyPath() {
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(makeReserve(FAKE_RESERVE_ADDR, USDC_MINT));
    KaminoObligationLoadMock.mockResolvedValue({ obligationAddress: FAKE_OBLIGATION_ADDR });
    const fakeAction = { __isFakeKaminoAction: true };
    KaminoActionBuildDepositTxnsMock.mockResolvedValue(fakeAction);
    KaminoActionActionToIxsMock.mockReturnValue([
      fakeKitInstruction("D"), // single deposit ix for simplicity
    ]);
  }

  it("builds the supply tx with nonceAdvance + the SDK's ix list, decoded args populated", async () => {
    await setNoncePresent();
    setupSupplyHappyPath();

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    const prepared = await buildKaminoSupply({
      wallet: WALLET,
      mint: USDC_MINT,
      amount: "100",
    });

    expect(prepared.action).toBe("kamino_supply");
    expect(prepared.from).toBe(WALLET);
    expect(prepared.description).toContain("100 USDC");
    expect(prepared.description).toContain("Kamino supply");
    expect(prepared.decoded.functionName).toBe("kamino.deposit");
    expect(prepared.decoded.args.amount).toBe("100");
    expect(prepared.decoded.args.amountBaseUnits).toBe("100000000"); // 100 * 1e6
    expect(prepared.decoded.args.symbol).toBe("USDC");
    expect(prepared.decoded.args.mint).toBe(USDC_MINT);
    expect(prepared.decoded.args.reserve).toBe(FAKE_RESERVE_ADDR);
    expect(prepared.decoded.args.obligation).toBe(FAKE_OBLIGATION_ADDR);

    const { getSolanaDraft } = await import(
      "../src/signing/solana-tx-store.js"
    );
    const draft = getSolanaDraft(prepared.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions[0].programId.toBase58()).toBe(SYSTEM_PROGRAM);
    expect(draft.instructions[0].data.toString("hex")).toBe("04000000");
    expect(draft.instructions.length).toBe(2); // nonceAdvance + deposit
    expect(draft.meta.action).toBe("kamino_supply");
  });

  it("passes skipInitialization=true to buildDepositTxns (we don't auto-init in supply)", async () => {
    await setNoncePresent();
    setupSupplyHappyPath();

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" });

    expect(KaminoActionBuildDepositTxnsMock).toHaveBeenCalledTimes(1);
    const args = KaminoActionBuildDepositTxnsMock.mock.calls[0];
    // signature: (market, amount, mint, owner, obligation, useV2Ixs,
    //             scopeRefreshConfig, extraComputeBudget, includeAtaIxs,
    //             requestElevationGroup, initUserMetadata, referrer, currentSlot)
    expect(args[5]).toBe(true); // useV2Ixs
    expect(args[10]).toEqual({
      skipInitialization: true,
      skipLutCreation: true,
    });
  });
});

describe("buildKaminoSupply — rejection paths", () => {
  it("refuses when userMetadata is missing (user hasn't init'd)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([FAKE_USER_METADATA_ADDR, null]);
    setReserves(makeReserve(FAKE_RESERVE_ADDR, USDC_MINT));

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino userMetadata.*prepare_kamino_init_user/);
  });

  it("refuses when obligation is missing (partial init state)", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(makeReserve(FAKE_RESERVE_ADDR, USDC_MINT));
    KaminoObligationLoadMock.mockResolvedValue(null);

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/no Kamino obligation.*prepare_kamino_init_user/);
  });

  it("refuses when the mint isn't listed on Kamino's main market", async () => {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves();

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "10" }),
    ).rejects.toThrow(/not listed on Kamino's main market/);
  });

  it("rejects bad amounts", async () => {
    await setNoncePresent();
    setReserves(makeReserve(FAKE_RESERVE_ADDR, USDC_MINT));

    const { buildKaminoSupply } = await import(
      "../src/modules/solana/kamino-actions.js"
    );
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "0" }),
    ).rejects.toThrow(/Invalid amount/);
    await expect(
      buildKaminoSupply({ wallet: WALLET, mint: USDC_MINT, amount: "-1" }),
    ).rejects.toThrow(/Invalid amount/);
  });
});

describe("renderSolanaAgentTaskBlock — kamino actions (init/supply)", () => {
  it("treats kamino_init_user as blind-sign with the right summary shape", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const { solanaLedgerMessageHash } = await import(
      "../src/signing/verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "kamino_init_user" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "Kamino setup: init userMetadata + obligation",
      decoded: {
        functionName: "kamino.initUser",
        args: { wallet: WALLET, userMetadata: FAKE_USER_METADATA_ADDR },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const expectedHash = solanaLedgerMessageHash(tx.messageBase64);
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain(expectedHash);
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("Kamino account init");
    expect(block).toContain("durable-nonce-protected");
  });

  it("treats kamino_supply as blind-sign with the right summary shape", async () => {
    const { renderSolanaAgentTaskBlock } = await import(
      "../src/signing/render-verification.js"
    );
    const tx = {
      chain: "solana" as const,
      action: "kamino_supply" as const,
      from: WALLET,
      messageBase64: "AQAEBzA/m98Yce1Jt/hp+eAbCM3GPwfIAUQr0DAXVer+HYYg",
      recentBlockhash: FAKE_BLOCKHASH,
      description: "Kamino supply: 100 USDC",
      decoded: {
        functionName: "kamino.deposit",
        args: { wallet: WALLET, amount: "100", symbol: "USDC" },
      },
      nonce: { account: "NonceAcct1", authority: WALLET, value: FAKE_BLOCKHASH },
    };
    const block = renderSolanaAgentTaskBlock(tx);
    expect(block).toContain("BLIND-SIGN");
    expect(block).toContain("PAIR-CONSISTENCY LEDGER HASH");
    expect(block).toContain("Kamino supply");
  });
});

describe("reserve selection — a mint listed as several reserves", () => {
  // Mirrors the mainnet Kamino main market for USDC: the hidden (status 2)
  // near-empty reserves enumerate before the active one, so an unpinned
  // KaminoMarket.getReserveByMint(USDC) returns a hidden reserve.
  const HIDDEN_A = Keypair.generate().publicKey.toBase58();
  const HIDDEN_B = Keypair.generate().publicKey.toBase58();
  const ACTIVE = Keypair.generate().publicKey.toBase58();
  const ACTIVE_2 = Keypair.generate().publicKey.toBase58();
  const MAINNET_SHAPE: [string, number][] = [[HIDDEN_A, 2], [HIDDEN_B, 2], [ACTIVE, 0]];

  type Action = "supply" | "borrow" | "withdraw" | "repay";
  interface Scenario {
    name: string;
    action: Action;
    reserves: [address: string, status: number][];
    deposits?: string[];
    borrows?: string[];
    expectReserve?: string;
    expectError?: RegExp;
  }

  const scenarios: Scenario[] = [
    { name: "withdraw takes the reserve holding the deposit (active, listed after hidden)", action: "withdraw", reserves: MAINNET_SHAPE, deposits: [ACTIVE], expectReserve: ACTIVE },
    { name: "withdraw can exit a deposit held in a hidden reserve", action: "withdraw", reserves: MAINNET_SHAPE, deposits: [HIDDEN_B], expectReserve: HIDDEN_B },
    { name: "withdraw refuses when no reserve of the mint holds a deposit", action: "withdraw", reserves: MAINNET_SHAPE, expectError: /no Kamino deposit in any reserve.*Nothing to withdraw/ },
    { name: "withdraw refuses when deposits sit in two reserves of the mint", action: "withdraw", reserves: MAINNET_SHAPE, deposits: [HIDDEN_A, ACTIVE], expectError: /holds a deposit in 2 of them.*ambiguous/ },
    { name: "repay takes the reserve the obligation owes in", action: "repay", reserves: MAINNET_SHAPE, borrows: [ACTIVE], expectReserve: ACTIVE },
    { name: "repay refuses when no reserve of the mint has debt", action: "repay", reserves: MAINNET_SHAPE, expectError: /no Kamino debt in any reserve.*Nothing to repay/ },
    { name: "supply takes the single active reserve, not the first listed", action: "supply", reserves: MAINNET_SHAPE, expectReserve: ACTIVE },
    { name: "supply refuses when every reserve of the mint is hidden", action: "supply", reserves: [[HIDDEN_A, 2], [HIDDEN_B, 2]], expectError: /None is active.*ambiguous/ },
    { name: "supply refuses when two reserves of the mint are active", action: "supply", reserves: [[HIDDEN_A, 2], [ACTIVE, 0], [ACTIVE_2, 0]], expectError: /2 are active.*ambiguous/ },
    { name: "borrow takes the single active reserve, not the first listed", action: "borrow", reserves: MAINNET_SHAPE, expectReserve: ACTIVE },
    { name: "borrow is not steered by collateral held in a hidden reserve", action: "borrow", reserves: MAINNET_SHAPE, deposits: [HIDDEN_A], expectReserve: ACTIVE },
  ];

  /** Stand-in for the SDK: builds against `market`, resolving the reserve via getReserveByMint like the real one. */
  function simulateSdk(): void {
    const build = async (market: typeof fakeMarket) => ({ market });
    KaminoActionBuildDepositTxnsMock.mockImplementation(build);
    KaminoActionBuildBorrowTxnsMock.mockImplementation(build);
    KaminoActionBuildWithdrawTxnsMock.mockImplementation(build);
    KaminoActionBuildRepayTxnsMock.mockImplementation(build);
    KaminoActionActionToIxsMock.mockImplementation((a: { market: typeof fakeMarket }) => [
      fakeKitInstruction("L", [a.market.getReserveByMint(USDC_MINT)!.address]),
    ]);
  }

  async function setup(sc: Scenario): Promise<void> {
    await setNoncePresent();
    fakeMarket.getUserMetadata.mockResolvedValue([
      FAKE_USER_METADATA_ADDR,
      { userLookupTable: FAKE_USER_LUT_ADDR },
    ]);
    setReserves(...sc.reserves.map(([address, status]) => makeReserve(address, USDC_MINT, { status })));
    const position = (reserveAddress: string) => ({
      reserveAddress,
      mintAddress: USDC_MINT,
      amount: "100000000",
      valueUsd: "100",
    });
    KaminoObligationLoadMock.mockResolvedValue(makeFakeObligation({
      deposits: (sc.deposits ?? []).map(position),
      borrows: (sc.borrows ?? []).map(position),
    }));
    simulateSdk();
  }

  async function build(action: Action) {
    const m = await import("../src/modules/solana/kamino-actions.js");
    const fn = {
      supply: m.buildKaminoSupply,
      borrow: m.buildKaminoBorrow,
      withdraw: m.buildKaminoWithdraw,
      repay: m.buildKaminoRepay,
    }[action];
    return fn({ wallet: WALLET, mint: USDC_MINT, amount: "10" });
  }

  it.each(scenarios)("$name", async (sc) => {
    await setup(sc);
    const listedBefore = [...fakeMarket.reserves.keys()];
    if (sc.expectError) {
      await expect(build(sc.action)).rejects.toThrow(sc.expectError);
      return;
    }
    const tx = await build(sc.action);
    expect(tx.decoded.args.reserve).toBe(sc.expectReserve);
    // The bytes bind the chosen reserve, not whichever the SDK lists first.
    const { getSolanaDraft } = await import("../src/signing/solana-tx-store.js");
    const draft = getSolanaDraft(tx.handle);
    if (draft.kind !== "v0") throw new Error("unreachable");
    expect(draft.instructions[1].keys.map((k) => k.pubkey.toBase58())).toContain(sc.expectReserve);
    // Pinning is a view; the loaded market's own enumeration is untouched.
    expect([...fakeMarket.reserves.keys()]).toEqual(listedBefore);
  });

  describe("built-instruction guard", () => {
    async function withdrawBuiltWith(ixAccounts: string[]) {
      const sc: Scenario = { name: "", action: "withdraw", reserves: MAINNET_SHAPE, deposits: [ACTIVE] };
      await setup(sc);
      KaminoActionActionToIxsMock.mockReset();
      KaminoActionActionToIxsMock.mockReturnValue([fakeKitInstruction("L", ixAccounts)]);
      return build("withdraw");
    }

    it("refuses when the built instructions omit the chosen reserve", async () => {
      await expect(withdrawBuiltWith([HIDDEN_A])).rejects.toThrow(
        /do not reference the chosen reserve/,
      );
    });

    it("refuses when the built instructions also touch a same-mint reserve the obligation does not hold", async () => {
      await expect(withdrawBuiltWith([ACTIVE, HIDDEN_A])).rejects.toThrow(
        /reference reserve .* for the same mint/,
      );
    });

    it("accepts a same-mint reserve the obligation holds (the SDK refreshes held reserves)", async () => {
      const sc: Scenario = { name: "", action: "supply", reserves: MAINNET_SHAPE, deposits: [HIDDEN_A] };
      await setup(sc);
      KaminoActionActionToIxsMock.mockReset();
      KaminoActionActionToIxsMock.mockReturnValue([fakeKitInstruction("L", [ACTIVE, HIDDEN_A])]);
      const tx = await build("supply");
      expect(tx.decoded.args.reserve).toBe(ACTIVE);
    });
  });
});
