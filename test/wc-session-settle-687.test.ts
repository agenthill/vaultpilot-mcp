/**
 * Regression tests for issue #687 — EVM WalletConnect settle-capture was
 * fire-and-forget. The settled session was persisted ONLY inside the approval
 * promise's async IIFE in `initiatePairing`; `getSignClient` wired
 * `session_delete` / `session_expire` listeners but NO settle listener. If the
 * approval promise rejected or never resolved (relay idle-drop, invalid
 * projectId), `currentSession` stayed null and `~/.vaultpilot-mcp/config.json`
 * was never written, so `get_ledger_status` reported `paired: false` forever.
 *
 * The fix adds a durable `client.on("session_connect", ({ session }) =>
 * adoptSession(client, session))` listener that persists the session
 * independently of the promise, plus surfacing of a terminal pairing-failure
 * error (`lastPairingError`) through `get_ledger_status`.
 *
 * These tests mock the WalletConnect `SignClient` so no real relay is touched,
 * and use a throwaway config dir so the developer's real `~/.vaultpilot-mcp/`
 * is never written.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hoisted mock state so the `vi.mock` factory below can reach it. The mock
// client records every `.on(...)` registration into `handlers` so the test
// can fetch and invoke the durable `session_connect` listener directly.
const mock = vi.hoisted(() => {
  const handlers = new Map<string, (arg: unknown) => void>();
  const relayerHandlers = new Map<string, (arg: unknown) => void>();
  const state = {
    // Default: `approval()` NEVER resolves — the core #687 scenario. A
    // rejecting variant is swapped in for the terminal-error test.
    connect: async () => ({
      uri: "wc:687settle@2?relay-protocol=irn&symKey=deadbeef",
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

// Keep the peer-pin quiet + deterministic — it's non-blocking UX, not under
// test here, and the real one warns on a synthetic session's metadata.
vi.mock("../src/signing/walletconnect-peer-pin.js", () => ({
  pinLedgerLivePeer: () => ({ verdict: "match", message: "" }),
}));

const TOPIC = "0xtopic687settlecapture";
const PAIRING_TOPIC = "0xpairing687";
const ADDRESS = "0x1111111111111111111111111111111111111111";

function fakeSettledSession(): unknown {
  return {
    topic: TOPIC,
    pairingTopic: PAIRING_TOPIC,
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
        accounts: [`eip155:1:${ADDRESS}`],
        methods: ["eth_sendTransaction"],
        events: ["accountsChanged"],
      },
    },
  };
}

let tmpHome: string;
let savedConfigDir: string | undefined;
let savedProjectId: string | undefined;

beforeEach(() => {
  vi.resetModules();
  mock.handlers.clear();
  mock.relayerHandlers.clear();
  mock.state.connect = mock.defaultConnect;
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-wc-687-"));
  // Direct assignment (NOT vi.stubEnv): the vitest config sets
  // `unstubEnvs: true`, which auto-clears stubEnv-created overrides and would
  // let `getConfigDir()` fall back to the developer's real ~/.vaultpilot-mcp.
  // A plain process.env write is immune to that auto-unstub.
  savedConfigDir = process.env.VAULTPILOT_CONFIG_DIR;
  savedProjectId = process.env.WALLETCONNECT_PROJECT_ID;
  process.env.VAULTPILOT_CONFIG_DIR = tmpHome;
  process.env.WALLETCONNECT_PROJECT_ID = "test-project-687";
  // Seed an empty config so `readUserConfig()` reads THIS dir and never falls
  // back to the hardcoded legacy `~/.recon-crypto-mcp/config.json` (which is
  // NOT env-overridable and would leak the developer's real session topic).
  writeFileSync(join(tmpHome, "config.json"), "{}\n");
});

afterEach(() => {
  if (savedConfigDir === undefined) delete process.env.VAULTPILOT_CONFIG_DIR;
  else process.env.VAULTPILOT_CONFIG_DIR = savedConfigDir;
  if (savedProjectId === undefined) delete process.env.WALLETCONNECT_PROJECT_ID;
  else process.env.WALLETCONNECT_PROJECT_ID = savedProjectId;
  rmSync(tmpHome, { recursive: true, force: true });
});

describe("issue #687 — durable session_connect settle capture", () => {
  it("persists the settled session via the session_connect listener even when the approval promise never resolves", async () => {
    const wc = await import("../src/signing/walletconnect.js");
    const sessionMod = await import("../src/signing/session.js");
    const { readUserConfig } = await import("../src/config/user-config.js");

    // Kick off pairing. This wires the SDK listeners (inside getSignClient)
    // and starts the fire-and-forget approval promise that NEVER resolves —
    // so the ONLY path that can persist the session is the new listener.
    const pair = await wc.initiatePairing();
    expect(pair.uri).toContain("wc:");
    void pair.approval.catch(() => {});

    // Before the event: nothing persisted, unpaired. (The promise can't
    // resolve, so the old code would sit here forever.)
    expect(readUserConfig()?.walletConnect?.sessionTopic).toBeUndefined();
    expect(await wc.getConnectedAccounts()).toEqual([]);
    expect((await sessionMod.getSessionStatus()).paired).toBe(false);

    // The durable settle listener MUST be registered. FALSIFIER: delete the
    // `client.on("session_connect", ...)` line in getSignClient and this is
    // undefined → the test goes RED here (and at the persistence asserts).
    const onConnect = mock.handlers.get("session_connect");
    expect(
      onConnect,
      "session_connect listener was not registered — the #687 fix is missing",
    ).toBeTypeOf("function");

    // Fire the settle event. ONLY this path can persist the session now.
    onConnect!({ session: fakeSettledSession() });

    // adoptSession must have persisted the topic to disk...
    expect(readUserConfig()?.walletConnect?.sessionTopic).toBe(TOPIC);
    // ...and the connected-accounts view + get_ledger_status must reflect it.
    expect(await wc.getConnectedAccounts()).toEqual([ADDRESS]);
    const status = await sessionMod.getSessionStatus();
    expect(status.paired).toBe(true);
    expect(status.accounts).toContain(ADDRESS);
    expect(status.topic).toBe(TOPIC);

    await wc.disconnect().catch(() => {});
  });

  it("is idempotent — a second session_connect for the same topic does not re-persist or throw", async () => {
    const wc = await import("../src/signing/walletconnect.js");
    const { readUserConfig } = await import("../src/config/user-config.js");
    await wc.initiatePairing();

    const onConnect = mock.handlers.get("session_connect");
    expect(onConnect).toBeTypeOf("function");
    onConnect!({ session: fakeSettledSession() });
    const firstTopic = readUserConfig()?.walletConnect?.sessionTopic;
    // Double capture (promise + event both firing) must be a safe no-op.
    expect(() => onConnect!({ session: fakeSettledSession() })).not.toThrow();
    expect(readUserConfig()?.walletConnect?.sessionTopic).toBe(firstTopic);
    expect(await wc.getConnectedAccounts()).toEqual([ADDRESS]);

    await wc.disconnect().catch(() => {});
  });
});

describe("issue #687 — terminal pairing-failure surfacing", () => {
  it("records lastPairingError and surfaces it through get_ledger_status when the approval promise rejects", async () => {
    // Swap in a connect whose approval REJECTS (relay never delivered settle).
    mock.state.connect = async () => ({
      uri: "wc:687reject@2?relay-protocol=irn&symKey=beef",
      approval: () => Promise.reject(new Error("relay never delivered settle")),
    });

    const wc = await import("../src/signing/walletconnect.js");
    const sessionMod = await import("../src/signing/session.js");

    const pair = await wc.initiatePairing();
    await expect(pair.approval).rejects.toThrow("relay never delivered settle");

    // The rejection was captured, not swallowed.
    const err = wc.getLastPairingError();
    expect(err?.message).toContain("relay never delivered settle");
    expect(typeof err?.at).toBe("number");

    // get_ledger_status reports a terminal error, not an eternal bare
    // `paired: false` that looks like the user simply never paired.
    const status = await sessionMod.getSessionStatus();
    expect(status.paired).toBe(false);
    expect(status.lastPairingError?.message).toContain(
      "relay never delivered settle",
    );
    expect(status.lastPairingErrorGuidance).toBeTruthy();
  });

  it("clears a prior lastPairingError once a session is adopted", async () => {
    // First: a rejecting pairing records the error.
    mock.state.connect = async () => ({
      uri: "wc:687reject@2?relay-protocol=irn&symKey=beef",
      approval: () => Promise.reject(new Error("first attempt failed")),
    });
    const wc = await import("../src/signing/walletconnect.js");
    const sessionMod = await import("../src/signing/session.js");
    const pair = await wc.initiatePairing();
    await expect(pair.approval).rejects.toThrow("first attempt failed");
    expect(wc.getLastPairingError()).not.toBeNull();

    // Then a settle event adopts a session — the stale error must clear.
    const onConnect = mock.handlers.get("session_connect");
    onConnect!({ session: fakeSettledSession() });
    expect(wc.getLastPairingError()).toBeNull();
    const status = await sessionMod.getSessionStatus();
    expect(status.paired).toBe(true);
    expect(status.lastPairingError).toBeUndefined();

    await wc.disconnect().catch(() => {});
  });
});
