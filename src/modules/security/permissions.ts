import { getAddress, zeroAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { getContractInfo } from "../../data/apis/etherscan.js";
import { ownableAbi, gnosisSafeAbi, timelockAbi } from "../../abis/access-control.js";
import type { PrivilegedRole, SupportedChain } from "../../types/index.js";

/**
 * Detect whether `address` is a contract.
 * For contracts, try to detect Gnosis Safe (isMultisig) and OZ TimelockController (hasTimelock).
 */
async function classifyHolder(
  chain: SupportedChain,
  holder: `0x${string}`
): Promise<Pick<PrivilegedRole, "isContract" | "isMultisig" | "hasTimelock" | "timelockDelaySeconds">> {
  const client = getClient(chain);
  const code = await client.getCode({ address: holder });
  const isContract = !!code && code !== "0x";
  if (!isContract) {
    return { isContract: false, isMultisig: false, hasTimelock: false };
  }

  // Gnosis Safe detection
  let isMultisig = false;
  try {
    const threshold = (await client.readContract({
      address: holder,
      abi: gnosisSafeAbi,
      functionName: "getThreshold",
    })) as bigint;
    isMultisig = threshold > 0n;
  } catch {
    // Not a Safe
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
  } catch {
    try {
      const delay = (await client.readContract({
        address: holder,
        abi: timelockAbi,
        functionName: "delay",
      })) as bigint;
      hasTimelock = true;
      timelockDelaySeconds = Number(delay);
    } catch {
      // Not a timelock
    }
  }

  return { isContract, isMultisig, hasTimelock, timelockDelaySeconds };
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
      const cls = await classifyHolder(chain, owner);
      roles.push({ role: "owner", holder: getAddress(owner) as `0x${string}`, ...cls });
    }
  } catch {
    // Not Ownable.
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
