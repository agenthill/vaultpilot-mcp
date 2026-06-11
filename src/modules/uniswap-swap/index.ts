import { parseUnits, formatUnits, encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "../../abis/erc20.js";
import { swapRouter02Abi } from "../../abis/uniswap-swap-router-02.js";
import { quoterV2Abi } from "../../abis/uniswap-quoter-v2.js";
import { CONTRACTS } from "../../config/contracts.js";
import { getClient } from "../../data/rpc.js";
import { getTokenPrice } from "../../data/prices.js";
import { assertSlippageOk } from "../swap/index.js";
import { mevExposureNote } from "../swap/mev-hint.js";
import type { PrepareUniswapSwapArgs } from "./schemas.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

/**
 * Uniswap V3 direct-DEX swap preparer.
 *
 * Bypasses LiFi when the user explicitly asks for Uniswap — otherwise
 * `prepare_swap` (LiFi aggregator) remains the default path. The whole point
 * of this module is to honour the "swap on Uniswap specifically" ask without
 * routing through an aggregator that might pick a different venue.
 *
 * v1 scope:
 *  - Single-hop only (auto-pick best of 100/500/3000/10000 bps fee tiers via QuoterV2).
 *  - ERC-20 <-> ERC-20, native-in (ETH -> ERC-20), and native-out (ERC-20 -> ETH).
 *    Native <-> native is rejected (not a swap).
 *  - exact-in and exact-out both supported.
 */

const FEE_TIERS = [100, 500, 3000, 10000] as const;
type FeeTier = (typeof FEE_TIERS)[number];

async function resolveDecimals(
  chain: SupportedChain,
  token: `0x${string}` | "native",
  fallback?: number
): Promise<number> {
  if (token === "native") return 18;
  if (fallback !== undefined) return fallback;
  try {
    const client = getClient(chain);
    const d = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "decimals",
    })) as number;
    return Number(d);
  } catch {
    return 18;
  }
}

interface UniswapContracts {
  swapRouter02: `0x${string}`;
  quoterV2: `0x${string}`;
  weth: `0x${string}`;
}

function getUniswapContracts(chain: SupportedChain): UniswapContracts {
  const chainCfg = CONTRACTS[chain] as {
    uniswap?: { swapRouter02?: string; quoterV2?: string };
    tokens?: { WETH?: string };
  };
  const router = chainCfg.uniswap?.swapRouter02;
  const quoter = chainCfg.uniswap?.quoterV2;
  const weth = chainCfg.tokens?.WETH;
  if (!router || !quoter || !weth) {
    throw new Error(
      `Uniswap V3 direct routing is not configured for chain "${chain}". ` +
        `Use prepare_swap (LiFi) instead.`
    );
  }
  return {
    swapRouter02: getAddress(router),
    quoterV2: getAddress(quoter),
    weth: getAddress(weth),
  };
}

/**
 * Query QuoterV2 across all four fee tiers and return the best-pricing pool.
 * Reverts are expected on tiers where no pool exists or liquidity is zero —
 * we swallow those and compare only the successful quotes.
 */
async function pickBestFeeTier(
  chain: SupportedChain,
  quoter: `0x${string}`,
  tokenIn: `0x${string}`,
  tokenOut: `0x${string}`,
  amount: bigint,
  isExactOut: boolean,
  override: FeeTier | undefined
): Promise<{ fee: FeeTier; quotedAmount: bigint }> {
  const client = getClient(chain);
  const tiersToTry: readonly FeeTier[] = override ? [override] : FEE_TIERS;
  type QuoteResult = { fee: FeeTier; amount: bigint };
  const results: QuoteResult[] = [];

  for (const fee of tiersToTry) {
    try {
      if (isExactOut) {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: quoterV2Abi,
          functionName: "quoteExactOutputSingle",
          args: [{ tokenIn, tokenOut, amount, fee, sqrtPriceLimitX96: 0n }],
        });
        results.push({ fee, amount: result[0] as bigint });
      } else {
        const { result } = await client.simulateContract({
          address: quoter,
          abi: quoterV2Abi,
          functionName: "quoteExactInputSingle",
          args: [{ tokenIn, tokenOut, amountIn: amount, fee, sqrtPriceLimitX96: 0n }],
        });
        results.push({ fee, amount: result[0] as bigint });
      }
    } catch {
      // No pool or insufficient liquidity at this tier — skip.
    }
  }

  if (results.length === 0) {
    throw new Error(
      `No Uniswap V3 pool with sufficient liquidity found for this pair ` +
        `across fee tiers ${tiersToTry.join("/")}. Either the pair does not exist ` +
        `on Uniswap V3 on this chain, or liquidity is too thin for the requested size.`
    );
  }

  // exact-in: maximise amountOut. exact-out: minimise amountIn.
  const best = isExactOut
    ? results.reduce((a, b) => (b.amount < a.amount ? b : a))
    : results.reduce((a, b) => (b.amount > a.amount ? b : a));
  return { fee: best.fee, quotedAmount: best.amount };
}

function applySlippageExactIn(quotedOut: bigint, slippageBps: number): bigint {
  return (quotedOut * BigInt(10_000 - slippageBps)) / 10_000n;
}

function applySlippageExactOut(quotedIn: bigint, slippageBps: number): bigint {
  // Round up so we approve/spend enough to cover the worst-case in-amount.
  return (quotedIn * BigInt(10_000 + slippageBps) + 9_999n) / 10_000n;
}

export async function prepareUniswapSwap(
  args: PrepareUniswapSwapArgs
): Promise<UnsignedTx> {
  assertSlippageOk(args.slippageBps, args.acknowledgeHighSlippage);

  const chain = args.chain as SupportedChain;
  const { swapRouter02, quoterV2, weth } = getUniswapContracts(chain);

  const fromToken = args.fromToken as `0x${string}` | "native";
  const toToken = args.toToken as `0x${string}` | "native";

  if (fromToken === "native" && toToken === "native") {
    throw new Error(
      "Native-to-native is not a swap — both sides are the same asset. " +
        "For ETH<->WETH, use the native wrapper contract directly via prepare_native_send."
    );
  }

  const hasNativeIn = fromToken === "native";
  const wantsNativeOut = toToken === "native";

  // For calldata purposes, native is represented by WETH — the router wraps
  // (for native-in) or unwraps-via-multicall (for native-out).
  const tokenIn = hasNativeIn ? weth : getAddress(fromToken);
  const tokenOut = wantsNativeOut ? weth : getAddress(toToken);
  if (tokenIn.toLowerCase() === tokenOut.toLowerCase()) {
    throw new Error("fromToken and toToken resolve to the same asset — nothing to swap.");
  }

  const [fromDecimals, toDecimals] = await Promise.all([
    resolveDecimals(chain, fromToken, args.fromTokenDecimals),
    resolveDecimals(chain, toToken, args.toTokenDecimals),
  ]);

  const amountSide = args.amountSide ?? "from";
  const isExactOut = amountSide === "to";
  const amountWei = parseUnits(args.amount, isExactOut ? toDecimals : fromDecimals);

  const { fee, quotedAmount } = await pickBestFeeTier(
    chain,
    quoterV2,
    tokenIn,
    tokenOut,
    amountWei,
    isExactOut,
    args.feeTier
  );

  const slippageBps = args.slippageBps ?? 50;
  const amountOutMin = isExactOut
    ? amountWei
    : applySlippageExactIn(quotedAmount, slippageBps);
  const amountInMax = isExactOut
    ? applySlippageExactOut(quotedAmount, slippageBps)
    : amountWei;

  const wallet = getAddress(args.wallet);
  // When we need to unwrap WETH back into ETH at the end, the swap output must
  // land in the router first so unwrapWETH9 can send native to the user.
  const swapRecipient = wantsNativeOut ? swapRouter02 : wallet;

  let innerData: `0x${string}`;
  if (isExactOut) {
    innerData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactOutputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient: swapRecipient,
          amountOut: amountWei,
          amountInMaximum: amountInMax,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  } else {
    innerData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "exactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          fee,
          recipient: swapRecipient,
          amountIn: amountWei,
          amountOutMinimum: amountOutMin,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
  }

  // Assemble final calldata + msg.value:
  //  - native-out: multicall([swap, unwrapWETH9(min, wallet)])
  //  - native-in + exact-out: multicall([swap, refundETH()]) — we overpay to
  //    cover slippage, router returns the unused ETH
  //  - native-in + exact-in: single exactInputSingle; router auto-wraps msg.value
  //  - ERC-20 <-> ERC-20: single call, no multicall
  let calldata: `0x${string}`;
  let valueWei: bigint;
  if (wantsNativeOut) {
    const unwrapData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "unwrapWETH9",
      args: [amountOutMin, wallet],
    });
    calldata = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [[innerData, unwrapData]],
    });
    valueWei = 0n;
  } else if (hasNativeIn && isExactOut) {
    const refundData = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "refundETH",
      args: [],
    });
    calldata = encodeFunctionData({
      abi: swapRouter02Abi,
      functionName: "multicall",
      args: [[innerData, refundData]],
    });
    valueWei = amountInMax;
  } else if (hasNativeIn) {
    calldata = innerData;
    valueWei = amountWei;
  } else {
    calldata = innerData;
    valueWei = 0n;
  }

  const fromSym =
    fromToken === "native"
      ? nativeSymbol(chain)
      : await readSymbol(chain, fromToken).catch(() => "token");
  const toSym =
    toToken === "native"
      ? nativeSymbol(chain)
      : await readSymbol(chain, toToken).catch(() => "token");

  const quotedHuman = formatUnits(quotedAmount, isExactOut ? fromDecimals : toDecimals);
  const minMaxHuman = formatUnits(
    isExactOut ? amountInMax : amountOutMin,
    isExactOut ? fromDecimals : toDecimals
  );
  const fromDisplay = isExactOut ? `≤${minMaxHuman}` : args.amount;
  const toDisplay = isExactOut ? args.amount : `~${quotedHuman}`;
  const feeLabel = `${fee / 100}bps`;
  const description =
    `Swap ${fromDisplay} ${fromSym} -> ${toDisplay} ${toSym} on ${chain} via Uniswap V3 ` +
    `(SwapRouter02, ${feeLabel} pool${args.feeTier ? ", user-specified" : ", auto-selected"})`;

  // Sandwich-MEV hint — Ethereum mainnet only. The fromAmount in human
  // units is what an attacker can extract a slice of via reordering.
  // Price fetch is best-effort; a failure falls through to the
  // percentage-only message inside `mevExposureNote`.
  const fromAmountHumanForUsd = Number(
    formatUnits(isExactOut ? amountInMax : amountWei, fromDecimals),
  );
  let fromAmountUsd: number | undefined;
  try {
    const price = await getTokenPrice(chain, fromToken);
    if (typeof price === "number" && Number.isFinite(price)) {
      fromAmountUsd = fromAmountHumanForUsd * price;
    }
  } catch {
    // Swallow — falls through to the no-USD branch in mevExposureNote.
  }
  const mevNote = mevExposureNote(chain, slippageBps, fromAmountUsd);

  let decodedFunctionName: string;
  if (wantsNativeOut || (hasNativeIn && isExactOut)) {
    decodedFunctionName = "multicall";
  } else if (isExactOut) {
    decodedFunctionName = "exactOutputSingle";
  } else {
    decodedFunctionName = "exactInputSingle";
  }

  const swapTx: UnsignedTx = {
    chain,
    to: swapRouter02,
    data: calldata,
    value: valueWei.toString(),
    from: wallet,
    description,
    decoded: {
      functionName: decodedFunctionName,
      args: {
        venue: "Uniswap V3",
        pool: `${fromSym}/${toSym} @ ${feeLabel}`,
        from: `${fromDisplay} ${fromSym}`,
        expectedOut: isExactOut ? `${args.amount} ${toSym}` : `${quotedHuman} ${toSym}`,
        minOut: isExactOut ? `${args.amount} ${toSym}` : `${minMaxHuman} ${toSym}`,
        maxIn: isExactOut ? `${minMaxHuman} ${fromSym}` : `${args.amount} ${fromSym}`,
        slippageBps: String(slippageBps),
        ...(mevNote ? { mev: mevNote } : {}),
      },
    },
  };

  // Approval chain — only for ERC-20 input (native flows use msg.value).
  if (!hasNativeIn) {
    const fromTokenAddr = tokenIn;
    const client = getClient(chain);
    const allowance = (await client.readContract({
      address: fromTokenAddr,
      abi: erc20Abi,
      functionName: "allowance",
      args: [wallet, swapRouter02],
    })) as bigint;

    // Approval sizing mirrors the LiFi swap module:
    //  - exact-in: approve exactly amountIn.
    //  - exact-out: approve the slippage-padded max to cover pool drift between
    //    prepare and execute.
    const needed = isExactOut ? amountInMax : amountWei;
    if (allowance < needed) {
      const approveTx: UnsignedTx = {
        chain,
        to: fromTokenAddr,
        data: encodeFunctionData({
          abi: erc20Abi,
          functionName: "approve",
          args: [swapRouter02, needed],
        }),
        value: "0",
        from: wallet,
        description:
          `Approve ${formatUnits(needed, fromDecimals)} ${fromSym} for Uniswap V3 SwapRouter02` +
          (isExactOut ? ` (covers up to ${slippageBps / 100}% input drift)` : " (exact amount)"),
        decoded: {
          functionName: "approve",
          args: {
            spender: swapRouter02,
            amount: `${formatUnits(needed, fromDecimals)} ${fromSym}`,
          },
        },
        next: swapTx,
      };
      if (allowance > 0n) {
        // USDT-style reset required by tokens that revert on approve(nonzero->nonzero).
        const resetTx: UnsignedTx = {
          chain,
          to: fromTokenAddr,
          data: encodeFunctionData({
            abi: erc20Abi,
            functionName: "approve",
            args: [swapRouter02, 0n],
          }),
          value: "0",
          from: wallet,
          description: `Reset ${fromSym} allowance to 0 (required by USDT-style tokens before re-approval)`,
          decoded: {
            functionName: "approve",
            args: { spender: swapRouter02, amount: "0" },
          },
          next: approveTx,
        };
        return resetTx;
      }
      return approveTx;
    }
  }

  return swapTx;
}

async function readSymbol(
  chain: SupportedChain,
  token: `0x${string}`
): Promise<string> {
  const client = getClient(chain);
  return (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "symbol",
  })) as string;
}

function nativeSymbol(chain: SupportedChain): string {
  return chain === "polygon" ? "MATIC" : "ETH";
}
