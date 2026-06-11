import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { assertLitecoinAddress, type LitecoinAddressType } from "./address.js";
import { assertNoDrainerPattern } from "../../security/drainer-pattern.js";
import { getLitecoinIndexer } from "./indexer.js";
import { selectInputs, type CoinSelectInput } from "../shared/utxo-coin-select.js";
import { issueLitecoinHandle } from "../../signing/ltc-tx-store.js";
import {
  getPairedLtcByAddress,
  getPairedLtcAddresses,
  type LtcAddressType as PairedLtcAddressType,
} from "../../signing/ltc-usb-signer.js";
import type { UnsignedLitecoinTx } from "../../types/index.js";
import { LTC_DECIMALS, LITOSHIS_PER_LTC } from "../../config/litecoin.js";

/**
 * Litecoin native-send builder. Mirror of `src/modules/btc/actions.ts`.
 * Same PSBT v0 / coin-selection / fee-cap pattern; only network params
 * and chain identifiers differ.
 *
 * Multi-source consolidation (issue #264). `wallet` accepts either a
 * single address or an array of paired source addresses; mirrors BTC's
 * fan-out + merged coin-selection. Phase 1 scope keeps all sources
 * within the SAME Ledger account (same accountIndex + addressType).
 *
 * bitcoinjs-lib does not ship a Litecoin network preset, so we
 * construct one inline (mainnet only). pubKeyHash 0x30 (L-prefix),
 * scriptHash 0x32 (M-prefix; modern Litecoin P2SH version), bech32
 * HRP `ltc`.
 *
 * Legacy 3-prefix (0x05) Litecoin P2SH addresses are READ-side only.
 * Change derivation mirrors BTC's (issue #254). Same RBF default
 * (`0xFFFFFFFD`). Same nonWitnessUtxo requirement on every input
 * (Ledger BTC/LTC app 2.x — issue #213).
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
};

const LITECOIN_NETWORK = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: {
    public: 0x0488b21e,
    private: 0x0488ade4,
  },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

const NETWORK = LITECOIN_NETWORK;

const ADDRESS_FORMAT_BY_TYPE: Record<
  PairedLtcAddressType,
  UnsignedLitecoinTx["addressFormat"]
> = {
  legacy: "legacy",
  "p2sh-segwit": "p2sh",
  segwit: "bech32",
  taproot: "bech32m",
};

function accountPathFromLeaf(leafPath: string): string {
  const parts = leafPath.split("/");
  if (parts.length < 5) {
    throw new Error(
      `Invalid Litecoin leaf path "${leafPath}" — expected at least 5 segments ` +
        `(<purpose>'/2'/<account>'/<change>/<index>).`,
    );
  }
  return parts.slice(0, -2).join("/");
}

function roughVbytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}

function pickChangeEntry(
  paired: ReturnType<typeof getPairedLtcByAddress>,
): { address: string; path: string; publicKey: string } | null {
  if (!paired) return null;
  const all = getPairedLtcAddresses();
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

function litoshisToLtcString(litoshis: bigint): string {
  const negative = litoshis < 0n;
  const abs = negative ? -litoshis : litoshis;
  const whole = abs / LITOSHIS_PER_LTC;
  const frac = abs - whole * LITOSHIS_PER_LTC;
  const fracStr = frac.toString().padStart(8, "0").replace(/0+$/, "") || "0";
  const body = fracStr === "0" ? whole.toString() : `${whole.toString()}.${fracStr}`;
  return negative ? `-${body}` : body;
}

function parseLtcAmountToLitoshis(amount: string): bigint | null {
  if (amount === "max") return null;
  if (!/^\d+(\.\d{1,8})?$/.test(amount)) {
    throw new Error(
      `Invalid LTC amount "${amount}" — expected a decimal with up to 8 fractional ` +
        `digits (e.g. "0.001", "0.5") or "max" for the full balance minus fees.`,
    );
  }
  const [whole, frac = ""] = amount.split(".");
  const padded = frac.padEnd(LTC_DECIMALS, "0");
  return BigInt(whole) * LITOSHIS_PER_LTC + BigInt(padded);
}

export interface BuildLitecoinNativeSendArgs {
  /**
   * Paired LTC source address(es). String for single-source; `string[]`
   * (1-20 entries) for multi-input consolidation. All addresses must
   * be in `UserConfig.pairings.litecoin` and share the same accountIndex
   * + addressType. Issue #264.
   */
  wallet: string | string[];
  to: string;
  amount: string;
  feeRateSatPerVb?: number;
  rbf?: boolean;
  allowHighFee?: boolean;
}

function normalizeWallets(arg: string | string[]): string[] {
  const list = Array.isArray(arg) ? arg : [arg];
  if (list.length === 0) {
    throw new Error(
      "`wallet` must be a paired Litecoin address or a non-empty array of paired addresses.",
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

export async function buildLitecoinNativeSend(
  args: BuildLitecoinNativeSendArgs,
): Promise<UnsignedLitecoinTx> {
  const wallets = normalizeWallets(args.wallet);

  const toType = assertLitecoinAddress(args.to);
  if (toType === "p2sh" && args.to.startsWith("3")) {
    throw new Error(
      `Sending to legacy 3-prefix Litecoin P2SH addresses (${args.to}) is not supported. ` +
        `Litecoin migrated P2SH to the M-prefix (version 0x32) form years ago. Ask the ` +
        `recipient for their modern M-prefix address, or send via Litecoin Core directly.`,
    );
  }
  const pairedList = wallets.map((w) => {
    assertLitecoinAddress(w);
    const paired = getPairedLtcByAddress(w);
    if (!paired) {
      throw new Error(
        `Litecoin address ${w} is not paired. Run \`pair_ledger_ltc\` to register ` +
          `the four standard address types and retry with one of the resulting addresses.`,
      );
    }
    return paired;
  });

  const primary = pairedList[0];
  for (let i = 1; i < pairedList.length; i++) {
    const p = pairedList[i];
    if (p.addressType !== primary.addressType) {
      throw new Error(
        `Mixed source-address types in one Litecoin send are not supported in Phase 1 ` +
          `(${pairedList[0].address} is ${primary.addressType}, ${p.address} is ` +
          `${p.addressType}). Group sources by type and run separate sends.`,
      );
    }
    if (p.accountIndex !== primary.accountIndex) {
      throw new Error(
        `Cross-account multi-source Litecoin sends are not supported (${pairedList[0].address} ` +
          `is accountIndex=${primary.accountIndex}, ${p.address} is ` +
          `accountIndex=${p.accountIndex}). Pull from one account at a time.`,
      );
    }
  }

  if (primary.addressType !== "segwit" && primary.addressType !== "taproot") {
    throw new Error(
      `Litecoin sends from ${primary.addressType} (${primary.path}) addresses are not ` +
        `supported in Phase 1 — only native segwit (ltc1q...) and taproot (ltc1p...). ` +
        `Move funds to your paired segwit address first.`,
    );
  }

  const changeEntry = pickChangeEntry(primary);
  if (!changeEntry) {
    throw new Error(
      `No paired chain=1 (change) address found for ${primary.address}'s account ` +
        `(${primary.addressType}, accountIndex=${primary.accountIndex}). Re-run ` +
        `\`pair_ledger_ltc({ accountIndex: ${primary.accountIndex} })\` and retry.`,
    );
  }

  const indexer = getLitecoinIndexer();

  let feeRate: number;
  if (args.feeRateSatPerVb !== undefined) {
    feeRate = args.feeRateSatPerVb;
  } else {
    const fees = await indexer.getFeeEstimates();
    feeRate = fees.halfHourFee;
  }
  if (!Number.isFinite(feeRate) || feeRate <= 0) {
    throw new Error(
      `Resolved fee rate ${feeRate} litoshi/vB is not positive. Pass an explicit ` +
        `\`feeRateSatPerVb\` or check the indexer URL.`,
    );
  }

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
        `(${wallets.join(", ")}). Verify with \`get_token_balance\` (chain:"litecoin") and ` +
        `confirm at least one tx has confirmed.`,
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

  let amountSats: bigint;
  if (args.amount === "max") {
    const totalSats = csUtxos.reduce((sum, u) => sum + u.value, 0);
    const vbytes = roughVbytes(csUtxos.length, 1);
    const feeMax = Math.ceil(feeRate * vbytes) + Math.ceil(feeRate * 5);
    if (totalSats <= feeMax) {
      throw new Error(
        `Cannot "max": total balance ${litoshisToLtcString(BigInt(totalSats))} LTC is at or below ` +
          `the estimated fee ${litoshisToLtcString(BigInt(feeMax))} LTC at ${feeRate} litoshi/vB. ` +
          `Lower the feeRate or wait for more confirmations.`,
      );
    }
    amountSats = BigInt(totalSats - feeMax);
  } else {
    const parsed = parseLtcAmountToLitoshis(args.amount);
    if (parsed === null) {
      throw new Error(`Internal error: parseLtcAmountToLitoshis returned null for ${args.amount}`);
    }
    amountSats = parsed;
  }
  if (amountSats <= 0n) {
    throw new Error(
      `Resolved send amount ${amountSats} litoshis is not positive. Increase the amount.`,
    );
  }

  const selection = selectInputs({
    utxos: csUtxos,
    outputs: [{ address: args.to, value: Number(amountSats) }],
    feeRate,
    changeAddress: changeEntry.address,
    ...(args.allowHighFee !== undefined ? { allowHighFee: args.allowHighFee } : {}),
  });

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

  const uniqueTxids = [...new Set(selection.inputs.map((i) => i.txid))];
  const prevTxHexEntries = await Promise.all(
    uniqueTxids.map(async (txid) => [txid, await indexer.getTxHex(txid)] as const),
  );
  const prevTxHexByTxid = new Map(prevTxHexEntries);

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

  const decodedOutputs = selection.outputs.map((o) => {
    const isChange = o.isChange;
    const address = o.address ?? changeEntry.address;
    return {
      address,
      amountSats: o.value.toString(),
      amountLtc: litoshisToLtcString(BigInt(o.value)),
      isChange,
      ...(isChange ? { changePath: changeEntry.path } : {}),
    };
  });

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
        pulledLtc: litoshisToLtcString(t.sats),
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
  const description =
    wallets.length === 1
      ? `Send ${litoshisToLtcString(amountSats)} LTC to ${args.to}`
      : `Consolidate ${litoshisToLtcString(amountSats)} LTC from ${wallets.length} addresses to ${args.to}`;

  const tx: Omit<UnsignedLitecoinTx, "handle" | "fingerprint"> = {
    chain: "litecoin",
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
    decoded: {
      functionName: "litecoin.native_send",
      args: {
        from: wallets.join(","),
        to: args.to,
        amount: litoshisToLtcString(amountSats),
        feeRate: `${feeRate} litoshi/vB`,
      },
      outputs: decodedOutputs,
      sources: decodedSources,
      feeSats: selection.fee.toString(),
      feeLtc: litoshisToLtcString(BigInt(selection.fee)),
      feeRateSatPerVb: feeRate,
      rbfEligible: args.rbf !== false,
    },
    vsize,
  };
  return issueLitecoinHandle(tx);
}

/** Validate an LTC address against the four mainnet types. Re-export for tests. */
export function _isSendableAddressType(
  type: LitecoinAddressType,
): type is "p2wpkh" | "p2tr" {
  return type === "p2wpkh" || type === "p2tr";
}

export interface SignLitecoinMessageArgs {
  wallet: string;
  message: string;
}

export interface SignedLitecoinMessage {
  address: string;
  message: string;
  /**
   * Lowercase hex SHA-256 of the exact UTF-8 bytes that went to the
   * Ledger Litecoin app for signing (issue #454, Inv #8 byte-fingerprint).
   * Mirrors `SignedBitcoinMessage.messageSha256`. The agent surfaces
   * this in the verbatim message-sign block so the user can recompute
   * on a separate device.
   */
  messageSha256: string;
  signature: string;
  format: "BIP-137";
  addressType: PairedLtcAddressType;
}

/**
 * Sign a UTF-8 message with the paired Litecoin address using the
 * Litecoin Signed Message format (BIP-137 with Litecoin's message
 * prefix).
 */
export async function signLitecoinMessage(
  args: SignLitecoinMessageArgs,
): Promise<SignedLitecoinMessage> {
  assertLitecoinAddress(args.wallet);
  if (typeof args.message !== "string" || args.message.length === 0) {
    throw new Error("`message` must be a non-empty string.");
  }
  if (args.message.length > 10_000) {
    throw new Error(
      `Message length ${args.message.length} exceeds the 10000-char ceiling.`,
    );
  }
  // Inv #8 hardening (#454) — same drainer-pattern refusal as the BTC
  // path; refuses BEFORE any device interaction so a compromised agent
  // can't suppress it by skipping the preview.
  assertNoDrainerPattern(args.message);

  const paired = getPairedLtcByAddress(args.wallet);
  if (!paired) {
    throw new Error(
      `Litecoin address ${args.wallet} is not paired. Run \`pair_ledger_ltc\` to register ` +
        `the four standard address types and retry with one of the resulting addresses.`,
    );
  }
  const messageBytes = Buffer.from(args.message, "utf-8");
  const messageSha256 = createHash("sha256").update(messageBytes).digest("hex");
  const { signLtcMessageOnLedger } = await import(
    "../../signing/ltc-usb-signer.js"
  );
  const result = await signLtcMessageOnLedger({
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
