import { cache } from "../cache.js";
import { CACHE_TTL } from "../../config/cache.js";
import { etherscanV2Fetch } from "./etherscan-v2.js";
import type { SupportedChain } from "../../types/index.js";

export interface ContractInfo {
  address: `0x${string}`;
  chain: SupportedChain;
  isVerified: boolean;
  isProxy: boolean;
  implementation?: `0x${string}`;
  /**
   * Etherscan-reported contract name. This is attacker-controllable at deploy
   * time — a malicious contract can set ContractName = "Aave V3 Pool" or bury
   * prompt-injection payloads in it. We sanitize to a short, safe subset
   * (alphanumerics / dots / underscores / dashes, ≤64 chars) and callers
   * should NOT display this field without that sanitization.
   */
  contractName?: string;
  compilerVersion?: string;
  abi?: unknown[];
}

/**
 * Sanitize a free-form name from Etherscan for agent/user display. Strips
 * anything that could carry a newline or steer the model (markdown fences,
 * angle brackets, braces, quotes) and caps length. We never want the raw
 * string hitting the agent transcript — it's attacker-controlled.
 */
export function sanitizeContractName(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw.replace(/[^A-Za-z0-9._\-]/g, "").slice(0, 64);
  return cleaned.length > 0 ? cleaned : undefined;
}

interface EtherscanSourceCodeItem {
  SourceCode: string;
  ABI: string;
  ContractName: string;
  CompilerVersion: string;
  Proxy: string;
  Implementation: string;
}

/**
 * Fetch contract verification info via Etherscan V2. Cached for 24 hours —
 * verification state rarely changes.
 *
 * V2 migration note: the per-chain V1 endpoints (api.etherscan.io,
 * api.arbiscan.io, ...) were deprecated in 2025 and now NOTOK every call.
 * V2 consolidates all chains behind a single host with `chainid`; the call
 * shape is otherwise unchanged. An ETHERSCAN_API_KEY is now required.
 *
 * Error discipline: real errors (missing key, rate limit, HTTP failure)
 * throw and are NOT cached. Only legitimate "contract exists but isn't
 * verified" responses (status:"1", empty SourceCode) are cached as
 * `{isVerified: false}`. This matters because caching an error as
 * "unverified" would lock callers out for 24h and silently degrade the
 * security-review path.
 */
export async function getContractInfo(
  address: `0x${string}`,
  chain: SupportedChain
): Promise<ContractInfo> {
  const key = `etherscan:${chain}:${address.toLowerCase()}`;
  const hit = cache.get<ContractInfo>(key);
  if (hit) return hit;

  // Surface the underlying error untouched — EtherscanApiKeyMissingError
  // carries a helpful message, and transient errors (rate limit, etc.)
  // should not pollute the 24h cache with a fake "not verified".
  const rows = await etherscanV2Fetch<EtherscanSourceCodeItem>(chain, {
    module: "contract",
    action: "getsourcecode",
    address,
  });

  if (!rows[0]) {
    // status:"1" with empty result — treat as unverified.
    const result: ContractInfo = {
      address,
      chain,
      isVerified: false,
      isProxy: false,
    };
    cache.set(key, result, CACHE_TTL.SECURITY_VERIFICATION);
    return result;
  }

  const item = rows[0];
  const isVerified = item.SourceCode !== "";
  let abi: unknown[] | undefined;
  if (isVerified && item.ABI && item.ABI !== "Contract source code not verified") {
    try {
      const parsed = JSON.parse(item.ABI);
      // Cap ABI length. 5000 items is ~10× the largest proxy ABIs we've seen
      // (LiFi Diamond is ~1000 entries); anything bigger is either a pathological
      // contract or a hostile response trying to blow up memory on scan paths.
      const MAX_ABI_ITEMS = 5000;
      if (Array.isArray(parsed) && parsed.length <= MAX_ABI_ITEMS) {
        abi = parsed;
      } else {
        abi = undefined;
      }
    } catch {
      abi = undefined;
    }
  }

  const info: ContractInfo = {
    address,
    chain,
    isVerified,
    isProxy: item.Proxy === "1",
    implementation: item.Implementation && /^0x[0-9a-fA-F]{40}$/.test(item.Implementation)
      ? (item.Implementation as `0x${string}`)
      : undefined,
    contractName: sanitizeContractName(item.ContractName),
    // Restrict compiler version to the safe pattern (e.g. v0.8.17+commit.8df45f5f)
    // so an attacker can't embed control characters or URLs in this field either.
    compilerVersion:
      item.CompilerVersion && /^[A-Za-z0-9.+_\-]+$/.test(item.CompilerVersion)
        ? item.CompilerVersion
        : undefined,
    abi,
    // sourceCode is attacker-controllable and huge; we never hand it to the
    // agent. Dropped entirely at the source rather than hoping downstream
    // code remembers not to surface it.
  };

  cache.set(key, info, CACHE_TTL.SECURITY_VERIFICATION);
  return info;
}
