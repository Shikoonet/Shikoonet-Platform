#!/usr/bin/env bash
# The production-dump attestation, as a control rather than a document.
#
# An attestation that is merely generated proves nothing: the question is
# whether a promotion can proceed WITHOUT one that verifies. So most of this
# suite is refusals, and each refusal is checked by its own message — missing,
# malformed, stale and mismatched send a reader to four different places, and
# one shared «invalid» would make the common case look like tampering.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WRITE="$ROOT/deploy/write-dump-attestation.sh"
VERIFY="$ROOT/deploy/verify-dump-attestation.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

SHA='239083d3c084593c98597459fbfc77811acbe24d'
OTHER_SHA='1f017d4f8b725592a2f4cf87b0af682d6dbf4f31'
DIGEST='sha256:5c658170121329e8dbf8d91fa26a3738d8eca54951f8e4438164881a0182ccad'
OTHER_DIGEST='sha256:21d9567f47c144a683f2e64bcce17133bd73ccf3cbc75755af02878ec1265da8'
DUMP_ID="sha256:$(printf 'a%.0s' $(seq 64)) 2026-08-28"

mkatt() { # [override=value ...] -> writes $WORK/att
  rm -rf "$WORK/att"
  env MAIN_SHA="$SHA" DIGEST="$DIGEST" CI_RUN_ID=9001 STAGING_RUN_ID=9002 \
    DUMP_ID="$DUMP_ID" MIGRATION_RANGE='0035..0037' DUMP_SUITES='49/49' \
    INVARIANTS='32/32' FINANCIAL_TOTALS=match RESTORE_RESULT=pass \
    RESTORE_SECONDS=412 OLD_APP_SCHEMA_COMPAT=pass \
    LEGACY_IMPORT=pass PROD_RESTORE_MIGRATED=pass PROD_INVARIANTS='32/32' \
    PROD_MIGRATION_RANGE='0035..0037' OLD_APP_SCHEMA_SUBJECT=production-restore \
    D1_EXPORT_ID="sha256:$(printf 'b%.0s' $(seq 64))" \
    GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform' \
    "$@" bash "$WRITE" "$WORK/att" >/dev/null 2>&1
}

LOG="$WORK/verify.log"
verify() { # [env assignments...] -> rc, output in $LOG
  set +e
  env EXPECTED_SHA="$SHA" EXPECTED_DIGEST="$DIGEST" "$@" \
    bash "$VERIFY" "$WORK/att" >"$LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}
refuses() { # name  substring  [env assignments...]
  local name=$1 want=$2
  shift 2
  if verify "$@"; then
    bad "$name" 'it verified when it had to refuse'
    return
  fi
  if grep -qF -- "$want" "$LOG"; then ok "$name"; else
    bad "$name" "refused, but not for '$want': $(tail -2 "$LOG" | tr '\n' ' ')"
  fi
}

section 'the attestation writer refuses to record a rehearsal that did not pass'

for spec in 'DUMP_SUITES=48/49' 'DUMP_SUITES=49/50' 'DUMP_SUITES=passed' \
  'INVARIANTS=31/32' 'FINANCIAL_TOTALS=mismatched' 'RESTORE_RESULT=passed' \
  'OLD_APP_SCHEMA_COMPAT=yes' 'MIGRATION_RANGE=0035-0037' 'RESTORE_SECONDS=a lot' \
  'LEGACY_IMPORT=skipped' 'PROD_RESTORE_MIGRATED=skipped' 'PROD_INVARIANTS=31/32' \
  'PROD_MIGRATION_RANGE=0035-0037' 'OLD_APP_SCHEMA_SUBJECT=legacy-destination' \
  'D1_EXPORT_ID=unknown'; do
  if mkatt "$spec"; then
    bad "the writer refuses ${spec}" 'it was written'
  else
    ok "the writer refuses ${spec}"
  fi
done

# A dump id that is a path is a dump id that names a file on a secure host, in
# a document whose entire purpose is to leave that host.
for spec in 'DUMP_ID=/srv/dumps/mirzabot-prod-20260811.sql' 'DUMP_ID=mirzabot-prod.sql' 'DUMP_ID=sha256:abc 2026-08-28'; do
  if mkatt "$spec"; then
    bad "the writer refuses a dump id of the form '${spec#DUMP_ID=}'" 'it was written'
  else
    ok "the writer refuses a dump id of the form '${spec#DUMP_ID=}'"
  fi
done

section 'a complete rehearsal verifies'

mkatt || true
if verify; then ok 'a matching, complete, fresh attestation is accepted'; else
  bad 'a matching, complete, fresh attestation is accepted' "$(tail -2 "$LOG")"
fi

# The dump itself must never travel. Only a hash and a date.
if grep -qE '\.sql|/srv|/var|pg_dump|password' "$WORK/att/attestation.env"; then
  bad 'the attestation carries no path to the dump' 'it names a file or a credential'
else
  ok 'the attestation carries no path to the dump'
fi

section 'missing, malformed, mismatched and stale are four different refusals'

rm -rf "$WORK/att" && mkdir -p "$WORK/att"
refuses 'a missing attestation blocks the promotion' 'no production-dump rehearsal has been recorded'

mkatt || true
rm -f "$WORK/att/attestation.sha256"
refuses 'an attestation with no checksum is refused' 'carries no checksum'

mkatt || true
printf 'invariants=0/32\n' >>"$WORK/att/attestation.env"
refuses 'an edited attestation is refused by its checksum, before any field is read' \
  'checksum does not verify'

mkatt || true
refuses 'a rehearsal for another commit is refused' 'a rehearsal of a different release' \
  EXPECTED_SHA="$OTHER_SHA"

mkatt || true
refuses 'a rehearsal against another digest is refused' 'is not the image that would ship' \
  EXPECTED_DIGEST="$OTHER_DIGEST"

mkatt || true
refuses 'a rehearsal naming a different CI run is refused' 'the release manifest names' \
  EXPECTED_CI_RUN_ID=1234

mkatt || true
refuses 'a rehearsal naming a different staging run is refused' 'the release manifest names' \
  EXPECTED_STAGING_RUN_ID=1234

mkatt || true
refuses 'a rehearsal from another repository is refused' 'not ' \
  EXPECTED_REPO='someone/else'

# The subtle one: every field matches and the evidence predates the thing it is
# evidence for.
mkatt || true
refuses 'a rehearsal recorded BEFORE the staging deployment it covers is refused' \
  'it rehearsed something earlier' \
  NOT_BEFORE="$(date -u -d '+1 day' +%Y-%m-%dT%H:%M:%SZ)"

mkatt || true
refuses 'a rehearsal older than the age limit is refused' 'no longer describes production' \
  MAX_AGE_DAYS=-1

section 'the verifier refuses to check an attestation against nothing'

mkatt || true
set +e
env EXPECTED_DIGEST="$DIGEST" bash "$VERIFY" "$WORK/att" >"$LOG" 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  bad 'an unset EXPECTED_SHA is refused, not skipped' 'it verified'
else
  ok 'an unset EXPECTED_SHA is refused, not skipped'
fi

set +e
env EXPECTED_SHA="$SHA" bash "$VERIFY" "$WORK/att" >"$LOG" 2>&1
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  bad 'an unset EXPECTED_DIGEST is refused, not skipped' 'it verified'
else
  ok 'an unset EXPECTED_DIGEST is refused, not skipped'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
