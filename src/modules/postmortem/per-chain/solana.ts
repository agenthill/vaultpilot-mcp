/**
 * Solana `explain_tx` implementation.
 *
 * Uses Connection.getParsedTransaction (commitment: confirmed) which
 * returns:
 *   - `transaction.message.accountKeys[]` — every involved pubkey.
 *   - `transaction.message.instructions[]` — top-level instructions
 *     (already parsed for native programs: System / SPL Token / ATA /
 *     Stake; raw `data + accounts` for custom programs).
 *   - `meta.preBalances[]` / `meta.postBalances[]` — per-key SOL deltas.
 *   - `meta.preTokenBalances[]` / `meta.postTokenBalances[]` — per-
 *     ATA SPL deltas with `owner` and `mint` already resolved.
 *   - `meta.fee` — paid by the fee-payer (accountKeys[0]).
 *   - `meta.err` — null on success, otherwise a structured error.
 *
 * Solana's pre/post balance vectors are the canonical source of "what
 * actually happened" — they reflect the net effect of every CPI in
 * the tx, including ones we'd miss by walking instructions alone.
 * Step rows surface the top-level instruction labels for narrative
 * context, but balance changes use the post-pre delta path.
 */

import type {
  ParsedInstruction,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
} from "@solana/web3.js";
import { getSolanaConnection } from "../../solana/rpc.js";
import {
  SOL_SYMBOL,
  SOL_DECIMALS,
  SOLANA_TOKENS,
  SOLANA_TOKEN_DECIMALS,
} from "../../../config/solana.js";
import { lookupProgram } from "../../solana/program-ids.js";
import { formatUnits } from "../../../data/format.js";
import { getDefillamaCoinPrice } from "../../../data/prices.js";
import type {
  ExplainTxApprovalChange,
  ExplainTxBalanceChange,
  ExplainTxResult,
  ExplainTxStep,
} from "../schemas.js";

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";

/** Reverse map: mint → { symbol, decimals }. */
const MINT_TO_SYMBOL: Record<string, { symbol: string; decimals: number }> =
  Object.fromEntries(
    (Object.entries(SOLANA_TOKENS) as [keyof typeof SOLANA_TOKENS, string][]).map(
      ([sym, addr]) => [
        addr,
        { symbol: sym, decimals: SOLANA_TOKEN_DECIMALS[sym] },
      ],
    ),
  );

export interface SolanaPostmortemArgs {
  signature: string;
  /**
   * Wallet to compute balance changes from. Defaults to fee payer
   * (accountKeys[0]).
   */
  perspective?: string;
}

/**
 * Render a top-level instruction into a label + detail pair for the
 * `steps[]` array. Native-program instructions (System / SPL Token /
 * ATA / Stake) come back from getParsedTransaction with a `parsed.type`
 * + `parsed.info` payload; custom programs come back as
 * PartiallyDecodedInstruction with `data + accounts` raw fields.
 */
function describeInstruction(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
): { label: string; detail: string; programOrContract?: string } | null {
  const programId = ix.programId.toBase58();
  if (programId === COMPUTE_BUDGET_PROGRAM) {
    // Skip — pure tx-fee tuning, not user-relevant for narrative.
    return null;
  }
  // Parsed (native) instruction — has `.parsed`.
  if ("parsed" in ix && ix.parsed && typeof ix.parsed === "object") {
    const parsed = ix.parsed as { type?: string; info?: Record<string, unknown> };
    const type = parsed.type ?? "unknown";
    const program = ix.program ?? programId;
    let detail = "";
    const info = parsed.info ?? {};
    if (programId === SYSTEM_PROGRAM && type === "transfer") {
      const lamports = BigInt((info.lamports as number) ?? 0);
      const sol = formatUnits(lamports, SOL_DECIMALS);
      detail = `${sol} SOL from ${info.source} to ${info.destination}`;
    } else if (programId === SYSTEM_PROGRAM && type === "createAccount") {
      detail = `Create account ${info.newAccount} (${(info.space as number) ?? 0} bytes, ${formatUnits(BigInt((info.lamports as number) ?? 0), SOL_DECIMALS)} SOL rent)`;
    } else if (
      (programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) &&
      type === "transferChecked"
    ) {
      const tokenAmount = info.tokenAmount as
        | { uiAmountString?: string; amount?: string }
        | undefined;
      detail = `${tokenAmount?.uiAmountString ?? tokenAmount?.amount ?? "?"} of mint ${info.mint} from ${info.source} to ${info.destination}`;
    } else if (
      (programId === SPL_TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM) &&
      type === "transfer"
    ) {
      detail = `${(info.amount as string | number | undefined) ?? "?"} (raw) from ${info.source} to ${info.destination}`;
    } else if (programId === ATA_PROGRAM) {
      detail = `Create associated token account for owner ${info.wallet} mint ${info.mint}`;
    } else {
      detail = JSON.stringify(parsed.info ?? {}).slice(0, 200);
    }
    return {
      label: `${program}::${type}`,
      detail,
      programOrContract: programId,
    };
  }
  // Custom program — surface a friendly name when known.
  const known = lookupProgram(programId);
  const partiallyDecoded = ix as PartiallyDecodedInstruction;
  const data = partiallyDecoded.data ?? "";
  const accountCount = (partiallyDecoded.accounts ?? []).length;
  return {
    label: known?.name ?? `program ${programId.slice(0, 8)}…`,
    detail: `Custom program call: ${accountCount} account(s), ${data.length} bytes of data.`,
    programOrContract: programId,
  };
}

export async function solanaPostmortem(
  args: SolanaPostmortemArgs,
): Promise<Omit<ExplainTxResult, "narrative"> & { summary: string }> {
  const conn = getSolanaConnection();
  const tx = await conn.getParsedTransaction(args.signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });
  if (!tx) {
    throw new Error(
      `Solana tx ${args.signature} not visible. May be unconfirmed, dropped, or the signature is wrong.`,
    );
  }

  const accountKeys = tx.transaction.message.accountKeys.map((k) =>
    k.pubkey.toBase58(),
  );
  const feePayer = accountKeys[0];
  const perspective = args.perspective ?? feePayer;
  const status: "success" | "failed" = tx.meta?.err == null ? "success" : "failed";

  // Build steps from top-level instructions.
  const steps: ExplainTxStep[] = [];
  for (const ix of tx.transaction.message.instructions) {
    const desc = describeInstruction(ix);
    if (!desc) continue;
    steps.push({
      kind: "instruction",
      label: desc.label,
      detail: desc.detail,
      ...(desc.programOrContract
        ? { programOrContract: desc.programOrContract }
        : {}),
    });
  }

  // Pick a "to" — the first non-native, non-ComputeBudget program is
  // the usual target; falls back to System program for pure transfers.
  const programIds = new Set<string>();
  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId.toBase58();
    if (pid !== COMPUTE_BUDGET_PROGRAM) programIds.add(pid);
  }
  const nativePrograms = new Set([
    SYSTEM_PROGRAM,
    SPL_TOKEN_PROGRAM,
    TOKEN_2022_PROGRAM,
    ATA_PROGRAM,
  ]);
  const nonNative = [...programIds].find((p) => !nativePrograms.has(p));
  const to = nonNative ?? [...programIds][0];

  // Native-SOL delta for perspective.
  const balanceDeltas = new Map<
    string,
    { delta: bigint; symbol: string; decimals: number }
  >();
  const perspectiveIdx = accountKeys.indexOf(perspective);
  if (
    perspectiveIdx >= 0 &&
    tx.meta?.preBalances &&
    tx.meta?.postBalances &&
    perspectiveIdx < tx.meta.preBalances.length &&
    perspectiveIdx < tx.meta.postBalances.length
  ) {
    const pre = BigInt(tx.meta.preBalances[perspectiveIdx]);
    const post = BigInt(tx.meta.postBalances[perspectiveIdx]);
    const delta = post - pre;
    if (delta !== 0n) {
      balanceDeltas.set("native", {
        delta,
        symbol: SOL_SYMBOL,
        decimals: SOL_DECIMALS,
      });
    }
  }

  // SPL deltas: aggregate by mint, owner === perspective.
  const preTokens = tx.meta?.preTokenBalances ?? [];
  const postTokens = tx.meta?.postTokenBalances ?? [];
  type Sum = { preRaw: bigint; postRaw: bigint; decimals: number; symbol: string };
  const byMint = new Map<string, Sum>();
  for (const b of preTokens) {
    if (b.owner !== perspective) continue;
    const entry = byMint.get(b.mint) ?? {
      preRaw: 0n,
      postRaw: 0n,
      decimals: b.uiTokenAmount?.decimals ?? 0,
      symbol: MINT_TO_SYMBOL[b.mint]?.symbol ?? "UNKNOWN",
    };
    entry.preRaw += BigInt(b.uiTokenAmount?.amount ?? "0");
    byMint.set(b.mint, entry);
  }
  for (const b of postTokens) {
    if (b.owner !== perspective) continue;
    const entry = byMint.get(b.mint) ?? {
      preRaw: 0n,
      postRaw: 0n,
      decimals: b.uiTokenAmount?.decimals ?? 0,
      symbol: MINT_TO_SYMBOL[b.mint]?.symbol ?? "UNKNOWN",
    };
    entry.postRaw += BigInt(b.uiTokenAmount?.amount ?? "0");
    byMint.set(b.mint, entry);
  }
  for (const [mint, sum] of byMint) {
    const delta = sum.postRaw - sum.preRaw;
    if (delta === 0n) continue;
    balanceDeltas.set(mint, {
      delta,
      symbol: sum.symbol,
      decimals: sum.decimals,
    });
  }

  // Pricing.
  const solPriceEntry = await getDefillamaCoinPrice("solana").catch(
    () => undefined,
  );
  const solPrice = solPriceEntry?.price;

  const balanceChanges: ExplainTxBalanceChange[] = [];
  for (const [token, info] of balanceDeltas) {
    const formatted = formatUnits(info.delta, info.decimals);
    const num = Number(formatted);
    let priceUsd: number | undefined;
    if (token === "native") priceUsd = solPrice;
    balanceChanges.push({
      symbol: info.symbol,
      token,
      delta: formatted,
      deltaApprox: num,
      ...(priceUsd !== undefined && Number.isFinite(num)
        ? { valueUsd: round2(num * priceUsd) }
        : {}),
    });
  }

  // Approval changes — Solana doesn't have ERC-20-style approvals as a
  // common surface. SPL Token's `approve` instruction exists (delegate
  // pattern) but is rarely used in retail flows; surfacing it requires
  // walking the parsed `approve`/`approveChecked` info. v1 deferred —
  // leave empty.
  const approvalChanges: ExplainTxApprovalChange[] = [];

  // Fee.
  const feeLamports = BigInt(tx.meta?.fee ?? 0);
  const feeNative = formatUnits(feeLamports, SOL_DECIMALS);
  const feeUsd =
    solPrice !== undefined && Number.isFinite(Number(feeNative))
      ? round2(Number(feeNative) * solPrice)
      : undefined;

  // Block time.
  const blockTimeIso = tx.blockTime
    ? new Date(tx.blockTime * 1000).toISOString()
    : undefined;

  let summary: string;
  if (status === "failed") {
    const errStr = JSON.stringify(tx.meta?.err ?? "unknown").slice(0, 100);
    summary = `Solana tx FAILED (${errStr}). ${feeNative} SOL paid as fee.`;
  } else if (programIds.has(SYSTEM_PROGRAM) && programIds.size === 1) {
    summary = `Native SOL transfer on Solana.`;
  } else if (
    (programIds.has(SPL_TOKEN_PROGRAM) ||
      programIds.has(TOKEN_2022_PROGRAM)) &&
    [...programIds].every((p) =>
      [SYSTEM_PROGRAM, SPL_TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ATA_PROGRAM].includes(
        p,
      ),
    )
  ) {
    summary = `SPL token transfer on Solana.`;
  } else if (nonNative) {
    const known = lookupProgram(nonNative);
    summary = `Solana program call to ${known?.name ?? nonNative.slice(0, 12) + "…"}.`;
  } else {
    summary = `Solana transaction (${steps.length} top-level instruction(s)).`;
  }

  return {
    chain: "solana",
    hash: args.signature,
    from: feePayer,
    ...(to ? { to } : {}),
    perspective,
    blockNumber: tx.slot.toString(),
    ...(blockTimeIso ? { blockTimeIso } : {}),
    status,
    feeNative,
    feeNativeSymbol: SOL_SYMBOL,
    ...(feeUsd !== undefined ? { feeUsd } : {}),
    summary,
    steps,
    balanceChanges,
    approvalChanges,
    heuristics: [],
    notes: [],
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
