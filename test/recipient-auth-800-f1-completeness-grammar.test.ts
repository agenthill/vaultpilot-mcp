/**
 * FALSIFIERS for incident #800 F1 — the recipient-authorization completeness
 * guard is not total over the ABI type grammar (latent, exploitability 15/100
 * today — no reachable drain, since no RECOGNIZED ABI currently carries any of
 * these shapes; the defect is in the GUARANTEE, not a live path).
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │ STATUS: these tests assert the SAFE (total) behaviour — an unclassifiable │
 * │ address/bytes leaf on a recognized-kind ABI must be FLAGGED / must FAIL   │
 * │ BOOT. They are RED against current `main` BY DESIGN — the walker is       │
 * │ blind to these type-string shapes and silently emits zero leaves, so      │
 * │ neither `findUnclassifiedPaths()` nor `assertClassificationComplete()`    │
 * │ ever sees them. TEST-ONLY, no src/ change lands on this branch.           │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * The defect (agenthill/vaultpilot-mcp #800, F1):
 *   `walkParam` (`src/signing/recipient-authorization.ts` ~322-368) branches
 *   on exactly seven type strings — `address`, `address[]`, `bytes`,
 *   `bytes32`, `bytes[]`, `tuple`, `tuple[]` — and everything else falls off
 *   the end into the scalar-catch-all comment ("scalar non-address … not an
 *   authorization surface"), emitting NO leaf. There is no terminal `else`
 *   that fails loud. Fixed-size arrays (`address[2]`), non-32 fixed bytes
 *   (`bytes20`), and fixed-size tuple arrays (`tuple[2]`) are all valid
 *   Solidity ABI type strings the walker has never seen and cannot classify
 *   — a `distribute((address recipient,uint256)[2] payouts)` landing in
 *   `RECOGNIZED_ABIS_BY_KIND` tomorrow would boot clean AND sign unstamped:
 *   `assertClassificationComplete()` (~413-445) walks the SAME blind
 *   `walkParam`, so it never demands a bucket for a leaf it never emits, and
 *   `gateCall` (the runtime gate) walks the identical function and gates
 *   zero leaves. #757 reopens by construction, with a green suite and no
 *   review signal.
 *
 * TWO LAYERS tested here, both against the same three blind shapes:
 *   1. `findUnclassifiedPaths()` — SEC's own exported probe, a pure function
 *      over an arbitrary ABI array (no module-reload needed). This is the
 *      mechanism `assertClassificationComplete()` is built on: both call the
 *      same `walkFunction`/`walkParam`, so a leaf this probe cannot see is a
 *      leaf the boot guard cannot see either.
 *   2. `assertClassificationComplete()` at REAL module-load — the actual
 *      runtime guarantee ("won't boot"). A synthetic kind is injected into
 *      `RECOGNIZED_ABIS_BY_KIND` (via `vi.doMock` on
 *      `recognized-destinations.js` + a fresh dynamic import of
 *      `recipient-authorization.js`, which runs `assertClassificationComplete()`
 *      as a load-time side effect — matching this repo's `vi.resetModules()`
 *      + per-test `vi.doMock` idiom, e.g. `test/757-recipient-authorization.test.ts`'s
 *      `previewOf` helper). A positive control (a synthetic kind carrying a
 *      plain unclassified `address`) proves the injection+throw mechanism
 *      itself works — its absence would make a "doesn't throw" result
 *      meaningless.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Abi } from "viem";
import { findUnclassifiedPaths } from "../src/signing/recipient-authorization.js";

// ═══════════════════════ Layer 1 — findUnclassifiedPaths() ═══════════════════
describe("#800 F1 — findUnclassifiedPaths(): the walker's grammar coverage", () => {
  // ── Positive controls — mirrors the #800 evidence table's DETECTED column.
  // These must (and do) pass on main; they prove the probe correctly flags an
  // unclassified leaf when the walker CAN see it, before the blind-spot cases
  // show shapes it cannot.
  describe("positive controls (DETECTED today — same walker, simple shapes)", () => {
    it("plain `address` arg is reported unclassified", () => {
      const abi = [
        {
          type: "function",
          name: "sendTo",
          stateMutability: "nonpayable",
          inputs: [{ name: "target", type: "address" }],
          outputs: [],
        },
      ] as const;
      expect(findUnclassifiedPaths([abi as unknown as Abi])).toContain("sendTo.target");
    });

    it("`address[]` (dynamic array) arg is reported unclassified", () => {
      const abi = [
        {
          type: "function",
          name: "sendToMany",
          stateMutability: "nonpayable",
          inputs: [{ name: "targets", type: "address[]" }],
          outputs: [],
        },
      ] as const;
      expect(findUnclassifiedPaths([abi as unknown as Abi])).toContain("sendToMany.targets");
    });

    it("`tuple[]` (dynamic array of tuples) with a nested address leaf is reported unclassified", () => {
      const abi = [
        {
          type: "function",
          name: "distributeDynamic",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "payouts",
              type: "tuple[]",
              components: [
                { name: "recipient", type: "address" },
                { name: "amount", type: "uint256" },
              ],
            },
          ],
          outputs: [],
        },
      ] as const;
      expect(findUnclassifiedPaths([abi as unknown as Abi])).toContain(
        "distributeDynamic.payouts.recipient",
      );
    });
  });

  // ── BLIND SPOTS — the #800 F1 falsifiers. RED on main: the walker emits NO
  // leaf at all for these type strings (falls into the untyped scalar
  // catch-all), so `findUnclassifiedPaths` returns an array that does NOT
  // contain the expected path — the assertion below is what a TOTAL walker
  // must satisfy, and fails today.
  describe("blind spots (RED today — walker emits zero leaves, not even 'unclassified')", () => {
    it("`address[2]` (fixed-size array) MUST be reported unclassified", () => {
      const abi = [
        {
          type: "function",
          name: "drainFixed",
          stateMutability: "nonpayable",
          inputs: [{ name: "recipients", type: "address[2]" }],
          outputs: [],
        },
      ] as const;
      const unclassified = findUnclassifiedPaths([abi as unknown as Abi]);
      expect(unclassified, `got ${JSON.stringify(unclassified)} — expected 'drainFixed.recipients'`).toContain(
        "drainFixed.recipients",
      );
    });

    it("`bytes20` (non-32 fixed bytes) MUST be reported unclassified", () => {
      const abi = [
        {
          type: "function",
          name: "drainBytes20",
          stateMutability: "nonpayable",
          inputs: [{ name: "chunk", type: "bytes20" }],
          outputs: [],
        },
      ] as const;
      const unclassified = findUnclassifiedPaths([abi as unknown as Abi]);
      expect(unclassified, `got ${JSON.stringify(unclassified)} — expected 'drainBytes20.chunk'`).toContain(
        "drainBytes20.chunk",
      );
    });

    it("`tuple[2]` (fixed-size tuple array) with a nested address leaf MUST be reported unclassified", () => {
      // The exact shape #800 names: distribute((address recipient,uint256)[2] payouts).
      const abi = [
        {
          type: "function",
          name: "distributeFixed",
          stateMutability: "nonpayable",
          inputs: [
            {
              name: "payouts",
              type: "tuple[2]",
              components: [
                { name: "recipient", type: "address" },
                { name: "amount", type: "uint256" },
              ],
            },
          ],
          outputs: [],
        },
      ] as const;
      const unclassified = findUnclassifiedPaths([abi as unknown as Abi]);
      expect(
        unclassified,
        `got ${JSON.stringify(unclassified)} — expected 'distributeFixed.payouts.recipient'`,
      ).toContain("distributeFixed.payouts.recipient");
    });
  });
});

// ═══════════════════ Layer 2 — assertClassificationComplete() at boot ═══════════
describe("#800 F1 — assertClassificationComplete(): the module-boot guarantee", () => {
  beforeEach(() => vi.resetModules());
  afterEach(async () => {
    vi.doUnmock("../src/signing/recognized-destinations.js");
    vi.restoreAllMocks();
  });

  /**
   * Inject `abis` as a brand-new recognized kind (`f1-synthetic-<suffix>`)
   * alongside the real ones, then dynamically re-import
   * `recipient-authorization.js` — which runs `buildFnBySelector()` +
   * `assertClassificationComplete()` as a load-time side effect (module
   * bottom, ~L759-760). A throw during evaluation surfaces as a REJECTED
   * import promise.
   */
  function mockSyntheticKind(suffix: string, abis: readonly Abi[]): void {
    vi.doMock("../src/signing/recognized-destinations.js", async (importOriginal) => {
      const orig =
        await importOriginal<typeof import("../src/signing/recognized-destinations.js")>();
      return {
        ...orig,
        RECOGNIZED_ABIS_BY_KIND: {
          ...orig.RECOGNIZED_ABIS_BY_KIND,
          [`f1-synthetic-${suffix}`]: abis,
        },
      };
    });
  }

  it("BOOT POSITIVE CONTROL — a synthetic kind with a plain unclassified `address` arg DOES fail boot (proves the injection+throw mechanism works)", async () => {
    const abi = [
      {
        type: "function",
        name: "sweepTo",
        stateMutability: "nonpayable",
        inputs: [{ name: "target", type: "address" }],
        outputs: [],
      },
    ] as const;
    mockSyntheticKind("plain-address", [abi as unknown as Abi]);
    await expect(import("../src/signing/recipient-authorization.js")).rejects.toThrow(
      /UNCLASSIFIED address path 'target' on sweepTo/,
    );
  });

  it("`address[2]` recipients injected into a recognized kind MUST fail boot (RED today: boots silently, walker blind)", async () => {
    const abi = [
      {
        type: "function",
        name: "drainFixed",
        stateMutability: "nonpayable",
        inputs: [{ name: "recipients", type: "address[2]" }],
        outputs: [],
      },
    ] as const;
    mockSyntheticKind("address2", [abi as unknown as Abi]);
    await expect(import("../src/signing/recipient-authorization.js")).rejects.toThrow();
  });

  it("`bytes20` injected into a recognized kind MUST fail boot (RED today: boots silently, walker blind)", async () => {
    const abi = [
      {
        type: "function",
        name: "drainBytes20",
        stateMutability: "nonpayable",
        inputs: [{ name: "chunk", type: "bytes20" }],
        outputs: [],
      },
    ] as const;
    mockSyntheticKind("bytes20", [abi as unknown as Abi]);
    await expect(import("../src/signing/recipient-authorization.js")).rejects.toThrow();
  });

  it("`tuple[2]` (#800's own example — distribute((address recipient,uint256)[2] payouts)) injected into a recognized kind MUST fail boot (RED today: boots silently, walker blind)", async () => {
    const abi = [
      {
        type: "function",
        name: "distribute",
        stateMutability: "nonpayable",
        inputs: [
          {
            name: "payouts",
            type: "tuple[2]",
            components: [
              { name: "recipient", type: "address" },
              { name: "amount", type: "uint256" },
            ],
          },
        ],
        outputs: [],
      },
    ] as const;
    mockSyntheticKind("tuple2", [abi as unknown as Abi]);
    await expect(import("../src/signing/recipient-authorization.js")).rejects.toThrow();
  });
});
