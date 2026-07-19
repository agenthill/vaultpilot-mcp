#!/usr/bin/env bash
# Mutation falsifier-check for the #757 over-block fix (recipient-authorization.ts).
#
# Backup/restore uses `cp` (NOT `git checkout`) so it is robust whether the fix
# is committed or still in the working tree — an earlier git-checkout version of
# this probe silently reverted the uncommitted fix to the b46a851 baseline.
#
# Two mutations, each reverted after its run:
#
#  (M1) Neuter the recipient hard-gate (gateHardRecipient → no-op). PROVES the
#       widened FN_BY_SELECTOR did NOT reopen a drain: the 6 #757 drain
#       falsifiers must go RED (drains signable) while the 9 over-block positive
#       controls stay GREEN — i.e. the address-bearing functions are still gated
#       by gateHardRecipient, and the two paths are independent.
#
#  (M2) Restore the exact pre-fix baseline (HEAD = b46a851, where FN_BY_SELECTOR
#       is populated ONLY from SPEC's address-bearing subset). PROVES the
#       over-block controls are a real falsifier of THIS fix: the 9 controls go
#       RED (over-blocked as "unknown selector") while the 6 drains AND the 5
#       =wallet controls stay GREEN (the recipient dimension is untouched).
#
# Run from the worktree root. Expected verdicts printed inline.
set -u
cd "$(dirname "$0")/.." || exit 2
SRC="src/signing/recipient-authorization.ts"
BAK="$(mktemp)"
DRAIN="test/757-760-recipient-drain.test.ts"
OVERBLOCK="test/757-overblock-regression.test.ts"
cp "$SRC" "$BAK"
restore() { cp "$BAK" "$SRC"; }
trap 'restore; rm -f "$BAK"' EXIT

run() { npx vitest run "$@" 2>&1 | grep -E "Tests +[0-9]|Test Files"; }

echo "=== BASELINE (fixed code) — drains GREEN (refused), over-block GREEN (signable) ==="
run "$DRAIN" "$OVERBLOCK"

echo
echo "=== M1: neuter gateHardRecipient (no-op) — EXPECT 6 drains RED, 9 over-block GREEN ==="
perl -0pi -e 's/(function gateHardRecipient\(leaf: Leaf, fnName: string, ctx: GateCtx\): void \{)/$1\n  return; \/\/ MUTATION M1/' "$SRC"
echo "-- drains:";     run "$DRAIN"
echo "-- over-block:"; run "$OVERBLOCK"
restore

echo
echo "=== M2: restore exact pre-fix baseline (HEAD b46a851, SPEC-only FN_BY_SELECTOR) — EXPECT 9 over-block RED, drains+controls (11) GREEN ==="
git show "HEAD:$SRC" > "$SRC"
echo "-- over-block:"; run "$OVERBLOCK"
echo "-- drains:";     run "$DRAIN"
restore

echo
echo "=== restored — confirm baseline GREEN again ==="
run "$DRAIN" "$OVERBLOCK"
