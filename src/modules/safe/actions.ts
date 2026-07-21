import { encodeFunctionData, getAddress } from "viem";
import { safeMultisigAbi } from "../../abis/safe-multisig.js";
import { getClient } from "../../data/rpc.js";
import { consumeHandle } from "../../signing/tx-store.js";
import {
  buildSafeTxBody,
  computeSafeTxHash,
  describeSafeTxBody,
  encodeApprovedHashSignature,
  SAFE_OP_CALL,
  SAFE_OP_DELEGATECALL,
  type SafeTxBody,
} from "./safe-tx.js";
import { lookupSafeTx, rememberSafeTx } from "./safe-tx-store.js";
import { getSafeApiKit } from "./sdk.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";
import type {
  PrepareSafeTxApproveArgs,
  PrepareSafeTxProposeArgs,
  SubmitSafeTxSignatureArgs,
} from "./schemas.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Resolve the inner-action fields of a propose request. When `handle` is
 * supplied, the underlying `prepare_*` UnsignedTx is fetched from the
 * server-side tx-store and `(to, value, data)` are taken verbatim — the
 * agent never has the chance to substitute different bytes between prepare
 * and propose. When raw fields are supplied, they're returned as-is.
 *
 * The handle is NOT consumed (i.e. retireHandle is not called) — the
 * underlying prepare_* receipt is still browsable for the user, and
 * propose's job is to wrap it, not replace it.
 */
function resolveInnerAction(args: PrepareSafeTxProposeArgs): {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
} {
  const inner = args.inner;
  if ("handle" in inner) {
    const tx: UnsignedTx = consumeHandle(inner.handle);
    return {
      to: tx.to,
      value: tx.value,
      data: tx.data,
      operation: inner.operation as 0 | 1,
    };
  }
  return {
    to: getAddress(inner.to) as `0x${string}`,
    value: inner.value,
    data: inner.data as `0x${string}`,
    operation: inner.operation as 0 | 1,
  };
}

/**
 * Build the OUTER `approveHash(safeTxHash)` UnsignedTx that the proposer (or
 * an additional signer) sends through `send_transaction`. This is a normal
 * EVM contract call to the Safe itself — no Safe-specific signing path; the
 * existing send_transaction flow handles it.
 */
function buildApproveHashTx(args: {
  chain: SupportedChain;
  signer: `0x${string}`;
  safeAddress: `0x${string}`;
  safeTxHash: `0x${string}`;
  description: string;
  innerSummary: string[];
}): UnsignedTx {
  return {
    chain: args.chain,
    to: args.safeAddress,
    data: encodeFunctionData({
      abi: safeMultisigAbi,
      functionName: "approveHash",
      args: [args.safeTxHash],
    }),
    value: "0",
    from: args.signer,
    description: args.description,
    decoded: {
      functionName: "approveHash",
      args: { hashToApprove: args.safeTxHash },
    },
    // Safe addresses are user-specific and never appear in the
    // canonical-dispatch allowlist. Tag the handle so `assertTransactionSafe`
    // skips ONLY its catch-all unknown-destination refusal. Issue #609.
    safeTxOrigin: true,
  };
}

/**
 * Read the Safe's current on-chain nonce. Used as a sanity check against
 * the tx-service's `getNextNonce` — if the service returns a nonce LOWER
 * than the on-chain nonce, the queue is corrupt and we refuse to propose.
 */
async function readOnChainNonce(
  chain: SupportedChain,
  safeAddress: `0x${string}`,
): Promise<bigint> {
  const client = getClient(chain);
  return (await client.readContract({
    address: safeAddress,
    abi: safeMultisigAbi,
    functionName: "nonce",
  })) as bigint;
}

/**
 * Resolve the SafeTx nonce to use. Order:
 *   1. Caller-supplied `nonceOverride` (deliberate replacement of a queued tx).
 *   2. Safe Tx Service `getNextNonce` (accounts for queued pending proposals).
 *   3. Sanity check: refuse if service nonce < on-chain nonce.
 */
async function resolveNonce(args: {
  chain: SupportedChain;
  safeAddress: `0x${string}`;
  nonceOverride?: string;
}): Promise<string> {
  if (args.nonceOverride !== undefined) return args.nonceOverride;
  const kit = getSafeApiKit(args.chain);
  const [serviceNonce, onChainNonce] = await Promise.all([
    kit.getNextNonce(args.safeAddress),
    readOnChainNonce(args.chain, args.safeAddress),
  ]);
  if (BigInt(serviceNonce) < onChainNonce) {
    throw new Error(
      `Safe Transaction Service returned a stale nonce (${serviceNonce}) below the ` +
        `on-chain nonce (${onChainNonce}) for ${args.safeAddress}. The service may be ` +
        `out of sync; re-try in a minute or pass an explicit \`nonceOverride\`.`,
    );
  }
  return serviceNonce;
}

/**
 * Build the Safe-format wrapper for an inner action and return an
 * `approveHash(safeTxHash)` UnsignedTx for the proposer to broadcast.
 *
 * The full SafeTx body is stashed in the in-memory store keyed by safeTxHash
 * so `submit_safe_tx_signature` can post the proposal to Safe Tx Service
 * without re-deriving the body from caller args (which would let an agent
 * substitute different bytes between approve and submit).
 */
export async function prepareSafeTxPropose(
  args: PrepareSafeTxProposeArgs,
): Promise<UnsignedTx> {
  const chain = args.chain as SupportedChain;
  const safeAddress = getAddress(args.safeAddress) as `0x${string}`;
  const signer = getAddress(args.signer) as `0x${string}`;
  const inner = resolveInnerAction(args);
  // DELEGATECALL (operation 1) runs the inner target in the Safe's own storage
  // context and can rewrite the Safe's owner set — a full takeover. Refuse to
  // build it without the explicit affirmative opt-in (issue #761); the pre-sign
  // inner-action gate refuses a DELEGATECALL that lacks the resulting stamp.
  if (inner.operation === SAFE_OP_DELEGATECALL && args.acknowledgeSafeDelegateCall !== true) {
    throw new Error(
      `prepare_safe_tx_propose: inner operation is DELEGATECALL (operation=1), which runs the ` +
        `target in the Safe's own storage context and can rewrite the Safe's owner set — a full ` +
        `takeover risk. Refusing to build it without the explicit acknowledgeSafeDelegateCall: true ` +
        `opt-in. Surface this trade-off to the user, then re-call with acknowledgeSafeDelegateCall: true.`,
    );
  }
  const nonce = await resolveNonce({
    chain,
    safeAddress,
    nonceOverride: args.nonceOverride,
  });

  const body: SafeTxBody = buildSafeTxBody({
    to: inner.to,
    value: inner.value,
    data: inner.data,
    operation: inner.operation,
    nonce,
  });
  const safeTxHash = computeSafeTxHash({ chain, safeAddress, body });

  const innerSummary = describeSafeTxBody(body);
  const opLabel = inner.operation === SAFE_OP_CALL ? "" : " ⚠ DELEGATECALL";
  const tx = buildApproveHashTx({
    chain,
    signer,
    safeAddress,
    safeTxHash,
    description:
      `Approve Safe tx ${safeTxHash.slice(0, 10)}… on ${safeAddress.slice(0, 8)}…` +
      ` (nonce ${nonce}${opLabel}). After this is mined, call submit_safe_tx_signature ` +
      `to post the proposal to Safe Transaction Service.`,
    innerSummary,
  });

  // Stamp the affirmative DELEGATECALL opt-in (issue #761) so the pre-sign
  // inner-action gate lets an acknowledged operation:1 tx through. Only set for
  // operation:1 (the un-acked case already threw above); the flag flows through
  // the server-minted handle store and is non-forgeable by the agent.
  if (inner.operation === SAFE_OP_DELEGATECALL) {
    tx.acknowledgedSafeDelegateCall = true;
  }

  rememberSafeTx({ safeTxHash, chain, safeAddress, body, proposeHandle: tx.handle });

  return tx;
}

/**
 * Build an `approveHash(safeTxHash)` UnsignedTx for an additional signer
 * confirming an already-proposed Safe transaction. Differs from
 * `prepareSafeTxPropose` in that it doesn't compute a new safeTxHash —
 * the hash is supplied by the caller (typically copied out of the Safe Web
 * UI or `get_safe_positions` pendingTxs list).
 *
 * If we don't have a server-side body for the safeTxHash (i.e. another
 * client proposed it), we fetch the body from Safe Tx Service so the
 * verification block can show the inner action being approved. Falls back
 * to a thin description when even that lookup fails.
 */
export async function prepareSafeTxApprove(
  args: PrepareSafeTxApproveArgs,
): Promise<UnsignedTx> {
  const chain = args.chain as SupportedChain;
  const safeAddress = getAddress(args.safeAddress) as `0x${string}`;
  const signer = getAddress(args.signer) as `0x${string}`;
  const safeTxHash = args.safeTxHash as `0x${string}`;

  let innerSummary: string[] = [`Safe tx ${safeTxHash.slice(0, 10)}… (body not in local cache).`];
  let nonceLabel = "?";
  let opLabel = "";

  const cached = lookupSafeTx(safeTxHash);
  if (cached) {
    innerSummary = describeSafeTxBody(cached.body);
    nonceLabel = cached.body.nonce;
    if (cached.body.operation === 1) opLabel = " ⚠ DELEGATECALL";
  } else {
    try {
      const kit = getSafeApiKit(chain);
      const remote = await kit.getTransaction(safeTxHash);
      const body: SafeTxBody = {
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
      innerSummary = describeSafeTxBody(body);
      nonceLabel = remote.nonce;
      if (remote.operation === 1) opLabel = " ⚠ DELEGATECALL";
    } catch {
      // Fall through: leave the thin innerSummary in place. The user can
      // still cross-check the safeTxHash via the Safe Web UI before signing.
    }
  }

  return buildApproveHashTx({
    chain,
    signer,
    safeAddress,
    safeTxHash,
    description:
      `Approve existing Safe tx ${safeTxHash.slice(0, 10)}… on ${safeAddress.slice(0, 8)}…` +
      ` (nonce ${nonceLabel}${opLabel}). After this is mined, call submit_safe_tx_signature ` +
      `to push the new signature to Safe Transaction Service.`,
    innerSummary,
  });
}

/**
 * Verify that the on-chain `approveHash` has been mined, then either propose
 * a new Safe Transaction Service queue entry (when we have the SafeTx body
 * locally) or confirm an existing one (when we don't).
 *
 * Refusing to post a "pre-validated" signature when the underlying approval
 * doesn't exist on chain keeps the service queue from carrying signatures
 * that won't validate at execute time. The check is a single
 * `approvedHashes(signer, safeTxHash)` view call — cheap and authoritative.
 */
export async function submitSafeTxSignature(
  args: SubmitSafeTxSignatureArgs,
): Promise<{
  /** Tells the agent which Safe Tx Service path was taken. */
  action: "proposed" | "confirmed";
  safeTxHash: `0x${string}`;
  safeAddress: `0x${string}`;
  chain: SupportedChain;
  signer: `0x${string}`;
  /** Convenience link to the Safe Web UI queue for the user / co-signers. */
  safeWebUiUrl: string;
}> {
  const chain = args.chain as SupportedChain;
  const safeAddress = getAddress(args.safeAddress) as `0x${string}`;
  const signer = getAddress(args.signer) as `0x${string}`;
  const safeTxHash = args.safeTxHash as `0x${string}`;

  // 1. On-chain approval check — refuse to post if the user didn't actually
  //    broadcast (or the tx hasn't landed yet).
  const client = getClient(chain);
  const approved = (await client.readContract({
    address: safeAddress,
    abi: safeMultisigAbi,
    functionName: "approvedHashes",
    args: [signer, safeTxHash],
  })) as bigint;
  if (approved === 0n) {
    throw new Error(
      `Signer ${signer} has not approved Safe tx ${safeTxHash} on-chain yet. ` +
        `Run prepare_safe_tx_propose / prepare_safe_tx_approve and broadcast the ` +
        `returned approveHash tx through send_transaction before submitting.`,
    );
  }

  const senderSignature = encodeApprovedHashSignature(signer);
  const kit = getSafeApiKit(chain);

  // 2. Decide between propose (server-side body present) and confirm
  //    (body unknown locally; rely on the existing service entry).
  const cached = lookupSafeTx(safeTxHash);
  let action: "proposed" | "confirmed";
  if (cached) {
    await enrichSafeServiceError(
      () =>
        kit.proposeTransaction({
          safeAddress,
          safeTransactionData: {
            to: cached.body.to,
            value: cached.body.value,
            data: cached.body.data,
            operation: cached.body.operation,
            safeTxGas: cached.body.safeTxGas,
            baseGas: cached.body.baseGas,
            gasPrice: cached.body.gasPrice,
            gasToken: cached.body.gasToken,
            refundReceiver: cached.body.refundReceiver,
            nonce: cached.body.nonce,
          },
          safeTxHash,
          senderAddress: signer,
          senderSignature,
          origin: "vaultpilot-mcp",
        }),
      { op: "proposeTransaction", chain, safeAddress, signer, safeTxHash },
    );
    action = "proposed";
  } else {
    await enrichSafeServiceError(
      () => kit.confirmTransaction(safeTxHash, senderSignature),
      { op: "confirmTransaction", chain, safeAddress, signer, safeTxHash },
    );
    action = "confirmed";
  }

  return {
    action,
    safeTxHash,
    safeAddress,
    chain,
    signer,
    safeWebUiUrl: `https://app.safe.global/transactions/queue?safe=${chainPrefix(chain)}:${safeAddress}`,
  };
}

/**
 * Wrap a Safe-API-Kit propose/confirm call with diagnostic enrichment.
 *
 * Why: `@safe-global/api-kit`'s internal `sendRequest` extracts the response
 * body only when its JSON shape contains one of a hard-coded key allowlist
 * (`data`, `detail`, `message`, `nonFieldErrors`, `delegate`, `safe`,
 * `delegator`). Safe Transaction Service 422 validation errors typically
 * return field-keyed shapes (e.g. `{"signature": ["..."]}`) that miss the
 * allowlist — the SDK falls through to `throw new Error(response.statusText)`
 * and the caller gets the literal string "Unprocessable Content" with no
 * actionable signal. See issue #610.
 *
 * Strategy: on failure, issue a read probe (`getTransaction(safeTxHash)`)
 * against the same service to recover whether STS already knows the entry,
 * and fold that state plus chain/signer/safe context into a re-thrown error.
 * The probe is read-only, and any probe failure is swallowed so enrichment
 * never masks the original error.
 */
async function enrichSafeServiceError<T>(
  fn: () => Promise<T>,
  context: {
    op: "proposeTransaction" | "confirmTransaction";
    chain: SupportedChain;
    safeAddress: `0x${string}`;
    signer: `0x${string}`;
    safeTxHash: `0x${string}`;
  },
): Promise<T> {
  try {
    return await fn();
  } catch (origError) {
    const original = origError instanceof Error ? origError.message : String(origError);
    const probeLines = await probeSafeServiceState(context);
    const enriched = new Error(
      [
        `Safe Transaction Service ${context.op} failed: ${original}`,
        ...probeLines,
        `Context: chain=${context.chain} safe=${context.safeAddress} ` +
          `signer=${context.signer} safeTxHash=${context.safeTxHash}`,
      ].join("\n"),
    );
    if (origError instanceof Error && origError.stack) {
      enriched.stack = origError.stack;
    }
    (enriched as Error & { cause?: unknown }).cause = origError;
    throw enriched;
  }
}

/**
 * Read-only probe of Safe Tx Service state for a safeTxHash. Returns a list
 * of summary lines tailored to one of three branches:
 *   1. STS knows the hash → include nonce / isExecuted / confirmation count.
 *   2. STS returns "Not found." → suggest re-running prepare_safe_tx_propose.
 *   3. Probe itself fails → include the probe error so the user can tell.
 *
 * All errors are swallowed; this function never throws.
 */
async function probeSafeServiceState(context: {
  op: "proposeTransaction" | "confirmTransaction";
  chain: SupportedChain;
  safeTxHash: `0x${string}`;
}): Promise<string[]> {
  try {
    const kit = getSafeApiKit(context.chain);
    const remote = await kit.getTransaction(context.safeTxHash);
    const conf = remote.confirmations?.length ?? 0;
    return [
      `STS state: KNOWS this safeTxHash (nonce=${remote.nonce} ` +
        `isExecuted=${remote.isExecuted} confirmations=${conf}/${remote.confirmationsRequired}).`,
      context.op === "proposeTransaction"
        ? `Hint: STS already has an entry for this hash, so the proposeTransaction ` +
          `call collided. The local SafeTx body cache likely went stale (TTL 30 min) ` +
          `but STS retains the prior proposal — call submit_safe_tx_signature again ` +
          `after re-running prepare_safe_tx_propose, or use prepare_safe_tx_approve ` +
          `(which routes through confirmTransaction) for an additional signer.`
        : `Hint: STS has the entry; confirmTransaction failure is most likely a ` +
          `signature-shape rejection. Verify approvedHashes(signer, safeTxHash)==1 ` +
          `on chain and that the signer is an owner of this Safe.`,
    ];
  } catch (probeError) {
    const probeMsg = probeError instanceof Error ? probeError.message : String(probeError);
    if (/not\s*found/i.test(probeMsg)) {
      return [
        `STS state: does NOT have this safeTxHash (probe returned "Not found.").`,
        `Hint: STS rejected the ${context.op} call before persisting the entry. ` +
          `Common causes: signature shape, payload-field validation (e.g. checksum ` +
          `case on \`to\`/\`safeAddress\`), or stale nonce. Re-run ` +
          `prepare_safe_tx_propose to refresh the cached SafeTx body and retry.`,
      ];
    }
    return [`STS state: probe failed (${probeMsg}).`];
  }
}

/**
 * Map our chain enum to the `<prefix>:<address>` shape used in Safe Web UI
 * deep-links (e.g. `eth:0x…`, `arb1:0x…`, `matic:0x…`). Hard-coded because
 * Safe's prefix list is short and stable; if Safe adds a chain we'd want
 * this updated alongside `SUPPORTED_CHAINS`.
 */
function chainPrefix(chain: SupportedChain): string {
  switch (chain) {
    case "ethereum":
      return "eth";
    case "arbitrum":
      return "arb1";
    case "polygon":
      return "matic";
    case "base":
      return "base";
    case "optimism":
      return "oeth";
  }
}
