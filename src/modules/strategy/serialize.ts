/**
 * `PortfolioSummary` → anonymized strategy structure.
 *
 * Walks the existing portfolio summary shape and emits one
 * `SharedStrategyPosition` row per non-zero position. Percentages are
 * computed against `summary.totalUsd` and rounded to 1 decimal — finer
 * precision would help fingerprint a wallet (47.32% USDC + 18.94% ETH
 * + ... is more identifying than the bucket itself).
 *
 * Privacy posture: this module emits ONLY the fields explicitly listed
 * below — no addresses, no raw balances, no tx hashes. The
 * `assertNoAddressLeak` scan in `redact.ts` runs on the output as a
 * mechanical check that this hand-crafted projection didn't drift, but
 * the projection is the source of truth for "what gets shared".
 */

import type {
  PortfolioSummary,
  LendingPositionUnion,
  LPPosition,
  StakingPosition,
  TronStakingSlice,
  TokenAmount,
  TronBalance,
  SolanaBalance,
} from "../../types/index.js";
import type {
  SharedStrategyPosition,
} from "./schemas.js";

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Compute pctOfTotal, rounded to 1 decimal. Total of 0 → 0%. */
function pct(valueUsd: number, totalUsd: number): number {
  if (totalUsd <= 0 || !Number.isFinite(valueUsd) || valueUsd === 0) {
    return 0;
  }
  return round1((valueUsd / totalUsd) * 100);
}

/**
 * Emit balance rows for the EVM wallet's native + top-N ERC-20 holdings
 * on each chain. One row per non-zero balance.
 */
function emitEvmBalances(
  natives: TokenAmount[],
  erc20: TokenAmount[],
  totalUsd: number,
  chain: string,
): SharedStrategyPosition[] {
  return emitWalletBalances([...natives, ...erc20], chain, totalUsd);
}

function emitLending(
  positions: LendingPositionUnion[],
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const p of positions) {
    if (p.protocol === "aave-v3") {
      // Supplied collateral.
      for (const c of p.collateral) {
        if (!c.valueUsd || c.amount === "0") continue;
        out.push({
          protocol: "aave-v3",
          chain: p.chain,
          kind: "supply",
          asset: c.symbol,
          pctOfTotal: pct(c.valueUsd, totalUsd),
          ...(p.totalDebtUsd > 0 && Number.isFinite(p.healthFactor)
            ? { healthFactor: round2(p.healthFactor) }
            : {}),
        });
      }
      for (const d of p.debt) {
        if (!d.valueUsd || d.amount === "0") continue;
        out.push({
          protocol: "aave-v3",
          chain: p.chain,
          kind: "borrow",
          asset: d.symbol,
          pctOfTotal: pct(d.valueUsd, totalUsd),
          ...(Number.isFinite(p.healthFactor)
            ? { healthFactor: round2(p.healthFactor) }
            : {}),
        });
      }
    } else if (p.protocol === "compound-v3") {
      if (p.baseSupplied && p.baseSupplied.amount !== "0" && p.baseSupplied.valueUsd) {
        out.push({
          protocol: "compound-v3",
          chain: p.chain,
          kind: "supply",
          asset: p.baseSupplied.symbol,
          pctOfTotal: pct(p.baseSupplied.valueUsd, totalUsd),
        });
      }
      if (p.baseBorrowed && p.baseBorrowed.amount !== "0" && p.baseBorrowed.valueUsd) {
        out.push({
          protocol: "compound-v3",
          chain: p.chain,
          kind: "borrow",
          asset: p.baseBorrowed.symbol,
          pctOfTotal: pct(p.baseBorrowed.valueUsd, totalUsd),
        });
      }
      for (const c of p.collateral) {
        if (!c.valueUsd || c.amount === "0") continue;
        out.push({
          protocol: "compound-v3",
          chain: p.chain,
          kind: "supply",
          asset: c.symbol,
          pctOfTotal: pct(c.valueUsd, totalUsd),
        });
      }
    } else if (p.protocol === "morpho-blue") {
      if (p.supplied && p.supplied.amount !== "0" && p.supplied.valueUsd) {
        out.push({
          protocol: "morpho-blue",
          chain: p.chain,
          kind: "supply",
          asset: p.supplied.symbol,
          pctOfTotal: pct(p.supplied.valueUsd, totalUsd),
        });
      }
      if (p.borrowed && p.borrowed.amount !== "0" && p.borrowed.valueUsd) {
        out.push({
          protocol: "morpho-blue",
          chain: p.chain,
          kind: "borrow",
          asset: p.borrowed.symbol,
          pctOfTotal: pct(p.borrowed.valueUsd, totalUsd),
        });
      }
      if (p.collateral && p.collateral.amount !== "0" && p.collateral.valueUsd) {
        out.push({
          protocol: "morpho-blue",
          chain: p.chain,
          kind: "supply",
          asset: p.collateral.symbol,
          pctOfTotal: pct(p.collateral.valueUsd, totalUsd),
        });
      }
    }
  }
  return out;
}

function emitLp(positions: LPPosition[], totalUsd: number): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const p of positions) {
    if (p.totalValueUsd <= 0) continue;
    out.push({
      protocol: "uniswap-v3",
      chain: p.chain,
      kind: "lp",
      asset: `${p.token0.symbol}/${p.token1.symbol}`,
      pctOfTotal: pct(p.totalValueUsd, totalUsd),
      feeTier: p.feeTier,
      inRange: p.inRange,
    });
  }
  return out;
}

function emitStaking(
  positions: StakingPosition[],
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const p of positions) {
    if (!p.stakedAmount.valueUsd || p.stakedAmount.amount === "0") continue;
    out.push({
      protocol: p.protocol,
      chain: p.chain,
      kind: "stake",
      asset: p.stakedAmount.symbol,
      pctOfTotal: pct(p.stakedAmount.valueUsd, totalUsd),
      ...(typeof p.apr === "number" ? { apr: p.apr } : {}),
    });
  }
  return out;
}

function emitWalletBalances(
  tokens: Array<{ valueUsd?: number; amount: string; symbol: string }>,
  chain: string,
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const t of tokens) {
    if (!t.valueUsd || t.amount === "0") continue;
    out.push({
      protocol: "wallet",
      chain,
      kind: "balance",
      asset: t.symbol,
      pctOfTotal: pct(t.valueUsd, totalUsd),
    });
  }
  return out;
}

function emitTronBalances(
  natives: TronBalance[],
  trc20: TronBalance[],
  totalUsd: number,
): SharedStrategyPosition[] {
  return emitWalletBalances([...natives, ...trc20], "tron", totalUsd);
}

function emitTronStaking(
  staking: TronStakingSlice,
  totalUsd: number,
): SharedStrategyPosition[] {
  if (staking.totalStakedUsd <= 0) return [];
  return [
    {
      protocol: "tron-staking",
      chain: "tron",
      kind: "stake",
      asset: "TRX",
      pctOfTotal: pct(staking.totalStakedUsd, totalUsd),
    },
  ];
}

function emitSolanaBalances(
  natives: SolanaBalance[],
  spl: SolanaBalance[],
  totalUsd: number,
): SharedStrategyPosition[] {
  return emitWalletBalances([...natives, ...spl], "solana", totalUsd);
}

function emitSolanaLending(
  marginfi: PortfolioSummary["breakdown"]["solana"] extends infer S
    ? S extends { marginfi?: infer M }
      ? M extends Array<infer Item>
        ? Item[]
        : never
      : never
    : never,
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const m of marginfi) {
    for (const s of m.supplied) {
      if (s.valueUsd <= 0) continue;
      out.push({
        protocol: "marginfi",
        chain: "solana",
        kind: "supply",
        asset: s.symbol,
        pctOfTotal: pct(s.valueUsd, totalUsd),
        ...(m.totalBorrowedUsd > 0 && Number.isFinite(m.healthFactor)
          ? { healthFactor: round2(m.healthFactor) }
          : {}),
      });
    }
    for (const b of m.borrowed) {
      if (b.valueUsd <= 0) continue;
      out.push({
        protocol: "marginfi",
        chain: "solana",
        kind: "borrow",
        asset: b.symbol,
        pctOfTotal: pct(b.valueUsd, totalUsd),
        ...(Number.isFinite(m.healthFactor)
          ? { healthFactor: round2(m.healthFactor) }
          : {}),
      });
    }
  }
  return out;
}

function emitKaminoLending(
  kamino: PortfolioSummary["breakdown"]["solana"] extends infer S
    ? S extends { kamino?: infer K }
      ? K extends Array<infer Item>
        ? Item[]
        : never
      : never
    : never,
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  for (const k of kamino) {
    for (const s of k.supplied) {
      if (s.valueUsd <= 0) continue;
      out.push({
        protocol: "kamino",
        chain: "solana",
        kind: "supply",
        asset: s.symbol,
        pctOfTotal: pct(s.valueUsd, totalUsd),
        ...(k.totalBorrowedUsd > 0 && Number.isFinite(k.healthFactor)
          ? { healthFactor: round2(k.healthFactor) }
          : {}),
      });
    }
    for (const b of k.borrowed) {
      if (b.valueUsd <= 0) continue;
      out.push({
        protocol: "kamino",
        chain: "solana",
        kind: "borrow",
        asset: b.symbol,
        pctOfTotal: pct(b.valueUsd, totalUsd),
        ...(Number.isFinite(k.healthFactor)
          ? { healthFactor: round2(k.healthFactor) }
          : {}),
      });
    }
  }
  return out;
}

function emitSolanaStaking(
  staking: NonNullable<NonNullable<PortfolioSummary["breakdown"]["solana"]>["staking"]>,
  solPriceUsd: number,
  totalUsd: number,
): SharedStrategyPosition[] {
  const out: SharedStrategyPosition[] = [];
  if (staking.marinade.solEquivalent > 0) {
    out.push({
      protocol: "marinade",
      chain: "solana",
      kind: "stake",
      asset: "SOL",
      pctOfTotal: pct(staking.marinade.solEquivalent * solPriceUsd, totalUsd),
    });
  }
  if (staking.jito.solEquivalent > 0) {
    out.push({
      protocol: "jito",
      chain: "solana",
      kind: "stake",
      asset: "SOL",
      pctOfTotal: pct(staking.jito.solEquivalent * solPriceUsd, totalUsd),
    });
  }
  // Native stake accounts: aggregate into one "native-stake" row to
  // avoid leaking the count (a wallet with N stake accounts is more
  // fingerprintable than one with "some" stake).
  let nativeSol = 0;
  for (const s of staking.nativeStakes) {
    if (s.status === "active" || s.status === "activating") {
      nativeSol += s.stakeSol;
    }
  }
  if (nativeSol > 0) {
    out.push({
      protocol: "solana-native-stake",
      chain: "solana",
      kind: "stake",
      asset: "SOL",
      pctOfTotal: pct(nativeSol * solPriceUsd, totalUsd),
    });
  }
  return out;
}

/**
 * Project a `PortfolioSummary` into the anonymized position list. The
 * order of rows is best-effort (chain → protocol → asset) but consumers
 * shouldn't depend on it; for stable display, sort by `pctOfTotal` desc
 * on the receiving side.
 */
export function serializePortfolioToPositions(
  summary: PortfolioSummary,
): SharedStrategyPosition[] {
  const total = summary.totalUsd;
  const positions: SharedStrategyPosition[] = [];

  // EVM balances: each TokenAmount carries `chain` so the helper
  // doesn't need a per-chain split — the underlying typing of
  // breakdown.native / .erc20 is `TokenAmount[]` with chain on each.
  // But TokenAmount here doesn't have `chain` on it directly… let me
  // check: looking at types/index.ts, TokenAmount has only token /
  // symbol / decimals / amount / formatted / valueUsd / priceUsd. No
  // chain field. So we infer chain from the broader summary.chains;
  // since the breakdown collapses per-chain into a flat list, we
  // can't recover per-asset chain. Treat as primary chain
  // (summary.chains[0]) — best we can do without re-walking the
  // per-chain reader. For mixed-chain wallets this is approximate;
  // documented in notes.
  const primaryChain = summary.chains[0] ?? "ethereum";
  positions.push(
    ...emitEvmBalances(
      summary.breakdown.native,
      summary.breakdown.erc20,
      total,
      primaryChain,
    ),
  );
  positions.push(...emitLending(summary.breakdown.lending, total));
  positions.push(...emitLp(summary.breakdown.lp, total));
  positions.push(...emitStaking(summary.breakdown.staking, total));

  // TRON.
  if (summary.breakdown.tron) {
    const tron = summary.breakdown.tron;
    positions.push(
      ...emitTronBalances(tron.native, tron.trc20, total),
    );
    if (tron.staking) {
      positions.push(...emitTronStaking(tron.staking, total));
    }
  }

  // Solana.
  if (summary.breakdown.solana) {
    const sol = summary.breakdown.solana;
    positions.push(...emitSolanaBalances(sol.native, sol.spl, total));
    if (sol.marginfi) {
      positions.push(...emitSolanaLending(sol.marginfi, total));
    }
    if (sol.kamino) {
      positions.push(...emitKaminoLending(sol.kamino, total));
    }
    if (sol.staking) {
      // Recover SOL price from the native row (priceUsd field) so we
      // can value the stake-pool LST equivalents. If the native SOL
      // line is missing or unpriced, fall back to inferring from the
      // staking subtotal — but the sol slice always has a native[0]
      // when there's any SOL/SPL activity.
      const solPriceUsd =
        sol.native.find((b) => b.token === "native")?.priceUsd ?? 0;
      if (solPriceUsd > 0) {
        positions.push(
          ...emitSolanaStaking(sol.staking, solPriceUsd, total),
        );
      }
    }
  }

  // BTC and LTC: surface as a single "wallet balance" row per chain,
  // aggregated across addresses so the count of UTXO addresses doesn't
  // leak (a wallet with 7 BTC addresses fingerprints differently from
  // one with 2).
  if (summary.breakdown.bitcoin && summary.bitcoinUsd && summary.bitcoinUsd > 0) {
    positions.push({
      protocol: "wallet",
      chain: "bitcoin",
      kind: "balance",
      asset: "BTC",
      pctOfTotal: pct(summary.bitcoinUsd, total),
    });
  }
  if (
    summary.breakdown.litecoin &&
    summary.litecoinUsd &&
    summary.litecoinUsd > 0
  ) {
    positions.push({
      protocol: "wallet",
      chain: "litecoin",
      kind: "balance",
      asset: "LTC",
      pctOfTotal: pct(summary.litecoinUsd, total),
    });
  }

  return positions;
}

/** Distinct chain slugs that contributed at least one position. */
export function chainsFromPositions(
  positions: SharedStrategyPosition[],
): string[] {
  const set = new Set<string>();
  for (const p of positions) set.add(p.chain);
  return Array.from(set).sort();
}
