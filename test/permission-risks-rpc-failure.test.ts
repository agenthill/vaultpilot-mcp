/**
 * checkPermissionRisks — RPC-failure vs "not Ownable" distinction (issue #696).
 *
 * `check_permission_risks` reads `owner()` on the target contract. Before the
 * fix, ANY failure of that read (a genuine revert on a non-Ownable contract OR
 * a transient transport failure that survives viem's 4-retry budget) landed in
 * the same bare `catch {}` and produced the unqualified
 * "No standard Ownable or AccessControl pattern detected." note — a false
 * "all-clear" on a security-advisory tool when the true state is "RPC failed,
 * couldn't tell".
 *
 * The fix distinguishes transport-shaped errors (viem HttpRequestError /
 * TimeoutError / anything surviving the retry budget) from revert-shaped
 * errors, and on a transport failure emits an explicit RPC-failure note
 * instead of folding into the negative-result path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { HttpRequestError } from "viem";

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

describe("checkPermissionRisks — RPC failure vs not-Ownable (issue #696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Verified contract, ABI without `hasRole` → no unverified/AccessControl
    // notes, so on current code an owner() failure lands squarely on the
    // unqualified negative note.
    getContractInfoMock.mockResolvedValue({ isVerified: true, abi: [] });
  });

  it("emits an RPC-failure note (not the negative note) when owner() fails transport-shaped", async () => {
    readContractMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "owner") {
        // Shape viem surfaces once the http transport has exhausted its
        // retry budget on a 5xx / timeout.
        throw new HttpRequestError({ url: "https://rpc.example.invalid" });
      }
      return undefined;
    });

    const res = await checkPermissionRisks(ADDR, "ethereum");
    const joined = res.notes.join("\n");

    // Transport failure surfaces the ambiguity explicitly...
    expect(joined).toMatch(/RPC call failed/i);
    expect(joined).toMatch(/may be incomplete/i);
    // ...and must NOT masquerade as a confirmed-negative all-clear.
    expect(res.notes).not.toContain(NEGATIVE_NOTE);
  });

  it("still reports the negative note on a genuine revert / non-Ownable contract", async () => {
    readContractMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "owner") {
        // A real revert-shaped error (no transport cause in the chain) — the
        // contract genuinely isn't Ownable.
        throw Object.assign(new Error("execution reverted"), {
          name: "ContractFunctionExecutionError",
        });
      }
      return undefined;
    });

    const res = await checkPermissionRisks(ADDR, "ethereum");
    const joined = res.notes.join("\n");

    expect(res.notes).toContain(NEGATIVE_NOTE);
    expect(joined).not.toMatch(/RPC call failed/i);
  });
});
