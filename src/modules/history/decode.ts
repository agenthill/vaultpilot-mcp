import { fetch4byteSignatures } from "../../data/apis/fourbyte.js";
import { cache } from "../../data/cache.js";

/**
 * Resolve a batch of 4-byte selectors to human-readable function names.
 *
 * Strategy: for each unique selector, query 4byte.directory (wrapped by the
 * existing `fetch4byteSignatures` helper, which doesn't cache internally, so
 * we wrap with a 24h cache keyed per selector). We deliberately do NOT do the
 * "re-encode every candidate and match against calldata" dance that
 * `verifyEvmCalldata` performs — that's far too expensive for bulk history
 * and we don't have the calldata contextually anyway (txlist only returns
 * `input` on the first item per tx). If a selector resolves to multiple
 * candidates we pick the first (4byte returns most-common first by ID) and
 * record `ambiguous: true` so the caller can surface uncertainty.
 *
 * Failures are swallowed — method decoding is a nice-to-have, never fatal.
 */

const SELECTOR_TTL = 86_400_000; // 24h — selectors don't change, but cache eviction needs a bound.

export interface SelectorResolution {
  methodName?: string;
  ambiguous?: boolean;
}

export async function resolveSelectors(
  selectors: string[]
): Promise<Map<string, SelectorResolution>> {
  const unique = Array.from(new Set(selectors.filter((s) => /^0x[0-9a-fA-F]{8}$/.test(s))));
  const out = new Map<string, SelectorResolution>();

  await Promise.all(
    unique.map(async (sel) => {
      const key = `4byte:${sel.toLowerCase()}`;
      const cached = cache.get<SelectorResolution>(key);
      if (cached) {
        out.set(sel, cached);
        return;
      }
      try {
        const sigs = await fetch4byteSignatures(sel);
        // Take the name (part before "(") of the first candidate. 4byte
        // returns candidates ordered by created-ID; the earliest-created
        // signature is usually the canonical one, but the field is also
        // attacker-insertable, so we sanitize the name before surfacing.
        const res: SelectorResolution = {};
        if (sigs.length > 0) {
          const first = sigs[0];
          const parenIdx = first.indexOf("(");
          const rawName = parenIdx > 0 ? first.slice(0, parenIdx) : first;
          const methodName = rawName.replace(/[^A-Za-z0-9_]/g, "").slice(0, 64);
          if (methodName) res.methodName = methodName;
          if (sigs.length > 1) res.ambiguous = true;
        }
        cache.set(key, res, SELECTOR_TTL);
        out.set(sel, res);
      } catch {
        // 4byte outage = method names simply missing; not an error for history.
      }
    })
  );

  return out;
}
