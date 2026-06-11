/**
 * EVM `explain_tx` implementation.
 *
 * One round-trip per concern:
 *   - `eth_getTransactionByHash` — input calldata, value, from, to.
 *   - `eth_getTransactionReceipt` — status, gasUsed, logs, blockNumber.
 *   - `eth_getBlock(receipt.blockNumber)` — block timestamp.
 *   - 4byte resolver — top-level method name.
 *   - DefiLlama price lookup for fee + balance-change USD valuations
 *     (current-spot, NOT historical — matches what the agent surfaces
 *     for fresh txs and is good enough for "did I lose money on gas?").
 *
 * Logs are decoded for two specific events: ERC-20 / ERC-721 `Transfer`
 * (`0xddf252...`) and ERC-20 `Approval` (`0x8c5be1...`). The decoded
 * data feeds `balanceChanges` (filtered to the wallet of interest) and
 * `approvalChanges`. ERC-721 transfers ARE detected (Transfer with 4
 * topics including tokenId) but reported as "1 NFT moved" rather than
 * an integer delta, since the qty is always 1 and the tokenId is what
 * matters — surfaced in the step detail.
 */

import { decodeEventLog, type Hex, type Log } from "viem";
import { erc20Abi } from "../../../abis/erc20.js";
import { getClient } from "../../../data/rpc.js";
import { resolveSelectors } from "../../history/decode.js";
import { decodeCallArgs } from "../decode-call.js";
import { getTokenPrice } from "../../../data/prices.js";
import { NATIVE_SYMBOL } from "../../../config/contracts.js";
import { formatUnits } from "../../../data/format.js";
import type { SupportedChain } from "../../../types/index.js";
import type {
  ExplainTxApprovalChange,
  ExplainTxBalanceChange,
  ExplainTxResult,
  ExplainTxStep,
} from "../schemas.js";

const TRANSFER_TOPIC =
  "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const APPROVAL_TOPIC =
  "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const MAX_UINT256 = (1n << 256n) - 1n;
/**
 * Threshold above which an approval is considered "unlimited" for
 * heuristic purposes. Many wallets cap at MAX_UINT256 / 2 - 1 (signed)
 * or other near-MAX values; treat anything within 0.01% of MAX as
 * effectively unlimited.
 */
const UNLIMITED_THRESHOLD = MAX_UINT256 - MAX_UINT256 / 10_000n;

/** Fetch ERC-20 metadata (symbol + decimals) for a contract. Tolerant — null on failure. */
async function fetchTokenMeta(
  chain: SupportedChain,
  address: `0x${string}`,
): Promise<{ symbol: string; decimals: number } | null> {
  const client = getClient(chain);
  try {
    const [symbol, decimals] = await Promise.all([
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "symbol",
      }) as Promise<string>,
      client.readContract({
        address,
        abi: erc20Abi,
        functionName: "decimals",
      }) as Promise<number>,
    ]);
    return { symbol, decimals: Number(decimals) };
  } catch {
    return null;
  }
}

interface DecodedTransfer {
  contract: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: bigint;
  /** True if this was a 4-topic Transfer (ERC-721 / ERC-1155 single). */
  isNft: boolean;
  /** ERC-721 token id when `isNft`. */
  tokenId?: bigint;
}

interface DecodedApproval {
  contract: `0x${string}`;
  owner: `0x${string}`;
  spender: `0x${string}`;
  value: bigint;
}

function decodeTransferLog(log: Log): DecodedTransfer | null {
  const topics = log.topics as readonly Hex[];
  if (topics.length < 3) return null;
  if (topics[0]?.toLowerCase() !== TRANSFER_TOPIC) return null;
  // ERC-20: 3 topics (event sig + from + to), data = value.
  // ERC-721: 4 topics (event sig + from + to + tokenId), data = empty.
  const from = `0x${topics[1].slice(26)}` as `0x${string}`;
  const to = `0x${topics[2].slice(26)}` as `0x${string}`;
  if (topics.length === 4) {
    const tokenId = BigInt(topics[3]);
    return {
      contract: log.address as `0x${string}`,
      from,
      to,
      value: 1n,
      isNft: true,
      tokenId,
    };
  }
  if (topics.length === 3) {
    const data = log.data as Hex;
    if (data.length !== 66) return null; // 0x + 64 hex
    const value = BigInt(data);
    return {
      contract: log.address as `0x${string}`,
      from,
      to,
      value,
      isNft: false,
    };
  }
  return null;
}

function decodeApprovalLog(log: Log): DecodedApproval | null {
  const topics = log.topics as readonly Hex[];
  if (topics.length !== 3) return null;
  if (topics[0]?.toLowerCase() !== APPROVAL_TOPIC) return null;
  const data = log.data as Hex;
  if (data.length !== 66) return null;
  const owner = `0x${topics[1].slice(26)}` as `0x${string}`;
  const spender = `0x${topics[2].slice(26)}` as `0x${string}`;
  const value = BigInt(data);
  return {
    contract: log.address as `0x${string}`,
    owner,
    spender,
    value,
  };
}

export interface EvmPostmortemArgs {
  chain: SupportedChain;
  hash: `0x${string}`;
  /** Wallet to compute balance-changes from. Defaults to tx sender. */
  perspective?: `0x${string}`;
}

export async function evmPostmortem(
  args: EvmPostmortemArgs,
): Promise<Omit<ExplainTxResult, "narrative" | "summary"> & { summary: string }> {
  const client = getClient(args.chain);

  let tx;
  let receipt;
  try {
    [tx, receipt] = await Promise.all([
      client.getTransaction({ hash: args.hash }),
      client.getTransactionReceipt({ hash: args.hash }),
    ]);
  } catch (e) {
    throw new Error(
      `Could not fetch tx ${args.hash} on ${args.chain}: ` +
        (e as Error).message,
    );
  }

  const blockTimeIso = await client
    .getBlock({ blockNumber: receipt.blockNumber })
    .then((b) => new Date(Number(b.timestamp) * 1000).toISOString())
    .catch(() => undefined);

  const sender = tx.from as `0x${string}`;
  const perspective = (args.perspective ?? sender).toLowerCase() as `0x${string}`;
  const status: "success" | "failed" =
    receipt.status === "success" ? "success" : "failed";

  // Decode top-level method, when there's calldata. Two parallel
  // requests against 4byte: `resolveSelectors` for the cached method
  // name + ambiguity flag we use in step labels and the summary, and
  // `decodeCallArgs` for the full lossless arg decode surfaced under
  // `decodedCall`. Both sit on the same 24h cache so a repeat call on
  // the same selector pays one HTTP round-trip total.
  const input = (tx.input ?? "0x") as Hex;
  const selector = input.length >= 10 ? input.slice(0, 10).toLowerCase() : null;
  let methodName: string | undefined;
  let methodAmbiguous = false;
  let decodedCall: Awaited<ReturnType<typeof decodeCallArgs>> = undefined;
  if (selector) {
    const [resolved, decoded] = await Promise.all([
      resolveSelectors([selector]),
      decodeCallArgs(input),
    ]);
    const r = resolved.get(selector);
    methodName = r?.methodName;
    methodAmbiguous = r?.ambiguous ?? false;
    decodedCall = decoded;
  }

  // Decode logs.
  const transfers: DecodedTransfer[] = [];
  const approvals: DecodedApproval[] = [];
  for (const log of receipt.logs as Log[]) {
    const t = decodeTransferLog(log);
    if (t) {
      transfers.push(t);
      continue;
    }
    const a = decodeApprovalLog(log);
    if (a) approvals.push(a);
  }

  // Pull token metadata for each unique contract we saw.
  const uniqueContracts = Array.from(
    new Set(
      [...transfers.map((t) => t.contract), ...approvals.map((a) => a.contract)].map(
        (a) => a.toLowerCase() as `0x${string}`,
      ),
    ),
  );
  const metaByContract = new Map<string, { symbol: string; decimals: number }>();
  await Promise.all(
    uniqueContracts.map(async (c) => {
      const m = await fetchTokenMeta(args.chain, c);
      if (m) metaByContract.set(c, m);
    }),
  );

  // Build ordered steps. Native value transfer (when non-zero) +
  // top-level call + decoded events. Order in chat surface: native
  // first (the most user-visible thing), then call, then events.
  const steps: ExplainTxStep[] = [];
  if (tx.value > 0n) {
    steps.push({
      kind: "native_transfer",
      label: NATIVE_SYMBOL[args.chain],
      detail: `${formatUnits(tx.value, 18)} ${NATIVE_SYMBOL[args.chain]} from ${tx.from} to ${tx.to ?? "(contract creation)"}`,
      ...(tx.to ? { programOrContract: tx.to } : {}),
    });
  }
  if (tx.to && (input === "0x" || input.length < 10)) {
    if (tx.value === 0n) {
      steps.push({
        kind: "call",
        label: "fallback",
        detail: `Plain call to ${tx.to} with no calldata.`,
        programOrContract: tx.to,
      });
    }
  } else if (tx.to) {
    steps.push({
      kind: "call",
      label: methodName
        ? methodAmbiguous
          ? `${methodName} (ambiguous selector)`
          : methodName
        : `selector ${selector ?? "(none)"}`,
      detail: methodName
        ? `Top-level call: ${tx.to}.${methodName}`
        : `Top-level call to ${tx.to}; method selector ${selector} did not resolve.`,
      programOrContract: tx.to,
    });
  } else if (input !== "0x") {
    steps.push({
      kind: "call",
      label: "create",
      detail: `Contract creation tx; ${input.length / 2 - 1} bytes of init code.`,
    });
  }
  for (const t of transfers) {
    const meta = metaByContract.get(t.contract.toLowerCase());
    if (t.isNft) {
      steps.push({
        kind: "event",
        label: "Transfer (NFT)",
        detail: `1 NFT (token id ${t.tokenId?.toString()}) from ${t.from} to ${t.to}`,
        programOrContract: t.contract,
      });
    } else {
      const symbol = meta?.symbol ?? "TOKEN";
      const formatted = meta
        ? formatUnits(t.value, meta.decimals)
        : t.value.toString();
      steps.push({
        kind: "event",
        label: "Transfer",
        detail: `${formatted} ${symbol} from ${t.from} to ${t.to}`,
        programOrContract: t.contract,
      });
    }
  }
  for (const a of approvals) {
    const meta = metaByContract.get(a.contract.toLowerCase());
    const symbol = meta?.symbol ?? "TOKEN";
    const isUnlimited = a.value >= UNLIMITED_THRESHOLD;
    const allowanceStr = isUnlimited
      ? "unlimited"
      : meta
        ? formatUnits(a.value, meta.decimals)
        : a.value.toString();
    steps.push({
      kind: "event",
      label: "Approval",
      detail: `${a.owner} grants ${a.spender} an allowance of ${allowanceStr} ${symbol}`,
      programOrContract: a.contract,
    });
  }

  // Per-token balance deltas FROM PERSPECTIVE.
  const balanceDeltas = new Map<
    string,
    { delta: bigint; symbol: string; decimals: number }
  >();
  // Native delta from value (signed by perspective).
  let nativeDelta = 0n;
  if (tx.value > 0n) {
    if ((tx.from as string).toLowerCase() === perspective) {
      nativeDelta -= tx.value;
    }
    if (tx.to && (tx.to as string).toLowerCase() === perspective) {
      nativeDelta += tx.value;
    }
  }
  if (nativeDelta !== 0n) {
    balanceDeltas.set("native", {
      delta: nativeDelta,
      symbol: NATIVE_SYMBOL[args.chain],
      decimals: 18,
    });
  }
  for (const t of transfers) {
    if (t.isNft) continue; // not a fungible delta
    const meta = metaByContract.get(t.contract.toLowerCase()) ?? {
      symbol: "TOKEN",
      decimals: 18,
    };
    const isFrom = (t.from as string).toLowerCase() === perspective;
    const isTo = (t.to as string).toLowerCase() === perspective;
    if (!isFrom && !isTo) continue;
    const key = t.contract.toLowerCase();
    const prev = balanceDeltas.get(key) ?? {
      delta: 0n,
      symbol: meta.symbol,
      decimals: meta.decimals,
    };
    prev.delta += isTo ? t.value : 0n;
    prev.delta -= isFrom ? t.value : 0n;
    balanceDeltas.set(key, prev);
  }

  // Price lookups for native + each tokenized delta. Spot, not
  // historical — see file docstring.
  const balanceChanges: ExplainTxBalanceChange[] = [];
  for (const [token, info] of balanceDeltas) {
    const formatted = formatUnits(info.delta, info.decimals);
    const num = Number(formatted);
    const priceUsd = await getTokenPrice(
      args.chain,
      token === "native" ? "native" : (token as `0x${string}`),
    ).catch(() => undefined);
    balanceChanges.push({
      symbol: info.symbol,
      token,
      delta: formatted,
      deltaApprox: num,
      ...(priceUsd !== undefined && Number.isFinite(num)
        ? { valueUsd: round2(num * priceUsd) }
        : {}),
    });
  }

  // Approval changes from perspective (only when wallet is the owner).
  const approvalChanges: ExplainTxApprovalChange[] = [];
  for (const a of approvals) {
    if ((a.owner as string).toLowerCase() !== perspective) continue;
    const meta = metaByContract.get(a.contract.toLowerCase());
    const isUnlimited = a.value >= UNLIMITED_THRESHOLD;
    const newAllowance = isUnlimited
      ? "unlimited"
      : meta
        ? formatUnits(a.value, meta.decimals)
        : a.value.toString();
    approvalChanges.push({
      ...(meta?.symbol ? { symbol: meta.symbol } : {}),
      token: a.contract.toLowerCase(),
      spender: a.spender,
      newAllowance,
      isUnlimited,
    });
  }

  // Fee.
  const gasUsed = receipt.gasUsed;
  const effectiveGasPrice = receipt.effectiveGasPrice ?? 0n;
  const feeWei = gasUsed * effectiveGasPrice;
  const feeNative = formatUnits(feeWei, 18);
  let feeUsd: number | undefined;
  const nativePrice = await getTokenPrice(args.chain, "native").catch(
    () => undefined,
  );
  if (nativePrice !== undefined) {
    feeUsd = round2(Number(feeNative) * nativePrice);
  }
  // The sender always pays the fee, so when perspective === sender,
  // subtract it from the native delta. This makes "what did I net" math
  // reflect gas costs.
  if (perspective === sender.toLowerCase()) {
    const existing = balanceChanges.find((b) => b.token === "native");
    if (existing) {
      // Recompute from raw nativeDelta + feeWei to avoid float-precision drift.
      const combined = nativeDelta - feeWei;
      existing.delta = formatUnits(combined, 18);
      existing.deltaApprox = Number(existing.delta);
      if (nativePrice !== undefined && Number.isFinite(existing.deltaApprox)) {
        existing.valueUsd = round2(existing.deltaApprox * nativePrice);
      }
    } else {
      const combined = -feeWei;
      const formattedCombined = formatUnits(combined, 18);
      const num = Number(formattedCombined);
      balanceChanges.push({
        symbol: NATIVE_SYMBOL[args.chain],
        token: "native",
        delta: formattedCombined,
        deltaApprox: num,
        ...(nativePrice !== undefined && Number.isFinite(num)
          ? { valueUsd: round2(num * nativePrice) }
          : {}),
      });
    }
  }

  // One-sentence summary.
  let summary: string;
  if (status === "failed") {
    summary = `Transaction REVERTED on ${args.chain}. Gas was paid (${feeNative} ${NATIVE_SYMBOL[args.chain]}); no state changes took effect.`;
  } else if (methodName) {
    summary = `Top-level ${methodName} call on ${args.chain}; ${transfers.length} transfer event(s), ${approvals.length} approval(s).`;
  } else if (tx.value > 0n) {
    summary = `${formatUnits(tx.value, 18)} ${NATIVE_SYMBOL[args.chain]} sent to ${tx.to ?? "(contract creation)"} on ${args.chain}.`;
  } else if (input === "0x") {
    summary = `Empty self-call (no value, no calldata) — likely a noop or wallet probe on ${args.chain}.`;
  } else {
    summary = `Top-level contract call on ${args.chain}; selector ${selector ?? "(none)"} did not resolve.`;
  }

  return {
    chain: args.chain,
    hash: args.hash,
    from: sender,
    ...(tx.to ? { to: tx.to } : {}),
    perspective,
    blockNumber: receipt.blockNumber.toString(),
    ...(blockTimeIso ? { blockTimeIso } : {}),
    status,
    feeNative,
    feeNativeSymbol: NATIVE_SYMBOL[args.chain],
    ...(feeUsd !== undefined ? { feeUsd } : {}),
    summary,
    steps,
    balanceChanges,
    approvalChanges,
    heuristics: [],
    notes: [],
    rawInput: input,
    ...(decodedCall ? { decodedCall } : {}),
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
