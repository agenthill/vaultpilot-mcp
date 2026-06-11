// Aave UiPoolDataProvider — three on-chain ABI variants in the wild
// across the chains we read.
//
//   V3 (legacy)  — Polygon. 54-field reserve tuple with stable-rate
//                  fields and in-tuple eMode fields (eModeCategoryId,
//                  eModeLtv, …).
//   V3.2         — Ethereum, Arbitrum (and likely Base; not verified
//                  on-chain there because the contract source is not
//                  verified on Etherscan, so we rely on decode-by-trial
//                  at first call). 41-field reserve tuple. Aave V3.2
//                  removed stable-rate borrowing entirely; eMode moved
//                  to a separate getter. Adds `virtualAccActive` +
//                  `virtualUnderlyingBalance`.
//   V3.3         — Optimism. 40-field reserve tuple. Same as V3.2 but
//                  drops `unbacked` and `virtualAccActive`, adds
//                  `deficit` at the end.
//
// The on-chain bytes are the same for one eth_call regardless of which
// ABI we hand viem; only the decode shape differs. So the helpers below
// do ONE eth_call per request, then try each variant in priority order
// and return the first that decodes. The matching variant is cached per
// uiProvider address so subsequent reads decode against the right ABI
// immediately.
//
// The exported `aaveUiPoolDataProviderAbi` (single, unparameterised) is
// kept for non-read callers — `pre-sign-check.ts` etc. use the function
// signatures only, not the output decode, so it points at V3.2 (the
// most common live shape today). New read-path callers should use the
// helpers `readAaveReservesData` / `readAaveUserReservesData` rather
// than calling `client.readContract` against the ABI directly — those
// are the only paths that survive ABI drift.
import {
  decodeFunctionResult,
  encodeFunctionData,
  type Abi,
  type PublicClient,
} from "viem";

const userReservesV3 = [
  { name: "underlyingAsset", type: "address" },
  { name: "scaledATokenBalance", type: "uint256" },
  { name: "usageAsCollateralEnabledOnUser", type: "bool" },
  { name: "scaledVariableDebt", type: "uint256" },
  { name: "principalStableDebt", type: "uint256" },
  { name: "stableBorrowRate", type: "uint256" },
  { name: "stableBorrowLastUpdateTimestamp", type: "uint40" },
] as const;

const userReservesV3_2 = [
  { name: "underlyingAsset", type: "address" },
  { name: "scaledATokenBalance", type: "uint256" },
  { name: "usageAsCollateralEnabledOnUser", type: "bool" },
  { name: "scaledVariableDebt", type: "uint256" },
] as const;

const reservesV3 = [
  { name: "underlyingAsset", type: "address" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "decimals", type: "uint256" },
  { name: "baseLTVasCollateral", type: "uint256" },
  { name: "reserveLiquidationThreshold", type: "uint256" },
  { name: "reserveLiquidationBonus", type: "uint256" },
  { name: "reserveFactor", type: "uint256" },
  { name: "usageAsCollateralEnabled", type: "bool" },
  { name: "borrowingEnabled", type: "bool" },
  { name: "stableBorrowRateEnabled", type: "bool" },
  { name: "isActive", type: "bool" },
  { name: "isFrozen", type: "bool" },
  { name: "liquidityIndex", type: "uint128" },
  { name: "variableBorrowIndex", type: "uint128" },
  { name: "liquidityRate", type: "uint128" },
  { name: "variableBorrowRate", type: "uint128" },
  { name: "stableBorrowRate", type: "uint128" },
  { name: "lastUpdateTimestamp", type: "uint40" },
  { name: "aTokenAddress", type: "address" },
  { name: "stableDebtTokenAddress", type: "address" },
  { name: "variableDebtTokenAddress", type: "address" },
  { name: "interestRateStrategyAddress", type: "address" },
  { name: "availableLiquidity", type: "uint256" },
  { name: "totalPrincipalStableDebt", type: "uint256" },
  { name: "averageStableRate", type: "uint256" },
  { name: "stableDebtLastUpdateTimestamp", type: "uint256" },
  { name: "totalScaledVariableDebt", type: "uint256" },
  { name: "priceInMarketReferenceCurrency", type: "uint256" },
  { name: "priceOracle", type: "address" },
  { name: "variableRateSlope1", type: "uint256" },
  { name: "variableRateSlope2", type: "uint256" },
  { name: "stableRateSlope1", type: "uint256" },
  { name: "stableRateSlope2", type: "uint256" },
  { name: "baseStableBorrowRate", type: "uint256" },
  { name: "baseVariableBorrowRate", type: "uint256" },
  { name: "optimalUsageRatio", type: "uint256" },
  { name: "isPaused", type: "bool" },
  { name: "isSiloedBorrowing", type: "bool" },
  { name: "accruedToTreasury", type: "uint128" },
  { name: "unbacked", type: "uint128" },
  { name: "isolationModeTotalDebt", type: "uint128" },
  { name: "flashLoanEnabled", type: "bool" },
  { name: "debtCeiling", type: "uint256" },
  { name: "debtCeilingDecimals", type: "uint256" },
  { name: "eModeCategoryId", type: "uint8" },
  { name: "borrowCap", type: "uint256" },
  { name: "supplyCap", type: "uint256" },
  { name: "eModeLtv", type: "uint16" },
  { name: "eModeLiquidationThreshold", type: "uint16" },
  { name: "eModeLiquidationBonus", type: "uint16" },
  { name: "eModePriceSource", type: "address" },
  { name: "eModeLabel", type: "string" },
  { name: "borrowableInIsolation", type: "bool" },
] as const;

const reservesV3_2 = [
  { name: "underlyingAsset", type: "address" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "decimals", type: "uint256" },
  { name: "baseLTVasCollateral", type: "uint256" },
  { name: "reserveLiquidationThreshold", type: "uint256" },
  { name: "reserveLiquidationBonus", type: "uint256" },
  { name: "reserveFactor", type: "uint256" },
  { name: "usageAsCollateralEnabled", type: "bool" },
  { name: "borrowingEnabled", type: "bool" },
  { name: "isActive", type: "bool" },
  { name: "isFrozen", type: "bool" },
  { name: "liquidityIndex", type: "uint128" },
  { name: "variableBorrowIndex", type: "uint128" },
  { name: "liquidityRate", type: "uint128" },
  { name: "variableBorrowRate", type: "uint128" },
  { name: "lastUpdateTimestamp", type: "uint40" },
  { name: "aTokenAddress", type: "address" },
  { name: "variableDebtTokenAddress", type: "address" },
  { name: "interestRateStrategyAddress", type: "address" },
  { name: "availableLiquidity", type: "uint256" },
  { name: "totalScaledVariableDebt", type: "uint256" },
  { name: "priceInMarketReferenceCurrency", type: "uint256" },
  { name: "priceOracle", type: "address" },
  { name: "variableRateSlope1", type: "uint256" },
  { name: "variableRateSlope2", type: "uint256" },
  { name: "baseVariableBorrowRate", type: "uint256" },
  { name: "optimalUsageRatio", type: "uint256" },
  { name: "isPaused", type: "bool" },
  { name: "isSiloedBorrowing", type: "bool" },
  { name: "accruedToTreasury", type: "uint128" },
  { name: "unbacked", type: "uint128" },
  { name: "isolationModeTotalDebt", type: "uint128" },
  { name: "flashLoanEnabled", type: "bool" },
  { name: "debtCeiling", type: "uint256" },
  { name: "debtCeilingDecimals", type: "uint256" },
  { name: "borrowCap", type: "uint256" },
  { name: "supplyCap", type: "uint256" },
  { name: "borrowableInIsolation", type: "bool" },
  { name: "virtualAccActive", type: "bool" },
  { name: "virtualUnderlyingBalance", type: "uint128" },
] as const;

const reservesV3_3 = [
  { name: "underlyingAsset", type: "address" },
  { name: "name", type: "string" },
  { name: "symbol", type: "string" },
  { name: "decimals", type: "uint256" },
  { name: "baseLTVasCollateral", type: "uint256" },
  { name: "reserveLiquidationThreshold", type: "uint256" },
  { name: "reserveLiquidationBonus", type: "uint256" },
  { name: "reserveFactor", type: "uint256" },
  { name: "usageAsCollateralEnabled", type: "bool" },
  { name: "borrowingEnabled", type: "bool" },
  { name: "isActive", type: "bool" },
  { name: "isFrozen", type: "bool" },
  { name: "liquidityIndex", type: "uint128" },
  { name: "variableBorrowIndex", type: "uint128" },
  { name: "liquidityRate", type: "uint128" },
  { name: "variableBorrowRate", type: "uint128" },
  { name: "lastUpdateTimestamp", type: "uint40" },
  { name: "aTokenAddress", type: "address" },
  { name: "variableDebtTokenAddress", type: "address" },
  { name: "interestRateStrategyAddress", type: "address" },
  { name: "availableLiquidity", type: "uint256" },
  { name: "totalScaledVariableDebt", type: "uint256" },
  { name: "priceInMarketReferenceCurrency", type: "uint256" },
  { name: "priceOracle", type: "address" },
  { name: "variableRateSlope1", type: "uint256" },
  { name: "variableRateSlope2", type: "uint256" },
  { name: "baseVariableBorrowRate", type: "uint256" },
  { name: "optimalUsageRatio", type: "uint256" },
  { name: "isPaused", type: "bool" },
  { name: "isSiloedBorrowing", type: "bool" },
  { name: "accruedToTreasury", type: "uint128" },
  { name: "isolationModeTotalDebt", type: "uint128" },
  { name: "flashLoanEnabled", type: "bool" },
  { name: "debtCeiling", type: "uint256" },
  { name: "debtCeilingDecimals", type: "uint256" },
  { name: "borrowCap", type: "uint256" },
  { name: "supplyCap", type: "uint256" },
  { name: "borrowableInIsolation", type: "bool" },
  { name: "virtualUnderlyingBalance", type: "uint128" },
  { name: "deficit", type: "uint128" },
] as const;

const baseCurrency = [
  { name: "marketReferenceCurrencyUnit", type: "uint256" },
  { name: "marketReferenceCurrencyPriceInUsd", type: "int256" },
  { name: "networkBaseTokenPriceInUsd", type: "int256" },
  { name: "networkBaseTokenPriceDecimals", type: "uint8" },
] as const;

function makeAbi(
  reserveComponents: ReadonlyArray<{ name: string; type: string }>,
  userComponents: ReadonlyArray<{ name: string; type: string }>,
) {
  return [
    {
      type: "function",
      name: "getUserReservesData",
      stateMutability: "view",
      inputs: [
        { name: "provider", type: "address" },
        { name: "user", type: "address" },
      ],
      outputs: [
        {
          name: "userReserves",
          type: "tuple[]",
          components: userComponents,
        },
        { name: "userEmodeCategoryId", type: "uint8" },
      ],
    },
    {
      type: "function",
      name: "getReservesData",
      stateMutability: "view",
      inputs: [{ name: "provider", type: "address" }],
      outputs: [
        {
          name: "reserves",
          type: "tuple[]",
          components: reserveComponents,
        },
        {
          name: "baseCurrencyInfo",
          type: "tuple",
          components: baseCurrency,
        },
      ],
    },
  ] as const;
}

export const aaveUiPoolDataProviderAbiV3 = makeAbi(reservesV3, userReservesV3);
export const aaveUiPoolDataProviderAbiV3_2 = makeAbi(reservesV3_2, userReservesV3_2);
export const aaveUiPoolDataProviderAbiV3_3 = makeAbi(reservesV3_3, userReservesV3_2);

// Single-shape default for non-read callers (selector lookup, encoding,
// pre-sign safety check). Decode-path callers must use the helpers.
export const aaveUiPoolDataProviderAbi = aaveUiPoolDataProviderAbiV3_2;

type AbiVariant = "v3" | "v3_2" | "v3_3";

const ABI_VARIANTS: ReadonlyArray<{ variant: AbiVariant; abi: Abi }> = [
  { variant: "v3_2", abi: aaveUiPoolDataProviderAbiV3_2 as unknown as Abi },
  { variant: "v3_3", abi: aaveUiPoolDataProviderAbiV3_3 as unknown as Abi },
  { variant: "v3", abi: aaveUiPoolDataProviderAbiV3 as unknown as Abi },
];

// Cache: address(uiProvider) lower-cased → variant that decoded
// successfully. Module-scoped so the next read on the same chain skips
// the trial-decode loop.
const variantCache = new Map<string, AbiVariant>();

/** Returns ABI_VARIANTS reordered so the cached variant (if any) is tried first. */
function orderedVariants(uiProvider: `0x${string}`): ReadonlyArray<{ variant: AbiVariant; abi: Abi }> {
  const cached = variantCache.get(uiProvider.toLowerCase());
  if (!cached) return ABI_VARIANTS;
  return [
    ABI_VARIANTS.find((v) => v.variant === cached)!,
    ...ABI_VARIANTS.filter((v) => v.variant !== cached),
  ];
}

/**
 * Test-only escape hatch — drops the cached variant for a given
 * uiProvider so a subsequent call re-runs the trial-decode loop.
 */
export function _resetAaveAbiCacheForTest(uiProvider?: string): void {
  if (uiProvider) variantCache.delete(uiProvider.toLowerCase());
  else variantCache.clear();
}

/** Normalized reserve fields — only what consumers actually read. */
export interface AaveReserveNormalized {
  underlyingAsset: `0x${string}`;
  name: string;
  symbol: string;
  decimals: bigint;
  baseLTVasCollateral: bigint;
  reserveLiquidationThreshold: bigint;
  liquidityIndex: bigint;
  variableBorrowIndex: bigint;
  liquidityRate: bigint;
  variableBorrowRate: bigint;
  aTokenAddress: `0x${string}`;
  variableDebtTokenAddress: `0x${string}`;
  availableLiquidity: bigint;
  totalScaledVariableDebt: bigint;
  priceInMarketReferenceCurrency: bigint;
  isActive: boolean;
  isFrozen: boolean;
  isPaused: boolean;
  isSiloedBorrowing: boolean;
  borrowingEnabled: boolean;
  usageAsCollateralEnabled: boolean;
  borrowableInIsolation: boolean;
}

export interface AaveBaseCurrencyNormalized {
  marketReferenceCurrencyUnit: bigint;
  marketReferenceCurrencyPriceInUsd: bigint;
  networkBaseTokenPriceInUsd: bigint;
  networkBaseTokenPriceDecimals: number;
}

export interface AaveUserReserveNormalized {
  underlyingAsset: `0x${string}`;
  scaledATokenBalance: bigint;
  usageAsCollateralEnabledOnUser: boolean;
  scaledVariableDebt: bigint;
}

function tryDecodeReserves(
  hex: `0x${string}`,
  uiProvider: `0x${string}`,
): { reserves: AaveReserveNormalized[]; baseCurrency: AaveBaseCurrencyNormalized; variant: AbiVariant } {
  const cacheKey = uiProvider.toLowerCase();
  const order = orderedVariants(uiProvider);

  let lastErr: unknown;
  for (const { variant, abi } of order) {
    try {
      const decoded = decodeFunctionResult({
        abi,
        functionName: "getReservesData",
        data: hex,
      }) as unknown as [Array<Record<string, unknown>>, Record<string, unknown>];
      const [rawReserves, rawBase] = decoded;
      // Field-by-name access — the normalized type only references
      // fields that exist in every variant, so this projection is
      // total.
      const reserves: AaveReserveNormalized[] = rawReserves.map((r) => ({
        underlyingAsset: r.underlyingAsset as `0x${string}`,
        name: r.name as string,
        symbol: r.symbol as string,
        decimals: r.decimals as bigint,
        baseLTVasCollateral: r.baseLTVasCollateral as bigint,
        reserveLiquidationThreshold: r.reserveLiquidationThreshold as bigint,
        liquidityIndex: r.liquidityIndex as bigint,
        variableBorrowIndex: r.variableBorrowIndex as bigint,
        liquidityRate: r.liquidityRate as bigint,
        variableBorrowRate: r.variableBorrowRate as bigint,
        aTokenAddress: r.aTokenAddress as `0x${string}`,
        variableDebtTokenAddress: r.variableDebtTokenAddress as `0x${string}`,
        availableLiquidity: r.availableLiquidity as bigint,
        totalScaledVariableDebt: r.totalScaledVariableDebt as bigint,
        priceInMarketReferenceCurrency: r.priceInMarketReferenceCurrency as bigint,
        isActive: r.isActive as boolean,
        isFrozen: r.isFrozen as boolean,
        isPaused: r.isPaused as boolean,
        isSiloedBorrowing: r.isSiloedBorrowing as boolean,
        borrowingEnabled: r.borrowingEnabled as boolean,
        usageAsCollateralEnabled: r.usageAsCollateralEnabled as boolean,
        borrowableInIsolation: r.borrowableInIsolation as boolean,
      }));
      const base: AaveBaseCurrencyNormalized = {
        marketReferenceCurrencyUnit: rawBase.marketReferenceCurrencyUnit as bigint,
        marketReferenceCurrencyPriceInUsd: rawBase.marketReferenceCurrencyPriceInUsd as bigint,
        networkBaseTokenPriceInUsd: rawBase.networkBaseTokenPriceInUsd as bigint,
        networkBaseTokenPriceDecimals: Number(rawBase.networkBaseTokenPriceDecimals),
      };
      variantCache.set(cacheKey, variant);
      return { reserves, baseCurrency: base, variant };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Aave UiPoolDataProvider getReservesData decode failed against all known variants ` +
      `(v3, v3.2, v3.3) for ${uiProvider}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

function tryDecodeUserReserves(
  hex: `0x${string}`,
  uiProvider: `0x${string}`,
): { userReserves: AaveUserReserveNormalized[]; userEmodeCategoryId: number; variant: AbiVariant } {
  // The userReserves shape only varies between v3 (legacy: 7 fields)
  // and v3.2/v3.3 (4 fields). The four shared fields — underlyingAsset,
  // scaledATokenBalance, usageAsCollateralEnabledOnUser, scaledVariableDebt —
  // are what consumers read. We use the same per-uiProvider cache as
  // getReservesData; v3.2 and v3.3 use identical user shapes so caching
  // either gives a correct decode.
  const cacheKey = uiProvider.toLowerCase();
  const order = orderedVariants(uiProvider);

  let lastErr: unknown;
  for (const { variant, abi } of order) {
    try {
      const decoded = decodeFunctionResult({
        abi,
        functionName: "getUserReservesData",
        data: hex,
      }) as unknown as [Array<Record<string, unknown>>, number | bigint];
      const [rawUserReserves, emodeCat] = decoded;
      const userReserves: AaveUserReserveNormalized[] = rawUserReserves.map((u) => ({
        underlyingAsset: u.underlyingAsset as `0x${string}`,
        scaledATokenBalance: u.scaledATokenBalance as bigint,
        usageAsCollateralEnabledOnUser: u.usageAsCollateralEnabledOnUser as boolean,
        scaledVariableDebt: u.scaledVariableDebt as bigint,
      }));
      variantCache.set(cacheKey, variant);
      return {
        userReserves,
        userEmodeCategoryId: Number(emodeCat),
        variant,
      };
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(
    `Aave UiPoolDataProvider getUserReservesData decode failed against all known variants ` +
      `(v3, v3.2, v3.3) for ${uiProvider}: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
  );
}

/**
 * Read `getReservesData(provider)` from the Aave UiPoolDataProvider on
 * any chain, decoding against whichever ABI variant the deployed
 * contract speaks. Caches the matching variant per uiProvider address
 * so subsequent calls skip the trial loop.
 *
 * The selector for `getReservesData(address)` is identical across all
 * variants (same function signature), so we encode using the V3.2
 * default and only the decode shape needs to be tried.
 */
export async function readAaveReservesData(
  client: PublicClient,
  uiProvider: `0x${string}`,
  poolAddressProvider: `0x${string}`,
): Promise<{
  reserves: AaveReserveNormalized[];
  baseCurrency: AaveBaseCurrencyNormalized;
}> {
  const data = encodeFunctionData({
    abi: aaveUiPoolDataProviderAbiV3_2,
    functionName: "getReservesData",
    args: [poolAddressProvider],
  });
  const { data: returnData } = await client.call({ to: uiProvider, data });
  if (!returnData || returnData === "0x") {
    throw new Error(
      `Aave UiPoolDataProvider getReservesData returned empty data from ${uiProvider}`,
    );
  }
  return tryDecodeReserves(returnData as `0x${string}`, uiProvider);
}

/**
 * Read `getUserReservesData(provider, user)` from the Aave
 * UiPoolDataProvider, with the same trial-decode protection as
 * `readAaveReservesData`.
 */
export async function readAaveUserReservesData(
  client: PublicClient,
  uiProvider: `0x${string}`,
  poolAddressProvider: `0x${string}`,
  user: `0x${string}`,
): Promise<{
  userReserves: AaveUserReserveNormalized[];
  userEmodeCategoryId: number;
}> {
  const data = encodeFunctionData({
    abi: aaveUiPoolDataProviderAbiV3_2,
    functionName: "getUserReservesData",
    args: [poolAddressProvider, user],
  });
  const { data: returnData } = await client.call({ to: uiProvider, data });
  if (!returnData || returnData === "0x") {
    throw new Error(
      `Aave UiPoolDataProvider getUserReservesData returned empty data from ${uiProvider}`,
    );
  }
  return tryDecodeUserReserves(returnData as `0x${string}`, uiProvider);
}
