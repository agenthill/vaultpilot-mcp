import { getAddress, zeroAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { getContractInfo } from "../../data/apis/etherscan.js";
import { ownableAbi, gnosisSafeAbi, timelockAbi } from "../../abis/access-control.js";
import type { PrivilegedRole, SupportedChain } from "../../types/index.js";

const RPC_INCOMPLETE_NOTE =
  "Could not verify Ownable/Safe/timelock pattern — RPC call failed; result may be incomplete.";

/**
 * Distinguish a transport-shaped RPC failure (HTTP 5xx/429/timeout/socket that
 * survived viem's 4-retry budget — see `data/rpc.ts`) from a revert-shaped one
 * (`ContractFunctionExecutionError` / missing-function decode — the function
 * genuinely isn't there). This is a SECURITY-verdict discriminator: a transport
 * failure means "unknown, couldn't tell", not "confirmed absent", so it must not
 * fold into a negative "no privileged pattern" all-clear.
 *
 * viem wraps the underlying failure and nests the transport error in `cause`, so
 * we walk the whole cause chain and positively identify transport shapes by
 * class name / HTTP status. Anything NOT positively identified as transport is
 * treated as a revert — preserving the pre-existing negative-result behaviour
 * for genuine non-Ownable / non-Safe / non-timelock contracts.
 */
function isTransportError(err: unknown): boolean {
  const TRANSPORT_NAMES = new Set([
    "HttpRequestError",
    "TimeoutError",
    "SocketClosedError",
    "WebSocketRequestError",
  ]);
  const seen = new Set<unknown>();
  let node: unknown = err;
  while (node && typeof node === "object" && !seen.has(node)) {
    seen.add(node);
    const n = node as { name?: unknown; status?: unknown; cause?: unknown };
    if (typeof n.name === "string" && TRANSPORT_NAMES.has(n.name)) return true;
    // A 429/5xx that survived the retry budget is transport, not revert.
    if (typeof n.status === "number" && (n.status === 429 || n.status >= 500)) return true;
    node = n.cause;
  }
  return false;
}

/**
 * Detect whether `address` is a contract.
 * For contracts, try to detect Gnosis Safe (isMultisig) and OZ TimelockController (hasTimelock).
 */
async function classifyHolder(
  chain: SupportedChain,
  holder: `0x${string}`
): Promise<
  Pick<PrivilegedRole, "isContract" | "isMultisig" | "hasTimelock" | "timelockDelaySeconds"> & {
    verifyNotes: string[];
  }
> {
  const client = getClient(chain);
  const code = await client.getCode({ address: holder });
  const isContract = !!code && code !== "0x";
  if (!isContract) {
    return { isContract: false, isMultisig: false, hasTimelock: false, verifyNotes: [] };
  }

  const verifyNotes: string[] = [];

  // Gnosis Safe detection
  let isMultisig = false;
  try {
    const threshold = (await client.readContract({
      address: holder,
      abi: gnosisSafeAbi,
      functionName: "getThreshold",
    })) as bigint;
    isMultisig = threshold > 0n;
  } catch (err) {
    // A revert means "not a Safe"; a transport failure means we couldn't tell —
    // surface the ambiguity rather than silently reporting isMultisig=false.
    if (isTransportError(err)) {
      verifyNotes.push(
        `Could not verify whether owner ${getAddress(holder)} is a Gnosis Safe — RPC call failed; result may be incomplete.`
      );
    }
  }

  // Timelock detection — try both getMinDelay() (OZ 4.x) and delay() (older).
  let hasTimelock = false;
  let timelockDelaySeconds: number | undefined;
  try {
    const delay = (await client.readContract({
      address: holder,
      abi: timelockAbi,
      functionName: "getMinDelay",
    })) as bigint;
    hasTimelock = true;
    timelockDelaySeconds = Number(delay);
  } catch (errMinDelay) {
    try {
      const delay = (await client.readContract({
        address: holder,
        abi: timelockAbi,
        functionName: "delay",
      })) as bigint;
      hasTimelock = true;
      timelockDelaySeconds = Number(delay);
    } catch (errDelay) {
      // Both probes reverting means "not a timelock"; a transport failure on
      // either means we couldn't tell — surface the ambiguity.
      if (isTransportError(errMinDelay) || isTransportError(errDelay)) {
        verifyNotes.push(
          `Could not verify whether owner ${getAddress(holder)} is a timelock — RPC call failed; result may be incomplete.`
        );
      }
    }
  }

  return { isContract, isMultisig, hasTimelock, timelockDelaySeconds, verifyNotes };
}

/** Enumerate privileged roles on a contract (best-effort given public ABIs). */
export async function checkPermissionRisks(
  address: `0x${string}`,
  chain: SupportedChain
): Promise<{ address: `0x${string}`; chain: SupportedChain; roles: PrivilegedRole[]; notes: string[] }> {
  const client = getClient(chain);
  const info = await getContractInfo(address, chain);
  const roles: PrivilegedRole[] = [];
  const notes: string[] = [];

  if (!info.isVerified) {
    notes.push("Contract is not verified on Etherscan — limited permission visibility.");
  }

  // 1) Ownable.owner()
  try {
    const owner = (await client.readContract({
      address,
      abi: ownableAbi,
      functionName: "owner",
    })) as `0x${string}`;
    if (owner && owner !== zeroAddress) {
      const { verifyNotes, ...cls } = await classifyHolder(chain, owner);
      roles.push({ role: "owner", holder: getAddress(owner) as `0x${string}`, ...cls });
      notes.push(...verifyNotes);
    }
  } catch (err) {
    // A revert means "not Ownable"; a transport failure means we couldn't tell.
    // Surface the RPC failure explicitly so it does NOT fold into the
    // confirmed-negative note below (a false all-clear on a security tool).
    if (isTransportError(err)) {
      notes.push(RPC_INCOMPLETE_NOTE);
    }
  }

  // 2) AccessControl — detect via ABI scan for hasRole function. If present, we can at least note it.
  if (info.abi && Array.isArray(info.abi)) {
    const hasRoleFn = info.abi.some((item) => {
      if (typeof item !== "object" || !item) return false;
      const it = item as { type?: string; name?: string };
      return it.type === "function" && it.name === "hasRole";
    });
    if (hasRoleFn) {
      notes.push(
        "Contract uses OpenZeppelin AccessControl. Role holders can only be enumerated with specific role hashes " +
          "(e.g. DEFAULT_ADMIN_ROLE = 0x000...). Further enumeration not implemented in MVP."
      );
    }
  }

  if (roles.length === 0 && notes.length === 0) {
    notes.push("No standard Ownable or AccessControl pattern detected.");
  }

  return { address: getAddress(address) as `0x${string}`, chain, roles, notes };
}
