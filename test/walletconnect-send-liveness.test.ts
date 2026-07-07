/**
 * Regression tests for issue #75 — `send_transaction` hanging indefinitely
 * when the WalletConnect session is dead. The fix adds a 5s ping-probe
 * before publishing and a 120s hard timeout on the request itself; both
 * paths now throw structured errors the agent can surface instead of
 * blocking the chat.
 *
 * Updated for issue #241 — the dead-branch is now NON-DESTRUCTIVE: a probe
 * failure no longer deletes the persisted session. Closing the WalletConnect
 * subapp inside Ledger Live and reopening it must resume the same session
 * without a re-pair. The dead-branch tests below assert the new invariant:
 * no `c.session.delete` call, no persisted-topic clear.
 */
import { describe, it, expect } from "vitest";
import { probeSessionLiveness } from "../src/signing/walletconnect.js";
import type { SignClient } from "@walletconnect/sign-client";

describe("probeSessionLiveness", () => {
  it("returns 'alive' when ping resolves promptly", async () => {
    const fakeClient = {
      ping: async () => {},
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("alive");
  });

  it("returns 'dead' when ping rejects immediately (explicit peer rejection)", async () => {
    const fakeClient = {
      ping: async () => {
        throw new Error("no matching session");
      },
    } as unknown as InstanceType<typeof SignClient>;
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    expect(result).toBe("dead");
  });

  it("returns 'unknown' when ping hangs past the 5s timeout", async () => {
    // Never resolves → forced timeout path. Real-world: peer is offline or
    // the relay can't deliver.
    const fakeClient = {
      ping: () => new Promise(() => {}),
    } as unknown as InstanceType<typeof SignClient>;
    const start = Date.now();
    const result = await probeSessionLiveness(fakeClient, "topic-abc");
    const elapsed = Date.now() - start;
    expect(result).toBe("unknown");
    // The probe must return in ~5s, not block indefinitely.
    expect(elapsed).toBeGreaterThanOrEqual(4_800);
    expect(elapsed).toBeLessThan(7_000);
  }, 10_000);
});

describe("WalletConnectSessionUnavailableError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectSessionUnavailableError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectSessionUnavailableError("test");
    expect(e.name).toBe("WalletConnectSessionUnavailableError");
    expect(e instanceof Error).toBe(true);
  });
});

describe("WalletConnectRequestTimeoutError", () => {
  it("exports a stable error name so agents can branch on it", async () => {
    const { WalletConnectRequestTimeoutError } = await import(
      "../src/signing/walletconnect.js"
    );
    const e = new WalletConnectRequestTimeoutError("test");
    expect(e.name).toBe("WalletConnectRequestTimeoutError");
    expect(e instanceof Error).toBe(true);
  });
});

// Issue #241 wording lock: deadSessionMessage now describes a NON-destructive
// peer-unreachable state. The session is RETAINED so reopening the
// WalletConnect subapp inside Ledger Live resumes the same session without a
// re-pair. The previous wording (#219) said "the local session record has
// been cleared" and led with `pair_ledger_live` — both wrong now.
describe("deadSessionMessage — issue #241 wording lock (non-destructive)", () => {
  it("leads with reopen-WC-in-LL and same-handle retry, not re-pair", async () => {
    const { deadSessionMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = deadSessionMessage();
    // Resumption is the primary recovery path now.
    expect(msg).toContain("RETAINED");
    expect(msg).toContain("reopening");
    expect(msg).toContain("Open WalletConnect in Ledger Live");
    expect(msg).toContain("SAME handle");
    expect(msg).toContain("15-minute TTL");
    // `pair_ledger_live` only appears as the last-resort fallback, never the lead.
    expect(msg).toContain("`pair_ledger_live`");
    expect(msg.indexOf("Open WalletConnect in Ledger Live")).toBeLessThan(
      msg.indexOf("`pair_ledger_live`"),
    );
    // Old destructive wording must NOT survive — the persisted record is no
    // longer cleared on probe failure.
    expect(msg).not.toContain("local session record has been cleared");
    expect(msg).not.toContain("listing is stale");
  });

  it("does NOT call c.session.delete or clear the persisted topic in the requestSendTransaction dead branch", async () => {
    // Issue #241 inverts the issue #219 assertion: probe failure must NOT
    // destroy the persisted session — that's what broke resumption when the
    // user closes/reopens WalletConnect inside Ledger Live. Source-scrape
    // the dead branch in `requestSendTransaction` to confirm there's no
    // session.delete call and no `sessionTopic: undefined` cleanup.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    // Anchor on the unique pre-send liveness check: the function body from
    // `const liveness = await probeSessionLiveness(c, currentSession.topic);`
    // up to the next `const chainId =` (the next statement after the dead
    // branch). The startup branch in getSignClient also calls
    // probeSessionLiveness but is followed by `startKeepalive`, not
    // `const chainId =`, so this anchor isolates the send-path branch.
    const sendBranch = src.match(
      /const liveness = await probeSessionLiveness\(c, currentSession\.topic\);[\s\S]*?const chainId =/,
    );
    expect(sendBranch, "requestSendTransaction send-path liveness branch not found").toBeTruthy();
    const code = sendBranch![0];
    // The destructive cleanup is gone.
    expect(code).not.toMatch(/c\.session\.delete\(/);
    expect(code).not.toMatch(/sessionTopic:\s*undefined/);
    expect(code).not.toMatch(/pairingTopic:\s*undefined/);
    // What SHOULD be there: peerUnreachable flip + thrown error.
    expect(code).toMatch(/peerUnreachable\s*=\s*true/);
    expect(code).toMatch(/throw new WalletConnectSessionUnavailableError/);
  });

  it("does NOT call c.session.delete in the getSignClient startup branch", async () => {
    // Same invariant on the startup path: a saved session whose probe
    // doesn't ack must NOT be deleted. The only legitimate clearing path
    // is a `session_delete` / `session_expire` event from the SDK, wired
    // via `client.on(...)` further up.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    // Anchor on the startup-branch comment so we isolate it from the
    // send-path branch checked above.
    const startupBranch = src.match(
      /Verify the restored session is currently reachable[\s\S]*?return client;/,
    );
    expect(startupBranch, "getSignClient startup liveness branch not found").toBeTruthy();
    const code = startupBranch![0];
    expect(code).not.toMatch(/c\.session\.delete\(/);
    expect(code).not.toMatch(/sessionTopic:\s*undefined/);
    // What SHOULD be there: peerUnreachable assignment + keepalive start.
    expect(code).toMatch(/peerUnreachable\s*=\s*liveness\s*!==\s*"alive"/);
    expect(code).toMatch(/startKeepalive\(/);
  });
});

// Issue #241: the SDK's `session_delete` and `session_expire` events are
// the ONLY authoritative session-end signals. The walletconnect.ts module
// must subscribe to both; without these listeners, an explicit peer-end
// from the relay would leave us with a stale local record that the next
// probe would then incorrectly handle.
describe("session lifecycle event listeners — issue #241", () => {
  it("subscribes to both session_delete and session_expire in getSignClient", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/client\.on\(\s*"session_delete"/);
    expect(src).toMatch(/client\.on\(\s*"session_expire"/);
  });

  it("clears persisted state via handleSessionEndedByPeer (the one cleanup function)", async () => {
    // Lock in that there is a single cleanup function and that the event
    // listeners route through it. This makes the "only events clear state"
    // invariant grep-able from one place rather than scattered.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    expect(src).toMatch(/function handleSessionEndedByPeer\(\)/);
    // Both listeners must call it.
    const deleteListener = src.match(
      /client\.on\(\s*"session_delete"[\s\S]*?\}\);/,
    );
    expect(deleteListener?.[0]).toMatch(/handleSessionEndedByPeer\(\)/);
    const expireListener = src.match(
      /client\.on\(\s*"session_expire"[\s\S]*?\}\);/,
    );
    expect(expireListener?.[0]).toMatch(/handleSessionEndedByPeer\(\)/);
    // The cleanup function itself does the destructive work.
    const cleanupFn = src.match(
      /function handleSessionEndedByPeer\(\)[\s\S]*?\n\}/,
    );
    expect(cleanupFn?.[0]).toMatch(/currentSession = null/);
    expect(cleanupFn?.[0]).toMatch(/sessionTopic:\s*undefined/);
    expect(cleanupFn?.[0]).toMatch(/stopKeepalive\(\)/);
  });
});

// Issue #241: server-side keepalive ping. While a session exists we
// proactively ping the peer every KEEPALIVE_INTERVAL_MS so the relay's
// topic subscription stays warm and we get a continuous reachability
// signal. Failures are non-destructive — they just flip peerUnreachable.
describe("keepalive ping — issue #241", () => {
  it("starts a setInterval-based keepalive after pairing and after restore", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    // Both code paths that produce a session must start the keepalive.
    // Issue #687: the pairing path now routes capture through the shared
    // `adoptSession` helper (so the durable `session_connect` listener reuses
    // the same logic), and `adoptSession` is what starts the keepalive.
    const initiateBlock = src.match(
      /const session = await approval\(\);[\s\S]*?return session;/,
    );
    expect(initiateBlock?.[0]).toMatch(/adoptSession\(c,\s*session\)/);
    const adoptFn = src.match(/function adoptSession\([\s\S]*?\n\}/);
    expect(adoptFn?.[0]).toMatch(/startKeepalive\(c,\s*session\.topic\)/);
    const startupBlock = src.match(
      /Verify the restored session is currently reachable[\s\S]*?return client;/,
    );
    expect(startupBlock?.[0]).toMatch(/startKeepalive\(client,\s*currentSession\.topic\)/);
  });

  it("uses setInterval and clears it on cleanup paths (non-destructive failures)", async () => {
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    // The keepalive must be implemented as setInterval (not a recursive
    // setTimeout chain) so cancellation is a single clearInterval call.
    expect(src).toMatch(/setInterval\(/);
    expect(src).toMatch(/clearInterval\(/);
    // Cancelled by the same single function used by event listeners and
    // disconnect(), so we have one chokepoint.
    expect(src).toMatch(/function stopKeepalive\(\)/);
    // disconnect() must cancel the keepalive when the user explicitly
    // tears down the session.
    const disconnectFn = src.match(/export async function disconnect\([\s\S]*?\n\}/);
    expect(disconnectFn?.[0]).toMatch(/stopKeepalive\(\)/);
  });

  it("keepalive ping failures must NOT clear persisted state", async () => {
    // Lock the keepalive's body shape: the only thing it can do on a
    // non-alive probe is flip peerUnreachable. Anything that touches
    // currentSession or patches walletConnect config in here would
    // re-introduce the #241 regression.
    const fs = await import("node:fs");
    const src = fs.readFileSync(
      new URL("../src/signing/walletconnect.ts", import.meta.url),
      "utf8",
    );
    const startKeepalive = src.match(/function startKeepalive\([\s\S]*?\n\}/);
    expect(startKeepalive, "startKeepalive function not found").toBeTruthy();
    const body = startKeepalive![0];
    // The probe + flag flip is the only behavior.
    expect(body).toMatch(/probeSessionLiveness\(c,\s*topic\)/);
    expect(body).toMatch(/peerUnreachable\s*=\s*liveness\s*!==\s*"alive"/);
    // Must NOT touch any persisted state from inside the interval body.
    expect(body).not.toMatch(/c\.session\.delete\(/);
    expect(body).not.toMatch(/currentSession\s*=\s*null/);
    expect(body).not.toMatch(/sessionTopic:\s*undefined/);
  });
});

// Issue #218 regression: the 120s timeout error must NOT advise "the
// handle is still valid for retry" without qualification — that wording
// invites a double-broadcast attempt. The new wording warns about the
// late-broadcast race and surfaces the pinned (from, nonce, chainId) so
// the agent can suggest concrete on-chain checks before any retry.
describe("timeoutMessage — issue #218 wording lock", () => {
  it("warns about async late broadcast and forbids blind retry; embeds pinned (from, nonce, chainId)", async () => {
    const { timeoutMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = timeoutMessage({
      timeoutSeconds: 120,
      from: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      nonce: 272,
      chainId: 1,
    });
    expect(msg).toContain("may still broadcast the tx asynchronously");
    expect(msg).toContain("DO NOT retry blindly");
    expect(msg).toContain("double-broadcast");
    expect(msg).toContain("get_transaction_status");
    // Pinned fields surfaced verbatim so the agent can act on them.
    expect(msg).toContain("0xC0f5b7f7703BA95dC7C09D4eF50A830622234075");
    expect(msg).toContain("nonce `272`");
    expect(msg).toContain("chain id `1`");
    // Old wording must NOT survive — it implied retry was safe.
    expect(msg).not.toContain("handle is still valid for retry (15-minute TTL");
  });

  it("falls back to a clear placeholder when nonce wasn't pinned", async () => {
    const { timeoutMessage } = await import(
      "../src/signing/walletconnect.js"
    );
    const msg = timeoutMessage({
      timeoutSeconds: 120,
      from: "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075",
      nonce: "<unpinned — check pending nonce on chain>",
      chainId: 1,
    });
    expect(msg).toContain("<unpinned — check pending nonce on chain>");
  });
});
