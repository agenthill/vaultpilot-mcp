import {
  AddressLookupTableAccount,
  PublicKey,
  TransactionInstruction,
  type AccountInfo,
  type Connection,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import { resolveAddressLookupTables } from "./alt.js";
import {
  buildAdvanceNonceIx,
  deriveNonceAccountAddress,
  getNonceAccountValue,
} from "./nonce.js";
import { throwNonceRequired } from "./actions.js";
import {
  issueSolanaDraftHandle,
  type SolanaTxDraft,
} from "../../signing/solana-tx-store.js";
import { SOLANA_TOKEN_DECIMALS, SOLANA_TOKENS } from "../../config/solana.js";

/**
 * MarginFi lending — supply / withdraw / borrow / repay + one-time PDA
 * MarginfiAccount init.
 *
 * Integration notes (scope-probed 2026-04-24 against SDK v6.4.1 — see
 * project_marginfi_sdk_scope.md):
 *
 * - Every action is durable-nonce-protected: ix[0] = SystemProgram.nonceAdvance,
 *   consistent with every other Solana send in this server. The wallet must
 *   have run prepare_solana_nonce_init before any prepare_marginfi_* call.
 *
 * - Init uses the PDA variant `marginfi_account_initialize_pda`. Plan's note
 *   3 claimed the SDK didn't wrap this; the scope-probe showed it does — via
 *   `instructions.makeInitMarginfiAccountPdaIx` — so we use the SDK wrapper
 *   instead of dropping to @coral-xyz/anchor codegen. Only `authority` and
 *   `fee_payer` sign; the MarginfiAccount PDA is writable but not a signer
 *   (Ledger-compatible).
 *
 * - Supply / Withdraw / Borrow / Repay go through
 *   `MarginfiAccountWrapper.make{Deposit,Repay,Withdraw,Borrow}Ix`. These
 *   return `InstructionsWrapper { instructions, keys: [] }`. `keys: []` is
 *   the Ledger-compatibility signal — no ephemeral Keypair signers in the
 *   lending happy path (scope-probed).
 *
 * - Transactions are always v0 VersionedMessages with the MarginFi group's
 *   Address Lookup Tables. MarginFi's group-wide ALTs (shipped in the SDK's
 *   ADDRESS_LOOKUP_TABLE_FOR_GROUP constant — 2 tables for the production
 *   group) compress account lists; without them a borrow/withdraw can blow
 *   past the 35-account legacy limit on banks with oracle cranks.
 */

const MAINNET_PROGRAM_ID = new PublicKey(
  "MFv2hWf31Z9kbCa1snEPYctwafyhdvnV7FZnsebVacA",
);

const MAINNET_GROUP = new PublicKey(
  "4qp6Fx6tnZkY5Wropq9wUYgtFxXKwE6viZxFHg3rdAG8",
);

/** ASCII bytes for `"marginfi_account"` — PDA seed 0 (16 bytes). */
const MARGINFI_ACCOUNT_SEED = Buffer.from("marginfi_account", "utf-8");

/**
 * Canonical MarginFi symbol → mint resolver. Piggybacks on the existing
 * SOLANA_TOKENS config so we don't duplicate the mint table. Extends with
 * "SOL" → wSOL mint (MarginFi's SOL bank uses wSOL under the hood — the SDK
 * auto-wraps/unwraps native SOL when `wrapAndUnwrapSol: true` is set, which
 * is our default).
 */
const WSOL_MINT = "So11111111111111111111111111111111111111112";

function resolveSymbolToMint(symbol: string): string {
  if (symbol === "SOL") return WSOL_MINT;
  const upper = symbol.toUpperCase();
  const sol = SOLANA_TOKENS[upper as keyof typeof SOLANA_TOKENS];
  if (!sol) {
    throw new Error(
      `Unknown token symbol "${symbol}". Supported: SOL, ${Object.keys(SOLANA_TOKENS).join(", ")}. ` +
        `Pass a canonical mint address in the \`mint\` field instead if you need a non-canonical token.`,
    );
  }
  return sol;
}

function resolveMintSymbol(mint: string): string {
  if (mint === WSOL_MINT) return "SOL";
  for (const [sym, addr] of Object.entries(SOLANA_TOKENS) as [
    keyof typeof SOLANA_TOKENS,
    string,
  ][]) {
    if (addr === mint) return sym;
  }
  return "UNKNOWN";
}

function resolveMintDecimals(mint: string): number | null {
  if (mint === WSOL_MINT) return 9;
  for (const [sym, addr] of Object.entries(SOLANA_TOKENS) as [
    keyof typeof SOLANA_TOKENS,
    string,
  ][]) {
    if (addr === mint) return SOLANA_TOKEN_DECIMALS[sym];
  }
  return null;
}

/**
 * Derive a wallet's deterministic MarginfiAccount PDA. Seeds per IDL 0.1.8:
 * ["marginfi_account", group, authority, account_index (u16 LE), third_party_id (u16 LE)].
 *
 * `accountIndex` lets one wallet own multiple MarginfiAccounts (most users
 * stay on 0). `thirdPartyId` is reserved for protocol integrators; we pass 0.
 */
export function deriveMarginfiAccountPda(
  authority: PublicKey,
  accountIndex = 0,
  thirdPartyId = 0,
  group: PublicKey = MAINNET_GROUP,
  programId: PublicKey = MAINNET_PROGRAM_ID,
): PublicKey {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(accountIndex);
  const tpidBuf = Buffer.alloc(2);
  tpidBuf.writeUInt16LE(thirdPartyId);
  const [pda] = PublicKey.findProgramAddressSync(
    [MARGINFI_ACCOUNT_SEED, group.toBuffer(), authority.toBuffer(), indexBuf, tpidBuf],
    programId,
  );
  return pda;
}

/**
 * Minimum SDK-facing `Wallet` shape (from @mrgnlabs/mrgn-common `types.d.ts`).
 * The SDK never *calls* `signTransaction` / `signAllTransactions` during ix
 * construction — only during the high-level `deposit()` flow, which we never
 * use. But the type shape is required to construct `MarginfiClient.fetch()`.
 * We stub the signers to throw on accidental call (defense in depth: if the
 * SDK ever starts invoking them in the ix path, tests will surface it with
 * a clear error rather than silently producing a tx with a zero signature).
 */
interface StubWallet {
  publicKey: PublicKey;
  signTransaction: <T>(tx: T) => Promise<T>;
  signAllTransactions: <T>(txs: T[]) => Promise<T[]>;
  signMessage?: (message: Uint8Array) => Promise<Uint8Array>;
}

function makeStubWallet(authority: PublicKey): StubWallet {
  const fail = (): never => {
    throw new Error(
      "MarginFi SDK attempted to sign through the stub wallet — this is a bug. " +
        "Ix construction should never invoke signTransaction / signAllTransactions. " +
        "Signing happens later via Ledger USB HID in send_transaction.",
    );
  };
  return {
    publicKey: authority,
    signTransaction: fail,
    signAllTransactions: fail,
  };
}

/**
 * Per-process cache for the (heavy) `MarginfiClient.fetch()` call. Keyed on
 * `group.toBase58()` — the client doesn't depend on the particular wallet
 * asking, only on group state (banks, oracle prices, bank metadatas). A
 * wallet-keyed cache would just multiply identical fetches.
 *
 * TTL of 60s balances two concerns: (1) MarginFi bank state (oracle prices,
 * reserve configs) shifts within minutes under normal conditions; (2) a
 * prepare_marginfi_* call cluster (init + supply + withdraw in one session)
 * shouldn't re-fetch 3 times.
 */
const CLIENT_CACHE_TTL_MS = 60_000;
interface CachedClient {
  // Typed as unknown so we don't export the heavy SDK types through our
  // module surface — callers interact via the module's public functions.
  client: unknown;
  expiresAt: number;
}
const clientCache = new Map<string, CachedClient>();

/**
 * Diagnostic record for a bank the hardened fetch path had to skip. Surfaced
 * so `findBankForMint` can tell "bank not listed on MarginFi" apart from
 * "bank IS listed but we failed to load it" (issue #107).
 *
 * `mint` is best-effort: on a step-2 Borsh decode failure we recover it from
 * the raw 32 bytes at offset 8 (the Bank account's first field), so even a
 * fully-undecodable bank gets an attributable mint.
 */
export type MarginfiBankSkipStep =
  | "decode"
  | "hydrate"
  | "tokenData"
  | "priceInfo";
export interface MarginfiBankSkipRecord {
  address: string;
  mint: string | null;
  step: MarginfiBankSkipStep;
  reason: string;
}
interface DiagnosticSnapshot {
  fetchedAt: number;
  addressesFetched: number;
  banksHydrated: number;
  skippedIntegrator: number;
  records: MarginfiBankSkipRecord[];
}
const lastGroupDiagnostics = new Map<string, DiagnosticSnapshot>();

function recordSkip(
  records: MarginfiBankSkipRecord[],
  address: PublicKey,
  mint: string | null,
  step: MarginfiBankSkipStep,
  err: unknown,
): void {
  const reason = err instanceof Error ? err.message : String(err);
  records.push({ address: address.toBase58(), mint, step, reason });
}

/**
 * Recover a bank's mint from the raw account data at IDL 0.1.8's known
 * offset (8-byte discriminator + 32-byte mint pubkey). Lets us attribute a
 * `decode`-step skip to a mint even when the Borsh layout is blind.
 *
 * Returns `null` if the data is too short or the bytes don't form a valid
 * base58 key — `findBankForMint`'s diagnostic then falls back to reporting
 * the bank address without the mint.
 */
function tryReadMintFromRawBankData(data: Buffer): string | null {
  if (data.length < 8 + 32) return null;
  try {
    return new PublicKey(data.subarray(8, 8 + 32)).toBase58();
  } catch {
    return null;
  }
}

async function getMarginfiClient(
  conn: Connection,
  authority: PublicKey,
): Promise<unknown> {
  const key = MAINNET_GROUP.toBase58();
  const existing = clientCache.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.client;

  const { MarginfiClient, getConfig } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  const config = getConfig("production");
  const wallet = makeStubWallet(authority);
  // Pass our hardened fetchGroupData so a single bank with a layout the
  // bundled IDL 0.1.8 can't decode doesn't blow up the whole client load
  // (issue #105 — `program.account.bank.all()` inside the SDK's default
  // path throws `Cannot read properties of null (reading 'property')`
  // when any on-chain Bank has a new field the IDL is blind to).
  const client = await MarginfiClient.fetch(config, wallet, conn, {
    readOnly: true,
    fetchGroupDataOverride: hardenedFetchGroupData,
  } as never);
  clientCache.set(key, {
    client,
    expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
  });
  return client;
}

/**
 * Hardened replacement for `MarginfiClient.fetchGroupData` that survives
 * per-bank / per-oracle decode failures. The default path calls
 * `program.account.bank.all([filter])`, which internally runs
 * `coder.accounts.decode` on every Bank account in one go — if even one
 * has a layout the bundled IDL (0.1.8) doesn't understand (MarginFi has
 * shipped on-chain changes faster than the SDK versions), the entire
 * client load fails with the opaque `null.property` runtime error.
 *
 * This version:
 *   1. Lists bank addresses via `getProgramAccounts` (same memcmp filter).
 *   2. Fetches raw account data via chunked plain `getMultipleAccountsInfo`
 *      (one HTTP call per ≤100-key chunk). NOT the SDK's batch-RPC path
 *      (`_rpcBatchRequest`), which rejects on many Solana RPC providers
 *      and surfaces as `"Failed to fetch account infos after 3 retries"`
 *      (issue #106).
 *   3. Decodes each bank in its own try/catch. Failures are skipped (with
 *      a console.warn tallying the count) — the client comes up with the
 *      set of banks it CAN understand.
 *   4. Skips integrator banks (KAMINO/DRIFT/SOLEND — AssetTag ≥ 3) same
 *      as the SDK does.
 *   5. Fetches oracles + mints + emission mints in one call (plain RPC).
 *   6. Per-bank wraps the price-info parse so a single unsupported oracle
 *      setup doesn't kill the whole client load either.
 *
 * Trade-off: banks we skip won't have positions surfaced via
 * `get_marginfi_positions` and can't be used as the target bank in
 * `prepare_marginfi_*`. The user sees a clear warning count, not a
 * broken client. Bump the SDK whenever a new release ships.
 */
/**
 * Fetch account infos for a list of pubkeys via plain
 * `connection.getMultipleAccountsInfo` (one HTTP call per ≤100-key chunk),
 * preserving input order + nulls.
 *
 * Replaces mrgn-common's `chunkedGetRawMultipleAccountInfoOrdered`, which
 * uses `connection._rpcBatchRequest` — JSON-RPC 2.0 batch requests are not
 * universally supported by Solana RPC providers. Rejecting providers make
 * the SDK's retry loop swallow the real error and surface a generic
 * `"Failed to fetch account infos after 3 retries"` (issue #106). The
 * plain `getMultipleAccounts` RPC is supported everywhere.
 */
async function chunkedGetAccountInfosWithNulls(
  conn: Connection,
  pubkeys: PublicKey[],
): Promise<Array<AccountInfo<Buffer> | null>> {
  const CHUNK_SIZE = 100;
  const out: Array<AccountInfo<Buffer> | null> = [];
  for (let i = 0; i < pubkeys.length; i += CHUNK_SIZE) {
    const chunk = pubkeys.slice(i, i + CHUNK_SIZE);
    const infos = await conn.getMultipleAccountsInfo(chunk, "confirmed");
    out.push(...infos);
  }
  return out;
}

/**
 * Account-decode coder built from MarginFi IDL **0.1.8** (18 OracleSetup
 * variants), used for the Bank-account Borsh decode in
 * `hardenedFetchGroupData`.
 *
 * Why not the SDK-default `program.coder`: marginfi-client-v2 6.4.2 ships
 * `marginfi_0.1.8.json` but STILL exports `MARGINFI_IDL` = 0.1.7 (see
 * `dist/idl/index.js`), so the `program` the SDK hands our override is
 * built from the 0.1.7 IDL — which only knows 13 OracleSetup variants and
 * throws `Cannot read properties of null (reading 'property')` on any bank
 * whose setup is JuplendPythPull (15) or JuplendSwitchboardPull (16). That
 * silently drops ~7 mainnet banks (USDC/USDT/SOL/USDS/JupSOL) at
 * step=decode (issue #156).
 *
 * Scope note: 0.1.8 fixes only the **decode** step — these banks now hydrate
 * and are suppliable (no longer reported as de-listed). The bundled SDK 6.4.2
 * runtime still cannot PARSE Juplend oracle setups (`parseOracleSetup` → "None"
 * → `parsePriceInfo` throws), so a genuinely Juplend-priced bank surfaces with
 * no price and is skipped at step=priceInfo; borrow/withdraw health and position
 * pricing for it stay impaired until the SDK adds Juplend oracle support upstream.
 *
 * Layout-safety: the `Bank` account is 1856 bytes in BOTH 0.1.7 and 0.1.8,
 * and `BankConfig` (which carries `oracleSetup`) is byte-identical between
 * them. 0.1.8 only re-interprets 0.1.7's trailing reserved `_padding_1`
 * (208 bytes) as `rate_limiter` + `_pad_0` + a shorter `_padding_1` — same
 * total size, previously-zeroed bytes. So decoding a real on-chain bank
 * with the 0.1.8 coder yields the same `config`/`mint`/etc. fields the
 * 0.1.7 coder did, plus it understands the wider enum.
 *
 * Cached per-process: the coder is pure (no connection/provider state), so
 * one instance serves every group/wallet.
 */
interface BankDecodeCoder {
  coder: { accounts: { decode(name: string, data: Buffer): unknown } };
}
let bankDecodeProgram018: BankDecodeCoder | null = null;
async function getBank018DecodeProgram(): Promise<BankDecodeCoder> {
  if (bankDecodeProgram018) return bankDecodeProgram018;
  const { Program } = await import("@coral-xyz/anchor");
  // Dynamic import of the 0.1.8 IDL JSON — matches this module's
  // dynamic-import style for the whole SDK surface and avoids a static
  // JSON import from node_modules (outside tsconfig `rootDir`).
  const idlMod = await import(
    "@mrgnlabs/marginfi-client-v2/dist/idl/marginfi_0.1.8.json",
    { with: { type: "json" } }
  );
  const idl018 = (idlMod as { default?: unknown }).default ?? idlMod;
  // A full Anchor `Program` (not a free-standing BorshAccountsCoder)
  // camelCases account-layout keys, so the decode call below uses the
  // lowercase `"bank"` key — identical to the SDK's default path and the
  // shape the issue-#108 guard test pins. We pass a stub provider: account
  // decoding never touches the connection.
  const program = new Program(
    { ...(idl018 as object), address: MAINNET_PROGRAM_ID.toBase58() } as never,
    { connection: {}, publicKey: undefined } as never,
  );
  bankDecodeProgram018 = program as unknown as BankDecodeCoder;
  return bankDecodeProgram018;
}

/**
 * Test-only: inject the bank-decode coder so unit tests that mock
 * `@coral-xyz/anchor` (the whole module) can still drive the decode step
 * — production builds the real 0.1.8 coder via `getBank018DecodeProgram`,
 * which a global anchor mock would otherwise break.
 */
export function __setBank018DecodeProgramForTest(coder: BankDecodeCoder): void {
  bankDecodeProgram018 = coder;
}

/** Test-only: drop the cached 0.1.8 decode program (vitest beforeEach). */
export function __clearBank018DecodeProgram(): void {
  bankDecodeProgram018 = null;
}

async function hardenedFetchGroupData(
  program: unknown,
  groupAddress: PublicKey,
  commitment: string | undefined,
  bankAddresses: PublicKey[] | undefined,
  bankMetadataMap: Record<string, unknown> | undefined,
): Promise<unknown> {
  const mfn = await import("@mrgnlabs/marginfi-client-v2");
  const common = await import("@mrgnlabs/mrgn-common");
  const {
    MarginfiGroup,
    Bank,
    BankConfig,
    AssetTag,
    parseOracleSetup,
    parsePriceInfo,
    findOracleKey,
  } = mfn as unknown as {
    MarginfiGroup: {
      fromBuffer(addr: PublicKey, data: Buffer, idl: unknown): unknown;
    };
    Bank: {
      fromAccountParsed(
        addr: PublicKey,
        data: unknown,
        feedIdMap: unknown,
        bankMetadata: unknown,
      ): unknown;
    };
    BankConfig: { fromAccountParsed(data: unknown): unknown };
    AssetTag: { KAMINO: number };
    parseOracleSetup: (raw: unknown) => unknown;
    parsePriceInfo: (
      setup: unknown,
      data: Buffer,
      fixedPrice: unknown,
    ) => unknown;
    findOracleKey: (cfg: unknown) => { oracleKey: PublicKey };
  };
  const { wrappedI80F48toBigNumber } = common as unknown as {
    wrappedI80F48toBigNumber: (w: unknown) => unknown;
  };

  // The SDK-built `program` is used only for the connection, the program
  // id, and `idl` (passed to MarginfiGroup.fromBuffer — group layout is
  // unaffected by the OracleSetup change, so the bundled 0.1.7 idl is fine
  // there). Bank-account decoding does NOT use `program.coder`; it uses the
  // dedicated 0.1.8 coder from getBank018DecodeProgram (issue #156).
  const p = program as {
    provider: { connection: Connection };
    programId: PublicKey;
    idl: unknown;
  };
  const conn = p.provider.connection;

  // Step 1: enumerate bank addresses. If the caller preloaded a set, honor
  // it; otherwise run the same memcmp filter the SDK uses to find all
  // banks tied to this group.
  let addresses: PublicKey[];
  if (bankAddresses && bankAddresses.length > 0) {
    addresses = bankAddresses;
  } else {
    const raw = await conn.getProgramAccounts(p.programId, {
      filters: [
        { memcmp: { offset: 8 + 32 + 1, bytes: groupAddress.toBase58() } },
      ],
    });
    addresses = raw.map((r) => r.pubkey);
  }

  // Step 2: fetch bank raw data (plain RPC, no batch) + decode with
  // per-bank try/catch.
  const bankAis = await chunkedGetAccountInfosWithNulls(conn, addresses);
  type BankDatum = { address: PublicKey; data: BankDecodedLike };
  interface BankDecodedLike {
    config: {
      assetTag?: number | null;
      oracleSetup: unknown;
      fixedPrice: unknown;
    };
    mint: PublicKey;
    emissionsMint: PublicKey;
  }
  const bankDatasKeyed: BankDatum[] = [];
  const skipRecords: MarginfiBankSkipRecord[] = [];
  let skippedIntegrator = 0;
  // Decode banks with the IDL-0.1.8 coder, NOT the SDK-default
  // `program.coder` (0.1.7). The SDK's `MARGINFI_IDL` is still 0.1.7 even
  // in 6.4.2, so its coder throws on OracleSetup variants 15/16 (issue
  // #156). 0.1.8's `Bank` layout is byte-compatible (see
  // getBank018DecodeProgram), so the decoded fields are identical apart
  // from the wider enum.
  const decodeProgram = await getBank018DecodeProgram();
  for (let i = 0; i < addresses.length; i++) {
    const ai = bankAis[i];
    if (!ai) continue;
    const address = addresses[i]!;
    try {
      // IDL 0.1.8 names the account "Bank" (PascalCase — see accounts[].name
      // in marginfi_0.1.8.json), but Anchor camelCases account-layout keys
      // when constructing the `BorshAccountsCoder` (live-probed against
      // `@coral-xyz/anchor@0.30.1`: `program.coder.accounts.accountLayouts`
      // contains `"bank"`, not `"Bank"`). So the key here matches
      // `program.account.bank` — the same shape the SDK's default path
      // uses internally.
      const decoded = decodeProgram.coder.accounts.decode(
        "bank",
        ai.data,
      ) as BankDecodedLike;
      // Skip integrator banks (KAMINO = 3, DRIFT = 4, SOLEND = 5). These
      // ride a different layout and aren't relevant to core lending.
      const tag = decoded.config?.assetTag;
      if (tag != null && tag >= AssetTag.KAMINO) {
        skippedIntegrator++;
        continue;
      }
      bankDatasKeyed.push({ address, data: decoded });
    } catch (err) {
      // Recover the mint from raw bytes so the diagnostic can still
      // attribute this skip to (e.g.) USDC even when the full layout is
      // opaque — enables the distinct "bank listed but skipped" error
      // in findBankForMint instead of the misleading "not listed" one
      // (issue #107).
      recordSkip(
        skipRecords,
        address,
        tryReadMintFromRawBankData(ai.data),
        "decode",
        err,
      );
    }
  }

  // Step 3: fetch group account + oracles + mints + emission mints (plain
  // RPC, no batch).
  const oracleKeys = bankDatasKeyed.map(
    (b) => findOracleKey(BankConfig.fromAccountParsed(b.data.config)).oracleKey,
  );
  const mintKeys = bankDatasKeyed.map((b) => b.data.mint);
  const emissionMintKeys = bankDatasKeyed
    .map((b) => b.data.emissionsMint)
    .filter((pk) => !pk.equals(PublicKey.default));
  const allAis = await chunkedGetAccountInfosWithNulls(conn, [
    groupAddress,
    ...oracleKeys,
    ...mintKeys,
    ...emissionMintKeys,
  ]);
  const groupAi = allAis.shift();
  const oracleAis = allAis.splice(0, oracleKeys.length);
  const mintAis = allAis.splice(0, mintKeys.length);

  if (!groupAi) {
    throw new Error(
      `Failed to fetch the on-chain MarginfiGroup at ${groupAddress.toBase58()} — RPC returned null.`,
    );
  }
  const marginfiGroup = MarginfiGroup.fromBuffer(
    groupAddress,
    groupAi.data,
    p.idl,
  );

  // Step 4: build the `banks` map with per-bank try/catch (hydration of
  // the Bank model could still trip if one mint metadata is surprising).
  const banks = new Map<string, unknown>();
  for (const { address, data } of bankDatasKeyed) {
    try {
      const bankMeta = bankMetadataMap
        ? bankMetadataMap[address.toBase58()]
        : undefined;
      const bank = Bank.fromAccountParsed(address, data, undefined, bankMeta);
      banks.set(address.toBase58(), bank);
    } catch (err) {
      // Decode succeeded so we know the mint — diagnostic attributes the
      // hydration failure to the specific token (e.g. "USDC bank skipped
      // at hydrate: Invalid risk tier") rather than dropping silently.
      recordSkip(skipRecords, address, data.mint.toBase58(), "hydrate", err);
    }
  }

  // Step 5: tokenDatas (mint + tokenProgram per bank). Per-bank try/catch
  // so a missing mint account doesn't kill the whole load.
  const tokenDatas = new Map<string, unknown>();
  for (let i = 0; i < bankDatasKeyed.length; i++) {
    const entry = bankDatasKeyed[i]!;
    const mintAi = mintAis[i];
    if (!mintAi) {
      recordSkip(
        skipRecords,
        entry.address,
        entry.data.mint.toBase58(),
        "tokenData",
        new Error("mint account fetch returned null"),
      );
      continue;
    }
    tokenDatas.set(entry.address.toBase58(), {
      mint: mintKeys[i],
      tokenProgram: mintAi.owner,
      feeBps: 0,
      emissionTokenProgram: null,
    });
  }

  // Step 6: priceInfos (oracle parse per bank). Per-bank try/catch — new
  // oracle setups that the SDK doesn't know how to parse become "no price"
  // rather than "client load fails".
  const priceInfos = new Map<string, unknown>();
  for (let i = 0; i < bankDatasKeyed.length; i++) {
    const entry = bankDatasKeyed[i]!;
    const priceAi = oracleAis[i];
    if (!priceAi) {
      recordSkip(
        skipRecords,
        entry.address,
        entry.data.mint.toBase58(),
        "priceInfo",
        new Error("oracle account fetch returned null"),
      );
      continue;
    }
    try {
      const oracleSetup = parseOracleSetup(entry.data.config.oracleSetup);
      const fixedPrice = wrappedI80F48toBigNumber(entry.data.config.fixedPrice);
      const parsed = parsePriceInfo(oracleSetup, priceAi.data, fixedPrice);
      priceInfos.set(entry.address.toBase58(), parsed);
    } catch (err) {
      recordSkip(
        skipRecords,
        entry.address,
        entry.data.mint.toBase58(),
        "priceInfo",
        err,
      );
    }
  }

  // Publish the diagnostic snapshot BEFORE returning so callers (most
  // importantly `findBankForMint`) can consult it on the next step.
  lastGroupDiagnostics.set(groupAddress.toBase58(), {
    fetchedAt: Date.now(),
    addressesFetched: addresses.length,
    banksHydrated: banks.size,
    skippedIntegrator,
    records: skipRecords,
  });

  // One consolidated warning keeps log volume sane but gives ops a hook.
  // Integrator (KAMINO/DRIFT/SOLEND) skips are expected, not noise.
  if (skipRecords.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vaultpilot/marginfi] fetchGroupData: skipped ${skipRecords.length} bank(s). ` +
        `Breakdown: ${summarizeSkipsByStep(skipRecords)}. Expected integrator skips: ${skippedIntegrator}. ` +
        `Call get_marginfi_diagnostics for per-bank detail.`,
    );
  }

  return {
    marginfiGroup,
    banks,
    priceInfos,
    tokenDatas,
    feedIdMap: new Map(),
  };
}

function summarizeSkipsByStep(records: MarginfiBankSkipRecord[]): string {
  const counts: Record<MarginfiBankSkipStep, number> = {
    decode: 0,
    hydrate: 0,
    tokenData: 0,
    priceInfo: 0,
  };
  for (const r of records) counts[r.step]++;
  return (Object.keys(counts) as MarginfiBankSkipStep[])
    .filter((k) => counts[k] > 0)
    .map((k) => `${k}=${counts[k]}`)
    .join(", ");
}

/**
 * Public accessor for the last hardened-fetch diagnostic snapshot for the
 * mainnet group. Returns `null` when no fetch has happened yet in this
 * process. Consumed by the `get_marginfi_diagnostics` MCP tool AND by
 * `findBankForMint` to distinguish "bank not listed" from "bank listed
 * but skipped by hardened decode" (issue #107).
 */
export function getLastMarginfiGroupDiagnostics(
  group: PublicKey = MAINNET_GROUP,
): DiagnosticSnapshot | null {
  return lastGroupDiagnostics.get(group.toBase58()) ?? null;
}

/** Test-only hook: reset the diagnostic store between tests. */
export function __clearMarginfiGroupDiagnostics(): void {
  lastGroupDiagnostics.clear();
}

/** Test-only hook: preload a diagnostic snapshot (used by unit tests). */
export function __setMarginfiGroupDiagnosticsForTest(
  snapshot: DiagnosticSnapshot,
  group: PublicKey = MAINNET_GROUP,
): void {
  lastGroupDiagnostics.set(group.toBase58(), snapshot);
}

/**
 * Public entry point for reader-side callers (`positions/marginfi.ts`) to
 * ride the same cache + hardened decode override the builder path uses.
 * Keeps the two paths from duplicating the stub-wallet + override wiring.
 */
export async function getHardenedMarginfiClient(
  conn: Connection,
  authority: PublicKey,
): Promise<unknown> {
  return getMarginfiClient(conn, authority);
}

/** Test-only: expose the hardened fetchGroupData for direct-path testing. */
export const __hardenedFetchGroupDataForTest = hardenedFetchGroupData;

/** Test-only hook so unit tests don't pay the cost of a live fetch. */
export function __setMarginfiClientCacheEntry(client: unknown): void {
  clientCache.set(MAINNET_GROUP.toBase58(), {
    client,
    expiresAt: Date.now() + CLIENT_CACHE_TTL_MS,
  });
}

/** Test-only clear hook for vitest's beforeEach. */
export function __clearMarginfiClientCache(): void {
  clientCache.clear();
}

/**
 * Minimal shape of the SDK objects we touch — deliberately narrow so the
 * concrete SDK types don't leak across the boundary. Any widening here
 * requires a matching widening of the SDK call in a builder function (the
 * TypeScript compiler will surface the mismatch).
 */
interface MinimalBank {
  address: PublicKey;
  mint: PublicKey;
  config: { assetWeightInit: BigNumber; liabilityWeightInit: BigNumber };
  tokenSymbol?: string;
  isPaused?: boolean;
}
interface MinimalClient {
  getBankByMint(mint: PublicKey): MinimalBank | null;
  banks: Map<string, MinimalBank>;
  program: unknown;
  wallet: StubWallet;
  group: unknown;
}
interface MinimalBalance {
  bankPk: PublicKey;
  active: boolean;
}
interface MinimalWrapper {
  address: PublicKey;
  activeBalances: MinimalBalance[];
  makeDepositIx(
    amount: number | string | BigNumber,
    bankAddress: PublicKey,
    opts?: Record<string, unknown>,
  ): Promise<{ instructions: TransactionInstruction[]; keys: unknown[] }>;
  makeRepayIx(
    amount: number | string | BigNumber,
    bankAddress: PublicKey,
    repayAll?: boolean,
    opts?: Record<string, unknown>,
  ): Promise<{ instructions: TransactionInstruction[]; keys: unknown[] }>;
  makeWithdrawIx(
    amount: number | string | BigNumber,
    bankAddress: PublicKey,
    withdrawAll?: boolean,
    opts?: Record<string, unknown>,
  ): Promise<{ instructions: TransactionInstruction[]; keys: unknown[] }>;
  makeBorrowIx(
    amount: number | string | BigNumber,
    bankAddress: PublicKey,
    opts?: Record<string, unknown>,
  ): Promise<{ instructions: TransactionInstruction[]; keys: unknown[] }>;
  computeHealthComponents(req: unknown): {
    assets: BigNumber;
    liabilities: BigNumber;
  };
  /**
   * Recompute health from active balances + raw bank state + oracle prices.
   * Unlike `computeHealthComponents` (which reads the on-chain `healthCache`
   * field — frequently all-zero on recently-supplied accounts in SDK v6.4.1
   * — see issue #110), this path weights each balance by `assetWeightInit` /
   * `assetWeightMaint` live and matches what the on-chain borrow/withdraw
   * program computes at ix time.
   */
  computeHealthComponentsLegacy(req: unknown): {
    assets: BigNumber;
    liabilities: BigNumber;
  };
  computeFreeCollateral(): BigNumber;
}

async function fetchMarginfiAccountWrapper(
  client: unknown,
  pda: PublicKey,
): Promise<MinimalWrapper | null> {
  const { MarginfiAccountWrapper } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  try {
    const wrapper = await MarginfiAccountWrapper.fetch(pda, client as never);
    return wrapper as unknown as MinimalWrapper;
  } catch (e) {
    // The SDK throws on missing account; fold into a null so the caller can
    // distinguish "account exists but fetch errored" from "user hasn't init'd".
    const msg = e instanceof Error ? e.message : String(e);
    if (/account.*does not exist|not found|Account does not exist/i.test(msg)) {
      return null;
    }
    throw e;
  }
}

function findBankForMint(client: unknown, mint: string): MinimalBank {
  const c = client as MinimalClient;
  const bank = c.getBankByMint(new PublicKey(mint));
  if (!bank) {
    // Issue #107 — before reporting "not listed", check the hardened
    // fetch's skip log: a bank CAN be live on-chain yet absent from
    // `client.banks` because we hit a decode/hydrate/oracle failure
    // while loading it. Collapsing that into the generic message misled
    // users into thinking MarginFi had de-listed the token.
    const diag = getLastMarginfiGroupDiagnostics();
    const skipped = diag?.records.find((r) => r.mint === mint);
    if (skipped) {
      throw new Error(
        `MarginFi bank for ${resolveMintSymbol(mint)} (mint ${mint}) IS listed on-chain but was ` +
          `skipped by the hardened client load at step "${skipped.step}" (bank ${skipped.address}). ` +
          `Reason: ${skipped.reason}. This usually means MarginFi shipped an on-chain ` +
          `change (new risk tier, operational state, oracle setup, or asset tag) that the ` +
          `bundled SDK v6.4.2 / IDL 0.1.8 doesn't yet understand. Workaround: bump @mrgnlabs/marginfi-client-v2 ` +
          `to a release that recognizes the new layout. Full skip log: call get_marginfi_diagnostics.`,
      );
    }
    throw new Error(
      `No MarginFi bank found for mint ${mint} (${resolveMintSymbol(mint)}). ` +
        `MarginFi lists a subset of SPL tokens; not every mainnet SPL is supported. ` +
        `Check https://app.marginfi.com for the current bank list.`,
    );
  }
  if (bank.isPaused) {
    throw new Error(
      `MarginFi bank for ${resolveMintSymbol(mint)} is paused by governance. ` +
        `Supply / withdraw / borrow / repay are all blocked until an unpause proposal passes. ` +
        `Refusing to prepare the tx.`,
    );
  }
  return bank;
}

export interface PreparedMarginfiTx {
  handle: string;
  action:
    | "marginfi_init"
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  nonceAccount: string;
  marginfiAccount: string;
  /**
   * Rent-exempt minimum in lamports. Populated on `marginfi_init` — the
   * PDA's 2312-byte account needs ~0.01698 SOL sent from the user's wallet
   * (reclaimable on close). Surfaced so the agent's bullet summary shows
   * the real cost to the user BEFORE they blind-sign (issue #103).
   */
  rentLamports?: number;
  /**
   * Invariant #14 — bank pubkey on supply/withdraw/borrow/repay; absent
   * on `marginfi_init` (no candidate-set selection — only one MarginfiAccount
   * PDA per (wallet, group)). Issue #460.
   */
  durableBindings?: import("../../security/durable-binding.js").DurableBinding[];
}

export interface MarginfiInitParams {
  wallet: string;
  /** Account slot (0 = first, 1 = second, ...) — lets one wallet own multiple MarginfiAccounts. */
  accountIndex?: number;
}

/**
 * Build the one-time `marginfi_account_initialize_pda` tx. Deterministic PDA,
 * only the user signs as authority + fee_payer. Runs under durable-nonce
 * protection so the user has unbounded Ledger review time.
 */
export async function buildMarginfiInit(
  p: MarginfiInitParams,
): Promise<PreparedMarginfiTx> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const accountIndex = p.accountIndex ?? 0;
  const conn = getSolanaConnection();

  // Durable-nonce preflight.
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(p.wallet);

  const marginfiAccount = deriveMarginfiAccountPda(fromPubkey, accountIndex);

  // Rent-exempt minimum for the 2312-byte MarginfiAccount PDA. The user's
  // wallet funds this directly — no ephemeral keypair involved, but the
  // SOL still leaves the wallet (reclaimable when the account is closed).
  // Surfaced on the prepared tx so the agent's bullet summary can show
  // real cost to the user before they blind-sign (issue #103).
  const MARGINFI_ACCOUNT_SIZE_BYTES = 2312;
  const rentLamports = await conn.getMinimumBalanceForRentExemption(
    MARGINFI_ACCOUNT_SIZE_BYTES,
  );

  // Refuse re-init — the on-chain ix reverts, but we get a clearer error by
  // short-circuiting here. ~0.017 SOL would otherwise burn on the failed send.
  const existing = await conn.getAccountInfo(marginfiAccount, "confirmed");
  if (existing) {
    throw new Error(
      `MarginfiAccount already exists at PDA ${marginfiAccount.toBase58()} ` +
        `for wallet ${p.wallet} (account_index=${accountIndex}). ` +
        `If you want a second MarginfiAccount, call prepare_marginfi_init with a different ` +
        `accountIndex (1, 2, ...). If you want to keep using this one, call ` +
        `prepare_marginfi_supply / withdraw / borrow / repay directly.`,
    );
  }

  const { instructions: mfnInstructions } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  const initIx = await mfnInstructions.makeInitMarginfiAccountPdaIx(
    // The SDK's helper takes a `Program<Marginfi>` for `mfProgram`. We don't
    // need a full client for the init path — just a Program bound to the
    // program ID + a dummy provider. Construct it minimally.
    (await buildMarginfiProgram(conn, fromPubkey)) as never,
    {
      marginfiGroup: MAINNET_GROUP,
      marginfiAccount,
      authority: fromPubkey,
      feePayer: fromPubkey,
    },
    { accountIndex, thirdPartyId: 0 },
  );

  const instructions: TransactionInstruction[] = [
    buildAdvanceNonceIx(noncePubkey, fromPubkey),
    initIx,
  ];

  // Use v0 even for init — the ALT set is empty here (no complex account
  // list yet), but v0 keeps the draft store branching uniform across all
  // MarginFi actions.
  const alts: AddressLookupTableAccount[] = [];

  const nonceAccountStr = noncePubkey.toBase58();
  const marginfiAccountStr = marginfiAccount.toBase58();
  const draft: SolanaTxDraft = {
    kind: "v0",
    payerKey: fromPubkey,
    instructions,
    addressLookupTableAccounts: alts,
    meta: {
      action: "marginfi_init",
      from: p.wallet,
      description:
        `Initialize MarginfiAccount ${marginfiAccountStr} for ${p.wallet} ` +
        `(accountIndex=${accountIndex}, third_party_id=0). One-time setup — rent-exempt ` +
        `minimum ~${(rentLamports / 1e9).toFixed(6)} SOL is moved from your wallet to ` +
        `fund the PDA (2312-byte account), reclaimable when the account is closed. ` +
        `No separate keypair required.`,
      decoded: {
        functionName: "marginfi.account_initialize_pda",
        args: {
          wallet: p.wallet,
          marginfiAccount: marginfiAccountStr,
          authority: p.wallet,
          marginfiGroup: MAINNET_GROUP.toBase58(),
          accountIndex: String(accountIndex),
          thirdPartyId: "0",
          nonceAccount: nonceAccountStr,
          rentLamports: String(rentLamports),
          rentSol: (rentLamports / 1e9).toFixed(9).replace(/\.?0+$/, ""),
        },
      },
      rentLamports,
      nonce: {
        account: nonceAccountStr,
        authority: fromPubkey.toBase58(),
        value: nonceState.nonce,
      },
    },
  };
  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "marginfi_init",
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: nonceAccountStr,
    marginfiAccount: marginfiAccountStr,
    rentLamports,
  };
}

/**
 * Construct an Anchor `Program<Marginfi>` instance pointed at mainnet MarginFi
 * with a stub provider. Only the init path needs this directly — supply/
 * withdraw/borrow/repay go through the higher-level MarginfiAccountWrapper
 * which already has a `_program` internal.
 *
 * Deliberately inlined here rather than shared with `getMarginfiClient`'s
 * internal Program to keep the init path's dependency surface minimal
 * (anchor, idl, program — nothing else).
 */
async function buildMarginfiProgram(
  conn: Connection,
  authority: PublicKey,
): Promise<unknown> {
  const { AnchorProvider, Program } = await import("@coral-xyz/anchor");
  const { MARGINFI_IDL } = await import("@mrgnlabs/marginfi-client-v2");
  const wallet = makeStubWallet(authority);
  const provider = new AnchorProvider(conn, wallet as never, {
    commitment: "confirmed",
  });
  // `MARGINFI_IDL` is typed as v0.1.7 IDL; spreading overrides .address to
  // the deployed program id. Same pattern the SDK's `MarginfiClient.fetch`
  // uses internally.
  const idl = { ...MARGINFI_IDL, address: MAINNET_PROGRAM_ID.toBase58() };
  return new Program(idl, provider);
}

export interface MarginfiActionParams {
  wallet: string;
  /** Canonical symbol ("USDC", "SOL", "USDT", ...) — resolved via SOLANA_TOKENS. */
  symbol?: string;
  /** OR pass an explicit mint address to override the symbol lookup. */
  mint?: string;
  /** Human-readable amount (e.g., "1.5" for 1.5 USDC). Decimals resolved from the bank. */
  amount: string;
  accountIndex?: number;
}

type ActionKind = "supply" | "withdraw" | "borrow" | "repay";

interface ResolvedActionContext {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
  marginfiAccount: PublicKey;
  wrapper: MinimalWrapper;
  bank: MinimalBank;
  mint: string;
  symbol: string;
  amountUi: BigNumber;
}

async function resolveActionContext(
  p: MarginfiActionParams,
  kind: ActionKind,
): Promise<ResolvedActionContext> {
  const fromPubkey = assertSolanaAddress(p.wallet);
  const conn = getSolanaConnection();

  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(p.wallet);

  const accountIndex = p.accountIndex ?? 0;
  const marginfiAccount = deriveMarginfiAccountPda(fromPubkey, accountIndex);
  const info = await conn.getAccountInfo(marginfiAccount, "confirmed");
  if (!info) {
    throw new Error(
      `No MarginfiAccount exists for ${p.wallet} (accountIndex=${accountIndex}). ` +
        `Run prepare_marginfi_init first — it's a one-time setup (no rent-exempt seed moved; ` +
        `only ~0.000005 SOL tx fee) that creates your MarginFi lending state account.`,
    );
  }

  const mint = p.mint ?? resolveSymbolToMint(p.symbol ?? "");
  if (!mint) {
    throw new Error(
      `Specify either \`symbol\` (USDC / SOL / USDT / ...) or \`mint\` (base58 SPL mint). Neither supplied.`,
    );
  }
  const symbol = resolveMintSymbol(mint);

  // The SDK-heavy paths below have produced opaque `null.property` errors
  // in live testing when the MarginfiAccount is freshly-initialized or
  // when one of the production group's banks has a layout the bundled IDL
  // doesn't understand (issue #102). Wrap each heavy call so the user
  // gets an actionable message naming the step + PDA + wallet instead of
  // a raw runtime trace.
  let client: unknown;
  try {
    client = await getMarginfiClient(conn, fromPubkey);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(
      `MarginfiClient load failed for wallet ${p.wallet} — the bundled SDK (v6.4.2) ` +
        `couldn't decode one of the production group's banks or oracle prices. ` +
        `Raw error: ${raw}. Retry in a minute; if it persists, MarginFi may have ` +
        `shipped an on-chain upgrade the SDK version doesn't support yet.`,
      { cause: e },
    );
  }
  const bank = findBankForMint(client, mint);

  let wrapper: MinimalWrapper | null;
  try {
    wrapper = await fetchMarginfiAccountWrapper(client, marginfiAccount);
  } catch (e) {
    const raw = e instanceof Error ? e.message : String(e);
    throw new Error(
      `MarginfiAccount hydration failed for ${marginfiAccount.toBase58()} ` +
        `(wallet ${p.wallet}, accountIndex=${accountIndex}). Raw error: ${raw}. ` +
        `The account exists on chain (verified earlier in this call) but the ` +
        `SDK can't parse it. If you just ran prepare_marginfi_init, wait one ` +
        `confirmation and retry.`,
      { cause: e },
    );
  }
  if (!wrapper) {
    throw new Error(
      `MarginfiAccount at ${marginfiAccount.toBase58()} exists on chain but the SDK could ` +
        `not hydrate it as a MarginfiAccountWrapper — this is unexpected. Retry; if it ` +
        `persists, the account data may be in a new schema this SDK version (v6.4.2) ` +
        `doesn't understand.`,
    );
  }

  // Action-specific pre-flight beyond the bank pause check that
  // findBankForMint already enforced.
  //
  // Must use the Legacy (recompute-from-raw) compute path, NOT
  // `computeFreeCollateral()`. The SDK's default `computeFreeCollateral`
  // reads `marginfiAccount.healthCache.assetValue` — an on-chain field
  // that is all-zero on MarginfiAccounts where the program hasn't yet
  // written a fresh health cache. Live-probed a wallet with 1 SOL +
  // 1 USDC supplied (issue #110, wallet 4FLpsz…): healthCache.assetValue
  // = 0 across all three margin types, yet computeHealthComponentsLegacy
  // correctly recomputes to ~$70 weighted collateral at Initial. The
  // cache-based path was producing a false-negative refusal on every
  // freshly-supplied account.
  //
  // Soft pre-flight: on throw we skip the guard and let the on-chain
  // program enforce the real check (cost of failure is one tx fee).
  if (kind === "borrow" || kind === "withdraw") {
    let free: BigNumber | null = null;
    try {
      const { assets, liabilities } = wrapper.computeHealthComponentsLegacy(
        0, // MarginRequirementType.Initial — what the on-chain borrow check uses
      );
      free = BigNumber.max(new BigNumber(0), assets.minus(liabilities));
    } catch {
      free = null;
    }
    if (free && free.lte(0)) {
      throw new Error(
        `MarginfiAccount has zero free collateral — ${kind === "borrow" ? "cannot take on new debt" : "withdrawing would push health factor below the required ratio"}. ` +
          `Supply more collateral or repay existing debt first.`,
      );
    }
  }

  const amountUi = new BigNumber(p.amount);
  if (!amountUi.isFinite() || amountUi.lte(0)) {
    throw new Error(
      `Invalid amount "${p.amount}" — expected a positive decimal (e.g. "1.5").`,
    );
  }

  return {
    fromPubkey,
    noncePubkey,
    nonceValue: nonceState.nonce,
    marginfiAccount,
    wrapper,
    bank,
    mint,
    symbol,
    amountUi,
  };
}

async function wrapWithNonce(
  ctx: ResolvedActionContext,
  actionLabel: string,
  actionAction:
    | "marginfi_supply"
    | "marginfi_withdraw"
    | "marginfi_borrow"
    | "marginfi_repay",
  bankIxs: TransactionInstruction[],
  p: MarginfiActionParams,
): Promise<PreparedMarginfiTx> {
  const conn = getSolanaConnection();

  // MarginFi publishes group-wide ALTs (2 tables for the production group).
  // Pull them into the v0 draft so borrow/withdraw flows with oracle cranks
  // fit inside the 1232-byte packet ceiling.
  const altPubkeys = await getMarginfiGroupAltAddresses();
  const alts = await resolveAddressLookupTables(conn, altPubkeys);

  const accountIndex = p.accountIndex ?? 0;
  const nonceAccountStr = ctx.noncePubkey.toBase58();
  const marginfiAccountStr = ctx.marginfiAccount.toBase58();

  // Stamp the set of banks MarginFi's risk engine will cross-check — the
  // target bank + every bank backing an active balance on this MarginfiAccount
  // (including the one we just added via the target-bank path, deduped).
  // Used by preview_solana_send to diagnose RiskEngineInitRejected by
  // probing each bank's oracle age (issue #116).
  const touchedBanks = new Set<string>([ctx.bank.address.toBase58()]);
  for (const balance of ctx.wrapper.activeBalances) {
    if (balance.active) touchedBanks.add(balance.bankPk.toBase58());
  }
  const touchedBanksArr = [...touchedBanks];

  // Issue #116 ask C — auto-prepend Switchboard Pull oracle cranks when
  // any touched bank uses a SwitchboardPull feed. These feeds only land
  // on-chain via an explicit update ix; without it the risk engine
  // rejects with `RiskEngineInitRejected (6009)` even when health is fine.
  // The MarginFi UI does this same prepend automatically.
  //
  // Best-effort: if `createUpdateFeedIx` throws (Switchboard Crossbar
  // gateway down, loadProgramFromConnection fails, etc.) we log and
  // proceed without crank. The #115 sim gate still catches the revert
  // and the #116 diagnosis will name the stale oracle — no worse than
  // before this PR for the bad-gateway edge case.
  const client = await getMarginfiClient(conn, ctx.fromPubkey);
  const { buildSwitchboardCrankIxs, patchSecp256k1CrankIxPosition } =
    await import("./swb-crank.js");
  let crankInstructions: TransactionInstruction[] = [];
  let crankLuts: AddressLookupTableAccount[] = [];
  let crankedOracles: string[] = [];
  try {
    const result = await buildSwitchboardCrankIxs(
      conn,
      ctx.fromPubkey,
      touchedBanksArr,
      client,
    );
    crankInstructions = result.instructions;
    crankLuts = result.luts;
    crankedOracles = result.oracles;
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[vaultpilot/marginfi] Switchboard crank prepend failed (${e instanceof Error ? e.message : String(e)}). ` +
        `Proceeding without crank — if a touched bank needs fresh oracle data, ` +
        `the pre-sign simulation gate will catch it with a diagnosis naming the stale feed.`,
    );
  }

  // Assemble the final ix list:
  //   ix[0] = nonceAdvance  (REQUIRED — Agave detects durable-nonce txs by
  //                          checking ix[0] specifically; any other position
  //                          falls back to the ~90s blockhash window)
  //   ix[1] = ComputeBudget.setComputeUnitLimit  (only when crank adds
  //            SWB ixs; marginfi borrow alone fits in the 200k default,
  //            but SWB secp256k1 verify + marginfi risk engine combined
  //            peaked at ~400k CU in live probes — 1.4M is the SDK's
  //            simulate-health default, same headroom used here)
  //   ix[2] = Secp256k1 sig-verify pre-compile  (crank ix 0; MUST have
  //            its three instruction_index bytes patched to point to its
  //            new position — the SDK hard-codes 0, which only works when
  //            it's the very first tx instruction; live-probed to fail
  //            with Custom:2 otherwise)
  //   ix[3] = Switchboard submit  (crank ix 1; positions-insensitive)
  //   ix[4..] = MarginFi action ixs
  const { ComputeBudgetProgram } = await import("@solana/web3.js");
  const nonceIx = buildAdvanceNonceIx(ctx.noncePubkey, ctx.fromPubkey);
  const computeIx = ComputeBudgetProgram.setComputeUnitLimit({
    units: 1_400_000,
  });
  const prefix: TransactionInstruction[] =
    crankInstructions.length > 0 ? [nonceIx, computeIx] : [nonceIx];
  const patchedCrank = crankInstructions.map((ix, idx) =>
    patchSecp256k1CrankIxPosition(ix, prefix.length + idx),
  );
  const instructions: TransactionInstruction[] = [
    ...prefix,
    ...patchedCrank,
    ...bankIxs,
  ];

  const draft: SolanaTxDraft = {
    kind: "v0",
    payerKey: ctx.fromPubkey,
    instructions,
    addressLookupTableAccounts: [...alts, ...crankLuts],
    meta: {
      action: actionAction,
      from: p.wallet,
      description:
        `MarginFi ${actionLabel}: ${ctx.amountUi.toFixed()} ${ctx.symbol} ` +
        `(account ${marginfiAccountStr.slice(0, 8)}…, bank ${ctx.bank.address.toBase58().slice(0, 8)}…)` +
        (crankedOracles.length > 0
          ? ` — auto-cranking ${crankedOracles.length} Switchboard oracle(s)`
          : ""),
      decoded: {
        functionName: `marginfi.${actionAction.replace("marginfi_", "lending_account_")}`,
        args: {
          wallet: p.wallet,
          marginfiAccount: marginfiAccountStr,
          accountIndex: String(accountIndex),
          bank: ctx.bank.address.toBase58(),
          mint: ctx.mint,
          symbol: ctx.symbol,
          amount: ctx.amountUi.toFixed() + " " + ctx.symbol,
          nonceAccount: nonceAccountStr,
        },
      },
      nonce: {
        account: nonceAccountStr,
        authority: ctx.fromPubkey.toBase58(),
        value: ctx.nonceValue,
      },
      marginfiTouchedBanks: touchedBanksArr,
      marginfiOracleCranks: {
        oracles: crankedOracles,
        instructionCount: crankInstructions.length,
      },
    },
  };

  const { handle } = issueSolanaDraftHandle(draft);
  const { makeDurableBinding } = await import(
    "../../security/durable-binding.js"
  );
  return {
    handle,
    action: actionAction,
    chain: "solana",
    from: p.wallet,
    description: draft.meta.description,
    decoded: draft.meta.decoded,
    nonceAccount: nonceAccountStr,
    marginfiAccount: marginfiAccountStr,
    durableBindings: [
      makeDurableBinding("marginfi-bank-pubkey", ctx.bank.address.toBase58()),
    ],
  };
}

async function getMarginfiGroupAltAddresses(): Promise<PublicKey[]> {
  const { ADDRESS_LOOKUP_TABLE_FOR_GROUP } = await import(
    "@mrgnlabs/marginfi-client-v2"
  );
  return (
    ADDRESS_LOOKUP_TABLE_FOR_GROUP[MAINNET_GROUP.toBase58()] ?? []
  ) as PublicKey[];
}

export async function buildMarginfiSupply(
  p: MarginfiActionParams,
): Promise<PreparedMarginfiTx> {
  const ctx = await resolveActionContext(p, "supply");
  const { instructions } = await ctx.wrapper.makeDepositIx(
    ctx.amountUi,
    ctx.bank.address,
  );
  return wrapWithNonce(ctx, "supply", "marginfi_supply", instructions, p);
}

export async function buildMarginfiWithdraw(
  p: MarginfiActionParams & { withdrawAll?: boolean },
): Promise<PreparedMarginfiTx> {
  const ctx = await resolveActionContext(p, "withdraw");
  const { instructions } = await ctx.wrapper.makeWithdrawIx(
    ctx.amountUi,
    ctx.bank.address,
    p.withdrawAll ?? false,
  );
  return wrapWithNonce(ctx, "withdraw", "marginfi_withdraw", instructions, p);
}

export async function buildMarginfiBorrow(
  p: MarginfiActionParams,
): Promise<PreparedMarginfiTx> {
  const ctx = await resolveActionContext(p, "borrow");
  const { instructions } = await ctx.wrapper.makeBorrowIx(
    ctx.amountUi,
    ctx.bank.address,
  );
  return wrapWithNonce(ctx, "borrow", "marginfi_borrow", instructions, p);
}

export async function buildMarginfiRepay(
  p: MarginfiActionParams & { repayAll?: boolean },
): Promise<PreparedMarginfiTx> {
  const ctx = await resolveActionContext(p, "repay");
  const { instructions } = await ctx.wrapper.makeRepayIx(
    ctx.amountUi,
    ctx.bank.address,
    p.repayAll ?? false,
  );
  return wrapWithNonce(ctx, "repay", "marginfi_repay", instructions, p);
}

/**
 * Diagnose a MarginFi simulation rejection (issue #116). Currently handles
 * Anchor error 6009 (RiskEngineInitRejected) — the most common + most
 * ambiguous failure mode — by probing each touched bank's oracle age
 * against its configured `oracleMaxAge` and telling the agent whether the
 * rejection is "stale oracle" (transient, typically SwitchboardPull) or
 * "bad health" (actually undercollateralized).
 *
 * The MarginFi UI sidesteps this by auto-prepending Switchboard/Pyth
 * oracle update ixs to every risk-engine tx; this server doesn't do
 * that yet (future follow-up — see #116 ask C), so the best we can do
 * today is name the root cause clearly.
 *
 * Returns `null` when the diagnosis doesn't apply (different Anchor code,
 * no banks stamped, client couldn't load). Callers should fall back to
 * the generic simulation-rejection message in that case.
 *
 * Best-effort: errors thrown inside this function must NOT bubble —
 * callers use the diagnosis purely to enrich an already-thrown preview
 * error. The shape `string | null` makes that explicit.
 */
export async function diagnoseMarginfiSimRejection(
  touchedBanks: string[],
  anchorError: { code: number; name: string; message: string },
): Promise<string | null> {
  if (anchorError.code !== 6009) return null; // Only RiskEngineInitRejected for now
  if (!touchedBanks || touchedBanks.length === 0) return null;

  let client: MinimalClient;
  try {
    const conn = getSolanaConnection();
    // Reuse the cached hardened client — authority doesn't matter for
    // read-only bank + oracle state, so we pass the SystemProgram id as
    // a throwaway pubkey. If the cache is cold, this will trigger a
    // fetch but that's the same cost the prepare path paid earlier.
    client = (await getHardenedMarginfiClient(
      conn,
      new PublicKey("11111111111111111111111111111111"),
    )) as MinimalClient;
  } catch {
    return null;
  }

  interface PriceInfoLike {
    timestamp?: { toNumber(): number };
  }
  interface BankWithOracleConfig extends MinimalBank {
    config: MinimalBank["config"] & {
      oracleMaxAge: number;
      oracleSetup: string;
    };
  }
  const clientWithPrices = client as MinimalClient & {
    oraclePrices: Map<string, PriceInfoLike>;
  };

  const nowSeconds = Math.round(Date.now() / 1000);
  const stale: Array<{
    symbol: string;
    bank: string;
    ageSeconds: number;
    maxAgeSeconds: number;
    oracleSetup: string;
  }> = [];
  const checked: string[] = [];

  for (const bankAddr of touchedBanks) {
    const rawBank = client.banks.get(bankAddr) as BankWithOracleConfig | undefined;
    const priceInfo = clientWithPrices.oraclePrices.get(bankAddr);
    if (!rawBank || !priceInfo) continue;
    const oracleTs = priceInfo.timestamp?.toNumber?.();
    if (oracleTs === undefined) continue;
    const age = nowSeconds - oracleTs;
    const maxAge = rawBank.config.oracleMaxAge;
    const symbol =
      rawBank.tokenSymbol ?? resolveMintSymbol(rawBank.mint.toBase58());
    checked.push(`${symbol} (${age}s old / ${maxAge}s max)`);
    if (age > maxAge) {
      stale.push({
        symbol,
        bank: bankAddr,
        ageSeconds: age,
        maxAgeSeconds: maxAge,
        oracleSetup: String(rawBank.config.oracleSetup),
      });
    }
  }

  if (checked.length === 0) return null;

  if (stale.length === 0) {
    return (
      `Diagnosis: stale oracle is RULED OUT — all ${checked.length} touched bank(s) ` +
      `have oracle prices within their maxAge window. Likely cause: BAD HEALTH ` +
      `(MarginFi's init-time asset weights are stricter than maintenance; re-check ` +
      `weighted collateral vs. requested borrow). Checked: ${checked.join(", ")}.`
    );
  }

  const staleLines = stale
    .map(
      (s) =>
        `  - ${s.symbol} (${s.oracleSetup}) — oracle ${s.ageSeconds}s old, maxAge ${s.maxAgeSeconds}s`,
    )
    .join("\n");
  return (
    `Diagnosis: STALE ORACLE(S) — ${stale.length} of ${checked.length} touched banks ` +
    `have oracle prices past their maxAge. The risk engine rejects the tx until these ` +
    `are refreshed:\n${staleLines}\n` +
    `Workaround: (a) retry in a few seconds if the oracle is push-style (PythPushOracle ` +
    `updates continuously off-chain); (b) for SwitchboardPull-backed banks (common for ` +
    `SOL), the MarginFi UI prepends a Switchboard crank ix — this server does not yet ` +
    `auto-prepend (see issue #116 ask C). Use the MarginFi UI to refresh, or pick a ` +
    `different collateral bank backed by a push-style oracle.`
  );
}

export const __internals = {
  resolveSymbolToMint,
  resolveMintSymbol,
  resolveMintDecimals,
  MAINNET_PROGRAM_ID,
  MAINNET_GROUP,
  fetchMarginfiAccountWrapper,
  findBankForMint,
};
