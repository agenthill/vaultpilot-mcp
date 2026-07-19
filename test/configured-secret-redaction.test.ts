import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
  redactSecrets,
  redactConfiguredSecrets,
  safeErrorMessage,
  redactResponseContent,
  __resetRedactionDiagnosticsForTest,
} from "../src/shared/error-message.js";
import {
  setConfigDirForTesting,
  writeUserConfig,
} from "../src/config/user-config.js";
import {
  setRuntimeOverride,
  _resetRuntimeRpcOverridesForTests,
} from "../src/data/runtime-rpc-overrides.js";
import type { UserConfig } from "../src/types/index.js";
import * as errorMessageModule from "../src/shared/error-message.js";

/**
 * Issue #771 — exact-match scrubbing of the user's OWN configured secret
 * VALUES, composed with (not replacing) the shape-based `redactSecrets`.
 *
 * The shape patterns are host-keyed (`PROVIDER_HOST`), so a key on a CUSTOM /
 * unlisted provider host still leaks. These tests drive an unlisted-host secret
 * through BOTH redaction seams (`safeErrorMessage` + `redactResponseContent`)
 * and assert it is scrubbed — while proving the shape layer alone MISSES it
 * (the meta-falsifier: removing the exact-match composition turns these RED,
 * because `safeErrorMessage`/`redactResponseContent` would collapse to
 * `redactSecrets`, which leaves the unlisted-host secret intact).
 *
 * All secret values below are FAKE / de-identified sentinels.
 */

// FAKE sentinels — never real keys. Each clears the 8-char needle floor.
const ANKR_TOKEN = "FAKEankr0token1234567890deadbeef"; // path token on unlisted host
const ANKR_URL = `https://rpc.ankr.com/eth/${ANKR_TOKEN}`;
const DRPC_TOKEN = "FAKEdrpc9key8765432100cafef00d"; // ?dkey= on unlisted host
const DRPC_URL = `https://lb.drpc.org/ogrpc?network=ethereum&dkey=${DRPC_TOKEN}`;
const CUSTOM_SOLANA_URL = `https://solana.example-provider.net/rpc/${ANKR_TOKEN}A`;

let tmpHome: string;

function writeConfig(cfg: UserConfig): void {
  writeUserConfig(cfg);
}

beforeEach(() => {
  tmpHome = mkdtempSync(pjoin(tmpdir(), "vaultpilot-cfg-secret-"));
  setConfigDirForTesting(tmpHome);
  _resetRuntimeRpcOverridesForTests();
  // Reset the module-global one-time diagnostic flags (depth cap + short-secret
  // skip) so warn-asserting tests are order-independent (Fix 4a).
  __resetRedactionDiagnosticsForTest();
  // Silence console.warn by default; warn-asserting tests read the spy via
  // vi.mocked(console.warn). afterEach restores it.
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setConfigDirForTesting(null);
  _resetRuntimeRpcOverridesForTests();
  rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

// Helper: drive a raw string through the SUCCESS-path seam and flatten to text.
const viaSuccess = (raw: string): string => {
  const res = redactResponseContent({
    content: [{ type: "text", text: `RPC read failed: ${raw}` }],
  });
  return (res.content[0] as { text: string }).text;
};

describe("issue #771 — exact-match configured-secret scrubbing", () => {
  describe("custom / unlisted-provider host secret (the core falsifier)", () => {
    const cases: Array<[string, string, string]> = [
      ["Ankr path token", ANKR_URL, ANKR_TOKEN],
      ["dRPC ?dkey=", DRPC_URL, DRPC_TOKEN],
    ];

    for (const [name, url, token] of cases) {
      it(`${name}: shape layer alone MISSES it (proves the exact-match layer is load-bearing)`, () => {
        // RED-on-removal proof: redactSecrets (shape-only) leaves the
        // unlisted-host secret intact. If safeErrorMessage/redactResponseContent
        // did NOT add the exact-match layer, they would equal this and leak.
        expect(redactSecrets(`connect ETIMEDOUT ${url}`)).toContain(token);
      });

      it(`${name}: scrubbed on the ERROR path (safeErrorMessage)`, () => {
        writeConfig({ rpc: { provider: "custom", customUrls: { ethereum: url } } });
        const out = safeErrorMessage(new Error(`HTTP request failed. URL: ${url}`));
        expect(out).not.toContain(token);
        expect(out).toContain("***");
      });

      it(`${name}: scrubbed on the SUCCESS path (redactResponseContent)`, () => {
        writeConfig({ rpc: { provider: "custom", customUrls: { ethereum: url } } });
        expect(viaSuccess(url)).not.toContain(token);
      });
    }

    it("custom solanaRpcUrl on an unlisted host is scrubbed on both paths", () => {
      writeConfig({ rpc: { provider: "custom" }, solanaRpcUrl: CUSTOM_SOLANA_URL });
      expect(safeErrorMessage(new Error(`solana rpc failed: ${CUSTOM_SOLANA_URL}`)))
        .not.toContain(ANKR_TOKEN);
      expect(viaSuccess(CUSTOM_SOLANA_URL)).not.toContain(ANKR_TOKEN);
    });
  });

  describe("encoding-variant matching (SEC R2)", () => {
    // Base64-shaped key: contains + / =, which become %2B %2F %3D once the key
    // passes through URL construction or an echoed encoded URL.
    const B64_KEY = "FAKE1inch+key/value==0123456789";
    const B64_ENCODED = "FAKE1inch%2Bkey%2Fvalue%3D%3D0123456789";
    // Appears on an UNLISTED host under a non-`apikey` param name, so the shape
    // layer does NOT catch it — only the exact-match encoding variant can. This
    // is SEC's mandatory R2 falsifier ("the one worth writing first").
    const ENCODED_HAYSTACK = `Upstream error: request to https://api.1inch.dev/swap?dkey=${B64_ENCODED} failed`;

    it("shape layer alone leaves the percent-encoded key (proves the encoding variant is load-bearing)", () => {
      // RED-on-removal anchor: redactSecrets is shape-only and never touches the
      // dkey= param on an unlisted host, so the encoded key survives it.
      expect(redactSecrets(ENCODED_HAYSTACK)).toContain(B64_ENCODED);
    });

    it("the percent-encoded (%2B/%2F/%3D) form of a base64-shaped configured key is still redacted", () => {
      writeConfig({ rpc: { provider: "custom" }, oneInchApiKey: B64_KEY });
      // The RAW key never appears in the haystack — only its encoded form — so a
      // naive raw-substring redactor (no encoding variant) leaves it: RED.
      expect(ENCODED_HAYSTACK).not.toContain(B64_KEY);
      expect(ENCODED_HAYSTACK).toContain(B64_ENCODED);
      const out = redactConfiguredSecrets(ENCODED_HAYSTACK);
      expect(out).not.toContain(B64_ENCODED);
      expect(out).toContain("***");
    });

    it("the encoded key is scrubbed on the ERROR path (safeErrorMessage)", () => {
      writeConfig({ rpc: { provider: "custom" }, oneInchApiKey: B64_KEY });
      expect(safeErrorMessage(new Error(ENCODED_HAYSTACK))).not.toContain(B64_ENCODED);
    });

    it("the encoded key is scrubbed on the SUCCESS path (redactResponseContent)", () => {
      writeConfig({ rpc: { provider: "custom" }, oneInchApiKey: B64_KEY });
      expect(viaSuccess(ENCODED_HAYSTACK)).not.toContain(B64_ENCODED);
    });
  });

  describe("over-redaction guard — public base URL survives (Fix 1)", () => {
    it("a configured PUBLIC base URL (bitcoinIndexerUrl) contributes no needle; an echoed sub-path passes through untouched", () => {
      writeConfig({
        rpc: { provider: "custom" },
        bitcoinIndexerUrl: "https://mempool.space/api",
      });
      const echoed = "https://mempool.space/api/tx/abcdef0123456789abcdef";
      // No userinfo, no key/token path segment, no credential query → no needle,
      // so the echoed URL on the same host is NOT clobbered. Reverting Fix 1 to
      // whole-URL needles turns this RED (the base becomes a needle).
      expect(redactConfiguredSecrets(echoed)).toBe(echoed);
      expect(viaSuccess(echoed)).toContain("https://mempool.space/api/tx/");
    });

    it("a configured public custom RPC base URL is not needled (host/path words survive)", () => {
      writeConfig({
        rpc: {
          provider: "custom",
          customUrls: { ethereum: "https://api.mainnet-beta.solana.com" },
        },
      });
      const echoed = "call to https://api.mainnet-beta.solana.com/health returned 200";
      expect(redactConfiguredSecrets(echoed)).toBe(echoed);
    });

    it("the credential segment of an otherwise-public URL IS still needled (guard does not disarm the feature)", () => {
      // Same host as the public case, but with a key path token → the token is
      // needled while the bare host would not be.
      const token = "FAKEkeyed0token1234567890abcdef";
      writeConfig({
        rpc: { provider: "custom" },
        bitcoinIndexerUrl: `https://mempool.space/api/${token}`,
      });
      expect(redactConfiguredSecrets(`indexer https://mempool.space/api/${token}/tx`))
        .not.toContain(token);
    });
  });

  describe("short-secret skip warning (SEC R1 / Fix 3)", () => {
    it("a below-floor configured value emits a value-free skip warning, once", () => {
      const warn = vi.mocked(console.warn); // silenced spy installed in beforeEach
      writeConfig({ rpc: { provider: "custom" }, tronApiKey: "shortk" }); // 6 chars < 8
      redactConfiguredSecrets("some ordinary output");
      redactConfiguredSecrets("more ordinary output"); // second call must NOT re-warn
      expect(warn).toHaveBeenCalledTimes(1);
      // The diagnostic must never carry the value.
      for (const call of warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain("shortk");
      }
    });
  });

  describe("bare API-key config fields", () => {
    it("etherscanApiKey is scrubbed even when it appears bare in a reason field", () => {
      const key = "FAKEetherscanKEY0123456789ABCDEFGH"; // 34-ish, fake
      writeConfig({ rpc: { provider: "custom" }, etherscanApiKey: key });
      const out = safeErrorMessage(new Error(`etherscan rejected apikey=${key}`));
      expect(out).not.toContain(key);
      expect(viaSuccess(`used key ${key}`)).not.toContain(key);
    });

    it("infura apiKey embedded in a constructed provider URL is scrubbed", () => {
      const key = "FAKEinfuraKEY0123456789abcdef";
      writeConfig({ rpc: { provider: "infura", apiKey: key } });
      const url = `https://mainnet.infura.io/v3/${key}`;
      expect(safeErrorMessage(new Error(`HTTP request failed. URL: ${url}`)))
        .not.toContain(key);
    });
  });

  describe("OVER-MATCH GUARD — short / empty configured values (SEC R1)", () => {
    it("a 4-char configured value is NOT used as a needle (does not redact unrelated text)", () => {
      // tronApiKey set to a 4-char value; must be SKIPPED (below the 8-char floor)
      // or it would clobber every 'abcd' substring in legitimate output.
      writeConfig({ rpc: { provider: "custom" }, tronApiKey: "abcd" });
      const haystack = "the quick brown fox abcd jumps over the lazy dog";
      expect(redactConfiguredSecrets(haystack)).toBe(haystack);
      expect(viaSuccess(haystack)).toContain("abcd");
    });

    it("an empty-string configured value is NOT used as a needle", () => {
      writeConfig({ rpc: { provider: "custom" }, etherscanApiKey: "" });
      const haystack = "a perfectly ordinary sentence with no secrets";
      expect(redactConfiguredSecrets(haystack)).toBe(haystack);
    });

    it("a long value alongside a short one: long redacted, short survives", () => {
      const longSecret = "FAKElongsecret0123456789abcdef"; // >= 8
      writeConfig({
        rpc: { provider: "custom" },
        tronApiKey: "abcd", // skipped
        etherscanApiKey: longSecret, // redacted
      });
      const out = redactConfiguredSecrets(`abcd and ${longSecret} together`);
      expect(out).toContain("abcd");
      expect(out).not.toContain(longSecret);
    });
  });

  describe("call-time freshness — rotation via runtime setter (SEC R4)", () => {
    it("a helius key configured mid-session is redacted from the next output", () => {
      // No override at first: the resolved Helius URL is not yet a needle.
      const keyA = "aaaaaaaa-1111-2222-3333-444444444444"; // fake UUID
      setRuntimeOverride("helius", keyA);
      const urlA = `https://mainnet.helius-rpc.com/?api-key=${keyA}`;
      expect(safeErrorMessage(new Error(`solana failed ${urlA}`))).not.toContain(keyA);

      // Rotate to key B; B must now be covered, A path rebuilt.
      const keyB = "bbbbbbbb-5555-6666-7777-888888888888";
      setRuntimeOverride("helius", keyB);
      const urlB = `https://mainnet.helius-rpc.com/?api-key=${keyB}`;
      expect(safeErrorMessage(new Error(`solana failed ${urlB}`))).not.toContain(keyB);
    });
  });

  describe("NO-LEAK (SEC R3)", () => {
    it("does not expose the needle collector as a getter", () => {
      expect(
        (errorMessageModule as Record<string, unknown>).collectConfiguredSecretNeedles,
      ).toBeUndefined();
    });

    it("malformed config does not throw out of the redaction path", () => {
      // Write a malformed config file directly (readUserConfig would throw).
      rmSync(tmpHome, { recursive: true, force: true });
      // Recreate dir + drop invalid JSON.
      mkdirSync(tmpHome, { recursive: true });
      writeFileSync(pjoin(tmpHome, "config.json"), "{ not valid json ");
      expect(() => redactConfiguredSecrets("some text")).not.toThrow();
      expect(redactConfiguredSecrets("some text")).toBe("some text");
    });
  });

  describe("depth-cap fix (issue #770 folded observation)", () => {
    it("a secret nested deeper than the old cap-of-4 is now scrubbed", () => {
      const secret = "FAKEdeepnested0123456789abcdef";
      writeConfig({ rpc: { provider: "custom" }, etherscanApiKey: secret });
      // Depth chain: block(0)->n1(1)->n2(2)->n3(3)->n4(4)->n5(5:leak). The old
      // `depth > 4` cap returned before scrubbing this; the raised cap covers it.
      const res = redactResponseContent({
        content: [
          {
            type: "text",
            n1: { n2: { n3: { n4: { n5: { leak: `key=${secret}` } } } } },
          },
        ],
      });
      expect(JSON.stringify(res)).not.toContain(secret);
    });

    it("hitting the raised depth cap emits a value-free diagnostic (not silent)", () => {
      const secret = "FAKEtoodeep0123456789abcdef";
      writeConfig({ rpc: { provider: "custom" }, etherscanApiKey: secret });
      const warn = vi.mocked(console.warn); // silenced spy installed in beforeEach
      // Build a chain deeper than MAX_REDACT_DEPTH (32).
      let node: Record<string, unknown> = { leak: `key=${secret}` };
      for (let i = 0; i < 40; i++) node = { child: node };
      redactResponseContent({ content: [{ type: "text", deep: node }] });
      expect(warn).toHaveBeenCalled();
      // The diagnostic must never carry the secret.
      for (const call of warn.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(secret);
      }
    });
  });
});
