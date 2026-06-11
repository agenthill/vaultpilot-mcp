/**
 * Process-local demo-mode address book. Mirrors `live-mode.ts`'s
 * pattern — in-memory only, never persisted, lost on process restart.
 *
 * Why a separate store rather than reusing the production
 * `~/.vaultpilot-mcp/contacts.json`:
 *   1. Production contacts are signature-verified by the user's
 *      hardware wallet on every read. Demo mode has no Ledger, so
 *      the same code path can't be exercised (the existing
 *      `pickAnchorForChain` throws when no pairing exists).
 *   2. Persisting unsigned demo entries to the same disk file as the
 *      production blob would erode the file's invariant ("every entry
 *      was authorized by the device the user controls"). A separate
 *      in-memory store keeps the trust boundary crisp: the demo book
 *      exists in this process only, the signed book persists on disk.
 *   3. Latching demo state in-memory matches `live-mode.ts`'s persona
 *      selection — neither survives restart, both are deliberate try-
 *      before-install scaffolding.
 *
 * Trust note (less-secure-by-design): a compromised MCP can mutate
 * the demo store without the user's hardware key. That's acceptable
 * because demo mode intercepts `send_transaction` and returns
 * simulation envelopes — nothing actually goes on-chain. Address-
 * poisoning protection in demo mode is "the agent shows you the
 * resolved address" + "the prepare receipt is a simulation that
 * never broadcasts," not the cryptographic signature chain
 * production gets.
 */

import type { ContactChain } from "./schemas.js";
import { CONTACT_ADDRESS_PATTERNS } from "./schemas.js";

/**
 * Per-entry record. `addedAt` is captured at insertion time so the
 * `list_contacts` ordering / display matches the production shape.
 */
interface DemoContactEntry {
  address: string;
  addedAt: string;
  notes?: string;
  tags?: string[];
}

/**
 * Per-chain map keyed by label. Same chain set as production
 * `ContactChain` (btc/evm/solana/tron) — demo mode has no signer
 * constraint so all four are usable from day one. Litecoin is not in
 * `ContactChain` and therefore not addressable here either.
 */
const store: Record<ContactChain, Map<string, DemoContactEntry>> = {
  btc: new Map(),
  evm: new Map(),
  solana: new Map(),
  tron: new Map(),
};

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Add (or replace) a demo contact. Adding the same `label` REPLACES
 * the existing entry on that chain, mirroring the production semantics
 * (one label → one address per chain). Duplicate-address detection
 * across labels: refuses if `address` is already saved under a
 * different label, same as production. Address-format validation
 * reuses the production regex table.
 */
export function addDemoContact(args: {
  chain: ContactChain;
  label: string;
  address: string;
  notes?: string;
  tags?: string[];
}): { entry: DemoContactEntry; replacedExisting: boolean } {
  if (!CONTACT_ADDRESS_PATTERNS[args.chain].test(args.address)) {
    throw new Error(
      `CONTACTS_ADDRESS_FORMAT_MISMATCH: address "${args.address}" does not ` +
        `match the expected format for chain "${args.chain}".`,
    );
  }
  const chainStore = store[args.chain];
  for (const [existingLabel, existingEntry] of chainStore.entries()) {
    if (
      existingLabel !== args.label &&
      existingEntry.address === args.address
    ) {
      throw new Error(
        `CONTACTS_DUPLICATE_ADDRESS: address ${args.address} is already ` +
          `saved as "${existingLabel}" on ${args.chain}. Remove the existing ` +
          `entry first if you want to rename, or pick a different address.`,
      );
    }
  }
  const existing = chainStore.get(args.label);
  const entry: DemoContactEntry = {
    address: args.address,
    addedAt: existing?.addedAt ?? nowIso(),
    ...(args.notes !== undefined ? { notes: args.notes } : {}),
    ...(args.tags !== undefined ? { tags: args.tags } : {}),
  };
  chainStore.set(args.label, entry);
  return { entry, replacedExisting: existing !== undefined };
}

/**
 * Remove a label from one chain (when `chain` is set) or every chain
 * that has it (when omitted). Matches the production tool's two-mode
 * behavior. Returns the list of chains the label was found on.
 */
export function removeDemoContact(args: {
  label: string;
  chain?: ContactChain;
}): Array<{ chain: ContactChain; address: string }> {
  const chains: ContactChain[] = args.chain
    ? [args.chain]
    : (Object.keys(store) as ContactChain[]);
  const removed: Array<{ chain: ContactChain; address: string }> = [];
  for (const chain of chains) {
    const entry = store[chain].get(args.label);
    if (entry) {
      removed.push({ chain, address: entry.address });
      store[chain].delete(args.label);
    }
  }
  return removed;
}

/**
 * Read view: all entries flattened to one row per (chain, label),
 * already address-format-valid by construction (write path checks).
 * Resolver + listContacts both consume this.
 */
export function listDemoContacts(args?: {
  chain?: ContactChain;
  label?: string;
}): Array<{
  chain: ContactChain;
  label: string;
  address: string;
  addedAt: string;
  notes?: string;
  tags?: string[];
}> {
  const chains: ContactChain[] = args?.chain
    ? [args.chain]
    : (Object.keys(store) as ContactChain[]);
  const out: Array<{
    chain: ContactChain;
    label: string;
    address: string;
    addedAt: string;
    notes?: string;
    tags?: string[];
  }> = [];
  for (const chain of chains) {
    for (const [label, entry] of store[chain].entries()) {
      if (args?.label && label !== args.label) continue;
      out.push({
        chain,
        label,
        address: entry.address,
        addedAt: entry.addedAt,
        ...(entry.notes !== undefined ? { notes: entry.notes } : {}),
        ...(entry.tags !== undefined ? { tags: entry.tags } : {}),
      });
    }
  }
  return out;
}

/**
 * Forward lookup for the resolver — `(chain, label) → address?`.
 * Returns null when no entry exists. Demo-only: the resolver consults
 * this BEFORE the production (signed) lookup when in demo mode.
 */
export function findDemoContactByLabel(
  chain: ContactChain,
  label: string,
): string | null {
  const entry = store[chain].get(label);
  return entry?.address ?? null;
}

/**
 * Reverse lookup for the resolver — `(chain, address) → label?`.
 * For EVM addresses the comparison is case-insensitive. Returns null
 * when no entry matches.
 */
export function findDemoContactByAddress(
  chain: ContactChain,
  address: string,
): string | null {
  const target = chain === "evm" ? address.toLowerCase() : address;
  const hit = [...store[chain].entries()].find(([, entry]) => {
    const candidate = chain === "evm" ? entry.address.toLowerCase() : entry.address;
    return candidate === target;
  });
  return hit ? hit[0] : null;
}

/** Test-only: reset the in-memory store. */
export function _resetDemoContactsForTests(): void {
  for (const chain of Object.keys(store) as ContactChain[]) {
    store[chain].clear();
  }
}
