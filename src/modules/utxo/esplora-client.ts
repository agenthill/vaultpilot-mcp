import { fetchWithTimeout } from "../../data/http.js";
import { BITCOIN_DEFAULT_INDEXER_URL } from "../../config/btc.js";
import { LITECOIN_DEFAULT_INDEXER_URL } from "../../config/litecoin.js";
import { readUserConfig } from "../../config/user-config.js";

/**
 * Parametrized Esplora-compatible indexer client, shared by BTC and LTC
 * (ARCHITECTURE.md §5.1). Both chains' indexers speak the identical
 * Esplora REST surface — mempool.space (BTC) and litecoinspace.org (LTC,
 * mempool.space's Litecoin sister deployment) both fork Blockstream
 * Esplora's API, with the same field shapes and retry behavior. Only the
 * default URL, the URL-resolution env var / config field, and the chain
 * label used in error messages differ per chain — captured below in
 * `ESPLORA_CHAIN_PROFILES`.
 *
 * This file is currently INERT: nothing imports it yet. It lands ahead of
 * the helpers/class/factory (next PR) and the pinning tests (PR after
 * that) so the cutover of `btc/indexer.ts` and `litecoin/indexer.ts` onto
 * this client has a stable, reviewed foundation to land against.
 *
 * Shapes and profile values below are transcribed verbatim from
 * `src/modules/btc/indexer.ts` (708L) and `src/modules/litecoin/indexer.ts`
 * (676L) — see the split plan on issue #716 for the verified diff.
 */

export type EsploraChain = "btc" | "ltc";

// ---------------------------------------------------------------------
// Esplora wire shapes — the raw JSON payloads returned by the indexer's
// REST endpoints. Identical across BTC and LTC (both are Esplora forks).
// ---------------------------------------------------------------------

/**
 * Esplora address-stats payload (`GET /address/<addr>`). Both confirmed
 * and mempool stats are present; callers sum them to surface a "total
 * balance" alongside the confirmed-only number.
 */
export interface EsploraAddressStats {
  address: string;
  chain_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
  mempool_stats: {
    funded_txo_count: number;
    funded_txo_sum: number;
    spent_txo_count: number;
    spent_txo_sum: number;
    tx_count: number;
  };
}

/** Esplora vin/vout shapes as returned by `GET /tx/<txid>` and address-tx listings. */
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

/** Full Esplora tx shape (`GET /tx/<txid>`, and entries from `GET /address/<addr>/txs`). */
export interface EsploraTx {
  txid: string;
  vin: EsploraVin[];
  vout: EsploraVout[];
  fee?: number;
  status?: { confirmed?: boolean; block_height?: number; block_time?: number };
}

/** `GET /address/<addr>/utxo` entry shape. */
export interface EsploraUtxoRow {
  txid: string;
  vout: number;
  value: number;
  status?: { confirmed?: boolean; block_height?: number };
}

/** `GET /tx/<txid>/status` payload shape. */
export interface EsploraTxStatusRow {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
  block_time?: number;
}

/**
 * `GET /blocks` / `GET /blocks/<startHeight>` per-entry shape. `extras`
 * is mempool.space-specific (surfaced on some but not all block-list
 * endpoints) — optional so callers can degrade gracefully.
 */
export interface EsploraBlockListEntryRow {
  id?: string;
  height?: number;
  timestamp?: number;
  tx_count?: number;
  size?: number;
  weight?: number;
  extras?: { pool?: { name?: string } };
}

/** `GET /block/<hash>` payload shape. */
export interface EsploraBlockRow {
  id?: string;
  height?: number;
  timestamp?: number;
  mediantime?: number;
  difficulty?: number;
}

// ---------------------------------------------------------------------
// Domain output shapes — what `EsploraClient` methods resolve to. These
// are the chain-agnostic equivalents of `Bitcoin*` / `Litecoin*` in the
// two existing indexer files; the two are structurally identical field
// for field (verified in the issue #716 split plan diff), so a single
// shared name replaces both once the cutover PRs land.
// ---------------------------------------------------------------------

/** Balance for a single address. Confirmed + unconfirmed reported separately. */
export interface EsploraAddressBalance {
  address: string;
  /** Confirmed funded - confirmed spent, in sats. Always >= 0. */
  confirmedSats: bigint;
  /** Mempool funded - mempool spent, in sats. Can be negative (funds in-flight as spent). */
  mempoolSats: bigint;
  /** Confirmed + mempool. Convenience field. */
  totalSats: bigint;
  /** Total tx count this address has been involved in (confirmed + mempool). */
  txCount: number;
}

/** Fee-rate estimates in sat/vB, matching mempool.space's `/v1/fees/recommended` labels. */
export interface EsploraFeeEstimates {
  fastestFee: number;
  halfHourFee: number;
  hourFee: number;
  economyFee: number;
  minimumFee: number;
}

/** Tx history entry — the subset of the Esplora tx shape surfaced for portfolio history. */
export interface EsploraTxHistoryEntry {
  txid: string;
  /** Sum of vouts that pay this address (the funding side). Sats. */
  receivedSats: bigint;
  /** Sum of vins that come from this address (the spending side). Sats. */
  sentSats: bigint;
  /** Tx fee from the Esplora payload (sats). */
  feeSats: bigint;
  /** Block height — undefined when still in mempool. */
  blockHeight?: number;
  /** Unix timestamp of the block — undefined for mempool. */
  blockTime?: number;
  /** True when sequence < 0xFFFFFFFE on at least one input (BIP-125). */
  rbfEligible: boolean;
}

/**
 * UTXO entry. `scriptPubKey` is derived from the address at PSBT-build
 * time rather than carried here (all UTXOs for one address share it).
 */
export interface EsploraUtxo {
  txid: string;
  vout: number;
  /** UTXO value in sats. */
  value: number;
  /** Block height of the funding tx. Undefined for mempool UTXOs. */
  blockHeight?: number;
  /** True when the UTXO is in mempool (not yet confirmed). */
  unconfirmed: boolean;
}

/** Per-block summary used for chain-health signals (hash_cliff, empty_block_streak, miner_concentration). */
export interface EsploraBlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  txCount: number;
  size: number;
  weight?: number;
  /** mempool.space `extras.pool.name` when the indexer surfaces it. Undefined on plain Esplora. */
  poolName?: string;
}

/** Current chain tip as the indexer reports it. */
export interface EsploraBlockTip {
  height: number;
  hash: string;
  timestamp: number;
  /** Server-computed `now - timestamp` at fetch time, in seconds. */
  ageSeconds: number;
  /** BIP-113 median time past, when the indexer exposes it. */
  medianTimePast?: number;
  difficulty?: number;
}

// ---------------------------------------------------------------------
// Client interface. LTC implements the base `EsploraClient`; BTC
// implements `BtcEsploraClient`, which additionally exposes `getTx` —
// the RBF fee-bump builder dependency (intentional asymmetry, not an
// oversight; LTC has no RBF fee-bump builder to back).
// ---------------------------------------------------------------------

export interface EsploraClient {
  getBalance(address: string): Promise<EsploraAddressBalance>;
  getFeeEstimates(): Promise<EsploraFeeEstimates>;
  getAddressTxs(
    address: string,
    opts?: { limit?: number },
  ): Promise<EsploraTxHistoryEntry[]>;
  getUtxos(address: string): Promise<EsploraUtxo[]>;
  broadcastTx(rawTxHex: string): Promise<string>;
  getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null>;
  getBlockTip(): Promise<EsploraBlockTip>;
  /**
   * Fetch the raw hex of a previous transaction by txid. Required for
   * `nonWitnessUtxo` population on PSBT inputs (Ledger BTC app 2.x
   * verifies the input amount against this prev-tx). Issue #213.
   */
  getTxHex(txid: string): Promise<string>;
  getRecentBlocks(n: number): Promise<EsploraBlockSummary[]>;
}

/**
 * BTC's client additionally exposes `getTx` — used by the RBF fee-bump
 * builder to: (1) confirm the tx is still in mempool, (2) read original
 * inputs to rebuild the same input set, (3) read original outputs to
 * preserve recipients and identify the change output, (4) verify at
 * least one input has BIP-125-eligible sequence.
 */
export interface BtcEsploraClient extends EsploraClient {
  getTx(txid: string): Promise<EsploraTx>;
}

// ---------------------------------------------------------------------
// Per-chain profile — the only real deltas between the two existing
// indexer files: default URL, env var, `UserConfig` field, and the
// chain label used in the 11 error-message templates.
// ---------------------------------------------------------------------

export interface EsploraChainProfile {
  /** Chain label used as the error-message prefix (e.g. `"Bitcoin indexer /tx returned …"`). */
  errorLabel: string;
  /** Env var consulted first for the indexer base URL (highest priority). */
  envVar: string;
  /** `UserConfig` field consulted second, after the env var. */
  configField: "bitcoinIndexerUrl" | "litecoinIndexerUrl";
  /** Default indexer base URL, used when neither the env var nor the config field is set. */
  defaultUrl: string;
}

export const ESPLORA_CHAIN_PROFILES: Record<EsploraChain, EsploraChainProfile> = {
  btc: {
    errorLabel: "Bitcoin indexer",
    envVar: "BITCOIN_INDEXER_URL",
    configField: "bitcoinIndexerUrl",
    defaultUrl: BITCOIN_DEFAULT_INDEXER_URL,
  },
  ltc: {
    errorLabel: "Litecoin indexer",
    envVar: "LITECOIN_INDEXER_URL",
    configField: "litecoinIndexerUrl",
    defaultUrl: LITECOIN_DEFAULT_INDEXER_URL,
  },
};

// ---------------------------------------------------------------------
// Helpers — parametrized equivalents of the per-chain free functions in
// `btc/indexer.ts` / `litecoin/indexer.ts`. Logic unchanged; only the
// per-chain literals (env var, config field, default URL) now come from
// the profile instead of being hardcoded.
// ---------------------------------------------------------------------

/** Resolve the indexer base URL via env > config > default, for the given chain's profile. */
function resolveEsploraUrl(profile: EsploraChainProfile): string {
  const fromEnv = process.env[profile.envVar]?.trim();
  if (fromEnv) return fromEnv;
  const cfg = readUserConfig();
  const fromCfg = cfg?.[profile.configField]?.trim();
  if (fromCfg) return fromCfg;
  return profile.defaultUrl;
}

/**
 * Convert an Esplora tx + the address it's queried for into the thin
 * history shape. The fee comes from the API directly; received/sent are
 * derived by walking vin/vout for entries that match the address.
 */
function summarizeTx(tx: EsploraTx, address: string): EsploraTxHistoryEntry {
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
 * Single retry policy for transient indexer failures (issue #199), shared
 * by both chains verbatim:
 *
 *   - HTTP 429 → honor `Retry-After` header (seconds, capped at 5s) or
 *     fall back to a small jittered backoff.
 *   - Network errors / timeouts → retry once with a small jittered
 *     backoff.
 *   - HTTP 5xx → NOT retried. Surfaces to the caller rather than being
 *     silently masked.
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

// ---------------------------------------------------------------------
// Client implementation. `EsploraIndexerClient` is the BTC implementation
// (`class EsploraIndexer` in `btc/indexer.ts`) verbatim, parametrized by
// `baseUrl` + `profile` instead of closing over chain-specific literals.
// It implements the base `EsploraClient` — every method LTC needs.
//
// `BtcEsploraIndexerClient` layers `getTx` on top via subclassing rather
// than defining it on the shared class, so an LTC instance genuinely
// lacks `getTx` at runtime (not just in the type) — `getEsploraClient`
// only ever constructs the subclass for `"btc"`.
// ---------------------------------------------------------------------

class EsploraIndexerClient implements EsploraClient {
  constructor(
    protected readonly baseUrl: string,
    protected readonly profile: EsploraChainProfile,
  ) {}

  protected async getJson<T>(path: string): Promise<T> {
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
          `${this.profile.errorLabel} ${path} returned ${res.status} ${res.statusText}`,
        );
      }
      return (await res.json()) as T;
    }
    // Both attempts failed with network errors.
    throw lastNetworkError instanceof Error
      ? lastNetworkError
      : new Error(`${this.profile.errorLabel} ${path} failed after retry`);
  }

  async getBalance(address: string): Promise<EsploraAddressBalance> {
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

  async getFeeEstimates(): Promise<EsploraFeeEstimates> {
    // mempool.space's recommended-fees endpoint lives under `/v1/`. Self-
    // hosted Esplora-only deployments may not have it; for those, the
    // per-block-target endpoint at `/fee-estimates` is the fallback.
    try {
      const r = await this.getJson<EsploraFeeEstimates>("/v1/fees/recommended");
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
  ): Promise<EsploraTxHistoryEntry[]> {
    const limit = opts.limit ?? 25;
    const txs = await this.getJson<EsploraTx[]>(`/address/${address}/txs`);
    return txs.slice(0, limit).map((tx) => summarizeTx(tx, address));
  }

  async getUtxos(address: string): Promise<EsploraUtxo[]> {
    const utxos = await this.getJson<EsploraUtxoRow[]>(`/address/${address}/utxo`);
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
        `${this.profile.errorLabel} /tx broadcast returned ${res.status} ${res.statusText}: ${body.slice(0, 200)}`,
      );
    }
    // Esplora returns the txid as plain text.
    const txid = (await res.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `${this.profile.errorLabel} /tx returned an unexpected response (not a 64-hex-char txid): "${txid.slice(0, 80)}"`,
      );
    }
    return txid;
  }

  async getTxStatus(txid: string): Promise<{
    confirmed: boolean;
    blockHeight?: number;
    confirmations?: number;
  } | null> {
    let status: EsploraTxStatusRow;
    try {
      status = await this.getJson<EsploraTxStatusRow>(`/tx/${txid}/status`);
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

  async getTxHex(txid: string): Promise<string> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `${this.profile.errorLabel} getTxHex called with non-64-hex txid "${txid.slice(0, 80)}".`,
      );
    }
    const res = await fetchWithTimeout(`${this.baseUrl}/tx/${txid}/hex`, {
      method: "GET",
      headers: { Accept: "text/plain" },
    });
    if (!res.ok) {
      throw new Error(
        `${this.profile.errorLabel} /tx/${txid}/hex returned ${res.status} ${res.statusText}`,
      );
    }
    const hex = (await res.text()).trim();
    if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
      throw new Error(
        `${this.profile.errorLabel} /tx/${txid}/hex returned non-hex body (length ${hex.length}, ` +
          `head "${hex.slice(0, 32)}").`,
      );
    }
    return hex;
  }

  async getRecentBlocks(n: number): Promise<EsploraBlockSummary[]> {
    // Cap at 200 to bound the worst-case HTTP fan-out on free-tier
    // indexers.
    const want = Math.min(Math.max(1, Math.floor(n)), 200);
    const out: EsploraBlockSummary[] = [];
    let cursor: string | undefined; // undefined → request newest 10
    while (out.length < want) {
      const path = cursor === undefined ? "/blocks" : `/blocks/${cursor}`;
      const page = await this.getJson<EsploraBlockListEntryRow[]>(path);
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
      // Esplora's `/blocks/<startHeight>` returns blocks in descending
      // order starting AT `startHeight`. The next page asks for one
      // below the lowest height just seen.
      const lowest = page.reduce<number | null>((min, b) => {
        if (typeof b.height !== "number") return min;
        return min === null || b.height < min ? b.height : min;
      }, null);
      if (lowest === null || lowest <= 0) break;
      cursor = String(lowest - 1);
    }
    return out;
  }

  async getBlockTip(): Promise<EsploraBlockTip> {
    // Esplora exposes the chain tip via two endpoints:
    //   GET /blocks/tip/hash  → plain-text 64-hex hash
    //   GET /block/<hash>     → JSON with height, timestamp, mediantime, difficulty
    const hashRes = await fetchWithTimeout(`${this.baseUrl}/blocks/tip/hash`, {
      method: "GET",
    });
    if (!hashRes.ok) {
      throw new Error(
        `${this.profile.errorLabel} /blocks/tip/hash returned ${hashRes.status} ${hashRes.statusText}`,
      );
    }
    const hash = (await hashRes.text()).trim();
    if (!/^[0-9a-fA-F]{64}$/.test(hash)) {
      throw new Error(
        `${this.profile.errorLabel} /blocks/tip/hash returned an unexpected response (not a 64-hex block hash): "${hash.slice(0, 80)}"`,
      );
    }
    const block = await this.getJson<EsploraBlockRow>(`/block/${hash}`);
    if (typeof block.height !== "number" || typeof block.timestamp !== "number") {
      throw new Error(
        `${this.profile.errorLabel} /block/${hash} response missing required fields ` +
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

/**
 * BTC-only subclass adding `getTx` — the RBF fee-bump builder dependency.
 * Logic copied verbatim from `EsploraIndexer.getTx` in `btc/indexer.ts`.
 */
class BtcEsploraIndexerClient extends EsploraIndexerClient implements BtcEsploraClient {
  async getTx(txid: string): Promise<EsploraTx> {
    if (!/^[0-9a-fA-F]{64}$/.test(txid)) {
      throw new Error(
        `${this.profile.errorLabel} getTx called with non-64-hex txid "${txid.slice(0, 80)}".`,
      );
    }
    return this.getJson<EsploraTx>(`/tx/${txid}`);
  }
}

// ---------------------------------------------------------------------
// Factory — per-chain singleton, keyed by chain then re-resolved if the
// URL changes (env or config swap). Mirrors `getBitcoinIndexer` /
// `getLitecoinIndexer`'s `{url, impl}` caching, generalized to a
// per-chain map so BTC and LTC each keep a stable identity across calls
// (a future cutover of `litecoin/indexer.ts` onto this factory must
// preserve the singleton identity `litecoin-core.test.ts` spies on).
// ---------------------------------------------------------------------

const singletons: { [K in EsploraChain]?: { url: string; impl: EsploraClient } } = {};

export function getEsploraClient(chain: "btc"): BtcEsploraClient;
export function getEsploraClient(chain: "ltc"): EsploraClient;
// General overload — needed so callers holding a variable typed as the
// union `EsploraChain` (rather than a literal `"btc"`/`"ltc"`) have a
// matching signature to resolve against; TS overload resolution won't
// match a union argument to either literal overload above.
export function getEsploraClient(chain: EsploraChain): EsploraClient;
export function getEsploraClient(chain: EsploraChain): EsploraClient {
  const profile = ESPLORA_CHAIN_PROFILES[chain];
  const url = resolveEsploraUrl(profile);
  const existing = singletons[chain];
  if (existing && existing.url === url) {
    return existing.impl;
  }
  const impl: EsploraClient =
    chain === "btc"
      ? new BtcEsploraIndexerClient(url, profile)
      : new EsploraIndexerClient(url, profile);
  singletons[chain] = { url, impl };
  return impl;
}

/** Test-only — drop the cached client(s) so a fresh URL resolution runs. */
export function resetEsploraClient(chain?: EsploraChain): void {
  if (chain) {
    delete singletons[chain];
    return;
  }
  delete singletons.btc;
  delete singletons.ltc;
}
