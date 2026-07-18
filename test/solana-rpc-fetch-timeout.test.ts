/**
 * Tests for issue #693 — `fetchWithRateLimitDetect` (the fetch shim wired
 * into the Solana `Connection`) has no timeout, so a stalled/malicious
 * upstream that accepts the TCP connection but never sends a body can
 * stall the MCP process indefinitely (undici default ~300s).
 *
 * Mirrors `src/data/http.ts`'s `fetchWithTimeout` AbortController pattern.
 * The mock `fetch` below models real `fetch` semantics: it never settles
 * on its own, but DOES reject once its `init.signal` fires abort — same
 * as undici's actual behavior. Before the fix, `fetchWithRateLimitDetect`
 * never constructs an `AbortController` or passes a `signal` through, so
 * the mock's `signal` is always undefined and the call hangs forever.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { _fetchWithRateLimitDetectForTests } from "../src/modules/solana/rpc.js";

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

function neverRespondingFetch(): typeof fetch {
  return vi.fn((_input: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("The operation was aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  }) as unknown as typeof fetch;
}

describe("fetchWithRateLimitDetect — issue #693 untimed fetch", () => {
  it("rejects with an abort-shaped error within timeoutMs + margin when the upstream never responds", async () => {
    global.fetch = neverRespondingFetch();

    const timeoutMs = 200;
    const marginMs = 2000;

    const call = _fetchWithRateLimitDetectForTests("https://example.com/rpc", undefined, timeoutMs);

    let settled: { ok: true } | { ok: false; error: unknown } | undefined;
    call.then(
      () => {
        settled = { ok: true };
      },
      (error) => {
        settled = { ok: false, error };
      },
    );

    // Poll for settlement instead of a single `await call` so we can
    // assert the "within timeoutMs + margin" bound directly rather than
    // relying on the surrounding test's own (much larger) timeout.
    const deadline = Date.now() + timeoutMs + marginMs;
    while (settled === undefined && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
    }

    expect(settled).toBeDefined();
    if (settled && !settled.ok) {
      const err = settled.error;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).name === "AbortError" || /abort/i.test((err as Error).message)).toBe(true);
    } else {
      throw new Error(
        `expected fetchWithRateLimitDetect to reject with an abort-shaped error within ${timeoutMs + marginMs}ms, but it ${settled ? "resolved" : "never settled"}`,
      );
    }
  });
});
