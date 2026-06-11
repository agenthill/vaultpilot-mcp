import { fetchWithTimeout } from "../../data/http.js";
import {
  TRONGRID_BASE_URL,
  TRX_DECIMALS,
  TRON_TOKENS,
  isTronAddress,
} from "../../config/tron.js";
import { resolveTronApiKey, readUserConfig } from "../../config/user-config.js";
import { issueTronHandle } from "../../signing/tron-tx-store.js";
import { encodeTrc20TransferParam } from "./address.js";
import { assertTronRawDataMatches } from "./verify-raw-data.js";
import type { UnsignedTronTx } from "../../types/index.js";

/**
 * Default fee limit (100 TRX) for TRC-20 transfers. TronGrid's
 * /wallet/triggersmartcontract rejects without a fee_limit. 100 TRX is the
 * Ledger Live / Tronlink default and far above typical energy burn for a
 * USDT-TRC20 transfer (~15 TRX at current mainnet energy price).
 */
export const DEFAULT_FEE_LIMIT_SUN = 100_000_000n;

/** Hardcoded TRC-20 decimals for canonical stablecoins (same as balances.ts). */
export const TOKEN_DECIMALS: Record<keyof typeof TRON_TOKENS, number> = {
  USDT: 6,
  USDC: 6,
  USDD: 18,
  TUSD: 18,
};
export const SYMBOL_BY_CONTRACT: Record<string, keyof typeof TRON_TOKENS> = Object.fromEntries(
  (Object.entries(TRON_TOKENS) as [keyof typeof TRON_TOKENS, string][]).map(
    ([symbol, addr]) => [addr, symbol]
  )
);

/**
 * Parse a human amount ("1.5") into integer base units given `decimals`.
 * Mirrors viem's `parseUnits` but doesn't import viem (keeps the TRON
 * path free of EVM-only helpers).
 */
export function parseUnits(value: string, decimals: number): bigint {
  if (!/^\d+(\.\d+)?$/.test(value)) {
    throw new Error(`Invalid amount "${value}" — expected a positive decimal number.`);
  }
  const [whole, frac = ""] = value.split(".");
  if (frac.length > decimals) {
    throw new Error(
      `Amount "${value}" has more decimals than token precision (${decimals}). Truncate or round first.`
    );
  }
  const padded = frac.padEnd(decimals, "0");
  return BigInt(whole + padded);
}

export async function trongridPost<T>(
  path: string,
  body: Record<string, unknown>,
  apiKey: string | undefined
): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers["TRON-PRO-API-KEY"] = apiKey;
  const res = await fetchWithTimeout(`${TRONGRID_BASE_URL}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (res.status === 429) {
    // Same pattern as trongridGet — observability hook for the
    // "set up a TronGrid API key" nudge surfaced by
    // `get_vaultpilot_config_status`. Dynamic import to keep this
    // file's import graph unchanged for code-loading order.
    const { recordRateLimit } = await import(
      "../../data/rate-limit-tracker.js"
    );
    recordRateLimit({ kind: "tron" });
  }
  if (!res.ok) {
    throw new Error(`TronGrid ${path} returned ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

/**
 * TRON bandwidth-burn rate: 1000 sun (0.001 TRX) per byte of signed tx that
 * can't be covered by the account's free+staked bandwidth pool. Constant
 * on mainnet, documented in TRON's resource-model spec.
 */
const BANDWIDTH_BURN_SUN_PER_BYTE = 1000n;

/**
 * Signed tx envelope overhead on top of `raw_data_hex`: the ECDSA signature
 * (65 bytes) plus a small protobuf wrapper. Empirically 67 bytes for
 * singleton-signature txs on mainnet — we round up slightly (to 68) so the
 * pre-flight errs on the cautious side. A false-negative here is a clear
 * error message the user can act on; a false-positive is the exact
 * broadcast-time rejection we're trying to prevent.
 */
const SIGNATURE_OVERHEAD_BYTES = 68;

interface TrongridAccountBalanceResponse {
  balance?: number;
}

interface TrongridBandwidthResourceResponse {
  freeNetUsed?: number;
  freeNetLimit?: number;
  NetUsed?: number;
  NetLimit?: number;
}

/**
 * Pre-flight: does `from` have enough bandwidth (or liquid TRX for the
 * burn) to broadcast a tx of this size? The on-chain rule is per-pool,
 * not combined (from java-tron `BandwidthProcessor.consume`):
 *
 *   1. Try staked pool: if `bytes > NetLimit - NetUsed`, skip.
 *   2. Try free pool: if `bytes > freeNetLimit - freeNetUsed`, skip.
 *   3. Fall back to TRX burn: FULL `bytes * 1000 sun` deducted from
 *      liquid balance — not the shortfall. If balance can't cover the
 *      full burn, broadcast rejects with `BANDWITH_ERROR` (sic).
 *
 * Earlier versions of this check summed the two pools and used a
 * shortfall burn; that was wrong on both axes — a user with, say, 120
 * units free + 100 staked + 0.1 TRX liquid was incorrectly marked OK for
 * a 250-byte tx (sum 220 looked close, shortfall-burn 30 bytes = 0.03
 * TRX looked covered) when in reality neither pool covers the tx and the
 * real burn is 250 × 1000 sun = 0.25 TRX. That miscalculation is exactly
 * how a real vote-cast flow slipped through to a failed broadcast.
 *
 * Called after the tx is built (we need `rawDataHex` for size) but before
 * the handle is issued, so the error surfaces at prepare time.
 */
export async function assertBandwidthSufficient(
  from: string,
  rawDataHex: string,
  apiKey: string | undefined
): Promise<void> {
  const [resources, account] = await Promise.all([
    trongridPost<TrongridBandwidthResourceResponse>(
      "/wallet/getaccountresource",
      { address: from, visible: true },
      apiKey
    ),
    trongridPost<TrongridAccountBalanceResponse>(
      "/wallet/getaccount",
      { address: from, visible: true },
      apiKey
    ),
  ]);

  const signedTxBytes = rawDataHex.length / 2 + SIGNATURE_OVERHEAD_BYTES;
  const freeBw = Math.max(0, (resources.freeNetLimit ?? 0) - (resources.freeNetUsed ?? 0));
  const stakedBw = Math.max(0, (resources.NetLimit ?? 0) - (resources.NetUsed ?? 0));

  // Per-pool coverage: staked pool OR free pool must fully cover on its
  // own. Pools don't combine (java-tron checks each sequentially and
  // falls through on partial coverage).
  if (stakedBw >= signedTxBytes) return;
  if (freeBw >= signedTxBytes) return;

  // Both pools skipped → full-tx TRX burn.
  const burnNeededSun = BigInt(signedTxBytes) * BANDWIDTH_BURN_SUN_PER_BYTE;
  const balanceSun = BigInt(account.balance ?? 0);
  if (balanceSun >= burnNeededSun) return;

  const burnNeededTrx = (Number(burnNeededSun) / 1_000_000).toFixed(3);
  const balanceTrx = (Number(balanceSun) / 1_000_000).toFixed(3);
  throw new Error(
    `Insufficient bandwidth to broadcast this ${signedTxBytes}-byte tx. Neither pool ` +
      `covers it on its own (${freeBw} free, ${stakedBw} staked; tx needs ${signedTxBytes} ` +
      `from a single pool), and liquid TRX can't cover the fallback burn ` +
      `(${balanceTrx} TRX available, ${burnNeededTrx} TRX required at 1000 sun/byte × full tx). ` +
      `Either (a) top up liquid TRX by at least ~${burnNeededTrx} TRX, (b) wait ${formatFreeRegenHint(resources.freeNetUsed ?? 0, resources.freeNetLimit ?? 0, signedTxBytes)} for ` +
      `the free bandwidth pool to regenerate past ${signedTxBytes} units, or (c) freeze ` +
      `additional TRX for bandwidth via prepare_tron_freeze(resource: "bandwidth"). This ` +
      `would have failed at broadcast with TronGrid's BANDWITH_ERROR.`
  );
}

/**
 * Estimate how long until the free bandwidth pool has enough headroom to
 * cover a tx of `signedTxBytes`. TRON's free-pool usage decays linearly
 * over a 24h window (`netUsage(t) = currentUsage * max(0, 1 - t/86400)`).
 * For the pool to cover the tx, usage must drop to `freeLimit -
 * signedTxBytes`. If the tx exceeds the per-day free cap entirely,
 * no amount of waiting helps — say so. Otherwise we linear-interpolate.
 *
 * A concrete estimate beats "~24h" from the old error message, which was
 * the worst case (full pool needed from an empty start) but wrong for
 * the common case (user needs back a small fraction of the daily cap).
 */
function formatFreeRegenHint(freeUsed: number, freeLimit: number, signedTxBytes: number): string {
  const targetUsage = freeLimit - signedTxBytes;
  if (targetUsage < 0) return "(unreachable — tx exceeds the per-day free cap)";
  if (freeUsed <= targetUsage) return "(already enough — retry)";
  const regenSec = 86400 * (freeUsed - targetUsage) / freeUsed;
  if (regenSec < 3600) return `~${Math.ceil(regenSec / 60)} minutes`;
  return `~${(regenSec / 3600).toFixed(1)} hours`;
}

/**
 * TronGrid surfaces errors in two shapes depending on endpoint:
 *   - /wallet/createtransaction and /wallet/withdrawbalance: `{Error: "..."}`
 *     at the top level on failure.
 *   - /wallet/triggersmartcontract: always returns 200; look at
 *     `result.result === true` and `result.message`.
 * Normalizing both to exceptions keeps the tx builders uniform.
 */
interface TrongridDirectTx {
  Error?: string;
  txID?: string;
  raw_data?: unknown;
  raw_data_hex?: string;
  visible?: boolean;
}

export interface TrongridTriggerResponse {
  result?: { result?: boolean; message?: string; code?: string };
  transaction?: {
    txID?: string;
    raw_data?: unknown;
    raw_data_hex?: string;
    visible?: boolean;
  };
}

export interface TrongridConstantResponse {
  result?: { result?: boolean; message?: string; code?: string };
  energy_used?: number;
  constant_result?: string[];
}

/**
 * Mainnet energy price in sun-per-energy. Hardcoded at the October 2024
 * governance value (420 sun/energy). If governance changes it, the estimate
 * drifts; fee_limit (the cap) is still enforced by the network, so drift
 * here just affects the preview string. A dynamic read via
 * /wallet/getchainparameters is possible but not worth the extra round-trip
 * for a preview-only number.
 */
export const ENERGY_PRICE_SUN = 420n;

/** Well-known solidity revert selector: Error(string) = 0x08c379a0. */
const ERROR_STRING_SELECTOR = "08c379a0";

/**
 * Decode the revert payload from a triggerconstantcontract constant_result.
 * The network returns ABI-encoded revert data: 4-byte Error(string) selector
 * plus an ABI-encoded string. We crudely extract the string bytes without
 * pulling in viem — this helper lives on the TRON path which is otherwise
 * viem-free.
 */
function decodeRevertString(constantResult: string[] | undefined): string | undefined {
  if (!constantResult || constantResult.length === 0) return undefined;
  const hex = constantResult[0].replace(/^0x/, "");
  if (!hex.startsWith(ERROR_STRING_SELECTOR)) return undefined;
  const body = hex.slice(ERROR_STRING_SELECTOR.length);
  // body = 32-byte offset (ignored) + 32-byte length + string bytes padded to 32.
  if (body.length < 128) return undefined;
  const lengthHex = body.slice(64, 128);
  const length = parseInt(lengthHex, 16);
  if (!Number.isFinite(length) || length <= 0 || length > body.length / 2) return undefined;
  const stringHex = body.slice(128, 128 + length * 2);
  try {
    return Buffer.from(stringHex, "hex").toString("utf8");
  } catch {
    return undefined;
  }
}

/**
 * Dry-run a smart-contract call via /wallet/triggerconstantcontract. This is
 * TRON's eth_call analogue — it executes the call against current state
 * without building a broadcastable tx. We use it as a pre-flight before
 * /wallet/triggersmartcontract so we refuse to hand out a handle for a tx
 * that would revert on-chain (insufficient balance, paused token, blocked
 * recipient). Returns the energy estimate for the preview.
 */
export async function preflightConstantContract(
  body: Record<string, unknown>,
  apiKey: string | undefined
): Promise<{ energyUsed: bigint }> {
  const res = await trongridPost<TrongridConstantResponse>(
    "/wallet/triggerconstantcontract",
    body,
    apiKey
  );
  if (res.result?.result === false) {
    throw new Error(
      `TronGrid pre-flight rejected the call: ${res.result.message ?? "unknown validation error"}`
    );
  }
  const revert = decodeRevertString(res.constant_result);
  if (revert) {
    throw new Error(
      `TronGrid pre-flight reverted: ${revert}. This tx would fail on-chain — refusing to prepare a handle.`
    );
  }
  const energyUsed = BigInt(res.energy_used ?? 0);
  return { energyUsed };
}

interface TrongridGetAccountResponse {
  latest_withdraw_time?: number;
}

const CLAIM_COOLDOWN_MS = 24 * 60 * 60 * 1000;

async function readClaimCooldownRemaining(
  owner: string,
  apiKey: string | undefined
): Promise<number | null> {
  const res = await trongridPost<TrongridGetAccountResponse>(
    "/wallet/getaccount",
    { address: owner, visible: true },
    apiKey
  );
  const last = res.latest_withdraw_time;
  if (!last) return null;
  const elapsed = Date.now() - last;
  if (elapsed >= CLAIM_COOLDOWN_MS) return 0;
  return CLAIM_COOLDOWN_MS - elapsed;
}

function formatDuration(ms: number): string {
  const totalMin = Math.ceil(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}m`;
  return `${h}h ${m}m`;
}

// ----- Native TRX send -----

export interface BuildTronNativeSendArgs {
  from: string;
  to: string;
  amount: string;
}

export async function buildTronNativeSend(
  args: BuildTronNativeSendArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  if (!isTronAddress(args.to)) {
    throw new Error(`"to" is not a valid TRON mainnet address: ${args.to}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    to_address: args.to,
    amount: Number(amountSun),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/createtransaction",
    body,
    apiKey
  );
  if (res.Error) {
    throw new Error(`TronGrid createtransaction failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid createtransaction returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "native_send",
    from: args.from,
    to: args.to,
    amountSun,
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "native_send",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Send ${args.amount} TRX to ${args.to}`,
    decoded: {
      functionName: "TransferContract",
      args: { to: args.to, amount: args.amount, symbol: "TRX" },
    },
  };
  return issueTronHandle(tx);
}

// ----- TRC-20 send -----

export interface BuildTronTokenSendArgs {
  from: string;
  to: string;
  /** Base58 TRC-20 contract address. */
  token: string;
  amount: string;
  /** Override fee limit in TRX (default: 100 TRX). */
  feeLimitTrx?: string;
}

export async function buildTronTokenSend(
  args: BuildTronTokenSendArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  if (!isTronAddress(args.to)) {
    throw new Error(`"to" is not a valid TRON mainnet address: ${args.to}`);
  }
  if (!isTronAddress(args.token)) {
    throw new Error(`"token" is not a valid TRC-20 base58 address: ${args.token}`);
  }

  // Resolve decimals + symbol from the canonical table. Unknown TRC-20s
  // are rejected here in Phase 2 — a proper `trc20.decimals()` on-chain
  // read can land later, but for now we only prepare sends for tokens we
  // can name in the preview (no user-confusing "UNKNOWN token" previews).
  const symbol = SYMBOL_BY_CONTRACT[args.token];
  if (!symbol) {
    throw new Error(
      `Token ${args.token} is not in the canonical TRC-20 set (USDT/USDC/USDD/TUSD). ` +
        `Preparing a send for unknown TRC-20s is not supported in Phase 2 — file a capability ` +
        `request if you need this.`
    );
  }
  const decimals = TOKEN_DECIMALS[symbol];
  const amountBase = parseUnits(args.amount, decimals);
  if (amountBase <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const feeLimitSun = args.feeLimitTrx
    ? parseUnits(args.feeLimitTrx, TRX_DECIMALS)
    : DEFAULT_FEE_LIMIT_SUN;

  const parameter = encodeTrc20TransferParam(args.to, amountBase);
  const body = {
    owner_address: args.from,
    contract_address: args.token,
    function_selector: "transfer(address,uint256)",
    parameter,
    fee_limit: Number(feeLimitSun),
    call_value: 0,
    visible: true,
  };
  const apiKey = resolveTronApiKey(readUserConfig());
  // Pre-flight dry-run via triggerconstantcontract. Catches the broad class of
  // prepare-succeeds-then-broadcast-reverts failures: insufficient token
  // balance, USDT blocklist, paused contract. Also gives us the energy
  // estimate for the preview (vs. the fee_limit cap).
  const { energyUsed } = await preflightConstantContract(body, apiKey);
  const estimatedEnergySun = energyUsed * ENERGY_PRICE_SUN;
  const res = await trongridPost<TrongridTriggerResponse>(
    "/wallet/triggersmartcontract",
    body,
    apiKey
  );
  if (!res.result?.result) {
    throw new Error(
      `TronGrid triggersmartcontract failed: ${res.result?.message ?? "unknown error"}`
    );
  }
  const ttx = res.transaction;
  if (!ttx?.txID || !ttx.raw_data_hex) {
    throw new Error("TronGrid triggersmartcontract returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(ttx.raw_data_hex, {
    kind: "trc20_send",
    from: args.from,
    contract: args.token,
    parameterHex: parameter,
    feeLimitSun,
    callValue: 0n,
  });
  await assertBandwidthSufficient(args.from, ttx.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "trc20_send",
    from: args.from,
    txID: ttx.txID,
    rawData: ttx.raw_data,
    rawDataHex: ttx.raw_data_hex,
    description: `Send ${args.amount} ${symbol} to ${args.to}`,
    decoded: {
      functionName: "transfer(address,uint256)",
      args: {
        to: args.to,
        amount: args.amount,
        symbol,
        contract: args.token,
      },
      parameterHex: parameter,
    },
    feeLimitSun: feeLimitSun.toString(),
    estimatedEnergyUsed: energyUsed.toString(),
    estimatedEnergyCostSun: estimatedEnergySun.toString(),
  };
  return issueTronHandle(tx);
}

// ----- TRC-20 approve -----

export interface BuildTronTrc20ApproveArgs {
  from: string;
  /** Base58 TRC-20 contract address. Any TRC-20 is accepted. */
  token: string;
  /** Base58 spender (typically the LiFi Diamond on TRON for prepare_tron_lifi_swap flows). */
  spender: string;
  amount: string;
  /** Required when `token` is not in the canonical TRC-20 set. */
  decimals?: number;
  feeLimitTrx?: string;
}

/**
 * Build a TRC-20 `approve(spender, amount)` call. Same TronGrid pipeline
 * as `buildTronTokenSend` (triggersmartcontract → preflight constant call
 * → bandwidth check → raw_data verify) but with selector `095ea7b3`
 * instead of `a9059cbb`.
 *
 * Why this exists: `prepare_tron_lifi_swap` requires the user to have
 * already approved the LiFi Diamond on TRON (TU3ymitEKCWQFtASkEeHaPb8NfZcJtCHLt)
 * to pull TRC-20 tokens. This builder lets the agent prepare that approve
 * tx directly. We deliberately do NOT support `amount: "max"` /
 * unbounded approvals — those are a known TRC-20 griefing vector
 * (allowance survives across versions of the spender contract; a
 * later upgrade could authorize new behaviors against the unbounded
 * grant). Pass exactly the amount you intend to swap.
 */
export async function buildTronTrc20Approve(
  args: BuildTronTrc20ApproveArgs,
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  if (!isTronAddress(args.token)) {
    throw new Error(`"token" is not a valid TRC-20 base58 address: ${args.token}`);
  }
  if (!isTronAddress(args.spender)) {
    throw new Error(`"spender" is not a valid TRON base58 address: ${args.spender}`);
  }

  // Decimals: canonical lookup OR caller-supplied. We REFUSE to default —
  // an off-by-power-of-ten allowance would silently authorize a
  // 10^12-fold larger spend than intended, and there's no UX recovery
  // from that on a Ledger blind-sign flow.
  const canonicalSymbol = SYMBOL_BY_CONTRACT[args.token];
  if (!canonicalSymbol && args.decimals === undefined) {
    throw new Error(
      `Token ${args.token} is not in the canonical TRC-20 set (USDT/USDC/USDD/TUSD). ` +
        `Pass an explicit \`decimals\` argument — we refuse to guess decimals on approve ` +
        `because an off-by-power-of-ten allowance silently authorizes a vastly larger ` +
        `spend than intended.`,
    );
  }
  const decimals = canonicalSymbol ? TOKEN_DECIMALS[canonicalSymbol] : args.decimals!;
  const symbolForDescription = canonicalSymbol ?? `TRC-20 ${args.token}`;

  const amountBase = parseUnits(args.amount, decimals);
  if (amountBase <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const feeLimitSun = args.feeLimitTrx
    ? parseUnits(args.feeLimitTrx, TRX_DECIMALS)
    : DEFAULT_FEE_LIMIT_SUN;

  // approve(address spender, uint256 amount) — same param shape as
  // transfer, so the existing encoder works without any change.
  const parameter = encodeTrc20TransferParam(args.spender, amountBase);
  const body = {
    owner_address: args.from,
    contract_address: args.token,
    function_selector: "approve(address,uint256)",
    parameter,
    fee_limit: Number(feeLimitSun),
    call_value: 0,
    visible: true,
  };
  const apiKey = resolveTronApiKey(readUserConfig());
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
    kind: "trc20_approve",
    from: args.from,
    contract: args.token,
    parameterHex: parameter,
    feeLimitSun,
    callValue: 0n,
  });
  await assertBandwidthSufficient(args.from, ttx.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "trc20_approve",
    from: args.from,
    txID: ttx.txID,
    rawData: ttx.raw_data,
    rawDataHex: ttx.raw_data_hex,
    description: `Approve ${args.amount} ${symbolForDescription} for spender ${args.spender}`,
    decoded: {
      functionName: "approve(address,uint256)",
      args: {
        spender: args.spender,
        amount: args.amount,
        symbol: symbolForDescription,
        contract: args.token,
        decimals: String(decimals),
      },
      parameterHex: parameter,
    },
    feeLimitSun: feeLimitSun.toString(),
    estimatedEnergyUsed: energyUsed.toString(),
    estimatedEnergyCostSun: estimatedEnergySun.toString(),
  };
  return issueTronHandle(tx);
}

// ----- VoteWitness (cast/replace all votes atomically) -----

export interface TronVoteEntry {
  /** Base58 SR address to vote for. */
  address: string;
  /** Integer vote count — 1 vote requires 1 TRX of frozen TRON Power. */
  count: number;
}

export interface BuildTronVoteArgs {
  from: string;
  votes: TronVoteEntry[];
}

/**
 * Build a VoteWitnessContract tx. This REPLACES the wallet's entire vote
 * allocation atomically — TRON has no delta/patch endpoint. The caller must
 * pass the full intended allocation; passing `votes: []` clears all votes.
 *
 * We enforce unique `vote_address` entries (TronGrid accepts duplicates but
 * silently collapses them, which confuses downstream previews) and positive
 * integer counts. The sum of counts must not exceed the wallet's TRON Power
 * (frozen TRX) — we don't pre-check that here because it requires a second
 * TronGrid round-trip; TronGrid rejects with a clear message in that case and
 * `list_tron_witnesses(address)` exposes `availableVotes` for the caller.
 */
export async function buildTronVote(args: BuildTronVoteArgs): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  const seen = new Set<string>();
  for (const v of args.votes) {
    if (!isTronAddress(v.address)) {
      throw new Error(`Vote target "${v.address}" is not a valid TRON base58 address.`);
    }
    if (!Number.isInteger(v.count) || v.count <= 0) {
      throw new Error(
        `Vote count must be a positive integer (got ${v.count} for ${v.address}).`
      );
    }
    if (seen.has(v.address)) {
      throw new Error(`Duplicate vote target in allocation: ${v.address}`);
    }
    seen.add(v.address);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    votes: args.votes.map((v) => ({ vote_address: v.address, vote_count: v.count })),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/votewitnessaccount",
    body,
    apiKey
  );
  if (res.Error) {
    // Common: "Not enough tron power" when sum > availableVotes; "witness not
    // exists" if the address isn't an active SR or candidate. Surface verbatim.
    throw new Error(`TronGrid votewitnessaccount failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid votewitnessaccount returned no transaction — unexpected shape.");
  }

  const totalVotes = args.votes.reduce((s, v) => s + v.count, 0);
  const description =
    args.votes.length === 0
      ? `Clear all SR votes for ${args.from}`
      : `Cast ${totalVotes} TRON Power across ${args.votes.length} SR${
          args.votes.length === 1 ? "" : "s"
        } (replaces any prior votes)`;

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "vote",
    from: args.from,
    votes: args.votes.map((v) => ({ address: v.address, count: v.count })),
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const { makeDurableBinding } = await import(
    "../../security/durable-binding.js"
  );
  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "vote",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description,
    decoded: {
      functionName: "VoteWitnessContract",
      args: {
        owner: args.from,
        totalVotes: totalVotes.toString(),
        allocation: JSON.stringify(args.votes),
      },
    },
    // Inv #14 — one binding per Super Representative the user is voting
    // for. Empty `args.votes` (clear-all-votes) intentionally surfaces
    // an empty array rather than absent so the skill can distinguish
    // "clear" from "tool didn't emit bindings".
    durableBindings: args.votes.map((v) =>
      makeDurableBinding("tron-super-representative-address", v.address),
    ),
  };
  return issueTronHandle(tx);
}

// ----- Stake 2.0: Freeze / Unfreeze / WithdrawExpireUnfreeze -----

/**
 * TRON Stake 2.0 resource types. Lowercase on our API surface for consistency
 * with the staking reader (`get_tron_staking` returns `type: "bandwidth"|"energy"`).
 * TronGrid expects uppercase, so we uppercase at the edge.
 */
export type TronResource = "bandwidth" | "energy";

export interface BuildTronFreezeArgs {
  from: string;
  amount: string;
  resource: TronResource;
}

export async function buildTronFreeze(
  args: BuildTronFreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    frozen_balance: Number(amountSun),
    resource: args.resource.toUpperCase(),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/freezebalancev2",
    body,
    apiKey
  );
  if (res.Error) {
    throw new Error(`TronGrid freezebalancev2 failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid freezebalancev2 returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "freeze",
    from: args.from,
    frozenBalanceSun: amountSun,
    resource: args.resource,
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "freeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Freeze ${args.amount} TRX for ${args.resource} (Stake 2.0)`,
    decoded: {
      functionName: "FreezeBalanceV2Contract",
      args: { owner: args.from, amount: args.amount, resource: args.resource },
    },
  };
  return issueTronHandle(tx);
}

export interface BuildTronUnfreezeArgs {
  from: string;
  amount: string;
  resource: TronResource;
}

export async function buildTronUnfreeze(
  args: BuildTronUnfreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }
  const amountSun = parseUnits(args.amount, TRX_DECIMALS);
  if (amountSun <= 0n) {
    throw new Error(`Amount must be greater than 0 (got "${args.amount}").`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const body = {
    owner_address: args.from,
    unfreeze_balance: Number(amountSun),
    resource: args.resource.toUpperCase(),
    visible: true,
  };
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/unfreezebalancev2",
    body,
    apiKey
  );
  if (res.Error) {
    // Common failure: "less than frozen balance" when the caller asks to
    // unfreeze more than they've frozen for that resource type. Surface
    // TronGrid's message verbatim so the agent can relay it.
    throw new Error(`TronGrid unfreezebalancev2 failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid unfreezebalancev2 returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "unfreeze",
    from: args.from,
    unfreezeBalanceSun: amountSun,
    resource: args.resource,
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "unfreeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Unfreeze ${args.amount} TRX from ${args.resource} — 14-day unstaking cooldown begins`,
    decoded: {
      functionName: "UnfreezeBalanceV2Contract",
      args: { owner: args.from, amount: args.amount, resource: args.resource },
    },
  };
  return issueTronHandle(tx);
}

export interface BuildTronWithdrawExpireUnfreezeArgs {
  from: string;
}

export async function buildTronWithdrawExpireUnfreeze(
  args: BuildTronWithdrawExpireUnfreezeArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/withdrawexpireunfreeze",
    { owner_address: args.from, visible: true },
    apiKey
  );
  if (res.Error) {
    // Common: "no expire unfreeze" when no unfrozenV2 slices have matured.
    // Pair with get_tron_staking to check pendingUnfreezes[].unlockAt first.
    throw new Error(`TronGrid withdrawexpireunfreeze failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid withdrawexpireunfreeze returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "withdraw_expire_unfreeze",
    from: args.from,
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "withdraw_expire_unfreeze",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Withdraw all expired unfreezes back to liquid TRX for ${args.from}`,
    decoded: {
      functionName: "WithdrawExpireUnfreezeContract",
      args: { owner: args.from },
    },
  };
  return issueTronHandle(tx);
}

// ----- Claim voting rewards (WithdrawBalance) -----

export interface BuildTronClaimRewardsArgs {
  from: string;
}

export async function buildTronClaimRewards(
  args: BuildTronClaimRewardsArgs
): Promise<UnsignedTronTx> {
  if (!isTronAddress(args.from)) {
    throw new Error(`"from" is not a valid TRON mainnet address: ${args.from}`);
  }

  const apiKey = resolveTronApiKey(readUserConfig());
  const res = await trongridPost<TrongridDirectTx>(
    "/wallet/withdrawbalance",
    { owner_address: args.from, visible: true },
    apiKey
  );
  if (res.Error) {
    // Most common failure: TRON's 24h-between-claims rate limit. TronGrid
    // returns "WithdrawBalance not allowed, need 24 hours since last Withdraw"
    // without telling you when the cooldown expires. Read the account's
    // latest_withdraw_time and translate to "claim again in X hours Y min"
    // so the user doesn't have to guess.
    if (/24 hours since last Withdraw/i.test(res.Error)) {
      const remaining = await readClaimCooldownRemaining(args.from, apiKey).catch(
        () => null
      );
      if (remaining !== null) {
        throw new Error(
          `TRON claim cooldown active — last claim was less than 24h ago. ` +
            `Next claim available in ${formatDuration(remaining)}.`
        );
      }
    }
    throw new Error(`TronGrid withdrawbalance failed: ${res.Error}`);
  }
  if (!res.txID || !res.raw_data_hex) {
    throw new Error("TronGrid withdrawbalance returned no transaction — unexpected shape.");
  }

  assertTronRawDataMatches(res.raw_data_hex, {
    kind: "claim_rewards",
    from: args.from,
  });
  await assertBandwidthSufficient(args.from, res.raw_data_hex, apiKey);

  const tx: UnsignedTronTx = {
    chain: "tron",
    action: "claim_rewards",
    from: args.from,
    txID: res.txID,
    rawData: res.raw_data,
    rawDataHex: res.raw_data_hex,
    description: `Claim accumulated TRON voting rewards to ${args.from}`,
    decoded: {
      functionName: "WithdrawBalanceContract",
      args: { owner: args.from },
    },
  };
  return issueTronHandle(tx);
}
