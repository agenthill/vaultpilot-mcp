#!/usr/bin/env node
/**
 * p95 tool-call latency bench (issue #719).
 *
 * Resolves ARCHITECTURE.md §2's R1/R2/R3 from "structurally plausible,
 * UNMEASURED" to a measured pass/fail by actually invoking representative
 * `get_*` / `prepare_*` / `preview_send` tools against a self-hosted mock
 * EVM JSON-RPC endpoint with an injectable per-call delay, and computing
 * p50/p95 wall-clock latency per tool from real round trips.
 *
 * Spawn/handshake mechanics (spawn `dist/index.js` over stdio, MCP
 * `initialize` + `notifications/initialized`, newline-delimited JSON-RPC)
 * are mirrored from `scripts/bench-tools.mjs` (issue #637) — same pattern,
 * extended here to `tools/call` instead of just `tools/list`.
 *
 * ---------------------------------------------------------------------
 * Tool set (5 tools, all EVM/`chain: "ethereum"`, all demo-mode-safe —
 * chosen by reading each candidate's handler down to its RPC calls;
 * see the citations below):
 *
 *   get class (R1, budget 3s):
 *     - get_transaction_status  — src/modules/execution/index.ts
 *       `getTransactionStatus`. Pure RPC: `eth_getTransactionReceipt`
 *       then (on miss) `eth_getTransactionByHash`. No external HTTP.
 *       Ungated read tool (works identically in/out of demo mode).
 *     - get_token_metadata      — src/modules/balances/index.ts
 *       `getTokenMetadata`. Pure RPC: three `eth_call`s (symbol/name/
 *       decimals) + one `eth_getStorageAt` (EIP-1967 proxy probe). No
 *       external HTTP. Ungated read tool.
 *
 *   prepare class (R2, budget 8s):
 *     - prepare_native_send     — src/modules/execution/index.ts
 *       `prepareNativeSend` → `enrichTx`. RPC: `eth_call` (simulateTx,
 *       empty calldata), `eth_estimateGas`, `eth_gasPrice`. Empty
 *       calldata means `verifyEvmCalldata` short-circuits on "no-data"
 *       (src/signing/verify-decode.ts:147) — no 4byte.directory hop.
 *     - prepare_weth_unwrap     — src/modules/weth/actions.ts
 *       `buildWethUnwrap` → `enrichTx`. RPC: `eth_call` (balanceOf,
 *       single readContract — WETH hardcodes 18 decimals so no
 *       resolveTokenMeta/multicall path), `eth_call` (simulateTx,
 *       WETH.withdraw calldata), `eth_estimateGas`, `eth_gasPrice`.
 *       Non-empty calldata DOES hit `verifyEvmCalldata` →
 *       `fetch4byteSignatures` (src/data/apis/fourbyte.ts) — normally a
 *       real network call to 4byte.directory, here stubbed by the wired
 *       fetch shim. Deliberately included: most
 *       real prepare_* calls carry calldata (swaps/supplies/approvals),
 *       so this is the representative case, not the exception.
 *       Chosen over `prepare_token_send` specifically to avoid
 *       `resolveTokenMeta`'s `client.multicall` (Multicall3
 *       `aggregate3`) — mocking that ABI shape correctly is nontrivial
 *       apparatus this bench doesn't need when a non-multicall
 *       prepare_* tool already exercises the same calldata-bearing
 *       code path.
 *
 *   preview class (R3, budget 10s):
 *     - preview_send            — src/modules/execution/index.ts
 *       `previewSend`, run on a FRESH handle from `prepare_native_send`
 *       each iteration (a cached-pin re-call returns instantly and
 *       would understate real latency — see `pinSendFields`'s early
 *       return at `previewSend`'s top). RPC: `eth_chainId`
 *       (`verifyChainId` — memoized per chain for the process lifetime,
 *       so only the FIRST preview_send iteration pays it; this matches
 *       real long-running-server behavior, not a bench artifact),
 *       `eth_call` (simulateTx), then `pinSendFields`'s
 *       `eth_getTransactionCount` + `eth_getBlockByNumber("latest")` +
 *       `eth_maxPriorityFeePerGas` + `eth_estimateGas`. `preview_send`
 *       is registered directly, not via the generic `handler()` +
 *       `collectVerificationBlocks()` pipeline (src/index.ts ~1466), so
 *       it never calls `verifyEvmCalldata` / 4byte.directory regardless
 *       of calldata shape.
 *
 * FORMERLY-KNOWN CONFOUND, NOW STUBBED — DefiLlama gas-cost-USD lookup and
 * 4byte.directory calldata lookup:
 *   `enrichTx` (all prepare_*) and `computePreviewCost` (preview_send) both
 *   call `getTokenPrice(chain, "native")` → src/data/prices.ts
 *   `getTokenPrices`, a fetch to `https://coins.llama.fi` (10s timeout,
 *   src/data/http.ts `fetchWithTimeout`); `prepare_weth_unwrap`'s non-empty
 *   calldata additionally reaches `fetch4byteSignatures` →
 *   src/data/apis/fourbyte.ts, a fetch to `https://www.4byte.directory`
 *   (also a 10s timeout on failure). Left unmocked, an offline / firewalled
 *   bench host would pay up to two uncached ~10s timeouts on every affected
 *   iteration, inflating p95 for R2/R3 with a number that has nothing to do
 *   with `src/data/rpc.ts`'s RPC latency or the viem retry/backoff gap the
 *   issue calls out — indistinguishable from "RPC too slow" without digging
 *   into which host actually stalled.
 *   Both hosts are now stubbed to resolve instantly by
 *   `scripts/bench-latency-fetch-shim.cjs`, preloaded into the spawned
 *   server via `--require` (see `FETCH_SHIM_PATH` in `startMcpClient`
 *   below) — see that file for the stub responses. Every other host
 *   (including the mock RPC server itself) passes through to the real
 *   `fetch` unchanged.
 *
 * Env wiring (read from source, not guessed):
 *   - `ETHEREUM_RPC_URL`               src/config/chains.ts:33 (`ENV_URL_VAR`)
 *   - `VAULTPILOT_ALLOW_INSECURE_RPC=1` src/config/chains.ts:96,112,120
 *     (required — the mock is `http://127.0.0.1:PORT`, and
 *     `validateRpcUrl` rejects both non-https and loopback hosts unless
 *     this is set)
 *   - `VAULTPILOT_DEMO=true`           src/demo/index.ts:242
 *     (strict `=== "true"` gate; needed so `preview_send`'s
 *     `enforceEvmRecipientAuthorization` skips the WalletConnect
 *     account-match — see src/modules/execution/index.ts:1850 — since
 *     this bench has no paired wallet. `prepare_*` tools auto-select
 *     the "whale" demo persona on first call in demo mode
 *     (src/index.ts:1187), flipping live-mode on for the subsequent
 *     `preview_send` calls; our own explicit `wallet` arg is still what
 *     lands in `tx.from`, the persona selection only un-gates the call)
 *   - `VAULTPILOT_DISABLE_SKILL_AUTOINSTALL=1` src/setup/auto-install.ts:62
 *   - `VAULTPILOT_DISABLE_UPDATE_CHECK=1`      src/shared/version-check.ts:23
 *     (both idempotent first-call background hooks fired from every tool
 *     response — src/index.ts:913,919 — disabled so they don't add
 *     unrelated network noise to a "measure RPC latency" bench)
 *   - `VAULTPILOT_CHAIN_FAMILIES=evm`  src/config/scope.ts:151-152 (`isFamilyEnabled`)
 *   - `VAULTPILOT_PROTOCOLS=""`        src/config/scope.ts:151-152 (`isProtocolEnabled`)
 *     (set explicitly rather than left to inherit from the host shell's env
 *     via `...process.env` — an operator with e.g. `VAULTPILOT_CHAIN_FAMILIES=
 *     solana` set for their own daily use would otherwise silently deregister
 *     all three EVM-family tools this bench calls. All five benched tools are
 *     family `evm` with no protocol tag — see `getToolScope()` — so `evm` /
 *     `""` is both correct and independent of whatever the host has set.
 *     `VAULTPILOT_SCOPE` from an earlier revision of this script was a
 *     phantom var read by nothing; these two are the real gates.)
 *
 * Usage:
 *   npm run build                       # produce dist/ — NOT done by this script
 *   node scripts/bench-latency.mjs
 *   node scripts/bench-latency.mjs --iterations 10 --rpc-delay-ms 300
 *   node scripts/bench-latency.mjs --json bench/latency.json
 *   node scripts/bench-latency.mjs --enforce   # exit 1 on any class FAIL or INVALID
 *
 * Exit codes: 0 ok (or FAIL/INVALID without --enforce), 1 bench failure
 * (server crash, dist/ missing, malformed response, or a tools/call timeout
 * aborting the whole run — see ToolCallTimeoutError) or FAIL/INVALID-with-
 * --enforce. Default is report-only — no CI should gate on this until a
 * maintainer has run it once on a Node host. The DefiLlama/4byte confounds
 * are stubbed by the wired fetch shim (see the CONFOUNDS section above).
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const DIST_ENTRY = resolve(REPO_ROOT, "dist", "index.js");
const FETCH_SHIM_PATH = resolve(SCRIPT_DIR, "bench-latency-fetch-shim.cjs");

// ---------------------------------------------------------------------
// ARCHITECTURE.md §2 budgets (R1/R2/R3), transcribed verbatim from issue
// #719. This bench does NOT edit ARCHITECTURE.md's UNMEASURED verdict —
// that flip is the doc owner's call once real numbers exist (see PR body).
const BUDGETS_MS = {
  get: 3000, // R1
  prepare: 8000, // R2
  preview: 10000, // R3
};

// Synthetic, obviously-fake test fixtures. Digits only (no a-f letters)
// so EIP-55 checksum validation never enters into it either way.
const WALLET = "0x" + "11".repeat(20);
const RECIPIENT = "0x" + "22".repeat(20);
const TOKEN = "0x" + "33".repeat(20);
const FAKE_TX_HASH = "0x" + "44".repeat(32);

// ---------------------------------------------------------------------
// CLI

function parseArgs(argv) {
  const args = {
    iterations: 30,
    rpcDelayMs: 150,
    json: null,
    enforce: false,
    help: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--iterations") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--iterations requires a positive integer, got: ${argv[i]}`);
      }
      args.iterations = Math.floor(n);
    } else if (a === "--rpc-delay-ms") {
      const n = Number(argv[++i]);
      if (!Number.isFinite(n) || n < 0) {
        throw new Error(`--rpc-delay-ms requires a non-negative integer, got: ${argv[i]}`);
      }
      args.rpcDelayMs = Math.floor(n);
    } else if (a === "--json") {
      args.json = argv[++i];
    } else if (a === "--enforce") {
      args.enforce = true;
    } else if (a === "--help" || a === "-h") {
      args.help = true;
    } else {
      throw new Error(`Unknown flag: ${a}`);
    }
  }
  return args;
}

function printHelp() {
  process.stdout.write(
    [
      "bench-latency — measure p95 tool-call latency against a mock EVM RPC",
      "",
      "Usage:",
      "  node scripts/bench-latency.mjs                          Report-only, default settings",
      "  node scripts/bench-latency.mjs --iterations N           Iterations per tool (default 30)",
      "  node scripts/bench-latency.mjs --rpc-delay-ms N         Per-RPC-call mock delay (default 150)",
      "  node scripts/bench-latency.mjs --json FILE              Also write machine-readable JSON to FILE",
      "  node scripts/bench-latency.mjs --enforce                Exit 1 if any class FAILs its budget or is INVALID",
      "  node scripts/bench-latency.mjs --help                   This message",
      "",
      "Requires a built dist/index.js (run `npm run build` first — this script never builds).",
      "",
    ].join("\n"),
  );
}

// ---------------------------------------------------------------------
// Percentile helper. Nearest-rank method: sort ascending, take the
// ceil(p/100 * n)-th smallest (1-indexed), clamped to [0, n-1].
// Examples: percentile([10,20,30,40,50], 50) === 30 (3rd of 5, index 2)
//           percentile([10,20,30,40,50], 95) === 50 (5th of 5, index 4)
//           percentile([1..30 ascending], 95) === 29th value (index 28)
function percentile(sortedAscending, p) {
  const n = sortedAscending.length;
  if (n === 0) return NaN;
  const idx = Math.min(Math.max(Math.ceil((p / 100) * n) - 1, 0), n - 1);
  return sortedAscending[idx];
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---------------------------------------------------------------------
// Minimal ABI word encoding for the mock `eth_call` responder. Only
// covers what the chosen tool set's RPC calls actually decode:
// decimals() -> uint8, symbol()/name() -> string, balanceOf(address) ->
// uint256. Everything else (empty calldata from simulateTx on a native
// send, ERC-20 transfer()/WETH withdraw() calldata from simulateTx —
// `client.call()` never ABI-decodes its result) gets a generic "0x".

function padWord(hexNoPrefix) {
  return hexNoPrefix.padStart(64, "0");
}

function uintWord(value) {
  return padWord(BigInt(value).toString(16));
}

function stringReturn(str) {
  const bytes = Buffer.from(str, "utf8");
  const lenWord = uintWord(bytes.length);
  let dataHex = bytes.toString("hex");
  const rem = dataHex.length % 64;
  if (rem !== 0) dataHex += "0".repeat(64 - rem);
  const offsetWord = uintWord(0x20);
  return "0x" + offsetWord + lenWord + dataHex;
}

const SELECTOR_DECIMALS = "0x313ce567"; // decimals()
const SELECTOR_SYMBOL = "0x95d89b41"; // symbol()
const SELECTOR_NAME = "0x06fdde03"; // name()
const SELECTOR_BALANCEOF = "0x70a08231"; // balanceOf(address)

const MOCK_DECIMALS = 18;
const MOCK_SYMBOL = "MOCK";
const MOCK_NAME = "Mock Token";
const MOCK_BALANCE_WEI = 5_000_000_000_000_000_000n; // 5 tokens @ 18 decimals — comfortably above any bench amount

function mockEthCallResult(data) {
  if (!data || data === "0x" || data.length < 10) return "0x";
  const selector = data.slice(0, 10).toLowerCase();
  switch (selector) {
    case SELECTOR_DECIMALS:
      return "0x" + uintWord(MOCK_DECIMALS);
    case SELECTOR_SYMBOL:
      return stringReturn(MOCK_SYMBOL);
    case SELECTOR_NAME:
      return stringReturn(MOCK_NAME);
    case SELECTOR_BALANCEOF:
      return "0x" + uintWord(MOCK_BALANCE_WEI);
    default:
      // e.g. ERC-20 transfer()/WETH withdraw() calldata reaching
      // simulateTx's low-level `client.call()` — it never ABI-decodes
      // the response, so any valid hex string is fine here.
      return "0x";
  }
}

// ---------------------------------------------------------------------
// Mock EVM JSON-RPC server. One handler per method actually exercised by
// the chosen tool set (PR #834 review dropped the eth_blockNumber /
// eth_feeHistory / eth_getBalance branches this used to also carry —
// re-verified against every benched handler's RPC calls: none reach
// them, so they were dead code, not defensive coverage). Every response
// is delayed by `rpcDelayMs` to simulate realistic provider latency;
// unknown methods get a loud JSON-RPC error instead of silently hanging.

function buildMockBlock() {
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    number: "0x112a880",
    hash: "0x" + "ab".repeat(32),
    parentHash: "0x" + "cd".repeat(32),
    nonce: "0x0000000000000000",
    sha3Uncles: "0x01dcc4de8dec75d7aab85b567b6ccd41ad312451b948a7413f0a142fd40d4934",
    logsBloom: "0x" + "00".repeat(256),
    transactionsRoot: "0x" + "00".repeat(32),
    stateRoot: "0x" + "00".repeat(32),
    receiptsRoot: "0x" + "00".repeat(32),
    miner: "0x0000000000000000000000000000000000000000",
    difficulty: "0x0",
    totalDifficulty: "0x0",
    extraData: "0x",
    size: "0x0",
    gasLimit: "0x1c9c380",
    gasUsed: "0xdbba0",
    timestamp: "0x" + nowSec.toString(16),
    transactions: [],
    uncles: [],
    baseFeePerGas: "0x3b9aca00", // 1 gwei
  };
}

function dispatchRpc(method, params) {
  switch (method) {
    case "eth_chainId":
      return { ok: true, result: "0x1" }; // CHAIN_IDS.ethereum (src/types/index.ts:48)
    case "eth_getBlockByNumber":
      return { ok: true, result: buildMockBlock() };
    case "eth_getTransactionCount":
      return { ok: true, result: "0x3" };
    case "eth_estimateGas":
      return { ok: true, result: "0x5208" }; // 21000, value is arbitrary — only shape matters
    case "eth_gasPrice":
      return { ok: true, result: "0x3b9aca00" };
    case "eth_maxPriorityFeePerGas":
      return { ok: true, result: "0x3b9aca00" };
    case "eth_call":
      return { ok: true, result: mockEthCallResult(params?.[0]?.data) };
    case "eth_getStorageAt":
      return { ok: true, result: "0x" + "0".repeat(64) }; // empty slot -> not a proxy
    case "eth_getTransactionReceipt":
    case "eth_getTransactionByHash":
      return { ok: true, result: null }; // "not found" — exercises getTransactionStatus's fallback path
    default:
      return {
        ok: false,
        error: { code: -32601, message: `bench-latency mock: method not implemented: ${method}` },
      };
  }
}

function startMockRpcServer(rpcDelayMs) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }));
        return;
      }
      const requests = Array.isArray(body) ? body : [body];
      setTimeout(() => {
        const responses = requests.map((r) => {
          const { ok, result, error } = dispatchRpc(r.method, r.params);
          return ok
            ? { jsonrpc: "2.0", id: r.id, result }
            : { jsonrpc: "2.0", id: r.id, error };
        });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(Array.isArray(body) ? responses : responses[0]));
      }, rpcDelayMs);
    });
  });
  return new Promise((resolvePromise, rejectPromise) => {
    server.on("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolvePromise({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// ---------------------------------------------------------------------
// MCP client: spawn dist/index.js, do the initialize handshake, then
// expose a callTool() that sends tools/call and resolves on the
// matching-id response. Spawn/handshake mirrors scripts/bench-tools.mjs.

function send(child, msg) {
  child.stdin.write(JSON.stringify(msg) + "\n");
}

/**
 * Thrown when a `tools/call` fails to answer within its timeout. This is
 * deliberately NOT treated like an ordinary tool error (see timeCall()):
 * giving up on waiting for a response doesn't mean the server gave up on
 * producing one. The MCP server keeps running the handler after we stop
 * waiting, and every EVM RPC call it makes goes through a per-chain,
 * cap-2 semaphore (src/data/rpc.ts, RPC_CONCURRENCY_DEFAULT) shared by
 * every tool this bench calls (all five run on "ethereum"). A single
 * stuck call can permanently occupy one of only two slots, so every
 * subsequent measurement — in the current tool's loop AND every later
 * one — would queue behind it and read as corrupted-slow rather than
 * reflecting real RPC latency. Surfacing this as a thrown error (instead
 * of a recorded per-call failure) propagates out of runTool() and main()
 * to the top-level `main().catch()` handler, aborting the entire run.
 */
class ToolCallTimeoutError extends Error {
  constructor(name, timeoutMs) {
    super(
      `tools/call "${name}" timed out after ${timeoutMs}ms — aborting the entire bench (INVALID ` +
        `run): the server may still be working through this call via its cap-2 per-chain RPC ` +
        `semaphore (src/data/rpc.ts) even though we gave up waiting, so every measurement after ` +
        `this point would be corrupted by queuing behind it.`,
    );
    this.name = "ToolCallTimeoutError";
  }
}

async function startMcpClient(rpcUrl) {
  if (!existsSync(DIST_ENTRY)) {
    throw new Error(
      `dist/index.js not found at ${DIST_ENTRY} — run \`npm run build\` first. ` +
        `This bench never builds the project itself.`,
    );
  }

  // --require (not --import — see FETCH_SHIM_PATH's own header for why)
  // preloads the fetch-stubbing shim before dist/index.js's top-level code
  // runs, so coins.llama.fi / www.4byte.directory are already stubbed for
  // every call the server makes from its very first tool invocation.
  const child = spawn(process.execPath, ["--require", FETCH_SHIM_PATH, DIST_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      ETHEREUM_RPC_URL: rpcUrl, // src/config/chains.ts:33 ENV_URL_VAR.ethereum
      VAULTPILOT_ALLOW_INSECURE_RPC: "1", // src/config/chains.ts:96,112,120 — mock is http+loopback
      VAULTPILOT_DEMO: "true", // src/demo/index.ts:242 — strict literal gate
      VAULTPILOT_DISABLE_SKILL_AUTOINSTALL: "1", // src/setup/auto-install.ts:62
      VAULTPILOT_DISABLE_UPDATE_CHECK: "1", // src/shared/version-check.ts:23
      // src/config/scope.ts:151-152 — explicit, not left to `...process.env`
      // inheritance, so a host operator's own scope config can't silently
      // deregister the EVM-family tools this bench calls (see header).
      VAULTPILOT_CHAIN_FAMILIES: "evm",
      VAULTPILOT_PROTOCOLS: "",
    },
  });

  let stdoutBuf = "";
  let stderrBuf = "";
  let nextId = 2; // 1 is the initialize handshake
  const pending = new Map();
  let crashed = null;

  child.stderr.on("data", (chunk) => {
    stderrBuf += chunk.toString("utf8");
  });

  child.on("exit", (code, signal) => {
    crashed = `server exited (code=${code}, signal=${signal}). stderr tail:\n${stderrBuf.slice(-2000)}`;
    for (const { reject } of pending.values()) {
      reject(new Error(crashed));
    }
    pending.clear();
  });

  let readyResolve;
  const ready = new Promise((res, rej) => {
    const handshakeTimer = setTimeout(() => rej(new Error("initialize handshake timed out after 30s")), 30_000);
    handshakeTimer.unref?.(); // never hold the process open on this alone
    readyResolve = () => {
      clearTimeout(handshakeTimer);
      res();
    };
  });

  child.stdout.on("data", (chunk) => {
    stdoutBuf += chunk.toString("utf8");
    let nl;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      if (msg.id === 1 && msg.result) {
        send(child, { jsonrpc: "2.0", method: "notifications/initialized" });
        readyResolve();
        continue;
      }
      const waiter = pending.get(msg.id);
      if (waiter) {
        pending.delete(msg.id);
        if (msg.error) {
          waiter.reject(new Error(`tools/call error: ${JSON.stringify(msg.error)}`));
        } else {
          waiter.resolve(msg.result);
        }
      }
    }
  });

  send(child, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "vaultpilot-bench-latency", version: "0.0.0" },
    },
  });

  await ready;

  async function callTool(name, args, timeoutMs = 30_000) {
    if (crashed) throw new Error(crashed);
    const id = nextId++;
    const p = new Promise((res, rej) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
          rej(new ToolCallTimeoutError(name, timeoutMs));
        }
      }, timeoutMs);
      timer.unref?.(); // never hold the process open on this alone
      // Wrap resolve/reject so a normal response (the stdout handler above)
      // clears this timer instead of leaving it to fire uselessly later.
      pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          res(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rej(e);
        },
      });
    });
    send(child, { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
    return p;
  }

  function shutdown() {
    child.kill("SIGTERM");
  }

  return { callTool, shutdown };
}

function firstJson(callToolResult) {
  const block = callToolResult?.content?.[0];
  if (!block || block.type !== "text") return undefined;
  try {
    return JSON.parse(block.text);
  } catch {
    return undefined;
  }
}

function firstText(callToolResult) {
  const block = callToolResult?.content?.[0];
  return block?.type === "text" ? block.text : undefined;
}

/**
 * Mint one fresh `prepare_native_send` handle, UNTIMED, for immediate
 * consumption by the very next `preview_send` call (see PR #834 review,
 * BLOCKER 2). Handles expire TX_TTL_MS (15 min) after mint
 * (src/signing/tx-store.ts:20); minting a whole iteration's worth up front
 * — as this bench originally did — let later handles sit unconsumed behind
 * every earlier prepare_*/preview_send iteration's latency, risking expiry
 * before `preview_send` ever got to them. Minting one handle right before
 * timing the `preview_send` call that consumes it keeps every handle's
 * mint-to-consume gap to a single round trip, well inside the TTL.
 *
 * Returns the handle string, or `undefined` on any failure (propagated by
 * the caller as a recorded error, not a silent skip — see runTool()).
 */
async function mintNativeSendHandle(mcp) {
  try {
    const res = await mcp.callTool("prepare_native_send", {
      wallet: WALLET,
      chain: "ethereum",
      to: RECIPIENT,
      amount: "0.001",
    });
    if (res?.isError) return undefined;
    const result = firstJson(res);
    return result?.handle ?? undefined;
  } catch (err) {
    if (err instanceof ToolCallTimeoutError) throw err; // abort the whole bench — see class doc
    return undefined;
  }
}

// ---------------------------------------------------------------------
// Benchmark runner

async function timeCall(mcp, name, args) {
  const t0 = process.hrtime.bigint();
  let ok = true;
  let errorMessage;
  let result;
  try {
    const res = await mcp.callTool(name, args);
    if (res?.isError) {
      ok = false;
      errorMessage = (firstText(res) ?? "unknown error").slice(0, 300);
    } else {
      result = firstJson(res);
    }
  } catch (err) {
    if (err instanceof ToolCallTimeoutError) throw err; // abort the whole bench — see class doc
    ok = false;
    errorMessage = String(err?.message ?? err).slice(0, 300);
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { ms, ok, errorMessage, result };
}

async function runTool(mcp, className, name, argsFn, iterations, onResult) {
  const durations = []; // timed sample — successful calls ONLY (see verdict())
  let attempted = 0;
  let errors = 0;
  let lastError;
  for (let i = 0; i < iterations; i++) {
    const args = await argsFn(i);
    if (args === null) break; // argsFn signals the input supply is exhausted — stop early
    attempted++;
    if (args === undefined) {
      // argsFn signals its own untimed setup step failed (e.g. preview_send
      // couldn't mint a fresh prepare_native_send handle for this iteration)
      // — count it as an attempt + error without spending a timed tools/call
      // on input we already know is bad.
      errors++;
      lastError = "setup step failed before the timed call (see argsFn)";
      if (onResult) onResult({ ms: 0, ok: false, errorMessage: lastError });
      continue;
    }
    const call = await timeCall(mcp, name, args);
    if (call.ok) {
      durations.push(call.ms);
    } else {
      errors++;
      lastError = call.errorMessage;
    }
    if (onResult) onResult(call);
  }
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    tool: name,
    class: className,
    n: durations.length,
    attempted,
    iterations,
    errors,
    lastError,
    p50: round1(percentile(sorted, 50)),
    p95: round1(percentile(sorted, 95)),
    max: durations.length ? round1(sorted[sorted.length - 1]) : NaN,
  };
}

// A tool's timing sample is only meaningful when every requested iteration
// both ran AND succeeded — a failed call has no valid duration to rank, and
// fewer attempts than requested (preview_send running out of mintable
// handles, a mid-run abort, etc.) means the p95 is computed over a smaller,
// silently-biased sample. Either condition makes the PASS/FAIL budget
// comparison meaningless, so it's surfaced as its own verdict rather than
// folded into FAIL (which would misreport "too slow" for "didn't run").
function verdict(stat) {
  if (stat.errors > 0 || stat.n < stat.iterations) return "INVALID";
  if (!Number.isFinite(stat.p95)) return "N/A";
  return stat.p95 <= BUDGETS_MS[stat.class] ? "PASS" : "FAIL";
}

function formatTable(stats) {
  const header = ["tool", "class", "n", "errors", "p50(ms)", "p95(ms)", "max(ms)", "budget(ms)", "verdict"];
  const rows = stats.map((s) => [
    s.tool,
    s.class,
    String(s.n),
    String(s.errors),
    String(s.p50),
    String(s.p95),
    String(s.max),
    String(BUDGETS_MS[s.class]),
    verdict(s),
  ]);
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
  const line = (cols) => cols.map((c, i) => c.padEnd(widths[i])).join("  ");
  const out = [line(header), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) out.push(line(r));

  out.push("");
  out.push(
    "Class rollup (ARCHITECTURE.md §2 — PASS iff every tool in the class PASSes; " +
      "INVALID iff any tool in the class has errors or an incomplete sample):",
  );
  for (const cls of ["get", "prepare", "preview"]) {
    const inClass = stats.filter((s) => s.class === cls);
    let classVerdict;
    if (inClass.length === 0) {
      classVerdict = "N/A";
    } else if (inClass.some((s) => verdict(s) === "INVALID")) {
      classVerdict = "INVALID";
    } else {
      classVerdict = inClass.every((s) => verdict(s) === "PASS") ? "PASS" : "FAIL";
    }
    out.push(`  ${cls.padEnd(8)} budget ${BUDGETS_MS[cls]}ms  -> ${classVerdict}`);
  }
  return out.join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    process.stderr.write(`bench-latency: ${err.message}\n`);
    printHelp();
    process.exit(2);
  }
  if (args.help) {
    printHelp();
    return;
  }

  const { server, url } = await startMockRpcServer(args.rpcDelayMs);
  let mcp;
  try {
    mcp = await startMcpClient(url);

    const stats = [];

    stats.push(
      await runTool(mcp, "get", "get_transaction_status", () => ({ chain: "ethereum", txHash: FAKE_TX_HASH }), args.iterations),
    );

    stats.push(
      await runTool(mcp, "get", "get_token_metadata", () => ({ address: TOKEN, chain: "ethereum" }), args.iterations),
    );

    // Must run before preview_send below: the first prepare_* call in demo
    // mode auto-selects the whale persona and flips live mode on
    // (index.ts:1187) — preview_send's own per-iteration prepare_native_send
    // mint calls (mintNativeSendHandle) depend on that having already run.
    stats.push(
      await runTool(
        mcp,
        "prepare",
        "prepare_native_send",
        () => ({ wallet: WALLET, chain: "ethereum", to: RECIPIENT, amount: "0.001" }),
        args.iterations,
      ),
    );

    stats.push(
      await runTool(
        mcp,
        "prepare",
        "prepare_weth_unwrap",
        () => ({ wallet: WALLET, chain: "ethereum", amount: "0.001" }),
        args.iterations,
      ),
    );

    stats.push(
      await runTool(
        mcp,
        "preview",
        "preview_send",
        // Mint a FRESH handle immediately before timing each preview_send
        // call (untimed — see mintNativeSendHandle's doc comment) rather
        // than reusing a batch of handles minted earlier. `undefined` here
        // means the mint failed, which runTool() records as an error for
        // this iteration without spending a timed tools/call on it.
        async () => {
          const handle = await mintNativeSendHandle(mcp);
          return handle ? { handle } : undefined;
        },
        args.iterations,
      ),
    );

    const table = formatTable(stats);
    process.stdout.write(table + "\n");

    if (args.json) {
      const outPath = resolve(REPO_ROOT, args.json);
      await mkdir(dirname(outPath), { recursive: true });
      const payload = {
        generatedAt: new Date().toISOString(),
        iterations: args.iterations,
        rpcDelayMs: args.rpcDelayMs,
        budgetsMs: BUDGETS_MS,
        results: stats.map((s) => ({ ...s, verdict: verdict(s) })),
      };
      await writeFile(outPath, JSON.stringify(payload, null, 2) + "\n", "utf8");
      process.stderr.write(`bench-latency: wrote JSON report to ${outPath}\n`);
    }

    const anyFailOrInvalid = stats.some((s) => verdict(s) === "FAIL" || verdict(s) === "INVALID");
    if (anyFailOrInvalid && args.enforce) {
      process.stderr.write(
        "bench-latency: --enforce set and at least one tool FAILed its budget or was INVALID " +
          "(errors, or fewer completed iterations than requested).\n",
      );
      process.exitCode = 1;
    }
  } finally {
    mcp?.shutdown();
    server.close();
  }
}

main().catch((err) => {
  process.stderr.write(`bench-latency failed: ${err?.stack ?? err}\n`);
  process.exit(1);
});
