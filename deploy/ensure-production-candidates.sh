#!/usr/bin/env bash
# The three canonical production applications — created once, reused for ever.
#
# ─────────────────────────────────────────────────────────────────────────────
# THE MISTAKE THIS FILE EXISTS TO NOT MAKE
#
# The obvious way to write this is "create three Docker Image applications",
# and it is correct exactly once. Run it again on the next release and there are
# six; run it a third time and there are nine, half of them holding stale
# variables, all of them named almost the same, and the one that owns the live
# domain is whichever a person last remembered. That is not a hypothetical
# failure mode — it is what "create the candidates" means if nobody writes down
# that the second release is a different problem from the first.
#
# So this is an ENSURE, not a create. It looks for the canonical names in the
# target project and environment first. If they are there, it returns their
# uuids and creates nothing. Only a genuinely absent application is created, and
# only by the exact documented contract.
#
# The first production release therefore creates three. Every release after it
# creates zero, and the assertion at the end says so out loud rather than
# leaving "no applications were created" as something to infer from silence.
#
# ── Why lookup by name rather than a uuid written in a config file ─────────
#
# A uuid in a file drifts: somebody deletes an application in the panel, the
# file still names it, and the next release creates a fourth beside it while
# reporting a reuse. The panel is the only thing that knows what exists, so the
# panel is what gets asked — filtered to one project and one environment, so a
# staging application called `shikoo-ingest` can never be mistaken for the
# production one.
#
# ── What it deliberately does not do ──────────────────────────────────────
#
# No domain, no host-published port, no environment variable, and
# `instant_deploy=false` — creation and deployment are separate steps because
# a new image needs the migrated schema, and an application that starts the
# moment it is created starts against the old one.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: ensure-production-candidates.sh <env>
# Emits `<role>_uuid=<uuid>` lines to $GITHUB_OUTPUT and to stdout.

set -Eeuo pipefail

ENV_ARG=${1:-}
case "$ENV_ARG" in
  staging | production) ;;
  *) echo "usage: ensure-production-candidates.sh <staging|production>" >&2; exit 2 ;;
esac

CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}
PROJECT_NAME=${PROJECT_NAME:-shikoo}
ENVIRONMENT_NAME=${ENVIRONMENT_NAME:-production}

# The canonical names. Changing one of these strings creates a fourth
# application rather than renaming anything, which is why they are here, in the
# reviewed file, and not in a settings page.
CANDIDATE_INGEST_NAME=${CANDIDATE_INGEST_NAME:-shikoo-prod-ingest}
CANDIDATE_DASHBOARD_NAME=${CANDIDATE_DASHBOARD_NAME:-shikoo-prod-dashboard}
CANDIDATE_BOT_NAME=${CANDIDATE_BOT_NAME:-shikoo-prod-bot}

# To stderr, deliberately. `ensure_one` returns the uuid on stdout and the
# caller captures it with `$(...)`, so a progress line written to stdout would
# be captured AS the uuid — and the failure looks like a Coolify bug rather
# than a shell one.
say() { echo "[candidates] $*" >&2; }
die() {
  echo "[candidates] REFUSED: $*" >&2
  exit 1
}

[ -r "$CONF" ] || die "cannot read $CONF"
cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
COOLIFY_URL=$(cfg COOLIFY_URL)
COOLIFY_TOKEN=$(cfg COOLIFY_TOKEN)
if [ -z "$COOLIFY_URL" ] || [ -z "$COOLIFY_TOKEN" ]; then
  die "$CONF has no COOLIFY_URL/COOLIFY_TOKEN"
fi

# The contract this file writes against was proven on this Coolify instance by
# `coolify-contract-probe.sh`, and the attestation it wrote is required here.
# Creating production applications on an unverified contract is the thing the
# probe exists to prevent, so its absence is a refusal rather than a warning.
CONTRACT=${CONTRACT:-/var/lib/shikoo/coolify-contract.env}
[ -r "$CONTRACT" ] ||
  die "no Coolify contract attestation at ${CONTRACT} — run coolify-contract-probe.sh on staging first. Production applications are not created against an unverified API contract."
# Schema 2 or nothing. A schema-1 attestation was written before anyone knew
# that `is_auto_deploy_enabled` is accepted and discarded at create time, so it
# records nothing about hardening — and accepting it here would let a
# production application be created with push-to-deploy silently ON.
grep -q '^schema_version=2$' "$CONTRACT" ||
  die "${CONTRACT} is not a schema-2 attestation — re-run coolify-contract-probe.sh. A schema-1 record predates the discovery that auto-deploy cannot be set at create time, so it proves nothing about hardening."
for claim in \
  'instant_deploy_false_creates_nothing=proven' \
  'autogenerate_domain_false_creates_no_domain=proven' \
  'auto_deploy_disabled_before_configuration=proven' \
  'previews_disabled_before_configuration=proven' \
  'delete_leaves_no_row=proven'; do
  grep -qx -- "$claim" "$CONTRACT" || die "${CONTRACT} does not record ${claim}"
done

# shellcheck source=deploy/coolify-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-api.sh"
# shellcheck source=deploy/coolify-app.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-app.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

# Which project and environment. Named, never positional: "the first project"
# is a correct answer exactly until somebody adds one.
coolify_api GET '/projects' || die "could not list projects"
[ "$API_STATUS" = '200' ] || die "listing projects was refused (HTTP ${API_STATUS})"
projects=$API_BODY
PROJECT_UUID=$(printf '%s' "$projects" | python3 -c 'import json,sys
d=json.load(sys.stdin)
for p in (d if isinstance(d,list) else []):
    if p.get("name")==sys.argv[1]: print(p.get("uuid") or ""); break
else: print("")' "$PROJECT_NAME")
[ -n "$PROJECT_UUID" ] || die "no project named '${PROJECT_NAME}'"

coolify_api GET '/servers' || die "could not list servers"
[ "$API_STATUS" = '200' ] || die "listing servers was refused (HTTP ${API_STATUS})"
servers=$API_BODY
SERVER_UUID=$(printf '%s' "$servers" | python3 -c 'import json,sys
d=json.load(sys.stdin); d=d if isinstance(d,list) else []
print(d[0].get("uuid") if len(d)==1 else "")')
[ -n "$SERVER_UUID" ] || die "expected exactly one server; refusing to guess which one to create on"

# Every application in this project+environment, once, so three lookups do not
# become three round trips that could each see a different world.
coolify_api GET '/applications' || die "could not list applications"
[ "$API_STATUS" = '200' ] || die "listing applications was refused (HTTP ${API_STATUS})"
existing=$API_BODY

find_uuid() { # name -> uuid or empty
  printf '%s' "$existing" | python3 -c 'import json,sys
d=json.load(sys.stdin)
want, proj, env = sys.argv[1], sys.argv[2], sys.argv[3]
for a in (d if isinstance(d,list) else []):
    if a.get("name") != want: continue
    e = a.get("environment") or {}
    p = (e.get("project") or {})
    if e.get("name") not in (env, None): continue
    if p.get("uuid") not in (proj, None): continue
    print(a.get("uuid") or ""); break
else: print("")' "$1" "$PROJECT_UUID" "$ENVIRONMENT_NAME"
}

# Prints `<outcome> <uuid>`, not just the uuid.
#
# The count of applications created cannot be kept in a variable this function
# assigns: the caller reads its stdout with `$(...)`, which is a subshell, and
# an increment inside it is discarded the moment the function returns. That bug
# does not fail loudly — it reports «created this run: 0» on the very first
# release, which is the one run where the number is supposed to be three, and
# the signal Phase 4 wants is then silent for ever.
#
# So the outcome travels the only way out of a subshell that works: on stdout,
# beside the value.
ensure_one() { # name role -> prints "<created|reused> <uuid>"
  local name=$1 role=$2 uuid
  uuid=$(find_uuid "$name")
  if [ -n "$uuid" ]; then
    say "${role}: reusing ${name} (${uuid}) — nothing created"
    printf 'reused %s' "$uuid"
    return 0
  fi

  local body
  body=$(python3 -c 'import json,sys
print(json.dumps({
  "project_uuid": sys.argv[1],
  "server_uuid": sys.argv[2],
  "environment_name": sys.argv[3],
  "docker_registry_image_name": sys.argv[4],
  "ports_exposes": sys.argv[5],
  "name": sys.argv[6],
  "description": "shikoo production, deployed by digest",
  "instant_deploy": False,
  "autogenerate_domain": False,
}))' "$PROJECT_UUID" "$SERVER_UUID" "$ENVIRONMENT_NAME" "$IMAGE_NAME" \
    "$([ "$role" = 'dashboard' ] && echo 8788 || echo 8787)" "$name")

  # Inside this function the status check is in the SAME shell that set it,
  # even though the function itself is called through `$(...)`. What must not
  # happen is the check moving outside — which is the whole subject of the
  # header of coolify-api.sh.
  coolify_api POST '/applications/dockerimage' "$body" ||
    die "${role}: the create call could not be made"
  case "$API_STATUS" in
    2??) ;;
    401 | 403) die "${role}: create was refused (HTTP ${API_STATUS}) — the token cannot create applications in this project" ;;
    *) die "${role}: create returned HTTP ${API_STATUS}" ;;
  esac
  uuid=$(printf '%s' "$API_BODY" | python3 -c 'import json,sys
try: print(json.load(sys.stdin).get("uuid") or "")
except Exception: print("")')
  [ -n "$uuid" ] || die "${role}: create returned HTTP ${API_STATUS} with no uuid"

  # Harden BEFORE the application has a domain, an environment row, a queued
  # deployment or a container — while a push that reached it could do nothing.
  # The create was asked for `is_auto_deploy_enabled: false` and this version
  # accepts and discards it, so the flag is true right now.
  #
  # A failure here deletes the exact uuid just created rather than leaving a
  # production application with push-to-deploy on and nobody's name against it.
  if ! coolify_harden_settings "$uuid"; then
    say "${role}: hardening failed — deleting ${uuid}"
    coolify_api DELETE "/applications/${uuid}" >/dev/null 2>&1 || true
    coolify_await_deletion "$uuid" "${DELETE_TIMEOUT:-120}" >/dev/null 2>&1 || true
    die "${role}: could not prove Auto Deploy and previews are off on ${name}; the application was deleted rather than left exposed"
  fi

  say "${role}: created ${name} (${uuid}), stopped, no domain, no ports published, auto-deploy off"
  printf 'created %s' "$uuid"
}

# Split in the PARENT shell, deliberately spelled out three times rather than
# wrapped in a helper. A helper would have to be called as `$(helper ...)` too,
# and the counter it incremented would be discarded by that subshell exactly
# like the first attempt at this — the same bug, one layer further away.
CREATED=0
result=$(ensure_one "$CANDIDATE_INGEST_NAME" ingest)
INGEST_UUID=${result#* }
if [ "${result%% *}" = 'created' ]; then CREATED=$((CREATED + 1)); fi

result=$(ensure_one "$CANDIDATE_DASHBOARD_NAME" dashboard)
DASHBOARD_UUID=${result#* }
if [ "${result%% *}" = 'created' ]; then CREATED=$((CREATED + 1)); fi

result=$(ensure_one "$CANDIDATE_BOT_NAME" bot)
BOT_UUID=${result#* }
if [ "${result%% *}" = 'created' ]; then CREATED=$((CREATED + 1)); fi

# Said out loud rather than left to be inferred from silence. On every release
# after the first this reads `created 0`, and a number other than 0 there is the
# signal that something was renamed or deleted underneath us.
say "canonical applications: 3, created this run: ${CREATED}"

emit() { # key value
  printf '%s=%s\n' "$1" "$2"
  [ -z "${GITHUB_OUTPUT:-}" ] || printf '%s=%s\n' "$1" "$2" >>"$GITHUB_OUTPUT"
}
emit candidate_ingest "$INGEST_UUID"
emit candidate_dashboard "$DASHBOARD_UUID"
emit candidate_bot "$BOT_UUID"
emit applications_created "$CREATED"
