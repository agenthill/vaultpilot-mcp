import { describe, it, expect } from "vitest";

/**
 * Structural falsifier for the execution/index.ts decomposition (ARCHITECTURE
 * §5.2, issue #720). Two things are asserted per extracted target module:
 *
 *  1. RESOLVES-TO-TARGET: each named §5.2 symbol is exported by its target
 *     module file, AND the execution/index.ts barrel re-export is the SAME
 *     function reference — proving the symbol's home moved to the target and
 *     the barrel merely forwards it. If a symbol drifts back into
 *     execution/index.ts as its own definition, the identity check breaks.
 *
 *  2. EXPORT-ALLOWLIST: each target module exports EXACTLY its permitted
 *     surface — no more. A new export landing in the module (a re-accumulated
 *     responsibility) fails the set-equality check. This is the §5 preamble's
 *     per-module allowlist that keeps the one-time split from silently
 *     un-happening.
 *
 * This is a PARTIAL decomposition (pairing, tron/send, solana/send extracted;
 * evm-prepare, evm-send-pipeline, status/verification, btc/ltc-rpc still in
 * execution/index.ts). The allowlists below cover only the extracted modules.
 */

import * as pairing from "../src/modules/pairing/index.js";
import * as tronSend from "../src/modules/tron/send.js";
import * as solanaSend from "../src/modules/solana/send.js";
import * as execBarrel from "../src/modules/execution/index.js";

const PAIRING_ALLOWLIST = [
  "pairLedgerLive",
  "pairLedgerTron",
  "pairLedgerBitcoin",
  "pairLedgerSolana",
  "pairLedgerLitecoin",
].sort();

const TRON_SEND_ALLOWLIST = [
  "prepareTronLifiSwap",
  "prepareTronSunswapSwap",
  "sendTronTransaction",
].sort();

const SOLANA_SEND_ALLOWLIST = [
  "prepareSolanaNativeSend",
  "prepareSolanaSplSend",
  "prepareSolanaNonceInit",
  "prepareSolanaNonceClose",
  "getSolanaSwapQuote",
  "prepareMarginfiInit",
  "prepareMarginfiSupply",
  "prepareMarginfiWithdraw",
  "prepareMarginfiBorrow",
  "prepareMarginfiRepay",
  "prepareMarinadeStake",
  "prepareMarinadeUnstakeImmediate",
  "prepareJitoStake",
  "prepareNativeStakeDelegate",
  "prepareNativeStakeDeactivate",
  "prepareNativeStakeWithdraw",
  "prepareSolanaLifiSwap",
  "prepareKaminoInitUser",
  "prepareKaminoSupply",
  "prepareKaminoBorrow",
  "prepareKaminoWithdraw",
  "prepareKaminoRepay",
  "getKaminoPositions",
  "getMarginfiPositions",
  "getSolanaStakingPositions",
  "getMarginfiDiagnostics",
  "getSolanaSetupStatus",
  "prepareSolanaSwap",
  "previewSolanaSend",
  "sendSolanaTransaction",
].sort();

function exportedNames(ns: Record<string, unknown>): string[] {
  return Object.keys(ns)
    .filter((k) => typeof (ns as Record<string, unknown>)[k] === "function")
    .sort();
}

describe("execution/index.ts decomposition (#720, ARCHITECTURE §5.2)", () => {
  it("modules/pairing exports EXACTLY its allowlisted pair_ledger_* surface", () => {
    expect(exportedNames(pairing)).toEqual(PAIRING_ALLOWLIST);
  });

  it("modules/tron/send exports EXACTLY its allowlisted TRON send surface", () => {
    expect(exportedNames(tronSend)).toEqual(TRON_SEND_ALLOWLIST);
  });

  it("modules/solana/send exports EXACTLY its allowlisted Solana pipeline surface", () => {
    expect(exportedNames(solanaSend)).toEqual(SOLANA_SEND_ALLOWLIST);
  });

  it("pairing symbols resolve to modules/pairing (barrel forwards the same ref)", () => {
    for (const name of PAIRING_ALLOWLIST) {
      expect((execBarrel as Record<string, unknown>)[name]).toBe(
        (pairing as Record<string, unknown>)[name],
      );
    }
  });

  it("TRON prepare tools resolve to modules/tron/send (barrel forwards the same ref)", () => {
    // sendTronTransaction is a private dispatcher helper — imported by the
    // barrel, not re-exported — so only the public prepare tools are checked
    // for barrel identity.
    for (const name of ["prepareTronLifiSwap", "prepareTronSunswapSwap"]) {
      expect((execBarrel as Record<string, unknown>)[name]).toBe(
        (tronSend as Record<string, unknown>)[name],
      );
    }
  });

  it("Solana public tools resolve to modules/solana/send (barrel forwards the same ref)", () => {
    // sendSolanaTransaction is a private dispatcher helper — imported by the
    // barrel, not re-exported.
    const publicSolana = SOLANA_SEND_ALLOWLIST.filter(
      (n) => n !== "sendSolanaTransaction",
    );
    for (const name of publicSolana) {
      expect((execBarrel as Record<string, unknown>)[name]).toBe(
        (solanaSend as Record<string, unknown>)[name],
      );
    }
  });
});
