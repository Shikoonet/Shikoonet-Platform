#!/usr/bin/env bash
# The preparation manifest, and the drift it exists to refuse.
#
# Production is released in two dispatches with a person reading evidence in
# between, and that gap is deliberate. It is also where state changes behind
# your back — a variable edited by hand, a candidate that fell over an hour
# later, a domain somebody already repointed. So cutover re-observes everything
# preparation wrote down, and this suite is mostly the disagreements.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WRITE="$ROOT/deploy/write-preparation-manifest.sh"
VERIFY="$ROOT/deploy/verify-preparation-manifest.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

SHA='239083d3c084593c98597459fbfc77811acbe24d'
DIGEST='sha256:5c658170121329e8dbf8d91fa26a3738d8eca54951f8e4438164881a0182ccad'
C_INGEST='ddddddddddddddddddddddd1'
C_DASH='ddddddddddddddddddddddd2'
C_BOT='ddddddddddddddddddddddd3'

mkprep() { # [override=value ...]
  rm -rf "$WORK/prep"
  env MAIN_SHA="$SHA" DIGEST="$DIGEST" STAGING_RUN_ID=9002 \
    CANDIDATE_INGEST="$C_INGEST" CANDIDATE_DASHBOARD="$C_DASH" CANDIDATE_BOT="$C_BOT" \
    BACKUP_ID='backup-2026-08-28T05-00Z' ENV_BACKUP_ID='envbak-2026-08-28' \
    SCHEMA_VERSION=37 TEMP_DOMAIN_VERIFY=pass OLD_APPS_HEALTHY=pass \
    LIVE_INGEST_OWNER='shikoo-ingest' LIVE_DASHBOARD_OWNER='shikoo-dashboard' \
    DB_SYSTEM_IDENTIFIER=7678248300486692898 BOT_ADVISORY_LOCKS=1 \
    GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform' GITHUB_RUN_ID=5150 \
    "$@" bash "$WRITE" "$WORK/prep" >/dev/null 2>&1
}

LOG="$WORK/verify.log"
verify() { # [env overrides...]
  set +e
  env EXPECTED_SHA="$SHA" EXPECTED_DIGEST="$DIGEST" EXPECTED_STAGING_RUN_ID=9002 \
    OBSERVED_SCHEMA_VERSION=37 OBSERVED_CANDIDATE_HEALTH=healthy \
    OBSERVED_LIVE_INGEST_OWNER='shikoo-ingest' OBSERVED_LIVE_DASHBOARD_OWNER='shikoo-dashboard' \
    OBSERVED_AUTO_DEPLOY=off OBSERVED_BOT_LOCKS=1 \
    OBSERVED_TEMP_DOMAIN_VERIFY=pass OBSERVED_BACKUP_PRESENT=present \
    "$@" bash "$VERIFY" "$WORK/prep" >"$LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}
refuses() { # name  substring  [env overrides...]
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

section 'preparation that did not verify leaves no manifest to cut over to'

# The dangerous shape: a red preparation that still writes a manifest a later
# cutover could select as "the latest one".
for spec in 'TEMP_DOMAIN_VERIFY=fail' 'OLD_APPS_HEALTHY=fail'; do
  if mkprep "$spec"; then
    bad "a preparation with ${spec} writes no manifest" 'a manifest was written'
  else
    ok "a preparation with ${spec} writes no manifest"
  fi
done

for spec in 'MAIN_SHA=abc' 'DIGEST=latest' 'SCHEMA_VERSION=many' 'CANDIDATE_BOT=not a uuid'; do
  if mkprep "$spec"; then
    bad "the writer refuses ${spec}" 'it was written'
  else
    ok "the writer refuses ${spec}"
  fi
done

section 'a preparation nothing has disturbed verifies'

mkprep || true
if verify; then ok 'matching expectations and unchanged observations pass'; else
  bad 'matching expectations and unchanged observations pass' "$(tail -2 "$LOG")"
fi

section 'every kind of drift is refused'

rm -rf "$WORK/prep" && mkdir -p "$WORK/prep"
refuses 'a missing preparation blocks the cutover' 'no Prepare Production run behind it'

mkprep || true
printf 'db_schema_version=99\n' >>"$WORK/prep/preparation.env"
refuses 'an edited preparation manifest is refused by its checksum' 'checksum does not verify'

mkprep || true
refuses 'a cutover for a different commit is refused' 'main moved, or the wrong preparation run' \
  EXPECTED_SHA='1f017d4f8b725592a2f4cf87b0af682d6dbf4f31'

mkprep || true
refuses 'a cutover for a different digest is refused' 'this cutover would deploy' \
  EXPECTED_DIGEST='sha256:21d9567f47c144a683f2e64bcce17133bd73ccf3cbc75755af02878ec1265da8'

# Somebody migrated outside the pipeline between the two dispatches.
mkprep || true
refuses 'a schema that moved since preparation is refused' 'migrated outside this pipeline' \
  OBSERVED_SCHEMA_VERSION=38

mkprep || true
refuses 'an unhealthy candidate is refused' 'cutting over to an unhealthy candidate' \
  OBSERVED_CANDIDATE_HEALTH=unhealthy

# The one that is easy to omit and matters most.
mkprep || true
refuses 'a live ingest domain somebody already moved is refused' 'somebody already moved it' \
  OBSERVED_LIVE_INGEST_OWNER='shikoo-ingest-candidate'

mkprep || true
refuses 'a live dashboard domain somebody already moved is refused' 'somebody already moved it' \
  OBSERVED_LIVE_DASHBOARD_OWNER='shikoo-dashboard-candidate'

mkprep || true
refuses 'native Auto Deploy switched back on is refused' 'a push could deploy behind this cutover' \
  OBSERVED_AUTO_DEPLOY=on

# The handover starts from exactly one poller or not at all.
mkprep || true
refuses 'two production pollers before the handover is refused' 'expected exactly 1' \
  OBSERVED_BOT_LOCKS=2

mkprep || true
refuses 'zero production pollers before the handover is refused' 'expected exactly 1' \
  OBSERVED_BOT_LOCKS=0

mkprep || true
refuses 'candidates that no longer answer on their temporary domains are refused' \
  'do not verify today' OBSERVED_TEMP_DOMAIN_VERIFY=fail

mkprep || true
refuses 'a vanished pre-cutover backup is refused' 'the only recovery path' \
  OBSERVED_BACKUP_PRESENT=missing

section 'an observation that was never gathered is not a passing one'

for missing in OBSERVED_SCHEMA_VERSION OBSERVED_CANDIDATE_HEALTH OBSERVED_LIVE_INGEST_OWNER \
  OBSERVED_LIVE_DASHBOARD_OWNER OBSERVED_AUTO_DEPLOY OBSERVED_BOT_LOCKS \
  OBSERVED_TEMP_DOMAIN_VERIFY OBSERVED_BACKUP_PRESENT; do
  mkprep || true
  refuses "an unset ${missing} is refused, not skipped" 'an absent observation is not a passing one' \
    "${missing}="
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
