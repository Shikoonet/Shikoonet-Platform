#!/usr/bin/env bash
# Exercise the customer-visible script as one transaction: domain movement,
# exact bot handover, and recovery of the retained old container.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/cutover-production.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

OLD_INGEST='aaaaaaaaaaaaaaaaaaaaaaa1'
OLD_DASHBOARD='aaaaaaaaaaaaaaaaaaaaaaa2'
OLD_BOT='aaaaaaaaaaaaaaaaaaaaaaa3'
CAND_INGEST='bbbbbbbbbbbbbbbbbbbbbbb1'
CAND_DASHBOARD='bbbbbbbbbbbbbbbbbbbbbbb2'
CAND_BOT='bbbbbbbbbbbbbbbbbbbbbbb3'
SHA='1111111111111111111111111111111111111111'
DIGEST='sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a'
IMAGE='ghcr.io/shikoonet/shikoonet-platform'
SECRET_TOKEN='0|CUTOVER-SCRIPT-TOKEN-MUST-NOT-PRINT'
SECRET_DB='postgres://shikoo:CUTOVER-SCRIPT-DB-MUST-NOT-PRINT@postgres:5432/shikoo'

CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://coolify.test
COOLIFY_TOKEN=$SECRET_TOKEN
APP_INGEST=$OLD_INGEST
APP_DASHBOARD=$OLD_DASHBOARD
APP_BOT=$OLD_BOT
EOF

APP_JSON="$WORK/app.json"
ENV_JSON="$WORK/envs.json"
cat >"$APP_JSON" <<EOF
{"uuid":"$CAND_BOT","build_pack":"dockerimage","docker_registry_image_name":"$IMAGE","docker_registry_image_tag":"sha256-${DIGEST#sha256:}"}
EOF
cat >"$ENV_JSON" <<EOF
[
  {"uuid":"e1","key":"ENV_NAME","value":"production","is_preview":false},
  {"uuid":"e2","key":"SERVICE","value":"bot","is_preview":false},
  {"uuid":"e3","key":"DATABASE_URL","value":"$SECRET_DB","is_preview":false},
  {"uuid":"e4","key":"APP_VERSION","value":"$SHA","is_preview":false},
  {"uuid":"p1","key":"ENV_NAME","value":"production","is_preview":true},
  {"uuid":"p2","key":"SERVICE","value":"bot","is_preview":true},
  {"uuid":"p3","key":"DATABASE_URL","value":"$SECRET_DB","is_preview":true}
]
EOF

BIN="$WORK/bin"
mkdir -p "$BIN"

cat >"$BIN/sleep" <<'FAKE'
#!/usr/bin/env bash
exit 0
FAKE
chmod +x "$BIN/sleep"

cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail

method=GET
has_stdin=0
previous=''
for argument in "$@"; do
  if [ "$previous" = '-X' ]; then method=$argument; fi
  [ "$argument" = '@-' ] && has_stdin=1
  previous=$argument
done
url=${*: -1}
body=''
[ "$has_stdin" = 0 ] || body=$(cat)

case "$url" in
  http://coolify.test/api/v1/*)
    path=${url#http://coolify.test/api/v1}
    printf '%s %s %s\n' "$method" "$path" "$body" >>"$FAKE_API_LOG"
    case "$method $path" in
      "GET /applications/$FAKE_CAND_BOT") cat "$FAKE_APP_JSON"; printf '200' ;;
      "GET /applications/$FAKE_CAND_BOT/envs") cat "$FAKE_ENV_JSON"; printf '200' ;;
      "POST /applications/$FAKE_CAND_BOT/start")
        printf '1\n' >"$FAKE_STATE/candidate-running"
        printf '%s\n' "${FAKE_START_LOCK:-1}" >"$FAKE_STATE/locks"
        printf '{"message":"Deployment request queued.","deployment_uuid":"deploy123"}200'
        ;;
      "POST /applications/$FAKE_CAND_BOT/stop")
        printf '0\n' >"$FAKE_STATE/candidate-running"
        printf '0\n' >"$FAKE_STATE/locks"
        printf '{"message":"Application stopping request queued."}200'
        ;;
      "POST /deployments/deploy123/cancel")
        printf '{"message":"Deployment cannot be cancelled. Current status: finished"}400'
        ;;
      # A restart of a Docker Image application is a queued redeploy; the fake
      # answers as Coolify does and lets the next `docker ps` show the
      # replacement container — unless the case says the roll never lands.
      "POST /applications/$FAKE_CAND_INGEST/restart")
        [ "${FAKE_RELABEL_FAILS:-0}" = 1 ] || printf '1\n' >"$FAKE_STATE/cand-ingest-relabelled"
        printf '{"message":"Restart request queued.","deployment_uuid":"web-deploy-ingest"}200'
        ;;
      "POST /applications/$FAKE_CAND_DASHBOARD/restart")
        [ "${FAKE_RELABEL_FAILS:-0}" = 1 ] || printf '1\n' >"$FAKE_STATE/cand-dashboard-relabelled"
        printf '{"message":"Restart request queued.","deployment_uuid":"web-deploy-dashboard"}200'
        ;;
      "POST /deployments/web-deploy-ingest/cancel" | "POST /deployments/web-deploy-dashboard/cancel")
        printf '{"message":"Deployment cannot be cancelled. Current status: finished"}400'
        ;;
      PATCH\ /applications/*) printf '{}200' ;;
      *) printf '{"message":"not found"}404' ;;
    esac
    ;;
  https://sms.chopon.uk/health | https://shikoo.chopon.uk/api/v1/health)
    printf '200'
    ;;
  https://sms.chopon.uk/version)
    printf '{"version":"%s"}' "$FAKE_SHA"
    ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$BIN/curl"

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail

command=${1:-}
shift || true
case "$command" in
  exec)
    [ "${1:-}" != '-i' ] || shift
    container=${1:-}
    if [ "$container" = 'coolify-db' ]; then
      printf 'pg-production\n'
    elif [ "$container" = 'pg-production' ]; then
      cat "$FAKE_STATE/locks"
    else
      exit 1
    fi
    ;;
  ps)
    filter=''
    previous=''
    for argument in "$@"; do
      [ "$previous" != '--filter' ] || filter=$argument
      previous=$argument
    done
    case "$filter" in
      "label=coolify.name=$FAKE_OLD_BOT")
        if [ "$(cat "$FAKE_STATE/old-running")" = 1 ]; then
          printf 'old-bot-cid\n'
          [ "${FAKE_OLD_COUNT:-1}" != 2 ] || printf 'old-bot-cid-2\n'
        fi
        ;;
      "label=coolify.name=$FAKE_CAND_BOT")
        [ "$(cat "$FAKE_STATE/candidate-running")" != 1 ] || printf 'candidate-bot-cid\n'
        ;;
      'id=old-bot-cid')
        [ "$(cat "$FAKE_STATE/old-running")" != 1 ] || printf 'old-bot-cid\n'
        ;;
      # The web tier. Each old application has one container until it is
      # stopped; each candidate answers `-next` until its redeploy lands, after
      # which the replacement carries the live name.
      "label=coolify.name=$FAKE_OLD_INGEST")
        [ "$(cat "$FAKE_STATE/old-ingest-running")" != 1 ] || printf 'old-ingest-cid\n'
        ;;
      "label=coolify.name=$FAKE_OLD_DASHBOARD")
        [ "$(cat "$FAKE_STATE/old-dashboard-running")" != 1 ] || printf 'old-dashboard-cid\n'
        ;;
      "label=coolify.name=$FAKE_CAND_INGEST")
        if [ "$(cat "$FAKE_STATE/cand-ingest-relabelled")" = 1 ]; then
          [ "$(cat "$FAKE_STATE/cand-ingest-live-stopped")" = 1 ] || printf 'cand-ingest-live-cid\n'
        else
          printf 'cand-ingest-next-cid\n'
        fi
        ;;
      "label=coolify.name=$FAKE_CAND_DASHBOARD")
        if [ "$(cat "$FAKE_STATE/cand-dashboard-relabelled")" = 1 ]; then
          [ "$(cat "$FAKE_STATE/cand-dashboard-live-stopped")" = 1 ] || printf 'cand-dashboard-live-cid\n'
        else
          printf 'cand-dashboard-next-cid\n'
        fi
        ;;
    esac
    ;;
  stop)
    target=${*: -1}
    case "$target" in
      old-bot-cid)
        printf '0\n' >"$FAKE_STATE/old-running"
        printf '0\n' >"$FAKE_STATE/locks"
        ;;
      old-ingest-cid) printf '0\n' >"$FAKE_STATE/old-ingest-running" ;;
      old-dashboard-cid) printf '0\n' >"$FAKE_STATE/old-dashboard-running" ;;
      cand-ingest-live-cid) printf '1\n' >"$FAKE_STATE/cand-ingest-live-stopped" ;;
      cand-dashboard-live-cid) printf '1\n' >"$FAKE_STATE/cand-dashboard-live-stopped" ;;
      *) exit 1 ;;
    esac
    printf 'stop %s\n' "$target" >>"$FAKE_DOCKER_LOG"
    printf '%s\n' "$target"
    ;;
  start)
    target=${1:-}
    case "$target" in
      old-bot-cid)
        printf '1\n' >"$FAKE_STATE/old-running"
        printf '1\n' >"$FAKE_STATE/locks"
        ;;
      old-ingest-cid) printf '1\n' >"$FAKE_STATE/old-ingest-running" ;;
      old-dashboard-cid) printf '1\n' >"$FAKE_STATE/old-dashboard-running" ;;
      *) exit 1 ;;
    esac
    printf 'start %s\n' "$target" >>"$FAKE_DOCKER_LOG"
    printf '%s\n' "$target"
    ;;
  inspect)
    format=''
    previous=''
    for argument in "$@"; do
      [ "$previous" != '--format' ] || format=$argument
      previous=$argument
    done
    subject=${*: -1}
    case "$format" in
      '{{.Image}}') printf '%s-image\n' "$subject" ;;
      *RepoDigests*)
        # Only the bot's image can be made to run the wrong bytes: the recovery
        # cases below exercise the handover, not the web relabel.
        case "$subject" in
          candidate-bot-cid-image) printf '%s@%s\n' "$FAKE_IMAGE" "${FAKE_RUNTIME_DIGEST:-$FAKE_DIGEST}" ;;
          *) printf '%s@%s\n' "$FAKE_IMAGE" "$FAKE_DIGEST" ;;
        esac
        ;;
      *Config.Env*) printf '["ENV_NAME=production","SERVICE=bot","APP_VERSION=%s","DATABASE_URL=hidden"]\n' "$FAKE_SHA" ;;
      *State.Status*) printf 'running healthy\n' ;;
      *Config.Labels*)
        # The labels Coolify wrote into each container at creation — what
        # Traefik routes by. The candidates' replacements carry the live name;
        # their `-next` containers and the old containers carry what they
        # were created with.
        case "$subject" in
          cand-ingest-live-cid | old-ingest-cid)
            printf '{"traefik.http.routers.https-0-x.rule":"Host(`sms.chopon.uk`) \u0026\u0026 PathPrefix(`/`)"}\n' ;;
          cand-dashboard-live-cid | old-dashboard-cid)
            printf '{"traefik.http.routers.https-0-x.rule":"Host(`shikoo.chopon.uk`) \u0026\u0026 PathPrefix(`/`)"}\n' ;;
          cand-ingest-next-cid)
            printf '{"traefik.http.routers.https-0-x.rule":"Host(`sms-next.chopon.uk`) \u0026\u0026 PathPrefix(`/`)"}\n' ;;
          cand-dashboard-next-cid)
            printf '{"traefik.http.routers.https-0-x.rule":"Host(`shikoo-next.chopon.uk`) \u0026\u0026 PathPrefix(`/`)"}\n' ;;
          *) printf '{}\n' ;;
        esac
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$BIN/docker"

export FAKE_OLD_BOT="$OLD_BOT" FAKE_CAND_BOT="$CAND_BOT"
export FAKE_OLD_INGEST="$OLD_INGEST" FAKE_OLD_DASHBOARD="$OLD_DASHBOARD"
export FAKE_CAND_INGEST="$CAND_INGEST" FAKE_CAND_DASHBOARD="$CAND_DASHBOARD"
export FAKE_APP_JSON="$APP_JSON" FAKE_ENV_JSON="$ENV_JSON"
export FAKE_SHA="$SHA" FAKE_DIGEST="$DIGEST" FAKE_IMAGE="$IMAGE"

make_case() { # name
  local dir="$WORK/$1"
  mkdir -p "$dir/state"
  printf '1\n' >"$dir/old-running"
  printf '0\n' >"$dir/candidate-running"
  printf '1\n' >"$dir/locks"
  for role in ingest dashboard; do
    printf '1\n' >"$dir/old-${role}-running"
    printf '0\n' >"$dir/cand-${role}-relabelled"
    printf '0\n' >"$dir/cand-${role}-live-stopped"
  done
  : >"$dir/api.log"
  : >"$dir/docker.log"
  cat >"$dir/state/preparation.env" <<EOF
main_sha=$SHA
digest=$DIGEST
candidate_ingest=$CAND_INGEST
candidate_dashboard=$CAND_DASHBOARD
candidate_bot=$CAND_BOT
bot_advisory_locks=1
bot_handover_mode=replace-single
EOF
  ( cd "$dir/state" && sha256sum preparation.env >preparation.sha256 )
  printf '%s\n' "$dir"
}

run_cutover_mode() { # case-dir output handover-mode [extra env]
  local dir="$1" output="$2" handover_mode="$3"
  shift 3
  set +e
  env PATH="$BIN:$PATH" CONF="$CONF" STATE="$dir/state" IMAGE_NAME="$IMAGE" WAIT_TIMEOUT=5 \
    FAKE_STATE="$dir" FAKE_API_LOG="$dir/api.log" FAKE_DOCKER_LOG="$dir/docker.log" \
    "$@" bash "$SCRIPT" "$SHA" "$DIGEST" \
    "$CAND_INGEST" "$CAND_DASHBOARD" "$CAND_BOT" "$handover_mode" >"$output" 2>&1
  local rc=$?
  set -e
  return $rc
}

run_cutover() { # case-dir output [extra env]
  local dir=$1 output=$2
  shift 2
  run_cutover_mode "$dir" "$output" replace-single "$@"
}

section 'successful cutover'

HAPPY=$(make_case happy)
HAPPY_OUT="$HAPPY/output.log"
if run_cutover "$HAPPY" "$HAPPY_OUT"; then
  ok 'the prepared web candidates and bot cut over as one release'
else
  bad 'the prepared web candidates and bot cut over as one release' "$(tail -8 "$HAPPY_OUT")"
fi

if grep -qF "PATCH /applications/$CAND_INGEST {\"domains\": \"https://sms.chopon.uk\"}" "$HAPPY/api.log" &&
  grep -qF "PATCH /applications/$CAND_DASHBOARD {\"domains\": \"https://shikoo.chopon.uk\"}" "$HAPPY/api.log"; then
  ok 'both live domains move onto the candidates'
else
  bad 'both live domains move onto the candidates' "$(tail -8 "$HAPPY/api.log")"
fi

# The record is not the route. Traefik reads container labels, so a domain
# PATCH alone leaves the old container answering the live name; the candidates
# have to be redeployed onto their new labels and the old containers stopped —
# in that order, and only after the records moved.
moved=$(grep -n 'records moved' "$HAPPY_OUT" | head -1 | cut -d: -f1)
relabelled=$(grep -n 'dashboard: replacement' "$HAPPY_OUT" | head -1 | cut -d: -f1)
retained=$(grep -n 'stopped and retained' "$HAPPY_OUT" | head -1 | cut -d: -f1)
if grep -qF "POST /applications/$CAND_INGEST/restart" "$HAPPY/api.log" &&
  grep -qF "POST /applications/$CAND_DASHBOARD/restart" "$HAPPY/api.log" &&
  grep -qF 'stop old-ingest-cid' "$HAPPY/docker.log" &&
  grep -qF 'stop old-dashboard-cid' "$HAPPY/docker.log" &&
  [ "$(cat "$HAPPY/cand-ingest-live-stopped")" = 0 ] &&
  [ "$(cat "$HAPPY/cand-dashboard-live-stopped")" = 0 ] &&
  [ -n "$moved" ] && [ -n "$relabelled" ] && [ -n "$retained" ] &&
  [ "$moved" -lt "$relabelled" ] && [ "$relabelled" -lt "$retained" ]; then
  ok 'the candidates are redeployed onto the live names, then the old web containers are stopped and kept'
else
  bad 'the candidates are redeployed onto the live names, then the old web containers are stopped and kept' \
    "moved=$moved relabelled=$relabelled retained=$retained docker=$(tr '\n' ' ' <"$HAPPY/docker.log")"
fi

if grep -qF 'stop old-bot-cid' "$HAPPY/docker.log" &&
  grep -qF "POST /applications/$CAND_BOT/start" "$HAPPY/api.log" &&
  ! grep -Eq "POST /applications/$OLD_BOT/(start|stop)" "$HAPPY/api.log"; then
  ok 'handover retains the exact old container and starts only the pinned candidate through Coolify'
else
  bad 'handover retains the exact old container and starts only the pinned candidate through Coolify' \
    "docker=$(tr '\n' ' ' <"$HAPPY/docker.log") api=$(tr '\n' ' ' <"$HAPPY/api.log")"
fi

if [ "$(cat "$HAPPY/old-running")" = 0 ] &&
  [ "$(cat "$HAPPY/candidate-running")" = 1 ] &&
  [ "$(cat "$HAPPY/locks")" = 1 ] &&
  grep -qF "$DIGEST $SHA promoted-by-hand" "$HAPPY/state/deployed" &&
  grep -qF "app_ingest=$CAND_INGEST" "$HAPPY/state/current-applications.env" &&
  grep -qF "app_dashboard=$CAND_DASHBOARD" "$HAPPY/state/current-applications.env" &&
  grep -qF "app_bot=$CAND_BOT" "$HAPPY/state/current-applications.env"; then
  ok 'success records one candidate poller and the immutable release ledger'
else
  bad 'success records one candidate poller and the immutable release ledger' "$(tail -8 "$HAPPY_OUT")"
fi

section 'first-poller bootstrap and recovery'

BOOTSTRAP=$(make_case bootstrap)
printf '0\n' >"$BOOTSTRAP/old-running"
printf '0\n' >"$BOOTSTRAP/locks"
sed -i 's/^bot_advisory_locks=.*/bot_advisory_locks=0/;s/^bot_handover_mode=.*/bot_handover_mode=bootstrap-empty/' \
  "$BOOTSTRAP/state/preparation.env"
( cd "$BOOTSTRAP/state" && sha256sum preparation.env >preparation.sha256 )
BOOTSTRAP_OUT="$BOOTSTRAP/output.log"
if run_cutover_mode "$BOOTSTRAP" "$BOOTSTRAP_OUT" bootstrap-empty; then
  ok 'a manifest-bound empty baseline starts the first production poller'
else
  bad 'a manifest-bound empty baseline starts the first production poller' "$(tail -10 "$BOOTSTRAP_OUT")"
fi
if [ "$(cat "$BOOTSTRAP/old-running")" = 0 ] &&
  [ "$(cat "$BOOTSTRAP/candidate-running")" = 1 ] &&
  [ "$(cat "$BOOTSTRAP/locks")" = 1 ] &&
  ! grep -qF 'stop old-bot-cid' "$BOOTSTRAP/docker.log" &&
  grep -qF "app_bot=$CAND_BOT" "$BOOTSTRAP/state/current-applications.env"; then
  ok 'bootstrap starts only the prepared candidate and adopts its UUID'
else
  bad 'bootstrap starts only the prepared candidate and adopts its UUID' "$(tail -10 "$BOOTSTRAP_OUT")"
fi

BOOTSTRAP_RECOVERY=$(make_case bootstrap-recovery)
printf '0\n' >"$BOOTSTRAP_RECOVERY/old-running"
printf '0\n' >"$BOOTSTRAP_RECOVERY/locks"
sed -i 's/^bot_advisory_locks=.*/bot_advisory_locks=0/;s/^bot_handover_mode=.*/bot_handover_mode=bootstrap-empty/' \
  "$BOOTSTRAP_RECOVERY/state/preparation.env"
( cd "$BOOTSTRAP_RECOVERY/state" && sha256sum preparation.env >preparation.sha256 )
BOOTSTRAP_RECOVERY_OUT="$BOOTSTRAP_RECOVERY/output.log"
if run_cutover_mode "$BOOTSTRAP_RECOVERY" "$BOOTSTRAP_RECOVERY_OUT" bootstrap-empty \
  FAKE_RUNTIME_DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; then
  bad 'a failed bootstrap candidate restores the empty baseline' 'the mismatched candidate was accepted'
elif grep -qF 'domains were restored and the prior zero-poller state remains' "$BOOTSTRAP_RECOVERY_OUT" &&
  [ "$(cat "$BOOTSTRAP_RECOVERY/old-running")" = 0 ] &&
  [ "$(cat "$BOOTSTRAP_RECOVERY/candidate-running")" = 0 ] &&
  [ "$(cat "$BOOTSTRAP_RECOVERY/locks")" = 0 ] &&
  [ ! -e "$BOOTSTRAP_RECOVERY/state/current-applications.env" ]; then
  ok 'a failed bootstrap restores domains, no candidate and zero pollers'
else
  bad 'a failed bootstrap restores domains, no candidate and zero pollers' "$(tail -12 "$BOOTSTRAP_RECOVERY_OUT")"
fi

section 'runtime mismatch recovery'

RECOVERY=$(make_case recovery)
RECOVERY_OUT="$RECOVERY/output.log"
if run_cutover "$RECOVERY" "$RECOVERY_OUT" \
  FAKE_RUNTIME_DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; then
  bad 'a candidate running different bytes fails the cutover' 'the release was recorded'
elif grep -qF 'domains and the original single bot poller were restored' "$RECOVERY_OUT"; then
  ok 'a candidate running different bytes fails after an observed recovery'
else
  bad 'a candidate running different bytes fails after an observed recovery' "$(tail -10 "$RECOVERY_OUT")"
fi

if grep -qF 'POST /deployments/deploy123/cancel' "$RECOVERY/api.log" &&
  grep -qF "POST /applications/$CAND_BOT/stop" "$RECOVERY/api.log" &&
  grep -qF 'start old-bot-cid' "$RECOVERY/docker.log"; then
  ok 'recovery cancels the candidate deployment, stops it, and restarts exact old bytes'
else
  bad 'recovery cancels the candidate deployment, stops it, and restarts exact old bytes' \
    "docker=$(tr '\n' ' ' <"$RECOVERY/docker.log") api=$(tr '\n' ' ' <"$RECOVERY/api.log")"
fi

if grep -qF "PATCH /applications/$OLD_INGEST {\"domains\": \"https://sms.chopon.uk\"}" "$RECOVERY/api.log" &&
  grep -qF "PATCH /applications/$OLD_DASHBOARD {\"domains\": \"https://shikoo.chopon.uk\"}" "$RECOVERY/api.log" &&
  [ "$(cat "$RECOVERY/old-running")" = 1 ] &&
  [ "$(cat "$RECOVERY/candidate-running")" = 0 ] &&
  [ "$(cat "$RECOVERY/locks")" = 1 ] &&
  [ ! -e "$RECOVERY/state/deployed" ]; then
  ok 'recovery restores domains and exactly one old poller without recording the failed release'
else
  bad 'recovery restores domains and exactly one old poller without recording the failed release' "$(tail -10 "$RECOVERY_OUT")"
fi

# By the time the bot fails, the old web containers are stopped and the
# candidates own the live names. Restoring the records alone would leave
# customers on containers that no longer exist for the proxy.
if grep -qF 'start old-ingest-cid' "$RECOVERY/docker.log" &&
  grep -qF 'start old-dashboard-cid' "$RECOVERY/docker.log" &&
  grep -qF 'stop cand-ingest-live-cid' "$RECOVERY/docker.log" &&
  grep -qF 'stop cand-dashboard-live-cid' "$RECOVERY/docker.log" &&
  grep -qF 'POST /deployments/web-deploy-ingest/cancel' "$RECOVERY/api.log" &&
  [ "$(cat "$RECOVERY/old-ingest-running")" = 1 ] &&
  [ "$(cat "$RECOVERY/old-dashboard-running")" = 1 ] &&
  [ "$(cat "$RECOVERY/cand-ingest-live-stopped")" = 1 ] &&
  [ "$(cat "$RECOVERY/cand-dashboard-live-stopped")" = 1 ]; then
  ok 'recovery starts the retained old web containers and stops every candidate container holding a live name'
else
  bad 'recovery starts the retained old web containers and stops every candidate container holding a live name' \
    "docker=$(tr '\n' ' ' <"$RECOVERY/docker.log") api=$(grep -c cancel "$RECOVERY/api.log")"
fi

section 'a candidate that never takes the live name'

# The redeploy is queued and nothing comes back carrying the name. Customers
# must still be on the old containers: nothing stopped, no bot touched, no
# release recorded, records returned.
RELABEL=$(make_case relabel)
RELABEL_OUT="$RELABEL/output.log"
if run_cutover "$RELABEL" "$RELABEL_OUT" FAKE_RELABEL_FAILS=1; then
  bad 'a candidate that never answers the live name fails the cutover' 'the release was recorded'
elif grep -qF 'candidate ingest never answered sms.chopon.uk' "$RELABEL_OUT" &&
  grep -qF "PATCH /applications/$OLD_INGEST {\"domains\": \"https://sms.chopon.uk\"}" "$RELABEL/api.log" &&
  grep -qF "PATCH /applications/$OLD_DASHBOARD {\"domains\": \"https://shikoo.chopon.uk\"}" "$RELABEL/api.log" &&
  ! grep -qF 'stop old-ingest-cid' "$RELABEL/docker.log" &&
  ! grep -qF 'stop old-bot-cid' "$RELABEL/docker.log" &&
  ! grep -qF "POST /applications/$CAND_BOT/start" "$RELABEL/api.log" &&
  [ "$(cat "$RELABEL/old-ingest-running")" = 1 ] &&
  [ "$(cat "$RELABEL/old-running")" = 1 ] &&
  [ ! -e "$RELABEL/state/deployed" ] &&
  [ ! -e "$RELABEL/state/current-applications.env" ]; then
  ok 'a candidate that never answers the live name leaves customers on the old containers'
else
  bad 'a candidate that never answers the live name leaves customers on the old containers' \
    "$(tail -6 "$RELABEL_OUT") docker=$(tr '\n' ' ' <"$RELABEL/docker.log")"
fi

section 'pre-move refusal and redaction'

MULTIPLE=$(make_case multiple)
MULTIPLE_OUT="$MULTIPLE/output.log"
if run_cutover "$MULTIPLE" "$MULTIPLE_OUT" FAKE_OLD_COUNT=2; then
  bad 'two current bot containers are refused before a domain moves' 'the cutover continued'
elif grep -qF 'current bot has 2 running containers' "$MULTIPLE_OUT" && [ ! -s "$MULTIPLE/api.log" ]; then
  ok 'two current bot containers are refused before a domain moves'
else
  bad 'two current bot containers are refused before a domain moves' "$(tail -8 "$MULTIPLE_OUT")"
fi

TAMPERED=$(make_case tampered)
TAMPERED_OUT="$TAMPERED/output.log"
printf 'candidate_bot=ccccccccccccccccccccccc3\n' >>"$TAMPERED/state/preparation.env"
if run_cutover "$TAMPERED" "$TAMPERED_OUT"; then
  bad 'a changed host ledger is refused before a domain moves' 'the checksum was ignored'
elif grep -qF 'host-side preparation ledger checksum does not verify' "$TAMPERED_OUT" &&
  [ ! -s "$TAMPERED/api.log" ] && [ ! -s "$TAMPERED/docker.log" ]; then
  ok 'a changed host ledger is refused before a domain moves'
else
  bad 'a changed host ledger is refused before a domain moves' "$(tail -8 "$TAMPERED_OUT")"
fi

DUPLICATE=$(make_case duplicate)
DUPLICATE_OUT="$DUPLICATE/output.log"
printf 'candidate_bot=ccccccccccccccccccccccc3\n' >>"$DUPLICATE/state/preparation.env"
( cd "$DUPLICATE/state" && sha256sum preparation.env >preparation.sha256 )
if run_cutover "$DUPLICATE" "$DUPLICATE_OUT"; then
  bad 'a checksum-valid host ledger with a duplicate key is refused' 'the ambiguous ledger was accepted'
elif grep -qF 'host-side preparation ledger contains a duplicate key' "$DUPLICATE_OUT" &&
  [ ! -s "$DUPLICATE/api.log" ] && [ ! -s "$DUPLICATE/docker.log" ]; then
  ok 'a checksum-valid host ledger with a duplicate key is refused before any API or Docker call'
else
  bad 'a checksum-valid host ledger with a duplicate key is refused before any API or Docker call' \
    "$(tail -8 "$DUPLICATE_OUT")"
fi

REUSED=$(make_case reused)
REUSED_OUT="$REUSED/output.log"
sed -i "s/^candidate_dashboard=.*/candidate_dashboard=$CAND_INGEST/" "$REUSED/state/preparation.env"
( cd "$REUSED/state" && sha256sum preparation.env >preparation.sha256 )
if run_cutover "$REUSED" "$REUSED_OUT"; then
  bad 'a checksum-valid host ledger that reuses a candidate is refused' 'the ambiguous roles were accepted'
elif grep -qF 'host ledger does not name three distinct candidate applications' "$REUSED_OUT" &&
  [ ! -s "$REUSED/api.log" ] && [ ! -s "$REUSED/docker.log" ]; then
  ok 'a checksum-valid host ledger that reuses a candidate is refused before any API or Docker call'
else
  bad 'a checksum-valid host ledger that reuses a candidate is refused before any API or Docker call' \
    "$(tail -8 "$REUSED_OUT")"
fi

for secret in "$SECRET_TOKEN" "$SECRET_DB"; do
  if grep -qF -- "$secret" "$HAPPY_OUT" "$RECOVERY_OUT" "$MULTIPLE_OUT" "$RELABEL_OUT" \
    "$BOOTSTRAP_OUT" "$BOOTSTRAP_RECOVERY_OUT" "$TAMPERED_OUT" "$DUPLICATE_OUT" "$REUSED_OUT" \
    "$HAPPY/api.log" "$RECOVERY/api.log" "$BOOTSTRAP/api.log" "$BOOTSTRAP_RECOVERY/api.log" \
    "$MULTIPLE/api.log" "$TAMPERED/api.log" "$DUPLICATE/api.log" "$REUSED/api.log" "$RELABEL/api.log"; then
    bad 'cutover output contains no credential' 'a fake credential was printed'
  else
    ok 'cutover output contains no credential'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
