import {
  PublicKey,
  TransactionInstruction,
} from "@solana/web3.js";
import BigNumber from "bignumber.js";
import { assertSolanaAddress } from "./address.js";
import { getSolanaConnection } from "./rpc.js";
import {
  buildAdvanceNonceIx,
  deriveNonceAccountAddress,
  getNonceAccountValue,
} from "./nonce.js";
import { throwNonceRequired } from "./actions.js";
import { kitInstructionsToLegacy } from "./kit-bridge.js";
import { loadKaminoMainMarket } from "./kamino.js";
import {
  issueSolanaDraftHandle,
  type SolanaTxDraft,
} from "../../signing/solana-tx-store.js";

/**
 * Kamino lending — write builders. Two tools:
 *
 *   - `buildKaminoInitUser` (prepare_kamino_init_user) — first-time setup:
 *     creates the user's lookup table + initUserMetadata + initObligation.
 *     Refuses if userMetadata already exists; partially-init states (LUT
 *     + userMetadata exist but obligation doesn't) are handled by
 *     re-running and skipping the userMetadata branch.
 *
 *   - `buildKaminoSupply` (prepare_kamino_supply) — deposit liquidity into
 *     a Kamino reserve. Refuses if userMetadata / obligation aren't already
 *     initialized (clear error pointing at prepare_kamino_init_user).
 *
 * Both go through the kit-bridge (#151): kit `Instruction[]` from the
 * Kamino SDK → web3.js v1 `TransactionInstruction[]`, prepended with our
 * durable-nonce `nonceAdvance` at ix[0], wrapped in a v0 SolanaTxDraft.
 *
 * Why two tools instead of one (per the plan from PR #151): Kamino's
 * KaminoAction.buildDepositTxns natively packs init + supply into one tx
 * via the `initUserMetadata` parameter. But the first-deposit tx packs
 * 8-12 ixs (createLut + initUserMetadata + initObligation + ATA setup +
 * reserve refresh + scope refresh + deposit + cleanup) and risks
 * overflowing the v0+ALT size budget on worst-case mints. Splitting is
 * also more honest UX: first-time users see two distinct Ledger approvals
 * (init account, then supply), each with a smaller-and-easier-to-decode
 * tx body.
 *
 * BLIND-SIGN on Ledger for both — Kamino's program isn't in the Solana
 * app's clear-sign allowlist; user matches the Message Hash on-device
 * after preview_solana_send.
 */

const LAMPORTS_PER_SOL = 1_000_000_000;

interface NonceContext {
  fromPubkey: PublicKey;
  noncePubkey: PublicKey;
  nonceValue: string;
}

async function loadNonceContext(walletStr: string): Promise<NonceContext> {
  const fromPubkey = assertSolanaAddress(walletStr);
  const conn = getSolanaConnection();
  const noncePubkey = await deriveNonceAccountAddress(fromPubkey);
  const nonceState = await getNonceAccountValue(conn, noncePubkey);
  if (!nonceState) throwNonceRequired(walletStr);
  return { fromPubkey, noncePubkey, nonceValue: nonceState.nonce };
}

function tokenBaseUnits(amountDecimal: string, decimals: number): bigint {
  const bn = new BigNumber(amountDecimal);
  if (!bn.isFinite() || bn.lte(0)) {
    throw new Error(
      `Invalid amount "${amountDecimal}" — expected a positive decimal (e.g. "1.5").`,
    );
  }
  return BigInt(
    bn
      .times(new BigNumber(10).pow(decimals))
      .integerValue(BigNumber.ROUND_DOWN)
      .toString(10),
  );
}

function buildDraft(args: {
  ctx: NonceContext;
  walletStr: string;
  action:
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  actionIxs: TransactionInstruction[];
}): SolanaTxDraft {
  const nonceIx = buildAdvanceNonceIx(args.ctx.noncePubkey, args.ctx.fromPubkey);
  const instructions: TransactionInstruction[] = [nonceIx, ...args.actionIxs];
  return {
    kind: "v0",
    payerKey: args.ctx.fromPubkey,
    instructions,
    addressLookupTableAccounts: [],
    meta: {
      action: args.action,
      from: args.walletStr,
      description: args.description,
      decoded: args.decoded,
      nonce: {
        account: args.ctx.noncePubkey.toBase58(),
        authority: args.ctx.fromPubkey.toBase58(),
        value: args.ctx.nonceValue,
      },
    },
  };
}

export interface PrepareKaminoInitUserParams {
  /** Base58 wallet address — funds the LUT + obligation accounts. */
  wallet: string;
}

export interface PreparedKaminoTx {
  handle: string;
  action:
    | "kamino_init_user"
    | "kamino_supply"
    | "kamino_borrow"
    | "kamino_withdraw"
    | "kamino_repay";
  chain: "solana";
  from: string;
  description: string;
  decoded: { functionName: string; args: Record<string, string> };
  /** Nonce-account PDA — durable-nonce-protected. */
  nonceAccount: string;
}

/**
 * First-time Kamino setup for a wallet. Three on-chain accounts get
 * created:
 *
 *   1. User lookup table (per-wallet ALT — referenced by userMetadata).
 *   2. UserMetadata PDA (Kamino's per-user state, references the LUT
 *      address so future Kamino ixs can resolve user-specific accounts).
 *   3. Obligation PDA (per-(wallet, market, tag, id) — VanillaObligation
 *      with id=0 is the default; multiply / leverage / lending variants
 *      use different tags).
 *
 * Refuses if the wallet's userMetadata already exists. Partially-init
 * states (LUT created but obligation missing) are NOT yet handled here —
 * they shouldn't happen in practice because all three are emitted in one
 * tx that's atomic on-chain. If it does happen, manual recovery via the
 * Kamino UI is the path; this tool's `userMetadata exists → refuse` rule
 * keeps the prepare flow honest about its assumption.
 */
export async function buildKaminoInitUser(
  p: PrepareKaminoInitUserParams,
): Promise<PreparedKaminoTx> {
  const ctx = await loadNonceContext(p.wallet);
  const market = await loadKaminoMainMarket();
  if (!market) {
    throw new Error(
      "Kamino main market not found on-chain — extremely unusual. Check Solana RPC connectivity.",
    );
  }

  // Lazy-import kit + SDK pieces to keep cold-start cost off the path
  // that doesn't use Kamino.
  const { createNoopSigner, address: toAddress, none, isSome } = await import(
    "@solana/kit"
  );
  const { getUserLutAddressAndSetupIxs, VanillaObligation } = await import(
    "@kamino-finance/klend-sdk"
  );

  const ownerAddr = toAddress(p.wallet);
  const owner = createNoopSigner(ownerAddr);

  // Refuse re-init: if the wallet already has userMetadata, the user
  // doesn't need this tool. Returning a no-op tx would be more confusing
  // than informative.
  const [userMetadataAddr, userMetadataState] = await market.getUserMetadata(
    ownerAddr,
  );
  if (userMetadataState !== null) {
    throw new Error(
      `Wallet ${p.wallet} already has Kamino userMetadata at ${userMetadataAddr.toString()}. ` +
        `prepare_kamino_init_user refuses to re-init. Use prepare_kamino_supply directly.`,
    );
  }

  // Init userMetadata + LUT. We pass `withExtendLut: false` because the
  // first-time tx can't reference its own newly-created LUT in the same
  // slot (LUT activation lag); LUT extension can happen in subsequent
  // setup actions if Kamino's other tools need it. For a vanilla
  // deposit-only path, the un-extended LUT is enough.
  const [userLutAddress, setupIxsBatches] = await getUserLutAddressAndSetupIxs(
    market,
    owner,
    none(),
    false,
  );
  // Flatten the [batch][ix] structure; for first-time init with no LUT
  // extension we expect exactly one batch carrying [createLut, initUserMetadata].
  const userMetadataIxs = setupIxsBatches.flat();

  // Init obligation (VanillaObligation, tag 0). Kamino's codegen ix
  // builder takes the obligation owner + fee payer + the obligation /
  // market / userMetadata PDAs.
  const { initObligation } = await import("@kamino-finance/klend-sdk");
  const { SYSVAR_RENT_ADDRESS } = await import("@solana/sysvars");
  const { SYSTEM_PROGRAM_ADDRESS } = await import("@solana-program/system");
  const obligationKind = new VanillaObligation(market.programId);
  const obligationPda = await obligationKind.toPda(market.getAddress(), ownerAddr);
  const obligationArgs = obligationKind.toArgs();
  const initObligationIx = initObligation(
    {
      args: {
        tag: obligationArgs.tag,
        id: obligationArgs.id,
      },
    },
    {
      obligationOwner: owner,
      feePayer: owner,
      obligation: obligationPda,
      lendingMarket: market.getAddress(),
      seed1Account: obligationArgs.seed1,
      seed2Account: obligationArgs.seed2,
      ownerUserMetadata: userMetadataAddr,
      rent: SYSVAR_RENT_ADDRESS,
      systemProgram: SYSTEM_PROGRAM_ADDRESS,
    },
    undefined,
    market.programId,
  );

  const allKitIxs = [...userMetadataIxs, initObligationIx];
  const actionIxs = kitInstructionsToLegacy(allKitIxs);

  const description = `Kamino setup: create lookup table + initUserMetadata + initObligation for ${p.wallet}`;
  const draft = buildDraft({
    ctx,
    walletStr: p.wallet,
    action: "kamino_init_user",
    description,
    decoded: {
      functionName: "kamino.initUser",
      args: {
        wallet: p.wallet,
        market: market.getAddress().toString(),
        userMetadata: userMetadataAddr.toString(),
        userLookupTable: userLutAddress.toString(),
        obligation: obligationPda.toString(),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
  });

  // Suppress unused-import warnings — `isSome` is part of @solana/kit's
  // canonical surface and may be needed when scope-refresh config ships;
  // the pin keeps it from being tree-shaken under bundlers that aren't
  // friendly to lazy imports.
  void isSome;

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "kamino_init_user",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}

export interface PrepareKaminoSupplyParams {
  /** Base58 wallet address — funds the supply, must already have Kamino userMetadata + obligation. */
  wallet: string;
  /** SPL mint address (base58) of the asset to supply. */
  mint: string;
  /** Human-readable amount (decimal string, e.g. "100.5"). */
  amount: string;
}

/**
 * Build a Kamino supply (deposit liquidity) tx. User must have already
 * run prepare_kamino_init_user; this builder REFUSES on missing
 * userMetadata or obligation rather than auto-init (see jsdoc on the
 * module about why we split the two tools).
 *
 * Uses `KaminoAction.buildDepositTxns` with skipInitialization +
 * skipLutCreation so the SDK doesn't try to pack init ixs. The returned
 * KaminoAction's actionToIxs gives us [computeBudget, setupIxs (ATA
 * creates + reserve refreshes + obligation refresh), depositIx,
 * cleanupIxs] — all kit-shaped, all-static accounts, no ephemeral
 * signers.
 */
export async function buildKaminoSupply(
  p: PrepareKaminoSupplyParams,
): Promise<PreparedKaminoTx> {
  const ctx = await loadNonceContext(p.wallet);
  const market = await loadKaminoMainMarket();
  if (!market) {
    throw new Error("Kamino main market not found on-chain.");
  }

  const { createNoopSigner, address: toAddress, none } = await import("@solana/kit");
  const { KaminoAction, KaminoObligation, VanillaObligation } = await import(
    "@kamino-finance/klend-sdk"
  );

  const ownerAddr = toAddress(p.wallet);
  const owner = createNoopSigner(ownerAddr);
  const mintAddr = toAddress(p.mint);

  // Resolve the reserve for this mint to learn its decimals and confirm
  // Kamino actually lists it. Failing fast here beats a confusing SDK
  // error from buildDepositTxns when the mint isn't in the market.
  const reserve = market.getReserveByMint(mintAddr);
  if (!reserve) {
    throw new Error(
      `Mint ${p.mint} is not listed on Kamino's main market. Confirm via the Kamino app's reserve list.`,
    );
  }
  const decimals = reserve.state.liquidity.mintDecimals;
  const amountBaseUnits = tokenBaseUnits(p.amount, Number(decimals));

  // Refuse missing init.
  const [userMetadataAddr, userMetadataState] = await market.getUserMetadata(
    ownerAddr,
  );
  if (userMetadataState === null) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino userMetadata. Run prepare_kamino_init_user first.`,
    );
  }

  const obligationKind = new VanillaObligation(market.programId);
  const obligationPda = await obligationKind.toPda(market.getAddress(), ownerAddr);
  const obligationState = await KaminoObligation.load(market, obligationPda);
  if (!obligationState) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino obligation at ${obligationPda.toString()}. ` +
        `Run prepare_kamino_init_user first.`,
    );
  }

  const action = await KaminoAction.buildDepositTxns(
    market,
    amountBaseUnits.toString(),
    mintAddr,
    owner,
    obligationState,
    true, // useV2Ixs
    undefined, // scopeRefreshConfig — Scope is refreshed on-chain by Kamino's price-feed-update flow; if a stale-price revert shows up live, we add scope refresh in a follow-up.
    1_000_000, // extraComputeBudget — same as KaminoAction default
    true, // includeAtaIxs — create the user's ctoken/SPL ATAs if missing
    false, // requestElevationGroup — vanilla obligation, no elevation
    { skipInitialization: true, skipLutCreation: true }, // we already init'd
    none(), // referrer
    0n, // currentSlot — caller can fetch fresh; SDK uses for staleness checks
  );

  // KaminoAction.actionToIxs returns the flat ix list:
  // [computeBudget, setupIxs (ATA + refresh), lendingIx (deposit), cleanupIxs].
  const kitIxs = KaminoAction.actionToIxs(action);
  const actionIxs = kitInstructionsToLegacy(kitIxs);

  const symbol = reserve.getTokenSymbol() ?? p.mint.slice(0, 6);
  const description = `Kamino supply: ${p.amount} ${symbol} → reserve ${reserve.address.toString()}`;
  const draft = buildDraft({
    ctx,
    walletStr: p.wallet,
    action: "kamino_supply",
    description,
    decoded: {
      functionName: "kamino.deposit",
      args: {
        wallet: p.wallet,
        market: market.getAddress().toString(),
        reserve: reserve.address.toString(),
        mint: p.mint,
        symbol,
        amount: p.amount,
        amountBaseUnits: amountBaseUnits.toString(),
        obligation: obligationPda.toString(),
        nonceAccount: ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
  });

  void userMetadataAddr; // surface in decoded.args is the obligation PDA; userMetadata addr only needed by SDK internally.

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "kamino_supply",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: ctx.noncePubkey.toBase58(),
  };
}

/**
 * Common preflight for borrow/withdraw/repay: load market, validate the
 * mint, fetch the obligation, refuse if userMetadata or obligation are
 * missing. Returns everything the three write builders need to call the
 * matching `KaminoAction.build*Txns`.
 */
async function loadKaminoSupplyContext(p: {
  wallet: string;
  mint: string;
  amount: string;
}): Promise<{
  ctx: NonceContext;
  // Cast to `any` because the kit-typed SDK objects flow through this
  // module without our local types layering on top — the SDK's
  // KaminoMarket / KaminoReserve / KaminoObligation are the source of
  // truth and any explicit typing here would just shadow them and rot.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  market: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  owner: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ownerAddr: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  mintAddr: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  reserve: any;
  symbol: string;
  decimals: number;
  amountBaseUnits: bigint;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  obligationState: any;
  obligationPda: string;
}> {
  const ctx = await loadNonceContext(p.wallet);
  const market = await loadKaminoMainMarket();
  if (!market) {
    throw new Error("Kamino main market not found on-chain.");
  }
  const { createNoopSigner, address: toAddress } = await import("@solana/kit");
  const { KaminoObligation, VanillaObligation } = await import(
    "@kamino-finance/klend-sdk"
  );

  const ownerAddr = toAddress(p.wallet);
  const owner = createNoopSigner(ownerAddr);
  const mintAddr = toAddress(p.mint);

  const reserve = market.getReserveByMint(mintAddr);
  if (!reserve) {
    throw new Error(
      `Mint ${p.mint} is not listed on Kamino's main market. Confirm via the Kamino app's reserve list.`,
    );
  }
  const decimals = Number(reserve.state.liquidity.mintDecimals);
  const amountBaseUnits = tokenBaseUnits(p.amount, decimals);
  const symbol = reserve.getTokenSymbol() ?? p.mint.slice(0, 6);

  const [, userMetadataState] = await market.getUserMetadata(ownerAddr);
  if (userMetadataState === null) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino userMetadata. Run prepare_kamino_init_user first.`,
    );
  }

  const obligationKind = new VanillaObligation(market.programId);
  const obligationPda = await obligationKind.toPda(market.getAddress(), ownerAddr);
  const obligationState = await KaminoObligation.load(market, obligationPda);
  if (!obligationState) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino obligation at ${obligationPda.toString()}. ` +
        `Run prepare_kamino_init_user first.`,
    );
  }

  return {
    ctx,
    market,
    owner,
    ownerAddr,
    mintAddr,
    reserve,
    symbol,
    decimals,
    amountBaseUnits,
    obligationState,
    obligationPda: obligationPda.toString(),
  };
}

export interface PrepareKaminoBorrowParams {
  wallet: string;
  mint: string;
  amount: string;
}

/**
 * Build a Kamino borrow tx. Pulls liquidity from the named reserve as
 * debt against the obligation's collateral. Refuses if userMetadata /
 * obligation aren't initialized; refuses if the mint isn't listed.
 *
 * The on-chain program enforces the borrow LTV gate — if the borrow
 * would push the obligation over `borrowLimit`, the tx reverts. We don't
 * pre-validate that here (the obligation's exact LTV depends on Scope's
 * latest prices, which Kamino refreshes inside the tx itself); the
 * pre-sign simulation gate at `simulatePinnedSolanaTx` catches it before
 * the user signs.
 */
export async function buildKaminoBorrow(
  p: PrepareKaminoBorrowParams,
): Promise<PreparedKaminoTx> {
  const c = await loadKaminoSupplyContext(p);
  const { KaminoAction } = await import("@kamino-finance/klend-sdk");
  const { none } = await import("@solana/kit");

  const action = await KaminoAction.buildBorrowTxns(
    c.market,
    c.amountBaseUnits.toString(),
    c.mintAddr,
    c.owner,
    c.obligationState,
    true, // useV2Ixs
    undefined, // scopeRefreshConfig
    1_000_000, // extraComputeBudget
    true, // includeAtaIxs
    false, // requestElevationGroup
    { skipInitialization: true, skipLutCreation: true },
    none(),
    0n,
  );
  const kitIxs = KaminoAction.actionToIxs(action);
  const actionIxs = kitInstructionsToLegacy(kitIxs);

  const description = `Kamino borrow: ${p.amount} ${c.symbol} from reserve ${c.reserve.address.toString()}`;
  const draft = buildDraft({
    ctx: c.ctx,
    walletStr: p.wallet,
    action: "kamino_borrow",
    description,
    decoded: {
      functionName: "kamino.borrow",
      args: {
        wallet: p.wallet,
        market: c.market.getAddress().toString(),
        reserve: c.reserve.address.toString(),
        mint: p.mint,
        symbol: c.symbol,
        amount: p.amount,
        amountBaseUnits: c.amountBaseUnits.toString(),
        obligation: c.obligationPda,
        nonceAccount: c.ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "kamino_borrow",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: c.ctx.noncePubkey.toBase58(),
  };
}

export interface PrepareKaminoWithdrawParams {
  wallet: string;
  mint: string;
  amount: string;
}

/**
 * Build a Kamino withdraw tx. Pulls liquidity out of a previously-supplied
 * reserve. Refuses if the obligation has zero deposits in the reserve
 * (the on-chain program would revert; surfacing the same condition with
 * a clear error beats a confusing revert).
 *
 * Withdraws are health-factor-gated on-chain — if the withdraw would
 * leave the obligation under-collateralized for its outstanding debt,
 * the tx reverts. The simulation gate catches this before broadcast.
 */
export async function buildKaminoWithdraw(
  p: PrepareKaminoWithdrawParams,
): Promise<PreparedKaminoTx> {
  const c = await loadKaminoSupplyContext(p);
  const { KaminoAction } = await import("@kamino-finance/klend-sdk");
  const { none } = await import("@solana/kit");

  // Sanity check: refuse if the obligation has no deposit in this reserve.
  // SDK error here is opaque ("reserve not in deposits"); preflight gives
  // a clean message.
  const hasDeposit = c.obligationState.deposits.has(c.reserve.address);
  if (!hasDeposit) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino deposit in reserve ${c.reserve.address.toString()} (mint ${p.mint}). ` +
        `Nothing to withdraw.`,
    );
  }

  const action = await KaminoAction.buildWithdrawTxns(
    c.market,
    c.amountBaseUnits.toString(),
    c.mintAddr,
    c.owner,
    c.obligationState,
    true,
    undefined,
    1_000_000,
    true,
    false,
    { skipInitialization: true, skipLutCreation: true },
    none(),
    0n,
  );
  const kitIxs = KaminoAction.actionToIxs(action);
  const actionIxs = kitInstructionsToLegacy(kitIxs);

  const description = `Kamino withdraw: ${p.amount} ${c.symbol} from reserve ${c.reserve.address.toString()}`;
  const draft = buildDraft({
    ctx: c.ctx,
    walletStr: p.wallet,
    action: "kamino_withdraw",
    description,
    decoded: {
      functionName: "kamino.withdraw",
      args: {
        wallet: p.wallet,
        market: c.market.getAddress().toString(),
        reserve: c.reserve.address.toString(),
        mint: p.mint,
        symbol: c.symbol,
        amount: p.amount,
        amountBaseUnits: c.amountBaseUnits.toString(),
        obligation: c.obligationPda,
        nonceAccount: c.ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "kamino_withdraw",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: c.ctx.noncePubkey.toBase58(),
  };
}

export interface PrepareKaminoRepayParams {
  wallet: string;
  mint: string;
  amount: string;
}

/**
 * Build a Kamino repay tx. Pays down outstanding debt in the named
 * reserve. Refuses if the obligation has zero borrows in the reserve.
 *
 * "Repay all" is not surfaced as a separate flag here; the on-chain
 * program clamps repayment at outstanding debt, so over-repaying just
 * burns the excess back to the user's wallet (no funds lost). If
 * over-repay UX matters later, we can add a `repayAll: true` shortcut
 * that fetches the exact outstanding amount.
 */
export async function buildKaminoRepay(
  p: PrepareKaminoRepayParams,
): Promise<PreparedKaminoTx> {
  const c = await loadKaminoSupplyContext(p);
  const { KaminoAction } = await import("@kamino-finance/klend-sdk");
  const { none } = await import("@solana/kit");

  const hasBorrow = c.obligationState.borrows.has(c.reserve.address);
  if (!hasBorrow) {
    throw new Error(
      `Wallet ${p.wallet} has no Kamino debt in reserve ${c.reserve.address.toString()} (mint ${p.mint}). ` +
        `Nothing to repay.`,
    );
  }

  const action = await KaminoAction.buildRepayTxns(
    c.market,
    c.amountBaseUnits.toString(),
    c.mintAddr,
    c.owner,
    c.obligationState,
    true,
    undefined,
    0n, // currentSlot (note: buildRepayTxns positional differs slightly — slot first, then defaults follow)
    c.owner, // payer
    1_000_000,
    true,
    false,
    { skipInitialization: true, skipLutCreation: true },
    none(),
  );
  const kitIxs = KaminoAction.actionToIxs(action);
  const actionIxs = kitInstructionsToLegacy(kitIxs);

  const description = `Kamino repay: ${p.amount} ${c.symbol} → reserve ${c.reserve.address.toString()}`;
  const draft = buildDraft({
    ctx: c.ctx,
    walletStr: p.wallet,
    action: "kamino_repay",
    description,
    decoded: {
      functionName: "kamino.repay",
      args: {
        wallet: p.wallet,
        market: c.market.getAddress().toString(),
        reserve: c.reserve.address.toString(),
        mint: p.mint,
        symbol: c.symbol,
        amount: p.amount,
        amountBaseUnits: c.amountBaseUnits.toString(),
        obligation: c.obligationPda,
        nonceAccount: c.ctx.noncePubkey.toBase58(),
      },
    },
    actionIxs,
  });

  const { handle } = issueSolanaDraftHandle(draft);
  return {
    handle,
    action: "kamino_repay",
    chain: "solana",
    from: p.wallet,
    description,
    decoded: draft.meta.decoded,
    nonceAccount: c.ctx.noncePubkey.toBase58(),
  };
}

// Suppress unused-import warning for LAMPORTS_PER_SOL — kept for symmetry
// with marinade.ts / native-stake.ts / other Solana write-builder modules
// in case a future flow needs SOL-amount conversion (e.g. SOL deposit
// into Kamino's wSOL reserve).
void LAMPORTS_PER_SOL;
