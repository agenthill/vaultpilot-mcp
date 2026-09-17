import type { SupportedChain } from "./chains.js";

/**
 * Per-argument decode from the calldata — one entry per ABI input field.
 * `valueHuman` is populated only when we can apply decimals + symbol (known
 * ERC-20 tokens via `TOKEN_META`). For everything else, `value` is the raw
 * stringified bigint / address / bytes and callers render that directly.
 */
export interface DecodedArg {
  name: string;
  type: string;
  value: string;
  valueHuman?: string;
}

/**
 * Local decode of the exact calldata that will be signed. Built from the
 * static ABI registry in `src/abis/*` via viem's `decodeFunctionData`. Never
 * calls a network — if the destination isn't in our registry, `source` is
 * `"none"` and the user is told to rely entirely on the swiss-knife URL.
 */
export interface HumanDecode {
  /** Function name (`"supply"`), or `"nativeTransfer"` / `"unknown"`. */
  functionName: string;
  /** Full signature like `supply(address,uint256,address,uint16)`. */
  signature?: string;
  args: DecodedArg[];
  /**
   * - `"local-abi"`: full decode against an ABI in our static registry — `functionName` is the canonical on-chain name and is corroborable against 4byte.directory's selector→name mapping.
   * - `"local-abi-partial"`: the destination is in our registry but the specific selector/facet isn't (e.g. LiFi Diamond bridge facets) — we surfaced a positional decode of a known shared sub-tuple, but `functionName` is synthetic and MUST NOT be cross-checked against 4byte (a name-equality check would always fail by design).
   * - `"native"`: pure native-value transfer, no calldata.
   * - `"none"`: unknown destination, no decode possible.
   */
  source: "local-abi" | "local-abi-partial" | "native" | "none";
}

/**
 * Pre-sign verification payload — attached to EVERY prepared transaction
 * unconditionally. The user is expected to open `decoderUrl` in a browser,
 * compare what swiss-knife.xyz decodes against `humanDecode` in chat, and
 * only approve on Ledger if the two agree. The `payloadHash` is a
 * domain-tagged keccak256 that can be recomputed independently from the
 * swiss-knife URL params and is re-checked at send time against the exact
 * bytes forwarded to WalletConnect (the bytes-we-previewed == bytes-we-sign
 * proof).
 */
export interface TxVerification {
  /** keccak256 of `("VaultPilot-txverify-v1:" ‖ chainId ‖ to ‖ value ‖ data)` for EVM; `("VaultPilot-txverify-v1:tron:" ‖ rawDataHex)` for TRON. */
  payloadHash: `0x${string}`;
  /** First 8 hex chars (no `0x`) of `payloadHash` — short enough to read off a Ledger screen and eyeball-match. */
  payloadHashShort: string;
  /** swiss-knife.xyz decoder URL with calldata, address, chainId preloaded. EVM only; absent when calldata is too large to fit or on TRON. */
  decoderUrl?: string;
  /** Fallback when `decoderUrl` can't be built — short instructions telling the user to paste calldata/address/chainId manually. */
  decoderPasteInstructions?: string;
  /** Local decode of the calldata (viem + ABI registry). */
  humanDecode: HumanDecode;
  /** Canonical comparison string `<chainId>:<to>:<value>:<data>` — exactly the four fields fed into the fingerprint. */
  comparisonString: string;
  /**
   * TRC-20 calldata bytes (`0x` + 4-byte selector + ABI-encoded params) for
   * `trc20_send` / `trc20_approve` actions. Surfaced so the agent can
   * (a) decode the recipient slot itself and cross-check it against the
   * typed base58 address (mirror of EVM CHECK 1), and (b) splice into a
   * swiss-knife.xyz decoder URL the user can open in the browser. Absent
   * for native TRX sends, freeze/unfreeze, votes, and other non-ABI
   * actions — those have no calldata to decode.
   */
  tronCalldataHex?: `0x${string}`;
}

/**
 * Unsigned TRON transaction. Shape is unavoidably different from EVM:
 * TronGrid builds the tx server-side (raw_data + raw_data_hex) and the
 * device signs the serialized raw_data_hex. We keep the TRON tx shape
 * separate from UnsignedTx so send_transaction's EVM-only security pipeline
 * (eth_call re-simulation, chain-id check, spender allowlist) can't be
 * silently shortcut by a TRON handle masquerading as an EVM one.
 *
 * Phase 3 (this release) routes TRON handles through `send_transaction`:
 * the USB HID signer (@ledgerhq/hw-app-trx) verifies the device address
 * matches `from`, signs `rawDataHex`, and broadcasts via TronGrid.
 */
export interface UnsignedTronTx {
  chain: "tron";
  /** Discriminator for the preview + future signer branching. */
  action:
    | "native_send"
    | "trc20_send"
    | "trc20_approve"
    | "claim_rewards"
    | "freeze"
    | "unfreeze"
    | "withdraw_expire_unfreeze"
    | "vote"
    | "lifi_swap"
    | "sunswap_swap";
  /** Base58 owner address (prefix T). */
  from: string;
  /** TronGrid-returned transaction ID (sha256 of raw_data_hex, hex string). */
  txID: string;
  /**
   * TronGrid's raw_data object — opaque to us; serialized in raw_data_hex.
   * Required for the standard `/wallet/broadcasttransaction` path. ABSENT
   * for `lifi_swap` flows where we receive only `raw_data_hex` from LiFi
   * and broadcast via `/wallet/broadcasthex` instead (broadcast.ts branches
   * on this).
   */
  rawData?: unknown;
  /** Hex-encoded raw_data used by the signer. */
  rawDataHex: string;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
    /**
     * ABI-encoded parameter payload (no `0x`, no selector) for TRC-20 calls.
     * Set by the trc20_send / trc20_approve builders so the verification
     * layer can compose the full calldata (`0x<selector><parameterHex>`)
     * without re-deriving it from the human-readable args.
     */
    parameterHex?: string;
  };
  /**
   * Fee limit in SUN, present on contract calls (TRC-20 transfers require it;
   * TronGrid rejects triggersmartcontract without one). Absent on native TRX
   * sends and WithdrawBalance — those pay bandwidth only.
   */
  feeLimitSun?: string;
  /**
   * Energy units the pre-flight triggerconstantcontract call consumed. Only
   * present on contract calls where we pre-flight (TRC-20 transfers). The
   * on-chain burn will be within a few percent of this number.
   */
  estimatedEnergyUsed?: string;
  /**
   * Estimated fee in SUN that will actually burn on-chain — energy units
   * times the mainnet energy price (420 sun/energy as of 2024-10). The
   * preview shows this alongside `feeLimitSun` so the user can see
   * "expected ~15 TRX" next to "cap 100 TRX" and not think the cap is the
   * charge.
   */
  estimatedEnergyCostSun?: string;
  /** Opaque handle — see tron-tx-store.ts. Phase 3 signer consumes this. */
  handle?: string;
  /**
   * Pre-sign verification payload, stamped by `issueTronHandle` on every
   * prepared TRON tx. Optional during rollout; flipped to required after
   * all call sites are updated.
   */
  verification?: TxVerification;
  /**
   * Invariant #14 — durable-binding source-of-truth verification (issue
   * #460). Populated by `prepare_tron_vote` (one binding per Super
   * Representative voted for). Absent on other TRON op kinds.
   */
  durableBindings?: import("../security/durable-binding.js").DurableBinding[];
}

/**
 * Unsigned Solana transaction. Parallel to `UnsignedTronTx` — kept separate
 * from `UnsignedTx` so `send_transaction`'s EVM-only security pipeline
 * (eth_call re-simulation, EIP-1559 pin, spender allowlist) can't be
 * silently shortcut by a Solana handle, and parallel to `UnsignedTronTx`
 * because Solana's wire format (Ed25519 sig over a serialized tx message)
 * is its own thing.
 *
 * Signing path: USB HID via `@ledgerhq/hw-app-solana` — Ledger Live's
 * WalletConnect integration does NOT expose Solana accounts, so we mirror
 * the TRON USB HID architecture (see `project_ledger_live_solana_wc.md`).
 */
export interface UnsignedSolanaTx {
  chain: "solana";
  /**
   * Discriminator for the preview + future signer branching.
   *
   * - `native_send` / `spl_send` — user-facing transfers. Durable-nonce-
   *   protected (ix[0] = nonceAdvance); every send refuses to build until
   *   the wallet has an initialized nonce account.
   * - `nonce_init` — one-time setup: createAccountWithSeed + nonceInitialize.
   *   Runs in legacy recent-blockhash mode (no nonce to use yet).
   * - `nonce_close` — teardown: nonceAdvance + nonceWithdraw. Drains the
   *   rent-exempt balance back to the user's main wallet.
   */
  action:
    | "native_send"
    | "spl_send"
    | "nonce_init"
    | "nonce_close"
    | "jupiter_swap"
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay"
    | "marinade_stake"
    | "marinade_unstake_immediate"
    | "jito_stake"
    | "native_stake_delegate"
    | "native_stake_deactivate"
    | "native_stake_withdraw"
    | "lifi_solana_swap"
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  /** Base58 owner address (44-char ed25519 pubkey). */
  from: string;
  /**
   * Base64-encoded serialized Solana tx MESSAGE (what the Ledger Solana app
   * signs). Post-sign, broadcast rebuilds the full tx = message + signature.
   * Message bytes bake the recent blockhash, fee payer, all instructions
   * and accounts — tampering with any of these at send time will cause
   * either the device address check or the on-chain signature verification
   * to fail.
   *
   * Pinned by `preview_solana_send` with a fresh blockhash, immediately before
   * signing. `prepare_solana_*` stores a draft (no blockhash); the pinned
   * form only exists after preview runs. `send_transaction` requires it.
   */
  messageBase64: string;
  /**
   * Blockhash baked into the message, pinned at `preview_solana_send` time.
   * Solana txs are valid for ~150 blocks (~60s) from this hash's slot, so
   * the preview → send window is bounded — `preview_solana_send` emits a
   * fresh hash right before broadcast so the full window is available.
   */
  recentBlockhash: string;
  /**
   * Last block height at which `recentBlockhash` remains valid. Captured
   * from `getLatestBlockhash` at pin time; carried through broadcast and
   * surfaced by `send_transaction` so the subsequent status-poller can
   * tell "dropped" (current slot > this) from "not-yet-propagated" when
   * `getSignatureStatuses` returns null.
   */
  lastValidBlockHeight?: number;
  /** Human-readable description for the preview. */
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
  };
  /**
   * Rent cost in lamports when this tx includes a
   * `createAssociatedTokenAccount` instruction (recipient doesn't hold the
   * mint yet). Absent when the tx is a plain transfer. Surfaced so the
   * preview can say "+0.00204 SOL rent to create recipient's USDC account".
   */
  rentLamports?: number;
  /**
   * Priority fee (micro-lamports per compute unit) baked into the message.
   * Present only when `getRecentPrioritizationFees` indicated network
   * congestion at prepare time and we injected ComputeBudget instructions.
   * Absent means "no priority fee; base fee only".
   */
  priorityFeeMicroLamports?: number;
  /** Compute-unit limit when ComputeBudget was added. */
  computeUnitLimit?: number;
  /** Estimated total fee in lamports (base + priority). For the preview. */
  estimatedFeeLamports?: number;
  /** Opaque handle — see solana-tx-store.ts. `send_transaction` consumes this. */
  handle?: string;
  /**
   * Server-minted UUID, set by `preview_solana_send` (every pin — fresh on
   * `refresh`). Echoed back through `send_transaction`'s `previewToken`
   * arg to prove the agent actually ran preview AND surfaced the CHECKS
   * PERFORMED block before the user replied "send". Mirrors the EVM
   * `previewToken` gate — a hostile agent can still forge it after a real
   * preview, so this is a careless-mistake backstop, not a coordinated-
   * lying defense.
   */
  previewToken?: string;
  /**
   * Pre-sign verification payload, stamped by `issueSolanaHandle` on every
   * prepared Solana tx. Mirrors the TRON / EVM verification shape.
   */
  verification?: TxVerification;
  /**
   * Pre-sign simulation result. Populated by `preview_solana_send` via
   * `connection.simulateTransaction(sigVerify: false, replaceRecentBlockhash:
   * false)` against the pinned message. Absent only when the caller
   * explicitly skipped simulation (currently `nonce_init`, which is legacy
   * and has no interesting revert surface) OR when the simulation RPC
   * itself errored transiently — in both cases `preview_solana_send`
   * proceeds so a momentary network hiccup can't block a user's flow.
   *
   * When present with `ok: false` the preview handler throws BEFORE
   * returning, so this field effectively always carries `ok: true` on the
   * wire — but the shape keeps `ok: boolean` so downstream callers that
   * might loosen the throw policy (e.g. a future "force" flag) stay
   * type-correct.
   */
  simulation?: {
    ok: boolean;
    unitsConsumed?: number;
    logs?: string[];
    err?: string;
    anchorError?: { code: number; name: string; message: string };
  };
  /**
   * Durable-nonce metadata — present when ix[0] = SystemProgram.nonceAdvance.
   * For `native_send` / `spl_send` / `nonce_close` this is always set; for
   * `nonce_init` it's absent (that's the tx that CREATES the nonce account;
   * it has no nonce to consume yet). Surfaced for the summary renderer
   * (`Nonce: <short addr>` bullet) and for future nonce-aware dropped-tx
   * polling (`getNonceAccountValue` to detect advance vs. stuck).
   */
  nonce?: {
    account: string;
    authority: string;
    value: string;
  };
}

/** Unsigned transaction, ready to be sent to Ledger Live for signing. */
export interface UnsignedTx {
  chain: SupportedChain;
  to: `0x${string}`;
  data: `0x${string}`;
  /** Value in wei as a decimal string (so JSON-safe). */
  value: string;
  from?: `0x${string}`;
  /** Human-readable description (e.g. "Supply 1.0 USDC to Aave V3 on Ethereum"). */
  description: string;
  /** Decoded function name + args for display. */
  decoded?: {
    functionName: string;
    args: Record<string, string>;
  };
  /** Estimated gas as a decimal string. */
  gasEstimate?: string;
  /** Estimated gas cost in USD. */
  gasCostUsd?: number;
  /**
   * Estimated gas cost denominated in the chain's native asset (ETH on
   * ethereum/arbitrum/base/optimism, MATIC/POL on polygon), as a string
   * formatted at 18 decimals. Stored alongside `gasCostUsd` so the cost
   * preview block (issue #636) can render the native fee even when the
   * USD price lookup degrades (no network / DefiLlama miss). Both halves
   * are populated by `enrichTx` when gas estimation succeeds; both stay
   * undefined when it fails.
   */
  gasCostNative?: string;
  /**
   * Result of an eth_call simulation against the current chain state. `ok:false`
   * with a revertReason is expected on the follow-up tx of an approve→action
   * pair at prepare time (the approve hasn't been mined yet). At sign time, the
   * same simulation is re-run and a revert aborts the signing path.
   */
  simulation?: {
    ok: boolean;
    revertReason?: string;
  };
  /** If this tx is a prerequisite (e.g. ERC-20 approve), the follow-up tx is in `next`. */
  next?: UnsignedTx;
  /**
   * Opaque handle issued by the tx-store when the prepared tx is returned to
   * the caller. `send_transaction` accepts ONLY this handle — raw calldata is
   * not acceptable, which binds the signed tx to the previewed one and closes
   * the prompt-injection → arbitrary-signing path.
   */
  handle?: string;
  /**
   * Pre-sign verification payload — decoder URL, local decode, and a
   * domain-tagged payload hash. Stamped by `issueHandles` on every prepared
   * EVM tx. Optional during rollout; flipped to required once all call
   * sites are updated.
   */
  verification?: TxVerification;
  /**
   * Address-book resolution metadata — populated by `resolveRecipient`
   * when the user's `to` arg matched a contact label, ENS, or a literal
   * address that reverse-decorated to a saved label. Threaded through to
   * the verification renderer so the user sees `to: 0xAbC… (contact: Mom
   * — verified)` instead of just the raw hex. Absent for prepares that
   * don't take a recipient (e.g. swap, lending). Issue: address-book
   * v1.0.
   */
  recipient?: {
    /** Saved label, if any (resolved-from or reverse-decorated). */
    label?: string;
    /** How the address was resolved. */
    source: "literal" | "contact" | "ens" | "unknown";
    /** Non-fatal warnings (e.g. "contacts file failed verification — recipient label not checked"). */
    warnings?: string[];
  };
  /**
   * Non-standard ERC-20 transfer-semantics flags (issue #441) — looked
   * up at `prepare_token_send` time from the curated registry in
   * `modules/execution/token-class.ts`. Absent when the token is plain
   * ERC-20 (no point surfacing `flags: ["standard"]` and adding noise
   * to every receipt). When present, the verification renderer
   * appends `warnings[]` as `⚠ <warning>` lines so the user reads
   * them before signing — caught the smoke-test case where a 0.3 stETH
   * transfer landed 1-2 wei short with no warning (script 019).
   */
  tokenClass?: {
    flags: Array<
      | "standard"
      | "rebasing"
      | "fee_on_transfer"
      | "pausable"
      | "blocklisted"
      | "upgradeable_admin"
    >;
    warnings: string[];
  };
  /**
   * Set when the tx was built by `prepare_custom_call` after the user passed
   * the affirmative `acknowledgeNonProtocolTarget: true` schema-enforced
   * gate. Read by `assertTransactionSafe` to skip ONLY the catch-all
   * "unknown destination" refusal at preview/send time — every other
   * pre-sign defense (approve-spender allowlist, transfer-on-unknown-token,
   * allowed-ABI-selector check) stays active. Issue #496.
   *
   * Trust note: this flag flows through the handle store keyed by the
   * server-minted UUID; the agent cannot fabricate it on a tx that didn't
   * come through `prepare_custom_call`'s build path. Setting it to true on
   * any other prepare path is a server bug, not a user-controllable lever.
   */
  acknowledgedNonProtocolTarget?: boolean;
  /**
   * Set when the tx was built by `prepare_safe_tx_propose`,
   * `prepare_safe_tx_approve`, or `prepare_safe_tx_execute`. Read by
   * `assertTransactionSafe` to skip ONLY the catch-all "unknown destination"
   * refusal — the OUTER `to` is the user's own Safe contract, which is by
   * definition not in any canonical allowlist. Issue #609.
   *
   * Why this is safe: the OUTER calldata is always a Safe-specific selector
   * (`approveHash(bytes32)` or `execTransaction(...)`) — neither carries
   * transferable authority on its own, and Ledger Live shows the
   * destination address on-device. The inner-action defense (binding the
   * SafeTx body to the safeTxHash) is upstream of this check.
   *
   * Trust note: like `acknowledgedNonProtocolTarget`, this flag flows
   * through the handle store keyed by the server-minted UUID. The agent
   * cannot fabricate it on a tx that didn't come through one of the three
   * prepare paths above. Setting it on any other prepare path is a server
   * bug, not a user-controllable lever.
   */
  safeTxOrigin?: boolean;
  /**
   * Set by `prepare_safe_tx_propose` ONLY when the user passed the affirmative
   * `acknowledgeSafeDelegateCall: true` gate for an inner `operation: 1`
   * (DELEGATECALL) Safe transaction. Read by the inner-action pre-sign gate
   * (issue #761): a `safeTxOrigin` tx whose inner operation is DELEGATECALL is
   * refused UNLESS this stamp is present. DELEGATECALL runs the inner target in
   * the Safe's own storage context and can rewrite its owner set (a full
   * takeover), so it must be a loud explicit opt-in rather than a plain
   * accepted literal.
   *
   * Trust note: like the sibling stamps (`safeTxOrigin`,
   * `acknowledgedNonProtocolTarget`), this flows through the server-minted
   * handle store; the agent cannot fabricate it on a tx that didn't come
   * through the propose path with the ack set. Setting it on any other path is
   * a server bug, not a user-controllable lever.
   */
  acknowledgedSafeDelegateCall?: boolean;
  /**
   * Set when the tx was built by a prepare_* tool that emits an
   * approve(spender, amount) where the spender is NOT in the canonical
   * protocol allowlist (Aave Pool, Compound Comet, Morpho Blue, Lido
   * Queue, EigenLayer, Uniswap NPM, Uniswap SwapRouter02, LiFi Diamond),
   * AND the user passed the affirmative `acknowledgeNonAllowlistedSpender:
   * true` schema-enforced gate at prepare time. Read by
   * `assertTransactionSafe` to skip ONLY the approve-spender-allowlist
   * refusal — every other pre-sign defense (chainId, simulation, payload
   * hash, ABI-selector check, transfer-on-unknown-token) stays active.
   *
   * Use case: tools like `prepare_curve_swap` that target a deep-liquidity
   * venue whose spender is well-known but isn't in the curated approve
   * allowlist. The allowlist remains a security recommendation: a warning
   * advisory is surfaced in the prepare receipt so the agent can relay
   * the trade-off to the user before they opt in.
   *
   * Trust note: like `acknowledgedNonProtocolTarget` and `safeTxOrigin`,
   * this flag flows through the handle store keyed by the server-minted
   * UUID. The agent cannot fabricate it on a tx that didn't come through
   * a prepare path that explicitly accepted the schema gate.
   */
  acknowledgedNonAllowlistedSpender?: boolean;
  /**
   * Invariant #14 — durable-binding source-of-truth verification (issue
   * #460). When the tx binds funds to a durable on-chain object selected
   * from a multi-candidate set (Compound Comet, Morpho marketId, Uniswap
   * V3 LP tokenId, allowance spender, ...) the prepare_* tool emits the
   * binding here so the skill can byte-equality-check it against the
   * prepared calldata + surface the provenance hint to the user before
   * signing. Absent for ops that don't bind to a durable identifier.
   */
  durableBindings?: import("../security/durable-binding.js").DurableBinding[];
}

/**
 * Unsigned Bitcoin transaction. Parallel to `UnsignedTronTx` /
 * `UnsignedSolanaTx`. Stores a PSBT (Partially Signed Bitcoin
 * Transaction, BIP-174) — the device signs it via
 * `@ledgerhq/hw-app-btc`'s `signPsbtBuffer`, we finalize, extract the
 * tx hex, and broadcast via the indexer.
 *
 * `decoded.outputs[]` and `decoded.changeOutput` carry the human-
 * readable preview the agent surfaces to the user. The PSBT bytes are
 * the source of truth — the device walks every output (including
 * change, with the "change" label when the path matches the wallet's
 * internal chain) and shows fee + total before asking for approval.
 */
export interface UnsignedBitcoinTx {
  chain: "bitcoin";
  /**
   * Discriminator for the action.
   *  - `native_send` — Phase 1 single-output send (also used by issue
   *    #264 multi-source consolidation).
   *  - `rbf_bump` — BIP-125 fee replacement of a stuck mempool tx.
   *    Same input set as the original, recipients preserved verbatim,
   *    the bump is absorbed by the change output.
   */
  action: "native_send" | "rbf_bump";
  /**
   * RBF replacement context — populated only on `action === "rbf_bump"`.
   * Lets the verification block surface "replacing TX <txid>" and the
   * old → new fee/fee-rate delta so the user reviews the bump itself,
   * not just the new tx in isolation. The original tx is identified by
   * `txid`; `oldFeeSats` + `oldFeeRateSatPerVb` come from the indexer.
   */
  replaces?: {
    txid: string;
    oldFeeSats: string;
    oldFeeRateSatPerVb: number;
  };
  /**
   * Primary source address (the first entry in `sources` for multi-source
   * sends, or the only source for single-source sends). Kept for
   * backwards compat — handlers and the verification block treat this as
   * the "from" label. Multi-source consumers should read `sources`.
   */
  from: string;
  /**
   * All source addresses contributing UTXOs to this tx. One entry per
   * unique source. Issue #264 — multi-input consolidation. For
   * single-source sends this is a one-element array; the signer treats
   * both shapes uniformly. All sources share `accountPath` +
   * `addressFormat` (Phase 1 intra-account / uniform-type constraint).
   */
  sources: Array<{
    address: string;
    /** Full leaf path of the source address, e.g. `84'/0'/0'/0/N`. */
    path: string;
    /** Compressed (or uncompressed; signer compresses) public key hex. */
    publicKey: string;
  }>;
  /**
   * Per-PSBT-input source address — `inputSources[i]` names which entry
   * in `sources` provided the i-th PSBT input. Used by the LTC legacy
   * `createPaymentTransaction` fallback to populate `associatedKeysets`
   * with the per-input path; the modern `signPsbtBuffer` path keys off
   * the witness program in each input's `witnessUtxo` script and looks
   * up the source via `knownAddressDerivations`. Length equals the PSBT
   * input count, in PSBT input order.
   */
  inputSources: string[];
  /** Base64-encoded PSBT v0 bytes. The device's `signPsbtBuffer` consumes this. */
  psbtBase64: string;
  /**
   * BIP-32 account-level path (e.g. `m/84'/0'/0'`) the PSBT signs from.
   * `signPsbtBuffer` requires this so it can populate missing BIP-32
   * derivation info on the PSBT inputs.
   */
  accountPath: string;
  /**
   * Address format the account uses — passed explicitly to
   * `signPsbtBuffer.addressFormat`. "bech32" for native segwit, etc.
   */
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
  /**
   * Internal-chain (BIP-32 chain=1) address the change output goes to,
   * plus its derivation. Threaded to the signer so it can register the
   * change output in `signPsbtBuffer.knownAddressDerivations` (and, for
   * the legacy `createPaymentTransaction` fallback, populate
   * `changePath`). Without this, the Ledger BTC app v2.x flags every
   * change output as "unusual change path". Issue #254.
   *
   * Optional only for tx envelopes built by older code paths or by
   * clients that pre-validated they want change-on-source — the modern
   * Phase-1 builder always sets it.
   */
  change?: {
    address: string;
    /** Full leaf path of the change address, e.g. `84'/0'/0'/1/0`. */
    path: string;
    /** Compressed (or uncompressed; signer compresses) public key hex. */
    publicKey: string;
  };
  /** Human-readable description for the preview. */
  description: string;
  /** Decoded outputs + fee + RBF flag. The shape Ledger's screen mirrors. */
  decoded: {
    functionName: string;
    args: Record<string, string>;
    outputs: Array<{
      address: string;
      amountSats: string;
      amountBtc: string;
      isChange: boolean;
      /** Path of the change output (when isChange=true), e.g. `m/84'/0'/0'/1/0`. */
      changePath?: string;
    }>;
    /**
     * Per-source breakdown — one entry per unique source contributing a
     * UTXO to this tx. Mirrors the verification-block "From: each source
     * address with sats pulled" line (issue #264). Always populated;
     * single-source sends produce a one-element array.
     */
    sources: Array<{
      address: string;
      /** Total sats pulled from this source across all selected inputs. */
      pulledSats: string;
      /** Same value as `pulledSats`, formatted as a BTC decimal string. */
      pulledBtc: string;
      /** How many of the PSBT's inputs come from this source. */
      inputCount: number;
    }>;
    feeSats: string;
    feeBtc: string;
    feeRateSatPerVb: number;
    /** Sequence number — < 0xFFFFFFFE marks the tx BIP-125 RBF-eligible. */
    rbfEligible: boolean;
  };
  /** Estimated tx vsize, used to derive the displayed feeRateSatPerVb. */
  vsize: number;
  /** Opaque handle — see btc-tx-store.ts. send_transaction consumes this. */
  handle?: string;
  /**
   * Domain-tagged sha256 over the PSBT base64. Pair-consistency
   * anchor between prepare → preview → sign stages. NOT shown
   * on-device (Ledger BTC clear-signs outputs; on-device anchor is
   * address + amount per output).
   */
  fingerprint?: `0x${string}`;
  /**
   * Address-book recipient metadata — see `UnsignedTx.recipient`.
   * Populated when `args.to` matched a contact label (or reverse-
   * decorated to a saved one). Threaded into the verification block.
   */
  recipient?: {
    label?: string;
    source: "literal" | "contact" | "ens" | "unknown";
    warnings?: string[];
  };
}

/**
 * Unsigned Litecoin transaction. Mirror of `UnsignedBitcoinTx` —
 * same PSBT-v0 shape, same Ledger app interface (currency:"litecoin"
 * on the SDK side selects Litecoin-specific encoding). Symbol fields
 * use LTC, but the on-wire bytes (PSBT, raw tx hex) use the same
 * format as BTC.
 */
export interface UnsignedLitecoinTx {
  chain: "litecoin";
  action: "native_send";
  from: string;
  /** See `UnsignedBitcoinTx.sources`. Issue #264. */
  sources: Array<{
    address: string;
    path: string;
    publicKey: string;
  }>;
  /** See `UnsignedBitcoinTx.inputSources`. Issue #264. */
  inputSources: string[];
  psbtBase64: string;
  accountPath: string;
  addressFormat: "legacy" | "p2sh" | "bech32" | "bech32m";
  /** See `UnsignedBitcoinTx.change`. Issue #254. */
  change?: {
    address: string;
    path: string;
    publicKey: string;
  };
  description: string;
  decoded: {
    functionName: string;
    args: Record<string, string>;
    outputs: Array<{
      address: string;
      amountSats: string;
      amountLtc: string;
      isChange: boolean;
      changePath?: string;
    }>;
    /** See `UnsignedBitcoinTx.decoded.sources`. Issue #264. */
    sources: Array<{
      address: string;
      pulledSats: string;
      pulledLtc: string;
      inputCount: number;
    }>;
    feeSats: string;
    feeLtc: string;
    feeRateSatPerVb: number;
    rbfEligible: boolean;
  };
  vsize: number;
  /** Opaque handle — see ltc-tx-store.ts. */
  handle?: string;
  fingerprint?: `0x${string}`;
}
