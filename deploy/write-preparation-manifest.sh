#!/usr/bin/env bash
# What Prepare Production actually did, so Cutover Production can refuse drift.
#
# ─────────────────────────────────────────────────────────────────────────────
# The two halves of a production release are separated by a person reading
# evidence, and that gap is the whole design: preparation happens while the old
# applications are still serving every customer, and nothing moves until
# somebody looks and presses the second button.
#
# A gap is also where state changes behind your back. Between the two runs
# somebody can edit a Coolify variable, a candidate can fall over, a migration
# can be applied by hand, `main` can move, native Auto Deploy can be switched
# on. So preparation writes down exactly what it observed and exactly what it
# created, and cutover re-reads all of it and refuses if a single field moved.
#
# `live_*_owner` is the field that is easy to leave out and is the most
# important one: it records WHICH application currently answers on the customer
# domains. Cutover is the step that changes those, and it must be able to prove
# it is moving them away from what preparation saw — not from something a hand
# already moved.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: write-preparation-manifest.sh <out-dir>

set -Eeuo pipefail

OUT_DIR=${1:?usage: write-preparation-manifest.sh <out-dir>}
mkdir -p "$OUT_DIR"

: "${MAIN_SHA:?MAIN_SHA is required}"
: "${DIGEST:?DIGEST is required}"
: "${STAGING_RUN_ID:?STAGING_RUN_ID is required}"
: "${CANDIDATE_INGEST:?CANDIDATE_INGEST is required — the candidate application uuid}"
: "${CANDIDATE_DASHBOARD:?CANDIDATE_DASHBOARD is required}"
: "${CANDIDATE_BOT:?CANDIDATE_BOT is required}"
: "${BACKUP_ID:?BACKUP_ID is required — the database backup taken before the migration}"
: "${ENV_BACKUP_ID:?ENV_BACKUP_ID is required — the Coolify environment recovery point}"
: "${SCHEMA_VERSION:?SCHEMA_VERSION is required — the migration count after P6}"
: "${TEMP_DOMAIN_VERIFY:?TEMP_DOMAIN_VERIFY is required: pass or fail}"
: "${OLD_APPS_HEALTHY:?OLD_APPS_HEALTHY is required: pass or fail}"
: "${LIVE_INGEST_OWNER:?LIVE_INGEST_OWNER is required — which application answers on the live ingest domain}"
: "${LIVE_DASHBOARD_OWNER:?LIVE_DASHBOARD_OWNER is required}"

refuse() {
  echo "refusing: $*" >&2
  exit 1
}

[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] || refuse "MAIN_SHA is not a 40-character commit sha"
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "DIGEST is not sha256: plus 64 lowercase hex"
[[ $STAGING_RUN_ID =~ ^[0-9]{1,20}$ ]] || refuse "STAGING_RUN_ID is not a run id"
[[ $SCHEMA_VERSION =~ ^[0-9]{1,4}$ ]] || refuse "SCHEMA_VERSION is not a migration count"
for u in "$CANDIDATE_INGEST" "$CANDIDATE_DASHBOARD" "$CANDIDATE_BOT"; do
  [[ $u =~ ^[a-z0-9]{20,32}$ ]] || refuse "'$u' is not a Coolify application uuid"
done
case "$TEMP_DOMAIN_VERIFY" in pass | fail) ;; *) refuse "TEMP_DOMAIN_VERIFY must be pass or fail" ;; esac
case "$OLD_APPS_HEALTHY" in pass | fail) ;; *) refuse "OLD_APPS_HEALTHY must be pass or fail" ;; esac

# Preparation that did not verify is preparation that must not be cut over to.
# Recorded as a failure AND refused here, so a red preparation cannot leave a
# manifest behind that a later cutover might pick up as the latest one.
[ "$TEMP_DOMAIN_VERIFY" = 'pass' ] ||
  refuse "the temporary-domain verification failed — refusing to write a manifest cutover could select"
[ "$OLD_APPS_HEALTHY" = 'pass' ] ||
  refuse "the old production applications are not healthy on the migrated schema — refusing to write a manifest cutover could select"

IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}

{
  printf 'schema_version=1\n'
  printf 'repository=%s\n' "${GITHUB_REPOSITORY:-Shikoonet/Shikoonet-Platform}"
  printf 'main_sha=%s\n' "$MAIN_SHA"
  printf 'digest=%s\n' "$DIGEST"
  printf 'image_ref=%s@%s\n' "$IMAGE_NAME" "$DIGEST"
  printf 'staging_run_id=%s\n' "$STAGING_RUN_ID"
  printf 'prepare_run_id=%s\n' "${GITHUB_RUN_ID:-unknown}"
  printf 'candidate_ingest=%s\n' "$CANDIDATE_INGEST"
  printf 'candidate_dashboard=%s\n' "$CANDIDATE_DASHBOARD"
  printf 'candidate_bot=%s\n' "$CANDIDATE_BOT"
  printf 'backup_id=%s\n' "$BACKUP_ID"
  printf 'env_backup_id=%s\n' "$ENV_BACKUP_ID"
  printf 'db_schema_version=%s\n' "$SCHEMA_VERSION"
  printf 'db_system_identifier=%s\n' "${DB_SYSTEM_IDENTIFIER:-unrecorded}"
  printf 'temp_domain_verify=%s\n' "$TEMP_DOMAIN_VERIFY"
  printf 'old_apps_healthy=%s\n' "$OLD_APPS_HEALTHY"
  printf 'live_ingest_owner=%s\n' "$LIVE_INGEST_OWNER"
  printf 'live_dashboard_owner=%s\n' "$LIVE_DASHBOARD_OWNER"
  printf 'bot_advisory_locks=%s\n' "${BOT_ADVISORY_LOCKS:-unrecorded}"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT_DIR/preparation.env"

( cd "$OUT_DIR" && sha256sum preparation.env >preparation.sha256 )

echo "[prepare] wrote ${OUT_DIR}/preparation.env for ${MAIN_SHA:0:12} @ ${DIGEST:0:19}…"
