/**
 * #685 DEV live-verify probe (read-only quote fetches against li.quest).
 *
 * Verifies the design's live-verify mandates against the real LiFi API:
 *   R1  — a larger `slippage` param monotonically lowers the baked on-chain
 *         min-out (the fix lever works).
 *   R3  — the calldata-baked generic-swap `_minAmountOut` equals the structured
 *         `estimate.toAmountMin` (else the gate's use of the DECODED value is
 *         load-bearing).
 *   NIT-1 — whether any current same-chain route classifies as neither a
 *         generic-swap selector nor a decodable bridge (a 1c REFUSE on a live
 *         route, not just a future ops risk).
 *
 * Read-only: only GET https://li.quest/v1/quote. No signing, no broadcast.
 * Uses the same integrator string the server sets. Run:
 *   node scripts/probe-685-lifi-liveverify.mjs
 */
import { decodeFunctionData } from "viem";
import { lifiDiamondAbi } from "../src/abis/lifi-diamond.js";
import { tryDecodeLifiBridgeData } from "../src/signing/decode-calldata.js";
import {
  classifyLifiQuote,
  vetGenericSwapQuote,
  bridgeSuspectedUnreachable,
} from "../src/modules/swap/vet-lifi-quote.js";

const BASE = "https://li.quest/v1/quote";
const WALLET = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075";
const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";

async function quote({ fromChain, toChain, fromToken, toToken, fromAmount, slippage, order }) {
  const params = new URLSearchParams({
    fromChain: String(fromChain),
    toChain: String(toChain),
    fromToken,
    toToken,
    fromAmount,
    fromAddress: WALLET,
    integrator: "vaultpilot-mcp",
  });
  if (slippage !== undefined) params.set("slippage", String(slippage));
  if (order !== undefined) params.set("order", order);
  const res = await fetch(`${BASE}?${params.toString()}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

function decodedBakedMinOut(data) {
  try {
    const d = decodeFunctionData({ abi: lifiDiamondAbi, data });
    return { cls: "generic", fn: d.functionName, minOut: d.args?.[4]?.toString() };
  } catch {
    /* not a generic-swap selector */
  }
  const bd = tryDecodeLifiBridgeData(data);
  if (bd) return { cls: "bridge", bridge: bd.bridge, minAmount: bd.minAmount.toString() };
  return { cls: "unknown" };
}

async function main() {
  const results = {};

  // R1 + R3 + NIT-1 on the #685 pair: same-chain 15,000 USDC → USDT, ETH mainnet.
  const slippages = [0.001, 0.005, 0.02];
  const r1 = [];
  for (const s of slippages) {
    try {
      const q = await quote({
        fromChain: 1,
        toChain: 1,
        fromToken: USDC,
        toToken: USDT,
        fromAmount: "15000000000",
        slippage: s,
        order: "CHEAPEST",
      });
      const data = q.transactionRequest?.data;
      const dec = data ? decodedBakedMinOut(data) : { cls: "no-calldata" };
      // Run the real gate against the live quote (R5 reconciliation + confirms
      // no over-refusal on the live #685 pair).
      let verdict = "n/a";
      if (data && classifyLifiQuote(data) === "generic") {
        verdict = vetGenericSwapQuote(q, q.action.fromToken.address);
      }
      r1.push({
        slippage: s,
        tool: q.tool,
        toAmount: q.estimate?.toAmount,
        toAmountMin: q.estimate?.toAmountMin,
        decoded: dec,
        // R3: structured toAmountMin vs decoded calldata baked min-out.
        r3_match: dec.cls === "generic" ? dec.minOut === q.estimate?.toAmountMin : "n/a-bridge",
        gate_verdict: verdict,
      });
    } catch (e) {
      r1.push({ slippage: s, error: String(e).slice(0, 200) });
    }
  }
  results.r1_r3_usdc_usdt = r1;

  // NIT-1: sample a few same-chain pairs to see if any classify as "unknown".
  const nitPairs = [
    { name: "USDC→WETH eth", fromChain: 1, toChain: 1, fromToken: USDC, toToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", fromAmount: "1000000000" },
    { name: "USDC→USDT arb", fromChain: 42161, toChain: 42161, fromToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", toToken: "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", fromAmount: "1000000000" },
    { name: "WETH→USDC base", fromChain: 8453, toChain: 8453, fromToken: "0x4200000000000000000000000000000000000006", toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fromAmount: "1000000000000000000" },
  ];
  const nit = [];
  for (const p of nitPairs) {
    try {
      const q = await quote({ ...p, slippage: 0.005 });
      const data = q.transactionRequest?.data;
      const dec = data ? decodedBakedMinOut(data) : { cls: "no-calldata" };
      let verdict = "n/a";
      if (data && dec.cls === "generic") verdict = vetGenericSwapQuote(q, q.action.fromToken.address);
      else if (data && dec.cls === "bridge") verdict = { bridgeFlagged: bridgeSuspectedUnreachable(q, q.action.fromToken.address) };
      nit.push({ pair: p.name, tool: q.tool, selector: data?.slice(0, 10), class: dec.cls, gate_verdict: verdict });
    } catch (e) {
      nit.push({ pair: p.name, error: String(e).slice(0, 200) });
    }
  }
  results.nit1_samechain_classification = nit;

  // R6: a live cross-chain bridge quote — confirm it classifies as "bridge" and
  // the source-side-only predicate runs on real BridgeData without error.
  const bridges = [];
  const bridgePairs = [
    { name: "USDC eth→arb", fromChain: 1, toChain: 42161, fromToken: USDC, toToken: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", fromAmount: "15000000000" },
    { name: "USDC eth→base", fromChain: 1, toChain: 8453, fromToken: USDC, toToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", fromAmount: "15000000000" },
  ];
  for (const p of bridgePairs) {
    try {
      const q = await quote({ ...p, slippage: 0.005 });
      const data = q.transactionRequest?.data;
      const cls = data ? classifyLifiQuote(data) : "no-calldata";
      const bd = data ? tryDecodeLifiBridgeData(data) : null;
      bridges.push({
        pair: p.name,
        tool: q.tool,
        selector: data?.slice(0, 10),
        class: cls,
        bridgeSendingAsset: bd?.sendingAssetId,
        bridgeMinAmount: bd?.minAmount?.toString(),
        actionFromAmount: q.action?.fromAmount,
        suspectedUnreachable:
          cls === "bridge" ? bridgeSuspectedUnreachable(q, q.action.fromToken.address) : "n/a",
      });
    } catch (e) {
      bridges.push({ pair: p.name, error: String(e).slice(0, 200) });
    }
  }
  results.r6_live_bridge = bridges;

  console.log(JSON.stringify(results, null, 2));
}

main().catch((e) => {
  console.error("PROBE FAILED:", e);
  process.exit(1);
});
