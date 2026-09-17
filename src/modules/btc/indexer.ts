import {
  getEsploraClient,
  resetEsploraClient,
} from "../utxo/esplora-client.js";
import type {
  EsploraAddressBalance,
  EsploraFeeEstimates,
  EsploraTxHistoryEntry,
  EsploraUtxo,
  EsploraBlockSummary,
  EsploraBlockTip,
  BtcEsploraClient,
} from "../utxo/esplora-client.js";

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
 * This file is now a delegating barrel (issue #716 §5.1 cutover): the
 * URL-resolution / retry / HTTP implementation, and the wire + domain
 * shapes it produces, all live once in `../utxo/esplora-client.js`,
 * shared with Litecoin. The BTC-specific names below are aliases of
 * that shared client's equivalents, kept so existing callers importing
 * `Bitcoin*` from this module are unaffected.
 */

/** Bitcoin balance for a single address. Alias of the shared client's `EsploraAddressBalance`. */
export type BitcoinAddressBalance = EsploraAddressBalance;

/** Fee-rate estimates in sat/vB. Alias of the shared client's `EsploraFeeEstimates`. */
export type BitcoinFeeEstimates = EsploraFeeEstimates;

/** Tx history entry. Alias of the shared client's `EsploraTxHistoryEntry`. */
export type BitcoinTxHistoryEntry = EsploraTxHistoryEntry;

/** UTXO entry. Alias of the shared client's `EsploraUtxo`. */
export type BitcoinUtxo = EsploraUtxo;

/**
 * BTC's indexer surface, including `getTx` — the RBF fee-bump builder
 * dependency (intentional BTC/LTC asymmetry, not an oversight). Alias
 * of the shared client's `BtcEsploraClient`.
 */
export type BitcoinIndexer = BtcEsploraClient;

/** Per-block summary for chain-health signals. Alias of the shared client's `EsploraBlockSummary`. */
export type BitcoinBlockSummary = EsploraBlockSummary;

/** Current chain tip. Alias of the shared client's `EsploraBlockTip`. */
export type BitcoinBlockTip = EsploraBlockTip;

/** Wire shapes re-exported unchanged — same name in the shared client. */
export type { EsploraVin, EsploraVout, EsploraTx } from "../utxo/esplora-client.js";

/**
 * Get the singleton indexer. Delegates to `getEsploraClient("btc")`
 * (issue #716 split-plan cutover — the URL-resolution / retry / HTTP
 * implementation this used to run locally now lives once, shared with
 * Litecoin, in `../utxo/esplora-client.js`). Same singleton instance,
 * same rebuild-on-URL-change behavior as before.
 */
export function getBitcoinIndexer(): BitcoinIndexer {
  return getEsploraClient("btc");
}

/** Test-only — drop the cached indexer so a fresh URL resolution runs. */
export function resetBitcoinIndexer(): void {
  resetEsploraClient("btc");
}
