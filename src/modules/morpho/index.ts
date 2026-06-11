import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { morphoBlueAbi } from "../../abis/morpho-blue.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import { discoverMorphoMarketIds } from "./discover.js";
import type { GetMorphoPositionsArgs } from "./schemas.js";
import type { SupportedChain, TokenAmount } from "../../types/index.js";

/**
 * A Morpho Blue position in a single (loanToken, collateralToken, oracle, irm, lltv) market.
 * Shares are converted to assets using the market's live totalSupplyAssets / totalSupplyShares ratio
 * (and likewise for borrow), which is an accurate snapshot at block-time.
 */
export interface MorphoPosition {
  protocol: "morpho-blue";
  chain: SupportedChain;
  marketId: `0x${string}`;
  loanToken: `0x${string}`;
  collateralToken: `0x${string}`;
  lltv: string;
  supplied: TokenAmount | null;
  borrowed: TokenAmount | null;
  collateral: TokenAmount | null;
  totalCollateralUsd: number;
  totalDebtUsd: number;
  totalSuppliedUsd: number;
  netValueUsd: number;
}

function morphoAddress(chain: SupportedChain): `0x${string}` | null {
  const entry = (CONTRACTS as Record<string, Record<string, Record<string, string>>>)[chain]
    ?.morpho;
  const addr = entry?.blue;
  return (addr as `0x${string}` | undefined) ?? null;
}

async function readMarketPosition(
  wallet: `0x${string}`,
  chain: SupportedChain,
  morpho: `0x${string}`,
  marketId: `0x${string}`
): Promise<MorphoPosition | null> {
  const client = getClient(chain);

  const [position, params, market] = await client.multicall({
    contracts: [
      {
        address: morpho,
        abi: morphoBlueAbi,
        functionName: "position",
        args: [marketId, wallet],
      },
      {
        address: morpho,
        abi: morphoBlueAbi,
        functionName: "idToMarketParams",
        args: [marketId],
      },
      { address: morpho, abi: morphoBlueAbi, functionName: "market", args: [marketId] },
    ],
    allowFailure: false,
  });

  const [supplyShares, borrowShares, collateralWei] = position as readonly [bigint, bigint, bigint];

  if (supplyShares === 0n && borrowShares === 0n && collateralWei === 0n) {
    return null;
  }

  const [loanToken, collateralToken, , , lltv] = params as readonly [
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    `0x${string}`,
    bigint,
  ];
  const [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares] =
    market as readonly [bigint, bigint, bigint, bigint, bigint, bigint];

  // Morpho share math: assets = shares * totalAssets / totalShares (virtual offset ignored — Morpho's
  // SharesMathLib adds 1 wei + 1e6 virtual offset, but for UI-level accuracy this is negligible).
  const suppliedWei = totalSupplyShares > 0n ? (supplyShares * totalSupplyAssets) / totalSupplyShares : 0n;
  const borrowedWei = totalBorrowShares > 0n ? (borrowShares * totalBorrowAssets) / totalBorrowShares : 0n;

  const [loanDecimals, loanSymbol, collateralDecimals, collateralSymbol] = await client.multicall({
    contracts: [
      { address: loanToken, abi: erc20Abi, functionName: "decimals" },
      { address: loanToken, abi: erc20Abi, functionName: "symbol" },
      { address: collateralToken, abi: erc20Abi, functionName: "decimals" },
      { address: collateralToken, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });

  const lDec = Number(loanDecimals);
  const lSym = loanSymbol as string;
  const cDec = Number(collateralDecimals);
  const cSym = collateralSymbol as string;

  const supplied =
    suppliedWei > 0n ? makeTokenAmount(chain, loanToken, suppliedWei, lDec, lSym) : null;
  const borrowed =
    borrowedWei > 0n ? makeTokenAmount(chain, loanToken, borrowedWei, lDec, lSym) : null;
  const collateral =
    collateralWei > 0n
      ? makeTokenAmount(chain, collateralToken, collateralWei, cDec, cSym)
      : null;

  const toPrice = [supplied, borrowed, collateral].filter((t): t is TokenAmount => t !== null);
  await priceTokenAmounts(chain, toPrice);

  const totalSuppliedUsd = supplied?.valueUsd ?? 0;
  const totalDebtUsd = borrowed?.valueUsd ?? 0;
  const totalCollateralUsd = collateral?.valueUsd ?? 0;

  return {
    protocol: "morpho-blue",
    chain,
    marketId,
    loanToken,
    collateralToken,
    lltv: lltv.toString(),
    supplied,
    borrowed,
    collateral,
    totalCollateralUsd: round(totalCollateralUsd, 2),
    totalDebtUsd: round(totalDebtUsd, 2),
    totalSuppliedUsd: round(totalSuppliedUsd, 2),
    netValueUsd: round(totalSuppliedUsd + totalCollateralUsd - totalDebtUsd, 2),
  };
}

/**
 * Environment flag that enables automatic Morpho Blue market-id discovery
 * via event-log scan. Default OFF because discovery is ~300 chunked
 * `eth_getLogs` calls per wallet per chain on mainnet — the dominant
 * source of Infura 429s in #88 traces. Users who actively hold Morpho
 * positions opt in with `VAULTPILOT_MORPHO_DISCOVERY=1` (or pass explicit
 * `marketIds` to this tool, which bypasses the flag entirely for a
 * fast-path read).
 */
function morphoDiscoveryEnabled(): boolean {
  return process.env.VAULTPILOT_MORPHO_DISCOVERY === "1";
}

export async function getMorphoPositions(
  args: GetMorphoPositionsArgs
): Promise<{
  wallet: `0x${string}`;
  positions: MorphoPosition[];
  /**
   * True iff we hit the discovery path AND the opt-in env var was unset,
   * so discovery was skipped without RPC calls. The aggregator surfaces
   * this as a non-errored "covered:false" status with a note pointing at
   * the opt-in mechanism — distinct from an errored/429 coverage.morpho.
   */
  discoverySkipped?: boolean;
}> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const morpho = morphoAddress(chain);
  if (!morpho) {
    return { wallet, positions: [] };
  }
  const explicitIds = args.marketIds as `0x${string}`[] | undefined;
  let marketIds: `0x${string}`[];
  if (explicitIds !== undefined) {
    marketIds = explicitIds;
  } else if (morphoDiscoveryEnabled()) {
    marketIds = await discoverMorphoMarketIds(wallet, chain);
  } else {
    // Discovery is opt-in. Return cleanly with a flag so coverage.morpho
    // becomes an opt-in guidance note rather than an errored coverage.
    return { wallet, positions: [], discoverySkipped: true };
  }
  if (marketIds.length === 0) {
    return { wallet, positions: [] };
  }
  const results = await Promise.all(
    marketIds.map((id) => readMarketPosition(wallet, chain, morpho, id))
  );
  return { wallet, positions: results.filter((p): p is MorphoPosition => p !== null) };
}
