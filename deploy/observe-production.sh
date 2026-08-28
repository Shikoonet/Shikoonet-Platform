#!/usr/bin/env bash
# Production as it is right now, in the words the drift check compares against.
#
# Deliberately separate from `verify-preparation-manifest.sh`. This file only
# LOOKS; that one only COMPARES. Keeping them apart is what stops a future edit
# from making the comparison agree with itself — a script that gathers its own
# expectations always passes.
#
# Every value is printed as `key=value` on stdout. A value this cannot determine
# is printed as `unknown`, never omitted and never guessed: the comparison
# treats a missing observation as a failure, and `unknown` reaches that same
# refusal by a path the reader can see.
#
# Read-only. It starts nothing, stops nothing and writes nothing.

set -Eeuo pipefail

ENV_ARG=${ENV_ARG:-production}
CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}
LIVE_INGEST_DOMAIN=${LIVE_INGEST_DOMAIN:-sms.chopon.uk}
LIVE_DASHBOARD_DOMAIN=${LIVE_DASHBOARD_DOMAIN:-shikoo.chopon.uk}

emit() { printf '%s=%s\n' "$1" "$2"; }

coolify_db() {
  docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' -c "$1" 2>/dev/null || true
}

# Which application currently answers on each customer domain. This is the
# observation cutover exists to act on, so it is the one worth being exact
# about: the fqdn column is Coolify's own record of who owns the name.
owner_of() { # domain -> application name or 'unknown'
  local name
  name=$(coolify_db "select a.name from applications a where a.fqdn like '%${1}%' limit 1;")
  printf '%s' "${name:-unknown}"
}
emit live_ingest_owner "$(owner_of "$LIVE_INGEST_DOMAIN")"
emit live_dashboard_owner "$(owner_of "$LIVE_DASHBOARD_DOMAIN")"

# The schema ledger, from the production database itself rather than from
# anything that remembers what it applied.
PG=$(coolify_db "select p.uuid from standalone_postgresqls p join environments e on e.id=p.environment_id where e.name='production' limit 1;")
if [ -n "$PG" ]; then
  SCHEMA=$(docker exec -i "$PG" sh -c \
    'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "select count(*) from schema_migrations"' 2>/dev/null || true)
  LOCKS=$(docker exec -i "$PG" sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select count(*) from pg_locks where locktype='advisory'\"" 2>/dev/null || true)
else
  SCHEMA=''
  LOCKS=''
fi
emit schema_version "${SCHEMA:-unknown}"
emit bot_locks "${LOCKS:-unknown}"

# Auto-deploy and previews across every production application, collapsed to one
# word. `off` only if every row says false — anything else, including a row that
# could not be read, is not `off`.
FLAGS=$(coolify_db "select count(*) from application_settings s
  join applications a on a.id = s.application_id
  join environments e on e.id = a.environment_id
  where e.name='production' and (s.is_auto_deploy_enabled or s.is_preview_deployments_enabled);")
if [ "$FLAGS" = '0' ]; then emit auto_deploy off; else emit auto_deploy "${FLAGS:-unknown}-enabled"; fi

# Candidate health, by the canonical names the ensure script uses.
health_of() { # app-name -> health word
  local uuid cid
  uuid=$(coolify_db "select uuid from applications where name='$1' limit 1;")
  [ -n "$uuid" ] || { printf 'absent'; return; }
  cid=$(docker ps --filter "label=coolify.name=${uuid}" --format '{{.Names}}' 2>/dev/null | head -1)
  [ -n "$cid" ] || { printf 'stopped'; return; }
  docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$cid" 2>/dev/null || printf 'unknown'
}
ING=$(health_of shikoo-prod-ingest)
DASH=$(health_of shikoo-prod-dashboard)
if [ "$ING" = 'healthy' ] && [ "$DASH" = 'healthy' ]; then
  emit candidate_health healthy
else
  emit candidate_health "ingest:${ING} dashboard:${DASH}"
fi

# The candidates still answering on their temporary domains.
TEMP_ING=${TEMP_INGEST_URL:-https://sms-next.chopon.uk}
TEMP_DASH=${TEMP_DASHBOARD_URL:-https://shikoo-next.chopon.uk}
probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 12 "$1" 2>/dev/null || printf '000'; }
if [ "$(probe "${TEMP_ING}/health")" = '200' ] && [ "$(probe "${TEMP_DASH}/api/v1/health")" = '200' ]; then
  emit temp_domain_verify pass
else
  emit temp_domain_verify fail
fi

# The pre-cutover backup. Present means a file exists and is not empty; a
# zero-byte backup is the failure that looks exactly like success.
BACKUP_DIR=${BACKUP_DIR:-/var/lib/shikoo/production/backups}
if [ -d "$BACKUP_DIR" ] && [ -n "$(find "$BACKUP_DIR" -type f -size +1k -print -quit 2>/dev/null)" ]; then
  emit backup_present present
else
  emit backup_present missing
fi
