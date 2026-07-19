import { decodeFunctionData, toFunctionSelector } from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { CONTRACTS } from "../config/contracts.js";
import type { SupportedChain, UnsignedTx } from "../types/index.js";
import {
  pinnedAavePool,
  LIFI_DIAMOND,
  classifyDestination,
  acceptedSelectorSetForKind,
} from "./recognized-destinations.js";

// Re-export the recognition data so existing importers of pre-sign-check keep
// working; the definitions live in recognized-destinations.ts so the
// recipient-authorization seam can consume them without importing this whole
// module (which several tests partially mock).
export {
  classifyDestination,
  acceptedSelectorSetForKind,
  RECOGNIZED_ABIS_BY_KIND,
  computeSelectorsFromAbi,
  LIFI_DIAMOND,
} from "./recognized-destinations.js";
export type {
  DestinationKind,
  RecognizedAbiKind,
  RecognizedDestination,
} from "./recognized-destinations.js";

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
 * contracts we've explicitly recognized. The recipient/authority dimension —
 * WHERE a recognized-destination call routes value/authority — is enforced by
 * the separate `recipient-authorization.ts` seam (#757/#760, design #759),
 * which runs in `runEvmPreSignGuards` after the account-set match.
 */

/** 4-byte selectors we treat as explicit allowlist entries. */
const SELECTOR = {
  approve: toFunctionSelector("approve(address,uint256)").toLowerCase(),
  transfer: toFunctionSelector("transfer(address,uint256)").toLowerCase(),
} as const;

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

  // Single-sourced from RECOGNIZED_ABIS_BY_KIND — the same per-kind ABI union
  // the D2-rot enumerator walks, so the two cannot drift (design #759).
  const allowedSelectors = acceptedSelectorSetForKind(dest.kind);

  if (allowedSelectors && !allowedSelectors.has(selector)) {
    throw new Error(
      `Pre-sign check: selector ${selector} is not a known function on ${dest.kind} (${tx.to}). ` +
        `Refusing to sign.`
    );
  }
}
