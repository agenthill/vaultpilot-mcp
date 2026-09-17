import { createConfig, getQuote, getStatus, ChainId as LifiChainId } from "@lifi/sdk";
import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";

let initialized = false;

/** Initialize the LiFi SDK once. Safe to call repeatedly. */
export function initLifi(): void {
  if (initialized) return;
  createConfig({
    integrator: "vaultpilot-mcp",
    // We don't execute routes through LiFi — we just fetch tx data and hand it to WalletConnect.
  });
  initialized = true;
}

/**
 * LiFi numeric chain ID for Solana. Authoritative value from
 * `@lifi/types/chains/base.ChainId.SOL` (= 1151111081099710 — derived from
 * the bytes "sol" interpreted as ASCII codes appended to a marker prefix).
 * Hoisted to a constant here so callers passing through the EVM-only
 * `toLifiChain` helper aren't forced to reach into the SDK.
 */
export const LIFI_SOLANA_CHAIN_ID = 1151111081099710 as const;

/**
 * LiFi API chain ID for TRON (chainType: "TVM"). This is NOT the on-chain
 * BridgeData.destinationChainId; that namespace uses 1885080386571452
 * (see lifi-chain-ids.ts). Keep quote/status requests in the API namespace:
 * GET https://li.quest/v1/chains?chainTypes=TVM returns id=728126428.
 */
export const LIFI_TRON_CHAIN_ID = 728126428 as const;

/** Map our chain name to LiFi's numeric chain ID. */
function toLifiChain(chain: SupportedChain): number {
  return CHAIN_IDS[chain];
}

interface LifiQuoteRequestBase {
  /**
   * Source chain. EVM `SupportedChain` for the existing `prepare_swap`
   * flow, or `"tron"` for the LiFi-on-TRON flow (`prepare_tron_lifi_swap`)
   * that signs a TRON tx. Solana-source has its own quote shape
   * (`fetchSolanaQuote`) — it doesn't share this type.
   */
  fromChain: SupportedChain | "tron";
  /**
   * Destination chain. EVM `SupportedChain` (intra-EVM + EVM-cross), or
   * `"solana"` / `"tron"` (cross-chain bridge to a non-EVM chain). LiFi's
   * API itself accepts any numeric chain ID; we constrain to chains we've
   * validated end-to-end in this server.
   */
  toChain: SupportedChain | "solana" | "tron";
  /** Use "native" or "0x0000000000000000000000000000000000000000" for native token. */
  fromToken: `0x${string}` | "native";
  /**
   * Destination token. EVM hex when `toChain` is EVM; SPL mint (base58)
   * when `toChain === "solana"`; TRC-20 contract address (T-prefixed
   * base58) when `toChain === "tron"`. `"native"` resolves to the chain's
   * native sentinel (`0x0…0` for EVM, wSOL mint for Solana, TRX
   * contract address for TRON — handled inside `fetchQuote`).
   */
  toToken: string | "native";
  /**
   * Source wallet. EVM hex when `fromChain` is EVM; TRON base58 when
   * `fromChain === "tron"`. LiFi's API accepts either — typed as the
   * narrow EVM-hex string for legacy callers; TRON callers cast through.
   */
  fromAddress: `0x${string}` | string;
  /**
   * Destination wallet. Defaults to `fromAddress` for intra-EVM swaps
   * (LiFi behavior). REQUIRED when `toChain` is `"solana"` or `"tron"`
   * because the source EVM hex wallet isn't a valid recipient on those
   * chains.
   */
  toAddress?: string;
  /** Optional slippage override — LiFi default is 0.5% (0.005). */
  slippage?: number;
  /**
   * Issue #411 — restrict LiFi routing to a specific set of DEX
   * aggregators / bridges. When set, LiFi's quote engine refuses to
   * route through any tool not in the allowlist; if no satisfying
   * route exists the SDK throws (NotFoundError / similar), surfacing
   * as a clear error to the caller. When omitted, LiFi picks the
   * best-output tool unconstrained.
   */
  allowExchanges?: string[];
  allowBridges?: string[];
  /**
   * Issue #439 — blocklists for DEX aggregators / bridges. Mirrors
   * `allowExchanges`/`allowBridges` but inverted: LiFi will route
   * around any tool listed here. Independent of the allowlists; both
   * can be set simultaneously (allowlist intersect, then blocklist
   * subtract). Pass-through to LiFi's `denyExchanges` / `denyBridges`.
   */
  denyExchanges?: string[];
  denyBridges?: string[];
  /**
   * Sort criterion LiFi applies when ranking candidate routes. The
   * default is `RECOMMENDED` (LiFi's mix of price + safety). Set
   * `CHEAPEST` for "best rate available" intent (highest output amount),
   * `FASTEST` for low-latency bridges, `SAFEST` for the most-vetted
   * tool set. Pass-through to LiFi's `order` param.
   */
  order?: "RECOMMENDED" | "FASTEST" | "CHEAPEST" | "SAFEST";
}

export type LifiQuoteRequest =
  | (LifiQuoteRequestBase & {
      /** Raw integer amount as string (e.g. "1000000" for 1 USDC). */
      fromAmount: string;
      toAmount?: undefined;
    })
  | (LifiQuoteRequestBase & {
      /** Raw integer output amount as string — exact-out quote. */
      toAmount: string;
      fromAmount?: undefined;
    });

const NATIVE = "0x0000000000000000000000000000000000000000";

// LiFi's canonical native-token handles per non-EVM chain. Source: the
// `nativeToken.address` field in `https://li.quest/v1/chains` for each chain.
const SOLANA_WSOL_NATIVE = "So11111111111111111111111111111111111111112";
const TRON_NATIVE = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";

export async function fetchQuote(req: LifiQuoteRequest) {
  initLifi();
  const fromIsTron = req.fromChain === "tron";
  const fromChain = fromIsTron
    ? LIFI_TRON_CHAIN_ID
    : toLifiChain(req.fromChain as SupportedChain);
  const toIsSolana = req.toChain === "solana";
  const toIsTron = req.toChain === "tron";
  const toChain = toIsSolana
    ? LIFI_SOLANA_CHAIN_ID
    : toIsTron
      ? LIFI_TRON_CHAIN_ID
      : toLifiChain(req.toChain as SupportedChain);
  const fromToken = req.fromToken === "native" ? NATIVE : req.fromToken;
  // Destination native sentinel depends on the chain family — wSOL for
  // Solana, TRX contract for TRON, 0x0…0 for EVM. LiFi's routing graph
  // treats each of these as the canonical native handle for that chain.
  const toToken =
    req.toToken === "native"
      ? toIsSolana
        ? SOLANA_WSOL_NATIVE
        : toIsTron
          ? TRON_NATIVE
          : NATIVE
      : req.toToken;

  // LiFi's `getQuote` accepts allow/deny lists + `order` as optional
  // filters; spread them in only when set so the default (full routing
  // graph, RECOMMENDED order) is preserved.
  const filterFields = {
    ...(req.allowExchanges && req.allowExchanges.length > 0
      ? { allowExchanges: req.allowExchanges }
      : {}),
    ...(req.allowBridges && req.allowBridges.length > 0
      ? { allowBridges: req.allowBridges }
      : {}),
    ...(req.denyExchanges && req.denyExchanges.length > 0
      ? { denyExchanges: req.denyExchanges }
      : {}),
    ...(req.denyBridges && req.denyBridges.length > 0
      ? { denyBridges: req.denyBridges }
      : {}),
    ...(req.order !== undefined ? { order: req.order } : {}),
  };

  if (req.toAmount !== undefined) {
    return getQuote({
      fromChain: fromChain as LifiChainId,
      toChain: toChain as LifiChainId,
      fromToken,
      toToken,
      toAmount: req.toAmount,
      fromAddress: req.fromAddress,
      ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
      slippage: req.slippage,
      ...filterFields,
    });
  }
  return getQuote({
    fromChain: fromChain as LifiChainId,
    toChain: toChain as LifiChainId,
    fromToken,
    toToken,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
    slippage: req.slippage,
    ...filterFields,
  });
}

export async function fetchStatus(txHash: string, fromChain: SupportedChain, toChain: SupportedChain) {
  initLifi();
  return getStatus({
    txHash,
    fromChain: toLifiChain(fromChain) as LifiChainId,
    toChain: toLifiChain(toChain) as LifiChainId,
  });
}

/**
 * Solana-source LiFi quote. Distinct shape from `LifiQuoteRequest` because
 * Solana addresses are base58 (not 0x-prefixed hex) and the destination can
 * be EVM (cross-chain bridge) or Solana (in-chain swap; LiFi will internally
 * route through Jupiter / similar). Output is a LiFi `Quote` whose
 * `transactionRequest.data` field carries the base64-encoded
 * `VersionedTransaction` for the source chain (= Solana) — see
 * `@lifi/sdk/src/_esm/core/Solana/SolanaStepExecutor.js`.
 *
 * `fromToken` accepts either:
 *   - a base58 SPL mint (e.g. USDC mint EPjFW...Dt1v)
 *   - the literal string "native" — interpreted as wrapped-SOL
 *     (So11111111111111111111111111111111111111112), the canonical token
 *     for SOL value transfer in LiFi's API
 *
 * `toToken` accepts:
 *   - base58 SPL mint (when toChain is "solana")
 *   - 0x-prefixed EVM token address (when toChain is an EVM chain)
 *   - "native" for native-asset on either chain (mapped to the chain's
 *     conventional native sentinel by LiFi)
 */
export interface LifiSolanaQuoteRequest {
  /** Solana base58 wallet — funds the swap, signs the source tx. */
  fromAddress: string;
  /** Source token: SPL mint (base58) or "native" for SOL. */
  fromToken: string | "native";
  /** Raw integer base units to sell (e.g. "1000000000" for 1 SOL @ 9 decimals). */
  fromAmount: string;
  /** Destination chain — either "solana" (in-chain swap) or an EVM chain (bridge). */
  toChain: SupportedChain | "solana";
  /** Destination token; format depends on toChain (see jsdoc on the type). */
  toToken: string | "native";
  /** Optional explicit destination wallet (defaults to fromAddress for same-chain). */
  toAddress?: string;
  /** Slippage as a fraction — e.g. 0.005 = 50 bps. LiFi default is 0.005. */
  slippage?: number;
}

const SOLANA_NATIVE_SENTINEL = "11111111111111111111111111111111";
const SOLANA_WSOL_MINT = "So11111111111111111111111111111111111111112";
const EVM_NATIVE_SENTINEL = NATIVE; // 0x0…0

/**
 * Fetch a LiFi quote with Solana as the source chain. Wraps the SDK's
 * `getQuote` (which is chain-agnostic — it accepts numeric chain IDs and
 * `string`-typed addresses + tokens, so this isn't a separate API endpoint).
 *
 * Native-token coercion:
 *   - Source: "native" → wrapped-SOL mint (LiFi treats wSOL as the canonical
 *     SOL handle in its routing graph; the Solana step builds in the wrap
 *     ix when needed).
 *   - Destination: "native" → 0x0…0 if EVM destination, else wrapped-SOL.
 */
export async function fetchSolanaQuote(req: LifiSolanaQuoteRequest) {
  initLifi();
  const fromTokenResolved =
    req.fromToken === "native" ? SOLANA_WSOL_MINT : req.fromToken;
  const toIsSolana = req.toChain === "solana";
  let toTokenResolved: string;
  if (req.toToken === "native") {
    toTokenResolved = toIsSolana ? SOLANA_WSOL_MINT : EVM_NATIVE_SENTINEL;
  } else {
    toTokenResolved = req.toToken;
  }
  const toChainId = toIsSolana
    ? LIFI_SOLANA_CHAIN_ID
    : CHAIN_IDS[req.toChain as SupportedChain];

  return getQuote({
    fromChain: LIFI_SOLANA_CHAIN_ID as LifiChainId,
    toChain: toChainId as LifiChainId,
    fromToken: fromTokenResolved,
    toToken: toTokenResolved,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    ...(req.toAddress !== undefined ? { toAddress: req.toAddress } : {}),
    ...(req.slippage !== undefined ? { slippage: req.slippage } : {}),
  });
}

// Re-export so the Solana wrapper module can use the wSOL constant without
// re-defining it (single source of truth).
export { SOLANA_WSOL_MINT, SOLANA_NATIVE_SENTINEL };

/**
 * LiFi numeric chain ID for native Bitcoin. Source: live
 * `https://li.quest/v1/chains?chainTypes=UTXO` returns
 * `{ id: 20000000000001, key: "btc", chainType: "UTXO" }`. Hoisted as a
 * constant so the BTC quote helper doesn't have to reach into the SDK
 * (the `ChainId` enum bundled with `@lifi/types` does include BTC under
 * `BTC = 20000000000001`, but spelling it here keeps lifi.ts independent
 * of SDK-version drift on this exact constant).
 */
export const LIFI_BITCOIN_CHAIN_ID = 20000000000001 as const;

/**
 * LiFi sentinel for the native BTC token. The chains endpoint reports
 * `nativeToken.address: "bitcoin"` for BTC — not 0x0…0 like EVM, not a
 * mint like Solana. The aggregator's quote endpoint accepts this exact
 * lowercase string.
 */
export const LIFI_BITCOIN_NATIVE_SENTINEL = "bitcoin";

/**
 * Quote request for a BTC-source LiFi swap/bridge. Constrained to the
 * destination chain types LiFi actually exposes a route for from native
 * BTC: every EVM chain in `SupportedChain`, plus Solana. TRON is NOT in
 * LiFi's BTC route table (empirical: `fromChain=BTC&toChain=TRX` returns
 * `tool: null, toAmount: null` — no aggregator path).
 *
 * Why BTC source has its own request type rather than widening
 * `LifiQuoteRequest`:
 *   - `fromAddress` is a Bitcoin bech32 / legacy / p2sh string, not 0x-hex
 *   - `fromToken` is the literal `"bitcoin"` sentinel, not a 0x token addr
 *   - exact-out (`toAmount`) is unsupported for BTC source — bridge
 *     deposit-tag-style memos commit to a fromAmount at quote time
 */
export interface LifiBitcoinQuoteRequest {
  /** Bitcoin source wallet (bech32/taproot/p2sh/legacy). LiFi reads UTXOs from this address. */
  fromAddress: string;
  /** Raw integer satoshi amount as a string (e.g. "500000" for 0.005 BTC). */
  fromAmount: string;
  /**
   * Destination chain. EVM `SupportedChain` for an EVM bridge target,
   * `"solana"` for native SOL/SPL delivery. Other chains rejected by the
   * upstream API.
   */
  toChain: SupportedChain | "solana";
  /**
   * Destination token. EVM hex when `toChain` is EVM; SPL mint (base58)
   * when `toChain === "solana"`. `"native"` resolves to the chain's
   * conventional native sentinel (`0x0…0` for EVM, wSOL mint for Solana).
   */
  toToken: string | "native";
  /**
   * Destination wallet — REQUIRED. The Bitcoin source address is not a
   * valid recipient on any other chain; LiFi has no source-defaults
   * fallback for cross-chain-type routes.
   */
  toAddress: string;
  /** Optional slippage override — LiFi default is 0.5% (0.005). */
  slippage?: number;
}

/**
 * Fetch a LiFi quote with Bitcoin as the source chain. The response's
 * `transactionRequest` has a different shape than EVM/Solana sources:
 *   - `to` — the BTC vault deposit address chosen by the routing solver
 *     (NEAR Intents / Garden / Thorswap / Chainflip / etc.; LiFi
 *     auctions the route across them per request)
 *   - `data` — a hex-encoded PSBT v0 (NOT EVM calldata). The PSBT
 *     carries the OP_RETURN memo committing to the destination chain +
 *     recipient + minOut. `data` field naming is shared with the EVM
 *     shape but the bytes are a Bitcoin PSBT.
 *   - `value` — satoshi amount that the deposit output (output #0)
 *     pays to the vault. Includes any LiFi-side fee outputs the PSBT
 *     also contains.
 *
 * The PSBT inputs are pre-selected by LiFi from `fromAddress`'s on-chain
 * UTXO set (LiFi runs its own indexer pass). Each input carries
 * `witnessUtxo` only — `nonWitnessUtxo` is missing, which Ledger BTC
 * app 2.x rejects (issue #213). Caller MUST hydrate prev-tx hex on every
 * input before forwarding the PSBT to `signPsbtBuffer`.
 */
export async function fetchBitcoinQuote(req: LifiBitcoinQuoteRequest) {
  initLifi();
  const toIsSolana = req.toChain === "solana";
  const toChainId = toIsSolana
    ? LIFI_SOLANA_CHAIN_ID
    : CHAIN_IDS[req.toChain as SupportedChain];
  const toTokenResolved =
    req.toToken === "native"
      ? toIsSolana
        ? SOLANA_WSOL_MINT
        : NATIVE
      : req.toToken;
  return getQuote({
    fromChain: LIFI_BITCOIN_CHAIN_ID as LifiChainId,
    toChain: toChainId as LifiChainId,
    fromToken: LIFI_BITCOIN_NATIVE_SENTINEL,
    toToken: toTokenResolved,
    fromAmount: req.fromAmount,
    fromAddress: req.fromAddress,
    toAddress: req.toAddress,
    ...(req.slippage !== undefined ? { slippage: req.slippage } : {}),
  });
}
