import { beforeAll, describe, expect, it } from "vitest";
import {
  redactSecrets,
  safeErrorMessage,
  redactResponseContent,
} from "../src/shared/error-message.js";

/**
 * Issue #768 — broaden `redactSecrets` beyond the Infura/Alchemy `/v[23]/<key>`
 * path + `api-key`/`apikey` query params to the provider-key shapes the #767
 * adversarial review found it MISSES:
 *
 *   (1) QuickNode / Triton / NOWNodes / GetBlock path token
 *       (`https://<name>.quiknode.pro/<token>/`)
 *   (2) URL userinfo (`https://user:pass@host/…` basic-auth RPC endpoints)
 *   (3) Bare `?key=` / `?token=` / `?access_token=` on a known provider host
 *
 * Each shape is exercised through ALL THREE redaction surfaces the leak flows
 * through — the core `redactSecrets` transform, the ERROR path
 * (`safeErrorMessage`), and the SUCCESS path (`redactResponseContent`). Removing
 * the corresponding widened pattern turns that shape's assertions RED (verified
 * by pattern-removal in the PR body). The over-redaction block guards the
 * primary risk: legit addresses / tx hashes / non-secret path words /
 * block-explorer URLs / non-provider query params must survive verbatim, and
 * are GREEN both before and after the widening.
 */
describe("issue #768 — widened provider-key redaction", () => {
  const SECRET = "abc123SECRETKEY"; // 15 chars — clears the ≥8 path-token floor

  // Helper: run a shape through the SUCCESS-path boundary and flatten to text.
  const viaSuccess = (raw: string): string => {
    const res = redactResponseContent({
      content: [{ type: "text", text: `RPC read failed: ${raw}` }],
    });
    return (res.content[0] as { text: string }).text;
  };

  describe("(1) provider path token — QuickNode / Triton / NOWNodes / GetBlock", () => {
    const cases: Array<[string, string]> = [
      ["QuickNode", `https://divine-cold-sea.quiknode.pro/${SECRET}/`],
      ["Triton (rpcpool)", `https://mainnet.rpcpool.com/${SECRET}`],
      ["NOWNodes", `https://eth.nownodes.io/${SECRET}`],
      ["GetBlock", `https://go.getblock.io/${SECRET}/`],
    ];
    for (const [name, url] of cases) {
      it(`${name} path token redacted through redactSecrets`, () => {
        const out = redactSecrets(`connect ETIMEDOUT ${url}`);
        expect(out).not.toContain(SECRET);
        expect(out).toContain("***");
      });
      it(`${name} path token redacted on the ERROR path (safeErrorMessage)`, () => {
        const out = safeErrorMessage(new Error(`HTTP request failed. URL: ${url}`));
        expect(out).not.toContain(SECRET);
      });
      it(`${name} path token redacted on the SUCCESS path (redactResponseContent)`, () => {
        expect(viaSuccess(url)).not.toContain(SECRET);
      });
    }
  });

  describe("(2) URL userinfo — basic-auth RPC endpoints", () => {
    const url = `https://rpcuser:${SECRET}@eth-rpc.example.com/`;
    it("userinfo redacted through redactSecrets, host + path preserved", () => {
      const out = redactSecrets(`401 Unauthorized from ${url}`);
      expect(out).not.toContain(SECRET);
      expect(out).not.toContain("rpcuser");
      expect(out).toContain("***@eth-rpc.example.com");
    });
    it("userinfo redacted on the ERROR path (safeErrorMessage)", () => {
      const out = safeErrorMessage(new Error(`fetch failed for ${url}`));
      expect(out).not.toContain(SECRET);
    });
    it("userinfo redacted on the SUCCESS path (redactResponseContent)", () => {
      expect(viaSuccess(url)).not.toContain(SECRET);
    });
  });

  describe("(3) bare ?key= / ?token= / ?access_token= on a known provider host", () => {
    const cases: Array<[string, string]> = [
      ["?key= (NOWNodes)", `https://eth.nownodes.io/?key=${SECRET}`],
      ["?token= (GetBlock)", `https://go.getblock.io/?token=${SECRET}`],
      ["?access_token= (GetBlock)", `https://go.getblock.io/?access_token=${SECRET}`],
    ];
    for (const [name, url] of cases) {
      it(`${name} redacted through redactSecrets`, () => {
        const out = redactSecrets(`RPC error ${url}`);
        expect(out).not.toContain(SECRET);
        expect(out).toContain("***");
      });
      it(`${name} redacted on the ERROR path (safeErrorMessage)`, () => {
        expect(safeErrorMessage(new Error(`timeout ${url}`))).not.toContain(SECRET);
      });
      it(`${name} redacted on the SUCCESS path (redactResponseContent)`, () => {
        expect(viaSuccess(url)).not.toContain(SECRET);
      });
    }
  });

  describe("combined userinfo + provider path token (order-independent)", () => {
    // Both credentials must be scrubbed regardless of which pattern runs first.
    const url = `https://basicuser:${SECRET}@name.quiknode.pro/${SECRET}/`;
    it("neither the userinfo password nor the path token survives", () => {
      const out = redactSecrets(`down: ${url}`);
      expect(out).not.toContain(SECRET);
      expect(out).toContain("***@name.quiknode.pro/***");
    });
  });

  describe("OVER-REDACTION guards — legit content survives verbatim", () => {
    // These MUST be GREEN both before and after the widening.
    const ADDRESS = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // USDT
    const TXHASH =
      "0x88df016429689c079f3b2f6ad39fa052532c56795b733da78a91ebe6a713944b";

    it("a real 0x address is not altered", () => {
      expect(redactSecrets(`transfer to ${ADDRESS} reverted`)).toContain(ADDRESS);
    });
    it("a real tx hash is not altered", () => {
      expect(redactSecrets(`tx ${TXHASH} not found`)).toContain(TXHASH);
    });
    it("a non-secret version path word (/v2/eth) is not clobbered", () => {
      const msg = "Upstream 502 from /v2/eth and /v3/quote — retry later";
      expect(redactSecrets(msg)).toBe(msg);
    });
    it("a block-explorer URL (non-provider host) passes through", () => {
      const url = `https://etherscan.io/tx/${TXHASH}`;
      expect(redactSecrets(`see ${url}`)).toContain(url);
    });
    it("a legit non-provider ?token= is NOT redacted (host-keyed)", () => {
      const url = "https://api.example.com/list?token=nextPageCursor123";
      expect(redactSecrets(`paginate ${url}`)).toContain("token=nextPageCursor123");
    });
    it("a long path segment on a non-provider host is NOT redacted", () => {
      const url = "https://docs.example.com/reference/getBlockByNumber";
      expect(redactSecrets(url)).toContain("getBlockByNumber");
    });
    it("the whole clean sentence is byte-for-byte unchanged", () => {
      const msg = `Insufficient funds: ${ADDRESS} needs 1.5 ETH, balance 0.3`;
      expect(redactSecrets(msg)).toBe(msg);
    });
  });

  describe("(C) non-text blocks — defensive string redaction", () => {
    it("redacts a keyed URL carried in a resource block's uri/text (not just `text` blocks)", () => {
      const res = redactResponseContent({
        content: [
          {
            type: "resource",
            resource: {
              uri: `https://name.quiknode.pro/${SECRET}/`,
              text: `endpoint https://eth.nownodes.io/?key=${SECRET}`,
              mimeType: "text/plain",
            },
          },
        ],
      });
      const flat = JSON.stringify(res);
      expect(flat).not.toContain(SECRET);
    });
    it("leaves a base64 `data` field (image/audio payload) untouched", () => {
      // A key is never base64-embedded in `data`; redacting it could corrupt
      // a legit binary payload, so `data`/`blob` are skipped by design.
      const data = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQ";
      const res = redactResponseContent({
        content: [{ type: "image", data, mimeType: "image/png" }],
      });
      expect((res.content[0] as { data: string }).data).toBe(data);
    });
  });
});

describe("issue #768 — widened redaction through the handler() success boundary", () => {
  const SECRET = "abc123SECRETKEY";
  let handler!: typeof import("../src/index.js")["handler"];

  beforeAll(async () => {
    ({ handler } = await import("../src/index.js"));
  }, 30_000);

  const flat = (out: { content: unknown[] }): string =>
    out.content.map((c) => (c as { text?: string }).text ?? "").join("\n");

  it("QuickNode path token in a success reason does NOT reach the response", async () => {
    const leaky = {
      unavailable: [
        {
          protocol: "solana",
          reason: `getSlot failed: connect ETIMEDOUT https://x.quiknode.pro/${SECRET}/`,
        },
      ],
    };
    const out = await handler(async () => leaky)({});
    expect(flat(out)).not.toContain(SECRET);
  });

  it("basic-auth userinfo in a success reason does NOT reach the response", async () => {
    const leaky = {
      chainHealth: "degraded",
      reason: `401 from https://rpcuser:${SECRET}@btc-rpc.example.com/`,
    };
    const out = await handler(async () => leaky)({});
    expect(flat(out)).not.toContain(SECRET);
  });

  it("bare ?token= on a provider host in a success reason does NOT reach the response", async () => {
    const leaky = {
      simulationSkipped: true,
      reason: `RPC error: https://go.getblock.io/?token=${SECRET}`,
    };
    const out = await handler(async () => leaky)({});
    expect(flat(out)).not.toContain(SECRET);
  });
});
