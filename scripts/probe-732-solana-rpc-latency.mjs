#!/usr/bin/env node
/**
 * Issue #732 — read-only latency probe for the Solana broadcast path.
 *
 * WHY: #706 wrapped every Solana Connection RPC call (including the
 * `sendTransaction` POST inside broadcastSolanaTx) in a 10s AbortController
 * timeout. #732 asks whether 10s comfortably exceeds real p99 submission
 * latency. True tx-submission p99 cannot be measured without live broadcasts
 * (which move value / mutate chain state), so this probe measures a
 * READ-ONLY responsiveness PROXY: the round-trip latency of `getLatestBlockhash`
 * and `getHealth` against the SAME endpoint the broadcast path resolves to.
 *
 * FIDELITY CAVEAT (stated loudly, per the issue): a read round-trip is a
 * LOWER BOUND on submission latency. A real `sendTransaction` with
 * `skipPreflight:false` additionally runs a preflight SIMULATION on the node
 * before returning, and the node forwards to the current leader — both add
 * time a plain read never pays. So p99(read) << p99(sendTransaction). Treat
 * these numbers as "is the endpoint even in the right ballpark", not as the
 * broadcast SLA.
 *
 * Endpoint resolution mirrors src/config/chains.ts resolveSolanaRpcUrl:
 *   SOLANA_RPC_URL env  >  (helius runtime override, N/A here)  >  public default.
 *
 * Read-only: getLatestBlockhash + getHealth are pure reads. No signing, no
 * broadcast, no value movement.
 */

const PUBLIC_DEFAULT = "https://api.mainnet-beta.solana.com";
const ENDPOINT = process.env.SOLANA_RPC_URL || PUBLIC_DEFAULT;
const N = Number(process.env.PROBE_N || 60);
const SPACING_MS = Number(process.env.PROBE_SPACING_MS || 150); // be gentle on the public endpoint
const PER_CALL_TIMEOUT_MS = 15_000; // wider than the 10s prod timeout so we can OBSERVE a >10s tail

function pct(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

async function timedRpc(method, params) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PER_CALL_TIMEOUT_MS);
  const t0 = performance.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal,
    });
    const status = res.status;
    let jsonErr = null;
    try {
      const body = await res.json();
      if (body && body.error) jsonErr = body.error;
    } catch {
      /* non-JSON body */
    }
    const ms = performance.now() - t0;
    return { ok: status === 200 && !jsonErr, ms, status, jsonErr };
  } catch (e) {
    const ms = performance.now() - t0;
    return { ok: false, ms, status: 0, jsonErr: null, aborted: e?.name === "AbortError", err: String(e?.message || e) };
  } finally {
    clearTimeout(timer);
  }
}

async function runSeries(label, method, params) {
  const oks = [];
  let http429 = 0, http410 = 0, http503 = 0, jsonRl = 0, aborts = 0, otherErr = 0;
  let over10s = 0;
  for (let i = 0; i < N; i++) {
    const r = await timedRpc(method, params);
    if (r.ok) {
      oks.push(r.ms);
      if (r.ms > 10_000) over10s++;
    } else if (r.status === 429) http429++;
    else if (r.status === 410) http410++;
    else if (r.status === 503) http503++;
    else if (r.jsonErr) jsonRl++;
    else if (r.aborted) aborts++;
    else otherErr++;
    if (SPACING_MS > 0) await new Promise((res) => setTimeout(res, SPACING_MS));
  }
  const sorted = [...oks].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    label, method, samples: oks.length, requested: N,
    min: sorted[0], p50: pct(sorted, 50), p95: pct(sorted, 95),
    p99: pct(sorted, 99), max: sorted[sorted.length - 1],
    mean: oks.length ? sum / oks.length : NaN,
    over10s, errors: { http429, http410, http503, jsonRl, aborts, otherErr },
  };
}

function fmt(n) { return Number.isFinite(n) ? n.toFixed(1) : "n/a"; }

(async () => {
  console.log(`# issue-732 solana rpc latency probe`);
  console.log(`endpoint : ${ENDPOINT}${ENDPOINT === PUBLIC_DEFAULT ? "  (public default — no SOLANA_RPC_URL / helius override)" : ""}`);
  console.log(`n        : ${N} calls/series, spacing ${SPACING_MS}ms, per-call timeout ${PER_CALL_TIMEOUT_MS}ms`);
  console.log(`prod-timeout being evaluated: 10000ms (#706)`);
  console.log(`started  : ${new Date().toISOString()}\n`);

  const series = [
    await runSeries("getLatestBlockhash(confirmed)", "getLatestBlockhash", [{ commitment: "confirmed" }]),
    await runSeries("getHealth", "getHealth", []),
  ];

  for (const s of series) {
    console.log(`## ${s.label}`);
    console.log(`  ok samples : ${s.samples}/${s.requested}`);
    console.log(`  min/p50/p95/p99/max ms : ${fmt(s.min)} / ${fmt(s.p50)} / ${fmt(s.p95)} / ${fmt(s.p99)} / ${fmt(s.max)}`);
    console.log(`  mean ms    : ${fmt(s.mean)}`);
    console.log(`  >10s (would-abort under #706) : ${s.over10s}`);
    console.log(`  errors     : ${JSON.stringify(s.errors)}`);
    console.log("");
  }

  console.log(JSON.stringify({ endpoint: ENDPOINT, ts: new Date().toISOString(), series }, null, 2));
})();
