import { getClient } from "../../data/rpc.js";
import { CONTRACTS, NATIVE_SYMBOL } from "../../config/contracts.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount, priceTokenAmounts, round } from "../../data/format.js";
import { getTokenPrice } from "../../data/prices.js";
import { getLendingPositions, getLpPositions } from "../positions/index.js";
import { getStakingPositions } from "../staking/index.js";
import { getCompoundPositions, prefetchCompoundProbes } from "../compound/index.js";
import { prefetchAaveAccountData } from "../positions/aave.js";
import { prefetchLidoMainnet } from "../staking/lido.js";
import { getMorphoPositions } from "../morpho/index.js";
import { getTronBalances } from "../tron/balances.js";
import { getTronStaking } from "../tron/staking.js";
import { getSolanaBalances } from "../solana/balances.js";
import { getMarginfiPositions as readMarginfiPositions } from "../positions/marginfi.js";
import { getKaminoPositions as readKaminoPositions } from "../positions/kamino.js";
import { getSolanaStakingPositions as readSolanaStakingPositions } from "../positions/solana-staking.js";
import { getSolanaConnection } from "../solana/rpc.js";
import type { GetPortfolioSummaryArgs } from "./schemas.js";
import type {
  BitcoinPortfolioSlice,
  LendingPositionUnion,
  LitecoinPortfolioSlice,
  MultiWalletPortfolioSummary,
  PortfolioCoverage,
  PortfolioSummary,
  SolanaMarginfiPositionSlice,
  SolanaKaminoPositionSlice,
  SolanaPortfolioSlice,
  SolanaStakingPositionSlice,
  SupportedChain,
  TokenAmount,
  TronPortfolioSlice,
  TronStakingSlice,
  UnpricedAsset,
} from "../../types/index.js";
import { getBitcoinBalances } from "../btc/balances.js";
import { getLitecoinBalances } from "../litecoin/balances.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

function zeroNative(wallet: `0x${string}`, chain: SupportedChain): TokenAmount {
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    0n,
    18,
    NATIVE_SYMBOL[chain]
  );
}

export async function fetchNativeBalance(wallet: `0x${string}`, chain: SupportedChain): Promise<TokenAmount> {
  const client = getClient(chain);
  const [balance, ethPrice] = await Promise.all([
    client.getBalance({ address: wallet }),
    getTokenPrice(chain, "native"),
  ]);
  return makeTokenAmount(
    chain,
    "0x0000000000000000000000000000000000000000" as `0x${string}`,
    balance,
    18,
    NATIVE_SYMBOL[chain],
    ethPrice
  );
}

export async function fetchTopErc20Balances(
  wallet: `0x${string}`,
  chain: SupportedChain
): Promise<TokenAmount[]> {
  const tokens = CONTRACTS[chain].tokens as Record<string, string>;
  const entries = Object.entries(tokens);
  if (entries.length === 0) return [];

  const client = getClient(chain);
  const calls = entries.flatMap(([, addr]) => [
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "balanceOf" as const, args: [wallet] as const },
    { address: addr as `0x${string}`, abi: erc20Abi, functionName: "decimals" as const },
  ]);
  const results = await client.multicall({ contracts: calls, allowFailure: true });

  const out: TokenAmount[] = [];
  for (let i = 0; i < entries.length; i++) {
    const [symbol, addr] = entries[i];
    const balanceRes = results[i * 2];
    const decimalsRes = results[i * 2 + 1];
    if (balanceRes.status !== "success" || decimalsRes.status !== "success") continue;
    const balance = balanceRes.result as bigint;
    if (balance === 0n) continue;
    const decimals = Number(decimalsRes.result);
    out.push(makeTokenAmount(chain, addr as `0x${string}`, balance, decimals, symbol));
  }

  await priceTokenAmounts(chain, out);
  return out;
}

export async function getPortfolioSummary(
  args: GetPortfolioSummaryArgs
): Promise<PortfolioSummary | MultiWalletPortfolioSummary> {
  if (!args.wallet && !(args.wallets && args.wallets.length > 0)) {
    throw new Error("Provide at least one of `wallet` or `wallets`.");
  }
  const chains = ((args.chains as SupportedChain[] | undefined) ?? [...SUPPORTED_CHAINS]);
  const wallets = args.wallets?.length
    ? (args.wallets as `0x${string}`[])
    : args.wallet
    ? [args.wallet as `0x${string}`]
    : [];

  // Resolve singular/plural args. Mutually exclusive forms throw — pass
  // either the single-address or the array form, not both. Issue #201:
  // multi-wallet mode now ALSO accepts non-EVM addresses; they're
  // surfaced as parallel siblings on the response (`nonEvm` block)
  // rather than folded into a chosen EVM wallet's totals.
  if (args.tronAddress && args.tronAddresses && args.tronAddresses.length > 0) {
    throw new Error(
      "Pass `tronAddress` (single) OR `tronAddresses` (array), not both.",
    );
  }
  const tronAddresses: string[] = args.tronAddresses?.length
    ? args.tronAddresses
    : args.tronAddress
    ? [args.tronAddress]
    : [];

  if (
    args.solanaAddress &&
    args.solanaAddresses &&
    args.solanaAddresses.length > 0
  ) {
    throw new Error(
      "Pass `solanaAddress` (single) OR `solanaAddresses` (array), not both.",
    );
  }
  const solanaAddresses: string[] = args.solanaAddresses?.length
    ? args.solanaAddresses
    : args.solanaAddress
    ? [args.solanaAddress]
    : [];

  if (args.bitcoinAddress && args.bitcoinAddresses && args.bitcoinAddresses.length > 0) {
    throw new Error(
      "Pass `bitcoinAddress` (single) OR `bitcoinAddresses` (array), not both.",
    );
  }
  const bitcoinAddresses = args.bitcoinAddresses?.length
    ? args.bitcoinAddresses
    : args.bitcoinAddress
    ? [args.bitcoinAddress]
    : [];

  if (args.litecoinAddress && args.litecoinAddresses && args.litecoinAddresses.length > 0) {
    throw new Error(
      "Pass `litecoinAddress` (single) OR `litecoinAddresses` (array), not both.",
    );
  }
  const litecoinAddresses = args.litecoinAddresses?.length
    ? args.litecoinAddresses
    : args.litecoinAddress
    ? [args.litecoinAddress]
    : [];

  // Single-wallet branch: keep the existing fold-non-EVM-into-totals
  // shape (backwards compat). Multi-address TRON/Solana don't have a
  // single-slice projection in this shape; reject explicitly so the
  // caller can switch to multi-wallet mode rather than silently lose
  // entries 2..N. BTC already supports multi-address natively
  // (BitcoinPortfolioSlice carries an `addresses[]` array).
  if (wallets.length === 1) {
    if (tronAddresses.length > 1) {
      throw new Error(
        "`tronAddresses` with multiple entries can't fold into a single-`wallet` " +
          "summary (each TRON address is a separate identity). Use `wallets: [...]` " +
          "(multi-wallet mode) so the TRON addresses are surfaced as parallel siblings " +
          "in `nonEvm.tron[]`.",
      );
    }
    if (solanaAddresses.length > 1) {
      throw new Error(
        "`solanaAddresses` with multiple entries can't fold into a single-`wallet` " +
          "summary (each Solana address is a separate identity). Use `wallets: [...]` " +
          "(multi-wallet mode) so the Solana addresses are surfaced as parallel siblings " +
          "in `nonEvm.solana[]`.",
      );
    }
    return buildWalletSummary(
      wallets[0],
      chains,
      tronAddresses[0],
      solanaAddresses[0],
      bitcoinAddresses,
      litecoinAddresses,
    );
  }

  // Cross-wallet prefetches run FIRST and populate per-wallet caches.
  // The per-wallet buildWalletSummary fan-out then hits the cache for
  // the most rate-limit-sensitive subsystems, keeping the wallet fan-
  // out's peak RPC pressure flat regardless of wallet count.
  //
  // Without these prefetches, a 4-wallet call fires ~20 parallel
  // Compound probes + 20 Aave aggregate reads + 4 Lido mainnet
  // multicalls + ... = dozens of simultaneous multicalls saturating
  // free-tier Infura even at cap=2 per chain. With them, each
  // subsystem collapses to ONE multicall per chain regardless of
  // wallet count — the downstream per-wallet calls hit cache.
  //
  // Run in parallel across subsystems (each batches by chain
  // internally); one slow subsystem doesn't serialize the others.
  // Non-EVM aggregation (issue #201) runs in parallel with the EVM
  // path — TRON / Solana / BTC are independent identities and don't
  // contend for the same RPC.
  const [evmPrefetchDone, nonEvm] = await Promise.all([
    Promise.all([
      prefetchCompoundProbes(wallets, chains),
      prefetchAaveAccountData(wallets, chains),
      // Lido mainnet is the most rate-limit-sensitive staking read;
      // arbitrum wstETH is low volume and stays per-wallet.
      chains.includes("ethereum") ? prefetchLidoMainnet(wallets) : Promise.resolve(),
    ]),
    aggregateNonEvm({
      tronAddresses,
      solanaAddresses,
      bitcoinAddresses,
      litecoinAddresses,
    }),
  ]);
  void evmPrefetchDone;
  const perWallet = await Promise.all(wallets.map((w) => buildWalletSummary(w, chains)));
  const evmTotal = round(perWallet.reduce((s, p) => s + p.totalUsd, 0), 2);
  const walletBalancesUsd = round(perWallet.reduce((s, p) => s + p.walletBalancesUsd, 0), 2);
  const lendingNetUsd = round(perWallet.reduce((s, p) => s + p.lendingNetUsd, 0), 2);
  const lpUsd = round(perWallet.reduce((s, p) => s + p.lpUsd, 0), 2);
  const stakingUsd = round(perWallet.reduce((s, p) => s + p.stakingUsd, 0), 2);
  // Non-EVM contribution to totalUsd. Each chain's USD already aggregates
  // wallet balances + (where applicable) staking + lending; sum them all
  // for the top-line totalUsd. NOTE: this does NOT roll into
  // `walletBalancesUsd` because that field documents EVM-only-ish
  // semantics across the codebase; non-EVM gets its own per-chain USD
  // fields below for clarity.
  const nonEvmContribution = round(
    (nonEvm.tronUsd ?? 0) +
      (nonEvm.tronStakingUsd ?? 0) +
      (nonEvm.solanaUsd ?? 0) +
      (nonEvm.solanaLendingUsd ?? 0) +
      (nonEvm.solanaStakingUsd ?? 0) +
      (nonEvm.bitcoinUsd ?? 0) +
      (nonEvm.litecoinUsd ?? 0),
    2,
  );
  const totalUsd = round(evmTotal + nonEvmContribution, 2);
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;
  for (const p of perWallet) {
    for (const c of chains) {
      perChain[c] = round((perChain[c] ?? 0) + (p.perChain[c] ?? 0), 2);
    }
  }
  // Aggregate coverage: a subsystem is considered errored across the group if
  // ANY wallet's fetch failed — because the group-level total will be short
  // that wallet's contribution. Notes get merged to the worst (errored) state.
  const aggregatedUnpricedDetail = perWallet.flatMap(
    (p) => p.coverage.unpricedAssetsDetail ?? [],
  );
  const mergedCoverage: PortfolioCoverage = {
    aave: mergeCoverage(perWallet.map((p) => p.coverage.aave)),
    compound: mergeCoverage(perWallet.map((p) => p.coverage.compound)),
    morpho: mergeCoverage(perWallet.map((p) => p.coverage.morpho)),
    uniswapV3: mergeCoverage(perWallet.map((p) => p.coverage.uniswapV3)),
    staking: mergeCoverage(perWallet.map((p) => p.coverage.staking)),
    unpricedAssets:
      perWallet.reduce((s, p) => s + p.coverage.unpricedAssets, 0) +
      (nonEvm.unpricedAssetsDetail?.length ?? 0),
    ...(aggregatedUnpricedDetail.length > 0 || (nonEvm.unpricedAssetsDetail?.length ?? 0) > 0
      ? {
          unpricedAssetsDetail: [
            ...aggregatedUnpricedDetail,
            ...(nonEvm.unpricedAssetsDetail ?? []),
          ],
        }
      : {}),
    ...(nonEvm.coverage ?? {}),
  };

  // Build the nonEvm block ONLY if at least one non-EVM source was
  // queried. Avoids polluting the response with empty objects when the
  // caller stays EVM-only.
  const nonEvmBlock =
    nonEvm.tron || nonEvm.solana || nonEvm.bitcoin
      ? {
          ...(nonEvm.tron ? { tron: nonEvm.tron } : {}),
          ...(nonEvm.solana ? { solana: nonEvm.solana } : {}),
          ...(nonEvm.bitcoin ? { bitcoin: nonEvm.bitcoin } : {}),
        }
      : undefined;

  return {
    wallets,
    chains,
    totalUsd,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    perChain,
    perWallet,
    ...(nonEvmBlock ? { nonEvm: nonEvmBlock } : {}),
    ...(nonEvm.tronUsd !== undefined ? { tronUsd: nonEvm.tronUsd } : {}),
    ...(nonEvm.tronStakingUsd !== undefined
      ? { tronStakingUsd: nonEvm.tronStakingUsd }
      : {}),
    ...(nonEvm.solanaUsd !== undefined ? { solanaUsd: nonEvm.solanaUsd } : {}),
    ...(nonEvm.solanaLendingUsd !== undefined
      ? { solanaLendingUsd: nonEvm.solanaLendingUsd }
      : {}),
    ...(nonEvm.solanaStakingUsd !== undefined
      ? { solanaStakingUsd: nonEvm.solanaStakingUsd }
      : {}),
    ...(nonEvm.bitcoinUsd !== undefined ? { bitcoinUsd: nonEvm.bitcoinUsd } : {}),
    ...(nonEvm.litecoinUsd !== undefined ? { litecoinUsd: nonEvm.litecoinUsd } : {}),
    coverage: mergedCoverage,
  };
}

/** Truncate an error message to at most 120 chars for note readability. */
function truncateError(error: string): string {
  const MAX_ERR = 120;
  return error.length > MAX_ERR ? `${error.slice(0, MAX_ERR)}…` : error;
}

/**
 * Build the human-readable `coverage.compound.note` when one or more markets
 * failed to read. Includes per-chain + per-market + raw error message so the
 * agent can tell the user which specific market is broken instead of the
 * generic "fetch failed on at least one market" string (issue #88). When no
 * structured detail is available (empty array), falls back to the old
 * generic message so callers still get a non-empty note.
 *
 * Error messages are truncated to keep the note readable — the full detail
 * is available via `get_compound_positions` directly, which returns the
 * same `erroredMarkets` array on its response.
 *
 * Exported for unit testing; the getPortfolioSummary path is the real caller.
 */
export function formatCompoundErrorNote(
  erroredMarkets?: { chain: SupportedChain; market: string; error: string }[],
): string {
  const generic =
    "Compound V3 fetch failed on at least one market — some positions may be missing from totals.";
  if (!erroredMarkets || erroredMarkets.length === 0) return generic;
  const lines = erroredMarkets.map(({ chain, market, error }) => `${chain}/${market}: ${truncateError(error)}`);
  return `${generic} Failures: ${lines.join("; ")}. Call get_compound_positions for the full per-market read.`;
}

/**
 * Build the human-readable `coverage.morpho.note` when one or more per-chain
 * event-log discoveries failed. Mirrors `formatCompoundErrorNote` structurally
 * — same reasoning: the generic "event-log discovery failed on at least one
 * chain" string left the agent with no way to tell the user WHICH chain's
 * scan was broken (issue #92).
 *
 * Exported for unit testing; getPortfolioSummary is the real caller.
 */
export function formatMorphoErrorNote(
  erroredChains?: { chain: SupportedChain; error: string }[],
): string {
  const generic =
    "Morpho Blue event-log discovery failed on at least one chain — some positions may be missing from totals.";
  if (!erroredChains || erroredChains.length === 0) return generic;
  const lines = erroredChains.map(({ chain, error }) => `${chain}: ${truncateError(error)}`);
  return `${generic} Failures: ${lines.join("; ")}. Call get_morpho_positions with an explicit chain for a fast-path read.`;
}

/**
 * Build the human-readable `coverage.staking.note` when Lido or EigenLayer
 * failed. The previous generic "Staking (Lido/EigenLayer) fetch failed"
 * string couldn't distinguish between a flaky Lido read, a flaky EigenLayer
 * read, or both — and because the prior code used `Promise.all` internally,
 * a single-source failure zeroed both. `getStakingPositions` now returns
 * per-source detail so the note can name the failing source(s) while the
 * healthy source's positions still flow through (issue #93).
 *
 * Exported for unit testing.
 */
export function formatStakingErrorNote(
  erroredSources?: { source: "lido" | "eigenlayer"; error: string }[],
): string {
  const generic =
    "Staking fetch failed — some positions may be missing from totals.";
  if (!erroredSources || erroredSources.length === 0) {
    // Fall back to the old wording if no structured detail is available —
    // keeps callers that hit the empty-array branch honest about what broke.
    return "Staking (Lido/EigenLayer) fetch failed — positions not included.";
  }
  const lines = erroredSources.map(({ source, error }) => `${source}: ${truncateError(error)}`);
  return `${generic} Failures: ${lines.join("; ")}. The other staking source(s) still loaded where applicable.`;
}

function mergeCoverage(entries: { covered: boolean; errored?: boolean; note?: string }[]) {
  const anyErrored = entries.some((e) => e.errored);
  const allCovered = entries.every((e) => e.covered);
  const noteEntry = entries.find((e) => e.note);
  return {
    covered: allCovered && !anyErrored,
    ...(anyErrored ? { errored: true } : {}),
    ...(noteEntry?.note ? { note: noteEntry.note } : {}),
  };
}

/**
 * Fetch BTC balances for `addresses` and project into the slice the
 * portfolio aggregator folds into `breakdown.bitcoin` + `bitcoinUsd`.
 * Errors per-address are surfaced as `priceMissing: true`-equivalent
 * dropped entries — the slice's `walletBalancesUsd` only sums entries
 * that priced cleanly. Returns null when the indexer call itself
 * fails for every address (caller flips coverage.bitcoin.errored).
 */
async function fetchBitcoinSlice(
  addresses: string[],
): Promise<{ slice: BitcoinPortfolioSlice; unpriced: UnpricedAsset[] } | null> {
  // getBitcoinBalances returns per-address ok/err entries; `null` is reserved
  // for catastrophic failure (every address errored). Each balance now
  // carries its own priceUsd / valueUsd from the reader (issue #274 —
  // the reader handles the DefiLlama lookup centrally), so we don't
  // double-fetch the price here.
  let results: Awaited<ReturnType<typeof getBitcoinBalances>>;
  try {
    results = await getBitcoinBalances(addresses);
  } catch {
    return null;
  }
  const okBalances = results.filter((r) => r.ok);
  if (okBalances.length === 0) return null;
  const unpriced: UnpricedAsset[] = [];
  let walletBalancesUsd = 0;
  const balances = results.map((r) => {
    if (!r.ok) {
      // Fail-soft: surface the failed address with zero balance + priceMissing
      // so the caller still sees which address failed in `breakdown.bitcoin`
      // without zero-padding the whole response.
      return {
        address: r.address,
        addressType: "p2wpkh" as const,
        confirmedSats: "0",
        mempoolSats: "0",
        totalSats: "0",
        confirmedBtc: "0",
        totalBtc: "0",
        symbol: "BTC" as const,
        decimals: 8 as const,
        txCount: 0,
        priceMissing: true,
      };
    }
    const b = r.balance;
    if (b.valueUsd !== undefined && b.confirmedSats > 0n) {
      walletBalancesUsd += b.valueUsd;
    } else if (b.priceMissing && b.confirmedSats > 0n) {
      unpriced.push({
        chain: "bitcoin",
        symbol: "BTC",
        amount: b.confirmedBtc,
      });
    }
    return {
      address: b.address,
      addressType: b.addressType,
      confirmedSats: b.confirmedSats.toString(),
      mempoolSats: b.mempoolSats.toString(),
      totalSats: b.totalSats.toString(),
      confirmedBtc: b.confirmedBtc,
      totalBtc: b.totalBtc,
      symbol: b.symbol,
      decimals: b.decimals,
      txCount: b.txCount,
      ...(b.valueUsd !== undefined ? { valueUsd: round(b.valueUsd, 2) } : {}),
      ...(b.priceMissing ? { priceMissing: true } : {}),
    };
  });
  return {
    slice: {
      addresses,
      balances,
      walletBalancesUsd: round(walletBalancesUsd, 2),
    },
    unpriced,
  };
}

/**
 * Mirror of fetchBitcoinSlice for Litecoin (issue #274). Same fan-out
 * + per-address fail-soft + price-via-fetchLitecoinPrice posture; only
 * the symbol/precision/slice-type differ.
 */
async function fetchLitecoinSlice(
  addresses: string[],
): Promise<{ slice: LitecoinPortfolioSlice; unpriced: UnpricedAsset[] } | null> {
  // Same DRY pattern as fetchBitcoinSlice — the reader supplies
  // priceUsd / valueUsd per balance (issue #274), no double-fetch.
  let results: Awaited<ReturnType<typeof getLitecoinBalances>>;
  try {
    results = await getLitecoinBalances(addresses);
  } catch {
    return null;
  }
  const okBalances = results.filter((r) => r.ok);
  if (okBalances.length === 0) return null;
  const unpriced: UnpricedAsset[] = [];
  let walletBalancesUsd = 0;
  const balances = results.map((r) => {
    if (!r.ok) {
      return {
        address: r.address,
        addressType: "p2wpkh" as const,
        confirmedSats: "0",
        mempoolSats: "0",
        totalSats: "0",
        confirmedLtc: "0",
        totalLtc: "0",
        symbol: "LTC" as const,
        decimals: 8 as const,
        txCount: 0,
        priceMissing: true,
      };
    }
    const b = r.balance;
    if (b.valueUsd !== undefined && b.confirmedSats > 0n) {
      walletBalancesUsd += b.valueUsd;
    } else if (b.priceMissing && b.confirmedSats > 0n) {
      unpriced.push({
        chain: "litecoin",
        symbol: "LTC",
        amount: b.confirmedLtc,
      });
    }
    return {
      address: b.address,
      addressType: b.addressType,
      confirmedSats: b.confirmedSats.toString(),
      mempoolSats: b.mempoolSats.toString(),
      totalSats: b.totalSats.toString(),
      confirmedLtc: b.confirmedLtc,
      totalLtc: b.totalLtc,
      symbol: b.symbol,
      decimals: b.decimals,
      txCount: b.txCount,
      ...(b.valueUsd !== undefined ? { valueUsd: round(b.valueUsd, 2) } : {}),
      ...(b.priceMissing ? { priceMissing: true } : {}),
    };
  });
  return {
    slice: {
      addresses,
      balances,
      walletBalancesUsd: round(walletBalancesUsd, 2),
    },
    unpriced,
  };
}

/**
 * Multi-wallet non-EVM aggregation. Issue #201 — when the caller
 * passes `wallets[]` together with TRON / Solana / BTC addresses, the
 * non-EVM holdings are independent identities and shouldn't fold into
 * any specific EVM wallet's totals. This helper builds the parallel
 * `nonEvm` block surfaced at the top of `MultiWalletPortfolioSummary`.
 *
 * Each chain's per-address fetches run in parallel (subreaders run
 * sequentially within an address but parallel across addresses) so a
 * 4-wallet + 2-TRON + 2-Solana + 3-BTC call collapses to roughly the
 * latency of the slowest single subreader on the slowest single
 * address, not the sum.
 *
 * Per-address failures degrade gracefully: a flaky TronGrid call on
 * address A doesn't drop address B from the response. Errored
 * subsystems flip the relevant `coverage.{tron,solana,bitcoin}` flag.
 *
 * Returns the slices + USD rollups + coverage bits ready to merge
 * into the multi-wallet response. The function is private — callers
 * should go through `getPortfolioSummary`.
 */
async function aggregateNonEvm(args: {
  tronAddresses: string[];
  solanaAddresses: string[];
  bitcoinAddresses: string[];
  litecoinAddresses: string[];
}): Promise<{
  tron?: TronPortfolioSlice[];
  solana?: SolanaPortfolioSlice[];
  bitcoin?: BitcoinPortfolioSlice;
  litecoin?: LitecoinPortfolioSlice;
  tronUsd?: number;
  tronStakingUsd?: number;
  solanaUsd?: number;
  solanaLendingUsd?: number;
  solanaStakingUsd?: number;
  bitcoinUsd?: number;
  litecoinUsd?: number;
  coverage?: Pick<
    PortfolioCoverage,
    "tron" | "tronStaking" | "solana" | "marginfi" | "kamino" | "solanaStaking" | "bitcoin" | "litecoin"
  >;
  unpricedAssetsDetail?: UnpricedAsset[];
}> {
  // Fan out all chain groups in parallel — they don't share network
  // paths so latency stacks pessimistically only inside a single chain
  // group.
  const [tronResult, solanaResult, bitcoinResult, litecoinResult] = await Promise.all([
    aggregateTron(args.tronAddresses),
    aggregateSolana(args.solanaAddresses),
    args.bitcoinAddresses.length > 0
      ? fetchBitcoinSlice(args.bitcoinAddresses)
      : Promise.resolve(null),
    args.litecoinAddresses.length > 0
      ? fetchLitecoinSlice(args.litecoinAddresses)
      : Promise.resolve(null),
  ]);

  const out: Awaited<ReturnType<typeof aggregateNonEvm>> = {};
  const coverage: NonNullable<
    Awaited<ReturnType<typeof aggregateNonEvm>>["coverage"]
  > = {};
  const unpricedAssetsDetail: UnpricedAsset[] = [];

  if (args.tronAddresses.length > 0) {
    if (tronResult.slices.length > 0) {
      out.tron = tronResult.slices;
      out.tronUsd = round(
        tronResult.slices.reduce((s, x) => s + x.walletBalancesUsd, 0),
        2,
      );
      const stakingUsd = tronResult.slices.reduce(
        (s, x) => s + (x.staking?.totalStakedUsd ?? 0),
        0,
      );
      if (stakingUsd > 0) out.tronStakingUsd = round(stakingUsd, 2);
    }
    coverage.tron = tronResult.balanceErrored
      ? {
          covered: false,
          errored: true,
          note:
            "One or more TRON balance fetches failed (TronGrid). Affected addresses dropped from totals.",
        }
      : { covered: true };
    coverage.tronStaking = tronResult.stakingErrored
      ? {
          covered: false,
          errored: true,
          note:
            "One or more TRON staking fetches failed (TronGrid getReward/accounts). Affected entries dropped from totals.",
        }
      : { covered: true };
    unpricedAssetsDetail.push(...tronResult.unpriced);
  }

  if (args.solanaAddresses.length > 0) {
    if (solanaResult.slices.length > 0) {
      out.solana = solanaResult.slices;
      out.solanaUsd = round(
        solanaResult.slices.reduce((s, x) => s + x.walletBalancesUsd, 0),
        2,
      );
      if (solanaResult.lendingUsd > 0)
        out.solanaLendingUsd = round(solanaResult.lendingUsd, 2);
      if (solanaResult.stakingUsd > 0)
        out.solanaStakingUsd = round(solanaResult.stakingUsd, 2);
    }
    coverage.solana = solanaResult.balanceErrored
      ? {
          covered: false,
          errored: true,
          note:
            "One or more Solana balance fetches failed. Check SOLANA_RPC_URL / solanaRpcUrl.",
        }
      : { covered: true };
    coverage.marginfi = solanaResult.marginfiErrored
      ? {
          covered: false,
          errored: true,
          note: "MarginFi position fetch failed for at least one Solana address.",
        }
      : { covered: true };
    coverage.kamino = solanaResult.kaminoErrored
      ? {
          covered: false,
          errored: true,
          note: "Kamino position fetch failed for at least one Solana address.",
        }
      : { covered: true };
    coverage.solanaStaking = solanaResult.stakingErrored
      ? {
          covered: false,
          errored: true,
          note:
            "Solana staking fetch failed for at least one address (Marinade / Jito / native stake-account read).",
        }
      : { covered: true };
    unpricedAssetsDetail.push(...solanaResult.unpriced);
  }

  if (args.bitcoinAddresses.length > 0) {
    if (bitcoinResult) {
      out.bitcoin = bitcoinResult.slice;
      out.bitcoinUsd = bitcoinResult.slice.walletBalancesUsd;
      unpricedAssetsDetail.push(...bitcoinResult.unpriced);
      coverage.bitcoin = { covered: true };
    } else {
      coverage.bitcoin = {
        covered: false,
        errored: true,
        note:
          "Bitcoin indexer fetch failed — BTC balances not included in totals. " +
          "Check `BITCOIN_INDEXER_URL` env var or `bitcoinIndexerUrl` user config.",
      };
    }
  }

  if (args.litecoinAddresses.length > 0) {
    if (litecoinResult) {
      out.litecoin = litecoinResult.slice;
      out.litecoinUsd = litecoinResult.slice.walletBalancesUsd;
      unpricedAssetsDetail.push(...litecoinResult.unpriced);
      coverage.litecoin = { covered: true };
    } else {
      coverage.litecoin = {
        covered: false,
        errored: true,
        note:
          "Litecoin indexer fetch failed — LTC balances not included in totals. " +
          "Check `LITECOIN_INDEXER_URL` env var or `litecoinIndexerUrl` user config.",
      };
    }
  }

  if (Object.keys(coverage).length > 0) out.coverage = coverage;
  if (unpricedAssetsDetail.length > 0) out.unpricedAssetsDetail = unpricedAssetsDetail;
  return out;
}

/**
 * Fan out `getTronBalances` + `getTronStaking` for every TRON address.
 * Each address gets a TronPortfolioSlice that bundles wallet balances
 * with staking (if the staking call succeeded), keeping the per-
 * address shape interchangeable with the single-wallet response.
 */
async function aggregateTron(addresses: string[]): Promise<{
  slices: TronPortfolioSlice[];
  balanceErrored: boolean;
  stakingErrored: boolean;
  unpriced: UnpricedAsset[];
}> {
  if (addresses.length === 0) {
    return { slices: [], balanceErrored: false, stakingErrored: false, unpriced: [] };
  }
  const settled = await Promise.all(
    addresses.map(async (addr) => {
      const [balanceR, stakingR] = await Promise.allSettled([
        getTronBalances(addr),
        getTronStaking(addr),
      ]);
      const balanceOk = balanceR.status === "fulfilled" ? balanceR.value : null;
      const stakingOk = stakingR.status === "fulfilled" ? stakingR.value : null;
      return {
        addr,
        balance: balanceOk,
        staking: stakingOk,
        balanceErrored: balanceR.status === "rejected",
        stakingErrored: stakingR.status === "rejected",
      };
    }),
  );
  const slices: TronPortfolioSlice[] = [];
  const unpriced: UnpricedAsset[] = [];
  let balanceErrored = false;
  let stakingErrored = false;
  for (const r of settled) {
    if (r.balanceErrored) balanceErrored = true;
    if (r.stakingErrored) stakingErrored = true;
    if (r.balance) {
      slices.push({
        ...r.balance,
        ...(r.staking ? { staking: r.staking } : {}),
      });
      // Pull priceMissing entries into the multi-wallet unpriced list.
      for (const t of [...r.balance.native, ...r.balance.trc20]) {
        if (t.priceMissing) {
          unpriced.push({
            chain: "tron" as const,
            symbol: t.symbol,
            amount: t.formatted,
          });
        }
      }
    }
  }
  return { slices, balanceErrored, stakingErrored, unpriced };
}

/**
 * Fan out `getSolanaBalances` + MarginFi + Kamino + Solana-staking
 * subreaders for every Solana address. Returns one
 * SolanaPortfolioSlice per address (extended with marginfi/kamino/
 * staking projections, same shape `buildWalletSummary` produces in
 * the single-wallet branch) plus rolled-up USD totals across all
 * addresses for the response's top-level `solanaLendingUsd` /
 * `solanaStakingUsd`.
 */
async function aggregateSolana(addresses: string[]): Promise<{
  slices: SolanaPortfolioSlice[];
  lendingUsd: number;
  stakingUsd: number;
  balanceErrored: boolean;
  marginfiErrored: boolean;
  kaminoErrored: boolean;
  stakingErrored: boolean;
  unpriced: UnpricedAsset[];
}> {
  if (addresses.length === 0) {
    return {
      slices: [],
      lendingUsd: 0,
      stakingUsd: 0,
      balanceErrored: false,
      marginfiErrored: false,
      kaminoErrored: false,
      stakingErrored: false,
      unpriced: [],
    };
  }
  const conn = getSolanaConnection();
  const perAddress = await Promise.all(
    addresses.map(async (addr) => {
      const [balanceR, marginfiR, kaminoR, stakingR] = await Promise.allSettled([
        getSolanaBalances(addr),
        readMarginfiPositions(conn, addr),
        readKaminoPositions(conn, addr),
        readSolanaStakingPositions(conn, addr),
      ]);
      return { addr, balanceR, marginfiR, kaminoR, stakingR };
    }),
  );

  const slices: SolanaPortfolioSlice[] = [];
  const unpriced: UnpricedAsset[] = [];
  let lendingUsd = 0;
  let stakingUsd = 0;
  let balanceErrored = false;
  let marginfiErrored = false;
  let kaminoErrored = false;
  let stakingErrored = false;
  for (const r of perAddress) {
    if (r.balanceR.status !== "fulfilled") {
      balanceErrored = true;
      continue;
    }
    const balance = r.balanceR.value;
    let solPriceUsd: number | undefined;
    for (const b of balance.native) {
      if (b.token === "native" && typeof b.priceUsd === "number") {
        solPriceUsd = b.priceUsd;
        break;
      }
    }

    const marginfiSlices: SolanaMarginfiPositionSlice[] = [];
    if (r.marginfiR.status === "fulfilled") {
      for (const pos of r.marginfiR.value) {
        marginfiSlices.push({
          protocol: "marginfi",
          chain: "solana",
          marginfiAccount: pos.marginfiAccount,
          supplied: pos.supplied.map((b) => ({
            symbol: b.symbol,
            amount: b.amount,
            valueUsd: b.valueUsd,
          })),
          borrowed: pos.borrowed.map((b) => ({
            symbol: b.symbol,
            amount: b.amount,
            valueUsd: b.valueUsd,
          })),
          totalSuppliedUsd: pos.totalSuppliedUsd,
          totalBorrowedUsd: pos.totalBorrowedUsd,
          netValueUsd: pos.netValueUsd,
          healthFactor: pos.healthFactor,
          warnings: pos.warnings,
        });
      }
    } else {
      marginfiErrored = true;
    }

    const kaminoSlices: SolanaKaminoPositionSlice[] = [];
    if (r.kaminoR.status === "fulfilled") {
      for (const pos of r.kaminoR.value) {
        kaminoSlices.push({
          protocol: "kamino",
          chain: "solana",
          obligation: pos.obligation,
          supplied: pos.supplied.map((b) => ({
            symbol: b.symbol,
            amount: b.amount,
            valueUsd: b.valueUsd,
          })),
          borrowed: pos.borrowed.map((b) => ({
            symbol: b.symbol,
            amount: b.amount,
            valueUsd: b.valueUsd,
          })),
          totalSuppliedUsd: pos.totalSuppliedUsd,
          totalBorrowedUsd: pos.totalBorrowedUsd,
          netValueUsd: pos.netValueUsd,
          healthFactor: pos.healthFactor,
          warnings: pos.warnings,
        });
      }
    } else {
      kaminoErrored = true;
    }
    const addrLendingUsd =
      marginfiSlices.reduce((s, p) => s + p.netValueUsd, 0) +
      kaminoSlices.reduce((s, p) => s + p.netValueUsd, 0);
    lendingUsd += addrLendingUsd;

    let solanaStakingSlice: SolanaStakingPositionSlice | undefined;
    let addrStakingUsd = 0;
    if (r.stakingR.status === "fulfilled" && r.stakingR.value) {
      const raw = r.stakingR.value;
      solanaStakingSlice = {
        chain: "solana",
        marinade: {
          mSolBalance: raw.marinade.mSolBalance,
          solEquivalent: raw.marinade.solEquivalent,
          exchangeRate: raw.marinade.exchangeRate,
        },
        jito: {
          jitoSolBalance: raw.jito.jitoSolBalance,
          solEquivalent: raw.jito.solEquivalent,
          exchangeRate: raw.jito.exchangeRate,
        },
        nativeStakes: raw.nativeStakes.map((s) => ({
          stakePubkey: s.stakePubkey,
          ...(s.validator ? { validator: s.validator } : {}),
          stakeSol: s.stakeSol,
          status: s.status,
          ...(s.activationEpoch !== undefined
            ? { activationEpoch: s.activationEpoch }
            : {}),
          ...(s.deactivationEpoch !== undefined
            ? { deactivationEpoch: s.deactivationEpoch }
            : {}),
        })),
        totalSolEquivalent: raw.totalSolEquivalent,
      };
      if (typeof solPriceUsd === "number") {
        addrStakingUsd = raw.totalSolEquivalent * solPriceUsd;
        stakingUsd += addrStakingUsd;
      }
    } else if (r.stakingR.status === "rejected") {
      stakingErrored = true;
    }

    const slice: SolanaPortfolioSlice = {
      ...balance,
      ...(marginfiSlices.length > 0
        ? {
            marginfi: marginfiSlices,
            marginfiNetUsd: round(
              marginfiSlices.reduce((s, p) => s + p.netValueUsd, 0),
              2,
            ),
          }
        : {}),
      ...(kaminoSlices.length > 0
        ? {
            kamino: kaminoSlices,
            kaminoNetUsd: round(
              kaminoSlices.reduce((s, p) => s + p.netValueUsd, 0),
              2,
            ),
          }
        : {}),
      ...(solanaStakingSlice && solanaStakingSlice.totalSolEquivalent > 0
        ? {
            staking: solanaStakingSlice,
            stakingNetUsd: round(addrStakingUsd, 2),
          }
        : {}),
    };
    slices.push(slice);
    for (const b of [...balance.native, ...balance.spl]) {
      if (b.priceMissing) {
        unpriced.push({
          chain: "solana" as const,
          symbol: b.symbol,
          amount: b.formatted,
        });
      }
    }
  }
  return {
    slices,
    lendingUsd,
    stakingUsd,
    balanceErrored,
    marginfiErrored,
    kaminoErrored,
    stakingErrored,
    unpriced,
  };
}

async function buildWalletSummary(
  wallet: `0x${string}`,
  chains: SupportedChain[],
  tronAddress?: string,
  solanaAddress?: string,
  bitcoinAddresses: string[] = [],
  litecoinAddresses: string[] = [],
): Promise<PortfolioSummary> {
  // Each subquery is independent — one failing shouldn't kill the summary. We swap
  // Promise.all for per-task catchers that return empty payloads on error, so a flaky
  // Aave read (say, "returned no data") still lets us report native + ERC-20 + LP totals.
  // Morpho Blue is discovered per-chain via event-log scan (onBehalf==wallet) since
  // Blue has no on-chain enumeration; discovery is the slowest subquery here on a
  // cold RPC, so it's wrapped in the same catch-and-continue pattern as the others.
  const emptyPositions = { wallet, positions: [] as never[] };
  // Wrap each subquery so the portfolio can distinguish failure from empty. A
  // thrown fetch becomes errored:true so callers don't mistake "Aave down" for
  // "no Aave position".
  const errors = {
    aave: false,
    compound: false,
    morpho: false,
    lp: false,
    staking: false,
    tron: false,
    tronStaking: false,
    solana: false,
    marginfi: false,
    kamino: false,
    solanaStaking: false,
    bitcoin: false,
    litecoin: false,
  };
  // Per-market Compound V3 failure detail, populated when at least one market
  // read errored. Surfaced in coverage.compound.note so the agent can tell
  // the user WHICH chain/market failed and WHY, instead of the generic "fetch
  // failed on at least one market" message (issue #88).
  let compoundErroredMarkets:
    | { chain: SupportedChain; market: string; error: string }[]
    | undefined;
  // Per-chain Morpho Blue discovery failures — same pattern as compound. The
  // Morpho fan-out already runs per-chain with a `.catch` that flips the
  // errored flag; we additionally capture the chain + raw error so the note
  // can name WHICH chain's RPC / event-log scan was failing (issue #92).
  const morphoErroredChains: { chain: SupportedChain; error: string }[] = [];
  // Separate signal from errored: when the VAULTPILOT_MORPHO_DISCOVERY env
  // var is unset, `getMorphoPositions` short-circuits without RPC calls
  // and returns `discoverySkipped: true`. Surface as coverage.morpho with
  // `covered: false, errored: false` — "not attempted, opt-in available".
  let morphoDiscoverySkipped = false;
  // Per-source Lido/EigenLayer staking failures. Previously `getStakingPositions`
  // used `Promise.all` — if EITHER Lido OR EigenLayer threw, the whole staking
  // response rejected and the aggregator coverage flag couldn't tell them
  // apart. `getStakingPositions` now returns `erroredSources` with one entry
  // per failing source (issue #93).
  let stakingErroredSources:
    | { source: "lido" | "eigenlayer"; error: string }[]
    | undefined;
  const [
    nativeAmounts,
    erc20Amounts,
    aave,
    compound,
    morphoByChain,
    lp,
    staking,
    tronSlice,
    tronStakingSlice,
    solanaSlice,
    marginfiPositionsRaw,
    kaminoPositionsRaw,
    solanaStakingRaw,
    bitcoinFetch,
    litecoinFetch,
  ] = await Promise.all([
      Promise.all(
        chains.map((c) =>
          fetchNativeBalance(wallet, c).catch(() => zeroNative(wallet, c))
        )
      ),
      Promise.all(chains.map((c) => fetchTopErc20Balances(wallet, c).catch(() => []))),
      getLendingPositions({ wallet, chains }).catch(() => {
        errors.aave = true;
        return emptyPositions as never;
      }),
      getCompoundPositions({ wallet, chains })
        .then((r) => {
          // Per-market reads use allSettled internally, so the top-level
          // promise succeeds even when individual markets errored. Surface
          // that partial failure so coverage.compound.errored is correct —
          // without this, a flaky cUSDCv3 read would drop a six-figure
          // supply while the aggregator still reported clean coverage
          // (issue #34). The underlying per-market error strings flow
          // through to coverage.compound.note so callers can diagnose
          // which chain/market is broken instead of guessing (issue #88).
          if (r.errored) {
            errors.compound = true;
            if (r.erroredMarkets && r.erroredMarkets.length > 0) {
              compoundErroredMarkets = r.erroredMarkets;
            }
          }
          return r;
        })
        .catch((e) => {
          errors.compound = true;
          compoundErroredMarkets = [
            {
              chain: "ethereum" as SupportedChain,
              market: "(all)",
              error: e instanceof Error ? e.message : String(e),
            },
          ];
          return emptyPositions as never;
        }),
      // Morpho has no multi-chain list endpoint; fan out per-chain and swallow
      // per-chain failures individually so one bad RPC doesn't drop the whole
      // Morpho bucket. If any chain throws, the overall coverage is errored —
      // and we capture the per-chain raw error so coverage.morpho.note can
      // name the failing chain + reason (mirrors #91's compound pattern for
      // issue #92).
      Promise.all(
        chains.map((c) =>
          getMorphoPositions({ wallet, chain: c })
            .then((r) => {
              // `discoverySkipped: true` means the opt-in env var was unset
              // and getMorphoPositions returned cleanly without any RPC
              // calls. Distinct from an errored fetch — we track it
              // separately so the coverage note is opt-in guidance rather
              // than an error diagnosis.
              if (r.discoverySkipped) morphoDiscoverySkipped = true;
              return r;
            })
            .catch((e) => {
              errors.morpho = true;
              morphoErroredChains.push({
                chain: c,
                error: e instanceof Error ? e.message : String(e),
              });
              return { wallet, positions: [] };
            })
        )
      ),
      getLpPositions({ wallet, chains }).catch(() => {
        errors.lp = true;
        return emptyPositions as never;
      }),
      getStakingPositions({ wallet, chains })
        .then((r) => {
          // Same shape as the compound handler: allSettled inside
          // getStakingPositions means the top-level promise now succeeds
          // even when one source errored. Flip the aggregator coverage
          // flag and capture per-source detail for the note (issue #93).
          if (r.errored) {
            errors.staking = true;
            if (r.erroredSources && r.erroredSources.length > 0) {
              stakingErroredSources = r.erroredSources;
            }
          }
          return r;
        })
        .catch((e) => {
          errors.staking = true;
          stakingErroredSources = [
            {
              source: "lido",
              error: e instanceof Error ? e.message : String(e),
            },
          ];
          return emptyPositions as never;
        }),
      // TRON reads are only attempted when the caller passed a tronAddress.
      // `null` means "not attempted" (coverage.tron left as
      // covered:false,errored:false — same semantics as Morpho without
      // marketIds pre-discovery).
      tronAddress
        ? getTronBalances(tronAddress).catch(() => {
            errors.tron = true;
            return null as TronPortfolioSlice | null;
          })
        : (Promise.resolve(null) as Promise<TronPortfolioSlice | null>),
      // TRON staking is fetched in parallel with balances (separate endpoints
      // on TronGrid — getReward + v1/accounts) and coverage-tracked
      // independently, so a staking failure doesn't mask a successful
      // balance read. Same "not attempted" semantics as the balance slot.
      tronAddress
        ? getTronStaking(tronAddress).catch(() => {
            errors.tronStaking = true;
            return null as TronStakingSlice | null;
          })
        : (Promise.resolve(null) as Promise<TronStakingSlice | null>),
      // Solana reads are only attempted when the caller passed a solanaAddress.
      // Same "not attempted" semantics as TRON: null → coverage.solana absent.
      solanaAddress
        ? getSolanaBalances(solanaAddress).catch(() => {
            errors.solana = true;
            return null as SolanaPortfolioSlice | null;
          })
        : (Promise.resolve(null) as Promise<SolanaPortfolioSlice | null>),
      // MarginFi positions ride the same "solanaAddress was passed" gate as
      // Solana balances. The reader deliberately short-circuits when the
      // wallet has no MarginfiAccount (1 RPC lookup, then return []) so the
      // cost of the idle case is essentially free.
      solanaAddress
        ? readMarginfiPositions(getSolanaConnection(), solanaAddress).catch(() => {
            errors.marginfi = true;
            return [] as Awaited<ReturnType<typeof readMarginfiPositions>>;
          })
        : (Promise.resolve([]) as Promise<
            Awaited<ReturnType<typeof readMarginfiPositions>>
          >),
      // Kamino positions ride the same gate. The reader short-circuits when
      // the wallet has no Kamino userMetadata (1 RPC lookup, then return [])
      // so the cost of the idle case is essentially free.
      solanaAddress
        ? readKaminoPositions(getSolanaConnection(), solanaAddress).catch(() => {
            errors.kamino = true;
            return [] as Awaited<ReturnType<typeof readKaminoPositions>>;
          })
        : (Promise.resolve([]) as Promise<
            Awaited<ReturnType<typeof readKaminoPositions>>
          >),
      // Solana staking rides the same gate. The consolidated reader fans
      // out to three sub-readers (Marinade SDK, Jito stake pool, native
      // stake-program enumeration) in parallel. A failure is independent
      // of balance/MarginFi coverage (mirror of tronStaking / marginfi
      // split). Returns null on failure so the aggregator can render a
      // present-but-errored coverage entry.
      solanaAddress
        ? readSolanaStakingPositions(
            getSolanaConnection(),
            solanaAddress,
          ).catch(() => {
            errors.solanaStaking = true;
            return null as Awaited<
              ReturnType<typeof readSolanaStakingPositions>
            > | null;
          })
        : (Promise.resolve(null) as Promise<Awaited<
            ReturnType<typeof readSolanaStakingPositions>
          > | null>),
      // Bitcoin reads are only attempted when the caller passed at least
      // one address. Errors are independent of EVM/TRON/Solana coverage —
      // a flaky mempool.space call doesn't drop the rest of the summary.
      bitcoinAddresses.length > 0
        ? fetchBitcoinSlice(bitcoinAddresses).catch(() => {
            errors.bitcoin = true;
            return null as Awaited<ReturnType<typeof fetchBitcoinSlice>>;
          })
        : (Promise.resolve(null) as Promise<Awaited<
            ReturnType<typeof fetchBitcoinSlice>
          > | null>),
      // Litecoin reads — same shape + degradation as Bitcoin (issue #274).
      litecoinAddresses.length > 0
        ? fetchLitecoinSlice(litecoinAddresses).catch(() => {
            errors.litecoin = true;
            return null as Awaited<ReturnType<typeof fetchLitecoinSlice>>;
          })
        : (Promise.resolve(null) as Promise<Awaited<
            ReturnType<typeof fetchLitecoinSlice>
          > | null>),
    ]);
  if (bitcoinAddresses.length > 0 && bitcoinFetch === null) {
    // fetchBitcoinSlice returns null when every per-address read errored
    // (or the indexer call itself threw). Distinct from "not attempted":
    // surface as coverage.bitcoin.errored.
    errors.bitcoin = true;
  }
  if (litecoinAddresses.length > 0 && litecoinFetch === null) {
    errors.litecoin = true;
  }
  const morphoPositions = morphoByChain.flatMap((r) => r.positions);

  // Filter zero native balances out.
  const native = nativeAmounts.filter((a) => a.amount !== "0");
  const erc20 = erc20Amounts.flat();

  // Merge Aave + Compound + Morpho into a single lending bucket — they all carry
  // `chain` and `netValueUsd`, which is all the summary math needs.
  const lendingPositions: LendingPositionUnion[] = [
    ...aave.positions,
    ...compound.positions,
    ...morphoPositions,
  ];

  const tronBalancesUsd = tronSlice?.walletBalancesUsd ?? 0;
  const tronStakingUsd = tronStakingSlice?.totalStakedUsd ?? 0;
  const solanaBalancesUsd = solanaSlice?.walletBalancesUsd ?? 0;
  const bitcoinSlice = bitcoinFetch?.slice;
  const bitcoinBalancesUsd = bitcoinSlice?.walletBalancesUsd ?? 0;
  const bitcoinUnpriced = bitcoinFetch?.unpriced ?? [];
  const litecoinSlice = litecoinFetch?.slice;
  const litecoinBalancesUsd = litecoinSlice?.walletBalancesUsd ?? 0;
  const litecoinUnpriced = litecoinFetch?.unpriced ?? [];
  // Project the reader's full MarginfiPosition into the thin slice the
  // types module exposes. Dropping bank/mint keeps the portfolio JSON
  // compact — callers who want the full per-bank detail call
  // get_marginfi_positions directly.
  const marginfiSlices: SolanaMarginfiPositionSlice[] = marginfiPositionsRaw.map(
    (pos) => ({
      protocol: "marginfi",
      chain: "solana",
      marginfiAccount: pos.marginfiAccount,
      supplied: pos.supplied.map((b) => ({
        symbol: b.symbol,
        amount: b.amount,
        valueUsd: b.valueUsd,
      })),
      borrowed: pos.borrowed.map((b) => ({
        symbol: b.symbol,
        amount: b.amount,
        valueUsd: b.valueUsd,
      })),
      totalSuppliedUsd: pos.totalSuppliedUsd,
      totalBorrowedUsd: pos.totalBorrowedUsd,
      netValueUsd: pos.netValueUsd,
      healthFactor: pos.healthFactor,
      warnings: pos.warnings,
    }),
  );
  // Project the Kamino reader's full KaminoPosition into the thin slice.
  // Mirror of marginfiSlices: drop reserve/mint/obligation-internal fields
  // that the portfolio JSON doesn't need.
  const kaminoSlices: SolanaKaminoPositionSlice[] = kaminoPositionsRaw.map(
    (pos) => ({
      protocol: "kamino",
      chain: "solana",
      obligation: pos.obligation,
      supplied: pos.supplied.map((b) => ({
        symbol: b.symbol,
        amount: b.amount,
        valueUsd: b.valueUsd,
      })),
      borrowed: pos.borrowed.map((b) => ({
        symbol: b.symbol,
        amount: b.amount,
        valueUsd: b.valueUsd,
      })),
      totalSuppliedUsd: pos.totalSuppliedUsd,
      totalBorrowedUsd: pos.totalBorrowedUsd,
      netValueUsd: pos.netValueUsd,
      healthFactor: pos.healthFactor,
      warnings: pos.warnings,
    }),
  );
  const solanaLendingUsd =
    marginfiSlices.reduce((s, p) => s + p.netValueUsd, 0) +
    kaminoSlices.reduce((s, p) => s + p.netValueUsd, 0);

  // Solana staking slice — shrink the consolidated reader's shape into the
  // portfolio's thin projection. Dropping the wallet/protocol/chain fields
  // on each sub-reader's output keeps the summary JSON compact; callers
  // who want the full view call get_solana_staking_positions directly.
  const solanaStakingSlice: SolanaStakingPositionSlice | undefined =
    solanaStakingRaw
      ? {
          chain: "solana",
          marinade: {
            mSolBalance: solanaStakingRaw.marinade.mSolBalance,
            solEquivalent: solanaStakingRaw.marinade.solEquivalent,
            exchangeRate: solanaStakingRaw.marinade.exchangeRate,
          },
          jito: {
            jitoSolBalance: solanaStakingRaw.jito.jitoSolBalance,
            solEquivalent: solanaStakingRaw.jito.solEquivalent,
            exchangeRate: solanaStakingRaw.jito.exchangeRate,
          },
          nativeStakes: solanaStakingRaw.nativeStakes.map((s) => ({
            stakePubkey: s.stakePubkey,
            ...(s.validator ? { validator: s.validator } : {}),
            stakeSol: s.stakeSol,
            status: s.status,
            ...(s.activationEpoch !== undefined
              ? { activationEpoch: s.activationEpoch }
              : {}),
            ...(s.deactivationEpoch !== undefined
              ? { deactivationEpoch: s.deactivationEpoch }
              : {}),
          })),
          totalSolEquivalent: solanaStakingRaw.totalSolEquivalent,
        }
      : undefined;

  // Convert the Solana staking subtotal to USD using the same SOL price
  // that valued the native-SOL line in solanaSlice. Reusing avoids a
  // duplicate price fetch + guarantees the two USD numbers (SOL-in-wallet
  // vs. staked-SOL) use the exact same SOL price. Falls back to 0 if the
  // solanaSlice is absent or didn't manage to resolve a SOL price.
  const solPriceUsd = solanaSlice?.native.find(
    (b) => b.token === "native",
  )?.priceUsd;
  const solanaStakingUsd =
    solanaStakingSlice && typeof solPriceUsd === "number"
      ? solanaStakingSlice.totalSolEquivalent * solPriceUsd
      : 0;

  const walletBalancesUsd = round(
    [...native, ...erc20].reduce((sum, t) => sum + (t.valueUsd ?? 0), 0) +
      tronBalancesUsd +
      solanaBalancesUsd +
      bitcoinBalancesUsd +
      litecoinBalancesUsd,
    2
  );
  const lendingNetUsd = round(
    lendingPositions.reduce((sum, p) => sum + p.netValueUsd, 0),
    2
  );
  const lpUsd = round(lp.positions.reduce((sum, p) => sum + p.totalValueUsd, 0), 2);
  const stakingUsd = round(
    staking.positions.reduce((sum, p) => sum + (p.stakedAmount.valueUsd ?? 0), 0),
    2
  );
  // totalUsd folds every accounted-for slice: EVM balances + TRON balances +
  // Solana balances + BTC balances are already rolled into walletBalancesUsd;
  // TRON staking and Solana staking are surfaced separately. EVM-only slices
  // (lending/LP/staking) are added here.
  const totalUsd = round(
    walletBalancesUsd +
      lendingNetUsd +
      lpUsd +
      stakingUsd +
      tronStakingUsd +
      solanaLendingUsd +
      solanaStakingUsd,
    2
  );

  // Per-chain breakdown (sums everything tagged to each chain).
  const perChain: Record<SupportedChain, number> = Object.fromEntries(
    chains.map((c) => [c, 0])
  ) as Record<SupportedChain, number>;

  chains.forEach((c, i) => {
    const chainNative = nativeAmounts[i]?.valueUsd ?? 0;
    const chainErc20 = erc20Amounts[i].reduce((s, t) => s + (t.valueUsd ?? 0), 0);
    const chainLending = lendingPositions.filter((p) => p.chain === c).reduce((s, p) => s + p.netValueUsd, 0);
    const chainLp = lp.positions.filter((p) => p.chain === c).reduce((s, p) => s + p.totalValueUsd, 0);
    const chainStaking = staking.positions.filter((p) => p.chain === c).reduce((s, p) => s + (p.stakedAmount.valueUsd ?? 0), 0);
    perChain[c] = round(chainNative + chainErc20 + chainLending + chainLp + chainStaking, 2);
  });

  // Tag each unpriced EVM balance with its chain at construction — TokenAmount
  // itself has no `chain` field (positional via the `chains` array), so we
  // zip here. Native and ERC-20 are collected separately per chain, so we
  // reuse the index alignment already established by nativeAmounts /
  // erc20Amounts above.
  const evmUnpricedDetail: UnpricedAsset[] = [];
  chains.forEach((c, i) => {
    const n = nativeAmounts[i];
    if (n && n.amount !== "0" && n.priceMissing) {
      evmUnpricedDetail.push({ chain: c, symbol: n.symbol, amount: n.formatted });
    }
    for (const t of erc20Amounts[i] ?? []) {
      if (t.priceMissing) {
        evmUnpricedDetail.push({ chain: c, symbol: t.symbol, amount: t.formatted });
      }
    }
  });
  const tronUnpricedDetail: UnpricedAsset[] = tronSlice
    ? [...tronSlice.native, ...tronSlice.trc20]
        .filter((t) => t.priceMissing)
        .map((t) => ({ chain: "tron" as const, symbol: t.symbol, amount: t.formatted }))
    : [];
  const solanaUnpricedDetail: UnpricedAsset[] = solanaSlice
    ? [...solanaSlice.native, ...solanaSlice.spl]
        .filter((t) => t.priceMissing)
        .map((t) => ({ chain: "solana" as const, symbol: t.symbol, amount: t.formatted }))
    : [];
  // Structured list of which specific tokens couldn't be priced (issue #94).
  // Before this existed, `unpricedAssets: N` was just a counter — the agent
  // couldn't tell the user "your 705 MATIC on polygon wasn't priced and
  // isn't in the total". Now the agent has symbol + amount + chain for each
  // unpriced asset and can surface a concrete warning.
  const unpricedAssetsDetail: UnpricedAsset[] = [
    ...evmUnpricedDetail,
    ...tronUnpricedDetail,
    ...solanaUnpricedDetail,
    ...bitcoinUnpriced,
    ...litecoinUnpriced,
  ];
  const unpricedAssets = unpricedAssetsDetail.length;
  const coverage: PortfolioCoverage = {
    aave: { covered: !errors.aave, ...(errors.aave ? { errored: true, note: "Aave fetch failed — positions not included in totals." } : {}) },
    compound: {
      covered: !errors.compound,
      ...(errors.compound
        ? {
            errored: true,
            note: formatCompoundErrorNote(compoundErroredMarkets),
          }
        : {}),
    },
    morpho: errors.morpho
      ? {
          covered: false,
          errored: true,
          note: formatMorphoErrorNote(morphoErroredChains),
        }
      : morphoDiscoverySkipped
      ? {
          covered: false,
          note:
            "Morpho Blue auto-discovery is opt-in to spare free-tier RPCs " +
            "(event-log scan dominated rate-limit pressure — see issue #88). " +
            "Set VAULTPILOT_MORPHO_DISCOVERY=1 to enable automatic scan, or " +
            "call get_morpho_positions with explicit marketIds for a fast-path " +
            "read.",
        }
      : { covered: true },
    uniswapV3: { covered: !errors.lp, ...(errors.lp ? { errored: true, note: "Uniswap V3 LP fetch failed — positions not included." } : {}) },
    staking: {
      covered: !errors.staking,
      ...(errors.staking
        ? {
            errored: true,
            note: formatStakingErrorNote(stakingErroredSources),
          }
        : {}),
    },
    ...(tronAddress
      ? {
          tron: errors.tron
            ? { covered: false, errored: true, note: "TRON balance fetch failed (TronGrid) — TRX/TRC-20 not included in totals." }
            : { covered: true },
          tronStaking: errors.tronStaking
            ? { covered: false, errored: true, note: "TRON staking fetch failed (TronGrid getReward/accounts) — frozen + rewards not included in totals." }
            : { covered: true },
        }
      : {}),
    ...(bitcoinAddresses.length > 0
      ? {
          bitcoin: errors.bitcoin
            ? {
                covered: false,
                errored: true,
                note:
                  "Bitcoin indexer fetch failed — BTC balances not included in totals. " +
                  "Check `bitcoinIndexerUrl` config or BITCOIN_INDEXER_URL env var; " +
                  "mempool.space's free public API is the default.",
              }
            : { covered: true },
        }
      : {}),
    ...(litecoinAddresses.length > 0
      ? {
          litecoin: errors.litecoin
            ? {
                covered: false,
                errored: true,
                note:
                  "Litecoin indexer fetch failed — LTC balances not included in totals. " +
                  "Check `litecoinIndexerUrl` config or LITECOIN_INDEXER_URL env var; " +
                  "litecoinspace.org's free public API is the default.",
              }
            : { covered: true },
        }
      : {}),
    ...(solanaAddress
      ? {
          solana: errors.solana
            ? { covered: false, errored: true, note: "Solana balance fetch failed — SOL/SPL not included in totals. Check SOLANA_RPC_URL or the solanaRpcUrl config." }
            : { covered: true },
          marginfi: errors.marginfi
            ? {
                covered: false,
                errored: true,
                note: "MarginFi position fetch failed — lending positions not included in totals. SDK or oracle RPC error; balances still loaded if coverage.solana is covered.",
              }
            : { covered: true },
          kamino: errors.kamino
            ? {
                covered: false,
                errored: true,
                note: "Kamino position fetch failed — lending positions not included in totals. Kamino market load or obligation read failed; balances + MarginFi still loaded if their coverage flags are covered.",
              }
            : { covered: true },
          solanaStaking: errors.solanaStaking
            ? {
                covered: false,
                errored: true,
                note: "Solana staking fetch failed — Marinade / Jito / native stake positions not included in totals. Independent of coverage.solana; MarginFi + balances still loaded if those are covered.",
              }
            : { covered: true },
        }
      : {}),
    unpricedAssets,
    ...(unpricedAssetsDetail.length > 0 ? { unpricedAssetsDetail } : {}),
  };

  // Merge balance + staking into a single TRON slice for the breakdown so
  // consumers only see one `tron` block. If balances errored but staking
  // succeeded (or vice versa) we still surface whichever loaded — each is
  // independently coverage-tracked.
  const tronBreakdown: TronPortfolioSlice | undefined =
    tronSlice || tronStakingSlice
      ? {
          address: tronAddress ?? tronSlice?.address ?? tronStakingSlice?.address ?? "",
          native: tronSlice?.native ?? [],
          trc20: tronSlice?.trc20 ?? [],
          walletBalancesUsd: tronSlice?.walletBalancesUsd ?? 0,
          ...(tronStakingSlice ? { staking: tronStakingSlice } : {}),
        }
      : undefined;

  // tronUsd rolls up balances + staking so the single-number view matches the
  // sum a user sees in a block explorer. tronStakingUsd surfaces the staking
  // portion separately for UI.
  const tronUsdTotal = round(tronBalancesUsd + tronStakingUsd, 2);

  return {
    wallet,
    chains,
    walletBalancesUsd,
    lendingNetUsd,
    lpUsd,
    stakingUsd,
    totalUsd,
    perChain,
    ...(tronBreakdown ? { tronUsd: tronUsdTotal } : {}),
    ...(tronStakingSlice ? { tronStakingUsd: round(tronStakingUsd, 2) } : {}),
    ...(solanaSlice ? { solanaUsd: round(solanaBalancesUsd, 2) } : {}),
    ...(marginfiSlices.length > 0 || kaminoSlices.length > 0
      ? { solanaLendingUsd: round(solanaLendingUsd, 2) }
      : {}),
    ...(solanaStakingSlice && solanaStakingSlice.totalSolEquivalent > 0
      ? { solanaStakingUsd: round(solanaStakingUsd, 2) }
      : {}),
    ...(bitcoinSlice ? { bitcoinUsd: round(bitcoinBalancesUsd, 2) } : {}),
    ...(litecoinSlice ? { litecoinUsd: round(litecoinBalancesUsd, 2) } : {}),
    breakdown: {
      native,
      erc20,
      lending: lendingPositions,
      lp: lp.positions,
      staking: staking.positions,
      ...(tronBreakdown ? { tron: tronBreakdown } : {}),
      ...(bitcoinSlice ? { bitcoin: bitcoinSlice } : {}),
      ...(litecoinSlice ? { litecoin: litecoinSlice } : {}),
      ...(solanaSlice
        ? {
            solana: {
              ...solanaSlice,
              ...(marginfiSlices.length > 0
                ? {
                    marginfi: marginfiSlices,
                    marginfiNetUsd: round(
                      marginfiSlices.reduce((s, p) => s + p.netValueUsd, 0),
                      2,
                    ),
                  }
                : {}),
              ...(kaminoSlices.length > 0
                ? {
                    kamino: kaminoSlices,
                    kaminoNetUsd: round(
                      kaminoSlices.reduce((s, p) => s + p.netValueUsd, 0),
                      2,
                    ),
                  }
                : {}),
              ...(solanaStakingSlice &&
              solanaStakingSlice.totalSolEquivalent > 0
                ? {
                    staking: solanaStakingSlice,
                    stakingNetUsd: round(solanaStakingUsd, 2),
                  }
                : {}),
            },
          }
        : {}),
    },
    coverage,
  };
}
