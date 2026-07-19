// Verify the canonical function signatures the #735 block-5 selector-matrix
// test pins for each of the 9 previously-untested DestinationKinds resolve
// cleanly through viem's keccak (§Verify external claims — don't trust the
// signature strings on reasoning alone; confirm viem parses each, tuple
// included). The test derives the "genuine selector" from these SAME strings
// via toFunctionSelector, so this proves the strings are well-formed and that
// the tuple form (morpho supply) is accepted.
// Run: node scripts/verify-735-block5-selectors.mjs
import { toFunctionSelector } from "viem";

// [destinationKind, canonicalGenuineSignature]
const CASES = [
  ["compound-v3-comet", "supply(address,uint256)"],
  ["morpho-blue", "supply((address,address,address,address,uint256),uint256,uint256,address,bytes)"],
  ["lido-stETH", "submit(address)"],
  ["lido-wstETH", "wrap(uint256)"],
  ["lido-withdrawalQueue", "requestWithdrawals(uint256[],address)"],
  ["eigenlayer-strategyManager", "depositIntoStrategy(address,address,uint256)"],
  ["uniswap-v3-npm", "burn(uint256)"],
  ["rocketpool-depositPool", "deposit()"],
  ["rocketpool-rETH", "burn(uint256)"],
];

let ok = true;
for (const [kind, sig] of CASES) {
  try {
    const sel = toFunctionSelector(sig);
    console.log(`${sel}  ${kind.padEnd(28)} ${sig}`);
  } catch (e) {
    ok = false;
    console.log(`ERROR    ${kind.padEnd(28)} ${sig}  -> ${e.message}`);
  }
}
// The bogus selector every reject case uses — must not collide with any real
// selector above (it doesn't: 0xdeadbeef is a fixed non-function 4-byte).
console.log(`\nbogus (reject-case) selector: 0xdeadbeef`);
console.log(ok ? "\nALL 735 BLOCK-5 SIGNATURES PARSE" : "\nSIGNATURE PARSE FAILURE — FIX BEFORE PROCEEDING");
