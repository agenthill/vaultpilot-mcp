import { z } from "zod";
import { SUPPORTED_CHAINS } from "../../types/index.js";
import { EVM_ADDRESS, SOLANA_ADDRESS, TRON_ADDRESS } from "../../shared/address-patterns.js";

const chainEnum = z.enum(SUPPORTED_CHAINS as unknown as [string, ...string[]]);
/**
 * Destination-chain enum: EVM chains plus Solana and TRON. Used for cross-
 * chain bridging where the user signs an EVM tx and the bridge protocol
 * delivers tokens on the destination chain. Source chain stays EVM-only
 * (Solana-source goes through `prepare_solana_lifi_swap`; TRON-source LiFi
 * is not yet wired — tracked as a follow-up that needs raw_data
 * reconstruction).
 */
const toChainEnum = z.enum([
  ...(SUPPORTED_CHAINS as unknown as [string, ...string[]]),
  "solana",
  "tron",
]);
const walletSchema = z.string().regex(EVM_ADDRESS);
const tokenSchema = z.union([
  z.literal("native"),
  z.string().regex(EVM_ADDRESS),
]);
/**
 * Destination token: EVM hex when `toChain` is EVM, base58 SPL mint when
 * `toChain === "solana"`, base58 TRC-20 contract address (T-prefixed)
 * when `toChain === "tron"`. Format-validated per-chain in the resolver
 * (`assertCrossChainAddressing`) since zod can't cross-reference fields
 * within `union` cleanly. `TRON_ADDRESS` is a strict subset of
 * `SOLANA_ADDRESS` (TRON is exactly 34 chars + T prefix; Solana is 43-44
 * chars), so the union-with-regex works cleanly.
 */
const toTokenSchema = z.union([
  z.literal("native"),
  z.string().regex(EVM_ADDRESS),
  z.string().regex(SOLANA_ADDRESS),
  z.string().regex(TRON_ADDRESS),
]);

const baseSwapSchema = z.object({
  wallet: walletSchema,
  fromChain: chainEnum,
  toChain: toChainEnum,
  fromToken: tokenSchema,
  toToken: toTokenSchema,
  toAddress: z
    .string()
    .max(80)
    .optional()
    .describe(
      "Destination wallet. For an EVM destination it must be OMITTED or equal the " +
        "source `wallet` — routing a same-chain/EVM swap's output to a DIFFERENT EVM " +
        "address is refused (#798 fail-closed: at this layer there is no user-confirmed, " +
        "unforgeable signal that a non-wallet EVM recipient is intentional, and a " +
        "prompt-injected agent controls every tool arg, so the swap-to-another-EVM-wallet " +
        "convenience is dropped rather than gated on an agent-settable flag). REQUIRED " +
        "when `toChain` is `\"solana\"` or `\"tron\"` (the source EVM hex wallet isn't a " +
        "valid recipient on those chains, and the real recipient lives in bridge-specific " +
        "calldata the EVM receiver check does not touch). Format must match the " +
        "destination chain (Solana base58 for `\"solana\"`, TRON base58 with T-prefix for " +
        "`\"tron\"`, EVM hex otherwise)."
    ),
  amount: z
    .string()
    .max(50)
    .describe(
      'Human-readable decimal amount, NOT raw wei/base units. Example: "1.5" for ' +
        '1.5 USDC, "0.01" for 0.01 ETH. Interpreted as fromToken input by default; ' +
        'set `amountSide: "to"` to interpret as the toToken output amount (exact-out). ' +
        'The tool resolves decimals on-chain and converts internally.'
    ),
  amountSide: z
    .enum(["from", "to"])
    .optional()
    .describe(
      'Which side of the swap `amount` refers to. "from" (default) = exact-in: you ' +
        'spend exactly `amount` of fromToken and receive a variable output. "to" = ' +
        'exact-out: you receive exactly `amount` of toToken and the input is sized to ' +
        "hit that target. Exact-out uses LiFi's toAmount quote and skips the 1inch " +
        "comparison (1inch has no exact-out endpoint)."
    ),
  fromTokenDecimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe(
      "Optional decimals hint for fromToken if on-chain lookup fails (rare). Native is 18."
    ),
  toTokenDecimals: z
    .number()
    .int()
    .min(0)
    .max(36)
    .optional()
    .describe(
      "Optional decimals hint for toToken if on-chain lookup fails (rare). Only used " +
        'when `amountSide: "to"`. Native is 18.'
    ),
  slippageBps: z
    .number()
    .int()
    .min(1)
    .max(500)
    .optional()
    .describe(
      "Slippage tolerance in basis points (50 = 0.5%, 100 = 1%). Default ~50. " +
        "Hard-capped at 500 (5%) — anything higher is almost always a sandwich-bait " +
        "misconfiguration. If a legitimate thin-liquidity route genuinely needs >1%, " +
        "also pass `acknowledgeHighSlippage: true`."
    ),
  acknowledgeHighSlippage: z
    .boolean()
    .optional()
    .describe(
      "Opt-in flag required when slippageBps > 100 (1%). Forces the caller to state " +
        "that an unusually-high slippage is intentional — the default rejects the tx " +
        "to protect the user from MEV sandwich attacks."
    ),
  // Issue #798 — NOTE: there is deliberately NO `acknowledgeNonWalletRecipient`
  // flag here. An agent-settable boolean cannot authorize a non-wallet EVM
  // recipient: the threat actor is a prompt-injected agent that controls every
  // tool arg, so it would simply set the flag alongside its own `toAddress` and
  // the self-referential check would pass — the original #798 drain. The sound
  // fix is fail-closed: a non-wallet EVM `toAddress` is refused outright (see
  // `assertCrossChainAddressing` and `assertEvmReceiverIsWallet` in index.ts).
  // The convenience of swapping to a different EVM wallet is dropped until a
  // user-confirmed, unforgeable signal exists at this layer.
  // Issue #411 — explicit DEX / bridge routing preferences. Without
  // these, LiFi picks whatever pool gives the best output (Sushi,
  // Uniswap, 1inch, KyberSwap, Paraswap, etc.). When the user names a
  // protocol — "swap on 1inch" — the agent should pass
  // `exchanges: ["1inch"]` so LiFi only considers that DEX. Filter
  // is hard: LiFi returns NO_ROUTE if the named DEX can't satisfy the
  // request, surfacing as a clear error rather than silent fallback.
  exchanges: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe(
      "Restrict LiFi routing to a specific set of DEX/exchange aggregators. Common " +
        'values: "1inch", "sushiswap", "uniswap", "paraswap", "0x", "kyberswap", ' +
        '"odos", "openocean". When the user explicitly names a DEX ("swap on 1inch"), ' +
        "pass it here — without a filter, LiFi silently picks the best-output route " +
        "regardless of what the user asked for. Multiple entries OR'd. If no route " +
        "exists via the requested exchange(s) the call errors clearly; agent should " +
        "offer to retry without the filter.",
    ),
  bridges: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe(
      "Restrict cross-chain routing to a specific set of bridge protocols. Common " +
        'values: "across", "stargate", "hop", "cbridge", "amarok", "polygon", ' +
        '"arbitrum-bridge". Mirrors `exchanges` but for bridge selection. Only ' +
        "applies to cross-chain routes; ignored for intra-chain swaps.",
    ),
  // Issue #439 — blocklists + ranking criterion.
  excludeExchanges: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe(
      "Blocklist version of `exchanges` — DEXes/aggregators LiFi must avoid. Use " +
        'when the user says "not via 1inch" or "avoid Sushiswap". Independent of ' +
        "`exchanges`: pass both to constrain to allowlist minus blocklist. Pass-through " +
        "to LiFi's `denyExchanges`.",
    ),
  excludeBridges: z
    .array(z.string().min(1).max(40))
    .max(20)
    .optional()
    .describe(
      "Blocklist version of `bridges` — bridge protocols LiFi must avoid on cross-chain " +
        "routes. Pass-through to LiFi's `denyBridges`.",
    ),
  order: z
    .enum(["RECOMMENDED", "FASTEST", "CHEAPEST", "SAFEST"])
    .optional()
    .describe(
      "Route ranking criterion. RECOMMENDED (default) — LiFi's mix of price + safety. " +
        "CHEAPEST — pick the route with the highest output amount; use this for " +
        '"best rate available" intent. FASTEST — minimize execution time (relevant ' +
        "for cross-chain bridges where settlement varies). SAFEST — prefer the " +
        "most-vetted tool set. Pass-through to LiFi's `order`.",
    ),
});

export const getSwapQuoteInput = baseSwapSchema;
export const prepareSwapInput = baseSwapSchema;

export type GetSwapQuoteArgs = z.infer<typeof getSwapQuoteInput>;
export type PrepareSwapArgs = z.infer<typeof prepareSwapInput>;
