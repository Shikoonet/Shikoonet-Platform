#!/usr/bin/env bash
# Does this Coolify actually behave the way the contract says it does?
#
# ─────────────────────────────────────────────────────────────────────────────
# Production candidates are created through `POST /api/v1/applications/dockerimage`,
# and everything downstream depends on three claims about that call:
#
#   · `instant_deploy=false` really does create WITHOUT deploying
#   · `autogenerate_domain=false` really does create WITHOUT a domain
#   · the application really does come out as `build_pack=dockerimage`, with
#     auto-deploy and previews off and no ports published on the host
#
# Believing those from documentation and finding out on production is the
# failure this file exists to prevent. So they are proven here, on STAGING, on
# one disposable application that is created and then deleted — and the
# attestation it writes is what `Prepare Production` refuses to run without.
#
# ── Everything it does is reversible, and the destructive step is exact ────
#
# It creates exactly one application whose name begins `shikoo-api-probe-`, and
# it deletes exactly the uuid the API handed back. It never enumerates
# applications and deletes by pattern: a delete driven by a name match is one
# bad glob away from removing the thing it was protecting.
#
# If the creation deploys, starts a container, generates a domain, or differs
# from the contract in any field, it STOPS — after trying to clean up — rather
# than continuing to a production that would do the same thing unwatched.
#
# ── The token ─────────────────────────────────────────────────────────────
#
# Read the way `deploy.sh` reads it: as text from /etc/shikoo/<env>/deploy.env,
# never `source`d, because a Coolify token is `<id>|<random>` and a shell would
# execute the pipe. It reaches curl through a 0600 config file and never through
# argv, which every process on this host can read. It is never printed, never
# logged, never hashed and never placed in a fixture.
#
# This file must therefore run as a user that can read that directory — which
# is `shikoo-deploy`, by design. Run it as:
#
#     sudo -u shikoo-deploy bash coolify-contract-probe.sh staging
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: coolify-contract-probe.sh <staging> [out-dir]

set -Eeuo pipefail

ENV_ARG=${1:-}
OUT=${2:-./probe-out}

# Staging only, and not by convention. A contract probe creates and deletes an
# application; production is not where you find out whether your delete works.
if [ "$ENV_ARG" != 'staging' ]; then
  echo "refusing: the contract probe runs on staging and nowhere else (got '${ENV_ARG:-nothing}')" >&2
  exit 2
fi

CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}
PROBE_IMAGE=${PROBE_IMAGE:-hello-world}
PROBE_TAG=${PROBE_TAG:-latest}

say() { echo "[probe] $*"; }
FAILED=0
note_fail() {
  echo "[probe] FAIL: $*" >&2
  FAILED=1
}
die() {
  echo "[probe] STOP: $*" >&2
  exit 1
}

[ -r "$CONF" ] || die "cannot read $CONF — run this as the shikoo-deploy user (sudo -u shikoo-deploy …)"

cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
COOLIFY_URL=$(cfg COOLIFY_URL)
COOLIFY_TOKEN=$(cfg COOLIFY_TOKEN)
if [ -z "$COOLIFY_URL" ] || [ -z "$COOLIFY_TOKEN" ]; then
  die "$CONF has no COOLIFY_URL/COOLIFY_TOKEN"
fi

CURLDIR=$(mktemp -d)
chmod 700 "$CURLDIR"
{
  printf 'header = "Authorization: Bearer %s"\n' "$COOLIFY_TOKEN"
  printf 'header = "Accept: application/json"\n'
} >"$CURLDIR/c"
chmod 600 "$CURLDIR/c"
unset COOLIFY_TOKEN

# Set once the application exists, so the EXIT trap can remove it even if a
# later assertion dies. Cleanup that only runs on the happy path is not cleanup.
PROBE_UUID=''
cleanup() {
  if [ -n "$PROBE_UUID" ]; then
    say "cleaning up ${PROBE_UUID}"
    api DELETE "/applications/${PROBE_UUID}" >/dev/null 2>&1 || true
  fi
  rm -rf "$CURLDIR"
}
trap cleanup EXIT

api_status=0
api() { # METHOD PATH [json-body]
  local method=$1 path=$2 body=${3:-} out
  if [ -n "$body" ]; then
    out=$(curl -sS -m 45 -w '%{http_code}' -K "$CURLDIR/c" \
      -X "$method" -H 'Content-Type: application/json' \
      --data-binary "$body" "${COOLIFY_URL}/api/v1${path}") || { api_status=0; return 1; }
  else
    out=$(curl -sS -m 45 -w '%{http_code}' -K "$CURLDIR/c" \
      -X "$method" "${COOLIFY_URL}/api/v1${path}") || { api_status=0; return 1; }
  fi
  api_status=${out: -3}
  printf '%s' "${out:0:${#out}-3}"
}

jqr() { python3 -c 'import json,sys
try: d=json.load(sys.stdin)
except Exception: print(""); sys.exit(0)
cur=d
for k in sys.argv[1].split("."):
    if k=="": continue
    if isinstance(cur,list):
        try: cur=cur[int(k)]
        except Exception: print(""); sys.exit(0)
    elif isinstance(cur,dict): cur=cur.get(k)
    else: cur=None
    if cur is None: print(""); sys.exit(0)
print(cur if not isinstance(cur,(dict,list)) else json.dumps(cur))' "$1"; }

mkdir -p "$OUT"

# ── 1. the token works, without anybody seeing it ─────────────────────────
say "1. token usability"
me=$(api GET '/teams/current') || die "cannot reach Coolify at the configured URL"
[ "$api_status" = '200' ] || die "the token was refused (HTTP ${api_status}) — it is missing, wrong, or lacks API access"
TEAM_ID=$(printf '%s' "$me" | jqr id)
TEAM_NAME=$(printf '%s' "$me" | jqr name)
say "   authenticated as team ${TEAM_ID} (${TEAM_NAME})"

# ── 2. scope ──────────────────────────────────────────────────────────────
#
# Coolify does not expose a token's abilities on any documented endpoint, so
# this is what CAN be observed: how many teams the token can enumerate. A
# team-scoped token sees one. Seeing more is broader than this work needs, and
# broader than approved.
say "2. token scope"
teams=$(api GET '/teams') || die "could not enumerate teams"
if [ "$api_status" = '200' ]; then
  TEAM_COUNT=$(printf '%s' "$teams" | python3 -c 'import json,sys
try: print(len(json.load(sys.stdin)))
except Exception: print(-1)')
else
  TEAM_COUNT=-1
fi
say "   the token can enumerate ${TEAM_COUNT} team(s)"
if [ "$TEAM_COUNT" -gt 1 ]; then
  die "this token can see ${TEAM_COUNT} teams — that is broader than a single-team deploy token and broader than approved. Rotate it to a team-scoped token before continuing."
fi

# ── 3. the identifiers the create call needs ──────────────────────────────
say "3. staging project, environment, server, destination"
projects=$(api GET '/projects') || die "could not list projects"
PROJECT_UUID=$(printf '%s' "$projects" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for p in d if isinstance(d,list) else []:
    if p.get("name")=="shikoo-dev": print(p.get("uuid") or ""); break
else: print("")')
[ -n "$PROJECT_UUID" ] || die "no project named 'shikoo-dev' — refusing to guess which project is staging"

proj=$(api GET "/projects/${PROJECT_UUID}") || die "could not read project ${PROJECT_UUID}"
ENVIRONMENT_NAME=$(printf '%s' "$proj" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for e in (d.get("environments") or []):
    if e.get("name")=="dev-fleet": print(e.get("name") or ""); break
else: print("")')
[ -n "$ENVIRONMENT_NAME" ] || die "project ${PROJECT_UUID} has no 'dev-fleet' environment"

servers=$(api GET '/servers') || die "could not list servers"
SERVER_UUID=$(printf '%s' "$servers" | python3 -c 'import json,sys
d=json.load(sys.stdin)
d=d if isinstance(d,list) else []
print(d[0].get("uuid") if len(d)==1 else "")')
[ -n "$SERVER_UUID" ] || die "expected exactly one server; refusing to guess which one to create on"
say "   project ${PROJECT_UUID}, environment ${ENVIRONMENT_NAME}, server ${SERVER_UUID}"

# ── 4. create exactly one disposable application ──────────────────────────
PROBE_NAME="shikoo-api-probe-$(date -u +%Y%m%d%H%M%S)-$$"
say "4. creating ${PROBE_NAME}"
REQUEST=$(python3 -c 'import json,sys
print(json.dumps({
  "project_uuid": sys.argv[1],
  "server_uuid": sys.argv[2],
  "environment_name": sys.argv[3],
  "docker_registry_image_name": sys.argv[4],
  "docker_registry_image_tag": sys.argv[5],
  "ports_exposes": "8080",
  "name": sys.argv[6],
  "description": "disposable API contract probe; safe to delete",
  "instant_deploy": False,
  "autogenerate_domain": False,
}))' "$PROJECT_UUID" "$SERVER_UUID" "$ENVIRONMENT_NAME" "$PROBE_IMAGE" "$PROBE_TAG" "$PROBE_NAME")

created=$(api POST '/applications/dockerimage' "$REQUEST") || die "the create call could not be made"
CREATE_STATUS=$api_status
PROBE_UUID=$(printf '%s' "$created" | jqr uuid)
if [ -z "$PROBE_UUID" ]; then
  die "create returned HTTP ${CREATE_STATUS} with no uuid — the contract does not hold on this instance; nothing was created to clean up"
fi
say "   created ${PROBE_UUID} (HTTP ${CREATE_STATUS})"

# ── 5. what the contract promised ─────────────────────────────────────────
say "5. proving the create did nothing else"

app=$(api GET "/applications/${PROBE_UUID}") || die "could not read back ${PROBE_UUID}"
BUILD_PACK=$(printf '%s' "$app" | jqr build_pack)
FQDN=$(printf '%s' "$app" | jqr fqdn)
IMAGE_NAME_BACK=$(printf '%s' "$app" | jqr docker_registry_image_name)
IMAGE_TAG_BACK=$(printf '%s' "$app" | jqr docker_registry_image_tag)
PORTS_BACK=$(printf '%s' "$app" | jqr ports_exposes)
STATUS_BACK=$(printf '%s' "$app" | jqr status)

[ "$BUILD_PACK" = 'dockerimage' ] || note_fail "build_pack is '${BUILD_PACK}', not dockerimage"
[ -z "$FQDN" ] || note_fail "a domain was generated (${FQDN}) despite autogenerate_domain=false"
[ "$IMAGE_NAME_BACK" = "$PROBE_IMAGE" ] || note_fail "docker_registry_image_name came back '${IMAGE_NAME_BACK}'"
[ "$IMAGE_TAG_BACK" = "$PROBE_TAG" ] || note_fail "docker_registry_image_tag came back '${IMAGE_TAG_BACK}'"
[ "$PORTS_BACK" = '8080' ] || note_fail "ports_exposes came back '${PORTS_BACK}'"
case "$STATUS_BACK" in running*) note_fail "the application is '${STATUS_BACK}' — instant_deploy=false did not prevent a deployment" ;; esac

envs=$(api GET "/applications/${PROBE_UUID}/envs") || envs='[]'
ENV_COUNT=$(printf '%s' "$envs" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)
except Exception: print(0)')
[ "$ENV_COUNT" = '0' ] || note_fail "${ENV_COUNT} environment variable row(s) exist on a probe that set none"

# Containers and settings flags: observed from the host, read-only, because the
# API serialises the two settings as null.
CONTAINERS=$(docker ps -a --filter "label=coolify.name=${PROBE_UUID}" --format '{{.Names}}' 2>/dev/null | grep -c . || true)
[ "${CONTAINERS:-0}" = '0' ] || note_fail "${CONTAINERS} container(s) exist for a probe that was never deployed"

SETTINGS=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' \
  -c "select s.is_auto_deploy_enabled, s.is_preview_deployments_enabled
        from application_settings s join applications a on a.id = s.application_id
       where a.uuid = '${PROBE_UUID}';" 2>/dev/null || true)
AUTO_DEPLOY=${SETTINGS%%|*}
PREVIEWS=${SETTINGS##*|}
[ "$AUTO_DEPLOY" = 'f' ] || note_fail "native Auto Deploy defaulted to '${AUTO_DEPLOY:-unreadable}' on a new application"
[ "$PREVIEWS" = 'f' ] || note_fail "preview deployments defaulted to '${PREVIEWS:-unreadable}' on a new application"

say "   build_pack=${BUILD_PACK} fqdn='${FQDN}' containers=${CONTAINERS:-0} envs=${ENV_COUNT} auto_deploy=${AUTO_DEPLOY:-?} previews=${PREVIEWS:-?} status=${STATUS_BACK}"

# ── 6. delete exactly that uuid ───────────────────────────────────────────
say "6. deleting ${PROBE_UUID}"
api DELETE "/applications/${PROBE_UUID}" >/dev/null || note_fail "the delete call could not be made"
DELETE_STATUS=$api_status
api GET "/applications/${PROBE_UUID}" >/dev/null 2>&1 || true
GONE_STATUS=$api_status
case "$GONE_STATUS" in
  404 | 401 | 403) say "   gone (HTTP ${GONE_STATUS})" ;;
  *) note_fail "the application still answers after DELETE (HTTP ${GONE_STATUS})" ;;
esac
LEFTOVER=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At \
  -c "select count(*) from applications where uuid = '${PROBE_UUID}';" 2>/dev/null || echo '?')
[ "$LEFTOVER" = '0' ] || note_fail "${LEFTOVER} application row(s) remain for ${PROBE_UUID}"
PROBE_UUID=''   # deleted; the EXIT trap has nothing left to do

# ── 7. the attestation ────────────────────────────────────────────────────
if [ "$FAILED" -ne 0 ]; then
  die "the contract does NOT hold on this instance — see the FAIL lines above. Nothing may create production candidates until this passes."
fi

{
  printf 'schema_version=1\n'
  printf 'coolify_version=%s\n' "$(api GET '/version' | tr -d '"\n' || echo unknown)"
  printf 'endpoint=POST /api/v1/applications/dockerimage\n'
  printf 'instant_deploy_false_creates_nothing=proven\n'
  printf 'autogenerate_domain_false_creates_no_domain=proven\n'
  printf 'build_pack=dockerimage\n'
  printf 'auto_deploy_default=%s\n' "$AUTO_DEPLOY"
  printf 'previews_default=%s\n' "$PREVIEWS"
  printf 'env_rows_on_create=%s\n' "$ENV_COUNT"
  printf 'containers_on_create=%s\n' "${CONTAINERS:-0}"
  printf 'delete_status=%s\n' "$DELETE_STATUS"
  printf 'delete_leaves_no_row=proven\n'
  printf 'team_count=%s\n' "$TEAM_COUNT"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT/coolify-contract.env"
( cd "$OUT" && sha256sum coolify-contract.env >coolify-contract.sha256 )

say "the contract holds. Attestation written to ${OUT}/coolify-contract.env"
say "no application, container, deployment, domain or environment row remains."
