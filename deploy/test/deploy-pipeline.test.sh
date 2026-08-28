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
OWNER='Isusami'

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
      body=''
      prev=''
      for a in "$@"; do
        [ "$prev" = '--request' ] && method="$a"
        [ "$prev" = '--data' ] && body="$a"
        prev="$a"
      done
      case "$method:$path" in
        GET:/applications/*/envs)
          if [ "${FAKE_NO_ENV_NAME:-}" = '1' ]; then
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"}]'
          else
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"},{"key":"ENV_NAME","value":"production"}]'
          fi ;;
        PATCH:/applications/*/envs | POST:/applications/*/envs)
          printf '{"ok":true}' ;;
        PATCH:/applications/*)
          if [ "${FAKE_COOLIFY_REFUSES:-}" = '1' ]; then
            printf '{"message":"Validation failed."}' >&2
            exit 22
          fi
          # Coolify 4.3.11 has no `dockerimage` case in BuildPackTypes, so any
          # PATCH carrying that field is a 422. The fake refuses it the same way
          # so the script cannot start sending it again without a red test.
          case "$body" in
            *build_pack*)
              printf '{"message":"Validation failed.","errors":{"build_pack":["The selected build pack is invalid."]}}' >&2
              exit 22 ;;
          esac
          printf '%s\n' "${path#/applications/}" >>"$FAKE_PINS"
          printf '{"ok":true}' ;;
        POST:/deploy*)
          uuid=${path#*uuid=}
          printf '%s\n' "$uuid" >>"$FAKE_DEPLOYS"
          # The replacement container appears only once a deploy is queued.
          printf '%s\n' "$uuid" >>"$FAKE_REPLACED"
          printf '{"ok":true}' ;;
        GET:/applications/*)
          pack=${FAKE_BUILD_PACK:-dockerimage}
          # Somebody editing the application in the Coolify UI midway through a
          # deploy: the type is right for the first N reads and wrong after.
          if [ -n "${FAKE_FLIP_AFTER:-}" ]; then
            printf 'x\n' >>"$FAKE_APP_READS"
            [ "$(wc -l <"$FAKE_APP_READS")" -gt "$FAKE_FLIP_AFTER" ] && pack=dockerfile
          fi
          printf '{"uuid":"x","build_pack":"%s","docker_registry_image_name":"%s"}' \
            "$pack" "${FAKE_APP_IMAGE:-ghcr.io/x/y}" ;;
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
runs_json() { printf '{"workflow_runs":[{"id":%s}]}' "${1:-9001}"; }
merged_by_json() { printf '{"number":7,"merged_by":{"login":"%s"}}' "$1"; }
jobs_json() { printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"},{"name":"Required Quality Gate","status":"completed","conclusion":"%s"}]}' "$1"; }
commit_json() { printf '{"sha":"%s"}' "$1"; }

# The whole happy path, which each test then breaks in exactly one place.
happy() { # [reviews-json]
  reset_scenarios
  # Each helper owns the mode, so a solo case cannot leak into the team case
  # that follows it and quietly turn it into a test of something else.
  GATE_MODE='team'
  GATE_OWNER=''
  scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged author "$SHA_PRHEAD")"
  scenario "/pulls/7/reviews" 200 "${1:-[$(review APPROVED reviewer "$SHA_PRHEAD")]}"
  scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json)"
  scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
  scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
}

GATE_LOG="$WORK/gate.log"

# `team` unless a test says otherwise, so every case written before there were
# modes still asks the question it was written to ask. The mode is passed
# explicitly rather than defaulted inside the script — an unset mode is its own
# test, below, and it denies.
GATE_MODE='team'
GATE_OWNER=''
run_gate() { # -> exit code, output in $GATE_LOG
  set +e
  env GITHUB_TOKEN="$FAKE_TOKEN" GITHUB_API='https://api.github.com' \
    DEPLOY_APPROVAL_MODE="$GATE_MODE" SOLO_DEPLOY_OWNER="$GATE_OWNER" \
    bash "$GATE" 'Shikoonet/Shikoonet-Platform' "$SHA_MERGED" >"$GATE_LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}

# The solo happy path: the owner wrote it, the owner merged it, CI passed on
# the branch AND on the merge commit, and nobody reviewed it — which is the
# whole point of the mode.
#
# `/pulls/7` is registered AFTER `/pulls/7/reviews` on purpose: the fake matches
# the first fragment that is a substring of the URL, and `/pulls/7` is one of
# `/pulls/7/reviews`.
solo_happy() { # [reviews-json] [merged-by]
  reset_scenarios
  GATE_MODE='solo'
  GATE_OWNER="$OWNER"
  scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "$OWNER" "$SHA_PRHEAD")"
  scenario "/pulls/7/reviews" 200 "${1:-[]}"
  scenario "/pulls/7" 200 "$(merged_by_json "${2:-$OWNER}")"
  scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
  scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
  scenario "/actions/runs?head_sha=${SHA_MERGED}" 200 "$(runs_json 9002)"
  scenario "/actions/runs/9002/jobs" 200 "$(jobs_json success)"
  scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
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
section 'the approval mode itself — unset and misspelled both deny'

# There is no default. Both tempting defaults are wrong: `team` turns a typo
# into a deploy that never runs, `solo` turns a typo into a deploy nobody
# reviewed.
happy
GATE_MODE=''
denies 'refuses when no approval mode is set at all' "must be exactly 'team' or 'solo'"

for bad_mode in SOLO Solo sOlO solo-owner TEAM 1 yes true; do
  happy
  GATE_MODE="$bad_mode"
  denies "refuses the mode «${bad_mode}» rather than guessing what it meant" \
    "must be exactly 'team' or 'solo'"
done
GATE_MODE='team'

solo_happy
GATE_OWNER=''
denies 'refuses solo mode with nobody allowlisted' 'needs SOLO_DEPLOY_OWNER'

section 'team mode — unchanged, and still needs somebody else to have looked'

happy '[]'
denies 'team mode still requires a non-author human approval' 'no current APPROVED review'

happy
if run_gate && grep -qF 'policy=team-approved' "$GATE_LOG"; then
  ok 'team mode passes and records itself as team-approved'
else
  bad 'team mode passes and records itself as team-approved' "$(tail -2 "$GATE_LOG")"
fi

section 'solo-owner mode — one named person, and no invented review'

solo_happy
if run_gate; then
  ok 'the owner may ship their own merged, green pull request'
else
  bad 'the owner may ship their own merged, green pull request' "$(tail -3 "$GATE_LOG")"
fi

solo_happy
if run_gate && grep -qF 'policy=solo-owner' "$GATE_LOG" &&
  grep -qF 'NOT reviewed by anyone else' "$GATE_LOG"; then
  ok 'says in the audit line that nobody reviewed it, rather than claiming an approval'
else
  bad 'says in the audit line that nobody reviewed it, rather than claiming an approval' \
    "$(tail -2 "$GATE_LOG")"
fi

solo_happy
if run_gate && ! grep -qE 'approved by [1-9]' "$GATE_LOG"; then
  ok 'never reports a self-approval as a human approval'
else
  bad 'never reports a self-approval as a human approval' 'the log claimed an approval'
fi

# Somebody else's pull request, merged by the owner. The author check is what
# stops the owner rubber-stamping a branch they did not write.
solo_happy
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged outsider "$SHA_PRHEAD")"
reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged outsider "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/pulls/7" 200 "$(merged_by_json "$OWNER")"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses a pull request the owner did not write' 'allows only @Isusami to ship unreviewed'

solo_happy '[]' 'someone-else'
denies 'refuses a pull request the owner did not merge' 'merged by @someone-else'

solo_happy
scenario '/pulls/7' 200 '{"number":7}'
reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "$OWNER" "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/pulls/7" 200 '{"number":7}'
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses when GitHub names nobody as the merger' 'reports nobody as its merger'

reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 '[]'
denies 'refuses a direct push to main in solo mode too' 'not the result of a merged pull request'

reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json open "$OWNER" "$SHA_PRHEAD")"
denies 'refuses an unmerged pull request in solo mode' 'not the result of a merged pull request'

solo_happy "[$(review CHANGES_REQUESTED reviewer "$SHA_PRHEAD")]"
denies 'an objection still blocks the owner' 'outstanding CHANGES_REQUESTED'

solo_happy
scenario '/actions/runs/9001/jobs' 200 "$(jobs_json failure)"
reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "$OWNER" "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/pulls/7" 200 "$(merged_by_json "$OWNER")"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json failure)"
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses when the final head is not green' 'did not succeed on the final head'

# The merge commit is a tree nobody has looked at — on a squash or rebase it
# has never existed before — so CI on it is the only thing standing between a
# bad merge and a deploy.
reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "$OWNER" "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/pulls/7" 200 "$(merged_by_json "$OWNER")"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
scenario "/actions/runs?head_sha=${SHA_MERGED}" 200 "$(runs_json 9002)"
scenario "/actions/runs/9002/jobs" 200 "$(jobs_json failure)"
scenario "/commits/main" 200 "$(commit_json "$SHA_MERGED")"
denies 'refuses when post-merge CI failed on the exact commit being deployed' \
  'did not succeed on the merge commit'

solo_happy
scenario '/commits/main' 200 "$(commit_json "$SHA_OTHER")"
reset_scenarios
GATE_MODE='solo'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "$OWNER" "$SHA_PRHEAD")"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/pulls/7" 200 "$(merged_by_json "$OWNER")"
scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
scenario "/actions/runs/9001/jobs" 200 "$(jobs_json success)"
scenario "/actions/runs?head_sha=${SHA_MERGED}" 200 "$(runs_json 9002)"
scenario "/actions/runs/9002/jobs" 200 "$(jobs_json success)"
scenario "/commits/main" 200 "$(commit_json "$SHA_OTHER")"
denies 'refuses when main moved while it was being evaluated' 'moved'

solo_happy
FAKE_CURL_DIES=1
export FAKE_CURL_DIES
denies 'fails closed on an API error in solo mode' 'failing closed'
unset FAKE_CURL_DIES

section 'provenance — one pull request, or none'

# Two merged pull requests claiming one commit means «which one was reviewed»
# has no answer, and picking the first would make the audit line a coin toss.
reset_scenarios
GATE_MODE='team'
scenario "/commits/${SHA_MERGED}/pulls" 200 \
  "[$(printf '{"number":7,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"},"user":{"login":"a"}}' "$SHA_MERGED" "$SHA_PRHEAD"),$(printf '{"number":8,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"},"user":{"login":"b"}}' "$SHA_MERGED" "$SHA_OLDER")]"
denies 'refuses when two merged pull requests claim the same commit' 'ambiguous'

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
      *RepoDigests*)    printf '%s\n' "${FAKE_REPO_DIGEST:-ghcr.io/x/y@sha256:abc}" ;;
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
  : >"$WORK/appreads"
  set +e
  env \
    FAKE_COOLIFY_URL='http://127.0.0.1:8000' \
    FAKE_PINS="$WORK/pins" FAKE_DEPLOYS="$WORK/deploys" FAKE_REPLACED="$WORK/replaced" \
    FAKE_LABEL_SHA="$SHA_MERGED" FAKE_BUILD_PACK="${FAKE_BUILD_PACK:-dockerimage}" \
    FAKE_APP_IMAGE="${FAKE_APP_IMAGE:-ghcr.io/x/y}" FAKE_REPO_DIGEST="${FAKE_REPO_DIGEST:-ghcr.io/x/y@sha256:abc}" \
    FAKE_NO_ENV_NAME="${FAKE_NO_ENV_NAME:-}" FAKE_COOLIFY_REFUSES="${FAKE_COOLIFY_REFUSES:-}" \
    FAKE_FLIP_AFTER="${FAKE_FLIP_AFTER:-}" FAKE_APP_READS="$WORK/appreads" \
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

section 'deploy.sh — an application that would rebuild instead of pulling'

# `build_pack=dockerfile` makes Coolify ignore the registry fields and rebuild
# from git. The deploy would go green, report a healthy container, and be
# running something this pipeline never verified — the digest guarantee lost
# silently, which is the worst way to lose it.
FAKE_BUILD_PACK=dockerfile
if run_deploy false; then
  bad 'refuses an application Coolify would rebuild from git' 'it deployed anyway'
else
  if grep -qF 'not a Docker Image application' "$DEPLOY_LOG"; then
    ok 'refuses an application Coolify would rebuild from git'
  else
    bad 'refuses an application Coolify would rebuild from git' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi

# And refuses it BEFORE the migration, so a misconfigured application costs
# nothing: the running containers are still consistent with the schema they
# booted on and there is nothing to undo.
if grep -qF 'migrating' "$DEPLOY_LOG"; then
  bad 'refuses before migrating, so nothing has to be undone' 'it migrated first'
else
  ok 'refuses before migrating, so nothing has to be undone'
fi
unset FAKE_BUILD_PACK

# The application is a Docker Image application, but pinned to somebody else's
# repository. The tag would land there and Coolify would pull an image nothing
# here built.
FAKE_APP_IMAGE='ghcr.io/someone/else'
if run_deploy false; then
  bad 'refuses an application pinned to another image repository' 'it deployed anyway'
else
  if grep -qF 'refusing to point it somewhere else' "$DEPLOY_LOG"; then
    ok 'refuses an application pinned to another image repository'
  else
    bad 'refuses an application pinned to another image repository' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi
unset FAKE_APP_IMAGE

# ENV_NAME, the failure that actually happened: the bot had none, so a deploy
# pushed a new image, watched three containers crash-loop and rolled back. All
# of it knowable from one GET before anything was touched.
FAKE_NO_ENV_NAME=1
if run_deploy false; then
  bad 'refuses an application with no ENV_NAME before touching anything' 'it deployed anyway'
else
  if grep -qF 'has no ENV_NAME' "$DEPLOY_LOG" && ! grep -qF 'migrating' "$DEPLOY_LOG"; then
    ok 'refuses an application with no ENV_NAME before touching anything'
  else
    bad 'refuses an application with no ENV_NAME before touching anything' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi
unset FAKE_NO_ENV_NAME

# The pre-flight runs before the migration, and the migration takes time. An
# application edited in the Coolify UI during that window would move out from
# under a check that already passed. The two application reads below are the
# pre-flight's; the third is the one `roll_one` makes immediately before it
# writes.
FAKE_FLIP_AFTER=2
if run_deploy false; then
  bad 'catches an application whose type changed after the pre-flight' 'it deployed anyway'
else
  if grep -qF 'not a Docker Image application' "$DEPLOY_LOG" &&
    ! grep -q '^uuid-ingest$' "$WORK/deploys"; then
    ok 'catches an application whose type changed after the pre-flight'
  else
    bad 'catches an application whose type changed after the pre-flight' \
      "$(tail -2 "$DEPLOY_LOG")"
  fi
fi
unset FAKE_FLIP_AFTER

section 'deploy.sh — the container must carry the digest that was deployed'

# Healthy is not the same as correct. This is the one failure nothing else on
# the box would report: the right container, running the wrong bytes.
FAKE_REPO_DIGEST='ghcr.io/x/y@sha256:0000000000000000000000000000000000000000000000000000000000000000'
if run_deploy false; then
  bad 'fails when the running container carries a different digest' 'it reported success'
else
  if grep -qF 'deployed bytes do not match' "$DEPLOY_LOG"; then
    ok 'fails when the running container carries a different digest'
  else
    bad 'fails when the running container carries a different digest' "$(tail -3 "$DEPLOY_LOG")"
  fi
fi
unset FAKE_REPO_DIGEST

if run_deploy false && grep -qF 'running the exact digest this deploy pulled' "$DEPLOY_LOG"; then
  ok 'verifies the digest of every application it deployed'
else
  bad 'verifies the digest of every application it deployed' "$(tail -3 "$DEPLOY_LOG")"
fi

section 'deploy.sh — a Coolify refusal costs nothing'

# The 422 that started this: Coolify refuses the write, and the deploy must stop
# with the database and every container exactly as they were.
FAKE_COOLIFY_REFUSES=1
if run_deploy false; then
  bad 'a Coolify API refusal stops the deploy' 'it deployed anyway'
else
  ok 'a Coolify API refusal stops the deploy'
fi
unset FAKE_COOLIFY_REFUSES

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
# A malformed digest, and no reference at all. Refused before an SSH session is
# opened and before the deploy flock is taken, so a bad promotion input never
# reaches the box.
#
# The REASON is asserted, not merely the exit code. This loop sat above
# `try_over_ssh`'s definition for one commit, so every case exited 127 with
# «command not found» and was recorded as a pass — a test that asserted
# nothing while reading green.
for bad_ref in 'ghcr.io/shikoonet/shikoonet-platform@sha256' 'ghcr.io/shikoonet/shikoonet-platform@md5:abc' ''; do
  name="refuses the malformed reference '${bad_ref:-<empty>}'"
  if try_over_ssh "$bad_ref"; then
    bad "$name" 'it was accepted'
  elif grep -qF 'not an immutable digest' "$WORK/ssh.log"; then
    ok "$name"
  else
    bad "$name" "refused, but not as a bad digest: $(tail -1 "$WORK/ssh.log")"
  fi
done

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

# Exactly one job may start a bot, and it is the production one. Counted rather
# than merely present: staging shares the shop's Telegram token, so a second
# poller would take updates from the bot real customers are talking to, and the
# way that mistake arrives is somebody copying the production block.
if [ "$(grep -c "DEPLOY_BOT_ENABLED: 'false'" "$WORKFLOW")" = '1' ] &&
  [ "$(grep -c "DEPLOY_BOT_ENABLED: 'true'" "$WORKFLOW")" = '2' ]; then
  ok 'the bot ships with production and with a promotion, and with nothing else'
else
  bad 'the bot ships with production and with a promotion, and with nothing else' \
    "$(grep -n DEPLOY_BOT_ENABLED "$WORKFLOW")"
fi

# The staging job specifically, by walking its block rather than the file.
if awk '/^  staging:/,/^  production:/' "$WORKFLOW" | grep -qF "DEPLOY_BOT_ENABLED: 'true'"; then
  bad 'staging never starts a bot' 'the staging job enables it'
else
  ok 'staging never starts a bot'
fi
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

# Every job that hands a registry token to the box must carry `packages: read`.
#
# Without it the token logs in and then reads nothing — «installation not
# allowed to Read organization package», on a digest this same workflow pushed
# a minute earlier. It cost two failed production deploys, and it is invisible:
# the job declares no permissions at all and silently inherits a workflow-level
# block that has no packages scope. Granting the package to the repository does
# NOT cover it; the token needs the scope too.
for pulling in staging production promote; do
  if awk -v j="  ${pulling}:" '$0 == j {f=1; next} /^  [a-z][a-z0-9_-]*:$/ {f=0} f' "$WORKFLOW" |
    grep -qF 'packages: read'; then
    ok "the ${pulling} job may read the package it is told to deploy"
  else
    bad "the ${pulling} job may read the package it is told to deploy" \
      "no 'packages: read' in the ${pulling} job — docker pull will be refused"
  fi
done

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

section 'deploy.yml — solo mode still cannot reach production on its own'

assert_wf 'the approval mode is versioned in the workflow, not a settings toggle' \
  'DEPLOY_APPROVAL_MODE: solo'
assert_wf 'the allowlisted owner is versioned too' 'SOLO_DEPLOY_OWNER: Isusami'
# These assert the literal text of the workflow, so the `${{ }}` and the `$VAR`
# below are quoted exactly as they appear in it — SC2016 is the reading these
# lines want, not a mistake.
# shellcheck disable=SC2016
assert_wf 'the gate is told which mode to apply' 'DEPLOY_APPROVAL_MODE: ${{ env.DEPLOY_APPROVAL_MODE }}'
# shellcheck disable=SC2016
assert_wf 'the policy reaches the box, so the ledger records which one shipped it' \
  'DEPLOY_APPROVAL_POLICY: ${{ needs.gate.outputs.policy }}'

# Solo mode changes WHO may ship, not WHERE it lands. Production is still
# behind the same exact-string variable, which does not exist.
assert_wf 'production is still behind the exact-string flag under solo mode' \
  "vars.PRODUCTION_AUTO_DEPLOY == 'true'"
if [ "$(job_field production 5)" = 'if' ]; then
  ok 'the production job still never starts while the flag is absent'
else
  bad 'the production job still never starts while the flag is absent' 'no if: on production'
fi

section 'deploy.yml — promotion is deliberate, and only of a digest staging ran'

assert_wf 'promotion demands the word PROMOTE' "!= 'PROMOTE'"
# shellcheck disable=SC2016
assert_wf 'promotion demands the owner, not merely a token holder' '"$ACTOR" != "$OWNER"'
# shellcheck disable=SC2016
assert_wf 'promotion reads the ledger artifact of a named run' 'run-id: ${{ inputs.staging_run_id }}'
assert_wf 'promotion refuses anything that is not an immutable digest' \
  "is not an immutable digest"

# There is no digest input, which is the strongest form of «an arbitrary digest
# cannot be promoted»: there is nowhere to type one. The digest comes from an
# artifact that exists only because a staging deploy ran and smoke-tested.
if awk '/^  workflow_dispatch:/,/^  [a-z]/' "$WORKFLOW" | grep -qE '^ +(digest|image|tag|sha):'; then
  bad 'promotion accepts no digest, tag or sha as input' 'the dispatch takes one'
else
  ok 'promotion accepts no digest, tag or sha as input'
fi

# The checks live in a job with no `environment:`, so an unauthorised actor is
# refused before any job holding a production secret exists.
if [ "$(job_field promote-gate 2)" = '-' ] && [ "$(job_field promote-gate 3)" = '-' ]; then
  ok 'the promotion checks run before any production secret is in scope'
else
  bad 'the promotion checks run before any production secret is in scope' \
    "$(grep '^promote-gate' "$WORK/jobs.txt")"
fi
case "$(job_field promote 4)" in
  *promote-gate*) ok 'the privileged promote job depends on those checks' ;;
  *) bad 'the privileged promote job depends on those checks' 'promote does not need promote-gate' ;;
esac

if awk '/^  promote:/,0' "$WORKFLOW" | grep -qF 'build-push-action'; then
  bad 'promotion never rebuilds the image' 'promote builds'
else
  ok 'promotion never rebuilds the image'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
