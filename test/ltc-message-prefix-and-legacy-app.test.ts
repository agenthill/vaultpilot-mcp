/**
 * Regression tests for the two LTC fixes shipped together:
 *
 * - **Issue #235**: `signLtcMessageOnLedger` taproot-rejection error must
 *   reference Litecoin address prefixes (`L…` / `M…` / `ltc1q…`), NOT
 *   the BTC prefixes (`1…` / `3…`) that leaked in via copy-paste from
 *   the BTC twin.
 *
 * - **Issue #240**: `signLtcPsbtOnLedger` must fall back to the legacy
 *   `createPaymentTransaction` API when `signPsbtBuffer` rejects with
 *   "is not supported with the legacy Bitcoin app" — the Ledger Litecoin
 *   app v2.4.x still ships only the legacy signing surface, while the
 *   BTC app on the same device is on the modern surface.
 *
 * The grep-guard at the top is the broader hedge against #235's class of
 * regression — any future copy-paste from BTC code that brings BTC
 * address prefixes into LTC paths fails the build instead of leaking to
 * the user mid-flow.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const requireCjs = createRequire(import.meta.url);

// Use bitcoinjs-lib to construct realistic PSBT + prev-tx fixtures.
const bitcoinjs = requireCjs("bitcoinjs-lib") as {
  Psbt: new (opts: { network: unknown }) => {
    addInput(input: {
      hash: string;
      index: number;
      sequence?: number;
      witnessUtxo: { script: Buffer; value: number };
      nonWitnessUtxo: Buffer;
    }): unknown;
    addOutput(output: { script: Buffer; value: number }): unknown;
    toBase64(): string;
  };
  Transaction: new () => {
    version: number;
    addInput(hash: Buffer, index: number, sequence?: number): unknown;
    addOutput(script: Buffer, value: number): unknown;
    toHex(): string;
  };
  address: {
    toOutputScript(addr: string, network?: unknown): Buffer;
  };
};

// Litecoin mainnet network params (mirror of the constant in
// src/signing/ltc-usb-signer.ts) — bitcoinjs-lib doesn't ship a preset.
const LITECOIN_NETWORK = {
  messagePrefix: "\x19Litecoin Signed Message:\n",
  bech32: "ltc",
  bip32: { public: 0x0488b21e, private: 0x0488ade4 },
  pubKeyHash: 0x30,
  scriptHash: 0x32,
  wif: 0xb0,
};

// ---------------------------------------------------------------------------
// Issue #235 — message-prefix correctness + grep guard against future drift
// ---------------------------------------------------------------------------

describe("issue #235 — LTC code paths must not leak BTC address prefixes", () => {
  it("the taproot-rejection error in ltc-usb-signer.ts uses LTC prefixes", () => {
    const src = readFileSync(
      new URL("../src/signing/ltc-usb-signer.ts", import.meta.url),
      "utf8",
    );
    // Find the specific error message and assert it references LTC prefixes.
    const m = src.match(
      /Taproot \(P2TR\) message signing requires BIP-322[\s\S]*?one tool call away/,
    );
    expect(m, "expected taproot-reject message not found").toBeTruthy();
    const msg = m![0];
    expect(msg).toContain("`L…`");
    expect(msg).toContain("`M…`");
    expect(msg).toContain("`ltc1q…`");
    // Negative regression — the BTC prefixes from the original copy-paste must NOT appear.
    expect(msg).not.toContain("`1…`");
    expect(msg).not.toContain("`3…`");
  });

  it("LTC source files do NOT contain BTC address-prefix literals (grep guard)", () => {
    // Walk every .ts under src/signing/ltc-* and src/modules/litecoin/.
    const roots = [
      new URL("../src/signing/", import.meta.url),
      new URL("../src/modules/litecoin/", import.meta.url),
    ];
    const offenders: string[] = [];
    for (const root of roots) {
      const dir = root.pathname;
      let entries: string[];
      try {
        entries = readdirSync(dir);
      } catch {
        continue;
      }
      for (const f of entries) {
        // Only LTC-specific files in src/signing/ — BTC files there share
        // the directory and legitimately use BTC prefixes.
        if (
          root.pathname.endsWith("/signing/") &&
          !f.startsWith("ltc-")
        ) {
          continue;
        }
        if (!f.endsWith(".ts")) continue;
        const path = join(dir, f);
        const src = readFileSync(path, "utf8");
        // The single legitimate `3...` mention in litecoin/address.ts
        // documents Litecoin's deprecated 0x05 P2SH form. Allow-list
        // by file-and-substring pair; everything else is a bug.
        const allowlist: Array<[string, RegExp]> = [
          // address.ts documents the legacy 0x05 form for backward-compat reads
          [
            "litecoin/address.ts",
            /(legacy 0x05.*P2SH|deprecated.*P2SH|0x05.*scriptHash|3-prefix.*legacy)/,
          ],
        ];
        // Patterns that indicate BTC prefix leakage when used as a
        // user-facing example. Match `\`1…\`` / `\`3…\`` / `\`bc1q\`` /
        // `\`bc1p\`` literals (the message format with backticks +
        // ellipsis).
        const badPatterns = [/`1…`/, /`3…`/, /`bc1q`/i, /`bc1p`/i];
        for (const re of badPatterns) {
          if (re.test(src)) {
            // Check allowlist
            const allowed = allowlist.some(
              ([fileSuffix, allowRe]) =>
                path.endsWith(fileSuffix) && allowRe.test(src),
            );
            if (!allowed) {
              offenders.push(`${path}: matches ${re.source}`);
            }
          }
        }
      }
    }
    expect(
      offenders,
      `BTC prefix literal(s) found in LTC code paths:\n${offenders.join("\n")}`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Issue #240 — legacy createPaymentTransaction fallback when signPsbtBuffer
// rejects with the specific "is not supported with the legacy Bitcoin app"
// error
// ---------------------------------------------------------------------------

// Build P2WPKH scripts directly from constructed hash160s rather than
// going through address parsing — this test only needs script bytes
// to round-trip through the legacy-API fallback's varint serialization,
// not real network-validatable addresses. Format: OP_0 (0x00) ||
// PUSH_20 (0x14) || 20-byte hash160.
const SOURCE_HASH160 = Buffer.alloc(20, 0xab);
const RECIPIENT_HASH160 = Buffer.alloc(20, 0xcd);
const SOURCE_SCRIPT = Buffer.concat([Buffer.from([0x00, 0x14]), SOURCE_HASH160]);
const RECIPIENT_SCRIPT = Buffer.concat([Buffer.from([0x00, 0x14]), RECIPIENT_HASH160]);

// Address strings — only used as the `expectedFrom` arg passed into the
// signer, where it's compared by-script (not parsed). bitcoinjs.address.
// toOutputScript runs inside the signer against this string and against
// the same LITECOIN_NETWORK constant to derive the script for change-
// path matching, so we need a real bech32-encoded ltc1... address. Use
// bech32 encoding of SOURCE_HASH160 under hrp "ltc".
const LTC_SEGWIT_ADDR = encodeBech32("ltc", 0, SOURCE_HASH160);
const LTC_SEGWIT_PUBKEY =
  "03a34b99f22c790c4e36b2b3c2c35a36db06226e41c692fc82b8b56ac1c540c5bd";

/** Minimal bech32 (BIP-173) encoder for v0 segwit addresses. */
function encodeBech32(hrp: string, witnessVersion: number, program: Buffer): string {
  const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
  // Convert program from 8-bit to 5-bit groups
  const data: number[] = [witnessVersion];
  let acc = 0;
  let bits = 0;
  for (const v of program) {
    acc = (acc << 8) | v;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      data.push((acc >> bits) & 31);
    }
  }
  if (bits > 0) data.push((acc << (5 - bits)) & 31);
  // Compute checksum
  function hrpExpand(s: string): number[] {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) >> 5);
    out.push(0);
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 31);
    return out;
  }
  function polymod(values: number[]): number {
    const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    let chk = 1;
    for (const v of values) {
      const top = chk >> 25;
      chk = ((chk & 0x1ffffff) << 5) ^ v;
      for (let i = 0; i < 5; i++) {
        if ((top >> i) & 1) chk ^= GEN[i];
      }
    }
    return chk;
  }
  // BIP-173 uses constant 1 for v0; BIP-350 (bech32m) uses 0x2bc830a3.
  const checksum = polymod([...hrpExpand(hrp), ...data, 0, 0, 0, 0, 0, 0]) ^ 1;
  const checksumWords: number[] = [];
  for (let i = 0; i < 6; i++) checksumWords.push((checksum >> (5 * (5 - i))) & 31);
  return (
    hrp +
    "1" +
    [...data, ...checksumWords].map((w) => CHARSET[w]).join("")
  );
}

function buildPrevTxHex(value: number): string {
  const tx = new bitcoinjs.Transaction();
  tx.version = 2;
  tx.addInput(Buffer.alloc(32, 0), 0xffffffff, 0xffffffff);
  tx.addOutput(SOURCE_SCRIPT, value);
  return tx.toHex();
}

function buildPsbtB64(): string {
  const psbt = new bitcoinjs.Psbt({ network: LITECOIN_NETWORK });
  const prevHex = buildPrevTxHex(1_000_000);
  psbt.addInput({
    hash: "1".repeat(64),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: SOURCE_SCRIPT, value: 1_000_000 },
    nonWitnessUtxo: Buffer.from(prevHex, "hex"),
  });
  // Recipient + change-to-source split
  psbt.addOutput({ script: RECIPIENT_SCRIPT, value: 100_000 });
  psbt.addOutput({ script: SOURCE_SCRIPT, value: 899_500 });
  return psbt.toBase64();
}

const getWalletPublicKeyMock = vi.fn();
const getAppAndVersionMock = vi.fn();
const signPsbtBufferMock = vi.fn();
const createPaymentTransactionMock = vi.fn();
const splitTransactionMock = vi.fn();
const transportCloseMock = vi.fn(async () => {});

vi.mock("../src/signing/ltc-usb-loader.js", () => ({
  openLedger: async () => ({
    app: {
      getWalletPublicKey: getWalletPublicKeyMock,
      signPsbtBuffer: signPsbtBufferMock,
      createPaymentTransaction: createPaymentTransactionMock,
      splitTransaction: splitTransactionMock,
    },
    transport: { close: transportCloseMock },
    rawTransport: {},
  }),
  getAppAndVersion: () => getAppAndVersionMock(),
}));

describe("issue #240 — legacy createPaymentTransaction fallback", () => {
  beforeEach(() => {
    getWalletPublicKeyMock.mockReset();
    getAppAndVersionMock.mockReset();
    signPsbtBufferMock.mockReset();
    createPaymentTransactionMock.mockReset();
    splitTransactionMock.mockReset();
    transportCloseMock.mockClear();

    getAppAndVersionMock.mockResolvedValue({
      name: "Litecoin",
      version: "2.4.11",
    });
    getWalletPublicKeyMock.mockResolvedValue({
      bitcoinAddress: LTC_SEGWIT_ADDR,
      publicKey: LTC_SEGWIT_PUBKEY,
      chainCode: "0".repeat(64),
    });
  });

  it("falls back to createPaymentTransaction on the SDK's legacy-app error", async () => {
    signPsbtBufferMock.mockRejectedValueOnce(
      new Error(
        "signPsbtBuffer is not supported with the legacy Bitcoin app",
      ),
    );
    splitTransactionMock.mockReturnValue({ marker: "split-tx" });
    createPaymentTransactionMock.mockResolvedValueOnce("0200000001abcd_signed_hex");

    const { signLtcPsbtOnLedger } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const result = await signLtcPsbtOnLedger({
      psbtBase64: buildPsbtB64(),
      sources: [{ address: LTC_SEGWIT_ADDR, path: "84'/2'/0'/0/0" }],
      inputSources: [LTC_SEGWIT_ADDR],
      accountPath: "84'/2'/0'",
      addressFormat: "bech32",
    });
    expect(result.rawTxHex).toBe("0200000001abcd_signed_hex");
    expect(signPsbtBufferMock).toHaveBeenCalledTimes(1);
    expect(createPaymentTransactionMock).toHaveBeenCalledTimes(1);
    const call = createPaymentTransactionMock.mock.calls[0][0];
    expect(call.segwit).toBe(true);
    expect(call.additionals).toEqual(["bech32"]);
    // One input → one entry in associatedKeysets, with the source path
    expect(call.associatedKeysets).toEqual(["84'/2'/0'/0/0"]);
    expect(call.inputs).toHaveLength(1);
    // changePath is set because output[1] goes back to source
    expect(call.changePath).toBe("84'/2'/0'/0/0");
    // outputScriptHex: 2 outputs encoded as varint(2) + ...
    // varint(2) is just 0x02 = "02"
    expect(call.outputScriptHex.startsWith("02")).toBe(true);
    // Should encode both output values; quick sanity check on length
    // (8 bytes value + varint scriptLen + script per output)
    expect(call.outputScriptHex.length).toBeGreaterThan(40);
  });

  it("does NOT fall back when signPsbtBuffer rejects with an unrelated error", async () => {
    signPsbtBufferMock.mockRejectedValueOnce(
      new Error("Ledger device: Invalid data received (0x6a80)"),
    );
    const { signLtcPsbtOnLedger } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    await expect(
      signLtcPsbtOnLedger({
        psbtBase64: buildPsbtB64(),
        sources: [{ address: LTC_SEGWIT_ADDR, path: "84'/2'/0'/0/0" }],
        inputSources: [LTC_SEGWIT_ADDR],
        accountPath: "84'/2'/0'",
        addressFormat: "bech32",
      }),
    ).rejects.toThrow(/0x6a80/);
    expect(createPaymentTransactionMock).not.toHaveBeenCalled();
  });

  it("succeeds via signPsbtBuffer when it works (no fallback fired)", async () => {
    signPsbtBufferMock.mockResolvedValueOnce({
      psbt: Buffer.alloc(0),
      tx: "0200000001happypath_signed_hex",
    });
    const { signLtcPsbtOnLedger } = await import(
      "../src/signing/ltc-usb-signer.js"
    );
    const result = await signLtcPsbtOnLedger({
      psbtBase64: buildPsbtB64(),
      sources: [{ address: LTC_SEGWIT_ADDR, path: "84'/2'/0'/0/0" }],
      inputSources: [LTC_SEGWIT_ADDR],
      accountPath: "84'/2'/0'",
      addressFormat: "bech32",
    });
    expect(result.rawTxHex).toBe("0200000001happypath_signed_hex");
    expect(createPaymentTransactionMock).not.toHaveBeenCalled();
  });
});

/**
 * Issue #698 — drift guard for the legacy-app fallback trigger.
 *
 * The fallback above matches on `msg.includes(LTC_LEGACY_APP_ERROR_MARKER)`,
 * a substring of an unversioned string that `@ledgerhq/hw-app-btc` throws.
 * `package.json` pins it with a caret (`^10.21.1`), so a patch release can
 * silently reword the string; every mock in this file (including the one
 * above) hardcodes the SAME literal, so it stays green even if the real
 * SDK's text changes underneath it.
 *
 * This test does NOT go through `vi.mock("../src/signing/ltc-usb-loader.js")`
 * — that mock only replaces the high-level loader (see its module-level
 * `vi.mock` call above), not `@ledgerhq/hw-app-btc` itself, exactly like the
 * `@ledgerhq/hw-app-btc bs58/base-x subtree` guard in `test/btc-pair.test.ts`.
 * It instantiates the REAL `Btc` class with `currency: "litecoin"` — which
 * always resolves to the legacy `BtcOld` implementation (see
 * `ltc-usb-loader.ts`'s `openLedger`) — and calls the real `signPsbtBuffer`,
 * which throws synchronously before touching the transport. If a future
 * `@ledgerhq/hw-app-btc` patch (still satisfying `^10.21.1`) reworks this
 * string, `realMessage` below stops equaling `LTC_LEGACY_APP_ERROR_MARKER`
 * and this test goes red — loudly, in CI, on the installed version — instead
 * of the fallback silently stopping firing in production.
 */
describe("issue #698 — legacy-app error string drift guard (real SDK)", () => {
  it("the real installed @ledgerhq/hw-app-btc still throws the pinned marker for currency: litecoin", async () => {
    const { LTC_LEGACY_APP_ERROR_MARKER } = await import(
      "../src/signing/ltc-usb-signer.js"
    );

    const btcRequire = createRequire(
      requireCjs.resolve("@ledgerhq/hw-app-btc/package.json"),
    );
    const Btc = btcRequire("@ledgerhq/hw-app-btc").default as new (arg: {
      transport: unknown;
      currency: string;
    }) => { signPsbtBuffer(buf: Buffer, opts: unknown): Promise<unknown> };
    const Transport = btcRequire("@ledgerhq/hw-transport")
      .default as new () => unknown;

    // Real base Transport (not a fake stub) — its `decorateAppAPIMethods`
    // and no-op `setScrambleKey` are what the Btc constructor relies on;
    // neither is reached before the synchronous throw under test.
    const transport = new Transport();
    const app = new Btc({ transport, currency: "litecoin" });

    let realMessage: string | undefined;
    try {
      await app.signPsbtBuffer(Buffer.alloc(0), {
        finalizePsbt: true,
        accountPath: "84'/2'/0'",
        addressFormat: "bech32",
        knownAddressDerivations: new Map(),
      });
    } catch (err) {
      realMessage = err instanceof Error ? err.message : String(err);
    }

    expect(realMessage).toBe(LTC_LEGACY_APP_ERROR_MARKER);
  });
});
