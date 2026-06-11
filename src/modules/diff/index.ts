/**
 * `get_portfolio_diff` — wallet-level "what changed since X" tool.
 *
 * Composer that fans out per-chain analysis (EVM x N + TRON + Solana +
 * BTC), folds the slices into a single `PortfolioDiffSummary`, and
 * optionally renders a narrative string for the agent to relay verbatim.
 *
 * See `decompose.ts` for the per-chain math; this module is plumbing.
 */
import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";
import {
  fetchNativeBalance,
  fetchTopErc20Balances,
} from "../portfolio/index.js";
import { getTronBalances } from "../tron/balances.js";
import { getSolanaBalances } from "../solana/balances.js";
import { getBitcoinBalance } from "../btc/balances.js";
import { fetchBitcoinPrice } from "../btc/price.js";
import {
  buildChainSlice,
  fetchChainHistory,
  resolveWindow,
  type AssetSnapshot,
} from "./decompose.js";
import { renderPortfolioDiffNarrative } from "./render.js";
import type {
  GetPortfolioDiffArgs,
  PortfolioDiffSummary,
  ChainDiffSlice,
} from "./schemas.js";
import { assertAtLeastOneAddress } from "./schemas.js";

/** Native-coin decimals per chain, used to render starting/ending qty. */
const NATIVE_DECIMALS: Record<string, number> = {
  ethereum: 18,
  arbitrum: 18,
  polygon: 18,
  base: 18,
  optimism: 18,
  tron: 6,
  solana: 9,
  bitcoin: 8,
};

const NATIVE_SYMBOLS: Record<string, string> = {
  ethereum: "ETH",
  arbitrum: "ETH",
  polygon: "MATIC",
  base: "ETH",
  optimism: "ETH",
  tron: "TRX",
  solana: "SOL",
  bitcoin: "BTC",
};

/**
 * Build the per-EVM-chain snapshots from existing balance readers. One
 * call per chain × {native, top-N erc20}. The portfolio summary's
 * aggregator already fans out this shape internally; we hit the same
 * readers directly so we get per-chain typed data without going through
 * its flattening.
 */
async function snapshotEvmChain(
  wallet: `0x${string}`,
  chain: SupportedChain,
): Promise<AssetSnapshot[]> {
  const [native, erc20] = await Promise.all([
    fetchNativeBalance(wallet, chain).catch(() => null),
    fetchTopErc20Balances(wallet, chain).catch(() => []),
  ]);
  const out: AssetSnapshot[] = [];
  if (native && native.amount !== "0") {
    out.push({
      token: "native",
      symbol: native.symbol,
      decimals: native.decimals,
      endingQtyRaw: BigInt(native.amount),
      endingQty: native.formatted,
      ...(native.priceUsd !== undefined ? { endingPriceUsd: native.priceUsd } : {}),
      endingValueUsd: native.valueUsd ?? 0,
    });
  }
  for (const t of erc20) {
    if (t.amount === "0") continue;
    out.push({
      token: t.token.toLowerCase(),
      symbol: t.symbol,
      decimals: t.decimals,
      endingQtyRaw: BigInt(t.amount),
      endingQty: t.formatted,
      ...(t.priceUsd !== undefined ? { endingPriceUsd: t.priceUsd } : {}),
      endingValueUsd: t.valueUsd ?? 0,
    });
  }
  return out;
}

async function snapshotTron(address: string): Promise<AssetSnapshot[]> {
  const slice = await getTronBalances(address);
  const out: AssetSnapshot[] = [];
  for (const b of [...slice.native, ...slice.trc20]) {
    if (b.amount === "0") continue;
    out.push({
      token: b.token,
      symbol: b.symbol,
      decimals: b.decimals,
      endingQtyRaw: BigInt(b.amount),
      endingQty: b.formatted,
      ...(b.priceUsd !== undefined ? { endingPriceUsd: b.priceUsd } : {}),
      endingValueUsd: b.valueUsd ?? 0,
    });
  }
  return out;
}

async function snapshotSolana(address: string): Promise<AssetSnapshot[]> {
  const slice = await getSolanaBalances(address);
  const out: AssetSnapshot[] = [];
  for (const b of [...slice.native, ...slice.spl]) {
    if (b.amount === "0") continue;
    out.push({
      token: b.token,
      symbol: b.symbol,
      decimals: b.decimals,
      endingQtyRaw: BigInt(b.amount),
      endingQty: b.formatted,
      ...(b.priceUsd !== undefined ? { endingPriceUsd: b.priceUsd } : {}),
      endingValueUsd: b.valueUsd ?? 0,
    });
  }
  return out;
}

async function snapshotBitcoin(address: string): Promise<AssetSnapshot[]> {
  // BTC balance + price are separate calls — the BitcoinBalance shape
  // intentionally doesn't carry valueUsd/priceUsd to keep balance reads
  // independent of price availability. We pair them here for the diff.
  const [balance, priceUsd] = await Promise.all([
    getBitcoinBalance(address),
    fetchBitcoinPrice().catch(() => undefined),
  ]);
  if (balance.confirmedSats === 0n) return [];
  const btcFloat = Number(balance.confirmedBtc);
  const endingValueUsd = priceUsd !== undefined ? btcFloat * priceUsd : 0;
  return [
    {
      token: "native",
      symbol: "BTC",
      decimals: 8,
      endingQtyRaw: balance.confirmedSats,
      endingQty: balance.confirmedBtc,
      ...(priceUsd !== undefined ? { endingPriceUsd: priceUsd } : {}),
      endingValueUsd,
    },
  ];
}

/**
 * Compose per-chain diff slices for an arbitrary timestamp window. Shared
 * core for `getPortfolioDiff` (this file's public entry point, fixed
 * 24h/7d/30d/ytd windows) and `getPnlSummary` (`src/modules/pnl/index.ts`,
 * adds `inception` capped at 365d). Both tools agree on the per-chain
 * math by construction since they call this same composer — no risk of
 * drift between the two surfaces' numbers.
 */
export async function composePerChainDiff(args: {
  wallet?: string;
  tronAddress?: string;
  solanaAddress?: string;
  bitcoinAddress?: string;
  startSec: number;
  endSec: number;
}): Promise<{
  slices: ChainDiffSlice[];
  notes: string[];
  anyMissedPrice: boolean;
  anyTruncated: boolean;
}> {
  const { startSec, endSec } = args;
  const slices: ChainDiffSlice[] = [];
  const notes: string[] = [];
  let anyMissedPrice = false;
  let anyTruncated = false;

  // Per-EVM-chain analysis. We cap to the canonical SUPPORTED_CHAINS list
  // and gracefully tolerate per-chain failures (errored chain → skipped
  // with a note rather than aborting the whole diff).
  if (args.wallet) {
    const evmTasks = SUPPORTED_CHAINS.map(async (chain) => {
      try {
        const [snapshots, history] = await Promise.all([
          snapshotEvmChain(args.wallet as `0x${string}`, chain),
          fetchChainHistory({
            wallet: args.wallet as string,
            chain,
            startSec,
            endSec,
          }),
        ]);
        // Skip empty chains UNLESS the history fetcher truncated — a
        // truncated history with no visible items still tells us
        // something (the cap was hit; flow accounting is partial),
        // and that signal must propagate to the summary's `truncated`
        // flag so the caveat surfaces in the narrative.
        if (
          snapshots.length === 0 &&
          history.items.length === 0 &&
          !history.truncated
        ) {
          return null;
        }
        const { slice, missedPrice } = await buildChainSlice({
          chain,
          wallet: args.wallet as string,
          snapshots,
          historyItems: history.items,
          truncated: history.truncated,
          windowStartSec: startSec,
          nativeDecimals: NATIVE_DECIMALS[chain]!,
          nativeSymbol: NATIVE_SYMBOLS[chain]!,
        });
        if (missedPrice) anyMissedPrice = true;
        if (history.truncated) anyTruncated = true;
        return slice;
      } catch (e) {
        notes.push(
          `Skipped ${chain}: ${(e as Error).message ?? "unknown error"}.`,
        );
        return null;
      }
    });
    const evmSlices = (await Promise.all(evmTasks)).filter(
      (s): s is ChainDiffSlice => s !== null,
    );
    slices.push(...evmSlices);
  }

  if (args.tronAddress) {
    try {
      const [snapshots, history] = await Promise.all([
        snapshotTron(args.tronAddress),
        fetchChainHistory({
          wallet: args.tronAddress,
          chain: "tron",
          startSec,
          endSec,
        }),
      ]);
      const { slice, missedPrice } = await buildChainSlice({
        chain: "tron",
        wallet: args.tronAddress,
        snapshots,
        historyItems: history.items,
        truncated: history.truncated,
        windowStartSec: startSec,
        nativeDecimals: NATIVE_DECIMALS.tron!,
        nativeSymbol: NATIVE_SYMBOLS.tron!,
      });
      if (missedPrice) anyMissedPrice = true;
      if (history.truncated) anyTruncated = true;
      slices.push(slice);
    } catch (e) {
      notes.push(`Skipped TRON: ${(e as Error).message ?? "unknown error"}.`);
    }
  }

  if (args.solanaAddress) {
    try {
      const [snapshots, history] = await Promise.all([
        snapshotSolana(args.solanaAddress),
        fetchChainHistory({
          wallet: args.solanaAddress,
          chain: "solana",
          startSec,
          endSec,
        }),
      ]);
      const { slice, missedPrice } = await buildChainSlice({
        chain: "solana",
        wallet: args.solanaAddress,
        snapshots,
        historyItems: history.items,
        truncated: history.truncated,
        windowStartSec: startSec,
        nativeDecimals: NATIVE_DECIMALS.solana!,
        nativeSymbol: NATIVE_SYMBOLS.solana!,
      });
      if (missedPrice) anyMissedPrice = true;
      if (history.truncated) anyTruncated = true;
      // Surface skipped program-interaction count.
      const skipped = (slice as ChainDiffSlice & {
        _skippedProgramInteractions?: number;
      })._skippedProgramInteractions;
      if (skipped && skipped > 0) {
        notes.push(
          `${skipped} Solana program-interaction tx(s) (Jupiter swaps, MarginFi actions, ` +
            `staking actions, etc.) skipped from net-flow accounting in v1 — their balance ` +
            `deltas mix swap legs that intra-tx cancel out.`,
        );
      }
      slices.push(slice);
    } catch (e) {
      notes.push(
        `Skipped Solana: ${(e as Error).message ?? "unknown error"}.`,
      );
    }
  }

  if (args.bitcoinAddress) {
    try {
      const snapshots = await snapshotBitcoin(args.bitcoinAddress);
      // Bitcoin doesn't yet have history support in `getTransactionHistory`
      // for the chain enum used by the diff module — surface as an
      // explicit limitation rather than failing.
      notes.push(
        "Bitcoin diff in v1 covers current balance only; no in-window flow " +
          "accounting yet (history support deferred).",
      );
      const { slice, missedPrice } = await buildChainSlice({
        chain: "bitcoin",
        wallet: args.bitcoinAddress,
        snapshots,
        historyItems: [],
        truncated: false,
        windowStartSec: startSec,
        nativeDecimals: NATIVE_DECIMALS.bitcoin!,
        nativeSymbol: NATIVE_SYMBOLS.bitcoin!,
      });
      if (missedPrice) anyMissedPrice = true;
      slices.push(slice);
    } catch (e) {
      notes.push(`Skipped BTC: ${(e as Error).message ?? "unknown error"}.`);
    }
  }

  return { slices, notes, anyMissedPrice, anyTruncated };
}

/**
 * Top-level entry. Reads inputs, fans out per-chain analysis (via
 * `composePerChainDiff`), sums everything, optionally renders the
 * narrative.
 */
export async function getPortfolioDiff(
  args: GetPortfolioDiffArgs,
): Promise<PortfolioDiffSummary> {
  assertAtLeastOneAddress(args);
  const { startSec, endSec } = resolveWindow(args.window);
  const windowStartIso = new Date(startSec * 1000).toISOString();
  const windowEndIso = new Date(endSec * 1000).toISOString();

  const composed = await composePerChainDiff({
    wallet: args.wallet,
    tronAddress: args.tronAddress,
    solanaAddress: args.solanaAddress,
    bitcoinAddress: args.bitcoinAddress,
    startSec,
    endSec,
  });
  const { slices, anyMissedPrice, anyTruncated } = composed;
  const notes = [...composed.notes];

  // Aggregate top-level numbers from slices.
  const startingValueUsd = round2(
    slices.reduce((s, c) => s + c.startingValueUsd, 0),
  );
  const endingValueUsd = round2(
    slices.reduce((s, c) => s + c.endingValueUsd, 0),
  );
  const inflowsUsd = round2(slices.reduce((s, c) => s + c.inflowsUsd, 0));
  const outflowsUsd = round2(slices.reduce((s, c) => s + c.outflowsUsd, 0));
  const netFlowsUsd = round2(inflowsUsd - outflowsUsd);
  const priceEffectUsd = round2(
    slices.reduce((s, c) => s + c.priceEffectUsd, 0),
  );
  const topLevelChangeUsd = round2(endingValueUsd - startingValueUsd);
  const otherEffectUsd = round2(
    topLevelChangeUsd - priceEffectUsd - netFlowsUsd,
  );

  // v1 caveats every diff response carries.
  notes.push(
    "DeFi position interest accrual (Aave / Compound / Morpho supply yield, " +
      "Lido stETH rebases, etc.) is collapsed into the residual `otherEffectUsd` " +
      "rather than separated. Split-by-protocol decomposition is a future enhancement.",
  );

  const priceCoverage: "full" | "partial" | "none" = anyMissedPrice
    ? "partial"
    : "full";

  const summary: PortfolioDiffSummary = {
    window: args.window,
    windowStartIso,
    windowEndIso,
    startingValueUsd,
    endingValueUsd,
    topLevelChangeUsd,
    inflowsUsd,
    outflowsUsd,
    netFlowsUsd,
    priceEffectUsd,
    otherEffectUsd,
    perChain: slices.map((s) => {
      // Strip the internal sentinel before returning to caller.
      const cleaned = { ...s } as ChainDiffSlice & {
        _skippedProgramInteractions?: number;
      };
      delete cleaned._skippedProgramInteractions;
      return cleaned;
    }),
    truncated: anyTruncated,
    priceCoverage,
    notes,
  };

  if (args.format !== "structured") {
    summary.narrative = renderPortfolioDiffNarrative(summary);
  }

  return summary;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
