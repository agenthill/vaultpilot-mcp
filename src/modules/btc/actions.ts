import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { assertBitcoinAddress, type BitcoinAddressType } from "./address.js";
import { assertNoDrainerPattern } from "../../security/drainer-pattern.js";
import { getBitcoinIndexer } from "./indexer.js";
import { selectInputs, type CoinSelectInput } from "../shared/utxo-coin-select.js";
import { issueBitcoinHandle } from "../../signing/btc-tx-store.js";
import {
  getPairedBtcByAddress,
  getPairedBtcAddresses,
  type BtcAddressType as PairedBtcAddressType,
} from "../../signing/btc-usb-signer.js";
import type { UnsignedBitcoinTx } from "../../types/index.js";
import { BTC_DECIMALS, SATS_PER_BTC } from "../../config/btc.js";

/**
 * Bitcoin native-send builder. Mirrors `buildTronNativeSend` /
 * `buildSolanaNativeSend` in shape: takes high-level args, fetches
 * UTXOs + fee estimates from the indexer, runs coin-selection, builds a
 * PSBT v0 via `bitcoinjs-lib`, and returns an `UnsignedBitcoinTx`
 * registered with the in-memory tx-store. The Ledger BTC app consumes
 * the PSBT bytes at signing time via `signPsbtBuffer`.
 *
 * Multi-source consolidation (issue #264). `wallet` accepts either a
 * single address or an array of paired source addresses; UTXOs from
 * every listed source are fetched in parallel, merged into one
 * coin-selection pool, and assembled into a single multi-input PSBT
 * with one output (plus change). Phase 1 scope keeps all sources within
 * the SAME Ledger account (same accountIndex + addressType) — mixed-
 * type sends (segwit + taproot in one tx) are protocol-supported but
 * out of scope here. The wallet-policy descriptor `wpkh(@0/**)` /
 * `tr(@0/**)` Ledger registers at pairing time covers every chain=0/1
 * descendant under the account, so multi-derivation PSBTs sign
 * natively without any per-tx policy ceremony.
 *
 * Change derivation (issue #254). Change goes to the BIP-44 internal
 * chain (`<purpose>'/0'/<account>'/1/<idx>`) of the source account,
 * looked up from the pairings cache (`pair_ledger_btc` derives the
 * first 20 chain=1 addresses per account during the gap-limit scan).
 * The change leaf's `path` and compressed `publicKey` are threaded
 * onto the unsigned tx envelope so the signer can register the change
 * output in `signPsbtBuffer.knownAddressDerivations` — the Ledger BTC
 * app then recognizes it as a same-account change output, labels it
 * "Change" on-screen, and skips the previous "unusual change path"
 * warning.
 *
 * For now the lowest available `addressIndex` (= 0) is used. Address
 * rotation across multiple sends in one session is out of scope for
 * this PR (each send currently reuses the same chain=1 address; the
 * Ledger app does not warn on address reuse).
 *
 * RBF — sequence `0xFFFFFFFD` on every input by default (BIP-125
 * replaceable). Pass `rbf: false` to set `0xFFFFFFFE` (final, not
 * replaceable). Locktime stays at 0.
 *
 * The PSBT is v0 (the only format `signPsbtBuffer` accepts). Every
 * input carries BOTH `witnessUtxo` (script + value, used by the segwit
 * sighash) AND `nonWitnessUtxo` (the full prev-tx hex). The latter is
 * mandatory on Ledger BTC app 2.x even for segwit/taproot inputs — the
 * device cryptographically verifies the input amount against the
 * prev-tx because BIP-143 sighash doesn't commit to input amount,
 * which is how a malicious offline signer could otherwise lie about
 * the input value to inflate the fee. Omitting it trips a
 * "Security risk: unverified inputs" device prompt and rejects with
 * 0x6985. Issue #213.
 */

const requireCjs = createRequire(import.meta.url);
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: new (opts?: { network?: unknown }) => {
    addInput(input: {
      hash: string | Buffer;
      index: number;
      sequence?: number;
      witnessUtxo?: { script: Buffer; value: number };
      nonWitnessUtxo?: Buffer;
    }): unknown;
    addOutput(output: { address?: string; script?: Buffer; value: number }): unknown;
    toBase64(): string;
  };
  address: {
    toOutputScript(address: string, network?: unknown): Buffer;
  };
  networks: { bitcoin: unknown };
};

const NETWORK = bitcoinjs.networks.bitcoin;

/**
 * Map BIP-32-purpose-to-our-paired-type. The source address's paired
 * entry tells us which BIP-44 purpose it lives under, which determines
 * the addressFormat passed to `signPsbtBuffer`.
 */
const ADDRESS_FORMAT_BY_TYPE: Record<
  PairedBtcAddressType,
  UnsignedBitcoinTx["addressFormat"]
> = {
  legacy: "legacy",
  "p2sh-segwit": "p2sh",
  segwit: "bech32",
  taproot: "bech32m",
};

/**
 * Bitcoin's `<purpose>'/0'/<account>'` account-level path (without the
 * trailing `change/index` leaf). `signPsbtBuffer` wants this so the
 * Ledger app can re-derive both receive and change leaves under it.
 */
function accountPathFromLeaf(leafPath: string): string {
  const parts = leafPath.split("/");
  if (parts.length < 5) {
    throw new Error(
      `Invalid Bitcoin leaf path "${leafPath}" — expected at least 5 segments ` +
        `(<purpose>'/0'/<account>'/<change>/<index>).`,
    );
  }
  return parts.slice(0, -2).join("/");
}

/** Estimate vbytes for a P2WPKH/P2TR tx — same shape coinselect uses. */
function roughVbytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}

/**
 * Pick the chain=1 (BIP-32 internal/change) entry from the pairings
 * cache that matches the source's (accountIndex, addressType). Lowest
 * `addressIndex` wins. Returns null when none is cached. Issue #254.
 */
function pickChangeEntry(
  paired: ReturnType<typeof getPairedBtcByAddress>,
): { address: string; path: string; publicKey: string } | null {
  if (!paired) return null;
  const all = getPairedBtcAddresses();
  const candidates = all
    .filter(
      (e) =>
        e.accountIndex === paired.accountIndex &&
        e.addressType === paired.addressType &&
        e.chain === 1 &&
        typeof e.addressIndex === "number",
    )
    .sort((a, b) => (a.addressIndex ?? 0) - (b.addressIndex ?? 0));
  const c = candidates[0];
  if (!c) return null;
  return { address: c.address, path: c.path, publicKey: c.publicKey };
}

function satsToBtcString(sats: bigint): string {
  const negative = sats < 0n;
  const abs = negative ? -sats : sats;
  const whole = abs / SATS_PER_BTC;
  const frac = abs - whole * SATS_PER_BTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function parseBtcAmountToSats(amount: string): bigint | null {
  if (amount === "max") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid BTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5") or "max" for the full balance minus fees.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(BTC_DECIMALS, "0");
  return BigInt(whole) * SATS_PER_BTC + BigInt(padded);
}

export interface BuildBitcoinNativeSendArgs {
  /**
   * Paired BTC source address(es). String for single-source;
   * `string[]` (1-20 entries) for multi-input consolidation. All
   * addresses must be in `UserConfig.pairings.bitcoin` and share the
   * same accountIndex + addressType. Issue #264.
   */
  wallet: string | string[];
  /** Recipient. Any of the four mainnet address types. */
  to: string;
  /** Decimal BTC string ("0.001"), or "max" for full-balance-minus-fee. */
  amount: string;
  /**
   * Fee rate in sat/vB. Optional — when omitted, uses the indexer's
   * `halfHourFee` recommendation (~3-block target). Mutually exclusive
   * with `feePriority`; the schema rejects both-set at the call site.
   */
  feeRateSatPerVb?: number;
  /**
   * Issue #435 — preset that resolves to one of mempool.space's named
   * fee buckets. Resolved via `getFeeEstimates()` once; the resolved
   * sat/vB flows through `feeRateSatPerVb` semantics for the rest of
   * the build. When neither is set, defaults to `halfHourFee`.
   */
  feePriority?:
    | "fastestFee"
    | "halfHourFee"
    | "hourFee"
    | "economyFee"
    | "minimumFee";
  /**
   * BIP-125 RBF. Default true → sequence `0xFFFFFFFD` (replaceable).
   */
  rbf?: boolean;
  /** Override the fee-cap guard. Default false. */
  allowHighFee?: boolean;
}

/**
 * Normalize the `wallet` arg to an ordered, deduplicated list of source
 * addresses. The first entry becomes the "primary" source surfaced as
 * `tx.from` for backwards compat.
 */
function normalizeWallets(arg: string | string[]): string[] {
  const list = Array.isArray(arg) ? arg : [arg];
  if (list.length === 0) {
    throw new Error(
      "`wallet` must be a paired Bitcoin address or a non-empty array of paired addresses.",
    );
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of list) {
    if (!seen.has(w)) {
      seen.add(w);
      out.push(w);
    }
  }
  return out;
}

export async function buildBitcoinNativeSend(
  args: BuildBitcoinNativeSendArgs,
): Promise<UnsignedBitcoinTx> {
  const wallets = normalizeWallets(args.wallet);

  // Address-book resolution. `args.to` may be a label like "Mom"; we
  // resolve via `resolveRecipient` which strict-aborts on contacts
  // tamper (label-resolution path) or proceeds with a warning when
  // the input was a literal address. The resolved address replaces
  // the user-supplied `to` for the rest of the flow; the resolved
  // label flows into `tx.recipient` for the verification block.
  const { resolveRecipient } = await import("../../contacts/resolver.js");
  const resolved = await resolveRecipient(args.to, "bitcoin");
  const resolvedTo = resolved.address;

  // 1. Validate every source address format + resolve every paired
  //    entry. Reject mixed accountIndex / addressType up-front.
  assertBitcoinAddress(resolvedTo);
  const pairedList = wallets.map((w) => {
    assertBitcoinAddress(w);
    const paired = getPairedBtcByAddress(w);
    if (!paired) {
      throw new Error(
        `Bitcoin address ${w} is not paired. Run \`pair_ledger_btc\` to register ` +
          `the four standard address types (legacy/p2sh-segwit/segwit/taproot) for ` +
          `an account, then pass any of those addresses as \`wallet\`.`,
      );
    }
    return paired;
  });

  const primary = pairedList[0];
  for (let i = 1; i < pairedList.length; i++) {
    const p = pairedList[i];
    if (p.addressType !== primary.addressType) {
      throw new Error(
        `Mixed source-address types in one send are not supported in Phase 1 ` +
          `(${pairedList[0].address} is ${primary.addressType}, ${p.address} is ` +
          `${p.addressType}). Group sources by type — segwit-only or taproot-only ` +
          `— and run separate sends.`,
      );
    }
    if (p.accountIndex !== primary.accountIndex) {
      throw new Error(
        `Cross-account multi-source sends are not supported (${pairedList[0].address} ` +
          `is accountIndex=${primary.accountIndex}, ${p.address} is ` +
          `accountIndex=${p.accountIndex}). Each Ledger account signs under its own ` +
          `wallet policy — pull from one account at a time.`,
      );
    }
  }

  // Phase 1 send-side scope: native segwit + taproot only.
  if (primary.addressType !== "segwit" && primary.addressType !== "taproot") {
    throw new Error(
      `Bitcoin sends from ${primary.addressType} (${primary.path}) addresses are not ` +
        `supported in Phase 1 — only native segwit (bc1q...) and taproot (bc1p...). ` +
        `Move funds to your paired segwit or taproot address first.`,
    );
  }

  const changeEntry = pickChangeEntry(primary);
  if (!changeEntry) {
    throw new Error(
      `No paired chain=1 (change) address found for ${primary.address}'s account ` +
        `(${primary.addressType}, accountIndex=${primary.accountIndex}). The pairings cache ` +
        `was likely populated when the wallet had no on-chain history (the gap-limit scan ` +
        `skips the change-chain walk in that case). Re-run \`pair_ledger_btc({ accountIndex: ` +
        `${primary.accountIndex} })\` now that this address has UTXOs and retry.`,
    );
  }

  const indexer = getBitcoinIndexer();

  // 2. Resolve fee rate. Both `feeRateSatPerVb` (raw) and `feePriority`
  //    (preset, issue #435) are optional. When neither is supplied the
  //    default is the indexer's `halfHourFee` (~3-block target) — same
  //    behavior as before #435 added the preset enum.
  if (
    args.feeRateSatPerVb !== undefined &&
    args.feePriority !== undefined
  ) {
    throw new Error(
      "Pass either `feeRateSatPerVb` (raw sat/vB) or `feePriority` (preset), " +
        "not both. The preset resolves to a sat/vB at prepare time so passing " +
        "both is ambiguous.",
    );
  }
  let feeRate: number;
  if (args.feeRateSatPerVb !== undefined) {
    feeRate = args.feeRateSatPerVb;
  } else {
    const fees = await indexer.getFeeEstimates();
    const bucket = args.feePriority ?? "halfHourFee";
    feeRate = fees[bucket];
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error(
      `Resolved fee rate ${feeRate} sat/vB is not positive. Pass an explicit ` +
        `\`feeRateSatPerVb\` or check the indexer URL.`,
    );
  }

  // 3. Fan out UTXO fetches across all sources in parallel; tag each
  //    UTXO with its source so coin-selection's output preserves the
  //    per-input mapping for PSBT building + the LTC legacy fallback.
  const utxosBySource = await Promise.all(
    wallets.map(async (w) => ({
      address: w,
      utxos: await indexer.getUtxos(w),
    })),
  );
  const totalUtxoCount = utxosBySource.reduce((n, e) => n + e.utxos.length, 0);
  if (totalUtxoCount === 0) {
    throw new Error(
      `No UTXOs across the ${wallets.length === 1 ? "source" : `${wallets.length} sources`} ` +
        `(${wallets.join(", ")}). Verify with \`get_btc_balance\` and confirm at least one ` +
        `tx has confirmed (unconfirmed mempool UTXOs are eligible for selection but very-young ` +
        `ones may be rejected by the relay).`,
    );
  }

  type TaggedUtxo = CoinSelectInput & { sourceAddress: string };
  const csUtxos: TaggedUtxo[] = utxosBySource.flatMap((src) =>
    src.utxos.map<TaggedUtxo>((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      sourceAddress: src.address,
    })),
  );

  // 4. Resolve "max" → fee-aware amount, or convert decimal-BTC → sats.
  let amountSats: bigint;
  if (args.amount === "max") {
    const totalSats = csUtxos.reduce((sum, u) => sum + u.value, 0);
    const vbytes = roughVbytes(csUtxos.length, 1);
    const feeMax = Math.ceil(feeRate * vbytes) + Math.ceil(feeRate * 5);
    if (totalSats <= feeMax) {
      throw new Error(
        `Cannot "max": total balance ${satsToBtcString(BigInt(totalSats))} BTC is at or below ` +
          `the estimated fee ${satsToBtcString(BigInt(feeMax))} BTC at ${feeRate} sat/vB. ` +
          `Lower the feeRate or wait for more confirmations.`,
      );
    }
    amountSats = BigInt(totalSats - feeMax);
  } else {
    const parsed = parseBtcAmountToSats(args.amount);
    if (parsed === null) {
      throw new Error(`Internal error: parseBtcAmountToSats returned null for ${args.amount}`);
    }
    amountSats = parsed;
  }
  if (amountSats <= 0n) {
    throw new Error(
      `Resolved send amount ${amountSats} sats is not positive. Increase the amount.`,
    );
  }

  // 5. Coin-selection over the merged pool.
  const selection = selectInputs({
    utxos: csUtxos,
    outputs: [{ address: resolvedTo, value: Number(amountSats) }],
    feeRate,
    changeAddress: changeEntry.address,
    allowHighFee: args.allowHighFee,
  });

  // Map selected inputs back to their source via (txid, vout) — that
  // pair uniquely identifies a pool entry within a single send.
  const utxoSourceByKey = new Map<string, string>();
  for (const u of csUtxos) {
    utxoSourceByKey.set(`${u.txid}:${u.vout}`, u.sourceAddress);
  }
  const inputSources: string[] = selection.inputs.map((i) => {
    const src = utxoSourceByKey.get(`${i.txid}:${i.vout}`);
    if (!src) {
      throw new Error(
        `Internal error: selected input ${i.txid}:${i.vout} not found in source-tagged pool.`,
      );
    }
    return src;
  });

  // 6. Fetch full prev-tx hex for every UNIQUE input txid (issue #213).
  const uniqueTxids = [...new Set(selection.inputs.map((i) => i.txid))];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);

  // 7. Build PSBT. Each input gets ITS source's scriptPubKey.
  const sourceScriptByAddr = new Map<string, Buffer>();
  for (const w of wallets) {
    sourceScriptByAddr.set(w, bitcoinjs.address.toOutputScript(w, NETWORK));
  }

  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  const sequence = args.rbf === false ? 0xfffffffe : 0xfffffffd;
  for (let i = 0; i < selection.inputs.length; i++) {
    const input = selection.inputs[i];
    const srcAddr = inputSources[i];
    const sourceScript = sourceScriptByAddr.get(srcAddr);
    if (!sourceScript) {
      throw new Error(
        `Internal error: missing source script for ${srcAddr} (input ${input.txid}:${input.vout}).`,
      );
    }
    const prevTxHex = prevTxHexByTxid.get(input.txid);
    if (!prevTxHex) {
      throw new Error(
        `Internal error: prev-tx hex missing for selected input ${input.txid}:${input.vout} ` +
          `after fan-out fetch.`,
      );
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence,
      witnessUtxo: { script: sourceScript, value: input.value },
      nonWitnessUtxo: Buffer.from(prevTxHex, "hex"),
    });
  }
  for (const output of selection.outputs) {
    const outScript = bitcoinjs.address.toOutputScript(
      output.address ?? changeEntry.address,
      NETWORK,
    );
    psbt.addOutput({ script: outScript, value: output.value });
  }
  const psbtBase64 = psbt.toBase64();

  // 8. Decoded-output projection for the verification block.
  const decodedOutputs = selection.outputs.map((o) => {
    const isChange = o.isChange;
    const address = o.address ?? changeEntry.address;
    return {
      address,
      amountSats: o.value.toString(),
      amountBtc: satsToBtcString(BigInt(o.value)),
      isChange,
      ...(isChange ? { changePath: changeEntry.path } : {}),
    };
  });

  // 9. Per-source breakdown — sats pulled from each source + how many
  //    inputs that source contributed. Sources whose UTXOs coinselect
  //    didn't pick are dropped (no zero-line rows in the verification).
  const sourceTotals = new Map<string, { sats: bigint; count: number }>();
  for (const w of wallets) {
    sourceTotals.set(w, { sats: 0n, count: 0 });
  }
  for (let i = 0; i < selection.inputs.length; i++) {
    const acc = sourceTotals.get(inputSources[i]);
    if (!acc) continue;
    acc.sats += BigInt(selection.inputs[i].value);
    acc.count += 1;
  }
  const decodedSources = wallets
    .map((w) => {
      const t = sourceTotals.get(w) ?? { sats: 0n, count: 0 };
      return {
        address: w,
        pulledSats: t.sats.toString(),
        pulledBtc: satsToBtcString(t.sats),
        inputCount: t.count,
      };
    })
    .filter((s) => s.inputCount > 0);

  const sources = wallets.map((addr, idx) => ({
    address: addr,
    path: pairedList[idx].path,
    publicKey: pairedList[idx].publicKey,
  }));

  const accountPath = accountPathFromLeaf(primary.path);
  const vsize = roughVbytes(selection.inputs.length, selection.outputs.length);
  const recipientDisplay = resolved.label
    ? `${resolved.label} (${resolvedTo})`
    : resolvedTo;
  const description =
    wallets.length === 1
      ? `Send ${satsToBtcString(amountSats)} BTC to ${recipientDisplay}`
      : `Consolidate ${satsToBtcString(amountSats)} BTC from ${wallets.length} addresses to ${recipientDisplay}`;

  const tx: Omit<UnsignedBitcoinTx, "handle" | "fingerprint"> = {
    chain: "bitcoin",
    action: "native_send",
    from: wallets[0],
    sources,
    inputSources,
    psbtBase64,
    accountPath,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[primary.addressType],
    change: {
      address: changeEntry.address,
      path: changeEntry.path,
      publicKey: changeEntry.publicKey,
    },
    description,
    recipient: {
      ...(resolved.label ? { label: resolved.label } : {}),
      source: resolved.source,
      ...(resolved.warnings.length > 0 ? { warnings: resolved.warnings } : {}),
    },
    decoded: {
      functionName: "bitcoin.native_send",
      args: {
        from: wallets.join(","),
        to: resolvedTo,
        ...(resolved.label ? { recipientLabel: resolved.label } : {}),
        amount: satsToBtcString(amountSats),
        feeRate: `${feeRate} sat/vB`,
      },
      outputs: decodedOutputs,
      sources: decodedSources,
      feeSats: selection.fee.toString(),
      feeBtc: satsToBtcString(BigInt(selection.fee)),
      feeRateSatPerVb: feeRate,
      rbfEligible: args.rbf !== false,
    },
    vsize,
  };
  return issueBitcoinHandle(tx);
}

/**
 * Dust threshold (sats) below which an output is non-standard and won't
 * relay. The Bitcoin Core default is `3 × output-size × min-relay-fee`,
 * which evaluates to 294 for P2WPKH and 330 for P2TR at 1 sat/vB. We
 * use 546 — Bitcoin Core's hardcoded floor for P2PKH and the
 * conservative cross-type baseline every modern wallet treats as
 * "definitely not dust." Below this the change output would either be
 * rejected at relay time or eat the entire fee bump.
 */
const DUST_THRESHOLD_SATS = 546;

/**
 * Min-relay fee rate (sat/vB) used by the BIP-125 rule-4 check. Bitcoin
 * Core's default `minRelayTxFee` is 1000 sat/kvB → 1 sat/vB; mempools
 * with non-default `incrementalRelayFee` may require more, but 1 is the
 * canonical floor every relay node accepts.
 */
const MIN_RELAY_FEE_RATE = 1;

export interface BuildBitcoinRbfBumpArgs {
  /** Paired BTC source address that signed the original tx. Segwit/taproot only (Phase 1). */
  wallet: string;
  /** 64-hex original tx hash. Must currently be in mempool (not yet confirmed). */
  txid: string;
  /** New fee rate in sat/vB. Must be high enough to satisfy BIP-125 rule 4. */
  newFeeRate: number;
  /** Override the fee-cap guard. Default false. */
  allowHighFee?: boolean;
}

/**
 * Build an RBF (BIP-125) replacement for a stuck mempool tx.
 *
 * The replacement reuses the original tx's exact input set and
 * preserves every non-change output verbatim — only the change output
 * shrinks to absorb the fee bump. Sequence is set to 0xFFFFFFFD on
 * every input so the replacement is itself RBF-eligible (the user can
 * bump again if the new rate is still too low).
 *
 * Refusal cases (every check is a hard refusal — no silent fallback):
 *  1. `wallet` not paired or not segwit/taproot.
 *  2. Original tx already confirmed (can't replace — `confirmed: true`).
 *  3. No input is BIP-125-eligible (every `sequence >= 0xFFFFFFFE`).
 *  4. Any input's prevout address differs from `wallet` (multi-source
 *     RBF is out of scope — partial-RBF where we'd need keys we don't
 *     have).
 *  5. Original tx has no change output paired to the user (sweep tx
 *     with no headroom to absorb the bump — would require adding a
 *     fresh input, which is CPFP territory).
 *  6. New fee fails BIP-125 rule 4: new abs fee < old abs fee +
 *     `MIN_RELAY_FEE_RATE × new vsize`.
 *  7. Bumped change drops below `DUST_THRESHOLD_SATS` — the bump would
 *     consume the entire change output (relay would reject the
 *     resulting dust output).
 *  8. Fee exceeds the safety cap (same shape as `selectInputs`'s cap)
 *     unless `allowHighFee: true`.
 */
export async function buildBitcoinRbfBump(
  args: BuildBitcoinRbfBumpArgs,
): Promise<UnsignedBitcoinTx> {
  if (!/^[0-9a-fA-F]{64}$/.test(args.txid)) {
    throw new Error(
      `\`txid\` must be 64 hex characters, got ${args.txid.length} chars.`,
    );
  }
  if (
    !Number.isFinite(args.newFeeRate) ||
    args.newFeeRate <= 0 ||
    args.newFeeRate > 10_000
  ) {
    throw new Error(
      `Invalid newFeeRate ${args.newFeeRate} sat/vB — expected a positive finite number ≤ 10000.`,
    );
  }

  // 1. Validate wallet is paired and segwit/taproot.
  assertBitcoinAddress(args.wallet);
  const paired = getPairedBtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Bitcoin address ${args.wallet} is not paired. Run \`pair_ledger_btc\` first.`,
    );
  }
  if (paired.addressType !== "segwit" && paired.addressType !== "taproot") {
    throw new Error(
      `RBF bump from ${paired.addressType} (${paired.path}) addresses is not supported ` +
        `in Phase 1 — only native segwit (bc1q...) and taproot (bc1p...).`,
    );
  }

  // 2. Fetch original tx.
  const indexer = getBitcoinIndexer();
  const orig = await indexer.getTx(args.txid);

  // 3. Refuse if already confirmed.
  if (orig.status?.confirmed === true) {
    const blockHeight = orig.status.block_height;
    throw new Error(
      `Tx ${args.txid} is already confirmed${
        blockHeight !== undefined ? ` at block ${blockHeight}` : ""
      } — RBF only works for unconfirmed mempool txs. Nothing to bump.`,
    );
  }

  // 4. Walk inputs: collect (txid, vout, value), check RBF eligibility,
  //    refuse foreign inputs.
  if (orig.vin.length === 0) {
    throw new Error(`Tx ${args.txid} has no inputs — indexer returned malformed shape.`);
  }
  let anyRbfEligible = false;
  const inputsForBuild: Array<{ txid: string; vout: number; value: number }> = [];
  for (const v of orig.vin) {
    const seq = typeof v.sequence === "number" ? v.sequence : 0xffffffff;
    if (seq < 0xfffffffe) anyRbfEligible = true;
    if (v.prevout?.scriptpubkey_address !== args.wallet) {
      throw new Error(
        `Tx ${args.txid} has an input from ${v.prevout?.scriptpubkey_address ?? "<unknown>"} ` +
          `which is not the bumped wallet ${args.wallet}. Multi-source RBF is out of scope ` +
          `for this tool — every input must belong to the address being passed as \`wallet\`.`,
      );
    }
    if (typeof v.prevout.value !== "number") {
      throw new Error(
        `Tx ${args.txid} input ${v.txid}:${v.vout} is missing prevout.value from the indexer.`,
      );
    }
    inputsForBuild.push({ txid: v.txid, vout: v.vout, value: v.prevout.value });
  }
  if (!anyRbfEligible) {
    throw new Error(
      `Tx ${args.txid} is not BIP-125 RBF-eligible (every input has sequence >= 0xFFFFFFFE). ` +
        `The original was broadcast as final. Wait for confirmation or ask a miner-accelerator ` +
        `service; this tool cannot replace it.`,
    );
  }

  // 5. Walk outputs: collect, identify change.
  if (orig.vout.length === 0) {
    throw new Error(`Tx ${args.txid} has no outputs — indexer returned malformed shape.`);
  }
  // Change candidates: any output whose address is paired under the
  // SAME (accountIndex, addressType) as `wallet`. Covers both the
  // chain=1 default (Phase-1 native_send) and a chain=0 self-send case.
  const allPaired = getPairedBtcAddresses();
  const ourAddrs = new Set(
    allPaired
      .filter(
        (e) =>
          e.accountIndex === paired.accountIndex &&
          e.addressType === paired.addressType,
      )
      .map((e) => e.address),
  );
  type OrigOutput = { address: string; value: number; isChange: boolean };
  const origOutputs: OrigOutput[] = [];
  for (const v of orig.vout) {
    if (typeof v.scriptpubkey_address !== "string" || typeof v.value !== "number") {
      throw new Error(
        `Tx ${args.txid} has an output with missing address/value — indexer returned malformed shape.`,
      );
    }
    origOutputs.push({
      address: v.scriptpubkey_address,
      value: v.value,
      isChange: ourAddrs.has(v.scriptpubkey_address),
    });
  }
  const changeOutputs = origOutputs.filter((o) => o.isChange);
  if (changeOutputs.length === 0) {
    throw new Error(
      `Tx ${args.txid} has no change output paying back to ${args.wallet}'s account ` +
        `(${paired.addressType}, accountIndex=${paired.accountIndex}). With no change ` +
        `there is no headroom to absorb a fee bump — this is CPFP territory, not RBF.`,
    );
  }
  if (changeOutputs.length > 1) {
    throw new Error(
      `Tx ${args.txid} has ${changeOutputs.length} outputs paying to this account — ` +
        `ambiguous which is the change. Self-sends and split-change patterns are out of ` +
        `scope for this tool.`,
    );
  }
  const changeAddress = changeOutputs[0].address;
  const changeEntryFromPairings = allPaired.find((e) => e.address === changeAddress);
  if (!changeEntryFromPairings) {
    throw new Error(
      `Internal error: change address ${changeAddress} matched the paired set but ` +
        `disappeared on lookup.`,
    );
  }

  // 6. Recompute fee + change at the new fee rate.
  const newVbytes = roughVbytes(inputsForBuild.length, origOutputs.length);
  const newFee = Math.ceil(args.newFeeRate * newVbytes);
  const totalInputValue = inputsForBuild.reduce((s, i) => s + i.value, 0);
  const externalOutputTotal = origOutputs
    .filter((o) => !o.isChange)
    .reduce((s, o) => s + o.value, 0);
  const newChangeValue = totalInputValue - externalOutputTotal - newFee;

  // 7. BIP-125 rule 4: new abs fee >= old abs fee + min-relay × new vsize.
  const oldFee = orig.fee ?? totalInputValue - origOutputs.reduce((s, o) => s + o.value, 0);
  const minBumpAbs = oldFee + MIN_RELAY_FEE_RATE * newVbytes;
  if (newFee < minBumpAbs) {
    const requiredRate = Math.ceil(minBumpAbs / newVbytes);
    throw new Error(
      `New fee ${newFee} sats fails BIP-125 rule 4 — must be at least ${minBumpAbs} sats ` +
        `(old fee ${oldFee} + min-relay 1 sat/vB × new vsize ${newVbytes}). ` +
        `Retry with newFeeRate >= ${requiredRate} sat/vB.`,
    );
  }

  // 8. Refuse if change drops below dust.
  if (newChangeValue < DUST_THRESHOLD_SATS) {
    throw new Error(
      `Bumped change output would be ${newChangeValue} sats — below the ${DUST_THRESHOLD_SATS}-sat ` +
        `dust threshold. The fee bump would consume the entire change output (or worse, ` +
        `produce negative change). Lower newFeeRate, or use CPFP / add inputs (out of scope).`,
    );
  }

  // 9. Fee-cap guard (mirror of `selectInputs`'s cap).
  if (!args.allowHighFee) {
    const vbyteCap = Math.ceil(args.newFeeRate * 10 * newVbytes);
    const percentCap = Math.ceil(externalOutputTotal * 0.02);
    const cap = Math.max(vbyteCap, percentCap);
    if (newFee > cap) {
      throw new Error(
        `Fee ${newFee} sats exceeds safety cap ${cap} sats ` +
          `(max of 10× feeRate-based ${vbyteCap} and 2%-of-output ${percentCap}). ` +
          `If this is intentional (priority bump through congestion), retry with ` +
          `\`allowHighFee: true\` after confirming with the user.`,
      );
    }
  }

  // 10. Fetch prev-tx hex for every UNIQUE input txid (issue #213).
  const uniqueTxids = [...new Set(inputsForBuild.map((i) => i.txid))];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);

  // 11. Build PSBT — same shape as buildBitcoinNativeSend but with the
  //     fixed input set and the recomputed change value spliced in.
  const sourceScript = bitcoinjs.address.toOutputScript(args.wallet, NETWORK);
  const psbt = new bitcoinjs.Psbt({ network: NETWORK });
  for (const input of inputsForBuild) {
    const prevTxHex = prevTxHexByTxid.get(input.txid);
    if (!prevTxHex) {
      throw new Error(
        `Internal error: prev-tx hex missing for ${input.txid} after fan-out fetch.`,
      );
    }
    psbt.addInput({
      hash: input.txid,
      index: input.vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script: sourceScript, value: input.value },
      nonWitnessUtxo: Buffer.from(prevTxHex, "hex"),
    });
  }
  // Output ordering preserved from the original — same indices, just
  // change updated. Wallet fingerprinting heuristics (BIP-69, etc.) the
  // original tx adopted carry over by construction.
  const newOutputs = origOutputs.map((o) =>
    o.isChange ? { ...o, value: newChangeValue } : o,
  );
  for (const o of newOutputs) {
    const outScript = bitcoinjs.address.toOutputScript(o.address, NETWORK);
    psbt.addOutput({ script: outScript, value: o.value });
  }
  const psbtBase64 = psbt.toBase64();

  // 12. Project decoded outputs for the verification block.
  const decodedOutputs = newOutputs.map((o) => ({
    address: o.address,
    amountSats: o.value.toString(),
    amountBtc: satsToBtcString(BigInt(o.value)),
    isChange: o.isChange,
    ...(o.isChange ? { changePath: changeEntryFromPairings.path } : {}),
  }));

  const decodedSources = [
    {
      address: args.wallet,
      pulledSats: totalInputValue.toString(),
      pulledBtc: satsToBtcString(BigInt(totalInputValue)),
      inputCount: inputsForBuild.length,
    },
  ];
  const sources = [
    {
      address: args.wallet,
      path: paired.path,
      publicKey: paired.publicKey,
    },
  ];
  const inputSources = inputsForBuild.map(() => args.wallet);

  const accountPath = accountPathFromLeaf(paired.path);
  const oldFeeRate = oldFee / Math.max(1, newVbytes); // approximate; orig vsize ≈ new vsize
  const description =
    `RBF bump tx ${args.txid.slice(0, 12)}…: ` +
    `fee ${oldFee} → ${newFee} sats (${args.newFeeRate} sat/vB)`;

  const tx: Omit<UnsignedBitcoinTx, "handle" | "fingerprint"> = {
    chain: "bitcoin",
    action: "rbf_bump",
    from: args.wallet,
    sources,
    inputSources,
    psbtBase64,
    accountPath,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    change: {
      address: changeEntryFromPairings.address,
      path: changeEntryFromPairings.path,
      publicKey: changeEntryFromPairings.publicKey,
    },
    description,
    replaces: {
      txid: args.txid,
      oldFeeSats: oldFee.toString(),
      oldFeeRateSatPerVb: Math.round(oldFeeRate * 100) / 100,
    },
    decoded: {
      functionName: "bitcoin.rbf_bump",
      args: {
        wallet: args.wallet,
        oldTxid: args.txid,
        oldFeeSats: oldFee.toString(),
        newFeeRate: `${args.newFeeRate} sat/vB`,
      },
      outputs: decodedOutputs,
      sources: decodedSources,
      feeSats: newFee.toString(),
      feeBtc: satsToBtcString(BigInt(newFee)),
      feeRateSatPerVb: args.newFeeRate,
      rbfEligible: true,
    },
    vsize: newVbytes,
  };
  return issueBitcoinHandle(tx);
}

/** Validate a BTC address against the four mainnet types. Re-export for tests. */
export function _isSendableAddressType(
  type: BitcoinAddressType,
): type is "p2wpkh" | "p2tr" {
  return type === "p2wpkh" || type === "p2tr";
}

export interface SignBitcoinMessageArgs {
  wallet: string;
  message: string;
}

export interface SignedBitcoinMessage {
  address: string;
  message: string;
  /**
   * Lowercase hex SHA-256 of the exact UTF-8 bytes that went to the
   * Ledger BTC app for signing (issue #454, Inv #8 byte-fingerprint).
   * The agent surfaces this in the verbatim message-sign block so a
   * user concerned about unicode-confusable substitution / OLED skim
   * attacks can recompute on a separate device:
   * `printf '%s' '<message>' | sha256sum`.
   */
  messageSha256: string;
  signature: string;
  format: "BIP-137";
  addressType: PairedBtcAddressType;
}

/**
 * Sign a UTF-8 message with the paired Bitcoin address using the
 * Bitcoin Signed Message format (BIP-137). The Ledger BTC app prompts
 * the user to confirm the message text on-device before producing the
 * signature.
 */
export async function signBitcoinMessage(
  args: SignBitcoinMessageArgs,
): Promise<SignedBitcoinMessage> {
  assertBitcoinAddress(args.wallet);
  if (typeof args.message !== "string" || args.message.length === 0) {
    throw new Error("`message` must be a non-empty string.");
  }
  if (args.message.length > 10_000) {
    throw new Error(
      `Message length ${args.message.length} exceeds the 10000-char ceiling. Sign-In-` +
        `with-Bitcoin-style flows are typically a few hundred chars; rejecting the long ` +
        `tail because the Ledger BTC app's on-device review surface chunks the message ` +
        `into 16-char windows and a multi-KB string is not realistically reviewable.`,
    );
  }
  // Inv #8 hardening (#454): refuse drainer-pattern messages BEFORE any
  // device interaction. The check runs on the agent-supplied bytes,
  // which are the same bytes hashed into `messageSha256` below — no
  // gap between what we refuse against and what we'd sign.
  assertNoDrainerPattern(args.message);

  const paired = getPairedBtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Bitcoin address ${args.wallet} is not paired. Run \`pair_ledger_btc\` to register ` +
        `the four standard address types and retry with one of the resulting addresses.`,
    );
  }
  const messageBytes = Buffer.from(args.message, "utf-8");
  const messageSha256 = createHash("sha256").update(messageBytes).digest("hex");
  const { signBtcMessageOnLedger } = await import(
    "../../signing/btc-usb-signer.js"
  );
  const result = await signBtcMessageOnLedger({
    expectedFrom: args.wallet,
    path: paired.path,
    addressFormat: ADDRESS_FORMAT_BY_TYPE[paired.addressType],
    messageHex: messageBytes.toString("hex"),
    addressType: paired.addressType,
  });
  return {
    address: args.wallet,
    message: args.message,
    messageSha256,
    signature: result.signature,
    format: result.format,
    addressType: paired.addressType,
  };
}
