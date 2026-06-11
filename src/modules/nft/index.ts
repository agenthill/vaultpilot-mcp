/**
 * `get_nft_portfolio` / `get_nft_collection` / `get_nft_history`
 * handlers. Read-only, EVM-only in v1. Reservoir is the source of
 * truth for all three tools.
 *
 * Multi-chain fan-out is `Promise.allSettled` — one chain's 429 or
 * 5xx degrades to a `coverage[].errored: true` entry rather than
 * aborting the whole call. Single-chain rate limits surface a
 * structured `setupHint` so the agent can tell the user how to
 * remediate (set RESERVOIR_API_KEY).
 */

import { SUPPORTED_CHAINS, type SupportedChain } from "../../types/index.js";
import {
  reservoirFetch,
  ReservoirRateLimitedError,
  RESERVOIR_SETUP_HINT,
  type ReservoirActivityItem,
  type ReservoirAskOrder,
  type ReservoirCollection,
  type ReservoirCollectionsResponse,
  type ReservoirOrdersAsksResponse,
  type ReservoirUserToken,
  type ReservoirUserTokensResponse,
  type ReservoirUsersActivityResponse,
} from "./reservoir.js";
import {
  getAssetsByOwner,
  HeliusNotConfiguredError,
  HeliusRateLimitedError,
} from "./helius-das.js";
import type {
  GetNftCollectionArgs,
  GetNftHistoryArgs,
  GetNftListingsArgs,
  GetNftPortfolioArgs,
  NftCollectionInfo,
  NftHistoryItem,
  NftHistoryItemType,
  NftHistoryResult,
  NftListingRow,
  NftListingsResult,
  NftPortfolioResult,
  NftPortfolioRow,
} from "./schemas.js";

/** Reservoir's `/users/{user}/tokens/v10` page size cap. */
const PORTFOLIO_PAGE_SIZE = 200;
/** Reservoir's `/users/{user}/activity/v6` page size cap. */
const ACTIVITY_PAGE_SIZE = 100;

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---- get_nft_portfolio ---------------------------------------------

interface ChainScanOk {
  chain: SupportedChain;
  ok: true;
  rows: NftPortfolioRow[];
}
interface ChainScanErr {
  chain: SupportedChain;
  ok: false;
  reason: string;
}

async function scanChain(
  chain: SupportedChain,
  wallet: string,
): Promise<ChainScanOk | ChainScanErr> {
  try {
    const res = await reservoirFetch<ReservoirUserTokensResponse>({
      chain,
      path: `/users/${wallet}/tokens/v10`,
      query: {
        limit: PORTFOLIO_PAGE_SIZE,
        // Aggregate per-collection rather than emit one row per token —
        // the v1 question is "how much NFT exposure do I have?", not
        // "list every token id". Reservoir's response carries
        // `ownership.tokenCount` so we can collapse to per-collection
        // rows after fetching.
        sortBy: "lastAppraisalValue",
      },
    });
    const byCollection = new Map<string, NftPortfolioRow>();
    for (const t of res.tokens) {
      const row = projectToken(chain, t);
      if (!row) continue;
      const key = row.contractAddress.toLowerCase();
      const existing = byCollection.get(key);
      if (!existing) {
        byCollection.set(key, row);
      } else {
        // Multiple tokens in the same collection — merge counts and
        // recompute totals.
        existing.tokenCount += row.tokenCount;
        if (existing.floorEth !== undefined) {
          existing.totalFloorEth = round2(existing.floorEth * existing.tokenCount);
        }
        if (existing.floorUsd !== undefined) {
          existing.totalFloorUsd = round2(existing.floorUsd * existing.tokenCount);
        }
      }
    }
    return { chain, ok: true, rows: Array.from(byCollection.values()) };
  } catch (e) {
    if (e instanceof ReservoirRateLimitedError) {
      return { chain, ok: false, reason: "rate_limited" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { chain, ok: false, reason: msg };
  }
}

function projectToken(
  chain: SupportedChain,
  t: ReservoirUserToken,
): NftPortfolioRow | null {
  const tokenCount = Number(t.ownership.tokenCount ?? "0");
  if (!Number.isFinite(tokenCount) || tokenCount <= 0) return null;
  const floorEth = t.token.collection.floorAskPrice?.amount?.decimal;
  const floorUsd = t.token.collection.floorAskPrice?.amount?.usd;
  const floorCurrency = t.token.collection.floorAskPrice?.currency?.symbol;
  return {
    chain,
    contractAddress: t.token.contract,
    ...(t.token.collection.name ? { collectionName: t.token.collection.name } : {}),
    ...(t.token.collection.slug ? { collectionSlug: t.token.collection.slug } : {}),
    ...(t.token.collection.imageUrl ? { collectionImage: t.token.collection.imageUrl } : {}),
    tokenCount,
    ...(typeof floorEth === "number" ? { floorEth } : {}),
    ...(typeof floorUsd === "number" ? { floorUsd: round2(floorUsd) } : {}),
    ...(typeof floorEth === "number"
      ? { totalFloorEth: round2(floorEth * tokenCount) }
      : {}),
    ...(typeof floorUsd === "number"
      ? { totalFloorUsd: round2(floorUsd * tokenCount) }
      : {}),
    ...(floorCurrency ? { floorCurrency } : {}),
  };
}

/**
 * Issue #433 — Solana branch via Helius DAS `getAssetsByOwner`. Returns
 * one row per collection (collected from `grouping.group_key === "collection"`)
 * with `tokenCount` aggregated. Floor pricing intentionally absent in
 * v1 — Magic Eden / Tensor integration is a separate follow-up issue
 * per the deferred-scope plan.
 *
 * Spam / mint-bombed collection filtering is left to the user via the
 * Helius `displayOptions.showFungible: false` server-side filter (which
 * we send) plus the `interface !== "FungibleToken"` client-side guard.
 * That covers the bulk of obvious noise without needing a paid-tier
 * scam classifier.
 */
type SolanaScanResult =
  | { ok: true; rows: NftPortfolioRow[]; truncated: boolean }
  | { ok: false; reason: string; setupHint?: boolean };

async function scanSolana(solanaWallet: string): Promise<SolanaScanResult> {
  try {
    const res = await getAssetsByOwner({
      ownerAddress: solanaWallet,
      page: 1,
      limit: 1000,
    });
    const byCollection = new Map<string, NftPortfolioRow>();
    for (const a of res.items) {
      // Server-side filter SHOULD have dropped fungible tokens, but be
      // defensive — Helius occasionally surfaces ambiguous interface
      // labels on programmable assets.
      if (
        a.interface === "FungibleToken" ||
        a.interface === "FungibleAsset"
      ) {
        continue;
      }
      const collectionGroup = a.grouping?.find(
        (g) => g.group_key === "collection",
      );
      const collectionId = collectionGroup?.group_value;
      if (!collectionId) {
        // Non-grouped 1/1 piece — skip the per-collection rollup. Could
        // surface as a synthetic "(ungrouped)" row, but the agent
        // already treats `tokenCount` as the salient field and an
        // ungrouped 1/1 doesn't need its own row in the rollup.
        continue;
      }
      const existing = byCollection.get(collectionId);
      if (existing) {
        existing.tokenCount += 1;
      } else {
        byCollection.set(collectionId, {
          chain: "solana",
          contractAddress: collectionId,
          ...(a.content?.metadata?.name
            ? { collectionName: a.content.metadata.name }
            : {}),
          ...(a.content?.metadata?.symbol
            ? { collectionSlug: a.content.metadata.symbol }
            : {}),
          ...(a.content?.links?.image
            ? { collectionImage: a.content.links.image }
            : {}),
          tokenCount: 1,
        });
      }
    }
    const rows = Array.from(byCollection.values());
    const truncated = res.total > res.items.length;
    return { ok: true, rows, truncated };
  } catch (e) {
    if (e instanceof HeliusNotConfiguredError) {
      return { ok: false, reason: "helius_not_configured", setupHint: true };
    }
    if (e instanceof HeliusRateLimitedError) {
      return { ok: false, reason: "rate_limited" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, reason: msg };
  }
}

export async function getNftPortfolio(
  args: GetNftPortfolioArgs,
): Promise<NftPortfolioResult> {
  if (!args.wallet && !args.solanaWallet) {
    throw new Error(
      "get_nft_portfolio requires at least one of `wallet` (EVM) or " +
        "`solanaWallet` (Solana base58).",
    );
  }
  const wallet = args.wallet;
  // EVM scan only fires when the user supplied an EVM wallet.
  const evmChains = wallet
    ? ((args.chains ?? SUPPORTED_CHAINS) as SupportedChain[])
    : [];

  const evmResultsPromise = wallet
    ? Promise.allSettled(evmChains.map((c) => scanChain(c, wallet)))
    : Promise.resolve([] as PromiseSettledResult<ChainScanOk | ChainScanErr>[]);
  const solanaResultPromise = args.solanaWallet
    ? scanSolana(args.solanaWallet)
    : null;

  const [evmResults, solanaResult] = await Promise.all([
    evmResultsPromise,
    solanaResultPromise,
  ]);

  const rows: NftPortfolioRow[] = [];
  const coverage: NftPortfolioResult["coverage"] = [];
  let rateLimitedAny = false;
  let solanaSetupHint = false;
  let solanaTruncated = false;
  for (let i = 0; i < evmResults.length; i++) {
    const c = evmChains[i];
    const r = evmResults[i];
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      coverage.push({ chain: c, errored: true, reason });
      continue;
    }
    if (!r.value.ok) {
      coverage.push({ chain: c, errored: true, reason: r.value.reason });
      if (r.value.reason === "rate_limited") rateLimitedAny = true;
      continue;
    }
    coverage.push({ chain: c, errored: false });
    rows.push(...r.value.rows);
  }
  if (solanaResult) {
    if (solanaResult.ok) {
      coverage.push({ chain: "solana", errored: false });
      rows.push(...solanaResult.rows);
      solanaTruncated = solanaResult.truncated;
    } else {
      coverage.push({
        chain: "solana",
        errored: true,
        reason: solanaResult.reason,
      });
      if (solanaResult.setupHint) solanaSetupHint = true;
    }
  }

  // Apply filters. EVM-only — Solana rows have no floor pricing in v1
  // (#433 deferred), so `minFloorEth` would always drop them; skip
  // Solana rows from the floor filter and from the EVM-collection
  // whitelist (which uses EVM contract addresses).
  let filtered = rows;
  if (typeof args.minFloorEth === "number") {
    filtered = filtered.filter((r) => {
      if (r.chain === "solana") return true;
      return typeof r.floorEth === "number" && r.floorEth >= args.minFloorEth!;
    });
  }
  if (args.collections && args.collections.length > 0) {
    const allow = new Set(args.collections.map((a) => a.toLowerCase()));
    filtered = filtered.filter((r) => {
      if (r.chain === "solana") return true;
      return allow.has(r.contractAddress.toLowerCase());
    });
  }

  // Sort by total floor USD descending — biggest-exposure-first matches
  // the security-audit / portfolio-rollup framing. Solana rows (no
  // floor) tail-sort.
  filtered.sort((a, b) => (b.totalFloorUsd ?? 0) - (a.totalFloorUsd ?? 0));

  const totalFloorUsd = round2(
    filtered.reduce((sum, r) => sum + (r.totalFloorUsd ?? 0), 0),
  );
  const totalTokenCount = filtered.reduce((sum, r) => sum + r.tokenCount, 0);

  const allChains = [
    ...evmChains.map((c) => c as string),
    ...(args.solanaWallet ? ["solana"] : []),
  ];

  const notes: string[] = [];
  notes.push(
    "Floor != liquidation. The `totalFloorUsd` rollup is an upper-bound " +
      "estimate based on each collection's lowest currently-listed ask. " +
      "Selling a held NFT typically means hitting an existing bid (a few " +
      "percent below floor) or accepting a sweep at a discount; treat the " +
      "total as 'best case before slippage', not 'what I'd net selling now'.",
  );
  if (args.solanaWallet && (solanaResult?.ok || solanaSetupHint)) {
    notes.push(
      "Solana rows have no floor pricing in v1 — Magic Eden / Tensor " +
        "integration is tracked as a follow-up to #433. `tokenCount` and " +
        "collection metadata are accurate; `totalFloorUsd` only reflects " +
        "EVM exposure.",
    );
  }
  if (solanaSetupHint) {
    notes.push(
      "Solana branch refused: Helius DAS requires a Helius API key. The " +
        "public Solana mainnet endpoint does not expose DAS. Set a key via " +
        "`set_helius_api_key({ apiKey: \"<uuid>\" })` (demo mode) or " +
        "`vaultpilot-mcp-setup` (persisted). Free tier is enough — see " +
        "https://dashboard.helius.dev/.",
    );
  }
  if (solanaTruncated) {
    notes.push(
      "Solana wallet has more than 1000 assets — only the first page was " +
        "fetched. v2 pagination is a follow-up; for now, the per-collection " +
        "rollup may undercount very large wallets.",
    );
  }
  if (rateLimitedAny) {
    notes.push(RESERVOIR_SETUP_HINT);
  }
  if (filtered.length === 0) {
    if (rows.length > 0) {
      notes.push(
        "All collections were filtered out by `minFloorEth` and/or " +
          "`collections`. Loosen the filter to see them.",
      );
    } else {
      notes.push(
        "No NFTs found for this wallet on the requested chain(s). Either " +
          "the wallet doesn't hold any, or per-chain reads errored — check " +
          "`coverage[]`.",
      );
    }
  }

  return {
    wallet: wallet ?? "",
    ...(args.solanaWallet ? { solanaWallet: args.solanaWallet } : {}),
    chains: allChains,
    totalFloorUsd,
    collectionCount: filtered.length,
    totalTokenCount,
    rows: filtered,
    coverage,
    notes,
  };
}

// ---- get_nft_collection --------------------------------------------

function projectCollection(
  chain: SupportedChain,
  contractAddress: string,
  c: ReservoirCollection,
): NftCollectionInfo {
  const floor = c.floorAsk?.price;
  const topBid = c.topBid?.price;
  return {
    chain,
    contractAddress,
    ...(c.name ? { name: c.name } : {}),
    ...(c.slug ? { slug: c.slug } : {}),
    ...(c.symbol ? { symbol: c.symbol } : {}),
    ...(c.description ? { description: c.description } : {}),
    ...(c.image ? { image: c.image } : {}),
    ...(c.tokenCount !== undefined
      ? { tokenCount: Number(c.tokenCount) }
      : {}),
    ...(c.ownerCount !== undefined ? { ownerCount: c.ownerCount } : {}),
    ...(typeof floor?.amount?.decimal === "number"
      ? { floorEth: floor.amount.decimal }
      : {}),
    ...(typeof floor?.amount?.usd === "number"
      ? { floorUsd: round2(floor.amount.usd) }
      : {}),
    ...(floor?.currency?.symbol ? { floorCurrency: floor.currency.symbol } : {}),
    ...(typeof topBid?.amount?.decimal === "number"
      ? { topBidEth: topBid.amount.decimal }
      : {}),
    ...(typeof topBid?.amount?.usd === "number"
      ? { topBidUsd: round2(topBid.amount.usd) }
      : {}),
    ...(typeof c.volume?.["1day"] === "number"
      ? { volume24hEth: c.volume["1day"] }
      : {}),
    ...(typeof c.volume?.["7day"] === "number"
      ? { volume7dEth: c.volume["7day"] }
      : {}),
    ...(typeof c.volume?.["30day"] === "number"
      ? { volume30dEth: c.volume["30day"] }
      : {}),
    ...(typeof c.volume?.allTime === "number"
      ? { volumeAllTimeEth: c.volume.allTime }
      : {}),
    ...(typeof c.royalties?.bps === "number"
      ? { royaltyBps: c.royalties.bps }
      : {}),
    ...(c.royalties?.recipient
      ? { royaltyRecipient: c.royalties.recipient }
      : {}),
    notes: [],
  };
}

export async function getNftCollection(
  args: GetNftCollectionArgs,
): Promise<NftCollectionInfo> {
  const chain = args.chain as SupportedChain;
  const contractAddress = args.contractAddress;
  let res: ReservoirCollectionsResponse;
  try {
    res = await reservoirFetch<ReservoirCollectionsResponse>({
      chain,
      path: `/collections/v7`,
      query: { contract: contractAddress, limit: 1 },
    });
  } catch (e) {
    if (e instanceof ReservoirRateLimitedError) {
      throw new Error(
        `Reservoir rate-limited the collection lookup. ${RESERVOIR_SETUP_HINT}`,
      );
    }
    throw e;
  }
  const c = res.collections[0];
  if (!c) {
    throw new Error(
      `No Reservoir collection found at ${contractAddress} on ${chain}. ` +
        `Either the contract isn't an NFT, isn't indexed, or the chain is wrong.`,
    );
  }
  const info = projectCollection(chain, contractAddress, c);
  if (info.floorEth === undefined) {
    info.notes.push(
      "No active listings — `floorEth` / `floorUsd` are absent. The " +
        "collection may exist on-chain but currently have no asks.",
    );
  }
  if (info.royaltyBps !== undefined && info.royaltyBps > 0) {
    info.notes.push(
      `Secondary-sale royalty: ${(info.royaltyBps / 100).toFixed(2)}% to ${info.royaltyRecipient ?? "(creator)"}.`,
    );
  }
  return info;
}

// ---- get_nft_listings (issue #569) ---------------------------------

function projectAsk(
  chain: SupportedChain,
  contractAddress: string,
  o: ReservoirAskOrder,
): NftListingRow | null {
  const tokenId = o.criteria?.data?.token?.tokenId;
  if (!tokenId) {
    // Collection-bid criteria (no concrete tokenId) — drop. The "buy
    // N cheapest" question only makes sense against single-token asks,
    // and surfacing collection-criteria orders without a tokenId would
    // give the agent rows it can't reference unambiguously.
    return null;
  }
  const priceEth = o.price?.amount?.decimal;
  const priceUsd = o.price?.amount?.usd;
  const validUntil = o.validUntil;
  return {
    orderId: o.id,
    contractAddress,
    tokenId,
    ...(typeof priceEth === "number" ? { priceEth } : {}),
    ...(typeof priceUsd === "number" ? { priceUsd: round2(priceUsd) } : {}),
    ...(o.price?.currency?.symbol ? { priceCurrency: o.price.currency.symbol } : {}),
    ...(o.source?.domain ? { listingSource: o.source.domain } : {}),
    ...(o.source?.name ? { listingSourceName: o.source.name } : {}),
    makerAddress: o.maker,
    ...(typeof validUntil === "number" ? { validUntil } : {}),
    ...(typeof validUntil === "number"
      ? { validUntilIso: new Date(validUntil * 1000).toISOString() }
      : {}),
    ...(o.kind ? { orderKind: o.kind } : {}),
  };
}

export async function getNftListings(
  args: GetNftListingsArgs,
): Promise<NftListingsResult> {
  const chain = args.chain as SupportedChain;
  const contractAddress = args.contractAddress;
  const limit = args.limit;

  // Over-fetch by 1 so we can detect truncation when collection-bid
  // criteria orders get filtered out: ask for `limit + 1` raw, return
  // up to `limit` valid rows, mark `truncated` if Reservoir said there
  // was more OR we filtered any out at the boundary.
  const rawLimit = Math.min(limit + 1, 50);

  let res: ReservoirOrdersAsksResponse;
  try {
    res = await reservoirFetch<ReservoirOrdersAsksResponse>({
      chain,
      path: `/orders/asks/v5`,
      query: {
        contracts: contractAddress,
        status: "active",
        sortBy: "price",
        sortDirection: "asc",
        limit: rawLimit,
      },
    });
  } catch (e) {
    if (e instanceof ReservoirRateLimitedError) {
      throw new Error(
        `Reservoir rate-limited the listings lookup. ${RESERVOIR_SETUP_HINT}`,
      );
    }
    throw e;
  }

  const projected: NftListingRow[] = [];
  for (const o of res.orders) {
    const row = projectAsk(chain, contractAddress, o);
    if (row) projected.push(row);
    if (projected.length >= limit) break;
  }

  const truncated =
    !!res.continuation || res.orders.length > projected.length;

  const notes: string[] = [];
  if (projected.length === 0) {
    notes.push(
      "No active listings for this collection on " +
        chain +
        ". The collection may exist on-chain but currently have no asks " +
        "(Reservoir's `/orders/asks/v5` filtered to status=active returned 0 rows). " +
        "Re-check after listings repopulate, or use `get_nft_collection` for " +
        "collection-level vitals (floor / volume / holders) instead.",
    );
  }
  notes.push(
    "Read-only display tool. VaultPilot does not yet expose an NFT-buy " +
      "preparation flow — Seaport / blur / x2y2 marketplace fills require " +
      "EIP-712 typed-data signing, gated on the typed-data clear-sign " +
      "defenses tracked at #453. Use these rows for research / candidate " +
      "selection; execute the buy via the listing's marketplace UI " +
      "(`listingSource` field) until the prepare flow lands.",
  );
  notes.push(
    "Page size is schema-capped at 10. Validate that any `rows[i]` you " +
      "reference exists in this response — do NOT extrapolate beyond " +
      "`rows.length`. Issue #569 fabrication-resistance guard.",
  );

  return {
    chain,
    contractAddress,
    rows: projected,
    truncated,
    notes,
  };
}

// ---- get_nft_history -----------------------------------------------

const ACTIVITY_TYPE_MAP: Record<string, NftHistoryItemType> = {
  mint: "mint",
  sale: "sale",
  transfer: "transfer",
  ask: "ask",
  bid: "bid",
  ask_cancel: "ask_cancel",
  bid_cancel: "bid_cancel",
};

function projectActivity(
  chain: SupportedChain,
  a: ReservoirActivityItem,
): NftHistoryItem {
  const type = ACTIVITY_TYPE_MAP[a.type] ?? "other";
  const priceEth = a.price?.amount?.decimal;
  const priceUsd = a.price?.amount?.usd;
  return {
    chain,
    type,
    timestamp: a.timestamp,
    timestampIso: new Date(a.timestamp * 1000).toISOString(),
    ...(a.contract ? { contractAddress: a.contract } : {}),
    ...(a.collection?.collectionName
      ? { collectionName: a.collection.collectionName }
      : {}),
    ...(a.token?.tokenId ? { tokenId: a.token.tokenId } : {}),
    ...(a.token?.tokenName ? { tokenName: a.token.tokenName } : {}),
    ...(a.fromAddress ? { fromAddress: a.fromAddress } : {}),
    ...(a.toAddress ? { toAddress: a.toAddress } : {}),
    ...(typeof priceEth === "number" ? { priceEth } : {}),
    ...(typeof priceUsd === "number" ? { priceUsd: round2(priceUsd) } : {}),
    ...(a.price?.currency?.symbol
      ? { priceCurrency: a.price.currency.symbol }
      : {}),
    ...(a.txHash ? { txHash: a.txHash } : {}),
  };
}

interface HistoryScanOk {
  chain: SupportedChain;
  ok: true;
  items: NftHistoryItem[];
}
interface HistoryScanErr {
  chain: SupportedChain;
  ok: false;
  reason: string;
}

async function scanHistoryChain(
  chain: SupportedChain,
  wallet: string,
  limit: number,
): Promise<HistoryScanOk | HistoryScanErr> {
  try {
    const res = await reservoirFetch<ReservoirUsersActivityResponse>({
      chain,
      path: `/users/${wallet}/activity/v6`,
      query: {
        limit: Math.min(limit, ACTIVITY_PAGE_SIZE),
        sortBy: "eventTimestamp",
      },
    });
    return {
      chain,
      ok: true,
      items: res.activities.map((a) => projectActivity(chain, a)),
    };
  } catch (e) {
    if (e instanceof ReservoirRateLimitedError) {
      return { chain, ok: false, reason: "rate_limited" };
    }
    const msg = e instanceof Error ? e.message : String(e);
    return { chain, ok: false, reason: msg };
  }
}

export async function getNftHistory(
  args: GetNftHistoryArgs,
): Promise<NftHistoryResult> {
  const wallet = args.wallet;
  const chains = (args.chains ?? SUPPORTED_CHAINS) as SupportedChain[];
  const limit = args.limit;

  const results = await Promise.allSettled(
    chains.map((c) => scanHistoryChain(c, wallet, limit)),
  );

  const items: NftHistoryItem[] = [];
  const coverage: NftHistoryResult["coverage"] = [];
  let rateLimitedAny = false;
  for (let i = 0; i < results.length; i++) {
    const c = chains[i];
    const r = results[i];
    if (r.status === "rejected") {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      coverage.push({ chain: c, errored: true, reason });
      continue;
    }
    if (!r.value.ok) {
      coverage.push({ chain: c, errored: true, reason: r.value.reason });
      if (r.value.reason === "rate_limited") rateLimitedAny = true;
      continue;
    }
    coverage.push({ chain: c, errored: false });
    items.push(...r.value.items);
  }

  // Merge desc by timestamp; truncate to the requested limit.
  items.sort((a, b) => b.timestamp - a.timestamp);
  const truncated = items.length > limit;
  const finalItems = truncated ? items.slice(0, limit) : items;

  const notes: string[] = [];
  if (rateLimitedAny) notes.push(RESERVOIR_SETUP_HINT);
  if (finalItems.length === 0) {
    notes.push(
      "No NFT activity found on the requested chain(s). Either the wallet " +
        "has no NFT history, or per-chain Reservoir reads errored — check " +
        "`coverage[]`.",
    );
  }

  return {
    wallet,
    chains: chains as string[],
    items: finalItems,
    truncated,
    coverage,
    notes,
  };
}
