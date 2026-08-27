#!/usr/bin/env bash
#
# The deploy path, driven against a fake GitHub, a fake Coolify and a fake
# Docker — plus the assertions about `deploy.yml` that no script can make.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why a shell test
#
# The things under test ARE shell scripts, and the guarantee being tested is
# «this refuses». Reimplementing the jq filters in TypeScript would test the
# reimplementation; putting a `curl` and a `docker` on PATH that answer from
# fixtures runs the real control flow — the `set -e`, the status parsing, the
# `group_by | last` that makes a superseded approval stop counting, the flock.
#
# The workflow assertions are here rather than in a YAML linter because they are
# not about syntax. «The production job compares to the exact string true» and
# «no deploy step runs before the gate job» are properties of THIS file's
# meaning, and actionlint is happy either way.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: bash deploy/test/deploy-pipeline.test.sh

set -Eeuo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(cd -- "$HERE/../.." && pwd)
GATE="$ROOT/deploy/approval-gate.sh"
DEPLOY="$ROOT/deploy/deploy.sh"
OVER_SSH="$ROOT/deploy/over-ssh.sh"
WORKFLOW="$ROOT/.github/workflows/deploy.yml"
for f in "$GATE" "$DEPLOY" "$OVER_SSH" "$WORKFLOW"; do
  [ -r "$f" ] || {
    echo "cannot read $f" >&2
    exit 1
  }
done

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n' "$1"
  [ -z "${2:-}" ] || printf '       %s\n' "$2"
}
section() { printf '\n%s\n' "$1"; }

# The token the logs must never contain. Distinctive on purpose: a grep for it
# cannot match anything either script legitimately prints.
FAKE_TOKEN='ghs-FAKE-2f8c41a09b7e6d35'

SHA_MERGED='1111111111111111111111111111111111111111'
SHA_PRHEAD='2222222222222222222222222222222222222222'
SHA_OLDER='3333333333333333333333333333333333333333'
SHA_OTHER='4444444444444444444444444444444444444444'

# ═════════════════════════════════════════════════════════════════════════
# The fake GitHub
# ═════════════════════════════════════════════════════════════════════════
#
# A scenario file maps a URL fragment to a status and a body file. The fake
# appends the status the way real `curl -w '%{http_code}'` does, because the
# script parses the last three characters and that parsing is worth exercising.
SCEN="$WORK/scenarios"
: >"$SCEN"
SCEN_N=0
scenario() { # fragment status body
  SCEN_N=$((SCEN_N + 1))
  printf '%s' "$3" >"$WORK/body.$SCEN_N"
  printf '%s\t%s\t%s\n' "$1" "$2" "$WORK/body.$SCEN_N" >>"$SCEN"
}
reset_scenarios() {
  : >"$SCEN"
  unset FAKE_CURL_DIES
}

cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''
for a in "$@"; do
  case "$a" in http*) url="$a" ;; esac
done

# A transport failure: curl itself exits non-zero and prints nothing, which is
# what a DNS failure or a reset connection looks like to the caller.
[ -z "${FAKE_CURL_DIES:-}" ] || exit 7

# The Coolify half, when one is configured.
if [ -n "${FAKE_COOLIFY_URL:-}" ]; then
  case "$url" in
    "$FAKE_COOLIFY_URL"*)
      path=${url#"$FAKE_COOLIFY_URL"/api/v1}
      method='GET'
      prev=''
      for a in "$@"; do
        [ "$prev" = '--request' ] && method="$a"
        prev="$a"
      done
      case "$method:$path" in
        GET:/applications/*/envs)
          printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"}]' ;;
        PATCH:/applications/*/envs | POST:/applications/*/envs)
          printf '{"ok":true}' ;;
        PATCH:/applications/*)
          printf '%s\n' "${path#/applications/}" >>"$FAKE_PINS"
          printf '{"ok":true}' ;;
        POST:/deploy*)
          uuid=${path#*uuid=}
          printf '%s\n' "$uuid" >>"$FAKE_DEPLOYS"
          # The replacement container appears only once a deploy is queued.
          printf '%s\n' "$uuid" >>"$FAKE_REPLACED"
          printf '{"ok":true}' ;;
        GET:/applications/*) printf '{"uuid":"x"}' ;;
        *) printf '{"message":"no coolify route"}' >&2; exit 22 ;;
      esac
      exit 0 ;;
  esac
fi

while IFS=$'\t' read -r frag status file; do
  case "$url" in
    *"$frag"*)
      cat "$file"
      printf '%s' "$status"
      exit 0 ;;
  esac
done <"$FAKE_SCEN"
printf '{"message":"no scenario for %s"}404' "$url"
FAKE
chmod +x "$BIN/curl"
export FAKE_SCEN="$SCEN"

# ── fixtures ──────────────────────────────────────────────────────────────
pr_json() { # merged? author head
  local merged='"2026-08-27T10:00:00Z"'
  [ "$1" = 'merged' ] || merged='null'
  printf '[{"number":7,"merged_at":%s,"base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"},"user":{"login":"%s"}}]' \
    "$merged" "$SHA_MERGED" "$3" "$2"
}
review() { # state login commit_id type when
  printf '{"state":"%s","user":{"login":"%s","type":"%s"},"commit_id":"%s","submitted_at":"%s"}' \
    "$1" "$2" "${4:-User}" "$3" "${5:-2026-08-27T09:00:00Z}"
}
runs_json() { printf '{"workflow_runs":[{"id":9001}]}'; }
jobs_json() { printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"},{"name":"Required Quality Gate","status":"completed","conclusion":"%s"}]}' "$1"; }
commit_json() { printf '{"sha":"%s"}' "$1"; }

# The whole happy path, which each test then breaks in exactly one place.
happy() { # [reviews-json]
  reset_scenarios
  scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged author "$SHA_PRHEAD")"
  scenario "/pulls/7/reviews" 200 "${1:-[$(review APPROVED reviewer "$SHA_PRHEAD")]}"
  scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json)"
  scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
  scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
}

GATE_LOG="$WORK/gate.log"
run_gate() { # -> exit code, output in $GATE_LOG
  set +e
  GITHUB_TOKEN="$FAKE_TOKEN" GITHUB_API='https://api.github.com' \
    bash "$GATE" 'Shikoonet/Shikoonet-Platform' "$SHA_MERGED" >"$GATE_LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}

denies() { # name  substring-the-log-must-contain
  if run_gate; then
    bad "$1" "the gate PASSED when it had to deny"
    return
  fi
  if grep -qF "$2" "$GATE_LOG"; then
    ok "$1"
  else
    bad "$1" "denied, but not for '$2': $(tail -2 "$GATE_LOG" | tr '\n' ' ')"
  fi
}

section 'approval gate — what must be true before anything is built'

happy
if run_gate; then ok 'passes on a merged, human-approved, green, current head'; else
  bad 'passes on a merged, human-approved, green, current head' "$(tail -3 "$GATE_LOG")"
fi

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 200 '[]'
denies 'refuses a commit no pull request produced (direct push to main)' 'not the result of a merged pull request'

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json open author "$SHA_PRHEAD")"
denies 'refuses a pull request that was never merged' 'not the result of a merged pull request'

happy '[]'
denies 'refuses when nobody reviewed it' 'no current APPROVED review'

happy "[$(review APPROVED author "$SHA_PRHEAD")]"
denies 'refuses an approval by the author' 'no current APPROVED review'

happy "[$(review APPROVED some-bot "$SHA_PRHEAD" Bot)]"
denies 'refuses an approval by a bot' 'no current APPROVED review'

happy "[$(review COMMENTED reviewer "$SHA_PRHEAD")]"
denies 'refuses a COMMENTED review' 'no current APPROVED review'

happy "[$(review APPROVED reviewer "$SHA_OLDER")]"
denies 'refuses an approval on a superseded head' 'no current APPROVED review'

happy "[$(review APPROVED reviewer "$SHA_PRHEAD" User 2026-08-27T09:00:00Z),$(review CHANGES_REQUESTED reviewer "$SHA_PRHEAD" User 2026-08-27T09:30:00Z)]"
denies 'refuses when the approver later asked for changes' 'outstanding CHANGES_REQUESTED'

happy "[$(review APPROVED alice "$SHA_PRHEAD"),$(review CHANGES_REQUESTED bob "$SHA_PRHEAD")]"
denies 'refuses when somebody else has changes outstanding, even with an approval' 'outstanding CHANGES_REQUESTED'

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged author "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$SHA_PRHEAD")]"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json failure)"
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses when Required Quality Gate did not succeed on the final head' 'did not succeed on the final head'

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged author "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$SHA_PRHEAD")]"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 '{"workflow_runs":[]}'
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses when no run exists on the final head at all' 'no workflow run at all'

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged author "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$SHA_PRHEAD")]"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
scenario "/commits/main" 200 "$(commit_json "$SHA_OTHER")"
denies 'refuses when main has moved on since CI passed' 'moved'

reset_scenarios
scenario "/commits/${SHA_MERGED}/pulls" 500 '{"message":"boom"}'
denies 'fails closed on an API error' 'failing closed'

happy
FAKE_CURL_DIES=1
export FAKE_CURL_DIES
denies 'fails closed when the API cannot be reached at all'  'failing closed'
unset FAKE_CURL_DIES

happy
if run_gate && ! grep -qF "$FAKE_TOKEN" "$GATE_LOG"; then
  ok 'never prints the token'
else
  bad 'never prints the token' 'the token appeared in the gate output'
fi

# ═════════════════════════════════════════════════════════════════════════
# deploy.sh — the bot switch and the lock
# ═════════════════════════════════════════════════════════════════════════
section 'deploy.sh — the bot stays off unless the exact string says otherwise'

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1:-}" in
  pull) exit 0 ;;
  logs) exit 0 ;;
  run) exit 0 ;;
  exec) printf '1\n'; exit 0 ;;   # the bot singleton count, if ever asked
  ps)
    for a in "$@"; do
      case "$a" in label=coolify.name=*) uuid=${a#label=coolify.name=} ;; esac
    done
    # A container id that CHANGES once this uuid has been asked to deploy,
    # which is what `wait_healthy` is watching for.
    n=$(grep -c "^${uuid}$" "$FAKE_REPLACED" 2>/dev/null || true)
    printf 'cid-%s-%s\n' "$uuid" "${n:-0}"
    exit 0 ;;
  inspect)
    fmt=''
    prev=''
    for a in "$@"; do
      [ "$prev" = '--format' ] && fmt="$a"
      prev="$a"
    done
    case "$fmt" in
      *image.revision*) printf '%s\n' "${FAKE_LABEL_SHA}" ;;
      '{{.Id}}')        printf 'img-deadbeef\n' ;;
      '{{.Image}}')     printf 'img-deadbeef\n' ;;
      *State.Status*)   printf 'running healthy\n' ;;
      *Ports*)          printf '\n' ;;
      *)                printf '\n' ;;
    esac
    exit 0 ;;
esac
exit 0
FAKE
chmod +x "$BIN/docker"

ENVDIR="$WORK/env"
mkdir -p "$ENVDIR"
cat >"$ENVDIR/deploy.env" <<CONF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=$FAKE_TOKEN
APP_INGEST=uuid-ingest
APP_DASHBOARD=uuid-dashboard
APP_BOT=uuid-bot
DB_CONTAINER=fake-db
CONF

DEPLOY_LOG="$WORK/deploy.log"
run_deploy() { # bot-flag
  : >"$WORK/pins"
  : >"$WORK/deploys"
  : >"$WORK/replaced"
  set +e
  env \
    FAKE_COOLIFY_URL='http://127.0.0.1:8000' \
    FAKE_PINS="$WORK/pins" FAKE_DEPLOYS="$WORK/deploys" FAKE_REPLACED="$WORK/replaced" \
    FAKE_LABEL_SHA="$SHA_MERGED" \
    ENV_DIR="$ENVDIR" STATE_FILE="$WORK/state" LOCK_FILE="$WORK/lock" \
    WAIT_TIMEOUT=5 NETWORK=none DEPLOY_BOT_ENABLED="$1" \
    bash "$DEPLOY" production "ghcr.io/x/y@sha256:abc" "$SHA_MERGED" \
    >"$DEPLOY_LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}

if run_deploy false; then
  if grep -q '^uuid-bot$' "$WORK/deploys"; then
    bad 'the bot is not deployed when the flag is false' 'a deploy was queued for the bot application'
  else
    ok 'the bot is not deployed when the flag is false'
  fi
  if grep -q '^uuid-bot$' "$WORK/pins"; then
    bad 'the bot image is not pinned when the flag is false' 'the bot application was PATCHed'
  else
    ok 'the bot image is not pinned when the flag is false'
  fi
  if grep -qF 'bot_singleton=not asserted' "$DEPLOY_LOG"; then
    ok 'the bot poller lock is not asserted when the bot was not started'
  else
    bad 'the bot poller lock is not asserted when the bot was not started' "$(grep -F bot_singleton "$DEPLOY_LOG" || true)"
  fi
  if grep -q '^uuid-ingest$' "$WORK/deploys" && grep -q '^uuid-dashboard$' "$WORK/deploys"; then
    ok 'ingest and dashboard still deploy with the bot off'
  else
    bad 'ingest and dashboard still deploy with the bot off' "$(cat "$WORK/deploys")"
  fi
else
  bad 'deploy.sh completes with the bot excluded' "$(tail -5 "$DEPLOY_LOG")"
fi

for falsey in '' 'false' 'TRUE' '1' 'yes' 'True'; do
  if run_deploy "$falsey" && ! grep -q '^uuid-bot$' "$WORK/deploys"; then
    ok "the bot stays off for DEPLOY_BOT_ENABLED='${falsey}'"
  else
    bad "the bot stays off for DEPLOY_BOT_ENABLED='${falsey}'" 'the bot deployed, or the run failed'
  fi
done

if run_deploy true && grep -q '^uuid-bot$' "$WORK/deploys"; then
  ok "the bot deploys for the exact string 'true'"
else
  bad "the bot deploys for the exact string 'true'" "$(tail -3 "$DEPLOY_LOG")"
fi

section 'deploy.sh — two deploys cannot run at once'

(
  flock -n 9 || exit 1
  sleep 5
) 9>"$WORK/lock" &
HOLDER=$!
sleep 0.3
if run_deploy false; then
  bad 'refuses to start while another deploy holds the lock' 'it ran anyway'
else
  if grep -qF 'holds' "$DEPLOY_LOG"; then
    ok 'refuses to start while another deploy holds the lock'
  else
    bad 'refuses to start while another deploy holds the lock' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi
kill "$HOLDER" 2>/dev/null || true
wait "$HOLDER" 2>/dev/null || true

section 'over-ssh.sh — only a digest is deployable'

try_over_ssh() { # image-ref
  set +e
  env DEPLOY_SSH_KEY=k DEPLOY_KNOWN_HOSTS=h DEPLOY_HOST=h DEPLOY_USER=u \
    REGISTRY_TOKEN="$FAKE_TOKEN" IMAGE_REF="$1" SHA="$SHA_MERGED" \
    bash "$OVER_SSH" staging >"$WORK/ssh.log" 2>&1
  local rc=$?
  set -e
  return $rc
}
if try_over_ssh 'ghcr.io/shikoonet/shikoonet-platform:latest'; then
  bad 'refuses a mutable tag as deployment input' 'it accepted :latest'
else
  if grep -qF 'not an immutable digest' "$WORK/ssh.log"; then
    ok 'refuses a mutable tag as deployment input'
  else
    bad 'refuses a mutable tag as deployment input' "$(tail -2 "$WORK/ssh.log")"
  fi
fi
if try_over_ssh "ghcr.io/shikoonet/shikoonet-platform:sha-${SHA_MERGED}"; then
  bad 'refuses a sha- tag, which looks immutable and is not' 'it accepted the tag'
else
  if grep -qF 'not an immutable digest' "$WORK/ssh.log"; then
    ok 'refuses a sha- tag, which looks immutable and is not'
  else
    bad 'refuses a sha- tag, which looks immutable and is not' "$(tail -2 "$WORK/ssh.log")"
  fi
fi

# ═════════════════════════════════════════════════════════════════════════
# deploy.yml — the properties no script can assert about itself
# ═════════════════════════════════════════════════════════════════════════
section 'deploy.yml — trigger, gating and secret ordering'

wf() { grep -qF "$1" "$WORKFLOW"; }
assert_wf() { # name  substring
  if wf "$2"; then ok "$1"; else bad "$1" "deploy.yml does not contain: $2"; fi
}
refute_wf() { # name  substring
  if wf "$2"; then bad "$1" "deploy.yml still contains: $2"; else ok "$1"; fi
}

assert_wf 'only a successful CI run triggers a deploy' "workflow_run.conclusion == 'success'"
assert_wf 'a CI run from a pull request cannot deploy' "workflow_run.event == 'push'"
assert_wf 'only main can deploy' "workflow_run.head_branch == 'main'"
# The `${{ }}` below are the literal text of the workflow file, which is exactly
# what these assertions are for — SC2016 is the expected reading, not a mistake.
# shellcheck disable=SC2016
assert_wf 'the built ref is the exact sha CI passed' 'ref: ${{ github.event.workflow_run.head_sha }}'
assert_wf 'the deploy is serialised' 'group: deploy'
assert_wf 'a running deploy is never cancelled' 'cancel-in-progress: false'
assert_wf 'production is compared to the exact string true' "vars.PRODUCTION_AUTO_DEPLOY == 'true'"
assert_wf 'the staging bot is explicitly off' "DEPLOY_BOT_ENABLED: 'false'"
refute_wf 'no cache is read from pull request runs' 'type=gha'

# The gate must not be able to see a deployment secret, and everything that can
# must depend on it. Checked by walking the job blocks rather than by grepping
# the file flat, because «which job» is the entire property.
python3 - "$WORKFLOW" <<'PY' >"$WORK/jobs.txt"
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
body = text.split('\njobs:\n', 1)[1]
# Job blocks start at exactly two spaces of indent.
starts = [(m.start(), m.group(1)) for m in re.finditer(r'^  ([a-z][a-z0-9_-]*):$', body, re.M)]
for i, (pos, name) in enumerate(starts):
    end = starts[i + 1][0] if i + 1 < len(starts) else len(body)
    block = body[pos:end]
    print('\t'.join([
        name,
        'env' if re.search(r'^    environment:', block, re.M) else '-',
        'secrets' if 'secrets.DEPLOY_' in block else '-',
        (re.search(r'^    needs: (.+)$', block, re.M) or [None, '-'])[1].strip(),
        'if' if re.search(r'^    if:', block, re.M) else '-',
    ]))
PY

job_field() { awk -F'\t' -v j="$1" -v c="$2" '$1==j{print $c}' "$WORK/jobs.txt"; }

if [ "$(job_field gate 2)" = '-' ] && [ "$(job_field gate 3)" = '-' ]; then
  ok 'the gate job has no environment and touches no deployment secret'
else
  bad 'the gate job has no environment and touches no deployment secret' "$(grep '^gate' "$WORK/jobs.txt")"
fi

bad_ordering=''
while IFS=$'\t' read -r name env secrets needs _; do
  [ "$env$secrets" = '--' ] && continue
  case "$name" in
    promote) continue ;; # dispatch-only; its provenance is the staging artifact
  esac
  case "$needs" in
    *gate*) ;;
    *) bad_ordering="$bad_ordering $name" ;;
  esac
done <"$WORK/jobs.txt"
if [ -z "$bad_ordering" ]; then
  ok 'every job that can read a deployment secret depends on the gate'
else
  bad 'every job that can read a deployment secret depends on the gate' "not gated:$bad_ordering"
fi

if [ "$(job_field production 5)" = 'if' ]; then
  ok 'the production job is behind an if, so it never enters its environment while off'
else
  bad 'the production job is behind an if, so it never enters its environment while off' 'no if: on production'
fi

# Digest, never a tag, as the thing deployed.
if grep -E 'IMAGE_REF: .*@\$\{\{ (needs\.image\.outputs\.digest|steps\.read\.outputs\.digest) \}\}' "$WORKFLOW" >/dev/null &&
  ! grep -E 'IMAGE_REF: .*:sha-' "$WORKFLOW" >/dev/null; then
  ok 'staging, production and promote all deploy a digest and never a tag'
else
  bad 'staging, production and promote all deploy a digest and never a tag' "$(grep -n IMAGE_REF "$WORKFLOW")"
fi

# shellcheck disable=SC2016
if [ "$(grep -c 'IMAGE_REF: ${{ env.IMAGE_NAME }}@${{ needs.image.outputs.digest }}' "$WORKFLOW")" = '2' ]; then
  ok 'staging and production deploy the same digest from the same build'
else
  bad 'staging and production deploy the same digest from the same build' 'the two IMAGE_REFs differ'
fi

# shellcheck disable=SC2016
if grep -qF 'run-id: ${{ inputs.staging_run_id }}' "$WORKFLOW" &&
  ! awk '/^  promote:/,0' "$WORKFLOW" | grep -qF 'build-push-action'; then
  ok 'promotion reads the digest staging passed and never rebuilds'
else
  bad 'promotion reads the digest staging passed and never rebuilds' 'promote builds, or does not read the artifact'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
