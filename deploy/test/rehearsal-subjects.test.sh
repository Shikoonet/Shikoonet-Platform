#!/usr/bin/env bash
# Does the rehearsal actually do BOTH things, to the RIGHT databases?
#
# Reading the script says yes. Reading it said yes when step 11 applied only a
# lower-bounded range, when nothing checked that any migration reached the
# restored copy at all, and when the attestation recorded one `invariants`
# line that could have come from either subject. Grep cannot tell a command
# that names $RESTORE_C from one that reaches it, and it cannot tell a check
# that ran from one that was skipped.
#
# So these tests run the real deploy/production-dump-rehearsal.sh — the whole
# orchestration, top to bottom — against a docker that records which container
# received every operation. The subjects are distinguished by a marker the
# script can observe and the fake maintains honestly: each container's own
# schema_migrations ledger. The restored production copy starts at what
# production has applied; the legacy destination is built from nothing by the
# migrator and ends at the repository's full count. A command sent to the wrong
# one is therefore visible in the log AND detectable by the script.
#
# The guards are checked by breaking the script, one break at a time, and
# requiring a non-zero exit with the right reason — not by asserting that a
# line of source exists.
set -uo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }

# Both are read by build_world and run_rehearsal in rehearsal-world.sh.
# shellcheck disable=SC2034
SHA=$(printf '%040d' 7 | tr '0' 'a')
# shellcheck disable=SC2034
DIGEST="sha256:$(printf '%064d' 3 | tr '0' 'c')"

# shellcheck source=deploy/test/rehearsal-world.sh
. "$HERE/rehearsal-world.sh"
rehearsal_become_root "$0" "$@"

export FAKE_PROD_DB_UUID=qd2vduj7kv05sp9ejdrmclmu
export FAKE_STAGING_DB_UUID=bea6ac92holn5k6vjgopy2ai
export FAKE_UUID_INGEST=d9ulbwkdjpvg2ajalecruxzh
export FAKE_UUID_DASHBOARD=huneuqvzyw0cjd4u0f7s37cf
export FAKE_UUID_BOT=3xetld1oi3x7viq8cr8is0ls

WORKROOT=$(mktemp -d)
trap 'rm -rf "$WORKROOT"' EXIT

# A mutated copy of the real script: the guard is proven by removing it.
mutate() { # name sed-expression -> path to the mutant
  local name=$1 expr=$2
  local out="$WORKROOT/mutant-$name.sh"
  sed "$expr" "$ROOT/deploy/production-dump-rehearsal.sh" >"$out"
  if cmp -s "$out" "$ROOT/deploy/production-dump-rehearsal.sh"; then
    printf '  MUTATION DID NOT APPLY: %s\n' "$name" >&2
    return 1
  fi
  printf '%s' "$out"
}

echo "rehearsal subject separation"

# ── 1. the happy path, and what each subject actually received ───────────
W="$WORKROOT/happy"; build_world "$W"
if run_rehearsal "$W"; then
  ok "the full rehearsal completes"
else
  bad "the full rehearsal completes" "$(tail -5 "$W/out")"
fi

# Anchored to the name's own character set, not "everything up to the next
# pipe". The fake now logs full argv, where a container name is followed by
# more arguments rather than a delimiter, so `[^|]*` swallowed the rest of the
# line and every subsequent grep for that name matched nothing.
RESTORE_C=$(grep -oE 'shikoo-rehearsal-restore-[0-9]+-[0-9]+' "$W/log" | head -1)
DEST_C=$(grep -oE 'shikoo-rehearsal-dest-[0-9]+-[0-9]+' "$W/log" | head -1)

# Both halves ran, against different databases.
if [ -n "$RESTORE_C" ] && [ -n "$DEST_C" ] && [ "$RESTORE_C" != "$DEST_C" ]; then ok "the two subjects are distinct containers"; else bad "the two subjects are distinct containers" "restore=$RESTORE_C dest=$DEST_C"; fi

# Exactly three migrations reached the restored production copy...
n=$(grep -c "^migration|$RESTORE_C|prodrestore|" "$W/log")
if [ "$n" = 3 ]; then ok "the pending range (3) was applied to the production restore"; else bad "the pending range (3) was applied to the production restore" "saw $n"; fi

# ...and the legacy destination was built by the migrator, not by this loop.
n=$(grep -c "^migrator|$DEST_C|" "$W/log")
if [ "$n" = 1 ]; then ok "the legacy destination was built by the real migrator"; else bad "the legacy destination was built by the real migrator" "saw $n"; fi

# Invariants ran against BOTH, separately — one run each, never the same twice.
n=$(grep -c "^invariants|$RESTORE_C|" "$W/log")
if [ "$n" = 1 ]; then ok "invariants ran against the migrated production restore"; else bad "invariants ran against the migrated production restore" "saw $n"; fi
n=$(grep -c "^invariants|$DEST_C|" "$W/log")
if [ "$n" = 1 ]; then ok "invariants ran against the legacy destination"; else bad "invariants ran against the legacy destination" "saw $n"; fi

# Old images were tested against the production restore, never the destination.
n=$(grep -c "^old-image-gate|$RESTORE_C|prodrestore|" "$W/log")
if [ "$n" = 3 ]; then ok "all three old images were tested against the production restore"; else bad "all three old images were tested against the production restore" "saw $n"; fi
n=$(grep -c "^old-image-gate|$DEST_C|" "$W/log")
if [ "$n" = 0 ]; then ok "no old-image check touched the legacy destination"; else bad "no old-image check touched the legacy destination" "saw $n"; fi

# The suites ran against the legacy destination, which is their subject.
if grep -q "^suites|$DEST_C|" "$W/log"; then
  ok "the dump suites ran against the legacy destination"
else
  bad "the dump suites ran against the legacy destination" "$(grep '^suites' "$W/log")"
fi

# ── the attestation records six separate verdicts ────────────────────────
VER=$(readlink -f "$W/state/attestation/current" 2>/dev/null || true)
if [ -n "$VER" ] && [ -f "$VER/attestation.env" ]; then
  ok "an attestation was activated through the pointer"
  for f in legacy_import prod_restore_migrated prod_invariants prod_migration_range \
           old_app_schema_subject dump_suites financial_totals invariants d1_export_id; do
    if grep -q "^${f}=" "$VER/attestation.env"; then ok "attestation records ${f}"; else bad "attestation records ${f}" "absent"; fi
  done
  if [ "$(sed -n 's/^old_app_schema_subject=//p' "$VER/attestation.env")" = 'production-restore' ]; then ok "the old-image subject is recorded as the production restore"; else bad "the old-image subject is recorded as the production restore" ""; fi
  if [ "$(sed -n 's/^prod_invariants=//p' "$VER/attestation.env")" = '32/32' ]; then ok "production-restore invariants are recorded separately"; else bad "production-restore invariants are recorded separately" ""; fi
  # No customer value, no secret, no path.
  if grep -qiE 'ghp_|password|/home/|wallet_balance=[0-9]|1234' "$VER/attestation.env"; then
    bad "the attestation carries no secret, path or customer value" "$(grep -ciE 'ghp_|password|/home/' "$VER/attestation.env") hit(s)"
  else
    ok "the attestation carries no secret, path or customer value"
  fi
else
  bad "an attestation was activated through the pointer" "no current pointer"
fi

if grep -qiE 'ghp_faketoken|POSTGRES_PASSWORD=rehearsal|wallet_balance=1000' "$W/out"; then
  bad "the run output carries no secret or customer value" "$(grep -ciE 'ghp_faketoken' "$W/out") hit(s)"
else
  ok "the run output carries no secret or customer value"
fi

# ── 2. six ways to conflate the subjects, each refused ────────────────────
#
# Each mutation is applied to a copy, and each must produce a non-zero exit
# with a reason naming the right thing. A mutation that does not apply is
# reported and not counted, because a guard "proven" by a no-op edit is not
# proven at all.
refuses() { # label sed-expr reason-regex [extra-env]
  local label=$1 expr=$2 want=$3 m mw rc
  if ! m=$(mutate "$(echo "$label" | tr -c 'a-z0-9' '-')" "$expr"); then
    bad "$label" "the mutation did not apply — not counted as killed"; return
  fi
  mw="$WORKROOT/mut-$RANDOM"; build_world "$mw" "$m"
  run_rehearsal "$mw"; rc=$?
  if [ "$rc" -eq 0 ]; then
    bad "$label" "the rehearsal SUCCEEDED with the guard removed"
  elif grep -qiE "$want" "$mw/out"; then
    # and it must not have left evidence behind
    # `-e` follows the symlink, so a pointer left dangling at a removed version
    # directory read as "no attestation" — a refusal would have looked clean
    # while leaving a broken pointer behind.
    if [ -e "$mw/state/attestation/current" ] || [ -L "$mw/state/attestation/current" ]; then
      bad "$label" "refused, but an attestation was still activated"
    else
      ok "$label"
    fi
  else
    bad "$label" "refused for the wrong reason: $(grep -i 'STOP:' "$mw/out" | head -1)"
  fi
  rm -rf "$mw"
}

# 1. the restored production database is never migrated
# A range that selects nothing: the loop runs, applies nothing, and exits zero.
# This is the failure the old code could not see, because nothing counted.
# shellcheck disable=SC2016
refuses "refuses when the production restore is never migrated" \
  's|^RANGE_LO=\${MIGRATION_RANGE%%\.\.\*}|RANGE_LO=9999|' \
  'never migrated|selected no migrations'

# 2. the full range is applied instead of the derived pending range
# shellcheck disable=SC2016
refuses "refuses when the full range is applied instead of the pending range" \
  's|^RANGE_LO=\${MIGRATION_RANGE%%\.\.\*}|RANGE_LO=0001|' \
  'wrong range was applied|ledger says'

# 3. invariants run against the legacy destination
# shellcheck disable=SC2016
refuses "refuses when production invariants run against the legacy destination" \
  's|^PROD_SUBJECT="\$RESTORE_C"|PROD_SUBJECT="$DEST_C"|' \
  'refusing to migrate the wrong database|this is not that database'

# 4. old-image compatibility runs against the legacy destination
# shellcheck disable=SC2016
refuses "refuses when old-image compatibility runs against the legacy destination" \
  's|^OLD_APP_TARGET="\$PROD_SUBJECT"|OLD_APP_TARGET="$DEST_C"|' \
  'legacy destination, not the production restore'

# 5. the legacy half is skipped while the production half succeeds
# shellcheck disable=SC2016
refuses "refuses when the legacy MySQL+D1 half is skipped" \
  's|^LEGACY_IMPORT=pass|:|' \
  'LEGACY_IMPORT|unbound variable'

# 6. the production-restore half is skipped while the legacy half succeeds
# shellcheck disable=SC2016
refuses "refuses when the production-restore half is skipped" \
  's|^PROD_RESTORE_MIGRATED=pass|:|' \
  'PROD_RESTORE_MIGRATED|unbound variable'

# ── 3. the subject is identified by a marker, not by its name ────────────
#
# Every refusal above can be reached through the name check alone. This one
# cannot: the container keeps its name and its identity, and only its ledger
# betrays that it is not the database step 5 measured. Without the marker the
# run completes and attests to a migration of the wrong data.
MW="$WORKROOT/drift"; build_world "$MW"
FAKE_LEDGER_DRIFT=1 run_rehearsal "$MW"; DRC=$?
if [ "$DRC" -eq 0 ]; then
  bad "refuses when the subject's ledger does not match the restored production copy" "it succeeded"
elif grep -q 'this is not that database' "$MW/out"; then
  if [ -e "$MW/state/attestation/current" ] || [ -L "$MW/state/attestation/current" ]; then
    bad "refuses when the subject's ledger does not match the restored production copy" "an attestation was activated"
  else
    ok "refuses when the subject's ledger does not match the restored production copy"
  fi
else
  bad "refuses when the subject's ledger does not match the restored production copy" \
    "$(grep -i 'STOP:' "$MW/out" | head -1)"
fi

# ── 4. a blocked gate and a broken probe are different answers ───────────
#
# The probe that was here called `m.status(db)` with the D1 adapter and no
# migrations directory, so it threw on every image and the loop wrote
# OLD_APP_SCHEMA_COMPAT=fail. A broken probe read as "the old code cannot serve
# the migrated schema" — the most alarming possible verdict, from a bug.
GW="$WORKROOT/gate-blocked"; build_world "$GW"
FAKE_GATE_RC=1 run_rehearsal "$GW"; GRC=$?
if [ "$GRC" -eq 0 ]; then
  bad "a blocked schema gate stops the rehearsal" "it succeeded"
elif grep -q 'cannot serve the migrated schema' "$GW/out"; then
  ok "a blocked schema gate stops the rehearsal"
else
  bad "a blocked schema gate stops the rehearsal" "$(grep -i 'STOP:' "$GW/out" | head -1)"
fi

# Exit 1 with nothing printed is a rejected `main()` — a connection failure, an
# unreadable schema — not a blocking gate. Recording it as
# old_app_schema_compat=fail would report a broken connection as "the current
# production image cannot serve the migrated schema".
GWS="$WORKROOT/gate-silent"; build_world "$GWS"
FAKE_GATE_RC=1 FAKE_GATE_SILENT=1 run_rehearsal "$GWS"; GSRC=$?
if [ "$GSRC" -eq 0 ]; then
  bad "exit 1 without a BLOCK reason is not a compatibility verdict" "it succeeded"
elif grep -q 'without a BLOCK reason' "$GWS/out"; then
  ok "exit 1 without a BLOCK reason is not a compatibility verdict"
else
  bad "exit 1 without a BLOCK reason is not a compatibility verdict" "$(grep -i 'STOP:' "$GWS/out" | head -1)"
fi
rm -rf "$GWS"

GW2="$WORKROOT/gate-broken"; build_world "$GW2"
FAKE_GATE_RC=127 run_rehearsal "$GW2"; GRC2=$?
if [ "$GRC2" -eq 0 ]; then
  bad "a probe that cannot run is not reported as incompatibility" "it succeeded"
elif grep -q 'broken probe, not a compatibility result' "$GW2/out"; then
  ok "a probe that cannot run is not reported as incompatibility"
else
  bad "a probe that cannot run is not reported as incompatibility" "$(grep -i 'STOP:' "$GW2/out" | head -1)"
fi
# Neither leaves evidence behind.
for d in "$GW" "$GW2"; do
  if [ -e "$d/state/attestation/current" ] || [ -L "$d/state/attestation/current" ]; then
    bad "a gate refusal activates no attestation" "one was activated"
  else
    ok "a gate refusal activates no attestation"
  fi
done
rm -rf "$GW" "$GW2"

echo
printf 'subjects: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
