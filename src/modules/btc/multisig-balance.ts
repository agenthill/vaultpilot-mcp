import { getBitcoinIndexer, type BitcoinUtxo } from "./indexer.js";
import { deriveMultisigAddress } from "./multisig-derive.js";
import { getPairedMultisigByName } from "./multisig.js";
import type { PairedBitcoinMultisigWallet } from "../../types/index.js";

/**
 * Balance + UTXO reads for registered multi-sig wallets. Walks both
 * BIP-32 chains (chain=0 receive, chain=1 change) up to a gap-limit
 * window, queries each derived address via the existing Esplora
 * indexer, aggregates the results.
 *
 * The walk follows the standard BIP-44 gap-limit semantics: scan
 * sequential addresses on each chain, stop after `gapLimit` consecutive
 * empty addresses (zero confirmed + mempool tx count). Default gap
 * limit is 20, matching the BIP-44 recommendation and what wallets
 * like Sparrow / Specter use.
 *
 * Used by:
 *   - `get_btc_multisig_balance` / `get_btc_multisig_utxos` (this PR).
 *   - PR3's initiator flow (`prepare_btc_multisig_send`) — needs the
 *     UTXO set for coin-selection.
 *
 * NOTE: Each address read is one indexer call; the fan-out is bounded
 * by `gapLimit × 2` per wallet (chains × 0/1), capped to a few dozen
 * for sensible defaults. Mempool.space's free tier rate-limits at ~50
 * requests / 30s; the walk fits well under that for default args.
 */

export const DEFAULT_MULTISIG_GAP_LIMIT = 20;
export const MAX_MULTISIG_GAP_LIMIT = 100;

export interface MultisigChainEntry {
  /** Chain (0 = receive, 1 = change). */
  chain: 0 | 1;
  /** Address index along this chain. */
  addressIndex: number;
  /** Derived address. */
  address: string;
  /** Confirmed balance in sats. */
  confirmedSats: bigint;
  /** Mempool delta in sats. Can be negative (in-flight outgoing). */
  mempoolSats: bigint;
  /** Confirmed + mempool. */
  totalSats: bigint;
  /** Total tx count this address has been involved in. */
  txCount: number;
}

export interface MultisigBalance {
  walletName: string;
  threshold: number;
  totalSigners: number;
  scriptType: PairedBitcoinMultisigWallet["scriptType"];
  /** Aggregate confirmed balance across both chains. */
  confirmedSats: bigint;
  /** Aggregate mempool delta across both chains. */
  mempoolSats: bigint;
  /** Confirmed + mempool aggregate. */
  totalSats: bigint;
  /** Sum of tx counts across every walked address. */
  txCount: number;
  /** Per-address breakdown for the walked window (only entries with non-zero history). */
  addresses: MultisigChainEntry[];
  /** How far the gap-limit walk advanced on each chain. */
  walked: { receive: number; change: number };
}

export interface MultisigUtxo extends BitcoinUtxo {
  /** Address (bech32) the UTXO funds. */
  address: string;
  /** scriptPubKey bytes for this address (witness program). */
  scriptPubKey: Buffer;
  /** witnessScript bytes — needed to build PSBT inputs in PR3. */
  witnessScript: Buffer;
  /** Compressed cosigner pubkeys at this leaf, in slot order (NOT sorted). Used for PSBT bip32_derivation. */
  cosignerPubkeys: Buffer[];
  /** Chain (0 = receive, 1 = change). */
  chain: 0 | 1;
  /** Address index along this chain. */
  addressIndex: number;
}

export interface MultisigUtxoSet {
  walletName: string;
  utxos: MultisigUtxo[];
  /** Sum of utxo.value across the set, in sats. */
  totalSats: bigint;
  /** How far the gap-limit walk advanced on each chain. */
  walked: { receive: number; change: number };
}

function clampGapLimit(raw: number | undefined): number {
  if (raw === undefined) return DEFAULT_MULTISIG_GAP_LIMIT;
  if (!Number.isInteger(raw) || raw < 1) {
    throw new Error(
      `gapLimit must be a positive integer (got ${raw}). Default is ${DEFAULT_MULTISIG_GAP_LIMIT}; ` +
        `cap is ${MAX_MULTISIG_GAP_LIMIT} to bound indexer fan-out.`,
    );
  }
  return Math.min(raw, MAX_MULTISIG_GAP_LIMIT);
}

/**
 * Walk one BIP-32 chain (0 or 1) and call `visit` for each address
 * derivation until `gapLimit` consecutive empty addresses are seen.
 * Returns the count of addresses walked (one past the last index
 * touched, so the walk's "end position").
 */
async function walkChain<T>(
  wallet: PairedBitcoinMultisigWallet,
  chain: 0 | 1,
  gapLimit: number,
  visit: (info: {
    chain: 0 | 1;
    addressIndex: number;
    address: string;
    scriptPubKey: Buffer;
    witnessScript: Buffer;
    cosignerPubkeys: Buffer[];
    /** True iff the address has on-chain history (txCount > 0 or a non-zero balance). */
    hasHistory: boolean;
  }) => Promise<T | undefined>,
): Promise<{ walked: number; visited: T[] }> {
  const indexer = getBitcoinIndexer();
  const visited: T[] = [];
  let consecutiveEmpty = 0;
  let i = 0;
  while (consecutiveEmpty < gapLimit) {
    const info = deriveMultisigAddress(wallet, chain, i);
    const balance = await indexer.getBalance(info.address);
    const hasHistory =
      balance.txCount > 0 ||
      balance.confirmedSats !== 0n ||
      balance.mempoolSats !== 0n;
    if (hasHistory) {
      consecutiveEmpty = 0;
      const ret = await visit({
        chain,
        addressIndex: i,
        address: info.address,
        scriptPubKey: info.scriptPubKey,
        witnessScript: info.witnessScript,
        cosignerPubkeys: info.cosignerPubkeys,
        hasHistory: true,
      });
      if (ret !== undefined) visited.push(ret);
    } else {
      consecutiveEmpty += 1;
      // Still call visit when the caller wants empty entries (no-op
      // for now since our two readers only care about non-empty).
    }
    i += 1;
  }
  return { walked: i, visited };
}

export interface GetMultisigBalanceArgs {
  walletName: string;
  gapLimit?: number;
}

export async function getMultisigBalance(
  args: GetMultisigBalanceArgs,
): Promise<MultisigBalance> {
  const wallet = getPairedMultisigByName(args.walletName);
  if (!wallet) {
    throw new Error(
      `No multi-sig wallet registered under name "${args.walletName}". Call ` +
        `\`register_btc_multisig_wallet\` first.`,
    );
  }
  const gapLimit = clampGapLimit(args.gapLimit);
  const indexer = getBitcoinIndexer();

  const addresses: MultisigChainEntry[] = [];
  let confirmedSats = 0n;
  let mempoolSats = 0n;
  let txCount = 0;
  const walked = { receive: 0, change: 0 };

  for (const chain of [0, 1] as const) {
    let consecutiveEmpty = 0;
    let i = 0;
    while (consecutiveEmpty < gapLimit) {
      const info = deriveMultisigAddress(wallet, chain, i);
      const balance = await indexer.getBalance(info.address);
      if (
        balance.txCount > 0 ||
        balance.confirmedSats !== 0n ||
        balance.mempoolSats !== 0n
      ) {
        consecutiveEmpty = 0;
        confirmedSats += balance.confirmedSats;
        mempoolSats += balance.mempoolSats;
        txCount += balance.txCount;
        addresses.push({
          chain,
          addressIndex: i,
          address: info.address,
          confirmedSats: balance.confirmedSats,
          mempoolSats: balance.mempoolSats,
          totalSats: balance.totalSats,
          txCount: balance.txCount,
        });
      } else {
        consecutiveEmpty += 1;
      }
      i += 1;
    }
    if (chain === 0) walked.receive = i;
    else walked.change = i;
  }

  return {
    walletName: wallet.name,
    threshold: wallet.threshold,
    totalSigners: wallet.totalSigners,
    scriptType: wallet.scriptType,
    confirmedSats,
    mempoolSats,
    totalSats: confirmedSats + mempoolSats,
    txCount,
    addresses,
    walked,
  };
}

export interface GetMultisigUtxosArgs {
  walletName: string;
  gapLimit?: number;
}

export async function getMultisigUtxos(
  args: GetMultisigUtxosArgs,
): Promise<MultisigUtxoSet> {
  const wallet = getPairedMultisigByName(args.walletName);
  if (!wallet) {
    throw new Error(
      `No multi-sig wallet registered under name "${args.walletName}". Call ` +
        `\`register_btc_multisig_wallet\` first.`,
    );
  }
  const gapLimit = clampGapLimit(args.gapLimit);
  const indexer = getBitcoinIndexer();
  const utxos: MultisigUtxo[] = [];
  let totalSats = 0n;
  const walked = { receive: 0, change: 0 };
  for (const chain of [0, 1] as const) {
    const result = await walkChain(wallet, chain, gapLimit, async (info) => {
      const addrUtxos = await indexer.getUtxos(info.address);
      return addrUtxos.map<MultisigUtxo>((u) => ({
        ...u,
        address: info.address,
        scriptPubKey: info.scriptPubKey,
        witnessScript: info.witnessScript,
        cosignerPubkeys: info.cosignerPubkeys,
        chain: info.chain,
        addressIndex: info.addressIndex,
      }));
    });
    if (chain === 0) walked.receive = result.walked;
    else walked.change = result.walked;
    for (const batch of result.visited) {
      for (const utxo of batch) {
        utxos.push(utxo);
        totalSats += BigInt(utxo.value);
      }
    }
  }
  return { walletName: wallet.name, utxos, totalSats, walked };
}
