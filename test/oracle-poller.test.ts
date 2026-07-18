import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Tests for the background oracle poller. The poller fans
 * out to `getSolanaConnection().getAccountInfo` and calls
 * `parsePriceData` on the result; we mock both at module boundary
 * to control what each feed "returns".
 */

const tmpDir = mkdtempSync(join(tmpdir(), "vaultpilot-oracle-poller-"));
const HISTORY_PATH = join(tmpDir, "store.json");

// Track calls per feed.
const accountInfoMock = vi.fn();
vi.mock("../src/modules/solana/rpc.js", () => ({
  getSolanaConnection: () => ({ getAccountInfo: accountInfoMock }),
}));

// parsePriceData mock — return the data we set per-feed via responseFor.
const parsePriceDataMock = vi.fn();
vi.mock("@pythnetwork/client", () => ({
  parsePriceData: parsePriceDataMock,
  PriceStatus: {
    Unknown: 0,
    Trading: 1,
    Halted: 2,
    Auction: 3,
    Ignored: 4,
    1: "Trading",
    2: "Halted",
    3: "Auction",
    4: "Ignored",
    0: "Unknown",
  },
}));

const NOW_SEC = 1_750_000_000;

beforeEach(() => {
  process.env.VAULTPILOT_ORACLE_HISTORY_PATH = HISTORY_PATH;
  accountInfoMock.mockReset();
  parsePriceDataMock.mockReset();
  rmSync(HISTORY_PATH, { force: true });
  // Reset the history-module cache so the new path is picked up.
  return import("../src/modules/incidents/oracle-history.js").then((m) =>
    m._resetOracleHistoryCache(),
  );
});

afterEach(() => {
  rmSync(HISTORY_PATH, { force: true });
  delete process.env.VAULTPILOT_ORACLE_HISTORY_PATH;
});

describe("pollOnce — happy path", () => {
  it("appends a sample for each feed when parse succeeds with status=Trading", async () => {
    accountInfoMock.mockResolvedValue({ data: Buffer.from([0, 1, 2, 3]) });
    parsePriceDataMock.mockReturnValue({
      status: 1, // Trading
      price: 100,
      timestamp: BigInt(NOW_SEC),
    });
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const { getSampleCount } = await import("../src/modules/incidents/oracle-history.js");
    const { KNOWN_PYTH_FEEDS } = await import("../src/modules/incidents/solana-known.js");

    const result = await pollOnce();
    expect(result.ok).toBe(KNOWN_PYTH_FEEDS.length);
    expect(result.errors).toBe(0);
    for (const feed of KNOWN_PYTH_FEEDS) {
      expect(getSampleCount(feed.feedAddress)).toBe(1);
    }
  });
});

describe("pollOnce — failure modes (per-feed isolation)", () => {
  it("skips a feed when getAccountInfo returns null (account not found)", async () => {
    accountInfoMock.mockResolvedValue(null);
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const result = await pollOnce();
    expect(result.ok).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.details.every((d) => d.status === "skipped")).toBe(true);
    expect(result.details[0].reason).toBe("account not found");
  });

  it("skips a feed when status is not Trading", async () => {
    accountInfoMock.mockResolvedValue({ data: Buffer.from([0]) });
    parsePriceDataMock.mockReturnValue({
      status: 2, // Halted
      price: 100,
      timestamp: BigInt(NOW_SEC),
    });
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const result = await pollOnce();
    expect(result.ok).toBe(0);
    expect(result.details[0].status).toBe("skipped");
    expect(result.details[0].reason).toContain("status=");
  });

  it("skips a feed when parsed price is undefined (publisher uncertainty)", async () => {
    accountInfoMock.mockResolvedValue({ data: Buffer.from([0]) });
    parsePriceDataMock.mockReturnValue({
      status: 1,
      price: undefined,
      timestamp: BigInt(NOW_SEC),
    });
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const result = await pollOnce();
    expect(result.ok).toBe(0);
    expect(result.details[0].status).toBe("skipped");
  });

  it("skips a feed when timestamp is bogus", async () => {
    accountInfoMock.mockResolvedValue({ data: Buffer.from([0]) });
    parsePriceDataMock.mockReturnValue({
      status: 1,
      price: 100,
      timestamp: BigInt(0),
    });
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const result = await pollOnce();
    expect(result.ok).toBe(0);
    expect(result.details[0].status).toBe("skipped");
    expect(result.details[0].reason).toContain("bad timestamp");
  });

  it("records an error when getAccountInfo throws (one bad feed doesn't tank the poll)", async () => {
    accountInfoMock
      .mockRejectedValueOnce(new Error("RPC 429"))
      .mockResolvedValue({ data: Buffer.from([0]) });
    parsePriceDataMock.mockReturnValue({
      status: 1,
      price: 100,
      timestamp: BigInt(NOW_SEC),
    });
    const { pollOnce } = await import("../src/modules/incidents/oracle-poller.js");
    const { KNOWN_PYTH_FEEDS } = await import("../src/modules/incidents/solana-known.js");
    const result = await pollOnce();
    // First feed: error. Remaining: ok.
    expect(result.errors).toBe(1);
    expect(result.ok).toBe(KNOWN_PYTH_FEEDS.length - 1);
    const errored = result.details.filter((d) => d.status === "error");
    expect(errored.length).toBe(1);
    expect(errored[0].reason).toContain("RPC 429");
  });
});

describe("startOraclePoller — in-flight re-entrancy guard", () => {
  it("skips starting a new pollOnce while the previous tick hasn't settled (issue #697)", async () => {
    vi.useFakeTimers();
    try {
      // getAccountInfo never resolves — simulates a hung Solana RPC call,
      // so the first pollOnce() tick never settles.
      accountInfoMock.mockImplementation(() => new Promise(() => {}));
      const { startOraclePoller, stopOraclePoller } = await import(
        "../src/modules/incidents/oracle-poller.js"
      );
      const { KNOWN_PYTH_FEEDS } = await import("../src/modules/incidents/solana-known.js");

      startOraclePoller();
      // Cold-start poll fires immediately — one call per feed.
      expect(accountInfoMock).toHaveBeenCalledTimes(KNOWN_PYTH_FEEDS.length);

      await vi.advanceTimersByTimeAsync(60_000);
      await vi.advanceTimersByTimeAsync(60_000);

      // The in-flight guard should have skipped both subsequent ticks
      // since the cold-start pollOnce() never settled.
      expect(accountInfoMock).toHaveBeenCalledTimes(KNOWN_PYTH_FEEDS.length);

      stopOraclePoller();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("startOraclePoller — idempotency", () => {
  it("starting twice schedules only one timer (no double-poller)", async () => {
    const { startOraclePoller, stopOraclePoller } = await import(
      "../src/modules/incidents/oracle-poller.js"
    );
    accountInfoMock.mockResolvedValue(null); // skip — no samples appended
    startOraclePoller();
    startOraclePoller();
    startOraclePoller();
    // The first call fires a poll immediately; subsequent calls are no-ops.
    // We don't have a public API to introspect the timer; the smoke is
    // that the test doesn't hang and stop succeeds.
    stopOraclePoller();
    // Re-start after stop should work (resets the started-flag).
    startOraclePoller();
    stopOraclePoller();
  });
});
