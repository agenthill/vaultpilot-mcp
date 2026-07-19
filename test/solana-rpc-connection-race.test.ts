/**
 * Falsifier for issue #713 — "Solana cached-Connection rebuild has no
 * concurrency guard on URL swap" (ARCHITECTURE.md §4 INV-T1,
 * `robustness:solana-conn-cache-race`).
 *
 * The issue's own doc calls this "minor, benign" and asks for a test that
 * exercises a URL swap while a call is in flight, going RED if the swap
 * races (torn/duplicate Connection, lost swap).
 *
 * `getSolanaConnection()` (src/modules/solana/rpc.ts) is fully synchronous
 * top to bottom — `readUserConfig()` (readFileSync), `resolveSolanaRpcUrl()`,
 * `getRuntimeSolanaRpc()` (Map.get), and `new Connection(...)` all run
 * without a single `await` or Promise in between the cache-check and the
 * cache-write. Node has no worker threads in this server (grep confirms),
 * so every tool call runs on the one JS event-loop thread. A synchronous
 * function body cannot be preempted mid-execution by another call — the
 * whole check-then-rebuild sequence is atomic by construction, whatever
 * order "concurrent" (Promise.all-wrapped) callers are kicked off in.
 *
 * This test tries hard to falsify that: it fires a burst of overlapping
 * async callers, flips the runtime override between every one of them
 * (including via setTimeout(0)/microtask gaps to give the scheduler every
 * chance to interleave), then asserts the one thing a real race would
 * break — the lost-swap check `expect(results[results.length - 1]).toBe(
 * finalUrl)`: the last caller's returned endpoint must equal the
 * connection's final cached endpoint. If a yield ever opened a window
 * between the cache-check and the cache-write, a later caller could read
 * a stale cache and "lose" its swap to an earlier one — that's exactly
 * what this assertion goes RED on.
 *
 * Scope note: these callers are macrotask-scheduled (`setTimeout(0)`), so
 * this falsifies a macrotask/I-O yield at the check→write point — the
 * realistic sync→async-I/O regression — but not a pure-microtask-only
 * yield there, which is fine: a macrotask-scheduled caller can never
 * interleave with a microtask-only yield anyway.
 */
import { describe, it, expect, afterEach } from "vitest";
import { getSolanaConnection, resetSolanaConnection } from "../src/modules/solana/rpc.js";
import { setRuntimeOverride, clearRuntimeOverride } from "../src/data/runtime-rpc-overrides.js";

function endpointOf(connection: ReturnType<typeof getSolanaConnection>): string {
  return connection.rpcEndpoint;
}

afterEach(() => {
  resetSolanaConnection();
  clearRuntimeOverride("helius");
});

describe("getSolanaConnection — issue #713 concurrent URL-swap falsifier", () => {
  it("never returns a Connection whose endpoint disagrees with the cache it was drawn from", async () => {
    const HELIUS_KEY_A = "11111111-1111-1111-1111-111111111111";
    const HELIUS_KEY_B = "22222222-2222-2222-2222-222222222222";

    setRuntimeOverride("helius", HELIUS_KEY_A);
    const first = getSolanaConnection();
    const urlA = endpointOf(first);

    // Fire a burst of "concurrent" callers, each wrapped in a microtask/
    // macrotask gap, flipping the override between every single one so
    // the scheduler gets maximum opportunity to interleave if the
    // underlying code ever yields mid-rebuild.
    const results: string[] = [];
    const callers = Array.from({ length: 20 }, (_, i) =>
      (async () => {
        // Give the event loop a real chance to run other queued work
        // between the override flip and the call — a setTimeout(0) macrotask
        // gap, not just a microtask, to maximize interleaving opportunity.
        await new Promise((r) => setTimeout(r, 0));
        if (i % 2 === 0) {
          setRuntimeOverride("helius", HELIUS_KEY_B);
        } else {
          setRuntimeOverride("helius", HELIUS_KEY_A);
        }
        const conn = getSolanaConnection();
        results.push(endpointOf(conn));
      })(),
    );

    await Promise.all(callers);

    // Final state: cache must reflect exactly the last override set,
    // with no lost swap (a lost swap would leave the cache pinned to a
    // stale key even though the override map moved on).
    const finalUrl = endpointOf(getSolanaConnection());
    expect(results[results.length - 1]).toBe(finalUrl);
    expect(urlA.includes(HELIUS_KEY_A)).toBe(true);
  });
});
