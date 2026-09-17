import { BITCOIN_DEFAULT_INDEXER_URL } from "../../config/btc.js";
import { LITECOIN_DEFAULT_INDEXER_URL } from "../../config/litecoin.js";

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
