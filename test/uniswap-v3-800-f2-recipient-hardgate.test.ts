/**
 * FALSIFIERS for incident #800 F2 — Uniswap V3 `collect`/`mint` route to an
 * attacker-set `recipient`, unstamped, live on `main`.
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: these tests assert the SAFE behaviour (the drain is REFUSED).    │
 * │ They are RED against current `main` BY DESIGN — the drain is signable    │
 * │ TODAY. That RED is the proof-of-drain (incident #800 F2, filed against   │
 * │ #787 / 2e97ca9). This file is the acceptance criterion for the eventual  │
 * │ fix (move mint/collect.recipient into the hard-gate `recipient` bucket,  │
 * │ matching swapRouter02.recipient) — NOT a fix itself. TEST-ONLY, no       │
 * │ src/ change lands on this branch.                                       │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The defect (agenthill/vaultpilot-mcp #800, F2):
 *   `prepare_uniswap_v3_collect` / `prepare_uniswap_v3_mint` take an
 *   agent-settable `recipient` (schemas.ts prepareUniswapV3CollectInput /
 *   MintInput). The builders honour it verbatim — `buildUniswapCollect` /
 *   `buildUniswapMint` in `src/modules/lp/uniswap-v3/actions.ts` compute
 *   `const recipient = p.recipient ?? p.wallet`. The outer `to` (the NPM) is a
 *   RECOGNIZED destination, so block 4's argument-agnostic catch-all never
 *   fires. `recipient-authorization.ts` classifies `mint`/`collect`'s
 *   `params.recipient` as bucket-4 `user-directed` (SPEC entries for
 *   `uniswapPositionManagerAbi` `mint`/`collect`), which `gateCall` passes
 *   UNSTAMPED — no `acknowledgedNonProtocolTarget` is ever set on these
 *   builders' output, so the hard-gate branch in `gateCall`
 *   (`if (ctx.stamped) gateHardRecipient(...)`) never triggers. Contrast
 *   `swapRouter02.recipient` (same file, `exactInputSingle`/
 *   `exactOutputSingle`/`unwrapWETH9`), which is bucket "recipient"
 *   (hard-gated unconditionally) — the identical-shaped field on a sibling
 *   Uniswap contract gets the opposite treatment.
 *
 * WHY THE ENTRY POINT IS `prepareUniswapV3Collect`/`prepareUniswapV3Mint`,
 * NOT hand-built calldata: those are the literal functions `txHandler(
 * "prepare_uniswap_v3_collect", prepareUniswapV3Collect)` /
 * `txHandler("prepare_uniswap_v3_mint", prepareUniswapV3Mint)` wire to the
 * MCP tools in `src/index.ts` — the exact agent-facing entry point #800
 * names (`prepare_uniswap_v3_collect(tokenId, recipient=ATTACKER)`). Each
 * wraps `enrichTx(await buildUniswap{Collect,Mint}(...))` — the builders
 * #800 cites by file:line. Only `enrichTx`'s UX-only gas-estimate / price
 * enrichment is skipped versus the full `prepare_*` MCP tool (no gate logic
 * lives there); `issueHandles` + `previewSend` — the REAL pre-sign path,
 * `assertTransactionSafe` and `recipient-authorization.ts` both live and
 * unmocked — run exactly as they would for a real agent call. Mirrors the
 * `previewOf` harness in test/757-recipient-authorization.test.ts and
 * test/757-760-recipient-drain.test.ts; RPC preflight is mocked (position
 * read, pool state, token meta, gas), the gate itself never is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getAddress } from "viem";

// ── De-identified fake addresses ──────────────────────────────────────────
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
const ATTACKER = getAddress("0x2222222222222222222222222222222222222222");
// Real mainnet USDC/WETH — used only as distinct token identities for the
// mint pair; the same pair + pool-state fixture as test/uniswap-v3-mint.test.ts
// (known to satisfy the tick-math invariant getSqrtRatioAtTick(tick) <=
// sqrtPriceX96 < getSqrtRatioAtTick(tick+1)), so this file's failures are the
// gate under test, never the position-math port.
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
const USDC_WETH_POOL = getAddress("0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8");
// Pre-computed via TickMath.getSqrtRatioAtTick(-201960) — same fixture
// test/uniswap-v3-mint.test.ts uses for its happy path.
const FAKE_CURRENT_TICK = -201_960;
const FAKE_SQRT_PRICE_X96 = 3_262_820_378_846_468_593_912_909n;
const FAKE_POOL_LIQUIDITY = 10_000_000_000_000_000_000n;
const MINT_TICK_LOWER = -202_020; // aligned to tickSpacing=60 @ feeTier 3000
const MINT_TICK_UPPER = -201_900;

const REFUSAL =
  /recipient|receiver|owner|onBehalf|not your|connected wallet|authoriz|refus|multicall|no `?from|no usable/i;

/**
 * One mocked viem client covering every RPC read `buildUniswapCollect` /
 * `buildUniswapMint` / `enrichTx` / `previewSend`'s pin phase issue. Routes
 * `readContract` / `multicall` per-entry by `functionName` (array order is
 * preserved by `.map`, so multi-entry multicalls — token-pair-meta, pool
 * slot0+liquidity, position+ownerOf — resolve correctly without needing to
 * inspect the batch shape). `allowance` returns max so no approval leg is
 * emitted (mint's output stays a single node — the recipient dimension under
 * test, not the approval chain). An unexpected read throws loudly rather
 * than returning `undefined`, so a builder change that adds a new RPC call
 * surfaces as a test failure instead of a silent bad fixture.
 */
function evmClient() {
  const byFn = (fn: string): unknown => {
    switch (fn) {
      case "positions":
        // [nonce, operator, token0, token1, fee, tickLower, tickUpper,
        //  liquidity, feeGrowthInside0LastX128, feeGrowthInside1LastX128,
        //  tokensOwed0, tokensOwed1] — readOwnedPosition's positional read.
        return [
          0n,
          "0x0000000000000000000000000000000000000000",
          USDC,
          WETH,
          3000,
          MINT_TICK_LOWER,
          MINT_TICK_UPPER,
          5_000_000_000_000_000_000n,
          0n,
          0n,
          1_000_000n,
          1_000_000n,
        ];
      case "ownerOf":
        return WALLET; // the position is owned by the caller — ownership check passes
      case "getPool":
        return USDC_WETH_POOL;
      case "slot0":
        return [FAKE_SQRT_PRICE_X96, FAKE_CURRENT_TICK, 0, 1, 1, 0, true];
      case "liquidity":
        return FAKE_POOL_LIQUIDITY;
      case "decimals":
        return 18;
      case "symbol":
        return "TOK";
      case "allowance":
        return (1n << 256n) - 1n; // maxUint256 — no approval leg needed
      default:
        throw new Error(`evmClient: unexpected read ${fn}`);
    }
  };
  return {
    readContract: vi.fn(async (call: { functionName: string }) => byFn(call.functionName)),
    multicall: vi.fn(async ({ contracts }: { contracts: { functionName: string }[] }) =>
      contracts.map((c) => byFn(c.functionName)),
    ),
    call: vi.fn().mockResolvedValue({ data: "0x" }), // simulateTx eth_call → ok
    getGasPrice: vi.fn().mockResolvedValue(20_000_000_000n),
    getTransactionCount: vi.fn().mockResolvedValue(7),
    getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
    estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
    estimateGas: vi.fn().mockResolvedValue(250_000n),
  };
}

function mockRpc(): void {
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => evmClient(),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: () => {},
  }));
  vi.doMock("../src/signing/walletconnect.js", () => ({
    requestSendTransaction: vi.fn().mockResolvedValue("0xabc123"),
    getConnectedAccounts: async () => [WALLET],
  }));
  // Keep the preview-cost price lookup off the network (degrades to native-only).
  vi.doMock("../src/data/prices.js", async (imp) => ({
    ...(await imp<typeof import("../src/data/prices.js")>()),
    getTokenPrice: vi.fn().mockResolvedValue(undefined),
  }));
}

/** Drive a builder's output through the REAL pre-sign path (issueHandles → previewSend). */
async function previewOf(tx: unknown): Promise<unknown> {
  const { issueHandles } = await import("../src/signing/tx-store.js");
  const stamped = issueHandles(tx as never);
  const { previewSend } = await import("../src/modules/execution/index.js");
  return previewSend({ handle: stamped.handle! });
}

describe("#800 F2 — Uniswap V3 collect/mint recipient reaches an attacker, UNSTAMPED, live on main", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // ── prepare_uniswap_v3_collect ──────────────────────────────────────────
  describe("prepare_uniswap_v3_collect", () => {
    it("recipient=ATTACKER MUST be REFUSED at pre-sign (RED today: accrued fees + tokensOwed drain unstamped)", async () => {
      mockRpc();
      const { prepareUniswapV3Collect } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Collect({
        wallet: WALLET,
        chain: "ethereum",
        tokenId: "42",
        recipient: ATTACKER,
      });
      await expect(previewOf(tx)).rejects.toThrow(REFUSAL);
    });

    it("over-refusal control — recipient=wallet (explicit) MUST still PASS (GREEN now and after fix)", async () => {
      mockRpc();
      const { prepareUniswapV3Collect } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Collect({
        wallet: WALLET,
        chain: "ethereum",
        tokenId: "42",
        recipient: WALLET,
      });
      await expect(previewOf(tx)).resolves.toBeDefined();
    });

    it("over-refusal control — recipient omitted (defaults to wallet) MUST still PASS", async () => {
      mockRpc();
      const { prepareUniswapV3Collect } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Collect({
        wallet: WALLET,
        chain: "ethereum",
        tokenId: "42",
      });
      await expect(previewOf(tx)).resolves.toBeDefined();
    });
  });

  // ── prepare_uniswap_v3_mint ──────────────────────────────────────────────
  describe("prepare_uniswap_v3_mint", () => {
    const mintArgs = (recipient: `0x${string}` | undefined) => ({
      wallet: WALLET,
      chain: "ethereum" as const,
      tokenA: USDC,
      tokenB: WETH,
      feeTier: 3000 as const,
      tickLower: MINT_TICK_LOWER,
      tickUpper: MINT_TICK_UPPER,
      amountADesired: "100",
      amountBDesired: "0.05",
      recipient,
    });

    it("recipient=ATTACKER MUST be REFUSED at pre-sign (RED today: the minted position NFT — and its deposited principal — go to the attacker, unstamped)", async () => {
      mockRpc();
      const { prepareUniswapV3Mint } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Mint(mintArgs(ATTACKER));
      await expect(previewOf(tx)).rejects.toThrow(REFUSAL);
    });

    it("over-refusal control — recipient=wallet (explicit) MUST still PASS (GREEN now and after fix)", async () => {
      mockRpc();
      const { prepareUniswapV3Mint } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Mint(mintArgs(WALLET));
      await expect(previewOf(tx)).resolves.toBeDefined();
    });

    it("over-refusal control — recipient omitted (defaults to wallet) MUST still PASS", async () => {
      mockRpc();
      const { prepareUniswapV3Mint } = await import("../src/modules/execution/index.js");
      const tx = await prepareUniswapV3Mint(mintArgs(undefined));
      await expect(previewOf(tx)).resolves.toBeDefined();
    });
  });
});
