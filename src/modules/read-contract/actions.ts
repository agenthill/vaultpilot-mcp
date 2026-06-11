import {
  encodeFunctionData,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import { resolveContractAbi } from "../../shared/contract-abi.js";
import { getClient } from "../../data/rpc.js";
import type { SupportedChain } from "../../types/index.js";
import type { ReadContractArgs } from "./schemas.js";

export interface ReadContractResult {
  function: string;
  args: readonly unknown[];
  result: unknown;
  resultRaw?: `0x${string}`;
  abiSource: "etherscan" | "user-supplied";
  contractIsProxy?: boolean;
  implementationAddress?: `0x${string}`;
}

/**
 * Resolve which ABI entry corresponds to the caller's `fn`. Accepts either a
 * bare name ("getRoleMember") or a full signature ("getRoleMember(bytes32,uint256)").
 * Refuses on unknown names, on ambiguous overloads when only the name was given,
 * and on non-view/pure functions — `eth_call` would simulate a state-changing
 * function and return a hypothetical result the agent would mistake for ground
 * truth.
 */
function resolveFunctionEntry(abi: Abi, fn: string): AbiFunction {
  const fnEntries = abi.filter(
    (entry): entry is AbiFunction =>
      typeof entry === "object" && entry !== null && entry.type === "function",
  );

  // Full-signature path: caller passed "name(type1,type2)".
  if (fn.includes("(")) {
    const match = fnEntries.find(
      (e) => formatFunctionSignature(e) === fn,
    );
    if (!match) {
      const candidates = fnEntries.map(formatFunctionSignature).slice(0, 5).join(", ");
      throw new Error(
        `Function signature ${fn} not found in ABI. Available functions (first 5): ${candidates}`,
      );
    }
    return enforceViewOrPure(match);
  }

  // Bare-name path: caller passed "getRoleMember".
  const matches = fnEntries.filter((e) => e.name === fn);
  if (matches.length === 0) {
    const closest = fnEntries
      .map((e) => e.name)
      .filter((n): n is string => Boolean(n))
      .filter((n) => n.toLowerCase().includes(fn.toLowerCase()) || fn.toLowerCase().includes(n.toLowerCase()))
      .slice(0, 5);
    const hint = closest.length > 0
      ? ` Did you mean: ${closest.join(", ")}?`
      : "";
    throw new Error(
      `Function ${fn} not found in ABI.${hint}`,
    );
  }
  if (matches.length > 1) {
    const sigs = matches.map(formatFunctionSignature).join(", ");
    throw new Error(
      `Function ${fn} is overloaded in this ABI (${matches.length} variants). Pass the full signature to disambiguate, e.g. ${sigs}`,
    );
  }
  return enforceViewOrPure(matches[0]);
}

function enforceViewOrPure(fn: AbiFunction): AbiFunction {
  const sm = fn.stateMutability ?? "nonpayable";
  if (sm !== "view" && sm !== "pure") {
    throw new Error(
      `STATE_CHANGING_FN: ${fn.name} is ${sm}; use prepare_custom_call for writes. eth_call would simulate this and return a result, but the result reflects a hypothetical state change that has not occurred on-chain.`,
    );
  }
  return fn;
}

function formatFunctionSignature(fn: AbiFunction): string {
  const inputs = (fn.inputs ?? []).map(formatAbiType).join(",");
  return `${fn.name}(${inputs})`;
}

function formatAbiType(p: AbiParameter): string {
  if (p.type === "tuple" && "components" in p && p.components) {
    const inner = p.components.map(formatAbiType).join(",");
    return `(${inner})`;
  }
  if (p.type.startsWith("tuple[") && "components" in p && p.components) {
    const inner = p.components.map(formatAbiType).join(",");
    const arraySuffix = p.type.slice("tuple".length);
    return `(${inner})${arraySuffix}`;
  }
  return p.type;
}

export async function readContract(args: ReadContractArgs): Promise<ReadContractResult> {
  const chain = args.chain as SupportedChain;
  const contract = args.contract as `0x${string}`;

  let abi: Abi;
  let abiSource: "etherscan" | "user-supplied";
  let contractIsProxy: boolean | undefined;
  let implementationAddress: `0x${string}` | undefined;

  if (args.abi) {
    abi = args.abi as Abi;
    abiSource = "user-supplied";
  } else {
    const resolved = await resolveContractAbi(contract, chain);
    abi = resolved.abi;
    abiSource = "etherscan";
    contractIsProxy = resolved.isProxy;
    implementationAddress = resolved.implementation;
  }

  const fnEntry = resolveFunctionEntry(abi, args.fn);
  const callArgs = args.args ?? [];

  const client = getClient(chain);

  let result: unknown;
  try {
    result = await client.readContract({
      address: contract,
      abi,
      functionName: fnEntry.name,
      args: callArgs as readonly unknown[],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `eth_call to ${fnEntry.name} on ${contract} (${chain}) failed: ${msg}. Verify args match the function signature ${formatFunctionSignature(fnEntry)} in order and that the contract actually exposes this function at the called address.`,
    );
  }

  // Capture the raw returndata alongside the decoded result so the agent can
  // recover if our decoding produced something unexpected (e.g. our `result`
  // looks like a number when the agent expected an address). One extra
  // eth_call; cheap and adds debug headroom.
  let resultRaw: `0x${string}` | undefined;
  try {
    const data = encodeFunctionData({
      abi,
      functionName: fnEntry.name,
      args: callArgs as readonly unknown[],
    });
    const raw = await client.call({ to: contract, data });
    resultRaw = raw.data;
  } catch {
    // Best-effort; if the second call fails, ship the result we have.
    resultRaw = undefined;
  }

  return {
    function: formatFunctionSignature(fnEntry),
    args: callArgs,
    result,
    resultRaw,
    abiSource,
    contractIsProxy,
    implementationAddress,
  };
}
