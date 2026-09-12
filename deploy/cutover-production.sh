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
# In replace-single mode: exact old bot container stopped (but kept) → its
# advisory lock proven to be ZERO → new bot started → count proven to be ONE.
# In one-time bootstrap-empty mode the first two facts are already the measured
# baseline: no old container and zero locks. The middle proof is the one that
# is tempting to skip and must not be: stopping a container and
# observing that it stopped are different facts, and Telegram hands each
# update to exactly one getUpdates caller. Two pollers on one token means
# messages a customer sent disappearing into the wrong process, silently, with
# both bots looking healthy.
#
# `pg_try_advisory_lock` would make the second poller exit rather than
# double-poll, and that is a backstop, not the plan. A plan that relies on its
# backstop has no plan.
#
# ── Domains move back on any failure ─────────────────────────────────────
#
# The rollback here is a domain move plus a `docker start`, which is seconds,
# and it happens automatically the moment a candidate fails to take its name
# or external verification fails. The old ingest, dashboard and bot containers
# are all stopped directly rather than deleted through Coolify, so a failed
# candidate can restore those exact old bytes. A bootstrap failure instead
# proves the candidate absent and restores the same zero-poller baseline it
# began with.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: cutover-production.sh <sha> <digest> <candidate-ingest> <candidate-dashboard> <candidate-bot> <replace-single|bootstrap-empty>

set -Eeuo pipefail

SHA_ARG=${1:-}
DIGEST_ARG=${2:-}
EXPECTED_CAND_INGEST=${3:-}
EXPECTED_CAND_DASHBOARD=${4:-}
EXPECTED_CAND_BOT=${5:-}
EXPECTED_BOT_HANDOVER_MODE=${6:-}
ENV_ARG=production
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
STATE=${STATE:-/var/lib/shikoo/$ENV_ARG}
LIVE_INGEST_DOMAIN=${LIVE_INGEST_DOMAIN:-sms.chopon.uk}
LIVE_DASHBOARD_DOMAIN=${LIVE_DASHBOARD_DOMAIN:-shikoo.chopon.uk}
IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}

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
[ -r "$STATE/preparation.sha256" ] ||
  die "the host-side preparation ledger has no checksum"
( cd "$STATE" && sha256sum -c --status preparation.sha256 ) ||
  die "the host-side preparation ledger checksum does not verify"
if cut -d= -f1 "$STATE/preparation.env" | LC_ALL=C sort | uniq -d | grep -q .; then
  die "the host-side preparation ledger contains a duplicate key and is ambiguous"
fi

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
BOT_HANDOVER_MODE=$(field bot_handover_mode)

for candidate in "$EXPECTED_CAND_INGEST" "$EXPECTED_CAND_DASHBOARD" "$EXPECTED_CAND_BOT" \
  "$CAND_INGEST" "$CAND_DASHBOARD" "$CAND_BOT"; do
  [[ "$candidate" =~ ^[a-z0-9]{20,32}$ ]] ||
    die "a candidate uuid is missing or malformed"
done
if [ "$EXPECTED_CAND_INGEST" = "$EXPECTED_CAND_DASHBOARD" ] ||
  [ "$EXPECTED_CAND_INGEST" = "$EXPECTED_CAND_BOT" ] ||
  [ "$EXPECTED_CAND_DASHBOARD" = "$EXPECTED_CAND_BOT" ]; then
  die "the verified preparation artifact does not name three distinct candidate applications"
fi
if [ "$CAND_INGEST" = "$CAND_DASHBOARD" ] ||
  [ "$CAND_INGEST" = "$CAND_BOT" ] ||
  [ "$CAND_DASHBOARD" = "$CAND_BOT" ]; then
  die "the host ledger does not name three distinct candidate applications"
fi
if [ "$CAND_INGEST" != "$EXPECTED_CAND_INGEST" ] ||
  [ "$CAND_DASHBOARD" != "$EXPECTED_CAND_DASHBOARD" ] ||
  [ "$CAND_BOT" != "$EXPECTED_CAND_BOT" ]; then
  die "the host ledger names different candidates than the verified preparation artifact"
fi

# The host's own record has to agree with what the workflow was told. Two
# independent stories about which release this is, and both have to match.
[ "$LEDGER_SHA" = "$SHA_ARG" ] ||
  die "the host ledger prepared ${LEDGER_SHA:0:12}, this cutover is for ${SHA_ARG:0:12}"
[ "$LEDGER_DIGEST" = "$DIGEST_ARG" ] ||
  die "the host ledger prepared a different digest than this cutover would deploy"
case "$EXPECTED_BOT_HANDOVER_MODE" in replace-single | bootstrap-empty) ;; *)
  die "the verified preparation artifact has an invalid bot handover mode" ;;
esac
[ "$BOT_HANDOVER_MODE" = "$EXPECTED_BOT_HANDOVER_MODE" ] ||
  die "the host ledger names a different bot handover mode than the verified preparation artifact"

# shellcheck source=deploy/coolify-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

# Every call here CHECKS the status, and that is not tidiness.
#
# `curl -sS` exits 0 for a 401 and for a 500, so the previous shape — «curl …
# || die» — treated «Coolify refused to move the domain» as success. The
# cutover would then report a completed domain move, verify against a domain
# that never moved, and roll back something it had not done.
set_domain() { # uuid fqdn-or-empty
  # On stdin, not in argv, which `ps` shows to every local account. This one was
  # not reported — the identical line in prepare-production.sh was — and fixing
  # only the reported half is how the same hole survives in the file that moves
  # the LIVE customer domains.
  coolify_api PATCH "/applications/$1" \
    "$(printf '%s' "$2" | python3 -c 'import json,sys; print(json.dumps({"domains": sys.stdin.read()}))')" || return 1
  case "$API_STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}

app_action() { # uuid start|stop
  coolify_api POST "/applications/$1/$2" || return 1
  case "$API_STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}

BOT_DEPLOYMENT_UUID=''
start_candidate_bot() {
  coolify_api POST "/applications/$CAND_BOT/start" || return 1
  case "$API_STATUS" in 2??) ;; *) return 1 ;; esac
  BOT_DEPLOYMENT_UUID=$(printf '%s' "$API_BODY" | python3 -c '
import json, re, sys
try:
    value = json.load(sys.stdin).get("deployment_uuid", "")
except Exception:
    value = ""
print(value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{6,80}", value) else "")
')
  [ -n "$BOT_DEPLOYMENT_UUID" ]
}

cancel_deployment() { # deployment-uuid
  [ -n "$1" ] || return 1
  coolify_api POST "/deployments/$1/cancel" || return 1
  case "$API_STATUS" in
    2??) return 0 ;;
    400)
      # A completed or already-cancelled deployment cannot be cancelled, but it
      # is no longer capable of materialising a new container behind recovery.
      printf '%s' "$API_BODY" | python3 -c '
import json, re, sys
try:
    message = json.load(sys.stdin).get("message", "")
except Exception:
    raise SystemExit(1)
ok = re.fullmatch(r"Deployment cannot be cancelled\. Current status: (finished|failed|cancelled-by-user)", message)
raise SystemExit(0 if ok else 1)
' ;;
    *) return 1 ;;
  esac
}
cancel_candidate_deployment() { cancel_deployment "$BOT_DEPLOYMENT_UUID"; }

probe() { curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null || printf '000'; }

# Resolve the database and prove the stopped bot BEFORE a customer hostname is
# moved. `/start` queues a Coolify deployment; it is not a plain container
# restart. Preparation therefore pins the application record, and this check
# binds that record plus APP_VERSION to the manifest Cutover was handed.
PG=$(docker exec -i "${COOLIFY_DB_CONTAINER:-coolify-db}" psql -U coolify -d coolify -At \
  -c "select p.uuid from standalone_postgresqls p join environments e on e.id=p.environment_id where e.name='production' limit 1;" 2>/dev/null || true)
[ -n "$PG" ] || die "could not find the production database container to count pollers"
locks() {
  docker exec -i "$PG" sh -c \
    "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select count(distinct pid) from pg_locks where locktype='advisory' and granted and classid=1399324672\"" 2>/dev/null || printf 'unknown'
}
[ "$OLD_BOT" != "$CAND_BOT" ] ||
  die "the current and candidate bot are the same application — this bootstrap handover cannot stop and start one uuid as two pollers"
if ! OLD_BOT_CONTAINERS=$(docker ps -q --filter "label=coolify.name=$OLD_BOT" 2>/dev/null); then
  die "could not query Docker for the current bot container"
fi
OLD_BOT_COUNT=$(printf '%s\n' "$OLD_BOT_CONTAINERS" | sed '/^$/d' | wc -l)
OLD_BOT_CID=''
case "$BOT_HANDOVER_MODE" in
  replace-single)
    [ "$OLD_BOT_COUNT" = 1 ] ||
      die "the current bot has ${OLD_BOT_COUNT} running containers, expected exactly one for replace-single"
    [ "$(locks)" = 1 ] || die "replace-single no longer has exactly one production bot lock"
    OLD_BOT_CID=$(printf '%s\n' "$OLD_BOT_CONTAINERS" | head -1)
    ;;
  bootstrap-empty)
    [ "$OLD_BOT_COUNT" = 0 ] ||
      die "bootstrap-empty found ${OLD_BOT_COUNT} old bot container(s), expected none"
    [ "$(locks)" = 0 ] || die "bootstrap-empty no longer has zero production bot locks"
    ;;
  *) die "the host ledger has an invalid bot handover mode '$BOT_HANDOVER_MODE'" ;;
esac
CONF="$CONF" IMAGE_NAME="$IMAGE_NAME" \
  bash "$HERE/verify-production-bot-candidate.sh" prepared "$CAND_BOT" "$SHA_ARG" "$DIGEST_ARG" ||
  die "the candidate bot is not the stopped, immutable release preparation recorded"

# The two web candidates, asked what KIND of application they are — before a
# customer hostname moves.
#
# This is the same refusal `deploy.sh` makes before every deploy request, and
# the reason is the same: «Docker Image» is an application TYPE fixed at
# creation, not one of Coolify's five build strategies, and a Git application
# asked to deploy runs `deploy_dockerfile_buildpack()` — it CLONES AND REBUILDS
# and ignores `docker_registry_image_name` entirely. The run goes green, the
# container comes up healthy, and it is running a tree this pipeline never
# verified.
#
# `relabel_candidate` does eventually catch that, because a rebuilt image
# carries no RepoDigest matching the prepared one — but only by exhausting
# WAIT_TIMEOUT, and by then P11 has already put the live customer name on the
# candidate. Detection after the traffic moved is not detection. So the
# question is asked here, where the answer costs a refusal and nothing else.
#
# The bot is deliberately absent: `verify-production-bot-candidate.sh prepared`
# above already asserts the same two fields plus the exact prepared tag, and it
# runs before this line. Repeating it at P14 would have to `die` in the middle
# of the handover, where every other failure calls `recover_bot_handover`.
app_field() { # field, application record on stdin — deploy.sh's spelling
  python3 -c 'import json,sys
try:
    print(json.load(sys.stdin).get(sys.argv[1]) or "")
except Exception:
    print("")' "$1"
}
assert_docker_image_app() { # uuid name
  local record pack image
  coolify_api GET "/applications/$1" ||
    die "could not read the $2 application record from Coolify"
  [ "$API_STATUS" = '200' ] ||
    die "reading the $2 application record was refused (HTTP ${API_STATUS})"
  record=$API_BODY
  pack=$(printf '%s' "$record" | app_field build_pack)
  [ "$pack" = 'dockerimage' ] ||
    die "the candidate $2 is a '${pack:-unknown}' application, not a Docker Image application. Coolify would clone the repository and rebuild, ignoring the digest this release verified. There is no setting that converts it: «Docker Image» is an application TYPE chosen at creation. Refusing before ${LIVE_INGEST_DOMAIN} or ${LIVE_DASHBOARD_DOMAIN} moves."
  image=$(printf '%s' "$record" | app_field docker_registry_image_name)
  [ "$image" = "$IMAGE_NAME" ] ||
    die "the candidate $2 is pinned to image repository '${image:-none}', but this release is '$IMAGE_NAME' — refusing to move a live domain onto it"
}
assert_docker_image_app "$CAND_INGEST" ingest
assert_docker_image_app "$CAND_DASHBOARD" dashboard

# The old web containers, by exact id, before a domain moves — the same
# retain-for-rollback rule the bot handover uses. Exactly one each: zero means
# customers are already off the air and this is not the tool for that, two
# means a roll is still in flight and there is no single set of bytes to keep.
containers_of() { docker ps -q --filter "label=coolify.name=$1" 2>/dev/null; }
count_lines() { printf '%s\n' "$1" | sed '/^$/d' | wc -l; }
OLD_INGEST_CONTAINERS=$(containers_of "$OLD_INGEST") ||
  die "could not query Docker for the current ingest container"
[ "$(count_lines "$OLD_INGEST_CONTAINERS")" = 1 ] ||
  die "the current ingest has $(count_lines "$OLD_INGEST_CONTAINERS") running container(s), expected exactly one to retain for rollback"
OLD_INGEST_CID=$(printf '%s\n' "$OLD_INGEST_CONTAINERS" | head -1)
OLD_DASHBOARD_CONTAINERS=$(containers_of "$OLD_DASHBOARD") ||
  die "could not query Docker for the current dashboard container"
[ "$(count_lines "$OLD_DASHBOARD_CONTAINERS")" = 1 ] ||
  die "the current dashboard has $(count_lines "$OLD_DASHBOARD_CONTAINERS") running container(s), expected exactly one to retain for rollback"
OLD_DASHBOARD_CID=$(printf '%s\n' "$OLD_DASHBOARD_CONTAINERS" | head -1)
# The candidates' current containers — the ones answering `-next` — so the
# replacement each redeploy produces can be told apart from them.
CAND_INGEST_CID=$(containers_of "$CAND_INGEST" | head -1)
CAND_DASHBOARD_CID=$(containers_of "$CAND_DASHBOARD" | head -1)

# ── P11. the domains ──────────────────────────────────────────────────────
#
# A domain lives in two places, and `PATCH domains` moves only one of them.
# It rewrites the application record and regenerates the proxy labels stored
# on it (`ApplicationsController::update_by_uuid`, when container labels are
# read-only, which they are here) — and that is all. Traefik never reads that
# record. It reads the labels on RUNNING CONTAINERS, and those were written
# when each container was created. After the four PATCHes below the candidate
# still advertises `sms-next` and the old container still advertises the live
# name, exactly as before; a cutover that stopped there would verify the old
# version on the live name and roll itself back, every time.
#
# So there are three moves, in this order:
#
#   1. the records — old released first, then the candidate given the name,
#      because the API refuses a name two applications claim;
#   2. the candidates REDEPLOYED. A restart of a Docker Image application is a
#      full redeploy (`ApplicationDeploymentJob` forces `restart_only` off for
#      `dockerimage`): the pinned digest is pulled again and a replacement
#      container rolled in with the regenerated labels. The replacement is the
#      only proof the move happened — a new container id, healthy, carrying the
#      live name in its router rule, on the prepared digest;
#   3. the old containers stopped — and kept, because their labels are the
#      rollback: `docker start` puts the live name straight back on the bytes
#      customers were on, without asking Coolify to rebuild anything.
#
# Between 2 and 3 both containers answer the live name. That overlap is chosen
# over its alternative: both run against the schema preparation migrated and
# proved on both sides (P7, P10), while stopping the old container first is an
# outage exactly as long as the roll.
say "P11. moving ${LIVE_INGEST_DOMAIN} and ${LIVE_DASHBOARD_DOMAIN}"
WAIT_TIMEOUT=${WAIT_TIMEOUT:-420}
STOP_TIMEOUT=${STOP_TIMEOUT:-30}
WEB_DEPLOYMENTS=()

relabel_candidate() { # uuid name previous-cid host
  local uuid=$1 name=$2 previous=$3 host=$4 deadline cid state labels image digests deployment
  coolify_api POST "/applications/$uuid/restart" || return 1
  case "$API_STATUS" in 2??) ;; *) return 1 ;; esac
  deployment=$(printf '%s' "$API_BODY" | python3 -c '
import json, re, sys
try:
    value = json.load(sys.stdin).get("deployment_uuid", "")
except Exception:
    value = ""
print(value if isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9_-]{6,80}", value) else "")
')
  [ -z "$deployment" ] || WEB_DEPLOYMENTS+=("$deployment")
  deadline=$(($(date +%s) + WAIT_TIMEOUT))
  while :; do
    while IFS= read -r cid; do
      if [ -z "$cid" ] || [ "$cid" = "$previous" ]; then continue; fi
      state=$(docker inspect --format '{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' "$cid" 2>/dev/null || echo gone)
      [ "$state" = 'running healthy' ] || continue
      labels=$(docker inspect --format '{{json .Config.Labels}}' "$cid" 2>/dev/null || echo '')
      case "$labels" in *"Host(\`${host}\`)"*) ;; *) continue ;; esac
      image=$(docker inspect --format '{{.Image}}' "$cid" 2>/dev/null || echo '')
      digests=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$image" 2>/dev/null || echo '')
      case "$digests" in
        *"$DIGEST_ARG"*)
          say "    ${name}: replacement ${cid:0:12} is healthy, answers ${host}, runs the prepared digest"
          return 0 ;;
      esac
    done <<EOF
$(containers_of "$uuid")
EOF
    [ "$(date +%s)" -lt "$deadline" ] || {
      echo "[cutover] ${name}: no healthy replacement carrying ${host} on the prepared digest within ${WAIT_TIMEOUT}s" >&2
      return 1
    }
    sleep 5
  done
}

rollback_domains() {
  local failed=0 uuid cid labels deployment
  say "ROLLING BACK: returning both domains to the old applications"
  set_domain "$CAND_INGEST" '' || failed=1
  set_domain "$CAND_DASHBOARD" '' || failed=1
  set_domain "$OLD_INGEST" "https://${LIVE_INGEST_DOMAIN}" || failed=1
  set_domain "$OLD_DASHBOARD" "https://${LIVE_DASHBOARD_DOMAIN}" || failed=1
  # The records are back; the proxy routes by containers. The retained old
  # containers still carry the live names in their own labels, so starting
  # them is the whole restoration — a no-op on one that never stopped. Then
  # every candidate container that took a live name is stopped, after any
  # redeploy still in flight is cancelled so it cannot bring one back.
  docker start "$OLD_INGEST_CID" >/dev/null || failed=1
  docker start "$OLD_DASHBOARD_CID" >/dev/null || failed=1
  for deployment in "${WEB_DEPLOYMENTS[@]:-}"; do
    [ -z "$deployment" ] || cancel_deployment "$deployment" || failed=1
  done
  for uuid in "$CAND_INGEST" "$CAND_DASHBOARD"; do
    while IFS= read -r cid; do
      [ -n "$cid" ] || continue
      labels=$(docker inspect --format '{{json .Config.Labels}}' "$cid" 2>/dev/null || echo '')
      case "$labels" in
        *"Host(\`${LIVE_INGEST_DOMAIN}\`)"* | *"Host(\`${LIVE_DASHBOARD_DOMAIN}\`)"*)
          docker stop --time "$STOP_TIMEOUT" "$cid" >/dev/null || failed=1 ;;
      esac
    done <<EOF
$(containers_of "$uuid")
EOF
  done
  [ "$failed" = 0 ]
}

set_domain "$OLD_INGEST" '' || die "could not release ${LIVE_INGEST_DOMAIN} from the old ingest"
set_domain "$CAND_INGEST" "https://${LIVE_INGEST_DOMAIN}" || {
  rollback_domains || die "could not move ${LIVE_INGEST_DOMAIN} onto the candidate and automatic domain rollback was incomplete"
  die "could not move ${LIVE_INGEST_DOMAIN} onto the candidate"
}
set_domain "$OLD_DASHBOARD" '' || {
  rollback_domains || die "could not release ${LIVE_DASHBOARD_DOMAIN} and automatic domain rollback was incomplete"
  die "could not release ${LIVE_DASHBOARD_DOMAIN} from the old dashboard"
}
set_domain "$CAND_DASHBOARD" "https://${LIVE_DASHBOARD_DOMAIN}" || {
  rollback_domains || die "could not move ${LIVE_DASHBOARD_DOMAIN} onto the candidate and automatic domain rollback was incomplete"
  die "could not move ${LIVE_DASHBOARD_DOMAIN} onto the candidate"
}
say "    records moved; redeploying the candidates onto their new labels"

relabel_candidate "$CAND_INGEST" ingest "$CAND_INGEST_CID" "$LIVE_INGEST_DOMAIN" || {
  rollback_domains || die "the candidate ingest never answered ${LIVE_INGEST_DOMAIN} and automatic rollback was incomplete"
  die "the candidate ingest never answered ${LIVE_INGEST_DOMAIN} — domains returned to the old applications"
}
relabel_candidate "$CAND_DASHBOARD" dashboard "$CAND_DASHBOARD_CID" "$LIVE_DASHBOARD_DOMAIN" || {
  rollback_domains || die "the candidate dashboard never answered ${LIVE_DASHBOARD_DOMAIN} and automatic rollback was incomplete"
  die "the candidate dashboard never answered ${LIVE_DASHBOARD_DOMAIN} — domains returned to the old applications"
}

for pair in "$OLD_INGEST_CID ingest" "$OLD_DASHBOARD_CID dashboard"; do
  docker stop --time "$STOP_TIMEOUT" "${pair%% *}" >/dev/null || {
    rollback_domains || die "could not stop the old ${pair##* } container and automatic rollback was incomplete"
    die "could not stop the old ${pair##* } container — domains returned to the old applications"
  }
done
say "    old ingest and dashboard containers stopped and retained for rollback"

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
  rollback_domains || die "live verification failed and automatic domain rollback was incomplete"
  die "live verification failed (ingest ${ING_CODE}, dashboard ${DASH_CODE}, version '${VER_SHA:0:12}') — domains returned to the old applications"
fi
say "    ingest 200, dashboard 200, version ${VER_SHA:0:12}"

# ── P13–P15. the bot handover ─────────────────────────────────────────────
wait_for_locks() { # exact-count
  local want=$1
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(locks)" = "$want" ] && return 0
    sleep 6
  done
  return 1
}

candidate_containers() {
  docker ps -q --filter "label=coolify.name=$CAND_BOT" 2>/dev/null
}

wait_for_candidate_absent() {
  local quiet=0 containers
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    containers=''
    if ! containers=$(candidate_containers); then
      return 1
    fi
    if [ -z "$containers" ]; then
      quiet=$((quiet + 1))
      [ "$quiet" -ge 3 ] && return 0
    else
      quiet=0
    fi
    sleep 2
  done
  return 1
}

# A candidate that fails after the old bot stopped must not leave production
# with zero pollers and the domains in their post-cutover state. Best-effort is
# not described as success: every leg is observed, and an incomplete recovery
# is named as manual intervention.
recover_bot_handover() { # reason
  local reason=$1 recovered=1 final_candidate_containers='' old_running=''
  say "ROLLING BACK BOT HANDOVER: ${reason}"
  rollback_domains || recovered=0
  cancel_candidate_deployment || recovered=0
  app_action "$CAND_BOT" stop || recovered=0
  wait_for_candidate_absent || recovered=0
  wait_for_locks 0 || recovered=0
  # Even an incomplete cancellation should get a best-effort availability
  # recovery. The singleton lock keeps a late candidate from polling beside
  # this container; the checks below still refuse to call that recovery
  # complete unless the candidate is observed absent.
  #
  # Coolify's stop endpoint removes the container, and its start endpoint
  # queues a fresh deployment. Starting the exact container retained at P13 is
  # the only rollback that restores observed old bytes rather than whatever the
  # old application record happens to build now.
  if [ "$BOT_HANDOVER_MODE" = replace-single ]; then
    docker start "$OLD_BOT_CID" >/dev/null || recovered=0
    wait_for_locks 1 || recovered=0
  else
    wait_for_locks 0 || recovered=0
  fi
  if ! final_candidate_containers=$(candidate_containers); then
    recovered=0
  elif [ -n "$final_candidate_containers" ]; then
    recovered=0
  fi
  if [ "$BOT_HANDOVER_MODE" = replace-single ]; then
    if ! old_running=$(docker ps -q --filter "id=$OLD_BOT_CID" 2>/dev/null | head -1); then
      recovered=0
    elif [ "$old_running" != "$OLD_BOT_CID" ]; then
      recovered=0
    fi
  fi
  if [ "$recovered" = 1 ]; then
    if [ "$BOT_HANDOVER_MODE" = replace-single ]; then
      die "${reason} — domains and the original single bot poller were restored"
    fi
    die "${reason} — domains were restored and the prior zero-poller state remains"
  fi
  die "${reason} — automatic recovery was incomplete; production needs manual intervention"
}

if [ "$BOT_HANDOVER_MODE" = replace-single ]; then
  say "P13. stopping the old bot"
  if ! docker stop --time "${BOT_STOP_TIMEOUT:-30}" "$OLD_BOT_CID" >/dev/null; then
    rollback_domains || die "could not stop the old production bot and automatic domain rollback was incomplete"
    die "could not stop and retain the exact old production bot container; domains were restored"
  fi

  # Observed, not assumed. «I asked it to stop» and «it stopped» are different
  # facts, and starting the second poller on the strength of the first is how one
  # token ends up with two.
  if ! wait_for_locks 0; then
    rollback_domains || die "the old bot still holds its lock and automatic domain rollback was incomplete"
    # This exact old container will wait on the same singleton lock if Postgres
    # has not released the stopped session yet. Do not call that observed
    # recovery: a count of one here could still be the stale session.
    docker start "$OLD_BOT_CID" >/dev/null || true
    die "the old bot lock did not clear — no second poller was started, domains were restored, and the retained old container was restarted for manual verification"
  fi
else
  say "P13. bootstrap baseline has no old bot container and zero poller locks"
fi
say "P14. zero pollers confirmed; starting the candidate bot"

start_candidate_bot ||
  recover_bot_handover "could not start the candidate bot (HTTP ${API_STATUS})"
wait_for_locks 1 ||
  recover_bot_handover "the candidate bot did not take the advisory lock"
CONF="$CONF" IMAGE_NAME="$IMAGE_NAME" \
  bash "$HERE/verify-production-bot-candidate.sh" running "$CAND_BOT" "$SHA_ARG" "$DIGEST_ARG" ||
  recover_bot_handover "the candidate poller is not running the prepared digest and sha"
say "P15. exactly one poller confirmed on the prepared digest"

# The one-time cutover changes which application UUIDs a normal production
# promotion must target. Credentials stay in the root-owned deploy.env; only
# these non-secret UUIDs are atomically adopted in deploy-owned state. If this
# cannot be recorded, restore the pre-cutover state rather than leave the next
# promotion aimed at the legacy Git applications.
bash "$HERE/current-production-apps.sh" adopt "$STATE/current-applications.env" \
  "$CAND_INGEST" "$CAND_DASHBOARD" "$CAND_BOT" "$SHA_ARG" "$DIGEST_ARG" ||
  recover_bot_handover "could not record the canonical production applications"
say "P16. canonical Docker Image application UUIDs adopted for later promotions"

# ── P17. identity, then the ledger ────────────────────────────────────────
BOT_NAME=$(docker exec -i "$PG" sh -c \
  "psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"select value::text from settings where scope='bot' and key='username'\"" 2>/dev/null | tr -d '"' || true)
say "P17. bot identity: ${BOT_NAME:-not yet recorded}"

mkdir -p "$STATE"
printf '%s %s %s promoted-by-hand\n' \
  "$(date -u +%Y-%m-%dT%H:%M:%S%z)" "$DIGEST_ARG" "$SHA_ARG" >>"$STATE/deployed"
say "P17. release recorded. Old applications are stopped-but-kept for rollback."
