import { decodeFunctionData, toFunctionSelector, getAddress } from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { safeMultisigAbi } from "../abis/safe-multisig.js";
import { CONTRACTS } from "../config/contracts.js";
import { lookupSafeTx } from "../modules/safe/safe-tx-store.js";
import type { SupportedChain, UnsignedTx } from "../types/index.js";
import {
  pinnedAavePool,
  LIFI_DIAMOND,
  classifyDestination,
  acceptedSelectorSetForKind,
} from "./recognized-destinations.js";
import { assertRecipientsAuthorized } from "./recipient-authorization.js";

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
    if (tx.safeTxOrigin === true) {
      // Safe-origin OUTER tx (`approveHash` / `execTransaction` on the user's
      // own Safe, which is never in any canonical allowlist). Do NOT wave it
      // through on the stamp alone (issue #761): the OUTER selector carries no
      // transferable authority, but the INNER action it authorizes does — an
      // `transfer(attacker, balance)` or a DELEGATECALL takeover otherwise
      // rides hidden behind the 4-byte-truncated inner `data`. Decode the
      // inner action and re-apply the direct-call pre-sign defenses to it.
      await assertSafeInnerActionSafe(tx);
      return;
    }
    if (tx.acknowledgedNonProtocolTarget === true) {
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

/** The inner action a Safe `execTransaction` / `approveHash` OUTER tx authorizes. */
interface SafeInnerAction {
  to: `0x${string}`;
  value: string;
  data: `0x${string}`;
  operation: 0 | 1;
}

/**
 * Resolve the inner `(to, value, data, operation)` a `safeTxOrigin` OUTER tx
 * ultimately authorizes (issue #761).
 *
 *  - `execTransaction(...)` — the inner tuple IS the OUTER calldata's own first
 *    four args, decoded directly.
 *  - `approveHash(safeTxHash)` — the inner body is not in the OUTER calldata; it
 *    lives in the server-side safe-tx-store keyed by the hash (stashed by
 *    `prepare_safe_tx_propose`). Returns `undefined` when the body is NOT in our
 *    custody — an externally-proposed tx confirmed via `prepare_safe_tx_approve`,
 *    or an expired cache entry. Those bytes were never held here, so there is
 *    nothing to decode; the caller keeps the pre-#761 accept for that path (the
 *    inner cannot be inspected from an `approveHash` hash alone).
 *
 * Throws (fail-closed) when the OUTER calldata does not decode against the Safe
 * ABI or is neither of the two expected selectors — a `safeTxOrigin` tx should
 * only ever be `approveHash` or `execTransaction`.
 */
function resolveSafeInnerAction(tx: UnsignedTx): SafeInnerAction | undefined {
  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: safeMultisigAbi, data: tx.data });
    } catch {
      throw new Error(
        `Pre-sign check: refusing a Safe-origin (safeTxOrigin) transaction whose OUTER calldata ` +
          `does not decode against the Safe ABI — a Safe-stamped tx must be approveHash(bytes32) ` +
          `or execTransaction(...). Refusing to sign.`
      );
    }
  })();
  if (decoded.functionName === "execTransaction") {
    const [to, value, data, operation] = decoded.args;
    return { to, value: value.toString(), data, operation: operation === 1 ? 1 : 0 };
  }
  if (decoded.functionName === "approveHash") {
    const [safeTxHash] = decoded.args;
    const entry = lookupSafeTx(safeTxHash);
    if (!entry) return undefined;
    const b = entry.body;
    return { to: b.to, value: b.value, data: b.data, operation: b.operation };
  }
  throw new Error(
    `Pre-sign check: refusing a Safe-origin (safeTxOrigin) transaction whose OUTER selector ` +
      `${tx.data.slice(0, 10)} is neither approveHash(bytes32) nor execTransaction(...). ` +
      `Refusing to sign an unrecognized Safe call.`
  );
}

/** Checksum-normalized address equality; a non-string / undefined side fails closed. */
function addrEq(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

/** Data that carries no function selector (a pure native send). */
function isEmptyCalldata(data: string): boolean {
  return data === "0x" || data === "0x0" || data === "0x00";
}

/**
 * Re-apply the direct-call pre-sign defenses to the INNER action a
 * `safeTxOrigin` OUTER tx authorizes (issue #761). Without this, block 4 waved
 * the OUTER `approveHash`/`execTransaction` through on the stamp alone and never
 * looked at the inner call, so an inner `transfer(attacker, …)`, an inner native
 * `{to: attacker, value: balance, data: "0x"}` drain, or a DELEGATECALL takeover
 * rode through unexamined.
 *
 * The design intent (reviewer #761): gate the decoded inner action EXACTLY as a
 * direct `send_transaction` of that same call would be gated — same comparand
 * (the connected wallet), same buckets — NOT by forcing every inner recipient to
 * equal the Safe (the over-block a prior revision shipped, which refused a
 * legitimate `transfer(vendor)` or an `Aave withdraw(..., to=your wallet)`).
 *
 * Five defenses:
 *  (0) FAIL CLOSED on an inner body we cannot resolve. `resolveSafeInnerAction`
 *      returns undefined for an `approveHash` whose SafeTx body is NOT in this
 *      server's custody — an externally-proposed tx (`prepare_safe_tx_approve`)
 *      or an expired cache entry. We cannot inspect what we cannot decode, so
 *      co-signing it blind is exactly how a malicious externally-proposed Safe
 *      tx drains a co-signer. Refuse (a prior revision accepted it — reviewer
 *      fail-open finding).
 *  (1) A missing OUTER `from` refuses — the inner recipient gate must anchor to
 *      the connected wallet, and there is none to check against.
 *  (2) DELEGATECALL (`operation === 1`) is refused unless the user affirmatively
 *      opted in at propose time (the non-forgeable `acknowledgedSafeDelegateCall`
 *      stamp). It runs the inner target in the Safe's own storage context and can
 *      rewrite the Safe's owner set — a full takeover.
 *  (3) NATIVE-VALUE gate (reviewer BLOCKING finding). A pure native send
 *      (`value > 0`, empty `data`) is inspected by NO calldata-based check —
 *      `assertTransactionSafe` block 1 returns on empty data and
 *      `assertRecipientsAuthorized` early-returns on an unrecognized (null)
 *      dest — so its recipient is otherwise ungated. Allow it ONLY to the
 *      connected wallet, back to the Safe itself, or to a recognized protocol
 *      destination; any other native recipient refuses.
 *  (4) The direct-call block-level defenses (`assertTransactionSafe`) + the
 *      recipient/authority seam (`assertRecipientsAuthorized`) re-run against the
 *      inner call, UNSTAMPED and resolved against the connected wallet — the
 *      identical treatment a direct send of the inner call receives. So a
 *      protocol recipient-bucket arg (`Aave withdraw.to`, swap `recipient`, …)
 *      pointing anywhere but your wallet refuses (the #757 drain shape), while a
 *      user-directed `transfer.to` passes exactly as a direct transfer does — its
 *      real recipient is surfaced to the user by `describeSafeTxBody`'s #761
 *      inner-target line, the same on-device review a direct send relies on.
 */
async function assertSafeInnerActionSafe(tx: UnsignedTx): Promise<void> {
  const inner = resolveSafeInnerAction(tx);

  // (0) FAIL CLOSED — inner body not in our custody, so it cannot be decoded and
  //     checked. Refusing to co-sign an unverifiable inner action.
  if (!inner) {
    throw new Error(
      `Pre-sign check: refusing a Safe approveHash whose inner SafeTx body is not in this ` +
        `server's custody — it was proposed elsewhere (or its cache entry expired), so the inner ` +
        `action it authorizes cannot be decoded and gated. Co-signing an unverifiable inner action ` +
        `is exactly how a malicious externally-proposed Safe tx drains a co-signer (#761). ` +
        `Re-propose it through prepare_safe_tx_propose so the body is bound to the hash, or approve ` +
        `it from the Safe web UI where you can read the decoded action before signing.`
    );
  }

  // (1) The connected wallet (the Safe owner submitting this approveHash /
  //     execTransaction) is the OUTER `tx.from` — the SAME comparand a DIRECT
  //     call's recipient gate uses (design #759 D4), validated against the
  //     connected WalletConnect account set by `enforceEvmRecipientAuthorization`
  //     (which always runs after `assertTransactionSafe` in `runEvmPreSignGuards`).
  //     A missing `from` fails closed here, mirroring that gate's D1 branch.
  if (!tx.from) {
    throw new Error(
      `Pre-sign check: refusing a Safe-origin transaction with no 'from' account — the inner-action ` +
        `recipient gate must anchor to your connected wallet, and there is none to check against. ` +
        `Re-prepare the Safe tx with the sending owner set.`
    );
  }
  const connectedWallet = tx.from as `0x${string}`;
  const safeAddress = tx.to;

  // (2) DELEGATECALL — a full-takeover primitive; loud explicit opt-in only.
  if (inner.operation === 1 && tx.acknowledgedSafeDelegateCall !== true) {
    throw new Error(
      `Pre-sign check: refusing a Safe transaction whose inner operation is DELEGATECALL ` +
        `(operation=1). DELEGATECALL runs ${inner.to} in your Safe's own storage context and can ` +
        `rewrite the Safe's owner set — a full takeover of the Safe. If you truly intend a ` +
        `DELEGATECALL, re-propose with the explicit acknowledgeSafeDelegateCall opt-in (surface ` +
        `the trade-off to the user first), or perform it from the Safe web UI directly.`
    );
  }

  const innerDest = await classifyDestination(tx.chain, inner.to);

  // (3) NATIVE-VALUE gate. A pure native send's recipient is gated nowhere else.
  if (isEmptyCalldata(inner.data) && BigInt(inner.value || "0") > 0n) {
    const authorized =
      addrEq(inner.to, connectedWallet) ||
      addrEq(inner.to, safeAddress) ||
      innerDest !== null;
    if (!authorized) {
      throw new Error(
        `Pre-sign check: refusing a Safe inner NATIVE transfer of ${inner.value} wei to ` +
          `${inner.to} — a plain native send (no calldata) carries its recipient in a field no ` +
          `other pre-sign check inspects, and ${inner.to} is neither your connected wallet ` +
          `(${connectedWallet}), the Safe itself, nor a recognized protocol destination. An ` +
          `unrecognized native recipient behind an approveHash/execTransaction is exactly the ` +
          `#761 drain shape. Move it from the Safe web UI if you truly intend this recipient.`
      );
    }
  }

  const innerTx: UnsignedTx = {
    chain: tx.chain,
    to: inner.to,
    data: inner.data,
    value: inner.value,
    from: connectedWallet,
    description: `Safe inner action of: ${tx.description}`,
  };

  // (4) Direct-call block-level defenses against the inner call. No safeTxOrigin
  //     stamp on the inner tx, so an unknown inner destination with calldata is
  //     refused (block 4) rather than waved through a second time.
  await assertTransactionSafe(innerTx);

  // (4) Recipient/authority seam — the SAME call a direct send makes (design
  //     #759 D2/D3/D7): UNSTAMPED, resolved against the connected wallet. Do NOT
  //     stamp it and do NOT pass the Safe as the comparand — that was the
  //     over-block the reviewer rejected. Protocol recipient-bucket args are
  //     hard-gated to your wallet; user-directed sends pass as a direct send does.
  assertRecipientsAuthorized(innerTx, innerDest, connectedWallet);
}
