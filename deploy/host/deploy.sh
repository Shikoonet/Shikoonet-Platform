#!/usr/bin/env bash
# Deploy one immutable image digest to one environment, through Coolify.
#
#   deploy.sh <staging|production> <ghcr.io/…@sha256:…> <40-char sha> [--dry-run]
#
# Runs ON the server, as the shikoo-deploy user, invoked over SSH by the GitHub
# deploy workflow — which scp's this file up from the commit being deployed
# first, so the version that runs is always the version that was reviewed.
#
# ## Why Coolify still owns the containers
#
# Coolify writes the Traefik labels that put the panel and the SMS endpoint
# behind their hostnames, and renews their certificates. Taking the containers
# away from it means owning fifteen labels per service and the ACME wiring by
# hand, forever, to gain nothing this script needs.
#
# What Coolify could NOT do was deploy an image built somewhere else: the apps
# were `dockerfile` build-packs, so every deploy rebuilt from git and the
# artifact CI tested was never the artifact that ran. That is the one thing
# changed here, and it is three fields on an application rather than a new
# orchestrator:
#
#   build_pack                 = dockerimage
#   docker_registry_image_name = ghcr.io/<owner>/<repo>
#   docker_registry_image_tag  = sha256-<hex>      ← note the HYPHEN
#
# The hyphen is not a typo. ApplicationDeploymentJob.php:1191-1193 reads a tag
# beginning `sha256-` and pulls `name@sha256:<hex>` — a digest, not a tag. That
# is Coolify's own spelling for a digest deploy, read out of the source of the
# installed version (4.3.11) rather than assumed.
#
# ## What this script still owns
#
# Coolify deploys one application when asked. It does not know that migrations
# come first, that the bot must be last, that exactly one poller may hold the
# advisory lock afterwards, or what to put back when a deploy fails. That is
# the whole of this file.
#
# ## Configuration, per environment, on this host
#
#   /etc/shikoo/<env>/deploy.env      root:shikoo-deploy 0640
#     COOLIFY_URL     http://localhost:8000 — LOCAL on purpose: the panel is
#                     plain HTTP, so the token must never cross a wire
#     COOLIFY_TOKEN   abilities read, write, deploy. Never leaves this host
#     APP_INGEST / APP_DASHBOARD / APP_BOT   application UUIDs, which are
#                     stable across deploys — unlike container names
#     DB_CONTAINER    this environment's Postgres container
#
#   /var/lib/shikoo/<env>/deployed    the deploy history, and the rollback source
#
# No secret is printed, and none is passed as an argument — argv is visible in
# `ps` to every process on the box. The API token reaches curl through a config
# file on stdin.
set -Eeuo pipefail

usage() {
  echo "usage: deploy.sh <staging|production> <image@sha256:digest> <full-sha> [--dry-run]" >&2
  exit 2
}

[ $# -ge 3 ] || usage
ENV_ARG=$1
IMAGE_REF=$2
EXPECTED_SHA=$3
DRY_RUN=${4:-}

case "$ENV_ARG" in staging | production) ;; *) usage ;; esac
case "$IMAGE_REF" in
  *@sha256:*) ;;
  *)
    echo "refusing: not an immutable digest: $IMAGE_REF" >&2
    exit 2
    ;;
esac
echo "$EXPECTED_SHA" | grep -qE '^[0-9a-f]{40}$' || {
  echo "refusing: expected sha is not a full 40-character commit sha" >&2
  exit 2
}
[ -z "$DRY_RUN" ] || [ "$DRY_RUN" = "--dry-run" ] || usage

IMAGE_NAME=${IMAGE_REF%@*}
DIGEST_HEX=${IMAGE_REF##*@sha256:}
COOLIFY_TAG="sha256-$DIGEST_HEX"

# Overridable so the whole script can be exercised against a fake API and a
# throwaway database — the only reason its rollback has ever been tested rather
# than believed. Same pattern as restore-drill.sh.
ENV_DIR=${ENV_DIR:-/etc/shikoo/$ENV_ARG}
STATE_FILE=${STATE_FILE:-/var/lib/shikoo/$ENV_ARG/deployed}
LOCK_FILE=${LOCK_FILE:-/var/lock/shikoo-deploy-$ENV_ARG.lock}
WAIT_TIMEOUT=${WAIT_TIMEOUT:-420}
NETWORK=${NETWORK:-coolify}

say() { echo "[deploy:$ENV_ARG] $*"; }
summary() { echo "SUMMARY: $*"; }
die() {
  echo "[deploy:$ENV_ARG] FATAL: $*" >&2
  exit 1
}

# ---------------------------------------------------------------------- lock
# Fail fast rather than queue: GitHub's environment concurrency already queues,
# so a second copy here means a hand-run racing CI, which is worth seeing.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy of $ENV_ARG holds $LOCK_FILE"

[ -f "$ENV_DIR/deploy.env" ] || die "missing $ENV_DIR/deploy.env — this environment is not set up"
# shellcheck source=/dev/null
. "$ENV_DIR/deploy.env"
: "${COOLIFY_URL:?deploy.env must set COOLIFY_URL}"
: "${COOLIFY_TOKEN:?deploy.env must set COOLIFY_TOKEN}"
: "${APP_INGEST:?deploy.env must set APP_INGEST}"
: "${APP_DASHBOARD:?deploy.env must set APP_DASHBOARD}"
: "${APP_BOT:?deploy.env must set APP_BOT}"
: "${DB_CONTAINER:?deploy.env must set DB_CONTAINER}"
PGUSER=${PGUSER:-postgres}
say "config: $ENV_DIR/deploy.env"

# The token goes to curl through a config file on stdin, never on the command
# line. `--fail-with-body` so a 4xx is an error and still shows what the API
# said, which a bare `--fail` throws away.
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(--silent --show-error --fail-with-body --request "$method" "$COOLIFY_URL/api/v1$path")
  [ -z "$body" ] || args+=(--header 'Content-Type: application/json' --data "$body")
  curl "${args[@]}" --config - <<CFG
header = "Authorization: Bearer $COOLIFY_TOKEN"
CFG
}

# ------------------------------------------------------------ pull + verify
# Pulled here as well as by Coolify, because the revision label is checked
# BEFORE anything is asked to deploy. A digest that was not built from this
# commit must never reach an application record.
docker pull -q "$IMAGE_REF" >/dev/null || die "pull failed for $IMAGE_REF"
LABEL_SHA=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_REF")
[ "$LABEL_SHA" = "$EXPECTED_SHA" ] ||
  die "image revision label is '$LABEL_SHA', expected $EXPECTED_SHA — this digest was not built from that commit"
say "pulled $IMAGE_REF, revision label matches"
summary "env=$ENV_ARG"
summary "image=$IMAGE_REF"
summary "sha=$EXPECTED_SHA"

PREV_TAG=""
PREV_SHA=""
if [ -s "$STATE_FILE" ]; then
  PREV_TAG=$(awk 'END{print $2}' "$STATE_FILE")
  PREV_SHA=$(awk 'END{print $3}' "$STATE_FILE")
  say "rollback candidate: $PREV_TAG ($PREV_SHA)"
else
  say "first deploy of $ENV_ARG through this pipeline — no rollback candidate"
fi

if [ "$DRY_RUN" = "--dry-run" ]; then
  for u in "$APP_INGEST" "$APP_DASHBOARD" "$APP_BOT"; do
    api GET "/applications/$u" >/dev/null || die "the Coolify API did not answer for $u"
  done
  say "dry run: token works, image verified, three applications addressable. Stopping before migrate."
  summary "dry_run=ok"
  exit 0
fi

# ----------------------------------------------------------------- migrate
# One one-off container, before any application is touched. If it fails nothing
# has changed: the running containers are still consistent with the schema they
# booted on, and there is nothing to roll back.
#
# DATABASE_URL comes from the dashboard application's own environment, so there
# is one source of truth for it. It reaches docker through an env-file rather
# than -e, keeping it out of argv.
say "migrating"
DB_ENV_FILE=$(mktemp)
chmod 600 "$DB_ENV_FILE"
trap 'rm -f "$DB_ENV_FILE"' EXIT
api GET "/applications/$APP_DASHBOARD/envs" | python3 -c '
import json, sys
rows = json.load(sys.stdin)
rows = rows if isinstance(rows, list) else []
for r in rows:
    if r.get("key") == "DATABASE_URL":
        sys.stdout.write("DATABASE_URL=" + (r.get("value") or "") + "\n")
        break
' > "$DB_ENV_FILE"
grep -q '^DATABASE_URL=..' "$DB_ENV_FILE" || die "the dashboard application has no DATABASE_URL in Coolify"

if ! docker run --rm --network "$NETWORK" --env-file "$DB_ENV_FILE" -e SERVICE=migrate "$IMAGE_REF"; then
  summary "migration=FAILED"
  summary "services=untouched"
  die "migration failed — no application was touched"
fi
summary "migration=ok"

# `gate`, not `status`: a database ahead of this image is a rollback, which is a
# warning rather than a refusal. Same rule as the entrypoint's own gate.
docker run --rm --network "$NETWORK" --env-file "$DB_ENV_FILE" --entrypoint node "$IMAGE_REF" \
  --import tsx packages/db/src/schemaCli.ts gate ||
  die "schema gate refuses this image against the migrated database"
say "schema gate: safe to start on"

# --------------------------------------------------------- deploy, in order
# ingest and dashboard first, the bot last. The bot is the writer, and a new
# bot against a table its migration has not created is the 2026-08-18 failure.
set_image() { # uuid tag
  api PATCH "/applications/$1" \
    "{\"build_pack\":\"dockerimage\",\"docker_registry_image_name\":\"$IMAGE_NAME\",\"docker_registry_image_tag\":\"$2\"}" >/dev/null
}

# Containers are found by Coolify's own label, never by name: a container name
# changes on every deploy, `coolify.name` is the application UUID and does not.
container_for() { docker ps -q --filter "label=coolify.name=$1" | head -1; }

wait_healthy() { # uuid name
  local uuid=$1 name=$2 deadline cid state
  deadline=$(($(date +%s) + WAIT_TIMEOUT))
  while :; do
    cid=$(container_for "$uuid")
    if [ -n "$cid" ]; then
      state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "gone none")
      case "$state" in
        "running healthy")
          say "$name: healthy"
          return 0
          ;;
        "exited "*)
          echo "$name exited" >&2
          docker logs --tail 20 "$cid" >&2 || true
          return 1
          ;;
      esac
    fi
    [ "$(date +%s)" -lt "$deadline" ] || {
      echo "$name not healthy within ${WAIT_TIMEOUT}s" >&2
      [ -z "$cid" ] || docker logs --tail 20 "$cid" >&2 || true
      return 1
    }
    sleep 5
  done
}

roll_one() { # uuid name tag
  set_image "$1" "$3"
  api POST "/deploy?uuid=$1" >/dev/null
  wait_healthy "$1" "$2"
}

on_err() {
  trap - ERR
  echo "[deploy:$ENV_ARG] deploy FAILED after an application was touched" >&2
  if [ -z "$PREV_TAG" ]; then
    summary "rollback=unavailable (no previous digest recorded)"
    summary "verdict=MANUAL INTERVENTION REQUIRED"
    exit 1
  fi
  echo "[deploy:$ENV_ARG] restoring $PREV_TAG ($PREV_SHA) — the schema stays as migrated" >&2
  if roll_one "$APP_INGEST" ingest "$PREV_TAG" &&
    roll_one "$APP_DASHBOARD" dashboard "$PREV_TAG" &&
    roll_one "$APP_BOT" bot "$PREV_TAG"; then
    summary "rollback=ok ($PREV_TAG)"
    summary "verdict=DEPLOY FAILED, ROLLBACK SUCCEEDED"
  else
    summary "rollback=FAILED"
    summary "verdict=DEPLOY FAILED AND ROLLBACK FAILED — MANUAL INTERVENTION REQUIRED"
  fi
  exit 1
}
trap on_err ERR

roll_one "$APP_INGEST" ingest "$COOLIFY_TAG"
roll_one "$APP_DASHBOARD" dashboard "$COOLIFY_TAG"
roll_one "$APP_BOT" bot "$COOLIFY_TAG"
summary "health=ok (ingest, dashboard, bot)"

# ------------------------------------------------------------------- smoke
# Run inside each service's own network namespace, so this asks the running
# process the same questions its health check asks — and one it does not: that
# the version answering is the commit that was deployed.
smoke() {
  local ing dash
  ing=$(container_for "$APP_INGEST")
  dash=$(container_for "$APP_DASHBOARD")
  [ -n "$ing" ] && [ -n "$dash" ] || return 1
  docker run --rm --network "container:$ing" --entrypoint node \
    -e EXPECTED_SHA="$EXPECTED_SHA" "$IMAGE_REF" -e '
    const fail = (m) => { console.error("smoke: " + m); process.exit(1); };
    fetch("http://127.0.0.1:8787/version").then((r) => r.json()).then((v) => {
      if (v.version !== process.env.EXPECTED_SHA) fail("ingest /version says " + v.version);
      process.exit(0);
    }, (e) => fail(String(e)));' || return 1
  docker run --rm --network "container:$dash" --entrypoint node "$IMAGE_REF" -e '
    const fail = (m) => { console.error("smoke: " + m); process.exit(1); };
    Promise.all([
      fetch("http://127.0.0.1:8788/api/v1/health").then((r) => {
        if (r.status !== 200) fail("dashboard health " + r.status);
      }),
      fetch("http://127.0.0.1:8788/api/v1/version").then((r) => {
        if (r.status !== 401) fail("/api/v1/version answered " + r.status + " with no session — the gate fell off");
      }),
    ]).then(() => process.exit(0), (e) => fail(String(e)));' || return 1
}
smoke || die "smoke checks failed"
say "smoke: version matches, health answers, session gate intact"
summary "smoke=ok"

# --------------------------------------------------- exactly one bot poller
# 1399324672 is 0x53680000, the namespace in apps/bot/src/singleton.ts. One
# granted holder means one poller for THIS environment's token. Two means a
# deploy overlapped; zero means the bot is not polling, however healthy it looks.
HOLDERS=$(docker exec "$DB_CONTAINER" psql -U "$PGUSER" -tA -c \
  "SELECT count(DISTINCT pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1399324672" 2>/dev/null || echo "")
[ "$HOLDERS" = "1" ] || die "expected exactly 1 bot poller lock holder, found ${HOLDERS:-none}"
say "bot singleton: exactly one poller holds the lock"
summary "bot_singleton=1 poller"

# ------------------------------------------- nothing quietly became public
# There is no firewall on this host: a published port is a public port, and
# Traefik is the only thing that may publish one.
for pair in "$APP_INGEST ingest" "$APP_DASHBOARD dashboard" "$APP_BOT bot"; do
  uuid=${pair%% *}
  name=${pair##* }
  cid=$(container_for "$uuid")
  [ -n "$cid" ] || continue
  ports=$(docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$cid")
  [ -z "$ports" ] || die "$name publishes host ports ($ports) — only Traefik may"
done
say "no published ports"

# ------------------------------------------------------------------ record
trap - ERR
mkdir -p "$(dirname "$STATE_FILE")"
printf '%s %s %s\n' "$(date -Is)" "$COOLIFY_TAG" "$EXPECTED_SHA" >>"$STATE_FILE"
say "recorded in $STATE_FILE"
summary "verdict=DEPLOYED"
