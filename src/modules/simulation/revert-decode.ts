import { BaseError, decodeErrorResult, parseAbiItem, type AbiItem } from "viem";
import { fetch4byteSignatures, type FetchLike } from "../../data/apis/fourbyte.js";

export interface DecodedRevert {
  /** Error name (e.g. "Paused", "InsufficientCollateral"), or undefined if we couldn't decode. */
  errorName?: string;
  /** Positional args as stringified values, or undefined if the error has no args. */
  args?: string[];
  /** Extra human hint for specific well-known errors (e.g. which pause flag to check for Comet Paused()). */
  hint?: string;
  /** Raw revert data, if we managed to extract it from the error chain. */
  data?: `0x${string}`;
  /** Where the decode came from — local ABI, 4byte.directory fallback, or just the selector. */
  source: "local-abi" | "4byte" | "selector-only" | "string-reason" | "unknown";
  /** Final human-readable message suitable for surfacing directly to the agent/user. */
  message: string;
}

/**
 * Curated registry of custom errors we care enough about to decode inline.
 * Kept deliberately small — every entry here is an error a DeFi user is
 * plausibly going to hit on a preview, and whose name alone is actionable.
 * Falls back to 4byte.directory for anything else.
 */
const KNOWN_ERROR_ABIS = [
  // Compound V3 Comet — named errors from comet-rs
  "error Paused()",
  "error NotCollateralized()",
  "error SupplyCapExceeded()",
  "error Absurd()",
  "error BorrowTooSmall()",
  "error BadAsset()",
  "error BadDecimals()",
  "error BadMinimum()",
  "error BadPrice()",
  "error BorrowCFTooLarge()",
  "error InsufficientReserves()",
  "error LiquidateCFTooLarge()",
  "error NoSelfTransfer()",
  "error NotForSale()",
  "error NotLiquidatable()",
  "error StoreFrontPriceFactorTooLarge()",
  "error Unauthorized()",
  "error InvalidUInt64(uint256)",
  "error InvalidUInt128(uint256)",
  "error InvalidInt104(uint256)",
  "error InvalidInt256(uint256)",
  "error TransferInFailed()",
  "error TransferOutFailed()",
  "error TooManyAssets()",
  "error TooMuchSlippage()",
  "error NegativeNumber()",
  "error BadDiscount()",
  "error AlreadyInitialized()",

  // Morpho Blue
  "error InsufficientCollateral()",
  "error InsufficientLiquidity()",
  "error MarketNotCreated()",
  "error InconsistentInput()",
  "error AlreadyCreated()",
  "error NotCreated()",
  "error ZeroAddress()",
  "error ZeroAssets()",
  "error MaxUint128Exceeded()",

  // OpenZeppelin ERC-20 v5 custom errors
  "error ERC20InsufficientBalance(address sender, uint256 balance, uint256 needed)",
  "error ERC20InsufficientAllowance(address spender, uint256 allowance, uint256 needed)",
  "error ERC20InvalidSender(address sender)",
  "error ERC20InvalidReceiver(address receiver)",
  "error ERC20InvalidApprover(address approver)",
  "error ERC20InvalidSpender(address spender)",
].map((s) => parseAbiItem(s) as AbiItem);

/**
 * Walks the viem error cause-chain looking for anything that carries the raw
 * revert-data hex string. Different viem versions attach it to different error
 * classes (`RawContractError`, `ExecutionRevertedError`, `ContractFunctionRevertedError`),
 * so we defensively check every cause for a `data` field that looks like hex.
 */
export function extractRevertData(err: unknown): `0x${string}` | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const candidate = err.walk((e: unknown) => {
    if (!e || typeof e !== "object") return false;
    const d = (e as { data?: unknown }).data;
    if (typeof d === "string" && d.startsWith("0x") && d.length >= 10) return true;
    // Some viem versions wrap it as { data: { data: "0x..." } }
    if (d && typeof d === "object" && typeof (d as { data?: unknown }).data === "string") return true;
    return false;
  }) as { data?: unknown } | null;
  if (!candidate) return undefined;
  const d = candidate.data;
  if (typeof d === "string" && d.startsWith("0x")) return d as `0x${string}`;
  if (d && typeof d === "object") {
    const inner = (d as { data?: unknown }).data;
    if (typeof inner === "string" && inner.startsWith("0x")) return inner as `0x${string}`;
  }
  return undefined;
}

function stringifyArg(v: unknown): string {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "true" : "false";
  if (v === null || v === undefined) return String(v);
  try {
    return JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  } catch {
    return String(v);
  }
}

function hintFor(errorName: string): string | undefined {
  switch (errorName) {
    case "Paused":
      return (
        "Market is paused. On a Comet market, call isWithdrawPaused / isSupplyPaused / " +
        "isTransferPaused / isBuyPaused / isAbsorbPaused to see which action is disabled."
      );
    case "NotCollateralized":
      return "Position would be under-collateralized after this action. Reduce borrow or add collateral.";
    case "InsufficientLiquidity":
      return "Market doesn't have enough available base asset to satisfy this borrow/withdraw right now.";
    case "InsufficientCollateral":
      return "Not enough collateral in the position to back this borrow / remain solvent after withdraw.";
    case "SupplyCapExceeded":
      return "This supply would exceed the market's configured supply cap.";
    case "TooMuchSlippage":
      return "Price moved past the configured slippage tolerance. Retry with a refreshed quote.";
    default:
      return undefined;
  }
}

function tryDecodeKnown(data: `0x${string}`): DecodedRevert | undefined {
  try {
    const decoded = decodeErrorResult({ abi: KNOWN_ERROR_ABIS, data });
    const args = decoded.args ? (decoded.args as readonly unknown[]).map(stringifyArg) : undefined;
    const hint = hintFor(decoded.errorName);
    return {
      errorName: decoded.errorName,
      args,
      hint,
      data,
      source: "local-abi",
      message: formatMessage(decoded.errorName, args, hint),
    };
  } catch {
    return undefined;
  }
}

function formatMessage(errorName: string, args?: string[], hint?: string): string {
  const base = args && args.length > 0
    ? `reverted with ${errorName}(${args.join(", ")})`
    : `reverted with ${errorName}()`;
  return hint ? `${base} — ${hint}` : base;
}

function extractStringReason(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const msg = err.shortMessage || err.message.split("\n")[0];
  if (!msg) return undefined;
  const m = msg.match(/reverted with reason(?: string)?:\s*['"]?([^'"]+?)['"]?\s*$/i);
  return m ? m[1] : undefined;
}

/**
 * Enriched revert decoder. Tries, in order:
 *   1. Extract raw revert data from the error chain + decode against the known-error ABI registry.
 *   2. Fall back to 4byte.directory lookup by 4-byte selector, for unknown selectors.
 *   3. If the error carries a plain string reason (Aave V3 style numeric require-codes,
 *      "SafeERC20" OZ reasons), surface that directly.
 *   4. Give up and return a sanitized version of viem's shortMessage.
 */
export async function enrichRevertReason(
  err: unknown,
  fetchFn?: FetchLike
): Promise<DecodedRevert> {
  const data = extractRevertData(err);

  if (data && data.length >= 10) {
    const local = tryDecodeKnown(data);
    if (local) return local;

    const selector = data.slice(0, 10).toLowerCase();
    try {
      const sigs = await fetch4byteSignatures(selector, fetchFn);
      if (sigs.length > 0) {
        const nameMatch = sigs[0].match(/^([^(]+)\(/);
        const errorName = nameMatch ? nameMatch[1] : sigs[0];
        return {
          errorName,
          data,
          source: "4byte",
          message: `reverted with ${sigs[0]} (selector ${selector}, via 4byte.directory — first of ${sigs.length} candidates)`,
        };
      }
    } catch {
      // fall through to selector-only
    }

    return {
      data,
      source: "selector-only",
      message: `reverted with unknown custom error (selector ${selector}; not in local registry or 4byte.directory)`,
    };
  }

  const stringReason = extractStringReason(err);
  if (stringReason) {
    return {
      source: "string-reason",
      message: `reverted with reason: ${stringReason}`,
    };
  }

  if (err instanceof BaseError) {
    return {
      source: "unknown",
      message: err.shortMessage || err.message.split("\n")[0] || "execution reverted",
    };
  }
  return {
    source: "unknown",
    message: err instanceof Error ? err.message.split("\n")[0] : "execution reverted",
  };
}
