/**
 * Regression tests for issue #690 — three follow-ups from the #687 /
 * PR #689 adversarial review:
 *
 * 1. Concurrent-attempt stale error: attempt A's approval() auto-rejects
 *    (the SDK's ~5-min "Proposal expired" timeout) AFTER attempt B's
 *    `initiatePairing` has already started (and cleared `lastPairingError`
 *    for its own attempt). Without a generation guard, A's stale rejection
 *    overwrites B's valid in-flight state with a terminal error B never had.
 *
 * 2. Reject-after-adopt race: the SAME attempt's `session_connect` event can
 *    `adoptSession` (clearing the error, going `paired: true`) microseconds
 *    before that attempt's own approval-promise timeout fires and re-sets
 *    the error — leaving a permanent stale "Proposal expired" error next to
 *    a healthy paired session.
 *
 * 3. `LAST_PAIRING_ERROR_GUIDANCE` wording: it's surfaced on BOTH the
 *    unpaired AND the paired return (a failed re-pair over a still-live
 *    session), so the copy must not assert unconditionally that "no session
 *    was persisted" — that's false on the paired-return path.
 *
 * The fix: a module-level `pairGen` counter. `initiatePairing` captures
 * `gen = ++pairGen` at entry; the catch block only writes `lastPairingError`
 * when `gen === pairGen` at rejection time. `adoptSession` also bumps
 * `pairGen` on a real (non-idempotent) adopt, which is what closes race (2):
 * the adopt bumps the counter, so the same attempt's later catch sees a
 * stale `gen` and skips the write.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same mock shape as test/wc-session-settle-687.test.ts — a fake SignClient
// whose `.on(...)` registrations are captured so the test can fire the
// durable `session_connect` listener directly, and whose `.connect()` is
// swappable per-test so each `initiatePairing()` call can be handed its own
// independently-resolvable approval promise.
const mock = vi.hoisted(() => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const relayerHandlers = new Map<string, (arg: unknown) => void>();
  const state = {
    connect: async () => ({
      uri: "wc:690default@2?relay-protocol=irn&symKey=deadbeef",
      approval: () => new Promise<never>(() => {}),
    }),
  };
  const mockClient: Record<string, unknown> = {
    on(event: string, handler: (arg: unknown) => void) {
      handlers.set(event, handler);
      return mockClient;
    },
    core: {
      relayer: {
        on(event: string, handler: (arg: unknown) => void) {
          relayerHandlers.set(event, handler);
        },
      },
    },
    session: { getAll: () => [] as unknown[] },
    ping: async () => {},
    connect: () => state.connect(),
    disconnect: async () => {},
  };
  const defaultConnect = state.connect;
  return { handlers, relayerHandlers, mockClient, state, defaultConnect };
});

vi.mock("@walletconnect/sign-client", () => ({
  SignClient: { init: vi.fn(async () => mock.mockClient) },
}));

vi.mock("../src/signing/walletconnect-peer-pin.js", () => ({
  pinLedgerLivePeer: () => ({ verdict: "match", message: "" }),
}));

function fakeSettledSession(topic: string, pairingTopic: string): unknown {
  return {
    topic,
    pairingTopic,
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    peer: {
      metadata: {
        name: "Ledger Live",
        url: "https://ledger.com",
        description: "",
      },
    },
    namespaces: {
      eip155: {
        accounts: [`eip155:1:0x1111111111111111111111111111111111111111`],
        methods: ["eth_sendTransaction"],
        events: ["accountsChanged"],
      },
    },
  };
}

/** A promise + external resolve/reject, so a test can fire the SDK's
 * approval rejection at a precisely chosen moment relative to other events. */
function makeDeferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let tmpHome: string;
let savedConfigDir: string | undefined;
let savedProjectId: string | undefined;

beforeEach(() => {
  vi.resetModules();
  mock.handlers.clear();
  mock.relayerHandlers.clear();
  mock.state.connect = mock.defaultConnect;
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-wc-690-"));
  savedConfigDir = process.env.VAULTPILOT_CONFIG_DIR;
  savedProjectId = process.env.WALLETCONNECT_PROJECT_ID;
  process.env.VAULTPILOT_CONFIG_DIR = tmpHome;
  process.env.WALLETCONNECT_PROJECT_ID = "test-project-690";
  writeFileSync(join(tmpHome, "config.json"), "{}\n");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.VAULTPILOT_CONFIG_DIR;
  else process.env.VAULTPILOT_CONFIG_DIR = savedConfigDir;
  if (savedProjectId === undefined) delete process.env.WALLETCONNECT_PROJECT_ID;
  else process.env.WALLETCONNECT_PROJECT_ID = savedProjectId;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("issue #690 (1) — concurrent-attempt stale error", () => {
  it("does not surface attempt A's late rejection once attempt B has started", async () => {
    const deferredA = makeDeferred<unknown>();
    const deferredB = makeDeferred<unknown>();
    let callCount = 0;
    mock.state.connect = async () => {
      callCount += 1;
      if (callCount === 1) {
        return {
          uri: "wc:690attemptA@2?relay-protocol=irn&symKey=aaaa",
          approval: () => deferredA.promise,
        };
      }
      return {
        uri: "wc:690attemptB@2?relay-protocol=irn&symKey=bbbb",
        approval: () => deferredB.promise,
      };
    };

    const wc = await import("../src/signing/walletconnect.js");

    // Attempt A starts.
    const pairA = await wc.initiatePairing();
    // Attempt B starts SECOND — this is the generation bump that must make
    // A's later rejection stale.
    const pairB = await wc.initiatePairing();
    void pairB.approval.catch(() => {});

    // A's approval now auto-rejects (~5-min "Proposal expired" timeout),
    // AFTER B already superseded it.
    deferredA.reject(new Error("Proposal expired"));
    await expect(pairA.approval).rejects.toThrow("Proposal expired");

    // FALSIFIER: on current code (no generation guard) this is set — RED.
    expect(wc.getLastPairingError()).toBeNull();

    await wc.disconnect().catch(() => {});
  });
});

describe("issue #690 (2) — reject-after-adopt race", () => {
  it("does not leave a stale error once the same attempt's session_connect has adopted", async () => {
    const deferredX = makeDeferred<unknown>();
    mock.state.connect = async () => ({
      uri: "wc:690attemptX@2?relay-protocol=irn&symKey=cccc",
      approval: () => deferredX.promise,
    });

    const wc = await import("../src/signing/walletconnect.js");
    const sessionMod = await import("../src/signing/session.js");

    const pairX = await wc.initiatePairing();

    // The durable session_connect listener adopts THIS attempt's session
    // microseconds before the approval promise's own timeout rejection
    // fires below (the race described in #690.2).
    const onConnect = mock.handlers.get("session_connect");
    expect(onConnect).toBeTypeOf("function");
    onConnect!({ session: fakeSettledSession("0xtopic690x", "0xpairing690x") });

    // Same attempt's approval promise now rejects (SDK timeout racing the
    // settle it already delivered out-of-band).
    deferredX.reject(new Error("Proposal expired"));
    await expect(pairX.approval).rejects.toThrow("Proposal expired");

    // FALSIFIER: on current code the catch unconditionally re-sets the
    // error here, leaving a permanent stale error next to paired:true — RED.
    expect(wc.getLastPairingError()).toBeNull();
    const status = await sessionMod.getSessionStatus();
    expect(status.paired).toBe(true);
    expect(status.lastPairingError).toBeUndefined();

    await wc.disconnect().catch(() => {});
  });
});

describe("issue #690 (3) — qualified LAST_PAIRING_ERROR_GUIDANCE wording", () => {
  it("qualifies the 'no session persisted' claim to the failed attempt only", async () => {
    const sessionMod = await import("../src/signing/session.js");
    const guidance = sessionMod.LAST_PAIRING_ERROR_GUIDANCE;

    // FALSIFIER: current code asserts unconditionally "no session was
    // persisted" / "the pairing did not complete" — false on the
    // paired-return path (a failed re-pair over a still-live session) — RED.
    expect(guidance).toContain(
      "no NEW session was persisted by that attempt",
    );
    expect(guidance).toContain("any existing session is unaffected");
    expect(guidance).not.toMatch(/\bno session was persisted\b/);
  });

  it("surfaces the qualified guidance on the PAIRED return (failed re-pair over a still-live session)", async () => {
    // First attempt succeeds and adopts a session.
    const deferred0 = makeDeferred<unknown>();
    mock.state.connect = async () => ({
      uri: "wc:690first@2?relay-protocol=irn&symKey=dddd",
      approval: () => deferred0.promise,
    });
    const wc = await import("../src/signing/walletconnect.js");
    const sessionMod = await import("../src/signing/session.js");

    const attempt0 = await wc.initiatePairing();
    deferred0.resolve(
      fakeSettledSession("0xtopic690paired", "0xpairing690paired"),
    );
    await attempt0.approval;

    let established = await sessionMod.getSessionStatus();
    expect(established.paired).toBe(true);
    expect(established.lastPairingError).toBeUndefined();

    // Second attempt (a re-pair) fails outright — no concurrent attempt
    // supersedes it, so its terminal error IS genuine and must surface.
    const deferred1 = makeDeferred<unknown>();
    mock.state.connect = async () => ({
      uri: "wc:690repair@2?relay-protocol=irn&symKey=eeee",
      approval: () => deferred1.promise,
    });
    const attempt1 = await wc.initiatePairing();
    deferred1.reject(new Error("second attempt failed"));
    await expect(attempt1.approval).rejects.toThrow("second attempt failed");

    const status = await sessionMod.getSessionStatus();
    // Still paired on the OLD (unaffected) session; the re-pair attempt's
    // own terminal failure is surfaced alongside it with the qualified copy.
    expect(status.paired).toBe(true);
    expect(status.lastPairingError?.message).toContain("second attempt failed");
    expect(status.lastPairingErrorGuidance).toBe(
      sessionMod.LAST_PAIRING_ERROR_GUIDANCE,
    );
    expect(status.lastPairingErrorGuidance).toContain(
      "no NEW session was persisted by that attempt",
    );

    await wc.disconnect().catch(() => {});
  });
});
