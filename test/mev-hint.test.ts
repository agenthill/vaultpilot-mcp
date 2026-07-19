/**
 * Sandwich-MEV exposure hint — pure function, fixture tests.
 */
import { describe, it, expect } from "vitest";
import {
  MEV_SLIPPAGE_BPS_THRESHOLD,
  mevExposureNote,
} from "../src/modules/swap/mev-hint.js";

describe("mevExposureNote", () => {
  it("threshold constant is 0.5% (50 bps)", () => {
    expect(MEV_SLIPPAGE_BPS_THRESHOLD).toBe(50);
  });

  it("returns undefined for non-mainnet chains regardless of slippage", () => {
    expect(mevExposureNote("arbitrum", 500, 10000)).toBeUndefined();
    expect(mevExposureNote("optimism", 1000, 10000)).toBeUndefined();
    expect(mevExposureNote("base", 200, 10000)).toBeUndefined();
    expect(mevExposureNote("polygon", 5000, 10000)).toBeUndefined();
  });

  it("returns undefined at or below the 50 bps threshold", () => {
    expect(mevExposureNote("ethereum", 50, 10000)).toBeUndefined();
    expect(mevExposureNote("ethereum", 25, 10000)).toBeUndefined();
    expect(mevExposureNote("ethereum", 0, 10000)).toBeUndefined();
  });

  it("returns USD-shaped message when notional is provided and finite", () => {
    const note = mevExposureNote("ethereum", 100, 10000);
    expect(note).toMatch(/up to ~\$100\.00 extractable via sandwich/);
    expect(note).toMatch(/1\.00% slippage on Ethereum mainnet/);
    expect(note).toMatch(/lowering slippage or splitting/);
  });

  it("scales the dollar figure with notional and slippage linearly", () => {
    const note = mevExposureNote("ethereum", 200, 50000);
    // 50_000 * 0.02 = 1000
    expect(note).toMatch(/up to ~\$1000\.00 extractable/);
    expect(note).toMatch(/2\.00% slippage/);
  });

  it("falls back to percentage-only message when notional is undefined", () => {
    const note = mevExposureNote("ethereum", 100, undefined);
    expect(note).toMatch(/up to 1\.00% of swap value extractable/);
    expect(note).not.toMatch(/\$/);
  });

  it("falls back to percentage-only message when notional is NaN or zero", () => {
    expect(mevExposureNote("ethereum", 100, NaN)).toMatch(
      /up to 1\.00% of swap value/,
    );
    expect(mevExposureNote("ethereum", 100, 0)).toMatch(
      /up to 1\.00% of swap value/,
    );
  });

  it("fires for slippages just above the threshold", () => {
    // 51 bps is one bp over the 50-bps threshold: the exact-threshold call is
    // a no-op, one bp above must fire AND carry the near-threshold content.
    expect(mevExposureNote("ethereum", 50, 1000)).toBeUndefined();
    const note = mevExposureNote("ethereum", 51, 1000);
    // 1000 * (51 / 10_000) = 5.10
    expect(note).toMatch(/up to ~\$5\.10 extractable via sandwich/);
    expect(note).toMatch(/0\.51% slippage on Ethereum mainnet/);
    expect(note).toMatch(/lowering slippage or splitting/);
  });
});
