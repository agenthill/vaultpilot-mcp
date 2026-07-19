/**
 * Pre-sign safety check — the independent guard that runs in send_transaction
 * between consumeHandle and WalletConnect. It should accept every tx our
 * prepare_* tools legitimately emit and reject anything unknown, especially
 * approve() to a spender that isn't on our protocol allowlist.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData, maxUint256, zeroAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";

// Aave V3 Pool on Ethereum (canonical). classifyDestination pins this address
// from CONTRACTS — no RPC read — so any tx whose `to` equals AAVE_POOL_ETH is
// recognized as the Pool.
const AAVE_POOL_ETH = "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2";
const LIFI_DIAMOND = "0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE";
const USDC_ETH = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT_ETH = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
const WETH_ETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
const ATTACKER = "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
const WALLET = "0x1111111111111111111111111111111111111111";
const STETH_TOKEN_ETH = "0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84";

describe("Pre-sign check: native sends", () => {
  it("accepts a bare native transfer with empty calldata", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`, // arbitrary EOA is fine for a native send
        data: "0x",
        value: "1000000000000000000",
        from: WALLET,
        description: "native send",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a tx with sub-selector calldata", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data: "0xabcd" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "malformed",
      })
    ).rejects.toThrow(/too short/);
  });
});

describe("Pre-sign check: approve() spender allowlist", () => {
  it("accepts approve(AavePool, amount) on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [AAVE_POOL_ETH as `0x${string}`, 1_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDC for Aave",
      })
    ).resolves.toBeUndefined();
  });

  it("accepts approve(LiFiDiamond, amount) on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [LIFI_DIAMOND as `0x${string}`, 1_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDT_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDT for LiFi swap",
      })
    ).resolves.toBeUndefined();
  });

  it("accepts approve(Uniswap SwapRouter02, amount) — prepare_uniswap_swap's approve step", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_02 as `0x${string}`, 100_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve USDC for Uniswap SwapRouter02",
      })
    ).resolves.toBeUndefined();
  });

  it("REJECTS approve(ATTACKER, max) — the classic prompt-injection attack", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "[malicious] drain approval",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist|phishing|prompt-injection/);
  });

  it("rejects approve() when the token itself is unknown", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [AAVE_POOL_ETH as `0x${string}`, 1_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`, // "token" is attacker-controlled
        data,
        value: "0",
        from: WALLET,
        description: "approve on fake token",
      })
    ).rejects.toThrow(/token is not in our recognized set/);
  });

  it("ACCEPTS approve(non-allowlisted-spender, amount) when acknowledgedNonAllowlistedSpender flag is stamped", async () => {
    // prepare_curve_swap (and future tools targeting deep-liquidity
    // venues outside the curated approve-allowlist) takes the user's
    // schema-enforced `acknowledgeNonAllowlistedSpender: true` at
    // prepare time and stamps the flag on the approval tx. The
    // pre-sign check skips the spender-allowlist refusal when the flag
    // is set, treating the allowlist as a security recommendation
    // rather than a hard requirement. Every other defense
    // (transfer-on-unknown-token, ABI-selector check, payload-hash
    // pin, simulation, chainId) stays active.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const CURVE_STETH_POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CURVE_STETH_POOL as `0x${string}`, 1_000_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: STETH_TOKEN_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Approve stETH for Curve stETH/ETH pool (acked)",
        acknowledgedNonAllowlistedSpender: true,
      })
    ).resolves.toBeUndefined();
  });

  it("REJECTS approve(non-allowlisted-spender, amount) WITHOUT the ack flag — default refusal still fires", async () => {
    // The ack flag is the explicit opt-out; absent the flag, the
    // refusal still fires verbatim. This is what protects the
    // canonical prompt-injection pattern (a compromised agent that
    // doesn't know to fabricate the flag, or a non-Curve prepare path
    // that would have built a drain approval).
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const CURVE_STETH_POOL = "0xDC24316b9AE028F1497c275EB9192a3Ea0f67022";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [CURVE_STETH_POOL as `0x${string}`, 1_000_000_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: STETH_TOKEN_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Approve stETH for Curve stETH/ETH pool (NOT acked)",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist/);
  });

  it("ACCEPTS approve(non-allowlisted-spender, 0) — the revoke pattern (issue #305)", async () => {
    // prepare_revoke_approval emits approve(spender, 0) targeting whatever
    // spender the user wants to revoke — Permit2, dead routers, deprecated
    // contracts. Those spenders are NOT on the protocol allowlist (the user
    // is revoking precisely because they want them off), so the allowlist
    // check would block the cleanup. amount=0 cannot grant any authority,
    // so the canonical phishing pattern doesn't apply — short-circuit.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [PERMIT2 as `0x${string}`, 0n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Revoke USDC allowance for Permit2",
      })
    ).resolves.toBeUndefined();
  });

  it("ACCEPTS approve(arbitrary-attacker-address, 0) — even maximally suspicious revokes are safe", async () => {
    // Defensive: revoke to a literally-attacker-controlled address still
    // grants no authority (amount=0). The allowlist is for grants of
    // authority; revokes are the inverse operation and have no analogous
    // attack surface.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 0n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Revoke USDC allowance for ATTACKER (cleanup)",
      })
    ).resolves.toBeUndefined();
  });

  it("STILL REJECTS approve(non-allowlisted-spender, 1) — only the exact-zero amount short-circuits", async () => {
    // Belt-and-suspenders: confirm the carve-out is keyed on amount === 0n
    // exactly, not on "amount that looks small". A 1-wei approval to an
    // attacker still grants authority over 1 wei (and the attack surface
    // typically isn't the size of the grant — it's that the grant exists
    // at all, since wormholes / delegatecall paths can amplify it).
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 1n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "[malicious] dust approval",
      })
    ).rejects.toThrow(/spender is not in the protocol allowlist|phishing|prompt-injection/);
  });

  it("rejects approve() aimed at a protocol contract (Aave Pool)", async () => {
    // Nonsensical: approve() on a non-ERC-20. A real ERC-20 approval would
    // hit the token, not the Pool; an agent pointing `to` at the Pool is off-rails.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, 1_000n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "weird approve",
      })
    ).rejects.toThrow(/approvals should target ERC-20/);
  });
});

describe("Pre-sign check: transfer()", () => {
  it("accepts transfer() to an arbitrary recipient on a known ERC-20", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer USDC",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects transfer() on a token we don't recognize", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer unknown token",
      })
    ).rejects.toThrow(/token is not in our recognized set/);
  });
});

describe("Pre-sign check: protocol calls", () => {
  it("accepts Aave V3 Pool supply() (selector 0x617ba037)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    // Manually build a supply(address,uint256,address,uint16) calldata — we
    // trust the selector portion since the full abi is in assertTransactionSafe.
    const data =
      "0x617ba037" +
      USDC_ETH.slice(2).toLowerCase().padStart(64, "0") +
      (1_000_000n).toString(16).padStart(64, "0") +
      WALLET.slice(2).toLowerCase().padStart(64, "0") +
      (0).toString(16).padStart(64, "0");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "Aave supply",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at the Aave Pool", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on Aave",
      })
    ).rejects.toThrow(/not a known function on aave-v3-pool/);
  });

  it("accepts a multicall() to Uniswap SwapRouter02 — prepare_uniswap_swap's swap step", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { swapRouter02Abi } = await import("../src/abis/uniswap-swap-router-02.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    // multicall is one of the SwapRouter02 functions; the selector must pass
    // the per-ABI gate.
    const data = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [["0xdeadbeef" as `0x${string}`]],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SWAP_ROUTER_02 as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Uniswap V3 swap",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at Uniswap SwapRouter02", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SWAP_ROUTER_02 as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on SwapRouter02",
      })
    ).rejects.toThrow(/not a known function on uniswap-v3-swap-router/);
  });

  it("accepts a call to LiFi Diamond regardless of selector (no ABI gate)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: LIFI_DIAMOND as `0x${string}`,
        data: "0xdeadbeef" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "LiFi swap",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a call to an unrelated contract with non-empty data", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: ATTACKER as `0x${string}`,
        data: "0xabcdef01" as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "unknown call",
      })
    ).rejects.toThrow(/refusing to sign against unknown contract/);
  });
});

describe("Pre-sign check: WETH9-specific selectors", () => {
  it("accepts WETH.withdraw(uint256) — the prepare_weth_unwrap path", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { wethAbi } = await import("../src/abis/weth.js");
    const data = encodeFunctionData({
      abi: wethAbi,
      functionName: "withdraw",
      args: [500_000_100_000_000_000n], // 0.5000001 WETH
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "Unwrap WETH",
      })
    ).resolves.toBeUndefined();
  });

  it("accepts WETH.deposit()", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const { wethAbi } = await import("../src/abis/weth.js");
    const data = encodeFunctionData({ abi: wethAbi, functionName: "deposit", args: [] });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "1000000000000000000",
        from: WALLET,
        description: "Wrap ETH",
      })
    ).resolves.toBeUndefined();
  });

  it("still accepts approve(WETH, SwapRouter02) — ERC-20 approvals on WETH must keep working", async () => {
    // Uniswap V3 swaps with WETH as the input token need this approval; a naive
    // fix that made WETH reject ERC-20 selectors would break prepare_uniswap_swap.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const SWAP_ROUTER_02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45";
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [SWAP_ROUTER_02 as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "approve WETH for Uniswap",
      })
    ).resolves.toBeUndefined();
  });

  it("still accepts transfer(WETH, recipient)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "transfer WETH",
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a random selector aimed at WETH9", async () => {
    // The per-selector gate is the reason we don't just classify WETH as
    // some catch-all kind. An arbitrary selector on WETH must still refuse.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = "0xdeadbeef" + "00".repeat(32);
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: WETH_ETH as `0x${string}`,
        data: data as `0x${string}`,
        value: "0",
        from: WALLET,
        description: "bogus call on WETH",
      })
    ).rejects.toThrow(/not a known function on weth9/);
  });
});

describe("Pre-sign check: prepare_custom_call escape hatch (issue #496)", () => {
  // OpenZeppelin TimelockController on mainnet — outside our canonical
  // CONTRACTS table, exactly the use case `prepare_custom_call` was filed
  // for in #493. The bug from #496: preview_send / send_transaction's
  // assertTransactionSafe refuses any tx whose `to` isn't in
  // KNOWN_DESTINATIONS, which made every prepare_custom_call handle dead-
  // on-arrival.
  const TIMELOCK = "0x22bc85C483103950441EaaB8312BE9f07e234634" as const;
  // schedule(address,uint256,bytes,bytes32,bytes32,uint256) selector +
  // valid abi-encoded args (zero target, zero value, empty bytes, two
  // zero bytes32 salts, 172800 delay).
  const SCHEDULE_CALLDATA =
    ("0x01d5062a" +
      "0000000000000000000000000000000000000000000000000000000000000001" + // target
      "0000000000000000000000000000000000000000000000000000000000000000" + // value
      "00000000000000000000000000000000000000000000000000000000000000c0" + // bytes offset
      "0000000000000000000000000000000000000000000000000000000000000000" + // predecessor
      "0000000000000000000000000000000000000000000000000000000000000000" + // salt
      "000000000000000000000000000000000000000000000000000000000002a300" + // delay (172800)
      "0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`; // empty bytes len=0

  it("WITHOUT the affirmative-ack flag — refuses unknown destination (current behavior)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: TIMELOCK as `0x${string}`,
        data: SCHEDULE_CALLDATA,
        value: "0",
        from: WALLET,
        description: "schedule call on a third-party Timelock",
      }),
    ).rejects.toThrow(/refusing to sign against unknown contract/);
  });

  it("error message points the user at prepare_custom_call as the right path", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: TIMELOCK as `0x${string}`,
        data: SCHEDULE_CALLDATA,
        value: "0",
        from: WALLET,
        description: "schedule call on a third-party Timelock",
      }),
    ).rejects.toThrow(/prepare_custom_call.*acknowledgeNonProtocolTarget/);
  });

  it("WITH acknowledgedNonProtocolTarget=true — accepts the unknown destination", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: TIMELOCK as `0x${string}`,
        data: SCHEDULE_CALLDATA,
        value: "0",
        from: WALLET,
        description: "prepare_custom_call: schedule on Timelock",
        acknowledgedNonProtocolTarget: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("the ack does NOT bypass the approve() spender allowlist", async () => {
    // A user calling `approve(attacker, max)` via prepare_custom_call
    // should still hit the allowlist refusal — the approve gate (block
    // 2 in assertTransactionSafe) is independent of the catch-all
    // unknown-destination check (block 4) the ack bypasses.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "prepare_custom_call: approve attacker max USDC",
        acknowledgedNonProtocolTarget: true,
      }),
    ).rejects.toThrow(/spender is not in the protocol allowlist/);
  });

  it("the ack does NOT bypass the transfer-on-unknown-token refusal", async () => {
    // A custom-call transfer() against an unrecognized token contract
    // still hits block 3 (transfer-on-unknown-token), not the catch-all.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [ATTACKER as `0x${string}`, 100n],
    });
    const RANDOM_TOKEN = "0x9999999999999999999999999999999999999999";
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: RANDOM_TOKEN as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "prepare_custom_call: transfer on a random contract",
        acknowledgedNonProtocolTarget: true,
      }),
    ).rejects.toThrow(/token is not in our.*recognized set/);
  });

  it("the ack does NOT bypass the per-destination ABI-selector check on KNOWN destinations", async () => {
    // If the ack-tagged handle somehow lands on a known protocol
    // destination (Aave Pool) but with an arbitrary selector that isn't
    // a real Aave function, the per-destination ABI guard (block 5)
    // still fires. The ack only opens the catch-all branch for
    // genuinely unknown destinations.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = ("0xdeadbeef" + "00".repeat(32)) as `0x${string}`;
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: AAVE_POOL_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "prepare_custom_call: bogus selector on Aave",
        acknowledgedNonProtocolTarget: true,
      }),
    ).rejects.toThrow(/not a known function on aave-v3-pool/);
    // Suppress unused warning — zeroAddress is imported by the file's
    // existing tests; this block doesn't reference it.
    void zeroAddress;
  });
});

describe("Pre-sign check: prepare_safe_tx_* origin flag (issue #609)", () => {
  // A user-specific Safe Multisig contract — by definition never in any
  // canonical-dispatch allowlist. The bug from #609: `preview_send` /
  // `send_transaction` refused every approveHash / execTransaction handle
  // produced by `prepare_safe_tx_propose|approve|execute` because the Safe
  // address didn't match a known destination. The fix: those builders
  // stamp `safeTxOrigin: true` on the UnsignedTx, and this check skips
  // ONLY the catch-all unknown-destination refusal — every other defense
  // stays active.
  const SAFE_ADDRESS = "0xC9844d6cecebc0498e533118Cd886C0d05d4B537" as const;
  // approveHash(bytes32) selector + zero hash arg
  const APPROVE_HASH_CALLDATA =
    ("0xd4d9bdcd" +
      "0000000000000000000000000000000000000000000000000000000000000000") as `0x${string}`;

  it("WITHOUT the safeTxOrigin flag — refuses unknown Safe address (current behavior)", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SAFE_ADDRESS as `0x${string}`,
        data: APPROVE_HASH_CALLDATA,
        value: "0",
        from: WALLET,
        description: "approveHash on user Safe",
      }),
    ).rejects.toThrow(/refusing to sign against unknown contract/);
  });

  it("WITH safeTxOrigin=true — accepts approveHash on the user's Safe", async () => {
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SAFE_ADDRESS as `0x${string}`,
        data: APPROVE_HASH_CALLDATA,
        value: "0",
        from: WALLET,
        description: "prepare_safe_tx_propose: approveHash",
        safeTxOrigin: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("WITH safeTxOrigin=true — accepts execTransaction on the user's Safe", async () => {
    // execTransaction selector (0x6a761202); calldata body irrelevant to the
    // catch-all branch — the destination + selector class are what's tested.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = ("0x6a761202" + "00".repeat(32 * 10)) as `0x${string}`;
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: SAFE_ADDRESS as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "prepare_safe_tx_execute: execTransaction",
        safeTxOrigin: true,
      }),
    ).resolves.toBeUndefined();
  });

  it("the flag does NOT bypass the approve() spender allowlist", async () => {
    // Defense in depth: even if a builder stamped safeTxOrigin on a tx
    // whose calldata happens to be approve(attacker, max), block 2 still
    // refuses. The Safe-origin bypass only opens the catch-all branch.
    const { assertTransactionSafe } = await import("../src/signing/pre-sign-check.js");
    const data = encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [ATTACKER as `0x${string}`, maxUint256],
    });
    await expect(
      assertTransactionSafe({
        chain: "ethereum",
        to: USDC_ETH as `0x${string}`,
        data,
        value: "0",
        from: WALLET,
        description: "[malicious] safeTxOrigin-tagged approve",
        safeTxOrigin: true,
      }),
    ).rejects.toThrow(/spender is not in the protocol allowlist/);
  });
});
