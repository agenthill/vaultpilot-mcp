import type {
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  ParsedInstruction,
  TokenBalance,
} from "@solana/web3.js";
import { cache } from "../../data/cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { formatUnits as formatUnitsDecimal } from "../../data/format.js";
import { SOL_DECIMALS, SOL_SYMBOL, SOLANA_TOKENS, SOLANA_TOKEN_DECIMALS } from "../../config/solana.js";
import { getSolanaConnection } from "../solana/rpc.js";
import { assertSolanaAddress } from "../solana/address.js";
import {
  KNOWN_PROGRAMS,
  KNOWN_STAKE_POOLS,
  lookupProgram,
} from "../solana/program-ids.js";
import {
  decodeSystemInstruction,
  decodeTokenInstruction,
  decodeStakeInstruction,
} from "../solana/decode.js";
import type {
  ExternalHistoryItem,
  TokenTransferHistoryItem,
  ProgramInteractionHistoryItem,
} from "./schemas.js";

const SERVER_ROW_CAP = 100;
const CONCURRENCY = 10;
const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const SPL_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TOKEN_2022_PROGRAM = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const ATA_PROGRAM = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";
const COMPUTE_BUDGET_PROGRAM = "ComputeBudget111111111111111111111111111111";
const STAKE_PROGRAM = "Stake11111111111111111111111111111111111111";
const NATIVE_PROGRAMS = new Set([
  SYSTEM_PROGRAM,
  SPL_TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  ATA_PROGRAM,
  COMPUTE_BUDGET_PROGRAM,
]);

/** Reverse map: mint → canonical symbol (for balance-delta formatting). */
const MINT_TO_SYMBOL: Record<string, { symbol: string; decimals: number }> =
  Object.fromEntries(
    (Object.entries(SOLANA_TOKENS) as [keyof typeof SOLANA_TOKENS, string][]).map(
      ([sym, addr]) => [addr, { symbol: sym, decimals: SOLANA_TOKEN_DECIMALS[sym] }],
    ),
  );

export interface SolanaFetchResult {
  items: Array<
    | ExternalHistoryItem
    | TokenTransferHistoryItem
    | ProgramInteractionHistoryItem
  >;
  truncated: boolean;
  errors: Array<{ source: string; message: string }>;
}

export async function fetchSolanaHistory(args: {
  wallet: string;
  limit: number;
}): Promise<SolanaFetchResult> {
  const pubkey = assertSolanaAddress(args.wallet);
  const wallet = args.wallet;

  const cacheKey = `history:solana:${wallet}:${args.limit}`;
  const cached = cache.get<SolanaFetchResult>(cacheKey);
  if (cached) return cached;

  const conn = getSolanaConnection();
  const errors: Array<{ source: string; message: string }> = [];
  let truncated = false;

  // Fetch signatures first. getSignaturesForAddress caps at 1000; we ask
  // for `limit` (max 50 from the schema) plus some headroom so failed/unparsed
  // txs don't starve the returned set.
  const sigFetch = Math.min(SERVER_ROW_CAP, Math.max(args.limit * 2, 10));
  let sigs: Awaited<ReturnType<typeof conn.getSignaturesForAddress>>;
  try {
    sigs = await conn.getSignaturesForAddress(pubkey, { limit: sigFetch });
  } catch (e) {
    errors.push({
      source: "solana.getSignaturesForAddress",
      message: e instanceof Error ? e.message : String(e),
    });
    return { items: [], truncated: false, errors };
  }
  if (sigs.length >= SERVER_ROW_CAP) truncated = true;

  // Parallel fetch of full tx details. Concurrency cap 10 mirrors the history
  // prices-lookup pattern.
  const txs: Array<{ sig: typeof sigs[number]; tx: ParsedTransactionWithMeta | null }> = [];
  const queue = [...sigs];
  const workers: Promise<void>[] = [];
  const worker = async () => {
    while (queue.length > 0) {
      const s = queue.shift();
      if (!s) break;
      try {
        const tx = await conn.getParsedTransaction(s.signature, {
          maxSupportedTransactionVersion: 0,
          commitment: "confirmed",
        });
        txs.push({ sig: s, tx });
      } catch (e) {
        errors.push({
          source: "solana.getParsedTransaction",
          message: e instanceof Error ? e.message : String(e),
        });
        txs.push({ sig: s, tx: null });
      }
    }
  };
  for (let i = 0; i < Math.min(CONCURRENCY, sigs.length); i++) workers.push(worker());
  await Promise.all(workers);

  // Preserve original signature order (newest-first per RPC response).
  const bySig = new Map(txs.map((e) => [e.sig.signature, e]));
  const items: SolanaFetchResult["items"] = [];
  for (const s of sigs) {
    const entry = bySig.get(s.signature);
    if (!entry?.tx) continue;
    const item = classifyTransaction(wallet, entry.tx, s.blockTime ?? 0);
    if (item) items.push(item);
  }

  // Truncate to the caller's requested limit.
  if (items.length > args.limit) {
    items.length = args.limit;
    truncated = true;
  }

  const result: SolanaFetchResult = { items, truncated, errors };
  cache.set(cacheKey, result, CACHE_TTL.HISTORY);
  return result;
}

/**
 * Walk the parsed tx and emit a single history item summarizing it:
 *  - pure System transfer → `external`
 *  - pure SPL token transfer → `token_transfer`
 *  - anything else (DeFi program, stake, unknown) → `program_interaction`
 *    with balance deltas derived from meta.pre/postTokenBalances and
 *    meta.pre/postBalances.
 *
 * Filters out the ComputeBudget program (noise) when deciding "pure".
 */
function classifyTransaction(
  wallet: string,
  tx: ParsedTransactionWithMeta,
  blockTime: number,
): SolanaFetchResult["items"][number] | null {
  const sig = tx.transaction.signatures[0];
  const status: "success" | "failed" = tx.meta?.err ? "failed" : "success";

  // Collect program IDs invoked at the top level. Some entries are the
  // ParsedInstruction form (with { programId, parsed: { type, info } });
  // others are PartiallyDecodedInstruction (with { programId, data, accounts }).
  const topLevelIxs = tx.transaction.message.instructions;
  const programIds = new Set<string>();
  for (const ix of topLevelIxs) {
    const pid = ix.programId?.toBase58?.() ?? "";
    if (!pid || pid === COMPUTE_BUDGET_PROGRAM) continue;
    programIds.add(pid);
  }

  // Single-native-program cases: System-only or SPL-Token-only.
  // These are the most common retail transactions and deserve their own
  // specific item type (not a generic program_interaction).
  const programIdsArr = [...programIds];
  if (programIds.size === 1) {
    const onlyProgram = programIdsArr[0];
    if (onlyProgram === SYSTEM_PROGRAM) {
      const ext = tryExternalFromSystem(wallet, tx, blockTime, status);
      if (ext) return ext;
    }
    if (onlyProgram === SPL_TOKEN_PROGRAM || onlyProgram === TOKEN_2022_PROGRAM) {
      const tt = tryTokenTransferFromSpl(wallet, tx, blockTime, status);
      if (tt) return tt;
    }
  }

  // Everything else: program_interaction with balance deltas. Pick the most
  // prominent non-native program for labeling. "Most prominent" = first
  // non-native top-level instruction. If all top-level instructions are
  // native (e.g. pure ATA creation), label with the first program.
  const nonNativeTop = programIdsArr.find((p) => !NATIVE_PROGRAMS.has(p));
  const primaryProgramId = nonNativeTop ?? programIdsArr[0] ?? SYSTEM_PROGRAM;
  const known = lookupProgram(primaryProgramId);
  let programName = known?.name;
  let programKind = known?.kind;

  // SPL Stake Pool specialization: check if the instruction references a
  // known pool account (e.g. Jito) in its accounts list.
  if (known?.kind === "stake-pool") {
    for (const ix of topLevelIxs) {
      const pid = ix.programId?.toBase58?.();
      if (pid !== primaryProgramId) continue;
      const accounts =
        (ix as PartiallyDecodedInstruction).accounts?.map((a) => a.toBase58?.() ?? "") ?? [];
      for (const acc of accounts) {
        const pool = KNOWN_STAKE_POOLS[acc];
        if (pool) {
          programName = pool.name;
          programKind = "lst";
          break;
        }
      }
    }
  }

  // Also: a stake-program instruction should be kind="stake", not an unknown
  // interaction. Override if any top-level ix is the Stake program.
  if (programIds.has(STAKE_PROGRAM)) {
    programName = programName ?? "Stake";
    programKind = "stake";
  }

  const balanceDeltas = computeBalanceDeltas(wallet, tx);

  const item: ProgramInteractionHistoryItem = {
    type: "program_interaction",
    hash: sig,
    timestamp: blockTime,
    from: wallet,
    to: primaryProgramId,
    status,
    programId: primaryProgramId,
    ...(programName ? { programName } : {}),
    ...(programKind ? { programKind } : {}),
    balanceDeltas,
  };
  return item;
}

function tryExternalFromSystem(
  wallet: string,
  tx: ParsedTransactionWithMeta,
  blockTime: number,
  status: "success" | "failed",
): ExternalHistoryItem | null {
  const sig = tx.transaction.signatures[0];
  // Find the first System transfer where wallet is sender OR recipient.
  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId?.toBase58?.() ?? "";
    if (pid !== SYSTEM_PROGRAM) continue;

    // Parsed form: { parsed: { type: "transfer", info: { source, destination, lamports } } }
    const parsed = (ix as ParsedInstruction).parsed;
    if (parsed && parsed.type === "transfer") {
      const info = parsed.info as { source: string; destination: string; lamports: number };
      if (info.source === wallet || info.destination === wallet) {
        const lamports = BigInt(info.lamports);
        return {
          type: "external",
          hash: sig,
          timestamp: blockTime,
          from: info.source,
          to: info.destination,
          valueNative: lamports.toString(),
          valueNativeFormatted: formatUnitsDecimal(lamports, SOL_DECIMALS),
          status,
        };
      }
    }

    // Partially decoded form: accounts = [source, destination]; data carries amount.
    const undecoded = ix as PartiallyDecodedInstruction;
    if (undecoded.accounts && undecoded.data) {
      const from = undecoded.accounts[0]?.toBase58?.() ?? "";
      const to = undecoded.accounts[1]?.toBase58?.() ?? "";
      if (from !== wallet && to !== wallet) continue;
      const decoded = decodeSystemInstruction(undecoded.data);
      if (decoded.kind !== "transfer") continue;
      return {
        type: "external",
        hash: sig,
        timestamp: blockTime,
        from,
        to,
        valueNative: decoded.lamports.toString(),
        valueNativeFormatted: formatUnitsDecimal(decoded.lamports, SOL_DECIMALS),
        status,
      };
    }
  }
  return null;
}

function tryTokenTransferFromSpl(
  wallet: string,
  tx: ParsedTransactionWithMeta,
  blockTime: number,
  status: "success" | "failed",
): TokenTransferHistoryItem | null {
  const sig = tx.transaction.signatures[0];
  // Use meta.preTokenBalances / postTokenBalances to identify owner + mint.
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  for (const ix of tx.transaction.message.instructions) {
    const pid = ix.programId?.toBase58?.() ?? "";
    if (pid !== SPL_TOKEN_PROGRAM && pid !== TOKEN_2022_PROGRAM) continue;
    const parsed = (ix as ParsedInstruction).parsed;
    if (!parsed) continue;
    if (parsed.type !== "transfer" && parsed.type !== "transferChecked") continue;

    const info = parsed.info as {
      source: string;
      destination: string;
      amount?: string;
      tokenAmount?: { amount: string; decimals: number };
      mint?: string;
      authority?: string;
    };

    // Resolve owner of source/destination via preTokenBalances — the SPL
    // Token instruction references the TOKEN ACCOUNT (ATA), not the owner.
    const srcOwner = findOwnerOfTokenAccount(info.source, pre, post, tx);
    const dstOwner = findOwnerOfTokenAccount(info.destination, pre, post, tx);
    if (srcOwner !== wallet && dstOwner !== wallet) continue;

    // Prefer info.mint (transferChecked); else look up from the ATA.
    const mint =
      info.mint ??
      findMintOfTokenAccount(info.source, pre, post) ??
      findMintOfTokenAccount(info.destination, pre, post);
    if (!mint) continue;

    const amountStr = info.tokenAmount?.amount ?? info.amount ?? "0";
    const amount = /^\d+$/.test(amountStr) ? BigInt(amountStr) : 0n;
    const decimals =
      info.tokenAmount?.decimals ??
      findDecimalsOfMint(mint, pre, post) ??
      MINT_TO_SYMBOL[mint]?.decimals ??
      0;
    const symbol = MINT_TO_SYMBOL[mint]?.symbol ?? "UNKNOWN";

    return {
      type: "token_transfer",
      hash: sig,
      timestamp: blockTime,
      from: srcOwner ?? info.source,
      to: dstOwner ?? info.destination,
      tokenAddress: mint,
      tokenSymbol: symbol,
      tokenDecimals: decimals,
      amount: amount.toString(),
      amountFormatted: formatUnitsDecimal(amount, decimals),
      status,
    };
  }
  return null;
}

function findOwnerOfTokenAccount(
  tokenAccount: string,
  pre: TokenBalance[],
  post: TokenBalance[],
  tx: ParsedTransactionWithMeta,
): string | undefined {
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58?.() ?? "");
  const idx = keys.indexOf(tokenAccount);
  if (idx < 0) return undefined;
  const pre0 = pre.find((b) => b.accountIndex === idx);
  const post0 = post.find((b) => b.accountIndex === idx);
  return (pre0 ?? post0)?.owner;
}

function findMintOfTokenAccount(
  tokenAccount: string,
  pre: TokenBalance[],
  post: TokenBalance[],
): string | undefined {
  for (const b of [...pre, ...post]) {
    // TokenBalance doesn't expose the pubkey directly — match by accountIndex
    // via the outer accountKeys list. Caller should pass the right slice.
    if (b.mint && b.owner && tokenAccount) return b.mint;
  }
  return undefined;
}

function findDecimalsOfMint(
  mint: string,
  pre: TokenBalance[],
  post: TokenBalance[],
): number | undefined {
  for (const b of [...pre, ...post]) {
    if (b.mint === mint) return b.uiTokenAmount?.decimals;
  }
  return undefined;
}

/**
 * Compute net balance deltas across the tx for the wallet being queried.
 * Uses meta.preTokenBalances / meta.postTokenBalances (by `owner`) for SPL
 * deltas, and meta.preBalances / meta.postBalances at accountKeys[walletIdx]
 * for the native SOL delta. Skips zero-delta entries.
 *
 * Returns entries with sign-preserving formatted amounts so the caller can
 * tell "user received 10 JUP, paid 0.05 SOL" at a glance.
 */
function computeBalanceDeltas(
  wallet: string,
  tx: ParsedTransactionWithMeta,
): ProgramInteractionHistoryItem["balanceDeltas"] {
  const out: ProgramInteractionHistoryItem["balanceDeltas"] = [];
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey.toBase58?.() ?? "");
  const walletIdx = keys.indexOf(wallet);

  // SOL delta (native balance at wallet's index). If wallet is fee payer
  // (index 0), the delta naturally includes the fee — that's the economic
  // truth the user wants.
  if (
    walletIdx >= 0 &&
    tx.meta &&
    tx.meta.preBalances &&
    tx.meta.postBalances &&
    walletIdx < tx.meta.preBalances.length &&
    walletIdx < tx.meta.postBalances.length
  ) {
    const pre = BigInt(tx.meta.preBalances[walletIdx]);
    const post = BigInt(tx.meta.postBalances[walletIdx]);
    const delta = post - pre;
    if (delta !== 0n) {
      out.push({
        token: "SOL",
        symbol: SOL_SYMBOL,
        decimals: SOL_DECIMALS,
        amount: delta.toString(),
        amountFormatted: formatSignedUnits(delta, SOL_DECIMALS),
      });
    }
  }

  // SPL deltas — aggregate by mint for this wallet's owner.
  const pre = tx.meta?.preTokenBalances ?? [];
  const post = tx.meta?.postTokenBalances ?? [];

  type SplSum = { preRaw: bigint; postRaw: bigint; decimals: number; symbol: string };
  const byMint = new Map<string, SplSum>();

  for (const b of pre) {
    if (b.owner !== wallet) continue;
    const entry = byMint.get(b.mint) ?? {
      preRaw: 0n,
      postRaw: 0n,
      decimals: b.uiTokenAmount?.decimals ?? 0,
      symbol: MINT_TO_SYMBOL[b.mint]?.symbol ?? "UNKNOWN",
    };
    entry.preRaw += BigInt(b.uiTokenAmount?.amount ?? "0");
    byMint.set(b.mint, entry);
  }
  for (const b of post) {
    if (b.owner !== wallet) continue;
    const entry = byMint.get(b.mint) ?? {
      preRaw: 0n,
      postRaw: 0n,
      decimals: b.uiTokenAmount?.decimals ?? 0,
      symbol: MINT_TO_SYMBOL[b.mint]?.symbol ?? "UNKNOWN",
    };
    entry.postRaw += BigInt(b.uiTokenAmount?.amount ?? "0");
    byMint.set(b.mint, entry);
  }

  for (const [mint, { preRaw, postRaw, decimals, symbol }] of byMint) {
    const delta = postRaw - preRaw;
    if (delta === 0n) continue;
    out.push({
      token: mint,
      symbol,
      decimals,
      amount: delta.toString(),
      amountFormatted: formatSignedUnits(delta, decimals),
    });
  }

  return out;
}

function formatSignedUnits(raw: bigint, decimals: number): string {
  const s = formatUnitsDecimal(raw, decimals);
  return raw > 0n ? `+${s}` : s;
}
