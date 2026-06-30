import { randomUUID } from "node:crypto";
import { encodeFunctionData, formatUnits, isAddress, parseEther, parseUnits } from "viem";
import { CONTRACTS } from "../../config/contracts.js";
import qrcodeTerminal from "qrcode-terminal";
import { resolveRecipient } from "../../contacts/resolver.js";
import { lookupTokenClass } from "./token-class.js";
import {
  initiatePairing,
  requestSendTransaction,
  getConnectedAccounts,
  WalletConnectRequestTimeoutError,
} from "../../signing/walletconnect.js";
import {
  consumeHandle,
  retireHandle,
  attachPinnedGas,
  getPinnedGas,
  markAmbiguousAttempt,
  getAmbiguousAttempt,
  clearAmbiguousAttempt,
  type AmbiguousAttempt,
  type StashedPin,
} from "../../signing/tx-store.js";
import { consumeTronHandle, retireTronHandle } from "../../signing/tron-tx-store.js";
import {
  consumeSolanaHandle,
  retireSolanaHandle,
  hasSolanaHandle,
  getSolanaDraft,
  pinSolanaHandle,
} from "../../signing/solana-tx-store.js";
import {
  consumeBitcoinHandle,
  retireBitcoinHandle,
  hasBitcoinHandle,
} from "../../signing/btc-tx-store.js";
import { buildCrossCheckBanner } from "../../signing/cross-check-banner.js";
import {
  consumeLitecoinHandle,
  retireLitecoinHandle,
  hasLitecoinHandle,
} from "../../signing/ltc-tx-store.js";
import {
  signBtcPsbtOnLedger,
  getPairedBtcByAddress,
} from "../../signing/btc-usb-signer.js";
import {
  signLtcPsbtOnLedger,
  getPairedLtcByAddress,
} from "../../signing/ltc-usb-signer.js";
import {
  getTronLedgerAddress,
  signTronTxOnLedger,
  setPairedTronAddress,
  getPairedTronByAddress,
  tronPathForAccountIndex,
} from "../../signing/tron-usb-signer.js";
import {
  getSolanaLedgerAddress,
  signSolanaTxOnLedger,
  setPairedSolanaAddress,
  getPairedSolanaByAddress,
  solanaPathForAccountIndex,
} from "../../signing/solana-usb-signer.js";
import { broadcastTronTx } from "../tron/broadcast.js";
import { getTronTransactionStatus } from "../tron/status.js";
import { broadcastSolanaTx } from "../solana/broadcast.js";
import { getSolanaTransactionStatus } from "../solana/status.js";
import {
  buildSolanaNativeSend,
  buildSolanaSplSend,
  buildSolanaNonceInit,
  buildSolanaNonceClose,
  type PreparedSolanaTx,
} from "../solana/actions.js";
import { getSolanaConnection } from "../solana/rpc.js";
import { getDeviceStateHint } from "../diagnostics/ledger-device-info.js";
import { assertTransactionSafe } from "../../signing/pre-sign-check.js";
import {
  eip1559PreSignHash,
  payloadFingerprint,
  tronPayloadFingerprint,
  solanaPayloadFingerprint,
  solanaLedgerMessageHash,
} from "../../signing/verification.js";
import { isClearSignOnlyTx } from "../../signing/render-verification.js";
import { getClient, verifyChainId } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { resolveTokenMeta } from "../shared/token-meta.js";
import { lookupKnownSpender } from "../../security/known-spenders.js";
import { assertNotUnlimitedBurnApproval } from "../shared/approval.js";
import { simulateTx } from "../simulation/index.js";
import { isDemoMode } from "../../demo/index.js";
import {
  buildAaveSupply,
  buildAaveWithdraw,
  buildAaveBorrow,
  buildAaveRepay,
} from "../positions/actions.js";
import {
  buildUniswapMint,
  buildUniswapIncrease,
  buildUniswapDecrease,
  buildUniswapCollect,
  buildUniswapBurn,
  buildUniswapRebalance,
} from "../lp/uniswap-v3/actions.js";
import {
  buildLidoStake,
  buildLidoUnstake,
  buildLidoWrap,
  buildLidoUnwrap,
  buildEigenLayerDeposit,
  buildRocketPoolStake,
  buildRocketPoolUnstake,
} from "../staking/actions.js";
import { buildWethUnwrap } from "../weth/actions.js";
import { buildCustomCall } from "../custom-call/actions.js";
import { getTokenPrice } from "../../data/prices.js";
import type {
  PairLedgerTronArgs,
  PairLedgerSolanaArgs,
  PairLedgerBitcoinArgs,
  PrepareAaveSupplyArgs,
  PrepareAaveWithdrawArgs,
  PrepareAaveBorrowArgs,
  PrepareAaveRepayArgs,
  PrepareUniswapV3MintArgs,
  PrepareUniswapV3IncreaseLiquidityArgs,
  PrepareUniswapV3DecreaseLiquidityArgs,
  PrepareUniswapV3CollectArgs,
  PrepareUniswapV3BurnArgs,
  PrepareUniswapV3RebalanceArgs,
  PrepareLidoStakeArgs,
  PrepareLidoUnstakeArgs,
  PrepareLidoWrapArgs,
  PrepareLidoUnwrapArgs,
  PrepareEigenLayerDepositArgs,
  PrepareRocketPoolStakeArgs,
  PrepareRocketPoolUnstakeArgs,
  PrepareNativeSendArgs,
  PrepareWethUnwrapArgs,
  PrepareTokenSendArgs,
  PrepareRevokeApprovalArgs,
  PrepareTokenApproveArgs,
  PrepareCustomCallArgs,
  PrepareSolanaNativeSendArgs,
  PrepareSolanaSplSendArgs,
  PrepareSolanaNonceInitArgs,
  PrepareSolanaNonceCloseArgs,
  GetSolanaSwapQuoteArgs,
  PrepareSolanaSwapArgs,
  PrepareMarginfiInitArgs,
  PrepareMarginfiSupplyArgs,
  PrepareMarginfiWithdrawArgs,
  PrepareMarginfiBorrowArgs,
  PrepareMarginfiRepayArgs,
  PrepareMarinadeStakeArgs,
  PrepareMarinadeUnstakeImmediateArgs,
  PrepareJitoStakeArgs,
  PrepareNativeStakeDelegateArgs,
  PrepareNativeStakeDeactivateArgs,
  PrepareNativeStakeWithdrawArgs,
  PrepareSolanaLifiSwapArgs,
  PrepareTronLifiSwapArgs,
  PrepareTronSunswapSwapArgs,
  PrepareKaminoInitUserArgs,
  PrepareKaminoSupplyArgs,
  PrepareKaminoBorrowArgs,
  PrepareKaminoWithdrawArgs,
  PrepareKaminoRepayArgs,
  GetKaminoPositionsArgs,
  GetBitcoinBalanceArgs,
  GetBitcoinBalancesArgs,
  GetBitcoinFeeEstimatesArgs,
  GetBitcoinBlockTipArgs,
  GetLitecoinBlockTipArgs,
  GetBitcoinBlocksRecentArgs,
  GetLitecoinBlocksRecentArgs,
  GetBitcoinChainTipsArgs,
  GetLitecoinChainTipsArgs,
  GetBitcoinBlockStatsArgs,
  GetLitecoinBlockStatsArgs,
  GetBitcoinMempoolSummaryArgs,
  GetLitecoinMempoolSummaryArgs,
  GetBitcoinAccountBalanceArgs,
  RescanBitcoinAccountArgs,
  GetBitcoinTxHistoryArgs,
  PrepareBitcoinNativeSendArgs,
  PrepareBitcoinRbfBumpArgs,
  PrepareBitcoinLifiSwapArgs,
  RegisterBitcoinMultisigWalletArgs,
  SignBitcoinMultisigPsbtArgs,
  CombineBitcoinPsbtsArgs,
  FinalizeBitcoinPsbtArgs,
  GetBitcoinMultisigBalanceArgs,
  GetBitcoinMultisigUtxosArgs,
  PrepareBitcoinMultisigSendArgs,
  UnregisterBitcoinMultisigWalletArgs,
  SignBtcMessageArgs,
  PairLedgerLitecoinArgs,
  GetLitecoinBalanceArgs,
  PrepareLitecoinNativeSendArgs,
  SignLtcMessageArgs,
  RescanLitecoinAccountArgs,
  GetMarginfiPositionsArgs,
  GetSolanaStakingPositionsArgs,
  PreviewSendArgs,
  SendTransactionArgs,
  GetTransactionStatusArgs,
  GetTxVerificationArgs,
  GetVerificationArtifactArgs,
} from "./schemas.js";
import { CHAIN_IDS } from "../../types/index.js";
import type {
  SupportedChain,
  UnsignedTx,
  UnsignedTronTx,
  UnsignedSolanaTx,
} from "../../types/index.js";
import { hasTronHandle } from "../../signing/tron-tx-store.js";
import { hasHandle } from "../../signing/tx-store.js";
import { round } from "../../data/format.js";
import {
  notApplicableForTron,
  verifyEvmCalldata,
  type VerifyDecodeResult,
} from "../../signing/verify-decode.js";

/** Render a QR code as an ASCII string (returns promise with the string). */
function qrString(uri: string): Promise<string> {
  return new Promise((resolve) => {
    qrcodeTerminal.generate(uri, { small: true }, (qr: string) => resolve(qr));
  });
}

export async function pairLedgerLive(): Promise<{
  uri: string;
  qr: string;
  instructions: string;
  waitingForApproval: true;
}> {
  const { uri, approval } = await initiatePairing();
  const qr = await qrString(uri);
  // Fire-and-forget: once approval resolves, the session is persisted automatically.
  approval.catch(() => {
    // WalletConnect will surface any error on the next call.
  });
  // If this is a re-pair (prior session exists on disk), surface the
  // cached peer version so the generated instructions lead with the UI
  // path that matched last time. Fresh first-ever pairs have no cached
  // session → version is undefined → instructions fall back to listing
  // both common UI paths.
  const { getCurrentSession } = await import("../../signing/walletconnect.js");
  const { parseLedgerLiveVersion, ledgerLivePairingInstructions } = await import(
    "../../signing/session.js"
  );
  const cached = getCurrentSession();
  const cachedVersion = parseLedgerLiveVersion(cached?.peer?.metadata);
  return {
    uri,
    qr,
    instructions:
      ledgerLivePairingInstructions(cachedVersion) +
      " VERIFY BEFORE FIRST USE: once pairing completes, the EVM addresses " +
      "Ledger Live shares are exposed via `get_ledger_status`. Before any " +
      "`prepare_*` uses one of those addresses, surface its FULL string (no " +
      "truncation) and have the user cross-check it against (a) Ledger Live " +
      "→ Settings → Connected Apps (the WC session entry shows the shared " +
      "accounts), and (b) the on-device 'Display address' screen for the " +
      "matching account in the Ethereum / chain-specific app. " +
      "On any mismatch, abort — a compromised middle layer may have " +
      "substituted addresses.",
    waitingForApproval: true,
  };
}

/**
 * Pair the host's directly-connected Ledger device for TRON signing. Unlike
 * `pair_ledger_live` (WalletConnect relay for EVM), TRON signs over USB HID —
 * the Ledger must be plugged into the host running this MCP, unlocked, with
 * the TRON app open. Reads + caches the device address at the BIP-44 path
 * derived from `accountIndex` (default 0 = first Ledger Live TRON account)
 * so subsequent `get_ledger_status` calls can report it without re-probing.
 * Call with different `accountIndex` values to expose multiple TRON accounts.
 */
export async function pairLedgerTron(args: PairLedgerTronArgs = {}): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = tronPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getTronLedgerAddress(path);
  } catch (e) {
    // Enrich the error with device-state probe data (which app is open
    // RIGHT NOW). The probe runs only on the failure path so successful
    // pairs don't pay the extra USB round-trip. If the probe itself
    // fails — likely because the same USB-HID resource is still busy —
    // we silently fall through to the original error message.
    const hint = await getDeviceStateHint("Tron");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedTronAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "TRON account paired. You can now call `prepare_tron_*` with this address and " +
      "forward the handle via `send_transaction`. Keep the Ledger plugged in with the " +
      "TRON app open — each sign re-opens USB and re-verifies the device address. " +
      "To pair a different slot, call `pair_ledger_tron` again with another `accountIndex`. " +
      "VERIFY BEFORE FIRST USE: surface this FULL address (no truncation) and have " +
      "the user verify it character-by-character against the device's 'Receive' / " +
      "'Show address' screen on the TRON app. On any mismatch, abort — a " +
      "compromised middle layer may have substituted the address.",
  };
}

/**
 * Pair the host's directly-connected Ledger device for Solana signing.
 * Unlike `pair_ledger_live` (WalletConnect relay for EVM), Solana signs
 * over USB HID because Ledger Live's WalletConnect integration does not
 * expose Solana accounts (confirmed 2026-04-23). The Ledger must be
 * plugged in, unlocked, with the Solana app open. Reads + caches the
 * device address at path `44'/501'/<accountIndex>'` (default 0 = first
 * Ledger Live Solana account).
 */
/**
 * Pair the host's directly-connected Ledger device for Bitcoin signing.
 * Same USB-HID rationale as `pair_ledger_solana` and `pair_ledger_tron`:
 * Ledger Live's WalletConnect relay does not expose `bip122` accounts
 * to dApps, so Bitcoin signing happens over USB HID. The Ledger must be
 * plugged in, unlocked, with the Bitcoin app open.
 *
 * One call enumerates ALL FOUR address types (legacy / p2sh-segwit /
 * segwit / taproot) for the given account index — the user sees their
 * full footprint per Ledger Live Bitcoin account in a single round-trip.
 * Each derivation is just `getWalletPublicKey` (read-only); no on-device
 * confirmation is requested by default. Subsequent calls with different
 * `accountIndex` values expose more accounts.
 */
export async function pairLedgerBitcoin(args: PairLedgerBitcoinArgs = {}): Promise<{
  accountIndex: number;
  gapLimit: number;
  appVersion: string;
  addresses: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    address: string;
    path: string;
    chain: 0 | 1;
    addressIndex: number;
    txCount: number;
  }>;
  summary: {
    totalDerived: number;
    used: number;
    unused: number;
  };
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const {
    scanBtcAccount,
    setPairedBtcAddress,
    clearPairedBtcAccount,
    DEFAULT_BTC_GAP_LIMIT,
  } = await import("../../signing/btc-usb-signer.js");
  const gapLimit = args.gapLimit ?? DEFAULT_BTC_GAP_LIMIT;

  // The indexer's getBalance() returns txCount alongside the balance —
  // reuse it as the gap-limit probe so we don't add a second HTTP API
  // surface. One round trip per derived address.
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const indexer = getBitcoinIndexer();
  const fetchTxCount = async (addr: string): Promise<number> => {
    const bal = await indexer.getBalance(addr);
    return bal.txCount;
  };

  let derived;
  try {
    derived = await scanBtcAccount({
      accountIndex,
      gapLimit,
      fetchTxCount,
    });
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron / pairLedgerSolana —
    // probe which app is currently open so the agent can tell the user
    // to switch to Bitcoin.
    const hint = await getDeviceStateHint("Bitcoin");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  // Drop any stale entries for this accountIndex BEFORE persisting the
  // fresh scan — protects against the case where a prior scan walked
  // further than this one (e.g. funds moved out, gap window now stops
  // earlier) and would otherwise leave dangling cached paths.
  clearPairedBtcAccount(accountIndex);
  for (const entry of derived.entries) {
    setPairedBtcAddress({
      address: entry.address,
      publicKey: entry.publicKey,
      path: entry.path,
      appVersion: entry.appVersion,
      addressType: entry.addressType,
      accountIndex: entry.accountIndex,
      chain: entry.chain,
      addressIndex: entry.addressIndex,
      txCount: entry.txCount,
    });
  }
  const used = derived.entries.filter((e) => e.txCount > 0).length;
  return {
    accountIndex,
    gapLimit,
    appVersion: derived.appVersion,
    addresses: derived.entries.map((e) => ({
      addressType: e.addressType,
      address: e.address,
      path: e.path,
      chain: e.chain,
      addressIndex: e.addressIndex,
      txCount: e.txCount,
    })),
    summary: {
      totalDerived: derived.entries.length,
      used,
      unused: derived.entries.length - used,
    },
    instructions:
      "Bitcoin account paired with BIP44 gap-limit scanning. Both the receive " +
      "(/0/i) and change (/1/i) chains were walked across all four address types " +
      "until " +
      gapLimit +
      " consecutive empty addresses were observed. Every address with on-chain " +
      "history is cached, plus the next fresh receive address per chain. Use " +
      "`get_btc_account_balance({ accountIndex })` to sum across the cached set " +
      "for this account, or `get_btc_balance` against any single cached address. " +
      "Re-run `pair_ledger_btc` to refresh the cache; previously-cached entries " +
      "for this accountIndex are dropped before the new scan persists. " +
      "VERIFY BEFORE FIRST USE: before any `prepare_btc_*_send` or " +
      "`send_transaction` uses one of these addresses, surface its FULL string " +
      "(no truncation) and have the user verify it character-by-character against " +
      "the device's 'Display address' screen (Bitcoin app → Display address → " +
      "select the matching BIP path). On any mismatch, abort — a compromised " +
      "middle layer may have substituted addresses.",
  };
}

export async function pairLedgerSolana(
  args: PairLedgerSolanaArgs = {},
): Promise<{
  address: string;
  path: string;
  appVersion: string;
  accountIndex: number;
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const path = solanaPathForAccountIndex(accountIndex);
  let result;
  try {
    result = await getSolanaLedgerAddress(path);
  } catch (e) {
    // Same enrichment pattern as pairLedgerTron — see comment there.
    const hint = await getDeviceStateHint("Solana");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  setPairedSolanaAddress(result);
  return {
    address: result.address,
    path: result.path,
    appVersion: result.appVersion,
    accountIndex,
    instructions:
      "Solana account paired. You can now call `prepare_solana_native_send` / " +
      "`prepare_solana_spl_send` with this address and forward the handle via " +
      "`send_transaction`. Keep the Ledger plugged in with the Solana app open " +
      "— each sign re-opens USB and re-verifies the device address. Native SOL " +
      "sends clear-sign (amount + recipient shown on-device). SPL token sends " +
      "BLIND-SIGN — the Ledger Solana app requires a signed Trusted-Name " +
      "descriptor that only Ledger Live supplies, so the device shows a " +
      "'Message Hash' instead of decoded fields. For SPL: (1) enable 'Allow " +
      "blind signing' in Solana app → Settings, (2) match the Message Hash " +
      "surfaced in the preview against the on-device value. To pair another " +
      "slot, call `pair_ledger_solana` again with a different `accountIndex`. " +
      "VERIFY BEFORE FIRST USE: surface this FULL address (no truncation) " +
      "and have the user verify it character-by-character against the " +
      "device's 'Public Key' / 'Show address' screen on the Solana app. " +
      "On any mismatch, abort — a compromised middle layer may have " +
      "substituted the address.",
  };
}

export async function prepareSolanaNativeSend(
  args: PrepareSolanaNativeSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
    ...(args.memo !== undefined ? { memo: args.memo } : {}),
  });
}

export async function prepareSolanaSplSend(
  args: PrepareSolanaSplSendArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaSplSend({
    wallet: args.wallet,
    mint: args.mint,
    to: args.to,
    amount: args.amount,
  });
}

export async function prepareSolanaNonceInit(
  args: PrepareSolanaNonceInitArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceInit({ wallet: args.wallet });
}

export async function prepareSolanaNonceClose(
  args: PrepareSolanaNonceCloseArgs,
): Promise<PreparedSolanaTx> {
  return buildSolanaNonceClose({ wallet: args.wallet });
}

export async function getSolanaSwapQuote(args: GetSolanaSwapQuoteArgs) {
  const { getJupiterQuote } = await import("../solana/jupiter.js");
  return getJupiterQuote({
    inputMint: args.inputMint,
    outputMint: args.outputMint,
    amount: args.amount,
    slippageBps: args.slippageBps,
    swapMode: args.swapMode,
    ...(args.dexes !== undefined ? { dexes: args.dexes } : {}),
    ...(args.excludeDexes !== undefined ? { excludeDexes: args.excludeDexes } : {}),
  });
}

export async function prepareMarginfiInit(
  args: PrepareMarginfiInitArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiInit } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiInit({
    wallet: args.wallet,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiSupply(
  args: PrepareMarginfiSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiSupply } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiSupply({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiWithdraw(
  args: PrepareMarginfiWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiWithdraw } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiWithdraw({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.withdrawAll !== undefined ? { withdrawAll: args.withdrawAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiBorrow(
  args: PrepareMarginfiBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiBorrow } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiBorrow({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarginfiRepay(
  args: PrepareMarginfiRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarginfiRepay } = await import("../solana/marginfi.js");
  const prepared = await buildMarginfiRepay({
    wallet: args.wallet,
    ...(args.symbol !== undefined ? { symbol: args.symbol } : {}),
    ...(args.mint !== undefined ? { mint: args.mint } : {}),
    amount: args.amount,
    ...(args.accountIndex !== undefined ? { accountIndex: args.accountIndex } : {}),
    ...(args.repayAll !== undefined ? { repayAll: args.repayAll } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeStake(
  args: PrepareMarinadeStakeArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeStake } = await import("../solana/marinade.js");
  const prepared = await buildMarinadeStake({
    wallet: args.wallet,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareMarinadeUnstakeImmediate(
  args: PrepareMarinadeUnstakeImmediateArgs,
): Promise<PreparedSolanaTx> {
  const { buildMarinadeUnstakeImmediate } = await import(
    "../solana/marinade.js"
  );
  const prepared = await buildMarinadeUnstakeImmediate({
    wallet: args.wallet,
    amountMSol: args.amountMSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareJitoStake(
  args: PrepareJitoStakeArgs,
): Promise<PreparedSolanaTx> {
  const { buildJitoStake } = await import("../solana/jito.js");
  const prepared = await buildJitoStake({
    wallet: args.wallet,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDelegate(
  args: PrepareNativeStakeDelegateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDelegate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDelegate({
    wallet: args.wallet,
    validator: args.validator,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeDeactivate(
  args: PrepareNativeStakeDeactivateArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeDeactivate } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeDeactivate({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareNativeStakeWithdraw(
  args: PrepareNativeStakeWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildNativeStakeWithdraw } = await import(
    "../solana/native-stake.js"
  );
  const prepared = await buildNativeStakeWithdraw({
    wallet: args.wallet,
    stakeAccount: args.stakeAccount,
    amountSol: args.amountSol,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareSolanaLifiSwap(
  args: PrepareSolanaLifiSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildLifiSolanaSwap } = await import("../solana/lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  const prepared = await buildLifiSolanaSwap({
    wallet: args.wallet,
    fromMint: args.fromMint,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildLifiSolanaSwap>[0]["toChain"],
    toToken: args.toToken,
    ...(args.toAddress !== undefined ? { toAddress: args.toAddress } : {}),
    ...(slippage !== undefined ? { slippage } : {}),
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareTronLifiSwap(
  args: PrepareTronLifiSwapArgs,
): Promise<UnsignedTronTx> {
  const { buildTronLifiSwap } = await import("../tron/lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  return buildTronLifiSwap({
    wallet: args.wallet,
    fromToken: args.fromToken,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildTronLifiSwap>[0]["toChain"],
    toToken: args.toToken,
    toAddress: args.toAddress,
    ...(slippage !== undefined ? { slippage } : {}),
  });
}

export async function prepareTronSunswapSwap(
  args: PrepareTronSunswapSwapArgs,
): Promise<UnsignedTronTx> {
  const { buildTronSunswapSwap } = await import("../tron/sunswap-swap.js");
  return buildTronSunswapSwap({
    wallet: args.wallet,
    fromToken: args.fromToken,
    toToken: args.toToken,
    amount: args.amount,
    ...(args.slippageBps !== undefined ? { slippageBps: args.slippageBps } : {}),
    ...(args.deadlineSeconds !== undefined
      ? { deadlineSeconds: args.deadlineSeconds }
      : {}),
    ...(args.fromTokenDecimals !== undefined
      ? { fromTokenDecimals: args.fromTokenDecimals }
      : {}),
    ...(args.toTokenDecimals !== undefined
      ? { toTokenDecimals: args.toTokenDecimals }
      : {}),
    ...(args.feeLimitTrx !== undefined ? { feeLimitTrx: args.feeLimitTrx } : {}),
  });
}

export async function prepareKaminoInitUser(
  args: PrepareKaminoInitUserArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoInitUser } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoInitUser({ wallet: args.wallet });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoSupply(
  args: PrepareKaminoSupplyArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoSupply } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoSupply({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoBorrow(
  args: PrepareKaminoBorrowArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoBorrow } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoBorrow({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoWithdraw(
  args: PrepareKaminoWithdrawArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoWithdraw } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoWithdraw({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function prepareKaminoRepay(
  args: PrepareKaminoRepayArgs,
): Promise<PreparedSolanaTx> {
  const { buildKaminoRepay } = await import("../solana/kamino-actions.js");
  const prepared = await buildKaminoRepay({
    wallet: args.wallet,
    mint: args.mint,
    amount: args.amount,
  });
  return prepared as unknown as PreparedSolanaTx;
}

export async function getKaminoPositions(args: GetKaminoPositionsArgs) {
  const { getKaminoPositions: reader } = await import(
    "../positions/kamino.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getBitcoinBalance(args: GetBitcoinBalanceArgs) {
  const { getBitcoinBalance: reader } = await import(
    "../btc/balances.js"
  );
  return reader(args.address);
}

export async function getBitcoinBalances(args: GetBitcoinBalancesArgs) {
  const { getBitcoinBalances: reader } = await import(
    "../btc/balances.js"
  );
  return { balances: await reader(args.addresses) };
}

export async function getBitcoinFeeEstimates(_args: GetBitcoinFeeEstimatesArgs) {
  void _args;
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  return getBitcoinIndexer().getFeeEstimates();
}

export async function getBitcoinBlockTip(_args: GetBitcoinBlockTipArgs) {
  void _args;
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  return getBitcoinIndexer().getBlockTip();
}

export async function getLitecoinBlockTip(_args: GetLitecoinBlockTipArgs) {
  void _args;
  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  return getLitecoinIndexer().getBlockTip();
}

export async function getBitcoinBlocksRecent(args: GetBitcoinBlocksRecentArgs) {
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const blocks = await getBitcoinIndexer().getRecentBlocks(args.limit);
  return { chain: "bitcoin" as const, count: blocks.length, blocks };
}

export async function getLitecoinBlocksRecent(args: GetLitecoinBlocksRecentArgs) {
  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  const blocks = await getLitecoinIndexer().getRecentBlocks(args.limit);
  return { chain: "litecoin" as const, count: blocks.length, blocks };
}

// ---------- Issue #248: optional bitcoind / litecoind RPC-tier handlers ----------
// All three handlers per chain follow the same shape:
//   1. Resolve RPC config from env. If null, return `available: false`.
//   2. Call the typed wrapper.
//   3. Wrap any JsonRpcError / JsonRpcTransportError in a structured
//      `available: false` envelope so the agent gets a useful reason.

interface RpcUnavailable {
  available: false;
  reason: string;
  hint: string;
}

const RPC_HINT_BTC =
  "Configure `BITCOIN_RPC_URL` (and optionally `BITCOIN_RPC_COOKIE` for self-hosted bitcoind, or `BITCOIN_RPC_USER`+`BITCOIN_RPC_PASSWORD`, or `BITCOIN_RPC_AUTH_HEADER_NAME`+`BITCOIN_RPC_AUTH_HEADER_VALUE` for hosted providers). See INSTALL.md.";
const RPC_HINT_LTC =
  "Configure `LITECOIN_RPC_URL` (and optionally `LITECOIN_RPC_COOKIE` for self-hosted litecoind, or `LITECOIN_RPC_USER`+`LITECOIN_RPC_PASSWORD`, or `LITECOIN_RPC_AUTH_HEADER_NAME`+`LITECOIN_RPC_AUTH_HEADER_VALUE` for hosted providers). See INSTALL.md.";

async function callBitcoinRpc<T>(
  fn: (cfg: import("../../data/jsonrpc.js").JsonRpcClientConfig) => Promise<T>,
): Promise<T | RpcUnavailable> {
  const { resolveBitcoinRpcConfig } = await import("../../config/btc.js");
  const cfg = resolveBitcoinRpcConfig();
  if (!cfg) {
    return {
      available: false,
      reason: "BITCOIN_RPC_URL not set",
      hint: RPC_HINT_BTC,
    };
  }
  try {
    return await fn(cfg);
  } catch (err) {
    return {
      available: false,
      reason: `RPC call failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: RPC_HINT_BTC,
    };
  }
}

async function callLitecoinRpc<T>(
  fn: (cfg: import("../../data/jsonrpc.js").JsonRpcClientConfig) => Promise<T>,
): Promise<T | RpcUnavailable> {
  const { resolveLitecoinRpcConfig } = await import("../../config/litecoin.js");
  const cfg = resolveLitecoinRpcConfig();
  if (!cfg) {
    return {
      available: false,
      reason: "LITECOIN_RPC_URL not set",
      hint: RPC_HINT_LTC,
    };
  }
  try {
    return await fn(cfg);
  } catch (err) {
    return {
      available: false,
      reason: `RPC call failed: ${err instanceof Error ? err.message : String(err)}`,
      hint: RPC_HINT_LTC,
    };
  }
}

export async function getBitcoinChainTips(_args: GetBitcoinChainTipsArgs) {
  void _args;
  const { getChainTips } = await import("../utxo/rpc-client.js");
  const tips = await callBitcoinRpc((cfg) => getChainTips(cfg));
  if ("available" in tips) return { chain: "bitcoin" as const, ...tips };
  return { chain: "bitcoin" as const, available: true as const, tipCount: tips.length, tips };
}

export async function getLitecoinChainTips(_args: GetLitecoinChainTipsArgs) {
  void _args;
  const { getChainTips } = await import("../utxo/rpc-client.js");
  const tips = await callLitecoinRpc((cfg) => getChainTips(cfg));
  if ("available" in tips) return { chain: "litecoin" as const, ...tips };
  return { chain: "litecoin" as const, available: true as const, tipCount: tips.length, tips };
}

export async function getBitcoinBlockStats(args: GetBitcoinBlockStatsArgs) {
  const { getBlockStats } = await import("../utxo/rpc-client.js");
  const stats = await callBitcoinRpc((cfg) => getBlockStats(cfg, args.hashOrHeight));
  if ("available" in stats) return { chain: "bitcoin" as const, ...stats };
  return { chain: "bitcoin" as const, available: true as const, stats };
}

export async function getLitecoinBlockStats(args: GetLitecoinBlockStatsArgs) {
  const { getBlockStats } = await import("../utxo/rpc-client.js");
  const stats = await callLitecoinRpc((cfg) => getBlockStats(cfg, args.hashOrHeight));
  if ("available" in stats) return { chain: "litecoin" as const, ...stats };
  return { chain: "litecoin" as const, available: true as const, stats };
}

export async function getBitcoinMempoolSummary(_args: GetBitcoinMempoolSummaryArgs) {
  void _args;
  const { getMempoolInfo } = await import("../utxo/rpc-client.js");
  const info = await callBitcoinRpc((cfg) => getMempoolInfo(cfg));
  if ("available" in info) return { chain: "bitcoin" as const, ...info };
  return { chain: "bitcoin" as const, available: true as const, mempool: info };
}

export async function getLitecoinMempoolSummary(_args: GetLitecoinMempoolSummaryArgs) {
  void _args;
  const { getMempoolInfo } = await import("../utxo/rpc-client.js");
  const info = await callLitecoinRpc((cfg) => getMempoolInfo(cfg));
  if ("available" in info) return { chain: "litecoin" as const, ...info };
  return { chain: "litecoin" as const, available: true as const, mempool: info };
}

/**
 * Refresh the indexer-side `txCount` for every cached BTC address
 * under one Ledger account, without touching the device. Distinct from
 * `pair_ledger_btc` (which DOES touch the device, deriving fresh leaf
 * paths) — this tool only re-probes the indexer for already-derived
 * addresses and updates the persisted cache.
 *
 * Use case: the user received funds AFTER the original gap-limit scan
 * (so the cached entry's `txCount === 0` is stale), or the indexer
 * was cold/lagging at scan time. Either way the addresses themselves
 * are correct; only the on-chain history snapshot needs refreshing.
 *
 * If the LAST cached address on a chain (the trailing buffer empty)
 * now has on-chain history, the response flags `needsExtend: true` —
 * funds may exist past the originally-walked gap window, and the
 * caller should run `pair_ledger_btc` again (which DOES use the
 * device) to extend the scan.
 *
 * Issue #191.
 */
export async function rescanBitcoinAccount(args: RescanBitcoinAccountArgs) {
  const { getPairedBtcAddresses, setPairedBtcAddress } = await import(
    "../../signing/btc-usb-signer.js"
  );
  const all = getPairedBtcAddresses();
  const forAccount = all.filter(
    (e) => e.accountIndex === args.accountIndex,
  );
  if (forAccount.length === 0) {
    throw new Error(
      `No paired Bitcoin entries cached for accountIndex=${args.accountIndex}. ` +
        `Run \`pair_ledger_btc({ accountIndex: ${args.accountIndex} })\` first ` +
        `to populate the cache. \`rescan_btc_account\` only refreshes existing ` +
        `entries — it cannot derive new addresses (that needs the Ledger device).`,
    );
  }
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const indexer = getBitcoinIndexer();
  const { pLimitMap } = await import("../../data/http.js");
  const { resolveBitcoinIndexerParallelism } = await import(
    "../../config/btc.js"
  );
  // Indexer fan-out is purely HTTP — parallelize for speed but cap
  // concurrency to avoid bursting past mempool.space's free-tier
  // rate limit (issue #199; ~40% probe failures observed without a
  // cap on a 100+-address account). Per-address failures degrade
  // gracefully (the entry's txCount stays at its prior value rather
  // than getting wiped to 0). The configured cap can be overridden
  // via `BITCOIN_INDEXER_PARALLELISM` env var; self-hosted Esplora
  // users with no rate concerns can set it as high as 32.
  const parallelism = resolveBitcoinIndexerParallelism();
  const probes = await pLimitMap(forAccount, parallelism, (e) =>
    indexer.getBalance(e.address),
  );

  type BTCEntry = (typeof forAccount)[number];
  type ChainKey = `${BTCEntry["addressType"]}:${0 | 1}`;
  const chainBuckets = new Map<ChainKey, BTCEntry[]>();
  const refreshed: Array<{
    address: string;
    addressType: BTCEntry["addressType"];
    chain: 0 | 1 | null;
    addressIndex: number | null;
    path: string;
    previousTxCount: number;
    txCount: number;
    delta: number;
    fetchOk: boolean;
  }> = [];
  for (let i = 0; i < forAccount.length; i++) {
    const entry = forAccount[i];
    const probe = probes[i];
    const previousTxCount = entry.txCount ?? 0;
    let liveTxCount = previousTxCount;
    let fetchOk = false;
    if (probe.status === "fulfilled") {
      liveTxCount = probe.value.txCount;
      fetchOk = true;
      // Persist the refresh so subsequent get_btc_account_balance
      // calls reflect the updated state without re-rescanning.
      if (liveTxCount !== previousTxCount) {
        setPairedBtcAddress({ ...entry, txCount: liveTxCount });
      }
    }
    refreshed.push({
      address: entry.address,
      addressType: entry.addressType,
      chain: entry.chain ?? null,
      addressIndex: entry.addressIndex ?? null,
      path: entry.path,
      previousTxCount,
      txCount: liveTxCount,
      delta: liveTxCount - previousTxCount,
      fetchOk,
    });
    if (entry.chain === 0 || entry.chain === 1) {
      const key: ChainKey = `${entry.addressType}:${entry.chain}`;
      const bucket = chainBuckets.get(key);
      if (bucket) bucket.push(entry);
      else chainBuckets.set(key, [entry]);
    }
  }

  // needsExtend: for any (type, chain), if the entry with the LARGEST
  // addressIndex (the trailing buffer empty from the original walk)
  // now has txCount > 0, the gap window may no longer cover all funds
  // and the user should re-pair to extend. Issue #197 — the tail
  // probe has THREE outcomes; conflating "rejected" with "healthy"
  // silently masks an extend that's needed.
  let needsExtend = false;
  const extendChains: Array<{
    addressType: BTCEntry["addressType"];
    chain: 0 | 1;
    lastAddressIndex: number;
  }> = [];
  // Tail probes whose live HTTP call rejected — we don't know whether
  // the chain has been exceeded. Caller should rerun the rescan once
  // (or when the indexer is healthier) to re-test those chains;
  // re-pairing is only warranted when needsExtend turns true.
  const unverifiedChains: Array<{
    addressType: BTCEntry["addressType"];
    chain: 0 | 1;
    lastAddressIndex: number;
  }> = [];
  for (const [key, bucket] of chainBuckets) {
    const tail = bucket.reduce((max, e) =>
      (e.addressIndex ?? -1) > (max.addressIndex ?? -1) ? e : max,
    );
    const i = forAccount.indexOf(tail);
    const probe = probes[i];
    const [addressTypeStr, chainStr] = key.split(":");
    const chainEntry = {
      addressType: addressTypeStr as BTCEntry["addressType"],
      chain: Number(chainStr) as 0 | 1,
      lastAddressIndex: tail.addressIndex ?? -1,
    };
    if (probe.status === "rejected") {
      // Tail probe failed — indeterminate. Surface as `unverifiedChains`
      // so the caller can distinguish "definitely healthy" from "we
      // didn't get a clean signal this run".
      unverifiedChains.push(chainEntry);
      continue;
    }
    if (probe.value.txCount > 0) {
      needsExtend = true;
      extendChains.push(chainEntry);
    }
  }

  const fetchFailures = refreshed.filter((r) => !r.fetchOk).length;
  const txCountChanges = refreshed.filter((r) => r.delta !== 0).length;
  // Note text adapts to which combination of signals fired. The "go
  // re-pair" prompt only fires for `needsExtend`; an `unverified`-only
  // response asks the caller to retry the rescan rather than
  // immediately re-pair (re-pairing forces a device interaction the
  // user may not want for a probably-transient indexer hiccup).
  let note: string | undefined;
  if (needsExtend) {
    note =
      "The trailing empty address on at least one cached chain now has " +
      "on-chain history. The original gap-limit window may miss funds " +
      "past it. Run `pair_ledger_btc({ accountIndex: " +
      args.accountIndex +
      " })` to extend the scan with fresh on-device derivations." +
      (unverifiedChains.length > 0
        ? " (Some other chains' tail probes failed and are reported as " +
          "`unverifiedChains` — those are independent of the extend signal.)"
        : "");
  } else if (unverifiedChains.length > 0) {
    note =
      "Some chains' tail probes failed this run, so we can't confirm the " +
      "gap window is still healthy for them — see `unverifiedChains`. " +
      "This is usually a transient indexer hiccup (rate limit / 5xx); " +
      "re-run `rescan_btc_account` after a moment. Don't re-pair on this " +
      "alone — `needsExtend: true` is the signal for that.";
  }
  return {
    accountIndex: args.accountIndex,
    addressesScanned: refreshed.length,
    txCountChanges,
    fetchFailures,
    needsExtend,
    ...(needsExtend ? { extendChains } : {}),
    ...(unverifiedChains.length > 0 ? { unverifiedChains } : {}),
    refreshed,
    ...(note ? { note } : {}),
  };
}

/**
 * Aggregate the on-chain balance across every CACHED used-address for
 * one Ledger BTC account index. Walks the in-memory + persisted
 * pairing cache (populated by `pair_ledger_btc`'s gap-limit scan),
 * filters to entries with `txCount > 0` (skip the trailing fresh
 * receive addresses to keep fan-out tight), fans out to the indexer's
 * per-address `getBalance`, and surfaces both the rolled-up totals and
 * the per-leg breakdown so the agent can show which addresses hold
 * what.
 */
export async function getBitcoinAccountBalance(
  args: GetBitcoinAccountBalanceArgs,
) {
  const { getPairedBtcAddresses } = await import(
    "../../signing/btc-usb-signer.js"
  );
  const all = getPairedBtcAddresses();
  const forAccount = all.filter(
    (e) => e.accountIndex === args.accountIndex,
  );
  if (forAccount.length === 0) {
    throw new Error(
      `No paired Bitcoin entries cached for accountIndex=${args.accountIndex}. ` +
        `Run \`pair_ledger_btc({ accountIndex: ${args.accountIndex} })\` first ` +
        `to populate the cache.`,
    );
  }
  // Used = ever observed on-chain history at scan time. Empty (txCount===0)
  // entries are kept in the cache for receive-UX (next fresh address) but
  // skipped here to avoid 80 unneeded indexer hits per call.
  const used = forAccount.filter((e) => (e.txCount ?? 0) > 0);
  if (used.length === 0) {
    return {
      accountIndex: args.accountIndex,
      addressesQueried: 0,
      addressesCached: forAccount.length,
      totalConfirmedSats: "0",
      totalConfirmedBtc: "0",
      totalMempoolSats: "0",
      totalSats: "0",
      breakdown: [] as Array<{
        address: string;
        addressType: string;
        chain: 0 | 1 | null;
        addressIndex: number | null;
        path: string;
        confirmedSats: string;
        mempoolSats: string;
        totalSats: string;
      }>,
      note:
        "All cached addresses for this account had zero on-chain history at " +
        "scan time. If you've recently received funds, call " +
        "`rescan_btc_account` to refresh the cached txCount via the indexer " +
        "(no Ledger device needed). If funds may have landed past the original " +
        "gap-limit window, re-run `pair_ledger_btc` to extend the scan.",
    };
  }
  const { getBitcoinBalance } = await import("../btc/balances.js");
  const results = await Promise.allSettled(
    used.map((e) => getBitcoinBalance(e.address)),
  );
  let totalConfirmed = 0n;
  let totalMempool = 0n;
  const breakdown: Array<{
    address: string;
    addressType: string;
    chain: 0 | 1 | null;
    addressIndex: number | null;
    path: string;
    confirmedSats: string;
    mempoolSats: string;
    totalSats: string;
  }> = [];
  for (let i = 0; i < used.length; i++) {
    const entry = used[i];
    const r = results[i];
    if (r.status !== "fulfilled") continue;
    totalConfirmed += r.value.confirmedSats;
    totalMempool += r.value.mempoolSats;
    breakdown.push({
      address: entry.address,
      addressType: entry.addressType,
      chain: entry.chain ?? null,
      addressIndex: entry.addressIndex ?? null,
      path: entry.path,
      confirmedSats: r.value.confirmedSats.toString(),
      mempoolSats: r.value.mempoolSats.toString(),
      totalSats: r.value.totalSats.toString(),
    });
  }
  // Format BTC string from bigint sats (8 decimals, trailing zeros stripped).
  const SATS_PER_BTC = 100_000_000n;
  const fmt = (sats: bigint): string => {
    const negative = sats < 0n;
    const abs = negative ? -sats : sats;
    const whole = abs / SATS_PER_BTC;
    const frac = abs - whole * SATS_PER_BTC;
    const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
    const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
    return negative ? `-${body}` : body;
  };
  return {
    accountIndex: args.accountIndex,
    addressesQueried: breakdown.length,
    addressesCached: forAccount.length,
    totalConfirmedSats: totalConfirmed.toString(),
    totalConfirmedBtc: fmt(totalConfirmed),
    totalMempoolSats: totalMempool.toString(),
    totalSats: (totalConfirmed + totalMempool).toString(),
    breakdown,
  };
}

export async function getBitcoinTxHistory(args: GetBitcoinTxHistoryArgs) {
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const { assertBitcoinAddress } = await import("../btc/address.js");
  assertBitcoinAddress(args.address);
  const txs = await getBitcoinIndexer().getAddressTxs(args.address, {
    ...(args.limit !== undefined ? { limit: args.limit } : {}),
  });
  return { address: args.address, txs };
}

export async function prepareBitcoinNativeSend(
  args: PrepareBitcoinNativeSendArgs,
) {
  const { buildBitcoinNativeSend } = await import("../btc/actions.js");
  return buildBitcoinNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
    ...(args.feeRateSatPerVb !== undefined
      ? { feeRateSatPerVb: args.feeRateSatPerVb }
      : {}),
    ...(args.feePriority !== undefined
      ? { feePriority: args.feePriority }
      : {}),
    ...(args.rbf !== undefined ? { rbf: args.rbf } : {}),
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });
}

export async function prepareBitcoinRbfBump(args: PrepareBitcoinRbfBumpArgs) {
  const { buildBitcoinRbfBump } = await import("../btc/actions.js");
  return buildBitcoinRbfBump({
    wallet: args.wallet,
    txid: args.txid,
    newFeeRate: args.newFeeRate,
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });
}

export async function prepareBitcoinLifiSwap(args: PrepareBitcoinLifiSwapArgs) {
  const { buildBitcoinLifiSwap } = await import("../btc/lifi-swap.js");
  return buildBitcoinLifiSwap({
    wallet: args.wallet,
    toChain: args.toChain as Parameters<typeof buildBitcoinLifiSwap>[0]["toChain"],
    toToken: args.toToken,
    toAddress: args.toAddress,
    amount: args.amount,
    ...(args.slippageBps !== undefined ? { slippageBps: args.slippageBps } : {}),
    ...(args.acknowledgeHighSlippage !== undefined
      ? { acknowledgeHighSlippage: args.acknowledgeHighSlippage }
      : {}),
  });
}

export async function signBtcMessage(args: SignBtcMessageArgs) {
  const { signBitcoinMessage } = await import("../btc/actions.js");
  return signBitcoinMessage({ wallet: args.wallet, message: args.message });
}

export async function registerBtcMultisigWallet(
  args: RegisterBitcoinMultisigWalletArgs,
) {
  const { registerBitcoinMultisigWallet } = await import("../btc/multisig.js");
  return registerBitcoinMultisigWallet({
    name: args.name,
    threshold: args.threshold,
    cosigners: args.cosigners,
    scriptType: args.scriptType,
  });
}

export async function signBtcMultisigPsbt(args: SignBitcoinMultisigPsbtArgs) {
  const { signBitcoinMultisigPsbt } = await import("../btc/multisig.js");
  return signBitcoinMultisigPsbt({
    walletName: args.walletName,
    psbtBase64: args.psbtBase64,
  });
}

export async function combineBtcPsbts(args: CombineBitcoinPsbtsArgs) {
  const { combinePsbts } = await import("../btc/psbt-combine.js");
  return combinePsbts({ psbts: args.psbts });
}

export async function finalizeBtcPsbt(args: FinalizeBitcoinPsbtArgs) {
  const { finalizePsbt } = await import("../btc/psbt-combine.js");
  return finalizePsbt({
    psbtBase64: args.psbtBase64,
    ...(args.broadcast !== undefined ? { broadcast: args.broadcast } : {}),
  });
}

export async function getBtcMultisigBalance(args: GetBitcoinMultisigBalanceArgs) {
  const { getMultisigBalance } = await import("../btc/multisig-balance.js");
  return getMultisigBalance({
    walletName: args.walletName,
    ...(args.gapLimit !== undefined ? { gapLimit: args.gapLimit } : {}),
  });
}

export async function getBtcMultisigUtxos(args: GetBitcoinMultisigUtxosArgs) {
  const { getMultisigUtxos } = await import("../btc/multisig-balance.js");
  return getMultisigUtxos({
    walletName: args.walletName,
    ...(args.gapLimit !== undefined ? { gapLimit: args.gapLimit } : {}),
  });
}

export async function prepareBtcMultisigSend(
  args: PrepareBitcoinMultisigSendArgs,
) {
  const { prepareBitcoinMultisigSend } = await import("../btc/multisig.js");
  return prepareBitcoinMultisigSend({
    walletName: args.walletName,
    to: args.to,
    amount: args.amount,
    ...(args.feeRateSatPerVb !== undefined
      ? { feeRateSatPerVb: args.feeRateSatPerVb }
      : {}),
    ...(args.allowHighFee !== undefined
      ? { allowHighFee: args.allowHighFee }
      : {}),
  });
}

export async function unregisterBtcMultisigWallet(
  args: UnregisterBitcoinMultisigWalletArgs,
) {
  const { unregisterBitcoinMultisigWallet } = await import(
    "../btc/multisig.js"
  );
  return unregisterBitcoinMultisigWallet({ walletName: args.walletName });
}

/**
 * Pair the Ledger device for Litecoin signing. Mirror of
 * `pairLedgerBitcoin`. The Ledger Litecoin app shares its host-side
 * SDK (`@ledgerhq/hw-app-btc`) with the Bitcoin app, parametrized by
 * `currency: "litecoin"` in our `ltc-usb-loader.ts`.
 *
 * One call enumerates all four address types for the given account
 * index. BIP-44 coin_type 2 (`<purpose>'/2'/<account>'/...`) instead
 * of 0.
 */
export async function pairLedgerLitecoin(
  args: PairLedgerLitecoinArgs = {},
): Promise<{
  accountIndex: number;
  gapLimit: number;
  appVersion: string;
  addresses: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    address: string;
    path: string;
    chain: 0 | 1;
    addressIndex: number;
    txCount: number;
  }>;
  skipped: Array<{
    addressType: "legacy" | "p2sh-segwit" | "segwit" | "taproot";
    reason: string;
  }>;
  summary: { totalDerived: number; used: number; unused: number };
  instructions: string;
}> {
  const accountIndex = args.accountIndex ?? 0;
  const {
    scanLtcAccount,
    setPairedLtcAddress,
    clearPairedLtcAccount,
    DEFAULT_LTC_GAP_LIMIT,
  } = await import("../../signing/ltc-usb-signer.js");
  const gapLimit = args.gapLimit ?? DEFAULT_LTC_GAP_LIMIT;

  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  const indexer = getLitecoinIndexer();
  const fetchTxCount = async (addr: string): Promise<number> => {
    const bal = await indexer.getBalance(addr);
    return bal.txCount;
  };

  let derived;
  try {
    derived = await scanLtcAccount({
      accountIndex,
      gapLimit,
      fetchTxCount,
    });
  } catch (e) {
    const hint = await getDeviceStateHint("Litecoin");
    if (hint && e instanceof Error) {
      throw new Error(`${e.message} ${hint}`, { cause: e });
    }
    throw e;
  }
  // Issue #231: scanLtcAccount is per-type fault-tolerant — a single
  // type's failure (e.g. taproot's bech32m on the current Ledger LTC
  // app) records into `skipped` rather than aborting. If EVERY type
  // failed, treat that as a real pairing failure: don't drop the
  // existing cache and don't claim success.
  if (derived.entries.length === 0) {
    const reasons = derived.skipped
      .map((s) => `${s.addressType}: ${s.reason}`)
      .join("; ");
    throw new Error(
      `pair_ledger_ltc: every address-type walk failed. ${reasons || "no per-type errors recorded"}`,
    );
  }
  clearPairedLtcAccount(accountIndex);
  for (const entry of derived.entries) {
    setPairedLtcAddress({
      address: entry.address,
      publicKey: entry.publicKey,
      path: entry.path,
      appVersion: entry.appVersion,
      addressType: entry.addressType,
      accountIndex: entry.accountIndex,
      chain: entry.chain,
      addressIndex: entry.addressIndex,
      txCount: entry.txCount,
    });
  }
  const used = derived.entries.filter((e) => e.txCount > 0).length;
  const succeededTypes = new Set(derived.entries.map((e) => e.addressType)).size;
  const totalTypes = succeededTypes + derived.skipped.length;
  const skippedNote = derived.skipped.length
    ? ` Skipped ${derived.skipped.length}/${totalTypes} address types (${derived.skipped.map((s) => s.addressType).join(", ")}) — see \`skipped[]\` for per-type reasons. Common case: the Ledger Litecoin app does not support bech32m, so taproot (\`ltc1p…\`) derivation throws "Unsupported address format bech32m". Litecoin Core has not activated Taproot on mainnet anyway, so taproot pairing is effectively forward-compat only.`
    : "";
  return {
    accountIndex,
    gapLimit,
    appVersion: derived.appVersion,
    addresses: derived.entries.map((e) => ({
      addressType: e.addressType,
      address: e.address,
      path: e.path,
      chain: e.chain,
      addressIndex: e.addressIndex,
      txCount: e.txCount,
    })),
    skipped: derived.skipped,
    summary: {
      totalDerived: derived.entries.length,
      used,
      unused: derived.entries.length - used,
    },
    instructions:
      "Litecoin account paired with BIP44 gap-limit scanning. Both the receive " +
      "(/0/i) and change (/1/i) chains were walked across all four address types " +
      "until " +
      gapLimit +
      " consecutive empty addresses were observed. Use `get_ltc_balance` against " +
      "any cached address. Re-run `pair_ledger_ltc` to refresh; previously-cached " +
      "entries for this accountIndex are dropped before the new scan persists. " +
      "VERIFY BEFORE FIRST USE: before any `prepare_litecoin_*_send` or " +
      "`send_transaction` uses one of these addresses, surface its FULL string " +
      "(no truncation) and have the user verify it character-by-character " +
      "against the device's 'Display address' screen (Litecoin app → Display " +
      "address → select the matching BIP path). On any mismatch, abort — a " +
      "compromised middle layer may have substituted addresses." +
      skippedNote,
  };
}

export async function getLitecoinBalance(args: GetLitecoinBalanceArgs) {
  const { getLitecoinBalance: reader } = await import(
    "../litecoin/balances.js"
  );
  return reader(args.address);
}

export async function prepareLitecoinNativeSend(
  args: PrepareLitecoinNativeSendArgs,
) {
  const { buildLitecoinNativeSend } = await import("../litecoin/actions.js");
  return buildLitecoinNativeSend({
    wallet: args.wallet,
    to: args.to,
    amount: args.amount,
    ...(args.feeRateSatPerVb !== undefined
      ? { feeRateSatPerVb: args.feeRateSatPerVb }
      : {}),
    ...(args.rbf !== undefined ? { rbf: args.rbf } : {}),
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });
}

export async function signLtcMessage(args: SignLtcMessageArgs) {
  const { signLitecoinMessage } = await import("../litecoin/actions.js");
  return signLitecoinMessage({ wallet: args.wallet, message: args.message });
}

/**
 * Refresh the cached `txCount` for every paired Litecoin address under
 * one Ledger account by re-querying the indexer. Pure indexer fan-out:
 * no Ledger / USB interaction. Mirror of `rescanBitcoinAccount` for
 * Litecoin — same three-state extend signal, same persistence side
 * effects, same parallelism cap (`LITECOIN_INDEXER_PARALLELISM`).
 *
 * Issue #229.
 */
export async function rescanLitecoinAccount(args: RescanLitecoinAccountArgs) {
  const { getPairedLtcAddresses, setPairedLtcAddress } = await import(
    "../../signing/ltc-usb-signer.js"
  );
  const all = getPairedLtcAddresses();
  const forAccount = all.filter(
    (e) => e.accountIndex === args.accountIndex,
  );
  if (forAccount.length === 0) {
    throw new Error(
      `No paired Litecoin entries cached for accountIndex=${args.accountIndex}. ` +
        `Run \`pair_ledger_ltc({ accountIndex: ${args.accountIndex} })\` first ` +
        `to populate the cache. \`rescan_ltc_account\` only refreshes existing ` +
        `entries — it cannot derive new addresses (that needs the Ledger device).`,
    );
  }
  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  const indexer = getLitecoinIndexer();
  const { pLimitMap } = await import("../../data/http.js");
  const { resolveLitecoinIndexerParallelism } = await import(
    "../../config/litecoin.js"
  );
  // Same rationale as the BTC twin: cap fan-out under litecoinspace.org's
  // free-tier rate limit. Self-hosted Esplora users with no rate concerns
  // can override via `LITECOIN_INDEXER_PARALLELISM`.
  const parallelism = resolveLitecoinIndexerParallelism();
  const probes = await pLimitMap(forAccount, parallelism, (e) =>
    indexer.getBalance(e.address),
  );

  type LTCEntry = (typeof forAccount)[number];
  type ChainKey = `${LTCEntry["addressType"]}:${0 | 1}`;
  const chainBuckets = new Map<ChainKey, LTCEntry[]>();
  const refreshed: Array<{
    address: string;
    addressType: LTCEntry["addressType"];
    chain: 0 | 1 | null;
    addressIndex: number | null;
    path: string;
    previousTxCount: number;
    txCount: number;
    delta: number;
    fetchOk: boolean;
  }> = [];
  for (let i = 0; i < forAccount.length; i++) {
    const entry = forAccount[i];
    const probe = probes[i];
    const previousTxCount = entry.txCount ?? 0;
    let liveTxCount = previousTxCount;
    let fetchOk = false;
    if (probe.status === "fulfilled") {
      liveTxCount = probe.value.txCount;
      fetchOk = true;
      if (liveTxCount !== previousTxCount) {
        setPairedLtcAddress({ ...entry, txCount: liveTxCount });
      }
    }
    refreshed.push({
      address: entry.address,
      addressType: entry.addressType,
      chain: entry.chain ?? null,
      addressIndex: entry.addressIndex ?? null,
      path: entry.path,
      previousTxCount,
      txCount: liveTxCount,
      delta: liveTxCount - previousTxCount,
      fetchOk,
    });
    if (entry.chain === 0 || entry.chain === 1) {
      const key: ChainKey = `${entry.addressType}:${entry.chain}`;
      const bucket = chainBuckets.get(key);
      if (bucket) bucket.push(entry);
      else chainBuckets.set(key, [entry]);
    }
  }

  let needsExtend = false;
  const extendChains: Array<{
    addressType: LTCEntry["addressType"];
    chain: 0 | 1;
    lastAddressIndex: number;
  }> = [];
  const unverifiedChains: Array<{
    addressType: LTCEntry["addressType"];
    chain: 0 | 1;
    lastAddressIndex: number;
  }> = [];
  for (const [key, bucket] of chainBuckets) {
    const tail = bucket.reduce((max, e) =>
      (e.addressIndex ?? -1) > (max.addressIndex ?? -1) ? e : max,
    );
    const i = forAccount.indexOf(tail);
    const probe = probes[i];
    const [addressTypeStr, chainStr] = key.split(":");
    const chainEntry = {
      addressType: addressTypeStr as LTCEntry["addressType"],
      chain: Number(chainStr) as 0 | 1,
      lastAddressIndex: tail.addressIndex ?? -1,
    };
    if (probe.status === "rejected") {
      unverifiedChains.push(chainEntry);
      continue;
    }
    if (probe.value.txCount > 0) {
      needsExtend = true;
      extendChains.push(chainEntry);
    }
  }

  const fetchFailures = refreshed.filter((r) => !r.fetchOk).length;
  const txCountChanges = refreshed.filter((r) => r.delta !== 0).length;
  let note: string | undefined;
  if (needsExtend) {
    note =
      "The trailing empty address on at least one cached chain now has " +
      "on-chain history. The original gap-limit window may miss funds " +
      "past it. Run `pair_ledger_ltc({ accountIndex: " +
      args.accountIndex +
      " })` to extend the scan with fresh on-device derivations." +
      (unverifiedChains.length > 0
        ? " (Some other chains' tail probes failed and are reported as " +
          "`unverifiedChains` — those are independent of the extend signal.)"
        : "");
  } else if (unverifiedChains.length > 0) {
    note =
      "Some chains' tail probes failed this run, so we can't confirm the " +
      "gap window is still healthy for them — see `unverifiedChains`. " +
      "This is usually a transient indexer hiccup (rate limit / 5xx); " +
      "re-run `rescan_ltc_account` after a moment. Don't re-pair on this " +
      "alone — `needsExtend: true` is the signal for that.";
  }
  return {
    accountIndex: args.accountIndex,
    addressesScanned: refreshed.length,
    txCountChanges,
    fetchFailures,
    needsExtend,
    ...(needsExtend ? { extendChains } : {}),
    ...(unverifiedChains.length > 0 ? { unverifiedChains } : {}),
    refreshed,
    ...(note ? { note } : {}),
  };
}

export async function getMarginfiPositions(args: GetMarginfiPositionsArgs) {
  const { getMarginfiPositions: reader } = await import(
    "../positions/marginfi.js"
  );
  const conn = getSolanaConnection();
  return { positions: await reader(conn, args.wallet) };
}

export async function getSolanaStakingPositions(
  args: GetSolanaStakingPositionsArgs,
) {
  const { getSolanaStakingPositions: reader } = await import(
    "../positions/solana-staking.js"
  );
  const conn = getSolanaConnection();
  return reader(conn, args.wallet);
}

/**
 * Read-only diagnostic surface for the hardened MarginFi client load.
 * Returns per-bank skip records (address, best-effort mint, step, reason)
 * from the last `fetchGroupData` pass in this process — the data that
 * powers `findBankForMint`'s "bank listed but skipped" branch (issue #107).
 *
 * Triggers a fresh load if the cache is cold so the snapshot is always
 * recent on demand.
 */
export async function getMarginfiDiagnostics(
  _args?: Record<string, never>,
): Promise<{
  group: string;
  fetchedAt: number | null;
  addressesFetched: number;
  banksHydrated: number;
  skippedIntegrator: number;
  skipped: Array<{
    address: string;
    mint: string | null;
    symbol: string;
    step: "decode" | "hydrate" | "tokenData" | "priceInfo";
    reason: string;
  }>;
}> {
  const marginfi = await import("../solana/marginfi.js");
  const conn = getSolanaConnection();
  let snap = marginfi.getLastMarginfiGroupDiagnostics();
  if (!snap) {
    // Warm the cache — picks a valid pubkey as the stub authority since
    // the hardened fetch doesn't actually use it, only the SDK's wallet
    // type-check does.
    const { PublicKey } = await import("@solana/web3.js");
    await marginfi.getHardenedMarginfiClient(
      conn,
      new PublicKey("11111111111111111111111111111111"),
    );
    snap = marginfi.getLastMarginfiGroupDiagnostics();
  }
  if (!snap) {
    return {
      group: marginfi.__internals.MAINNET_GROUP.toBase58(),
      fetchedAt: null,
      addressesFetched: 0,
      banksHydrated: 0,
      skippedIntegrator: 0,
      skipped: [],
    };
  }
  return {
    group: marginfi.__internals.MAINNET_GROUP.toBase58(),
    fetchedAt: snap.fetchedAt,
    addressesFetched: snap.addressesFetched,
    banksHydrated: snap.banksHydrated,
    skippedIntegrator: snap.skippedIntegrator,
    skipped: snap.records.map((r) => ({
      address: r.address,
      mint: r.mint,
      symbol: r.mint
        ? marginfi.__internals.resolveMintSymbol(r.mint)
        : "UNKNOWN",
      step: r.step,
      reason: r.reason,
    })),
  };
}

/**
 * Read-only setup probe for a Solana wallet. Returns which one-time-setup
 * prerequisites are already in place (durable-nonce account + MarginFi
 * PDAs) so agents planning a supply/borrow/etc. don't re-propose a
 * redundant prepare_solana_nonce_init or prepare_marginfi_init step.
 *
 * Mirrors `get_ledger_status` in spirit: a cheap inspection tool that
 * turns "ask the user what's set up" into "read the chain". Issue #101.
 */
export async function getSolanaSetupStatus(args: {
  wallet: string;
}): Promise<{
  wallet: string;
  nonce: {
    exists: boolean;
    address: string;
    lamports?: number;
    currentNonce?: string;
    authority?: string;
  };
  marginfi: {
    accounts: Array<{ index: number; address: string }>;
  };
}> {
  const { assertSolanaAddress } = await import("../solana/address.js");
  const { deriveNonceAccountAddress, getNonceAccountValue } = await import(
    "../solana/nonce.js"
  );
  const { deriveMarginfiAccountPda } = await import("../solana/marginfi.js");

  const authority = assertSolanaAddress(args.wallet);
  const conn = getSolanaConnection();

  // Nonce lookup — one RPC + one decode.
  const noncePubkey = await deriveNonceAccountAddress(authority);
  const nonceInfo = await conn.getAccountInfo(noncePubkey, "confirmed");
  let nonceState: { nonce: string; authority: string } | undefined;
  let nonceLamports: number | undefined;
  if (nonceInfo) {
    nonceLamports = nonceInfo.lamports;
    try {
      const v = await getNonceAccountValue(conn, noncePubkey);
      if (v) {
        nonceState = { nonce: v.nonce, authority: v.authority.toBase58() };
      }
    } catch {
      // Account exists but isn't a System-owned nonce — surface as
      // exists:true without the nonce value. Caller should inspect the
      // lamports + our own nonce tool's refusal to explain.
    }
  }

  // MarginFi PDA probe — same 4-slot pattern as getMarginfiPositions, but
  // stops at the existence check. No SDK load, no oracle fetch — cheap.
  const marginfiAccounts: Array<{ index: number; address: string }> = [];
  const MAX_SLOTS = 4;
  for (let idx = 0; idx < MAX_SLOTS; idx++) {
    const pda = deriveMarginfiAccountPda(authority, idx);
    const info = await conn.getAccountInfo(pda, "confirmed");
    if (!info) {
      if (marginfiAccounts.length === 0 && idx === 0) break; // common: none
      break; // gap in the slot sequence
    }
    marginfiAccounts.push({ index: idx, address: pda.toBase58() });
  }

  return {
    wallet: args.wallet,
    nonce: {
      exists: nonceInfo !== null,
      address: noncePubkey.toBase58(),
      ...(nonceLamports !== undefined ? { lamports: nonceLamports } : {}),
      ...(nonceState
        ? {
            currentNonce: nonceState.nonce,
            authority: nonceState.authority,
          }
        : {}),
    },
    marginfi: { accounts: marginfiAccounts },
  };
}

export async function prepareSolanaSwap(
  args: PrepareSolanaSwapArgs,
): Promise<PreparedSolanaTx> {
  const { buildJupiterSwap } = await import("../solana/jupiter.js");
  // The `quote` arg is the full Jupiter QuoteResponse — typed loosely as
  // Record<string, unknown> at the schema boundary, narrowed here by the
  // Jupiter module (which expects a JupiterQuote shape).
  const prepared = await buildJupiterSwap({
    wallet: args.wallet,
    quote: args.quote as never, // JupiterQuote is a superset of Record<string, unknown>
    ...(args.prioritizationFeeLamports !== undefined
      ? { prioritizationFeeLamports: args.prioritizationFeeLamports }
      : {}),
  });
  // buildJupiterSwap returns a narrower type (PreparedJupiterSwap). The
  // handlers all converge on PreparedSolanaTx, and jupiter_swap is already
  // in that action union, so the assignment is shape-compatible.
  return prepared as PreparedSolanaTx;
}

/**
 * Pin a prepared Solana tx's draft with a fresh blockhash, serialize the
 * message bytes, compute the Ledger Message Hash (base58(sha256(bytes))),
 * and return the fully-pinned tx the user must match on-device.
 *
 * Why this step exists: blockhashes expire after ~150 blocks (~60s), and
 * prepare → CHECKS → user-approve → broadcast routinely runs 90+ seconds.
 * Fetching the blockhash at prepare time burned the full window before the
 * device ever prompted. This step refreshes the blockhash right before the
 * user matches the hash on the device, giving the full ~60s window for the
 * broadcast path.
 *
 * Re-callable on the same handle — the store overwrites the pinned form
 * with the newer blockhash. Useful if the user paused between the first
 * preview and the actual "send".
 */
export async function previewSolanaSend(args: {
  handle: string;
}): Promise<UnsignedSolanaTx> {
  // Verify the handle exists before hitting the RPC so we fail fast on stale
  // handles without burning a network call.
  const draft = getSolanaDraft(args.handle);
  const conn = getSolanaConnection();

  let pinned: UnsignedSolanaTx;
  if (draft.meta.nonce) {
    // Durable-nonce path: refresh the nonce value in case someone else
    // advanced it between prepare and preview (edge case — another tx
    // against the same nonce in flight — but cheap to handle correctly).
    // The nonce account pubkey never changes, so we just re-fetch.
    const { PublicKey } = await import("@solana/web3.js");
    const { getNonceAccountValue } = await import("../solana/nonce.js");
    const noncePubkey = new PublicKey(draft.meta.nonce.account);
    const fresh = await getNonceAccountValue(conn, noncePubkey);
    if (!fresh) {
      throw new Error(
        `Nonce account ${draft.meta.nonce.account} has disappeared between prepare and preview. ` +
          `Did it get closed mid-flight? Re-run prepare_solana_nonce_init and then re-prepare the send.`,
      );
    }
    // Update meta so pinSolanaHandle's consistency check passes.
    draft.meta.nonce.value = fresh.nonce;
    pinned = pinSolanaHandle(args.handle, fresh.nonce);
  } else {
    // Legacy recent-blockhash path — only reachable for `nonce_init` now,
    // since every send/close is durable-nonce-protected.
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(
      "confirmed",
    );
    pinned = pinSolanaHandle(args.handle, blockhash, lastValidBlockHeight);
  }

  // Pre-sign simulation gate (issue #115). Run `simulateTransaction` on the
  // pinned versioned tx so program-level reverts (MarginFi OperationBorrowOnly,
  // stale-oracle rejects, bank-paused asserts, etc.) surface BEFORE the user
  // is asked to blind-sign on Ledger. Mirrors the EVM enrichTx path which
  // runs eth_call at prepare_* time.
  //
  // Skip for `nonce_init`: that's a legacy-message one-time setup (createAccount
  // + nonceInitialize) with no interesting revert surface worth a pre-sign
  // RPC. Every other Solana action here is v0.
  if (pinned.action !== "nonce_init") {
    const { simulatePinnedSolanaTx } = await import("../solana/simulate.js");
    try {
      const sim = await simulatePinnedSolanaTx(conn, pinned.messageBase64);
      if (!sim.ok) {
        const header = sim.anchorError
          ? `Pre-sign simulation REJECTED the ${pinned.action} tx — ` +
            `${sim.anchorError.name} (${sim.anchorError.code}): ${sim.anchorError.message}.`
          : `Pre-sign simulation REJECTED the ${pinned.action} tx. Raw err: ${sim.err ?? "(unknown)"}.`;
        const logTail = sim.logs && sim.logs.length
          ? `\nLast program logs:\n  ${sim.logs.slice(-8).join("\n  ")}`
          : "";
        // Issue #116 — enrich with a targeted root-cause diagnosis for
        // ambiguous MarginFi errors (currently just 6009 RiskEngineInitRejected,
        // which collapses "stale oracle" and "bad health" into one message).
        // Best-effort: diagnosis failure must NOT mask the real sim error.
        let diagnosis = "";
        if (
          pinned.action.startsWith("marginfi_") &&
          sim.anchorError &&
          draft.meta.marginfiTouchedBanks
        ) {
          try {
            const { diagnoseMarginfiSimRejection } = await import(
              "../solana/marginfi.js"
            );
            const result = await diagnoseMarginfiSimRejection(
              draft.meta.marginfiTouchedBanks,
              sim.anchorError,
            );
            if (result) diagnosis = `\n${result}`;
          } catch {
            // Swallow — diagnosis is additive, not gating.
          }
        }
        // Issue #125 — split the two NotEnoughSamples failure modes. A
        // "Rotating mega slot" log line immediately before the Anchor
        // 6030 means the feed is mid oracle-set rotation: consensus can't
        // be reached for ~60–120s regardless of how many samples we
        // requested (#120's N=3 tuning doesn't help during rotation).
        // The right user action is to WAIT, not loop-retry. The plain
        // stale-samples branch still tells the user to re-prepare.
        const isNotEnoughSamples = sim.anchorError?.code === 6030;
        const { isSwitchboardRotation } = await import(
          "../solana/simulate.js"
        );
        const rotating =
          isNotEnoughSamples && isSwitchboardRotation(sim.logs);
        const remediation = rotating
          ? `\nThis is a transient SWITCHBOARD ORACLE ROTATION ("Rotating mega slot" ` +
            `in the logs) — the feed is between oracle sets and consensus is ` +
            `temporarily unreachable. Wait 60–120s before retrying; tight retry ` +
            `loops will fail identically until rotation completes. No code bug ` +
            `on our side; no fix on retry. Durable nonce was not advanced.`
          : isNotEnoughSamples
            ? `\nOracle samples fetched at preview time are already past their ` +
              `max-staleness window. This is unusual at preview time (the fetch ` +
              `is seconds-old) and typically indicates extreme RPC lag or a ` +
              `freshly-rotated feed. Call prepare_* again to fetch fresh samples.`
            : `\nRefusing to surface the Ledger hash — the tx would revert on broadcast. ` +
              `Resolve the underlying issue (e.g. withdraw conflicting collateral, wait for oracle freshness, ` +
              `pick a different bank) and call prepare_* again.`;
        throw new Error(header + logTail + diagnosis + remediation);
      }
      pinned.simulation = sim;
    } catch (e) {
      // Distinguish our own throw (preview-level rejection — re-raise) from
      // an RPC-level error (transient — swallow and proceed without the
      // simulation field; broadcast-side preflight is the backstop).
      if (
        e instanceof Error &&
        /Pre-sign simulation REJECTED/.test(e.message)
      ) {
        throw e;
      }
      // eslint-disable-next-line no-console
      console.warn(
        `[vaultpilot/solana] pre-sign simulate RPC failed: ${e instanceof Error ? e.message : String(e)}. ` +
          `Proceeding without simulation — broadcast-side preflight will still catch reverts.`,
      );
    }
  }

  return pinned;
}

/**
 * Send a Solana tx: consume handle, re-hash the stored message bytes and
 * compare against the preview fingerprint, sign over USB HID, stitch the
 * signature into the serialized tx, broadcast via RPC. Mirror of
 * `sendTronTransaction`.
 */
async function sendSolanaTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "solana";
  lastValidBlockHeight?: number;
  durableNonce?: { noncePubkey: string; nonceValue: string };
}> {
  const tx: UnsignedSolanaTx = consumeSolanaHandle(args.handle);
  // Preview-gate enforcement (parity with the EVM path). These two args
  // prove the agent ran `preview_solana_send` AND surfaced the CHECKS
  // PERFORMED block before the user replied "send". Missing / mismatched
  // values mean the agent either skipped preview entirely, collapsed
  // preview + send into one silent step, or replayed an old token after
  // a refresh — in all three cases the user hasn't had a chance to match
  // the on-device Message Hash against the chat-side value and the
  // defense collapses for blind-sign flows (SPL / MarginFi / Jupiter).
  // Error text is verbose on purpose — the agent reads it and self-corrects.
  if (!args.previewToken) {
    throw new Error(
      "Missing `previewToken` arg on send_transaction. preview_solana_send " +
        "returned a `previewToken` field in its top-level JSON response — " +
        "pass it back here verbatim. This is the schema-enforced proof " +
        "that the preview step actually ran and that the CHECKS PERFORMED " +
        "block was surfaced to the user. If you skipped preview_solana_send, " +
        "call it first.",
    );
  }
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the CHECKS PERFORMED block from preview_solana_send " +
        "and receiving the user's explicit 'send' reply. The literal proves " +
        "the preview-time gate was shown to the user rather than silently " +
        "bypassed.",
    );
  }
  if (tx.previewToken && args.previewToken !== tx.previewToken) {
    throw new Error(
      "SECURITY: `previewToken` does not match the current pin on this " +
        "Solana handle. The benign explanation is that preview_solana_send " +
        "was re-called after the token was captured (e.g. to refresh a stale " +
        "nonce) — in that case, the new pin has a new token AND a new Message " +
        "Hash the user MUST re-match on-device. Do NOT retry with the old " +
        "token: call preview_solana_send again, surface the fresh CHECKS " +
        "PERFORMED block and the new blind-sign hash to the user, and pass " +
        "the new token.",
    );
  }
  // Proof-of-identity guard: same logic as the TRON sender. Recompute the
  // domain-tagged hash of the exact message bytes the Ledger will sign
  // and require equality with the hash the user previewed.
  if (tx.verification) {
    const rehash = solanaPayloadFingerprint(tx.messageBase64);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: Solana payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The message bytes changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare from scratch and compare ` +
          `the new preview carefully.`,
      );
    }
  }
  // Use the paired path for `from` if available; otherwise fall through to
  // the default (`44'/501'/0'`) and let the device-address check inside
  // `signSolanaTxOnLedger` surface a "pair the right slot" error.
  const paired = getPairedSolanaByAddress(tx.from);
  const messageBytes = Buffer.from(tx.messageBase64, "base64");
  const { signature } = await signSolanaTxOnLedger({
    messageBytes,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });

  // Assemble the final serialized tx: one signature count byte (0x01), the
  // 64-byte signature, then the message bytes. Matches what
  // `Transaction.serialize()` produces for a single-signer tx after
  // `addSignature` — but we construct it by hand so we never need a
  // `Keypair`/`Signer` object (which would imply a key in the server).
  const signedTxBytes = Buffer.concat([
    Buffer.from([1]), // signature count = 1 (single signer)
    signature,
    messageBytes,
  ]);

  const txSignature = await broadcastSolanaTx(signedTxBytes);
  // Retire the handle only after successful broadcast. A signing or
  // broadcast failure leaves the handle valid for retry within its 15-min
  // TTL (though on-chain validity is bounded by the ~60s blockhash window).
  retireSolanaHandle(args.handle);
  return {
    txHash: txSignature,
    chain: "solana",
    // `lastValidBlockHeight` is for legacy-blockhash txs (nonce_init only);
    // `durableNonce` is for every other send. The status poller uses one
    // or the other to distinguish dropped from pending — always surface
    // the applicable field so the agent can hand it back to
    // `get_transaction_status` verbatim.
    ...(tx.lastValidBlockHeight !== undefined
      ? { lastValidBlockHeight: tx.lastValidBlockHeight }
      : {}),
    ...(tx.nonce
      ? {
          durableNonce: {
            noncePubkey: tx.nonce.account,
            nonceValue: tx.nonce.value,
          },
        }
      : {}),
  };
}

/**
 * Send a Bitcoin tx: consume handle, sign PSBT on the Ledger BTC app
 * (which clear-signs every output + fee on-screen), broadcast the
 * finalized raw tx hex to the indexer's `/tx` endpoint, return the txid.
 *
 * No preview-gate: the Ledger BTC app's clear-signing UX *is* the
 * review step. Every output (address + amount), the fee, and the change
 * label are shown on-device — there's no blind-sign hash for the user
 * to pre-match in chat. The agent-side verification block surfaces the
 * same projection, so the user can cross-check before the device prompt.
 */
async function sendBitcoinTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "bitcoin";
}> {
  const tx = consumeBitcoinHandle(args.handle);
  // Validate every source in the envelope is still paired. The signer
  // re-derives each source against the device for the proof-of-identity
  // guard, but we want the clear "cache cleared since prepare" error
  // surfaced before the USB transport opens.
  for (const src of tx.sources) {
    const paired = getPairedBtcByAddress(src.address);
    if (!paired) {
      throw new Error(
        `Bitcoin source ${src.address} is no longer in the pairing cache. The cache ` +
          `may have been cleared since prepare_btc_send. Re-pair via \`pair_ledger_btc\` ` +
          `and re-run prepare_btc_send to get a fresh handle.`,
      );
    }
  }
  const { rawTxHex } = await signBtcPsbtOnLedger({
    psbtBase64: tx.psbtBase64,
    sources: tx.sources.map((s) => ({ address: s.address, path: s.path })),
    accountPath: tx.accountPath,
    addressFormat: tx.addressFormat,
    ...(tx.change ? { change: tx.change } : {}),
  });
  const { getBitcoinIndexer } = await import("../btc/indexer.js");
  const txid = await getBitcoinIndexer().broadcastTx(rawTxHex);
  // Retire only after successful broadcast — the same retry-on-failure
  // policy as the Solana / TRON branches.
  retireBitcoinHandle(args.handle);
  return { txHash: txid, chain: "bitcoin" };
}

/**
 * Send a Litecoin tx — mirror of `sendBitcoinTransaction`. Same Ledger
 * BTC-app SDK with `currency:"litecoin"`, same PSBT + finalize +
 * broadcast flow.
 */
async function sendLitecoinTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "litecoin";
}> {
  const tx = consumeLitecoinHandle(args.handle);
  for (const src of tx.sources) {
    const paired = getPairedLtcByAddress(src.address);
    if (!paired) {
      throw new Error(
        `Litecoin source ${src.address} is no longer in the pairing cache. Re-pair via ` +
          `\`pair_ledger_ltc\` and re-run prepare_litecoin_native_send for a fresh handle.`,
      );
    }
  }
  const { rawTxHex } = await signLtcPsbtOnLedger({
    psbtBase64: tx.psbtBase64,
    sources: tx.sources.map((s) => ({ address: s.address, path: s.path })),
    inputSources: tx.inputSources,
    accountPath: tx.accountPath,
    addressFormat: tx.addressFormat,
    ...(tx.change ? { change: tx.change } : {}),
  });
  const { getLitecoinIndexer } = await import("../litecoin/indexer.js");
  const txid = await getLitecoinIndexer().broadcastTx(rawTxHex);
  retireLitecoinHandle(args.handle);
  return { txHash: txid, chain: "litecoin" };
}

/** Attach eth_call simulation result, gas estimate, and USD cost. */
async function enrichTx(tx: UnsignedTx): Promise<UnsignedTx> {
  const client = getClient(tx.chain);
  const from = tx.from;
  // Always simulate — even when gas estimation would succeed — so the caller
  // can see the decoded revert reason alongside the preview. A failed sim on
  // a standalone tx is a red flag; a failed sim on `tx.next` of an
  // approve→action pair is expected until the approve mines.
  tx.simulation = await simulateTx({
    chain: tx.chain,
    from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  try {
    const gas = await client.estimateGas({
      account: from ?? "0x0000000000000000000000000000000000000001",
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
    });
    tx.gasEstimate = gas.toString();

    const gasPrice = await client.getGasPrice();
    const gasWei = gas * gasPrice;
    // Always populate the native-fee field (issue #636) — the cost preview
    // block can render even when USD pricing degrades, which keeps the
    // fee-shock abort signal alive on cold chains and during DefiLlama
    // outages.
    tx.gasCostNative = formatUnits(gasWei, 18);
    const ethPrice = await getTokenPrice(tx.chain, "native");
    if (ethPrice) {
      const gasEth = Number(formatUnits(gasWei, 18));
      tx.gasCostUsd = round(gasEth * ethPrice, 2);
    }
  } catch {
    // Gas estimation fails for many legitimate reasons (insufficient allowance on
    // a follow-up step, etc.) — we surface the tx anyway. The simulation field
    // above has already captured any revert reason.
  }
  if (tx.next) tx.next = await enrichTx(tx.next);
  return tx;
}

// ----- Aave preparation handlers -----

export async function prepareAaveSupply(args: PrepareAaveSupplyArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveSupply({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareAaveWithdraw(args: PrepareAaveWithdrawArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveWithdraw({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
    })
  );
}

export async function prepareAaveBorrow(args: PrepareAaveBorrowArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveBorrow({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
    })
  );
}

export async function prepareAaveRepay(args: PrepareAaveRepayArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta(args.chain as SupportedChain, args.asset as `0x${string}`);
  return enrichTx(
    await buildAaveRepay({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      asset: args.asset as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

// ----- Uniswap V3 LP preparation handlers -----

export async function prepareUniswapV3Mint(
  args: PrepareUniswapV3MintArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapMint({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenA: args.tokenA as `0x${string}`,
      tokenB: args.tokenB as `0x${string}`,
      feeTier: args.feeTier,
      tickLower: args.tickLower,
      tickUpper: args.tickUpper,
      amountADesired: args.amountADesired,
      amountBDesired: args.amountBDesired,
      slippageBps: args.slippageBps,
      acknowledgeHighSlippage: args.acknowledgeHighSlippage,
      deadlineSec: args.deadlineSec,
      recipient: args.recipient as `0x${string}` | undefined,
      approvalCap: args.approvalCap,
    }),
  );
}

export async function prepareUniswapV3IncreaseLiquidity(
  args: PrepareUniswapV3IncreaseLiquidityArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapIncrease({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenId: args.tokenId,
      amount0Desired: args.amount0Desired,
      amount1Desired: args.amount1Desired,
      slippageBps: args.slippageBps,
      acknowledgeHighSlippage: args.acknowledgeHighSlippage,
      deadlineSec: args.deadlineSec,
      approvalCap: args.approvalCap,
    }),
  );
}

export async function prepareUniswapV3DecreaseLiquidity(
  args: PrepareUniswapV3DecreaseLiquidityArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapDecrease({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenId: args.tokenId,
      liquidityPct: args.liquidityPct,
      liquidity: args.liquidity,
      slippageBps: args.slippageBps,
      acknowledgeHighSlippage: args.acknowledgeHighSlippage,
      deadlineSec: args.deadlineSec,
    }),
  );
}

export async function prepareUniswapV3Collect(
  args: PrepareUniswapV3CollectArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapCollect({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenId: args.tokenId,
      recipient: args.recipient as `0x${string}` | undefined,
    }),
  );
}

export async function prepareUniswapV3Burn(
  args: PrepareUniswapV3BurnArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapBurn({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenId: args.tokenId,
    }),
  );
}

export async function prepareUniswapV3Rebalance(
  args: PrepareUniswapV3RebalanceArgs,
): Promise<UnsignedTx> {
  return enrichTx(
    await buildUniswapRebalance({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      tokenId: args.tokenId,
      newTickLower: args.newTickLower,
      newTickUpper: args.newTickUpper,
      burnOld: args.burnOld,
      slippageBps: args.slippageBps,
      acknowledgeHighSlippage: args.acknowledgeHighSlippage,
      deadlineSec: args.deadlineSec,
      approvalCap: args.approvalCap,
    }),
  );
}

// ----- Staking preparation handlers -----

export async function prepareLidoStake(args: PrepareLidoStakeArgs): Promise<UnsignedTx> {
  return enrichTx(buildLidoStake({ wallet: args.wallet as `0x${string}`, amountEth: args.amountEth }));
}

export async function prepareLidoUnstake(args: PrepareLidoUnstakeArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildLidoUnstake({
      wallet: args.wallet as `0x${string}`,
      amountStETH: args.amountStETH,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareLidoWrap(args: PrepareLidoWrapArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildLidoWrap({
      wallet: args.wallet as `0x${string}`,
      amountStETH: args.amountStETH,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareLidoUnwrap(args: PrepareLidoUnwrapArgs): Promise<UnsignedTx> {
  return enrichTx(
    buildLidoUnwrap({
      wallet: args.wallet as `0x${string}`,
      amountWstETH: args.amountWstETH,
    })
  );
}

export async function prepareEigenLayerDeposit(args: PrepareEigenLayerDepositArgs): Promise<UnsignedTx> {
  const meta = await resolveTokenMeta("ethereum", args.token as `0x${string}`);
  return enrichTx(
    await buildEigenLayerDeposit({
      wallet: args.wallet as `0x${string}`,
      strategy: args.strategy as `0x${string}`,
      token: args.token as `0x${string}`,
      amount: args.amount,
      decimals: meta.decimals,
      symbol: meta.symbol,
      approvalCap: args.approvalCap,
    })
  );
}

export async function prepareRocketPoolStake(args: PrepareRocketPoolStakeArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildRocketPoolStake({
      wallet: args.wallet as `0x${string}`,
      amountEth: args.amountEth,
    })
  );
}

export async function prepareRocketPoolUnstake(args: PrepareRocketPoolUnstakeArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildRocketPoolUnstake({
      wallet: args.wallet as `0x${string}`,
      amountReth: args.amountReth,
    })
  );
}

// ----- Native + ERC-20 transfers -----

/**
 * Accept recipient addresses that are either all-lowercase hex (no checksum
 * intent) or valid EIP-55 checksummed. Reject mixed-case with a wrong
 * checksum — that is the class of error where a user pasted an address with
 * a single-character case typo; viem's bare `as 0x${string}` cast would
 * otherwise pass it through silently. viem's `isAddress(x, { strict: true })`
 * encodes exactly this policy.
 */
function assertRecipient(addr: string): `0x${string}` {
  if (!isAddress(addr, { strict: true })) {
    throw new Error(
      `Invalid recipient address ${addr}: failed EIP-55 checksum or malformed hex. ` +
        `If you pasted a mixed-case address, a single-character case typo is the most ` +
        `likely cause — re-check the source.`,
    );
  }
  return addr as `0x${string}`;
}

export async function prepareNativeSend(args: PrepareNativeSendArgs): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  // Address-book resolution: `args.to` may be a label, an ENS name,
  // or a literal address. Strict-aborts on contacts-tamper if the
  // user passed a label (label-resolution is the phishing-redirect
  // path; tamper there is unsafe). Literal addresses + ENS still
  // proceed with a warning when contacts are tampered.
  const resolved = await resolveRecipient(args.to, chain);
  const to = assertRecipient(resolved.address);
  const value = parseEther(args.amount);
  const display = resolved.label
    ? `${resolved.label} (${to})`
    : to;
  return enrichTx({
    chain,
    to,
    data: "0x",
    value: value.toString(),
    from: wallet,
    description: `Send ${args.amount} native coin to ${display} on ${chain}`,
    decoded: {
      functionName: "transfer",
      args: {
        to,
        ...(resolved.label ? { recipientLabel: resolved.label } : {}),
        amount: args.amount,
      },
    },
    recipient: {
      ...(resolved.label ? { label: resolved.label } : {}),
      source: resolved.source,
      ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
    },
  });
}

export async function prepareWethUnwrap(args: PrepareWethUnwrapArgs): Promise<UnsignedTx> {
  return enrichTx(
    await buildWethUnwrap({
      wallet: args.wallet as `0x${string}`,
      chain: args.chain as SupportedChain,
      amount: args.amount,
    }),
  );
}

export async function prepareTokenSend(args: PrepareTokenSendArgs): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const token = args.token as `0x${string}`;
  // Address-book resolution — same shape as prepareNativeSend.
  const resolved = await resolveRecipient(args.to, chain);
  const to = assertRecipient(resolved.address);
  const meta = await resolveTokenMeta(chain, token);

  let amountWei: bigint;
  let displayAmount = args.amount;
  if (args.amount === "max") {
    const client = getClient(chain);
    amountWei = (await client.readContract({
      address: token,
      abi: erc20Abi,
      functionName: "balanceOf",
      args: [wallet],
    })) as bigint;
    displayAmount = formatUnits(amountWei, meta.decimals);
  } else {
    amountWei = parseUnits(args.amount, meta.decimals);
  }

  const recipientDisplay = resolved.label
    ? `${resolved.label} (${to})`
    : to;
  const tokenClass = lookupTokenClass(chain, token);
  return enrichTx({
    chain,
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "transfer",
      args: [to, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Send ${displayAmount} ${meta.symbol} to ${recipientDisplay} on ${chain}`,
    decoded: {
      functionName: "transfer",
      args: {
        to,
        ...(resolved.label ? { recipientLabel: resolved.label } : {}),
        amount: displayAmount,
        symbol: meta.symbol,
      },
    },
    recipient: {
      ...(resolved.label ? { label: resolved.label } : {}),
      source: resolved.source,
      ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
    },
    ...(tokenClass !== null ? { tokenClass } : {}),
  });
}

/**
 * Build an `approve(spender, 0)` tx to revoke the allowance `wallet`
 * previously granted `spender` on `token`. Pre-flight check refuses
 * when the live allowance is already 0 — the on-chain call would still
 * succeed but burns gas for nothing, and the user almost certainly
 * meant a different (token, spender) pair.
 *
 * Resolves a friendly spender label from the canonical CONTRACTS table
 * when one matches (Aave V3 Pool, Uniswap V3 SwapRouter02, etc.) so
 * the description + Ledger-screen preview is more meaningful than a
 * raw hex address.
 *
 * No `approvalCap`-style logic — revoke is a strict zero. The shared
 * `buildApprovalTx` helper covers the raise-then-spend path; this is
 * the inverse one-shot.
 */
export async function prepareRevokeApproval(
  args: PrepareRevokeApprovalArgs,
): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const token = args.token as `0x${string}`;
  const spender = args.spender as `0x${string}`;

  const client = getClient(chain);
  const currentAllowance = (await client.readContract({
    address: token,
    abi: erc20Abi,
    functionName: "allowance",
    args: [wallet, spender],
  })) as bigint;

  if (currentAllowance === 0n) {
    throw new Error(
      `${wallet} has no allowance to revoke for spender ${spender} on token ` +
        `${token} (${chain}). Current allowance is already 0 — calling ` +
        `approve(spender, 0) would be a no-op gas burn. If you intended a ` +
        `different (token, spender) pair, double-check the inputs.`,
    );
  }

  const meta = await resolveTokenMeta(chain, token);
  const knownLabel = lookupKnownSpender(chain, spender);
  const spenderDisplay = knownLabel ? `${knownLabel} (${spender})` : spender;
  const currentFormatted = formatUnits(currentAllowance, meta.decimals);

  const { makeDurableBinding } = await import(
    "../../security/durable-binding.js"
  );
  return enrichTx({
    chain,
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, 0n],
    }),
    value: "0",
    from: wallet,
    description:
      `Revoke ${meta.symbol} allowance for ${spenderDisplay} on ${chain} ` +
      `(was ${currentFormatted} ${meta.symbol})`,
    decoded: {
      functionName: "approve",
      args: {
        spender,
        amount: "0",
        note: "revoke",
        symbol: meta.symbol,
        ...(knownLabel ? { spenderLabel: knownLabel } : {}),
      },
    },
    // Inv #14 (#460) — the spender selected from the user's allowance
    // set is the durable object the user must re-verify. Complements the
    // existing set-level enumeration check (Inv #13 / #450 which already
    // ensures the user picks a row, not the agent).
    durableBindings: [makeDurableBinding("approval-spender-address", spender)],
  });
}

/**
 * Build an `approve(spender, amount)` tx that raises (or sets) the
 * allowance `wallet` grants `spender` on `token`. Structured inverse of
 * `prepare_revoke_approval`. Issue #556.
 *
 * `amount` is a decimal string in token units; pass `"max"` for the
 * uint256-max unlimited allowance. Burn-address gate refuses unlimited
 * approvals to canonical no-key recipients unless
 * `acknowledgeBurnApproval: true` is set.
 *
 * Resolves a friendly spender label from the canonical `CONTRACTS` table
 * so the description + Ledger-screen preview reads as "Approve USDC for
 * Aave V3 Pool, 1000 USDC" rather than a raw hex address.
 */
export async function prepareTokenApprove(
  args: PrepareTokenApproveArgs,
): Promise<UnsignedTx> {
  const wallet = args.wallet as `0x${string}`;
  const chain = args.chain as SupportedChain;
  const token = args.token as `0x${string}`;
  const spender = args.spender as `0x${string}`;

  const meta = await resolveTokenMeta(chain, token);

  let amountWei: bigint;
  let amountDisplay: string;
  if (args.amount === "max") {
    amountWei = (1n << 256n) - 1n;
    amountDisplay = "unlimited";
  } else if (/^\d+(\.\d+)?$/.test(args.amount)) {
    amountWei = parseUnits(args.amount, meta.decimals);
    amountDisplay = `${args.amount} ${meta.symbol}`;
  } else {
    throw new Error(
      `\`amount\` must be a decimal string (e.g. "10" or "1.5") in ${meta.symbol} units, ` +
        `or the literal "max" for unlimited. Got: "${args.amount}". Raw wei is NOT accepted.`,
    );
  }

  if (amountWei === 0n) {
    throw new Error(
      `prepare_token_approve refuses approve(spender, 0) — that's the revoke pattern. ` +
        `Use prepare_revoke_approval instead, which adds the "live allowance must be > 0" ` +
        `pre-flight check and the friendly revoke description.`,
    );
  }

  assertNotUnlimitedBurnApproval(spender, amountWei, args.acknowledgeBurnApproval);

  const knownLabel = lookupKnownSpender(chain, spender);
  const spenderDisplay = knownLabel ? `${knownLabel} (${spender})` : spender;

  const { makeDurableBinding } = await import(
    "../../security/durable-binding.js"
  );
  return enrichTx({
    chain,
    to: token,
    data: encodeFunctionData({
      abi: erc20Abi,
      functionName: "approve",
      args: [spender, amountWei],
    }),
    value: "0",
    from: wallet,
    description: `Approve ${meta.symbol} for ${spenderDisplay} on ${chain} (${amountDisplay})`,
    decoded: {
      functionName: "approve",
      args: {
        spender,
        amount: amountDisplay,
        symbol: meta.symbol,
        ...(knownLabel ? { spenderLabel: knownLabel } : {}),
      },
    },
    // Inv #14 — the spender selected here is the durable object the user
    // must re-verify. Mirrors prepare_revoke_approval.
    durableBindings: [makeDurableBinding("approval-spender-address", spender)],
  });
}

export async function prepareCustomCall(
  args: PrepareCustomCallArgs,
): Promise<UnsignedTx> {
  // Schema enforces `acknowledgeNonProtocolTarget: z.literal(true)` so
  // anything that lands here has already crossed the affirmative gate.
  // Re-assert defensively in case a future caller bypasses the schema.
  if (args.acknowledgeNonProtocolTarget !== true) {
    throw new Error(
      "prepare_custom_call requires acknowledgeNonProtocolTarget=true. The tool " +
        "BYPASSES the canonical-dispatch allowlist by design; this flag is the " +
        "user's affirmative ack that they're calling a non-protocol target.",
    );
  }
  const built = await buildCustomCall({
    wallet: args.wallet as `0x${string}`,
    chain: args.chain as SupportedChain,
    contract: args.contract as `0x${string}`,
    fn: args.fn,
    args: args.args ?? [],
    value: args.value,
    abi: args.abi,
    acknowledgeBurnApproval: args.acknowledgeBurnApproval,
    acknowledgeRawApproveBypass: args.acknowledgeRawApproveBypass,
    acknowledgeKnownExfilPattern: args.acknowledgeKnownExfilPattern,
  });
  // Stamp the affirmative-ack on the tx so `assertTransactionSafe`
  // (preview/send time) recognizes this handle as the explicit
  // non-protocol-target bypass and skips ONLY its catch-all "unknown
  // destination" refusal. Issue #496.
  built.acknowledgedNonProtocolTarget = true;
  return enrichTx(built);
}


// ----- Send + status -----

/**
 * Sign a prepared TRON tx on the connected Ledger and broadcast via TronGrid.
 * Called internally from `sendTransaction` when the handle belongs to the
 * TRON store.
 *
 * Security pipeline (intentionally narrower than the EVM one — many EVM
 * checks don't translate to TRON):
 *   - consumeTronHandle gives us the exact tx the user previewed.
 *   - signTronTxOnLedger re-opens USB, re-derives the address, and refuses
 *     if it doesn't match `tx.from`. This is the TRON equivalent of EVM's
 *     "tx.from must be a paired account" guard.
 *   - broadcastTronTx posts the signed envelope; TronGrid validates the
 *     contract before inclusion.
 *
 * We don't re-simulate. TronGrid's createtransaction / triggersmartcontract
 * already validates at prepare time (insufficient balance, fee_limit too low,
 * contract revert), and there's no equivalent of eth_call against a specific
 * block on TRON that we'd gain from re-running. A genuine drift between
 * prepare and send (someone drained the balance in the interim) surfaces as
 * a broadcast error, which we propagate verbatim.
 */
async function sendTronTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "tron";
}> {
  const tx: UnsignedTronTx = consumeTronHandle(args.handle);
  // Preview-gate enforcement. TRON has no preview step — prepare_tron_*
  // produces the signable artifact directly — so the gate here is just
  // the `userDecision: "send"` literal, without a token. It pins the
  // same careless-mistake invariant as on EVM: an agent collapsing
  // prepare + send into a single silent step without pausing to surface
  // the VERIFY block gets a clear-error refusal naming the missing arg.
  // TRON clear-signs every supported action on-device, so even if a
  // hostile agent forges this literal, the Ledger screen's decoded
  // fields are the source of truth — but skipping the reply is the
  // UX-honesty bar we want to enforce.
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the VERIFY-BEFORE-SIGNING block from the " +
        "prepare_tron_* tool result and receiving the user's explicit " +
        "'send' reply. The literal proves the prepare-time summary was " +
        "shown to the user rather than silently bypassed.",
    );
  }
  // Proof-of-identity guard: recompute the domain-tagged hash of the EXACT
  // rawDataHex that the USB signer is about to hand to the Ledger, and
  // require equality with the hash the user previewed. A drift here means
  // tx state mutated between handle issuance and send — should never
  // happen, but the invariant is cheap to enforce and exactly what turns
  // "trust me" into "same bytes, same hash".
  if (tx.verification) {
    const rehash = tronPayloadFingerprint(tx.rawDataHex);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: TRON payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The rawDataHex changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare the transaction from ` +
          `scratch (call the prepare_* tool again) and compare the new preview carefully — a ` +
          `drift here means the bytes mutated inside the MCP process between the moment the user ` +
          `reviewed them and the moment they would have been signed, which is not a normal ` +
          `operating condition and may indicate a compromised intermediary.`,
      );
    }
  }
  // If the user paired this `from` via `pair_ledger_tron`, use the path they
  // paired on (covers non-default account slots). If we have no paired entry
  // for `from`, fall through to the signer's default path — the device
  // address check inside signTronTxOnLedger will then surface a clear error
  // telling the user to pair the right slot.
  const paired = getPairedTronByAddress(tx.from);
  const { signature } = await signTronTxOnLedger({
    rawDataHex: tx.rawDataHex,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });
  const { txID } = await broadcastTronTx(tx, signature);
  // Only retire the handle after successful broadcast. If signing fails
  // (user rejected, device disconnected) or the broadcast fails (transient
  // TronGrid error), the handle stays valid and the caller can retry
  // within the 15-min TTL without re-preparing.
  retireTronHandle(args.handle);
  return { txHash: txID, chain: "tron" };
}

/**
 * Minimum priority fee floor in wei. viem's `estimateFeesPerGas` returns the
 * node's priority-fee estimate, which on quiet blocks can drop below what
 * mempool-aware miners actually include (observed: 20 mwei on Ethereum at
 * 14:00 UTC while the inclusion floor was ~1 gwei). Floor at 0.05 gwei so a
 * tx we pinned during a lull doesn't sit stuck when activity picks up,
 * without over-tipping ~8x on a near-empty mempool (e.g. a 0.5 gwei floor
 * on a 0.07 gwei base fee).
 */
const MIN_PRIORITY_FEE_WEI = 50_000_000n;

/**
 * Multiplier applied to `baseFeePerGas` before adding priority fee. viem's
 * default is `1.2x` — safe on average, too tight for user-review windows
 * (observed live test: a tx pinned at 1.2x baseFee stuck in mempool after
 * the block's baseFee bumped mid-review). 2x gives one full EIP-1559 double
 * worth of headroom, which covers ~4 blocks of consecutive 12.5% baseFee
 * rises — enough for a user to read, confirm, and press a Ledger button.
 */
const BASE_FEE_MULTIPLIER = 2n;

/**
 * Fetch `{nonce, maxFeePerGas, maxPriorityFeePerGas, gas}` from the chain
 * for a single tx. Extracted so `previewSend` has one clearly-defined place
 * to pick fee levels. All four fields land verbatim in the WalletConnect
 * `eth_sendTransaction` params (hex-encoded in `walletconnect.ts`), and all
 * four feed the EIP-1559 pre-sign RLP hash — so if this helper's output
 * drifts, so does the hash the user matches on-device.
 *
 * Throws on RPC failure; unpinned sends defeat the hash-match UX by design
 * (Ledger Live would substitute its own nonce + fees, making the on-device
 * hash unpredictable).
 */
async function pinSendFields(
  chain: SupportedChain,
  from: `0x${string}`,
  to: `0x${string}`,
  data: `0x${string}`,
  value: string,
): Promise<{
  nonce: number;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  gas: bigint;
  /**
   * Live base fee from `latestBlock.baseFeePerGas`. Threaded out so the
   * preview-time cost block (issue #650) can render `base fee X gwei`
   * separately from the priority fee — recovering it from `maxFeePerGas`
   * arithmetic would silently drift if `BASE_FEE_MULTIPLIER` ever changes.
   */
  baseFeePerGas: bigint;
}> {
  const rpcClient = getClient(chain);
  const [nonceRaw, latestBlock, priorityEstimate, gasLimit] = await Promise.all([
    rpcClient.getTransactionCount({ address: from, blockTag: "pending" }),
    rpcClient.getBlock({ blockTag: "latest" }),
    rpcClient.estimateMaxPriorityFeePerGas(),
    rpcClient.estimateGas({
      account: from,
      to,
      data,
      value: BigInt(value),
    }),
  ]);
  const baseFee = latestBlock.baseFeePerGas ?? 0n;
  const maxPriorityFeePerGas =
    priorityEstimate < MIN_PRIORITY_FEE_WEI ? MIN_PRIORITY_FEE_WEI : priorityEstimate;
  const maxFeePerGas = baseFee * BASE_FEE_MULTIPLIER + maxPriorityFeePerGas;
  return {
    nonce: Number(nonceRaw),
    maxFeePerGas,
    maxPriorityFeePerGas,
    gas: gasLimit,
    baseFeePerGas: baseFee,
  };
}

/**
 * Run the full EVM pre-sign guard pipeline against the tx named by `handle`:
 * chainId verification, destination/selector allowlist, re-simulation,
 * account-match check against the paired WC session, and the payload-hash
 * fingerprint. Re-used by `previewSend` (early surfacing before the user
 * invests time matching a hash) and — tests only — for individual guard
 * assertions.
 *
 * Handle is NOT retired here; `consumeHandle` is a non-destructive peek.
 */
async function runEvmPreSignGuards(tx: UnsignedTx): Promise<void> {
  await verifyChainId(tx.chain);
  await assertTransactionSafe(tx);
  const sim = await simulateTx({
    chain: tx.chain,
    from: tx.from,
    to: tx.to,
    data: tx.data,
    value: tx.value,
  });
  if (!sim.ok) {
    throw new Error(
      `Pre-sign simulation failed: ${sim.revertReason ?? "execution reverted"}. ` +
        `Refusing to forward to Ledger — signing this tx would burn gas on a revert. ` +
        `If a prerequisite step (e.g. an ERC-20 approve) must be mined first, send it ` +
        `and wait for confirmation before retrying. Use simulate_transaction to debug.`,
    );
  }
  // The WC account-match check is meaningless in demo mode: there's no paired
  // session (and no project ID needed), and `send_transaction` returns a sim
  // envelope rather than broadcasting. Calling getConnectedAccounts() here
  // would throw inside getProjectId() and abort the whole preview flow before
  // the integrity-check / hash output the demo is meant to showcase.
  if (tx.from && !isDemoMode()) {
    const accounts = (await getConnectedAccounts()).map((a) => a.toLowerCase());
    const from = tx.from.toLowerCase();
    if (accounts.length > 0 && !accounts.includes(from)) {
      throw new Error(
        `Pre-sign check: tx.from (${tx.from}) is not one of the accounts exposed by the paired ` +
          `WalletConnect session (${accounts.join(", ")}). Refusing to submit. If this is a ` +
          `different Ledger account, re-pair with that account unlocked.`,
      );
    }
  }
  if (tx.verification) {
    const rehash = payloadFingerprint({
      chain: tx.chain,
      to: tx.to,
      value: tx.value,
      data: tx.data,
    });
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: payload hash mismatch at preview/send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The transaction bytes (chain/to/value/data) changed between ` +
          `prepare and preview — refusing to proceed. Do NOT retry this handle. Re-prepare the ` +
          `transaction from scratch and compare the new preview against user intent carefully: ` +
          `this drift means the bytes mutated inside the MCP process after the user reviewed ` +
          `them, which is not a normal operating condition and may indicate a compromised ` +
          `intermediary swapping bytes at send time.`,
      );
    }
  }
}

/**
 * Server-side pin of nonce + EIP-1559 fees + gasLimit for the tx named by
 * `handle`. Runs the full EVM pre-sign guard pipeline (chainId, safety
 * allowlist, simulation, account match, payload hash) BEFORE pinning so a
 * tx that would have been refused at send time never gets as far as the
 * user matching a hash. Computes the EIP-1559 pre-sign RLP hash from the
 * pinned tuple and stashes both on the handle.
 *
 * The caller (typically the `preview_send` MCP tool) surfaces the returned
 * hash to the user as a `LEDGER BLIND-SIGN HASH` block — the user reads
 * it BEFORE `send_transaction` is called and the Ledger device prompt
 * appears. `send_transaction` then reads the stashed pin verbatim and
 * forwards it through WalletConnect, so the on-device hash is deterministic.
 *
 * Re-entrant with an explicit opt-in: calling `previewSend` a second time on
 * the same handle returns the existing pin verbatim. Pass `refresh: true` to
 * re-pin (e.g. if the user paused for minutes and wants fresh fees). Without
 * this guard, a buggy or adversarial agent could silently swap the pre-sign
 * hash between the moment the user reads it in chat and the moment Ledger
 * displays it — the hash-match UX would still catch the change, but the
 * guard makes the default deterministic.
 */
export async function previewSend(args: PreviewSendArgs): Promise<{
  handle: string;
  chain: SupportedChain;
  to: `0x${string}`;
  valueWei: string;
  preSignHash: `0x${string}`;
  pinned: {
    nonce: number;
    maxFeePerGas: string;
    maxPriorityFeePerGas: string;
    gas: string;
    /**
     * Live base fee from `latestBlock.baseFeePerGas` at pin time. Surfaced
     * for the preview-time cost block's EIP-1559 breakdown (issue #650);
     * not part of what `send_transaction` forwards to WalletConnect — the
     * tx is signed against `maxFeePerGas` + `maxPriorityFeePerGas`.
     */
    baseFeePerGas: string;
  };
  /**
   * Native-currency cost computed at preview time from the pinned tuple
   * (`gas * (baseFee + priority)` — the realistic-case cost; worst-case
   * is bounded by `gas * maxFeePerGas`). Lets the preview-time render
   * surface a fee-spike that happened between prepare and preview, without
   * scrolling back through the verification + cross-check + agent-task
   * surfaces. Always present on success — derived from values already in
   * scope, no separate failure path. Issue #650.
   */
  gasCostNative: string;
  /**
   * USD-denominated equivalent of `gasCostNative`. Undefined when the
   * native-token price lookup (DefiLlama) degraded. The render block falls
   * back to native-only in that case rather than fabricating a number.
   */
  gasCostUsd?: number;
  previewToken: string;
  refreshed?: boolean;
  /**
   * Swiss-knife decoder URL carried over from prepare-time verification. Echoed
   * on the preview response so `renderPreviewVerifyAgentTaskBlock` can splice
   * it directly into the ⚠ DECODE UNAVAILABLE branch of the render template —
   * without this, the agent was "mentioning" the URL lived in the earlier
   * prepare block instead of actually surfacing it in the CHECKS PERFORMED
   * output, forcing the user to scroll up.
   */
  decoderUrl?: string;
  /**
   * True for the three Ledger clear-sign-only tx types: native ETH send
   * (empty calldata), ERC-20 `transfer`, ERC-20 `approve`. The preview
   * handler uses this to render a reduced CHECKS PERFORMED template —
   * no PAIR-CONSISTENCY HASH line, no BLIND-SIGN branch of NEXT ON-DEVICE
   * (both are noise for these tx types; Ledger clear-signs decoded
   * fields and the hash-match path never fires). No security posture
   * change; the server still pins and re-hashes at send time.
   */
  clearSignOnly?: boolean;
}> {
  if (hasTronHandle(args.handle)) {
    throw new Error(
      "preview_send is EVM-only; TRON handles do not use WalletConnect and their on-device " +
        "preview comes from the TRON app's clear-sign screens. Call send_transaction directly " +
        "for TRON handles.",
    );
  }
  const tx = consumeHandle(args.handle);
  const decoderUrl = tx.verification?.decoderUrl;
  const clearSignOnly = isClearSignOnlyTx(tx);
  const existing = getPinnedGas(args.handle);
  if (existing && !args.refresh) {
    const cost = await computePreviewCost(tx.chain, existing);
    return {
      handle: args.handle,
      chain: tx.chain,
      to: tx.to,
      valueWei: tx.value,
      preSignHash: existing.preSignHash,
      pinned: {
        nonce: existing.nonce,
        maxFeePerGas: existing.maxFeePerGas.toString(),
        maxPriorityFeePerGas: existing.maxPriorityFeePerGas.toString(),
        gas: existing.gas.toString(),
        baseFeePerGas: existing.baseFeePerGas.toString(),
      },
      gasCostNative: cost.native,
      ...(cost.usd !== undefined ? { gasCostUsd: cost.usd } : {}),
      previewToken: existing.previewToken,
      ...(decoderUrl ? { decoderUrl } : {}),
      ...(clearSignOnly ? { clearSignOnly: true } : {}),
    };
  }
  await runEvmPreSignGuards(tx);
  // Demo mode never opens a WC session, so don't fall back to it for the
  // sender address. Every prepare_* writes `tx.from` from the wallet arg,
  // which is the persona address in demo mode — that's the value we want.
  const from =
    tx.from ??
    (isDemoMode()
      ? undefined
      : ((await getConnectedAccounts())[0] as `0x${string}` | undefined));
  if (!from) {
    throw new Error(
      isDemoMode()
        ? "Cannot determine sender address for nonce/fee pin in demo mode. The prepare_* tool " +
            "did not set tx.from; this is an internal bug. Re-run set_demo_wallet and the " +
            "prepare_* tool, or file an issue with the failing tool name."
        : "Cannot determine sender address for nonce/fee pin; pair Ledger Live first.",
    );
  }
  const pinned = await pinSendFields(tx.chain, from, tx.to, tx.data, tx.value);
  const preSignHash = eip1559PreSignHash({
    chainId: CHAIN_IDS[tx.chain],
    nonce: pinned.nonce,
    maxFeePerGas: pinned.maxFeePerGas,
    maxPriorityFeePerGas: pinned.maxPriorityFeePerGas,
    gas: pinned.gas,
    to: tx.to,
    value: BigInt(tx.value),
    data: tx.data,
  });
  // Fresh pin → fresh token. If the caller re-pins (refresh: true), any token
  // captured before this call is invalid — prevents replaying an old preview's
  // "I already showed the user" claim against a tx with new fees/nonce/hash.
  const previewToken = randomUUID();
  const pin: StashedPin = {
    nonce: pinned.nonce,
    maxFeePerGas: pinned.maxFeePerGas,
    maxPriorityFeePerGas: pinned.maxPriorityFeePerGas,
    gas: pinned.gas,
    baseFeePerGas: pinned.baseFeePerGas,
    preSignHash,
    pinnedAt: Date.now(),
    previewToken,
  };
  attachPinnedGas(args.handle, pin);
  const cost = await computePreviewCost(tx.chain, pin);
  return {
    handle: args.handle,
    chain: tx.chain,
    to: tx.to,
    valueWei: tx.value,
    preSignHash,
    pinned: {
      nonce: pinned.nonce,
      maxFeePerGas: pinned.maxFeePerGas.toString(),
      maxPriorityFeePerGas: pinned.maxPriorityFeePerGas.toString(),
      gas: pinned.gas.toString(),
      baseFeePerGas: pinned.baseFeePerGas.toString(),
    },
    gasCostNative: cost.native,
    ...(cost.usd !== undefined ? { gasCostUsd: cost.usd } : {}),
    previewToken,
    ...(existing ? { refreshed: true } : {}),
    ...(decoderUrl ? { decoderUrl } : {}),
    ...(clearSignOnly ? { clearSignOnly: true } : {}),
  };
}

/**
 * Realistic-case fee estimate from a pinned EIP-1559 tuple. Uses
 * `gas * (baseFee + priority)` rather than `gas * maxFeePerGas` because
 * `maxFeePerGas` is `baseFee * 2 + priority` (a 4-block-rise headroom cap),
 * not what the user actually pays. The on-chain effectiveGasPrice is
 * `min(maxFeePerGas, baseFeeAtInclusion + priority)` — over the ~12s
 * inclusion window `baseFeeAtInclusion` rarely diverges far from `baseFee`,
 * so this is the right number to anchor abort decisions.
 *
 * Native is always returned (we have all the inputs); USD is undefined when
 * DefiLlama price lookup degrades. Issue #650.
 */
async function computePreviewCost(
  chain: SupportedChain,
  pin: StashedPin,
): Promise<{ native: string; usd?: number }> {
  const effectiveGasPrice = pin.baseFeePerGas + pin.maxPriorityFeePerGas;
  const gasWei = pin.gas * effectiveGasPrice;
  const native = formatUnits(gasWei, 18);
  const price = await getTokenPrice(chain, "native");
  if (price === undefined) {
    return { native };
  }
  const usd = round(Number(native) * price, 2);
  return { native, usd };
}

/**
 * Forward a prepared tx to the right signer based on which store owns the
 * handle. EVM handles take the WalletConnect path; the caller MUST have
 * called `preview_send` first so the pinned gas tuple + pre-sign hash live
 * on the handle (otherwise the on-device hash would be unpredictable and
 * the whole hash-match UX collapses). TRON handles take the USB HID path
 * and have no preview step.
 *
 * We check TRON first because its path has strictly fewer side effects on
 * failure (no WC relay roundtrip, no eth_call, no chain-id check that would
 * meaninglessly fire before we even know what chain we're on).
 */
/**
 * Build the user-facing refusal text when an EVM `send_transaction` is
 * called on a handle that has a previous ambiguous-attempt mark and
 * the agent did not pass `acknowledgeRetryRiskAfterAmbiguousFailure:
 * true`. Issue #326 P3 — the previous attempt's recovery guidance is
 * re-stated so the agent surfaces it to the user before retrying.
 *
 * Per-kind copy: `consumed_unmatched` and `ambiguous_disagreement`
 * lean stronger on "DO NOT retry without verifying on a block
 * explorer first"; `no_broadcast` is permissive but still requires
 * the user to know about the duplicate-prompt risk.
 */
function buildAmbiguousRetryRefusalMessage(
  prev: AmbiguousAttempt,
  handle: string,
): string {
  const ageMs = Date.now() - prev.at;
  const ageSec = Math.round(ageMs / 1000);
  const common =
    `This send_transaction call is a retry on a handle whose previous attempt (${ageSec}s ago) ` +
    `returned a WalletConnect timeout with probe outcome \`${prev.kind}\`. Issue #326 — a blind retry ` +
    `at this point CAN queue a duplicate signing prompt to Ledger Live (the WC subapp may have ` +
    `silently completed signing in the background). The duplicate-prompt scenario looks identical ` +
    `to a key-leak attack pattern (two prompts for the same nonce) even though it's mathematically ` +
    `benign — the user's first reaction will be alarm.\n\n` +
    `Before passing \`acknowledgeRetryRiskAfterAmbiguousFailure: true\` to retry, do this with the user:\n`;
  const perKind = (() => {
    if (prev.kind === "no_broadcast") {
      return (
        `  1. Tell the user that the previous attempt timed out but the on-chain probe (local RPC + ` +
        `Etherscan cross-check, where available) confirmed nothing landed at the pinned nonce.\n` +
        `  2. Tell them that retrying CAN STILL queue a duplicate prompt; if a duplicate prompt ` +
        `appears on their Ledger, the right action is **REJECT** — the original tx will land normally ` +
        `(retrying after a successful background sign double-counts the slot otherwise).\n` +
        `  3. Get explicit user acknowledgement, then re-call send_transaction with the same ` +
        `\`previewToken\`, \`userDecision: "send"\`, AND \`acknowledgeRetryRiskAfterAmbiguousFailure: true\`.`
      );
    }
    if (prev.kind === "consumed_unmatched") {
      return (
        `  1. Tell the user that the pinned nonce was consumed in the last 16 blocks but no tx in ` +
        `that window had a matching pre-sign hash. Most likely the original tx mined further back ` +
        `than the probe window, or a parallel tool / RBF replacement used the same slot.\n` +
        `  2. Have them check on a block explorer (Etherscan / Ledger Live tx history) for any tx ` +
        `with the pinned nonce on this wallet — if found, the original send already succeeded.\n` +
        `  3. If genuinely no tx with the pinned nonce is found AND the user wants to try again, ` +
        `they should re-prepare from scratch (new handle, fresh nonce/gas pin) — a same-pin retry ` +
        `would fail at the chain level with "nonce too low". Acknowledging the risk on THIS handle ` +
        `is unlikely to be useful; mostly this kind exists so the agent stops to verify rather than ` +
        `silently retrying.`
      );
    }
    // ambiguous_disagreement
    return (
      `  1. Tell the user that local RPC and Etherscan disagree on whether the pinned nonce was ` +
      `consumed: most likely Ledger Live finished signing + relayed the tx through ITS own RPC ` +
      `after our 120s timer fired and the propagation hasn't reached our local node yet.\n` +
      `  2. Have them check on a block explorer (etherscan.io / Ledger Live tx history) for a tx ` +
      `with the pinned nonce on this wallet within the last ~5 minutes — if found, the original ` +
      `send already succeeded and NO retry is needed.\n` +
      `  3. If after ~5 minutes no tx with the pinned nonce appears on chain, the slot is genuinely ` +
      `free and they should re-prepare from scratch (NEW handle, fresh nonce/gas pin). Retrying ` +
      `THIS handle with the ack flag is allowed but discouraged — re-prepare is the safer path.`
    );
  })();
  return (
    common +
    perKind +
    `\n\nHandle: \`${handle}\` (still valid; 15-min TTL from prepare). Previous outcome kind: ` +
    `\`${prev.kind}\`. Issue #326 P3.`
  );
}

export async function sendTransaction(args: SendTransactionArgs): Promise<{
  txHash: `0x${string}` | string;
  chain: SupportedChain | "tron" | "solana" | "bitcoin" | "litecoin";
  nextHandle?: string;
  /**
   * EIP-1559 pre-sign RLP hash the user already matched on-device during
   * preview_send. Echoed back so the post-broadcast block can reassure the
   * user that what was signed equals what was previewed. TRON / Solana
   * omit this (they clear-sign on the device; no hash to match in chat).
   */
  preSignHash?: `0x${string}`;
  /** Echoed back so the send handler can render on-device eyeball values without re-reading the handle. */
  to?: `0x${string}`;
  /** Decimal wei string, echoed alongside `preSignHash` for the post-broadcast block. */
  valueWei?: string;
  /**
   * Solana legacy-blockhash txs (currently just `nonce_init`). Surfaced so
   * `get_transaction_status` can distinguish "dropped" (current slot past
   * this) from "not-yet-propagated" when `getSignatureStatuses` returns
   * null.
   */
  lastValidBlockHeight?: number;
  /**
   * Solana durable-nonce txs (native/SPL sends, nonce_close, jupiter_swap,
   * all marginfi_* actions). Surfaced so `get_transaction_status` can
   * authoritatively distinguish "dropped" (on-chain nonce rotated past
   * `nonceValue`) from "not-yet-propagated". Authoritative because Agave
   * itself gates durable-nonce tx validity on the nonce state, not block
   * height.
   */
  durableNonce?: { noncePubkey: string; nonceValue: string };
}> {
  if (hasTronHandle(args.handle)) {
    return sendTronTransaction(args);
  }
  if (hasSolanaHandle(args.handle)) {
    return sendSolanaTransaction(args);
  }
  if (hasBitcoinHandle(args.handle)) {
    return sendBitcoinTransaction(args);
  }
  if (hasLitecoinHandle(args.handle)) {
    return sendLitecoinTransaction(args);
  }
  const stashed = getPinnedGas(args.handle);
  if (!stashed) {
    throw new Error(
      "Missing pinned gas for this handle. Call `preview_send(handle)` first — it pins " +
        "nonce + EIP-1559 fees server-side, computes the EIP-1559 pre-sign RLP hash Ledger " +
        "will display in blind-sign mode, and returns the LEDGER BLIND-SIGN HASH block for " +
        "the user to match BEFORE the Ledger device prompt appears. send_transaction then " +
        "forwards the exact pinned tuple so the on-device hash is deterministic.",
    );
  }
  // Preview-gate enforcement: these two args are what prove the agent went
  // through preview_send and actually surfaced the EXTRA CHECKS menu to the
  // user. A missing/mismatched token means the agent either skipped preview
  // entirely (token never issued) or collapsed preview_send + send_transaction
  // into one step without pausing for the user's 'send' reply. Error text is
  // detailed on purpose — the agent reads it and is expected to self-correct.
  if (!args.previewToken) {
    throw new Error(
      "Missing `previewToken` arg on send_transaction. preview_send returned a `previewToken` " +
        "field in its top-level JSON response — pass it back here verbatim. This is the " +
        "schema-enforced proof that the preview step actually ran and that the EXTRA CHECKS " +
        "YOU CAN RUN BEFORE REPLYING 'SEND' menu was surfaced to the user. If you skipped " +
        "preview_send, call it first.",
    );
  }
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this AFTER presenting the " +
        "EXTRA CHECKS menu from preview_send's agent-task block and receiving the user's " +
        "explicit 'send' reply. The literal is what proves the preview-time gate was shown to " +
        "the user rather than silently bypassed.",
    );
  }
  if (args.previewToken !== stashed.previewToken) {
    throw new Error(
      "SECURITY: `previewToken` does not match the current pin on this handle. The benign " +
        "explanation is that preview_send was re-called with `refresh: true` after the token " +
        "was captured — in that case, the new pin has a new token AND a new preSignHash the " +
        "user MUST re-match on-device. Do NOT retry with the old token: call preview_send " +
        "again, surface the fresh CHECKS PERFORMED block and the new blind-sign hash to the " +
        "user, and pass the new token. If the user did not ask for a refresh and the hash on " +
        "their Ledger screen no longer matches the one they were shown, reject on-device — a " +
        "token drift without a user-initiated refresh is not expected.",
    );
  }
  // Issue #326 P3 — gate retries behind an explicit ack flag when the
  // previous attempt on this handle returned a timeout-with-probe
  // outcome. The mark survives until the agent re-calls with the ack,
  // a successful submission retires the handle, or the 15-minute TTL
  // prunes the entry. Without this guard, an agent that sees the
  // probe's "safe to retry" message can pile retries on top of each
  // other and queue duplicate device prompts that look like a
  // key-leak attack pattern.
  const previousAmbiguous = getAmbiguousAttempt(args.handle);
  if (previousAmbiguous && args.acknowledgeRetryRiskAfterAmbiguousFailure !== true) {
    throw new Error(buildAmbiguousRetryRefusalMessage(previousAmbiguous, args.handle));
  }
  if (previousAmbiguous && args.acknowledgeRetryRiskAfterAmbiguousFailure === true) {
    // The user has acknowledged the risk; clear the mark so the next
    // attempt is a fresh slate. A SECOND ambiguous outcome on this
    // retry will set the mark again and require ANOTHER explicit ack.
    clearAmbiguousAttempt(args.handle);
  }
  const tx = consumeHandle(args.handle);
  const pinned = {
    nonce: stashed.nonce,
    maxFeePerGas: stashed.maxFeePerGas,
    maxPriorityFeePerGas: stashed.maxPriorityFeePerGas,
    gas: stashed.gas,
  };
  // Issue #232: thread the pinned pre-sign hash so a WC timeout can
  // run a late-broadcast probe (find a tx that mined after our 120s
  // timer fired) instead of surfacing a false-alarm timeout.
  let hash: `0x${string}`;
  try {
    hash = await requestSendTransaction(tx, pinned, stashed.preSignHash);
  } catch (e) {
    // Issue #326 P3 — mark the handle as ambiguous when the timeout
    // path produced a structured probe outcome. The next
    // send_transaction call on this handle will require the explicit
    // ack flag. Mark fires regardless of the WC error wording so
    // future probe-result variants slot in cleanly.
    if (e instanceof WalletConnectRequestTimeoutError && e.kind !== "unknown") {
      const kindMap: Record<
        Exclude<typeof e.kind, "unknown">,
        "no_broadcast" | "consumed_unmatched" | "ambiguous_disagreement"
      > = {
        no_broadcast: "no_broadcast",
        consumed_unmatched: "consumed_unmatched",
        ambiguous_disagreement: "ambiguous_disagreement",
      };
      markAmbiguousAttempt(args.handle, kindMap[e.kind]);
    }
    throw e;
  }
  // Only retire the handle after successful submission. If requestSendTransaction
  // throws (device disconnect, user rejection, relay timeout), the handle stays
  // valid and the caller can retry until the 15-minute TTL expires. The pin
  // stays attached so a retry doesn't have to re-preview.
  retireHandle(args.handle);
  return {
    txHash: hash,
    chain: tx.chain,
    ...(tx.next?.handle ? { nextHandle: tx.next.handle } : {}),
    preSignHash: stashed.preSignHash,
    to: tx.to,
    valueWei: tx.value,
  };
}

export async function getTransactionStatus(args: GetTransactionStatusArgs) {
  if (args.chain === "tron") {
    return getTronTransactionStatus(args.txHash);
  }
  if (args.chain === "solana") {
    return getSolanaTransactionStatus({
      signature: args.txHash,
      ...(args.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: args.lastValidBlockHeight }
        : {}),
      ...(args.durableNonce ? { durableNonce: args.durableNonce } : {}),
    });
  }
  if (args.chain === "bitcoin") {
    const { getBitcoinIndexer } = await import("../btc/indexer.js");
    const status = await getBitcoinIndexer().getTxStatus(args.txHash);
    if (status === null) {
      return {
        chain: "bitcoin" as const,
        txHash: args.txHash,
        status: "unknown" as const,
        note:
          "Tx not found at the indexer. Either it was dropped before any node saw it " +
          "(low fee, RBF-replaced, or never broadcast) or it hasn't propagated yet — " +
          "wait a minute and re-poll. If a low fee is suspected, the original handle " +
          "is gone after broadcast; rebuild via prepare_btc_send with a higher feeRate.",
      };
    }
    if (!status.confirmed) {
      return {
        chain: "bitcoin" as const,
        txHash: args.txHash,
        status: "pending" as const,
        note: "Tx is in the mempool — waiting for inclusion in a block.",
      };
    }
    return {
      chain: "bitcoin" as const,
      txHash: args.txHash,
      status: "success" as const,
      ...(status.blockHeight !== undefined
        ? { blockNumber: status.blockHeight.toString() }
        : {}),
      ...(status.confirmations !== undefined
        ? { confirmations: status.confirmations }
        : {}),
    };
  }
  const client = getClient(args.chain as SupportedChain);
  try {
    const receipt = await client.getTransactionReceipt({ hash: args.txHash as `0x${string}` });
    return {
      chain: args.chain,
      txHash: args.txHash,
      status: receipt.status === "success" ? "success" : "failed",
      blockNumber: receipt.blockNumber.toString(),
      gasUsed: receipt.gasUsed.toString(),
      from: receipt.from,
      to: receipt.to,
    };
  } catch {
    // No receipt yet — try to find it pending.
    try {
      const tx = await client.getTransaction({ hash: args.txHash as `0x${string}` });
      return {
        chain: args.chain,
        txHash: args.txHash,
        status: "pending",
        from: tx.from,
        to: tx.to,
      };
    } catch {
      return {
        chain: args.chain,
        txHash: args.txHash,
        status: "unknown",
        note: "Transaction not yet visible to this RPC — it may still be propagating.",
      };
    }
  }
}

/**
 * Re-emit the prepared tx + verification block for a known handle. The result
 * shape matches the original prepare_* response, so the existing handler
 * wrapper renders the same VERIFY-BEFORE-SIGNING text content blocks.
 *
 * Why this exists: agents periodically lose the original prepare_* tool result
 * from their context (compaction, long sessions, multi-agent handoffs). The
 * wrong recovery is to read the persisted tool-result JSON file from disk and
 * parse it with a python script — that bypasses the MCP boundary, drags the
 * agent into harness internals, and produces brittle code per call. The right
 * recovery is to ask the server: handles live in-memory for 15 minutes and
 * already carry the verification data, so a tool that takes a handle and
 * returns the same shape costs almost nothing and keeps every agent on the
 * same code path.
 *
 * Routes by handle origin: EVM handles come from tx-store, TRON handles from
 * tron-tx-store. If neither knows the handle, throws with a single clear
 * "expired or unknown" message rather than chaining store-specific errors.
 */
export function getTxVerification(args: GetTxVerificationArgs): UnsignedTx | UnsignedTronTx {
  if (hasHandle(args.handle)) return consumeHandle(args.handle);
  if (hasTronHandle(args.handle)) return consumeTronHandle(args.handle);
  throw new Error(
    `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
      `15 minutes after issue and are deleted on successful submission. Re-run the ` +
      `prepare_* tool to get a fresh handle.`
  );
}

/**
 * Per-chain prompts appended to verification artifacts. Each tells a second
 * LLM how to independently decode the payload of one specific chain without
 * trusting any of the first agent's narrative.
 *
 * v2 redesign (compact form): the prior monolithic ~80-line prompts were
 * unreadable for the "lazy user" who needs to confirm no prompt-injection
 * was added to the block before pasting it. Now each chain's inline
 * instruction is ~8-12 lines covering the universal task (decode →
 * compare → flag); the full chain-specific carve-outs (Solana
 * durable-nonce, TRON contract types, blind-sign vs clear-sign branches)
 * live in `docs/cross-check-v1.md` and the banner points the second LLM
 * + the user at the URL with the spec's SHA-256 pinned for tamper
 * detection. See `src/signing/cross-check-banner.ts`.
 *
 * Each constant is byte-identical across every artifact for that chain, so
 * an attacker still cannot inject behavior through the instructions: the
 * text doesn't depend on tx data, only on which chain the handle is for.
 */
const EVM_AGENT_INSTRUCTIONS = [
  "Audit task (EVM):",
  "  1. Decode payload.data yourself (4-byte selector + ABI args). Don't trust",
  "     payload.description / payload.decoded — decoding from scratch IS the check.",
  "  2. Describe in plain English what the tx does to payload.to.",
  "  3. Compare your decode to payload.description: MATCH=pass, MISMATCH=tell user",
  "     to REJECT on-device with a ✗ MISMATCH headline, PARTIAL=mention extras only.",
  "  4. Flag uint256.max approvals, unknown destinations, delegatecalls. If the",
  "     calldata embeds a recipient/spender that DIFFERS from payload.from, the",
  "     user is sending to a third party — they should confirm intent.",
  "  5. On-device: BLIND-SIGN ⇒ on-device hash MUST equal payload.preSignHash;",
  "     CLEAR-SIGN ⇒ verify decoded fields match your decode. Mismatch ⇒ REJECT.",
  "Full rules (selector list, plugin allowlist, edge cases): see Spec URL above.",
].join("\n");

const TRON_AGENT_INSTRUCTIONS = [
  "Audit task (TRON):",
  "  1. Decode payload.rawDataHex yourself (protobuf Transaction.raw). Identify",
  "     the contract type (TransferContract / TriggerSmartContract / VoteWitness /",
  "     FreezeBalanceV2 / etc.) and any TRC-20 selector inside",
  "     TriggerSmartContract.parameter. Don't trust payload.description.",
  "  2. Describe in plain English what the tx does.",
  "  3. Compare to payload.description: MATCH=pass, MISMATCH=✗ MISMATCH + REJECT,",
  "     PARTIAL=mention extras only.",
  "  4. Flag TRC-20 approve(max_uint256), recipients that DIFFER from payload.from",
  "     when the description claims self-targeted (third-party send — confirm intent).",
  "  5. On-device: Ledger TRON app CLEAR-SIGNS every supported action (no",
  "     blind-sign hash). Verify the on-screen action+recipient+amount match",
  "     your decode. Mismatch ⇒ REJECT.",
  "Full rules (contract-type list, edge cases): see Spec URL above.",
].join("\n");

const SOLANA_AGENT_INSTRUCTIONS = [
  "Audit task (Solana):",
  "  1. Decode payload.messageBase64 yourself (base64 → @solana/web3.js Message.from)",
  "     and enumerate every ix's programId + accounts + data. Don't trust",
  "     payload.description / payload.decoded.",
  "  2. Describe in plain English what the tx does across all instructions.",
  "  3. Compare to payload.description: MATCH=pass, MISMATCH=✗ MISMATCH + REJECT,",
  "     PARTIAL=mention extras (priority-fee / ATA-create / nonce-advance).",
  "  4. Flag transfers / authority delegations to addresses that DIFFER from",
  "     payload.from when description implies self-targeted. Server-specific",
  "     patterns are NOT red flags — see Spec URL for the full list (durable-",
  "     nonce ix[0] = AdvanceNonceAccount, SPL self-transfer source==dest).",
  "  5. On-device: BLIND-SIGN (all SPL transfers) ⇒ device 'Message Hash' MUST",
  "     equal payload.ledgerMessageHash. CLEAR-SIGN (native SOL send /",
  "     nonce_init / nonce_close) ⇒ verify decoded fields match. Mismatch ⇒ REJECT.",
  "Full rules (durable-nonce design, self-transfer rule, mode-by-action table):",
  "see Spec URL above.",
].join("\n");

/**
 * Pick the per-chain prompt for `buildPasteableBlock`. Centralized so the
 * three call sites (EVM / TRON / Solana branches of getVerificationArtifact)
 * stay terse and impossible to mis-pair.
 */
function instructionsFor(chain: "tron" | "solana" | SupportedChain): string {
  if (chain === "tron") return TRON_AGENT_INSTRUCTIONS;
  if (chain === "solana") return SOLANA_AGENT_INSTRUCTIONS;
  return EVM_AGENT_INSTRUCTIONS;
}

/**
 * Explicit start/end copy-markers so the user (and the second LLM) can tell
 * where the paste target begins and ends. Without them, the first agent's
 * surrounding commentary bleeds into the paste: live users have pasted the
 * "Reply with what the second agent said..." trailing sentence into the
 * second session, confusing it. The markers eliminate that ambiguity.
 */
const PASTE_START = '===== COPY FROM THIS LINE TO THE "END" MARKER INTO A SEPARATE LLM SESSION =====';
const PASTE_START_2 = "===== (ideally a different LLM provider — the point is no shared context)    =====";
const PASTE_END = '===== END — STOP COPYING HERE =====';

function buildPasteableBlock(
  chain: "tron" | "solana" | SupportedChain,
  payload: Record<string, unknown>,
): string {
  return [
    PASTE_START,
    PASTE_START_2,
    "",
    buildCrossCheckBanner(),
    "",
    instructionsFor(chain),
    "",
    "PAYLOAD:",
    JSON.stringify(payload, null, 2),
    "",
    PASTE_END,
  ].join("\n");
}

export interface EvmVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: SupportedChain;
  chainId: number;
  /**
   * The signer / paired wallet. Surfaced on the artifact (and inside the
   * pasteable payload) so the second agent can auto-check "is the recipient
   * embedded in the calldata the signer's own wallet or a third party?" —
   * the common case that a second agent otherwise has to flag uncertainly.
   * Optional on the type because UnsignedTx.from is optional, but populated
   * in practice for every tx our prepare_* tools produce.
   */
  from?: `0x${string}`;
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  payloadHash: `0x${string}`;
  preSignHash?: `0x${string}`;
  /**
   * Self-contained copy-paste string with explicit START/END markers,
   * instructions for the second agent, and the JSON payload embedded inline.
   * The agent should present this field VERBATIM to the user — do not
   * rewrap, don't add commentary inside the markers, don't reformat.
   */
  pasteableBlock: string;
}

export interface TronVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: "tron";
  from: string;
  txID: string;
  rawDataHex: string;
  payloadHash: `0x${string}`;
  /** See EvmVerificationArtifact.pasteableBlock. */
  pasteableBlock: string;
}

export interface SolanaVerificationArtifact {
  artifactVersion: "v1";
  handle: string;
  chain: "solana";
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "jito_stake"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  from: string;
  messageBase64: string;
  recentBlockhash: string;
  /** Domain-tagged server-side fingerprint (pair-consistency, NOT shown on-device). */
  payloadHash: `0x${string}`;
  /** base58(sha256(messageBytes)) — the exact 'Message Hash' the Ledger Solana app displays on blind-sign. Present for spl_send; absent for native_send (clear-signs). */
  ledgerMessageHash?: string;
  /** See EvmVerificationArtifact.pasteableBlock. */
  pasteableBlock: string;
}

export type VerificationArtifact =
  | EvmVerificationArtifact
  | TronVerificationArtifact
  | SolanaVerificationArtifact;

/**
 * Produce a sparse verification artifact for the tx named by `handle`. The
 * artifact is designed to be copy-pasted into a second, independent LLM
 * session (different provider ideally) so the user gets an adversarial,
 * from-scratch decode of the calldata — catching the threat class where the
 * first agent truthfully invokes prepare_* with malicious args and then
 * narrates a different action in chat.
 *
 * Deliberately omits the server's humanDecode / swiss-knife URL / 4byte
 * cross-check: the point is adversarial independence, and including any of
 * those fields risks the second agent echoing them instead of decoding.
 *
 * The trust anchor is the Ledger device screen, not a server-side signature.
 * If an adversary fabricates an artifact, the preSignHash it ships will not
 * match what Ledger displays at sign time — the user rejects. No new keypair,
 * no ceremony.
 */
export function getVerificationArtifact(args: GetVerificationArtifactArgs): VerificationArtifact {
  if (hasHandle(args.handle)) {
    const tx = consumeHandle(args.handle);
    // issueHandles stamps verification unconditionally — this should never
    // happen, but the type is optional.
    if (!tx.verification) {
      throw new Error(`Internal: tx for handle '${args.handle}' missing verification metadata.`);
    }
    const pin = getPinnedGas(args.handle);
    // Payload embedded in the paste-block is the SECOND-AGENT-FACING view —
    // just the fields the prompt references (chain, chainId, to, value, data,
    // payloadHash, preSignHash). The artifact's own `handle` / `artifactVersion`
    // are internal plumbing; including them would just invite the second
    // agent to comment on structural fields rather than the tx semantics.
    const pasteablePayload: Record<string, unknown> = {
      chain: tx.chain,
      chainId: CHAIN_IDS[tx.chain],
      to: tx.to,
      value: tx.value,
      data: tx.data,
      payloadHash: tx.verification.payloadHash,
    };
    if (tx.from) pasteablePayload.from = tx.from;
    if (pin) pasteablePayload.preSignHash = pin.preSignHash;
    const artifact: EvmVerificationArtifact = {
      artifactVersion: "v1",
      handle: args.handle,
      chain: tx.chain,
      chainId: CHAIN_IDS[tx.chain],
      to: tx.to,
      value: tx.value,
      data: tx.data,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock(tx.chain, pasteablePayload),
    };
    if (tx.from) artifact.from = tx.from;
    if (pin) artifact.preSignHash = pin.preSignHash;
    return artifact;
  }
  if (hasTronHandle(args.handle)) {
    const tx = consumeTronHandle(args.handle);
    if (!tx.verification) {
      throw new Error(`Internal: TRON tx for handle '${args.handle}' missing verification metadata.`);
    }
    const pasteablePayload = {
      chain: "tron",
      from: tx.from,
      txID: tx.txID,
      rawDataHex: tx.rawDataHex,
      payloadHash: tx.verification.payloadHash,
    };
    return {
      artifactVersion: "v1",
      handle: args.handle,
      chain: "tron",
      from: tx.from,
      txID: tx.txID,
      rawDataHex: tx.rawDataHex,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock("tron", pasteablePayload),
    };
  }
  if (hasSolanaHandle(args.handle)) {
    const tx = consumeSolanaHandle(args.handle);
    if (!tx.verification) {
      throw new Error(`Internal: Solana tx for handle '${args.handle}' missing verification metadata.`);
    }
    // Blind-sign actions need the server-computed Ledger Message Hash in the
    // artifact payload so the second LLM can tell the user which value to
    // match against the on-device screen. Clear-sign actions (native_send,
    // nonce_init, nonce_close) omit it — the device shows decoded fields
    // and there is no hash to match.
    const blindSignActions = new Set([
      "spl_send",
      "jupiter_swap",
      "marginfi_init",
      "marginfi_supply",
      "marginfi_withdraw",
      "marginfi_borrow",
      "marginfi_repay",
      "marinade_stake",
      "marinade_unstake_immediate",
      "native_stake_delegate",
      "native_stake_deactivate",
      "native_stake_withdraw",
      "lifi_solana_swap",
      "kamino_init_user",
      "kamino_supply",
      "kamino_borrow",
      "kamino_withdraw",
      "kamino_repay",
    ]);
    const ledgerMessageHash = blindSignActions.has(tx.action)
      ? solanaLedgerMessageHash(tx.messageBase64)
      : undefined;
    // `description` and `decoded` are the human/structured summary the FIRST
    // agent showed the user. The second LLM uses them as a comparison target
    // (step 3 of SECOND_AGENT_INSTRUCTIONS) AFTER it independently decodes
    // the bytes — the genuine threat here is "first agent narrates X, signs
    // Y", which manifests as a mismatch between the byte decode and these
    // fields. Without them, the second LLM has no claim to compare against
    // and falls back to generic "unusual pattern" pattern-matching, which
    // produces false positives on legitimate self-transfers + this server's
    // standard durable-nonce flow (live regression: a 100-USDC self-send
    // got flagged as adversarial because source ATA == dest ATA, with no
    // way for the second LLM to know the user explicitly asked for self).
    const pasteablePayload: Record<string, unknown> = {
      chain: "solana",
      action: tx.action,
      from: tx.from,
      messageBase64: tx.messageBase64,
      recentBlockhash: tx.recentBlockhash,
      payloadHash: tx.verification.payloadHash,
      description: tx.description,
      decoded: tx.decoded,
    };
    if (ledgerMessageHash) pasteablePayload.ledgerMessageHash = ledgerMessageHash;
    const artifact: SolanaVerificationArtifact = {
      artifactVersion: "v1",
      handle: args.handle,
      chain: "solana",
      action: tx.action,
      from: tx.from,
      messageBase64: tx.messageBase64,
      recentBlockhash: tx.recentBlockhash,
      payloadHash: tx.verification.payloadHash,
      pasteableBlock: buildPasteableBlock("solana", pasteablePayload),
    };
    if (ledgerMessageHash) artifact.ledgerMessageHash = ledgerMessageHash;
    return artifact;
  }
  throw new Error(
    `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
      `15 minutes after issue and are deleted on successful submission. Re-run the ` +
      `prepare_* tool to get a fresh handle.`
  );
}

/**
 * Server-side independent cross-check of a prepared EVM tx's calldata.
 *
 * Pipeline: fetch candidate function signatures for the 4-byte selector from
 * 4byte.directory, decode + re-encode the calldata against each, and report
 * which (if any) round-trips losslessly. Result is a `VerifyDecodeResult`
 * with a human-readable `summary` field — the orchestrator agent is
 * expected to relay that summary to the user verbatim.
 *
 * This exists so the agent does NOT have to script ad-hoc WebFetches to
 * verify arguments, and does NOT have to pretend it read swiss-knife's
 * client-rendered SPA output. One MCP tool = one auditable code path.
 */
export async function verifyTxDecode(args: GetTxVerificationArgs): Promise<VerifyDecodeResult> {
  if (hasTronHandle(args.handle)) {
    const tronTx = consumeTronHandle(args.handle);
    return notApplicableForTron(tronTx);
  }
  if (!hasHandle(args.handle)) {
    throw new Error(
      `Unknown or expired tx handle '${args.handle}'. Prepared transactions live for ` +
        `15 minutes after issue. Re-run the prepare_* tool to get a fresh handle.`
    );
  }
  const tx = consumeHandle(args.handle);
  return verifyEvmCalldata(tx);
}
