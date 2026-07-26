/**
 * Issue #764 — completeness-caveat dangling-pointer guard.
 *
 * `custom-call-classifier.ts` carries two in-code pointers marking the
 * send-family gate's COMPLETENESS as an open question: the JSDoc above
 * `SEND_FAMILY_RECIPIENT_GATE` (~:55) and the trailing note on the
 * non-bypassable refusal message thrown by `assertSendFamilyRecipientIsWallet`
 * (~:150). Both cited #741 — which SEC's #753 certification closed on ITS
 * OWN acceptance criterion (the nine gated selectors are correct) while
 * explicitly leaving completeness unsettled. A reader following `(issue
 * #741)` lands on a resolved, closed issue and reasonably (wrongly)
 * concludes completeness was settled.
 *
 * The two location-scoped assertions below don't hardcode "must be #764" —
 * they only assert "must not be #741" — so a future re-scope (e.g. onto
 * #757 once the seam ships) repoints the source and stays green without
 * touching this test.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLASSIFIER_TS = join(
  __dirname,
  "..",
  "src",
  "security",
  "custom-call-classifier.ts",
);

// #741 is CLOSED (PR #753, 2026-07-19). Its completeness caveat rode along
// with the closure even though completeness itself was left unsettled — see
// #764. Any `(issue #741)` pointer left in the completeness-caveat text is
// exactly the dangling reference this issue exists to catch.
const CLOSED_ISSUE_REF = "(issue #741)";

describe("Completeness-caveat dangling-pointer guard (issue #764)", () => {
  const src = readFileSync(CLASSIFIER_TS, "utf8");

  it("does not cite the closed #741 issue as the completeness caveat's home", () => {
    expect(src).not.toContain(CLOSED_ISSUE_REF);
  });

  it("the SEND_FAMILY_RECIPIENT_GATE JSDoc completeness caveat resolves to an open issue", () => {
    // Slice to the JSDoc block that precedes the gate-entry interface — the
    // COMPLETENESS caveat lives there, not anywhere else in the file.
    const jsdocEnd = src.indexOf("export interface SendFamilyGateEntry");
    expect(jsdocEnd).toBeGreaterThan(-1);
    const jsdoc = src.slice(0, jsdocEnd);
    const m = jsdoc.match(/qualified security review \(issue #(\d+)\)/);
    expect(m).not.toBeNull();
    // #741 is closed; the pointer must not resolve back to it.
    expect(m![1]).not.toBe("741");
  });

  it("the non-bypassable refusal message's completeness caveat resolves to an open issue", () => {
    // Slice to the assertSendFamilyRecipientIsWallet function body — the
    // trailing `(issue #NNN)` note on its refusal message lives there.
    const fnStart = src.indexOf(
      "export function assertSendFamilyRecipientIsWallet",
    );
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = src.slice(fnStart);
    const m = fnBody.match(/\(issue #(\d+)\)/);
    expect(m).not.toBeNull();
    expect(m![1]).not.toBe("741");
  });
});
