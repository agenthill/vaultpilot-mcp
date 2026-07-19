/**
 * #757 D1 branch-1 — the FOUR distinct producer states that collapse an EVM
 * WalletConnect session to an empty account set, each driven through the REAL
 * `getConnectedAccounts()` (design D1). The sibling falsifier file
 * (757-recipient-authorization.test.ts) proves the gate REFUSES on an empty set;
 * this file proves each of the four producers genuinely EMPTIES it, by feeding a
 * distinct `SignClient.session.getAll()` shape into the real restore + CAIP-10
 * filter path rather than stubbing `getConnectedAccounts` to `[]` (which cannot
 * tell the four states apart — REVIEW's overclaim finding on the prior ×4 loop).
 *
 * The four states (getConnectedAccountsDetailed in src/signing/walletconnect.ts):
 *   (a) no session survives restore  → `if (!currentSession) return []`
 *   (b) settled session, no eip155   → `if (!ns) return []`
 *   (c) empty eip155.accounts array  → the account loop never populates the Map
 *   (d) every entry fails CAIP-10    → the loop's parts/EVM_ADDRESS filter drops all
 *
 * Each has its own falsifier: delete that branch and its state throws / returns a
 * non-empty set, so the `toEqual([])` assertion goes RED. The `SignClient` is
 * mocked (no relay), and a throwaway config dir keeps the developer's real
 * ~/.vaultpilot-mcp untouched (same harness as the #687 settle tests).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WALLET = "0x1111111111111111111111111111111111111111";
const TOPIC = "0xtopic757d1producerstate";
const PAIRING_TOPIC = "0xpairing757d1";

// Hoisted mock state so the `vi.mock` factory can reach it. `state.sessions` is
// what `client.session.getAll()` returns — each test swaps in the session shape
// for its producer state before importing the real walletconnect module.
const mock = vi.hoisted(() => {
  const state: { sessions: unknown[] } = { sessions: [] };
  const mockClient: Record<string, unknown> = {
    on(_event: string, _handler: (arg: unknown) => void) {
      return mockClient;
    },
    core: { relayer: { on() {} } },
    session: { getAll: () => state.sessions },
    ping: async () => {},
    connect: async () => ({ uri: "wc:757d1@2", approval: () => new Promise<never>(() => {}) }),
    disconnect: async () => {},
  };
  return { state, mockClient };
});

vi.mock("@walletconnect/sign-client", () => ({
  SignClient: { init: vi.fn(async () => mock.mockClient) },
}));

// Keep the peer-pin quiet — not under test here.
vi.mock("../src/signing/walletconnect-peer-pin.js", () => ({
  pinLedgerLivePeer: () => ({ verdict: "match", message: "" }),
}));

/** A settled session carrying `namespaces` verbatim (topic/pairingTopic for the restore-side patchUserConfig). */
function session(namespaces: Record<string, unknown>): unknown {
  return {
    topic: TOPIC,
    pairingTopic: PAIRING_TOPIC,
    expiry: Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
    peer: { metadata: { name: "Ledger Live", url: "https://ledger.com", description: "" } },
    namespaces,
  };
}

let tmpHome: string;
let savedConfigDir: string | undefined;
let savedProjectId: string | undefined;
let savedDemo: string | undefined;

beforeEach(() => {
  vi.resetModules();
  mock.state.sessions = [];
  tmpHome = mkdtempSync(join(tmpdir(), "vaultpilot-757-d1-"));
  savedConfigDir = process.env.VAULTPILOT_CONFIG_DIR;
  savedProjectId = process.env.WALLETCONNECT_PROJECT_ID;
  savedDemo = process.env.VAULTPILOT_DEMO;
  // Plain env writes (not vi.stubEnv — the config sets unstubEnvs:true).
  process.env.VAULTPILOT_CONFIG_DIR = tmpHome;
  process.env.WALLETCONNECT_PROJECT_ID = "test-project-757-d1";
  // Force REAL mode: `false` is the documented auto-demo escape hatch, so a fresh
  // (empty) config dir cannot flip getConnectedAccounts into the demo early-return.
  process.env.VAULTPILOT_DEMO = "false";
  writeFileSync(join(tmpHome, "config.json"), "{}\n");
});

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("VAULTPILOT_CONFIG_DIR", savedConfigDir);
  restore("WALLETCONNECT_PROJECT_ID", savedProjectId);
  restore("VAULTPILOT_DEMO", savedDemo);
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("#757 D1 branch-1 — four DISTINCT producer states each empty the EVM account set", () => {
  it("(a) no session survives restore → getConnectedAccounts() === []", async () => {
    mock.state.sessions = []; // session.getAll() empty → currentSession stays null
    const wc = await import("../src/signing/walletconnect.js");
    expect(await wc.getConnectedAccounts()).toEqual([]);
  });

  it("(b) settled session with NO eip155 namespace → getConnectedAccounts() === []", async () => {
    // A restored session that exposes only a non-EVM namespace: `ns` is undefined.
    mock.state.sessions = [session({ cosmos: { accounts: ["cosmos:cosmoshub-4:cosmos1abc"], methods: [], events: [] } })];
    const wc = await import("../src/signing/walletconnect.js");
    expect(await wc.getConnectedAccounts()).toEqual([]);
  });

  it("(c) settled eip155 namespace with an EMPTY accounts array → getConnectedAccounts() === []", async () => {
    mock.state.sessions = [session({ eip155: { accounts: [], methods: ["eth_sendTransaction"], events: ["accountsChanged"] } })];
    const wc = await import("../src/signing/walletconnect.js");
    expect(await wc.getConnectedAccounts()).toEqual([]);
  });

  it("(d) eip155 accounts present but EVERY entry fails the CAIP-10/EVM_ADDRESS filter → getConnectedAccounts() === []", async () => {
    // Distinct from (c): the loop DOES iterate, but each entry is dropped —
    // wrong arity, a non-hex address, and a non-numeric chainId respectively.
    mock.state.sessions = [
      session({
        eip155: {
          accounts: ["garbage-no-colons", `eip155:1:0xNOTHEXADDRESS`, `eip155:notanumber:${WALLET}`],
          methods: ["eth_sendTransaction"],
          events: ["accountsChanged"],
        },
      }),
    ];
    const wc = await import("../src/signing/walletconnect.js");
    expect(await wc.getConnectedAccounts()).toEqual([]);
  });

  it("CONTROL — a valid eip155 account is NOT dropped (proves (d)'s emptiness is the filter, not a broken restore)", async () => {
    mock.state.sessions = [session({ eip155: { accounts: [`eip155:1:${WALLET}`], methods: ["eth_sendTransaction"], events: ["accountsChanged"] } })];
    const wc = await import("../src/signing/walletconnect.js");
    expect((await wc.getConnectedAccounts()).map((a) => a.toLowerCase())).toEqual([WALLET]);
  });
});
