#!/bin/sh
# The one list of checks run by BOTH the pre-commit and pre-push hooks.
#
# Exists because a change was once committed while its test suite was printing
# failures: the checks only gated `git push`, and nothing stopped the commit.
# Now nothing is committed or pushed unless every check below passes.
#
# A suite counts as passing only if it prints "=== N passed, 0 failed ===" AND
# exits 0 -- a suite that silently runs nothing does not pass.
# Plain POSIX sh on purpose: every command is written out, never built from a
# string variable (zsh does not word-split those, which once made checks
# silently not run).

cd "$(git rev-parse --show-toplevel)" || exit 1
failed=0

guard() { # guard <label> <command...>  -- must exit 0
  label=$1; shift
  if out=$("$@" 2>&1); then
    printf '  ok    %s\n' "$label"
  else
    printf '  FAIL  %s\n%s\n' "$label" "$out"; failed=1
  fi
}

suite() { # suite <label> <command...>  -- must exit 0 and report 0 failed
  label=$1; shift
  out=$("$@" 2>&1); code=$?
  result=$(printf '%s\n' "$out" | grep -E '=== [0-9]+ passed, [0-9]+ failed ===' | tail -1)
  if [ "$code" -eq 0 ] && printf '%s' "$result" | grep -q ' 0 failed'; then
    printf '  ok    %-26s %s\n' "$label" "$result"
  else
    printf '  FAIL  %-26s exit %s %s\n' "$label" "$code" "${result:-(no result line -- suite did not run)}"
    printf '%s\n' "$out" | grep -E 'FAIL|Error' | head -15
    failed=1
  fi
}

echo "Security checks (tupple_dev):"
guard "payout guards"          node scripts/check-payout-guards.js
guard "model indexes"          node scripts/check-model-indexes.js
suite "withdrawal security"    node tests/withdrawal-security.test.mjs
suite "privilege verification" node tests/privilege-verification.test.mjs
suite "purchase verification"  node tests/purchase-verification.test.mjs
suite "purchase recovery"      node tests/purchase-recovery.test.mjs
suite "deposit address keys"   node tests/deposit-address-keys.test.mjs
suite "bulk notifications"     node tests/bulk-notifications.test.mjs
suite "mining session start"   node tests/mining-session-start.test.mjs
suite "stuck session pay"      node tests/stuck-session-compensation.test.mjs

# Verifies tokens signed by the auth service's own library, so it needs that
# repo checked out alongside. Missing it is a failure, not a skip -- a gate that
# quietly skips is not a gate. Opt out explicitly with SKIP_CROSS_REPO=1.
AUTH_DIR=${JWT_LIB_DIR:-../bitplay-auth}
if [ -f "$AUTH_DIR/node_modules/jsonwebtoken/package.json" ]; then
  suite "app user auth" env JWT_LIB_DIR="$AUTH_DIR" node tests/app-user-auth.test.mjs
elif [ "$SKIP_CROSS_REPO" = "1" ]; then
  echo "  SKIP  app user auth -- SKIP_CROSS_REPO=1 (cross-repo token check NOT run)"
else
  echo "  FAIL  app user auth -- needs $AUTH_DIR with node_modules (or set SKIP_CROSS_REPO=1 deliberately)"
  failed=1
fi

if [ "$failed" -ne 0 ]; then
  echo ""
  echo "Refusing: fix the failures above. Money, keys or identity may be at risk."
  exit 1
fi
echo "All security checks passed."
