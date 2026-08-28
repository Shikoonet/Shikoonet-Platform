#!/usr/bin/env bash
# P11–P17: the step customers can see.
#
# ─────────────────────────────────────────────────────────────────────────────
# Moves the two live domains onto the candidates that preparation already
# proved, then hands the bot over. It builds nothing, migrates nothing and
# creates nothing.
#
# ── The bot handover, and why it is three steps rather than two ───────────
#
# Old bot stopped → advisory lock count proven to be ZERO → new bot started →
# count proven to be ONE. The middle step is the one that is tempting to skip
# and must not be: stopping a container and observing that it stopped are
# different facts, and Telegram hands each update to exactly one getUpdates
# caller. Two pollers on one token means messages a customer sent disappearing
# into the wrong process, silently, with both bots looking healthy.
#
# `pg_try_advisory_lock` would make the second poller exit rather than
# double-poll, and that is a backstop, not the plan. A plan that relies on its
# backstop has no plan.
#
# ── Domains move back on any failure ─────────────────────────────────────
#
# The rollback here is a domain move, which is seconds, and it happens
# automatically the moment external verification fails. Nothing waits for a
# person to notice: the old applications are still running, which is the whole
# reason they are kept.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: cutover-production.sh <sha> <digest>

set -Eeuo pipefail

SHA_ARG=${1:-}
DIGEST_ARG=${2:-}
ENV_ARG=production
CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
STATE=${STATE:-/var/lib/shikoo/$ENV_ARG}
LIVE_INGEST_DOMAIN=${LIVE_INGEST_DOMAIN:-sms.chopon.uk}
LIVE_DASHBOARD_DOMAIN=${LIVE_DASHBOARD_DOMAIN:-shikoo.chopon.uk}

say() { echo "[cutover] $*"; }
die() {
  echo "[cutover] STOP: $*" >&2
  exit 1
}

[[ $SHA_ARG =~ ^[0-9a-f]{40}$ ]] || die "sha '$SHA_ARG' is not a commit sha"
[[ $DIGEST_ARG =~ ^sha256:[0-9a-f]{64}$ ]] || die "digest '$DIGEST_ARG' is not immutable"
[ -r "$CONF" ] || die "cannot read $CONF — run as the shikoo-deploy user"
[ -r "$STATE/preparation.env" ] ||
  die "no host-side preparation ledger at ${STATE}/preparation.env — this box has no record of a preparation for this release"

cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
COOLIFY_URL=$(cfg COOLIFY_URL)
COOLIFY_TOKEN=$(cfg COOLIFY_TOKEN)
if [ -z "$COOLIFY_URL" ] || [ -z "$COOLIFY_TOKEN" ]; then
  die "$CONF has no COOLIFY_URL/COOLIFY_TOKEN"
fi
OLD_INGEST=$(cfg APP_INGEST)
OLD_DASHBOARD=$(cfg APP_DASHBOARD)
OLD_BOT=$(cfg APP_BOT)

field() { sed -n "s/^$1=//p" "$STATE/preparation.env" | head -1; }
CAND_INGEST=$(field candidate_ingest)
CAND_DASHBOARD=$(field candidate_dashboard)
CAND_BOT=$(field candidate_bot)
LEDGER_SHA=$(field main_sha)
LEDGER_DIGEST=$(field digest)

# The host's own record has to agree with what the workflow was told. Two
# independent stories about which release this is, and both have to match.
[ "$LEDGER_SHA" = "$SHA_ARG" ] ||
  die "the host ledger prepared ${LEDGER_SHA:0:12}, this cutover is for ${SHA_ARG:0:12}"
[ "$LEDGER_DIGEST" = "$DIGEST_ARG" ] ||
  die "the host ledger prepared a different digest than this cutover would deploy"

CURLDIR=$(mktemp -d)
trap 'rm -rf "$CURLDIR"' EXIT
chmod 700 "$CURLDIR"
{
  printf 'header = "Authorization: Bearer %s"\n' "$COOLIFY_TOKEN"
  printf 'header = "Accept: application/json"\n'
} >"$CURLDIR/c"
chmod 600 "$CURLDIR/c"
unset COOLIFY_TOKEN

api() { # METHOD PATH [body]
  local method=$1 path=$2 body=${3:-}
  if [ -n "$body" ]; then
    curl -sS -m 45 -K "$CURLDIR/c" -X "$method" -H 'Content-Type: application/json' \
      --data-binary "$body" "${COOLIFY_URL}/api/v1${path}"
  else
    curl -sS -m 45 -K "$CURLDIR/c" -X "$method" "${COOLIFY_URL}/api/v1${path}"
  fi
}
set_domain() { # uuid fqdn-or-empty
  api PATCH "/applications/$1" "$(python3 -c 'import json,sys; print(json.dumps({"domains": sys.argv[1]}))' "$2")" >/dev/null
}

probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || printf '000'; }

# ── P11. the domains ──────────────────────────────────────────────────────
#
# Off the old application first, then onto the new one. Both holding the same
# name for even a moment is a proxy choosing between them, and which one it
# picks is not a decision anybody made.
say "P11. moving ${LIVE_INGEST_DOMAIN} and ${LIVE_DASHBOARD_DOMAIN}"
rollback_domains() {
  say "ROLLING BACK: returning both domains to the old applications"
  set_domain "$CAND_INGEST" '' || true
  set_domain "$CAND_DASHBOARD" '' || true
  set_domain "$OLD_INGEST" "https://${LIVE_INGEST_DOMAIN}" || true
  set_domain "$OLD_DASHBOARD" "https://${LIVE_DASHBOARD_DOMAIN}" || true
}

set_domain "$OLD_INGEST" '' || die "could not release ${LIVE_INGEST_DOMAIN} from the old ingest"
set_domain "$CAND_INGEST" "https://${LIVE_INGEST_DOMAIN}" || {
  rollback_domains
  die "could not move ${LIVE_INGEST_DOMAIN} onto the candidate"
}
set_domain "$OLD_DASHBOARD" '' || {
  rollback_domains
  die "could not release ${LIVE_DASHBOARD_DOMAIN} from the old dashboard"
}
set_domain "$CAND_DASHBOARD" "https://${LIVE_DASHBOARD_DOMAIN}" || {
  rollback_domains
  die "could not move ${LIVE_DASHBOARD_DOMAIN} onto the candidate"
}

# ── P12. from outside, the way a customer would ───────────────────────────
say "P12. external verification"
sleep 10
ING_CODE=$(probe "https://${LIVE_INGEST_DOMAIN}/health")
DASH_CODE=$(probe "https://${LIVE_DASHBOARD_DOMAIN}/api/v1/health")
VER=$(curl -sS --max-time 15 "https://${LIVE_INGEST_DOMAIN}/version" 2>/dev/null || printf '{}')
VER_SHA=$(printf '%s' "$VER" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("version") or "")
except Exception: print("")')

if [ "$ING_CODE" != '200' ] || [ "$DASH_CODE" != '200' ] || [ "$VER_SHA" != "$SHA_ARG" ]; then
  rollback_domains
  die "live verification failed (ingest ${ING_CODE}, dashboard ${DASH_CODE}, version '${VER_SHA:0:12}') — domains returned to the old applications"
fi
say "    ingest 200, dashboard 200, version ${VER_SHA:0:12}"

# ── P13–P15. the bot handover ─────────────────────────────────────────────
PG=$(docker exec -i "${COOLIFY_DB_CONTAINER:-coolify-db}" psql -U coolify -d coolify -At \
  -c "select p.uuid from standalone_postgresqls p join environments e on e.id=p.environment_id where e.name='production' limit 1;" 2>/dev/null || true)
[ -n "$PG" ] || die "could not find the production database container to count pollers"
locks() {
  docker exec -i "$PG" sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select count(*) from pg_locks where locktype='advisory'\"" 2>/dev/null || printf 'unknown'
}

say "P13. stopping the old bot"
api POST "/applications/${OLD_BOT}/stop" >/dev/null || die "could not stop the old production bot"

# Observed, not assumed. «I asked it to stop» and «it stopped» are different
# facts, and starting the second poller on the strength of the first is how one
# token ends up with two.
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(locks)" = '0' ] && break
  sleep 6
done
[ "$(locks)" = '0' ] ||
  die "the old bot still holds an advisory lock after being stopped — refusing to start a second poller on the same token"
say "P14. zero pollers confirmed; starting the candidate bot"

api POST "/applications/${CAND_BOT}/start" >/dev/null || die "could not start the candidate bot"
BOT_OK=''
for _ in 1 2 3 4 5 6 7 8 9 10; do
  [ "$(locks)" = '1' ] && { BOT_OK=yes; break; }
  sleep 6
done
[ -n "$BOT_OK" ] || die "the candidate bot did not take the advisory lock — production has NO poller; start the old bot to recover"
say "P15. exactly one poller confirmed"

# ── P16. identity, then the ledger ────────────────────────────────────────
BOT_NAME=$(docker exec -i "$PG" sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select value::text from settings where scope='bot' and key='username'\"" 2>/dev/null | tr -d '"' || true)
say "P16. bot identity: ${BOT_NAME:-not yet recorded}"

mkdir -p "$STATE"
printf '%s %s %s promoted-by-hand\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%S%z)" "$DIGEST_ARG" "$SHA_ARG" >>"$STATE/deployed"
say "P17. release recorded. Old applications are stopped-but-kept for rollback."
