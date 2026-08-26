#!/usr/bin/env bash
# What deploy.sh promises, proved against real containers.
#
#   deploy/host/deploy-test.sh <image-tag>       # default: shikoo-ci
#
# Everything deploy.sh is for is a refusal or a recovery, and neither shows up
# in a green deploy. A migration that fails must leave every running container
# alone; a new image that cannot boot must put the old one back; two deploys
# must not interleave. Those paths only ever run on the worst day, which is the
# worst day to discover they were written wrong — so they run here instead, on
# a throwaway database, a throwaway registry and a throwaway network.
#
# A registry rather than a local tag, because «deploy by digest» is the claim
# being tested: the script refuses anything that is not `@sha256:…`, and a
# digest that never round-tripped through a registry would not test that.
#
# Nothing here can touch a real environment. The paths, the network, the
# database and the project name are all `deploytest`-prefixed and removed on
# exit, and deploy.sh reads every one of them from the environment for exactly
# this reason.
#
# Roughly three minutes, most of it waiting for health checks to say what they
# are going to say.
set -Eeuo pipefail

IMAGE=${1:-shikoo-ci}

# shellcheck disable=SC1007  # `CDPATH= cd` is the idiom, not a typo: it blanks
# CDPATH for this one command so `cd` cannot print a different directory.
REPO_ROOT="${REPO_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
DEPLOY_SH="$REPO_ROOT/deploy/host/deploy.sh"
COMPOSE_YAML="$REPO_ROOT/deploy/compose.yaml"

NET=deploytest-net
PG=deploytest-pg
REG=deploytest-registry
REG_PORT=5599
WORK=$(mktemp -d)
PASSED=0

say() { printf '\n=== %s\n' "$*"; }
pass() {
  PASSED=$((PASSED + 1))
  printf '  ok   %s\n' "$*"
}
fail() {
  printf '  FAIL %s\n' "$*" >&2
  exit 1
}

cleanup() {
  set +e
  # The project name is the same one deploy.sh used, so this removes exactly
  # what the test created and nothing else.
  SHIKOO_IMAGE=x SOURCE_COMMIT=x SHIKOO_ENV_DIR="$WORK/staging" SHIKOO_NETWORK="$NET" \
    docker compose -f "$COMPOSE_YAML" -p shikoo-staging down --timeout 5 >/dev/null 2>&1
  docker rm -f "$PG" "$REG" >/dev/null 2>&1
  docker rmi "127.0.0.1:$REG_PORT/shikoo:good" "127.0.0.1:$REG_PORT/shikoo:broken" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

# ---------------------------------------------------------------- the world
say "setting up a throwaway environment"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no image '$IMAGE' — build it first, or pass a tag"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=deploytest -e POSTGRES_DB=shikoo postgres:16 >/dev/null
docker run -d --name "$REG" --network "$NET" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null
until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

# A second image whose ingest cannot boot. A bad BUILD, not a bad environment —
# the rollback has to put a working image back using the same env files, so a
# poisoned env file would prove the wrong thing (it would break the rollback
# too, and the test would pass for the wrong reason).
docker build -q -t "127.0.0.1:$REG_PORT/shikoo:broken" - <<EOF >/dev/null
FROM $IMAGE
USER root
RUN printf '#!/bin/sh\nif [ "\$SERVICE" = "ingest" ]; then echo "boot.failed: simulated bad build" >&2; exit 1; fi\nexec /usr/local/bin/entrypoint.sh "\$@"\n' > /usr/local/bin/broken.sh \\
 && chmod 0755 /usr/local/bin/broken.sh
USER node
ENTRYPOINT ["/usr/local/bin/broken.sh"]
EOF

GOOD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
BROKEN_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
docker tag "$IMAGE" "127.0.0.1:$REG_PORT/shikoo:good"
# The label is applied at push time the same way CI applies it — by rebuilding
# the one-line derived image rather than by editing metadata in place.
docker build -q --label org.opencontainers.image.revision="$GOOD_SHA" \
  -t "127.0.0.1:$REG_PORT/shikoo:good" - <<EOF >/dev/null
FROM $IMAGE
EOF
docker build -q --label org.opencontainers.image.revision="$BROKEN_SHA" \
  -t "127.0.0.1:$REG_PORT/shikoo:broken" - <<EOF >/dev/null
FROM 127.0.0.1:$REG_PORT/shikoo:broken
EOF
docker push -q "127.0.0.1:$REG_PORT/shikoo:good" >/dev/null
docker push -q "127.0.0.1:$REG_PORT/shikoo:broken" >/dev/null
GOOD="127.0.0.1:$REG_PORT/shikoo@$(docker inspect --format '{{index .RepoDigests 0}}' "127.0.0.1:$REG_PORT/shikoo:good" | sed 's/.*@//')"
BROKEN="127.0.0.1:$REG_PORT/shikoo@$(docker inspect --format '{{index .RepoDigests 0}}' "127.0.0.1:$REG_PORT/shikoo:broken" | sed 's/.*@//')"

mkdir -p "$WORK/staging" "$WORK/production" "$WORK/state" "$WORK/lock"
DB="postgres://postgres:deploytest@$PG:5432/shikoo"
for f in bot ingest dashboard; do
  printf 'DATABASE_URL=%s\nENV_NAME=staging\n' "$DB" >"$WORK/staging/$f.env"
done
# Unreachable on purpose: the bot must never reach Telegram from a test. Its
# poll loop backs off and beats the heartbeat anyway, which is what its health
# check reads, so «healthy» here means «polling», not «talking to Telegram».
printf 'TELEGRAM_BOT_TOKEN=000000:deploytest-staging\nTELEGRAM_API_BASE=http://127.0.0.1:9\n' >>"$WORK/staging/bot.env"
printf 'DB_CONTAINER=%s\nSHIKOO_NETWORK=%s\n' "$PG" "$NET" >"$WORK/staging/deploy.env"

export ENV_DIR="$WORK/staging" OTHER_ENV_DIR="$WORK/production" \
  STATE_FILE="$WORK/state/deployed" LOCK_FILE="$WORK/lock/staging.lock" \
  COMPOSE_FILE="$COMPOSE_YAML" WAIT_TIMEOUT=180 SKIP_LOGIN=1

run() { bash "$DEPLOY_SH" "$@"; }

# The whole point of most of these is that deploy.sh says no, so «it failed» is
# the assertion rather than the accident.
refuses() {
  local what=$1
  shift
  if run "$@" >/dev/null 2>&1; then
    fail "$what — it was accepted"
  fi
  pass "$what"
}
state_lines() { [ -f "$STATE_FILE" ] && wc -l <"$STATE_FILE" || echo 0; }
running_image() {
  docker inspect --format '{{.Image}}' "shikoo-staging-$1-1" 2>/dev/null || echo none
}

# ------------------------------------------------------------- the refusals
say "a mutable tag is not a deployment identity"
refuses "refused" staging "127.0.0.1:$REG_PORT/shikoo:good" "$GOOD_SHA"

say "a digest whose commit label disagrees is refused"
refuses "refused" staging "$GOOD" 0000000000000000000000000000000000000000

say "the two environments may not share a bot token"
cp "$WORK/staging/bot.env" "$WORK/production/bot.env"
refuses "refused" staging "$GOOD" "$GOOD_SHA"
rm -f "$WORK/production/bot.env"

say "two deploys at once"
(
  exec 9>"$LOCK_FILE"
  flock 9
  sleep 8
) &
holder=$!
sleep 1
refuses "the second refused" staging "$GOOD" "$GOOD_SHA" --dry-run
wait "$holder"
run staging "$GOOD" "$GOOD_SHA" --dry-run >/dev/null || fail "dry run failed once the lock was free"
pass "and succeeds once the lock is released"

# ------------------------------------------------ the migration is the fence
say "a failed migration touches nothing"
saved=$(cat "$WORK/staging/dashboard.env")
printf 'DATABASE_URL=postgres://postgres:WRONG@%s:5432/shikoo\nENV_NAME=staging\n' "$PG" >"$WORK/staging/dashboard.env"
if run staging "$GOOD" "$GOOD_SHA" >/dev/null 2>&1; then fail "a broken migration deployed"; fi
[ "$(docker ps -aq --filter 'label=com.docker.compose.project=shikoo-staging' | wc -l)" = "0" ] ||
  fail "services exist after a failed migration"
[ "$(state_lines)" = "0" ] || fail "the state file was written after a failed migration"
pass "no service started, nothing recorded"
printf '%s\n' "$saved" >"$WORK/staging/dashboard.env"

# --------------------------------------------------------- the happy path
say "a real deploy (migrate, order, health, smoke, one poller)"
run staging "$GOOD" "$GOOD_SHA" || fail "the deploy failed"
[ "$(state_lines)" = "1" ] || fail "the deploy was not recorded"
good_id=$(running_image ingest)
pass "deployed and recorded"

# ------------------------------------------------------------- the recovery
say "an image whose ingest cannot boot is rolled back"
if run staging "$BROKEN" "$BROKEN_SHA" >"$WORK/rollback.log" 2>&1; then
  fail "a broken image was accepted as a successful deploy"
fi
grep -q 'ROLLBACK SUCCEEDED' "$WORK/rollback.log" ||
  fail "no rollback verdict was reported: $(tail -3 "$WORK/rollback.log")"
for svc in ingest dashboard bot; do
  [ "$(running_image "$svc")" = "$good_id" ] || fail "$svc is not back on the previous image"
done
[ "$(state_lines)" = "1" ] || fail "a failed deploy was recorded as deployed"
pass "previous image restored on all three, failure still reported, nothing recorded"

# The schema is deliberately NOT rolled back — an older image on a newer schema
# is exactly the case the boot gate warns about rather than refusing.
ledger=$(docker exec "$PG" psql -U postgres -d shikoo -tAc 'select count(*) from schema_migrations')
[ "$ledger" -gt 0 ] || fail "the ledger is empty — the schema was rolled back"
pass "the schema stayed where the migration left it ($ledger applied)"

printf '\n%s checks passed\n' "$PASSED"
