/**
 * Optional online drift check for #799. Run after `npm run build`:
 *   npm run verify:lifi-chain-ids
 *
 * GET quotes only, with public test addresses; no keys, signing or broadcast.
 * Every accepted destination/ID needs a probe. Forced bridge labels make the
 * emitted (bridge, destinationChainId) assertion reproducible, including the
 * near -> Arbitrum falsifier and symbiosis -> TRON namespace mismatch.
 * HTTP errors / unavailable routes fail the run, never count as verification.
 */
import assert from "node:assert/strict";
import { LIFI_BRIDGE_CHAIN_IDS, assertLifiDestinationChain } from "../dist/modules/swap/lifi-chain-ids.js";
import { tryDecodeLifiBridgeData } from "../dist/signing/decode-calldata.js";

const wallet = "0x1111111111111111111111111111111111111111";
const ethereumUsdc = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const arbitrumUsdc = "0xaf88d065e77c8cC2239327C5EDb3A432268e5831";
const probes = [
  { chain: "ethereum", apiId: 1, token: ethereumUsdc, bridge: "near" },
  { chain: "arbitrum", apiId: 42161, token: arbitrumUsdc, bridge: "near" },
  { chain: "polygon", apiId: 137, token: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359", bridge: "across" },
  { chain: "base", apiId: 8453, token: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", bridge: "near" },
  { chain: "optimism", apiId: 10, token: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", bridge: "near" },
  { chain: "solana", apiId: 1151111081099710, token: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", bridge: "near",
    recipient: "5rJ3dKM5K8hYkHcH67z3kjRtGkGuGh3aVi9fFpq9ZuDi" },
  { chain: "tron", apiId: 728126428, token: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", bridge: "symbiosis",
    recipient: "TQn9Y2khEsLJW1ChVWFMSMeRDow5KcbLSE" },
];

assert.deepEqual(
  [...new Set(probes.map((probe) => probe.chain))].sort(),
  Object.keys(LIFI_BRIDGE_CHAIN_IDS).sort(),
  "Every listed destination must have a live probe",
);
const observed = new Set();
let failures = 0;
for (const probe of probes) {
  try {
    const params = new URLSearchParams({
      fromChain: probe.chain === "ethereum" ? "42161" : "1",
      fromToken: probe.chain === "ethereum" ? arbitrumUsdc : ethereumUsdc,
      toChain: String(probe.apiId),
      toToken: probe.token,
      fromAddress: wallet,
      toAddress: probe.recipient ?? wallet,
      fromAmount: "100000000",
      allowBridges: probe.bridge,
    });
    const response = await fetch(`https://li.quest/v1/quote?${params}`, {
      signal: AbortSignal.timeout(45_000),
    });
    if (!response.ok) {
      throw new Error(`LiFi HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    }
    const quote = await response.json();
    const decoded = tryDecodeLifiBridgeData(quote.transactionRequest?.data ?? "0x");
    assert(decoded, "Live quote must contain decodable BridgeData");
    assert.equal(quote.action.toChainId, probe.apiId, "API destination must match the probe");
    assert.equal(quote.tool, probe.bridge, "LiFi must honor the forced bridge");
    assert(LIFI_BRIDGE_CHAIN_IDS[probe.chain].some((id) => {
      return decoded.bridge === probe.bridge && decoded.destinationChainId === id;
    }), `Unexpected pair (${decoded.bridge}, ${decoded.destinationChainId}) for ${probe.chain}`);
    assertLifiDestinationChain(probe.chain, decoded.destinationChainId);
    observed.add(`${probe.chain}:${decoded.destinationChainId}`);
    console.log(`PASS ${probe.chain}: API=${probe.apiId}, BridgeData=(${decoded.bridge}, ${decoded.destinationChainId})`);
  } catch (error) {
    failures++;
    console.error(`FAIL ${probe.chain}/${probe.bridge}: ${error.message}`);
  }
}
for (const [chain, ids] of Object.entries(LIFI_BRIDGE_CHAIN_IDS)) {
  for (const id of ids) {
    if (!observed.has(`${chain}:${id}`)) {
      failures++;
      console.error(`FAIL no live quote verified ${chain}:${id}`);
    }
  }
}
process.exitCode = failures ? 1 : 0;
