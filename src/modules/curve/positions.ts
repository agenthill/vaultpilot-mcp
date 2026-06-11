/**
 * Curve LP positions reader — v0.1.
 *
 * Strategy: enumerate stable_ng plain pools via `pools.ts`, then per-pool
 * read the user's LP balance + gauge-staked balance + pending CRV in one
 * multicall. Pools where the user has zero of all three are filtered out
 * to keep the response scannable.
 *
 * NOTE on `claimable_tokens`: the gauge function is `nonpayable` per the
 * ABI (it has side effects — refreshes the integral state) but viem's
 * `multicall` will still execute it as a `staticCall`-equivalent at the
 * RPC level and return the would-be result. This matches how the SDK
 * reads pending CRV. If the RPC rejects nonpayable in static context
 * (some providers do), the result for that pool surfaces as an error
 * and the position row falls back to `pendingCrv: "0"`.
 */
import type { Address } from "viem";
import { getClient } from "../../data/rpc.js";
import { listEthereumStableNgPools } from "./pools.js";
import {
  curveStableNgPlainPoolAbi,
  curveGaugeV5Abi,
} from "../../abis/curve.js";
import type { CurvePosition } from "../../types/index.js";

export async function getCurvePositions(
  wallet: Address,
): Promise<CurvePosition[]> {
  const pools = await listEthereumStableNgPools();
  if (pools.length === 0) return [];

  const client = getClient("ethereum");

  // Build the per-pool multicall. Per pool we read:
  //   1. balanceOf(wallet) on the pool itself (LP token == pool on stable_ng)
  //   2. balanceOf(wallet) on the gauge (or skip if gauge is null)
  //   3. claimable_tokens(wallet) on the gauge (or skip if gauge is null)
  // We track a per-pool offset so we can match results back.
  type Slot =
    | { kind: "lp"; poolIdx: number }
    | { kind: "gaugeBal"; poolIdx: number }
    | { kind: "gaugeClaim"; poolIdx: number };
  const calls: Array<{ address: Address; abi: typeof curveStableNgPlainPoolAbi | typeof curveGaugeV5Abi; functionName: string; args: readonly unknown[] }> = [];
  const slots: Slot[] = [];

  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    calls.push({
      address: p.pool,
      abi: curveStableNgPlainPoolAbi,
      functionName: "balanceOf",
      args: [wallet] as const,
    });
    slots.push({ kind: "lp", poolIdx: i });
    if (p.gauge !== null) {
      calls.push({
        address: p.gauge,
        abi: curveGaugeV5Abi,
        functionName: "balanceOf",
        args: [wallet] as const,
      });
      slots.push({ kind: "gaugeBal", poolIdx: i });
      calls.push({
        address: p.gauge,
        abi: curveGaugeV5Abi,
        functionName: "claimable_tokens",
        args: [wallet] as const,
      });
      slots.push({ kind: "gaugeClaim", poolIdx: i });
    }
  }

  // Cast to viem multicall-input shape — the ABI types are intentionally
  // narrowed to the function we're calling, so viem accepts the union.
  const results = await client.multicall({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    contracts: calls as any,
    allowFailure: true,
  });

  // Aggregate per-pool: { lp, gaugeBal, gaugeClaim }
  const perPool: Map<
    number,
    { lp: bigint; gaugeBal: bigint; gaugeClaim: bigint }
  > = new Map(pools.map((_, i) => [i, { lp: 0n, gaugeBal: 0n, gaugeClaim: 0n }]));
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const slot = slots[i];
    if (r.status !== "success") continue;
    const value = r.result as bigint;
    const entry = perPool.get(slot.poolIdx)!;
    if (slot.kind === "lp") entry.lp = value;
    else if (slot.kind === "gaugeBal") entry.gaugeBal = value;
    else if (slot.kind === "gaugeClaim") entry.gaugeClaim = value;
  }

  // Build CurvePosition[] filtering out the all-zero pools.
  const out: CurvePosition[] = [];
  for (let i = 0; i < pools.length; i++) {
    const p = pools[i];
    const e = perPool.get(i)!;
    if (e.lp === 0n && e.gaugeBal === 0n && e.gaugeClaim === 0n) continue;
    out.push({
      protocol: "curve",
      chain: "ethereum",
      poolAddress: p.pool,
      poolType: p.poolType,
      coins: p.coins,
      lpBalance: e.lp.toString(),
      gaugeStakedBalance: e.gaugeBal.toString(),
      pendingCrv: e.gaugeClaim.toString(),
      gaugeAddress: p.gauge,
    });
  }
  return out;
}
