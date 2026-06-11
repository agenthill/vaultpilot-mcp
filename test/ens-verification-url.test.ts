/**
 * Unit tests for ENS verification URL + single-source warning (issue #574).
 *
 * ENS resolution routes through the MCP's RPC client, so a rogue MCP can
 * return an attacker address. The defense (option 1 of the issue's resolution)
 * is to include a `verificationUrl` pointing at app.ens.domains — a
 * third-party site the user opens in their browser independently of this MCP —
 * plus a `singleSourceWarning` that agents must surface before any send flow.
 *
 * These tests verify the response shape without live RPC calls: viem's
 * `getEnsAddress` / `getEnsName` are mocked so the test is deterministic
 * and doesn't require a mainnet node.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// We need to mock the RPC client before importing the module under test.
vi.mock("../src/data/rpc.js", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "../src/data/rpc.js";
import { resolveName, reverseResolve } from "../src/modules/balances/index.js";

const ATTACKER_ADDRESS = "0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAa" as `0x${string}`;
const KNOWN_ADDRESS = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" as `0x${string}`; // vitalik.eth

describe("resolveName — response shape includes verificationUrl and singleSourceWarning", () => {
  const mockClient = {
    getEnsAddress: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getClient).mockReturnValue(mockClient as never);
    mockClient.getEnsAddress.mockResolvedValue(KNOWN_ADDRESS);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns verificationUrl pointing at app.ens.domains/<name>", async () => {
    const out = await resolveName({ name: "vitalik.eth" });
    expect(out.verificationUrl).toBe("https://app.ens.domains/vitalik.eth");
  });

  it("returns a non-empty singleSourceWarning", async () => {
    const out = await resolveName({ name: "vitalik.eth" });
    expect(out.singleSourceWarning).toMatch(/single-sourced through this MCP/i);
    expect(out.singleSourceWarning).toMatch(/verificationUrl/i);
  });

  it("still returns the resolved address in the address field", async () => {
    mockClient.getEnsAddress.mockResolvedValue(KNOWN_ADDRESS);
    const out = await resolveName({ name: "vitalik.eth" });
    expect(out.address).toBe(KNOWN_ADDRESS);
    expect(out.name).toBe("vitalik.eth");
  });

  it("returns null address when name is unregistered, verificationUrl still present", async () => {
    mockClient.getEnsAddress.mockResolvedValue(null);
    const out = await resolveName({ name: "unregistered-xyz-404.eth" });
    expect(out.address).toBeNull();
    expect(out.verificationUrl).toBe(
      "https://app.ens.domains/unregistered-xyz-404.eth",
    );
    expect(out.singleSourceWarning).toBeTruthy();
  });

  it("URL-encodes the name to prevent injection in the verification URL", async () => {
    mockClient.getEnsAddress.mockResolvedValue(ATTACKER_ADDRESS);
    // Names with special characters are URL-encoded.
    const out = await resolveName({ name: "evil name & <script>" });
    expect(out.verificationUrl).not.toMatch(/<script>/);
    expect(out.verificationUrl).toMatch(/^https:\/\/app\.ens\.domains\//);
  });
});

describe("reverseResolve — response shape includes verificationUrl and singleSourceWarning", () => {
  const mockClient = {
    getEnsName: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getClient).mockReturnValue(mockClient as never);
    mockClient.getEnsName.mockResolvedValue("vitalik.eth");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("returns verificationUrl pointing at app.ens.domains/<address>", async () => {
    const out = await reverseResolve({ address: KNOWN_ADDRESS });
    expect(out.verificationUrl).toBe(
      `https://app.ens.domains/${KNOWN_ADDRESS}`,
    );
  });

  it("returns a non-empty singleSourceWarning", async () => {
    const out = await reverseResolve({ address: KNOWN_ADDRESS });
    expect(out.singleSourceWarning).toMatch(/single-sourced through this MCP/i);
  });

  it("returns the primary ENS name in the name field", async () => {
    mockClient.getEnsName.mockResolvedValue("vitalik.eth");
    const out = await reverseResolve({ address: KNOWN_ADDRESS });
    expect(out.name).toBe("vitalik.eth");
    expect(out.address).toBe(KNOWN_ADDRESS);
  });

  it("returns null name when no primary name set, verificationUrl still present", async () => {
    mockClient.getEnsName.mockResolvedValue(null);
    const out = await reverseResolve({ address: KNOWN_ADDRESS });
    expect(out.name).toBeNull();
    expect(out.verificationUrl).toBeTruthy();
    expect(out.singleSourceWarning).toBeTruthy();
  });
});

describe("ENS external-URL advisory — security invariants (issue #574)", () => {
  const mockClient = {
    getEnsAddress: vi.fn(),
    getEnsName: vi.fn(),
  };

  beforeEach(() => {
    vi.mocked(getClient).mockReturnValue(mockClient as never);
    mockClient.getEnsAddress.mockResolvedValue(ATTACKER_ADDRESS);
    mockClient.getEnsName.mockResolvedValue("attacker.eth");
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("verificationUrl domain is always app.ens.domains — cannot be overridden by a rogue MCP response", async () => {
    // A rogue MCP can control the RPC return value (mocked as ATTACKER_ADDRESS)
    // but the verificationUrl is constructed server-side from a compile-time
    // constant, so the domain is always app.ens.domains.
    const out = await resolveName({ name: "victim.eth" });
    const url = new URL(out.verificationUrl);
    expect(url.hostname).toBe("app.ens.domains");
  });

  it("reverseResolve verificationUrl domain is always app.ens.domains", async () => {
    const out = await reverseResolve({ address: KNOWN_ADDRESS });
    const url = new URL(out.verificationUrl);
    expect(url.hostname).toBe("app.ens.domains");
  });
});
