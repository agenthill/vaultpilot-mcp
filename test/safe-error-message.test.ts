import { describe, it, expect } from "vitest";
import { safeErrorMessage } from "../src/shared/error-message.js";

describe("safeErrorMessage — issue #326 stringification fix", () => {
  it("standard Error with string message → returns the message", () => {
    expect(safeErrorMessage(new Error("boom"))).toBe("boom");
  });

  it("Error with object message → unwraps structured fields, never returns '[object Object]'", () => {
    // The exact failure mode that surfaced as "Error: [object Object]"
    // in the live incident — some SDKs (WalletConnect) throw Errors
    // whose `.message` is itself a structured object, and the legacy
    // pattern `${error.message}` toString'd it to literal garbage.
    const err = new Error();
    Object.defineProperty(err, "message", {
      value: { code: 4001, reason: "user_rejected" },
      enumerable: true,
    });
    const out = safeErrorMessage(err);
    expect(out).not.toBe("[object Object]");
    expect(out).not.toContain("[object Object]");
    expect(out).toContain("user_rejected");
    expect(out).toContain("4001");
  });

  it("Error with empty string message → falls back to name + own props", () => {
    class CustomError extends Error {
      code = "ERR_CUSTOM";
      constructor() {
        super("");
        this.name = "CustomError";
      }
    }
    const out = safeErrorMessage(new CustomError());
    expect(out).toContain("CustomError");
    expect(out).toContain("ERR_CUSTOM");
  });

  it("plain string thrown → returns the string verbatim", () => {
    expect(safeErrorMessage("just a string")).toBe("just a string");
  });

  it("plain object thrown → JSON-stringified, structured fields visible", () => {
    const out = safeErrorMessage({ kind: "wc-relay-error", code: 4100, message: "Unauthorized method" });
    expect(out).toContain("wc-relay-error");
    expect(out).toContain("4100");
    expect(out).toContain("Unauthorized method");
  });

  it("null / undefined → labels them explicitly rather than returning empty", () => {
    expect(safeErrorMessage(null)).toMatch(/null/);
    expect(safeErrorMessage(undefined)).toMatch(/undefined/);
  });

  it("circular object → does not throw; surfaces what it can", () => {
    const o: Record<string, unknown> = { kind: "loop" };
    o.self = o;
    expect(() => safeErrorMessage(o)).not.toThrow();
    const out = safeErrorMessage(o);
    expect(out).toContain("loop");
    // Either `[circular]` is surfaced or the toString fallback fires —
    // the assertion is just "no throw, no garbage".
    expect(out).not.toBe("");
  });

  it("Error with literal '[object Object]' message (the live bug) → still recovers structured fields", () => {
    // Defensive: if the bug ever resurfaces upstream, we must still
    // surface SOMETHING useful rather than parroting the literal back.
    const err = new Error("[object Object]");
    Object.defineProperty(err, "code", { value: 4001, enumerable: true });
    const out = safeErrorMessage(err);
    expect(out).not.toBe("[object Object]");
    // The own-property unwrap should pick up `code`.
    expect(out).toMatch(/4001/);
  });

  it("BigInt fields in structured object don't crash JSON.stringify", () => {
    // viem-side errors often carry BigInt gas/nonce fields, which
    // JSON.stringify rejects by default. Our helper must coerce.
    const out = safeErrorMessage({ kind: "viem-error", gas: 1234567890123n });
    expect(out).toContain("viem-error");
    expect(out).toContain("1234567890123");
  });
});

describe("safeErrorMessage — issue #695 provider-API-key redaction", () => {
  const SECRET = "abc123SECRETKEY";

  it("Infura URL in .message AND .url is redacted — no key, no /v3/<key> segment", () => {
    // viem HttpRequestError shape (confirmed empirically vs installed
    // viem@2.54.x): the RPC URL with the key lands in BOTH the `.message`
    // (as a "URL: …" line) and a `.url` own-prop. Both must be scrubbed
    // before this string reaches an MCP tool-error response.
    const url = `https://mainnet.infura.io/v3/${SECRET}`;
    const err = new Error(`HTTP request failed. URL: ${url}`);
    Object.defineProperty(err, "url", { value: url, enumerable: true });

    const out = safeErrorMessage(err);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(`/v3/${SECRET}`);
  });

  it("Alchemy /v2/<key> path segment is redacted", () => {
    const url = `https://eth-mainnet.g.alchemy.com/v2/${SECRET}`;
    const err = new Error(`fetch failed for ${url}`);
    const out = safeErrorMessage(err);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(`/v2/${SECRET}`);
  });

  it("key surfaced only via a .url own-prop (empty .message fallback path) is redacted", () => {
    const url = `https://mainnet.infura.io/v3/${SECRET}`;
    const err = new Error("");
    err.name = "HttpRequestError";
    Object.defineProperty(err, "url", { value: url, enumerable: true });
    const out = safeErrorMessage(err);
    expect(out).not.toContain(SECRET);
  });

  it("api-key / apikey query params are redacted", () => {
    const withHyphen = `Timeout: https://rpc.example.com/eth?api-key=${SECRET}`;
    const withoutHyphen = `Timeout: https://rpc.example.com/eth?apikey=${SECRET}&chain=1`;
    expect(safeErrorMessage(new Error(withHyphen))).not.toContain(SECRET);
    expect(safeErrorMessage(new Error(withoutHyphen))).not.toContain(SECRET);
  });

  it("does not over-redact non-secret error text", () => {
    // No key-shaped material here — the message must survive verbatim.
    const out = safeErrorMessage(new Error("Insufficient funds for gas * price + value"));
    expect(out).toBe("Insufficient funds for gas * price + value");
  });
});
