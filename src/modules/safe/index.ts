import { getAddress, getContract } from "viem";
import { getSafeApiKit, type SafeServiceMultisigTx } from "./sdk.js";
import { getClient } from "../../data/rpc.js";
import { gnosisSafeAbi } from "../../abis/access-control.js";
import { getTokenBalance } from "../balances/index.js";
import type { SupportedChain, TokenAmount } from "../../types/index.js";
import type { GetSafePositionsArgs } from "./schemas.js";

/**
 * Compact summary of one Safe pending or recently-executed transaction. The
 * Safe Transaction Service returns a fat record per tx (~30 fields, decoded
 * calldata, paginated confirmation list); we surface the load-bearing fields
 * for an agent and let callers fetch the full record by `safeTxHash` if they
 * need calldata-level detail.
 */
export interface SafeTxSummary {
  safeTxHash: string;
  nonce: number;
  to: string;
  value: string;
  /** True when the call carries calldata (i.e. is a contract call, not a plain transfer). */
  hasData: boolean;
  /** 0 = CALL, 1 = DELEGATECALL. DELEGATECALL is high-risk; agents should flag it loudly. */
  operation: number;
  confirmations: number;
  confirmationsRequired: number;
  proposer: string | null;
  submissionDate: string;
  /** Only set for executed txs — the on-chain transaction hash. */
  executionTxHash?: string;
  /** Only set for executed txs — date the multisig tx landed on-chain. */
  executionDate?: string;
}

/** Result for a single Safe — one entry in the response list. */
export interface SafeAccount {
  address: `0x${string}`;
  chain: SupportedChain;
  /** Safe contract version (e.g. "1.4.1"). Useful for compat checks. */
  version: string;
  threshold: number;
  owners: `0x${string}`[];
  /** Native coin balance on this chain. ERC20 balances are not enumerated here — query `get_token_balance` per token. */
  nativeBalance: TokenAmount;
  /** Number of Safe Modules currently enabled. >0 is a notable risk surface — modules can bypass owner consent. */
  moduleCount: number;
  /** True when a Safe Guard is configured (extra checks on every tx). */
  hasGuard: boolean;
  pendingTxs: SafeTxSummary[];
  /** Most-recent first; capped at `RECENT_EXECUTED_LIMIT`. */
  recentExecutedTxs: SafeTxSummary[];
  /** Plain-English risk notes derived from the config above. Empty array when nothing notable. */
  riskNotes: string[];
}

export interface GetSafePositionsResult {
  /** What the caller asked about, echoed back so multi-Safe responses are easy to match up. */
  query: {
    signerAddress?: `0x${string}`;
    safeAddress?: `0x${string}`;
    chains: SupportedChain[];
  };
  safes: SafeAccount[];
  /**
   * Per-chain coverage. `errored: true` means the Safe Transaction Service
   * call failed for that chain (network, auth, or upstream error). Mirrors
   * the `coverage` shape used by `get_portfolio_summary` so agents can
   * distinguish "no Safes here" from "fetch failed".
   */
  coverage: Array<{ chain: SupportedChain; errored: boolean; error?: string }>;
}

/**
 * Cap on `recentExecutedTxs`. Five is enough for "what did this Safe do
 * recently" without ballooning the response payload — the tx-service paginates
 * at 100/page, but agents almost never need more than the most recent few.
 */
const RECENT_EXECUTED_LIMIT = 5;

/**
 * Cap on `pendingTxs`. Pending is usually 0–3 txs in real treasuries; setting
 * the limit at 20 leaves headroom for the rare DAO with a queue without
 * producing a 200-item dump.
 */
const PENDING_LIMIT = 20;

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

function summarizeTx(tx: SafeServiceMultisigTx): SafeTxSummary {
  const summary: SafeTxSummary = {
    safeTxHash: tx.safeTxHash,
    nonce: Number(tx.nonce),
    to: tx.to,
    value: tx.value,
    hasData: !!tx.data && tx.data !== "0x",
    operation: tx.operation,
    confirmations: tx.confirmations?.length ?? 0,
    confirmationsRequired: tx.confirmationsRequired,
    proposer: tx.proposer,
    submissionDate: tx.submissionDate,
  };
  if (tx.isExecuted && tx.transactionHash) {
    summary.executionTxHash = tx.transactionHash;
  }
  if (tx.isExecuted && tx.executionDate) {
    summary.executionDate = tx.executionDate;
  }
  return summary;
}

function deriveRiskNotes(safe: {
  threshold: number;
  owners: string[];
  moduleCount: number;
  hasGuard: boolean;
}): string[] {
  const notes: string[] = [];
  if (safe.threshold === 1) {
    notes.push(
      "Threshold is 1 — this Safe is signed by any single owner, equivalent to an EOA in terms of multisig protection.",
    );
  }
  if (safe.threshold > 1 && safe.threshold === safe.owners.length) {
    notes.push(
      `Threshold equals owner count (${safe.threshold}/${safe.owners.length}) — losing any single owner permanently locks the Safe.`,
    );
  }
  if (safe.moduleCount > 0) {
    notes.push(
      `${safe.moduleCount} Safe Module(s) enabled — modules can move funds without owner signatures. Verify each one before trusting this Safe.`,
    );
  }
  if (safe.hasGuard) {
    // Guards can be either a SAFER posture (e.g. one that blocks DELEGATECALL)
    // or a brick risk (a malicious guard rejects every legit tx). We just flag
    // the presence and let the user investigate the guard contract.
    notes.push(
      "A Safe Guard is configured — every tx goes through extra checks. Verify the guard contract before relying on this Safe.",
    );
  }
  return notes;
}

/**
 * Read on-chain Safe state directly. `getSafeInfo` from the tx-service
 * already exposes threshold/owners/version, so this is currently a fallback
 * path; we keep it because the on-chain reads are the source of truth and
 * v2/v3 will need to compute the next nonce locally without round-tripping
 * through the tx-service.
 */
async function readSafeOnChain(
  chain: SupportedChain,
  address: `0x${string}`,
): Promise<{ threshold: number; owners: `0x${string}`[]; version: string }> {
  const client = getClient(chain);
  const safe = getContract({
    address,
    abi: [
      ...gnosisSafeAbi,
      {
        type: "function",
        name: "VERSION",
        stateMutability: "view",
        inputs: [],
        outputs: [{ type: "string" }],
      },
    ] as const,
    client,
  });
  const [threshold, owners, version] = await Promise.all([
    safe.read.getThreshold() as Promise<bigint>,
    safe.read.getOwners() as Promise<readonly `0x${string}`[]>,
    safe.read.VERSION() as Promise<string>,
  ]);
  return { threshold: Number(threshold), owners: [...owners], version };
}

/**
 * Fetch one Safe's full state (config + balance + tx queue) on a given chain.
 * Splits the work between the Safe Transaction Service (config, tx queue) and
 * direct RPC (native balance) so a tx-service hiccup doesn't block balance
 * reads and vice-versa.
 */
async function loadSafe(
  chain: SupportedChain,
  safeAddress: `0x${string}`,
): Promise<SafeAccount> {
  const kit = getSafeApiKit(chain);

  const [info, pending, executed, nativeBalance] = await Promise.all([
    kit.getSafeInfo(safeAddress),
    kit.getPendingTransactions(safeAddress, { limit: PENDING_LIMIT }),
    kit.getMultisigTransactions(safeAddress, { executed: true, limit: RECENT_EXECUTED_LIMIT }),
    getTokenBalance({ wallet: safeAddress, token: "native", chain }) as Promise<TokenAmount>,
  ]);

  const moduleCount = info.modules?.length ?? 0;
  const hasGuard = !!info.guard && info.guard.toLowerCase() !== ZERO_ADDRESS;
  const owners = info.owners.map((o: string) => getAddress(o) as `0x${string}`);

  return {
    address: getAddress(safeAddress) as `0x${string}`,
    chain,
    version: info.version,
    threshold: info.threshold,
    owners,
    nativeBalance,
    moduleCount,
    hasGuard,
    pendingTxs: pending.results.map(summarizeTx),
    recentExecutedTxs: executed.results.map(summarizeTx),
    riskNotes: deriveRiskNotes({
      threshold: info.threshold,
      owners,
      moduleCount,
      hasGuard,
    }),
  };
}

/**
 * Discover all Safes a given owner is a signer on, then load each one in
 * parallel. Per-Safe failures are surfaced via `coverage` rather than tanking
 * the whole call — losing one Safe to a transient tx-service blip shouldn't
 * black out the user's view of their other Safes.
 */
async function loadSafesForOwner(
  chain: SupportedChain,
  ownerAddress: `0x${string}`,
): Promise<{ safes: SafeAccount[]; perSafeErrors: string[] }> {
  const kit = getSafeApiKit(chain);
  const { safes: safeAddresses } = await kit.getSafesByOwner(ownerAddress);
  const perSafeErrors: string[] = [];
  const settled = await Promise.allSettled(
    safeAddresses.map((addr: string) =>
      loadSafe(chain, getAddress(addr) as `0x${string}`),
    ),
  );
  const safes: SafeAccount[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled") {
      safes.push(r.value);
    } else {
      const reason = r.reason instanceof Error ? r.reason.message : String(r.reason);
      perSafeErrors.push(`${safeAddresses[i]}: ${reason}`);
    }
  });
  return { safes, perSafeErrors };
}

/**
 * Top-level handler for `get_safe_positions`. Discovery rules:
 *
 *  - At least one of `signerAddress` / `safeAddress` must be supplied.
 *  - When both are supplied, results union (`safeAddress` is loaded directly
 *    on every requested chain, plus all Safes the signer is on per chain),
 *    de-duplicated by `chain:address`.
 *  - `chains` defaults to `["ethereum"]` (see schema rationale).
 *
 * The handler never throws on a single-chain failure — those land in
 * `coverage[i].errored`. It DOES throw `SafeApiKeyMissingError` synchronously
 * when SAFE_API_KEY is unset, since the request can't proceed at all.
 */
export async function getSafePositions(
  args: GetSafePositionsArgs,
): Promise<GetSafePositionsResult> {
  if (!args.signerAddress && !args.safeAddress) {
    throw new Error("Provide at least one of `signerAddress` or `safeAddress`.");
  }
  const chains: SupportedChain[] = (args.chains as SupportedChain[] | undefined) ?? ["ethereum"];
  const signerAddress = args.signerAddress ? (getAddress(args.signerAddress) as `0x${string}`) : undefined;
  const safeAddress = args.safeAddress ? (getAddress(args.safeAddress) as `0x${string}`) : undefined;

  const coverage: GetSafePositionsResult["coverage"] = [];
  // Map keyed by `${chain}:${address}` to dedupe when a direct safeAddress
  // also shows up under signerAddress's owner-list.
  const collected = new Map<string, SafeAccount>();

  await Promise.all(
    chains.map(async (chain) => {
      try {
        const tasks: Promise<unknown>[] = [];
        if (safeAddress) {
          tasks.push(
            loadSafe(chain, safeAddress).then((s) => {
              collected.set(`${chain}:${s.address.toLowerCase()}`, s);
            }),
          );
        }
        if (signerAddress) {
          tasks.push(
            loadSafesForOwner(chain, signerAddress).then(({ safes, perSafeErrors }) => {
              for (const s of safes) {
                collected.set(`${chain}:${s.address.toLowerCase()}`, s);
              }
              if (perSafeErrors.length > 0) {
                // Surface partial failure as an error string on coverage —
                // the safes that DID load are still in `collected`.
                coverage.push({
                  chain,
                  errored: true,
                  error: `partial failure: ${perSafeErrors.join("; ")}`,
                });
              }
            }),
          );
        }
        await Promise.all(tasks);
        if (!coverage.some((c) => c.chain === chain)) {
          coverage.push({ chain, errored: false });
        }
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        coverage.push({ chain, errored: true, error: message });
      }
    }),
  );

  // Stable ordering: chain first (in user-supplied order), then address.
  const chainOrder = new Map(chains.map((c, i) => [c, i]));
  const safes = [...collected.values()].sort((a, b) => {
    const ci = (chainOrder.get(a.chain) ?? 0) - (chainOrder.get(b.chain) ?? 0);
    if (ci !== 0) return ci;
    return a.address.localeCompare(b.address);
  });

  coverage.sort((a, b) => (chainOrder.get(a.chain) ?? 0) - (chainOrder.get(b.chain) ?? 0));

  return {
    query: {
      ...(signerAddress ? { signerAddress } : {}),
      ...(safeAddress ? { safeAddress } : {}),
      chains,
    },
    safes,
    coverage,
  };
}

// readSafeOnChain is exported for v2 (where we need on-chain nonce + version
// reads independent of the tx-service).
export { readSafeOnChain };
