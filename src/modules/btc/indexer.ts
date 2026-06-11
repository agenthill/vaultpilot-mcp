import { fetchWithTimeout } from "../../data/http.js";
import { BITCOIN_DEFAULT_INDEXER_URL } from "../../config/btc.js";
import { readUserConfig } from "../../config/user-config.js";

/**
 * Bitcoin indexer abstraction. Single interface, mempool.space (default)
 * + any Esplora-compatible endpoint as the impl. Self-hosted Esplora /
 * Electrs all expose the same REST surface — mempool.space's API is a
 * fork of Blockstream Esplora's, with a few additions (fee
 * recommendations, mempool stats) that we use.
 *
 * URL resolution priority (highest first):
 *   1. `BITCOIN_INDEXER_URL` env var
 *   2. `userConfig.bitcoinIndexerUrl`
 *   3. `BITCOIN_DEFAULT_INDEXER_URL` (mempool.space)
 *
 * Phase 1 scope: read-only. PR3 adds `getUtxos` + `getRawTx` for
 * coin-selection and PSBT input population, plus `broadcastTx` for the
 * send path.
 */

/**
 * Esplora address-stats payload. Both confirmed and mempool stats are
 * present; we sum them to surface a "total balance" alongside the
 * confirmed-only number. mempool.space prefers `chain_stats` /
 * `mempool_stats` field naming (forked from Blockstream).
 */
interface EsploraAddressStats {
  /** Address — echoed back. */
  address: string;
  /** Confirmed: funds that have at least 1 confirmation. */
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  /** Unconfirmed: funds in mempool, not yet mined. */
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

/**
 * Bitcoin balance for a single address. Confirmed + unconfirmed reported
 * separately so the caller can decide UX (typically: show confirmed as
 * the headline, surface unconfirmed only when non-zero).
 */
export interface BitcoinAddressBalance {
  address: string;
  /** Confirmed funded - confirmed spent, in sats. Always ≥ 0. */
  confirmedSats: bigint;
  /** Mempool funded - mempool spent, in sats. Can be negative when funds are in-flight as spent. */
  mempoolSats: bigint;
  /** Confirmed + mempool. Convenience field. */
  totalSats: bigint;
  /** Total tx count this address has been involved in (confirmed + mempool). */
  txCount: number;
}

/**
 * Fee-rate estimates in sat/vB. Returned by mempool.space's
 * `/v1/fees/recommended` endpoint — these match the labels the mempool.space
 * UI shows ("High Priority" / "Medium Priority" / etc.) so users see
 * familiar terminology.
 */
export interface BitcoinFeeEstimates {
  /** ~next-block target. */
  fastestFee: number;
  /** ~3 blocks (~30 min). */
  halfHourFee: number;
  /** ~6 blocks (~1 hour). */
  hourFee: number;
  /** Lowest fee miners are still including. */
  economyFee: number;
  /** Floor below which a tx is unlikely to ever confirm. */
  minimumFee: number;
}

/**
 * Tx history entry. Subset of the Esplora `/address/<addr>/txs` payload
 * we surface — enough for portfolio history rendering without forcing
 * callers to learn the full SAT/RBF/witness shape.
 */
export interface BitcoinTxHistoryEntry {
  txid: string;
  /** Sum of vouts that pay this address (the funding side). Sats. */
  receivedSats: bigint;
  /** Sum of vins that come from this address (the spending side). Sats. */
  sentSats: bigint;
  /** Tx fee from the Esplora payload (sats). Useful UX context. */
  feeSats: bigint;
  /** Block height — undefined when still in mempool. */
  blockHeight?: number;
  /** Unix timestamp of the block — undefined for mempool. */
  blockTime?: number;
  /** True when sequence < 0xFFFFFFFE on at least one input (BIP-125). */
  rbfEligible: boolean;
}

/**
 * Esplora vin/vout shapes we destructure. Trimmed to fields we read.
 */
export interface EsploraVin {
  txid: string;
  vout: number;
  prevout?: { scriptpubkey_address?: string; value?: number };
  sequence?: number;
}

export interface EsploraVout {
  scriptpubkey_address?: string;
  value?: number;
}

export interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
}

/**
 * UTXO entry. Esplora returns these from `/address/<addr>/utxo`.
 * `scriptPubKey` is NOT in the Esplora payload directly — we derive it
 * from the address at PSBT-build time (cheaper than a per-UTXO lookup
 * since all UTXOs for one address share the same scriptPubKey).
 */
export interface BitcoinUtxo {
  txid: string;
  vout: number;
  /** UTXO value in sats. */
  value: number;
  /** Block height of the funding tx. Undefined for mempool UTXOs. */
  blockHeight?: number;
  /** True when the UTXO is in mempool (not yet confirmed). */
  unconfirmed: boolean;
}

export interface BitcoinIndexer {
  getBalance(address: string): Promise<BitcoinAddressBalance>;
  getFeeEstimates(): Promise<BitcoinFeeEstimates>;
  /**
   * Fetch the tx history for an address. `limit` clamps how many entries
   * to walk (we paginate via the Esplora `/txs/chain/<last_seen>` cursor
   * pattern; mempool.space honors the same convention). Returns only
   * confirmed + mempool txs, oldest-first within each segment.
   */
  getAddressTxs(
    address: string,
    opts?: { limit?: number },
  ): Promise<BitcoinTxHistoryEntry[]>;
  /**
   * Fetch the UTXO set for an address. Returned newest-first (block
   * height descending). Used as the input set for coin-selection on
   * `prepare_btc_send`.
   */
  getUtxos(address: string): Promise<BitcoinUtxo[]>;
  /**
   * Broadcast a fully-signed tx hex via the indexer's `/tx` endpoint.
   * Returns the on-chain txid on success. Throws with the indexer's
   * error body on failures (most commonly: "min relay fee not met"
   * when feeRate is below the mempool floor, or "txn-already-known"
   * when re-broadcasting a tx that's already in the mempool).
   */
  broadcastTx(rawTxHex: string): Promise<string>;
  /**
   * Fetch confirmation status for a txid. Used by
   * `get_transaction_status` BTC branch — returns the confirmation
   * count at current tip when the tx is mined; returns `confirmed: false`
   * for in-mempool txs; null when the tx isn't found at all (dropped
   * or never broadcast).
   */
  getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null>;
  /**
   * Fetch the current Bitcoin chain tip — height, block hash, header
   * timestamp, etc. Two HTTP calls under the hood: `/blocks/tip/hash`
   * for the latest hash, then `/block/<hash>` for the full header
   * details. Both endpoints are aggressively cached at the indexer
   * (mempool.space + standard Esplora share the same shape).
   */
  getBlockTip(): Promise<BitcoinBlockTip>;
  /**
   * Fetch the most recent N block headers, newest-first. Backbone for
   * chain-health signals (hash_cliff, empty_block_streak, miner_concentration).
   * Esplora's `/blocks` endpoint returns 10 blocks per call from the tip;
   * this helper paginates via `/blocks/<startHeight>` to assemble up to
   * `n` blocks (capped at 200 to bound HTTP load on free-tier indexers).
   * Issue #233 v1.
   */
  getRecentBlocks(n: number): Promise<BitcoinBlockSummary[]>;
  /**
   * Fetch the raw hex of a previous transaction by txid. Required for
   * `nonWitnessUtxo` population on PSBT inputs — Ledger BTC app 2.x
   * cryptographically verifies the input amount against this prev-tx
   * (BIP-143 sighash doesn't commit to input amount, so the prev-tx is
   * the only way the device can prove a malicious offline signer didn't
   * lie about the input value to inflate the fee). Without it the device
   * surfaces a "Security risk: unverified inputs" prompt and refuses to
   * sign cleanly. Issue #213.
   */
  getTxHex(txid: string): Promise<string>;
  /**
   * Fetch the full Esplora tx shape (vin/vout/fee/status) for a single
   * txid. Used by the RBF fee-bump builder, which needs to: (1) confirm
   * the tx is still in mempool (not already mined), (2) read original
   * inputs to rebuild the same input set, (3) read original outputs to
   * preserve recipients verbatim and identify the change output, (4)
   * verify at least one input has BIP-125-eligible sequence.
   */
  getTx(txid: string): Promise<EsploraTx>;
}

/**
 * Latest mainnet block as the indexer reports it. Carries the height,
 * the 64-hex block hash, the header timestamp (unix seconds), and a
 * server-computed `ageSeconds` for UX convenience (the agent doesn't
 * need to grab system time and subtract). `medianTimePast` and
 * `difficulty` are surfaced when the indexer exposes them — both are
 * standard Esplora fields but we tolerate their absence for self-
 * hosted forks that strip them.
 */
/**
 * Subset of Esplora's per-block JSON we surface for chain-health
 * signals. Standard fields available on every Esplora-compatible
 * indexer (mempool.space, Blockstream, self-hosted Esplora).
 *
 * `pool` is mempool.space-specific (`/v1/blocks/<height>` returns it
 * but standard `/blocks/<startHeight>` does not). Surfaced as optional
 * so the `miner_concentration` signal can degrade gracefully when the
 * indexer doesn't expose pool tags.
 */
export interface BitcoinBlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  txCount: number;
  size: number;
  weight?: number;
  /** Mempool.space `extras.pool.name` (or similar) when the indexer surfaces it. Undefined on plain Esplora. */
  poolName?: string;
}

export interface BitcoinBlockTip {
  /** Block height — e.g. 946598. */
  height: number;
  /** 64-hex block hash. */
  hash: string;
  /** Block header timestamp, unix seconds. */
  timestamp: number;
  /** Server-computed `now - timestamp` at fetch time, in seconds. */
  ageSeconds: number;
  /** BIP-113 median time past, when the indexer exposes it. */
  medianTimePast?: number;
  /** Block difficulty, when the indexer exposes it. */
  difficulty?: number;
}

/**
 * Resolve the indexer base URL via env > config > default.
 */
function resolveIndexerUrl(): string {
  const fromEnv = process.env.BITCOIN_INDEXER_URL?.trim();
  if (fromEnv) return fromEnv;
  const cfg = readUserConfig();
  const fromCfg = cfg?.bitcoinIndexerUrl?.trim();
  if (fromCfg) return fromCfg;
  return BITCOIN_DEFAULT_INDEXER_URL;
}

/**
 * Convert an Esplora tx + the address it's queried for into our thin
 * history shape. The fee comes from the API directly; received/sent are
 * derived by walking vin/vout for entries that match the address.
 */
function summarizeTx(tx: EsploraTx, address: string): BitcoinTxHistoryEntry {
  let receivedSats = 0n;
  let sentSats = 0n;
  let rbfEligible = false;
  for (const v of tx.vin) {
    const seq = typeof v.sequence === "number" ? v.sequence : 0xffffffff;
    if (seq < 0xfffffffe) rbfEligible = true;
    if (v.prevout?.scriptpubkey_address === address && v.prevout.value !== undefined) {
      sentSats += BigInt(v.prevout.value);
    }
  }
  for (const v of tx.vout) {
    if (v.scriptpubkey_address === address && v.value !== undefined) {
      receivedSats += BigInt(v.value);
    }
  }
  return {
    txid: tx.txid,
    receivedSats,
    sentSats,
    feeSats: tx.fee !== undefined ? BigInt(tx.fee) : 0n,
    ...(tx.status?.block_height !== undefined ? { blockHeight: tx.status.block_height } : {}),
    ...(tx.status?.block_time !== undefined ? { blockTime: tx.status.block_time } : {}),
    rbfEligible,
  };
}

/**
 * Single retry policy for transient indexer failures (issue #199):
 *
 *   - HTTP 429 → honor `Retry-After` header (seconds, capped at 5s) or
 *     fall back to a small jittered backoff. Mempool.space's free
 *     public API throttles bursts; without a retry the burst-then-fail
 *     dynamic of `rescan_btc_account`'s 100+-way fan-out drops ~40%
 *     of probes.
 *   - Network errors / timeouts → retry once with a small jittered
 *     backoff. Doesn't help against a sustained outage but smooths
 *     the common "one packet dropped" case.
 *   - HTTP 5xx → NOT retried. A real upstream error should surface to
 *     the caller, not get silently masked. Callers can rerun the
 *     whole rescan if they want a second attempt.
 */
const ESPLORA_RETRY_BASE_MS = 400;
const ESPLORA_RETRY_JITTER_MS = 400;
const ESPLORA_MAX_RETRY_AFTER_MS = 5_000;

function parseRetryAfterMs(headerValue: string | null): number | null {
  if (!headerValue) return null;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(ESPLORA_MAX_RETRY_AFTER_MS, seconds * 1000);
  }
  // HTTP-date form is also valid for Retry-After; we ignore it (the
  // delta could be huge or negative under clock skew). Falls back to
  // the default backoff in the caller.
  return null;
}

function jitteredBackoffMs(): number {
  return ESPLORA_RETRY_BASE_MS + Math.floor(Math.random() * ESPLORA_RETRY_JITTER_MS);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class EsploraIndexer implements BitcoinIndexer {
  constructor(private readonly baseUrl: string) {}

  private async getJson<T>(path: string): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const init: RequestInit = {
      method: "GET",
      headers: { Accept: "application/json" },
    };
    // Up to 2 attempts total: original + 1 retry on 429 / network.
    let lastNetworkError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
      let res: Response;
      try {
        res = await fetchWithTimeout(url, init);
      } catch (err) {
        // Network error / abort — retry once.
        lastNetworkError = err;
        if (attempt === 0) {
          await sleep(jitteredBackoffMs());
          continue;
        }
        throw err;
      }
      if (res.status === 429 && attempt === 0) {
        const retryAfterMs =
          parseRetryAfterMs(res.headers.get("Retry-After")) ?? jitteredBackoffMs();
        // Drain the body so the underlying connection can be reused.
        await res.text().catch(() => "");
        await sleep(retryAfterMs);
        continue;
      }
      if (!res.ok) {
        throw new Error(
          `Bitcoin indexer ${path} returned ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as T;
    }
    // Both attempts failed with network errors.
    throw lastNetworkError instanceof Error
      ? lastNetworkError
      : new Error(`Bitcoin indexer ${path} failed after retry`);
  }

  async getBalance(address: string): Promise<BitcoinAddressBalance> {
    const stats = await this.getJson<EsploraAddressStats>(`/address/${address}`);
    const confirmedSats =
      BigInt(stats.chain_stats.funded_txo_sum) -
      BigInt(stats.chain_stats.spent_txo_sum);
    const mempoolSats =
      BigInt(stats.mempool_stats.funded_txo_sum) -
      BigInt(stats.mempool_stats.spent_txo_sum);
    return {
      address,
      confirmedSats,
      mempoolSats,
      totalSats: confirmedSats + mempoolSats,
      txCount: stats.chain_stats.tx_count + stats.mempool_stats.tx_count,
    };
  }

  async getFeeEstimates(): Promise<BitcoinFeeEstimates> {
    // mempool.space's recommended-fees endpoint lives under `/v1/`. Self-
    // hosted Esplora-only deployments may not have it; for those, the
    // per-block-target endpoint at `/fee-estimates` is the fallback. We
    // try the recommended-fees endpoint first (rich labels) and fall
    // back to deriving the four labels from the per-target map.
    try {
      const r = await this.getJson<BitcoinFeeEstimates>("/v1/fees/recommended");
      // Defensive: ensure the fields are numbers (some Esplora forks may
      // return strings or omit fields; clamp to the floor in that case).
      const num = (n: unknown) => (typeof n === "number" && Number.isFinite(n) ? n : 1);
      return {
        fastestFee: num(r.fastestFee),
        halfHourFee: num(r.halfHourFee),
        hourFee: num(r.hourFee),
        economyFee: num(r.economyFee),
        minimumFee: num(r.minimumFee),
      };
    } catch {
      // Esplora fallback: per-target map keyed by block-count.
      const map = await this.getJson<Record<string, number>>("/fee-estimates");
      const at = (k: string, fallback: number) =>
        typeof map[k] === "number" && Number.isFinite(map[k]) ? map[k] : fallback;
      return {
        fastestFee: at("1", 20),
        halfHourFee: at("3", 10),
        hourFee: at("6", 5),
        economyFee: at("144", 2),
        minimumFee: at("1008", 1),
      };
    }
  }

  async getAddressTxs(
    address: string,
    opts: { limit?: number } = {},
  ): Promise<BitcoinTxHistoryEntry[]> {
    const limit = opts.limit ?? 25;
    // Esplora returns 50 confirmed txs per page (newest-first) +
    // mempool txs at the start. For a single page that's enough for
    // portfolio history rendering. Pagination cursor is `/txs/chain/<last_seen>`
    // — we don't paginate in PR1.
    const txs = await this.getJson<EsploraTx[]>(`/address/${address}/txs`);
    return txs.slice(0, limit).map((tx) => summarizeTx(tx, address));
  }

  async getUtxos(address: string): Promise<BitcoinUtxo[]> {
    interface EsploraUtxo {
      txid: string;
      vout: number;
      value: number;
      status?: { confirmed?: boolean; block_height?: number };
    }
    const utxos = await this.getJson<EsploraUtxo[]>(`/address/${address}/utxo`);
    return utxos.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      unconfirmed: !u.status?.confirmed,
      ...(u.status?.block_height !== undefined
        ? { blockHeight: u.status.block_height }
        : {}),
    }));
  }

  async broadcastTx(rawTxHex: string): Promise<string> {
    const res = await fetchWithTimeout(`${this.baseUrl}/tx`, {
      method: "POST",
      headers: { "Content-Type": "text/plain" },
      body: rawTxHex,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `Bitcoin indexer /tx broadcast returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }
    // Esplora returns the txid as plain text.
    const txid = (await res.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `Bitcoin indexer /tx returned an unexpected response (not a 64-hex-char txid): "${txid.slice(0, 80)}"`,
      );
    }
    return txid;
  }

  async getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null> {
    interface EsploraTxStatus {
      confirmed: boolean;
      block_height?: number;
      block_hash?: string;
      block_time?: number;
    }
    let status: EsploraTxStatus;
    try {
      status = await this.getJson<EsploraTxStatus>(`/tx/${txid}/status`);
    } catch (err) {
      // Treat 404 as "tx not found" rather than a hard error — caller
      // surfaces the not-found case as a distinct "dropped" state.
      if (err instanceof Error && /returned 404/.test(err.message)) {
        return null;
      }
      throw err;
    }
    if (!status.confirmed) return { confirmed: false };
    // Confirmed → fetch the chain tip to compute confirmation count.
    const tipRes = await fetchWithTimeout(`${this.baseUrl}/blocks/tip/height`, {
      method: "GET",
    });
    if (!tipRes.ok) {
      // Tip fetch failed but we know it's confirmed; return without
      // a count rather than failing the whole call.
      return {
        confirmed: true,
        ...(status.block_height !== undefined ? { blockHeight: status.block_height } : {}),
      };
    }
    const tipText = (await tipRes.text()).trim();
    const tipHeight = Number(tipText);
    if (status.block_height !== undefined && Number.isFinite(tipHeight)) {
      return {
        confirmed: true,
        blockHeight: status.block_height,
        confirmations: Math.max(0, tipHeight - status.block_height + 1),
      };
    }
    return {
      confirmed: true,
      ...(status.block_height !== undefined ? { blockHeight: status.block_height } : {}),
    };
  }

  async getTx(txid: string): Promise<EsploraTx> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `Bitcoin indexer getTx called with non-64-hex txid "${txid.slice(0, 80)}".`,
      );
    }
    return this.getJson<EsploraTx>(`/tx/${txid}`);
  }

  async getTxHex(txid: string): Promise<string> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `Bitcoin indexer getTxHex called with non-64-hex txid "${txid.slice(0, 80)}".`,
      );
    }
    const res = await fetchWithTimeout(`${this.baseUrl}/tx/${txid}/hex`, {
      method: "GET",
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      throw new Error(
        `Bitcoin indexer /tx/${txid}/hex returned ${res.status} ${res.statusText}`,
      );
    }
    const hex = (await res.text()).trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(
        `Bitcoin indexer /tx/${txid}/hex returned non-hex body (length ${hex.length}, ` +
          `head "${hex.slice(0, 32)}").`,
      );
    }
    return hex;
  }

  async getRecentBlocks(n: number): Promise<BitcoinBlockSummary[]> {
    // Cap at 200 to bound the worst-case HTTP fan-out on free-tier
    // indexers (mempool.space limits unauthenticated requests to ~75
    // /quote-equivalents per 2h; 200 blocks @ 10/call = 20 calls per
    // invocation, well under the budget).
    const want = Math.min(Math.max(1, Math.floor(n)), 200);
    interface EsploraBlockListEntry {
      id?: string;
      height?: number;
      timestamp?: number;
      tx_count?: number;
      size?: number;
      weight?: number;
      // mempool.space-only — `extras` is on `/v1/blocks/<height>` but
      // some endpoints fold it into `/blocks/<startHeight>` too. Best-
      // effort field; absent on plain Esplora.
      extras?: { pool?: { name?: string } };
    }
    const out: BitcoinBlockSummary[] = [];
    let cursor: string | undefined; // undefined → request newest 10
    while (out.length < want) {
      const path = cursor === undefined ? "/blocks" : `/blocks/${cursor}`;
      const page = await this.getJson<EsploraBlockListEntry[]>(path);
      if (!Array.isArray(page) || page.length === 0) break;
      for (const b of page) {
        if (
          typeof b.height !== "number" ||
          typeof b.timestamp !== "number" ||
          typeof b.id !== "string"
        ) {
          // Malformed entry; skip rather than fail the whole walk.
          continue;
        }
        out.push({
          height: b.height,
          hash: b.id,
          timestamp: b.timestamp,
          txCount: typeof b.tx_count === "number" ? b.tx_count : 0,
          size: typeof b.size === "number" ? b.size : 0,
          ...(typeof b.weight === "number" ? { weight: b.weight } : {}),
          ...(b.extras?.pool?.name ? { poolName: b.extras.pool.name } : {}),
        });
        if (out.length >= want) break;
      }
      // Esplora's `/blocks/<startHeight>` returns blocks in
      // descending order starting AT `startHeight`. To get the next
      // page we ask for one below the lowest height we just saw.
      const lowest = page.reduce<number | null>((min, b) => {
        if (typeof b.height !== "number") return min;
        return min === null || b.height < min ? b.height : min;
      }, null);
      if (lowest === null || lowest <= 0) break;
      cursor = String(lowest - 1);
    }
    return out;
  }

  async getBlockTip(): Promise<BitcoinBlockTip> {
    // Esplora exposes the chain tip via two endpoints:
    //   GET /blocks/tip/hash  → plain-text 64-hex hash
    //   GET /block/<hash>     → JSON with height, timestamp, mediantime, difficulty
    // Both are aggressively cached at the indexer (mempool.space caches
    // for ~10s; self-hosted Esplora similar), so the two-call shape is
    // cheap. Esplora-pure deployments without `/blocks/tip` (the
    // alternate single-call shape mempool.space exposes) still work via
    // this path.
    const hashRes = await fetchWithTimeout(`${this.baseUrl}/blocks/tip/hash`, {
      method: "GET",
    });
    if (!hashRes.ok) {
      throw new Error(
        `Bitcoin indexer /blocks/tip/hash returned ${hashRes.status} ${hashRes.statusText}`,
      );
    }
    const hash = (await hashRes.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(
        `Bitcoin indexer /blocks/tip/hash returned an unexpected response (not a 64-hex block hash): "${hash.slice(0, 80)}"`,
      );
    }
    interface EsploraBlock {
      id?: string;
      height?: number;
      timestamp?: number;
      // BIP-113 median time past — Esplora exposes as `mediantime`.
      mediantime?: number;
      difficulty?: number;
    }
    const block = await this.getJson<EsploraBlock>(`/block/${hash}`);
    if (typeof block.height !== "number" || typeof block.timestamp !== "number") {
      throw new Error(
        `Bitcoin indexer /block/${hash} response missing required fields ` +
          `(height: ${block.height}, timestamp: ${block.timestamp}). The indexer ` +
          `may not be Esplora-compatible — check the URL.`,
      );
    }
    const ageSeconds = Math.max(0, Math.floor(Date.now() / 1000) - block.timestamp);
    return {
      height: block.height,
      hash,
      timestamp: block.timestamp,
      ageSeconds,
      ...(typeof block.mediantime === "number" ? { medianTimePast: block.mediantime } : {}),
      ...(typeof block.difficulty === "number" ? { difficulty: block.difficulty } : {}),
    };
  }
}

let cached: { url: string; impl: BitcoinIndexer } | undefined;

/**
 * Get the singleton indexer. Re-resolved if the URL has changed (env or
 * config swap). Lazy — env vars / config files are read on first call.
 */
export function getBitcoinIndexer(): BitcoinIndexer {
  const url = resolveIndexerUrl();
  if (!cached || cached.url !== url) {
    cached = { url, impl: new EsploraIndexer(url) };
  }
  return cached.impl;
}

/** Test-only — drop the cached indexer so a fresh URL resolution runs. */
export function resetBitcoinIndexer(): void {
  cached = undefined;
}
