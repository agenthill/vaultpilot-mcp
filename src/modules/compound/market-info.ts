import { formatUnits } from "viem";
import { getClient } from "../../data/rpc.js";
import { cometAbi } from "../../abis/compound-comet.js";
import { erc20Abi } from "../../abis/erc20.js";
import { round } from "../../data/format.js";
import { readCometPausedActions, type CometPausedAction } from "./index.js";
import type { SupportedChain } from "../../types/index.js";
import type { GetCompoundMarketInfoArgs } from "./schemas.js";

/**
 * Compound V3 per-collateral listing. Mirrors the public fields of
 * `Comet.getAssetInfo(i)` plus decoded metadata and the current total amount
 * of that asset supplied as collateral across all users.
 */
export interface CometCollateralAssetInfo {
  offset: number;
  asset: `0x${string}`;
  symbol: string;
  decimals: number;
  priceFeed: `0x${string}`;
  /** borrowCollateralFactor — bps-ish (1e18 == 100%). */
  borrowCollateralFactor: string;
  /** liquidateCollateralFactor — bps-ish (1e18 == 100%). */
  liquidateCollateralFactor: string;
  /** liquidationFactor — bps-ish (1e18 == 100%). */
  liquidationFactor: string;
  /** supplyCap in the asset's native units (formatted using decimals). */
  supplyCap: string;
  /** Total amount of this asset currently supplied as collateral (formatted). */
  totalSupplyCollateral: string;
}

export interface CompoundMarketInfo {
  chain: SupportedChain;
  market: `0x${string}`;
  baseToken: {
    address: `0x${string}`;
    symbol: string;
    decimals: number;
  };
  totalSupply: string;
  totalBorrow: string;
  utilization: number;
  supplyApr: number;
  borrowApr: number;
  pausedActions: CometPausedAction[];
  /**
   * True when the pause-flags multicall could not be resolved confidently.
   * When set, `pausedActions` is a LOWER BOUND — callers MUST treat it as
   * "state unknown" rather than "confirmed unpaused". See issue #71.
   */
  pausedActionsUnknown?: boolean;
  collateralAssets: CometCollateralAssetInfo[];
}

const SECONDS_PER_YEAR = 60n * 60n * 24n * 365n;

interface RawAssetInfo {
  offset: number;
  asset: `0x${string}`;
  priceFeed: `0x${string}`;
  scale: bigint;
  borrowCollateralFactor: bigint;
  liquidateCollateralFactor: bigint;
  liquidationFactor: bigint;
  supplyCap: bigint;
}

/**
 * Fetch structured market info for a single Comet. Designed to replace the
 * `numAssets` + 13 × `getAssetInfo` + hand-rolled ABI decode loop that the
 * 2026-04-20 session had to run via raw simulate_transaction. Everything
 * needed to explain a market's state + all listed collaterals in one call.
 */
export async function getCompoundMarketInfo(
  args: GetCompoundMarketInfoArgs
): Promise<CompoundMarketInfo> {
  const chain = args.chain as SupportedChain;
  const market = args.market as `0x${string}`;
  const client = getClient(chain);

  const core = await client.multicall({
    contracts: [
      { address: market, abi: cometAbi, functionName: "baseToken" },
      { address: market, abi: cometAbi, functionName: "numAssets" },
      { address: market, abi: cometAbi, functionName: "totalSupply" },
      { address: market, abi: cometAbi, functionName: "totalBorrow" },
      { address: market, abi: cometAbi, functionName: "getUtilization" },
    ],
    allowFailure: false,
  });
  const baseAddr = core[0] as `0x${string}`;
  const numAssets = Number(core[1]);
  const totalSupplyWei = core[2] as bigint;
  const totalBorrowWei = core[3] as bigint;
  const utilization = core[4] as bigint;

  // Rate reads depend on utilization, so they run after the core reads. Pause
  // reads + base metadata + per-slot getAssetInfo all run in parallel. Each
  // multicall is ABI-homogeneous so the viem tuple inference stays sharp.
  const baseMetaCalls = [
    { address: baseAddr, abi: erc20Abi, functionName: "decimals" as const },
    { address: baseAddr, abi: erc20Abi, functionName: "symbol" as const },
  ];
  const assetInfoCalls = Array.from({ length: numAssets }, (_, i) => ({
    address: market,
    abi: cometAbi,
    functionName: "getAssetInfo" as const,
    args: [i] as const,
  }));

  const [rates, baseMeta, assetInfoResults, pausedActions] = await Promise.all([
    client.multicall({
      contracts: [
        {
          address: market,
          abi: cometAbi,
          functionName: "getSupplyRate" as const,
          args: [utilization] as const,
        },
        {
          address: market,
          abi: cometAbi,
          functionName: "getBorrowRate" as const,
          args: [utilization] as const,
        },
      ],
      allowFailure: false,
    }),
    client.multicall({ contracts: baseMetaCalls, allowFailure: false }),
    assetInfoCalls.length === 0
      ? Promise.resolve([] as unknown[])
      : client.multicall({ contracts: assetInfoCalls, allowFailure: false }),
    readCometPausedActions(client, market),
  ]);

  const supplyRatePerSec = rates[0] as bigint;
  const borrowRatePerSec = rates[1] as bigint;

  const baseDecimals = Number(baseMeta[0]);
  const baseSymbol = baseMeta[1] as string;
  const assetInfos = assetInfoResults as unknown as RawAssetInfo[];

  // Per-collateral enrichment: totalsCollateral(address), ERC-20 decimals,
  // ERC-20 symbol. Batch all of them into one multicall.
  const perAssetCalls = assetInfos.flatMap((a) => [
    {
      address: market,
      abi: cometAbi,
      functionName: "totalsCollateral" as const,
      args: [a.asset] as const,
    },
    { address: a.asset, abi: erc20Abi, functionName: "decimals" as const },
    { address: a.asset, abi: erc20Abi, functionName: "symbol" as const },
  ]);
  const perAssetResults =
    perAssetCalls.length === 0
      ? []
      : await client.multicall({ contracts: perAssetCalls, allowFailure: true });

  const collateralAssets: CometCollateralAssetInfo[] = assetInfos.map((a, i) => {
    const totalsRes = perAssetResults[i * 3];
    const decRes = perAssetResults[i * 3 + 1];
    const symRes = perAssetResults[i * 3 + 2];
    const decimals = decRes?.status === "success" ? Number(decRes.result) : 18;
    const symbol =
      symRes?.status === "success" ? (symRes.result as string) : "?";
    const totalColl =
      totalsRes?.status === "success"
        ? ((totalsRes.result as unknown as { totalSupplyAsset: bigint })
            .totalSupplyAsset ?? 0n)
        : 0n;
    return {
      offset: a.offset,
      asset: a.asset,
      symbol,
      decimals,
      priceFeed: a.priceFeed,
      borrowCollateralFactor: a.borrowCollateralFactor.toString(),
      liquidateCollateralFactor: a.liquidateCollateralFactor.toString(),
      liquidationFactor: a.liquidationFactor.toString(),
      supplyCap: formatUnits(a.supplyCap, decimals),
      totalSupplyCollateral: formatUnits(totalColl, decimals),
    };
  });

  return {
    chain,
    market,
    baseToken: {
      address: baseAddr,
      symbol: baseSymbol,
      decimals: baseDecimals,
    },
    totalSupply: formatUnits(totalSupplyWei, baseDecimals),
    totalBorrow: formatUnits(totalBorrowWei, baseDecimals),
    // Comet returns utilization as a 1e18-scaled fraction.
    utilization: round(Number(formatUnits(utilization, 18)), 6),
    supplyApr: round(
      Number(formatUnits(supplyRatePerSec * SECONDS_PER_YEAR, 18)),
      6
    ),
    borrowApr: round(
      Number(formatUnits(borrowRatePerSec * SECONDS_PER_YEAR, 18)),
      6
    ),
    pausedActions: pausedActions.pausedActions,
    ...(pausedActions.unknown ? { pausedActionsUnknown: true } : {}),
    collateralAssets,
  };
}
