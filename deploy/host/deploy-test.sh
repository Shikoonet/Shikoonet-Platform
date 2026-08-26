#!/usr/bin/env bash
# What deploy.sh promises, proved against a real database and a fake Coolify.
#
#   deploy/host/deploy-test.sh <image-tag>       # default: shikoo-ci
#
# Everything deploy.sh is for is a refusal or a recovery, and neither shows up
# in a green deploy. Those paths only ever run on the worst day, which is the
# worst day to discover they were written wrong.
#
# ## What is faked, and what is not
#
# The database is real, the image is real, the registry is real, and the
# migration really runs. What is faked is the Coolify API — a few dozen lines
# of node that answers the four calls deploy.sh makes and records what it was
# asked for. That boundary is deliberate: a fake that also started containers
# would be a reimplementation of Coolify, and a test of a reimplementation
# proves nothing about the real one.
#
# So this covers the argument handling, the digest and revision checks, the
# lock, the environment configuration, and — the one that matters most — that
# a failed migration stops the deploy before any application is touched.
#
# It does NOT cover the deploy-and-rollback path end to end; that needs a real
# Coolify. Run it there with --dry-run first, then for real, and watch it.
set -Eeuo pipefail

IMAGE=${1:-shikoo-ci}

# shellcheck disable=SC1007  # `CDPATH= cd` is the idiom, not a typo: it blanks
# CDPATH for this one command so `cd` cannot print a different directory.
REPO_ROOT="${REPO_ROOT:-$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)}"
DEPLOY_SH="$REPO_ROOT/deploy/host/deploy.sh"

NET=deploytest-net
PG=deploytest-pg
REG=deploytest-registry
REG_PORT=5599
API_PORT=5598
WORK=$(mktemp -d)
API_PID=""
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
  [ -z "$API_PID" ] || kill "$API_PID" 2>/dev/null
  docker rm -f "$PG" "$REG" >/dev/null 2>&1
  docker rmi "127.0.0.1:$REG_PORT/shikoo:good" >/dev/null 2>&1
  docker network rm "$NET" >/dev/null 2>&1
  rm -rf "$WORK"
}
trap cleanup EXIT

say "setting up a throwaway environment"
docker image inspect "$IMAGE" >/dev/null 2>&1 || fail "no image '$IMAGE' — build it first, or pass a tag"
docker network create "$NET" >/dev/null
docker run -d --name "$PG" --network "$NET" \
  -e POSTGRES_PASSWORD=deploytest -e POSTGRES_DB=shikoo postgres:16 >/dev/null
docker run -d --name "$REG" --network "$NET" -p "127.0.0.1:$REG_PORT:5000" registry:2 >/dev/null
until docker exec "$PG" pg_isready -U postgres >/dev/null 2>&1; do sleep 1; done

GOOD_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
docker build -q --label org.opencontainers.image.revision="$GOOD_SHA" \
  -t "127.0.0.1:$REG_PORT/shikoo:good" - <<EOF >/dev/null
FROM $IMAGE
EOF
docker push -q "127.0.0.1:$REG_PORT/shikoo:good" >/dev/null
GOOD="127.0.0.1:$REG_PORT/shikoo@$(docker inspect --format '{{index .RepoDigests 0}}' "127.0.0.1:$REG_PORT/shikoo:good" | sed 's/.*@//')"

# --------------------------------------------------------- the fake Coolify
# Answers only what deploy.sh asks, and writes every PATCH to a file so the
# test can assert WHAT was requested — which is the whole point of the
# digest-deploy change.
cat > "$WORK/fake-coolify.mjs" <<'JS'
import { createServer } from 'node:http';
import { appendFileSync } from 'node:fs';
const [, , port, dbUrl, log] = process.argv;
const TOKEN = 'test-token';
createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    res.writeHead(401).end('{"message":"unauthenticated"}');
    return;
  }
  const url = new URL(req.url, 'http://x');
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    appendFileSync(log, `${req.method} ${url.pathname}${url.search} ${body}\n`);
    if (url.pathname.endsWith('/envs')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify([{ key: 'DATABASE_URL', value: dbUrl }]));
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"message":"ok"}');
  });
}).listen(Number(port), '127.0.0.1');
JS

DB="postgres://postgres:deploytest@$PG:5432/shikoo"
node "$WORK/fake-coolify.mjs" "$API_PORT" "$DB" "$WORK/api.log" &
API_PID=$!
until curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/v1/ping"; do sleep 0.2; done

mkdir -p "$WORK/staging" "$WORK/state" "$WORK/lock"
cat > "$WORK/staging/deploy.env" <<EOF
COOLIFY_URL=http://127.0.0.1:$API_PORT
COOLIFY_TOKEN=test-token
APP_INGEST=uuid-ingest
APP_DASHBOARD=uuid-dashboard
APP_BOT=uuid-bot
DB_CONTAINER=$PG
EOF

export ENV_DIR="$WORK/staging" STATE_FILE="$WORK/state/deployed" \
  LOCK_FILE="$WORK/lock/staging.lock" NETWORK="$NET" WAIT_TIMEOUT=20

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

# ------------------------------------------------------------- the refusals
say "a mutable tag is not a deployment identity"
refuses "refused" staging "127.0.0.1:$REG_PORT/shikoo:good" "$GOOD_SHA"

say "a digest whose commit label disagrees is refused"
refuses "refused" staging "$GOOD" 0000000000000000000000000000000000000000

say "an environment name outside the two is refused"
refuses "refused" prod "$GOOD" "$GOOD_SHA"

say "a short commit sha is refused"
refuses "refused" staging "$GOOD" aaaaaaa

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

# ------------------------------------------------------------- the dry run
say "a dry run verifies and stops"
run staging "$GOOD" "$GOOD_SHA" --dry-run >"$WORK/dry.log" 2>&1 || fail "the dry run failed"
grep -q 'dry_run=ok' "$WORK/dry.log" || fail "no dry_run verdict"
[ "$(state_lines)" = "0" ] || fail "a dry run wrote to the state file"
grep -q 'GET /api/v1/applications/uuid-bot' "$WORK/api.log" || fail "the dry run did not address all three applications"
grep -q 'PATCH' "$WORK/api.log" && fail "a dry run changed an application"
pass "verified all three, changed nothing, recorded nothing"

# ------------------------------------------------ the migration is the fence
say "a failed migration touches no application"
: >"$WORK/api.log"
kill "$API_PID" 2>/dev/null || true
node "$WORK/fake-coolify.mjs" "$API_PORT" \
  "postgres://postgres:WRONG@$PG:5432/shikoo" "$WORK/api.log" &
API_PID=$!
until curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/v1/ping"; do sleep 0.2; done
if run staging "$GOOD" "$GOOD_SHA" >"$WORK/mig.log" 2>&1; then
  fail "a broken migration deployed"
fi
grep -q 'migration=FAILED' "$WORK/mig.log" || fail "no migration verdict"
grep -q 'services=untouched' "$WORK/mig.log" || fail "did not report services untouched"
grep -q 'PATCH' "$WORK/api.log" && fail "an application was changed despite the migration failing"
[ "$(state_lines)" = "0" ] || fail "the state file was written after a failed migration"
pass "no application touched, nothing recorded"

# --------------------------------------------- the digest reaches the API
say "the digest is what gets written to Coolify"
: >"$WORK/api.log"
kill "$API_PID" 2>/dev/null || true
node "$WORK/fake-coolify.mjs" "$API_PORT" "$DB" "$WORK/api.log" &
API_PID=$!
until curl -s -o /dev/null "http://127.0.0.1:$API_PORT/api/v1/ping"; do sleep 0.2; done
# Health can never go green here — nothing starts containers — so this is
# expected to fail at the wait. What is asserted is the request that was made
# before it got there.
run staging "$GOOD" "$GOOD_SHA" >"$WORK/deploy.log" 2>&1 || true
hex=${GOOD##*@sha256:}
grep -q "\"docker_registry_image_tag\":\"sha256-$hex\"" "$WORK/api.log" ||
  fail "the PATCH did not carry sha256-<digest>"
grep -q '"build_pack":"dockerimage"' "$WORK/api.log" ||
  fail "the PATCH did not set build_pack=dockerimage"
grep -q 'POST /api/v1/deploy?uuid=uuid-ingest' "$WORK/api.log" ||
  fail "ingest was not deployed first"
pass "build_pack=dockerimage and the digest, ingest first"

# Coolify injects SOURCE_COMMIT only for git builds, so without this the
# deployed services answer /version with the literal string `dev` and the
# smoke test's premise disappears.
say "the deployed commit is written as APP_VERSION"
grep -q "\"key\":\"APP_VERSION\",\"value\":\"$GOOD_SHA\"" "$WORK/api.log" ||
  fail "APP_VERSION was not set to the deployed sha"
pass "APP_VERSION=$GOOD_SHA"

say "and a failure after that point reports a verdict"
grep -qE 'verdict=(DEPLOY FAILED|MANUAL INTERVENTION)' "$WORK/deploy.log" ||
  fail "a failed deploy produced no verdict: $(tail -3 "$WORK/deploy.log")"
[ "$(state_lines)" = "0" ] || fail "a failed deploy was recorded as deployed"
pass "failure reported, nothing recorded"

printf '\n%s checks passed\n' "$PASSED"
printf 'not covered here (needs a real Coolify): the deploy-and-rollback path end to end.\n'
