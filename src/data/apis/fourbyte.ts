import { fetchWithTimeout } from "../http.js";

const FOURBYTE_URL = "https://www.4byte.directory/api/v1/signatures/";

/**
 * Issue #694: this path feeds the pre-sign ABI cross-check
 * (`src/signing/verify-decode.ts`'s `verifyEvmCalldata`) — a stalled or
 * MITM'd 4byte.directory connection must not stall it indefinitely.
 * Default matches `data/http.ts`'s `fetchWithTimeout` convention.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export type FetchLike = (input: string) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

const defaultFetch: FetchLike = (url) => fetchWithTimeout(url);

/**
 * Races `promise` against a timer. `FetchLike` (above) takes only
 * `(input: string)` — no `init`/`signal` slot — so a caller-injected
 * `fetchFn` can't be handed an `AbortSignal` the way `defaultFetch` can
 * via `fetchWithTimeout`. Racing here bounds EVERY `fetchFn` — default
 * or injected — uniformly, rather than only the default path.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`4byte.directory fetch timed out after ${timeoutMs}ms`);
      err.name = "AbortError";
      reject(err);
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function fetch4byteSignatures(
  selector: string,
  fetchFn: FetchLike = defaultFetch,
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<string[]> {
  const res = await withTimeout(fetchFn(`${FOURBYTE_URL}?hex_signature=${selector}`), timeoutMs);
  if (!res.ok) throw new Error(`4byte.directory returned ${res.status}`);
  const data = (await res.json()) as { results?: Array<{ text_signature: string }> };
  return (data.results ?? []).map((r) => r.text_signature);
}
