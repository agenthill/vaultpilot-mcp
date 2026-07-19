/**
 * Recognized-destination classification — the shared source of truth for which
 * `to` addresses the pre-sign layer treats as pinned protocol contracts, and
 * which curated ABI (union) block 5 accepts for each.
 *
 * Split out of `pre-sign-check.ts` so the recipient-authorization seam
 * (`recipient-authorization.ts`, #757/#760 design #759) can consume the
 * `classifyDestination` / `RECOGNIZED_ABIS_BY_KIND` / `acceptedSelectorSetForKind`
 * data WITHOUT importing the whole pre-sign module — several tests stub
 * `pre-sign-check`'s `assertTransactionSafe` while relying on the REAL
 * destination recognition, and a partial mock of that module must not take these
 * data exports down with it.
 */
import { toFunctionSelector, type Abi } from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { aavePoolAbi } from "../abis/aave-pool.js";
import { stETHAbi, wstETHAbi, lidoWithdrawalQueueAbi } from "../abis/lido.js";
import { eigenStrategyManagerAbi } from "../abis/eigenlayer-strategy-manager.js";
import { rocketDepositPoolAbi, rocketTokenRETHAbi } from "../abis/rocketpool.js";
import { cometAbi } from "../abis/compound-comet.js";
import { morphoBlueAbi } from "../abis/morpho-blue.js";
import { uniswapPositionManagerAbi } from "../abis/uniswap-position-manager.js";
import { swapRouter02Abi } from "../abis/uniswap-swap-router-02.js";
import { wethAbi } from "../abis/weth.js";
import { CONTRACTS } from "../config/contracts.js";
import type { SupportedChain } from "../types/index.js";

/**
 * Returns the pinned Aave V3 Pool address for `chain`. We deliberately DO NOT
 * resolve this via PoolAddressesProvider.getPool() at sign time: the pre-sign
 * check is our defense against a hostile RPC, so it must not delegate a trust-
 * root lookup to that same RPC. Pool addresses are frozen per chain since
 * Aave V3 launched and have not rotated; see contracts.ts for the source.
 */
export function pinnedAavePool(chain: SupportedChain): `0x${string}` {
  return CONTRACTS[chain].aave.pool as `0x${string}`;
}

/** LiFi Diamond — deterministic address across all our chains. Stable since 2022. */
export const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

/** Kinds of destination we recognize; used for error messages only. */
export type DestinationKind =
  | "aave-v3-pool"
  | "compound-v3-comet"
  | "morpho-blue"
  | "lido-stETH"
  | "lido-wstETH"
  | "lido-withdrawalQueue"
  | "rocketpool-depositPool"
  | "rocketpool-rETH"
  | "eigenlayer-strategyManager"
  | "uniswap-v3-npm"
  | "uniswap-v3-swap-router"
  | "weth9"
  | "known-erc20"
  | "lifi-diamond";

/** Every recognized kind that carries a curated ABI (i.e. all but LiFi). */
export type RecognizedAbiKind = Exclude<DestinationKind, "lifi-diamond">;

export interface RecognizedDestination {
  kind: DestinationKind;
  /** ABI to check the selector against. null = skip selector check (LiFi: too many selectors). */
  allowedAbi: Abi | null;
}

export function computeSelectorsFromAbi(abi: Abi): Set<string> {
  const out = new Set<string>();
  for (const item of abi) {
    if (item.type !== "function") continue;
    try {
      out.add(toFunctionSelector(item).toLowerCase());
    } catch {
      // Skip items that don't encode cleanly (shouldn't happen in our curated ABIs).
    }
  }
  return out;
}

/**
 * The ABI set block 5 accepts per recognized kind — the SINGLE source of truth
 * for both the per-selector check in `assertTransactionSafe` AND the D2-rot
 * module-load enumerator (`recipient-authorization.ts`). Several kinds accept a
 * UNION wider than `classifyDestination`'s single `allowedAbi` field:
 * stETH/wstETH/rETH are each also ERC-20 (transfer/approve), and weth9 is
 * ERC-20 ∪ {withdraw,deposit}. Keeping ONE map here — rather than a switch in
 * the gate and a second array in the enumerator — is what stops the two from
 * drifting apart (design #759 D2-rot: "never a second, independently-maintained
 * array"). `lifi-diamond` has no curated ABI (`allowedAbi: null`) and is
 * excluded — routed to D8, deferred.
 */
export const RECOGNIZED_ABIS_BY_KIND: Record<RecognizedAbiKind, readonly Abi[]> = {
  "aave-v3-pool": [aavePoolAbi],
  "compound-v3-comet": [cometAbi],
  "morpho-blue": [morphoBlueAbi],
  // stETH is both the Lido submit surface AND an ERC-20 (transfer/approve).
  "lido-stETH": [stETHAbi, erc20Abi],
  // wstETH is both the wrap/unwrap surface AND an ERC-20 (transfer/approve).
  "lido-wstETH": [wstETHAbi, erc20Abi],
  "lido-withdrawalQueue": [lidoWithdrawalQueueAbi],
  "rocketpool-depositPool": [rocketDepositPoolAbi],
  // rETH is both the burn surface AND an ERC-20 (transfer/approve).
  "rocketpool-rETH": [rocketTokenRETHAbi, erc20Abi],
  "eigenlayer-strategyManager": [eigenStrategyManagerAbi],
  "uniswap-v3-npm": [uniswapPositionManagerAbi],
  "uniswap-v3-swap-router": [swapRouter02Abi],
  // WETH9 is also an ERC-20 (approve/transfer for Uniswap/Compound/Morpho
  // supply flows), so the accepted surface is ERC-20 ∪ {withdraw, deposit}.
  weth9: [erc20Abi, wethAbi],
  "known-erc20": [erc20Abi],
};

const selectorSetCache = new Map<RecognizedAbiKind, Set<string>>();

/**
 * The exact 4-byte selector set block 5 accepts for `kind` — the union across
 * every ABI `RECOGNIZED_ABIS_BY_KIND[kind]` lists. Returns `null` for
 * `lifi-diamond` (no curated ABI; block 5 skips it). Memoized per kind.
 */
export function acceptedSelectorSetForKind(
  kind: DestinationKind,
): Set<string> | null {
  if (kind === "lifi-diamond") return null;
  const cached = selectorSetCache.get(kind);
  if (cached) return cached;
  const set = new Set<string>();
  for (const abi of RECOGNIZED_ABIS_BY_KIND[kind]) {
    for (const s of computeSelectorsFromAbi(abi)) set.add(s);
  }
  selectorSetCache.set(kind, set);
  return set;
}

export async function classifyDestination(
  chain: SupportedChain,
  to: `0x${string}`,
): Promise<RecognizedDestination | null> {
  const lo = to.toLowerCase();

  // Aave V3 Pool — pinned from a hardcoded address, NOT a live RPC read.
  const aavePool = pinnedAavePool(chain).toLowerCase();
  if (lo === aavePool) return { kind: "aave-v3-pool", allowedAbi: aavePoolAbi };

  // Compound V3 Comet markets.
  const compound = CONTRACTS[chain].compound as Record<string, string> | undefined;
  if (compound) {
    for (const addr of Object.values(compound)) {
      if (lo === addr.toLowerCase()) {
        return { kind: "compound-v3-comet", allowedAbi: cometAbi };
      }
    }
  }

  // Ethereum-only protocols.
  if (chain === "ethereum") {
    if (lo === CONTRACTS.ethereum.morpho.blue.toLowerCase()) {
      return { kind: "morpho-blue", allowedAbi: morphoBlueAbi };
    }
    if (lo === CONTRACTS.ethereum.lido.stETH.toLowerCase()) {
      return { kind: "lido-stETH", allowedAbi: stETHAbi };
    }
    // wstETH — target of prepare_lido_wrap (wrap) / prepare_lido_unwrap (unwrap).
    if (lo === CONTRACTS.ethereum.lido.wstETH.toLowerCase()) {
      return { kind: "lido-wstETH", allowedAbi: wstETHAbi };
    }
    if (lo === CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase()) {
      return { kind: "lido-withdrawalQueue", allowedAbi: lidoWithdrawalQueueAbi };
    }
    // Rocket Pool — RocketDepositPool.deposit() (prepare_rocketpool_stake) and
    // rETH.burn() (prepare_rocketpool_unstake). Fixed mainnet addresses.
    if (lo === CONTRACTS.ethereum.rocketpool.depositPool.toLowerCase()) {
      return { kind: "rocketpool-depositPool", allowedAbi: rocketDepositPoolAbi };
    }
    if (lo === CONTRACTS.ethereum.rocketpool.rETH.toLowerCase()) {
      return { kind: "rocketpool-rETH", allowedAbi: rocketTokenRETHAbi };
    }
    if (lo === CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase()) {
      return { kind: "eigenlayer-strategyManager", allowedAbi: eigenStrategyManagerAbi };
    }
  }

  // Uniswap V3 NonfungiblePositionManager (target of prepare_uniswap_v3_* builders).
  if (lo === CONTRACTS[chain].uniswap.positionManager.toLowerCase()) {
    return { kind: "uniswap-v3-npm", allowedAbi: uniswapPositionManagerAbi };
  }

  // Uniswap V3 SwapRouter02 — target of prepare_uniswap_swap.
  const swapRouter02 = (CONTRACTS[chain].uniswap as { swapRouter02?: string })
    .swapRouter02;
  if (swapRouter02 && lo === swapRouter02.toLowerCase()) {
    return { kind: "uniswap-v3-swap-router", allowedAbi: swapRouter02Abi };
  }

  // LiFi Diamond — accept but skip per-selector check (LiFi's ABI is huge and dynamic).
  if (lo === LIFI_DIAMOND) return { kind: "lifi-diamond", allowedAbi: null };

  // WETH9 — matched BEFORE the generic tokens loop so the WETH9-specific
  // `withdraw` / `deposit` selectors pass the per-selector check. Classified
  // as plain `known-erc20` those selectors would be rejected even though
  // `prepare_weth_unwrap` legitimately emits them.
  const wethAddr = (CONTRACTS[chain].tokens as { WETH?: string } | undefined)?.WETH;
  if (wethAddr && lo === wethAddr.toLowerCase()) {
    return { kind: "weth9", allowedAbi: erc20Abi };
  }

  // Known ERC-20s (USDC, USDT, DAI, ...). Tokens ONLY — this path never
  // covers a protocol contract that exposes transfer-like selectors, because
  // the protocol branches above match first.
  const tokens = CONTRACTS[chain].tokens as Record<string, string> | undefined;
  if (tokens) {
    for (const addr of Object.values(tokens)) {
      if (lo === addr.toLowerCase()) return { kind: "known-erc20", allowedAbi: erc20Abi };
    }
  }

  return null;
}
