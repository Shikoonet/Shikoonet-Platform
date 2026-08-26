#!/usr/bin/env bash
# Deploy one immutable image digest to one environment on this host.
#
#   deploy.sh <staging|production> <ghcr.io/…@sha256:…> <40-char sha> [--dry-run]
#
# Runs ON the server, as the shikoo-deploy user, invoked over SSH by the
# GitHub deploy workflow — which also scp's this file and compose.yaml first,
# so the version that runs is always the version of the deployed commit.
#
# The sequence, and why it is this order:
#
#   lock → preflight → pull+verify → migrate → gate → ingest+dashboard → bot →
#   smoke → singleton → record
#
# Migration comes before any service because a container on a schema it does
# not know refuses to start (the entrypoint gate) — the 2026-08-17 outage in
# reverse. The bot comes LAST because it is the writer, and a new bot against
# a table the migration has not created yet is the failure docs/STATUS.md
# recorded on 2026-08-18. `up -d` on a single-replica compose service is an
# explicit stop-old-then-start-new, and the advisory-lock singleton makes even
# an overlap safe — both sides of every deployable image know the lock.
#
# Rollback restores the previous APPLICATION image only. The schema is never
# rolled back: migrations are additive and the entrypoint gate only WARNS when
# the database is ahead of the image, which is precisely what makes yesterday's
# image deployable while something is already wrong.
#
# Everything environment-specific lives on this host, per environment:
#
#   /etc/shikoo/<env>/bot.env dashboard.env ingest.env   app secrets (0640)
#   /etc/shikoo/<env>/deploy.env                          this script's config
#   /var/lib/shikoo/<env>/deployed                        deploy history
#
# deploy.env must define:
#   GHCR_USER, GHCR_TOKEN   read-only pull credential for ghcr.io — it stays
#                           on this host; GitHub never sends it per-run
#   DB_CONTAINER            this environment's Postgres container (a Coolify
#                           DATABASE resource — those ids are stable, unlike
#                           application container names; restore-drill.sh set
#                           the precedent)
#   SHIKOO_NETWORK          the docker network this environment's services and
#                           its shikoo-tls terminator share
#   PGUSER                  optional, default postgres
#
# No secret value is ever printed. File NAMES are; contents are not.
set -Eeuo pipefail

usage() {
  echo "usage: deploy.sh <staging|production> <image@sha256:digest> <full-sha> [--dry-run]" >&2
  exit 2
}

[ $# -ge 3 ] || usage
ENV_NAME_ARG=$1
IMAGE_REF=$2
EXPECTED_SHA=$3
DRY_RUN=${4:-}

case "$ENV_NAME_ARG" in
  staging | production) ;;
  *) usage ;;
esac
case "$IMAGE_REF" in
  *@sha256:*) ;;
  *)
    echo "refusing: image reference is not an immutable digest: $IMAGE_REF" >&2
    exit 2
    ;;
esac
if ! echo "$EXPECTED_SHA" | grep -qE '^[0-9a-f]{40}$'; then
  echo "refusing: expected sha is not a full 40-char commit sha" >&2
  exit 2
fi
if [ -n "$DRY_RUN" ] && [ "$DRY_RUN" != "--dry-run" ]; then usage; fi

# Every path is overridable so the whole script can be exercised against a
# local throwaway database and scratch directories — the same pattern as
# restore-drill.sh, and the only reason the rollback path has ever been TESTED
# rather than believed.
ENV_DIR=${ENV_DIR:-/etc/shikoo/$ENV_NAME_ARG}
OTHER_ENV_DIR=${OTHER_ENV_DIR:-$(dirname "$ENV_DIR")/$([ "$ENV_NAME_ARG" = staging ] && echo production || echo staging)}
STATE_FILE=${STATE_FILE:-/var/lib/shikoo/$ENV_NAME_ARG/deployed}
LOCK_FILE=${LOCK_FILE:-/var/lock/shikoo-deploy-$ENV_NAME_ARG.lock}
COMPOSE_FILE=${COMPOSE_FILE:-/opt/shikoo/compose.yaml}
WAIT_TIMEOUT=${WAIT_TIMEOUT:-300}
PROJECT="shikoo-$ENV_NAME_ARG"

say() { echo "[deploy:$ENV_NAME_ARG] $*"; }
summary() { echo "SUMMARY: $*"; }
die() {
  echo "[deploy:$ENV_NAME_ARG] FATAL: $*" >&2
  exit 1
}

compose() {
  SHIKOO_IMAGE="$1" SOURCE_COMMIT="$2" SHIKOO_ENV_DIR="$ENV_DIR" SHIKOO_NETWORK="$SHIKOO_NETWORK" \
    docker compose -f "$COMPOSE_FILE" -p "$PROJECT" "${@:3}"
}

# ---------------------------------------------------------------------- lock
# One deploy per environment at a time. Fail fast rather than queue: GitHub's
# environment concurrency already queues runs, so a second copy here means
# something abnormal (a by-hand run racing CI) and should be looked at, not
# silently serialized behind a lock nobody knows is held.
exec 9>"$LOCK_FILE"
flock -n 9 || die "another deploy of $ENV_NAME_ARG holds $LOCK_FILE — refusing to run concurrently"

# ----------------------------------------------------------------- preflight
for f in bot.env ingest.env dashboard.env deploy.env; do
  [ -f "$ENV_DIR/$f" ] || die "missing $ENV_DIR/$f — see deploy/README.md, the environment is not set up"
done
say "config present: $ENV_DIR/{bot,ingest,dashboard,deploy}.env"

# shellcheck source=/dev/null
. "$ENV_DIR/deploy.env"
: "${DB_CONTAINER:?deploy.env must set DB_CONTAINER}"
: "${SHIKOO_NETWORK:?deploy.env must set SHIKOO_NETWORK}"
PGUSER=${PGUSER:-postgres}

# The env files must agree about which environment they are. ENV_NAME has no
# default anywhere in this system for exactly this reason; here the same
# refusal keeps a production env file out of a staging deploy and vice versa.
for f in bot.env ingest.env dashboard.env; do
  # `|| true` because pipefail turns a grep miss into a silent exit, and a
  # missing ENV_NAME is exactly the case this check exists to report.
  found=$({ grep -E '^ENV_NAME=' "$ENV_DIR/$f" || true; } | tail -1 | cut -d= -f2-)
  [ "$found" = "$ENV_NAME_ARG" ] ||
    die "$ENV_DIR/$f has ENV_NAME=${found:-<unset>}, expected $ENV_NAME_ARG — refusing a cross-environment deploy"
done

# Staging and production must never share a database or a bot token. Compared
# as hashes so neither value is ever printed, even on mismatch. A key absent
# on either side is skipped — absence is a different failure with a better
# error (the service refuses to boot), not a shared credential.
line_hash() { { grep -E "^$2=" "$1" 2>/dev/null || true; } | tail -1 | sha256sum | cut -d' ' -f1; }
EMPTY_HASH=$(printf '' | sha256sum | cut -d' ' -f1)
if [ -d "$OTHER_ENV_DIR" ]; then
  compared=0
  for pair in "dashboard.env DATABASE_URL" "bot.env TELEGRAM_BOT_TOKEN"; do
    file=${pair% *} key=${pair#* }
    here=$(line_hash "$ENV_DIR/$file" "$key")
    there=$(line_hash "$OTHER_ENV_DIR/$file" "$key")
    if [ "$here" = "$EMPTY_HASH" ] || [ "$there" = "$EMPTY_HASH" ]; then continue; fi
    if [ "$here" = "$there" ]; then
      die "$key in $ENV_DIR/$file is identical to $OTHER_ENV_DIR/$file — the environments are not isolated"
    fi
    compared=$((compared + 1))
  done
  # Reported as a count, because «they differ» would be a claim about a
  # comparison that did not happen when the other environment has no files yet.
  say "cross-environment isolation: $compared of 2 shared-credential checks compared against $OTHER_ENV_DIR, none collided"
fi

# SKIP_LOGIN is for the local demo harness only, where no registry exists.
if [ "${SKIP_LOGIN:-0}" != "1" ]; then
  : "${GHCR_USER:?deploy.env must set GHCR_USER}"
  : "${GHCR_TOKEN:?deploy.env must set GHCR_TOKEN}"
  printf '%s' "$GHCR_TOKEN" | docker login ghcr.io -u "$GHCR_USER" --password-stdin >/dev/null
fi

# ------------------------------------------------- previous image = rollback
PREV_REF=""
PREV_SHA=""
if [ -s "$STATE_FILE" ]; then
  PREV_REF=$(tail -1 "$STATE_FILE" | awk '{print $2}')
  PREV_SHA=$(tail -1 "$STATE_FILE" | awk '{print $3}')
  say "rollback candidate: $PREV_REF ($PREV_SHA)"
else
  say "first deploy of $ENV_NAME_ARG — no rollback candidate exists"
fi

# ------------------------------------------------------------ pull + verify
docker pull -q "$IMAGE_REF" >/dev/null || die "pull failed for $IMAGE_REF"
LABEL_SHA=$(docker inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$IMAGE_REF")
[ "$LABEL_SHA" = "$EXPECTED_SHA" ] ||
  die "image revision label is '$LABEL_SHA', expected $EXPECTED_SHA — this digest was not built from that commit"
say "pulled $IMAGE_REF, revision label matches $EXPECTED_SHA"
summary "env=$ENV_NAME_ARG"
summary "image=$IMAGE_REF"
summary "sha=$EXPECTED_SHA"

if [ "$DRY_RUN" = "--dry-run" ]; then
  compose "$IMAGE_REF" "$EXPECTED_SHA" config -q || die "compose file does not validate"
  say "dry run: config validates, image verified, environment isolated. Stopping before migrate."
  summary "dry_run=ok"
  exit 0
fi

# ----------------------------------------------------------------- migrate
# One one-off container, before any service is touched. If it fails, nothing
# has changed: the running services are still consistent with the schema they
# booted on, and there is nothing to roll back. `up()` holds the schema
# advisory lock and applies each file in its own transaction, so this is safe
# to re-run and safe against a concurrent copy.
if ! compose "$IMAGE_REF" "$EXPECTED_SHA" run --rm migrate; then
  summary "migration=FAILED"
  summary "services=untouched"
  die "migration failed — no service was touched; fix the migration and redeploy"
fi
summary "migration=ok"

# `gate`, not `status`: after a rollback deploy the database is legitimately
# AHEAD of this image, which status calls a failure and gate calls a warning.
# Blocking yesterday's image is blocking the one deploy made while something
# is already wrong — the same reasoning as the entrypoint gate itself.
compose "$IMAGE_REF" "$EXPECTED_SHA" run --rm --entrypoint node migrate --import tsx packages/db/src/schemaCli.ts gate ||
  die "schema gate refuses this image against the migrated database"
say "schema gate: safe to start on"

# ----------------------------------------------------- services, in order
# The ERR trap arms only now: earlier failures need no rollback because
# nothing was touched. From here, any failure restores the previous image.
on_err() {
  trap - ERR
  echo "[deploy:$ENV_NAME_ARG] deploy FAILED after services were touched" >&2
  if [ -z "$PREV_REF" ]; then
    summary "rollback=unavailable (first deploy)"
    summary "verdict=MANUAL INTERVENTION REQUIRED"
    exit 1
  fi
  echo "[deploy:$ENV_NAME_ARG] rolling back application images to $PREV_REF ($PREV_SHA) — schema stays as migrated" >&2
  if compose "$PREV_REF" "$PREV_SHA" up -d ingest dashboard bot &&
    wait_healthy "$PREV_REF" ingest dashboard bot; then
    summary "rollback=ok ($PREV_REF)"
    summary "verdict=DEPLOY FAILED, ROLLBACK SUCCEEDED"
  else
    summary "rollback=FAILED"
    summary "verdict=DEPLOY FAILED AND ROLLBACK FAILED — MANUAL INTERVENTION REQUIRED"
  fi
  exit 1
}
trap on_err ERR

# Poll container health. `exited`/`restarting`/`unhealthy` fail immediately —
# an entrypoint refusal exits within seconds, and waiting out the full window
# on a container that has already said no helps nobody.
wait_healthy() {
  local image=$1
  shift
  local svc deadline cid state
  deadline=$(($(date +%s) + WAIT_TIMEOUT))
  for svc in "$@"; do
    while :; do
      cid=$(compose "$image" "$EXPECTED_SHA" ps -q "$svc")
      [ -n "$cid" ] || {
        echo "no container for $svc" >&2
        return 1
      }
      state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid")
      case "$state" in
        "running healthy")
          say "$svc: healthy"
          break
          ;;
        "running starting" | "running none") ;; # keep waiting
        *)
          echo "$svc is '$state'" >&2
          docker logs --tail 15 "$cid" >&2 || true
          return 1
          ;;
      esac
      [ "$(date +%s)" -lt "$deadline" ] || {
        echo "$svc not healthy within ${WAIT_TIMEOUT}s" >&2
        return 1
      }
      sleep 5
    done
  done
}

compose "$IMAGE_REF" "$EXPECTED_SHA" up -d ingest dashboard
wait_healthy "$IMAGE_REF" ingest dashboard

# The bot last, and by itself: `up -d` recreates the single replica — stop
# old, start new — so the old poller's lock session is gone before the new
# one asks for it. If anything still holds it, the new bot blocks on the
# advisory lock rather than fighting Telegram for getUpdates.
compose "$IMAGE_REF" "$EXPECTED_SHA" up -d bot
wait_healthy "$IMAGE_REF" bot
summary "health=ok (ingest, dashboard, bot)"

# ------------------------------------------------------------------- smoke
# Probed from a throwaway container on the same network, resolving the same
# aliases nginx resolves — so this proves the path a real request takes, not
# just that a process exists. node:22-slim has no curl; node's fetch does it.
smoke() {
  docker run --rm --network "$SHIKOO_NETWORK" --entrypoint node \
    -e EXPECTED_SHA="$EXPECTED_SHA" "$IMAGE_REF" -e '
    const fail = (m) => { console.error("smoke: " + m); process.exit(1); };
    const j = (r) => r.json();
    Promise.all([
      fetch("http://ingest:8787/version").then(j).then((v) => {
        if (v.version !== process.env.EXPECTED_SHA) fail("ingest /version says " + v.version);
      }),
      fetch("http://dashboard:8788/api/v1/health").then((r) => {
        if (r.status !== 200) fail("dashboard health " + r.status);
      }),
      fetch("http://dashboard:8788/api/v1/version").then((r) => {
        if (r.status !== 401) fail("dashboard /api/v1/version answered " + r.status + " without a session — the gate fell off");
      }),
    ]).then(() => process.exit(0), (e) => fail(String(e)));'
}
smoke || die "smoke checks failed"
say "smoke: version matches, health answers, session gate intact"
summary "smoke=ok"

# --------------------------------------------------- exactly one bot poller
# The lock namespace is 0x53680000 = 1399324672 (apps/bot/src/singleton.ts).
# One granted holder in THIS environment's database means one poller for this
# environment's token. Two means a deploy overlapped; zero means the bot is
# not actually polling, however healthy it looks.
HOLDERS=$(docker exec "$DB_CONTAINER" psql -U "$PGUSER" -tA -c \
  "SELECT count(DISTINCT pid) FROM pg_locks WHERE locktype='advisory' AND granted AND classid=1399324672")
[ "$HOLDERS" = "1" ] || die "expected exactly 1 bot poller lock holder, found ${HOLDERS:-none}"
say "bot singleton: exactly one poller holds the lock"
summary "bot_singleton=1 poller"

# ------------------------------------------- no port quietly became public
# There is no firewall on this host: a published port IS a public port. The
# compose file publishes none; assert nothing crept in.
for svc in ingest dashboard bot; do
  cid=$(compose "$IMAGE_REF" "$EXPECTED_SHA" ps -q "$svc")
  ports=$(docker inspect --format '{{range $p, $b := .NetworkSettings.Ports}}{{if $b}}{{$p}} {{end}}{{end}}' "$cid")
  [ -z "$ports" ] || die "$svc publishes host ports ($ports) — nothing here may listen publicly"
done
say "no published ports"

# ------------------------------------------------------------------ record
trap - ERR
mkdir -p "$(dirname "$STATE_FILE")"
printf '%s %s %s\n' "$(date -Is)" "$IMAGE_REF" "$EXPECTED_SHA" >>"$STATE_FILE"
say "recorded in $STATE_FILE"
summary "verdict=DEPLOYED"
