import { encodeFunctionData, getAddress } from "viem";
import { safeMultisigAbi } from "../../abis/safe-multisig.js";
import { getClient } from "../../data/rpc.js";
import { encodeApprovedHashSignature, type SafeTxBody } from "./safe-tx.js";
import { lookupSafeTx } from "./safe-tx-store.js";
import { getSafeApiKit } from "./sdk.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";
import type { PrepareSafeTxExecuteArgs } from "./schemas.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Resolve the SafeTx body for an execute call. Local store first (fast path
 * — set by prepare_safe_tx_propose this session); falls back to Safe Tx
 * Service `getTransaction` for txs proposed elsewhere.
 *
 * Throws when neither path yields a body, since `execTransaction` cannot be
 * built without `(to, value, data, operation, nonce)`.
 */
async function resolveSafeTxBody(args: {
  chain: SupportedChain;
  safeTxHash: `0x${string}`;
}): Promise<SafeTxBody> {
  const cached = lookupSafeTx(args.safeTxHash);
  if (cached) return cached.body;

  const kit = getSafeApiKit(args.chain);
  const remote = await kit.getTransaction(args.safeTxHash).catch((e: unknown) => {
    throw new Error(
      `SafeTx ${args.safeTxHash} not found in local cache or Safe Transaction Service: ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
  });
  return {
    to: remote.to as `0x${string}`,
    value: remote.value,
    data: (remote.data ?? "0x") as `0x${string}`,
    operation: (remote.operation === 1 ? 1 : 0) as 0 | 1,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: remote.nonce,
  };
}

/**
 * Read the Safe's owner list, threshold, and per-owner approveHash status
 * for a given safeTxHash in a single multicall. Returns the owners that
 * have already approved + the threshold so the caller can check whether
 * execution is feasible.
 */
async function readApprovalState(args: {
  chain: SupportedChain;
  safeAddress: `0x${string}`;
  safeTxHash: `0x${string}`;
}): Promise<{
  threshold: number;
  owners: `0x${string}`[];
  approvedOwners: `0x${string}`[];
}> {
  const client = getClient(args.chain);
  const [threshold, owners] = (await Promise.all([
    client.readContract({
      address: args.safeAddress,
      abi: safeMultisigAbi,
      functionName: "getThreshold",
    }) as Promise<bigint>,
    client.readContract({
      address: args.safeAddress,
      abi: safeMultisigAbi,
      functionName: "getOwners",
    }) as Promise<readonly `0x${string}`[]>,
  ])) as [bigint, readonly `0x${string}`[]];

  // Per-owner approvedHashes lookup, parallelised. A single multicall would
  // be one fewer RPC call but adds the multicall ABI to this module for
  // negligible benefit at owner counts < 20 (essentially every Safe).
  const approvalFlags = await Promise.all(
    owners.map((owner) =>
      client.readContract({
        address: args.safeAddress,
        abi: safeMultisigAbi,
        functionName: "approvedHashes",
        args: [owner, args.safeTxHash],
      }) as Promise<bigint>,
    ),
  );
  const approvedOwners = owners.filter((_, i) => approvalFlags[i] !== 0n);
  return {
    threshold: Number(threshold),
    owners: [...owners],
    approvedOwners,
  };
}

/**
 * Build the `signatures` blob `execTransaction` expects. Safe contract rules:
 *
 *  - Each signature is 65 bytes: `r (32) | s (32) | v (1)`.
 *  - For "approved hashes" we use the pre-validated form: r = signer left-
 *    padded to 32 bytes, s = 0, v = 1. The contract verifies this against
 *    `msg.sender == signer || approvedHashes[signer][hash] != 0`.
 *  - Signatures MUST be ordered by ascending owner address — the contract
 *    iterates `currentOwner > lastOwner` and reverts otherwise.
 *
 * The executor counts as their own signature when they're an owner (the
 * `msg.sender` clause of the contract check), so they don't need to have
 * pre-approved on-chain. We include the executor in the picked list FIRST
 * (highest priority) so a cold-start execute by an owner just works.
 */
function buildSignaturesBlob(args: {
  threshold: number;
  approvedOwners: `0x${string}`[];
  executor: `0x${string}`;
  ownersSet: Set<string>;
}): `0x${string}` {
  // Combined eligible-signer set: confirmed approveHashers + the executor
  // (when they're an owner). Lower-cased keys for set semantics.
  const eligible = new Set<string>(args.approvedOwners.map((o) => o.toLowerCase()));
  const executorLc = args.executor.toLowerCase();
  if (args.ownersSet.has(executorLc)) {
    eligible.add(executorLc);
  }
  if (eligible.size < args.threshold) {
    throw new Error(
      `Threshold not met: ${eligible.size}/${args.threshold} signers ready ` +
        `(approveHash count = ${args.approvedOwners.length}; executor counts iff they're an owner).`,
    );
  }

  // Sort ascending — what the contract requires. Lower-case comparison is
  // lexicographic on hex; that matches numeric address ordering.
  const ordered = [...eligible].sort();

  // Take exactly `threshold` of them — extra signatures are accepted but
  // waste calldata gas on every chain.
  const picked = ordered.slice(0, args.threshold) as `0x${string}`[];

  const sigs = picked.map((s) => encodeApprovedHashSignature(getAddress(s) as `0x${string}`));
  return ("0x" + sigs.map((s) => s.slice(2)).join("")) as `0x${string}`;
}

/**
 * Build the executor-side `execTransaction` UnsignedTx. The OUTER tx sends
 * 0 ETH from the executor — the inner value (if any) is paid by the Safe
 * contract from its own balance to the inner `to` during the inner CALL.
 */
export async function prepareSafeTxExecute(
  args: PrepareSafeTxExecuteArgs,
): Promise<UnsignedTx> {
  const chain = args.chain as SupportedChain;
  const safeAddress = getAddress(args.safeAddress) as `0x${string}`;
  const executor = getAddress(args.executor) as `0x${string}`;
  const safeTxHash = args.safeTxHash as `0x${string}`;

  const [body, approvalState] = await Promise.all([
    resolveSafeTxBody({ chain, safeTxHash }),
    readApprovalState({ chain, safeAddress, safeTxHash }),
  ]);

  const ownersSet = new Set(approvalState.owners.map((o) => o.toLowerCase()));
  const signatures = buildSignaturesBlob({
    threshold: approvalState.threshold,
    approvedOwners: approvalState.approvedOwners,
    executor,
    ownersSet,
  });

  const data = encodeFunctionData({
    abi: safeMultisigAbi,
    functionName: "execTransaction",
    args: [
      body.to,
      BigInt(body.value),
      body.data,
      body.operation,
      BigInt(body.safeTxGas),
      BigInt(body.baseGas),
      BigInt(body.gasPrice),
      body.gasToken,
      body.refundReceiver,
      signatures,
    ],
  });

  const opLabel = body.operation === 1 ? " ⚠ DELEGATECALL" : "";
  return {
    chain,
    to: safeAddress,
    data,
    value: "0",
    from: executor,
    description:
      `Execute Safe tx ${safeTxHash.slice(0, 10)}… on ${safeAddress.slice(0, 8)}…` +
      ` (nonce ${body.nonce}${opLabel}). Inner: ${body.to.slice(0, 8)}… value ${body.value} wei` +
      `${body.data === "0x" ? " (plain transfer)" : ` data ${body.data.slice(0, 10)}…`}.`,
    decoded: {
      functionName: "execTransaction",
      args: {
        to: body.to,
        value: body.value,
        operation: body.operation === 1 ? "DELEGATECALL" : "CALL",
        nonce: body.nonce,
        signaturesLength: String((signatures.length - 2) / 2),
      },
    },
    // Safe addresses are user-specific and never appear in the
    // canonical-dispatch allowlist. Tag the handle so `assertTransactionSafe`
    // skips ONLY its catch-all unknown-destination refusal. Issue #609.
    safeTxOrigin: true,
  };
}
