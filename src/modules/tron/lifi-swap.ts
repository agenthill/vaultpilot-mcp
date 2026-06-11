import { createHash } from "node:crypto";
import { fetchQuote } from "../swap/lifi.js";
import { base58ToHex } from "./address.js";
import { isTronAddress } from "../../config/tron.js";
import { issueTronHandle } from "../../signing/tron-tx-store.js";
import {
  decodeTronTriggerSmartContract,
  type DecodedTronTriggerSmartContract,
} from "./verify-raw-data.js";
import {
  tryDecodeLifiBridgeData,
  type DecodedLifiBridgeData,
} from "../../signing/decode-calldata.js";
import { NON_EVM_RECEIVER_SENTINEL } from "../../abis/lifi-diamond.js";
import { matchIntermediateChainBridge } from "../swap/intermediate-chain-bridges.js";
import { SOLANA_ADDRESS } from "../../shared/address-patterns.js";
import { getAddress } from "viem";
import type { SupportedChain, UnsignedTronTx } from "../../types/index.js";

/**
 * TRON-source LiFi swap / bridge.
 *
 * Why this exists separately from `prepare_solana_lifi_swap` and
 * `prepare_swap` (EVM-source): TRON's tx envelope is protobuf, signing is
 * USB HID via `@ledgerhq/hw-app-trx`, and broadcast goes to TronGrid —
 * none of that overlaps with the Solana or EVM flows. Sharing the
 * cross-chain LiFi quote endpoint and the universal BridgeData decoder
 * lets us reuse the security defenses, but the tx-shape work is
 * TRON-specific.
 *
 * ## Tx-shape surgery
 *
 * LiFi returns a fully-formed TRON `Transaction.raw` protobuf in
 * `quote.transactionRequest.data` (hex). Unlike Solana where we own the
 * VersionedMessage compile step, TRON's raw_data is wrap-and-sign — we
 * don't recompile, just validate + pass to Ledger. Validation:
 *
 *   1. Decode the protobuf to extract the inner `TriggerSmartContract`.
 *   2. Assert the contract_address is the LiFi Diamond on TRON
 *      (`TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt`).
 *   3. Assert the owner_address is the user's wallet (catches a wallet
 *      swap inside the protobuf even though `from` in the tx-store would
 *      look correct).
 *   4. Decode the inner ABI calldata (= the EVM-style call to the LiFi
 *      Diamond) and run `verifyLifiBridgeIntent`-equivalent checks:
 *        - destinationChainId matches user-requested toChain
 *        - receiver matches toAddress (EVM dest) or is the LiFi
 *          non-EVM sentinel (Solana dest)
 *
 * ## Broadcast path
 *
 * `tx.rawData` is left undefined — broadcast.ts branches on this and
 * uses `/wallet/broadcasthex` instead of `/wallet/broadcasttransaction`,
 * because we don't have the deserialized JSON shape that the latter
 * requires.
 *
 * ## On-device review
 *
 * The Ledger TRON app does NOT clear-sign LiFi Diamond calls — its
 * allowlist covers System contract types (Transfer, Vote, Freeze) and
 * a small set of TRC-20 selectors (USDT/USDC `transfer`). User must
 * enable "Allow blind signing" in the app's on-device Settings; the
 * device then displays the txID (= sha256 of raw_data_hex), which the
 * user matches against the txID in our prepare receipt.
 *
 * ## TRC-20 source flows
 *
 * If `fromToken` is a TRC-20 mint (not TRX-native), the LiFi Diamond
 * needs prior `approve()` allowance. This builder does NOT check or
 * prepare the approve — the on-chain swap will revert if allowance is
 * insufficient. The agent should explain to the user that TRC-20
 * sources require a prior approve, and either offer one via separate
 * tooling (a `prepare_tron_trc20_approve` is not yet shipped) or
 * confirm they've already approved sufficient allowance.
 */

/** TRON LiFi Diamond — same routing engine as EVM, deployed on TRON mainnet. */
const TRON_LIFI_DIAMOND = "TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt";

/**
 * Same chain-id table as `swap/index.ts:LIFI_CHAIN_ID`; copied here to
 * avoid a cross-module import. The two MUST stay in sync; tests pin
 * both via the LiFi public chain IDs.
 */
const LIFI_CHAIN_ID: Record<SupportedChain | "solana" | "tron", number> = {
  ethereum: 1,
  arbitrum: 42161,
  polygon: 137,
  base: 8453,
  optimism: 10,
  solana: 1151111081099710,
  tron: 728126428,
};

export interface PrepareTronLifiSwapParams {
  /** TRON base58 wallet — funds + signs. T-prefix, 34 chars. */
  wallet: string;
  /**
   * Source token. T-prefixed base58 TRC-20 contract OR the literal
   * string "native" for TRX. TRC-20 source requires prior approve to
   * the LiFi Diamond — this builder does not prepare the approve;
   * insufficient allowance will revert the on-chain swap.
   */
  fromToken: string | "native";
  /** Raw integer base units to sell. */
  fromAmount: string;
  /**
   * Destination chain. Any EVM chain (cross-chain bridge to EVM) or
   * "solana" (cross-chain bridge to Solana). TRON-to-TRON is supported
   * by LiFi (in-chain swap), but `prepare_swap`'s EVM-source surface
   * doesn't quote to TRON either, so we keep the cross-chain-only
   * scope on the TRON-source side too.
   */
  toChain: SupportedChain | "solana";
  /** Destination token. EVM hex when toChain is EVM; SPL mint base58 for "solana". */
  toToken: string | "native";
  /**
   * Destination wallet. REQUIRED — TRON base58 source wallet isn't a
   * valid recipient on EVM or Solana destinations.
   */
  toAddress: string;
  /** Slippage as fraction (0.005 = 50 bps). LiFi default 0.005. */
  slippage?: number;
}

export interface PreparedTronLifiSwapTx {
  handle: string;
  action: "lifi_swap";
  chain: "tron";
  from: string;
  txID: string;
  rawDataHex: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  feeLimitSun?: string;
}

function sha256Hex(hex: string): string {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return createHash("sha256").update(Buffer.from(clean, "hex")).digest("hex");
}

function assertCrossChainAddressing(p: PrepareTronLifiSwapParams): void {
  if (!isTronAddress(p.wallet)) {
    throw new Error(
      `wallet "${p.wallet}" is not a valid TRON base58 address (T-prefix, 34 chars).`,
    );
  }
  if (p.toChain === "solana") {
    if (!SOLANA_ADDRESS.test(p.toAddress)) {
      throw new Error(
        `toAddress "${p.toAddress}" is not a valid Solana base58 address. ` +
          `Refusing to prepare a bridge to an unparseable destination.`,
      );
    }
  } else {
    // EVM destination — toAddress must be EVM hex.
    if (!/^0x[a-fA-F0-9]{40}$/.test(p.toAddress)) {
      throw new Error(
        `toAddress "${p.toAddress}" is not a valid EVM address. For ` +
          `toChain="${p.toChain}" pass a 0x-prefixed 40-hex-char address.`,
      );
    }
  }
}

/**
 * Cross-check the LiFi quote's bridge intent against the user's request.
 * Identical asserts to `swap/index.ts:verifyLifiBridgeIntent`, but operating
 * on TRON-source TriggerSmartContract calldata rather than EVM calldata.
 */
function verifyTronLifiBridgeIntent(
  p: PrepareTronLifiSwapParams,
  trigger: DecodedTronTriggerSmartContract,
): DecodedLifiBridgeData {
  // Owner address must be the user's wallet — catches a swap-and-replay
  // where calldata was prepared for a different account.
  const expectedOwnerHex = base58ToHex(p.wallet).toLowerCase();
  if (trigger.ownerAddressHex.toLowerCase() !== expectedOwnerHex) {
    throw new Error(
      `LiFi TRON tx owner_address mismatch: encoded 0x${trigger.ownerAddressHex} ` +
        `but user wallet is ${p.wallet} (0x${expectedOwnerHex}). Refusing to sign.`,
    );
  }

  // Contract must be the LiFi Diamond on TRON.
  const expectedDiamondHex = base58ToHex(TRON_LIFI_DIAMOND).toLowerCase();
  if (trigger.contractAddressHex.toLowerCase() !== expectedDiamondHex) {
    throw new Error(
      `LiFi TRON tx contract_address mismatch: encoded 0x${trigger.contractAddressHex} ` +
        `but expected the LiFi Diamond on TRON (${TRON_LIFI_DIAMOND}). ` +
        `Refusing to sign — calldata targets a different contract.`,
    );
  }

  // Decode BridgeData from the inner ABI calldata.
  const decoded = tryDecodeLifiBridgeData(trigger.dataHex);
  if (!decoded) {
    throw new Error(
      `LiFi TRON quote returned non-bridge calldata for a cross-chain request ` +
        `(tron → ${p.toChain}) — expected calldata carrying a BridgeData tuple. ` +
        `Refusing to return tx.`,
    );
  }

  const expectedChainId = BigInt(LIFI_CHAIN_ID[p.toChain]);
  if (decoded.destinationChainId !== expectedChainId) {
    // Intermediate-chain bridges (NEAR Intents) legitimately encode a
    // settlement-chain ID instead of the user's final destination.
    // Source-code-constant allowlist — see
    // `src/modules/swap/intermediate-chain-bridges.ts`. Issue #237.
    if (!matchIntermediateChainBridge(decoded)) {
      throw new Error(
        `LiFi bridge calldata destinationChainId mismatch: encoded ` +
          `${decoded.destinationChainId.toString()} but user requested toChain="${p.toChain}" ` +
          `(= ${expectedChainId.toString()}). Refusing to sign.`,
      );
    }
    // TRON-source same-chain (tron → tron) is excluded by the type
    // system: `PrepareTronLifiSwapParams.toChain` is `SupportedChain |
    // "solana"`. So the cross-chain invariant the EVM-source path
    // re-asserts is enforced upstream here. Fall through to
    // receiver-side checks below.
  }

  if (p.toChain === "solana") {
    if (decoded.receiver.toLowerCase() !== NON_EVM_RECEIVER_SENTINEL) {
      throw new Error(
        `LiFi bridge calldata receiver mismatch for non-EVM destination solana: ` +
          `expected the LiFi non-EVM sentinel (${NON_EVM_RECEIVER_SENTINEL}), got ` +
          `${decoded.receiver.toLowerCase()}. Refusing to sign.`,
      );
    }
  } else {
    // EVM destination — receiver must equal toAddress.
    if (getAddress(decoded.receiver) !== getAddress(p.toAddress as `0x${string}`)) {
      throw new Error(
        `LiFi bridge calldata receiver mismatch: encoded ${getAddress(decoded.receiver)} ` +
          `but user requested ${getAddress(p.toAddress as `0x${string}`)}. Refusing to sign.`,
      );
    }
  }

  return decoded;
}

export async function buildTronLifiSwap(
  p: PrepareTronLifiSwapParams,
): Promise<UnsignedTronTx> {
  assertCrossChainAddressing(p);

  // Hand off to LiFi. fetchQuote already supports `fromChain: "tron"` via
  // the wrapper's chain-id resolution.
  const quote = await fetchQuote({
    fromChain: "tron" as unknown as SupportedChain,
    toChain: p.toChain,
    fromToken: p.fromToken === "native"
      ? "native"
      : (p.fromToken as `0x${string}`),
    toToken: p.toToken === "native" ? "native" : (p.toToken as `0x${string}`),
    fromAddress: p.wallet as `0x${string}`,
    toAddress: p.toAddress,
    fromAmount: p.fromAmount,
    ...(p.slippage !== undefined ? { slippage: p.slippage } : {}),
  });

  const txReq = quote.transactionRequest;
  if (!txReq || !txReq.data) {
    throw new Error(
      `LiFi quote returned no transactionRequest.data for TRON source. ` +
        `The route may not be supported — try a different fromToken / toChain combination.`,
    );
  }

  // Decode the TRON protobuf to extract TriggerSmartContract.
  const rawDataStr = String(txReq.data);
  const rawDataHex = rawDataStr.startsWith("0x") ? rawDataStr.slice(2) : rawDataStr;
  const trigger = decodeTronTriggerSmartContract(rawDataHex);

  // Cross-check bridge intent on the inner ABI calldata.
  const bridgeData = verifyTronLifiBridgeIntent(p, trigger);

  // Compute txID. Same convention TronGrid uses: sha256 of the raw_data
  // protobuf bytes. Ledger TRON app displays this on-device when
  // blind-signing; user matches against the prepare receipt.
  const txID = sha256Hex(rawDataHex);

  const fromSym =
    p.fromToken === "native"
      ? "TRX"
      : quote.action.fromToken.symbol ?? p.fromToken;
  const toSym = quote.action.toToken.symbol ?? p.toToken;
  const tool = quote.toolDetails?.name ?? quote.tool ?? "lifi";
  const description =
    `LiFi bridge — ${quote.action.fromAmount} ${fromSym} (TRON) → ` +
    `~${quote.estimate.toAmount} ${toSym} on ${p.toChain} via ${tool}`;

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "lifi_swap",
    from: p.wallet,
    txID,
    // rawData intentionally absent — broadcast.ts uses /broadcasthex.
    rawDataHex,
    description,
    decoded: {
      functionName: "lifi.tron.bridge",
      args: {
        wallet: p.wallet,
        fromToken: p.fromToken,
        fromAmount: p.fromAmount,
        toChain: p.toChain,
        toToken: p.toToken,
        toAddress: p.toAddress,
        bridge: bridgeData.bridge,
        minOutput: quote.estimate.toAmountMin,
        tool: String(tool),
        // TRON LiFi Diamond contract — included so the prepare receipt
        // surfaces what contract the user is calling.
        diamond: TRON_LIFI_DIAMOND,
      },
    },
    ...(trigger.feeLimitSun > 0n
      ? { feeLimitSun: trigger.feeLimitSun.toString() }
      : {}),
  };

  return issueTronHandle(tx);
}
