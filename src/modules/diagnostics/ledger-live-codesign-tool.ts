/**
 * `verify_ledger_live_codesign` — issue #325 P4. Discrete user-driven
 * tool that delegates to the platform-specific codesign verifier in
 * `src/signing/ledger-live-codesign.ts`. Translates exceptions into
 * structured statuses so the agent can relay clear next-steps.
 *
 * NOT auto-fired on every signing call — codesign tools take 100s of
 * ms per invocation and the binary doesn't change between signs. Run
 * after first install / Ledger Live update / OS update.
 * bump
 */
import {
  verifyLedgerLiveCodesign as verify,
  type CodesignResult,
} from "../../signing/ledger-live-codesign.js";

export interface VerifyLedgerLiveCodesignToolArgs {
  binaryPath?: string;
}

export async function verifyLedgerLiveCodesign(
  args: VerifyLedgerLiveCodesignToolArgs = {},
): Promise<CodesignResult> {
  try {
    return await verify({ binaryPath: args.binaryPath });
  } catch (err) {
    const message = (err as Error).message ?? String(err);
    return {
      status: "error",
      inspectedPath: args.binaryPath ?? "",
      platform: process.platform,
      message: `Unexpected failure during codesign verification: ${message}`,
    };
  }
}
