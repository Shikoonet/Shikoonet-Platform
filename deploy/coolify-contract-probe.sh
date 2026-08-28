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

# shellcheck source=deploy/coolify-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-api.sh"
# shellcheck source=deploy/coolify-app.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-app.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"

# Set once the application exists, so the EXIT trap can remove it even if a
# later assertion dies. Cleanup that only runs on the happy path is not cleanup.
PROBE_UUID=''
cleanup() {
  if [ -n "$PROBE_UUID" ]; then
    say "cleaning up ${PROBE_UUID}"
    coolify_api DELETE "/applications/${PROBE_UUID}" >/dev/null 2>&1 || true
  fi
  coolify_api_cleanup
}
trap cleanup EXIT

# There is deliberately no `api()` wrapper that prints the body. A wrapper is
# the obvious tidy-up and it reintroduces the exact bug this refactor removes:
# `body=$(api …)` forks, and the status the wrapper stored dies with the fork.
# Every call below is a plain command, and reads API_BODY afterwards.

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
coolify_api GET '/teams/current' || die "cannot reach Coolify at the configured URL"
me=$API_BODY
[ "$API_STATUS" = '200' ] || die "the token was refused (HTTP ${API_STATUS}) — it is missing, wrong, or lacks API access"
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
coolify_api GET '/teams' || die "could not enumerate teams"
teams=$API_BODY
if [ "$API_STATUS" = '200' ]; then
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
coolify_api GET '/projects' || die "could not list projects"
[ "$API_STATUS" = '200' ] || die "listing projects was refused (HTTP ${API_STATUS})"
projects=$API_BODY
PROJECT_UUID=$(printf '%s' "$projects" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for p in d if isinstance(d,list) else []:
    if p.get("name")=="shikoo-dev": print(p.get("uuid") or ""); break
else: print("")')
[ -n "$PROJECT_UUID" ] || die "no project named 'shikoo-dev' — refusing to guess which project is staging"

coolify_api GET "/projects/${PROJECT_UUID}" || die "could not read project ${PROJECT_UUID}"
[ "$API_STATUS" = '200' ] || die "reading project ${PROJECT_UUID} was refused (HTTP ${API_STATUS})"
proj=$API_BODY
ENVIRONMENT_NAME=$(printf '%s' "$proj" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for e in (d.get("environments") or []):
    if e.get("name")=="dev-fleet": print(e.get("name") or ""); break
else: print("")')
[ -n "$ENVIRONMENT_NAME" ] || die "project ${PROJECT_UUID} has no 'dev-fleet' environment"

coolify_api GET '/servers' || die "could not list servers"
[ "$API_STATUS" = '200' ] || die "listing servers was refused (HTTP ${API_STATUS})"
servers=$API_BODY
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
  # Sent because the endpoint documents them, and measured because it
  # discards one of them. See the header of coolify-app.sh.
  "is_auto_deploy_enabled": False,
  "is_preview_deployments_enabled": False,
}))' "$PROJECT_UUID" "$SERVER_UUID" "$ENVIRONMENT_NAME" "$PROBE_IMAGE" "$PROBE_TAG" "$PROBE_NAME")

coolify_api POST '/applications/dockerimage' "$REQUEST" || die "the create call could not be made"
created=$API_BODY
CREATE_STATUS=$API_STATUS
PROBE_UUID=$(printf '%s' "$created" | jqr uuid)
if [ -z "$PROBE_UUID" ]; then
  die "create returned HTTP ${CREATE_STATUS} with no uuid — the contract does not hold on this instance; nothing was created to clean up"
fi
say "   created ${PROBE_UUID} (HTTP ${CREATE_STATUS})"

# ── 5. what the contract promised ─────────────────────────────────────────
say "5. proving the create did nothing else"

coolify_api GET "/applications/${PROBE_UUID}" || die "could not read back ${PROBE_UUID}"
[ "$API_STATUS" = '200' ] || die "reading back ${PROBE_UUID} was refused (HTTP ${API_STATUS})"
app=$API_BODY
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

if coolify_api GET "/applications/${PROBE_UUID}/envs" && [ "$API_STATUS" = '200' ]; then
  envs=$API_BODY
else
  envs='[]'
fi
ENV_COUNT=$(printf '%s' "$envs" | python3 -c 'import json,sys
try: d=json.load(sys.stdin); print(len(d) if isinstance(d,list) else 0)
except Exception: print(0)')
[ "$ENV_COUNT" = '0' ] || note_fail "${ENV_COUNT} environment variable row(s) exist on a probe that set none"

# Containers and settings flags: observed from the host, read-only, because the
# API serialises the two settings as null.
CONTAINERS=$(docker ps -a --filter "label=coolify.name=${PROBE_UUID}" --format '{{.Names}}' 2>/dev/null | grep -c . || true)
[ "${CONTAINERS:-0}" = '0' ] || note_fail "${CONTAINERS} container(s) exist for a probe that was never deployed"

# The state as CREATED, before anything is hardened. This is the measurement,
# not an assertion: whether the documented create-time field is honoured is
# precisely what this probe exists to find out, and on 4.3.13 it is not.
SETTINGS=$(coolify_settings_flags "$PROBE_UUID")
AUTO_DEPLOY_DEFAULT=${SETTINGS%%|*}
PREVIEWS_DEFAULT=${SETTINGS##*|}
[ -n "$SETTINGS" ] || note_fail "could not read the settings of a freshly created application"

# `status` is NOT evidence of a deployment and is not treated as such.
#
# A Docker Image application with no container reports `exited:unhealthy`,
# because Coolify derives the string from a container it cannot find rather
# than from anything it did. The authoritative signals are the two below: a
# container existing, and a row in the deployment queue. Both are zero here.
DEPLOYMENTS=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At \
  -c "select count(*) from application_deployment_queues where application_id = '${PROBE_UUID}';" 2>/dev/null || printf '?')
[ "$DEPLOYMENTS" = '0' ] || note_fail "${DEPLOYMENTS} deployment(s) were queued by a create that asked for none"

say "   build_pack=${BUILD_PACK} fqdn='${FQDN}' containers=${CONTAINERS:-0} envs=${ENV_COUNT} deployments=${DEPLOYMENTS} status=${STATUS_BACK} (status is not deploy evidence)"
say "   as created: auto_deploy=${AUTO_DEPLOY_DEFAULT:-?} previews=${PREVIEWS_DEFAULT:-?}"

# ── 5b. hardening, before anything deployable exists ──────────────────────
#
# Nothing has a domain, an environment row, a queued deployment or a container
# at this point, and that is asserted above rather than assumed. Auto Deploy is
# switched off while the application is still inert, so the window in which a
# push could reach a half-configured production application never opens.
say "5b. disabling Auto Deploy and previews through the API, then proving it"
if coolify_harden_settings "$PROBE_UUID"; then
  HARDENED=proven
else
  HARDENED=failed
  note_fail "could not prove Auto Deploy and previews are false after hardening"
fi

# Hardening must not have deployed anything either.
CONTAINERS_AFTER=$(docker ps -a --filter "label=coolify.name=${PROBE_UUID}" --format '{{.Names}}' 2>/dev/null | grep -c . || true)
[ "${CONTAINERS_AFTER:-0}" = '0' ] || note_fail "${CONTAINERS_AFTER} container(s) appeared while hardening settings"
DEPLOY_AFTER=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At \
  -c "select count(*) from application_deployment_queues where application_id = '${PROBE_UUID}';" 2>/dev/null || printf '?')
[ "$DEPLOY_AFTER" = '0' ] || note_fail "${DEPLOY_AFTER} deployment(s) were queued while hardening settings"

# ── 6. delete exactly that uuid ───────────────────────────────────────────
say "6. deleting ${PROBE_UUID}"
coolify_api DELETE "/applications/${PROBE_UUID}" || note_fail "the delete call could not be made"
DELETE_STATUS=$API_STATUS
coolify_api GET "/applications/${PROBE_UUID}" || true
GONE_STATUS=$API_STATUS
case "$GONE_STATUS" in
  404 | 401 | 403) say "   the API no longer serves it (HTTP ${GONE_STATUS})" ;;
  *) note_fail "the application still answers after DELETE (HTTP ${GONE_STATUS})" ;;
esac

# The API 404s the moment the soft delete lands, and the queued
# `DeleteResourceJob` removes the row a little later — Coolify's own response
# says "Application deletion request queued". Asserting on the database
# immediately therefore fails a deletion that is working correctly, which is
# what the first run of this probe did.
#
# Bounded, because "it will probably be gone soon" is not something a release
# may assume about a row that could still own a name it is about to reuse.
say "   waiting for the queued deletion to converge"
if CONVERGE_SECONDS=$(coolify_await_deletion "$PROBE_UUID" "${DELETE_TIMEOUT:-120}"); then
  say "   converged to zero rows in ~${CONVERGE_SECONDS}s"
  PROBE_UUID=''   # gone; the EXIT trap has nothing left to do
else
  CONVERGE_SECONDS=''
  note_fail "the deleted application never disappeared from the database"
fi

# ── 7. the attestation ────────────────────────────────────────────────────
COOLIFY_VERSION=unknown
if coolify_api GET '/version' && [ "$API_STATUS" = '200' ]; then
  COOLIFY_VERSION=$(printf '%s' "$API_BODY" | tr -d '"\n')
fi

if [ "$FAILED" -ne 0 ]; then
  die "the contract does NOT hold on this instance — see the FAIL lines above. Nothing may create production candidates until this passes."
fi

{
  printf 'schema_version=2\n'
  printf 'coolify_version=%s\n' "$COOLIFY_VERSION"
  printf 'endpoint=POST /api/v1/applications/dockerimage\n'
  printf 'instant_deploy_false_creates_nothing=proven\n'
  printf 'autogenerate_domain_false_creates_no_domain=proven\n'
  printf 'build_pack=dockerimage\n'
  printf 'auto_deploy_default=%s\n' "$AUTO_DEPLOY_DEFAULT"
  printf 'previews_default=%s\n' "$PREVIEWS_DEFAULT"
  printf 'auto_deploy_settable_at_create=no\n'
  printf 'auto_deploy_disabled_before_configuration=%s\n' "$HARDENED"
  printf 'previews_disabled_before_configuration=%s\n' "$HARDENED"
  printf 'env_rows_on_create=%s\n' "$ENV_COUNT"
  printf 'containers_on_create=%s\n' "${CONTAINERS:-0}"
  printf 'deployments_on_create=%s\n' "$DEPLOYMENTS"
  printf 'delete_status=%s\n' "$DELETE_STATUS"
  printf 'delete_semantics=async-hard-delete\n'
  printf 'delete_converged_seconds=%s\n' "$CONVERGE_SECONDS"
  printf 'delete_leaves_no_row=proven\n'
  printf 'team_count=%s\n' "$TEAM_COUNT"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT/coolify-contract.env"
( cd "$OUT" && sha256sum coolify-contract.env >coolify-contract.sha256 )

say "the contract holds. Attestation written to ${OUT}/coolify-contract.env"
say "no application, container, deployment, domain or environment row remains."
