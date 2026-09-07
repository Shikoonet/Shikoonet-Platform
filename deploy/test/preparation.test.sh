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

if mkprep "CANDIDATE_BOT=$C_INGEST"; then
  bad 'the writer refuses one application reused for two candidate roles' 'it wrote an ambiguous manifest'
else
  ok 'the writer refuses one application reused for two candidate roles'
fi

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
printf 'candidate_bot=ccccccccccccccccccccccc3\n' >>"$WORK/prep/preparation.env"
( cd "$WORK/prep" && sha256sum preparation.env >preparation.sha256 )
refuses 'a checksum-valid manifest with a duplicate key is refused' 'contains a duplicate key'

mkprep || true
sed -i "s/^candidate_dashboard=.*/candidate_dashboard=$C_INGEST/" "$WORK/prep/preparation.env"
( cd "$WORK/prep" && sha256sum preparation.env >preparation.sha256 )
refuses 'a checksum-valid manifest that reuses a candidate is refused' 'three distinct candidate applications'

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

# ── the temporary-domain guard, which has been wrong twice ───────────────
#
# P5b writes a domain onto a candidate, and the only thing standing between it
# and a LIVE customer hostname is `host_of`. That guard shipped broken twice —
# first comparing whole URL strings, so `https://sms.chopon.uk:443` passed it;
# then stripping the port but not the fragment, so `…#candidate` passed it.
# Both times Coolify normalised what the guard had not, and both times nothing
# in this repository would have noticed: no test executes prepare-production.sh.
#
# The function is lifted out of the real script rather than restated here — a
# copy of the parser in the test would be a test of the copy.
section 'the temporary-domain guard refuses every spelling of a live hostname'
PREPARE="$ROOT/deploy/prepare-production.sh"
eval "$(sed -n '/^host_of() {/,/^}/p' "$PREPARE")"
if ! declare -F host_of >/dev/null; then
  bad 'host_of could be lifted out of prepare-production.sh' 'the function was not found — did it move or get renamed?'
else
  ok 'host_of could be lifted out of prepare-production.sh'
  LIVE='sms.chopon.uk'
  for u in \
    "https://${LIVE}" \
    "https://${LIVE}:443" \
    "https://${LIVE}#candidate" \
    "https://${LIVE}#" \
    "https://${LIVE}/" \
    "https://${LIVE}/api/v1/sms" \
    "https://${LIVE}?x=1" \
    "https://u:p@${LIVE}" \
    "https://u@${LIVE}:8443#z" \
    "https://SMS.Chopon.UK" \
    "http://${LIVE}:80/a?b#c"; do
    got=$(host_of "$u")
    if [ "$got" = "$LIVE" ]; then
      ok "a live hostname is seen through '${u}'"
    else
      bad "a live hostname is seen through '${u}'" "host_of returned '${got}', so the guard would have let this reach Coolify"
    fi
  done
  # And the names preparation is actually for must NOT collide with them.
  for u in 'https://sms-next.chopon.uk' 'https://shikoo-next.chopon.uk'; do
    got=$(host_of "$u")
    want=${u#https://}
    if [ "$got" = "$want" ]; then
      ok "the temporary name '${want}' is left alone"
    else
      bad "the temporary name '${want}' is left alone" "host_of returned '${got}'"
    fi
  done
fi

# ── the retired gate stays retired, unless somebody means it ─────────────
#
# P0 — the dump-rehearsal attestation — was removed from prepare on 2026-09-07
# together with the legacy-import release path, by owner decision. This check
# exists so the gate cannot drift back in half-remembered: whoever restores it
# is making a policy decision and updates this assertion in the same commit,
# which is exactly the visibility the original removal got.
section 'the retired dump-attestation gate does not quietly return'
# Comment lines are excluded deliberately — the script's own retirement note
# names the verifier on purpose, so the next reader knows where the gate went.
# What must not come back is an INVOCATION.
if grep -v '^[[:space:]]*#' "$ROOT/deploy/prepare-production.sh" | grep -q 'verify-dump-attestation'; then
  bad 'prepare does not invoke the dump-attestation verifier' \
    'it does — if the legacy-import path is back, update this test in the same commit as the decision'
else
  ok 'prepare does not invoke the dump-attestation verifier'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
