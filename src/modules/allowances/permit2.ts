/**
 * Permit2 sub-allowance enumeration. Issue #304.
 *
 * Permit2 (Uniswap, deployed identically at the same address on every
 * supported EVM chain) is an intermediary: a wallet grants Permit2 a
 * single ERC-20 allowance via the standard `approve()`, then Permit2
 * maintains its OWN per-(owner, token, spender) allowance ledger
 * inside its own storage. When a downstream contract (Universal
 * Router, 1inch, a phishing site) gets authorized to pull tokens via
 * Permit2, the grant emits a Permit2 event — NOT the ERC-20 standard
 * `Approval` that `get_token_allowances`'s primary scan looks for.
 *
 * The result: a wallet that's used Uniswap once typically shows ONE
 * row in the primary scan ("Permit2 — unlimited"), and every actual
 * downstream attack surface is invisible. This module closes the gap
 * by re-running the same Etherscan-logs + Multicall3 pattern against
 * the Permit2 contract instead.
 *
 * Permit2 emits two relevant events:
 *
 *   event Approval(
 *     address indexed owner,
 *     address indexed token,
 *     address indexed spender,
 *     uint160 amount,
 *     uint48 expiration
 *   );
 *
 *   event Permit(
 *     address indexed owner,
 *     address indexed token,
 *     address indexed spender,
 *     uint160 amount,
 *     uint48 expiration,
 *     uint48 nonce
 *   );
 *
 * Both index `owner`, `token`, and `spender`. The Etherscan logs API
 * filter for our purposes is `topic1=owner, topic2=token`, no
 * topic0 (we want both Approval and Permit events). The downstream
 * spender lives in topic3.
 *
 * Live-allowance read:
 *
 *   function allowance(address user, address token, address spender)
 *     external view
 *     returns (uint160 amount, uint48 expiration, uint48 nonce);
 *
 * `expiration` is a Unix-seconds timestamp; allowances past their
 * expiration are functionally revoked even though the storage slot is
 * still populated. We drop expired rows to match the user's mental
 * model ("show me what someone could pull from me right now").
 */

import { etherscanV2Fetch } from "../../data/apis/etherscan-v2.js";
import { getClient } from "../../data/rpc.js";
import { CONTRACTS } from "../../config/contracts.js";
import { formatUnits } from "../../data/format.js";
import type { SupportedChain } from "../../types/index.js";

/**
 * Permit2 deployment address. The contract is deployed at this address
 * on every supported EVM chain (Ethereum, Arbitrum, Polygon, Base,
 * Optimism — and beyond). Lowercased here for direct case-insensitive
 * comparison against an event-topic-decoded spender.
 */
export const PERMIT2_ADDRESS =
  "0x000000000022d473030f116ddee9f6b43ac78ba3" as `0x${string}`;

/**
 * Topic0 hashes for the two Permit2 events we care about. These are
 * `keccak256(<canonical event signature>)` — recomputed in the test
 * suite as a guard against drift if Permit2 ever ships a v2 with
 * tweaked signatures (it hasn't, but the test catches it for free).
 */
export const PERMIT2_APPROVAL_TOPIC =
  "0xda9fa7c1b00402c17d0161b249b1ab8bbec047c5a52207b9c112deffd817036b" as const;
export const PERMIT2_PERMIT_TOPIC =
  "0xc6a377bfc4eb120024a8ac08eef205be16b817020812c73223e81d1bdb9708ec" as const;

/**
 * Permit2 ABI fragment for the live-allowance read. Pulled inline (not
 * promoted into `src/abis/`) because Permit2 is the only consumer in
 * this codebase and the surface is tiny.
 */
const PERMIT2_ABI = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "user", type: "address" },
      { name: "token", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [
      { name: "amount", type: "uint160" },
      { name: "expiration", type: "uint48" },
      { name: "nonce", type: "uint48" },
    ],
  },
] as const;

const UINT160_MAX = (1n << 160n) - 1n;
/**
 * Permit2 caps at uint160 (not uint256), so the unlimited threshold
 * differs from the primary tool's. Uniswap's own UI sets the literal
 * MAX_UINT160 for "unlimited"; others may cap a few hundred under it.
 * 0.01% margin matches the primary tool's posture.
 */
const PERMIT2_UNLIMITED_THRESHOLD = UINT160_MAX - UINT160_MAX / 10_000n;

/** One downstream spender that holds a non-zero, non-expired Permit2 sub-allowance. */
export interface Permit2SubAllowanceRow {
  /** The downstream contract authorized to pull `token` via Permit2. */
  downstreamSpender: `0x${string}`;
  /**
   * Friendly label when the downstream spender matches a known protocol
   * contract in the canonical CONTRACTS table (Uniswap V3 SwapRouter,
   * Universal Router, etc.). Absent for arbitrary contracts.
   */
  downstreamSpenderLabel?: string;
  /** Raw current allowance (uint160) as decimal string. */
  amount: string;
  /** Same value formatted with the token's decimals. */
  amountFormatted: string;
  /** True when amount is at-or-near `MAX_UINT160`. */
  isUnlimited: boolean;
  /**
   * Permit2's per-allowance expiration (uint48 unix seconds). When
   * `expiration === 0`, Permit2 treats the allowance as REQUIRING a
   * fresh signature — the on-chain allowance is unusable on its own
   * and we drop the row. When `expiration > 0` and ≤ now, the
   * allowance has expired and is dropped. Surviving rows have
   * `expiration > now`; we surface the ISO timestamp.
   */
  expirationIso: string;
  /** Block number where the most recent Permit2 event for this triple landed. */
  lastEventBlock: string;
  /** Tx hash of that event. */
  lastEventTxHash: `0x${string}`;
  /** ISO timestamp from the indexer's `timeStamp` field, when available. */
  lastEventAt?: string;
}

interface EtherscanLogRow {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  timeStamp?: string;
  transactionHash: string;
}

function addressToTopic(addr: `0x${string}`): string {
  return `0x000000000000000000000000${addr.slice(2).toLowerCase()}`;
}

const LOGS_PAGE_SIZE = 1000;

/**
 * Fetch every Permit2 Approval + Permit event filtered to (owner,
 * token). Both event types index those fields at topic1 and topic2,
 * so a single Etherscan logs call (no topic0 filter) catches both —
 * we partition by topic0 client-side. The downstream spender is at
 * topic3 in both events.
 */
async function fetchPermit2Logs(
  chain: SupportedChain,
  owner: `0x${string}`,
  token: `0x${string}`,
): Promise<{ logs: EtherscanLogRow[]; truncated: boolean }> {
  const params: Record<string, string> = {
    module: "logs",
    action: "getLogs",
    address: PERMIT2_ADDRESS,
    topic1: addressToTopic(owner),
    topic2: addressToTopic(token),
    topic1_2_opr: "and",
    fromBlock: "0",
    toBlock: "latest",
    page: "1",
    offset: String(LOGS_PAGE_SIZE),
  };
  const logs = await etherscanV2Fetch<EtherscanLogRow>(chain, params);
  return { logs, truncated: logs.length >= LOGS_PAGE_SIZE };
}

/**
 * Resolve a friendly label for a downstream spender from the
 * `CONTRACTS` table on the given chain. Mirrors the primary tool's
 * label resolution so the read surfaces consistent names across both
 * direct and via-Permit2 rows.
 */
function lookupKnownSpender(
  chain: SupportedChain,
  spender: `0x${string}`,
): string | undefined {
  const c = CONTRACTS[chain] as Record<string, Record<string, string>> | undefined;
  if (!c) return undefined;
  const target = spender.toLowerCase();
  for (const [protocol, addrs] of Object.entries(c)) {
    if (protocol === "tokens") continue;
    if (typeof addrs !== "object" || addrs === null) continue;
    for (const [name, addr] of Object.entries(addrs)) {
      if (typeof addr !== "string" || addr.toLowerCase() !== target) continue;
      let protoLabel: string;
      switch (protocol) {
        case "aave": protoLabel = "Aave V3"; break;
        case "uniswap": protoLabel = "Uniswap V3"; break;
        case "lido": protoLabel = "Lido"; break;
        case "eigenlayer": protoLabel = "EigenLayer"; break;
        case "compound": protoLabel = "Compound V3"; break;
        case "morpho": protoLabel = "Morpho Blue"; break;
        default: protoLabel = protocol.charAt(0).toUpperCase() + protocol.slice(1);
      }
      const niceName = name.charAt(0).toUpperCase() + name.slice(1);
      return `${protoLabel} ${niceName}`;
    }
  }
  return undefined;
}

export interface FetchPermit2SubAllowancesResult {
  rows: Permit2SubAllowanceRow[];
  /** Distinct downstream spenders observed in events (including ones now expired or revoked). */
  totalScanned: number;
  truncated: boolean;
  /** Sub-allowances that read non-zero on-chain but have expired (now ≥ expiration). */
  expiredCount: number;
  /** Sub-allowances at-or-near MAX_UINT160 — unlimited within Permit2's per-spender ledger. */
  unlimitedCount: number;
}

/**
 * Enumerate downstream spenders authorized via Permit2 for the
 * (owner, token) pair. Pipeline mirrors the primary tool:
 *
 *   1. Pull Approval + Permit events from Permit2 via Etherscan logs,
 *      filtered to (owner, token). Single call covers full history.
 *   2. Dedup by downstream spender, keeping the latest event per
 *      spender for provenance.
 *   3. Multicall3 batched `Permit2.allowance(owner, token, spender)`
 *      reads for each unique downstream → live (amount, expiration,
 *      nonce) tuple.
 *   4. Drop rows where `amount === 0` (revoked) OR `expiration === 0`
 *      (Permit2 treats this as "fresh signature required") OR
 *      `expiration ≤ now` (expired).
 *   5. Resolve friendly labels for known protocol contracts.
 *   6. Sort descending by amount.
 */
export async function fetchPermit2SubAllowances(args: {
  chain: SupportedChain;
  owner: `0x${string}`;
  token: `0x${string}`;
  decimals: number;
}): Promise<FetchPermit2SubAllowancesResult> {
  const { chain, owner, token, decimals } = args;

  const { logs, truncated } = await fetchPermit2Logs(chain, owner, token);

  // Dedup by downstream spender, keeping the latest event per spender.
  // Etherscan returns oldest-first; iterating forward and overwriting
  // yields "latest wins".
  interface SeenLog {
    downstreamSpender: `0x${string}`;
    blockNumber: string;
    txHash: `0x${string}`;
    timeStamp?: string;
  }
  const lastBySpender = new Map<string, SeenLog>();
  for (const log of logs) {
    if (!log.topics || log.topics.length < 4) continue;
    const topic0 = log.topics[0]?.toLowerCase();
    if (
      topic0 !== PERMIT2_APPROVAL_TOPIC.toLowerCase() &&
      topic0 !== PERMIT2_PERMIT_TOPIC.toLowerCase()
    ) {
      continue;
    }
    const spenderTopic = log.topics[3];
    if (!spenderTopic || spenderTopic.length < 42) continue;
    const downstreamSpender = `0x${spenderTopic.slice(-40)}` as `0x${string}`;
    lastBySpender.set(downstreamSpender, {
      downstreamSpender,
      blockNumber: log.blockNumber,
      txHash: log.transactionHash as `0x${string}`,
      ...(log.timeStamp ? { timeStamp: log.timeStamp } : {}),
    });
  }

  const uniqueSpenders = Array.from(lastBySpender.values()).map(
    (s) => s.downstreamSpender,
  );

  if (uniqueSpenders.length === 0) {
    return {
      rows: [],
      totalScanned: 0,
      truncated,
      expiredCount: 0,
      unlimitedCount: 0,
    };
  }

  const client = getClient(chain);
  const allowances = await client.multicall({
    contracts: uniqueSpenders.map((spender) => ({
      address: PERMIT2_ADDRESS,
      abi: PERMIT2_ABI,
      functionName: "allowance" as const,
      args: [owner, token, spender] as const,
    })),
    allowFailure: true,
  });

  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const rows: Permit2SubAllowanceRow[] = [];
  let expiredCount = 0;
  let unlimitedCount = 0;
  for (let i = 0; i < uniqueSpenders.length; i++) {
    const r = allowances[i];
    if (r.status !== "success") continue;
    // viem returns the struct as a tuple; cast.
    const tuple = r.result as readonly [bigint, number, number];
    const amount = tuple[0];
    const expiration = BigInt(tuple[1]);
    if (amount === 0n) continue; // revoked / fully consumed
    if (expiration === 0n) continue; // Permit2 marker for "fresh signature required"
    if (expiration <= nowSec) {
      expiredCount += 1;
      continue;
    }
    const downstreamSpender = uniqueSpenders[i];
    const meta = lastBySpender.get(downstreamSpender)!;
    const isUnlimited = amount >= PERMIT2_UNLIMITED_THRESHOLD;
    if (isUnlimited) unlimitedCount += 1;
    const label = lookupKnownSpender(chain, downstreamSpender);
    const lastEventAt = meta.timeStamp
      ? new Date(Number(meta.timeStamp) * 1000).toISOString()
      : undefined;
    rows.push({
      downstreamSpender,
      ...(label ? { downstreamSpenderLabel: label } : {}),
      amount: amount.toString(),
      amountFormatted: isUnlimited ? "unlimited" : formatUnits(amount, decimals),
      isUnlimited,
      expirationIso: new Date(Number(expiration) * 1000).toISOString(),
      lastEventBlock: meta.blockNumber,
      lastEventTxHash: meta.txHash,
      ...(lastEventAt ? { lastEventAt } : {}),
    });
  }

  rows.sort((a, b) => {
    const aBig = BigInt(a.amount);
    const bBig = BigInt(b.amount);
    if (bBig > aBig) return 1;
    if (bBig < aBig) return -1;
    return 0;
  });

  return {
    rows,
    totalScanned: lastBySpender.size,
    truncated,
    expiredCount,
    unlimitedCount,
  };
}
