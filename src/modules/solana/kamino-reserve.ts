/**
 * Reserve selection for the mint-keyed Kamino write builders.
 *
 * A Kamino market can list several reserves for one liquidity mint. The main
 * market has four for USDC: one active reserve holding the liquidity and three
 * hidden (status 2) near-empty ones. The SDK resolves mint → reserve as "first
 * match in `market.reserves` insertion order" (`KaminoMarket.getReserveByMint`),
 * and every `KaminoAction.build*Txns` re-resolves through it, so without an
 * explicit choice a tx is built against whichever reserve the on-chain
 * enumeration returned first.
 *
 * When the mint has exactly one reserve the choice is unchanged. When it has
 * several:
 *   - withdraw / repay act on an existing position: the reserve is the one the
 *     obligation holds a deposit / borrow in (none or several → refuse).
 *   - supply / borrow add new liquidity: the reserve is the single ACTIVE
 *     (status 0) one (none or several → refuse).
 * The chosen reserve is pinned for the SDK by `pinReserveForMint`, and the built
 * instructions are checked to bind it by `assertBuiltIxsBindReserve`.
 */

const RESERVE_STATUS_ACTIVE = 0;

/** The slice of the SDK's `KaminoReserve` that selection reads. */
export interface KaminoReserveLike {
  address: string;
  state: { config: { status: number | bigint } };
  getLiquidityMint(): string;
}

/** The slice of the SDK's `KaminoMarket` that selection reads. */
export interface KaminoMarketLike<R extends KaminoReserveLike = KaminoReserveLike> {
  reserves: ReadonlyMap<string, R>;
}

/** The slice of the SDK's `KaminoObligation` that selection reads. */
export interface KaminoObligationLike {
  deposits: ReadonlyMap<string, unknown>;
  borrows: ReadonlyMap<string, unknown>;
}

export type ReserveIntent =
  | { kind: "new-liquidity" }
  | {
      kind: "existing-position";
      side: "deposits" | "borrows";
      obligation: KaminoObligationLike;
      wallet: string;
    };

const SIDE_WORDS = {
  deposits: { noun: "deposit", verb: "withdraw" },
  borrows: { noun: "debt", verb: "repay" },
} as const;

function describeReserves(reserves: KaminoReserveLike[]): string {
  return reserves
    .map((r) => `${r.address} (status ${Number(r.state.config.status)})`)
    .join(", ");
}

/** Every reserve in the market whose liquidity mint is `mint`, in SDK order. */
export function reservesForMint<R extends KaminoReserveLike>(
  market: KaminoMarketLike<R>,
  mint: string,
): R[] {
  return [...market.reserves.values()].filter(
    (r) => r.getLiquidityMint() === mint,
  );
}

/**
 * Pick the reserve a mint-keyed builder should act on. `candidates` is the
 * non-empty `reservesForMint` result. Throws when the choice is not
 * determined; never guesses between reserves.
 */
export function selectReserve<R extends KaminoReserveLike>(
  candidates: R[],
  mint: string,
  intent: ReserveIntent,
): R {
  if (candidates.length === 1) return candidates[0];
  const listed = `Mint ${mint} has ${candidates.length} reserves on Kamino's main market: ${describeReserves(candidates)}.`;

  if (intent.kind === "existing-position") {
    const { noun, verb } = SIDE_WORDS[intent.side];
    const held = candidates.filter((r) => intent.obligation[intent.side].has(r.address));
    if (held.length === 1) return held[0];
    if (held.length === 0) {
      throw new Error(
        `Wallet ${intent.wallet} has no Kamino ${noun} in any reserve for mint ${mint}. ` +
          `${listed} Nothing to ${verb}.`,
      );
    }
    throw new Error(
      `${listed} The wallet holds a ${noun} in ${held.length} of them (${describeReserves(held)}), ` +
        `so the reserve to ${verb} from is ambiguous. Use the Kamino app.`,
    );
  }

  const active = candidates.filter(
    (r) => Number(r.state.config.status) === RESERVE_STATUS_ACTIVE,
  );
  if (active.length === 1) return active[0];
  throw new Error(
    `${listed} ${active.length === 0 ? "None is active" : `${active.length} are active`}, ` +
      `so the reserve to use is ambiguous. Choose the reserve in the Kamino app.`,
  );
}

/**
 * A view of `market` whose `reserves` lists `reserve` first, so the SDK's
 * first-match `getReserveByMint` resolves the mint to it. Returns a wrapper
 * that delegates everything else to `market`; the market itself is not
 * mutated.
 */
export function pinReserveForMint<M extends KaminoMarketLike<KaminoReserveLike>>(
  market: M,
  reserve: KaminoReserveLike,
): M {
  const reserves = new Map<string, KaminoReserveLike>([[reserve.address, reserve]]);
  for (const [address, r] of market.reserves) {
    if (address !== reserve.address) reserves.set(address, r);
  }
  return Object.create(market, {
    reserves: { value: reserves, enumerable: true },
  }) as M;
}

/**
 * Check the SDK-built instructions bind `chosen`: it must appear among the
 * instruction accounts, and no other same-mint reserve may appear unless the
 * obligation holds a position in it (the SDK refreshes held reserves). Run
 * only when the mint has several reserves; throws on a mismatch so a pin the
 * SDK did not honor cannot reach signing.
 */
export function assertBuiltIxsBindReserve(
  ixs: ReadonlyArray<{ accounts?: ReadonlyArray<{ address: string }> }>,
  chosen: KaminoReserveLike,
  candidates: KaminoReserveLike[],
  obligation: KaminoObligationLike,
): void {
  const touched = new Set<string>();
  for (const ix of ixs) {
    for (const account of ix.accounts ?? []) touched.add(String(account.address));
  }
  if (!touched.has(chosen.address)) {
    throw new Error(
      `Built Kamino instructions do not reference the chosen reserve ${chosen.address}; ` +
        `refusing to return a tx the SDK built against a different reserve.`,
    );
  }
  for (const other of candidates) {
    if (other.address === chosen.address || !touched.has(other.address)) continue;
    if (obligation.deposits.has(other.address) || obligation.borrows.has(other.address)) continue;
    throw new Error(
      `Built Kamino instructions reference reserve ${other.address} for the same mint as the ` +
        `chosen reserve ${chosen.address}; refusing to return a tx the SDK built against a different reserve.`,
    );
  }
}
