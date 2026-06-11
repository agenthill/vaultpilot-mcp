import type { Connection } from "@solana/web3.js";
import { assertSolanaAddress } from "../solana/address.js";
import { loadKaminoMainMarket } from "../solana/kamino.js";

/**
 * Read-only Kamino position reader. Parallels `getMarginfiPositions` —
 * enumerates one wallet's Kamino obligation, surfaces deposits + borrows
 * with USD valuations, and derives a health factor.
 *
 * Health factor convention: matches Aave / MarginFi —
 * `borrowLiquidationLimit / userTotalBorrowBorrowFactorAdjusted`. >1 safe,
 * <1 liquidatable, Infinity when no debt. The Kamino SDK exposes
 * `loanToValue` (current usage as fraction of liquidation limit) which is
 * the inverse — we publish 1/loanToValue to keep the user-facing
 * convention consistent across the lending bucket.
 */

export interface KaminoBalanceEntry {
  /** Reserve PDA. */
  reserve: string;
  /** SPL mint of the reserve's liquidity asset. */
  mint: string;
  /** Token symbol from the reserve metadata; empty string when missing. */
  symbol: string;
  /** Human-readable decimal balance (already-decimals-applied). */
  amount: string;
  /** Refreshed market value in USD. */
  valueUsd: number;
}

export interface KaminoPosition {
  protocol: "kamino";
  chain: "solana";
  wallet: string;
  /** Base58 obligation PDA — empty string when wallet has none on Kamino. */
  obligation: string;
  /** Per-reserve deposits with USD values. */
  supplied: KaminoBalanceEntry[];
  /** Per-reserve outstanding borrows with USD values. */
  borrowed: KaminoBalanceEntry[];
  totalSuppliedUsd: number;
  totalBorrowedUsd: number;
  /** Net = supplied − borrowed. */
  netValueUsd: number;
  /**
   * `borrowLiquidationLimit / userTotalBorrowBorrowFactorAdjusted`.
   * Infinity when no debt; matches Aave / MarginFi convention.
   */
  healthFactor: number;
  /** Optional reserve-level pause / freeze flags — empty array when all healthy. */
  warnings: string[];
}

/**
 * Project the SDK's `Position` (per-reserve entry on the obligation) into
 * our thin `KaminoBalanceEntry`. Decimal values are converted via
 * `Decimal.toNumber()`; for obligations with extreme amounts that's lossy
 * but acceptable for portfolio display (USD valuation already lost
 * precision earlier in the price stack).
 */
function projectPosition(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  pos: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reserve: any,
): KaminoBalanceEntry {
  // SDK's `Position.amount` is in lamports/base units; divide by mintFactor
  // (= 10^decimals) to get the human amount.
  const decimals = Number(reserve.state.liquidity.mintDecimals);
  const factor = 10 ** decimals;
  const humanAmount = Number(pos.amount.toString()) / factor;
  return {
    reserve: pos.reserveAddress.toString(),
    mint: pos.mintAddress.toString(),
    symbol: reserve.getTokenSymbol() ?? "",
    amount: humanAmount.toString(),
    valueUsd: Number(pos.marketValueRefreshed.toString()),
  };
}

/**
 * Read a single wallet's Kamino position on the main market. Returns an
 * empty position (zero balances, no obligation) when the wallet has no
 * userMetadata or obligation — never throws on the empty path. Rethrows
 * any RPC / SDK error so the portfolio caller can mark coverage errored.
 */
export async function getKaminoPositions(
  _conn: Connection,
  wallet: string,
): Promise<KaminoPosition[]> {
  // The connection is unused; Kamino SDK uses its own kit-style RPC. We
  // keep the conn parameter for signature parity with getMarginfiPositions
  // (the portfolio aggregator passes it the same way).
  void _conn;

  assertSolanaAddress(wallet);

  const market = await loadKaminoMainMarket();
  if (!market) {
    throw new Error("Kamino main market not found on-chain.");
  }

  const { address: toAddress } = await import("@solana/kit");
  const { KaminoObligation, VanillaObligation } = await import(
    "@kamino-finance/klend-sdk"
  );

  const ownerAddr = toAddress(wallet);

  // No userMetadata = wallet has never used Kamino. Return empty array
  // (= "no positions"), same convention as MarginFi for fresh wallets.
  const [, userMetadataState] = await market.getUserMetadata(ownerAddr);
  if (userMetadataState === null) {
    return [];
  }

  const obligationKind = new VanillaObligation(market.programId);
  const obligationPda = await obligationKind.toPda(market.getAddress(), ownerAddr);
  const obligationState = await KaminoObligation.load(market, obligationPda);
  if (!obligationState) {
    // userMetadata exists but obligation doesn't — partial-init state. No
    // position to surface; return empty.
    return [];
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function collectBalances(entries: Map<any, any>): KaminoBalanceEntry[] {
    const out: KaminoBalanceEntry[] = [];
    for (const [, pos] of entries) {
      const reserve = market!.getReserveByAddress(pos.reserveAddress);
      if (!reserve) continue;
      out.push(projectPosition(pos, reserve));
    }
    return out;
  }

  const supplied = collectBalances(obligationState.deposits);
  const borrowed = collectBalances(obligationState.borrows);

  const totalSuppliedUsd = supplied.reduce((s, b) => s + b.valueUsd, 0);
  const totalBorrowedUsd = borrowed.reduce((s, b) => s + b.valueUsd, 0);

  // Health factor: borrowLiquidationLimit / userTotalBorrowBorrowFactorAdjusted.
  // Both are SDK Decimal; coerce via toNumber() for the user-facing ratio.
  const stats = obligationState.refreshedStats;
  const adjustedBorrow = Number(stats.userTotalBorrowBorrowFactorAdjusted.toString());
  const liquidationLimit = Number(stats.borrowLiquidationLimit.toString());
  const healthFactor =
    adjustedBorrow > 0 ? liquidationLimit / adjustedBorrow : Number.POSITIVE_INFINITY;

  // Reserve-level warnings: walk both deposits + borrows, surface if any
  // touched reserve is paused/frozen via Kamino's risk-config flags. The
  // SDK exposes `state.config.status` (0 = active, 1 = obsolete, 2 = hidden)
  // — anything non-zero is worth flagging to the user even if the position
  // still loads cleanly.
  const warnings: string[] = [];
  const touchedReserves = new Set<string>([
    ...supplied.map((b) => b.reserve),
    ...borrowed.map((b) => b.reserve),
  ]);
  for (const reserveAddr of touchedReserves) {
    const reserve = market.getReserveByAddress(toAddress(reserveAddr));
    if (!reserve) continue;
    const status = Number(reserve.state.config.status);
    if (status !== 0) {
      const sym = reserve.getTokenSymbol() ?? reserveAddr;
      warnings.push(
        `Reserve ${sym} (${reserveAddr}) reports non-active status (${status}) — position may be illiquid for new ops.`,
      );
    }
  }

  return [
    {
      protocol: "kamino",
      chain: "solana",
      wallet,
      obligation: obligationPda.toString(),
      supplied,
      borrowed,
      totalSuppliedUsd,
      totalBorrowedUsd,
      netValueUsd: totalSuppliedUsd - totalBorrowedUsd,
      healthFactor,
      warnings,
    },
  ];
}
