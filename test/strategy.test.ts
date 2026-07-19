/**
 * `share_strategy` + `import_strategy` round-trip + privacy tests.
 *
 * The single most important invariant — "no addresses, no tx hashes,
 * ever" — is exercised by injecting real wallet/contract/tx-hash
 * strings into every plausible fields the share path touches and
 * asserting either:
 *   - they get stripped by the serializer (positions[] never carries
 *     them), or
 *   - if they slip through into a user-supplied free-form field, the
 *     redaction scan throws `RedactionError` BEFORE any JSON is
 *     returned to the agent.
 *
 * Round-trip: share → JSON.stringify → JSON.parse → import produces an
 * equivalent strategy (same positions, same meta).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const getPortfolioSummaryMock = vi.fn();

vi.mock("../src/modules/portfolio/index.ts", () => ({
  getPortfolioSummary: (...a: unknown[]) => getPortfolioSummaryMock(...a),
}));

const WALLET = "0x000000000000000000000000000000000000dEaD";
const HOSTILE_EVM = "0xC0fFee0000000000000000000000000000000000";
const HOSTILE_TRON = "TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7";
const HOSTILE_SOLANA = "DjVE6JNiYqPL2QXyCUUh8rNjHrbz9hXHNYt94Wdcuh1S";
const HOSTILE_TX_HASH =
  "0xabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789";

/** Canonical "1 ETH @ $4000 + 1000 USDC supplied on Aave V3" portfolio. */
function aPortfolioWithEthAndAaveSupply() {
  return {
    wallet: WALLET,
    chains: ["ethereum"],
    walletBalancesUsd: 4000,
    lendingNetUsd: 1000,
    lpUsd: 0,
    stakingUsd: 0,
    totalUsd: 5000,
    perChain: { ethereum: 5000 },
    breakdown: {
      native: [
        {
          token: "0x0000000000000000000000000000000000000000",
          symbol: "ETH",
          decimals: 18,
          amount: "1000000000000000000",
          formatted: "1.0",
          priceUsd: 4000,
          valueUsd: 4000,
        },
      ],
      erc20: [],
      lending: [
        {
          protocol: "aave-v3",
          chain: "ethereum",
          collateral: [
            {
              token: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
              symbol: "USDC",
              decimals: 6,
              amount: "1000000000",
              formatted: "1000.0",
              priceUsd: 1,
              valueUsd: 1000,
            },
          ],
          debt: [],
          totalCollateralUsd: 1000,
          totalDebtUsd: 0,
          netValueUsd: 1000,
          healthFactor: Infinity,
          liquidationThreshold: 8500,
          ltv: 8000,
        },
      ],
      lp: [],
      staking: [],
    },
    coverage: {},
  };
}

beforeEach(() => {
  getPortfolioSummaryMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("shareStrategy — input validation", () => {
  it("throws when no address is supplied", async () => {
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    await expect(
      shareStrategy({ name: "test" }),
    ).rejects.toThrow(/At least one of `wallet`/);
  });
});

describe("shareStrategy — happy path", () => {
  it("emits a SharedStrategy with one supply + one balance row, no addresses", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    const r = await shareStrategy({
      wallet: WALLET,
      name: "Conservative ETH + stable supply",
      description: "1 ETH held + USDC on Aave for some yield",
      authorLabel: "alice",
      riskProfile: "conservative",
    });
    expect(r.strategy.version).toBe(1);
    expect(r.strategy.meta.name).toBe("Conservative ETH + stable supply");
    expect(r.strategy.meta.authorLabel).toBe("alice");
    expect(r.strategy.meta.riskProfile).toBe("conservative");
    expect(r.strategy.meta.chains).toEqual(["ethereum"]);
    // Two non-zero positions: 1 ETH (80% of $5k) + 1000 USDC supply (20%).
    expect(r.strategy.positions).toHaveLength(2);
    const eth = r.strategy.positions.find((p) => p.asset === "ETH")!;
    const usdcSupply = r.strategy.positions.find(
      (p) => p.asset === "USDC" && p.kind === "supply",
    )!;
    expect(eth.kind).toBe("balance");
    expect(eth.protocol).toBe("wallet");
    expect(eth.pctOfTotal).toBe(80);
    expect(usdcSupply.protocol).toBe("aave-v3");
    expect(usdcSupply.pctOfTotal).toBe(20);
    // No address ever in jsonString (that's the whole point).
    expect(r.jsonString).not.toContain(WALLET);
    expect(r.jsonString).not.toContain("0xA0b86991");
    // Sorted desc by pctOfTotal — dominant piece first.
    expect(r.strategy.positions[0].pctOfTotal).toBeGreaterThanOrEqual(
      r.strategy.positions[1].pctOfTotal,
    );
  });

  it("anonymous mode (no authorLabel) emits no identifier", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    const r = await shareStrategy({
      wallet: WALLET,
      name: "Anonymous strategy",
    });
    expect(r.strategy.meta.authorLabel).toBeUndefined();
    // No "authorLabel" key surfaces at all in the serialized form.
    expect(r.jsonString).not.toContain("authorLabel");
  });

  it("includes healthFactor on borrow rows when there's debt", async () => {
    const summary = aPortfolioWithEthAndAaveSupply();
    summary.breakdown.lending[0].debt = [
      {
        token: "0xdAC17F958D2ee523a2206206994597C13D831ec7",
        symbol: "USDT",
        decimals: 6,
        amount: "200000000",
        formatted: "200.0",
        priceUsd: 1,
        valueUsd: 200,
      },
    ];
    summary.breakdown.lending[0].totalDebtUsd = 200;
    summary.breakdown.lending[0].netValueUsd = 800;
    summary.breakdown.lending[0].healthFactor = 1.7234;
    summary.totalUsd = 4800;
    getPortfolioSummaryMock.mockResolvedValue(summary);
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    const r = await shareStrategy({ wallet: WALLET, name: "leveraged" });
    const borrow = r.strategy.positions.find((p) => p.kind === "borrow");
    expect(borrow).toBeDefined();
    // Rounded to 2 decimals — fingerprint defense.
    expect(borrow!.healthFactor).toBe(1.72);
  });

  it("notes contain the v1 caveats", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    const r = await shareStrategy({ wallet: WALLET, name: "test" });
    const joined = r.strategy.notes.join("\n");
    expect(joined).toMatch(/percentage/i);
    expect(joined).toMatch(/fingerprint/i);
    expect(joined).toMatch(/structure/i);
  });
});

describe("shareStrategy — redaction guard", () => {
  it("throws RedactionError when an EVM address slips into the strategy name", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, RedactionError } = await import(
      "../src/modules/strategy/index.ts"
    );
    await expect(
      shareStrategy({
        wallet: WALLET,
        name: `My setup at ${HOSTILE_EVM}`,
      }),
    ).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError when a TRON address is in the description", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, RedactionError } = await import(
      "../src/modules/strategy/index.ts"
    );
    await expect(
      shareStrategy({
        wallet: WALLET,
        name: "test",
        description: `Visit ${HOSTILE_TRON} for details`,
      }),
    ).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError when a Solana base58 address is in authorLabel", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, RedactionError } = await import(
      "../src/modules/strategy/index.ts"
    );
    await expect(
      shareStrategy({
        wallet: WALLET,
        name: "test",
        authorLabel: HOSTILE_SOLANA,
      }),
    ).rejects.toBeInstanceOf(RedactionError);
  });

  it("throws RedactionError when a 64-hex tx hash is in the description", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, RedactionError } = await import(
      "../src/modules/strategy/index.ts"
    );
    await expect(
      shareStrategy({
        wallet: WALLET,
        name: "test",
        description: `My favorite tx: ${HOSTILE_TX_HASH}`,
      }),
    ).rejects.toBeInstanceOf(RedactionError);
  });

  it("does NOT throw when the strategy contains only structural data", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy } = await import("../src/modules/strategy/index.ts");
    await expect(
      shareStrategy({
        wallet: WALLET,
        name: "Pure structure — no leak",
        description: "All-stables ladder with 80/20 yield mix.",
      }),
    ).resolves.toBeDefined();
  });
});

describe("importStrategy — round-trip", () => {
  it("parses a freshly-emitted JSON string back to an equivalent strategy", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, importStrategy } = await import(
      "../src/modules/strategy/index.ts"
    );
    const shared = await shareStrategy({
      wallet: WALLET,
      name: "Round-trip test",
      authorLabel: "alice",
      riskProfile: "moderate",
    });
    const imported = await importStrategy({ json: shared.jsonString });
    expect(imported.strategy.version).toBe(shared.strategy.version);
    expect(imported.strategy.meta.name).toBe(shared.strategy.meta.name);
    expect(imported.strategy.meta.authorLabel).toBe("alice");
    expect(imported.strategy.meta.riskProfile).toBe("moderate");
    expect(imported.strategy.meta.chains).toEqual(shared.strategy.meta.chains);
    expect(imported.strategy.positions).toHaveLength(
      shared.strategy.positions.length,
    );
    for (let i = 0; i < imported.strategy.positions.length; i++) {
      expect(imported.strategy.positions[i].asset).toBe(
        shared.strategy.positions[i].asset,
      );
      expect(imported.strategy.positions[i].pctOfTotal).toBe(
        shared.strategy.positions[i].pctOfTotal,
      );
    }
  });

  it("accepts the parsed-object form too", async () => {
    getPortfolioSummaryMock.mockResolvedValue(aPortfolioWithEthAndAaveSupply());
    const { shareStrategy, importStrategy } = await import(
      "../src/modules/strategy/index.ts"
    );
    const shared = await shareStrategy({ wallet: WALLET, name: "obj form" });
    const imported = await importStrategy({ json: shared.strategy as unknown as Record<string, unknown> });
    expect(imported.strategy.meta.name).toBe("obj form");
  });
});

describe("importStrategy — privacy + validation", () => {
  it("throws RedactionError when a hostile JSON contains an embedded address", async () => {
    const { importStrategy, RedactionError } = await import(
      "../src/modules/strategy/index.ts"
    );
    const hostile = {
      version: 1,
      meta: {
        name: "innocent",
        createdIso: "2026-04-26T12:00:00.000Z",
        chains: ["ethereum"],
      },
      positions: [
        {
          protocol: "wallet",
          chain: "ethereum",
          kind: "balance",
          // Address smuggled into asset symbol.
          asset: HOSTILE_EVM,
          pctOfTotal: 50,
        },
      ],
      notes: [],
    };
    await expect(
      importStrategy({ json: hostile as unknown as Record<string, unknown> }),
    ).rejects.toBeInstanceOf(RedactionError);
  });

  it("rejects malformed JSON", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    await expect(
      importStrategy({ json: "not-valid-json{{" }),
    ).rejects.toThrow(/did not parse/);
  });

  it("rejects unsupported version", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const future = {
      version: 99,
      meta: {
        name: "from the future",
        createdIso: "2030-01-01T00:00:00.000Z",
        chains: [],
      },
      positions: [],
      notes: [],
    };
    await expect(
      importStrategy({ json: future as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/version 99/);
  });

  it("rejects missing meta.name", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const broken = {
      version: 1,
      meta: { createdIso: "2026-04-26T12:00:00.000Z", chains: [] },
      positions: [],
      notes: [],
    };
    await expect(
      importStrategy({ json: broken as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/meta.name/);
  });

  it("rejects bad position kind", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const broken = {
      version: 1,
      meta: {
        name: "x",
        createdIso: "2026-04-26T12:00:00.000Z",
        chains: ["ethereum"],
      },
      positions: [
        {
          protocol: "wallet",
          chain: "ethereum",
          kind: "leveraged-yolo", // not in the allowed set
          asset: "ETH",
          pctOfTotal: 100,
        },
      ],
      notes: [],
    };
    await expect(
      importStrategy({ json: broken as unknown as Record<string, unknown> }),
    ).rejects.toThrow(/kind/);
  });
});

describe("importStrategy — strict-shape gate (issue #557)", () => {
  /** Shorthand for a minimum-valid v1 strategy we can mutate per test. */
  function aValidStrategy(): Record<string, unknown> {
    return {
      version: 1,
      meta: {
        name: "x",
        createdIso: "2026-04-26T12:00:00.000Z",
        chains: ["ethereum"],
      },
      positions: [
        {
          protocol: "wallet",
          chain: "ethereum",
          kind: "balance",
          asset: "ETH",
          pctOfTotal: 100,
        },
      ],
      notes: [],
    };
  }

  it("refuses unknown top-level keys (e.g. _delegateAuthority)", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const hostile = aValidStrategy();
    hostile._delegateAuthority = "0xDeadBeef";
    await expect(
      importStrategy({ json: hostile }),
    ).rejects.toThrow(/STRATEGY_UNKNOWN_KEY_REJECTED.*strategy root.*_delegateAuthority/s);
  });

  it("refuses unknown nested keys under meta (e.g. _executor)", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const hostile = aValidStrategy();
    (hostile.meta as Record<string, unknown>)._executor = "Bob";
    await expect(
      importStrategy({ json: hostile }),
    ).rejects.toThrow(/STRATEGY_UNKNOWN_KEY_REJECTED.*strategy\.meta.*_executor/s);
  });

  it("refuses unknown nested keys under positions[]", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const hostile = aValidStrategy();
    (hostile.positions as Array<Record<string, unknown>>)[0]._delegate = "Bob";
    await expect(
      importStrategy({ json: hostile }),
    ).rejects.toThrow(/STRATEGY_UNKNOWN_KEY_REJECTED.*strategy\.positions\[\].*_delegate/s);
  });

  it("refuses non-underscore unknown keys too (the gate is whitelist-based, not pattern-based)", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const hostile = aValidStrategy();
    hostile.somethingNew = "value";
    await expect(
      importStrategy({ json: hostile }),
    ).rejects.toThrow(/STRATEGY_UNKNOWN_KEY_REJECTED/);
  });

  it("accepts a valid v1 strategy with all known fields populated", async () => {
    const { importStrategy } = await import("../src/modules/strategy/index.ts");
    const valid = {
      version: 1,
      meta: {
        name: "x",
        description: "an example",
        authorLabel: "alice",
        riskProfile: "moderate",
        createdIso: "2026-04-26T12:00:00.000Z",
        chains: ["ethereum"],
      },
      positions: [
        {
          protocol: "aave-v3",
          chain: "ethereum",
          kind: "supply",
          asset: "USDC",
          pctOfTotal: 75,
          healthFactor: 2.1,
          apr: 0.04,
        },
        {
          protocol: "uniswap-v3",
          chain: "ethereum",
          kind: "lp",
          asset: "ETH/USDC",
          pctOfTotal: 25,
          feeTier: 3000,
          inRange: true,
        },
      ],
      notes: ["a note"],
    };
    const { strategy } = await importStrategy({ json: valid });
    // Assert every constructed field survives the happy path — a silent
    // field-drop in validateSharedStrategy is caught here, not masked by a
    // bare `.toBeDefined()`.
    expect(strategy.version).toBe(1);
    expect(strategy.meta.name).toBe("x");
    expect(strategy.meta.description).toBe("an example");
    expect(strategy.meta.authorLabel).toBe("alice");
    expect(strategy.meta.riskProfile).toBe("moderate");
    expect(strategy.meta.createdIso).toBe("2026-04-26T12:00:00.000Z");
    expect(strategy.meta.chains).toEqual(["ethereum"]);
    expect(strategy.positions).toHaveLength(2);
    const aave = strategy.positions.find((p) => p.protocol === "aave-v3")!;
    expect(aave).toMatchObject({
      protocol: "aave-v3",
      chain: "ethereum",
      kind: "supply",
      asset: "USDC",
      pctOfTotal: 75,
      healthFactor: 2.1,
      apr: 0.04,
    });
    const uni = strategy.positions.find((p) => p.protocol === "uniswap-v3")!;
    expect(uni).toMatchObject({
      protocol: "uniswap-v3",
      chain: "ethereum",
      kind: "lp",
      asset: "ETH/USDC",
      pctOfTotal: 25,
      feeTier: 3000,
      inRange: true,
    });
    expect(strategy.notes).toEqual(["a note"]);
  });
});
