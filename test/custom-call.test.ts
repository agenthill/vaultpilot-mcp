/**
 * `prepare_custom_call` tests. Covers the build-side of the new escape-
 * hatch tool — issue #493.
 *
 * Coverage:
 *   - ABI source: inline arg wins; Etherscan fallback works for verified
 *     contracts; unverified contracts refuse with NO raw-bytecode path;
 *     proxies are followed once to the implementation.
 *   - Schema: `acknowledgeNonProtocolTarget: z.literal(true)` rejects
 *     `false` / `undefined` / non-boolean values at zod-parse time.
 *   - Calldata encoding matches viem's expected output for known sigs.
 *   - The wired txHandler doesn't throw INV_1A on a non-canonical target —
 *     `prepare_custom_call` must NOT be in the EXPECTED_TARGETS allowlist
 *     (it's the explicit allowlist-bypass tool).
 *   - Function-overload disambiguation: `fn` accepts both bare name and
 *     full signature.
 *   - `value` rejects non-decimal-integer strings (zod regex + builder
 *     re-assertion).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { encodeFunctionData, type Abi } from "viem";

const getContractInfoMock = vi.fn();
vi.mock("../src/data/apis/etherscan.js", () => ({
  getContractInfo: (...a: unknown[]) => getContractInfoMock(...a),
}));

import { buildCustomCall } from "../src/modules/custom-call/actions.js";
import { prepareCustomCallInput } from "../src/modules/execution/schemas.js";
import { assertCanonicalDispatchOnTxChain } from "../src/security/canonical-dispatch.js";
import {
  matchSendFamilyGate,
  assertSendFamilyRecipientIsWallet,
} from "../src/security/custom-call-classifier.js";

const WALLET = "0xC0f5b7f7703BA95dC7C09D4eF50A830622234075" as const;
const TIMELOCK = "0x22bc85C483103950441EaaB8312BE9f07e234634" as const;
const PROXY = "0x1111111111111111111111111111111111111111" as const;
const IMPL = "0x2222222222222222222222222222222222222222" as const;

// Minimal Timelock fragment — schedule(...) — exact shape of the v4
// OpenZeppelin TimelockController on mainnet.
const TIMELOCK_ABI = [
  {
    type: "function",
    name: "schedule",
    stateMutability: "nonpayable",
    inputs: [
      { name: "target", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "predecessor", type: "bytes32" },
      { name: "salt", type: "bytes32" },
      { name: "delay", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

beforeEach(() => {
  getContractInfoMock.mockReset();
});

describe("prepare_custom_call schema (issue #493)", () => {
  it("requires acknowledgeNonProtocolTarget=true literally", () => {
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        acknowledgeNonProtocolTarget: false,
      }),
    ).toThrow();
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        // missing
      }),
    ).toThrow();
    // true passes — combined with required wallet + contract + fn.
    const ok = prepareCustomCallInput.parse({
      wallet: WALLET,
      contract: TIMELOCK,
      fn: "schedule",
      args: [],
      acknowledgeNonProtocolTarget: true,
    });
    expect(ok.acknowledgeNonProtocolTarget).toBe(true);
    expect(ok.value).toBe("0"); // default
    expect(ok.chain).toBe("ethereum"); // default
  });

  it("rejects non-decimal-integer value", () => {
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0.5", // decimal — must be wei integer
        acknowledgeNonProtocolTarget: true,
      }),
    ).toThrow();
    expect(() =>
      prepareCustomCallInput.parse({
        wallet: WALLET,
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "1000000000000000000", // 1 ETH in wei
        acknowledgeNonProtocolTarget: true,
      }),
    ).not.toThrow();
  });
});

describe("buildCustomCall — ABI resolution", () => {
  it("uses inline ABI when provided (no Etherscan fetch)", async () => {
    const args: readonly unknown[] = [
      "0x0000000000000000000000000000000000000001",
      "0",
      "0x",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      "172800",
    ];
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args,
      value: "0",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(getContractInfoMock).not.toHaveBeenCalled();
    expect(tx.to).toBe(TIMELOCK);
    expect(tx.chain).toBe("ethereum");
    // Compare bit-exactly against viem's encoder.
    const expected = encodeFunctionData({
      abi: TIMELOCK_ABI,
      functionName: "schedule",
      args,
    });
    expect(tx.data).toBe(expected);
  });

  it("fetches ABI via Etherscan when verified and not a proxy", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: TIMELOCK_ABI as unknown as unknown[],
    });
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
    });
    expect(getContractInfoMock).toHaveBeenCalledOnce();
    expect(tx.data.startsWith("0x01d5062a")).toBe(true); // schedule selector
  });

  it("refuses unverified contracts with NO raw-bytecode fallback", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: false,
      isProxy: false,
    });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/not Etherscan-verified/);
  });

  it("follows proxy → implementation once for ABI lookup", async () => {
    getContractInfoMock
      .mockResolvedValueOnce({
        address: PROXY,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: IMPL,
        abi: [], // proxy itself has only fallback
      })
      .mockResolvedValueOnce({
        address: IMPL,
        chain: "ethereum",
        isVerified: true,
        isProxy: false,
        abi: TIMELOCK_ABI as unknown as unknown[],
      });
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: PROXY,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
    });
    expect(getContractInfoMock).toHaveBeenCalledTimes(2);
    expect(tx.to).toBe(PROXY); // outer call still targets the proxy
  });

  it("refuses proxy when implementation is unverified", async () => {
    getContractInfoMock
      .mockResolvedValueOnce({
        address: PROXY,
        chain: "ethereum",
        isVerified: true,
        isProxy: true,
        implementation: IMPL,
        abi: [],
      })
      .mockResolvedValueOnce({
        address: IMPL,
        chain: "ethereum",
        isVerified: false,
        isProxy: false,
      });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: PROXY,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/proxy.*implementation.*couldn't be ABI-fetched/);
  });

  it("refuses verified contract with empty parsed ABI", async () => {
    getContractInfoMock.mockResolvedValueOnce({
      address: TIMELOCK,
      chain: "ethereum",
      isVerified: true,
      isProxy: false,
      abi: undefined,
    });
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "schedule",
        args: [],
        value: "0",
      }),
    ).rejects.toThrow(/no parseable ABI/);
  });
});

describe("buildCustomCall — encoding", () => {
  it("surfaces a useful error when fn doesn't match the ABI", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: TIMELOCK,
        fn: "totallyMadeUpFn",
        args: [],
        value: "0",
        abi: TIMELOCK_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/Failed to encode calldata/);
  });

  it("preserves passed value (wei) in the unsigned tx", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "1000000000000000000",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(tx.value).toBe("1000000000000000000");
  });
});

// Minimal ERC-20 fragment — only `approve` is needed for the redirect gate.
const ERC20_APPROVE_ABI = [
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48" as const;
const RANDOM_EOA = "0x000000000000000000000000000000000000beef" as const;
const UNISWAP_ROUTER02 = "0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45" as const;
const UINT256_MAX = (1n << 256n) - 1n;

describe("buildCustomCall — approve-route refusal (issue #556)", () => {
  it("refuses approve(...) and points to prepare_token_approve when spender is unknown", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "approve",
        args: [RANDOM_EOA, "1000000"],
        value: "0",
        abi: ERC20_APPROVE_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/APPROVE_ROUTE_VIA_DEDICATED_TOOL[\s\S]*prepare_token_approve/);
  });

  it("refuses approve(...) and points to protocol-specific prepare_* when spender is a known protocol", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "approve",
        args: [UNISWAP_ROUTER02, UINT256_MAX.toString()],
        value: "0",
        abi: ERC20_APPROVE_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/APPROVE_ROUTE_VIA_DEDICATED_TOOL[\s\S]*Uniswap V3/);
  });

  it("allows approve(...) when acknowledgeRawApproveBypass=true (escape hatch)", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "approve",
      args: [RANDOM_EOA, "1000000"],
      value: "0",
      abi: ERC20_APPROVE_ABI as unknown as readonly unknown[],
      acknowledgeRawApproveBypass: true,
    });
    expect(tx.data.startsWith("0x095ea7b3")).toBe(true);
  });

  it("burn-address gate still fires on the override path (defense in depth)", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "approve",
        args: ["0xdead000000000000000000000000000000000000", UINT256_MAX.toString()],
        value: "0",
        abi: ERC20_APPROVE_ABI as unknown as readonly unknown[],
        acknowledgeRawApproveBypass: true,
      }),
    ).rejects.toThrow(/BURN_ADDRESS_UNLIMITED_APPROVAL/);
  });

  it("does not fire on non-approve calldata (Timelock schedule)", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(tx.data.startsWith("0x01d5062a")).toBe(true);
  });
});

describe("canonical-dispatch wiring (#483 / PR #489)", () => {
  it("is a no-op for prepare_custom_call regardless of `to`", () => {
    // The wired txHandler walks to the action leg and asserts canonical
    // dispatch. `prepare_custom_call` is the explicit allowlist-bypass
    // tool — it must NOT match any EXPECTED_TARGETS entry. Verify by
    // running the same shape txHandler runs against an arbitrary `to`.
    const tx = {
      chain: "ethereum" as const,
      to: "0x000000000000000000000000000000000000beef" as `0x${string}`,
      data: "0x" as `0x${string}`,
      value: "0",
      description: "",
    };
    expect(() => assertCanonicalDispatchOnTxChain("prepare_custom_call", tx)).not.toThrow();
  });
});

// ------- Selector classifier (issue #652) -------
// Defense in depth on the prepare_custom_call escape hatch — refuses
// obvious value-exfil selectors and routes the agent to the safer
// protocol-specific tool. Approve(0x095ea7b3) is intentionally NOT in
// the classifier (already handled by the dedicated #556 check above).

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC20_TRANSFER_FROM_ABI = [
  {
    type: "function",
    name: "transferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC721_SAFE_TRANSFER_FROM_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [],
  },
] as const;

const ERC721_SET_APPROVAL_FOR_ALL_ABI = [
  {
    type: "function",
    name: "setApprovalForAll",
    stateMutability: "nonpayable",
    inputs: [
      { name: "operator", type: "address" },
      { name: "approved", type: "bool" },
    ],
    outputs: [],
  },
] as const;

const ATTACKER = "0x000000000000000000000000000000000000dEaD" as const;
const ANOTHER_WALLET = "0x1111111111111111111111111111111111111111" as const;

describe("buildCustomCall — selector classifier (issue #652)", () => {
  it("refuses ERC-20 transfer(...) and points at prepare_token_send", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transfer",
        args: [ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/CUSTOM_CALL_REFUSED[\s\S]*transfer\(address,uint256\)[\s\S]*prepare_token_send/);
  });

  it("transfer refusal does NOT claim prepare_token_send applies address-poisoning checks (issue #763)", async () => {
    // prepare_token_send's send path (resolveRecipient + assertRecipient)
    // never calls annotatePoisoning — that annotator has exactly one
    // importer, get_transaction_history's read-side display
    // (src/modules/history/index.ts), and is never reached from the
    // prepare_token_send handler (src/modules/execution/index.ts). The
    // refusal text must not tell the agent it obtained a screening that
    // doesn't exist on this path.
    let caught: Error | undefined;
    try {
      await buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transfer",
        args: [ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_ABI as unknown as readonly unknown[],
      });
    } catch (e) {
      caught = e as Error;
    }
    expect(caught).toBeDefined();
    expect(caught?.message).not.toMatch(/applies the address-poisoning checks/);
    expect(caught?.message).toMatch(/does NOT screen for\s+address-poisoning/);
  });

  it("refuses ERC-20 transferFrom(...) and points at the safer flow", async () => {
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transferFrom",
        args: [ANOTHER_WALLET, ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
      }),
    ).rejects.toThrow(/CUSTOM_CALL_REFUSED[\s\S]*transferFrom/);
  });

  it("refuses transferFrom(self, ...) outright with NO bypass available", async () => {
    // Self-as-from is pull-style draining via a pre-existing approval —
    // there's no legitimate flow where the user wants this through the
    // escape hatch (use prepare_token_send instead, which doesn't need
    // an allowance). The ack flag MUST NOT downgrade this verdict.
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transferFrom",
        args: [WALLET, ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
        acknowledgeKnownExfilPattern: true,
      }),
    ).rejects.toThrow(/NOT[\s\S]*bypassable/);
  });

  it("self-as-from comparison is case-insensitive on the wallet hex", async () => {
    // Wallet is a checksummed 0xC0f5… address; from-arg is the same
    // hex lowercased. The check must canonicalize both sides.
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transferFrom",
        args: [WALLET.toLowerCase(), ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
        acknowledgeKnownExfilPattern: true,
      }),
    ).rejects.toThrow(/NOT[\s\S]*bypassable/);
  });

  it("acknowledgeKnownExfilPattern=true downgrades transfer refusal to a warn annotation", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "transfer",
      args: [ATTACKER, "1000000"],
      value: "0",
      abi: ERC20_TRANSFER_ABI as unknown as readonly unknown[],
      acknowledgeKnownExfilPattern: true,
    });
    expect(tx.data.startsWith("0xa9059cbb")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toBeDefined();
    expect(tx.decoded?.args._classifierWarning).toMatch(/exfil-pattern bypassed/);
  });

  it("acknowledgeKnownExfilPattern=true downgrades transferFrom(other, ...) refusal", async () => {
    // Other-as-from is rare-but-legitimate (pulling someone else's
    // pre-existing allowance to yourself). Bypass IS allowed here.
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "transferFrom",
      args: [ANOTHER_WALLET, WALLET, "1000000"],
      value: "0",
      abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
      acknowledgeKnownExfilPattern: true,
    });
    expect(tx.data.startsWith("0x23b872dd")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toMatch(/exfil-pattern bypassed/);
  });

  it("refuses ack-stamped transferFrom(other, ATTACKER) — recipient not wallet, NON-bypassable (issue #711)", async () => {
    // The ack override's stated rationale is "pulling someone else's
    // allowance TO YOURSELF is rare-but-legitimate" — nothing checked
    // that the pulled tokens land back at the wallet. from != wallet AND
    // to != wallet is pure value-exfil: the ack MUST NOT downgrade it.
    await expect(
      buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn: "transferFrom",
        args: [ANOTHER_WALLET, ATTACKER, "1000000"],
        value: "0",
        abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
        acknowledgeKnownExfilPattern: true,
      }),
    ).rejects.toThrow(/CUSTOM_CALL_REFUSED[\s\S]*NOT[\s\S]*bypassable/);
  });

  it("recipient check is case-insensitive on the wallet hex (issue #711)", async () => {
    // to == wallet hex, lowercased — must canonicalize both sides and
    // treat this as the legitimate pull-to-own-wallet case.
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "transferFrom",
      args: [ANOTHER_WALLET, WALLET.toLowerCase(), "1000000"],
      value: "0",
      abi: ERC20_TRANSFER_FROM_ABI as unknown as readonly unknown[],
      acknowledgeKnownExfilPattern: true,
    });
    expect(tx.data.startsWith("0x23b872dd")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toMatch(/exfil-pattern bypassed/);
  });

  it("attaches a soft-warn annotation to ERC-721 safeTransferFrom (recipient == wallet, no refusal)", async () => {
    // The pre-existing #652 warn annotation still fires when the recipient
    // is the wallet — the #741 send-family recipient gate lets pull-to-self
    // through untouched, and the warn branch below is byte-for-byte
    // unchanged. (Non-wallet recipients now refuse — see the #741 block.)
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC, // contract addr is irrelevant — selector match is the gate
      fn: "safeTransferFrom",
      args: [ANOTHER_WALLET, WALLET, "42"],
      value: "0",
      abi: ERC721_SAFE_TRANSFER_FROM_ABI as unknown as readonly unknown[],
    });
    expect(tx.data.startsWith("0x42842e0e")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toMatch(/\[warning\][\s\S]*safeTransferFrom/);
  });

  it("attaches a soft-warn annotation to setApprovalForAll (no refusal)", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "setApprovalForAll",
      args: [ANOTHER_WALLET, true],
      value: "0",
      abi: ERC721_SET_APPROVAL_FOR_ALL_ABI as unknown as readonly unknown[],
    });
    expect(tx.data.startsWith("0xa22cb465")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toMatch(/\[warning\][\s\S]*setApprovalForAll/);
  });

  it("does not attach a warning for unrelated selectors (Timelock schedule)", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: TIMELOCK,
      fn: "schedule",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0",
        "0x",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "0x0000000000000000000000000000000000000000000000000000000000000000",
        "172800",
      ],
      value: "0",
      abi: TIMELOCK_ABI as unknown as readonly unknown[],
    });
    expect(tx.data.startsWith("0x01d5062a")).toBe(true);
    expect(tx.decoded?.args._classifierWarning).toBeUndefined();
  });
});

// ── Issue #741 — send-family recipient-gate fixtures ──────────────────
// Selectors whose ABI moves a THIRD PARTY's pre-authorized tokens/assets
// (a from/owner param the ABI allows to differ from the wallet) TO a
// call-parameter recipient. Every member's recipient is arg index 1
// (verified — scripts/verify-send-family-selectors.mjs).
const ERC777_OPERATOR_SEND_ABI = [
  {
    type: "function",
    name: "operatorSend",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operatorData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC1363_TFAC_ABI = [
  {
    type: "function",
    name: "transferFromAndCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC1363_TFAC_BYTES_ABI = [
  {
    type: "function",
    name: "transferFromAndCall",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const ERC4626_WITHDRAW_ABI = [
  {
    type: "function",
    name: "withdraw",
    stateMutability: "nonpayable",
    inputs: [
      { name: "assets", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "shares", type: "uint256" }],
  },
] as const;

const ERC4626_REDEEM_ABI = [
  {
    type: "function",
    name: "redeem",
    stateMutability: "nonpayable",
    inputs: [
      { name: "shares", type: "uint256" },
      { name: "receiver", type: "address" },
      { name: "owner", type: "address" },
    ],
    outputs: [{ name: "assets", type: "uint256" }],
  },
] as const;

const ERC721_SAFE_TRANSFER_FROM_BYTES_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "tokenId", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC1155_SAFE_TRANSFER_FROM_ABI = [
  {
    type: "function",
    name: "safeTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "id", type: "uint256" },
      { name: "amount", type: "uint256" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

const ERC1155_SAFE_BATCH_ABI = [
  {
    type: "function",
    name: "safeBatchTransferFrom",
    stateMutability: "nonpayable",
    inputs: [
      { name: "from", type: "address" },
      { name: "to", type: "address" },
      { name: "ids", type: "uint256[]" },
      { name: "amounts", type: "uint256[]" },
      { name: "data", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

interface SendFamilyCase {
  label: string;
  selector: string;
  fn: string;
  abi: readonly unknown[];
  /** Build the encoded args with a given recipient (to/receiver) at arg 1. */
  args: (to: string) => readonly unknown[];
  /**
   * True for selectors that ALSO carry a pre-existing #652 warn rule
   * (ERC-721 safeTransferFrom) — those keep the warn annotation on the
   * recipient==wallet path; the rest are unclassified once past the gate.
   */
  prevWarned: boolean;
}

const SEND_FAMILY_CASES: readonly SendFamilyCase[] = [
  {
    label: "ERC-777 operatorSend",
    selector: "0x62ad1b83",
    fn: "operatorSend",
    abi: ERC777_OPERATOR_SEND_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "1000000", "0x", "0x"],
    prevWarned: false,
  },
  {
    label: "ERC-1363 transferFromAndCall (3-arg)",
    selector: "0xd8fbe994",
    fn: "transferFromAndCall",
    abi: ERC1363_TFAC_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "1000000"],
    prevWarned: false,
  },
  {
    label: "ERC-1363 transferFromAndCall (4-arg)",
    selector: "0xc1d34b89",
    fn: "transferFromAndCall",
    abi: ERC1363_TFAC_BYTES_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "1000000", "0x"],
    prevWarned: false,
  },
  {
    label: "ERC-4626 withdraw",
    selector: "0xb460af94",
    fn: "withdraw",
    abi: ERC4626_WITHDRAW_ABI as unknown as readonly unknown[],
    args: (to) => ["1000000", to, ANOTHER_WALLET],
    prevWarned: false,
  },
  {
    label: "ERC-4626 redeem",
    selector: "0xba087652",
    fn: "redeem",
    abi: ERC4626_REDEEM_ABI as unknown as readonly unknown[],
    args: (to) => ["1000000", to, ANOTHER_WALLET],
    prevWarned: false,
  },
  {
    label: "ERC-721 safeTransferFrom (3-arg)",
    selector: "0x42842e0e",
    fn: "safeTransferFrom",
    abi: ERC721_SAFE_TRANSFER_FROM_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "42"],
    prevWarned: true,
  },
  {
    label: "ERC-721 safeTransferFrom (4-arg with bytes)",
    selector: "0xb88d4fde",
    fn: "safeTransferFrom",
    abi: ERC721_SAFE_TRANSFER_FROM_BYTES_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "42", "0x"],
    prevWarned: true,
  },
  {
    label: "ERC-1155 safeTransferFrom",
    selector: "0xf242432a",
    fn: "safeTransferFrom",
    abi: ERC1155_SAFE_TRANSFER_FROM_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, "1", "1000000", "0x"],
    prevWarned: false,
  },
  {
    label: "ERC-1155 safeBatchTransferFrom",
    selector: "0x2eb2c2d6",
    fn: "safeBatchTransferFrom",
    abi: ERC1155_SAFE_BATCH_ABI as unknown as readonly unknown[],
    args: (to) => [ANOTHER_WALLET, to, ["1"], ["1000000"], "0x"],
    prevWarned: false,
  },
];

describe("buildCustomCall — send-family recipient gate (issue #741)", () => {
  // RED before the gate lands: every member below is either unclassified
  // (→ {rule:null} → allowed) or a soft warn (ERC-721 safeTransferFrom →
  // allowed) today, so an ack-stamped drain to an ATTACKER recipient builds
  // a tx with no refusal. The gate mirrors #727's transferFrom recipient
  // block: recipient != wallet is value-exfil, NON-bypassable by the ack.
  it.each(SEND_FAMILY_CASES)(
    "refuses ack-stamped $label to a non-wallet recipient (NON-bypassable)",
    async ({ fn, abi, args }) => {
      await expect(
        buildCustomCall({
          wallet: WALLET,
          chain: "ethereum",
          contract: USDC,
          fn,
          args: args(ATTACKER),
          value: "0",
          abi,
          acknowledgeKnownExfilPattern: true,
        }),
      ).rejects.toThrow(/CUSTOM_CALL_REFUSED[\s\S]*NOT[\s\S]*bypassable/);
    },
  );

  it.each(SEND_FAMILY_CASES)(
    "allows $label when the recipient is the wallet (pull-to-self, no ack needed)",
    async ({ fn, abi, args, selector, prevWarned }) => {
      const tx = await buildCustomCall({
        wallet: WALLET,
        chain: "ethereum",
        contract: USDC,
        fn,
        args: args(WALLET),
        value: "0",
        abi,
      });
      expect(tx.data.startsWith(selector)).toBe(true);
      if (prevWarned) {
        // ERC-721 safeTransferFrom keeps its pre-existing #652 warn rule.
        expect(tx.decoded?.args._classifierWarning).toMatch(/\[warning\]/);
      } else {
        expect(tx.decoded?.args._classifierWarning).toBeUndefined();
      }
    },
  );

  it("recipient check is case-insensitive on the wallet hex (operatorSend)", async () => {
    const tx = await buildCustomCall({
      wallet: WALLET,
      chain: "ethereum",
      contract: USDC,
      fn: "operatorSend",
      args: [ANOTHER_WALLET, WALLET.toLowerCase(), "1000000", "0x", "0x"],
      value: "0",
      abi: ERC777_OPERATOR_SEND_ABI as unknown as readonly unknown[],
    });
    expect(tx.data.startsWith("0x62ad1b83")).toBe(true);
  });
});

describe("assertSendFamilyRecipientIsWallet — unit (issue #741)", () => {
  it("throws non-bypassably when a matched selector's recipient is not the wallet", () => {
    // operatorSend selector + recipientIsWallet=false — the deny-by-default
    // verdict the caller computes on a missing/non-wallet recipient arg.
    expect(() =>
      assertSendFamilyRecipientIsWallet("0x62ad1b83deadbeef", false),
    ).toThrow(/CUSTOM_CALL_REFUSED[\s\S]*NOT[\s\S]*bypassable/);
  });

  it("is a no-op when the recipient is the wallet", () => {
    expect(() =>
      assertSendFamilyRecipientIsWallet("0x62ad1b83deadbeef", true),
    ).not.toThrow();
  });

  it("does not fire for a non-member selector (transferFrom is #727's, not here)", () => {
    expect(matchSendFamilyGate("0x23b872dd00000000")).toBeNull();
    // Even with recipientIsWallet=false, a non-member selector is untouched.
    expect(() =>
      assertSendFamilyRecipientIsWallet("0x23b872dd00000000", false),
    ).not.toThrow();
  });
});

describe("send-family gate selectors (#741) — bit-exact against viem", () => {
  // Verify the hard-coded selectors in SEND_FAMILY_RECIPIENT_GATE match
  // what viem encodes for the canonical signatures (project rule: verify
  // cryptographic constants independently, in the committed suite).
  it.each(SEND_FAMILY_CASES)("$label encodes to $selector", ({ fn, abi, args, selector }) => {
    const data = encodeFunctionData({
      abi: abi as Abi,
      functionName: fn,
      args: args(WALLET) as readonly unknown[],
    });
    expect(data.slice(0, 10)).toBe(selector);
  });
});

describe("classifier rule selectors (#652) — bit-exact against viem", () => {
  // Verify the hard-coded selectors in CUSTOM_CALL_CLASSIFIER_RULES
  // match what viem encodes for the canonical signatures. Per the
  // project rule on verifying cryptographic constants independently.
  it("ERC-20 transfer", () => {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_ABI,
      functionName: "transfer",
      args: ["0x0000000000000000000000000000000000000001", 0n],
    });
    expect(data.slice(0, 10)).toBe("0xa9059cbb");
  });

  it("ERC-20 transferFrom", () => {
    const data = encodeFunctionData({
      abi: ERC20_TRANSFER_FROM_ABI,
      functionName: "transferFrom",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        0n,
      ],
    });
    expect(data.slice(0, 10)).toBe("0x23b872dd");
  });

  it("ERC-721 safeTransferFrom (3-arg)", () => {
    const data = encodeFunctionData({
      abi: ERC721_SAFE_TRANSFER_FROM_ABI,
      functionName: "safeTransferFrom",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        0n,
      ],
    });
    expect(data.slice(0, 10)).toBe("0x42842e0e");
  });

  it("ERC-721 setApprovalForAll", () => {
    const data = encodeFunctionData({
      abi: ERC721_SET_APPROVAL_FOR_ALL_ABI,
      functionName: "setApprovalForAll",
      args: ["0x0000000000000000000000000000000000000001", true],
    });
    expect(data.slice(0, 10)).toBe("0xa22cb465");
  });

  it("ERC-721 safeTransferFrom (4-arg with bytes)", () => {
    const ABI_WITH_BYTES = [
      {
        type: "function",
        name: "safeTransferFrom",
        stateMutability: "nonpayable",
        inputs: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "tokenId", type: "uint256" },
          { name: "data", type: "bytes" },
        ],
        outputs: [],
      },
    ] as const;
    const data = encodeFunctionData({
      abi: ABI_WITH_BYTES,
      functionName: "safeTransferFrom",
      args: [
        "0x0000000000000000000000000000000000000001",
        "0x0000000000000000000000000000000000000002",
        0n,
        "0x",
      ],
    });
    expect(data.slice(0, 10)).toBe("0xb88d4fde");
  });
});

describe("prepareCustomCallInput schema — acknowledgeKnownExfilPattern (#652)", () => {
  it("accepts boolean true / false / undefined", () => {
    const ok1 = prepareCustomCallInput.parse({
      wallet: WALLET,
      contract: TIMELOCK,
      fn: "schedule",
      args: [],
      acknowledgeNonProtocolTarget: true,
      acknowledgeKnownExfilPattern: true,
    });
    expect(ok1.acknowledgeKnownExfilPattern).toBe(true);
    const ok2 = prepareCustomCallInput.parse({
      wallet: WALLET,
      contract: TIMELOCK,
      fn: "schedule",
      args: [],
      acknowledgeNonProtocolTarget: true,
      acknowledgeKnownExfilPattern: false,
    });
    expect(ok2.acknowledgeKnownExfilPattern).toBe(false);
    const ok3 = prepareCustomCallInput.parse({
      wallet: WALLET,
      contract: TIMELOCK,
      fn: "schedule",
      args: [],
      acknowledgeNonProtocolTarget: true,
    });
    expect(ok3.acknowledgeKnownExfilPattern).toBeUndefined();
  });
});
