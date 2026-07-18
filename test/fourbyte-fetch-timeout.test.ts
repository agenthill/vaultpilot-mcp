/**
 * Tests for issue #694 — `fetch4byteSignatures`' `defaultFetch` (and any
 * caller-injected `FetchLike`) has no timeout, so a stalled/MITM'd
 * 4byte.directory connection stalls the pre-sign ABI cross-check
 * indefinitely — the project's own documented security-critical path
 * (`src/signing/verify-decode.ts` -> `verifyEvmCalldata`).
 *
 * `FetchLike` (`src/data/apis/fourbyte.ts`) takes only `(input: string)`
 * — no `init`/`signal` slot — so a caller-injected fetch can't be raced
 * against an `AbortSignal` the way a real `fetch(url, {signal})` can.
 * The fix has to bound the call generically (regardless of whether the
 * injected `fetchFn` cooperates with cancellation), which this test
 * exercises directly with a `FetchLike` that never resolves.
 */
import { describe, it, expect } from "vitest";
import { encodeFunctionData, getAddress } from "viem";
import { erc20Abi } from "../src/abis/erc20.js";
import { fetch4byteSignatures, type FetchLike } from "../src/data/apis/fourbyte.js";
import { verifyEvmCalldata } from "../src/signing/verify-decode.js";

const RECIPIENT = getAddress("0x2222222222222222222222222222222222222222");

const neverResolvingFetch: FetchLike = () => new Promise(() => {});

/** Poll `promise` until it settles or `deadlineMs` elapses, without
 * relying on the test's own (much larger) surrounding timeout to prove
 * the "settles within N ms" bound. */
async function settleWithin<T>(
  promise: Promise<T>,
  deadlineMs: number,
): Promise<{ ok: true; value: T } | { ok: false; error: unknown } | undefined> {
  let settled: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
  promise.then(
    (value) => {
      settled = { ok: true, value };
    },
    (error) => {
      settled = { ok: false, error };
    },
  );
  const deadline = Date.now() + deadlineMs;
  while (settled === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  return settled;
}

describe("fetch4byteSignatures — issue #694 untimed fetch", () => {
  it("rejects within timeoutMs + margin when the injected FetchLike never resolves", async () => {
    const timeoutMs = 200;
    const marginMs = 2000;

    const settled = await settleWithin(
      fetch4byteSignatures("0xdeadbeef", neverResolvingFetch, timeoutMs),
      timeoutMs + marginMs,
    );

    expect(settled).toBeDefined();
    if (settled && !settled.ok) {
      expect(settled.error).toBeInstanceOf(Error);
    } else {
      throw new Error(
        `expected fetch4byteSignatures to reject within ${timeoutMs + marginMs}ms, but it ${settled ? "resolved" : "never settled"}`,
      );
    }
  });
});

describe("verifyEvmCalldata — issue #694, hung 4byte fetch degrades to status:'error'", () => {
  it(
    "produces status:'error' (not a hang) when the pre-sign cross-check's fetch never resolves",
    async () => {
      const data = encodeFunctionData({
        abi: erc20Abi,
        functionName: "transfer",
        args: [RECIPIENT, 1_000_000n],
      });
      const tx = { data } as Parameters<typeof verifyEvmCalldata>[0];

      // verifyEvmCalldata doesn't thread a custom timeoutMs through to
      // fetch4byteSignatures, so this exercises the production default
      // (10s, matching data/http.ts's fetchWithTimeout convention) —
      // hence the generous margin and the per-test timeout override
      // below (vitest's file-wide default is 15s).
      const productionDefaultTimeoutMs = 10_000;
      const marginMs = 2_000;

      const settled = await settleWithin(
        verifyEvmCalldata(tx, neverResolvingFetch),
        productionDefaultTimeoutMs + marginMs,
      );

      expect(settled).toBeDefined();
      if (settled?.ok) {
        expect(settled.value.status).toBe("error");
        expect(settled.value.summary).toMatch(/Could not reach 4byte/);
      } else {
        throw new Error(
          `expected verifyEvmCalldata to settle (status:'error') within ${productionDefaultTimeoutMs + marginMs}ms, but it ${settled ? "rejected instead of returning status:error" : "never settled (hung)"}`,
        );
      }
    },
    14_000,
  );
});
