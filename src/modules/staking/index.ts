import { getLidoPositions, getLidoApr, estimateLidoRewards } from "./lido.js";
import { getEigenLayerPositions } from "./eigenlayer.js";
import type {
  GetStakingPositionsArgs,
  GetStakingRewardsArgs,
  EstimateStakingYieldArgs,
} from "./schemas.js";
import type { StakingPosition, SupportedChain } from "../../types/index.js";
import { SUPPORTED_CHAINS } from "../../types/index.js";

export async function getStakingPositions(args: GetStakingPositionsArgs): Promise<{
  wallet: string;
  positions: StakingPosition[];
  /**
   * True if any source (Lido, EigenLayer) failed. Combined with
   * `erroredSources` — a flaky Lido RPC no longer zeroes EigenLayer data
   * (issue #93). Omitted when both sources succeeded so the happy-path
   * response stays unchanged.
   */
  errored?: boolean;
  /**
   * Per-source failure detail for callers that need to surface which source
   * was unavailable (portfolio coverage notes) without losing the other
   * source's positions.
   */
  erroredSources?: { source: "lido" | "eigenlayer"; error: string }[];
}> {
  const wallet = args.wallet as `0x${string}`;
  const chains: SupportedChain[] = (args.chains as SupportedChain[]) ?? [...SUPPORTED_CHAINS];

  // allSettled so a flaky Lido RPC (say, balanceOf reverting under rate-limit)
  // no longer short-circuits the EigenLayer read. Previously `Promise.all`
  // rejected the whole function on either source failing — the aggregator's
  // `.catch(() => { errors.staking = true; return emptyPositions })` then
  // dropped BOTH sources, making `coverage.staking.errored:true` ambiguous.
  // Returning per-source detail lets the aggregator produce a note that
  // names the failing source(s) (issue #93).
  const [lidoResult, eigenResult] = await Promise.allSettled([
    getLidoPositions(wallet, chains),
    chains.includes("ethereum") ? getEigenLayerPositions(wallet) : Promise.resolve([]),
  ]);

  const positions: StakingPosition[] = [];
  const erroredSources: { source: "lido" | "eigenlayer"; error: string }[] = [];

  function extractError(reason: unknown): string {
    return reason instanceof Error ? reason.message : String(reason);
  }

  if (lidoResult.status === "fulfilled") {
    positions.push(...lidoResult.value);
  } else {
    erroredSources.push({ source: "lido", error: extractError(lidoResult.reason) });
  }
  if (eigenResult.status === "fulfilled") {
    positions.push(...eigenResult.value);
  } else {
    erroredSources.push({ source: "eigenlayer", error: extractError(eigenResult.reason) });
  }

  return {
    wallet,
    positions,
    ...(erroredSources.length > 0 ? { errored: true, erroredSources } : {}),
  };
}

const PERIOD_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

export async function getStakingRewards(args: GetStakingRewardsArgs): Promise<{
  wallet: string;
  period: string;
  estimated: Array<{
    protocol: string;
    amount: string;
    valueUsd?: number;
    note: string;
  }>;
  disclaimer: string;
}> {
  const wallet = args.wallet as `0x${string}`;
  const days = PERIOD_DAYS[args.period ?? "30d"];
  const { positions } = await getStakingPositions({ wallet, chains: undefined });

  const estimated = positions
    .map((p) => {
      if (p.protocol !== "lido") {
        return {
          protocol: p.protocol,
          amount: "0",
          note: "Reward estimation not yet implemented for this protocol.",
        };
      }
      const est = estimateLidoRewards(p, days);
      return est
        ? { protocol: p.protocol, amount: est.amount, valueUsd: est.valueUsd, note: est.note }
        : { protocol: p.protocol, amount: "0", note: "Could not fetch APR." };
    });

  return {
    wallet,
    period: args.period ?? "30d",
    estimated,
    disclaimer:
      "Figures are APR-based projections, not actual on-chain rewards. For precise rewards, use an indexer over the wallet's transaction history.",
  };
}

export async function estimateStakingYield(args: EstimateStakingYieldArgs): Promise<{
  protocol: string;
  amount: number;
  apr?: number;
  estimatedAnnualYield?: number;
  note: string;
}> {
  if (args.protocol === "lido") {
    const apr = await getLidoApr();
    return {
      protocol: "lido",
      amount: args.amount,
      apr,
      estimatedAnnualYield: apr !== undefined ? args.amount * apr : undefined,
      note: "Based on current Lido APR from DefiLlama. Actual yield varies with validator performance.",
    };
  }
  // EigenLayer restaking yield is AVS-dependent and not yet uniformly reported.
  return {
    protocol: "eigenlayer",
    amount: args.amount,
    apr: undefined,
    estimatedAnnualYield: undefined,
    note: "EigenLayer yield depends on the AVSs a user's operator participates in; per-AVS APRs are not yet aggregated in this MVP.",
  };
}
