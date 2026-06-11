import { encodeFunctionData, parseUnits } from "viem";
import { morphoBlueAbi, type MorphoMarketParams } from "../../abis/morpho-blue.js";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { buildApprovalTx, chainApproval, resolveApprovalCap } from "../shared/approval.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import { makeDurableBinding } from "../../security/durable-binding.js";
import type {
  PrepareMorphoSupplyArgs,
  PrepareMorphoWithdrawArgs,
  PrepareMorphoBorrowArgs,
  PrepareMorphoRepayArgs,
  PrepareMorphoSupplyCollateralArgs,
  PrepareMorphoWithdrawCollateralArgs,
} from "./schemas.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";

function morphoAddress(chain: SupportedChain): `0x${string}` {
  const addr = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]?.morpho
    ?.blue;
  if (!addr) throw new Error(`Morpho Blue is not deployed on ${chain}`);
  return addr as `0x${string}`;
}

// Intentionally no pre-flight pause/frozen check here. Morpho Blue core markets
// are immutable — once created, MarketParams (lltv, oracle, irm, tokens) cannot
// change and there is no governance pause at the core-protocol level. The only
// "pause-shaped" surface is MetaMorpho vaults built on top of Blue, which these
// prepare_morpho_* tools do not drive. resolveMarketParams already refuses
// unknown market ids (loanToken=0x0).

async function resolveMarketParams(
  chain: SupportedChain,
  marketId: `0x${string}`
): Promise<MorphoMarketParams> {
  const client = getClient(chain);
  const morpho = morphoAddress(chain);
  const result = (await client.readContract({
    address: morpho,
    abi: morphoBlueAbi,
    functionName: "idToMarketParams",
    args: [marketId],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];
  const [loanToken, collateralToken, oracle, irm, lltv] = result;
  if (loanToken === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Unknown Morpho market id ${marketId} on ${chain}`);
  }
  return { loanToken, collateralToken, oracle, irm, lltv };
}

export async function buildMorphoSupply(p: PrepareMorphoSupplyArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.loanToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    amountWei,
    meta.decimals
  );
  const approval = await buildApprovalTx({
    chain,
    wallet,
    asset: params.loanToken,
    spender: morpho,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: meta.symbol,
    spenderLabel: "Morpho Blue",
  });
  const supplyTx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supply",
      args: [params, amountWei, 0n, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description: `Supply ${p.amount} ${meta.symbol} to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "supply",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
  return chainApproval(approval, supplyTx);
}

export async function buildMorphoWithdraw(p: PrepareMorphoWithdrawArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.loanToken);
  // "max" withdraw is encoded as shares=MaxUint256/2 would exceed position; safer to ask by assets with
  // a very large number. Morpho reverts on overdraw, so callers should read their position first.
  // Here we only support explicit amounts for withdraw.
  if (p.amount === "max") {
    throw new Error(
      `"max" is not supported for Morpho withdraw — read position and pass an explicit amount.`
    );
  }
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "withdraw",
      args: [params, amountWei, 0n, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Withdraw ${p.amount} ${meta.symbol} from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "withdraw",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
}

export async function buildMorphoBorrow(p: PrepareMorphoBorrowArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.loanToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "borrow",
      args: [params, amountWei, 0n, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Borrow ${p.amount} ${meta.symbol} from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "borrow",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
}

export async function buildMorphoRepay(p: PrepareMorphoRepayArgs): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.loanToken);

  // Issue #437 — `amount: "max"` repays the user's entire debt by
  // submitting in shares-mode. Morpho's `repay(params, assets, shares,
  // onBehalf, data)` enforces exactly one of `assets` / `shares` is
  // non-zero; passing `assets = type(uint256).max` (Aave's pattern)
  // would NOT cap to user debt — Morpho takes `assets` as the literal
  // transferFrom amount. Shares-mode lets Morpho compute the exact
  // assets from `position(marketId, user).borrowShares` at execution
  // time, so the close is exact regardless of interest accrued
  // between sign and broadcast.
  let assetsArg: bigint;
  let sharesArg: bigint;
  let neededForApproval: bigint;
  if (p.amount === "max") {
    const client = getClient(chain);
    const position = (await client.readContract({
      address: morpho,
      abi: morphoBlueAbi,
      functionName: "position",
      args: [p.marketId as `0x${string}`, wallet],
    })) as readonly [bigint, bigint, bigint];
    const borrowShares = position[1];
    if (borrowShares === 0n) {
      throw new Error(
        `No outstanding debt for marketId ${p.marketId} on Morpho Blue ${chain} — nothing to repay.`,
      );
    }
    const market = (await client.readContract({
      address: morpho,
      abi: morphoBlueAbi,
      functionName: "market",
      args: [p.marketId as `0x${string}`],
    })) as readonly [bigint, bigint, bigint, bigint, bigint, bigint];
    const totalBorrowAssets = market[2];
    const totalBorrowShares = market[3];
    // Round-up assets-from-shares: ceil(shares * (totalAssets+1) / (totalShares+1)).
    // The +1 virtual offsets approximate Morpho's `toAssetsUp` shape; the 1%
    // buffer below absorbs the residual virtual-shares math difference plus
    // any interest accrued between prepare and broadcast (matches Aave repay
    // pattern at modules/positions/actions.ts:273).
    const denom = totalBorrowShares + 1n;
    const numer = borrowShares * (totalBorrowAssets + 1n) + denom - 1n;
    const approxAssets = numer / denom;
    neededForApproval = (approxAssets * 101n) / 100n;
    assetsArg = 0n;
    sharesArg = borrowShares;
  } else {
    const amountWei = parseUnits(p.amount, meta.decimals);
    assetsArg = amountWei;
    sharesArg = 0n;
    neededForApproval = amountWei;
  }

  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    neededForApproval,
    meta.decimals,
  );
  const approval = await buildApprovalTx({
    chain,
    wallet,
    asset: params.loanToken,
    spender: morpho,
    amountWei: neededForApproval,
    approvalAmount,
    approvalDisplay: display,
    symbol: meta.symbol,
    spenderLabel: "Morpho Blue",
  });
  const repayTx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "repay",
      args: [params, assetsArg, sharesArg, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description:
      p.amount === "max"
        ? `Repay all ${meta.symbol} to Morpho Blue market ${p.marketId} on ${chain}`
        : `Repay ${p.amount} ${meta.symbol} to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "repay",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
  return chainApproval(approval, repayTx);
}

export async function buildMorphoSupplyCollateral(
  p: PrepareMorphoSupplyCollateralArgs
): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.collateralToken);
  const amountWei = parseUnits(p.amount, meta.decimals);
  const { approvalAmount, display } = resolveApprovalCap(
    p.approvalCap,
    amountWei,
    meta.decimals
  );
  const approval = await buildApprovalTx({
    chain,
    wallet,
    asset: params.collateralToken,
    spender: morpho,
    amountWei,
    approvalAmount,
    approvalDisplay: display,
    symbol: meta.symbol,
    spenderLabel: "Morpho Blue",
  });
  const tx: UnsignedTx = {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "supplyCollateral",
      args: [params, amountWei, wallet, "0x"],
    }),
    value: "0",
    from: wallet,
    description: `Supply ${p.amount} ${meta.symbol} as collateral to Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "supplyCollateral",
      args: { marketId: p.marketId, amount: p.amount, onBehalf: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
  return chainApproval(approval, tx);
}

export async function buildMorphoWithdrawCollateral(
  p: PrepareMorphoWithdrawCollateralArgs
): Promise<UnsignedTx> {
  const chain = p.chain as SupportedChain;
  const wallet = p.wallet as `0x${string}`;
  const morpho = morphoAddress(chain);
  const params = await resolveMarketParams(chain, p.marketId as `0x${string}`);
  const meta = await resolveTokenMeta(chain, params.collateralToken);
  if (p.amount === "max") {
    throw new Error(
      `"max" is not supported for Morpho withdrawCollateral — read position.collateral and pass an explicit amount.`
    );
  }
  const amountWei = parseUnits(p.amount, meta.decimals);
  return {
    chain,
    to: morpho,
    data: encodeFunctionData({
      abi: morphoBlueAbi,
      functionName: "withdrawCollateral",
      args: [params, amountWei, wallet, wallet],
    }),
    value: "0",
    from: wallet,
    description: `Withdraw ${p.amount} ${meta.symbol} collateral from Morpho Blue market ${p.marketId} on ${chain}`,
    decoded: {
      functionName: "withdrawCollateral",
      args: { marketId: p.marketId, amount: p.amount, receiver: wallet },
    },
    durableBindings: [makeDurableBinding("morpho-blue-market-id", p.marketId)],
  };
}
