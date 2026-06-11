import { getAaveLendingPosition, simulateHealthFactorChange } from "./aave.js";
import { getUniswapPositions } from "./uniswap.js";
import { getCompoundPositions } from "../compound/index.js";
import { getCompoundMarketInfo } from "../compound/market-info.js";
import { getMorphoPositions } from "../morpho/index.js";
import {
  getMarginfiPositions,
  getKaminoPositions,
} from "../execution/index.js";
import type {
  GetLendingPositionsArgs,
  GetLpPositionsArgs,
  GetHealthAlertsArgs,
  SimulatePositionChangeArgs,
} from "./schemas.js";
import type { LendingPosition, LPPosition, SupportedChain } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function resolveChains(chains?: string[]): SupportedChain[] {
  return (chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS];
}

export async function getLendingPositions(args: GetLendingPositionsArgs): Promise<{
  wallet: string;
  positions: LendingPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const results = await Promise.all(chains.map((c) => getAaveLendingPosition(wallet, c)));
  return { wallet, positions: results.filter((p): p is LendingPosition => p !== null) };
}

export async function getLpPositions(args: GetLpPositionsArgs): Promise<{
  wallet: string;
  positions: LPPosition[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains = resolveChains(args.chains);
  const perChain = await Promise.all(chains.map((c) => getUniswapPositions(wallet, c)));
  return { wallet, positions: perChain.flat() };
}

/**
 * Health-factor row for one at-risk lending position. The discriminator
 * is `protocol`; `chain` is "solana" for MarginFi / Kamino and an EVM
 * chain otherwise; `market` is the protocol-specific position handle —
 * Comet address for Compound V3, marketId bytes32 for Morpho Blue,
 * MarginfiAccount for MarginFi, obligation for Kamino, and `null` for
 * Aave V3 (Aave aggregates per-chain, not per-market).
 */
export interface HealthAlertRow {
  protocol: "aave-v3" | "compound-v3" | "morpho-blue" | "marginfi" | "kamino";
  chain: SupportedChain | "solana";
  market: string | null;
  healthFactor: number;
  collateralUsd: number;
  debtUsd: number;
  /** % HF would need to drop by to hit 1.0. */
  marginToLiquidation: number;
}

function marginPct(hf: number): number {
  if (!Number.isFinite(hf) || hf <= 0) return 0;
  return Math.max(0, Math.round(((hf - 1) / hf) * 10000) / 100);
}

/** Cap Infinity at the sentinel 1e18 and round to 4 decimal places. */
function normalizeHF(hf: number): number {
  return hf === Number.POSITIVE_INFINITY ? 1e18 : Math.round(hf * 10000) / 10000;
}

/**
 * Across-protocol liquidation-risk reader. Issue #427: until this rewrite
 * the function only scanned Aave V3 reserves — a user with no Aave borrows
 * but active borrows on Compound V3 / Morpho Blue / MarginFi / Kamino got
 * `atRisk: []` back from a generically-named tool, which is false safety
 * reassurance, not just a UX gap.
 *
 * Now fans out to all five readers in parallel and computes a unified
 * health factor per position:
 *   - Aave V3, MarginFi, Kamino expose `healthFactor` directly on the
 *     position type → use as-is.
 *   - Compound V3 needs per-market `liquidateCollateralFactor` to compute
 *     `Σ(collat_i × CF_i) / debt`. We fetch one `getCompoundMarketInfo`
 *     per market the user has positions in (most users have ≤ 2).
 *   - Morpho Blue exposes `lltv` on the position; `(collat × lltv) / debt`
 *     reproduces Morpho's liquidation rule.
 *
 * EVM and Solana inputs are independent: the user passes whichever
 * address(es) they have. Schema validation requires at least one.
 *
 * Per-protocol failures (RPC down, MarginFi SDK IDL drift, etc.) DO NOT
 * fail the whole call — each reader is wrapped so a partial result still
 * reaches the user. The optional `notes[]` field flags any reader that
 * couldn't run so a "no liquidation risk" answer is never silently wrong.
 */
export async function getHealthAlerts(args: GetHealthAlertsArgs): Promise<{
  wallet: string | null;
  solanaWallet: string | null;
  threshold: number;
  atRisk: HealthAlertRow[];
  notes?: string[];
}> {
  if (!args.wallet && !args.solanaWallet) {
    throw new Error(
      "get_health_alerts requires at least one of `wallet` (EVM) or " +
        "`solanaWallet` (Solana base58).",
    );
  }
  const threshold = args.threshold ?? 1.5;
  const notes: string[] = [];

  type ProtocolJob =
    | { kind: "skip" }
    | { kind: "rows"; rows: HealthAlertRow[] };
  async function run(
    label: string,
    fn: () => Promise<HealthAlertRow[]>,
  ): Promise<ProtocolJob> {
    try {
      return { kind: "rows", rows: await fn() };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      notes.push(`${label} health check failed: ${msg}`);
      return { kind: "skip" };
    }
  }

  const evmJobs = args.wallet
    ? [
        run("Aave V3", () => readAaveAtRisk(args.wallet!, threshold)),
        run("Compound V3", () => readCompoundAtRisk(args.wallet!, threshold)),
        run("Morpho Blue", () => readMorphoAtRisk(args.wallet!, threshold)),
      ]
    : [];
  const solanaJobs = args.solanaWallet
    ? [
        run("MarginFi", () => readMarginfiAtRisk(args.solanaWallet!, threshold)),
        run("Kamino", () => readKaminoAtRisk(args.solanaWallet!, threshold)),
      ]
    : [];

  const results = await Promise.all([...evmJobs, ...solanaJobs]);
  const atRisk = results.flatMap((r) => (r.kind === "rows" ? r.rows : []));
  return {
    wallet: args.wallet ?? null,
    solanaWallet: args.solanaWallet ?? null,
    threshold,
    atRisk,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

async function readAaveAtRisk(
  wallet: string,
  threshold: number,
): Promise<HealthAlertRow[]> {
  const { positions } = await getLendingPositions({ wallet, chains: undefined });
  return positions
    .filter((p) => p.healthFactor < threshold && p.totalDebtUsd > 0)
    .map((p) => ({
      protocol: "aave-v3" as const,
      chain: p.chain,
      market: null,
      healthFactor: p.healthFactor,
      collateralUsd: p.totalCollateralUsd,
      debtUsd: p.totalDebtUsd,
      marginToLiquidation: marginPct(p.healthFactor),
    }));
}

async function readCompoundAtRisk(
  wallet: string,
  threshold: number,
): Promise<HealthAlertRow[]> {
  const { positions } = await getCompoundPositions({ wallet, chains: undefined });
  const borrowing = positions.filter((p) => p.totalDebtUsd > 0);
  if (borrowing.length === 0) return [];
  // Comet's liquidation rule: Σ(collateral_i × liquidateCF_i) ≥ borrowed.
  // CF lives on the market info — fetch one per (chain, market).
  const infos = await Promise.all(
    borrowing.map((p) =>
      getCompoundMarketInfo({ chain: p.chain, market: p.marketAddress }),
    ),
  );
  const rows: HealthAlertRow[] = [];
  for (let i = 0; i < borrowing.length; i++) {
    const pos = borrowing[i];
    const info = infos[i];
    const cfByAsset = new Map<string, number>();
    for (const c of info.collateralAssets) {
      cfByAsset.set(
        c.asset.toLowerCase(),
        Number(c.liquidateCollateralFactor) / 1e18,
      );
    }
    const liquidationCollateralUsd = pos.collateral.reduce((sum, t) => {
      const cf = cfByAsset.get(t.token.toLowerCase()) ?? 0;
      return sum + (t.valueUsd ?? 0) * cf;
    }, 0);
    const hf = liquidationCollateralUsd / pos.totalDebtUsd;
    if (hf >= threshold) continue;
    rows.push({
      protocol: "compound-v3",
      chain: pos.chain,
      market: pos.marketAddress,
      healthFactor: Math.round(hf * 10000) / 10000,
      collateralUsd: pos.totalCollateralUsd,
      debtUsd: pos.totalDebtUsd,
      marginToLiquidation: marginPct(hf),
    });
  }
  return rows;
}

async function readMorphoAtRisk(
  wallet: string,
  threshold: number,
): Promise<HealthAlertRow[]> {
  // Morpho Blue is Ethereum-only today; discovery is opt-in via
  // VAULTPILOT_MORPHO_DISCOVERY=1 (without it, getMorphoPositions returns
  // an empty list with `discoverySkipped: true`). The discoverySkipped
  // case is a pre-existing limitation — surfacing it as a `notes` line
  // here so the user at least sees that Morpho coverage was inactive.
  const { positions, discoverySkipped } = await getMorphoPositions({
    wallet,
    chain: "ethereum",
  });
  if (discoverySkipped) {
    throw new Error(
      "Morpho discovery is opt-in (set VAULTPILOT_MORPHO_DISCOVERY=1) — " +
        "this run did not scan Morpho positions.",
    );
  }
  const rows: HealthAlertRow[] = [];
  for (const pos of positions) {
    if (pos.totalDebtUsd <= 0) continue;
    const lltvFraction = Number(pos.lltv) / 1e18;
    const hf = (pos.totalCollateralUsd * lltvFraction) / pos.totalDebtUsd;
    if (hf >= threshold) continue;
    rows.push({
      protocol: "morpho-blue",
      chain: pos.chain,
      market: pos.marketId,
      healthFactor: Math.round(hf * 10000) / 10000,
      collateralUsd: pos.totalCollateralUsd,
      debtUsd: pos.totalDebtUsd,
      marginToLiquidation: marginPct(hf),
    });
  }
  return rows;
}

async function readMarginfiAtRisk(
  solanaWallet: string,
  threshold: number,
): Promise<HealthAlertRow[]> {
  const { positions } = await getMarginfiPositions({ wallet: solanaWallet });
  return positions
    .filter((p) => p.totalBorrowedUsd > 0 && p.healthFactor < threshold)
    .map((p) => ({
      protocol: "marginfi" as const,
      chain: "solana" as const,
      market: p.marginfiAccount,
      healthFactor: p.healthFactor,
      collateralUsd: p.totalSuppliedUsd,
      debtUsd: p.totalBorrowedUsd,
      marginToLiquidation: marginPct(p.healthFactor),
    }));
}

async function readKaminoAtRisk(
  solanaWallet: string,
  threshold: number,
): Promise<HealthAlertRow[]> {
  const { positions } = await getKaminoPositions({ wallet: solanaWallet });
  return positions
    .filter((p) => p.totalBorrowedUsd > 0 && p.healthFactor < threshold)
    .map((p) => ({
      protocol: "kamino" as const,
      chain: "solana" as const,
      market: p.obligation,
      healthFactor: p.healthFactor,
      collateralUsd: p.totalSuppliedUsd,
      debtUsd: p.totalBorrowedUsd,
      marginToLiquidation: marginPct(p.healthFactor),
    }));
}

export async function simulatePositionChange(args: SimulatePositionChangeArgs): Promise<{
  wallet: string;
  chain: SupportedChain;
  protocol: "aave-v3" | "compound-v3" | "morpho-blue";
  action: string;
  before: { healthFactor: number; collateralUsd: number; debtUsd: number };
  after: { healthFactor: number; collateralUsd: number; debtUsd: number; safe: boolean };
}> {
  const wallet = args.wallet as `0x${string}`;
  const chain = (args.chain ?? "ethereum") as SupportedChain;
  const protocol = args.protocol ?? "aave-v3";

  if (protocol === "aave-v3") {
    const base = await getAaveLendingPosition(wallet, chain);
    if (!base) {
      throw new Error(`Wallet ${wallet} has no Aave V3 position on ${chain}.`);
    }
    const sim = simulateHealthFactorChange(base, args.action, args.amountUsd);
    return {
      wallet,
      chain,
      protocol,
      action: args.action,
      before: {
        healthFactor: base.healthFactor,
        collateralUsd: base.totalCollateralUsd,
        debtUsd: base.totalDebtUsd,
      },
      after: {
        healthFactor: sim.newHealthFactor,
        collateralUsd: sim.newCollateralUsd,
        debtUsd: sim.newDebtUsd,
        safe: sim.safe,
      },
    };
  }

  if (protocol === "compound-v3") {
    if (!args.market) {
      throw new Error(
        `simulate_position_change for compound-v3 requires \`market\` (the Comet market address).`
      );
    }
    const market = args.market as `0x${string}`;
    const [{ positions }, info] = await Promise.all([
      getCompoundPositions({ wallet: args.wallet, chains: [chain] }),
      getCompoundMarketInfo({ chain, market }),
    ]);
    const pos = positions.find(
      (p) => p.chain === chain && p.marketAddress.toLowerCase() === market.toLowerCase()
    );
    if (!pos) {
      throw new Error(
        `Wallet ${wallet} has no Compound V3 position in market ${market} on ${chain}.`
      );
    }
    // Comet's liquidation rule: sum(collateral_i × liquidateCF_i) ≥ baseBorrowed.
    // Reproduce that as a 1-to-1 health factor.
    const cfByAsset = new Map<string, number>();
    for (const c of info.collateralAssets) {
      cfByAsset.set(
        c.asset.toLowerCase(),
        Number(c.liquidateCollateralFactor) / 1e18
      );
    }
    const liquidationCollateralUsd = pos.collateral.reduce((sum, t) => {
      const cf = cfByAsset.get(t.token.toLowerCase()) ?? 0;
      return sum + (t.valueUsd ?? 0) * cf;
    }, 0);
    const beforeDebt = pos.totalDebtUsd;
    const beforeHF =
      beforeDebt === 0 ? Number.POSITIVE_INFINITY : liquidationCollateralUsd / beforeDebt;

    // Apply delta. For add/remove_collateral, use the asset-specific CF when
    // `asset` was passed and resolves to a known collateral; otherwise weighted
    // average across existing collaterals.
    const weightedAvgCF =
      pos.totalCollateralUsd > 0
        ? liquidationCollateralUsd / pos.totalCollateralUsd
        : 0;
    const argAssetCF =
      args.asset && cfByAsset.has(args.asset.toLowerCase())
        ? cfByAsset.get(args.asset.toLowerCase())!
        : weightedAvgCF;

    let newCollateralUsd = pos.totalCollateralUsd;
    let newLiquidationCollateralUsd = liquidationCollateralUsd;
    let newDebt = beforeDebt;
    switch (args.action) {
      case "add_collateral":
        newCollateralUsd += args.amountUsd;
        newLiquidationCollateralUsd += args.amountUsd * argAssetCF;
        break;
      case "remove_collateral":
        newCollateralUsd = Math.max(0, newCollateralUsd - args.amountUsd);
        newLiquidationCollateralUsd = Math.max(
          0,
          newLiquidationCollateralUsd - args.amountUsd * argAssetCF
        );
        break;
      case "borrow":
        newDebt += args.amountUsd;
        break;
      case "repay":
        newDebt = Math.max(0, newDebt - args.amountUsd);
        break;
    }
    const afterHF =
      newDebt === 0 ? Number.POSITIVE_INFINITY : newLiquidationCollateralUsd / newDebt;

    return {
      wallet,
      chain,
      protocol,
      action: args.action,
      before: {
        healthFactor: normalizeHF(beforeHF),
        collateralUsd: pos.totalCollateralUsd,
        debtUsd: beforeDebt,
      },
      after: {
        healthFactor: normalizeHF(afterHF),
        collateralUsd: Math.round(newCollateralUsd * 100) / 100,
        debtUsd: Math.round(newDebt * 100) / 100,
        safe: afterHF > 1.0,
      },
    };
  }

  // morpho-blue
  if (!args.marketId) {
    throw new Error(
      `simulate_position_change for morpho-blue requires \`marketId\` (bytes32).`
    );
  }
  const marketId = args.marketId as `0x${string}`;
  const { positions } = await getMorphoPositions({
    wallet: args.wallet,
    chain,
    marketIds: [marketId],
  });
  const pos = positions.find((p) => p.marketId.toLowerCase() === marketId.toLowerCase());
  if (!pos) {
    throw new Error(
      `Wallet ${wallet} has no Morpho Blue position in market ${marketId} on ${chain}.`
    );
  }
  // Morpho: liquidation when collateralUsd × lltv < borrowedUsd. lltv is a
  // 1e18-scaled fraction. Health = (collat × lltv) / debt.
  const lltvFraction = Number(pos.lltv) / 1e18;
  const beforeHF =
    pos.totalDebtUsd === 0
      ? Number.POSITIVE_INFINITY
      : (pos.totalCollateralUsd * lltvFraction) / pos.totalDebtUsd;

  let newCollateralUsd = pos.totalCollateralUsd;
  let newDebt = pos.totalDebtUsd;
  switch (args.action) {
    case "add_collateral":
      newCollateralUsd += args.amountUsd;
      break;
    case "remove_collateral":
      newCollateralUsd = Math.max(0, newCollateralUsd - args.amountUsd);
      break;
    case "borrow":
      newDebt += args.amountUsd;
      break;
    case "repay":
      newDebt = Math.max(0, newDebt - args.amountUsd);
      break;
  }
  const afterHF =
    newDebt === 0
      ? Number.POSITIVE_INFINITY
      : (newCollateralUsd * lltvFraction) / newDebt;

  return {
    wallet,
    chain,
    protocol,
    action: args.action,
    before: {
      healthFactor: normalizeHF(beforeHF),
      collateralUsd: pos.totalCollateralUsd,
      debtUsd: pos.totalDebtUsd,
    },
    after: {
      healthFactor: normalizeHF(afterHF),
      collateralUsd: Math.round(newCollateralUsd * 100) / 100,
      debtUsd: Math.round(newDebt * 100) / 100,
      safe: afterHF > 1.0,
    },
  };
}
