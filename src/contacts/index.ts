/**
 * Top-level contacts orchestrator. Implements the four MCP tools —
 * `add_contact` / `remove_contact` / `list_contacts` /
 * `verify_contacts` — against the per-chain signed blobs in
 * `~/.vaultpilot-mcp/contacts.json`.
 *
 * v1.0 chain support:
 *   - BTC: anchor selected from non-taproot pairings (segwit > p2sh-segwit > legacy)
 *   - EVM: anchor selected from active WC session's first account
 *   - Solana / TRON: not yet supported, returns CONTACTS_CHAIN_NOT_YET_SUPPORTED
 *
 * In-memory anchor + version tracking — see `anchorState` below.
 * Re-derived from the device on session start; mismatch with the
 * disk-resident anchor surfaces CONTACTS_ANCHOR_MISMATCH at read time.
 */
import { canonicalize, buildSigningPreimage } from "./canonicalize.js";
import {
  readContactsFile,
  readContactsStrict,
  writeContactsFile,
} from "./storage.js";
import {
  addDemoContact,
  removeDemoContact,
  listDemoContacts,
} from "./demo-store.js";
import { isDemoMode } from "../demo/index.js";
import {
  type ContactsFile,
  type ChainBlob,
  type ListedContact,
  type VerifyResult,
  type AddContactArgs,
  type RemoveContactArgs,
  type ListContactsArgs,
  type VerifyContactsArgs,
  type ContactChain,
  type SignedContactEntry,
  ContactsError,
  CONTACT_ADDRESS_PATTERNS,
  emptyContactsFile,
} from "./schemas.js";
import {
  signContactsBlobBtc,
  pickBtcAnchor,
  assertBtcAnchorAvailable,
  type BtcAnchor,
} from "../signers/contacts/btc.js";
import {
  signContactsBlobEvm,
  pickEvmAnchor,
  type EvmAnchor,
} from "../signers/contacts/evm.js";
import { verifyBtcBlob, verifyEvmBlob } from "./verify.js";

// ---------- in-memory anchor + version tracking ----------

/**
 * Per-chain in-memory state captured on first read of this session.
 * Once set, subsequent reads compare against it: any disk swap that
 * changes anchorAddress fails CONTACTS_ANCHOR_MISMATCH; any version
 * decrement fails CONTACTS_VERSION_ROLLBACK.
 *
 * Caveat documented in SECURITY.md: a cold-start rollback before any
 * session has read the file is undetectable here — that's the limit
 * of in-memory tracking.
 */
const anchorState: Record<
  ContactChain,
  { anchorAddress?: string; maxVersion?: number }
> = { btc: {}, evm: {}, solana: {}, tron: {} };

function recordAnchor(chain: ContactChain, blob: ChainBlob | null): void {
  if (!blob) return;
  const state = anchorState[chain];
  if (!state.anchorAddress) state.anchorAddress = blob.anchorAddress;
  if (state.maxVersion === undefined || blob.version > state.maxVersion) {
    state.maxVersion = blob.version;
  }
}

/** Test-only: reset the in-memory anchor + version state. */
export function _resetContactsAnchorStateForTests(): void {
  anchorState.btc = {};
  anchorState.evm = {};
  anchorState.solana = {};
  anchorState.tron = {};
}

// ---------- chain dispatch helpers ----------

function isV1Chain(chain: ContactChain): chain is "btc" | "evm" {
  return chain === "btc" || chain === "evm";
}

function rejectIfNotV1(chain: ContactChain): void {
  if (!isV1Chain(chain)) {
    throw new Error(
      `${ContactsError.ChainNotYetSupported}: chain "${chain}" requires its own ` +
        `internal signing helper which lands in v1.5. v1.0 supports btc + evm.`,
    );
  }
}

async function pickAnchorForChain(
  chain: "btc" | "evm",
): Promise<BtcAnchor | EvmAnchor> {
  if (chain === "btc") return assertBtcAnchorAvailable();
  return pickEvmAnchor();
}

/**
 * Issue #428 — variant that returns `null` instead of throwing when no
 * Ledger is paired, so write paths can fall through to the unsigned
 * in-memory store. Other failures (BTC anchor present but taproot-only,
 * etc.) still throw so the user sees the real error rather than a
 * silent demotion to unsigned.
 */
async function tryPickAnchorForChain(
  chain: "btc" | "evm",
): Promise<BtcAnchor | EvmAnchor | null> {
  try {
    return await pickAnchorForChain(chain);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith(ContactsError.LedgerNotPaired)) return null;
    throw e;
  }
}

async function signBlobForChain(args: {
  chain: "btc" | "evm";
  preimage: string;
  anchor: BtcAnchor | EvmAnchor;
}): Promise<string> {
  if (args.chain === "btc") {
    const out = await signContactsBlobBtc({
      preimage: args.preimage,
      anchor: args.anchor as BtcAnchor,
    });
    return out.signature;
  }
  const out = await signContactsBlobEvm({
    preimage: args.preimage,
    anchor: args.anchor as EvmAnchor,
  });
  return out.signature;
}

async function verifyBlobForChain(
  chain: "btc" | "evm",
  blob: ChainBlob,
): Promise<boolean> {
  if (chain === "btc") return verifyBtcBlob(blob);
  return verifyEvmBlob(blob);
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- read-side validation ----------

/**
 * Strict check on a single chain's blob. Throws the matching CONTACTS_*
 * error code on any failure; returns the verified blob on success.
 */
async function validateChainBlob(
  chain: ContactChain,
  blob: ChainBlob,
): Promise<ChainBlob> {
  if (!isV1Chain(chain)) {
    // We don't have signers for these in v1; storage shouldn't either.
    throw new Error(
      `${ContactsError.ChainNotYetSupported}: ${chain} blob exists in storage ` +
        `but no v1 verifier is wired.`,
    );
  }
  // Anchor-mismatch: in-memory anchor (if present) must match disk.
  const recorded = anchorState[chain].anchorAddress;
  if (recorded && recorded !== blob.anchorAddress) {
    throw new Error(
      `${ContactsError.AnchorMismatch}: ${chain} blob anchor changed mid-session ` +
        `(recorded=${recorded}, disk=${blob.anchorAddress}). ` +
        `Possible disk tampering — refusing to use this list.`,
    );
  }
  // Version-rollback: must be ≥ the highest version this session has seen.
  const maxV = anchorState[chain].maxVersion;
  if (maxV !== undefined && blob.version < maxV) {
    throw new Error(
      `${ContactsError.VersionRollback}: ${chain} blob version ${blob.version} ` +
        `is lower than highest seen this session (${maxV}). Replay/rollback ` +
        `attempt — refusing.`,
    );
  }
  // Signature: must verify.
  const ok = await verifyBlobForChain(chain, blob);
  if (!ok) {
    throw new Error(
      `${ContactsError.Tampered}: ${chain} blob signature invalid. The contacts ` +
        `file may have been edited between sessions.`,
    );
  }
  recordAnchor(chain, blob);
  return blob;
}

// ---------- public API ----------

export async function addContact(args: AddContactArgs): Promise<{
  chain: ContactChain;
  label: string;
  address: string;
  version: number;
  anchorAddress: string;
  /**
   * `true` when the contact was stored unsigned (demo mode OR non-demo
   * with no paired Ledger — issue #428). Persistence is process-local
   * in both cases; the agent should surface "(unsigned)" alongside the
   * label so the user knows the address is not anchored to a hardware
   * key. Pair a Ledger and re-add the contact to upgrade to signed.
   */
  unsigned?: boolean;
}> {
  // Issue #482 — `intendedChains` is meaningful only for EVM, where the
  // single `evm` blob covers ethereum/arbitrum/polygon/base/optimism and
  // the resolver has no other signal to fire CONTACT-CHAIN MISMATCH on.
  // Reject early (before the demo / no-Ledger branches) so the rejection
  // is consistent across all three storage paths.
  if (args.intendedChains !== undefined && args.chain !== "evm") {
    throw new Error(
      `${ContactsError.IntendedChainsEvmOnly}: intendedChains is EVM-only ` +
        `(issue #482); contacts on chain "${args.chain}" cannot carry it. ` +
        `Drop the field or save the contact under chain="evm".`,
    );
  }
  // Demo mode: route to the in-memory store, no Ledger interaction.
  // `version` and `anchorAddress` are placeholders so the response shape
  // matches the production tool — agents that branch on those fields
  // see a sentinel ("DEMO_ANCHOR") rather than a missing key.
  // NOTE: the demo store does not currently track `intendedChains`; the
  // tag is silently dropped in demo mode, matching demo's documented
  // less-secure-by-design trust model (the simulation envelope intercept
  // is the address-poisoning defense, not crypto chain consistency).
  if (isDemoMode()) {
    addDemoContact({
      chain: args.chain,
      label: args.label,
      address: args.address,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    });
    return {
      chain: args.chain,
      label: args.label,
      address: args.address,
      version: 0,
      anchorAddress: "DEMO_ANCHOR",
      unsigned: true,
    };
  }
  rejectIfNotV1(args.chain);
  const chain = args.chain as "btc" | "evm";
  // Address format validation up front.
  if (!CONTACT_ADDRESS_PATTERNS[args.chain].test(args.address)) {
    throw new Error(
      `${ContactsError.AddressFormatMismatch}: address "${args.address}" does not ` +
        `match the expected format for chain "${args.chain}".`,
    );
  }

  // Issue #428 — when no Ledger is paired, fall through to the same
  // in-memory store demo mode uses, return `unsigned: true`. Lets first-
  // run / accountant-share users label addresses without entering demo
  // mode (which intercepts broadcasts) or pairing a Ledger they don't
  // own. Persistence is process-local; the deferred state machine in
  // `claude-work/plan-contacts-unsigned-state-machine.md` adds disk
  // persistence + sign-on-pair upgrade.
  const anchor = await tryPickAnchorForChain(chain);
  if (anchor === null) {
    addDemoContact({
      chain: args.chain,
      label: args.label,
      address: args.address,
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
    });
    return {
      chain: args.chain,
      label: args.label,
      address: args.address,
      version: 0,
      anchorAddress: "UNSIGNED_NO_LEDGER",
      unsigned: true,
    };
  }

  const file = readContactsFile();
  const existingBlob = file.chains[chain];
  // If a blob exists, verify it BEFORE mutating — any tamper means we
  // can't safely merge new entries in.
  if (existingBlob) {
    await validateChainBlob(chain, existingBlob);
    // Duplicate detection: same (address) on the chain — reject;
    // adding the same LABEL replaces (per design), but the same
    // address under a different label is suspicious so we surface.
    const collision = existingBlob.entries.find(
      (e) => e.address === args.address && e.label !== args.label,
    );
    if (collision) {
      throw new Error(
        `${ContactsError.DuplicateAddress}: address ${args.address} is already ` +
          `saved as "${collision.label}" on ${args.chain}. Remove the existing ` +
          `entry first if you want to rename, or pick a different address.`,
      );
    }
  }

  // Build the new entries: replace if same label, append otherwise.
  const oldEntries: SignedContactEntry[] = existingBlob?.entries ?? [];
  const filtered = oldEntries.filter((e) => e.label !== args.label);
  const newEntry: SignedContactEntry = {
    label: args.label,
    address: args.address,
    addedAt:
      oldEntries.find((e) => e.label === args.label)?.addedAt ?? nowIso(),
    ...(args.intendedChains !== undefined
      ? { intendedChains: args.intendedChains }
      : {}),
  };
  const nextEntries = [...filtered, newEntry];
  const nextVersion = (existingBlob?.version ?? 0) + 1;
  const signedAt = nowIso();
  const preimage = canonicalize(
    buildSigningPreimage({
      chainId: chain,
      version: nextVersion,
      anchorAddress: anchor.address,
      signedAt,
      entries: nextEntries,
    }),
  );
  const signature = await signBlobForChain({ chain, preimage, anchor });

  const newBlob: ChainBlob = {
    version: nextVersion,
    anchorAddress: anchor.address,
    anchorPath: anchor.path,
    ...(chain === "btc"
      ? { anchorAddressType: (anchor as BtcAnchor).addressType }
      : {}),
    signedAt,
    entries: nextEntries.sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
    ),
    signature,
  };

  // Update metadata sidecar if notes/tags supplied.
  const newMetadata = { ...file.metadata };
  if (args.notes !== undefined || args.tags !== undefined) {
    const existingMeta = newMetadata[args.label];
    newMetadata[args.label] = {
      ...(args.notes !== undefined ? { notes: args.notes } : {}),
      ...(args.tags !== undefined ? { tags: args.tags } : {}),
      createdAt: existingMeta?.createdAt ?? nowIso(),
    };
  }

  const next: ContactsFile = {
    ...file,
    chains: { ...file.chains, [chain]: newBlob },
    metadata: newMetadata,
  };
  writeContactsFile(next);
  recordAnchor(chain, newBlob);
  return {
    chain,
    label: args.label,
    address: args.address,
    version: nextVersion,
    anchorAddress: anchor.address,
  };
}

export async function removeContact(args: RemoveContactArgs): Promise<{
  removed: Array<{
    chain: ContactChain;
    address: string;
    version: number;
    unsigned?: boolean;
  }>;
}> {
  if (isDemoMode()) {
    const removed = removeDemoContact({
      label: args.label,
      ...(args.chain !== undefined ? { chain: args.chain } : {}),
    });
    if (removed.length === 0) {
      throw new Error(
        `${ContactsError.LabelNotFound}: no contact with label "${args.label}" found ` +
          `on ${args.chain ? `chain ${args.chain}` : "any chain"}.`,
      );
    }
    return {
      removed: removed.map((r) => ({ ...r, version: 0, unsigned: true })),
    };
  }
  // Issue #428 — also clear matching entries from the in-memory unsigned
  // store. Unsigned removals don't need a Ledger; signed removals still
  // do, and fall through to the existing path below.
  const unsignedRemoved = removeDemoContact({
    label: args.label,
    ...(args.chain !== undefined ? { chain: args.chain } : {}),
  });
  const file = readContactsFile();
  const chains: Array<"btc" | "evm"> = args.chain
    ? (rejectIfNotV1(args.chain), [args.chain as "btc" | "evm"])
    : ["btc", "evm"];

  const removed: Array<{
    chain: ContactChain;
    address: string;
    version: number;
    unsigned?: boolean;
  }> = unsignedRemoved.map((r) => ({ ...r, version: 0, unsigned: true }));
  let next = file;
  for (const chain of chains) {
    const blob = next.chains[chain];
    if (!blob) continue;
    const target = blob.entries.find((e) => e.label === args.label);
    if (!target) continue;
    await validateChainBlob(chain, blob);
    const anchor = await pickAnchorForChain(chain);
    const filtered = blob.entries.filter((e) => e.label !== args.label);
    const nextVersion = blob.version + 1;
    const signedAt = nowIso();
    const preimage = canonicalize(
      buildSigningPreimage({
        chainId: chain,
        version: nextVersion,
        anchorAddress: anchor.address,
        signedAt,
        entries: filtered,
      }),
    );
    const signature = await signBlobForChain({ chain, preimage, anchor });
    const newBlob: ChainBlob = {
      ...blob,
      version: nextVersion,
      anchorAddress: anchor.address,
      anchorPath: anchor.path,
      signedAt,
      entries: filtered,
      signature,
    };
    next = {
      ...next,
      chains: { ...next.chains, [chain]: newBlob },
    };
    removed.push({ chain, address: target.address, version: nextVersion });
    recordAnchor(chain, newBlob);
  }

  // Drop the metadata row if NO chain still references the label.
  const stillReferenced = (["btc", "evm"] as const).some((c) =>
    next.chains[c]?.entries.some((e) => e.label === args.label),
  );
  if (!stillReferenced && next.metadata[args.label]) {
    const { [args.label]: _, ...rest } = next.metadata;
    next = { ...next, metadata: rest };
  }

  if (removed.length === 0) {
    throw new Error(
      `${ContactsError.LabelNotFound}: no contact with label "${args.label}" found ` +
        `on ${args.chain ? `chain ${args.chain}` : "any chain"}.`,
    );
  }
  // Only persist if signed removals actually changed the disk file.
  // Pure unsigned removals (issue #428) leave the on-disk blob untouched.
  const signedRemovals = removed.some((r) => !r.unsigned);
  if (signedRemovals) writeContactsFile(next);
  return { removed };
}

export async function listContacts(
  args: ListContactsArgs,
): Promise<{ contacts: ListedContact[] }> {
  if (isDemoMode()) {
    const rows = listDemoContacts({
      ...(args.chain !== undefined ? { chain: args.chain } : {}),
      ...(args.label !== undefined ? { label: args.label } : {}),
    });
    // Join by label across chains — same shape as production. Every
    // demo entry is unsigned; flag accordingly.
    const byLabel = new Map<string, ListedContact>();
    for (const row of rows) {
      const existing = byLabel.get(row.label);
      const notes = row.notes ?? existing?.notes;
      const tags = row.tags ?? existing?.tags;
      const addedAt = existing && existing.addedAt < row.addedAt ? existing.addedAt : row.addedAt;
      byLabel.set(row.label, {
        label: row.label,
        addresses: { ...(existing?.addresses ?? {}), [row.chain]: row.address },
        ...(notes !== undefined ? { notes } : {}),
        ...(tags !== undefined ? { tags } : {}),
        addedAt,
        unsigned: true,
      });
    }
    const contacts = Array.from(byLabel.values()).sort((a, b) =>
      a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
    );
    return { contacts };
  }
  const file = readContactsStrict();
  const targets: Array<"btc" | "evm"> = args.chain
    ? (rejectIfNotV1(args.chain), [args.chain as "btc" | "evm"])
    : ["btc", "evm"];

  // Verify every target chain BEFORE building the joined view.
  // Strict failure — any tamper aborts (no silent fallback).
  const verified: Array<{ chain: "btc" | "evm"; blob: ChainBlob }> = [];
  for (const chain of targets) {
    const blob = file.chains[chain];
    if (!blob) continue;
    await validateChainBlob(chain, blob);
    verified.push({ chain, blob });
  }

  // Join by label across the verified blobs.
  const byLabel = new Map<string, ListedContact>();
  for (const { chain, blob } of verified) {
    for (const entry of blob.entries) {
      if (args.label && entry.label !== args.label) continue;
      const existing = byLabel.get(entry.label);
      const meta = file.metadata[entry.label];
      const earlierAddedAt =
        existing && existing.addedAt < entry.addedAt
          ? existing.addedAt
          : entry.addedAt;
      const newAddresses = {
        ...(existing?.addresses ?? {}),
        [chain]: entry.address,
      };
      byLabel.set(entry.label, {
        label: entry.label,
        addresses: newAddresses,
        ...(meta?.notes !== undefined ? { notes: meta.notes } : {}),
        ...(meta?.tags !== undefined ? { tags: meta.tags } : {}),
        addedAt: earlierAddedAt,
      });
    }
  }

  // Issue #428 — also fold in any unsigned entries from the in-memory
  // store so a non-demo user who added contacts before pairing a Ledger
  // can still see them. A label that has BOTH signed and unsigned
  // entries gets `unsigned: true` so the agent surfaces "(unsigned)"
  // in the verification block — the safety property is "never claim
  // a label is verified when any chain is unsigned."
  const unsignedRows = listDemoContacts({
    ...(args.chain !== undefined ? { chain: args.chain } : {}),
    ...(args.label !== undefined ? { label: args.label } : {}),
  });
  for (const row of unsignedRows) {
    const existing = byLabel.get(row.label);
    const notes = row.notes ?? existing?.notes;
    const tags = row.tags ?? existing?.tags;
    const addedAt = existing && existing.addedAt < row.addedAt ? existing.addedAt : row.addedAt;
    const newAddresses = {
      ...(existing?.addresses ?? {}),
      // In-memory wins ONLY for chains the disk doesn't already cover —
      // signed disk entries are the source of truth for any chain they
      // populate. The unsigned overlay just fills gaps.
      ...(existing?.addresses && existing.addresses[row.chain]
        ? {}
        : { [row.chain]: row.address }),
    };
    byLabel.set(row.label, {
      label: row.label,
      addresses: newAddresses,
      ...(notes !== undefined ? { notes } : {}),
      ...(tags !== undefined ? { tags } : {}),
      addedAt,
      unsigned: true,
    });
  }

  const contacts = Array.from(byLabel.values()).sort((a, b) =>
    a.label < b.label ? -1 : a.label > b.label ? 1 : 0,
  );
  return { contacts };
}

export async function verifyContacts(
  args: VerifyContactsArgs,
): Promise<{ results: VerifyResult[] }> {
  if (isDemoMode()) {
    // Demo store is unsigned by design; "verification" reduces to a
    // count of how many entries are present per requested chain. The
    // `anchorAddress: "DEMO_ANCHOR"` sentinel tells callers the result
    // is from the demo path so they don't conflate it with a signed
    // verification.
    const chains: ContactChain[] = args.chain
      ? [args.chain]
      : (["btc", "evm", "solana", "tron"] as ContactChain[]);
    const rows = listDemoContacts();
    const byChain = new Map<ContactChain, number>();
    for (const r of rows) byChain.set(r.chain, (byChain.get(r.chain) ?? 0) + 1);
    return {
      results: chains.map((chain) => {
        const count = byChain.get(chain) ?? 0;
        if (count === 0) {
          return { chain, ok: false, reason: "no entries on this chain" };
        }
        return {
          chain,
          ok: true,
          anchorAddress: "DEMO_ANCHOR",
          version: 0,
          entryCount: count,
        };
      }),
    };
  }
  let file: ContactsFile;
  try {
    file = readContactsStrict();
  } catch {
    // Even strict read can't parse → return one synthetic row per
    // requested chain saying CONTACTS_TAMPERED.
    const chains: Array<"btc" | "evm"> = args.chain
      ? (rejectIfNotV1(args.chain), [args.chain as "btc" | "evm"])
      : ["btc", "evm"];
    return {
      results: chains.map((c) => ({
        chain: c,
        ok: false,
        reason: ContactsError.Tampered,
      })),
    };
  }

  const targets: Array<"btc" | "evm"> = args.chain
    ? (rejectIfNotV1(args.chain), [args.chain as "btc" | "evm"])
    : ["btc", "evm"];
  // Issue #428 — count unsigned in-memory entries per chain so each
  // VerifyResult can carry `unsignedEntryCount`. A chain with NO signed
  // blob but ≥1 unsigned entry returns `ok: false, reason: "no signed
  // entries on this chain", unsignedEntryCount: N` so the agent
  // surfaces the unsigned overlay rather than silently dropping it.
  const unsignedCounts = new Map<ContactChain, number>();
  for (const r of listDemoContacts()) {
    unsignedCounts.set(r.chain, (unsignedCounts.get(r.chain) ?? 0) + 1);
  }
  const results: VerifyResult[] = [];
  for (const chain of targets) {
    const unsignedN = unsignedCounts.get(chain) ?? 0;
    const blob = file.chains[chain];
    if (!blob) {
      results.push({
        chain,
        ok: false,
        reason:
          unsignedN > 0
            ? "no signed entries on this chain (unsigned-only)"
            : "no entries on this chain",
        ...(unsignedN > 0 ? { unsignedEntryCount: unsignedN } : {}),
      });
      continue;
    }
    try {
      await validateChainBlob(chain, blob);
      results.push({
        chain,
        ok: true,
        anchorAddress: blob.anchorAddress,
        version: blob.version,
        entryCount: blob.entries.length,
        ...(unsignedN > 0 ? { unsignedEntryCount: unsignedN } : {}),
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Surface the matching CONTACTS_* error code.
      const code = msg.split(":")[0];
      results.push({
        chain,
        ok: false,
        reason: code,
        ...(unsignedN > 0 ? { unsignedEntryCount: unsignedN } : {}),
      });
    }
  }
  return { results };
}

// ---------- exposed for resolver ----------

/**
 * Internal-only "do we have any verified entries on this chain right
 * now?" probe. Used by the resolver's reverse-lookup decoration —
 * silently skips reverse lookup if the file is tampered (the literal
 * address still flows through unchanged), surfaces a warning instead.
 *
 * Returns `null` when storage / verification fails; returns the
 * verified blob otherwise.
 */
export async function tryReadVerifiedBlob(
  chain: "btc" | "evm",
): Promise<ChainBlob | null> {
  let file: ContactsFile;
  try {
    file = readContactsStrict();
  } catch {
    return null;
  }
  const blob = file.chains[chain];
  if (!blob) return null;
  try {
    await validateChainBlob(chain, blob);
    return blob;
  } catch {
    return null;
  }
}

export { emptyContactsFile };
