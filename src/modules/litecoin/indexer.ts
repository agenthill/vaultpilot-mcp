import {
  getEsploraClient,
  resetEsploraClient,
} from "../utxo/esplora-client.js";
import type {
  EsploraAddressBalance,
  EsploraFeeEstimates,
  EsploraTxHistoryEntry,
  EsploraUtxo,
  EsploraClient,
  EsploraBlockSummary,
  EsploraBlockTip,
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
 * This file is now a delegating barrel (issue #716 §5.1 cutover): the
 * URL-resolution / retry / HTTP implementation, and the wire + domain
 * shapes it produces, all live once in `../utxo/esplora-client.js`,
 * shared with Bitcoin. The LTC-specific names below are aliases of that
 * shared client's equivalents, kept so existing callers importing
 * `Litecoin*` from this module are unaffected. Unlike BTC, LTC has no
 * `getTx` — this indexer's surface is the base `EsploraClient`.
 */

/** Litecoin balance for a single address. Alias of the shared client's `EsploraAddressBalance`. */
export type LitecoinAddressBalance = EsploraAddressBalance;

/** Fee-rate estimates in sat/vB. Alias of the shared client's `EsploraFeeEstimates`. */
export type LitecoinFeeEstimates = EsploraFeeEstimates;

/** Tx history entry. Alias of the shared client's `EsploraTxHistoryEntry`. */
export type LitecoinTxHistoryEntry = EsploraTxHistoryEntry;

/** UTXO entry. Alias of the shared client's `EsploraUtxo`. */
export type LitecoinUtxo = EsploraUtxo;

/** LTC's indexer surface. Alias of the shared client's base `EsploraClient` (no `getTx`). */
export type LitecoinIndexer = EsploraClient;

/** Per-block summary for chain-health signals. Alias of the shared client's `EsploraBlockSummary`. */
export type LitecoinBlockSummary = EsploraBlockSummary;

/** Current chain tip. Alias of the shared client's `EsploraBlockTip`. */
export type LitecoinBlockTip = EsploraBlockTip;

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
