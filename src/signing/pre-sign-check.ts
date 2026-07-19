import { decodeFunctionData, toFunctionSelector, type Abi } from "viem";
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
import type { SupportedChain, UnsignedTx } from "../types/index.js";

/**
 * Returns the pinned Aave V3 Pool address for `chain`. We deliberately DO NOT
 * resolve this via PoolAddressesProvider.getPool() at sign time: the pre-sign
 * check is our defense against a hostile RPC, so it must not delegate a trust-
 * root lookup to that same RPC. Pool addresses are frozen per chain since
 * Aave V3 launched and have not rotated; see contracts.ts for the source.
 */
function pinnedAavePool(chain: SupportedChain): `0x${string}` {
  return CONTRACTS[chain].aave.pool as `0x${string}`;
}

/**
 * Independent pre-sign safety check. Runs in send_transaction AFTER the handle
 * is redeemed and chain id is verified, immediately before the tx is handed to
 * Ledger Live. The goal is a second line of defense against a compromised /
 * prompt-injected agent: even if a prepare_* tool produced a misleading
 * description, this check reasons about the raw calldata alone and refuses
 * anything that doesn't match a known-safe shape.
 *
 * Threat model: the canonical prompt-injection attack against a wallet agent is
 * convincing the model to sign an `approve(attacker, MAX)` or a direct
 * `transfer(attacker, amount)` on some token. This check closes the approve
 * vector outright (spender allowlist) and narrows the call-surface to
 * contracts we've explicitly recognized.
 */

/** LiFi Diamond — deterministic address across all our chains. Stable since 2022. */
const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

/** 4-byte selectors we treat as explicit allowlist entries. */
const SELECTOR = {
  approve: toFunctionSelector("approve(address,uint256)").toLowerCase(),
  transfer: toFunctionSelector("transfer(address,uint256)").toLowerCase(),
} as const;

/** Kinds of destination we recognize; used for error messages only. */
type DestinationKind =
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

interface RecognizedDestination {
  kind: DestinationKind;
  /** ABI to check the selector against. null = skip selector check (LiFi: too many selectors). */
  allowedAbi: Abi | null;
}

function computeSelectorsFromAbi(abi: Abi): Set<string> {
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

const AAVE_SELECTORS = computeSelectorsFromAbi(aavePoolAbi);
const COMET_SELECTORS = computeSelectorsFromAbi(cometAbi);
const MORPHO_SELECTORS = computeSelectorsFromAbi(morphoBlueAbi);
const LIDO_STETH_SELECTORS = computeSelectorsFromAbi(stETHAbi);
const LIDO_WSTETH_SELECTORS = computeSelectorsFromAbi(wstETHAbi);
const LIDO_QUEUE_SELECTORS = computeSelectorsFromAbi(lidoWithdrawalQueueAbi);
const ROCKET_DEPOSIT_POOL_SELECTORS = computeSelectorsFromAbi(rocketDepositPoolAbi);
const ROCKET_RETH_SELECTORS = computeSelectorsFromAbi(rocketTokenRETHAbi);
const EIGEN_SELECTORS = computeSelectorsFromAbi(eigenStrategyManagerAbi);
const UNISWAP_NPM_SELECTORS = computeSelectorsFromAbi(uniswapPositionManagerAbi);
const UNISWAP_SWAP_ROUTER_SELECTORS = computeSelectorsFromAbi(swapRouter02Abi);
const ERC20_SELECTORS = computeSelectorsFromAbi(erc20Abi);
// WETH9 is also an ERC-20 (approve/transfer for Uniswap/Compound/Morpho
// supply flows), so the accepted surface is ERC-20 ∪ {withdraw, deposit}.
const WETH9_SELECTORS = new Set<string>([
  ...ERC20_SELECTORS,
  ...computeSelectorsFromAbi(wethAbi),
]);

async function classifyDestination(
  chain: SupportedChain,
  to: `0x${string}`
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

  // Uniswap V3 NonfungiblePositionManager (not currently written to by our prepare_*
  // tools, but listed because it's in CONTRACTS and we may add LP mint/collect flows).
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

/** Spenders allowed for approve(spender, _). */
function buildSpenderAllowlist(chain: SupportedChain): Set<string> {
  const out = new Set<string>();
  out.add(pinnedAavePool(chain).toLowerCase());
  const compound = CONTRACTS[chain].compound as Record<string, string> | undefined;
  if (compound) for (const a of Object.values(compound)) out.add(a.toLowerCase());
  if (chain === "ethereum") {
    out.add(CONTRACTS.ethereum.morpho.blue.toLowerCase());
    out.add(CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase());
    // wstETH is the spender on prepare_lido_wrap's approve leg (stETH → wstETH).
    out.add(CONTRACTS.ethereum.lido.wstETH.toLowerCase());
    out.add(CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase());
  }
  out.add(CONTRACTS[chain].uniswap.positionManager.toLowerCase());
  const swapRouter02 = (CONTRACTS[chain].uniswap as { swapRouter02?: string })
    .swapRouter02;
  if (swapRouter02) out.add(swapRouter02.toLowerCase());
  out.add(LIFI_DIAMOND);
  return out;
}

/**
 * Throws a descriptive error if `tx` looks unsafe to sign. Call synchronously
 * before every WalletConnect submission. "Unsafe" is conservative: unknown
 * destination + non-empty data, approves to non-allowlisted spenders, or
 * selectors that don't belong to the contract we think we're calling.
 */
export async function assertTransactionSafe(tx: UnsignedTx): Promise<void> {
  // 1) Pure native send — data must be empty. Allow the transfer; the user
  //    picks the recipient, and the Ledger screen shows it.
  if (tx.data === "0x" || tx.data === "0x0" || tx.data === "0x00") {
    return;
  }

  if (tx.data.length < 10) {
    throw new Error(
      `Pre-sign check: calldata (${tx.data}) is too short to carry a function selector. ` +
        `Refusing to sign.`
    );
  }

  const selector = tx.data.slice(0, 10).toLowerCase() as `0x${string}`;
  const dest = await classifyDestination(tx.chain, tx.to);

  // 2) approve(): the single highest-leverage attack vector. Spender MUST be on
  //    the protocol allowlist. Destination is whichever ERC-20 we're approving.
  if (selector === SELECTOR.approve) {
    if (!dest) {
      throw new Error(
        `Pre-sign check: refusing approve() on ${tx.to} (${tx.chain}) — token is not in our ` +
          `recognized set. If this is a legitimate token, add it to CONTRACTS[${tx.chain}].tokens.`
      );
    }
    // `to` must be a token (ERC-20 or a protocol token surface like stETH),
    // not, say, the Aave Pool. approve() on the pool itself is nonsensical.
    if (
      dest.kind !== "known-erc20" &&
      dest.kind !== "lido-stETH" && // stETH IS an ERC-20; approvals to spenders happen on it
      dest.kind !== "weth9" // WETH IS an ERC-20; Uniswap/Compound/Morpho supply flows approve it
    ) {
      throw new Error(
        `Pre-sign check: refusing approve() on ${dest.kind} (${tx.to}) — approvals should ` +
          `target ERC-20 tokens, not protocol contracts.`
      );
    }
    let spender: string;
    let amount: bigint;
    try {
      const decoded = decodeFunctionData({ abi: erc20Abi, data: tx.data });
      spender = (decoded.args?.[0] as string).toLowerCase();
      amount = decoded.args?.[1] as bigint;
    } catch {
      throw new Error(
        `Pre-sign check: could not decode approve() calldata on ${tx.to}. Refusing to sign.`
      );
    }
    // Revokes — `approve(spender, 0)` — bypass the spender allowlist. Setting
    // an allowance to zero cannot grant any authority, so the canonical
    // phishing/drain pattern doesn't apply. Without this carve-out
    // `prepare_revoke_approval` is unusable for its primary use case:
    // cleaning up obsolete allowances to spenders the allowlist doesn't
    // recognize (Permit2, dead router versions, deprecated routers) — those
    // are exactly the spenders users want OFF, not added to the allowlist.
    // Issue #305.
    if (amount === 0n) return;
    const allowlist = buildSpenderAllowlist(tx.chain);
    if (!allowlist.has(spender)) {
      // Per-prepare-tool affirmative-ack escape hatch. A prepare_* tool
      // that legitimately approves a non-allowlisted spender (e.g.
      // `prepare_curve_swap` → Curve stETH/ETH pool) takes the user's
      // schema-enforced `acknowledgeNonAllowlistedSpender: true` and
      // stamps this flag on the tx. The flag flows through the
      // server-minted handle, so the agent cannot fabricate it on a tx
      // that didn't come through such a path. Without the ack the
      // refusal still fires — the allowlist is the default; the ack is
      // the explicit opt-out.
      if (tx.acknowledgedNonAllowlistedSpender === true) return;
      throw new Error(
        `Pre-sign check: refusing approve(spender=${spender}, ...) on ${tx.chain} — spender is ` +
          `not in the protocol allowlist (Aave Pool, Compound Comet, Morpho Blue, Lido Queue, ` +
          `EigenLayer, Uniswap NPM, Uniswap SwapRouter02, LiFi Diamond). This is the canonical phishing/prompt-injection ` +
          `pattern. If you need to approve a different spender, do it from the Ledger Live app directly. ` +
          `(Revokes — approve(spender, 0) — bypass this check; if you want to revoke an existing ` +
          `allowance, run prepare_revoke_approval instead of crafting your own approve. ` +
          `A prepare_* tool may also accept an explicit per-tool ` +
          `\`acknowledgeNonAllowlistedSpender: true\` to opt out of this default after surfacing ` +
          `the trade-off to the user.)`
      );
    }
    return;
  }

  // 3) transfer(): user-directed token move. Destination must still be a token
  //    we recognize (otherwise the agent is calling transfer() on an arbitrary
  //    contract with matching 4-byte — unlikely but worth rejecting).
  if (selector === SELECTOR.transfer) {
    if (
      !dest ||
      (dest.kind !== "known-erc20" && dest.kind !== "lido-stETH" && dest.kind !== "weth9")
    ) {
      throw new Error(
        `Pre-sign check: refusing transfer() on ${tx.to} (${tx.chain}) — token is not in our ` +
          `recognized set. Add it to CONTRACTS[${tx.chain}].tokens if this is a legitimate asset.`
      );
    }
    return;
  }

  // 4) Every other selector: must be a known protocol destination — UNLESS
  //    this handle came through `prepare_custom_call`'s affirmative-ack
  //    path (`acknowledgeNonProtocolTarget: true`) OR through one of the
  //    `prepare_safe_tx_*` builders (`safeTxOrigin: true`, issue #609 —
  //    Safe addresses are user-specific and can never appear in any
  //    canonical allowlist; the OUTER calldata is always `approveHash` or
  //    `execTransaction`, neither of which carries transferable authority
  //    on its own). The schema-enforced gate at build time (custom_call)
  //    or the tool semantics (safe_tx_*) already covered consent for the
  //    non-protocol target; refusing here would render the escape hatch
  //    dead-on-arrival (the bug from #496) and break the documented
  //    `prepare_safe_tx_propose → send_transaction` flow. Note this skips
  //    ONLY the catch-all unknown-destination refusal — the approve()
  //    spender-allowlist (block 2 above), the transfer()-on-unknown-token
  //    refusal (block 3), and the per-destination ABI-selector check
  //    (block 5 below) all stay active because they protect against
  //    distinct attack shapes the ack does not subsume.
  if (!dest) {
    if (
      tx.acknowledgedNonProtocolTarget === true ||
      tx.safeTxOrigin === true
    ) {
      // Pre-sign defenses #2 (approve spender allowlist) and #3 (transfer
      // on unknown token) are already past; this catch-all is the right
      // place to cleanly accept the call.
      return;
    }
    throw new Error(
      `Pre-sign check: refusing to sign against unknown contract ${tx.to} on ${tx.chain} ` +
        `(selector ${selector}). Accepted destinations: Aave V3 Pool, Compound V3 Comet markets, ` +
        `Morpho Blue, Lido (stETH/Queue), EigenLayer StrategyManager, Uniswap V3 NPM, Uniswap V3 SwapRouter02, LiFi Diamond, ` +
        `and known ERC-20s. An unknown destination with non-empty calldata is exactly the shape of ` +
        `a prompt-injection attack. (If you intended an arbitrary contract call, use ` +
        `\`prepare_custom_call\` with \`acknowledgeNonProtocolTarget: true\` — that path is ` +
        `built specifically to bypass this check.)`
    );
  }

  // 4b) LiFi Diamond stamped-partition refusal (#786 / #760-core). The Diamond
  //     is recognized with `allowedAbi: null`, so block 5's early return below
  //     would otherwise let a stamped `prepare_custom_call` to it pass with NO
  //     selector / argument / value check — a general drain (arbitrary facet
  //     call, SwapData.callTo → arbitrary contract, attacker-chosen native
  //     value). `prepare_swap` is the SOLE legitimate EVM prepare path
  //     producing `to == LIFI_DIAMOND` and it is UNSTAMPED; `prepare_custom_call`
  //     is ALWAYS stamped (server-set at execution/index.ts, non-forgeable —
  //     the field is in no zod input schema, 3 server writers). So the stamp
  //     deterministically partitions legit (unstamped prepare_swap → passes
  //     below) from rogue (stamped custom_call → refused here) LiFi txs with
  //     zero over-block. This must sit BEFORE the `allowedAbi === null` return.
  //     EVM-ONLY: btc/solana/tron LiFi swaps (TRON uses a different Diamond)
  //     never traverse this branch — #744 tracks the sibling class there, and
  //     #760 is NOT closed for those chains. Deliberate availability cost: a
  //     raw LiFi call via prepare_custom_call is refused with no override (the
  //     right trade for an open INCIDENT). SwapData.callTo WITHIN a legitimate
  //     unstamped prepare_swap route is a different (malicious-API) threat
  //     actor, out of scope → #776 / Inv-#15.
  if (dest.kind === "lifi-diamond" && tx.acknowledgedNonProtocolTarget === true) {
    throw new Error(
      `Pre-sign check: refusing a stamped prepare_custom_call ` +
        `(acknowledgedNonProtocolTarget) transaction to the LiFi Diamond ` +
        `(${tx.to}) on ${tx.chain}. The Diamond is recognized with no ` +
        `ABI-selector gate, so an arbitrary facet call, an attacker-authored ` +
        `SwapData.callTo, or an attacker-chosen native value would pass every ` +
        `pre-sign check unexamined — the #760-core drain. Legitimate LiFi swaps ` +
        `go through prepare_swap, which does not carry this stamp and is ` +
        `unaffected. There is no override: raw prepare_custom_call access to ` +
        `the LiFi Diamond is disabled.`
    );
  }

  // 5) For destinations where we have a tight ABI, verify the selector is one
  //    of its functions. LiFi Diamond is the explicit exception (allowedAbi=null).
  if (dest.allowedAbi === null) return;

  // Pick the right precomputed selector set.
  const allowedSelectors = (() => {
    switch (dest.kind) {
      case "aave-v3-pool":
        return AAVE_SELECTORS;
      case "compound-v3-comet":
        return COMET_SELECTORS;
      case "morpho-blue":
        return MORPHO_SELECTORS;
      case "lido-stETH":
        // stETH is both the Lido submit surface AND an ERC-20 (transfer/approve).
        return new Set<string>([...LIDO_STETH_SELECTORS, ...ERC20_SELECTORS]);
      case "lido-wstETH":
        // wstETH is both the wrap/unwrap surface AND an ERC-20 (transfer/approve).
        return new Set<string>([...LIDO_WSTETH_SELECTORS, ...ERC20_SELECTORS]);
      case "lido-withdrawalQueue":
        return LIDO_QUEUE_SELECTORS;
      case "rocketpool-depositPool":
        return ROCKET_DEPOSIT_POOL_SELECTORS;
      case "rocketpool-rETH":
        // rETH is both the burn surface AND an ERC-20 (transfer/approve).
        return new Set<string>([...ROCKET_RETH_SELECTORS, ...ERC20_SELECTORS]);
      case "eigenlayer-strategyManager":
        return EIGEN_SELECTORS;
      case "uniswap-v3-npm":
        return UNISWAP_NPM_SELECTORS;
      case "uniswap-v3-swap-router":
        return UNISWAP_SWAP_ROUTER_SELECTORS;
      case "weth9":
        return WETH9_SELECTORS;
      case "known-erc20":
        return ERC20_SELECTORS;
      case "lifi-diamond":
        return null; // handled above
    }
  })();

  if (allowedSelectors && !allowedSelectors.has(selector)) {
    throw new Error(
      `Pre-sign check: selector ${selector} is not a known function on ${dest.kind} (${tx.to}). ` +
        `Refusing to sign.`
    );
  }
}
