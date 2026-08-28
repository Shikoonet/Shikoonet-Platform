#!/usr/bin/env bash
# Deploy one immutable image digest to one environment, through Coolify.
#
#   deploy.sh <staging|production> <ghcr.io/…@sha256:…> <40-char sha> \
#             [--dry-run] [--registry-token-stdin]
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
#   /etc/shikoo/<env>/deploy.env      root:shikoo-deploy 0640, plain KEY=value,
#                                     read as text — values need no quoting
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
  echo "usage: deploy.sh <staging|production> <image@sha256:digest> <full-sha> [--dry-run] [--registry-token-stdin]" >&2
  exit 2
}

[ $# -ge 3 ] || usage
ENV_ARG=$1
IMAGE_REF=$2
EXPECTED_SHA=$3
DRY_RUN=${4:-}

case "$ENV_ARG" in staging | production) ;; *) usage ;; esac
# A digest is `name@sha256:` and then exactly 64 lowercase hex characters.
#
# The glob this replaced accepted anything after the colon — «@sha256:abc», or
# «@sha256:» with nothing at all — which is a malformed reference wearing the
# shape of a real one. It would survive both layers of this pipeline and fail
# at «docker pull», after the flock was taken and the ledger consulted.
echo "$IMAGE_REF" | grep -qE '^[^@[:space:]]+@sha256:[0-9a-f]{64}$' || {
  echo "refusing: not an immutable digest: $IMAGE_REF" >&2
  exit 2
}
echo "$EXPECTED_SHA" | grep -qE '^[0-9a-f]{40}$' || {
  echo "refusing: expected sha is not a full 40-character commit sha" >&2
  exit 2
}
REGISTRY_LOGIN=0
case "${5:-}" in
  --registry-token-stdin) REGISTRY_LOGIN=1 ;;
  '') ;;
  *) usage ;;
esac
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

CONF="$ENV_DIR/deploy.env"
# «missing» and «there but not readable» are different faults with different
# fixes, and `[ -f ]` answers false to both. It said missing once when the file
# was present and /etc/shikoo had lost its group execute bit, which sent the
# search in entirely the wrong direction.
if [ ! -e "$CONF" ]; then
  [ -d "$ENV_DIR" ] ||
    die "$ENV_DIR does not exist, or this user cannot traverse into it — check that $(dirname "$ENV_DIR") is group-executable by $(id -gn)"
  die "missing $CONF — this environment is not set up"
fi
[ -r "$CONF" ] ||
  die "$CONF exists but is not readable by $(id -un) — it should be mode 0640, group $(id -gn)"

# Read, do not `source`. A Coolify API token is `<id>|<random>` and a shell
# reads that pipe as a pipeline — `COOLIFY_TOKEN=4|Vhs…` runs `Vhs…` as a
# command and assigns `4`. Sourcing a secrets file also hands whoever can write
# it arbitrary execution as this user. This reads values as text and never
# interprets them, so a `|`, a space or a `$` in any secret is just a character.
cfg() { sed -n "s/^$1=//p" "$CONF" | tail -1; }
COOLIFY_URL=$(cfg COOLIFY_URL)
COOLIFY_TOKEN=$(cfg COOLIFY_TOKEN)
APP_INGEST=$(cfg APP_INGEST)
APP_DASHBOARD=$(cfg APP_DASHBOARD)
APP_BOT=$(cfg APP_BOT)
DB_CONTAINER=$(cfg DB_CONTAINER)
PGUSER=$(cfg PGUSER); PGUSER=${PGUSER:-postgres}
for required in COOLIFY_URL COOLIFY_TOKEN APP_INGEST APP_DASHBOARD APP_BOT DB_CONTAINER; do
  [ -n "$(eval "printf '%s' \"\$$required\"")" ] || die "$CONF must set $required"
done
say "config: $ENV_DIR/deploy.env"

# ------------------------------------------------------------- the bot switch
# Deploying the bot is not like deploying the other two. It does not answer a
# port somebody chose to call: it CONNECTS OUT, takes the advisory lock and
# starts long-polling Telegram with this environment's token. A staging bot
# started by accident answers real customers from a database that is not the
# real one.
#
# So it is opt-in, and ONLY the exact lowercase string `true` opts in. Not
# `TRUE`, not `1`, not `yes`, not empty, not unset — every one of those is a
# value somebody typed hoping it would work, and the safe reading of a value
# nobody defined is «no».
#
# When it is off the bot is not pinned, not deployed, not waited on, not
# smoke-tested, not counted in the singleton check and not rolled back. Its
# Coolify safety configuration is still validated, because that check asks
# whether something could deploy behind this script's back and the answer
# matters most about the application nobody is watching.
DEPLOY_BOT_ENABLED=${DEPLOY_BOT_ENABLED:-false}
if [ "$DEPLOY_BOT_ENABLED" = 'true' ]; then
  BOT_ENABLED=1
  say "bot: ENABLED for this deploy"
else
  BOT_ENABLED=0
  say "bot: excluded (DEPLOY_BOT_ENABLED=${DEPLOY_BOT_ENABLED}; only the exact string 'true' enables it)"
  summary "bot=EXCLUDED"
fi

# ------------------------------------------------------------ registry auth
# With `--registry-token-stdin` the caller hands a registry credential on
# STDIN — the deploy workflow passes GitHub's own per-run token, which is
# scoped to this repository's packages and stops existing when the job ends.
#
# That is the better half of a real trade. The alternative is a personal access
# token living on this host: it reads every package the account can see, it
# lasts until somebody remembers to rotate it, and it sits in
# /root/.docker/config.json base64-encoded, which is not encryption.
#
# On STDIN and never in an argument, because argv is visible in `ps` to every
# process on this box, and never in a file.
if [ "$REGISTRY_LOGIN" = "1" ]; then
  IFS= read -r REGISTRY_TOKEN || true
  [ -n "${REGISTRY_TOKEN:-}" ] || die "--registry-token-stdin was given but nothing arrived on stdin"
  printf '%s' "$REGISTRY_TOKEN" |
    docker login "${IMAGE_NAME%%/*}" -u x-access-token --password-stdin >/dev/null ||
    die "registry login failed for ${IMAGE_NAME%%/*}"
  REGISTRY_TOKEN=
  say "registry: authenticated for this run only"
fi

# The token goes to curl through a config file on stdin, never on the command
# line. `--fail-with-body` so a 4xx is an error and still shows what the API
# said, which a bare `--fail` throws away.
# `--max-time` is not decoration. This script holds the environment's flock for
# its whole life, so a panel that accepts a connection and never answers would
# hang the deploy AND block every later one — including the rollback somebody
# runs to recover from it. The GitHub job timeout kills the ssh client; it does
# not reach the process on the host.
api() {
  local method=$1 path=$2 body=${3:-}
  local args=(--silent --show-error --fail-with-body --connect-timeout 10 --max-time 120
    --request "$method" "$COOLIFY_URL/api/v1$path")
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
# Which policy let this out. Recorded rather than assumed, and validated the
# same way the bot switch is: a value this script does not recognise is written
# as «unrecorded» instead of being trusted into the ledger.
DEPLOY_APPROVAL_POLICY=${DEPLOY_APPROVAL_POLICY:-unrecorded}
case "$DEPLOY_APPROVAL_POLICY" in
  team-approved | solo-owner | promoted-by-hand) ;;
  *) DEPLOY_APPROVAL_POLICY=unrecorded ;;
esac

summary "env=$ENV_ARG"
summary "approval=$DEPLOY_APPROVAL_POLICY"
summary "image=$IMAGE_REF"
summary "sha=$EXPECTED_SHA"

PREV_TAG=""
PREV_SHA=""
if [ -s "$STATE_FILE" ]; then
  # Stored canonically as `sha256:<hex>`; Coolify's tag field wants the hyphen.
  PREV_TAG=$(awk 'END{print $2}' "$STATE_FILE" | sed 's/^sha256:/sha256-/')
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

# What kind of application Coolify thinks this is.
#
# python3 rather than jq: this script already depends on python3 for the env
# parsing below, and jq is not installed on the box.
app_field() { # uuid field
  api GET "/applications/$1" |
    python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get(sys.argv[1]) or "")
except Exception:
    print("")' "$2"
}

# The check that makes leaving `build_pack` alone safe.
#
# `dockerimage` is NOT a build strategy. Coolify 4.3.11 offers five of those —
# railpack, nixpacks, static, dockerfile, dockercompose — and `dockerimage` is
# none of them: it is an application TYPE, decided when the application is
# created (`Livewire/Project/New/DockerImage.php`) and reachable by no UI
# dropdown and no PATCH afterwards. An application created from a Git source is
# a Git application for life.
#
# That distinction is the whole reason this check exists. A Git application
# asked to deploy runs `deploy_dockerfile_buildpack()`, which CLONES AND
# REBUILDS, ignoring `docker_registry_image_name` entirely. The run would go
# green, the container would be healthy, and it would be running a tree this
# pipeline never verified — the digest guarantee lost in silence.
#
# So the refusal is a refusal, and it does not suggest a setting to change,
# because there is none. Moving a Git application onto this pipeline means
# creating a Docker Image application beside it and cutting over.
assert_deployable() { # uuid name
  local pack image
  pack=$(app_field "$1" build_pack)
  if [ "$pack" != 'dockerimage' ]; then
    die "$2 is a '${pack:-unknown}' application, not a Docker Image application. Coolify would clone the repository and rebuild, ignoring the digest this deploy verified. There is no setting that converts it: «Docker Image» is an application TYPE chosen at creation, not one of the five build strategies. A Docker Image application has to be created beside this one and cut over."
  fi
  # The registry the application is pinned to must be the one this pipeline
  # pushes. Otherwise the tag lands on somebody else's repository and Coolify
  # pulls an image nothing here built.
  image=$(app_field "$1" docker_registry_image_name)
  [ "$image" = "$IMAGE_NAME" ] ||
    die "$2 is pinned to image repository '${image:-none}', but this deploy builds '$IMAGE_NAME' — refusing to point it somewhere else"

  # ENV_NAME, asked of Coolify before anything is touched.
  #
  # `parseEnvName` refuses to boot without it — «there is no safe default» —
  # and on 2026-08-27 the bot had no such variable, so the deploy pushed a new
  # image, watched three containers crash-loop, and rolled back. Every minute of
  # that was knowable from one GET before the first application was touched.
  api GET "/applications/$1/envs" |
    python3 -c 'import json,sys
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
rows = rows if isinstance(rows, list) else []
sys.exit(0 if any(r.get("key") == "ENV_NAME" and (r.get("value") or "").strip() for r in rows) else 1)' ||
    die "$2 has no ENV_NAME in Coolify — the image refuses to boot without it, so this deploy would crash-loop and roll back"
}

# Before the migration, because a misconfigured application should cost
# nothing: at this point the running containers are still consistent with the
# schema they booted on and there is nothing to undo.
#
# Only the applications this deploy will TOUCH. Demanding the right type of an
# excluded bot would refuse a good deploy over a setting that does not matter
# yet.
assert_deployable "$APP_INGEST" ingest
assert_deployable "$APP_DASHBOARD" dashboard
if [ "$BOT_ENABLED" = 1 ]; then
  assert_deployable "$APP_BOT" bot
fi
say "every application this deploy touches is set to deploy an image, not to rebuild"

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
# `build_pack` is deliberately NOT sent.
#
# Coolify 4.3.11's `BuildPackTypes` enum is nixpacks / static / dockerfile /
# dockercompose / railpack. There is no `dockerimage` case, so the API refuses
# any PATCH carrying that value:
#
#     {"message":"Validation failed.",
#      "errors":{"build_pack":["The selected build pack is invalid."]}}
#
# The value is legal in the database and legal to `ApplicationDeploymentJob`,
# which is where this script's header read it from — only the WRITE path
# disagrees, and the UI sets it by another route. So it is configured once per
# application by hand and asserted below rather than sent on every deploy.
set_image() { # uuid tag
  api PATCH "/applications/$1" \
    "{\"docker_registry_image_name\":\"$IMAGE_NAME\",\"docker_registry_image_tag\":\"$2\"}" >/dev/null
}

# `SOURCE_COMMIT` is injected by Coolify only for GIT builds — it is not a
# stored variable, and there is no commit behind an image reference. So after
# the move to `dockerimage` nothing would answer `/version` and both services
# would go back to reporting the literal string `dev`, which is exactly the
# bug docs/STATUS.md records under «موج ۳».
#
# `APP_VERSION` is the first thing `resolveAppVersion` looks at, ahead of
# SOURCE_COMMIT, so setting it here is both the fix and the smoke test's
# premise: /version answering the deployed sha is what proves the running code
# is the code that was deployed.
#
# Update first, create if it is not there yet — the variable does not exist on
# an application that has only ever been a git build.
set_version() { # uuid sha
  local body="{\"key\":\"APP_VERSION\",\"value\":\"$2\",\"is_preview\":false}"
  api PATCH "/applications/$1/envs" "$body" >/dev/null 2>&1 ||
    api POST "/applications/$1/envs" "$body" >/dev/null
}

# Containers are found by Coolify's own label, never by name: a container name
# changes on every deploy, `coolify.name` is the application UUID and does not.
container_for() { docker ps -q --filter "label=coolify.name=$1" | head -1; }

# Waits for the REPLACEMENT container, which is the whole difficulty here.
#
# `POST /deploy` queues a deployment; it does not start a container. While that
# deployment sits in the queue the previous container is still running and
# still healthy, and `coolify.name` is stable across deploys precisely so it
# keeps matching. Asking only «is a container with this label healthy» there
# gets `yes` from the container being replaced — so a new image that cannot
# boot would be called healthy, recorded as deployed, and never rolled back.
#
# Two things have to change before this returns 0: the container id, and the
# image it was started from. The image is compared by ID rather than by name,
# because a name can be a tag pointing anywhere while an ID is the bytes.
wait_healthy() { # uuid name old_cid want_image_id
  local uuid=$1 name=$2 old_cid=$3 want=$4 deadline cid state img
  deadline=$(($(date +%s) + WAIT_TIMEOUT))
  while :; do
    cid=$(container_for "$uuid")
    if [ -n "$cid" ] && [ "$cid" != "$old_cid" ]; then
      img=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo "")
      if [ "$img" = "$want" ]; then
        state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo "gone none")
        case "$state" in
          "running healthy")
            say "$name: healthy, on the deployed image"
            return 0
            ;;
          "exited "*)
            echo "$name exited" >&2
            docker logs --tail 20 "$cid" >&2 || true
            return 1
            ;;
        esac
      fi
    fi
    [ "$(date +%s)" -lt "$deadline" ] || {
      if [ -n "$cid" ] && [ "$cid" = "$old_cid" ]; then
        echo "$name was never replaced within ${WAIT_TIMEOUT}s — the deployment did not start" >&2
      else
        echo "$name not healthy on the deployed image within ${WAIT_TIMEOUT}s" >&2
        [ -z "$cid" ] || docker logs --tail 20 "$cid" >&2 || true
      fi
      return 1
    }
    sleep 5
  done
}

roll_one() { # uuid name tag sha
  # Asked again, immediately before the write.
  #
  # The pre-flight above runs before the migration, and the migration takes
  # time. A person editing an application in the Coolify UI during that window
  # would move it out from under a check that already passed, and the deploy
  # would then hand a tag to something that rebuilds from git. One GET per
  # application closes all of the window this script can see.
  #
  # What it does NOT do is serialise against the Coolify UI. There is no lock,
  # advisory or otherwise, that a shell script can take against a human with a
  # browser — Coolify exposes no such primitive — so this narrows the race
  # rather than removing it. `assert_running_digest` after the deploy is the
  # backstop: whatever happened in between, the container has to be running the
  # bytes this run pulled.
  assert_deployable "$1" "$2"

  local old_cid want ref
  old_cid=$(container_for "$1")
  # The image must be here to have an ID to compare against. It already is for
  # a forward deploy; on a rollback the previous digest may not be, so this
  # pulls rather than assuming.
  ref="$IMAGE_NAME@sha256:${3#sha256-}"
  docker pull -q "$ref" >/dev/null || {
    echo "cannot pull $ref" >&2
    return 1
  }
  want=$(docker inspect --format '{{.Id}}' "$ref")
  set_image "$1" "$3"
  set_version "$1" "$4"
  api POST "/deploy?uuid=$1" >/dev/null
  wait_healthy "$1" "$2" "$old_cid" "$want"
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
  # The bot is rolled back only if it was rolled forward. Restoring a previous
  # digest onto an application this deploy never touched would START it.
  rollback_ok=0
  if roll_one "$APP_INGEST" ingest "$PREV_TAG" "$PREV_SHA" &&
    roll_one "$APP_DASHBOARD" dashboard "$PREV_TAG" "$PREV_SHA"; then
    rollback_ok=1
    if [ "$BOT_ENABLED" = 1 ] && ! roll_one "$APP_BOT" bot "$PREV_TAG" "$PREV_SHA"; then
      rollback_ok=0
    fi
  fi
  if [ "$rollback_ok" = 1 ]; then
    summary "rollback=ok ($PREV_TAG)"
    summary "verdict=DEPLOY FAILED, ROLLBACK SUCCEEDED"
  else
    summary "rollback=FAILED"
    summary "verdict=DEPLOY FAILED AND ROLLBACK FAILED — MANUAL INTERVENTION REQUIRED"
  fi
  exit 1
}
trap on_err ERR

# What the container is actually running, against the registry.
#
# `wait_healthy` already compares the container's image ID to the ID of the ref
# this script pulled, which is strong. This asks the other question: that the
# image the container runs still CARRIES the digest we were told to deploy.
# An image ID is local; `RepoDigests` is what the registry called it, and it is
# the identity the ledger and any later promotion speak in.
#
# Belt and braces on purpose. The failure this catches — a healthy container on
# the wrong bytes — is the one nothing else on the box would ever report.
assert_running_digest() { # uuid name
  local cid digests
  cid=$(container_for "$1")
  [ -n "$cid" ] || die "$2 has no container after a successful deploy"
  digests=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' \
    "$(docker inspect --format '{{.Image}}' "$cid")" 2>/dev/null || echo "")
  case "$digests" in
    *"sha256:$DIGEST_HEX"*) ;;
    *)
      die "$2 is running an image that does not carry sha256:${DIGEST_HEX:0:12} — deployed bytes do not match the digest this run verified"
      ;;
  esac
  say "$2: running the exact digest this deploy pulled"
}

roll_one "$APP_INGEST" ingest "$COOLIFY_TAG" "$EXPECTED_SHA"
assert_running_digest "$APP_INGEST" ingest
roll_one "$APP_DASHBOARD" dashboard "$COOLIFY_TAG" "$EXPECTED_SHA"
assert_running_digest "$APP_DASHBOARD" dashboard
if [ "$BOT_ENABLED" = 1 ]; then
  roll_one "$APP_BOT" bot "$COOLIFY_TAG" "$EXPECTED_SHA"
  assert_running_digest "$APP_BOT" bot
  summary "health=ok (ingest, dashboard, bot)"
else
  say "bot: not deployed, not started, not health-checked"
  summary "health=ok (ingest, dashboard)"
fi

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
#
# Skipped entirely when the bot is excluded: this deploy did not start a poller,
# so «exactly one» is not a property it can assert. On a first staging rollout
# the honest count is zero, and failing on that would be failing on the thing
# that was asked for.
if [ "$BOT_ENABLED" = 1 ]; then
  HOLDERS=$(docker exec "$DB_CONTAINER" psql -U "$PGUSER" -tA -c \
    "SELECT count(DISTINCT pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1399324672" 2>/dev/null || echo "")
  [ "$HOLDERS" = "1" ] || die "expected exactly 1 bot poller lock holder, found ${HOLDERS:-none}"
  say "bot singleton: exactly one poller holds the lock"
  summary "bot_singleton=1 poller"
else
  summary "bot_singleton=not asserted (bot excluded)"
fi

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
# The canonical spelling is `sha256:<hex>` — what a registry, `promote.yml`
# and `rollback.yml` all speak. `sha256-<hex>` exists only because it is the
# spelling Coolify's tag field requires, and writing THAT into the history
# meant a digest copied out of this file could never be promoted: promote
# greps the history for `sha256:<hex>` and would never have found it.
# A fourth field, appended: `promote` and `rollback` read $2 and $3 and are
# unaffected, and a line that did not say which policy shipped it would make
# «somebody reviewed this» and «the owner shipped it alone» indistinguishable
# afterwards — which is exactly what the ledger is for.
printf '%s %s %s %s\n' "$(date -Is)" "sha256:$DIGEST_HEX" "$EXPECTED_SHA" "$DEPLOY_APPROVAL_POLICY" >>"$STATE_FILE"
say "recorded in $STATE_FILE"
summary "verdict=DEPLOYED"
