// Safe (Gnosis Safe) v1.3+ ABI fragments used by the propose/execute flow.
// Pulled from the canonical Safe contracts source at
// https://github.com/safe-global/safe-smart-account; only the shapes our
// tools actually call live here so the bundle stays small.

export const safeMultisigAbi = [
  {
    type: "function",
    name: "approveHash",
    stateMutability: "nonpayable",
    inputs: [{ name: "hashToApprove", type: "bytes32" }],
    outputs: [],
  },
  {
    type: "function",
    name: "approvedHashes",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "hashToApprove", type: "bytes32" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "nonce",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getThreshold",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "getOwners",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address[]" }],
  },
  {
    type: "function",
    name: "VERSION",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "string" }],
  },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;
