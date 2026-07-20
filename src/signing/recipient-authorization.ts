/**
 * Recipient / authority authorization seam — the argument-level pre-sign gate
 * that closes incident #757 (and #760's recipient dimension via D8, DEFERRED).
 *
 * Design: docs/design/759-recipient-authorization-seam.md (#765 v6.1).
 *
 * `assertTransactionSafe` block 5 validates WHICH function is called (selector ∈
 * curated ABI) but never WHERE the value/authority goes. For a recognized
 * destination, block 4's argument-agnostic catch-all is skipped, so a
 * recipient-bearing call on a pinned protocol (`Aave withdraw(...,to)`, Morpho
 * `withdraw(...,receiver)`, Uniswap `exactInputSingle((...,recipient,...))`, …)
 * drains to an arbitrary address. This module decodes every recognized-
 * destination call and classifies EVERY address-typed argument path (including
 * nested tuples, arrays-of-tuples, and `multicall(bytes[])` sub-calls) into one
 * of four buckets; anything unclassified REFUSES.
 *
 * Why it does NOT live in `assertTransactionSafe`: that function only sees the
 * agent-supplied `tx.from`. This gate runs in `runEvmPreSignGuards` (and again
 * at send time), AFTER `tx.from` has been confirmed a member of the connected
 * WalletConnect account set (design D1). The caller passes that confirmed
 * `walletFrom` in.
 *
 * COMPLETENESS (D2-rot): `assertClassificationComplete()` runs at module load —
 * it recursively enumerates every address / opaque-bytes path on every
 * state-mutating function across every recognized ABI and THROWS if any path is
 * unclassified. "New recognized ABI silently ungated" becomes "won't boot".
 */
import {
  decodeFunctionData,
  getAddress,
  toFunctionSelector,
  type Abi,
  type AbiFunction,
  type AbiParameter,
} from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { aavePoolAbi } from "../abis/aave-pool.js";
import { cometAbi } from "../abis/compound-comet.js";
import { stETHAbi, lidoWithdrawalQueueAbi } from "../abis/lido.js";
import { eigenStrategyManagerAbi } from "../abis/eigenlayer-strategy-manager.js";
import { morphoBlueAbi } from "../abis/morpho-blue.js";
import { uniswapPositionManagerAbi } from "../abis/uniswap-position-manager.js";
import { swapRouter02Abi } from "../abis/uniswap-swap-router-02.js";
import { CONTRACTS } from "../config/contracts.js";
import type { SupportedChain, UnsignedTx } from "../types/index.js";
import {
  RECOGNIZED_ABIS_BY_KIND,
  acceptedSelectorSetForKind,
  type RecognizedAbiKind,
  type RecognizedDestination,
} from "./recognized-destinations.js";

/**
 * Total decoded sub-calls permitted across all `multicall` recursion depths
 * combined — a breadth bound, not a depth bound (design D7 property 4). The
 * live rebalance builder emits at most 3 legs (`decreaseLiquidity` + `collect` +
 * `burn`); a native-out swap emits 2 (`exactInputSingle` + `unwrapWETH9`). 24 is
 * generous headroom over any flow the MCP's own tools produce.
 */
export const SUB_CALL_BUDGET = 24;

/**
 * The four buckets (design D2) plus two opaque-bytes states (D2-rot). Every
 * address / bytes path on a recognized state-mutating function is exactly one:
 *
 *  - `non-recipient`  — cannot spend the caller's value to a third party and
 *                        cannot confer authority (token identity, venue/infra,
 *                        fee-routing, Aave `borrow.onBehalfOf`). PASS.
 *  - `recipient`      — protocol-embedded recipient the builder hardcodes to the
 *                        wallet; any other value is an anomaly. HARD-GATE
 *                        (wallet-only, D4). Non-bypassable by any ack (D1
 *                        monotonicity).
 *  - `authority`      — an authorization-conferring arg (ERC-20 `approve`
 *                        spender). Its live enforcement is PRE-EXISTING block 2;
 *                        this gate adds no second check (D6 — bucket 3 deferred),
 *                        it only registers the path so the enumerator is complete.
 *  - `user-directed`  — an address the USER (not the protocol) names — pass-
 *                        through governed by the resolver + on-device render,
 *                        CONDITIONED on the absence of the server
 *                        `acknowledgedNonProtocolTarget` stamp. A stamped call
 *                        (custom-call-reachable) is evaluated HARD-GATED instead
 *                        (design D3 — closes the #757 shape on these protocols).
 *  - `bytes-require-empty` — an opaque `bytes` payload with no decoder (Morpho
 *                        callback `data`). REFUSE unless zero-length.
 *  - `bytes-recurse`  — `multicall(bytes[])`. Decode every leg and apply the
 *                        whole mechanism per-leg (D7).
 */
export type Bucket =
  | "non-recipient"
  | "recipient"
  | "authority"
  | "user-directed"
  | "bytes-require-empty"
  | "bytes-recurse";

/**
 * Per-function classification of every address / opaque-bytes path. Keyed by
 * function NAME within each ABI (names are unique per curated ABI — no
 * overloads); the loader resolves each to its 4-byte selector so the runtime
 * lookup is `${selector}|${path}` and cannot collide across ABIs that share a
 * selector (ERC-20 `approve`/`transfer`, `multicall`). Paths are dotted names
 * matching the ABI component names; array indices are stripped before lookup.
 *
 * Every entry carries the design's per-entry evidence in a comment so a future
 * ABI addition is forced to state WHY each of its address args is safe, rather
 * than invent an ad-hoc bucket (the D2-rot boot enumeration refuses to boot
 * until every path here is present).
 */
interface FnSpec {
  abi: Abi;
  /** Function name (unique within `abi`). */
  fn: string;
  /** path (dotted) → bucket, for every address / opaque-bytes leaf. */
  paths: Record<string, Bucket>;
}

const SPEC: readonly FnSpec[] = [
  // ── ERC-20 (unioned into every token kind) ──────────────────────────────
  // `approve.spender` is authority (ERC-20 approve) — enforced by PRE-EXISTING
  // block 2's spender allowlist, NOT a second predicate here (D6).
  { abi: erc20Abi, fn: "approve", paths: { spender: "authority" } },
  // `transfer.to` is the canonical user-directed send (prepare_token_send exists
  // to let the user name a fresh address) — bucket 4, stamp-conditioned (D3).
  { abi: erc20Abi, fn: "transfer", paths: { to: "user-directed" } },

  // ── Lido ────────────────────────────────────────────────────────────────
  // `submit.referral` — fee-routing address; the referral fee is paid from the
  // protocol's own emission, never redirected from the caller's principal (D2 b1).
  { abi: stETHAbi, fn: "submit", paths: { referral: "non-recipient" } },
  // `requestWithdrawals.owner` — protocol-embedded; the builder hardcodes wallet.
  { abi: lidoWithdrawalQueueAbi, fn: "requestWithdrawals", paths: { owner: "recipient" } },

  // ── Aave V3 Pool ──────────────────────────────────────────────────────────
  // `asset` is the token being acted on, never a beneficiary (D2 b1). `to`/
  // `onBehalfOf` semantics per D2/D3.
  { abi: aavePoolAbi, fn: "supply", paths: { asset: "non-recipient", onBehalfOf: "recipient" } },
  { abi: aavePoolAbi, fn: "withdraw", paths: { asset: "non-recipient", to: "recipient" } },
  // `borrow.onBehalfOf` passes by DIRECTION — borrowed asset always transfers to
  // msg.sender; onBehalfOf only designates whose debt is charged, and charging a
  // third party needs their own prior credit-delegation approval (D2 b1).
  { abi: aavePoolAbi, fn: "borrow", paths: { asset: "non-recipient", onBehalfOf: "non-recipient" } },
  // `repay.onBehalfOf` is the MIRROR of borrow — spends the CALLER's tokens to
  // reduce a THIRD PARTY's debt; hard-gated (D3), moved out of bucket 1.
  { abi: aavePoolAbi, fn: "repay", paths: { asset: "non-recipient", onBehalfOf: "recipient" } },

  // ── Compound V3 Comet ─────────────────────────────────────────────────────
  // `asset` token-identity (Comet was absent from prior D2/D3 — closed here).
  { abi: cometAbi, fn: "supply", paths: { asset: "non-recipient" } },
  { abi: cometAbi, fn: "withdraw", paths: { asset: "non-recipient" } },

  // ── Morpho Blue ───────────────────────────────────────────────────────────
  // marketParams.{loanToken,collateralToken,oracle,irm} — venue/infra addresses
  // fixed by the market's own identity, never a redirectable beneficiary (D2 b1;
  // `oracle`/`irm` are the easy-to-miss half of the tuple). `onBehalf`/`receiver`
  // hard-gated (D3). `.data` is an opaque borrower-callback payload → REQUIRE-EMPTY.
  {
    abi: morphoBlueAbi,
    fn: "supply",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      data: "bytes-require-empty",
    },
  },
  {
    abi: morphoBlueAbi,
    fn: "withdraw",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      receiver: "recipient",
    },
  },
  {
    abi: morphoBlueAbi,
    fn: "borrow",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      receiver: "recipient",
    },
  },
  {
    abi: morphoBlueAbi,
    fn: "repay",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      data: "bytes-require-empty",
    },
  },
  {
    abi: morphoBlueAbi,
    fn: "supplyCollateral",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      data: "bytes-require-empty",
    },
  },
  {
    abi: morphoBlueAbi,
    fn: "withdrawCollateral",
    paths: {
      "marketParams.loanToken": "non-recipient",
      "marketParams.collateralToken": "non-recipient",
      "marketParams.oracle": "non-recipient",
      "marketParams.irm": "non-recipient",
      onBehalf: "recipient",
      receiver: "recipient",
    },
  },

  // ── EigenLayer StrategyManager ────────────────────────────────────────────
  // `strategy` — named-exemption on an UNVERIFIED premise (§7 residual): every
  // legitimate deposit sets it to a venue, so hard-gating would refuse them all;
  // whether an attacker `strategy` drains depends on EigenLayer's own whitelist,
  // external behavior with no repo artifact. `token` — deposited token identity.
  { abi: eigenStrategyManagerAbi, fn: "depositIntoStrategy", paths: { strategy: "non-recipient", token: "non-recipient" } },

  // ── Uniswap V3 NonfungiblePositionManager ─────────────────────────────────
  // `params.token0`/`token1` token-identity. `mint`/`collect.recipient` are a
  // swap-output recipient — the same class as `swapRouter02.recipient`, which is
  // already hard-gated — so they are HARD-GATE too (wallet-only, D4), not bucket 4:
  // the bucket-4 "user sees it on-device before signing" premise is unverifiable,
  // and an unstamped prepare_uniswap_v3_mint/collect(recipient=ATTACKER) otherwise
  // passes (the #757 drain shape). Legit builds set recipient = wallet and clear
  // the gate; a genuinely different recipient goes through Ledger Live directly.
  // `multicall` → per-leg recursion (D7).
  {
    abi: uniswapPositionManagerAbi,
    fn: "mint",
    paths: { "params.token0": "non-recipient", "params.token1": "non-recipient", "params.recipient": "recipient" },
  },
  { abi: uniswapPositionManagerAbi, fn: "collect", paths: { "params.recipient": "recipient" } },
  { abi: uniswapPositionManagerAbi, fn: "multicall", paths: { data: "bytes-recurse" } },

  // ── Uniswap V3 SwapRouter02 ───────────────────────────────────────────────
  // swap `recipient` is protocol-embedded (the swap builder hardcodes wallet or
  // a router-self intermediate paired with a wallet-only unwrap) → hard-gate
  // (D3/D7). `unwrapWETH9.recipient` hard-gate. `multicall` → per-leg recursion.
  {
    abi: swapRouter02Abi,
    fn: "exactInputSingle",
    paths: { "params.tokenIn": "non-recipient", "params.tokenOut": "non-recipient", "params.recipient": "recipient" },
  },
  {
    abi: swapRouter02Abi,
    fn: "exactOutputSingle",
    paths: { "params.tokenIn": "non-recipient", "params.tokenOut": "non-recipient", "params.recipient": "recipient" },
  },
  { abi: swapRouter02Abi, fn: "unwrapWETH9", paths: { recipient: "recipient" } },
  { abi: swapRouter02Abi, fn: "multicall", paths: { data: "bytes-recurse" } },
];

/**
 * `${selector}|${dottedPath}` → Bucket. The per-ADDRESS bucket source of truth,
 * single-sourced from SPEC — the curated list of every recognized function that
 * carries an address/opaque-bytes leaf (each annotated with the design's
 * per-entry evidence). A recognized function with NO such leaf is deliberately
 * absent from SPEC: it has no recipient/authority dimension to classify.
 */
const CLASSIFICATION: Map<string, Bucket> = new Map();
/**
 * selector → the AbiFunction it decodes against. Populated by
 * `buildFnBySelector()` at module load from the FULL `RECOGNIZED_ABIS_BY_KIND`
 * state-mutating set — NOT just SPEC's address-bearing subset. A recognized
 * function with no address/bytes leaf (WETH.withdraw, wstETH.wrap/unwrap,
 * rETH.burn, RocketDepositPool.deposit, Uniswap increase/decrease/burn) MUST
 * resolve here so `gateCall`/`decodeLeg` DECODE it and find it carries nothing
 * to gate — otherwise its selector reads as "unknown" and is refused,
 * over-blocking a flow block 5 already accepts (#757 over-block regression). A
 * selector ABSENT here is genuinely unknown (on NO recognized ABI) and stays a
 * fail-closed REFUSE (design D7 property 3), matching block 5's own rejection.
 */
const FN_BY_SELECTOR: Map<string, AbiFunction> = new Map();

function fnItem(abi: Abi, name: string): AbiFunction {
  const item = abi.find(
    (i): i is AbiFunction => i.type === "function" && i.name === name,
  );
  if (!item) throw new Error(`recipient-authorization: ABI has no function ${name}`);
  return item;
}

// CLASSIFICATION (per-address buckets) is single-sourced from SPEC.
for (const entry of SPEC) {
  const selector = toFunctionSelector(fnItem(entry.abi, entry.fn)).toLowerCase();
  for (const [path, bucket] of Object.entries(entry.paths)) {
    CLASSIFICATION.set(`${selector}|${path}`, bucket);
  }
}

// ── Argument-path walker ────────────────────────────────────────────────────

interface Leaf {
  /** Dotted path with array indices (`[0]`) where present. */
  path: string;
  kind: "address" | "bytes" | "recurse";
  /** Decoded value (runtime); undefined at boot enumeration. */
  value?: unknown;
}

const STATE_MUTATING = new Set(["nonpayable", "payable"]);

/** Strip array indices so a runtime path matches its SPEC key. */
function normalizePath(path: string): string {
  return path.replace(/\[\d+\]/g, "");
}

function walkParam(param: AbiParameter, value: unknown, path: string, out: Leaf[]): void {
  const t = param.type;
  if (t === "address") {
    out.push({ path, kind: "address", value });
    return;
  }
  if (t === "address[]") {
    if (Array.isArray(value)) {
      value.forEach((el, idx) => out.push({ path: `${path}[${idx}]`, kind: "address", value: el }));
    } else {
      out.push({ path, kind: "address", value: undefined });
    }
    return;
  }
  if (t === "bytes" || t === "bytes32") {
    out.push({ path, kind: "bytes", value });
    return;
  }
  if (t === "bytes[]") {
    out.push({ path, kind: "recurse", value });
    return;
  }
  if (t === "tuple") {
    const comps = (param as { components?: readonly AbiParameter[] }).components ?? [];
    for (const c of comps) {
      const cv =
        value && typeof value === "object" ? (value as Record<string, unknown>)[c.name ?? ""] : undefined;
      walkParam(c, cv, `${path}.${c.name}`, out);
    }
    return;
  }
  if (t === "tuple[]") {
    const comps = (param as { components?: readonly AbiParameter[] }).components ?? [];
    if (Array.isArray(value)) {
      value.forEach((el, idx) => {
        for (const c of comps) {
          const cv = el && typeof el === "object" ? (el as Record<string, unknown>)[c.name ?? ""] : undefined;
          walkParam(c, cv, `${path}[${idx}].${c.name}`, out);
        }
      });
    } else {
      for (const c of comps) walkParam(c, undefined, `${path}.${c.name}`, out);
    }
    return;
  }
  // scalar non-address (uint/int/bool/string/…) — not an authorization surface.
}

/** Every address / opaque-bytes leaf of a function's inputs (with values if given). */
function walkFunction(item: AbiFunction, args?: readonly unknown[]): Leaf[] {
  const out: Leaf[] = [];
  item.inputs.forEach((inp, i) => {
    walkParam(inp, args ? args[i] : undefined, inp.name || `arg${i}`, out);
  });
  return out;
}

/**
 * Populate `FN_BY_SELECTOR` with EVERY recognized state-mutating selector across
 * every recognized ABI — the same per-kind domain the D2-rot enumeration walks
 * and `acceptedSelectorSetForKind` (block 5) accepts, single-sourced from
 * `RECOGNIZED_ABIS_BY_KIND`. This includes recognized functions with no
 * address/bytes argument, so `gateCall`/`decodeLeg` can decode them and find
 * they carry nothing to gate rather than refusing their selector as "unknown".
 * A selector left ABSENT here is one on no recognized ABI → genuinely unknown →
 * fail-closed REFUSE (design D7 property 3).
 */
function buildFnBySelector(): void {
  for (const kind of Object.keys(RECOGNIZED_ABIS_BY_KIND) as RecognizedAbiKind[]) {
    for (const abi of RECOGNIZED_ABIS_BY_KIND[kind]) {
      for (const item of abi) {
        if (item.type !== "function") continue;
        if (!STATE_MUTATING.has(item.stateMutability)) continue; // exclude view/pure
        const selector = toFunctionSelector(item).toLowerCase();
        // First writer wins; recognized ABIs that share a selector (ERC-20
        // approve/transfer unioned into every token kind, multicall(bytes[]) on
        // both Uniswap ABIs) share its signature, so the decode is identical.
        if (!FN_BY_SELECTOR.has(selector)) FN_BY_SELECTOR.set(selector, item);
      }
    }
  }
}

// ── D2-rot: module-load anti-rot enumeration ────────────────────────────────

/**
 * Assert every address / opaque-bytes path on every state-mutating function
 * across every recognized ABI is classified. Throws (fails boot / a unit test
 * RED) on any unclassified path or any domain divergence. Called once at module
 * load; also exported for a dedicated boot-falsifier test.
 */
export function assertClassificationComplete(): void {
  // The enumerator domain and block 5's accepted-selector set are the SAME set
  // by construction — block 5 calls `acceptedSelectorSetForKind(kind)`, and both
  // it and this walk read `RECOGNIZED_ABIS_BY_KIND[kind]`, the design's single
  // source. There is therefore no independent comparand to check them against
  // (a prior "domain-divergence" sub-check compared the map against a re-walk of
  // the same map — tautological, could never fire; removed). The genuine anti-rot
  // is the unclassified-path throw below: it walks every state-mutating function
  // block 5 accepts and refuses to boot if any address/opaque-bytes leaf lacks a
  // bucket — turning "new recognized ABI silently ungated" into "won't boot".
  const kinds = Object.keys(RECOGNIZED_ABIS_BY_KIND) as RecognizedAbiKind[];
  for (const kind of kinds) {
    for (const abi of RECOGNIZED_ABIS_BY_KIND[kind]) {
      for (const item of abi) {
        if (item.type !== "function") continue;
        if (!STATE_MUTATING.has(item.stateMutability)) continue; // exclude view/pure
        const selector = toFunctionSelector(item).toLowerCase();
        for (const leaf of walkFunction(item)) {
          const key = `${selector}|${normalizePath(leaf.path)}`;
          if (!CLASSIFICATION.has(key)) {
            throw new Error(
              `recipient-authorization: UNCLASSIFIED ${leaf.kind} path '${leaf.path}' on ` +
                `${item.name}() (kind '${kind}', selector ${selector}). Every address / opaque-bytes ` +
                `argument on a recognized state-mutating function must be classified into a bucket ` +
                `before it can ship — refusing to boot (design #759 D2-rot). Add it to SPEC with ` +
                `per-entry evidence for its bucket.`,
            );
          }
        }
      }
    }
  }
}

// ── Runtime gate ─────────────────────────────────────────────────────────────

class RefusalError extends Error {}

function addrEq(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return false;
  }
}

function isEmptyBytes(v: unknown): boolean {
  return v === "0x" || v === "0x0" || v === undefined || v === null;
}

interface GateCtx {
  chain: SupportedChain;
  /** The recognized-destination kind of the OUTER tx (drives sub-call selector validation). */
  kind: RecognizedAbiKind;
  /** The tx.to address (== the router for a SwapRouter02 multicall). */
  to: `0x${string}`;
  /** The connected-account-verified wallet (design D1/D4). */
  walletFrom: `0x${string}`;
  /** Whether the tx carries the server `acknowledgedNonProtocolTarget` stamp (D3). */
  stamped: boolean;
  /** Running total of decoded sub-calls across recursion depth (D7 breadth budget). */
  budget: { count: number };
}

/** Decode + classify one call's arguments. Throws `RefusalError` on any unsafe arg. */
function gateCall(data: `0x${string}`, ctx: GateCtx): void {
  if (!data || data.length < 10) return; // no selector — nothing to classify here
  const selector = data.slice(0, 10).toLowerCase();
  const item = FN_BY_SELECTOR.get(selector);
  if (!item) {
    // Genuinely unknown selector — on NO recognized ABI (every recognized
    // state-mutating function, address-bearing OR not, is in FN_BY_SELECTOR).
    // Block 5 already refuses an unknown selector on the OUTER call; reaching
    // here also covers a multicall sub-call outside the ABI — fail closed
    // (D7 property 3), matching block 5's own rejection.
    throw new RefusalError(
      `Pre-sign check: selector ${selector} is not a recognized function on ${ctx.kind}. ` +
        `Refusing to sign a call the destination's ABI does not define.`,
    );
  }
  let decoded: { args: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: [item] as Abi, data }) as { args: readonly unknown[] };
  } catch {
    // D2-rot: a top-level (or sub-call) decode throw is a REFUSE, mirroring the
    // approve-decode catch already in assertTransactionSafe.
    throw new RefusalError(
      `Pre-sign check: could not decode ${item.name}() calldata on ${ctx.to} (${ctx.chain}). ` +
        `Refusing to sign an argument set the recognized ABI cannot parse.`,
    );
  }
  const leaves = walkFunction(item, decoded.args);
  const isSwapMulticall = ctx.kind === "uniswap-v3-swap-router";
  for (const leaf of leaves) {
    const bucket = CLASSIFICATION.get(`${selector}|${normalizePath(leaf.path)}`);
    if (!bucket) {
      // Belt-and-suspenders: boot enumeration proves this cannot happen for a
      // recognized ABI, but a decoded value at an unenumerated path fails closed.
      throw new RefusalError(
        `Pre-sign check: unclassified argument '${leaf.path}' on ${item.name}() — refusing to sign.`,
      );
    }
    switch (bucket) {
      case "non-recipient":
      case "authority":
        // authority (ERC-20 approve spender) is enforced by block 2, not here (D6).
        break;
      case "recipient":
        gateHardRecipient(leaf, item.name ?? selector, ctx);
        break;
      case "user-directed":
        // Bucket 4: pass-through UNLESS the server provenance stamp is present,
        // in which case it is evaluated hard-gated (design D3 — closes the #757
        // shape reached via prepare_custom_call).
        if (ctx.stamped) gateHardRecipient(leaf, item.name ?? selector, ctx);
        break;
      case "bytes-require-empty":
        if (!isEmptyBytes(leaf.value)) {
          throw new RefusalError(
            `Pre-sign check: refusing ${item.name}() with a non-empty opaque '${leaf.path}' payload ` +
              `on ${ctx.to} — a recipient can be smuggled inside a bytes callback this gate cannot ` +
              `decode, so a non-empty value is refused (design #759 D2-rot REQUIRE-EMPTY).`,
          );
        }
        break;
      case "bytes-recurse":
        gateMulticall(leaf.value, isSwapMulticall, ctx);
        break;
    }
  }
}

/** Hard wallet-only gate (design D4 — normalize BOTH sides, one-sided fails closed). */
function gateHardRecipient(leaf: Leaf, fnName: string, ctx: GateCtx): void {
  if (!addrEq(leaf.value, ctx.walletFrom)) {
    throw new RefusalError(
      `Pre-sign check: refusing ${fnName}() — the '${leaf.path}' recipient/authority argument ` +
        `(${String(leaf.value)}) is not your connected wallet (${ctx.walletFrom}). A recognized ` +
        `protocol call that routes value or authority to any address other than your own wallet is ` +
        `exactly the #757 drain shape. Send from Ledger Live directly if you truly intend a ` +
        `different recipient.`,
    );
  }
}

/** D7 — decode a `multicall(bytes[])` and apply the whole gate to every leg. */
function gateMulticall(value: unknown, isSwapMulticall: boolean, ctx: GateCtx): void {
  if (!Array.isArray(value)) {
    throw new RefusalError(
      `Pre-sign check: refusing multicall on ${ctx.to} — its bytes[] payload did not decode to an ` +
        `array of sub-calls.`,
    );
  }
  const subcalls = value as `0x${string}`[];
  // Decode every leg once up front so the router-self coexistence check (D7
  // property 2) can see sibling legs and their order.
  const legs = subcalls.map((data) => decodeLeg(data, ctx));

  for (let i = 0; i < legs.length; i++) {
    const leg = legs[i];
    // Router-self exception (D7 property 2), swap-class only: a swap leg whose
    // `recipient == the router itself` is permitted ONLY when BOTH hold —
    // (a) that leg's tokenOut == WETH, AND (b) a LATER unwrapWETH9(amountMinimum>0,
    // recipient==wallet) sibling appears after it. refundETH() does NOT satisfy (b).
    if (isSwapMulticall && (leg.name === "exactInputSingle" || leg.name === "exactOutputSingle")) {
      const params = (leg.decoded.args[0] ?? {}) as Record<string, unknown>;
      const recipient = params.recipient;
      if (addrEq(recipient, ctx.to)) {
        const tokenOutIsWeth = addrEq(params.tokenOut, wethAddress(ctx.chain));
        const hasLaterUnwrap = legs
          .slice(i + 1)
          .some(
            (l) =>
              l.name === "unwrapWETH9" &&
              typeof l.decoded.args[0] === "bigint" &&
              (l.decoded.args[0] as bigint) > 0n &&
              addrEq(l.decoded.args[1], ctx.walletFrom),
          );
        if (!(tokenOutIsWeth && hasLaterUnwrap)) {
          throw new RefusalError(
            `Pre-sign check: refusing multicall — a swap leg sends its output to the router itself ` +
              `without a following wallet-only unwrapWETH9(amountMinimum>0) that releases it back to ` +
              `you (design #759 D7). A router-self recipient is only legitimate as the WETH ` +
              `intermediate before an unwrap.`,
          );
        }
        // This leg's router-self recipient is cleared by the coexistence check.
        // Its only other address args (params.tokenIn / params.tokenOut) are
        // bucket-1 non-recipient, so nothing further to gate on this leg.
        continue;
      }
    }
    // Universal per-leg: apply the whole gate (recipient hard-gate, bucket-4
    // stamp-threading, nested multicall, decode-throw) to this leg.
    gateCall(subcalls[i], ctx);
  }
}

interface DecodedLeg {
  name: string;
  decoded: { args: readonly unknown[] };
}

function decodeLeg(data: `0x${string}`, ctx: GateCtx): DecodedLeg {
  ctx.budget.count++;
  if (ctx.budget.count > SUB_CALL_BUDGET) {
    throw new RefusalError(
      `Pre-sign check: refusing multicall — decoded sub-call count exceeds the ${SUB_CALL_BUDGET} ` +
        `budget (design #759 D7 breadth bound). This is far beyond any flow the MCP's own tools ` +
        `produce.`,
    );
  }
  if (!data || data.length < 10) {
    throw new RefusalError(`Pre-sign check: refusing multicall — a sub-call carries no selector.`);
  }
  const selector = data.slice(0, 10).toLowerCase();
  const accepted = acceptedSelectorSetForKind(ctx.kind);
  if (accepted && !accepted.has(selector)) {
    throw new RefusalError(
      `Pre-sign check: refusing multicall — sub-call selector ${selector} is not a function on ${ctx.kind}'s ` +
        `ABI (design #759 D7 property 3, fail-closed on unrecognized sub-call selectors).`,
    );
  }
  const item = FN_BY_SELECTOR.get(selector);
  if (!item) {
    throw new RefusalError(
      `Pre-sign check: refusing multicall — sub-call selector ${selector} has no classified function.`,
    );
  }
  try {
    return { name: item.name ?? selector, decoded: decodeFunctionData({ abi: [item] as Abi, data }) as { args: readonly unknown[] } };
  } catch {
    throw new RefusalError(
      `Pre-sign check: refusing multicall — a sub-call's ${item.name}() calldata did not decode.`,
    );
  }
}

function wethAddress(chain: SupportedChain): `0x${string}` {
  const w = (CONTRACTS[chain].tokens as { WETH?: string } | undefined)?.WETH;
  return (w ?? "0x0000000000000000000000000000000000000000") as `0x${string}`;
}

/**
 * The runtime entry point (design D2/D3/D7). Decodes the recognized-destination
 * call and refuses if any address/authority argument routes value away from the
 * connected wallet without qualifying for a pass-through bucket.
 *
 *  - `dest === null` (unrecognized) → defer to block 4's catch-all (D9); no gate.
 *  - `dest.kind === "lifi-diamond"` → DEFERRED to D8 (this PR does not touch it).
 *  - native send / no selector → nothing to classify.
 *
 * @param walletFrom the connected-account-verified sender (design D1); the
 *        caller must run the fail-closed account-set precondition first.
 */
export function assertRecipientsAuthorized(
  tx: UnsignedTx,
  dest: RecognizedDestination | null,
  walletFrom: `0x${string}`,
): void {
  if (!dest) return;
  if (dest.kind === "lifi-diamond") return; // D8 — deferred; do not touch the allowedAbi:null path.
  const kind = dest.kind as RecognizedAbiKind;
  const data = tx.data as `0x${string}`;
  if (!data || data === "0x" || data === "0x0" || data === "0x00" || data.length < 10) return;
  try {
    gateCall(data, {
      chain: tx.chain,
      kind,
      to: tx.to,
      walletFrom,
      stamped: tx.acknowledgedNonProtocolTarget === true,
      budget: { count: 0 },
    });
  } catch (e) {
    if (e instanceof RefusalError) throw new Error(e.message);
    throw e;
  }
}

// ── Test-support enumeration helpers (also used by the boot falsifier) ───────

/** Every classified address / opaque-bytes path across the recognized ABIs. */
export function enumerateRecognizedAddressPaths(): Array<{
  kind: RecognizedAbiKind;
  selector: string;
  fn: string;
  path: string;
  leafKind: Leaf["kind"];
  bucket: Bucket | undefined;
}> {
  const out: Array<{
    kind: RecognizedAbiKind;
    selector: string;
    fn: string;
    path: string;
    leafKind: Leaf["kind"];
    bucket: Bucket | undefined;
  }> = [];
  for (const kind of Object.keys(RECOGNIZED_ABIS_BY_KIND) as RecognizedAbiKind[]) {
    for (const abi of RECOGNIZED_ABIS_BY_KIND[kind]) {
      for (const item of abi) {
        if (item.type !== "function" || !STATE_MUTATING.has(item.stateMutability)) continue;
        const selector = toFunctionSelector(item).toLowerCase();
        for (const leaf of walkFunction(item)) {
          out.push({
            kind,
            selector,
            fn: item.name ?? "",
            path: leaf.path,
            leafKind: leaf.kind,
            bucket: CLASSIFICATION.get(`${selector}|${normalizePath(leaf.path)}`),
          });
        }
      }
    }
  }
  return out;
}

/**
 * The address / opaque-bytes paths on `abis`' state-mutating functions that are
 * NOT classified. Empty for the recognized set (proven at boot); non-empty for a
 * synthetic ABI carrying an unmapped address arg — the falsifier that the D2-rot
 * detector actually detects, rather than silently passing.
 */
export function findUnclassifiedPaths(abis: readonly Abi[]): string[] {
  const out: string[] = [];
  for (const abi of abis) {
    for (const item of abi) {
      if (item.type !== "function" || !STATE_MUTATING.has(item.stateMutability)) continue;
      const selector = toFunctionSelector(item).toLowerCase();
      for (const leaf of walkFunction(item)) {
        if (!CLASSIFICATION.has(`${selector}|${normalizePath(leaf.path)}`)) {
          out.push(`${item.name}.${leaf.path}`);
        }
      }
    }
  }
  return out;
}

// Build the recognized-selector decode table, then run the completeness
// enumeration — both single-sourced from RECOGNIZED_ABIS_BY_KIND. "New
// recognized ABI silently ungated" becomes "won't boot" (design #759 D2-rot).
buildFnBySelector();
assertClassificationComplete();
