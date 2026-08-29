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
# One command, not the tail of a pipeline: under `pipefail` the status of
# `grep -v ... | grep -q ...` is non-zero whenever EITHER stage fails, so a
# first stage that matched nothing would report "no override present" for the
# wrong reason.
if grep -E '^[^#]*D1_TABLES=\$\{D1_TABLES' "$R" >/dev/null; then
  bad 'the table set cannot be overridden by the environment' 'an override is present'
else
  ok 'the table set cannot be overridden by the environment'
fi
if grep -q 'd1-tables.manifest' "$R"; then
  ok 'the rehearsal reads the committed manifest'
else
  bad 'the rehearsal reads the committed manifest' 'it does not'
fi

# The generator pins this manifest by digest so it cannot be handed some other
# table list. That pin and the tracked file have to stay in step, and the only
# way to guarantee it is to fail the build when they drift.
PIN=$(sed -n 's/^TABLES_MANIFEST_SHA256 = "\(.*\)"/\1/p' "$ROOT/tools/d1-export-manifest.py")
ACTUAL=$(sha256sum "$ROOT/deploy/d1-tables.manifest" | cut -d' ' -f1)
if [ "$PIN" = "$ACTUAL" ]; then
  ok 'the sidecar generator pins this exact table manifest'
else
  bad 'the sidecar generator pins this exact table manifest' "pin ${PIN:0:12} vs file ${ACTUAL:0:12}"
fi

# A floor. The regeneration test compares the generated list against the
# committed manifest, so a pattern change that silently drops tables would be
# caught only if someone regenerated the manifest — at which point both sides
# agree on a shorter list. The count is asserted independently.
N=$(python3 "$ROOT/tools/d1-contract.py" | grep -c .)
if [ "$N" -ge 26 ]; then
  ok "the generator derives at least 26 tables (${N})"
else
  bad "the generator derives at least 26 tables" "only ${N} — a pattern change may be dropping tables silently"
fi
# And a name with a digit in it must survive extraction.
if python3 - "$ROOT" <<'PY'
import re, sys
src = open(sys.argv[1] + "/tools/d1-contract.py").read()
pats = re.findall(r"'\(\[[a-z0-9_\-]*\]\+\)'", src)
sys.exit(0 if all("0-9" in p for p in pats) else 1)
PY
then
  ok 'every table-name pattern admits digits'
else
  bad 'every table-name pattern admits digits' 'a pattern would drop raw_sms_events_v2'
fi

# The three tables `migrateHub` reads through explicit `copyD1` calls outside
# `D1_TABLES`. The bracket-depth walk cannot see them — they are arguments, not
# array entries — and omitting them made the contract 23 where the migrator
# reads 26. A complete export would then have been refused as holding
# unexpected files.
for t in dashboard_notification_state dashboard_transaction_reads dashboard_payment_event_reads; do
  if grep -qxF "$t" "$ROOT/deploy/d1-tables.manifest"; then
    ok "the contract covers ${t}"
  else
    bad "the contract covers ${t}" 'the migrator reads it and the contract does not name it'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
