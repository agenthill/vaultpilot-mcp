import { encodeFunctionData, formatUnits, parseEther } from "viem";
import { wethAbi } from "../../abis/weth.js";
import { CONTRACTS } from "../../config/contracts.js";
import { getClient } from "../../data/rpc.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Resolve the canonical WETH9 contract for a supported chain. All current
 * deployments use 18 decimals (same as native ETH), so we don't expose
 * `decimals` — the builder hardcodes 18. Verified 2026-04 against each
 * chain's block explorer.
 */
function getWethAddress(chain: SupportedChain): `0x${string}` {
  const tokens = (CONTRACTS[chain] as { tokens?: Record<string, string> }).tokens;
  const addr = tokens?.WETH;
  if (!addr) {
    throw new Error(
      `No canonical WETH address registered for chain "${chain}". ` +
        `Add one to src/config/contracts.ts (CONTRACTS.${chain}.tokens.WETH) first.`,
    );
  }
  return addr as `0x${string}`;
}

export interface WethUnwrapParams {
  wallet: `0x${string}`;
  chain: SupportedChain;
  /** Human-readable amount ("0.5"), or the literal "max" to unwrap the full WETH balance. */
  amount: string | "max";
}

/**
 * Build an unsigned `WETH.withdraw(uint256)` transaction. No ERC-20 approval
 * is required — `msg.sender` burns their own balance and receives native
 * ETH back in the same call.
 *
 * `amount: "max"` reads the wallet's WETH balance from chain and uses the
 * full amount. An explicit amount is parsed at 18 decimals (WETH is always
 * 18 — verified across ethereum, arbitrum, polygon, base, optimism) and
 * compared against balance; we refuse pre-sign with a clear message if the
 * balance is insufficient rather than letting the tx revert on-chain with
 * an opaque "arithmetic underflow" error.
 */
export async function buildWethUnwrap(p: WethUnwrapParams): Promise<UnsignedTx> {
  const weth = getWethAddress(p.chain);
  const client = getClient(p.chain);

  let amountWei: bigint;
  let displayAmount: string;

  if (p.amount === "max") {
    amountWei = (await client.readContract({
      address: weth,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [p.wallet],
    })) as bigint;
    if (amountWei === 0n) {
      throw new Error(
        `Cannot unwrap: wallet ${p.wallet} holds 0 WETH on ${p.chain}.`,
      );
    }
    displayAmount = formatUnits(amountWei, 18);
  } else {
    amountWei = parseEther(p.amount);
    const balance = (await client.readContract({
      address: weth,
      abi: wethAbi,
      functionName: "balanceOf",
      args: [p.wallet],
    })) as bigint;
    if (balance < amountWei) {
      throw new Error(
        `Insufficient WETH: wallet ${p.wallet} has ${formatUnits(balance, 18)} WETH on ${p.chain}, ` +
          `requested ${p.amount}. Reduce the amount or use "max".`,
      );
    }
    displayAmount = p.amount;
  }

  return {
    chain: p.chain,
    to: weth,
    data: encodeFunctionData({
      abi: wethAbi,
      functionName: "withdraw",
      args: [amountWei],
    }),
    value: "0",
    from: p.wallet,
    description: `Unwrap ${displayAmount} WETH → ETH on ${p.chain}`,
    decoded: {
      functionName: "withdraw",
      args: { amount: `${displayAmount} WETH` },
    },
  };
}
