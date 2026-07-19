/**
 * OVER-BLOCK REGRESSION POSITIVE CONTROLS — #757 recipient-authorization seam.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: these tests assert the LEGITIMATE behaviour (a recognized        │
 * │ state-mutating call with NO recipient/authority dimension is SIGNABLE).  │
 * │ They are RED against the FIRST spine commit (b46a851) BY DESIGN — that   │
 * │ commit built `FN_BY_SELECTOR` ONLY from `SPEC` (address-bearing fns), so │
 * │ every RECOGNIZED function with no address argument (WETH.withdraw,        │
 * │ wstETH.wrap/unwrap, rETH.burn, RocketDepositPool.deposit, Uniswap        │
 * │ increase/decrease/burn, and the rebalance multicall's decreaseLiquidity  │
 * │ leg) fell into `gateCall`/`decodeLeg`'s "unknown selector → REFUSE"      │
 * │ branch even though pre-sign block 5 ACCEPTS it. No positive control      │
 * │ existed, so the over-block shipped GREEN. This file is that control: the │
 * │ over-block fix must turn every RED assertion here GREEN while the #757    │
 * │ drain falsifiers (757-760-recipient-drain.test.ts) STAY GREEN.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The regression (agenthill/vaultpilot-mcp #757 rework):
 *   `recipient-authorization.ts` built `FN_BY_SELECTOR` from `SPEC`, and `SPEC`
 *   by construction lists ONLY functions that carry an address/bytes leaf. A
 *   recognized function with no such leaf therefore had no `FN_BY_SELECTOR`
 *   entry, so `gateCall` (outer) and `decodeLeg` (multicall leg) treated its
 *   selector as unknown → REFUSE — over-blocking ~8 live tools that worked on
 *   `main` (block 5 accepted them; there was no recipient gate).
 *
 * WHY THE ENTRY POINT IS `previewSend`: identical to the drain falsifiers — the
 * recipient/authority gate lives in `runEvmPreSignGuards`, reachable only
 * through `previewSend`, AFTER the fail-closed WalletConnect account-set match.
 * These flows carry NO `acknowledgedNonProtocolTarget` stamp — they are the
 * normal per-protocol `prepare_*` outputs, not `prepare_custom_call`.
 *
 * De-identified fixtures: WALLET is a fake repeated-digit address; the
 * destinations are the REAL pinned recognized contracts (mainnet). No real
 * user data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { wethAbi } from "../src/abis/weth.js";
import { wstETHAbi } from "../src/abis/lido.js";
import { rocketDepositPoolAbi, rocketTokenRETHAbi } from "../src/abis/rocketpool.js";
import { uniswapPositionManagerAbi } from "../src/abis/uniswap-position-manager.js";

// ── De-identified fake account (the victim's connected device account) ──────
const WALLET = getAddress("0x1111111111111111111111111111111111111111");

// ── REAL pinned recognized destinations (ethereum) — src/config/contracts.ts ─
const WETH9 = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const WSTETH = getAddress("0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0");
const RETH = getAddress("0xae78736Cd615f374D3085123A210448E74Fc6393");
const ROCKET_DEPOSIT_POOL = getAddress("0xDD3f50F8A6CafbE9b31a427582963f465E745AF8");
const UNISWAP_NPM = getAddress("0xC36442b4a4522E871399CD717aBDD847Ab11FE88");

// ── Legit calldata builders (the exact shapes the per-protocol builders emit) ─
const wethWithdraw = (): `0x${string}` =>
  encodeFunctionData({ abi: wethAbi as Abi, functionName: "withdraw", args: [1_000_000_000_000_000_000n] });

const wstWrap = (): `0x${string}` =>
  encodeFunctionData({ abi: wstETHAbi as Abi, functionName: "wrap", args: [1_000_000_000_000_000_000n] });

const wstUnwrap = (): `0x${string}` =>
  encodeFunctionData({ abi: wstETHAbi as Abi, functionName: "unwrap", args: [1_000_000_000_000_000_000n] });

const rocketDeposit = (): `0x${string}` =>
  encodeFunctionData({ abi: rocketDepositPoolAbi as Abi, functionName: "deposit", args: [] });

const rethBurn = (): `0x${string}` =>
  encodeFunctionData({ abi: rocketTokenRETHAbi as Abi, functionName: "burn", args: [1_000_000_000_000_000_000n] });

const uniIncrease = (): `0x${string}` =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "increaseLiquidity",
    args: [{ tokenId: 42n, amount0Desired: 1n, amount1Desired: 1n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n }],
  });

const uniDecrease = (): `0x${string}` =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "decreaseLiquidity",
    args: [{ tokenId: 42n, liquidity: 1_000n, amount0Min: 0n, amount1Min: 0n, deadline: 9_999_999_999n }],
  });

const uniBurn = (): `0x${string}` =>
  encodeFunctionData({ abi: uniswapPositionManagerAbi as Abi, functionName: "burn", args: [42n] });

const uniCollectToWallet = (): `0x${string}` =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "collect",
    args: [{ tokenId: 42n, recipient: WALLET, amount0Max: (1n << 128n) - 1n, amount1Max: (1n << 128n) - 1n }],
  });

// A legit rebalance: decreaseLiquidity + collect(recipient=wallet) batched via
// multicall(bytes[]). The decreaseLiquidity leg is exactly what `decodeLeg`
// refused pre-fix (recognized-by-block-5, no address arg, absent from SPEC).
const rebalanceMulticall = (): `0x${string}` =>
  encodeFunctionData({
    abi: uniswapPositionManagerAbi as Abi,
    functionName: "multicall",
    args: [[uniDecrease(), uniCollectToWallet()]],
  });

/**
 * A tx as a per-protocol `prepare_*` tool emits it: no `acknowledgedNonProtocolTarget`
 * stamp (these are NOT `prepare_custom_call`), `from` == the connected wallet.
 */
function legitTx(to: `0x${string}`, data: `0x${string}`, value = "0"): unknown {
  return {
    chain: "ethereum" as const,
    to,
    data,
    value,
    from: WALLET,
    description: "#757 over-block positive control",
  };
}

/**
 * Same mock harness as the drain falsifiers: RPC + WalletConnect account set so
 * `previewSend` reaches the gate locus (`runEvmPreSignGuards`, after the
 * account-set match) without live network. `getConnectedAccounts` returns
 * exactly [WALLET] so `tx.from` passes the account-set match. `pre-sign-check.js`
 * is deliberately NOT mocked — the REAL classifyDestination + block 5 run.
 */
function mockEvmRpc(): void {
  vi.doMock("../src/signing/walletconnect.js", () => ({
    requestSendTransaction: vi.fn().mockResolvedValue("0xabc123"),
    getConnectedAccounts: async () => [WALLET],
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

async function previewOf(tx: unknown): Promise<unknown> {
  const { issueHandles } = await import("../src/signing/tx-store.js");
  const stamped = issueHandles(tx as never);
  const { previewSend } = await import("../src/modules/execution/index.js");
  return previewSend({ handle: stamped.handle! });
}

// Every over-blocked flow: recognized destination, recognized selector (block 5
// accepts it), NO recipient/authority dimension → MUST be signable.
const OVER_BLOCKED = [
  { tool: "prepare_weth_unwrap", fn: "WETH.withdraw(uint256)", to: WETH9, build: wethWithdraw, value: "0" },
  { tool: "prepare_lido_wrap", fn: "wstETH.wrap(uint256)", to: WSTETH, build: wstWrap, value: "0" },
  { tool: "prepare_lido_unwrap", fn: "wstETH.unwrap(uint256)", to: WSTETH, build: wstUnwrap, value: "0" },
  { tool: "prepare_rocketpool_stake", fn: "RocketDepositPool.deposit()", to: ROCKET_DEPOSIT_POOL, build: rocketDeposit, value: "1000000000000000000" },
  { tool: "prepare_rocketpool_unstake", fn: "rETH.burn(uint256)", to: RETH, build: rethBurn, value: "0" },
  { tool: "prepare_uniswap_v3_increase", fn: "NPM.increaseLiquidity((...))", to: UNISWAP_NPM, build: uniIncrease, value: "0" },
  { tool: "prepare_uniswap_v3_decrease", fn: "NPM.decreaseLiquidity((...))", to: UNISWAP_NPM, build: uniDecrease, value: "0" },
  { tool: "prepare_uniswap_v3_burn", fn: "NPM.burn(uint256)", to: UNISWAP_NPM, build: uniBurn, value: "0" },
  { tool: "prepare_uniswap_v3_rebalance", fn: "NPM.multicall([decreaseLiquidity, collect(recipient=wallet)])", to: UNISWAP_NPM, build: rebalanceMulticall, value: "0" },
] as const;

describe("#757 over-block positive controls — recognized no-recipient calls MUST stay signable (RED on b46a851)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it.each(OVER_BLOCKED)(
    "$tool — $fn MUST PASS the recipient seam (RED pre-fix: over-blocked as 'unknown selector')",
    async ({ to, build, value }) => {
      mockEvmRpc();
      await expect(previewOf(legitTx(to, build(), value))).resolves.toBeDefined();
    },
  );
});
