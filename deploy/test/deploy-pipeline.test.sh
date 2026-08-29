#!/usr/bin/env bash
#
# The deploy path, driven against a fake GitHub, a fake Coolify and a fake
# Docker — plus the assertions about `deploy-staging.yml` that no script can make.
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
WORKFLOW="$ROOT/.github/workflows/deploy-staging.yml"
PROMOTE_WF="$ROOT/.github/workflows/promote-production.yml"
for f in "$GATE" "$DEPLOY" "$OVER_SSH" "$WORKFLOW" "$PROMOTE_WF"; do
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
# A canonical 64-hex digest. The fixtures used `sha256:abc`, which the digest
# rule now rejects — and which never resembled what a registry returns.
DIGEST='27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a'

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
          app=${path#/applications/}
          app=${app%%/*}
          if [ -n "${FAKE_ENV_ROWS:-}" ] && grep -q "^$app|" "$FAKE_ENV_ROWS" 2>/dev/null; then
            # A store, not a fixture: what this application has been asked to
            # create, minus what it has been asked to delete. Nothing else can
            # show that the SECOND deploy is the one that used to refuse.
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"},{"key":"ENV_NAME","value":"production"}'
            while IFS='|' read -r a u k v; do
              [ "$a" = "$app" ] || continue
              printf ',{"uuid":"%s","key":"%s","value":"%s"}' "$u" "$k" "$v"
            done <"$FAKE_ENV_ROWS"
            printf ']'
          elif [ "${FAKE_MALFORMED_ENVS:-}" = 'json' ]; then
            printf '{not-json'
          elif [ "${FAKE_MALFORMED_ENVS:-}" = 'object' ]; then
            printf '{"key":"ENV_NAME","value":"production"}'
          elif [ "${FAKE_NO_ENV_NAME:-}" = '1' ]; then
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"}]'
          elif [ "${FAKE_DUPLICATE_ENVS:-}" = '1' ]; then
            # The shape the staging bot was actually in: every key twice, one
            # form submitted twice. ENV_NAME is present, so this passes the
            # older check and has to be caught by the newer one.
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"},{"key":"DATABASE_URL","value":"postgres://u:p@other:5432/shikoo"},{"key":"ENV_NAME","value":"production"},{"key":"ENV_NAME","value":"production"},{"key":"TELEGRAM_BOT_TOKEN","value":"x"},{"key":"TELEGRAM_BOT_TOKEN","value":"y"}]'
          else
            printf '[{"key":"DATABASE_URL","value":"postgres://u:p@db:5432/shikoo"},{"key":"ENV_NAME","value":"production"}]'
          fi ;;
        PATCH:/applications/*/envs)
          # The 404 a PATCH gets on an application that has never held the
          # variable — the only way the create path is ever reached.
          if [ "${FAKE_ENV_PATCH_FAILS:-}" = '1' ]; then
            printf '{"message":"Environment variable not found."}' >&2
            exit 22
          fi
          printf '{"ok":true}' ;;
        POST:/applications/*/envs)
          if [ -n "${FAKE_ENV_ROWS:-}" ]; then
            app=${path#/applications/}
            app=${app%%/*}
            kv=$(printf '%s' "$body" | python3 -c 'import json,sys
d = json.load(sys.stdin)
print("%s	%s" % (d["key"], d["value"]))')
            k=${kv%%$'	'*}
            v=${kv#*$'	'}
            n=$(($(wc -l <"$FAKE_ENV_ROWS") + 1))
            # ONE post, TWO rows. Measured against the live Coolify panel on
            # 2026-08-29 with a throwaway key: the response named one uuid and
            # the application then listed that row and a second one holding the
            # same value.
            printf '%s|row%da|%s|%s
%s|row%db|%s|%s
'               "$app" "$n" "$k" "$v" "$app" "$n" "$k" "$v" >>"$FAKE_ENV_ROWS"
            printf '{"uuid":"row%da"}' "$n"
          else
            printf '{"ok":true}'
          fi ;;
        DELETE:/applications/*/envs/*)
          if [ -n "${FAKE_ENV_ROWS:-}" ]; then
            gone=${path##*/}
            grep -v "|$gone|" "$FAKE_ENV_ROWS" >"$FAKE_ENV_ROWS.keep" || true
            mv "$FAKE_ENV_ROWS.keep" "$FAKE_ENV_ROWS"
          fi
          printf '{"message":"Environment variable deleted."}' ;;
        PATCH:/applications/*)
          if [ "${FAKE_COOLIFY_REFUSES:-}" = '1' ]; then
            printf '{"message":"Validation failed."}' >&2
            exit 22
          fi
          # Coolify 4.3.11 has no `dockerimage` case in BuildPackTypes, so any
          # PATCH carrying that MEMBER is a 422. The fake refuses it the same
          # way, so the script cannot start sending it again without a red test.
          #
          # Parsed, not grepped. A `case "$body" in *build_pack*)` glob would
          # also fire on an image name or tag that merely contains the words —
          # rejecting a request Coolify would accept, and proving nothing about
          # what the PATCH actually sent. Coolify validates a member; so does
          # this.
          if printf '%s' "$body" | python3 -c 'import json,sys
try:
    d = json.load(sys.stdin)
except Exception:
    d = {}
sys.exit(0 if isinstance(d, dict) and "build_pack" in d else 1)'; then
            printf '{"message":"Validation failed.","errors":{"build_pack":["The selected build pack is invalid."]}}' >&2
            exit 22
          fi
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
denies 'refuses when no approval mode is set at all' "must be exactly 'team', 'solo' or 'owner-or-approved'"

for bad_mode in SOLO Solo sOlO solo-owner TEAM 1 yes true; do
  happy
  GATE_MODE="$bad_mode"
  denies "refuses the mode «${bad_mode}» rather than guessing what it meant" \
    "must be exactly 'team', 'solo' or 'owner-or-approved'"
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

# ═════════════════════════════════════════════════════════════════════════
section 'owner-or-approved — the owner ships their own, everybody else is reviewed'

# The mode exists because `solo` could not ship contributor work at all. The
# author check denied before the merged-by check was ever read, so PR #20 by
# @arshiajacki — merged by the owner, green, unobjected — was refused with no
# branch to fall to. These cases pin both halves.

# The owner half is `solo` by another name: no review, and none invented.
owner_or_approved_owner() { # [reviews-json] [merged-by]
  solo_happy "${1:-[]}" "${2:-$OWNER}"
  GATE_MODE='owner-or-approved'
}

# The contributor half: written by somebody else, approved on the FINAL HEAD by
# a third human, merged by the owner, green on both shas.
# Every scenario set is built whole, never overridden after the fact: the fake
# matches the FIRST registered fragment that is a substring of the url, so a
# later `scenario` for the same path is dead weight that silently changes
# nothing.
owner_or_approved_contributor() { # [reviews] [merged-by] [author] [head-jobs] [merge-jobs] [main-sha]
  reset_scenarios
  GATE_MODE='owner-or-approved'
  GATE_OWNER="$OWNER"
  scenario "/commits/${SHA_MERGED}/pulls" 200 "$(pr_json merged "${3:-contributor}" "$SHA_PRHEAD")"
  scenario "/pulls/7/reviews" 200 "${1:-[$(review APPROVED reviewer "$SHA_PRHEAD")]}"
  scenario "/pulls/7" 200 "$(merged_by_json "${2:-$OWNER}")"
  scenario "/actions/runs?head_sha=${SHA_PRHEAD}" 200 "$(runs_json 9001)"
  scenario "/actions/runs/9001/jobs" 200 "$(jobs_json "${4:-success}")"
  scenario "/actions/runs?head_sha=${SHA_MERGED}" 200 "$(runs_json 9002)"
  scenario "/actions/runs/9002/jobs" 200 "$(jobs_json "${5:-success}")"
  scenario "/commits/main" 200 "$(commit_json "${6:-$SHA_MERGED}")"
}

owner_or_approved_owner
if run_gate && grep -qF 'policy=solo-owner' "$GATE_LOG"; then
  ok 'the owner still ships their own work, recorded as solo-owner'
else
  bad 'the owner still ships their own work, recorded as solo-owner' \
    "$(tail -3 "$GATE_LOG" | tr '\n' ' ')"
fi

owner_or_approved_contributor
if run_gate && grep -qF 'policy=team-approved' "$GATE_LOG"; then
  ok 'a reviewed contributor PR ships, recorded as team-approved'
else
  bad 'a reviewed contributor PR ships, recorded as team-approved' \
    "$(tail -3 "$GATE_LOG" | tr '\n' ' ')"
fi

# This is the exact shape that was denied under `solo` — the regression the
# mode was added to fix. Naming it here means a revert cannot pass quietly.
owner_or_approved_contributor '[]' "$OWNER" 'arshiajacki'
denies 'a contributor PR with NO approval is still refused' \
  'no current APPROVED review from a human other than'

# Self-approval is not approval. `approvals` already excludes the author, so
# the count is zero and the deny message is the no-approval one.
owner_or_approved_contributor "[$(review APPROVED contributor "$SHA_PRHEAD")]"
denies 'the author approving themselves does not count' \
  'no current APPROVED review from a human other than'

# A stale approval approved a different tree. GitHub keeps the row for ever.
owner_or_approved_contributor "[$(review APPROVED reviewer "$SHA_OLDER")]"
denies 'an approval given on an earlier head does not count' \
  'no current APPROVED review from a human other than'

# A bot agreeing with a machine is not a person having looked.
owner_or_approved_contributor "[$(review APPROVED coderabbitai reviewer-bot Bot)]"
denies 'a Bot approval does not count as a human review' \
  'no current APPROVED review from a human other than'

# Somebody looked and said no. Outranks any policy about who may ship.
owner_or_approved_contributor \
  "[$(review APPROVED reviewer "$SHA_PRHEAD"),$(review CHANGES_REQUESTED other "$SHA_PRHEAD")]"
denies 'an outstanding CHANGES_REQUESTED blocks a reviewed contributor PR' \
  'outstanding CHANGES_REQUESTED'

# Reviewed is not sufficient on its own: an approval says the tree was read,
# not that shipping it was intended.
owner_or_approved_contributor '' 'someone-else'
denies 'a reviewed contributor PR merged by somebody else is refused' \
  'not @'

# The owner half keeps its own merged-by assertion.
owner_or_approved_owner '[]' 'someone-else'
denies 'the owner half still refuses a PR merged by somebody else' 'not @'

# The Quality Gate is asked on the merge commit in this mode too — the approval
# was given on the final head, and the merge commit is a different tree.
owner_or_approved_contributor '' '' '' success failure
denies 'a red Quality Gate on the merge commit refuses a reviewed contributor PR' \
  'did not succeed on the merge commit'

owner_or_approved_contributor '' '' '' failure
denies 'a red Quality Gate on the final head refuses a reviewed contributor PR' \
  'did not succeed on the final head'

# Direct pushes do not deploy, in this mode either.
reset_scenarios
GATE_MODE='owner-or-approved'
GATE_OWNER="$OWNER"
scenario "/commits/${SHA_MERGED}/pulls" 200 '[]'
denies 'refuses a direct push to main in owner-or-approved mode' \
  'not the result of a merged pull request'

# The branch race, in this mode too.
owner_or_approved_contributor '' '' '' success success "$SHA_OTHER"
denies 'refuses when main moved during an owner-or-approved evaluation' 'moved'

# Fails closed, in this mode too.
owner_or_approved_contributor
FAKE_CURL_DIES=1
export FAKE_CURL_DIES
denies 'fails closed on an API error in owner-or-approved mode' 'failing closed'
unset FAKE_CURL_DIES

# The owner allowlist is required by this mode as well — without it the
# merged-by comparison has nothing to compare against and would pass empty.
owner_or_approved_contributor
GATE_OWNER=''
denies 'refuses owner-or-approved mode with nobody allowlisted' 'needs SOLO_DEPLOY_OWNER'
GATE_OWNER="$OWNER"
GATE_MODE='team'

# ═════════════════════════════════════════════════════════════════════════
section 'require-ci-run — the manual redeploy has to find a real green CI run'

# The automatic path gets «CI passed on this sha, as a push, on main» from the
# `workflow_run` event for free. A dispatch has no event to read it from, so it
# goes and asks — and the four conditions are asked together, because a run
# satisfying three of them is not a partial pass.

CI_RUN_LOG="$WORK/ci-run.log"
run_ci_check() { # -> exit code, output in $CI_RUN_LOG
  set +e
  env GITHUB_TOKEN="$FAKE_TOKEN" GITHUB_API='https://api.github.com' \
    GITHUB_OUTPUT="$WORK/ci-run.out" \
    bash "$ROOT/deploy/require-ci-run.sh" 'Shikoonet/Shikoonet-Platform' "$SHA_MERGED" \
    >"$CI_RUN_LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}
ci_runs() { # [event] [branch] [status] [conclusion]
  printf '{"workflow_runs":[{"id":7788,"event":"%s","head_branch":"%s","status":"%s","conclusion":"%s","run_started_at":"2026-08-28T08:00:00Z"}]}' \
    "${1:-push}" "${2:-main}" "${3:-completed}" "${4:-success}"
}
ci_denies() { # name  substring
  if run_ci_check; then
    bad "$1" 'it accepted the run when it had to deny'
    return
  fi
  if grep -qF "$2" "$CI_RUN_LOG"; then ok "$1"; else
    bad "$1" "denied, but not for '$2': $(tail -2 "$CI_RUN_LOG" | tr '\n' ' ')"
  fi
}

reset_scenarios
: >"$WORK/ci-run.out"
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs)"
if run_ci_check && grep -qF 'ci_run_id=7788' "$WORK/ci-run.out"; then
  ok 'a completed successful push run on main is accepted, and its id recorded'
else
  bad 'a completed successful push run on main is accepted, and its id recorded' \
    "$(tail -2 "$CI_RUN_LOG" | tr '\n' ' ')"
fi

# «CI never ran» and «CI ran and failed» are different mistakes and get
# different sentences: the first usually means the sha is not on main at all.
reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 '{"workflow_runs":[]}'
ci_denies 'refuses a sha nothing has tested' 'no CI run exists'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs push main completed failure)"
ci_denies 'refuses a sha whose CI run failed' 'none qualifying'

# A CI run FROM A PULL REQUEST must never authorise a deploy — a fork's run
# completing is something an outsider can trigger. Same refusal the
# `workflow_run` trigger makes on the automatic path.
reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs pull_request main completed success)"
ci_denies 'refuses a green run that came from a pull request' 'none qualifying'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs push some-branch completed success)"
ci_denies 'refuses a green run from another branch' 'none qualifying'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs push main in_progress '')"
ci_denies 'refuses a run that has not finished' 'none qualifying'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs push main completed cancelled)"
ci_denies 'refuses a cancelled run — cancelled is not a pass' 'none qualifying'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 500 '{"message":"boom"}'
ci_denies 'fails closed when the CI run list cannot be read' 'failing closed'

reset_scenarios
scenario "/actions/workflows/ci.yml/runs" 200 "$(ci_runs)"
FAKE_CURL_DIES=1
export FAKE_CURL_DIES
ci_denies 'fails closed when the API cannot be reached at all' 'failing closed'
unset FAKE_CURL_DIES

# The sha is an argument, not a free-text field: a short, uppercase or
# whitespace-bearing one is refused as malformed rather than repaired.
for bad_sha in 'abc' "$(printf '%040d' 0 | tr '0' 'A')" '  '; do
  set +e
  env GITHUB_TOKEN="$FAKE_TOKEN" GITHUB_API='https://api.github.com' \
    bash "$ROOT/deploy/require-ci-run.sh" 'Shikoonet/Shikoonet-Platform' "$bad_sha" \
    >"$CI_RUN_LOG" 2>&1
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    bad "require-ci-run refuses the sha '${bad_sha:0:8}'" 'it was accepted'
  else
    ok "require-ci-run refuses the sha '${bad_sha:0:8}'"
  fi
done

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
  exec)
    # Two different questions reach `docker exec`: Coolify's application
    # settings, and the bot singleton count. Told apart by the SQL, because
    # answering one with the other's shape is how this fake last lied.
    if printf '%s ' "$@" | grep -q 'application_settings'; then
      printf '%s\n' "${FAKE_COOLIFY_SETTINGS-f|f}"
    else
      printf '1\n'   # the bot singleton count
    fi
    exit 0 ;;
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
      *RepoDigests*)    printf '%s\n' "${FAKE_REPO_DIGEST:-ghcr.io/x/y@sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a}" ;;
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

# The same deploy, with a different image repository — so the PATCH body carries
# a value containing «build_pack» while sending no such member.
run_deploy_image() { # image-name
  IMAGE_UNDER_TEST="$1" run_deploy false
}

# The same deploy with a hand-written reference, valid or not, so the digest
# check can be exercised against the real script rather than against a copy of
# its regex.
run_deploy_ref() { # image-ref
  : >"$WORK/pins"
  : >"$WORK/deploys"
  : >"$WORK/replaced"
  : >"$WORK/appreads"
  rm -f "$WORK/state"
  set +e
  env \
    FAKE_COOLIFY_URL='http://127.0.0.1:8000' \
    FAKE_PINS="$WORK/pins" FAKE_DEPLOYS="$WORK/deploys" FAKE_REPLACED="$WORK/replaced" \
    FAKE_LABEL_SHA="$SHA_MERGED" FAKE_BUILD_PACK=dockerimage \
    FAKE_APP_IMAGE='ghcr.io/x/y' FAKE_REPO_DIGEST="ghcr.io/x/y@sha256:${DIGEST}" \
    FAKE_APP_READS="$WORK/appreads" \
    ENV_DIR="$ENVDIR" STATE_FILE="$WORK/state" LOCK_FILE="$WORK/lock" \
    WAIT_TIMEOUT=5 NETWORK=none DEPLOY_BOT_ENABLED=false \
    bash "$DEPLOY" production "$1" "$SHA_MERGED" \
    >"$DEPLOY_LOG" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

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
    FAKE_APP_IMAGE="${FAKE_APP_IMAGE:-ghcr.io/x/y}" FAKE_REPO_DIGEST="${FAKE_REPO_DIGEST:-${IMAGE_UNDER_TEST:-ghcr.io/x/y}@sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a}" \
    FAKE_NO_ENV_NAME="${FAKE_NO_ENV_NAME:-}" FAKE_COOLIFY_REFUSES="${FAKE_COOLIFY_REFUSES:-}" \
    FAKE_DUPLICATE_ENVS="${FAKE_DUPLICATE_ENVS:-}" FAKE_MALFORMED_ENVS="${FAKE_MALFORMED_ENVS:-}" \
    FAKE_FLIP_AFTER="${FAKE_FLIP_AFTER:-}" FAKE_APP_READS="$WORK/appreads"     FAKE_ENV_ROWS="${FAKE_ENV_ROWS:-}" FAKE_ENV_PATCH_FAILS="${FAKE_ENV_PATCH_FAILS:-}" \
    ENV_DIR="$ENVDIR" STATE_FILE="$WORK/state" LOCK_FILE="$WORK/lock" \
    WAIT_TIMEOUT=5 NETWORK=none DEPLOY_BOT_ENABLED="$1" \
    bash "$DEPLOY" production "${IMAGE_UNDER_TEST:-ghcr.io/x/y}@sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a" "$SHA_MERGED" \
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

section 'the fake Coolify refuses a build_pack MEMBER, not the words'

# The fake's refusal is what proves `deploy.sh` stopped sending the unsupported
# field. If it fired on any body merely CONTAINING the words, it would also
# reject requests Coolify accepts — and a green suite would prove nothing about
# what was actually sent.
#
# So: an image repository whose name contains the words must still deploy.
FAKE_APP_IMAGE='ghcr.io/x/build_pack-tools'
if IMAGE_NAME_OVERRIDE=1 run_deploy_image 'ghcr.io/x/build_pack-tools'; then
  ok 'a payload whose values merely contain «build_pack» is still accepted'
else
  bad 'a payload whose values merely contain «build_pack» is still accepted' \
    "$(tail -2 "$DEPLOY_LOG")"
fi
unset FAKE_APP_IMAGE

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

for malformed in json object; do
  FAKE_MALFORMED_ENVS=$malformed
  export FAKE_MALFORMED_ENVS
  if run_deploy false; then
    bad "refuses a malformed Coolify environment response (${malformed})" 'it deployed anyway'
  elif grep -qF 'could not read the application environment' "$DEPLOY_LOG" &&
    ! grep -qF 'migrating' "$DEPLOY_LOG"; then
    ok "refuses a malformed Coolify environment response (${malformed}) before migration"
  else
    bad "refuses a malformed Coolify environment response (${malformed})" "$(tail -3 "$DEPLOY_LOG")"
  fi
done
unset FAKE_MALFORMED_ENVS

# A key defined twice in Coolify. The staging bot held DATABASE_URL, ENV_NAME,
# SERVICE and TELEGRAM_BOT_TOKEN twice each on 2026-08-26 — and it has an
# ENV_NAME, so the check above says yes to it. Which of each pair the container
# gets is row order, and for two of those keys that is which environment it
# joins.
# Native Auto Deploy, asserted by the live path at last.
#
# `assert_coolify_safe` in the retired `autodeploy.sh` calls this "the whole
# defence", and means it literally: Coolify's webhook endpoint is reachable
# from the internet in plaintext, and the only thing making it inert is this
# flag being false. The pipeline that replaced that script inherited the risk
# and not the check — so for the whole of that window a single UI click could
# have re-enabled push-to-deploy and nothing would have said so.
FAKE_COOLIFY_SETTINGS='t|f'
export FAKE_COOLIFY_SETTINGS
if run_deploy false; then
  bad 'refuses an application with native Auto Deploy enabled' 'it deployed anyway'
else
  if grep -qF 'Auto Deploy ENABLED' "$DEPLOY_LOG" && ! grep -qF 'migrating' "$DEPLOY_LOG"; then
    ok 'refuses an application with native Auto Deploy enabled'
  else
    bad 'refuses an application with native Auto Deploy enabled' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi

FAKE_COOLIFY_SETTINGS='f|t'
if run_deploy false; then
  bad 'refuses an application with preview deployments enabled' 'it deployed anyway'
else
  if grep -qF 'preview deployments ENABLED' "$DEPLOY_LOG" && ! grep -qF 'migrating' "$DEPLOY_LOG"; then
    ok 'refuses an application with preview deployments enabled'
  else
    bad 'refuses an application with preview deployments enabled' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi

# Unreadable is not «fine». A deploy that cannot ask says so out loud rather
# than concluding the flag it could not read is the value it hoped for.
FAKE_COOLIFY_SETTINGS=''
if run_deploy false && grep -qF 'UNVERIFIED' "$DEPLOY_LOG"; then
  ok 'an unreadable Coolify settings row is reported, not assumed safe'
else
  bad 'an unreadable Coolify settings row is reported, not assumed safe' \
    "$(tail -2 "$DEPLOY_LOG")"
fi
unset FAKE_COOLIFY_SETTINGS

FAKE_DUPLICATE_ENVS=1
if run_deploy false; then
  bad 'refuses an application with a variable defined twice' 'it deployed anyway'
else
  if grep -qF 'defined more than once' "$DEPLOY_LOG" && ! grep -qF 'migrating' "$DEPLOY_LOG"; then
    ok 'refuses an application with a variable defined twice'
  else
    bad 'refuses an application with a variable defined twice' "$(tail -2 "$DEPLOY_LOG")"
  fi
fi

# Every duplicated key, named. A message that stops at the first one sends the
# operator back to the panel once per duplicate.
if grep -qF 'DATABASE_URL, ENV_NAME, TELEGRAM_BOT_TOKEN' "$DEPLOY_LOG"; then
  ok 'names every duplicated variable, not just the first'
else
  bad 'names every duplicated variable, not just the first' "$(tail -2 "$DEPLOY_LOG")"
fi
unset FAKE_DUPLICATE_ENVS

# ═════════════════════════════════════════════════════════════════════════
# The spare row Coolify creates alongside the one that was asked for
# ═════════════════════════════════════════════════════════════════════════
#
# Two deploys, because one cannot show this. On 2026-08-29 deploy 1 wrote
# `APP_VERSION` for the first time and passed; Coolify stored the value twice;
# deploy 2 refused with «APP_VERSION defined more than once» before it touched
# anything, and the staging environment sat behind `main` until a row was
# deleted by hand. The refusal was right — nothing in a deploy reads a value,
# so nothing in a deploy can tell which copy was meant — which is why the fix
# belongs in the create path and not in the check.
section 'the spare row Coolify creates alongside the one that was asked for'

FAKE_ENV_ROWS="$WORK/envrows"
: >"$FAKE_ENV_ROWS"
FAKE_ENV_PATCH_FAILS=1

if run_deploy true; then
  ok 'the deploy that creates APP_VERSION still succeeds'
else
  bad 'the deploy that creates APP_VERSION still succeeds' "$(tail -3 "$DEPLOY_LOG")"
fi

if grep -qF 'removed the spare APP_VERSION row' "$DEPLOY_LOG"; then
  ok 'the create path says out loud which row it removed'
else
  bad 'the create path says out loud which row it removed' "$(tail -3 "$DEPLOY_LOG")"
fi

# Three applications are rolled, so three rows survive — and each one holds
# THIS deploy's sha. Counting only the total would pass on a version that kept
# a stale row and deleted the one it had just written.
kept=$(grep -c "|APP_VERSION|" "$FAKE_ENV_ROWS" || true)
right=$(grep -c "|APP_VERSION|$SHA_MERGED\$" "$FAKE_ENV_ROWS" || true)
if [ "$kept" = 3 ] && [ "$right" = 3 ]; then
  ok 'one APP_VERSION row per application, holding the sha that was deployed'
else
  bad 'one APP_VERSION row per application, holding the sha that was deployed'     "kept=$kept right=$right: $(cat "$FAKE_ENV_ROWS")"
fi

# The assertion the whole section exists for. The store is carried over, the
# PATCH now finds a row, and this is the deploy that used to refuse.
unset FAKE_ENV_PATCH_FAILS
if run_deploy true && ! grep -qF 'defined more than once' "$DEPLOY_LOG"; then
  ok 'the deploy after it is not refused for a variable it wrote itself'
else
  bad 'the deploy after it is not refused for a variable it wrote itself'     "$(tail -3 "$DEPLOY_LOG")"
fi
unset FAKE_ENV_ROWS

# The pre-flight runs before the migration, and the migration takes time. An
# application edited in the Coolify UI during that window would move out from
# under a check that already passed.
#
# FOUR, because `assert_deployable` reads the application record twice — once
# for `build_pack`, once for `docker_registry_image_name` — and the pre-flight
# covers ingest and dashboard. Reads 1-4 are the pre-flight's and see the right
# type; read 5 is the one `roll_one` makes immediately before it writes.
#
# The first version of this test used 2, which flipped the type DURING the
# pre-flight. It passed, and proved the pre-flight works — not the re-check it
# was written for. So the assertion below now requires the pre-flight to have
# PASSED first: if that read count ever changes, this fails loudly instead of
# quietly testing the wrong guard again.
FAKE_FLIP_AFTER=4
name='catches an application whose type changed after the pre-flight'
if run_deploy false; then
  bad "$name" 'it deployed anyway'
elif grep -qF 'every application this deploy touches is set to deploy an image' "$DEPLOY_LOG" &&
  grep -qF 'not a Docker Image application' "$DEPLOY_LOG" &&
  ! grep -q '^uuid-ingest$' "$WORK/deploys"; then
  ok "$name"
else
  bad "$name" "pre-flight did not pass first, or a deploy was queued: $(tail -2 "$DEPLOY_LOG")"
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

section 'deploy.sh — a refused reference touches nothing at all'

# Exiting non-zero is not enough. A rejected reference must reach NOTHING: no
# Coolify request, no migration, no ledger line. The digest check sits above all
# three, and this is what proves it stays there.
D_BAD_CASES=(
  "ghcr.io/x/y@sha256:${DIGEST}
extra"
  " ghcr.io/x/y@sha256:${DIGEST}"
  "ghcr.io/x/y@sha256:${DIGEST} "
  "ghcr.io/x/y@sha256:${DIGEST}@sha256:${DIGEST}"
  'ghcr.io/x/y:latest'
  "ghcr.io/x/y@sha256:abc"
)
for ref in "${D_BAD_CASES[@]}"; do
  label=$(printf '%s' "$ref" | tr '\n' '~')
  if run_deploy_ref "$ref"; then
    bad "refuses and touches nothing: ${label:0:44}" 'it was accepted'
    continue
  fi
  problems=''
  grep -qF 'not an immutable digest' "$DEPLOY_LOG" || problems="$problems no-message"
  [ ! -s "$WORK/pins" ] || problems="$problems patched-coolify"
  [ ! -s "$WORK/deploys" ] || problems="$problems queued-deploy"
  grep -qF 'migrating' "$DEPLOY_LOG" && problems="$problems migrated"
  [ ! -s "$WORK/state" ] || problems="$problems wrote-ledger"
  if [ -z "$problems" ]; then
    ok "refuses and touches nothing: ${label:0:44}"
  else
    bad "refuses and touches nothing: ${label:0:44}" "side effects:$problems"
  fi
done

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
# The multiline case is the subtle one. `echo "$REF" | grep -qE '^…$'` matches
# LINE BY LINE, so a reference carrying a newline passed as long as one of its
# lines looked right — a valid digest with anything at all appended after a
# newline. Both layers match against the whole string now.
#
# `@sha256:` followed by anything used to pass: the check was a glob on the
# prefix, so «@sha256:abc» and «@sha256:» with nothing after it both read as
# immutable digests. They would have reached the box, taken the deploy flock and
# failed at `docker pull`.
for bad_ref in \
  'ghcr.io/shikoonet/shikoonet-platform@sha256' \
  'ghcr.io/shikoonet/shikoonet-platform@md5:abc' \
  'ghcr.io/shikoonet/shikoonet-platform@sha256:abc' \
  'ghcr.io/shikoonet/shikoonet-platform@sha256:' \
  "ghcr.io/shikoonet/shikoonet-platform@sha256:${DIGEST}00" \
  "ghcr.io/shikoonet/shikoonet-platform@sha256:${DIGEST^^}" \
  "ghcr.io/shikoonet/shikoonet-platform@sha256:${DIGEST}
extra" \
  ''; do
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
  if wf "$2"; then ok "$1"; else bad "$1" "deploy-staging.yml does not contain: $2"; fi
}
refute_wf() { # name  substring
  if wf "$2"; then bad "$1" "deploy-staging.yml still contains: $2"; else ok "$1"; fi
}

assert_wf 'only a successful CI run triggers a deploy' "workflow_run.conclusion == 'success'"
assert_wf 'a CI run from a pull request cannot deploy' "workflow_run.event == 'push'"
assert_wf 'only main can deploy' "workflow_run.head_branch == 'main'"
# The `${{ }}` below are the literal text of the workflow file, which is exactly
# what these assertions are for — SC2016 is the expected reading, not a mistake.
# shellcheck disable=SC2016
assert_wf 'the built ref is the exact sha CI passed' 'github.event.workflow_run.head_sha'
# shellcheck disable=SC2016
assert_wf 'the image is built from the sha the gate resolved, not a default ref' \
  'ref: ${{ needs.gate.outputs.sha }}'

# ── the manual redeploy names nothing ─────────────────────────────────────
#
# These are the load-bearing ones. Every other guard in this pipeline exists to
# prove that what ships is what was reviewed; a dispatch input naming a commit,
# a digest, an image or a ref hands that answer to whoever pressed the button.
# Asserting their ABSENCE textually is what makes adding one back a red build
# rather than a review somebody skimmed.
assert_wf 'the staging workflow can be redeployed by hand' 'workflow_dispatch:'

dispatch_block() { awk '/^on:/,/^permissions:/' "$WORKFLOW"; }

if dispatch_block | grep -qE '^\s+inputs:'; then
  bad 'the manual redeploy accepts no inputs at all' 'workflow_dispatch declares inputs'
else
  ok 'the manual redeploy accepts no inputs at all'
fi

for forbidden in sha ref digest image tag run_id revision commit; do
  if grep -qE "inputs\.${forbidden}\b" "$WORKFLOW"; then
    bad "no user-supplied ${forbidden} can reach the staging deploy" \
      "deploy-staging.yml reads inputs.${forbidden}"
  else
    ok "no user-supplied ${forbidden} can reach the staging deploy"
  fi
done

# shellcheck disable=SC2016
assert_wf 'a manual redeploy is refused unless it came from main' \
  '[ "$REF" != '"'"'refs/heads/main'"'"' ]'
assert_wf 'a manual redeploy resolves the sha from the ref, on the server' \
  'git rev-parse refs/heads/main'
assert_wf 'a manual redeploy requires CI to have passed on that sha' \
  'deploy/require-ci-run.sh'
# shellcheck disable=SC2016
assert_wf 'the manifest records the CI run that gated the deploy' \
  'CI_RUN_ID: ${{ needs.gate.outputs.ci_run_id }}'
assert_wf 'the staging deploy is serialised' 'group: shikoo-deploy'
assert_wf 'a running deploy is never cancelled' 'cancel-in-progress: false'
# The workflow passes the repository variable unchanged. GitHub expression
# comparisons are case-insensitive, so comparing it here would let TRUE and
# True through. The case-sensitive shell check in deploy.sh is the gate.
# shellcheck disable=SC2016
assert_wf 'the staging workflow does not normalise the bot switch' \
  'DEPLOY_BOT_ENABLED: ${{ vars.STAGING_BOT_ENABLED }}'
if grep -qE 'STAGING_BOT_ENABLED[[:space:]]*==' "$WORKFLOW"; then
  bad 'the workflow performs no case-insensitive comparison on the bot switch' \
    "$(grep -n STAGING_BOT_ENABLED "$WORKFLOW")"
else
  ok 'the workflow performs no case-insensitive comparison on the bot switch'
fi
# The literal shell expression is the contract.
# shellcheck disable=SC2016
if grep -qF '[ "$DEPLOY_BOT_ENABLED" = '\''true'\'' ]' "$DEPLOY"; then
  ok 'deploy.sh accepts only exact lowercase true for the bot'
else
  bad 'deploy.sh accepts only exact lowercase true for the bot' \
    'the case-sensitive shell comparison is missing'
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
for pulling in staging promote; do
  case "$pulling" in
    staging) wf=$WORKFLOW ;;
    *) wf=$PROMOTE_WF ;;
  esac
  if awk -v j="  ${pulling}:" '$0 == j {f=1; next} /^  [a-z][a-z0-9_-]*:$/ {f=0} f' "$wf" |
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


# Digest, never a tag, as the thing deployed.
if grep -E 'IMAGE_REF: .*@\$\{\{ (needs\.image\.outputs\.digest|steps\.read\.outputs\.digest) \}\}' "$WORKFLOW" >/dev/null &&
  ! grep -E 'IMAGE_REF: .*:sha-' "$WORKFLOW" >/dev/null; then
  ok 'staging, production and promote all deploy a digest and never a tag'
else
  bad 'staging, production and promote all deploy a digest and never a tag' "$(grep -n IMAGE_REF "$WORKFLOW")"
fi

# Staging deploys the digest this build produced; promotion deploys the digest
# the manifest recorded. Neither can name a tag.
# shellcheck disable=SC2016
if grep -qF 'IMAGE_REF: ${{ env.IMAGE_NAME }}@${{ needs.image.outputs.digest }}' "$WORKFLOW" &&
  grep -qF 'IMAGE_REF: ${{ env.IMAGE_NAME }}@${{ needs.promote-gate.outputs.digest }}' "$PROMOTE_WF"; then
  ok 'staging and promotion both deploy an immutable digest'
else
  bad 'staging and promotion both deploy an immutable digest' "$(grep -n IMAGE_REF "$WORKFLOW" "$PROMOTE_WF")"
fi


section 'the release interface — a merge cannot reach production at all'

# The strongest form of the guarantee, and the reason the job was DELETED
# rather than left behind an `if:`. While `production` existed as a job gated on
# a repository variable, re-creating that one variable re-enabled automatic
# production deployment from a settings page, with no diff and no review.
#
# Now there is nothing to re-enable.
if grep -qE '^  production:' "$WORKFLOW"; then
  bad 'the staging workflow has no production job' 'a production job still exists in Deploy Staging'
else
  ok 'the staging workflow has no production job'
fi

if grep -q 'PRODUCTION_AUTO_DEPLOY' "$WORKFLOW" "$PROMOTE_WF"; then
  bad 'nothing depends on PRODUCTION_AUTO_DEPLOY any more' 'the variable is still referenced'
else
  ok 'nothing depends on PRODUCTION_AUTO_DEPLOY any more'
fi

if grep -qE '^\s+environment: production' "$WORKFLOW"; then
  bad 'the staging workflow never enters the production environment' 'it names environment: production'
else
  ok 'the staging workflow never enters the production environment'
fi

if grep -q 'secrets.DEPLOY_' "$WORKFLOW" && ! grep -qE '^\s+environment: staging' "$WORKFLOW"; then
  bad 'staging credentials come from the staging environment' 'deployment secrets with no environment'
else
  ok 'staging credentials come from the staging environment'
fi

section 'the release interface — production is reachable only by hand'

assert_pwf() { # name substring
  if grep -qF "$2" "$PROMOTE_WF"; then ok "$1"; else bad "$1" "promote-production.yml lacks: $2"; fi
}

assert_pwf 'the Actions UI shows a clear Promote Production entry' 'name: Promote Production'
assert_pwf 'promotion is dispatch-only' 'workflow_dispatch:'
assert_pwf 'the confirmation is a choice, not free text' 'type: choice'
assert_pwf 'its default is not promotion' "default: 'no — cancel'"
assert_pwf 'only the exact word PROMOTE continues' "!= 'PROMOTE'"
# shellcheck disable=SC2016
assert_pwf 'the actor must be the allowlisted owner' '"$ACTOR" != "$OWNER"'
assert_pwf 'the manifest is verified before anything is deployed' 'verify-release-manifest.sh'
assert_pwf 'the staging run is chosen, never a digest' 'pick-staging-run.sh'

# Only `workflow_dispatch` may appear as a trigger. A `push` or `workflow_run`
# line here would make production automatic again by the back door.
if awk '/^on:/,/^permissions:/' "$PROMOTE_WF" | grep -qE '^\s+(push|workflow_run|schedule|repository_dispatch):'; then
  bad 'no automatic trigger can reach production' 'promote-production.yml has an automatic trigger'
else
  ok 'no automatic trigger can reach production'
fi

# There must be no way to TYPE a digest. The provenance chain ends at the
# paste buffer the moment such an input exists.
if awk '/^  workflow_dispatch:/,/^permissions:/' "$PROMOTE_WF" | grep -qE '^\s+(digest|image|image_ref|tag|sha):'; then
  bad 'promotion accepts no digest, image or tag as input' 'the dispatch takes one'
else
  ok 'promotion accepts no digest, image or tag as input'
fi

if awk '/^  promote:/,0' "$PROMOTE_WF" | grep -qF 'build-push-action'; then
  bad 'promotion never rebuilds the image' 'promote builds'
else
  ok 'promotion never rebuilds the image'
fi

# The checks run in a job with NO environment, so an unauthorised promotion is
# refused before any job holding a production secret exists.
python3 - "$PROMOTE_WF" <<'PYEOF' >"$WORK/pjobs.txt"
import re, sys
text = open(sys.argv[1], encoding='utf-8').read()
body = text.split('\njobs:\n', 1)[1]
starts = [(m.start(), m.group(1)) for m in re.finditer(r'^  ([a-z][a-z0-9_-]*):$', body, re.M)]
for i, (pos, name) in enumerate(starts):
    end = starts[i + 1][0] if i + 1 < len(starts) else len(body)
    blk = body[pos:end]
    print('\t'.join([
        name,
        'env' if re.search(r'^    environment:', blk, re.M) else '-',
        'secrets' if 'secrets.DEPLOY_' in blk else '-',
        (re.search(r'^    needs: (.+)$', blk, re.M) or [None, '-'])[1].strip(),
    ]))
PYEOF
pjob() { awk -F'\t' -v j="$1" -v c="$2" '$1==j{print $c}' "$WORK/pjobs.txt"; }

if [ "$(pjob promote-gate 2)" = '-' ] && [ "$(pjob promote-gate 3)" = '-' ]; then
  ok 'the promotion checks run before any production secret is in scope'
else
  bad 'the promotion checks run before any production secret is in scope' "$(cat "$WORK/pjobs.txt")"
fi
case "$(pjob promote 4)" in
  *promote-gate*) ok 'the privileged promote job depends on those checks' ;;
  *) bad 'the privileged promote job depends on those checks' 'promote does not need promote-gate' ;;
esac

section 'the release interface — the bot, and which environment starts one'

# Staging starts a bot only if somebody turned it on, and «on» is a repository
# variable rather than a literal in this file — so the first rollout is not a
# pull request and neither is turning it back off. What must never appear is a
# hard-coded `'true'`: Telegram gives each update to one getUpdates caller, so a
# staging bot on the shop's token silently takes messages from the bot real
# customers are talking to, and that must stay a decision somebody makes.
# shellcheck disable=SC2016
if grep -qF 'DEPLOY_BOT_ENABLED: ${{ vars.STAGING_BOT_ENABLED }}' "$WORKFLOW" &&
  ! grep -qE 'STAGING_BOT_ENABLED[[:space:]]*==' "$WORKFLOW" &&
  ! grep -qF "DEPLOY_BOT_ENABLED: 'true'" "$WORKFLOW"; then
  ok 'staging starts no bot unless a variable was set, and never by default'
else
  bad 'staging starts no bot unless a variable was set, and never by default' "$(grep -n DEPLOY_BOT_ENABLED "$WORKFLOW")"
fi
if grep -qF "DEPLOY_BOT_ENABLED: 'true'" "$PROMOTE_WF"; then
  ok 'production promotion carries the bot'
else
  bad 'production promotion carries the bot' 'promotion does not enable it'
fi

section 'the release manifest'

MAN=$WORK/manifest
rm -rf "$MAN"
env MAIN_SHA="$SHA_MERGED" DIGEST="sha256:${DIGEST}" POLICY=solo-owner \
  GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform' GITHUB_RUN_ID=4242 CI_RUN_ID=1234 \
  bash "$ROOT/deploy/write-release-manifest.sh" "$MAN" >/dev/null 2>&1

if [ -s "$MAN/release-manifest.json" ] && [ -s "$MAN/manifest.sha256" ]; then
  ok 'staging writes a release manifest with a checksum'
else
  bad 'staging writes a release manifest with a checksum' 'nothing written'
fi

# Valid expected values on purpose. The run cross-checks are REQUIRED now, so a
# helper that omitted them would stop every case below at that guard instead of
# the one it was written to exercise — a suite that passes while testing the
# wrong thing.
#
# 4242 and this sha are what `mkman` writes into the manifest, so the
# cross-checks agree and each case reaches its own guard.
verify_manifest() {
  set +e
  ( cd "$ROOT" && EXPECTED_REPO='Shikoonet/Shikoonet-Platform' \
      EXPECTED_RUN_ID=4242 EXPECTED_RUN_HEAD_SHA="$SHA_MERGED" \
      bash deploy/verify-release-manifest.sh "$MAN" ) >"$WORK/verify.log" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

# The manifest names a commit that is not in this repository, so verification
# must fail on reachability even though every field is well formed.
if verify_manifest; then
  bad 'a manifest naming a commit not on main is refused' 'it verified'
else
  if grep -qE 'not in this repository|not reachable from main' "$WORK/verify.log"; then
    ok 'a manifest naming a commit not on main is refused'
  else
    bad 'a manifest naming a commit not on main is refused' "$(tail -1 "$WORK/verify.log")"
  fi
fi

printf 'digest=sha256:abc\n' >>"$MAN/manifest.env"
if verify_manifest; then
  bad 'a manifest altered after staging wrote it is refused' 'it verified'
else
  if grep -qF 'checksum does not verify' "$WORK/verify.log"; then
    ok 'a manifest altered after staging wrote it is refused'
  else
    bad 'a manifest altered after staging wrote it is refused' "$(tail -1 "$WORK/verify.log")"
  fi
fi

rm -f "$MAN/manifest.sha256"
if verify_manifest; then
  bad 'a manifest with no checksum is refused' 'it verified'
else
  ok 'a manifest with no checksum is refused'
fi

rm -rf "$MAN"
if verify_manifest; then
  bad 'a missing manifest is refused, not treated as empty' 'it verified'
else
  ok 'a missing manifest is refused, not treated as empty'
fi

# `ci_run_id` used to fall back to GITHUB_RUN_ID — this workflow's own id — so
# it was always identical to `staging_run_id` and recorded nothing at all. A
# provenance field that silently describes the wrong run is worse than an
# absent one, because it reads like evidence.
rm -rf "$MAN"
if env MAIN_SHA="$SHA_MERGED" DIGEST="sha256:${DIGEST}" POLICY=solo-owner \
  GITHUB_RUN_ID=4242 \
  bash "$ROOT/deploy/write-release-manifest.sh" "$MAN" >/dev/null 2>&1; then
  bad 'the manifest writer refuses a missing CI_RUN_ID' 'it fell back instead'
else
  ok 'the manifest writer refuses a missing CI_RUN_ID'
fi

rm -rf "$MAN"
if env MAIN_SHA="$SHA_MERGED" DIGEST="sha256:${DIGEST}" POLICY=solo-owner \
  GITHUB_RUN_ID=4242 CI_RUN_ID=4242 \
  bash "$ROOT/deploy/write-release-manifest.sh" "$MAN" >/dev/null 2>&1; then
  bad 'the manifest writer refuses a CI_RUN_ID equal to its own run' 'it was written'
else
  ok 'the manifest writer refuses a CI_RUN_ID equal to its own run'
fi

for bad_run in 'abc' '' '12 34'; do
  rm -rf "$MAN"
  if env MAIN_SHA="$SHA_MERGED" DIGEST="sha256:${DIGEST}" POLICY=solo-owner \
    GITHUB_RUN_ID=4242 CI_RUN_ID="$bad_run" \
    bash "$ROOT/deploy/write-release-manifest.sh" "$MAN" >/dev/null 2>&1; then
    bad "the manifest writer refuses the CI run id '${bad_run}'" 'it was written'
  else
    ok "the manifest writer refuses the CI run id '${bad_run}'"
  fi
done

for bad_digest in 'sha256:abc' 'latest' "sha256:${DIGEST}
extra"; do
  rm -rf "$MAN"
  if env MAIN_SHA="$SHA_MERGED" DIGEST="$bad_digest" CI_RUN_ID=1234 \
    bash "$ROOT/deploy/write-release-manifest.sh" "$MAN" >/dev/null 2>&1; then
    bad "the manifest writer refuses '${bad_digest:0:18}'" 'it was written'
  else
    ok "the manifest writer refuses '${bad_digest:0:18}'"
  fi
done


section 'promote-production — the dispatch cannot be pointed somewhere else'

# The ref guard must be the FIRST step, before the repository, the artifact or
# any credential. A dispatch runs the workflow file on the ref it was started
# from, so a branch run would execute guards the actor had just rewritten.
first_step=$(awk '/^  promote-gate:/,/^  promote:/' "$PROMOTE_WF" | grep -n '^      - ' | head -1 | cut -d: -f2-)
case "$first_step" in
  *'only main may promote'*) ok 'the ref guard is the first step of the promotion gate' ;;
  *) bad 'the ref guard is the first step of the promotion gate' "first step is: ${first_step}" ;;
esac
# The comparison AND the exit. Asserting only the comparison passes even when
# the branch that follows it merely logs — which is exactly how a guard rots
# into a warning.
guard_step=$(awk '/- name: only main may promote/,/- name: the two things/' "$PROMOTE_WF")
if printf '%s' "$guard_step" | grep -qF "!= 'refs/heads/main'" &&
  printf '%s' "$guard_step" | grep -qE '^\s+exit 1$'; then
  ok 'a dispatch from any ref but main is refused, and the refusal exits'
else
  bad 'a dispatch from any ref but main is refused, and the refusal exits' \
    'the ref guard does not compare-and-exit'
fi

# The repository script must not run before the repository exists. It used to,
# which was both broken and the wrong order in principle.
ck=$(awk '/^  promote-gate:/,/^  promote:/' "$PROMOTE_WF" | grep -n 'actions/checkout' | head -1 | cut -d: -f1)
# The `run:` line, not any mention: a comment naming the script sits above the
# checkout, and matching that would assert the opposite of the truth.
pk=$(awk '/^  promote-gate:/,/^  promote:/' "$PROMOTE_WF" | grep -n 'run: bash deploy/pick-staging-run.sh' | head -1 | cut -d: -f1)
if [ -n "$ck" ] && [ -n "$pk" ] && [ "$ck" -lt "$pk" ]; then
  ok 'the checkout happens before any repository script runs'
else
  bad 'the checkout happens before any repository script runs' "checkout line ${ck:-none}, script line ${pk:-none}"
fi
assert_pwf 'the promotion checkout names main explicitly' 'ref: main'
assert_pwf 'the promotion checkout has full history for reachability' 'fetch-depth: 0'

# One group across both workflows, so a promotion cannot read a ledger a
# staging deploy is still writing.
if grep -qF 'group: shikoo-deploy' "$WORKFLOW" && grep -qF 'group: shikoo-deploy' "$PROMOTE_WF"; then
  ok 'staging and promotion share one concurrency group'
else
  bad 'staging and promotion share one concurrency group' 'the groups differ'
fi

section 'promote-production — the staging run is evidence, not an integer'

PICK=$ROOT/deploy/pick-staging-run.sh
RUNJSON=$WORK/run.json
cat >"$BIN/gh" <<'FAKEGH'
#!/usr/bin/env bash
set -Eeuo pipefail
for a in "$@"; do case "$a" in */actions/runs/*) cat "$FAKE_RUN_JSON"; exit 0 ;; esac; done
printf '{}'
FAKEGH
chmod +x "$BIN/gh"
export FAKE_RUN_JSON="$RUNJSON"

run_json() { # path status conclusion event branch head_sha
  printf '{"path":"%s","status":"%s","conclusion":"%s","event":"%s","head_branch":"%s","head_sha":"%s"}' \
    "$1" "$2" "$3" "$4" "$5" "$6" >"$RUNJSON"
}

try_pick() {
  set +e
  ( cd "$ROOT" && GH_TOKEN=t GIVEN=4242 bash "$PICK" 'Shikoonet/Shikoonet-Platform' ) >"$WORK/pick.log" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

GOOD_SHA=$SHA_MERGED
run_json '.github/workflows/deploy-staging.yml' completed success workflow_run main "$GOOD_SHA"
if try_pick && grep -qF 'verified' "$WORK/pick.log"; then
  ok 'a genuine staging run is accepted'
else
  bad 'a genuine staging run is accepted' "$(tail -1 "$WORK/pick.log")"
fi

# Each rejection names its own reason. Exit code alone would pass all five.
run_json '.github/workflows/ci.yml' completed success workflow_run main "$GOOD_SHA"
if ! try_pick && grep -qF 'is not a staging release' "$WORK/pick.log"; then
  ok 'a run from another workflow is refused, by name'
else
  bad 'a run from another workflow is refused, by name' "$(tail -1 "$WORK/pick.log")"
fi

run_json '.github/workflows/deploy-staging.yml' in_progress '' workflow_run main "$GOOD_SHA"
if ! try_pick && grep -qF 'half-written record' "$WORK/pick.log"; then
  ok 'an unfinished run is refused, by name'
else
  bad 'an unfinished run is refused, by name' "$(tail -1 "$WORK/pick.log")"
fi

run_json '.github/workflows/deploy-staging.yml' completed failure workflow_run main "$GOOD_SHA"
if ! try_pick && grep -qF 'staging did not pass' "$WORK/pick.log"; then
  ok 'a failed run is refused, by name'
else
  bad 'a failed run is refused, by name' "$(tail -1 "$WORK/pick.log")"
fi

# `workflow_dispatch` became a real staging source when the no-input manual
# redeploy landed, so refusing it here would refuse the very runs that exist to
# redeploy current main without a dummy commit. It is not a weaker source: it
# resolves the sha from the ref on the server, requires a green CI push run for
# that sha, and goes through the same approval gate.
run_json '.github/workflows/deploy-staging.yml' completed success workflow_dispatch main "$GOOD_SHA"
if try_pick; then
  ok 'the no-input manual redeploy is a promotable staging source'
else
  bad 'the no-input manual redeploy is a promotable staging source' "$(tail -1 "$WORK/pick.log")"
fi

# Everything else still is hand-made. `push` is the sharp one: it is what a
# staging run would be triggered by if somebody wired the workflow directly to
# main and skipped the gate entirely.
for forged in push schedule repository_dispatch; do
  run_json '.github/workflows/deploy-staging.yml' completed success "$forged" main "$GOOD_SHA"
  if ! try_pick && grep -qF 'real Deploy Staging runs start no other way' "$WORK/pick.log"; then
    ok "a run triggered by '${forged}' is refused, by name"
  else
    bad "a run triggered by '${forged}' is refused, by name" "$(tail -1 "$WORK/pick.log")"
  fi
done

run_json '.github/workflows/deploy-staging.yml' completed success workflow_run some-branch "$GOOD_SHA"
if ! try_pick && grep -qF "not main" "$WORK/pick.log"; then
  ok 'a run for another branch is refused, by name'
else
  bad 'a run for another branch is refused, by name' "$(tail -1 "$WORK/pick.log")"
fi

rm -f "$BIN/gh"

section 'promote-production — the manifest must describe the run it came from'

MAN2=$WORK/man2
mkman() { # main_sha staging_run_id
  rm -rf "$MAN2"
  env MAIN_SHA="$1" DIGEST="sha256:${DIGEST}" POLICY=solo-owner CI_RUN_ID=1234 \
    GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform' GITHUB_RUN_ID="$2" \
    bash "$ROOT/deploy/write-release-manifest.sh" "$MAN2" >/dev/null 2>&1
}
try_verify() { # expected_run_id expected_head_sha
  set +e
  ( cd "$ROOT" && EXPECTED_REPO='Shikoonet/Shikoonet-Platform' \
      EXPECTED_RUN_ID="$1" EXPECTED_RUN_HEAD_SHA="$2" \
      bash deploy/verify-release-manifest.sh "$MAN2" ) >"$WORK/v2.log" 2>&1
  local rc=$?
  set -e
  return "$rc"
}

# A well-formed sha that is deliberately NOT a real commit. The cross-checks
# below run before the reachability check, so these cases never depend on what
# `git rev-parse HEAD` happens to be — which on a CI runner is a PR merge commit
# that is not on `main`, and locally changes the moment anything is committed.
REAL_SHA=$SHA_MERGED

mkman "$REAL_SHA" 4242
if ! try_verify 9999 "$REAL_SHA" && grep -qF 'but it arrived from run' "$WORK/v2.log"; then
  ok 'a manifest from a different staging run is refused'
else
  bad 'a manifest from a different staging run is refused' "$(tail -1 "$WORK/v2.log")"
fi

mkman "$REAL_SHA" 4242
if ! try_verify 4242 "$SHA_OTHER" && grep -qF 'but the staging run deployed' "$WORK/v2.log"; then
  ok 'a manifest whose commit differs from the run is refused'
else
  bad 'a manifest whose commit differs from the run is refused' "$(tail -1 "$WORK/v2.log")"
fi

# And nothing is written on the way out of any refusal: the promotion path must
# leave no digest, no sha and no ledger behind when it declines.
mkman "$REAL_SHA" 4242
rm -f "$MAN2/digest" "$MAN2/sha"
if ! try_verify 9999 "$REAL_SHA" && [ ! -e "$MAN2/digest" ] && [ ! -e "$MAN2/sha" ]; then
  ok 'a refused manifest leaves no digest or sha behind'
else
  bad 'a refused manifest leaves no digest or sha behind' 'files were written despite the refusal'
fi

section 'promote-production — the cross-checks cannot be skipped'

# The gap this closes: both values used to be optional, each comparison wrapped
# in `if [ -n "${VAR:-}" ]`. A future edit that stopped passing one would have
# deleted that cross-check silently and promoted anyway. An absent guard has to
# be louder than a failing one.
MAN3=$WORK/man3
rm -rf "$MAN3"
env MAIN_SHA="$SHA_MERGED" DIGEST="sha256:${DIGEST}" POLICY=solo-owner \
  GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform' GITHUB_RUN_ID=4242 CI_RUN_ID=1234 \
  bash "$ROOT/deploy/write-release-manifest.sh" "$MAN3" >/dev/null 2>&1

# Run with the expected values set to whatever the case is testing — including
# not set at all, which is the whole point.
try_required() { # name  expected-substring  [env assignments...]
  local name=$1 want=$2
  shift 2
  rm -f "$MAN3/digest" "$MAN3/sha"
  set +e
  ( cd "$ROOT" && env EXPECTED_REPO='Shikoonet/Shikoonet-Platform' "$@" \
      bash deploy/verify-release-manifest.sh "$MAN3" ) >"$WORK/req.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    bad "$name" 'it verified'
    return
  fi
  if ! grep -qF "$want" "$WORK/req.log"; then
    bad "$name" "refused, but not for '${want}': $(tail -1 "$WORK/req.log")"
    return
  fi
  # A refusal writes nothing. The digest and sha files are what the deploy path
  # reads, so a refusal that left them behind would hand the next step a value
  # it never verified.
  if [ -e "$MAN3/digest" ] || [ -e "$MAN3/sha" ]; then
    bad "$name" 'the refusal left a digest or sha behind'
    return
  fi
  ok "$name"
}

try_required 'a missing EXPECTED_RUN_ID is refused, not skipped' \
  'EXPECTED_RUN_ID is not set' EXPECTED_RUN_HEAD_SHA="$SHA_MERGED"

try_required 'a missing EXPECTED_RUN_HEAD_SHA is refused, not skipped' \
  'EXPECTED_RUN_HEAD_SHA is not set' EXPECTED_RUN_ID=4242

try_required 'an empty EXPECTED_RUN_ID is refused' \
  'EXPECTED_RUN_ID is not set' EXPECTED_RUN_ID='' EXPECTED_RUN_HEAD_SHA="$SHA_MERGED"

try_required 'a whitespace EXPECTED_RUN_ID is refused' \
  'is not a run id' EXPECTED_RUN_ID=' ' EXPECTED_RUN_HEAD_SHA="$SHA_MERGED"

try_required 'a non-numeric EXPECTED_RUN_ID is refused' \
  'is not a run id' EXPECTED_RUN_ID='42x' EXPECTED_RUN_HEAD_SHA="$SHA_MERGED"

try_required 'a run id with an embedded space is refused, not repaired' \
  'is not a run id' EXPECTED_RUN_ID='12 34' EXPECTED_RUN_HEAD_SHA="$SHA_MERGED"

try_required 'a short EXPECTED_RUN_HEAD_SHA is refused' \
  'is not 40 lowercase hex' EXPECTED_RUN_ID=4242 EXPECTED_RUN_HEAD_SHA='abc'

# A sha with LETTERS in it. `SHA_MERGED` is all ones, and uppercasing digits
# changes nothing — the case would have passed on a value that was still valid
# lowercase hex, proving nothing.
HEX_SHA='abcdef0123456789abcdef0123456789abcdef01'
try_required 'an uppercase EXPECTED_RUN_HEAD_SHA is refused' \
  'is not 40 lowercase hex' EXPECTED_RUN_ID=4242 EXPECTED_RUN_HEAD_SHA="${HEX_SHA^^}"

try_required 'a multiline EXPECTED_RUN_HEAD_SHA is refused' \
  'is not 40 lowercase hex' EXPECTED_RUN_ID=4242 EXPECTED_RUN_HEAD_SHA="${SHA_MERGED}
extra"

# The workflow must actually pass both, or the requirement above turns every
# promotion into a refusal — correct, but only discovered in production.
assert_pwf 'the workflow passes the run id to the verifier' 'EXPECTED_RUN_ID:'
assert_pwf 'the workflow passes the run head sha to the verifier' 'EXPECTED_RUN_HEAD_SHA:'

# And no optional path may creep back into the verifier.
if grep -qE 'if \[ -n "\$\{EXPECTED_RUN' "$ROOT/deploy/verify-release-manifest.sh"; then
  bad 'neither cross-check sits behind an optional guard' 'an if-optional path is back'
else
  ok 'neither cross-check sits behind an optional guard'
fi

section 'pick-staging-run — malformed input is refused, not repaired'

# `GIVEN` used to have whitespace STRIPPED, which turned «12 34» into «1234» —
# a different run, accepted without comment.
# The literal text of the removed line — SC2016 is the reading this wants.
# shellcheck disable=SC2016
if grep -qF '${GIVEN//[[:space:]]/}' "$ROOT/deploy/pick-staging-run.sh"; then
  bad 'the run id is validated raw, not stripped' 'whitespace is still being stripped'
else
  ok 'the run id is validated raw, not stripped'
fi

try_given() { # value  expected-substring
  set +e
  ( cd "$ROOT" && GH_TOKEN=t GIVEN="$1" bash deploy/pick-staging-run.sh 'Shikoonet/Shikoonet-Platform' ) \
    >"$WORK/given.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then
    bad "refuses the run id '$1'" 'it was accepted'
  elif grep -qF "$2" "$WORK/given.log"; then
    ok "refuses the run id '$1'"
  else
    bad "refuses the run id '$1'" "refused, but not for '${2}': $(tail -1 "$WORK/given.log")"
  fi
}

try_given '12 34' 'is not a run id'
try_given ' 4242' 'is not a run id'
try_given '4242 ' 'is not a run id'
try_given '42x' 'is not a run id'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
