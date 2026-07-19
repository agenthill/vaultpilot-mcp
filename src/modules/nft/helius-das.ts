/**
 * Helius DAS (Digital Asset Standard) read-only client. Powers the
 * Solana branch of `get_nft_portfolio` (issue #433). Same Helius API
 * key the existing `set_helius_api_key` tool / `~/.vaultpilot-mcp/
 * config.json#solanaRpcUrl` already manage — DAS lives at the same
 * `https://mainnet.helius-rpc.com/?api-key=KEY` endpoint as the
 * Solana JSON-RPC, just behind different methods (`getAssetsByOwner`
 * etc.).
 *
 * Scope of this PR (#433): only `getAssetsByOwner`, the bare minimum
 * for the portfolio enumerator. `getSignaturesForAsset` (history) and
 * `getAsset` (collection metadata) are tracked as separate follow-up
 * issues per the deferred-scope plan; not implemented here.
 */
import { resolveSolanaRpcUrl } from "../../config/chains.js";
import { readUserConfig } from "../../config/user-config.js";

const PUBLIC_MAINNET_URL = "https://api.mainnet-beta.solana.com";
const REQUEST_TIMEOUT_MS = 8000;

/**
 * Subset of the DAS asset shape we actually project. Helius returns
 * many more fields per asset (royalties, supply, mutability, etc.) —
 * we narrow to the shape `get_nft_portfolio` needs and ignore the
 * rest. See https://docs.helius.dev/compression-and-das-api/digital-
 * asset-standard-das-api/get-assets-by-owner for the full schema.
 */
export interface HeliusAsset {
  id: string;
  /**
   * `V1_NFT` / `ProgrammableNFT` / `MplCoreAsset` / `Custom` / etc.
   * `FungibleToken` / `FungibleAsset` are filtered server-side by
   * `displayOptions.showFungible: false`, but we double-check on the
   * client.
   */
  interface: string;
  content?: {
    metadata?: {
      name?: string;
      symbol?: string;
    };
    links?: {
      image?: string;
    };
  };
  grouping?: Array<{
    group_key: string;
    group_value?: string;
  }>;
  compression?: {
    compressed?: boolean;
  };
}

export interface GetAssetsByOwnerResult {
  items: HeliusAsset[];
  total: number;
  limit: number;
  page: number;
}

/**
 * Thrown when the resolved Solana RPC URL is the public-mainnet
 * fallback. DAS methods are not exposed on the public endpoint;
 * surface a clear setup hint so the user knows they need a free
 * Helius key to use this branch.
 */
export class HeliusNotConfiguredError extends Error {
  constructor() {
    super(
      "Helius API key not configured — Solana NFT enumeration requires the " +
        "Helius DAS API at mainnet.helius-rpc.com, which the public Solana " +
        "endpoint (api.mainnet-beta.solana.com) does NOT serve. Set a Helius " +
        "key via `set_helius_api_key({ apiKey: \"<uuid>\" })` (demo mode) or " +
        "`vaultpilot-mcp-setup` (persisted). Free tier is plenty for this; " +
        "see https://dashboard.helius.dev/.",
    );
    this.name = "HeliusNotConfiguredError";
  }
}

/** Thrown on HTTP 429 / Helius-quoted rate-limit codes. */
export class HeliusRateLimitedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HeliusRateLimitedError";
  }
}

/**
 * Resolve the Helius DAS endpoint URL. Returns `null` when only the
 * public-fallback Solana RPC is configured — DAS is not available
 * there, so callers should refuse the call with a setup hint.
 */
export function resolveHeliusUrl(): string | null {
  const url = resolveSolanaRpcUrl(readUserConfig());
  if (url === PUBLIC_MAINNET_URL) return null;
  return url;
}

/**
 * Test seam — lets test fixtures swap the underlying fetch without
 * patching `globalThis.fetch`. Returns `null` to fall back to the
 * default fetch.
 */
type FetchFn = typeof fetch;
let fetchOverride: FetchFn | null = null;

export function _setFetchForTests(fn: FetchFn | null): void {
  fetchOverride = fn;
}

/**
 * DAS `getAssetsByOwner`. One JSON-RPC call. Helius caps `limit` at
 * 1000; most wallets fit comfortably in one page, so we fetch one
 * page and let the caller flag truncation when `total > limit`.
 */
export async function getAssetsByOwner(args: {
  ownerAddress: string;
  page?: number;
  limit?: number;
}): Promise<GetAssetsByOwnerResult> {
  const url = resolveHeliusUrl();
  if (url === null) throw new HeliusNotConfiguredError();
  // #714: reviewed exception — the `f(...)` call below threads its own
  // AbortController-backed signal (INV-T1's thread-an-AbortSignal
  // alternative); ARCHITECTURE.md §4 INV-T1 names this aliasing test seam
  // by file, must not be flagged.
  // eslint-disable-next-line no-restricted-syntax
  const f = fetchOverride ?? globalThis.fetch;
  if (typeof f !== "function") {
    throw new Error("Global fetch is not available in this runtime.");
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let res: Response;
  try {
    res = await f(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "vaultpilot",
        method: "getAssetsByOwner",
        params: {
          ownerAddress: args.ownerAddress,
          page: args.page ?? 1,
          limit: Math.min(args.limit ?? 1000, 1000),
          displayOptions: {
            showCollectionMetadata: true,
            showFungible: false,
          },
        },
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 429) {
    throw new HeliusRateLimitedError(
      "Helius rate-limited the DAS call (HTTP 429). Free-tier limits hit; " +
        "wait a moment and retry, or upgrade the Helius plan.",
    );
  }
  if (!res.ok) {
    throw new Error(
      `Helius DAS getAssetsByOwner failed: HTTP ${res.status} ${res.statusText}`,
    );
  }
  const body = (await res.json()) as {
    result?: GetAssetsByOwnerResult;
    error?: { code?: number; message?: string };
  };
  if (body.error) {
    const msg = body.error.message ?? "unknown error";
    if (
      body.error.code === -32429 ||
      /rate.?limit|too many requests|quota|throttl/i.test(msg)
    ) {
      throw new HeliusRateLimitedError(`Helius DAS rate-limited: ${msg}`);
    }
    throw new Error(`Helius DAS getAssetsByOwner JSON-RPC error: ${msg}`);
  }
  if (!body.result) {
    throw new Error(
      "Helius DAS getAssetsByOwner returned no `result` field — unexpected shape.",
    );
  }
  return body.result;
}
