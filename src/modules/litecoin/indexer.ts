import {
  getEsploraClient,
  resetEsploraClient,
} from "../utxo/esplora-client.js";

/**
 * Litecoin indexer abstraction. Single interface, litecoinspace.org
 * (default) + any Esplora-compatible endpoint as the impl. Self-hosted
 * Esplora / Electrs all expose the same REST surface; litecoinspace.org
 * is mempool.space's Litecoin sister deployment, exposing the same API.
 *
 * URL resolution priority (highest first):
 *   1. `LITECOIN_INDEXER_URL` env var
 *   2. `userConfig.litecoinIndexerUrl`
 *   3. `LITECOIN_DEFAULT_INDEXER_URL` (litecoinspace.org)
 *
 * Mirror of `src/modules/btc/indexer.ts` — same Esplora API surface,
 * same retry policy, same field shapes; only the default URL and
 * user-config field name differ.
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
 * Litecoin balance for a single address. Confirmed + unconfirmed reported
 * separately so the caller can decide UX (typically: show confirmed as
 * the headline, surface unconfirmed only when non-zero).
 */
export interface LitecoinAddressBalance {
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
export interface LitecoinFeeEstimates {
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
export interface LitecoinTxHistoryEntry {
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
interface EsploraVin {
  txid: string;
  vout: number;
  prevout?: { scriptpubkey_address?: string; value?: number };
  sequence?: number;
}

interface EsploraVout {
  scriptpubkey_address?: string;
  value?: number;
}

interface EsploraTx {
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
export interface LitecoinUtxo {
  txid: string;
  vout: number;
  /** UTXO value in sats. */
  value: number;
  /** Block height of the funding tx. Undefined for mempool UTXOs. */
  blockHeight?: number;
  /** True when the UTXO is in mempool (not yet confirmed). */
  unconfirmed: boolean;
}

export interface LitecoinIndexer {
  getBalance(address: string): Promise<LitecoinAddressBalance>;
  getFeeEstimates(): Promise<LitecoinFeeEstimates>;
  /**
   * Fetch the tx history for an address. `limit` clamps how many entries
   * to walk (we paginate via the Esplora `/txs/chain/<last_seen>` cursor
   * pattern; mempool.space honors the same convention). Returns only
   * confirmed + mempool txs, oldest-first within each segment.
   */
  getAddressTxs(
    address: string,
    opts?: { limit?: number },
  ): Promise<LitecoinTxHistoryEntry[]>;
  /**
   * Fetch the UTXO set for an address. Returned newest-first (block
   * height descending). Used as the input set for coin-selection on
   * `prepare_btc_send`.
   */
  getUtxos(address: string): Promise<LitecoinUtxo[]>;
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
   * Fetch the current Litecoin chain tip — height, block hash, header
   * timestamp, etc. Two HTTP calls under the hood: `/blocks/tip/hash`
   * for the latest hash, then `/block/<hash>` for the full header
   * details. Both endpoints are aggressively cached at the indexer
   * (mempool.space + standard Esplora share the same shape).
   */
  getBlockTip(): Promise<LitecoinBlockTip>;
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
   * Fetch the most recent N block headers, newest-first. Mirrors
   * `BitcoinIndexer.getRecentBlocks` — same Esplora pagination pattern,
   * same 200-block cap. Backbone for chain-health signals
   * (hash_cliff, empty_block_streak, miner_concentration). Issue #233 v1.
   */
  getRecentBlocks(n: number): Promise<LitecoinBlockSummary[]>;
}

/**
 * Subset of Esplora's per-block JSON we surface for chain-health
 * signals. Mirrors `BitcoinBlockSummary` shape exactly. `poolName` is
 * indexer-specific (mempool.space-style `extras.pool.name`); plain
 * Esplora deployments leave it undefined and `miner_concentration`
 * degrades to `available: false`.
 */
export interface LitecoinBlockSummary {
  height: number;
  hash: string;
  timestamp: number;
  txCount: number;
  size: number;
  weight?: number;
  poolName?: string;
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
export interface LitecoinBlockTip {
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
 * Get the singleton indexer. Delegates to `getEsploraClient("ltc")`
 * (issue #716 split-plan cutover — the URL-resolution / retry / HTTP
 * implementation this used to run locally now lives once, shared with
 * Bitcoin, in `../utxo/esplora-client.js`). Same singleton instance,
 * same rebuild-on-URL-change behavior as before.
 */
export function getLitecoinIndexer(): LitecoinIndexer {
  return getEsploraClient("ltc");
}

/** Test-only — drop the cached indexer so a fresh URL resolution runs. */
export function resetLitecoinIndexer(): void {
  resetEsploraClient("ltc");
}
