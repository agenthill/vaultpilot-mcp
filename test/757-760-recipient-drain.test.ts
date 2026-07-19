/**
 * INCIDENT-REPRODUCTION FALSIFIERS — #757 + #760 (recipient-authorization seam).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: these tests assert the SAFE behaviour (the drain is REFUSED).    │
 * │ They are RED against current `main` BY DESIGN — the drains are signable  │
 * │ TODAY. That RED is the proof-of-drain. The #759 recipient-authorization  │
 * │ fix (HELD — build gated on #765 v6 + REVIEW re-approval) must turn every │
 * │ RED assertion here GREEN. This file is the acceptance criterion; it is   │
 * │ committed on the prep branch with NO PR (a PR would run RED CI on the    │
 * │ intentionally-failing falsifiers, which is not wanted yet).              │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The two incidents (agenthill/vaultpilot-mcp #757, #760):
 *
 *  #757 — `assertTransactionSafe` block 5 checks WHICH function is called
 *         (selector ∈ curated ABI) but never WHERE the value/authority goes.
 *         Block 4 (the argument-agnostic catch-all, ack-consulted) is skipped
 *         for RECOGNIZED destinations (`if (!dest)` — dest is truthy). So a
 *         recipient-bearing function on a pinned protocol drains to an
 *         arbitrary address: Aave `withdraw(...,to)`, Morpho `withdraw/borrow
 *         (...,receiver)`, Lido `requestWithdrawals(...,owner)`, Uniswap
 *         `exactInputSingle(...,recipient)` (tuple-nested — invisible to the
 *         current selector-only gate). Reached via `prepare_custom_call` to the
 *         REAL pinned address with `acknowledgeNonProtocolTarget: true` (a
 *         schema-required literal, INERT here — block 4 never fires).
 *
 *  #760 — LiFi Diamond has `allowedAbi: null`, so block 5 does not run at all
 *         (`if (dest.allowedAbi === null) return;`). Arbitrary LiFi calldata +
 *         arbitrary native value to the recognized LiFi Diamond via
 *         `prepare_custom_call` is signable. #759 (design D8) closes the
 *         extractable-`_receiver` dimension: an ack-stamped LiFi swap whose
 *         `_receiver` is not the wallet must be REFUSED.
 *
 * WHY THE ENTRY POINT IS `previewSend`, NOT a direct `assertTransactionSafe`:
 * per design #759 (docs/design/759-recipient-authorization-seam.md, D1) the
 * recipient/authority gate does NOT live in `assertTransactionSafe` — that
 * function only receives agent-supplied `tx.from`. The gate lands in
 * `runEvmPreSignGuards` (execution/index.ts), AFTER the fail-closed
 * WalletConnect account-set match, and `runEvmPreSignGuards` is reached only
 * through `previewSend`. A direct `assertTransactionSafe(tx)` test would stay
 * RED forever (the fix is not there), so it would be a BROKEN acceptance
 * criterion. These falsifiers therefore drive the real gate: issue a handle,
 * then `previewSend(handle)`. `pre-sign-check.js` is deliberately NOT mocked.
 *
 * De-identified fixtures throughout: WALLET/ATTACKER are fake repeated-digit
 * addresses; the destination addresses are the REAL pinned recognized
 * contracts (that is the point of the incident — being on the allowlist is
 * what opens the door). No real user data.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { encodeFunctionData, getAddress, type Abi } from "viem";
import { aavePoolAbi } from "../src/abis/aave-pool.js";
import { morphoBlueAbi } from "../src/abis/morpho-blue.js";
import { lidoWithdrawalQueueAbi } from "../src/abis/lido.js";
import { swapRouter02Abi } from "../src/abis/uniswap-swap-router-02.js";
import { lifiDiamondAbi } from "../src/abis/lifi-diamond.js";

// ── De-identified fake addresses ──────────────────────────────────────────
/** The victim's connected device account. `tx.from` == this; the drain is FROM here. */
const WALLET = getAddress("0x1111111111111111111111111111111111111111");
/** The drain target. NOT the wallet, NOT a saved contact. */
const ATTACKER = getAddress("0x2222222222222222222222222222222222222222");
const FAKE_ORACLE = getAddress("0x3333333333333333333333333333333333333333");
const FAKE_IRM = getAddress("0x4444444444444444444444444444444444444444");
const USDC = getAddress("0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48");
const WETH = getAddress("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
/** LiFi native-ETH sentinel for `sendingAssetId` on a native→ERC20 swap. */
const ETH_SENTINEL = getAddress("0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE");

// ── REAL pinned recognized destinations (ethereum) — src/config/contracts.ts ─
const AAVE_V3_POOL = getAddress("0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2");
const MORPHO_BLUE = getAddress("0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb");
const LIDO_WITHDRAWAL_QUEUE = getAddress(
  "0x889edC2eDab5f40e902b864aD4d7AdE8E412F9B1",
);
const UNISWAP_SWAP_ROUTER_02 = getAddress(
  "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45",
);
const LIFI_DIAMOND = getAddress("0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae");

// ── Calldata builders (recipient parameterized) ───────────────────────────
// Encoded against the repo's OWN curated ABIs so block 5 recognizes every
// selector by construction — exactly why the current selector-only gate lets
// them through.
const aaveWithdraw = (to: `0x${string}`): `0x${string}` =>
  encodeFunctionData({
    abi: aavePoolAbi as Abi,
    functionName: "withdraw",
    args: [USDC, 1_000_000n, to],
  });

const morphoWithdraw = (receiver: `0x${string}`): `0x${string}` =>
  encodeFunctionData({
    abi: morphoBlueAbi as Abi,
    functionName: "withdraw",
    args: [
      {
        loanToken: USDC,
        collateralToken: WETH,
        oracle: FAKE_ORACLE,
        irm: FAKE_IRM,
        lltv: 860_000_000_000_000_000n,
      },
      1_000_000n, // assets
      0n, // shares
      WALLET, // onBehalf (self)
      receiver, // ← drain target
    ],
  });

const lidoRequestWithdrawals = (owner: `0x${string}`): `0x${string}` =>
  encodeFunctionData({
    abi: lidoWithdrawalQueueAbi as Abi,
    functionName: "requestWithdrawals",
    args: [[1_000_000_000_000_000_000n], owner],
  });

// recipient is NESTED inside the `params` tuple — invisible to the current
// selector-only block 5, which never decodes an argument.
const uniExactInputSingle = (recipient: `0x${string}`): `0x${string}` =>
  encodeFunctionData({
    abi: swapRouter02Abi as Abi,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: WETH,
        tokenOut: USDC,
        fee: 3000,
        recipient, // ← drain target, tuple-nested
        amountIn: 1n,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });

// LiFi generic native→ERC20 swap; `_receiver` is arg index 3 (`commonInputs`),
// all seven generic-swap entry points are `payable` (native `value`).
const lifiNativeSwap = (receiver: `0x${string}`): `0x${string}` =>
  encodeFunctionData({
    abi: lifiDiamondAbi as Abi,
    functionName: "swapTokensSingleV3NativeToERC20",
    args: [
      `0x${"00".repeat(32)}` as `0x${string}`, // _transactionId
      "vaultpilot", // _integrator
      "", // _referrer
      receiver, // ← _receiver, drain target
      0n, // _minAmountOut
      {
        callTo: UNISWAP_SWAP_ROUTER_02,
        approveTo: UNISWAP_SWAP_ROUTER_02,
        sendingAssetId: ETH_SENTINEL,
        receivingAssetId: USDC,
        fromAmount: 1_000_000_000_000_000_000n,
        callData: "0x",
        requiresDeposit: false,
      },
    ],
  });

/**
 * A tx as it would arrive from `prepare_custom_call` to a REAL pinned protocol
 * address. `acknowledgedNonProtocolTarget: true` is the schema-required literal
 * that path stamps — INERT here (block 4 never fires for a recognized dest),
 * carried so these falsifiers ALSO pin the monotonicity property: the fix must
 * refuse the drain WITH the ack present (an ack may never make the gate laxer,
 * design D1).
 */
function customCallTx(
  to: `0x${string}`,
  data: `0x${string}`,
  value = "0",
): unknown {
  return {
    chain: "ethereum" as const,
    to,
    data,
    value,
    from: WALLET,
    description: "#757/#760 incident falsifier",
    acknowledgedNonProtocolTarget: true,
  };
}

/**
 * Mock the RPC + WalletConnect account set so `previewSend` reaches the gate
 * locus (`runEvmPreSignGuards`, after the account-set match) without live
 * network. `getConnectedAccounts` returns exactly [WALLET] so `tx.from` (==
 * WALLET) passes the account-set match — the recipient is the ONLY unsafe
 * value on the path.
 *
 * IMPORTANT: `../src/signing/pre-sign-check.js` is deliberately NOT mocked
 * (unlike preview-token-gate.test.ts). The gap under test lives in the REAL
 * classifyDestination / assertTransactionSafe + the recipient check the fix
 * adds to runEvmPreSignGuards; mocking pre-sign-check would hide it.
 */
function mockEvmRpc(): void {
  vi.doMock("../src/signing/walletconnect.js", () => ({
    requestSendTransaction: vi.fn().mockResolvedValue("0xabc123"),
    getConnectedAccounts: async () => [WALLET],
  }));
  vi.doMock("../src/data/rpc.js", () => ({
    getClient: () => ({
      call: vi.fn().mockResolvedValue({ data: "0x" }), // simulateTx eth_call → ok
      getTransactionCount: vi.fn().mockResolvedValue(7),
      getBlock: vi.fn().mockResolvedValue({ baseFeePerGas: 10_000_000_000n }),
      estimateMaxPriorityFeePerGas: vi.fn().mockResolvedValue(2_000_000_000n),
      estimateGas: vi.fn().mockResolvedValue(120_000n),
    }),
    verifyChainId: vi.fn().mockResolvedValue(undefined),
    resetClients: () => {},
  }));
  // Keep the preview-cost price lookup off the network (degrades to native-only).
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

/**
 * The refusal the fix will raise names the offending recipient/authority
 * argument. Broad-but-topical so the acceptance criterion is not brittle to the
 * exact wording the fix chooses. RED today is independent of this regex — today
 * `previewSend` RESOLVES (no throw at all), so `.rejects` fails regardless.
 */
const REFUSAL =
  /recipient|receiver|owner|onBehalf|not your|connected wallet|authoriz|refus/i;

// The blast-radius table from #757 (Aave / Morpho / Lido / Uniswap).
const BLAST_RADIUS = [
  {
    protocol: "Aave V3 Pool",
    fn: "withdraw(asset,amount,to)",
    arg: "to",
    to: AAVE_V3_POOL,
    build: aaveWithdraw,
    tupleNested: false,
  },
  {
    protocol: "Morpho Blue",
    fn: "withdraw(marketParams,assets,shares,onBehalf,receiver)",
    arg: "receiver",
    to: MORPHO_BLUE,
    build: morphoWithdraw,
    tupleNested: false,
  },
  {
    protocol: "Lido Withdrawal Queue",
    fn: "requestWithdrawals(amounts,owner)",
    arg: "owner",
    to: LIDO_WITHDRAWAL_QUEUE,
    build: lidoRequestWithdrawals,
    tupleNested: false,
  },
  {
    protocol: "Uniswap SwapRouter02",
    fn: "exactInputSingle((...,recipient,...))",
    arg: "recipient",
    to: UNISWAP_SWAP_ROUTER_02,
    build: uniExactInputSingle,
    tupleNested: true,
  },
] as const;

describe("#757 falsifiers — recipient-bearing fns on RECOGNIZED destinations are signable drains (RED today)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it.each(BLAST_RADIUS)(
    "$protocol — $fn with $arg=ATTACKER MUST be REFUSED at pre-sign (RED today: drain signable)",
    async ({ to, build }) => {
      mockEvmRpc();
      await expect(previewOf(customCallTx(to, build(ATTACKER)))).rejects.toThrow(
        REFUSAL,
      );
    },
  );

  it.each(BLAST_RADIUS)(
    "over-block control — $protocol $fn with $arg=wallet MUST still PASS (GREEN now and after fix)",
    async ({ to, build }) => {
      mockEvmRpc();
      await expect(
        previewOf(customCallTx(to, build(WALLET))),
      ).resolves.toBeDefined();
    },
  );

  // Sharp instance the incident acceptance criterion names explicitly.
  it("SHARP INSTANCE — ack-stamped real Aave V3 Pool withdraw(USDC, amount, ATTACKER) MUST be REFUSED (RED today)", async () => {
    mockEvmRpc();
    await expect(
      previewOf(customCallTx(AAVE_V3_POOL, aaveWithdraw(ATTACKER))),
    ).rejects.toThrow(REFUSAL);
  });

  // Tuple-nested proof: the recipient lives inside `exactInputSingle`'s params
  // tuple, so a selector-only gate cannot see it. The fix's argument walk must.
  it("TUPLE-NESTED — Uniswap exactInputSingle recipient=ATTACKER (nested in params tuple) MUST be REFUSED (RED today)", async () => {
    mockEvmRpc();
    await expect(
      previewOf(customCallTx(UNISWAP_SWAP_ROUTER_02, uniExactInputSingle(ATTACKER))),
    ).rejects.toThrow(REFUSAL);
  });
});

describe("#760 falsifiers — LiFi Diamond allowedAbi:null (block 5 does not run at all)", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  // ACCEPTANCE INCREMENT: this LiFi `_receiver` case is closed by the D8
  // LiFi-discriminator leg, which is v6-PENDING (REVIEW's §4-grounding stop) —
  // NOT the first SEC-v5 spine PR (see docs/design/757-760-impl-plan.md). It is
  // written RED now as the incident's proof-of-drain; it turns GREEN when the
  // D8 increment lands, not when the first spine PR does.
  //
  // #759 design D8: an ack-stamped (prepare_custom_call-reachable) LiFi swap
  // whose extractable `_receiver` is not the wallet must be hard-gated. Native
  // `value` rides along (all generic-swap entry points are payable).
  // D8 v6-increment / separate track — not this PR. The first #759 spine PR
  // (this one) closes the SEC-v5-approved recipient dimension for the
  // recognized-ABI destinations (Aave/Morpho/Lido/Uniswap). LiFi's `_receiver`
  // discriminator (`allowedAbi: null`, extractable-receiver classification) is
  // the v6-pending D8 leg — REVIEW's §4-grounding stop landed on exactly its
  // stamp/discriminator rows. Skipped so CI is GREEN; turns GREEN when the D8
  // increment lands, per docs/design/757-760-impl-plan.md §3.2.
  it.skip("ack-stamped LiFi swapTokensSingleV3NativeToERC20(_receiver=ATTACKER) + native value MUST be REFUSED [D8 v6-increment / separate track — not this PR]", async () => {
    mockEvmRpc();
    await expect(
      previewOf(
        customCallTx(LIFI_DIAMOND, lifiNativeSwap(ATTACKER), "1000000000000000000"),
      ),
    ).rejects.toThrow(REFUSAL);
  });

  // Reconciled after #786/#789 (LiFi Diamond stamped-refuse) MERGED into main:
  // a STAMPED prepare_custom_call to the LiFi Diamond is now REFUSED at pre-sign
  // regardless of `_receiver`. That refuse is pre-sign-check.ts block 4b, which
  // landed on main via merged #786/#789 — NOT this branch, and NOT #760-core (the
  // separate undecodable-calldata track below). This over-block control uses a
  // STAMPED call (customCallTx sets
  // acknowledgedNonProtocolTarget), so it is no longer a valid "MUST PASS" case.
  // LiFi stamped-refuse is now handled by #786 (merged); the D8 `_receiver`
  // dimension is deferred — see test/786-lifi-stamped-refuse.test.ts. Out of the
  // #757 recipient-seam scope (the seam defers lifi-diamond:
  // assertRecipientsAuthorized returns early for it).
  it.skip("over-block control — LiFi _receiver=wallet [now REFUSED by merged #786; reconciled out of #757 seam scope]", async () => {
    mockEvmRpc();
    await expect(
      previewOf(
        customCallTx(LIFI_DIAMOND, lifiNativeSwap(WALLET), "1000000000000000000"),
      ),
    ).resolves.toBeDefined();
  });

  // SCOPE BOUNDARY (design §5): #760-core — arbitrary, fully-UNDECODABLE
  // calldata + arbitrary native value to LiFi Diamond (no extractable receiver,
  // blind-sign class) — is a SEPARATE mitigation track, NOT closed by the first
  // #759 spine PR (which closes only the `_receiver` dimension, D8). Recorded as
  // skipped so it is not mistaken for part of THIS PR's acceptance set.
  it.skip("[#760-core — SEPARATE TRACK, not this PR] arbitrary undecodable calldata to LiFi Diamond MUST be REFUSED", () => {
    // Owned by the §3.4/#760-core thread; needs tx.value entering the gate +
    // scoping the allowedAbi:null blanket to its producer. Out of #759 scope.
  });
});
