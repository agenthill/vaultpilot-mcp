/**
 * `explain_tx` — narrative post-mortem for a single transaction.
 *
 * Dispatches per chain:
 *   - EVM (Ethereum / Arbitrum / Polygon / Base / Optimism) →
 *     `evmPostmortem` (viem RPC).
 *   - TRON → `tronPostmortem` (TronGrid POST endpoints).
 *   - Solana → `solanaPostmortem` (web3.js getParsedTransaction).
 *   - Bitcoin → out of v1 scope (return a stub error).
 *
 * Each per-chain helper produces an `ExplainTxResult` minus the
 * heuristics + narrative; the dispatcher applies those uniformly so
 * the rules and rendering are consistent across chains.
 */

import { isEvmChain, type AnyChain, type SupportedChain } from "../../types/index.js";
import { evmPostmortem } from "./per-chain/evm.js";
import { tronPostmortem } from "./per-chain/tron.js";
import { solanaPostmortem } from "./per-chain/solana.js";
import { applyHeuristics } from "./heuristics.js";
import { renderPostmortemNarrative } from "./render.js";
import type { ExplainTxArgs, ExplainTxResult } from "./schemas.js";

export async function explainTx(
  args: ExplainTxArgs,
): Promise<ExplainTxResult> {
  const chain = args.chain as AnyChain;

  let core: Omit<ExplainTxResult, "narrative">;

  if (isEvmChain(chain)) {
    const evmChain = chain as SupportedChain;
    const hash = (
      args.hash.startsWith("0x") ? args.hash : `0x${args.hash}`
    ) as `0x${string}`;
    core = await evmPostmortem({
      chain: evmChain,
      hash,
      ...(args.wallet ? { perspective: args.wallet as `0x${string}` } : {}),
    });
  } else if (chain === "tron") {
    core = await tronPostmortem({
      hash: args.hash,
      ...(args.wallet ? { perspective: args.wallet } : {}),
    });
  } else if (chain === "solana") {
    core = await solanaPostmortem({
      signature: args.hash,
      ...(args.wallet ? { perspective: args.wallet } : {}),
    });
  } else {
    throw new Error(
      `explain_tx does not yet support chain "${chain}". v1 covers EVM ` +
        `(Ethereum / Arbitrum / Polygon / Base / Optimism), TRON, and Solana. ` +
        `Bitcoin is deferred to v2 — needs a separate UTXO post-mortem path.`,
    );
  }

  // Apply heuristics + add the v1 caveats.
  const heuristics = applyHeuristics(core);
  const notes = [
    ...core.notes,
    "v1 covers top-level execution only — internal calls / CPI / multi-hop " +
      "DeFi compositions show up only via their balance/approval effects, not " +
      "as separate steps. Full call-graph trace deferred.",
    "Pricing is current spot via DefiLlama, not historical at tx time. For " +
      "fresh txs the difference is sub-second; for older txs prices may have " +
      "drifted materially.",
  ];

  const result: ExplainTxResult = {
    ...core,
    heuristics,
    notes,
  };

  if (args.format !== "structured") {
    result.narrative = renderPostmortemNarrative(result);
  }

  return result;
}
