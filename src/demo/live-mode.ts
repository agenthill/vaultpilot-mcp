/**
 * Process-local active-wallet state for VAULTPILOT_DEMO live mode.
 *
 * Default demo mode (`VAULTPILOT_DEMO=true` with no live wallet set) is
 * read-real-RPC + signing-refused: a prospective user can browse any
 * address they pass without committing to a Ledger, but every signing /
 * broadcast tool refuses with a structured error.
 *
 * Live mode is opted into at runtime via the `set_demo_wallet` tool. Once
 * set, the wallet stays active for the rest of the process lifetime (or
 * until cleared via `set_demo_wallet({})`). In live mode, the broadcast
 * step (`send_transaction`) is intercepted and returns a simulation
 * envelope instead of refusing — letting the user walk the full
 * prepare → simulate → preview → "broadcast" flow against a real on-chain
 * persona without a Ledger.
 *
 * State is module-local (not file-backed): a restart resets to default
 * demo mode. This is deliberate — demo state is ephemeral by design, and
 * persisting it to disk would risk leaking the "this is a demo session"
 * signal into a real-mode boot.
 */

import {
  DEMO_WALLETS,
  PERSONAS,
  isDemoChain,
  isDemoType,
  isPersonaId,
  type DemoCell,
  type DemoChain,
  type DemoType,
  type Persona,
  type PersonaId,
} from "./personas.js";

/**
 * Active live-mode wallet selection. `null` means default demo mode
 * (read-real-RPC + signing-refused, no broadcast simulation). Mutated
 * exclusively via `setLivePersona` / `setLiveCellAddress` /
 * `setLiveCustomAddresses` / `clearLiveWallet`.
 */
export interface LiveWalletState {
  /**
   * Persona that the active wallet belongs to. `null` when the live
   * wallet was assembled via per-cell loads (different chains may
   * carry different types) or via custom-address mode.
   */
  personaId: PersonaId | null;
  /**
   * Per-chain type tags. Tracks which DemoType drove each chain's
   * slot — populated by per-cell loads, derived from `personaId`
   * for full-persona loads, all-null for custom-address mode.
   */
  types: {
    evm: DemoType | null;
    solana: DemoType | null;
    tron: DemoType | null;
    bitcoin: DemoType | null;
  };
  /** Resolved address bundle. */
  addresses: {
    evm: string[];
    solana: string[];
    tron: string[];
    bitcoin: string[] | null;
  };
}

let activeWallet: LiveWalletState | null = null;

/** Returns a deep-frozen copy of the current state, or `null` if not in live mode. */
export function getLiveWallet(): LiveWalletState | null {
  if (activeWallet === null) return null;
  return {
    personaId: activeWallet.personaId,
    types: { ...activeWallet.types },
    addresses: {
      evm: [...activeWallet.addresses.evm],
      solana: [...activeWallet.addresses.solana],
      tron: [...activeWallet.addresses.tron],
      bitcoin:
        activeWallet.addresses.bitcoin === null
          ? null
          : [...activeWallet.addresses.bitcoin],
    },
  };
}

/** True when a live wallet has been set (i.e., we're in live mode, not default). */
export function isLiveMode(): boolean {
  return activeWallet !== null;
}

/**
 * Activate a persona by ID — batch-loads every chain that has a curated
 * cell for the type. Equivalent to four `setLiveCellAddress` calls but
 * cheaper to express. Throws on unknown ID rather than falling back
 * silently — the agent should know if the user typo'd a persona name.
 *
 * Accepts the legacy `defi-power-user` alias (resolves to `defi-degen`)
 * so call sites that still use the pre-rename name keep working.
 */
export function setLivePersona(personaId: string): Persona {
  const resolved =
    personaId === "defi-power-user" ? "defi-degen" : personaId;
  if (!isPersonaId(resolved)) {
    throw new Error(
      `[VAULTPILOT_DEMO] Unknown persona '${personaId}'. ` +
        `Valid IDs: ${Object.keys(PERSONAS).join(", ")}.`,
    );
  }
  const persona = PERSONAS[resolved];
  // Type tags: every chain that has a non-empty address slot gets the
  // persona's type. Chains with no curated cell stay null.
  activeWallet = {
    personaId: resolved,
    types: {
      evm: persona.addresses.evm.length > 0 ? resolved : null,
      solana: persona.addresses.solana.length > 0 ? resolved : null,
      tron: persona.addresses.tron.length > 0 ? resolved : null,
      bitcoin: (persona.addresses.bitcoin?.length ?? 0) > 0 ? resolved : null,
    },
    addresses: {
      evm: [...persona.addresses.evm],
      solana: [...persona.addresses.solana],
      tron: [...persona.addresses.tron],
      bitcoin:
        persona.addresses.bitcoin === null
          ? null
          : [...persona.addresses.bitcoin],
    },
  };
  return persona;
}

/**
 * Per-cell loader — sets a single (chain, type) slot in the live
 * wallet. Other chains stay as they are (or empty if no live wallet
 * was set yet). The matching slot is REPLACED, not appended — the
 * matrix is one-address-per-cell by design.
 *
 * Throws on unknown chain/type or on a null cell (e.g. BTC defi-degen
 * is not curated and would activate a meaningless slot).
 */
export function setLiveCellAddress(chain: string, type: string): {
  chain: DemoChain;
  type: DemoType;
  cell: DemoCell;
} {
  if (!isDemoChain(chain)) {
    throw new Error(
      `[VAULTPILOT_DEMO] Unknown chain '${chain}'. Valid: evm, solana, tron, bitcoin.`,
    );
  }
  const resolvedType = type === "defi-power-user" ? "defi-degen" : type;
  if (!isDemoType(resolvedType)) {
    throw new Error(
      `[VAULTPILOT_DEMO] Unknown type '${type}'. Valid: defi-degen, stable-saver, staking-maxi, whale.`,
    );
  }
  const cell = DEMO_WALLETS[chain][resolvedType];
  if (!cell) {
    throw new Error(
      `[VAULTPILOT_DEMO] No curated cell for (chain='${chain}', type='${resolvedType}'). ` +
        `This combination is intentionally null — the chain doesn't support the archetype, ` +
        `or no verified-recent address was available at curation time. Try a different ` +
        `combination (e.g. 'bitcoin' + 'whale', 'evm' + 'staking-maxi').`,
    );
  }
  // Initialize live wallet if this is the first per-cell load.
  if (activeWallet === null) {
    activeWallet = {
      personaId: null,
      types: { evm: null, solana: null, tron: null, bitcoin: null },
      addresses: { evm: [], solana: [], tron: [], bitcoin: null },
    };
  }
  // Mark the wallet as composite (no single persona drove it) once
  // ANY per-cell load has happened — even if the user later batch-
  // loads a persona, the historical mix means personaId is null.
  activeWallet.personaId = null;
  activeWallet.types[chain] = resolvedType;
  if (chain === "bitcoin") {
    activeWallet.addresses.bitcoin = [cell.address];
  } else {
    activeWallet.addresses[chain] = [cell.address];
  }
  return { chain, type: resolvedType, cell };
}

/**
 * Activate a custom address bundle (no persona). At least one chain
 * field must be non-empty, otherwise we'd be in a "live mode with no
 * addresses" state which is meaningless. Throws on empty input.
 */
export function setLiveCustomAddresses(custom: {
  evm?: string[];
  solana?: string[];
  tron?: string[];
  bitcoin?: string[];
}): void {
  const evm = custom.evm ?? [];
  const solana = custom.solana ?? [];
  const tron = custom.tron ?? [];
  const bitcoin = custom.bitcoin ?? [];
  if (
    evm.length === 0 &&
    solana.length === 0 &&
    tron.length === 0 &&
    bitcoin.length === 0
  ) {
    throw new Error(
      "[VAULTPILOT_DEMO] set_demo_wallet(custom={...}) requires at least one chain " +
        "address. Pass a persona ID instead, or include evm/solana/tron/bitcoin entries.",
    );
  }
  activeWallet = {
    personaId: null,
    types: { evm: null, solana: null, tron: null, bitcoin: null },
    addresses: {
      evm,
      solana,
      tron,
      bitcoin: bitcoin.length === 0 ? null : bitcoin,
    },
  };
}

/** Clear live-mode state, returning to default demo mode. */
export function clearLiveWallet(): void {
  activeWallet = null;
}

/** Test-only: hard reset between tests. Equivalent to `clearLiveWallet`. */
export function _resetLiveWalletForTests(): void {
  activeWallet = null;
}
