/**
 * FALSIFIERS for the #757/#760 recipient-authorization seam (design #759) — the
 * legs NOT covered by test/757-760-recipient-drain.test.ts (the incident
 * acceptance file). Every guard this PR ships carries a falsifier here:
 *
 *  - D1 fail-closed account-set precondition (four empty-producer states + falsy
 *    tx.from), at BOTH loci (preview + send).
 *  - D2 bucket-4 provenance discriminator (stamped → hard-gate; unstamped → pass).
 *  - D2-rot module-load enumeration (completeness + the tuple walk + REQUIRE-EMPTY
 *    + top-level decode-refuse), plus the detector's own negative direction.
 *  - D4 mixed-case normalization.
 *  - D7 multicall (universal per-leg, router-self conjunctive+ordered exception,
 *    unrecognized sub-selector, breadth budget, provenance-stamp threading).
 *  - §5 send-time re-check (fresh account read at send).
 *  - U1 CI assertion (no fourth writer of `acknowledgedNonProtocolTarget`).
 *
 * previewSend is the entry point (per design D1 the gate lives in
 * runEvmPreSignGuards, reached only via previewSend); pre-sign-check is NOT
 * mocked. De-identified fixtures throughout.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { aavePoolAbi } from "../src/abis/aave-pool.js";
import { morphoBlueAbi } from "../src/abis/morpho-blue.js";
import { swapRouter02Abi } from "../src/abis/uniswap-swap-router-02.js";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";
import { erc20Abi } from "../src/abis/erc20.js";
import {
  enumerateRecognizedAddressPaths,
  findUnclassifiedPaths,
  assertClassificationComplete,
  SUB_CALL_BUDGET,
} from "../src/signing/recipient-authorization.js";

const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const ATTACKER = getAddress("0x2222222222222222222222222222222222222222");
const FAKE_ORACLE = getAddress("0x3333333333333333333333333333333333333333");
const FAKE_IRM = getAddress("0x4444444444444444444444444444444444444444");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const DAI = getAddress("0x6B175474E89094C44Da98b954EedeAC495271d0F");

const AAVE_V3_POOL = getAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
const MORPHO_BLUE = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const UNISWAP_SWAP_ROUTER_02 = getAddress("0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45");
const UNISWAP_NPM = getAddress("0xC36442b4a4522E871399CD717aBDD847Ab11FE88");

const REFUSAL = /recipient|receiver|owner|onBehalf|not your|connected wallet|authoriz|refus|multicall|no `?from|no usable/i;

function mockEvmRpc(accounts: `0x${string}`[] = [WALLET]): void {
  vi.doMock("../src/signing/walletconnect.js", () => ({
    requestSendTransaction: vi.fn().mockResolvedValue("0xabc123"),
    getConnectedAccounts: async () => accounts,
  }));
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => ({
      call: vi.fn().mockResolvedValue({ data: "0x" }),
      getTransactionCount: vi.fn().mockResolvedValue(7),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
      estimateGas: vi.fn().mockResolvedValue(120_000n),
    }),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: () => {},
  }));
  vi.doMock("../src/data/prices.js", async (imp) => ({
    ...(await imp<typeof import("../src/data/prices.js")>()),
    getTokenPrice: vi.fn().mockResolvedValue(undefined),
  }));
}

function tx(
  to: `0x${string}`,
  data: `0x${string}`,
  opts: { stamped?: boolean; from?: `0x${string}` | undefined; value?: string } = {},
): unknown {
  const base: Record<string, unknown> = {
    chain: "ethereum" as const,
    to,
    data,
    value: opts.value ?? "0",
    description: "recipient-authorization falsifier",
  };
  if ("from" in opts) base.from = opts.from;
  else base.from = WALLET;
  if (opts.stamped) base.acknowledgedNonProtocolTarget = true;
  return base;
}

async function previewOf(t: unknown): Promise<unknown> {
  const { issueHandles } = await import("../src/signing/tx-store.js");
  const stamped = issueHandles(t as never);
  const { previewSend } = await import("../src/modules/execution/index.js");
  return previewSend({ handle: stamped.handle! });
}

// ── calldata builders ────────────────────────────────────────────────────────
const aaveWithdraw = (to: `0x${string}`) =>
  encodeFunctionData({ abi: aavePoolAbi as Abi, functionName: "withdraw", args: [USDC, 1_000_000n, to] });

const erc20Transfer = (to: `0x${string}`) =>
  encodeFunctionData({ abi: erc20Abi as Abi, functionName: "transfer", args: [to, 1_000_000n] });

const npmMint = (recipient: `0x${string}`) =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "mint",
    args: [
      {
        token0: USDC,
        token1: WETH,
        fee: 3000,
        tickLower: -100,
        tickUpper: 100,
        amount0Desired: 1n,
        amount1Desired: 1n,
        amount0Min: 0n,
        amount1Min: 0n,
        recipient,
        deadline: 9_999_999_999n,
      },
    ],
  });

const npmCollect = (recipient: `0x${string}`) =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "collect",
    args: [{ tokenId: 1n, recipient, amount0Max: 1n, amount1Max: 1n }],
  });

const npmDecreaseLiquidity = () =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "decreaseLiquidity",
    args: [{ tokenId: 1n, liquidity: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n }],
  });

const swapExactInputSingle = (recipient: `0x${string}`, tokenOut: `0x${string}` = USDC) =>
  encodeFunctionData({
    abi: swapRouter02Abi as Abi,
    functionName: "exactInputSingle",
    args: [{ tokenIn: WETH, tokenOut, fee: 3000, recipient, amountIn: 1n, amountOutMinimum: 0n, sqrtPriceLimitX96: 0n }],
  });

const swapUnwrapWeth9 = (amountMinimum: bigint, recipient: `0x${string}`) =>
  encodeFunctionData({ abi: swapRouter02Abi as Abi, functionName: "unwrapWETH9", args: [amountMinimum, recipient] });

const swapRefundEth = () =>
  encodeFunctionData({ abi: swapRouter02Abi as Abi, functionName: "refundETH", args: [] });

const swapMulticall = (legs: `0x${string}`[]) =>
  encodeFunctionData({ abi: swapRouter02Abi as Abi, functionName: "multicall", args: [legs] });

const npmMulticall = (legs: `0x${string}`[]) =>
  encodeFunctionData({ abi: uniswapPositionManagerAbi as Abi, functionName: "multicall", args: [legs] });

const morphoSupplyWithData = (data: `0x${string}`) =>
  encodeFunctionData({
    abi: morphoBlueAbi as Abi,
    functionName: "supply",
    args: [
      { loanToken: USDC, collateralToken: WETH, oracle: FAKE_ORACLE, irm: FAKE_IRM, lltv: 860_000_000_000_000_000n },
      1_000_000n,
      0n,
      WALLET,
      data,
    ],
  });

// ═══════════════════════════ D2-rot enumeration ═══════════════════════════════
describe("#757 D2-rot — module-load anti-rot enumeration", () => {
  it("boots: every recognized-ABI address/opaque-bytes path is classified", () => {
    expect(() => assertClassificationComplete()).not.toThrow();
    const paths = enumerateRecognizedAddressPaths();
    for (const p of paths) expect(p.bucket, `${p.fn}.${p.path} (${p.kind})`).toBeDefined();
  });

  it("TUPLE WALK — finds `.recipient` nested inside exactInputSingle's params tuple (hard-gate)", () => {
    const paths = enumerateRecognizedAddressPaths();
    const hit = paths.find((p) => p.fn === "exactInputSingle" && p.path === "params.recipient");
    expect(hit).toBeDefined();
    expect(hit!.bucket).toBe("recipient");
  });

  it("v6.1 fix — Morpho withdrawCollateral.receiver IS enumerated + hard-gated", () => {
    const paths = enumerateRecognizedAddressPaths();
    const hit = paths.find((p) => p.fn === "withdrawCollateral" && p.path === "receiver");
    expect(hit).toBeDefined();
    expect(hit!.bucket).toBe("recipient");
  });

  it("the six Uniswap token-identity paths are bucket-1 non-recipient (v6 boot-blocker)", () => {
    const paths = enumerateRecognizedAddressPaths();
    for (const [fn, path] of [
      ["mint", "params.token0"],
      ["mint", "params.token1"],
      ["exactInputSingle", "params.tokenIn"],
      ["exactInputSingle", "params.tokenOut"],
      ["exactOutputSingle", "params.tokenIn"],
      ["exactOutputSingle", "params.tokenOut"],
    ] as const) {
      const hit = paths.find((p) => p.fn === fn && p.path === path);
      expect(hit, `${fn}.${path}`).toBeDefined();
      expect(hit!.bucket).toBe("non-recipient");
    }
  });

  it("DETECTOR falsifier — a synthetic ABI with an unmapped address arg is reported unclassified", () => {
    const rogueAbi = [
      { type: "function", name: "drainTo", stateMutability: "nonpayable", inputs: [{ name: "beneficiary", type: "address" }], outputs: [] },
    ] as const;
    const unclassified = findUnclassifiedPaths([rogueAbi as unknown as Abi]);
    expect(unclassified).toContain("drainTo.beneficiary");
  });

  it("DETECTOR falsifier — an unmapped opaque bytes arg on a state-mutating fn is reported", () => {
    const rogueAbi = [
      { type: "function", name: "exec", stateMutability: "payable", inputs: [{ name: "blob", type: "bytes" }], outputs: [] },
    ] as const;
    expect(findUnclassifiedPaths([rogueAbi as unknown as Abi])).toContain("exec.blob");
  });
});

// ═══════════════════════════ F1 — walkParam total over the grammar ════════════
describe("#757 F1 — walkParam is TOTAL over the ABI type grammar (no blind shape)", () => {
  // A leaf the walker never emits is a leaf the boot enumeration never demands a
  // bucket for and gateCall never gates. PRE-F1 these shapes emitted NO leaf, so
  // findUnclassifiedPaths could not see them — a recipient hidden in an
  // `address[2]`/`tuple[2]`/`bytes20` on a recognized dest booted clean and signed.
  // POST-F1 the walker decomposes every shape and the detector reports it. Each
  // `toContain` goes RED if the walkParam total-grammar rewrite is reverted (the
  // old walker's trailing scalar no-op swallows these), while the CONTROL stays
  // GREEN either way — proving the detection is the fix, not a broken apparatus.
  const mkAbi = (name: string, inputs: readonly unknown[]): Abi =>
    [{ type: "function", name, stateMutability: "nonpayable", inputs, outputs: [] }] as unknown as Abi;

  it("address[2] (fixed-size array) recipient is DETECTED", () => {
    expect(findUnclassifiedPaths([mkAbi("distribute", [{ name: "recipient", type: "address[2]" }])])).toContain(
      "distribute.recipient",
    );
  });
  it("address[][] (nested array) recipient is DETECTED", () => {
    expect(findUnclassifiedPaths([mkAbi("fanout", [{ name: "recipient", type: "address[][]" }])])).toContain(
      "fanout.recipient",
    );
  });
  it("tuple[2] (fixed-size tuple array) with an address field is DETECTED", () => {
    const abi = mkAbi("batch", [
      {
        name: "orders",
        type: "tuple[2]",
        components: [
          { name: "recipient", type: "address" },
          { name: "amount", type: "uint256" },
        ],
      },
    ]);
    expect(findUnclassifiedPaths([abi])).toContain("batch.orders.recipient");
  });
  it("bytes[2] (fixed-size bytes array) is DETECTED (recurse leaf)", () => {
    expect(findUnclassifiedPaths([mkAbi("execMany", [{ name: "calls", type: "bytes[2]" }])])).toContain(
      "execMany.calls",
    );
  });
  it("bytes20 (bytesM, M≠32) is DETECTED (opaque leaf)", () => {
    expect(findUnclassifiedPaths([mkAbi("tag", [{ name: "blob", type: "bytes20" }])])).toContain("tag.blob");
  });
  it("SEC's exact falsifier — address[2] recipient + bytes20 param on one fn, BOTH detected", () => {
    const abi = mkAbi("drain", [
      { name: "recipient", type: "address[2]" },
      { name: "note", type: "bytes20" },
    ]);
    const unclassified = findUnclassifiedPaths([abi]);
    expect(unclassified).toContain("drain.recipient");
    expect(unclassified).toContain("drain.note");
  });
  it("CONTROL — plain uint256/bool/string args emit NO leaf (walker is total, not over-eager)", () => {
    const abi = mkAbi("noop", [
      { name: "amount", type: "uint256" },
      { name: "flag", type: "bool" },
      { name: "memo", type: "string" },
      { name: "ids", type: "uint256[]" },
    ]);
    expect(findUnclassifiedPaths([abi])).toHaveLength(0);
  });
});

// ═══════════════════════════ D2 bucket-4 provenance ═══════════════════════════
describe("#757 D2/D3 — bucket-4 USER_DIRECTED provenance discriminator", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("erc20 transfer(ATTACKER) UNSTAMPED → PASSES (prepare_token_send's normal case)", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(USDC, erc20Transfer(ATTACKER)))).resolves.toBeDefined();
  });
  it("erc20 transfer(ATTACKER) STAMPED (custom-call reachable) → REFUSED", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(USDC, erc20Transfer(ATTACKER), { stamped: true }))).rejects.toThrow(REFUSAL);
  });
  it("Uniswap NPM mint(recipient=ATTACKER) UNSTAMPED → PASSES (live standalone tool)", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(UNISWAP_NPM, npmMint(ATTACKER)))).resolves.toBeDefined();
  });
  it("Uniswap NPM mint(recipient=ATTACKER) STAMPED → REFUSED", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(UNISWAP_NPM, npmMint(ATTACKER), { stamped: true }))).rejects.toThrow(REFUSAL);
  });
  it("Uniswap NPM collect(recipient=ATTACKER) STAMPED → REFUSED", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(UNISWAP_NPM, npmCollect(ATTACKER), { stamped: true }))).rejects.toThrow(REFUSAL);
  });
  it("Uniswap NPM collect(recipient=wallet) STAMPED → PASSES (wallet recipient clears the hard gate)", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(UNISWAP_NPM, npmCollect(WALLET), { stamped: true }))).resolves.toBeDefined();
  });
});

// ═══════════════════════════ D2-rot REQUIRE-EMPTY / decode ════════════════════
describe("#757 D2-rot — opaque-bytes REQUIRE-EMPTY + top-level decode-refuse", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("Morpho supply with a NON-EMPTY data payload → REFUSED", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(MORPHO_BLUE, morphoSupplyWithData("0xdeadbeef")))).rejects.toThrow(REFUSAL);
  });
  it("Morpho supply with EMPTY data (0x) → PASSES", async () => {
    mockEvmRpc();
    await expect(previewOf(tx(MORPHO_BLUE, morphoSupplyWithData("0x")))).resolves.toBeDefined();
  });
  it("a recognized selector with truncated args (decode throws) → REFUSED", async () => {
    mockEvmRpc();
    const selector = aaveWithdraw(WALLET).slice(0, 10) as `0x${string}`;
    const truncated = (selector + "00".repeat(32)) as `0x${string}`; // one word, needs three
    await expect(previewOf(tx(AAVE_V3_POOL, truncated))).rejects.toThrow(REFUSAL);
  });
});

// ═══════════════════════════ D4 mixed-case ════════════════════════════════════
describe("#757 D4 — checksum normalization (getAddress both sides)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("Aave withdraw to=wallet with wallet lower-cased on tx.from → PASSES (not a false refuse)", async () => {
    mockEvmRpc([WALLET]);
    // tx.from lower-cased, recipient checksummed — one-sided/no normalization would wrongly refuse.
    await expect(
      previewOf(tx(AAVE_V3_POOL, aaveWithdraw(WALLET), { from: WALLET.toLowerCase() as `0x${string}` })),
    ).resolves.toBeDefined();
  });
});

// ═══════════════════════════ D7 multicall ═════════════════════════════════════
describe("#757 D7 — multicall universal per-leg + router-self exception", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it("native-out swap [exactInputSingle(tokenOut=WETH, recipient=router), unwrapWETH9(1, wallet)] → PASSES", async () => {
    mockEvmRpc();
    const data = swapMulticall([swapExactInputSingle(UNISWAP_SWAP_ROUTER_02, WETH), swapUnwrapWeth9(1n, WALLET)]);
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, data))).resolves.toBeDefined();
  });
  it("per-leg drain [exactInputSingle(recipient=ATTACKER)] → REFUSED", async () => {
    mockEvmRpc();
    const data = swapMulticall([swapExactInputSingle(ATTACKER)]);
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, data))).rejects.toThrow(REFUSAL);
  });
  it("router-self on a NON-WETH leg paired only with refundETH() → REFUSED", async () => {
    mockEvmRpc();
    const data = swapMulticall([swapExactInputSingle(UNISWAP_SWAP_ROUTER_02, DAI), swapRefundEth()]);
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, data))).rejects.toThrow(REFUSAL);
  });
  it("ORDERING — terminal unwrap BEFORE the router-self leg → REFUSED (requirement (b) is positional)", async () => {
    mockEvmRpc();
    const data = swapMulticall([swapUnwrapWeth9(1n, WALLET), swapExactInputSingle(UNISWAP_SWAP_ROUTER_02, WETH)]);
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, data))).rejects.toThrow(REFUSAL);
  });
  it("unrecognized sub-call selector (approve, absent from swapRouter02) → REFUSED", async () => {
    mockEvmRpc();
    const approveLeg = encodeFunctionData({ abi: erc20Abi as Abi, functionName: "approve", args: [ATTACKER, 1n] });
    const data = swapMulticall([approveLeg]);
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, data))).rejects.toThrow(REFUSAL);
  });
  it("breadth budget — more than SUB_CALL_BUDGET legs → REFUSED", async () => {
    mockEvmRpc();
    const legs = Array.from({ length: SUB_CALL_BUDGET + 1 }, () => swapUnwrapWeth9(1n, WALLET));
    await expect(previewOf(tx(UNISWAP_SWAP_ROUTER_02, swapMulticall(legs)))).rejects.toThrow(REFUSAL);
  });
  it("STAMP THREADING — NPM multicall([decreaseLiquidity, collect(recipient=ATTACKER)]) STAMPED → REFUSED", async () => {
    mockEvmRpc();
    const data = npmMulticall([npmDecreaseLiquidity(), npmCollect(ATTACKER)]);
    await expect(previewOf(tx(UNISWAP_NPM, data, { stamped: true }))).rejects.toThrow(REFUSAL);
  });
});

// ═══════════════════════════ D1 precondition (preview) ════════════════════════
describe("#757 D1 — fail-closed account-set precondition (PREVIEW locus)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // Empty account set → REFUSED — the D1 branch-1 LINKAGE (gate refuses on the
  // empty RESULT, independent of which producer emptied it). The FOUR distinct
  // producer states that each empty the set are exercised against the REAL
  // getConnectedAccounts in test/757-d1-producer-states.test.ts; a stub-`[]` ×4
  // loop here could not tell them apart (REVIEW's overclaim finding).
  it("empty account set → REFUSED (even with a wallet recipient)", async () => {
    mockEvmRpc([]);
    await expect(previewOf(tx(AAVE_V3_POOL, aaveWithdraw(WALLET)))).rejects.toThrow(REFUSAL);
  });

  it("falsy/missing tx.from (non-demo) → REFUSED (design D1 branch 2)", async () => {
    mockEvmRpc([WALLET]);
    await expect(previewOf(tx(AAVE_V3_POOL, aaveWithdraw(WALLET), { from: undefined }))).rejects.toThrow(REFUSAL);
  });

  it("non-empty set that does NOT include tx.from → REFUSED", async () => {
    mockEvmRpc([ATTACKER]);
    await expect(previewOf(tx(AAVE_V3_POOL, aaveWithdraw(WALLET)))).rejects.toThrow(REFUSAL);
  });
});

// ═══════════════════════════ §5 send-time re-check ════════════════════════════
describe("#757 §5 — send-time re-check re-reads the account set at SEND", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  async function sendWithAccountsAtSend(accountsAtSend: `0x${string}`[]): Promise<unknown> {
    vi.doMock("../src/signing/walletconnect.js", () => ({
      requestSendTransaction: vi.fn().mockResolvedValue("0xdeadbeef" as `0x${string}`),
      getConnectedAccounts: async () => accountsAtSend,
    }));
    const { issueHandles, attachPinnedGas } = await import("../src/signing/tx-store.js");
    const stamped = issueHandles(tx(AAVE_V3_POOL, aaveWithdraw(WALLET)) as never);
    attachPinnedGas(stamped.handle!, {
      nonce: 7,
      maxFeePerGas: 30_000_000_000n,
      maxPriorityFeePerGas: 1_000_000_000n,
      gas: 100_000n,
      preSignHash: ("0x" + "ab".repeat(32)) as `0x${string}`,
      pinnedAt: Date.now(),
      previewToken: "tok-send",
    });
    const { sendTransaction } = await import("../src/modules/execution/index.js");
    return sendTransaction({ handle: stamped.handle!, previewToken: "tok-send", userDecision: "send" });
  }

  it("account set SWAPPED to [ATTACKER] between preview and send → REFUSED at send", async () => {
    await expect(sendWithAccountsAtSend([ATTACKER])).rejects.toThrow(REFUSAL);
  });
  it("account set EMPTY at send → REFUSED at send (fail-closed precondition re-runs)", async () => {
    await expect(sendWithAccountsAtSend([])).rejects.toThrow(REFUSAL);
  });
  it("account set still [WALLET] at send → forwards to WalletConnect", async () => {
    await expect(sendWithAccountsAtSend([WALLET])).resolves.toMatchObject({ txHash: "0xdeadbeef" });
  });
});

// ═══════════════════════════ U1 — no fourth stamp writer ══════════════════════
describe("#757 U1 — acknowledgedNonProtocolTarget has exactly three server writers", () => {
  it("no fourth writer appears in src/ (SEC-suggested regression guard, design D3)", () => {
    const srcDir = new URL("../src/", import.meta.url).pathname;
    const tsFiles: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = `${dir}${e.name}`;
        if (e.isDirectory()) walk(`${p}/`);
        else if (e.name.endsWith(".ts")) tsFiles.push(p);
      }
    };
    walk(srcDir);
    const writers: string[] = [];
    // A WRITE is an assignment/object-literal set of the flag to a value — NOT a
    // read (`=== true`) and NOT a type/interface field (`?:`) or a doc comment.
    const writeRe = /acknowledgedNonProtocolTarget\s*[:=]\s*(?!=)/;
    for (const f of tsFiles) {
      readFileSync(f, "utf8")
        .split("\n")
        .forEach((line) => {
          if (writeRe.test(line) && !/\?\s*:/.test(line) && !/^\s*\*/.test(line)) writers.push(`${f}: ${line.trim()}`);
        });
    }
    // Two Curve builder stamps + one custom-call stamp = three. A fourth means a
    // new write site silently reopened the provenance question U1 settled.
    expect(writers, writers.join("\n")).toHaveLength(3);
  });
});
