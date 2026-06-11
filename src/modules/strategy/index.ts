/**
 * `share_strategy` and `import_strategy` handlers.
 *
 * Strategy = anonymized portfolio structure. The user's wallet
 * positions are projected into a percentage-only shape (no addresses,
 * no absolute USD), redaction-scanned, and emitted as JSON. The
 * recipient pastes the JSON into their own VaultPilot via
 * `import_strategy` for read-only inspection.
 *
 * v1 ships JSON-only; the URL-shortener path the plan calls out is
 * explicitly v2 (depends on hosted-MCP infrastructure that doesn't
 * exist yet).
 *
 * No on-chain side effects, no signing, no broadcast. Pure read +
 * project + redact.
 */

import { getPortfolioSummary } from "../portfolio/index.js";
import type { PortfolioSummary } from "../../types/index.js";
import {
  assertAtLeastOneAddress,
  SHARED_STRATEGY_VERSION,
  type ImportStrategyArgs,
  type ShareStrategyArgs,
  type SharedStrategy,
  type SharedStrategyPosition,
} from "./schemas.js";
import {
  serializePortfolioToPositions,
  chainsFromPositions,
} from "./serialize.js";
import { assertNoAddressLeak, RedactionError } from "./redact.js";

export { RedactionError };

const POSITION_KIND_VALUES = new Set<SharedStrategyPosition["kind"]>([
  "balance",
  "supply",
  "borrow",
  "lp",
  "stake",
]);

const RISK_PROFILE_VALUES = new Set<NonNullable<SharedStrategy["meta"]["riskProfile"]>>([
  "conservative",
  "moderate",
  "aggressive",
]);

// Known-key sets, frozen against the v1 schema. Validation refuses any key
// outside these sets so a compromised producer can't smuggle directive-shaped
// fields (`_delegateAuthority`, `_executor`, …) through silently. Issue #557.
const KNOWN_TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  "version",
  "meta",
  "positions",
  "notes",
]);
const KNOWN_META_KEYS: ReadonlySet<string> = new Set([
  "name",
  "description",
  "authorLabel",
  "riskProfile",
  "createdIso",
  "chains",
]);
const KNOWN_POSITION_KEYS: ReadonlySet<string> = new Set([
  "protocol",
  "chain",
  "kind",
  "asset",
  "pctOfTotal",
  "healthFactor",
  "feeTier",
  "apr",
  "inRange",
]);

/**
 * Refuse any key not listed in `allowed`. The previous behavior (silently
 * drop unknown keys via reconstruction) hid tampering — issue #557 wants
 * the import side to surface it. Symmetric on emit so a future serializer
 * drift adding a new field can't leak past validation either.
 */
function assertOnlyAllowedKeys(
  obj: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  context: string,
): void {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new Error(
        `STRATEGY_UNKNOWN_KEY_REJECTED: ${context} contains unexpected key ` +
          `"${key}". Strategy JSON must conform to the published ` +
          `v${SHARED_STRATEGY_VERSION} schema; unknown keys are refused to surface ` +
          `tampering by an upstream producer (a compromised MCP, a hand-edited ` +
          `paste, or a directive-shaped sidecar like \`_delegateAuthority\` / ` +
          `\`_executor\`). Allowed at ${context}: ` +
          `${Array.from(allowed).sort().join(", ")}.`,
      );
    }
  }
}

/** Walk top-level, meta, and each position and assert the strict shape. */
function assertStrategyStrictShape(obj: Record<string, unknown>): void {
  assertOnlyAllowedKeys(obj, KNOWN_TOP_LEVEL_KEYS, "strategy root");
  const meta = obj.meta;
  if (meta && typeof meta === "object") {
    assertOnlyAllowedKeys(
      meta as Record<string, unknown>,
      KNOWN_META_KEYS,
      "strategy.meta",
    );
  }
  const positions = obj.positions;
  if (Array.isArray(positions)) {
    for (const p of positions) {
      if (p && typeof p === "object") {
        assertOnlyAllowedKeys(
          p as Record<string, unknown>,
          KNOWN_POSITION_KEYS,
          "strategy.positions[]",
        );
      }
    }
  }
}

/** Sort positions by descending pctOfTotal so consumers see the dominant pieces first. */
function sortPositions(positions: SharedStrategyPosition[]): SharedStrategyPosition[] {
  return [...positions].sort((a, b) => b.pctOfTotal - a.pctOfTotal);
}

export interface ShareStrategyResult {
  strategy: SharedStrategy;
  /** Stringified form of `strategy`. Convenience for paste-into-Discord flows. */
  jsonString: string;
}

export async function shareStrategy(
  args: ShareStrategyArgs,
): Promise<ShareStrategyResult> {
  assertAtLeastOneAddress(args);

  // Pull the same portfolio summary the agent would for any other
  // read-side question. Single-wallet only in v1 (multi-wallet sharing
  // adds a "whose strategy is this?" attribution question that's a
  // separate plan).
  const summary = (await getPortfolioSummary({
    ...(args.wallet ? { wallet: args.wallet } : {}),
    ...(args.tronAddress ? { tronAddress: args.tronAddress } : {}),
    ...(args.solanaAddress ? { solanaAddress: args.solanaAddress } : {}),
    ...(args.bitcoinAddress ? { bitcoinAddress: args.bitcoinAddress } : {}),
    ...(args.litecoinAddress
      ? { litecoinAddress: args.litecoinAddress }
      : {}),
  })) as PortfolioSummary;

  const positions = sortPositions(serializePortfolioToPositions(summary));

  const notes: string[] = [
    "Percentages are rounded to 1 decimal — fine-grained allocation can " +
      "fingerprint a wallet.",
    "DeFi position interest accrual and unrealized LP impermanent loss are NOT " +
      "surfaced; positions are point-in-time snapshots.",
    "Strategy is read-only structure. The recipient cannot replicate amounts " +
      "or addresses — only the protocol + asset + percentage shape.",
  ];
  if (positions.length === 0) {
    notes.push(
      "No non-zero positions found for the supplied address(es). The strategy " +
        "is empty; nothing to share.",
    );
  }
  if (summary.totalUsd <= 0) {
    notes.push(
      "Wallet total USD value is 0 (or unpriced). Position percentages may " +
        "not be meaningful — consider waiting until at least one priced " +
        "balance is present.",
    );
  }

  const strategy: SharedStrategy = {
    version: SHARED_STRATEGY_VERSION,
    meta: {
      name: args.name,
      ...(args.description ? { description: args.description } : {}),
      ...(args.authorLabel ? { authorLabel: args.authorLabel } : {}),
      ...(args.riskProfile ? { riskProfile: args.riskProfile as NonNullable<SharedStrategy["meta"]["riskProfile"]> } : {}),
      createdIso: new Date().toISOString(),
      chains: chainsFromPositions(positions),
    },
    positions,
    notes,
  };

  // Strict-shape guard. Backstop for serializer drift adding a new
  // field — issue #557. Walks top-level + meta + each position and
  // throws if any key falls outside the v1 schema. Defense in depth
  // against a future code path that emits a directive-shaped sidecar
  // (`_delegateAuthority`, `_executor`, …) that the recipient's import
  // path would now refuse anyway, but this catches it at the source.
  assertStrategyStrictShape(strategy as unknown as Record<string, unknown>);

  // Privacy guard. Throws RedactionError if anything in the JSON
  // matches an address / hash pattern. The serializer is expected to
  // produce clean output; this scan is a backstop for serializer drift
  // AND for user-pasted-address-into-name slip-ups (the meta fields
  // ride through the same JSON).
  assertNoAddressLeak(strategy);

  // Stable, deterministic stringification — JSON.stringify with no
  // pretty-printing produces a canonical form the user can paste
  // verbatim. The recipient parses the same way.
  const jsonString = JSON.stringify(strategy);

  return { strategy, jsonString };
}

export interface ImportStrategyResult {
  strategy: SharedStrategy;
}

/**
 * Validate that a parsed JSON matches the SharedStrategy shape. Strict
 * check — unknown top-level keys are rejected, version must match,
 * positions must each have the required fields. This is the agent's
 * defense against a sender who tries to embed unexpected fields (e.g.
 * "comments" or sidecar metadata) hoping the recipient surfaces them
 * unfiltered.
 */
function validateSharedStrategy(value: unknown): SharedStrategy {
  if (typeof value !== "object" || value === null) {
    throw new Error(
      "Imported strategy must be a JSON object. Got: " + typeof value,
    );
  }
  const obj = value as Record<string, unknown>;
  assertOnlyAllowedKeys(obj, KNOWN_TOP_LEVEL_KEYS, "strategy root");
  if (obj.version !== SHARED_STRATEGY_VERSION) {
    throw new Error(
      `Imported strategy version ${String(obj.version)} is not supported. ` +
        `This server understands version ${SHARED_STRATEGY_VERSION}.`,
    );
  }
  const meta = obj.meta as Record<string, unknown> | undefined;
  if (!meta || typeof meta !== "object") {
    throw new Error("Imported strategy missing required `meta` object.");
  }
  assertOnlyAllowedKeys(meta, KNOWN_META_KEYS, "strategy.meta");
  if (typeof meta.name !== "string" || meta.name.length === 0) {
    throw new Error(
      "Imported strategy `meta.name` must be a non-empty string.",
    );
  }
  if (typeof meta.createdIso !== "string") {
    throw new Error("Imported strategy `meta.createdIso` must be a string.");
  }
  if (!Array.isArray(meta.chains)) {
    throw new Error("Imported strategy `meta.chains` must be an array.");
  }
  for (const c of meta.chains) {
    if (typeof c !== "string") {
      throw new Error(
        "Imported strategy `meta.chains` entries must be strings.",
      );
    }
  }
  if (
    meta.riskProfile !== undefined &&
    !RISK_PROFILE_VALUES.has(meta.riskProfile as never)
  ) {
    throw new Error(
      `Imported strategy \`meta.riskProfile\` "${String(meta.riskProfile)}" ` +
        `must be one of ${Array.from(RISK_PROFILE_VALUES).join(" / ")}.`,
    );
  }
  if (!Array.isArray(obj.positions)) {
    throw new Error("Imported strategy `positions` must be an array.");
  }
  const positions: SharedStrategyPosition[] = [];
  for (const raw of obj.positions) {
    if (typeof raw !== "object" || raw === null) {
      throw new Error("Each position must be an object.");
    }
    const p = raw as Record<string, unknown>;
    assertOnlyAllowedKeys(p, KNOWN_POSITION_KEYS, "strategy.positions[]");
    if (typeof p.protocol !== "string") {
      throw new Error("Position `protocol` must be a string.");
    }
    if (typeof p.chain !== "string") {
      throw new Error("Position `chain` must be a string.");
    }
    if (
      typeof p.kind !== "string" ||
      !POSITION_KIND_VALUES.has(p.kind as never)
    ) {
      throw new Error(
        `Position \`kind\` "${String(p.kind)}" must be one of ${Array.from(
          POSITION_KIND_VALUES,
        ).join(" / ")}.`,
      );
    }
    if (typeof p.asset !== "string" || p.asset.length === 0) {
      throw new Error("Position `asset` must be a non-empty string.");
    }
    if (typeof p.pctOfTotal !== "number" || !Number.isFinite(p.pctOfTotal)) {
      throw new Error("Position `pctOfTotal` must be a finite number.");
    }
    const next: SharedStrategyPosition = {
      protocol: p.protocol,
      chain: p.chain,
      kind: p.kind as SharedStrategyPosition["kind"],
      asset: p.asset,
      pctOfTotal: p.pctOfTotal,
    };
    if (typeof p.healthFactor === "number" && Number.isFinite(p.healthFactor)) {
      next.healthFactor = p.healthFactor;
    }
    if (typeof p.feeTier === "number" && Number.isFinite(p.feeTier)) {
      next.feeTier = p.feeTier;
    }
    if (typeof p.apr === "number" && Number.isFinite(p.apr)) {
      next.apr = p.apr;
    }
    if (typeof p.inRange === "boolean") {
      next.inRange = p.inRange;
    }
    positions.push(next);
  }
  if (!Array.isArray(obj.notes)) {
    throw new Error("Imported strategy `notes` must be an array.");
  }
  for (const n of obj.notes) {
    if (typeof n !== "string") {
      throw new Error("Imported strategy `notes` entries must be strings.");
    }
  }

  const out: SharedStrategy = {
    version: SHARED_STRATEGY_VERSION,
    meta: {
      name: meta.name,
      createdIso: meta.createdIso,
      chains: meta.chains as string[],
      ...(typeof meta.description === "string"
        ? { description: meta.description }
        : {}),
      ...(typeof meta.authorLabel === "string"
        ? { authorLabel: meta.authorLabel }
        : {}),
      ...(meta.riskProfile !== undefined
        ? {
            riskProfile:
              meta.riskProfile as NonNullable<SharedStrategy["meta"]["riskProfile"]>,
          }
        : {}),
    },
    positions,
    notes: obj.notes as string[],
  };

  return out;
}

export async function importStrategy(
  args: ImportStrategyArgs,
): Promise<ImportStrategyResult> {
  let parsed: unknown;
  if (typeof args.json === "string") {
    try {
      parsed = JSON.parse(args.json);
    } catch (e) {
      throw new Error(
        "Imported strategy JSON did not parse: " +
          ((e as Error).message ?? "unknown parse error"),
      );
    }
  } else {
    parsed = args.json;
  }

  // Run the redaction scan FIRST (before validation), so a hostile
  // sender can't smuggle an address through a field we'd later strip.
  // The scan looks at the entire input shape regardless of what
  // validation would accept.
  assertNoAddressLeak(parsed);

  const strategy = validateSharedStrategy(parsed);

  // Re-scan the validated, normalized output for symmetry. Catches the
  // (unlikely) case where validation reshaped something into an
  // address-looking string.
  assertNoAddressLeak(strategy);

  return { strategy };
}
