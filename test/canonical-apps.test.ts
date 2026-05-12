import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  CANONICAL_LEDGER_APPS,
  assertCanonicalLedgerApp,
  _setCanonicalAppWarnHook,
} from "../src/signing/canonical-apps.ts";

/**
 * Tests for the canonical Ledger app version manifest (issue #325 P2).
 * Pure unit tests — no Ledger device, no transport.
 */

let warnings: string[] = [];
let restoreWarnHook: ReturnType<typeof _setCanonicalAppWarnHook>;

beforeEach(() => {
  warnings = [];
  restoreWarnHook = _setCanonicalAppWarnHook((msg) => {
    warnings.push(msg);
  });
});

afterEach(() => {
  _setCanonicalAppWarnHook(restoreWarnHook);
});

describe("assertCanonicalLedgerApp — accept", () => {
  it("accepts a known-good Bitcoin version with no warning", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Bitcoin",
        reportedVersion: "2.4.6",
        expectedNames: ["Bitcoin"],
      }),
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });

  it("accepts the Bitcoin Test alias", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Bitcoin Test",
        reportedVersion: "2.4.6",
        expectedNames: ["Bitcoin"],
      }),
    ).not.toThrow();
  });

  it("accepts the BTC alias", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "BTC",
        reportedVersion: "2.4.6",
        expectedNames: ["Bitcoin"],
      }),
    ).not.toThrow();
  });

  it("accepts Litecoin / Litecoin Test / LTC aliases", () => {
    for (const name of ["Litecoin", "Litecoin Test", "LTC"]) {
      expect(() =>
        assertCanonicalLedgerApp({
          reportedName: name,
          reportedVersion: "2.4.11",
          expectedNames: ["Litecoin"],
        }),
      ).not.toThrow();
    }
  });

  it("accepts a known-good Solana version", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Solana",
        reportedVersion: "1.12.1",
        expectedNames: ["Solana"],
      }),
    ).not.toThrow();
  });

  it("accepts a known-good TRON version", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Tron",
        reportedVersion: "0.7.4",
        expectedNames: ["Tron"],
      }),
    ).not.toThrow();
  });
});

describe("assertCanonicalLedgerApp — refuse", () => {
  it("refuses an unknown app name", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Ethereum",
        reportedVersion: "1.10.0",
        expectedNames: ["Bitcoin"],
      }),
    ).toThrow(/not a known Ledger app/);
  });

  it("refuses when the reported app isn't in expectedNames", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Solana",
        reportedVersion: "1.12.1",
        expectedNames: ["Bitcoin"],
      }),
    ).toThrow(/expected one of: Bitcoin/);
  });

  it("refuses a Bitcoin version below minVersion", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Bitcoin",
        reportedVersion: "2.0.5",
        expectedNames: ["Bitcoin"],
      }),
    ).toThrow(/below the minimum supported version 2\.4\.0/);
  });

  it("refuses a TRON version below minVersion", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Tron",
        reportedVersion: "0.6.5",
        expectedNames: ["Tron"],
      }),
    ).toThrow(/below the minimum supported version 0\.7\.0/);
  });

  it("refuses a Solana version below minVersion", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Solana",
        reportedVersion: "0.9.9",
        expectedNames: ["Solana"],
      }),
    ).toThrow(/below the minimum supported version 1\.10\.0/);
  });

  it("refuses a Litecoin version below minVersion", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Litecoin",
        reportedVersion: "2.3.0",
        expectedNames: ["Litecoin"],
      }),
    ).toThrow(/below the minimum supported version 2\.4\.0/);
  });

  it("refuses a malformed name with no canonical mapping", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "DefinitelyNotAnApp",
        reportedVersion: "1.0.0",
      }),
    ).toThrow(/not a known Ledger app/);
  });
});

describe("assertCanonicalLedgerApp — warn-but-accept", () => {
  it("warns when version is at-or-above floor but not in knownGood", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Bitcoin",
        reportedVersion: "2.5.0",
        expectedNames: ["Bitcoin"],
      }),
    ).not.toThrow();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/not on the known-good list/);
  });

  it("does not warn for an explicit known-good version", () => {
    expect(() =>
      assertCanonicalLedgerApp({
        reportedName: "Bitcoin",
        reportedVersion: "2.4.11",
        expectedNames: ["Bitcoin"],
      }),
    ).not.toThrow();
    expect(warnings).toEqual([]);
  });
});

describe("CANONICAL_LEDGER_APPS shape", () => {
  it("covers the four USB-direct chains", () => {
    expect(Object.keys(CANONICAL_LEDGER_APPS).sort()).toEqual([
      "Bitcoin",
      "Litecoin",
      "Solana",
      "Tron",
    ]);
  });

  it("every entry has minVersion and at least one knownGood", () => {
    for (const [name, entry] of Object.entries(CANONICAL_LEDGER_APPS)) {
      expect(entry.minVersion, `${name} minVersion`).toMatch(/^\d+\.\d+\.\d+$/);
      expect(entry.knownGood.length, `${name} knownGood`).toBeGreaterThanOrEqual(1);
      // Every knownGood entry should be at-or-above the minVersion
      // (otherwise the manifest is internally inconsistent).
      for (const v of entry.knownGood) {
        expect(v, `${name} knownGood entry`).toMatch(/^\d+\.\d+\.\d+$/);
      }
    }
  });
});
