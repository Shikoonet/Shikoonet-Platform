#!/usr/bin/env bash
# Whether a production-dump rehearsal permits this promotion.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHERE THIS RUNS, AND WHY THAT IS THE WHOLE DESIGN
#
# In `promote-gate`, which carries no `environment:` and therefore holds no
# DEPLOY_* secret. Everything this refuses is refused before a credential is in
# scope, before a migration, before a Coolify write and before a ledger line.
#
# An attestation that is merely *generated* is a document. What makes it a
# control is that a promotion cannot proceed without one that verifies, and that
# the check happens where failing costs nothing.
#
# ── Missing, malformed, stale and mismatched are four different failures ────
#
# Each gets its own sentence, because they send the reader to four different
# places: no rehearsal was run / the file was damaged or edited / the rehearsal
# was for an older release / the rehearsal was for a different release. A single
# «attestation invalid» would make the most common one — stale — look like
# tampering.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: verify-dump-attestation.sh <artifact-dir>
# Required: EXPECTED_SHA EXPECTED_DIGEST
# Optional: EXPECTED_REPO, EXPECTED_CI_RUN_ID, EXPECTED_STAGING_RUN_ID,
#           MAX_AGE_DAYS (default 14), NOT_BEFORE (ISO-8601)

set -Eeuo pipefail

DIR=${1:?usage: verify-dump-attestation.sh <artifact-dir>}

fail() {
  echo "::error::$*"
  exit 1
}

# Resolved through the pointer, never by naming a version directory. The flat
# `attestation.env`/`attestation.sha256` pair this used to read was a second
# copy that could disagree with `current`; it no longer exists.
HERE_V=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
# shellcheck source=deploy/attestation-store.sh
. "$HERE_V/attestation-store.sh"
if [ -L "$DIR/current" ] || [ -e "$DIR/current" ]; then
  DIR=$(att_read "$DIR") || fail "the current attestation could not be resolved or is not intact"
fi

[ -r "$DIR/attestation.env" ] ||
  fail "no attestation.env — no production-dump rehearsal has been recorded for this release. Run the rehearsal on the secure host first; promotion does not proceed without one."
[ -r "$DIR/attestation.sha256" ] ||
  fail "no attestation.sha256 — the attestation carries no checksum, so nothing can say it is intact"

# The checksum first, before a single field is read.
( cd "$DIR" && sha256sum -c --status attestation.sha256 ) ||
  fail "attestation checksum does not verify — the file was altered after the rehearsal wrote it"

field() { sed -n "s/^$1=//p" "$DIR/attestation.env" | head -1; }

SCHEMA=$(field schema_version)
[ "$SCHEMA" = '1' ] || fail "unsupported attestation schema_version '${SCHEMA:-none}'"

: "${EXPECTED_SHA:?EXPECTED_SHA is not set — refusing to verify an attestation against nothing}"
: "${EXPECTED_DIGEST:?EXPECTED_DIGEST is not set — refusing to verify an attestation against nothing}"

SHA=$(field main_sha)
DIGEST=$(field digest)
IMAGE_REF=$(field image_ref)

[[ $SHA =~ ^[0-9a-f]{40}$ ]] || fail "attestation main_sha is not a 40-character commit sha"
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || fail "attestation digest is not an immutable sha256 reference"
[[ $IMAGE_REF =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] || fail "attestation image_ref is not an immutable digest reference"
[ "${IMAGE_REF##*@}" = "$DIGEST" ] || fail "attestation image_ref and digest disagree with each other"

# The two that make this an attestation OF SOMETHING rather than a document.
[ "$SHA" = "$EXPECTED_SHA" ] ||
  fail "the rehearsal was run for commit ${SHA:0:12}, but this promotion is for ${EXPECTED_SHA:0:12} — a rehearsal of a different release proves nothing about this one"
[ "$DIGEST" = "$EXPECTED_DIGEST" ] ||
  fail "the rehearsal was run against digest ${DIGEST:0:19}…, but this promotion deploys ${EXPECTED_DIGEST:0:19}… — the image that was rehearsed is not the image that would ship"

if [ -n "${EXPECTED_REPO:-}" ]; then
  REPO=$(field repository)
  [ "$REPO" = "$EXPECTED_REPO" ] || fail "attestation is from repository '${REPO}', not '${EXPECTED_REPO}'"
fi

# Cross-checked against the release manifest's own view of the same two runs,
# so a rehearsal cannot claim a CI run or a staging run that did not produce
# this digest.
if [ -n "${EXPECTED_CI_RUN_ID:-}" ]; then
  [ "$(field ci_run_id)" = "$EXPECTED_CI_RUN_ID" ] ||
    fail "attestation names CI run $(field ci_run_id), the release manifest names ${EXPECTED_CI_RUN_ID}"
fi
if [ -n "${EXPECTED_STAGING_RUN_ID:-}" ]; then
  [ "$(field staging_run_id)" = "$EXPECTED_STAGING_RUN_ID" ] ||
    fail "attestation names Deploy Staging run $(field staging_run_id), the release manifest names ${EXPECTED_STAGING_RUN_ID}"
fi

# The findings. Each is compared as a whole string against the only value that
# permits a promotion — «49/48» and «passed» are failures, not near-misses.
SUITES=$(field dump_suites)
[ "$SUITES" = '49/49' ] ||
  fail "the rehearsal reports dump_suites=${SUITES:-none} — every production-dump suite has to run on the secure host, and all of them have to pass"

INV=$(field invariants)
[ "$INV" = '32/32' ] ||
  fail "the rehearsal reports invariants=${INV:-none} — all thirty-two have to pass on the migrated schema"

TOTALS=$(field financial_totals)
[ "$TOTALS" = 'match' ] ||
  fail "the rehearsal reports financial_totals=${TOTALS:-none} — the migration changed a financial total, which is a stop, not a warning"

RESTORE=$(field restore_result)
[ "$RESTORE" = 'pass' ] ||
  fail "the rehearsal reports restore_result=${RESTORE:-none} — an unproven restore means the rollback plan has no floor under it"

COMPAT=$(field old_app_schema_compat)
[ "$COMPAT" = 'pass' ] ||
  fail "the rehearsal reports old_app_schema_compat=${COMPAT:-none} — if the current production image cannot serve the migrated schema then image rollback is void and only a restore can recover this release"

# The two subjects, enforced separately.
#
# `invariants=32/32` alone was satisfiable by a run that measured the legacy
# import twice and never migrated the production restore at all — the very
# thing this rehearsal exists to prove. Each subject now carries its own
# verdict and every one is required, so half a rehearsal cannot be promoted on.
LEGACY=$(field legacy_import)
[ "$LEGACY" = 'pass' ] ||
  fail "the rehearsal reports legacy_import=${LEGACY:-none} — the MySQL+D1 import half did not pass"
PRESTORE=$(field prod_restore_migrated)
[ "$PRESTORE" = 'pass' ] ||
  fail "the rehearsal reports prod_restore_migrated=${PRESTORE:-none} — the restored production copy was never brought forward over the pending range, so nothing here describes what promotion will do to production"
PINV=$(field prod_invariants)
[ "$PINV" = '32/32' ] ||
  fail "the rehearsal reports prod_invariants=${PINV:-none} — the thirty-two have to hold on the MIGRATED PRODUCTION RESTORE, not only on the freshly built legacy destination"
PRANGE=$(field prod_migration_range)
[[ $PRANGE =~ ^[0-9]{4}\.\.[0-9]{4}$ ]] ||
  fail "attestation prod_migration_range is not NNNN..NNNN"
[ "$PRANGE" = "$(field migration_range)" ] ||
  fail "the range applied to the production restore (${PRANGE}) is not the range this release migrates ($(field migration_range))"
SUBJ=$(field old_app_schema_subject)
[ "$SUBJ" = 'production-restore' ] ||
  fail "old-image compatibility was measured against '${SUBJ:-none}' — proving the old image works on a database the NEW code just built says nothing about whether it can serve production's own data after migration"

DUMP_ID=$(field dump_id)
[[ $DUMP_ID =~ ^sha256:[0-9a-f]{64}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
  fail "attestation dump_id is not 'sha256:<hex> YYYY-MM-DD' — a dump identified by anything else is a dump this file may be naming a path to"

# Staleness. A rehearsal from before the release it claims to cover is the
# subtle one — the fields all match and the evidence predates the thing it is
# evidence for.
CREATED=$(field created_at)
[[ $CREATED =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] ||
  fail "attestation created_at is not an ISO-8601 UTC timestamp"
created_epoch=$(date -u -d "$CREATED" +%s 2>/dev/null) ||
  fail "attestation created_at '${CREATED}' cannot be read as a date"

if [ -n "${NOT_BEFORE:-}" ]; then
  not_before_epoch=$(date -u -d "$NOT_BEFORE" +%s 2>/dev/null) ||
    fail "NOT_BEFORE '${NOT_BEFORE}' cannot be read as a date"
  [ "$created_epoch" -ge "$not_before_epoch" ] ||
    fail "the rehearsal was recorded at ${CREATED}, BEFORE the staging deployment it claims to cover (${NOT_BEFORE}) — it rehearsed something earlier"
fi

MAX_AGE_DAYS=${MAX_AGE_DAYS:-14}
age_days=$(( ( $(date -u +%s) - created_epoch ) / 86400 ))
[ "$age_days" -le "$MAX_AGE_DAYS" ] ||
  fail "the rehearsal is ${age_days} days old (limit ${MAX_AGE_DAYS}) — the dump it used no longer describes production closely enough to promote on"

echo "[attestation] ${SHA:0:12} @ ${DIGEST:0:19}… — ${SUITES} suites, ${INV} invariants, totals ${TOTALS}, restore ${RESTORE} in $(field restore_seconds)s, old-app compat ${COMPAT}, recorded ${CREATED}"
