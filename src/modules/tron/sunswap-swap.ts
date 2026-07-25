import {
  isTronAddress,
  TRX_DECIMALS,
  SUNSWAP_V2_ROUTER_TRON,
  WTRX_TRON,
} from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { issueTronHandle } from "../../signing/tron-tx-store.js";
import { base58ToHex } from "./address.js";
import { assertTronRawDataMatches } from "./verify-raw-data.js";
import {
  trongridPost,
  preflightConstantContract,
  assertBandwidthSufficient,
  parseUnits,
  TOKEN_DECIMALS,
  SYMBOL_BY_CONTRACT,
  ENERGY_PRICE_SUN,
  DEFAULT_FEE_LIMIT_SUN,
  type TrongridConstantResponse,
  type TrongridTriggerResponse,
} from "./actions.js";
import { applyMinOut } from "../shared/slippage.js";
import type { UnsignedTronTx } from "../../types/index.js";

/**
 * SunSwap V2 same-chain swap builder for TRON.
 *
 * SunSwap V2 is a Uniswap-V2 fork on TRON; the router ABI is identical
 * (selectors + struct layout) so we hand-roll calldata against the
 * standard signatures rather than adopting an SDK. The probe at issue
 * #432 plan time confirmed: no official SunSwap TS SDK on npm; the
 * one community package (`sunswap-sdk`, last published >1yr ago) is an
 * EVM Uniswap V2 repackage. Hand-rolling matches the existing TRON
 * pipeline (raw HTTP to TronGrid + manual ABI-param encoding via
 * `encodeTrc20TransferParam`-shaped helpers).
 *
 * Smart Router (V1+V2+V3+PSM+SunCurve aggregator) is intentionally NOT
 * used — its ABI is a different shape (multi-version path encoding,
 * SwapData struct), and its only published address is testnet-only per
 * the sun-protocol/smart-exchange-router README. V2-router-only keeps
 * the calldata encoding simple and the trust surface small.
 *
 * BLIND-SIGN on Ledger TRON app — the SunSwap router is not in the
 * device's clear-sign allowlist (which currently only covers Transfer,
 * Vote, Freeze, and a few canonical TRC-20 selectors). User must enable
 * "Allow blind signing" in the TRON app's on-device Settings; the device
 * displays the txID (sha256 of raw_data_hex), which the user matches
 * against the txID in the prepare receipt.
 */

/** Sentinel for native TRX in `fromToken`/`toToken`. Internally swapped for WTRX in path encoding. */
const TRX_SENTINEL = "TRX";

/**
 * SunSwap V2 router selectors. SunSwap V2 inherits Uniswap V2's ABI verbatim
 * (including the "ETH" naming despite the chain being TRON), so these are
 * the well-known Uniswap V2 selectors.
 *
 *   swapExactETHForTokens(uint256,address[],address,uint256)            -> fb3bdb41
 *   swapExactTokensForETH(uint256,uint256,address[],address,uint256)    -> 18cbafe5
 *   swapExactTokensForTokens(uint256,uint256,address[],address,uint256) -> 38ed1739
 *   getAmountsOut(uint256,address[])                                    -> d06ca61f
 *
 * Hardcoded as constants to avoid a runtime keccak. The verifier rejects
 * a swap whose data doesn't match `selector || parameterHex`, so a
 * selector typo here surfaces immediately as a verify-time refusal
 * rather than as a wrong-method on-chain call.
 */
const SELECTOR_SWAP_EXACT_ETH_FOR_TOKENS = "fb3bdb41";
const SELECTOR_SWAP_EXACT_TOKENS_FOR_ETH = "18cbafe5";
const SELECTOR_SWAP_EXACT_TOKENS_FOR_TOKENS = "38ed1739";

const FUNCTION_SIG_SWAP_EXACT_ETH_FOR_TOKENS =
  "swapExactETHForTokens(uint256,address[],address,uint256)";
const FUNCTION_SIG_SWAP_EXACT_TOKENS_FOR_ETH =
  "swapExactTokensForETH(uint256,uint256,address[],address,uint256)";
const FUNCTION_SIG_SWAP_EXACT_TOKENS_FOR_TOKENS =
  "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)";

const DEFAULT_SLIPPAGE_BPS = 50;
const DEFAULT_DEADLINE_SEC = 1200;

// --- ABI param encoding (no viem; same convention as encodeTrc20TransferParam) ---

function encodeUint256(value: bigint): string {
  if (value < 0n) throw new Error("uint256 must be non-negative");
  return value.toString(16).padStart(64, "0");
}

function encodeAddressWord(base58: string): string {
  // TRC-20 ABI uses the 20-byte EVM-style form (drops the 0x41 TRON prefix).
  // Same convention as encodeTrc20TransferParam in address.ts.
  const hex21 = base58ToHex(base58);
  return hex21.slice(2).padStart(64, "0");
}

function encodeAddressArray(addresses: string[]): string {
  const length = encodeUint256(BigInt(addresses.length));
  const elements = addresses.map(encodeAddressWord).join("");
  return length + elements;
}

// --- Public input shape ---------------------------------------------------

export interface BuildTronSunswapSwapArgs {
  /** Source wallet — funds the swap and signs. T-prefix base58. */
  wallet: string;
  /** Source token: "TRX" sentinel for native TRX, OR T-prefix TRC20 contract. */
  fromToken: string;
  /** Destination token: same shape as fromToken. */
  toToken: string;
  /** Human-readable amount of fromToken (e.g. "100" for 100 TRX). */
  amount: string;
  /** Slippage in basis points; default 50 (0.5%). */
  slippageBps?: number;
  /** Deadline window in seconds from now; default 1200 (20 min). */
  deadlineSeconds?: number;
  /** Required when fromToken is a non-canonical TRC-20 (USDT/USDC/etc auto-resolve). */
  fromTokenDecimals?: number;
  /** Required when toToken is a non-canonical TRC-20. */
  toTokenDecimals?: number;
  /** Optional override fee limit in TRX (default 100 TRX). */
  feeLimitTrx?: string;
}

interface ResolvedToken {
  /** "TRX" or T-prefix TRC20 base58 — what the caller passed. */
  raw: string;
  /** What goes into the V2 path (always WTRX for the TRX sentinel). */
  pathAddress: string;
  /** Display symbol — canonical lookup, or "TRC-20 <addr>" for unknown. */
  symbol: string;
  /** Decimals — TRX=6, canonical TRC20s from the table, others from caller. */
  decimals: number;
}

function resolveToken(
  token: string,
  explicitDecimals: number | undefined,
  side: "from" | "to",
): ResolvedToken {
  if (token === TRX_SENTINEL) {
    return {
      raw: TRX_SENTINEL,
      pathAddress: WTRX_TRON,
      symbol: "TRX",
      decimals: TRX_DECIMALS,
    };
  }
  if (!isTronAddress(token)) {
    throw new Error(
      `${side}Token must be either "TRX" (literal) or a T-prefixed TRC-20 contract; got "${token}"`,
    );
  }
  const canonical = SYMBOL_BY_CONTRACT[token];
  if (canonical) {
    return {
      raw: token,
      pathAddress: token,
      symbol: canonical,
      decimals: TOKEN_DECIMALS[canonical],
    };
  }
  if (explicitDecimals === undefined) {
    throw new Error(
      `${side}Token ${token} is not in the canonical TRC-20 set (USDT/USDC/USDD/TUSD). ` +
        `Pass an explicit \`${side}TokenDecimals\` argument — we refuse to guess decimals on a swap ` +
        `because an off-by-power-of-ten amountIn (or minOut) silently exposes the user to a ` +
        `~10^N-fold larger price slippage than they intended.`,
    );
  }
  return {
    raw: token,
    pathAddress: token,
    symbol: `TRC-20 ${token}`,
    decimals: explicitDecimals,
  };
}

function buildPath(from: ResolvedToken, to: ResolvedToken): string[] {
  // V2 path rules:
  //   TRX   → TRC20: [WTRX, toToken]
  //   TRC20 → TRX  : [fromToken, WTRX]
  //   TRC20 → TRC20: [fromToken, WTRX, toToken]
  // SunSwap's WTRX pools dominate TRON liquidity, so the WTRX hop is
  // a stable predictable depth. Direct-pool optimisation can land later
  // if a real path exposes meaningfully better pricing.
  if (from.raw === TRX_SENTINEL) return [WTRX_TRON, to.pathAddress];
  if (to.raw === TRX_SENTINEL) return [from.pathAddress, WTRX_TRON];
  return [from.pathAddress, WTRX_TRON, to.pathAddress];
}

interface SwapEncoding {
  selector: string;
  functionSignature: string;
  parameterHex: string;
  callValueSun: bigint;
}

function encodeSwapCall(opts: {
  from: ResolvedToken;
  to: ResolvedToken;
  amountInBase: bigint;
  minOutBase: bigint;
  path: string[];
  wallet: string;
  deadlineUnix: bigint;
}): SwapEncoding {
  if (opts.from.raw === TRX_SENTINEL) {
    // swapExactETHForTokens(uint256 amountOutMin, address[] path, address to, uint256 deadline)
    // Head: amountOutMin | offset(path) | to | deadline = 4 * 32 = 128 bytes; offset = 0x80 = 128
    const head =
      encodeUint256(opts.minOutBase) +
      encodeUint256(128n) +
      encodeAddressWord(opts.wallet) +
      encodeUint256(opts.deadlineUnix);
    return {
      selector: SELECTOR_SWAP_EXACT_ETH_FOR_TOKENS,
      functionSignature: FUNCTION_SIG_SWAP_EXACT_ETH_FOR_TOKENS,
      parameterHex: head + encodeAddressArray(opts.path),
      callValueSun: opts.amountInBase,
    };
  }
  // TRC20 → X: amountIn first, then minOut, path-offset, to, deadline.
  // Head = 5 * 32 = 160; offset = 0xa0 = 160.
  const head =
    encodeUint256(opts.amountInBase) +
    encodeUint256(opts.minOutBase) +
    encodeUint256(160n) +
    encodeAddressWord(opts.wallet) +
    encodeUint256(opts.deadlineUnix);
  if (opts.to.raw === TRX_SENTINEL) {
    return {
      selector: SELECTOR_SWAP_EXACT_TOKENS_FOR_ETH,
      functionSignature: FUNCTION_SIG_SWAP_EXACT_TOKENS_FOR_ETH,
      parameterHex: head + encodeAddressArray(opts.path),
      callValueSun: 0n,
    };
  }
  return {
    selector: SELECTOR_SWAP_EXACT_TOKENS_FOR_TOKENS,
    functionSignature: FUNCTION_SIG_SWAP_EXACT_TOKENS_FOR_TOKENS,
    parameterHex: head + encodeAddressArray(opts.path),
    callValueSun: 0n,
  };
}

async function quoteAmountOut(opts: {
  wallet: string;
  amountInBase: bigint;
  path: string[];
  apiKey: string | undefined;
}): Promise<bigint> {
  // getAmountsOut(uint256 amountIn, address[] path)
  // Head: amountIn | offset(path) = 2 * 32 = 64; offset = 0x40 = 64.
  const parameter =
    encodeUint256(opts.amountInBase) +
    encodeUint256(64n) +
    encodeAddressArray(opts.path);

  const res = await trongridPost<TrongridConstantResponse>(
    "/wallet/triggerconstantcontract",
    {
      owner_address: opts.wallet,
      contract_address: SUNSWAP_V2_ROUTER_TRON,
      function_selector: "getAmountsOut(uint256,address[])",
      parameter,
      visible: true,
    },
    opts.apiKey,
  );
  if (res.result?.result === false) {
    throw new Error(
      `SunSwap V2 router rejected getAmountsOut: ${res.result.message ?? "unknown error"}. ` +
        `The path may have no liquidity or one of the addresses may not be a valid TRC-20 token.`,
    );
  }
  const data = res.constant_result?.[0];
  if (!data) {
    throw new Error("SunSwap V2 getAmountsOut returned no result — unexpected TronGrid shape.");
  }
  // Decode `uint256[]` return:
  //   bytes [0..31]    = offset to array (typically 0x20)
  //   bytes [32..63]   = array length
  //   bytes [64..]     = elements, 32 bytes each
  // Want the LAST element (final output through the path).
  const hex = data.replace(/^0x/, "");
  if (hex.length < 192) {
    throw new Error(
      `SunSwap V2 getAmountsOut returned shorter-than-expected payload (${hex.length} chars).`,
    );
  }
  const length = Number(BigInt("0x" + hex.slice(64, 128)));
  if (length < 2) {
    throw new Error(`SunSwap V2 getAmountsOut returned ${length}-element array; expected ≥ 2.`);
  }
  const finalStart = 128 + (length - 1) * 64;
  const finalHex = hex.slice(finalStart, finalStart + 64);
  if (finalHex.length !== 64) {
    throw new Error("SunSwap V2 getAmountsOut payload truncated before the final amount.");
  }
  return BigInt("0x" + finalHex);
}

async function readAllowance(opts: {
  wallet: string;
  token: string;
  apiKey: string | undefined;
}): Promise<bigint> {
  // allowance(address owner, address spender)
  const parameter =
    encodeAddressWord(opts.wallet) + encodeAddressWord(SUNSWAP_V2_ROUTER_TRON);
  const res = await trongridPost<TrongridConstantResponse>(
    "/wallet/triggerconstantcontract",
    {
      owner_address: opts.wallet,
      contract_address: opts.token,
      function_selector: "allowance(address,address)",
      parameter,
      visible: true,
    },
    opts.apiKey,
  );
  if (res.result?.result === false) {
    throw new Error(
      `Allowance read failed for token ${opts.token}: ${res.result.message ?? "unknown error"}`,
    );
  }
  const data = res.constant_result?.[0];
  if (!data) return 0n;
  const hex = data.replace(/^0x/, "");
  if (hex.length === 0) return 0n;
  return BigInt("0x" + hex.slice(0, 64));
}

/** Format a base-units bigint as a human decimal string. Strips trailing zeros. */
function formatBase(value: bigint, decimals: number): string {
  if (decimals === 0) return value.toString();
  const s = value.toString().padStart(decimals + 1, "0");
  const whole = s.slice(0, s.length - decimals);
  const frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export async function buildTronSunswapSwap(
  args: BuildTronSunswapSwapArgs,
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.wallet)) {
    throw new Error(`"wallet" is not a valid TRON mainnet address: ${args.wallet}`);
  }
  if (args.fromToken === TRX_SENTINEL && args.toToken === TRX_SENTINEL) {
    throw new Error("fromToken and toToken cannot both be TRX — that's not a swap.");
  }
  if (args.fromToken === args.toToken) {
    throw new Error(
      `fromToken and toToken are identical (${args.fromToken}) — that's not a swap.`,
    );
  }

  const slippageBps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (slippageBps < 0 || slippageBps > 10_000) {
    throw new Error(`slippageBps must be in [0, 10000]; got ${slippageBps}`);
  }
  const deadlineSeconds = args.deadlineSeconds ?? DEFAULT_DEADLINE_SEC;
  if (deadlineSeconds <= 0 || deadlineSeconds > 24 * 3600) {
    throw new Error(`deadlineSeconds must be in (0, 86400]; got ${deadlineSeconds}`);
  }

  const from = resolveToken(args.fromToken, args.fromTokenDecimals, "from");
  const to = resolveToken(args.toToken, args.toTokenDecimals, "to");
  const amountInBase = parseUnits(args.amount, from.decimals);
  if (amountInBase <= 0n) {
    throw new Error(`amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const path = buildPath(from, to);

  // Quote BEFORE the approval check — if the path has no liquidity we want
  // the better error (no liquidity) rather than the misleading "insufficient
  // allowance" the user might attribute to a missing approve.
  const quotedOut = await quoteAmountOut({
    wallet: args.wallet,
    amountInBase,
    path,
    apiKey,
  });
  if (quotedOut <= 0n) {
    throw new Error(
      `SunSwap V2 quote returned 0 output for ${from.symbol} → ${to.symbol}. ` +
        `Insufficient liquidity along path [${path.join(", ")}]; refusing to prepare a swap that would revert.`,
    );
  }
  const minOutBase = applyMinOut(quotedOut, slippageBps);

  // TRC-20 source flows require allowance on the V2 router. Per CLAUDE.md
  // ("Crypto/DeFi Transaction Preflight Checks: (4) approval status for
  // ERC20 operations"), check + refuse rather than letting the on-chain
  // swap revert.
  if (from.raw !== TRX_SENTINEL) {
    const allowance = await readAllowance({
      wallet: args.wallet,
      token: from.raw,
      apiKey,
    });
    if (allowance < amountInBase) {
      throw new Error(
        `SunSwap V2 router has insufficient allowance for ${from.symbol}: ` +
          `${allowance.toString()} < ${amountInBase.toString()} (${args.amount} ${from.symbol}). ` +
          `Run prepare_tron_trc20_approve(token: "${from.raw}", spender: "${SUNSWAP_V2_ROUTER_TRON}", ` +
          `amount: "${args.amount}") first, broadcast it, then retry this swap. If you've just ` +
          `signed an approve, wait ~3 seconds for the block to land before retrying — TRON's ` +
          `triggerconstantcontract reads the latest mined state, not the mempool.`,
      );
    }
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  const deadlineUnix = BigInt(nowSeconds + deadlineSeconds);
  const swap = encodeSwapCall({
    from,
    to,
    amountInBase,
    minOutBase,
    path,
    wallet: args.wallet,
    deadlineUnix,
  });

  const feeLimitSun = args.feeLimitTrx
    ? parseUnits(args.feeLimitTrx, TRX_DECIMALS)
    : DEFAULT_FEE_LIMIT_SUN;

  const body = {
    owner_address: args.wallet,
    contract_address: SUNSWAP_V2_ROUTER_TRON,
    function_selector: swap.functionSignature,
    parameter: swap.parameterHex,
    fee_limit: Number(feeLimitSun),
    call_value: Number(swap.callValueSun),
    visible: true,
  };

  const { energyUsed } = await preflightConstantContract(body, apiKey);
  const estimatedEnergySun = energyUsed * ENERGY_PRICE_SUN;
  const res = await trongridPost<TrongridTriggerResponse>(
    "/wallet/triggersmartcontract",
    body,
    apiKey,
  );
  if (!res.result?.result) {
    throw new Error(
      `TronGrid triggersmartcontract failed: ${res.result?.message ?? "unknown error"}`,
    );
  }
  const ttx = res.transaction;
  if (!ttx?.txID || !ttx.raw_data_hex) {
    throw new Error("TronGrid triggersmartcontract returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(ttx.raw_data_hex, {
    kind: "sunswap_swap",
    from: args.wallet,
    contract: SUNSWAP_V2_ROUTER_TRON,
    selector: swap.selector,
    parameterHex: swap.parameterHex,
    callValue: swap.callValueSun,
    feeLimitSun,
  });
  await assertBandwidthSufficient(args.wallet, ttx.raw_data_hex, apiKey);

  const quotedHuman = formatBase(quotedOut, to.decimals);
  const minOutHuman = formatBase(minOutBase, to.decimals);
  const description =
    `SunSwap V2 swap — ${args.amount} ${from.symbol} → ~${quotedHuman} ${to.symbol} ` +
    `(min ${minOutHuman}, ${(slippageBps / 100).toFixed(2)}% slippage)`;

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "sunswap_swap",
    from: args.wallet,
    txID: ttx.txID,
    rawData: ttx.raw_data,
    rawDataHex: ttx.raw_data_hex,
    description,
    decoded: {
      functionName: swap.functionSignature,
      args: {
        fromToken: from.raw,
        fromSymbol: from.symbol,
        toToken: to.raw,
        toSymbol: to.symbol,
        amountIn: args.amount,
        amountInBase: amountInBase.toString(),
        amountOutQuoted: quotedHuman,
        amountOutMin: minOutHuman,
        amountOutMinBase: minOutBase.toString(),
        path: path.join(" -> "),
        slippageBps: String(slippageBps),
        deadlineUnix: deadlineUnix.toString(),
        router: SUNSWAP_V2_ROUTER_TRON,
        callValueSun: swap.callValueSun.toString(),
      },
      parameterHex: swap.parameterHex,
    },
    feeLimitSun: feeLimitSun.toString(),
    estimatedEnergyUsed: energyUsed.toString(),
    estimatedEnergyCostSun: estimatedEnergySun.toString(),
  };
  return issueTronHandle(tx);
}
