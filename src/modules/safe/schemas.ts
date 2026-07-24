import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS } from "../../shared/address-patterns.js";

const evmChainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);

/**
 * `get_safe_positions` accepts at least one of `signerAddress` (discover all
 * Safes the address is an owner of via Safe Transaction Service) or
 * `safeAddress` (direct lookup of one Safe). The "at least one" rule is
 * enforced inside the handler — MCP requires the raw ZodObject here, so we
 * can't `.refine` at the schema root.
 *
 * `chains` defaults to `["ethereum"]` rather than fanning out across all five
 * EVM chains. The Safe Transaction Service is a per-chain authenticated API:
 * fanning out by default would 5x the API-key request budget and surface a
 * pile of "no Safes here" empty results for users who only use mainnet.
 */
export const getSafePositionsInput = z.object({
  signerAddress: z.string().regex(EVM_ADDRESS).optional(),
  safeAddress: z.string().regex(EVM_ADDRESS).optional(),
  chains: z.array(evmChainEnum).min(1).optional(),
});

export type GetSafePositionsArgs = z.infer<typeof getSafePositionsInput>;

/**
 * Inner action for `prepare_safe_tx_propose`. Either:
 *  - `handle`: an opaque token returned by a previous `prepare_*` call. The
 *    server pulls `(to, value, data)` from its in-memory tx-store, so the
 *    agent never gets to substitute different calldata between prepare and
 *    propose. This is the canonical, secure path.
 *  - `to / value / data`: raw call fields, for ad-hoc contract calls that
 *    don't have a matching prepare_* tool (e.g. an obscure protocol's
 *    `claim()` method). `value` defaults to "0", `data` defaults to "0x".
 *  Both forms accept `operation` (CALL=0 default, DELEGATECALL=1).
 *
 * The two forms are mutually exclusive — the handler refuses requests that
 * pass both. Enforced at handler entry, not via `.refine`, so the MCP
 * inputSchema stays a flat ZodObject.
 */
const innerActionHandleSchema = z.object({
  handle: z.string().min(1),
  operation: z.union([z.literal(0), z.literal(1)]).default(0),
});

const innerActionRawSchema = z.object({
  to: z.string().regex(EVM_ADDRESS),
  value: z.string().regex(/^\d+$/).default("0"),
  data: z.string().regex(/^0x[a-fA-F0-9]*$/).default("0x"),
  operation: z.union([z.literal(0), z.literal(1)]).default(0),
});

const innerActionSchema = z.union([innerActionHandleSchema, innerActionRawSchema]);

/**
 * `prepare_safe_tx_propose` builds the Safe-format transaction wrapper for
 * an inner action and returns an `approveHash(safeTxHash)` UnsignedTx that
 * the proposer signs through the existing `send_transaction` flow. After
 * the on-chain `approveHash` is mined, the caller invokes
 * `submit_safe_tx_signature` to post the proposal to Safe Tx Service.
 *
 * Rationale: WC `eth_signTypedData_v4` is intentionally NOT in the session
 * scope (`src/signing/walletconnect.ts:70-89`); on-chain `approveHash` is
 * the gas-positive alternative that preserves the no-typed-data posture.
 */
export const prepareSafeTxProposeInput = z.object({
  signer: z.string().regex(EVM_ADDRESS),
  safeAddress: z.string().regex(EVM_ADDRESS),
  chain: evmChainEnum.default("ethereum"),
  inner: innerActionSchema,
  /**
   * Optional override for the SafeTx nonce. When omitted, the handler asks
   * Safe Transaction Service for the next-expected nonce (which accounts for
   * already-queued pending proposals). Override only when you need to
   * deliberately replace a queued tx (i.e. propose a NEW tx with the same
   * nonce as a pending one — Safe contracts will execute the first to clear
   * the threshold, displacing the others).
   */
  nonceOverride: z.string().regex(/^\d+$/).optional(),
  /**
   * Affirmative opt-in required for an inner `operation: 1` (DELEGATECALL) Safe
   * transaction (issue #761). DELEGATECALL runs the inner target in the Safe's
   * own storage context — it can rewrite the Safe's owner set (a full takeover),
   * so the handler refuses to build a DELEGATECALL propose unless this is `true`
   * and stamps `acknowledgedSafeDelegateCall` on the returned tx so the pre-sign
   * inner-action gate lets the acknowledged case through. Ignored for
   * `operation: 0` (CALL, the default).
   */
  acknowledgeSafeDelegateCall: z.literal(true).optional(),
});

/**
 * `prepare_safe_tx_approve` adds an additional approveHash signature to a
 * Safe transaction that's already in the queue (proposed elsewhere — Safe
 * Web UI, another VaultPilot install, a co-signer running their own SDK).
 * Builds an `approveHash(safeTxHash)` UnsignedTx for the additional signer.
 * After the on-chain approveHash is mined, `submit_safe_tx_signature` posts
 * the new signature to Safe Tx Service so the queue reflects the higher
 * confirmation count.
 */
export const prepareSafeTxApproveInput = z.object({
  signer: z.string().regex(EVM_ADDRESS),
  safeAddress: z.string().regex(EVM_ADDRESS),
  chain: evmChainEnum.default("ethereum"),
  safeTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

/**
 * `submit_safe_tx_signature` finalizes the propose-or-confirm post to
 * Safe Tx Service after the user's `approveHash` tx has been mined. The
 * handler verifies on-chain that `approvedHashes[signer][hash] != 0`
 * before posting — refusing to post a "pre-validated" signature when the
 * underlying approval doesn't exist yet keeps the service queue from
 * carrying signatures that won't validate at execute time.
 *
 * When the SafeTx body is in the server-side store (i.e. the same agent
 * proposed it via `prepare_safe_tx_propose`), the handler uses
 * `proposeTransaction` to create the queue entry. Otherwise it uses
 * `confirmTransaction` to add the signature to an existing entry.
 */
export const submitSafeTxSignatureInput = z.object({
  signer: z.string().regex(EVM_ADDRESS),
  safeAddress: z.string().regex(EVM_ADDRESS),
  chain: evmChainEnum.default("ethereum"),
  safeTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

/**
 * `prepare_safe_tx_execute` builds the final `execTransaction` UnsignedTx
 * that lands the multi-sig payload on chain. The executor doesn't need to
 * have pre-approved on-chain — when `msg.sender` is an owner, the Safe
 * contract treats their inline `(r=msg.sender, s=0, v=1)` signature as
 * implicit consent. So one of the threshold "signatures" can be the
 * executor themselves; the rest come from the on-chain `approvedHashes`
 * registry filled in by previous `prepare_safe_tx_propose` /
 * `prepare_safe_tx_approve` calls.
 *
 * The handler refuses to build the tx when fewer than `threshold` owners
 * (counting the executor) have approved on-chain — which would just
 * revert at execute time.
 */
export const prepareSafeTxExecuteInput = z.object({
  executor: z.string().regex(EVM_ADDRESS),
  safeAddress: z.string().regex(EVM_ADDRESS),
  chain: evmChainEnum.default("ethereum"),
  safeTxHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
});

export type PrepareSafeTxProposeArgs = z.infer<typeof prepareSafeTxProposeInput>;
export type PrepareSafeTxApproveArgs = z.infer<typeof prepareSafeTxApproveInput>;
export type SubmitSafeTxSignatureArgs = z.infer<typeof submitSafeTxSignatureInput>;
export type PrepareSafeTxExecuteArgs = z.infer<typeof prepareSafeTxExecuteInput>;
