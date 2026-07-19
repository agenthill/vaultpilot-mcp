import { consumeTronHandle, retireTronHandle } from "../../signing/tron-tx-store.js";
import {
  signTronTxOnLedger,
  getPairedTronByAddress,
} from "../../signing/tron-usb-signer.js";
import { broadcastTronTx } from "./broadcast.js";
import { tronPayloadFingerprint } from "../../signing/verification.js";
import type {
  PrepareTronLifiSwapArgs,
  PrepareTronSunswapSwapArgs,
  SendTransactionArgs,
} from "../execution/schemas.js";
import type { UnsignedTronTx } from "../../types/index.js";

export async function prepareTronLifiSwap(
  args: PrepareTronLifiSwapArgs,
): Promise<UnsignedTronTx> {
  const { buildTronLifiSwap } = await import("./lifi-swap.js");
  const slippage =
    args.slippageBps !== undefined ? args.slippageBps / 10_000 : undefined;
  return buildTronLifiSwap({
    wallet: args.wallet,
    fromToken: args.fromToken,
    fromAmount: args.fromAmount,
    toChain: args.toChain as Parameters<typeof buildTronLifiSwap>[0]["toChain"],
    toToken: args.toToken,
    toAddress: args.toAddress,
    ...(slippage !== undefined ? { slippage } : {}),
  });
}

export async function prepareTronSunswapSwap(
  args: PrepareTronSunswapSwapArgs,
): Promise<UnsignedTronTx> {
  const { buildTronSunswapSwap } = await import("./sunswap-swap.js");
  return buildTronSunswapSwap({
    wallet: args.wallet,
    fromToken: args.fromToken,
    toToken: args.toToken,
    amount: args.amount,
    ...(args.slippageBps !== undefined ? { slippageBps: args.slippageBps } : {}),
    ...(args.deadlineSeconds !== undefined
      ? { deadlineSeconds: args.deadlineSeconds }
      : {}),
    ...(args.fromTokenDecimals !== undefined
      ? { fromTokenDecimals: args.fromTokenDecimals }
      : {}),
    ...(args.toTokenDecimals !== undefined
      ? { toTokenDecimals: args.toTokenDecimals }
      : {}),
    ...(args.feeLimitTrx !== undefined ? { feeLimitTrx: args.feeLimitTrx } : {}),
  });
}

export async function sendTronTransaction(args: SendTransactionArgs): Promise<{
  txHash: string;
  chain: "tron";
}> {
  const tx: UnsignedTronTx = consumeTronHandle(args.handle);
  // Preview-gate enforcement. TRON has no preview step — prepare_tron_*
  // produces the signable artifact directly — so the gate here is just
  // the `userDecision: "send"` literal, without a token. It pins the
  // same careless-mistake invariant as on EVM: an agent collapsing
  // prepare + send into a single silent step without pausing to surface
  // the VERIFY block gets a clear-error refusal naming the missing arg.
  // TRON clear-signs every supported action on-device, so even if a
  // hostile agent forges this literal, the Ledger screen's decoded
  // fields are the source of truth — but skipping the reply is the
  // UX-honesty bar we want to enforce.
  if (args.userDecision !== "send") {
    throw new Error(
      "Missing `userDecision: \"send\"` arg on send_transaction. Set this " +
        "AFTER presenting the VERIFY-BEFORE-SIGNING block from the " +
        "prepare_tron_* tool result and receiving the user's explicit " +
        "'send' reply. The literal proves the prepare-time summary was " +
        "shown to the user rather than silently bypassed.",
    );
  }
  // Proof-of-identity guard: recompute the domain-tagged hash of the EXACT
  // rawDataHex that the USB signer is about to hand to the Ledger, and
  // require equality with the hash the user previewed. A drift here means
  // tx state mutated between handle issuance and send — should never
  // happen, but the invariant is cheap to enforce and exactly what turns
  // "trust me" into "same bytes, same hash".
  if (tx.verification) {
    const rehash = tronPayloadFingerprint(tx.rawDataHex);
    if (rehash !== tx.verification.payloadHash) {
      throw new Error(
        `SECURITY: TRON payload hash mismatch at send time. Previewed ${tx.verification.payloadHash}, ` +
          `about to sign ${rehash}. The rawDataHex changed between preview and send — refusing ` +
          `to forward to the Ledger. Do NOT retry this handle. Re-prepare the transaction from ` +
          `scratch (call the prepare_* tool again) and compare the new preview carefully — a ` +
          `drift here means the bytes mutated inside the MCP process between the moment the user ` +
          `reviewed them and the moment they would have been signed, which is not a normal ` +
          `operating condition and may indicate a compromised intermediary.`,
      );
    }
  }
  // If the user paired this `from` via `pair_ledger_tron`, use the path they
  // paired on (covers non-default account slots). If we have no paired entry
  // for `from`, fall through to the signer's default path — the device
  // address check inside signTronTxOnLedger will then surface a clear error
  // telling the user to pair the right slot.
  const paired = getPairedTronByAddress(tx.from);
  const { signature } = await signTronTxOnLedger({
    rawDataHex: tx.rawDataHex,
    expectedFrom: tx.from,
    ...(paired ? { path: paired.path } : {}),
  });
  const { txID } = await broadcastTronTx(tx, signature);
  // Only retire the handle after successful broadcast. If signing fails
  // (user rejected, device disconnected) or the broadcast fails (transient
  // TronGrid error), the handle stays valid and the caller can retry
  // within the 15-min TTL without re-preparing.
  retireTronHandle(args.handle);
  return { txHash: txID, chain: "tron" };
}
