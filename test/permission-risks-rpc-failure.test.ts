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
 * The fix distinguishes transport-shaped errors from revert-shaped ones and, on
 * a transport failure, emits an explicit RPC-failure note instead of folding
 * into the negative-result path.
 *
 * The transport class is NOT just `HttpRequestError` by class name / HTTP
 * status. viem also surfaces a JSON-RPC-code degradation class that survives
 * the retry budget carrying a JSON-RPC `.code` (NOT an HTTP `.status`):
 * `LimitExceededRpcError` (-32005), `InternalRpcError` (-32603), and body-level
 * `{code:429}`. These wrap up through `ContractFunctionExecutionError`, so the
 * discriminator must walk the whole cause chain and match the numeric code, not
 * only the top-level class name. The tests below build REALISTICALLY-wrapped
 * viem errors (`ContractFunctionExecutionError -> ... -> the transport cause`)
 * via a real client so they cannot pass against a top-level-only check.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createPublicClient,
  custom,
  LimitExceededRpcError,
  InternalRpcError,
  RpcRequestError,
} from "viem";
import { mainnet } from "viem/chains";

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
const HOLDER = "0x2222222222222222222222222222222222222222" as const;
const NEGATIVE_NOTE = "No standard Ownable or AccessControl pattern detected.";

const OWNER_ABI = [
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * Produce a GENUINELY viem-wrapped error whose cause chain terminates in a
 * JSON-RPC `.code`, exactly as `readContract` surfaces it once a degraded
 * provider (rate-limit / internal error) exhausts the retry budget. The
 * top-level class is `ContractFunctionExecutionError`; the transport shape is
 * only reachable by walking `.cause`.
 */
async function wrappedRpcError(code: number): Promise<unknown> {
  const transport = custom({
    async request({ method }: { method: string }) {
      const cause = new RpcRequestError({ body: { method }, error: { code, message: "degraded" }, url: "http://rpc.invalid" });
      if (code === -32005) throw new LimitExceededRpcError(cause);
      if (code === -32603) throw new InternalRpcError(cause);
      throw cause;
    },
  });
  const client = createPublicClient({ chain: mainnet, transport });
  try {
    await client.readContract({ address: ADDR, abi: OWNER_ABI, functionName: "owner" });
    throw new Error("expected readContract to throw");
  } catch (e) {
    return e;
  }
}

/** A genuine revert-shaped error — no transport cause anywhere in the chain. */
function revertError(): unknown {
  return Object.assign(new Error("execution reverted"), { name: "ContractFunctionExecutionError" });
}

describe("checkPermissionRisks — RPC failure vs not-Ownable (issue #696)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Verified contract, ABI without `hasRole` → no unverified/AccessControl
    // notes, so on the pre-fix code an owner() failure lands squarely on the
    // unqualified negative note.
    getContractInfoMock.mockResolvedValue({ isVerified: true, abi: [] });
  });

  for (const code of [-32005, -32603]) {
    it(`emits an RPC-failure note (not the negative note) when owner() fails wrapped code ${code}`, async () => {
      const wrapped = await wrappedRpcError(code);
      readContractMock.mockImplementation(async (p: { functionName: string }) => {
        if (p.functionName === "owner") throw wrapped;
        return undefined;
      });

      const res = await checkPermissionRisks(ADDR, "ethereum");
      const joined = res.notes.join("\n");

      // Transport-degradation failure surfaces the ambiguity explicitly...
      expect(joined).toMatch(/RPC call failed/i);
      expect(joined).toMatch(/may be incomplete/i);
      // ...and must NOT masquerade as a confirmed-negative all-clear.
      expect(res.notes).not.toContain(NEGATIVE_NOTE);
    });
  }

  it("still reports the negative note on a genuine revert / non-Ownable contract", async () => {
    readContractMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "owner") throw revertError();
      return undefined;
    });

    const res = await checkPermissionRisks(ADDR, "ethereum");
    const joined = res.notes.join("\n");

    expect(res.notes).toContain(NEGATIVE_NOTE);
    expect(joined).not.toMatch(/RPC call failed/i);
  });

  it("surfaces a Safe verify-note when getThreshold fails transport-shaped (widened branch)", async () => {
    getCodeMock.mockResolvedValue("0x60006000");
    const wrapped = await wrappedRpcError(-32005);
    readContractMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "owner") return HOLDER;
      if (p.functionName === "getThreshold") throw wrapped; // transport blip
      // timelock probes genuinely revert → not a timelock
      throw revertError();
    });

    const res = await checkPermissionRisks(ADDR, "ethereum");
    const joined = res.notes.join("\n");

    expect(joined).toMatch(/is a Gnosis Safe/i);
    expect(joined).toMatch(/RPC call failed/i);
  });

  it("surfaces a timelock verify-note when both timelock probes fail transport-shaped (widened branch)", async () => {
    getCodeMock.mockResolvedValue("0x60006000");
    const wrapped = await wrappedRpcError(-32603);
    readContractMock.mockImplementation(async (p: { functionName: string }) => {
      if (p.functionName === "owner") return HOLDER;
      if (p.functionName === "getThreshold") throw revertError(); // not a Safe
      // both getMinDelay() and delay() hit the transport blip
      throw wrapped;
    });

    const res = await checkPermissionRisks(ADDR, "ethereum");
    const joined = res.notes.join("\n");

    expect(joined).toMatch(/is a timelock/i);
    expect(joined).toMatch(/RPC call failed/i);
  });
});
