#!/usr/bin/env bash
# The bot is the only candidate not started during preparation. These checks
# prove Cutover cannot turn that necessary gap into a mutable-tag deployment.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/verify-production-bot-candidate.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

APP_UUID='bbbbbbbbbbbbbbbbbbbbbbb3'
SHA='1111111111111111111111111111111111111111'
DIGEST='sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a'
IMAGE='ghcr.io/shikoonet/shikoonet-platform'
SECRET_TOKEN='0|CUTOVER-TOKEN-MUST-NOT-PRINT'
SECRET_DB='postgres://shikoo:CUTOVER-DB-MUST-NOT-PRINT@postgres:5432/shikoo'
SECRET_BOT='CUTOVER-BOT-TOKEN-MUST-NOT-PRINT'

CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=$SECRET_TOKEN
EOF

APP_JSON="$WORK/app.json"
ENV_JSON="$WORK/envs.json"
export FAKE_APP_UUID="$APP_UUID" FAKE_APP_JSON="$APP_JSON" FAKE_ENV_JSON="$ENV_JSON"
export FAKE_IMAGE_NAME="$IMAGE" FAKE_DIGEST="$DIGEST" FAKE_SHA="$SHA"

reset_fixtures() {
  cat >"$APP_JSON" <<EOF
{"uuid":"$APP_UUID","build_pack":"dockerimage","docker_registry_image_name":"$IMAGE","docker_registry_image_tag":"sha256-${DIGEST#sha256:}"}
EOF
  cat >"$ENV_JSON" <<EOF
[
  {"uuid":"e1","key":"ENV_NAME","value":"production"},
  {"uuid":"e2","key":"SERVICE","value":"bot"},
  {"uuid":"e3","key":"DATABASE_URL","value":"$SECRET_DB"},
  {"uuid":"e4","key":"APP_VERSION","value":"$SHA"},
  {"uuid":"e5","key":"TELEGRAM_BOT_TOKEN","value":"$SECRET_BOT"}
]
EOF
}
reset_fixtures

cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=${*: -1}
case "$url" in
  */applications/$FAKE_APP_UUID/envs) cat "$FAKE_ENV_JSON"; printf '200' ;;
  */applications/$FAKE_APP_UUID) cat "$FAKE_APP_JSON"; printf '200' ;;
  *) printf '{"message":"not found"}404' ;;
esac
FAKE
chmod +x "$BIN/curl"

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  ps)
    case "${FAKE_RUNNING:-0}" in
      0) ;;
      1) printf 'candidate-bot-cid\n' ;;
      2) printf 'candidate-bot-cid\nsecond-candidate-bot-cid\n' ;;
    esac
    ;;
  inspect)
    format=''
    prev=''
    for arg in "$@"; do
      [ "$prev" = '--format' ] && format=$arg
      prev=$arg
    done
    case "$format" in
      '{{.Image}}') printf 'candidate-bot-image-id\n' ;;
      *RepoDigests*) printf '%s@%s\n' "$FAKE_IMAGE_NAME" "${FAKE_RUNTIME_DIGEST:-$FAKE_DIGEST}" ;;
      *Config.Env*)
        printf '["ENV_NAME=%s","SERVICE=bot","APP_VERSION=%s","DATABASE_URL=postgres://hidden","TELEGRAM_BOT_TOKEN=hidden"]\n' \
          "${FAKE_RUNTIME_ENV:-production}" "${FAKE_RUNTIME_SHA:-$FAKE_SHA}"
        ;;
      *) exit 1 ;;
    esac
    ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$BIN/docker"

run_verify() { # mode output [env overrides]
  local mode=$1 output=$2
  shift 2
  set +e
  env CONF="$CONF" IMAGE_NAME="$IMAGE" "$@" \
    bash "$SCRIPT" "$mode" "$APP_UUID" "$SHA" "$DIGEST" >"$output" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'before the old poller is stopped'

OUT1="$WORK/prepared.log"
if run_verify prepared "$OUT1" FAKE_RUNNING=0; then
  ok 'a stopped bot bound to the prepared digest and sha passes'
else
  bad 'a stopped bot bound to the prepared digest and sha passes' "$(tail -3 "$OUT1")"
fi

python3 - "$APP_JSON" <<'PY'
import json, sys
path = sys.argv[1]
app = json.load(open(path))
app["docker_registry_image_tag"] = "latest"
json.dump(app, open(path, "w"))
PY
OUT2="$WORK/mutable-tag.log"
if run_verify prepared "$OUT2" FAKE_RUNNING=0; then
  bad 'a mutable bot tag is refused' 'the verifier accepted latest'
elif grep -qF 'not a Docker Image application pinned to the prepared digest' "$OUT2"; then
  ok 'a mutable bot tag is refused'
else
  bad 'a mutable bot tag is refused' "$(tail -3 "$OUT2")"
fi

reset_fixtures
python3 - "$ENV_JSON" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.load(open(path))
rows.append(dict(rows[0], uuid="duplicate-env"))
json.dump(rows, open(path, "w"))
PY
OUT3="$WORK/duplicate-env.log"
if run_verify prepared "$OUT3" FAKE_RUNNING=0; then
  bad 'a duplicated bot environment key is refused' 'the verifier accepted row-order semantics'
elif grep -qF 'environment is missing, duplicated, or not bound' "$OUT3"; then
  ok 'a duplicated bot environment key is refused'
else
  bad 'a duplicated bot environment key is refused' "$(tail -3 "$OUT3")"
fi

reset_fixtures
OUT4="$WORK/already-running.log"
if run_verify prepared "$OUT4" FAKE_RUNNING=1; then
  bad 'a candidate already running before handover is refused' 'two pollers may exist'
elif grep -qF 'already has a running container' "$OUT4"; then
  ok 'a candidate already running before handover is refused'
else
  bad 'a candidate already running before handover is refused' "$(tail -3 "$OUT4")"
fi

section 'after the candidate takes the singleton lock'

OUT5="$WORK/running.log"
if run_verify running "$OUT5" FAKE_RUNNING=1; then
  ok 'one running bot on the prepared digest and sha passes'
else
  bad 'one running bot on the prepared digest and sha passes' "$(tail -3 "$OUT5")"
fi

OUT6="$WORK/wrong-digest.log"
if run_verify running "$OUT6" FAKE_RUNNING=1 \
  FAKE_RUNTIME_DIGEST='sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'; then
  bad 'a running bot on different bytes is refused' 'the digest mismatch passed'
elif grep -qF 'does not carry the prepared digest' "$OUT6"; then
  ok 'a running bot on different bytes is refused'
else
  bad 'a running bot on different bytes is refused' "$(tail -3 "$OUT6")"
fi

OUT7="$WORK/wrong-runtime.log"
if run_verify running "$OUT7" FAKE_RUNNING=1 \
  FAKE_RUNTIME_SHA='2222222222222222222222222222222222222222'; then
  bad 'a running bot with a stale APP_VERSION is refused' 'the runtime mismatch passed'
elif grep -qF 'does not identify as the prepared production bot' "$OUT7"; then
  ok 'a running bot with a stale APP_VERSION is refused'
else
  bad 'a running bot with a stale APP_VERSION is refused' "$(tail -3 "$OUT7")"
fi

OUT8="$WORK/two-containers.log"
if run_verify running "$OUT8" FAKE_RUNNING=2; then
  bad 'two candidate bot containers are refused' 'both were accepted'
elif grep -qF 'has 2 running containers' "$OUT8"; then
  ok 'two candidate bot containers are refused'
else
  bad 'two candidate bot containers are refused' "$(tail -3 "$OUT8")"
fi

section 'no bot credential is printed'

for secret in "$SECRET_TOKEN" "$SECRET_DB" "$SECRET_BOT"; do
  if grep -qF -- "$secret" "$OUT1" "$OUT2" "$OUT3" "$OUT4" "$OUT5" "$OUT6" "$OUT7" "$OUT8"; then
    bad 'the verifier output contains no credential' 'a fake credential was printed'
  else
    ok 'the verifier output contains no credential'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
