/**
 * #786 / #760-core — refuse the STAMPED (prepare_custom_call) partition to the
 * LiFi Diamond at pre-sign.
 *
 * The LiFi Diamond is recognized by `classifyDestination` with
 * `allowedAbi: null`, so block 5's `if (dest.allowedAbi === null) return;`
 * early-returns with NO selector / argument / value check. Block 4's catch-all
 * (where the ack flags are otherwise read) is skipped because LiFi is
 * *recognized* (`dest` is non-null). Consequence pre-fix: a
 * `prepare_custom_call(contract=LIFI_DIAMOND, fn=<any facet>, args=<any>,
 * value=<any wei>)` — which the server ALWAYS stamps with
 * `acknowledgedNonProtocolTarget=true` (execution/index.ts) — passes every
 * pre-sign block unexamined. That is a general drain: arbitrary facet call,
 * attacker-authored `SwapData.callTo`, attacker-chosen native value.
 *
 * The fix refuses exactly the stamped partition, BEFORE the `allowedAbi === null`
 * return. Partition soundness (SEC-verified @ 88540f6): `prepare_swap` is the
 * SOLE legitimate EVM prepare path producing `to == LIFI_DIAMOND` and it is
 * UNSTAMPED; `prepare_custom_call` is ALWAYS stamped and non-forgeable (the
 * field is in no zod input schema). So refusing the stamped partition closes
 * the custom_call drain with ZERO over-block on legit `prepare_swap` LiFi
 * routes.
 *
 * Falsifier design (measure = pre-sign verdict on a LiFi tx, calculated by
 * assertTransactionSafe, falsifier = remove the refuse check → stamped cases
 * go GREEN i.e. the drain is signable again):
 *  - Positive (RED on current main, GREEN with the fix): a STAMPED custom_call
 *    to the LiFi Diamond — arbitrary facet, arbitrary native value — REFUSES.
 *  - Over-block control (GREEN before and after): an UNSTAMPED prepare_swap-
 *    shaped LiFi tx (arbitrary facet selector + native value) PASSES.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData, maxUint256 } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

// LiFi Diamond — deterministic across all our chains (checksummed; the pre-sign
// classifier lowercases before comparing, so casing here is irrelevant).
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const WALLET = "0x1111111111111111111111111111111111111111";

// An arbitrary LiFi facet selector. LiFi's Diamond has `allowedAbi: null`, so
// ANY selector that is neither approve nor transfer reaches block 5's early
// return — that is precisely the surface the stamped-refuse closes. Shaped like
// a facet call with an embedded `callTo`-style address argument to mirror the
// real drain (SwapData.callTo → arbitrary contract).
const ARBITRARY_FACET_CALLDATA =
  ("0xdeadbeef" +
    ATTACKER.slice(2).padStart(64, "0") + // callTo → attacker
    (1_000_000n).toString(16).padStart(64, "0")) as `0x${string}`;

describe("#786 pre-sign: STAMPED custom_call to LiFi Diamond is REFUSED", () => {
  it("REFUSES a stamped arbitrary-facet call (zero native value)", async () => {
    // RED on current main: this is the #760-core drain — an ack-stamped
    // custom_call with an arbitrary facet selector passes today.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "0",
        from: WALLET,
        description: "[malicious] prepare_custom_call: arbitrary LiFi facet",
        acknowledgedNonProtocolTarget: true,
      })
    ).rejects.toThrow(/LiFi Diamond|#760-core drain|prepare_custom_call/);
  });

  it("REFUSES a stamped facet call carrying attacker-chosen native value", async () => {
    // The native-value dimension: an attacker sets `value` to sweep the
    // wallet's ETH through a facet. The refuse fires regardless of value.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "5000000000000000000", // 5 ETH, attacker-chosen
        from: WALLET,
        description: "[malicious] prepare_custom_call: LiFi facet + native drain",
        acknowledgedNonProtocolTarget: true,
      })
    ).rejects.toThrow(/LiFi Diamond|#760-core drain|prepare_custom_call/);
  });

  it("REFUSES on other chains too — the stamp partition is chain-independent (EVM)", async () => {
    // The LiFi Diamond address is the same on every EVM chain we support; a
    // stamped custom_call to it on e.g. arbitrum is the same drain.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "arbitrum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "0",
        from: WALLET,
        description: "[malicious] prepare_custom_call: arbitrary LiFi facet (arbitrum)",
        acknowledgedNonProtocolTarget: true,
      })
    ).rejects.toThrow(/LiFi Diamond|#760-core drain|prepare_custom_call/);
  });

  it("is NON-BYPASSABLE by stacking other ack flags on the stamped tx", async () => {
    // A rogue path that also sets safeTxOrigin / acknowledgedNonAllowlistedSpender
    // cannot escape the refuse — the check keys on acknowledgedNonProtocolTarget,
    // which the server stamps unconditionally on the custom_call build path and
    // which the extra flags do not remove.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "1000000000000000000",
        from: WALLET,
        description: "[malicious] stamped LiFi custom_call + extra acks",
        acknowledgedNonProtocolTarget: true,
        safeTxOrigin: true,
        acknowledgedNonAllowlistedSpender: true,
      })
    ).rejects.toThrow(/LiFi Diamond|#760-core drain|prepare_custom_call/);
  });
});

describe("#786 pre-sign: UNSTAMPED prepare_swap LiFi routes still PASS (zero over-block)", () => {
  it("PASSES an unstamped arbitrary-facet LiFi call (the prepare_swap surface)", async () => {
    // prepare_swap is the sole legit EVM LiFi emitter and sets NO ack flag.
    // It legitimately targets the Diamond with dynamic facet selectors, so an
    // unstamped LiFi call with an arbitrary selector must keep passing.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "0",
        from: WALLET,
        description: "prepare_swap: LiFi bridge/swap route",
      })
    ).resolves.toBeUndefined();
  });

  it("PASSES an unstamped LiFi swap that sends native value (native-token swap leg)", async () => {
    // A native-in LiFi swap legitimately carries a non-zero `value`. Unstamped
    // → the refuse does not fire; the existing allowedAbi:null early return
    // accepts it.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: ARBITRARY_FACET_CALLDATA,
        value: "1000000000000000000", // 1 ETH — legit native-in swap
        from: WALLET,
        description: "prepare_swap: native-in LiFi swap",
      })
    ).resolves.toBeUndefined();
  });
});

describe("#786 pre-sign: pre-existing LiFi defenses are unchanged by the refuse", () => {
  it("still ACCEPTS approve(LiFiDiamond, amount) on a known ERC-20 (unstamped)", async () => {
    // The approve-spender allowlist (block 2) lists the LiFi Diamond as a
    // legitimate spender for prepare_swap's approve leg. That path is unstamped
    // and targets the TOKEN (not the Diamond), so the refuse never applies.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [LIFI_DIAMOND as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "prepare_swap: approve USDC for LiFi",
      })
    ).resolves.toBeUndefined();
  });
});
