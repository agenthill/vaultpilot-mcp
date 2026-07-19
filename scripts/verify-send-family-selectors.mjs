// Verify #741 send-family selector hashes + recipient arg indices against
// viem's canonical keccak (§Verify external claims — do not trust the hex in
// the issue/ARCH brief). Run: node scripts/verify-send-family-selectors.mjs
import { toFunctionSelector } from "viem";

// [signature, claimedSelector, recipientArgIndex, recipientArgName]
const CASES = [
  ["operatorSend(address,address,uint256,bytes,bytes)", "0x62ad1b83", 1, "to"],
  ["transferFromAndCall(address,address,uint256)", null, 1, "to"],
  ["transferFromAndCall(address,address,uint256,bytes)", null, 1, "to"],
  ["withdraw(uint256,address,address)", null, 1, "receiver"],
  ["redeem(uint256,address,address)", null, 1, "receiver"],
  ["safeTransferFrom(address,address,uint256)", "0x42842e0e", 1, "to"],
  ["safeTransferFrom(address,address,uint256,bytes)", "0xb88d4fde", 1, "to"],
  ["safeTransferFrom(address,address,uint256,uint256,bytes)", null, 1, "to"], // ERC-1155
  ["safeBatchTransferFrom(address,address,uint256[],uint256[],bytes)", null, 1, "to"], // ERC-1155
  // Collision reference — ERC-20/721 transferFrom, already covered by #727.
  ["transferFrom(address,address,uint256)", "0x23b872dd", 1, "to"],
];

let ok = true;
for (const [sig, claimed, argIdx, argName] of CASES) {
  const sel = toFunctionSelector(sig);
  const match = claimed === null ? "(unclaimed)" : sel === claimed ? "MATCH" : "MISMATCH";
  if (claimed !== null && sel !== claimed) ok = false;
  console.log(`${sel}  arg[${argIdx}]=${argName}  ${match.padEnd(11)} ${sig}`);
}
console.log(ok ? "\nALL CLAIMED SELECTORS VERIFIED" : "\nSELECTOR MISMATCH — FIX BEFORE PROCEEDING");
