import { decodeFunctionData, hashTypedData, pad, toHex } from "viem";
import { erc20Abi } from "../../abis/erc20.js";
import { CHAIN_IDS, type SupportedChain } from "../../types/index.js";

/**
 * Operation type for a Safe transaction. CALL = standard call (the default
 * and the only safe option for most use cases). DELEGATECALL invokes the
 * target contract in the Safe's own storage context — extremely high-risk;
 * a malicious target can rewrite the Safe's owners array. We accept it as
 * an explicit input but flag it loudly in the prepare receipt.
 */
export const SAFE_OP_CALL = 0;
export const SAFE_OP_DELEGATECALL = 1;

/**
 * Body of a Safe transaction. These are the EIP-712 typed-data message fields
 * the Safe contract hashes when it computes `safeTxHash`. Values mirror the
 * Solidity types: addresses are 0x-hex strings, integers are decimal strings
 * to round-trip through JSON without loss.
 */
export interface SafeTxBody {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
  /**
   * Per-tx gas overhead reserved for the Safe contract's internal logic.
   * Set to 0 — Safe Tx Service estimates this server-side when the tx is
   * proposed; we don't need a separate on-chain estimation pass.
   */
  safeTxGas: string;
  /**
   * Refund-receiver gas overhead. Set to 0 — refundReceiver is also 0x0
   * (no gas refund), so this field is irrelevant.
   */
  baseGas: string;
  /** Refund-receiver gas price. Set to 0; see baseGas. */
  gasPrice: string;
  /** ERC-20 token used to refund the executor. 0x0 = pay in native ETH. */
  gasToken: `0x${string}`;
  /** Address that receives the gas refund. 0x0 = no refund. */
  refundReceiver: `0x${string}`;
  /** Sequential Safe nonce — must equal the Safe's current on-chain nonce. */
  nonce: string;
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as `0x${string}`;

/**
 * Compute the EIP-712 hash that Safe owners sign. Follows the v1.3+ domain
 * separator (chainId + verifyingContract only — no `name` or `version`).
 *
 * Older Safe versions (v1.0 – v1.2) used a different domain that included
 * the contract version as a string — we don't support those here. v1 of the
 * `get_safe_positions` tool surfaces the contract version on every Safe so
 * callers can detect this case before invoking the propose flow.
 */
export function computeSafeTxHash(args: {
  chain: SupportedChain;
  safeAddress: `0x${string}`;
  body: SafeTxBody;
}): `0x${string}` {
  return hashTypedData({
    domain: {
      chainId: CHAIN_IDS[args.chain],
      verifyingContract: args.safeAddress,
    },
    types: {
      SafeTx: [
        { name: "to", type: "address" },
        { name: "value", type: "uint256" },
        { name: "data", type: "bytes" },
        { name: "operation", type: "uint8" },
        { name: "safeTxGas", type: "uint256" },
        { name: "baseGas", type: "uint256" },
        { name: "gasPrice", type: "uint256" },
        { name: "gasToken", type: "address" },
        { name: "refundReceiver", type: "address" },
        { name: "nonce", type: "uint256" },
      ],
    },
    primaryType: "SafeTx",
    message: {
      to: args.body.to,
      value: BigInt(args.body.value),
      data: args.body.data,
      operation: args.body.operation,
      safeTxGas: BigInt(args.body.safeTxGas),
      baseGas: BigInt(args.body.baseGas),
      gasPrice: BigInt(args.body.gasPrice),
      gasToken: args.body.gasToken,
      refundReceiver: args.body.refundReceiver,
      nonce: BigInt(args.body.nonce),
    },
  });
}

/**
 * Build a SafeTx body from the inner-action fields plus the next nonce. All
 * gas-refund fields zero out — we never use Safe's gas-refund mechanism.
 */
export function buildSafeTxBody(args: {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
  nonce: string;
}): SafeTxBody {
  return {
    to: args.to,
    value: args.value,
    data: args.data,
    operation: args.operation,
    safeTxGas: "0",
    baseGas: "0",
    gasPrice: "0",
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce: args.nonce,
  };
}

/**
 * Encode an "approved hash" Safe owner signature (a.k.a. pre-validated
 * signature). When an owner has called `approveHash(safeTxHash)` on-chain,
 * their consent can be represented by a 65-byte tuple of `(r, s, v)` where:
 *
 *   r = bytes32(uint256(uint160(signer)))   // signer address, left-padded
 *   s = bytes32(0)                           // unused
 *   v = 1                                    // pre-validated marker
 *
 * `Safe.checkSignatures` validates this format by reading
 * `approvedHashes[signer][safeTxHash]` and accepting it iff > 0.
 *
 * The Safe Transaction Service accepts the same format in
 * `confirmTransaction(safeTxHash, signature)` and threads it into the
 * `signatures` blob handed to `execTransaction` at execute time.
 */
export function encodeApprovedHashSignature(signer: `0x${string}`): `0x${string}` {
  // r = signer address as 32-byte word
  const r = pad(signer, { size: 32 });
  const s = pad("0x", { size: 32 });
  const v = "01";
  return `0x${r.slice(2)}${s.slice(2)}${v}` as `0x${string}`;
}

/**
 * Pretty-print a SafeTx body for the prepare receipt. Used by the verification
 * block so the agent can show the user EXACTLY what's being approved before
 * they sign the on-chain `approveHash` tx — the receipt the user reads on
 * their Ledger device will only show the OUTER tx (calling Safe.approveHash)
 * not the INNER call this hash represents.
 */
export function describeSafeTxBody(body: SafeTxBody): string[] {
  const lines: string[] = [
    `Safe inner action:`,
    `  to:        ${body.to}`,
    `  value:     ${body.value} (wei)`,
    `  data:      ${body.data === "0x" ? "(no calldata — plain transfer)" : `${body.data.slice(0, 10)}… (${(body.data.length - 2) / 2} bytes)`}`,
    `  operation: ${body.operation === SAFE_OP_DELEGATECALL ? "DELEGATECALL ⚠ (high-risk: target executes in Safe's storage context)" : "CALL"}`,
    `  nonce:     ${body.nonce}`,
  ];
  // #761: the 4-byte-truncated `data` line above hides WHERE an ERC-20
  // transfer/approve routes value/authority (the `to` field is only the token
  // contract, not the recipient). Decode and surface the inner recipient/spender
  // explicitly so the user reads the real destination before signing.
  const innerTarget = describeInnerErc20Target(body.data);
  if (innerTarget) lines.push(innerTarget);
  return lines;
}

/**
 * If `data` is an ERC-20 `transfer(to, amount)` or `approve(spender, amount)`,
 * return a line naming the recipient/spender and amount. Returns `undefined`
 * for any other (or undecodable) calldata — display-only, so it never throws.
 */
function describeInnerErc20Target(data: `0x${string}`): string | undefined {
  if (!data || data.length < 10) return undefined;
  try {
    const decoded = decodeFunctionData({ abi: erc20Abi, data });
    if (decoded.functionName === "transfer") {
      return `  ⤷ ERC-20 transfer → recipient ${decoded.args[0]} (amount ${String(decoded.args[1])})`;
    }
    if (decoded.functionName === "approve") {
      return `  ⤷ ERC-20 approve → spender ${decoded.args[0]} (allowance ${String(decoded.args[1])})`;
    }
  } catch {
    // Not an ERC-20 transfer/approve (or undecodable) — nothing extra to show.
  }
  return undefined;
}

/**
 * Convenience: hex-encode a uint256-wide signer address. Exported separately
 * because the test suite asserts on its exact byte-shape.
 */
export function signerWord(signer: `0x${string}`): `0x${string}` {
  return pad(signer, { size: 32 });
}

// `toHex` re-export so callers can stringify bigint nonces consistently.
export { toHex };
