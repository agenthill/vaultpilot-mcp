import {
  decodeAbiParameters,
  decodeFunctionData,
  formatUnits,
  getAddress,
  type Abi,
  type AbiFunction,
} from "viem";
import { erc20Abi } from "../abis/erc20.js";
import { aavePoolAbi } from "../abis/aave-pool.js";
import { cometAbi } from "../abis/compound-comet.js";
import { morphoBlueAbi } from "../abis/morpho-blue.js";
import { stETHAbi, lidoWithdrawalQueueAbi } from "../abis/lido.js";
import { eigenStrategyManagerAbi } from "../abis/eigenlayer-strategy-manager.js";
import { uniswapPositionManagerAbi } from "../abis/uniswap-position-manager.js";
import {
  lifiDiamondAbi,
  LIFI_BRIDGE_DATA_TUPLE,
  NON_EVM_RECEIVER_SENTINEL,
} from "../abis/lifi-diamond.js";
import { wethAbi } from "../abis/weth.js";
import { CONTRACTS, NATIVE_SYMBOL, TOKEN_META } from "../config/contracts.js";
import type {
  DecodedArg,
  HumanDecode,
  SupportedChain,
  UnsignedTronTx,
} from "../types/index.js";

/**
 * Local ABI-based calldata decoder. Never touches the network — uses only
 * the static ABI registry under `src/abis/` and the curated destination map
 * in `CONTRACTS`. Any destination we don't recognize produces a
 * `source: "none"` result, which the chat render translates into a "unknown
 * contract — rely on swiss-knife" nudge. This matches the conservative
 * failure mode: when we can't locally decode, we still hand the user the
 * raw calldata and a decoder URL.
 */

const LIFI_DIAMOND = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae";

type DestinationKind =
  | "aave-v3-pool"
  | "compound-v3-comet"
  | "morpho-blue"
  | "lido-stETH"
  | "lido-withdrawalQueue"
  | "eigenlayer-strategyManager"
  | "uniswap-v3-npm"
  | "weth9"
  | "known-erc20"
  | "lifi-diamond";

/**
 * WETH9 surface merged with the standard ERC-20 surface: `withdraw(uint256)`
 * and `deposit()` are WETH9-specific, while `transfer`/`approve`/... are
 * also emitted against WETH for Uniswap/Compound/Morpho supply flows.
 * Classifying WETH as plain `known-erc20` would leave the decoder blind to
 * `withdraw` calldata that `prepare_weth_unwrap` legitimately emits.
 */
const weth9Abi = [...erc20Abi, ...wethAbi] as Abi;

interface Destination {
  kind: DestinationKind;
  /** ABI to use for decoding. `null` means we recognize the contract but have no ABI for decode. */
  abi: Abi | null;
}

/**
 * Synchronous destination classifier — shares its allowlist with
 * `pre-sign-check.classifyDestination` but does NOT await anything. Both
 * classifiers walk the same `CONTRACTS` map so the two lists stay in
 * lockstep: anything the pre-sign check accepts, the decoder can at least
 * attempt to decode.
 */
function classifyDestination(chain: SupportedChain, to: `0x${string}`): Destination | null {
  const lo = to.toLowerCase();

  if (lo === CONTRACTS[chain].aave.pool.toLowerCase()) {
    return { kind: "aave-v3-pool", abi: aavePoolAbi as Abi };
  }

  const compound = (CONTRACTS[chain] as { compound?: Record<string, string> }).compound;
  if (compound) {
    for (const addr of Object.values(compound)) {
      if (lo === addr.toLowerCase()) return { kind: "compound-v3-comet", abi: cometAbi as Abi };
    }
  }

  if (chain === "ethereum") {
    if (lo === CONTRACTS.ethereum.morpho.blue.toLowerCase()) {
      return { kind: "morpho-blue", abi: morphoBlueAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.lido.stETH.toLowerCase()) {
      return { kind: "lido-stETH", abi: stETHAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.lido.withdrawalQueue.toLowerCase()) {
      return { kind: "lido-withdrawalQueue", abi: lidoWithdrawalQueueAbi as Abi };
    }
    if (lo === CONTRACTS.ethereum.eigenlayer.strategyManager.toLowerCase()) {
      return { kind: "eigenlayer-strategyManager", abi: eigenStrategyManagerAbi as Abi };
    }
  }

  if (lo === CONTRACTS[chain].uniswap.positionManager.toLowerCase()) {
    return { kind: "uniswap-v3-npm", abi: uniswapPositionManagerAbi as Abi };
  }

  if (lo === LIFI_DIAMOND) return { kind: "lifi-diamond", abi: lifiDiamondAbi as Abi };

  // WETH9 — matched BEFORE the generic tokens loop so `withdraw(uint256)` /
  // `deposit()` decode cleanly instead of falling through to plain ERC-20.
  const wethAddr = (CONTRACTS[chain] as { tokens?: { WETH?: string } }).tokens?.WETH;
  if (wethAddr && lo === wethAddr.toLowerCase()) {
    return { kind: "weth9", abi: weth9Abi };
  }

  const tokens = (CONTRACTS[chain] as { tokens?: Record<string, string> }).tokens;
  if (tokens) {
    for (const addr of Object.values(tokens)) {
      if (lo === addr.toLowerCase()) return { kind: "known-erc20", abi: erc20Abi as Abi };
    }
  }

  return null;
}

/**
 * Map a `BridgeData.destinationChainId` integer to a human chain name. Both
 * EVM and known non-EVM (LiFi-encoded) chain IDs are recognized; everything
 * else returns `chain <id>` so the user still sees a number rather than
 * a missing field.
 *
 * The LiFi-internal IDs for non-EVM chains come from
 * `@lifi/types/chains/base.ChainId` — kept in sync via the same constant
 * surfaced in `src/modules/swap/lifi.ts:LIFI_SOLANA_CHAIN_ID`. Hardcoding
 * here avoids a layered import (decoder doesn't depend on the swap module).
 */
function describeBridgeChainId(id: bigint): string {
  switch (id) {
    case 1n:
      return "ethereum (1)";
    case 10n:
      return "optimism (10)";
    case 137n:
      return "polygon (137)";
    case 8453n:
      return "base (8453)";
    case 42161n:
      return "arbitrum (42161)";
    case 56n:
      return "bsc (56)";
    case 43114n:
      return "avalanche (43114)";
    case 100n:
      return "gnosis (100)";
    case 1151111081099710n:
      return "solana (1151111081099710)";
    case 728126428n:
      return "tron (728126428)";
    case 20000000000001n:
      return "bitcoin (20000000000001)";
    case 9270000000000000n:
      return "sui (9270000000000000)";
    default:
      return `chain ${id.toString()}`;
  }
}

/**
 * Decoded shape of the universal LiFi `BridgeData` tuple. Field-for-field
 * mirror of `LIFI_BRIDGE_DATA_TUPLE`. Returned only when decode succeeds —
 * caller falls back to `source: "none"` on parse failure.
 */
export interface DecodedLifiBridgeData {
  transactionId: `0x${string}`;
  bridge: string;
  integrator: string;
  referrer: `0x${string}`;
  sendingAssetId: `0x${string}`;
  receiver: `0x${string}`;
  minAmount: bigint;
  destinationChainId: bigint;
  hasSourceSwaps: boolean;
  hasDestinationCall: boolean;
}

/**
 * Try to extract a `BridgeData` tuple from a LiFi Diamond call's calldata
 * irrespective of which `startBridgeTokensVia*` (or `swapAndStartBridgeTokensVia*`)
 * facet was invoked. The tuple is the first argument of every bridge facet
 * the Diamond exposes, so a single decode handles all of them — Across,
 * Amarok, Stargate, Wormhole, Mayan, deBridge, Allbridge, Squid, etc.
 *
 * Returns null when the calldata is too short, the selector is in the swap
 * ABI (= already handled), or the abi-parameters decode throws. The caller
 * (decodeCalldata) treats null as "fall through to swiss-knife".
 *
 * Implementation note: viem's `decodeAbiParameters` decodes the first
 * matching parameter at the start of the buffer and ignores trailing bytes,
 * so we don't need to know the bridge-specific second argument's shape.
 */
export function tryDecodeLifiBridgeData(
  data: `0x${string}`,
): DecodedLifiBridgeData | null {
  // Selector + at least one offset word (= bridge data offset). We don't
  // bother with a tighter bound — viem will throw if the buffer is malformed.
  if (data.length < 10 + 64) return null;
  const argsHex = ("0x" + data.slice(10)) as `0x${string}`;
  try {
    const [tuple] = decodeAbiParameters([LIFI_BRIDGE_DATA_TUPLE], argsHex) as [
      DecodedLifiBridgeData,
    ];
    // Sanity-check the bridge name — if decode succeeded on garbage we'd
    // typically see an empty string or non-printable characters. A real
    // LiFi bridge name is always a known protocol label (Across, Amarok,
    // Wormhole, Mayan, etc.) — short, ASCII, printable.
    if (
      typeof tuple.bridge !== "string" ||
      tuple.bridge.length === 0 ||
      tuple.bridge.length > 64 ||
      // eslint-disable-next-line no-control-regex
      /[\x00-\x1f]/.test(tuple.bridge)
    ) {
      return null;
    }
    return tuple;
  } catch {
    return null;
  }
}

function decodeLifiBridge(
  chain: SupportedChain,
  data: `0x${string}`,
): HumanDecode | null {
  const bridgeData = tryDecodeLifiBridgeData(data);
  if (!bridgeData) return null;

  const sendingMeta =
    TOKEN_META[chain][bridgeData.sendingAssetId.toLowerCase()];
  const sendingHuman = sendingMeta
    ? `${getAddress(bridgeData.sendingAssetId)} (${sendingMeta.symbol})`
    : getAddress(bridgeData.sendingAssetId);
  const minAmountHuman = sendingMeta
    ? `${formatUnits(bridgeData.minAmount, sendingMeta.decimals)} ${sendingMeta.symbol}`
    : undefined;

  const receiverIsNonEvm =
    bridgeData.receiver.toLowerCase() === NON_EVM_RECEIVER_SENTINEL;
  // For non-EVM destinations, the encoded `receiver` is just LiFi's
  // sentinel — surfacing it as the destination would be misleading. Show
  // the sentinel verbatim (so the user can confirm the bridge is intended
  // to go non-EVM) plus a structured note pointing at the bridge-specific
  // data the Solana destination is actually packed into.
  const receiverValue = getAddress(bridgeData.receiver);
  const receiverHuman = receiverIsNonEvm
    ? `${receiverValue} — LiFi non-EVM sentinel: actual destination address is encoded in the bridge-specific data (NOT decoded by this server). Verify against the swiss-knife decode link.`
    : undefined;

  const args: DecodedArg[] = [
    {
      name: "bridge",
      type: "string",
      value: bridgeData.bridge,
    },
    {
      name: "sendingAssetId",
      type: "address",
      value: getAddress(bridgeData.sendingAssetId),
      ...(sendingMeta ? { valueHuman: sendingHuman } : {}),
    },
    {
      name: "receiver",
      type: "address",
      value: receiverValue,
      ...(receiverHuman ? { valueHuman: receiverHuman } : {}),
    },
    {
      name: "minAmount",
      type: "uint256",
      value: bridgeData.minAmount.toString(),
      ...(minAmountHuman ? { valueHuman: minAmountHuman } : {}),
    },
    {
      name: "destinationChainId",
      type: "uint256",
      value: bridgeData.destinationChainId.toString(),
      valueHuman: describeBridgeChainId(bridgeData.destinationChainId),
    },
    {
      name: "hasSourceSwaps",
      type: "bool",
      value: String(bridgeData.hasSourceSwaps),
    },
    {
      name: "hasDestinationCall",
      type: "bool",
      value: String(bridgeData.hasDestinationCall),
    },
  ];

  return {
    functionName: "lifiBridge",
    signature: `lifiBridge(BridgeData) — facet: ${bridgeData.bridge}`,
    args,
    // Partial because the LiFi Diamond ships dozens of bridge-facet selectors
    // (startBridgeTokensViaAcrossV4, swapAndStartBridgeTokensViaWormhole, …)
    // and our local ABI doesn't enumerate them — we only decode the universal
    // first `BridgeData` tuple. The `lifiBridge` label is synthetic; 4byte
    // resolves the same selector to the canonical facet name. Marking this
    // as partial tells the cross-check to NOT compare names (would always
    // mismatch by design); arg-level corroboration via re-encode still runs.
    source: "local-abi-partial",
  };
}

function nativeDecode(chain: SupportedChain, value: string): HumanDecode {
  let valueHuman: string;
  try {
    valueHuman = `${formatUnits(BigInt(value), 18)} ${NATIVE_SYMBOL[chain]}`;
  } catch {
    valueHuman = `${value} wei`;
  }
  return {
    functionName: "nativeTransfer",
    args: [{ name: "value", type: "uint256", value, valueHuman }],
    source: "native",
  };
}

function stringifyArg(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return `[${value.map(stringifyArg).join(", ")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).map(([k, v]) => `${k}: ${stringifyArg(v)}`).join(", ")}}`;
  }
  return String(value);
}

/**
 * Apply ERC-20 decimals + symbol when the arg's type is uint256 and we
 * recognize the destination as a known token. This is the only
 * human-formatting we do on generic ERC-20 args — anything else (aave
 * `supply(asset, amount, ...)` where `asset` is the token arg) would need
 * the caller to identify which specific arg is the "asset" field, which we
 * don't currently wire through. A future refinement could walk `supply`'s
 * args to look up the asset arg and format the amount arg accordingly.
 */
function formatErc20ArgHuman(
  chain: SupportedChain,
  to: `0x${string}`,
  argName: string,
  argType: string,
  raw: unknown,
): string | undefined {
  if (argType !== "uint256" || typeof raw !== "bigint") return undefined;
  // `wad` is the canonical WETH9 arg name for withdraw(uint256).
  if (argName !== "amount" && argName !== "value" && argName !== "wad") return undefined;
  const meta = TOKEN_META[chain][to.toLowerCase()];
  if (!meta) return undefined;
  return `${formatUnits(raw, meta.decimals)} ${meta.symbol}`;
}

function signatureOf(item: AbiFunction): string {
  const inputs = item.inputs.map((i) => i.type).join(",");
  return `${item.name}(${inputs})`;
}

/**
 * High-risk standard selectors we still try to decode positionally even
 * when the destination is absent from the curated `CONTRACTS` map.
 *
 * Threat that motivates this fallback: a C.2 collude attack routes an
 * NFT operator-approval (`setApprovalForAll(operator, true)`) to an
 * uncurated marketplace/aggregator while the cooperating MCP narrates
 * "Seaport-only". With `source:'none'` the attacker-controlled operator
 * address never surfaces in CHECKS PERFORMED, so Inv #1 sees opaque bytes
 * and cannot flag the label/calldata mismatch — the user-facing prose
 * passes while the bytes hand a hostile contract permission to move every
 * NFT in the collection. (Issue #573, smoke-test batch-3 finding
 * `expert-x104-C.2`.)
 *
 * The fallback returns `source:'local-abi-partial'` rather than
 * `'local-abi'`: we KNOW the standard ABI shape but we DO NOT know that
 * the destination is a real ERC-721/1155 — anyone can ship a contract
 * with a matching selector. The partial label tells the cross-check NOT
 * to compare function names against 4byte (4byte's signature for this
 * selector IS canonical, so the re-encode check still anchors the args
 * — matching the existing LiFi-bridge partial-decode pattern).
 *
 * Scope is intentionally narrow: standardized selectors whose blast
 * radius justifies decoding even on contracts we don't know. Adding
 * more selectors here is fine; using this list as an allowlist for
 * destination trust is NOT — the partial source label IS the warning.
 *
 * Each entry's `abi` is a single-function ABI tuple ready for
 * `decodeFunctionData`. The `selector` and `signature` are kept in sync by
 * hand; the per-entry decode tests pin each selector against its calldata
 * (`expect(data.slice(0, 10)).toBe(selector)`), so a mistyped selector or
 * signature fails in CI rather than silently mis-decoding.
 */
interface HighRiskSelector {
  selector: `0x${string}`;
  signature: string;
  abi: AbiFunction;
  /**
   * Set when the ABI has a dynamic tail (e.g. a trailing `bytes` arg) so the
   * encoded calldata length is variable. For these entries the strict
   * fixed-length guard is replaced by a minimum-length check (the static head
   * must fit); viem's `decodeFunctionData` then validates the dynamic
   * encoding and throws on a malformed payload. Static-only entries omit this
   * and keep the exact-length guard.
   */
  dynamicTail?: true;
}

const HIGH_RISK_STANDARD_SELECTORS: readonly HighRiskSelector[] = [
  {
    // ERC-721 / ERC-1155 setApprovalForAll(address operator, bool approved).
    // A single signed call grants/revokes operator authority for ALL tokens
    // of the collection — highest blast radius outside typed-data signing.
    selector: "0xa22cb465",
    signature: "setApprovalForAll(address,bool)",
    abi: {
      type: "function",
      name: "setApprovalForAll",
      stateMutability: "nonpayable",
      inputs: [
        { name: "operator", type: "address" },
        { name: "approved", type: "bool" },
      ],
      outputs: [],
    },
  },
  {
    // ERC-721 safeTransferFrom(address from, address to, uint256 tokenId).
    // A rogue MCP can route an NFT transfer to an attacker-controlled `to`
    // on an uncurated collection while narrating a benign recipient.
    // Surfacing `to` + `tokenId` lets Inv #1 flag the label/calldata
    // mismatch. (Issue #670, rogue-MCP-only / cooperating-agent slice.)
    selector: "0x42842e0e",
    signature: "safeTransferFrom(address,address,uint256)",
    abi: {
      type: "function",
      name: "safeTransferFrom",
      stateMutability: "nonpayable",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "tokenId", type: "uint256" },
      ],
      outputs: [],
    },
  },
  {
    // ERC-721 safeTransferFrom(address from, address to, uint256 tokenId,
    // bytes data) — the overload that carries an arbitrary `data` payload to
    // the receiver's onERC721Received hook. Same recipient-spoofing threat
    // as the 3-arg form; the trailing `bytes` makes the calldata length
    // variable, so this entry is flagged `dynamicTail` to swap the
    // exact-length guard for a minimum-length head check.
    selector: "0xb88d4fde",
    signature: "safeTransferFrom(address,address,uint256,bytes)",
    abi: {
      type: "function",
      name: "safeTransferFrom",
      stateMutability: "nonpayable",
      inputs: [
        { name: "from", type: "address" },
        { name: "to", type: "address" },
        { name: "tokenId", type: "uint256" },
        { name: "data", type: "bytes" },
      ],
      outputs: [],
    },
    dynamicTail: true,
  },
];

function decodeHighRiskStandardSelector(
  data: `0x${string}`,
): HumanDecode | null {
  if (data.length < 10) return null;
  const selector = data.slice(0, 10).toLowerCase() as `0x${string}`;
  const entry = HIGH_RISK_STANDARD_SELECTORS.find((e) => e.selector === selector);
  if (!entry) return null;

  // ABI sanity. For static-only entries (e.g. setApprovalForAll(address,bool)
  // or safeTransferFrom(address,address,uint256)) the head packs to exactly
  // `inputs.length * 64` hex chars after the 4-byte selector — reject any
  // other length to avoid surfacing a spuriously-decoded args list when a
  // different function with a coincidentally-matching selector prefix was
  // intended. For `dynamicTail` entries (a trailing `bytes` arg makes the
  // length variable) the head is still fixed, so require AT LEAST that many
  // hex chars; viem's `decodeFunctionData` then validates the dynamic tail
  // and throws on a malformed payload, falling through to source:'none'.
  const headHexLen = 10 + entry.abi.inputs.length * 64;
  if (entry.dynamicTail) {
    if (data.length < headHexLen) return null;
  } else if (data.length !== headHexLen) {
    return null;
  }

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: [entry.abi], data });
  } catch {
    return null;
  }

  const rawArgs = decoded.args ?? [];
  const args: DecodedArg[] = entry.abi.inputs.map((input, idx) => {
    const raw = rawArgs[idx];
    const base: DecodedArg = {
      name: input.name ?? `arg${idx}`,
      type: input.type,
      value: stringifyArg(raw),
    };
    if (input.type === "address" && typeof raw === "string") {
      try {
        base.value = getAddress(raw);
      } catch {
        // Keep raw string if checksum fails.
      }
    }
    return base;
  });

  return {
    functionName: entry.abi.name,
    signature: entry.signature,
    args,
    // Partial: we know the standard ABI shape, but we DO NOT know the
    // destination is a real ERC-721/1155 — name-equality with 4byte is
    // not safe to claim from this side (the destination could be an
    // attacker contract that re-uses the selector). The cross-check's
    // re-encode anchor still validates the args.
    source: "local-abi-partial",
  };
}

export function decodeCalldata(
  chain: SupportedChain,
  to: `0x${string}`,
  data: `0x${string}`,
  value: string,
): HumanDecode {
  if (data === "0x" || data === "0x0" || data === "0x00") {
    return nativeDecode(chain, value);
  }

  const dest = classifyDestination(chain, to);
  if (!dest || !dest.abi) {
    // Before giving up on `source:'none'`, attempt a selector-only
    // partial decode for high-risk standard selectors (ERC-721/1155
    // operator approvals, etc.). Surfaces operator/spender addresses in
    // CHECKS PERFORMED so Inv #1 can flag a label/calldata mismatch.
    const partial = decodeHighRiskStandardSelector(data);
    if (partial) return partial;
    return {
      functionName: "unknown",
      args: [],
      source: "none",
    };
  }

  let decoded: { functionName: string; args?: readonly unknown[] };
  try {
    decoded = decodeFunctionData({ abi: dest.abi, data });
  } catch {
    // LiFi Diamond-specific fallback: bridge facets aren't in
    // `lifiDiamondAbi` (one selector per facet, dozens total), but the
    // first argument is the universal `BridgeData` tuple — so we can
    // still surface bridge name / receiver / destinationChainId /
    // sendingAssetId / minAmount via a positional decode that ignores
    // the facet-specific second argument.
    if (dest.kind === "lifi-diamond") {
      const bridgeDecode = decodeLifiBridge(chain, data);
      if (bridgeDecode) return bridgeDecode;
    }
    return { functionName: "unknown", args: [], source: "none" };
  }

  const abiItem = dest.abi.find(
    (item): item is AbiFunction => item.type === "function" && item.name === decoded.functionName,
  );
  if (!abiItem) return { functionName: decoded.functionName, args: [], source: "local-abi" };

  const rawArgs = decoded.args ?? [];
  const args: DecodedArg[] = abiItem.inputs.map((input, idx) => {
    const raw = rawArgs[idx];
    const base: DecodedArg = {
      name: input.name ?? `arg${idx}`,
      type: input.type,
      value: stringifyArg(raw),
    };
    const human =
      dest.kind === "known-erc20" || dest.kind === "weth9"
        ? formatErc20ArgHuman(chain, to, base.name, input.type, raw)
        : undefined;
    if (input.type === "address" && typeof raw === "string") {
      // Re-apply checksum casing on address args so the chat output
      // matches the form swiss-knife renders.
      try {
        base.value = getAddress(raw);
      } catch {
        // Keep raw string if checksum fails (shouldn't happen for well-formed calldata).
      }
    }
    if (human) base.valueHuman = human;
    return base;
  });

  return {
    functionName: decoded.functionName,
    signature: signatureOf(abiItem),
    args,
    source: "local-abi",
  };
}

/**
 * TRON's `rawData` isn't ABI-encoded calldata — it's a protobuf-ish envelope
 * with a typed contract. The prepare_tron_* builders already populate
 * `tx.decoded` with a structured function name + args tailored to each
 * action type (native_send, trc20_send, vote, freeze, etc.). We reuse that
 * here rather than re-decoding raw_data_hex, so the verification decode
 * stays trivially consistent with what the preparer itself reported.
 */
export function decodeTronCall(tx: UnsignedTronTx): HumanDecode {
  const args: DecodedArg[] = Object.entries(tx.decoded.args).map(([name, value]) => ({
    name,
    type: "string",
    value,
  }));
  return {
    functionName: tx.decoded.functionName,
    args,
    source: "local-abi",
  };
}
