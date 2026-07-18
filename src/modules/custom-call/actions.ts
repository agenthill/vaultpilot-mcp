import { encodeFunctionData, type Abi } from "viem";
import { resolveContractAbi } from "../../shared/contract-abi.js";
import { lookupKnownSpender } from "../../security/known-spenders.js";
import { applyCustomCallClassifier } from "../../security/custom-call-classifier.js";
import type { SupportedChain, UnsignedTx } from "../../types/index.js";
import { assertNotUnlimitedBurnApproval } from "../shared/approval.js";

export interface BuildCustomCallParams {
  wallet: `0x${string}`;
  chain: SupportedChain;
  contract: `0x${string}`;
  fn: string;
  args: readonly unknown[];
  value: string;
  abi?: readonly unknown[];
  acknowledgeBurnApproval?: boolean;
  acknowledgeRawApproveBypass?: boolean;
  acknowledgeKnownExfilPattern?: boolean;
}

const APPROVE_SELECTOR = "0x095ea7b3";

// Issue #556 — when prepare_custom_call is invoked with an `approve(address,uint256)`
// selector, refuse and route the agent to `prepare_token_approve` (or a
// protocol-specific `prepare_*` when the spender is a known protocol contract).
// The dedicated tools carry burn-address gates, friendly spender labels, and the
// structured (token, spender, amount) interface that custom_call's raw-args path
// erases. `acknowledgeRawApproveBypass` is the escape hatch for the rare
// non-ERC-20 contract that exposes its own `approve(address,uint256)` for an
// unrelated purpose.
function assertApproveRoutedToDedicatedTool(
  data: `0x${string}`,
  spender: string | undefined,
  knownProtocolLabel: string | undefined,
  ack: boolean | undefined,
): void {
  if (ack === true) return;
  if (!data.toLowerCase().startsWith(APPROVE_SELECTOR)) return;
  const spenderHint = spender ? ` (spender=${spender})` : "";
  if (knownProtocolLabel) {
    throw new Error(
      `APPROVE_ROUTE_VIA_DEDICATED_TOOL: refusing to encode approve(...) via ` +
        `prepare_custom_call${spenderHint}. The spender resolves to ${knownProtocolLabel} — use the ` +
        `protocol-specific prepare_* (e.g. prepare_aave_supply / prepare_compound_supply / ` +
        `prepare_lido_stake) which bundles approve+action and applies protocol-tier safety ` +
        `checks. If you genuinely need a raw approve through this escape hatch, retry with ` +
        `\`acknowledgeRawApproveBypass: true\`.`,
    );
  }
  throw new Error(
    `APPROVE_ROUTE_VIA_DEDICATED_TOOL: refusing to encode approve(...) via ` +
      `prepare_custom_call${spenderHint}. Use \`prepare_token_approve\` instead — the dedicated ` +
      `tool applies the burn-address gate, friendly spender labeling, and the structured ` +
      `(token, spender, amount) interface that this escape hatch loses. If you genuinely need ` +
      `a raw approve through this escape hatch (e.g. a non-ERC-20 contract that exposes ` +
      `\`approve(address,uint256)\` for an unrelated purpose), retry with ` +
      `\`acknowledgeRawApproveBypass: true\`.`,
  );
}

export async function buildCustomCall(p: BuildCustomCallParams): Promise<UnsignedTx> {
  const abi: Abi = p.abi
    ? (p.abi as Abi)
    : (await resolveContractAbi(p.contract, p.chain)).abi;

  let data: `0x${string}`;
  try {
    data = encodeFunctionData({
      abi,
      functionName: p.fn,
      args: p.args as readonly unknown[],
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(
      `Failed to encode calldata for ${p.fn} on ${p.contract} (${p.chain}): ${msg}. ` +
        `Check that \`fn\` matches an ABI entry (use the full signature like ` +
        `"schedule(address,uint256,bytes,bytes32,bytes32,uint256)" to disambiguate ` +
        `overloads) and that \`args\` types match the function's inputs in order.`,
    );
  }

  // value is a raw wei decimal string; reject anything that isn't.
  if (!/^\d+$/.test(p.value)) {
    throw new Error(
      `\`value\` must be a non-negative wei integer as a decimal string (e.g. "0" or "1000000000000000000" for 1 ETH). Got: ${p.value}`,
    );
  }

  // Issue #556 — refuse approve(...) via the escape hatch and route the
  // agent to the dedicated tool. Burn-address gate stays as defense in
  // depth on the override path (`acknowledgeRawApproveBypass: true`).
  if (data.toLowerCase().startsWith(APPROVE_SELECTOR)) {
    const spender = p.args.length > 0 ? String(p.args[0]) : undefined;
    let knownProtocolLabel: string | undefined;
    if (spender && /^0x[0-9a-fA-F]{40}$/.test(spender)) {
      knownProtocolLabel = lookupKnownSpender(p.chain, spender as `0x${string}`);
    }
    assertApproveRoutedToDedicatedTool(
      data,
      spender,
      knownProtocolLabel,
      p.acknowledgeRawApproveBypass,
    );
    if (p.args.length >= 2) {
      let amount: bigint | null = null;
      try {
        amount = BigInt(p.args[1] as string | number | bigint);
      } catch {
        amount = null;
      }
      if (amount !== null && spender) {
        assertNotUnlimitedBurnApproval(spender, amount, p.acknowledgeBurnApproval);
      }
    }
  }

  // Issue #652 — selector classifier for known value-exfil patterns
  // (transfer / transferFrom / NFT-transfer / setApprovalForAll). The
  // approve(...) selector is intentionally OUT of the classifier's
  // ruleset because the dedicated check above already gates it with
  // protocol-spender resolution. The classifier handles the OTHER
  // selectors that the user-side defenses (swiss-knife URL, on-device
  // blind-sign hash) can't meaningfully gate when the user has been
  // social-engineered into the call themselves.
  //
  // `transferFrom` with `from == wallet` is value-exfil via a
  // pre-existing approval and is refused outright with no bypass —
  // there's no legitimate flow where the user wants to pull their own
  // tokens through allowance-spending machinery (use prepare_token_send
  // instead, which doesn't require an approval).
  const isTransferFromCall = data.toLowerCase().startsWith("0x23b872dd");
  const transferFromSelfAsFrom =
    isTransferFromCall &&
    p.args.length >= 1 &&
    String(p.args[0] ?? "").toLowerCase() === p.wallet.toLowerCase();
  // Issue #711 — the ack override is legitimate only when the pulled
  // tokens land back at the wallet, i.e. the recipient (`args[1]`, the
  // `to` param) equals the wallet. Recipient goes unchecked (missing arg)
  // → deny-by-default. Non-transferFrom selectors don't gate on this, so
  // report `true` for them (the flag is ignored unless isTransferFrom).
  const transferFromRecipientIsWallet =
    !isTransferFromCall ||
    (p.args.length >= 2 &&
      String(p.args[1] ?? "").toLowerCase() === p.wallet.toLowerCase());
  const classifierVerdict = applyCustomCallClassifier(
    data,
    p.acknowledgeKnownExfilPattern,
    transferFromSelfAsFrom,
    transferFromRecipientIsWallet,
  );

  // Stringify args for the decoded preview. Caller-supplied shapes are
  // arbitrary (struct tuples, address arrays, decimal strings); the JSON
  // form is the most faithful agent-readable rendering without losing
  // structural detail. Caps at 4KB so a pathological bytes argument
  // doesn't blow up the prepare-receipt block.
  const argsJson = JSON.stringify(p.args, (_, v) =>
    typeof v === "bigint" ? v.toString() : v,
  );
  const argsPreview = argsJson.length > 4096 ? `${argsJson.slice(0, 4096)}…` : argsJson;

  const decodedArgs: Record<string, string> = { args: argsPreview };
  if (classifierVerdict.annotation) {
    decodedArgs._classifierWarning = classifierVerdict.annotation;
  }

  return {
    chain: p.chain,
    to: p.contract,
    data,
    value: p.value,
    from: p.wallet,
    description: `Custom call: ${p.fn} on ${p.contract} (${p.chain})`,
    decoded: {
      functionName: p.fn,
      args: decodedArgs,
    },
  };
}
