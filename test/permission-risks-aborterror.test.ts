/**
 * checkPermissionRisks — raw AbortError classification (issue #731).
 *
 * `isTransportError` (src/modules/security/permissions.ts) discriminates a
 * transport-shaped RPC failure ("unknown, couldn't tell") from a revert-shaped
 * one ("confirmed absent"). Its TRANSPORT_NAMES set omits "AbortError", so a raw
 * AbortError — the DOMException(name="AbortError") that a wall-clock
 * `AbortController` timeout throws (see src/data/http.ts `fetchWithTimeout`), or
 * any `{ name: "AbortError" }`-shaped error (e.g. src/data/apis/fourbyte.ts's
 * timeout) — is NOT classified as transport. On the `owner()` read that drives
 * the "is this contract Ownable?" determination, that misclassification folds an
 * "RPC aborted, couldn't tell" into the unqualified
 * "No standard Ownable or AccessControl pattern detected." all-clear — the same
 * false-negative class as issue #696, one error shape it missed.
 *
 * REACHABILITY (QA 2026-07-19): purely LATENT on current code. All three
 * `isTransportError` call sites consume errors from the viem PublicClient
 * (`client.readContract` / `client.getCode`), and viem 2.54.6 converts its own
 * request timeout to a viem `TimeoutError` (already in TRANSPORT_NAMES) BEFORE it
 * reaches the caller — never a raw AbortError. The only current permission-read
 * path that produces a raw AbortError is
 * `getContractInfo` -> `etherscanV2Fetch` -> `fetchWithTimeout`, whose throw
 * propagates OUT of `checkPermissionRisks` (it is not inside an `isTransportError`
 * catch) and surfaces as a loud thrown error, not a silent all-clear. This test
 * asserts the DESIRED behavior so the guard is in place the moment any permission
 * read is re-routed through `fetchWithTimeout` / a raw `AbortController`.
 *
 * `isTransportError` is not exported; it is exercised here through the public
 * `checkPermissionRisks` surface (the `owner()` catch block), exactly as the
 * sibling permission-risks-rpc-failure.test.ts does for the JSON-RPC-code class.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getContractInfoMock = vi.fn();
vi.mock("../src/data/apis/etherscan.js", () => ({
  getContractInfo: (...a: unknown[]) => getContractInfoMock(...a),
}));

const readContractMock = vi.fn();
const getCodeMock = vi.fn();
vi.mock("../src/data/rpc.js", () => ({
  getClient: () => ({
    readContract: (...a: unknown[]) => readContractMock(...a),
    getCode: (...a: unknown[]) => getCodeMock(...a),
  }),
}));

import { checkPermissionRisks } from "../src/modules/security/permissions.js";

const ADDR = "0x1111111111111111111111111111111111111111" as const;
const NEGATIVE_NOTE = "No standard Ownable or AccessControl pattern detected.";

/** The DOMException shape undici / `fetch` throws when an `AbortController` fires. */
function domAbortError(): unknown {
  if (typeof DOMException === "function") {
    return new DOMException("The operation was aborted", "AbortError");
  }
  // Fallback for runtimes without a global DOMException (Node < 17).
  return Object.assign(new Error("The operation was aborted"), { name: "AbortError" });
}

/** The plain `{ name: "AbortError" }` shape (e.g. src/data/apis/fourbyte.ts's timeout). */
function nameShapedAbortError(): unknown {
  return Object.assign(new Error("timed out"), { name: "AbortError" });
}

describe("checkPermissionRisks — raw AbortError is transport, not not-Ownable (issue #731)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Verified contract, ABI without `hasRole` -> no unverified/AccessControl
    // notes, so an owner() failure lands squarely on the negative all-clear note
    // unless it is recognized as a transport failure.
    getContractInfoMock.mockResolvedValue({ isVerified: true, abi: [] });
  });

  for (const [label, make] of [
    ["a DOMException AbortError", domAbortError],
    ["a { name: 'AbortError' } error", nameShapedAbortError],
  ] as const) {
    it(`emits an RPC-failure note (not the negative all-clear) when owner() aborts with ${label}`, async () => {
      readContractMock.mockImplementation(async (p: { functionName: string }) => {
        if (p.functionName === "owner") throw make();
        return undefined;
      });

      const res = await checkPermissionRisks(ADDR, "ethereum");
      const joined = res.notes.join("\n");

      // A wall-clock abort means "couldn't tell", so surface the ambiguity...
      expect(joined).toMatch(/RPC call failed/i);
      expect(joined).toMatch(/may be incomplete/i);
      // ...and must NOT masquerade as a confirmed-negative all-clear.
      expect(res.notes).not.toContain(NEGATIVE_NOTE);
    });
  }
});
