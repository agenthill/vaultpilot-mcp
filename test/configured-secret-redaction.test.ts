import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import {
  redactSecrets,
  redactConfiguredSecrets,
  safeErrorMessage,
  redactResponseContent,
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
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
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
