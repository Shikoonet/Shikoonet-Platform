#!/usr/bin/env bash
# The D1 contract must match the migrator, or CI fails.
#
# The rehearsal validates a production D1 export before trusting it, and
# "validate" means the COMPLETE set is present. The first version named four
# tables out of twenty-three, so nineteen could have been missing and the check
# would still have passed — and it was overridable through an environment
# variable, which made it caller-controlled as well as wrong.
#
# The manifest is generated from the migrator's own source. This test
# regenerates and compares, so adding a table to `D1_TABLES` without updating
# the manifest is a red build rather than a quietly widened acceptance.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
MANIFEST="$ROOT/deploy/d1-tables.manifest"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

section 'the manifest is what the migrator actually reads'

python3 "$ROOT/tools/d1-contract.py" >"$WORK/derived.txt" 2>"$WORK/err.txt" || {
  bad 'the extractor runs' "$(cat "$WORK/err.txt")"
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"; exit 1
}
ok 'the extractor runs'

if diff -u "$MANIFEST" "$WORK/derived.txt" >"$WORK/diff.txt" 2>&1; then
  ok "the committed manifest matches the migrator ($(grep -c . "$MANIFEST") tables)"
else
  bad 'the committed manifest matches the migrator' "$(head -12 "$WORK/diff.txt")"
fi

n=$(grep -c . "$MANIFEST" || true)
if [ "$n" -ge 20 ]; then
  ok "the contract names ${n} tables, not an abbreviated handful"
else
  bad 'the contract names the full set' "only ${n} tables"
fi

# The tables the first version listed were a strict subset. Naming them here
# keeps that regression visible.
for t in access_users devices device_credentials settings; do
  if [ "$t" = settings ]; then
    if grep -qx "$t" "$MANIFEST"; then
      bad "the contract does not invent tables the migrator never reads" "'${t}' is listed"
    else
      ok "the contract does not invent tables the migrator never reads (${t})"
    fi
  else
    if grep -qx "$t" "$MANIFEST"; then ok "the contract includes ${t}"; else bad "the contract includes ${t}" 'absent'; fi
  fi
done

# Column names must never leak in as tables.
for c in id created_at updated_at email; do
  if grep -qx "$c" "$MANIFEST"; then
    bad "the extractor does not mistake the column '${c}' for a table" 'it is listed'
  else
    ok "the extractor does not mistake the column '${c}' for a table"
  fi
done

section 'drift is detected'

# Simulate a migrator that gained a table without the manifest being updated.
cp "$MANIFEST" "$WORK/saved"
printf 'a_new_table\n' >>"$WORK/derived.txt"
if diff -q "$MANIFEST" "$WORK/derived.txt" >/dev/null 2>&1; then
  bad 'an added table is detected as drift' 'the comparison did not notice'
else
  ok 'an added table is detected as drift'
fi
grep -v '^access_users$' "$WORK/saved" >"$WORK/short.txt"
if diff -q "$WORK/short.txt" "$WORK/saved" >/dev/null 2>&1; then
  bad 'a removed table is detected as drift' 'the comparison did not notice'
else
  ok 'a removed table is detected as drift'
fi

section 'the set is not caller-controlled'

R="$ROOT/deploy/production-dump-rehearsal.sh"
if grep -v '^[[:space:]]*#' "$R" | grep -qE 'D1_TABLES=\$\{D1_TABLES'; then
  bad 'the table set cannot be overridden by the environment' 'an override is present'
else
  ok 'the table set cannot be overridden by the environment'
fi
if grep -q 'd1-tables.manifest' "$R"; then
  ok 'the rehearsal reads the committed manifest'
else
  bad 'the rehearsal reads the committed manifest' 'it does not'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
