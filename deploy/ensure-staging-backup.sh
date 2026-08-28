#!/usr/bin/env bash
# Staging has no scheduled backup. This is the smallest correct one.
#
# ─────────────────────────────────────────────────────────────────────────────
# Production has had a daily backup since 2026-08-16; staging has never had one.
# That gap only matters once staging holds something worth losing — which is
# exactly what the next steps do to it: the first real operator, and the first
# bot identity.
#
# So this runs BEFORE the operator is created, and the restore drill runs after
# it, because a backup nobody has restored is a belief rather than a backup.
#
# ── The payload is the documented one, read from the running Coolify ──────
#
# `POST /api/v1/databases/{uuid}/backups`, whose validator accepts exactly:
# frequency (required, must parse as cron), enabled, save_s3, dump_all,
# backup_now, s3_storage_uuid, the six retention fields, and timeout. Nothing
# here is guessed; anything not in that list is not sent.
#
# ── The two decisions, and why these defaults ────────────────────────────
#
#   frequency `30 3 * * *` — thirty minutes after production's 03:00 run, so
#       the two never contend for the same disk and CPU, and so a bad night is
#       attributable to one of them rather than to "the backups".
#   retention 7 locally, no S3 — staging holds no customer money and no S3
#       target is configured. Seven days spans a week's work, which is the
#       window in which anybody would notice they needed it.
#   backup_now true — otherwise the first dump does not exist until 03:30 and
#       the restore drill has nothing to prove anything against tonight.
#
# Change them with the environment variables below rather than by editing this
# file, and production's settings are never read or written here.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: ensure-staging-backup.sh [--apply]

set -Eeuo pipefail

APPLY=0
[ "${1:-}" != '--apply' ] || APPLY=1

CONF=${CONF:-/etc/shikoo/staging/deploy.env}
COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}
FREQUENCY=${BACKUP_FREQUENCY:-30 3 * * *}
RETAIN_LOCAL=${BACKUP_RETAIN_LOCAL:-7}
TIMEOUT_S=${BACKUP_TIMEOUT:-1800}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

say() { echo "[staging-backup] $*"; }
die() {
  echo "[staging-backup] STOP: $*" >&2
  exit 1
}

[ -r "$CONF" ] || die "cannot read $CONF — run as the shikoo-deploy user"

# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

coolify_db() {
  docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' -c "$1" 2>/dev/null || true
}

# The staging database, by name and environment. Production is never a
# candidate here: the lookup is constrained to `dev-fleet` and the result is
# checked against production's uuid before anything is sent.
DB_UUID=$(coolify_db "select p.uuid from standalone_postgresqls p
    join environments e on e.id = p.environment_id
   where e.name = 'dev-fleet' limit 1;")
[ -n "$DB_UUID" ] || die "no Postgres in the dev-fleet environment"

PROD_UUID=$(coolify_db "select p.uuid from standalone_postgresqls p
    join environments e on e.id = p.environment_id
   where e.name = 'production' limit 1;")
[ "$DB_UUID" != "$PROD_UUID" ] ||
  die "the staging lookup returned the production database (${DB_UUID}) — refusing"
say "staging database ${DB_UUID} (production is ${PROD_UUID}, untouched)"

# Already configured? Then this is a no-op and says so, rather than adding a
# second schedule beside the first.
coolify_api GET "/databases/${DB_UUID}/backups" || die "could not read existing backups"
case "$API_STATUS" in
  200) ;;
  *) die "reading the backup configuration was refused (HTTP ${API_STATUS})" ;;
esac
EXISTING=$(printf '%s' "$API_BODY" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: d=[]
d=d if isinstance(d,list) else d.get("backups",[]) if isinstance(d,dict) else []
print(len(d))')
if [ "${EXISTING:-0}" -gt 0 ]; then
  say "staging already has ${EXISTING} scheduled backup(s) — nothing to do"
  exit 0
fi

BODY=$(python3 -c '
import json,sys
print(json.dumps({
  "frequency": sys.argv[1],
  "enabled": True,
  "save_s3": False,
  "dump_all": False,
  "backup_now": True,
  "database_backup_retention_amount_locally": int(sys.argv[2]),
  "timeout": int(sys.argv[3]),
}))' "$FREQUENCY" "$RETAIN_LOCAL" "$TIMEOUT_S")

if [ "$APPLY" -eq 0 ]; then
  say "DRY RUN — would POST to /databases/${DB_UUID}/backups:"
  printf '%s\n' "$BODY"
  say "re-run with --apply to create it"
  exit 0
fi

coolify_api POST "/databases/${DB_UUID}/backups" "$BODY" || die "could not reach Coolify"
case "$API_STATUS" in
  2??) ;;
  422) die "Coolify rejected the payload (HTTP 422): ${API_BODY}" ;;
  *) die "creating the backup schedule was refused (HTTP ${API_STATUS})" ;;
esac

say "created: ${FREQUENCY}, ${RETAIN_LOCAL} kept locally, no S3, first dump running now"
say "wait for that first dump, then run the restore drill for staging."
