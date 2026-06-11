import { createPublicClient, http, type PublicClient, type Transport } from "viem";
import { resolveRpcUrl, VIEM_CHAINS } from "../config/chains.js";
import { readUserConfig, onRpcConfigChange } from "../config/user-config.js";
import { CHAIN_IDS, type SupportedChain } from "../types/index.js";
import {
  recordRateLimit,
  resetRateLimitTracker,
  type RateLimitSource,
} from "./rate-limit-tracker.js";

/**
 * Type-narrowing predicate: which `SupportedChain`s does the
 * rate-limit tracker know about? All current ones, but kept explicit
 * so adding a new chain to `SupportedChain` without updating
 * `RateLimitSource` is a compile-time error rather than a silent skip.
 */
function isTrackedEvmChain(
  chain: SupportedChain,
): chain is Extract<RateLimitSource, { kind: "evm" }>["chain"] {
  return (
    chain === "ethereum" ||
    chain === "arbitrum" ||
    chain === "polygon" ||
    chain === "base" ||
    chain === "optimism"
  );
}

/**
 * Detect a rate-limit error from a thrown viem RPC failure. viem
 * surfaces HTTP 429 as `HttpRequestError` with `.status === 429`
 * after its internal retries are exhausted; some providers (Alchemy,
 * Infura) instead return a JSON-RPC error with code -32005 ("request
 * limit exceeded") which viem wraps as an `RpcRequestError`. We accept
 * either shape — the goal is "did the upstream throttle us", not
 * "exact wire shape".
 */
function isRateLimitNode(node: { status?: number; code?: number }): boolean {
  return node.status === 429 || node.code === -32005;
}

function isRateLimitError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as {
    status?: number;
    code?: number;
    cause?: { status?: number; code?: number; cause?: { status?: number; code?: number } };
  };
  if (isRateLimitNode(e)) return true;
  if (e.cause && isRateLimitNode(e.cause)) return true;
  // viem sometimes nests further (HttpRequestError → cause → cause).
  if (e.cause?.cause && isRateLimitNode(e.cause.cause)) return true;
  return false;
}

const clients = new Map<SupportedChain, PublicClient>();
const verifiedChains = new Set<SupportedChain>();

/**
 * Default per-chain concurrency cap — the hard ceiling on how many RPC
 * requests can be in flight against a single chain's endpoint at once.
 * Empirically the #88 trace kept hitting 429s at cap=4 on free-tier
 * Infura, even after the Morpho opt-in and the Compound probe-first
 * flow cut total request volume. Free-tier endpoints tolerate brief
 * bursts but not sustained ~10 req/s (what 4 concurrent at ~400ms each
 * produces during a multi-wallet portfolio fan-out).
 *
 * Lowered to 2 as the safe default. Users on premium endpoints can
 * raise via VAULTPILOT_RPC_CONCURRENCY and regain the parallelism.
 * Separate limiter per chain so saturated mainnet doesn't back-pressure
 * independent arbitrum reads.
 */
const RPC_CONCURRENCY_DEFAULT = 2;
const RPC_CONCURRENCY = (() => {
  const raw = process.env.VAULTPILOT_RPC_CONCURRENCY;
  if (!raw) return RPC_CONCURRENCY_DEFAULT;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : RPC_CONCURRENCY_DEFAULT;
})();

/**
 * Minimal FIFO semaphore. `acquire()` resolves as soon as a slot is free;
 * callers must call `release()` exactly once per acquire to avoid deadlock.
 * Kept tiny — no timeouts, no cancellation — because the only call sites
 * are inside the transport wrapper below and always run to completion via
 * a try/finally.
 */
class Semaphore {
  private active = 0;
  private waiting: Array<() => void> = [];
  constructor(private readonly max: number) {}
  acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.active++;
        resolve();
      });
    });
  }
  release(): void {
    this.active--;
    const next = this.waiting.shift();
    if (next) next();
  }
}

const limiters = new Map<SupportedChain, Semaphore>();
function getLimiter(chain: SupportedChain): Semaphore {
  const existing = limiters.get(chain);
  if (existing) return existing;
  const limiter = new Semaphore(RPC_CONCURRENCY);
  limiters.set(chain, limiter);
  return limiter;
}

// Invalidate cached clients + the verified-chains memo whenever the user
// rewrites their rpc config, so the next call re-resolves URLs and re-runs
// chain-id verification. `onRpcConfigChange` accepts a single hook; rpc.ts
// owns it because it owns the cache.
// Also clear the per-chain limiters — stale in-flight counts from a
// previous URL shouldn't throttle reads against the new one.
onRpcConfigChange(() => {
  clients.clear();
  verifiedChains.clear();
  limiters.clear();
  // Drop accumulated 429 counts too — once the user adds an API key,
  // historical hits against the previous (default) endpoint are
  // irrelevant to whether the new endpoint is also being throttled.
  resetRateLimitTracker();
});

/**
 * Wrap viem's `http` transport with a per-chain concurrency limiter.
 * Every outbound RPC request acquires a slot from the chain's semaphore
 * before hitting the wire and releases after — bounding instantaneous
 * pressure regardless of how the caller fanned out (multi-wallet ×
 * multi-subsystem × multi-market produces the highest burst; that was
 * the #88 trigger). viem doesn't expose a custom-fetch hook on its http
 * transport, so we wrap the transport's `request` method at the point
 * where every call funnels through it.
 */
function limitedHttp(chain: SupportedChain, url: string, httpOpts: {
  batch: boolean;
  retryCount: number;
  retryDelay: number;
}): Transport {
  const base = http(url, httpOpts);
  const limiter = getLimiter(chain);
  const wrapped: Transport = ((config) => {
    const inner = base(config);
    const originalRequest = inner.request.bind(inner);
    return {
      ...inner,
      request: (async (args: Parameters<typeof originalRequest>[0]) => {
        await limiter.acquire();
        try {
          return await originalRequest(args);
        } catch (err) {
          // Tag rate-limit errors with the source-chain. This is what
          // surfaces a setup-key nudge to the user via
          // `get_vaultpilot_config_status`. We re-throw the original
          // error untouched — this is purely an observability hook.
          if (isRateLimitError(err) && isTrackedEvmChain(chain)) {
            recordRateLimit({ kind: "evm", chain });
          }
          throw err;
        } finally {
          limiter.release();
        }
      }) as typeof inner.request,
    };
  }) as Transport;
  return wrapped;
}

/**
 * Get (or lazily create) a viem PublicClient for the given chain.
 * Throws RpcConfigError if the chain has no RPC configured.
 */
export function getClient(chain: SupportedChain): PublicClient {
  const cached = clients.get(chain);
  if (cached) return cached;

  const userConfig = readUserConfig();
  const url = resolveRpcUrl(chain, userConfig);
  // Do NOT set `batch: true` by default. JSON-RPC batching works on Infura/Alchemy but is
  // silently mis-handled by many public endpoints — we saw calls like getUserAccountData,
  // NPM.balanceOf, Multicall3.aggregate3 return 0x under load, purely because they were
  // coalesced into a batched POST the provider couldn't fulfill. Individual eth_call
  // requests are slower but never ghost-fail. Users on premium endpoints can opt back in
  // via RPC_BATCH=1. Multicall3 still batches at the contract layer regardless.
  const batchEnabled = process.env.RPC_BATCH === "1";
  // retryCount/retryDelay: viem's http transport retries on 429 (and
  // other transient 4xx/5xx) with exponential backoff — the predicate
  // in viem's `shouldRetry` already includes 429, 503, 504, etc. An
  // earlier iteration at 5/600 made wall-clock pain far worse because
  // hundreds of parallel calls were each multiplying 18s of blocked
  // retry; reverted to 3/500. Now that we've cut the parallelism-at-
  // source (cross-wallet batch probe, Morpho opt-in, cap=2 limiter),
  // the remaining requests are the ones that matter — so a modest bump
  // to 4/700 gives us a ~10.5s worst case (700/1400/2800/5600 backoff)
  // that rides out sustained free-tier saturation without the pre-
  // reduction death spiral. User's explicit ask on the #88 trace:
  // "make sure that rate limited requests retried" — framework-level
  // 429 retry was already happening; this just extends the window.
  const client = createPublicClient({
    chain: VIEM_CHAINS[chain],
    transport: limitedHttp(chain, url, {
      batch: batchEnabled,
      retryCount: 4,
      retryDelay: 700,
    }),
  });
  clients.set(chain, client);
  return client;
}

/**
 * Verify the RPC endpoint actually speaks the chain we think it does. A wrong-
 * chain RPC would happily sign "ETH" txs against (say) a fork or BSC — values
 * and addresses overlap but token semantics don't, and the user would end up
 * sending real ETH against what they thought was a testnet. We do this on the
 * first live call per chain, memoize it, and throw loud if it mismatches.
 */
export async function verifyChainId(chain: SupportedChain): Promise<void> {
  if (verifiedChains.has(chain)) return;
  const client = getClient(chain);
  const actual = await client.getChainId();
  const expected = CHAIN_IDS[chain];
  if (actual !== expected) {
    throw new Error(
      `RPC for ${chain} returned chainId ${actual}, expected ${expected}. ` +
        `The configured endpoint does NOT point at ${chain} — refusing to proceed. ` +
        `Fix via \`vaultpilot-mcp-setup\` or the relevant env var.`
    );
  }
  verifiedChains.add(chain);
}

/** Invalidate the cached clients — useful after the user re-runs setup. */
export function resetClients(): void {
  clients.clear();
  verifiedChains.clear();
}
