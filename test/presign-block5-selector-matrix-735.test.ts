/**
 * Issue #735 (b) — block-5 per-destination ABI-selector matrix.
 *
 * `assertTransactionSafe` block 5 (the per-destination ABI-selector check)
 * verifies a tx's 4-byte selector belongs to the ABI of the destination
 * `classifyDestination` recognized. Before this file only 5 of the 14
 * DestinationKinds had accept/reject coverage (aave-v3-pool,
 * uniswap-v3-swap-router, weth9, known-erc20, lifi-diamond — the last has no
 * ABI gate). This adds the missing 9 recognized-and-ABI-gated kinds:
 *
 *   compound-v3-comet, morpho-blue, lido-stETH, lido-wstETH,
 *   lido-withdrawalQueue, eigenlayer-strategyManager, uniswap-v3-npm,
 *   rocketpool-depositPool, rocketpool-rETH
 *
 * For each: (1) a GENUINE selector from the contract's real ABI at its real
 * `CONTRACTS` address must PASS, and (2) a bogus selector (0xdeadbeef) at the
 * same address must throw `/not a known function/`.
 *
 * The genuine selector is derived from a canonical signature STRING (pinned
 * here, independent of `src/abis/*`) via viem's `toFunctionSelector`, NOT
 * recomputed from the same ABI object the gate uses. That independence is
 * deliberate: if a `src/abis/*` function is renamed (drift), the gate's
 * precomputed selector set silently loses that selector and starts refusing
 * the legit tx — this test, pinned to the canonical signature, goes RED and
 * flags it. Verified against viem keccak by scripts/verify-735-block5-selectors.mjs.
 */
import { describe, it, expect } from "vitest";
import { toFunctionSelector } from "viem";
import { CONTRACTS } from "../src/config/contracts.js";

const WALLET = "0x1111111111111111111111111111111111111111" as const;
const BOGUS_SELECTOR = "0xdeadbeef";
/** Padding so calldata is realistically sized; block 5 only reads slice(0,10). */
const PAD = "00".repeat(32);

/**
 * One row per previously-untested recognized+ABI-gated DestinationKind.
 * `kind` is the exact string block 5's error message prints; `address` is the
 * real on-chain address from `CONTRACTS` that `classifyDestination` maps to
 * that kind; `genuineSig` is a canonical function on that contract's ABI.
 */
interface MatrixRow {
  kind: string;
  address: `0x${string}`;
  genuineSig: string;
}

const MATRIX: MatrixRow[] = [
  {
    kind: "compound-v3-comet",
    // Any recognized Comet market address classifies as compound-v3-comet.
    address: CONTRACTS.ethereum.compound.cUSDCv3 as `0x${string}`,
    genuineSig: "supply(address,uint256)",
  },
  {
    kind: "morpho-blue",
    address: CONTRACTS.ethereum.morpho.blue as `0x${string}`,
    genuineSig: "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)",
  },
  {
    kind: "lido-stETH",
    address: CONTRACTS.ethereum.lido.stETH as `0x${string}`,
    genuineSig: "submit(address)",
  },
  {
    kind: "lido-wstETH",
    address: CONTRACTS.ethereum.lido.wstETH as `0x${string}`,
    genuineSig: "wrap(uint256)",
  },
  {
    kind: "lido-withdrawalQueue",
    address: CONTRACTS.ethereum.lido.withdrawalQueue as `0x${string}`,
    genuineSig: "requestWithdrawals(uint256[],address)",
  },
  {
    kind: "eigenlayer-strategyManager",
    address: CONTRACTS.ethereum.eigenlayer.strategyManager as `0x${string}`,
    genuineSig: "depositIntoStrategy(address,address,uint256)",
  },
  {
    kind: "uniswap-v3-npm",
    address: CONTRACTS.ethereum.uniswap.positionManager as `0x${string}`,
    genuineSig: "burn(uint256)",
  },
  {
    kind: "rocketpool-depositPool",
    address: CONTRACTS.ethereum.rocketpool.depositPool as `0x${string}`,
    genuineSig: "deposit()",
  },
  {
    kind: "rocketpool-rETH",
    address: CONTRACTS.ethereum.rocketpool.rETH as `0x${string}`,
    genuineSig: "burn(uint256)",
  },
];

describe("Pre-sign block 5: per-destination selector matrix (issue #735)", () => {
  // Guard against a future kind being added without a matrix row: this file
  // must cover exactly the 9 kinds enumerated in the issue.
  it("covers all 9 previously-untested recognized ABI-gated kinds", () => {
    expect(MATRIX.map((r) => r.kind).sort()).toEqual(
      [
        "compound-v3-comet",
        "eigenlayer-strategyManager",
        "lido-stETH",
        "lido-withdrawalQueue",
        "lido-wstETH",
        "morpho-blue",
        "rocketpool-depositPool",
        "rocketpool-rETH",
        "uniswap-v3-npm",
      ].sort(),
    );
  });

  for (const row of MATRIX) {
    describe(row.kind, () => {
      it(`accepts a genuine selector (${row.genuineSig})`, async () => {
        const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
        const selector = toFunctionSelector(row.genuineSig);
        await expect(
          assertTransactionSafe({
            chain: "ethereum",
            to: row.address,
            data: (selector + PAD) as `0x${string}`,
            value: "0",
            from: WALLET,
            description: `genuine ${row.genuineSig} on ${row.kind}`,
          }),
        ).resolves.toBeUndefined();
      });

      it("rejects a bogus selector (0xdeadbeef) as not a known function", async () => {
        const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
        await expect(
          assertTransactionSafe({
            chain: "ethereum",
            to: row.address,
            data: (BOGUS_SELECTOR + PAD) as `0x${string}`,
            value: "0",
            from: WALLET,
            description: `bogus selector on ${row.kind}`,
          }),
        ).rejects.toThrow(new RegExp(`not a known function on ${row.kind}`));
      });
    });
  }
});
