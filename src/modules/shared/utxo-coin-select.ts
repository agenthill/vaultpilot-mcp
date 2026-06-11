import { createRequire } from "node:module";

/**
 * Wrapper around the `coinselect` library's branch-and-bound + accumulative
 * coin-selection. Adds:
 *   - sat/vB feeRate validation
 *   - fee-cap guard: refuses to prepare a tx whose fee exceeds
 *     `max(10× user-specified rate × estimated-vbytes, 2% of total
 *     output value)`. Catches both fat-finger feeRates and
 *     MCP-injected fee-drain attacks.
 *
 * `coinselect` ships as CommonJS without TypeScript declarations;
 * `createRequire` is the cleanest path for the import.
 */

const requireCjs = createRequire(import.meta.url);
const coinSelect = requireCjs("coinselect") as (
  utxos: Array<{ value: number; [k: string]: unknown }>,
  outputs: Array<{ value?: number; [k: string]: unknown }>,
  feeRate: number,
) => { inputs?: Array<unknown>; outputs?: Array<unknown>; fee?: number };

/**
 * coinselect's default input/output estimator assumes legacy P2PKH
 * (148 vbytes per input, 34 per output). Our send path is segwit/
 * taproot only, so we pass explicit `script` Buffers on each input/
 * output to override coinselect's per-element vbyte estimate.
 *
 * P2WPKH input vsize ≈ 68; subtract coinselect's TX_INPUT_BASE of 41 →
 * 27 bytes of "script" we feed in. P2WPKH output scriptPubKey is 22
 * bytes (OP_0 + 0x14 + 20-byte hash). Same approximation for taproot
 * (P2TR input vsize ≈ 57; output scriptPubKey is 34 bytes).
 */
const SEGWIT_INPUT_SCRIPT_LEN = 27;
const SEGWIT_OUTPUT_SCRIPT_LEN = 22;

export interface CoinSelectInput {
  /** Tx hash of the prev-out (txid). */
  txid: string;
  /** Output index in the prev-tx. */
  vout: number;
  /** UTXO value in sats. */
  value: number;
}

export interface CoinSelectOutput {
  /** Recipient address (passed through opaque to the caller). */
  address: string;
  /** Amount in sats. */
  value: number;
}

export interface CoinSelectResult {
  inputs: CoinSelectInput[];
  outputs: Array<{ address?: string; value: number; isChange: boolean }>;
  /** Total fee in sats. */
  fee: number;
  /**
   * Index of the change output in `outputs`, or null if the selection
   * fits exactly without change. The caller wires this index to the
   * change-address path so Ledger can label it on-screen.
   */
  changeIndex: number | null;
}

/**
 * Select inputs from `utxos` to cover `outputs[]` + fee at `feeRate`.
 * `changeAddress` is appended internally so coinselect produces the
 * change-output value. Returns `null` if no feasible solution exists
 * (insufficient funds at the requested feeRate).
 *
 * Throws when the resulting fee would exceed the cap. The cap is the
 * MAXIMUM of two thresholds — a coarse vbyte-based cap (10× the
 * requested feeRate × estimated tx vsize) and a percentage-of-value
 * cap (2% of total non-change output value). Either alone has gaps
 * (vbyte-only doesn't catch a fat-fingered amount; percentage-only
 * doesn't catch a fat-fingered feeRate). Override via `allowHighFee`
 * for the rare legitimate >2% / >10× case.
 */
export function selectInputs(args: {
  utxos: CoinSelectInput[];
  outputs: CoinSelectOutput[];
  feeRate: number; // sat/vB
  changeAddress: string;
  allowHighFee?: boolean;
}): CoinSelectResult {
  if (
    !Number.isFinite(args.feeRate) ||
    args.feeRate <= 0 ||
    args.feeRate > 10_000
  ) {
    throw new Error(
      `Invalid feeRate ${args.feeRate} sat/vB — expected a positive finite number ≤ 10000.`,
    );
  }
  if (args.utxos.length === 0) {
    throw new Error(
      "No UTXOs available at the source address. The wallet needs at least one " +
        "confirmed UTXO; check `get_btc_balance` for the current state.",
    );
  }
  if (args.outputs.length === 0 || args.outputs.some((o) => o.value <= 0)) {
    throw new Error("All outputs must have a strictly-positive value (sats).");
  }

  // coinselect mutates / re-orders inputs internally; pass copies so
  // the caller's UTXO list isn't reordered. Inject `script` Buffers on
  // every input and output so coinselect's vbyte estimator matches
  // segwit/taproot reality (it defaults to legacy P2PKH otherwise —
  // ~80 vbytes per input over-estimate that turns "max" sends into
  // INSUFFICIENT-FUNDS errors).
  const utxosCopy = args.utxos.map((u) => ({
    ...u,
    script: { length: SEGWIT_INPUT_SCRIPT_LEN },
  }));
  const outputsForCS = args.outputs.map((o) => ({
    ...o,
    script: { length: SEGWIT_OUTPUT_SCRIPT_LEN },
  }));
  // coinselect appends change automatically when needed by adding an
  // output with no `address` field (we tag the change output below by
  // matching the un-addressed entry).
  const result = coinSelect(utxosCopy, outputsForCS, args.feeRate);
  if (!result.inputs || !result.outputs || result.fee === undefined) {
    throw new Error(
      `Insufficient funds for the requested send at ${args.feeRate} sat/vB. ` +
        "Available UTXOs cannot cover the outputs + fee. Lower the amount, " +
        "wait for more confirmations, or pass a lower feeRate.",
    );
  }

  // coinselect's output entries are { address?, value }. Entries
  // without an address are change. Tag them and inject the change
  // address.
  const outputs = (result.outputs as Array<{ address?: string; value: number }>).map(
    (o) => {
      if (o.address) {
        return { address: o.address, value: o.value, isChange: false };
      }
      return { address: args.changeAddress, value: o.value, isChange: true };
    },
  );
  const changeIndex = outputs.findIndex((o) => o.isChange);
  const inputs = (result.inputs as CoinSelectInput[]).map((i) => ({
    txid: i.txid,
    vout: i.vout,
    value: i.value,
  }));

  // Fee-cap guard.
  const totalOutputValue = args.outputs.reduce((sum, o) => sum + o.value, 0);
  const estimatedVbytes = roughVbytes(inputs.length, outputs.length);
  const vbyteCap = Math.ceil(args.feeRate * 10 * estimatedVbytes);
  const percentCap = Math.ceil(totalOutputValue * 0.02);
  const cap = Math.max(vbyteCap, percentCap);
  if (!args.allowHighFee && result.fee > cap) {
    throw new Error(
      `Fee ${result.fee} sats exceeds safety cap ${cap} sats ` +
        `(max of 10× feeRate-based ${vbyteCap} and 2%-of-output ${percentCap}). ` +
        `If this is intentional (priority send through congestion), retry with ` +
        `\`allowHighFee: true\` after confirming with the user.`,
    );
  }

  return {
    inputs,
    outputs,
    fee: result.fee,
    changeIndex: changeIndex >= 0 ? changeIndex : null,
  };
}

/**
 * Rough vbyte estimate for a P2WPKH single-account tx — same shape
 * coinselect uses internally. Slightly over-estimated (~2-3%) so the
 * fee-cap is conservative-tight rather than too loose; doesn't affect
 * coinselect's own fee math (which has its own internal estimator).
 *
 *   - 10 vbytes overhead (4 version + 1 input-count + 1 output-count + 4 locktime)
 *   - 68 vbytes per P2WPKH input
 *   - 31 vbytes per P2WPKH output
 *
 * For taproot (P2TR), input vbytes drop to ~57 — but the over-estimate
 * just makes the cap slightly looser, never tighter. Worth not
 * paramaterizing this for now.
 */
function roughVbytes(inputCount: number, outputCount: number): number {
  return 10 + inputCount * 68 + outputCount * 31;
}
