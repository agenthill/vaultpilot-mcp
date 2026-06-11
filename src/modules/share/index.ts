import { randomUUID } from "node:crypto";
import {
  EXPIRES_IN_MS,
  decodeToken,
  encodeToken,
  extractToken,
  hashToken,
} from "./token.js";
import { readInvitesFile, writeInvitesFile } from "./storage.js";
import {
  type GenerateReadonlyLinkInput,
  type ImportReadonlyTokenInput,
  type ListReadonlyInvitesInput,
  type RevokeReadonlyInviteInput,
  type ShareWallets,
  type StoredInvite,
} from "./schemas.js";

/**
 * Read-only advisor / share — issuer + recipient handlers.
 *
 * Plan: `claude-work/plan-readonly-advisor.md`. v1 ships Model A: the
 * token is a structured envelope of public addresses + metadata, not a
 * cryptographic secret. Issuer-side bookkeeping (`list` / `revoke`)
 * lets the user see what they've shared and forget about it; recipient
 * queries the listed addresses via their own RPCs.
 */

function nowMs(): number {
  return Date.now();
}

function autoName(id: string): string {
  // First 4 hex chars of the UUID — short, mostly unique within a single
  // user's invite history. The user can pass their own friendly name to
  // override.
  return `share-${id.replace(/-/g, "").slice(0, 4)}`;
}

function walletCounts(
  wallets: ShareWallets,
): { evm: number; tron: number; solana: number; btc: number } {
  return {
    evm: wallets.evm?.length ?? 0,
    tron: wallets.tron?.length ?? 0,
    solana: wallets.solana?.length ?? 0,
    btc: wallets.btc?.length ?? 0,
  };
}

function countAddresses(wallets: ShareWallets): number {
  const c = walletCounts(wallets);
  return c.evm + c.tron + c.solana + c.btc;
}

export interface GenerateReadonlyLinkResult {
  /** The token to share with the recipient. Show ONCE — not stored locally. */
  token: string;
  id: string;
  name: string;
  scope: "read-portfolio";
  issuedAt: number;
  expiresAt: number;
  /** Address counts — quick visual confirmation of what was packed. */
  walletCounts: {
    evm: number;
    tron: number;
    solana: number;
    btc: number;
  };
}

export function generateReadonlyLink(
  args: GenerateReadonlyLinkInput,
): GenerateReadonlyLinkResult {
  const id = randomUUID();
  const issuedAt = nowMs();
  const expiresAt = issuedAt + EXPIRES_IN_MS[args.expiresIn];
  const name = args.name ?? autoName(id);

  // Reject duplicate names — the user wouldn't be able to revoke
  // unambiguously by name otherwise. Active duplicates only; revoked
  // invites with the same name are fine (the user has already moved on).
  const file = readInvitesFile();
  if (file.invites.some((inv) => inv.name === name && inv.revokedAt === null)) {
    throw new Error(
      `An active read-only invite named '${name}' already exists. ` +
        `Pick a different name or revoke the existing invite first ` +
        `(\`revoke_readonly_invite({ name: '${name}' })\`).`,
    );
  }

  const token = encodeToken({
    v: 1,
    id,
    iat: issuedAt,
    exp: expiresAt,
    scope: args.scope,
    name,
    wallets: args.wallets,
  });

  const stored: StoredInvite = {
    id,
    name,
    scope: args.scope,
    wallets: args.wallets,
    tokenHash: hashToken(token),
    issuedAt,
    expiresAt,
    revokedAt: null,
  };
  writeInvitesFile({ ...file, invites: [...file.invites, stored] });

  return {
    token,
    id,
    name,
    scope: args.scope,
    issuedAt,
    expiresAt,
    walletCounts: walletCounts(args.wallets),
  };
}

export interface ImportReadonlyTokenResult {
  /** Decoded envelope contents the recipient can hand to portfolio readers. */
  wallets: ShareWallets;
  scope: "read-portfolio";
  /** Friendly name from the issuer — surface to the user verbatim. */
  name: string;
  issuedAt: number;
  expiresAt: number;
  /** Issuer-side UUID; surfaced for diagnostics, not used for auth in Model A. */
  id: string;
}

export function importReadonlyToken(
  args: ImportReadonlyTokenInput,
): ImportReadonlyTokenResult {
  const raw = extractToken(args.token);
  const env = decodeToken(raw);
  const now = nowMs();
  if (env.exp <= now) {
    const ageMs = now - env.exp;
    const ageH = Math.floor(ageMs / (60 * 60 * 1000));
    throw new Error(
      `Read-only token expired ${ageH}h ago (expiresAt=${new Date(env.exp).toISOString()}). ` +
        `Ask the issuer for a fresh \`generate_readonly_link\`.`,
    );
  }
  return {
    wallets: env.wallets,
    scope: env.scope,
    name: env.name,
    issuedAt: env.iat,
    expiresAt: env.exp,
    id: env.id,
  };
}

export interface InviteSummary {
  id: string;
  name: string;
  scope: "read-portfolio";
  issuedAt: number;
  expiresAt: number;
  revokedAt: number | null;
  /** Computed at list time; reflects clock at this very moment. */
  expired: boolean;
  /** Computed convenience: revoked OR expired. */
  active: boolean;
  walletCounts: {
    evm: number;
    tron: number;
    solana: number;
    btc: number;
  };
  /** Total addresses across all chains — handy for UI sorting/scanning. */
  totalAddresses: number;
}

export interface ListReadonlyInvitesResult {
  invites: InviteSummary[];
}

export function listReadonlyInvites(
  args: ListReadonlyInvitesInput,
): ListReadonlyInvitesResult {
  const file = readInvitesFile();
  const now = nowMs();
  const summaries: InviteSummary[] = file.invites.map((inv) => {
    const expired = inv.expiresAt <= now;
    const revoked = inv.revokedAt !== null;
    return {
      id: inv.id,
      name: inv.name,
      scope: inv.scope,
      issuedAt: inv.issuedAt,
      expiresAt: inv.expiresAt,
      revokedAt: inv.revokedAt,
      expired,
      active: !revoked && !expired,
      walletCounts: walletCounts(inv.wallets),
      totalAddresses: countAddresses(inv.wallets),
    };
  });
  const filtered = args.includeInactive
    ? summaries
    : summaries.filter((s) => s.active);
  return { invites: filtered };
}

export interface RevokeReadonlyInviteResult {
  revoked: {
    id: string;
    name: string;
    revokedAt: number;
  };
}

export function revokeReadonlyInvite(
  args: RevokeReadonlyInviteInput,
): RevokeReadonlyInviteResult {
  const file = readInvitesFile();
  const target = file.invites.find(
    (inv) => inv.name === args.name && inv.revokedAt === null,
  );
  if (!target) {
    const exists = file.invites.some((inv) => inv.name === args.name);
    if (exists) {
      throw new Error(
        `Read-only invite '${args.name}' is already revoked. ` +
          `Use \`list_readonly_invites({ includeInactive: true })\` to see history.`,
      );
    }
    throw new Error(
      `No read-only invite found named '${args.name}'. ` +
        `Use \`list_readonly_invites\` to see active invites.`,
    );
  }
  const revokedAt = nowMs();
  const updatedInvites = file.invites.map((inv) =>
    inv.id === target.id ? { ...inv, revokedAt } : inv,
  );
  writeInvitesFile({ ...file, invites: updatedInvites });
  return {
    revoked: {
      id: target.id,
      name: target.name,
      revokedAt,
    },
  };
}
