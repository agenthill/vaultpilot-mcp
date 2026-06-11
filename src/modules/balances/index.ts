import { getAddress } from "viem";
import { getClient } from "../../data/rpc.js";
import { erc20Abi } from "../../abis/erc20.js";
import { makeTokenAmount } from "../../data/format.js";
import { getTokenPrice } from "../../data/prices.js";
import { NATIVE_SYMBOL } from "../../config/contracts.js";
import { readEip1967Implementation } from "../../data/proxy.js";
import { getTronTokenBalance } from "../tron/balances.js";
import { getSolanaTokenBalance } from "../solana/balances.js";
import type {
  GetTokenBalanceArgs,
  GetTokenMetadataArgs,
  ResolveNameArgs,
  ReverseResolveArgs,
} from "./schemas.js";
import type {
  AnyChain,
  SolanaBalance,
  SupportedChain,
  TokenAmount,
  TronBalance,
} from "../../types/index.js";

export interface TokenMetadata {
  chain: SupportedChain;
  address: `0x${string}`;
  symbol: string;
  name: string;
  decimals: number;
  isProxy: boolean;
  implementation?: `0x${string}`;
}

/**
 * Fetch the balance of an arbitrary token (ERC-20 by address, or the chain's native coin).
 * Returns `{ ...TokenAmount, zero: true }` when the wallet has no balance.
 *
 * On TRON, `wallet` must be base58 (prefix T) and `token` is either "native"
 * (TRX) or a base58 TRC-20 contract address; the shape of the returned value
 * is `TronBalance` rather than `TokenAmount`.
 */
export async function getTokenBalance(
  args: GetTokenBalanceArgs
): Promise<TokenAmount | TronBalance | SolanaBalance> {
  const chain = args.chain as AnyChain;

  // TRON branches to its own reader — addresses are base58 and the price
  // provider uses a different chain identifier.
  if (chain === "tron") {
    return getTronTokenBalance(args.wallet, args.token);
  }

  // Solana: base58 pubkey wallet, `token` is either "native" (SOL) or an
  // SPL mint address. Uses `@solana/web3.js` against the configured RPC.
  if (chain === "solana") {
    return getSolanaTokenBalance(args.wallet, args.token);
  }

  const wallet = args.wallet as `0x${string}`;
  const evmChain = chain as SupportedChain;
  const client = getClient(evmChain);

  if (args.token === "native") {
    const [balance, price] = await Promise.all([
      client.getBalance({ address: wallet }),
      getTokenPrice(evmChain, "native"),
    ]);
    return makeTokenAmount(
      evmChain,
      "0x0000000000000000000000000000000000000000" as `0x${string}`,
      balance,
      18,
      NATIVE_SYMBOL[evmChain],
      price
    );
  }

  const token = args.token as `0x${string}`;
  const [balance, decimals, symbol] = await client.multicall({
    contracts: [
      { address: token, abi: erc20Abi, functionName: "balanceOf", args: [wallet] },
      { address: token, abi: erc20Abi, functionName: "decimals" },
      { address: token, abi: erc20Abi, functionName: "symbol" },
    ],
    allowFailure: false,
  });
  const price = await getTokenPrice(evmChain, token);
  return makeTokenAmount(
    evmChain,
    token,
    balance as bigint,
    Number(decimals),
    symbol as string,
    price
  );
}

/**
 * Fetch on-chain metadata (symbol, name, decimals) for any ERC-20 address, no wallet required.
 * Also detects EIP-1967 transparent proxies and returns the current implementation slot so
 * callers know they're looking at a proxy.
 */
export async function getTokenMetadata(
  args: GetTokenMetadataArgs
): Promise<TokenMetadata> {
  const chain = args.chain as SupportedChain;
  const address = getAddress(args.address) as `0x${string}`;
  const client = getClient(chain);

  const [symbol, nameResult, decimals, implementation] = await Promise.all([
    client.readContract({ address, abi: erc20Abi, functionName: "symbol" }),
    client
      .readContract({ address, abi: erc20Abi, functionName: "name" })
      .catch(() => undefined),
    client.readContract({ address, abi: erc20Abi, functionName: "decimals" }),
    readEip1967Implementation(chain, address),
  ]);

  return {
    chain,
    address,
    symbol: symbol as string,
    name: (nameResult as string | undefined) ?? (symbol as string),
    decimals: Number(decimals),
    isProxy: implementation !== undefined,
    implementation,
  };
}

/**
 * Verification URL for any ENS resolution (forward or reverse).
 * app.ens.domains is a third-party site the user opens in their browser —
 * a rogue MCP cannot intercept or re-skin it, making this the only
 * suggestion here that doesn't route through the MCP. (Issue #574, option 1.)
 */
function ensVerificationUrl(input: string): string {
  return `https://app.ens.domains/${encodeURIComponent(input)}`;
}

/** Warning text appended to every ENS resolution response. */
const ENS_SINGLE_SOURCE_WARNING =
  "ENS resolution is single-sourced through this MCP — verify via verificationUrl before sending funds.";

/**
 * ENS forward resolution: name → address. Only Ethereum mainnet ENS is supported (viem routes
 * through the mainnet resolver even for subdomains used cross-chain).
 *
 * Includes a third-party verificationUrl (app.ens.domains) so the user can
 * cross-check the returned address in their browser independently of this MCP.
 * (Security hardening per issue #574.)
 */
export async function resolveName(
  args: ResolveNameArgs
): Promise<{ name: string; address: `0x${string}` | null; verificationUrl: string; singleSourceWarning: string }> {
  const client = getClient("ethereum");
  const address = await client.getEnsAddress({ name: args.name });
  return {
    name: args.name,
    address,
    verificationUrl: ensVerificationUrl(args.name),
    singleSourceWarning: ENS_SINGLE_SOURCE_WARNING,
  };
}

/**
 * ENS reverse resolution: address → primary name. Returns null if the address has no primary name set.
 *
 * Includes a third-party verificationUrl (app.ens.domains) so the user can
 * cross-check the result in their browser independently of this MCP.
 * (Security hardening per issue #574.)
 */
export async function reverseResolve(
  args: ReverseResolveArgs
): Promise<{ address: `0x${string}`; name: string | null; verificationUrl: string; singleSourceWarning: string }> {
  const client = getClient("ethereum");
  const address = args.address as `0x${string}`;
  const name = await client.getEnsName({ address });
  return {
    address,
    name,
    verificationUrl: ensVerificationUrl(args.address),
    singleSourceWarning: ENS_SINGLE_SOURCE_WARNING,
  };
}
