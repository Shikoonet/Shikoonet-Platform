#!/usr/bin/env bash
#
# `deploy/autodeploy.sh`, driven against a fake GitHub, a fake Coolify and a
# fake Docker.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why a shell test and not a vitest one
#
# The thing under test IS a shell script. Reimplementing its logic in
# TypeScript to test it would test the reimplementation; running it with a
# `curl` and a `docker` on PATH that answer from fixtures runs the real control
# flow — the `set -e`, the subshell that once swallowed an HTTP status, the `jq`
# filters, the order of the two branch reads, the rollback loop.
#
# ─────────────────────────────────────────────────────────────────────────────
# How the fakes work
#
# A directory is put at the front of PATH holding a `curl` and a `docker`.
#
# `curl` reads a scenario file instead of the network. Each scenario maps a URL
# fragment to a body; the fake appends the status code the way real
# `curl -w '%{http_code}'` does, because the script parses the last three
# characters and that parsing is itself worth exercising. Coolify writes —
# the `PATCH` that pins `git_commit_sha` and the `POST` that queues a deploy —
# are RECORDED, so a test can assert not merely «it deployed» but «it pinned
# this exact sha, in this order».
#
# `docker` answers the four things the script asks Docker for: which container
# belongs to an application uuid, that container's environment, its health, and
# `exec`/`cp` for the migration path.
#
# `flock` is NOT faked. It is real, on a temp path, which is what makes the
# duplicate-execution test mean something.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: bash deploy/test/autodeploy.test.sh

set -Eeuo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="${HERE}/../autodeploy.sh"
[ -r "$SCRIPT" ] || { echo "cannot read $SCRIPT"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
mkdir -p "$BIN"

# The two secrets the log must never contain. Distinctive on purpose: a grep for
# them cannot match anything the script legitimately prints.
GH_SECRET='ghs-FAKE-9d41f0c2e7b64a15'
CO_SECRET='1|coolify-FAKE-77b3e9a4d1c8'

# ---------------------------------------------------------------------------
# The fake curl.
# ---------------------------------------------------------------------------
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''; method='GET'; body=''; outfile=''
prev=''
for a in "$@"; do
  case "$prev" in
    -X) method="$a" ;;
    --data-binary) body="$a" ;;
    -o) outfile="$a" ;;
  esac
  case "$a" in http*) url="$a" ;; esac
  prev="$a"
done

# The repository tarball: a real .tar.gz, built from the fixture tree, because
# the script really untars it and really reads the SQL out of it.
case "$url" in
  */tarball/*)
    tar -czf "$outfile" -C "$FAKE_TREE" repo-sha 2>/dev/null
    exit 0 ;;
esac

# Coolify.
case "$url" in
  *"$FAKE_COOLIFY_HOST"*)
    path=${url#*"$FAKE_COOLIFY_HOST"}
    case "$method:$path" in
      GET:/api/v1/version) printf '4.3.10200'; exit 0 ;;
      PATCH:/api/v1/applications/*)
        uuid=${path##*/}
        sha=$(printf '%s' "$body" | sed -n 's/.*"git_commit_sha":"\([^"]*\)".*/\1/p')
        printf '%s %s\n' "$uuid" "$sha" >> "$FAKE_PINS"
        printf '{"uuid":"%s"}200' "$uuid"; exit 0 ;;
      GET:/api/v1/applications/*)
        uuid=${path##*/}
        # Whatever it was last pinned to — which is what makes «Coolify reports
        # a different sha» expressible as a test.
        sha=$(grep " ${uuid} " /dev/null 2>/dev/null || true)
        sha=$(awk -v u="$uuid" '$1==u{v=$2} END{print v}' "$FAKE_PINS" 2>/dev/null)
        [ -n "${sha:-}" ] || sha='HEAD'
        [ -n "${FAKE_APP_REPORTS_SHA:-}" ] && sha="$FAKE_APP_REPORTS_SHA"
        printf '{"uuid":"%s","git_branch":"%s","git_commit_sha":"%s","status":"running:healthy"}200' \
          "$uuid" "${FAKE_APP_BRANCH:-main}" "$sha"; exit 0 ;;
      POST:/api/v1/deploy*)
        uuid=${path#*uuid=}
        if [ "${FAKE_DEPLOY_API_FAILS_FOR:-}" = "$uuid" ]; then
          printf '{"message":"boom"}500'; exit 0
        fi
        printf '%s\n' "$uuid" >> "$FAKE_DEPLOYS"
        n=$(wc -l < "$FAKE_DEPLOYS" | tr -d ' ')
        printf '{"deployments":[{"resource_uuid":"%s","deployment_uuid":"dep-%s-%s"}]}200' "$uuid" "$uuid" "$n"
        exit 0 ;;
      GET:/api/v1/deployments/*)
        dep=${path##*/}
        uuid=${dep#dep-}; uuid=${uuid%-*}
        sha=$(awk -v u="$uuid" '$1==u{v=$2} END{print v}' "$FAKE_PINS" 2>/dev/null)
        if [ "${FAKE_DEPLOY_STATUS_FOR:-}" = "$uuid" ]; then
          printf '{"status":"%s","commit":"%s"}200' "${FAKE_DEPLOY_STATUS:-failed}" "$sha"; exit 0
        fi
        [ -n "${FAKE_DEPLOYED_COMMIT:-}" ] && sha="$FAKE_DEPLOYED_COMMIT"
        printf '{"status":"finished","commit":"%s"}200' "$sha"; exit 0 ;;
    esac
    echo "FAKE CURL: unhandled coolify $method $path" >&2; exit 98 ;;
esac

# GitHub, from the scenario file. First match wins, so a scenario can put a
# narrower fragment above a broader one. A URL that matches nothing is a test
# bug and says so loudly rather than defaulting to 200 — defaulting would let a
# test pass because the script never made the call it was supposed to make.
while IFS=$'\t' read -r frag status body2; do
  [ -n "${frag:-}" ] || continue
  case "$url" in
    *"$frag"*) printf '%s%s' "$body2" "$status"; exit 0 ;;
  esac
done < "$FAKE_SCENARIO"

echo "FAKE CURL: no scenario line matched $url" >&2
exit 99
FAKE
chmod +x "$BIN/curl"

# ---------------------------------------------------------------------------
# The fake docker.
#
# `container_for` → one container per uuid, unless FAKE_BOT_INSTANCES says two,
# which is how «the bot must never have two pollers» is asserted rather than
# asserted about.
# ---------------------------------------------------------------------------
cat > "$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
sub=${1:-}; shift || true

uuid_of_filter() { printf '%s' "$1" | sed -e 's/^name=\^//' -e 's/-$//'; }

case "$sub" in
  ps)
    filter=''; want_all=0
    prev=''
    for a in "$@"; do
      [ "$prev" = '--filter' ] && filter="$a"
      [ "$a" = '-a' ] && want_all=1
      prev="$a"
    done
    : "$want_all"
    u=$(uuid_of_filter "$filter")
    [ -n "${FAKE_NO_CONTAINERS:-}" ] && exit 0
    if [ "$u" = "${FAKE_BOT_UUID:-}" ] && [ "${FAKE_BOT_INSTANCES:-1}" -gt 1 ]; then
      printf '%s-1\n%s-2\n' "$u" "$u"
    else
      printf '%s-1\n' "$u"
    fi
    exit 0 ;;
  inspect)
    name=$1; fmt=${3:-}
    u=${name%-*}
    case "$fmt" in
      *State.Health.Status*)
        if [ "${FAKE_UNHEALTHY_UUID:-}" = "$u" ]; then printf 'unhealthy\n'; else printf 'healthy\n'; fi
        exit 0 ;;
      *Config.Env*)
        printf 'ENV_NAME=%s\n' "${FAKE_ENV_NAME-staging}"
        # SOURCE_COMMIT is whatever that application was last PINNED to, which
        # is exactly the claim the health check has to verify.
        sha=$(awk -v u="$u" '$1==u{v=$2} END{print v}' "$FAKE_PINS" 2>/dev/null)
        [ -n "${sha:-}" ] || sha="${FAKE_RUNNING_COMMIT:-none}"
        [ -n "${FAKE_RUNNING_COMMIT_OVERRIDE:-}" ] && sha="$FAKE_RUNNING_COMMIT_OVERRIDE"
        printf 'SOURCE_COMMIT=%s\n' "$sha"
        exit 0 ;;
    esac
    exit 0 ;;
  cp) exit 0 ;;
  exec)
    args=("$@")
    joined="${args[*]}"
    case "$joined" in
      *application_settings*)
        # The Coolify safety gate. Defaults to the safe answer; a test flips one
        # application by naming it in FAKE_AUTODEPLOY_ON / FAKE_PREVIEW_ON.
        for u in "$FAKE_U_ING" "$FAKE_U_DASH" "$FAKE_U_BOT"; do
          a=f; p=f
          # `if`, not `[ ] && x=y`: this fake runs under `set -e`, and a false
          # test as the whole statement makes the list return 1 and kills it.
          if [ "${FAKE_AUTODEPLOY_ON:-}" = "$u" ]; then a=t; fi
          if [ "${FAKE_PREVIEW_ON:-}" = "$u" ]; then p=t; fi
          printf '%s|%s|%s\n' "$u" "$a" "$p"
        done
        exit 0 ;;
      *pg_locks*)
        # How many processes hold the bot's polling lock. Must be matched BEFORE
        # the generic psql arm below, which would otherwise answer the ledger.
        printf '%s\n' "${FAKE_BOT_HOLDERS-1}"
        exit 0 ;;
      *psql*)
        # The migration ledger.
        printf '%s\n' ${FAKE_LEDGER:-}
        exit 0 ;;
      *schemaCli.ts\ up*)
        echo 'up' >> "$FAKE_MIGRATED"
        [ -n "${FAKE_MIGRATE_FAILS:-}" ] && exit 1
        exit 0 ;;
      *schemaCli.ts\ status*)
        [ -n "${FAKE_STATUS_FAILS:-}" ] && exit 1
        exit 0 ;;
      *node\ -e*)
        # The in-container health probes.
        [ -n "${FAKE_PROBE_FAILS:-}" ] && exit 1
        exit 0 ;;
      *rm\ -rf*) exit 0 ;;
    esac
    exit 0 ;;
esac
exit 0
FAKE
chmod +x "$BIN/docker"

export PATH="$BIN:$PATH"

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0

GREEN_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
PREV_SHA=cccccccccccccccccccccccccccccccccccccccc
PR_HEAD=dddddddddddddddddddddddddddddddddddddddd

U_INGEST=uuid-ingest
U_DASH=uuid-dashboard
U_BOT=uuid-bot

setup() {
  export FAKE_SCENARIO="$WORK/scenario"
  export FAKE_DEPLOYS="$WORK/deploys"
  export FAKE_PINS="$WORK/pins"
  export FAKE_MIGRATED="$WORK/migrated"
  export FAKE_COOLIFY_HOST='coolify.invalid:8000'
  export FAKE_BOT_UUID="$U_BOT"
  export FAKE_U_ING="$U_INGEST" FAKE_U_DASH="$U_DASH" FAKE_U_BOT="$U_BOT"
  : > "$FAKE_SCENARIO"; : > "$FAKE_DEPLOYS"; : > "$FAKE_PINS"; : > "$FAKE_MIGRATED"

  # A fixture tree shaped like a GitHub tarball: <owner>-<repo>-<sha>/migrations/
  export FAKE_TREE="$WORK/tree"
  rm -rf "$FAKE_TREE"
  mkdir -p "$FAKE_TREE/repo-sha/migrations"
  printf 'CREATE TABLE a (id int);\n' > "$FAKE_TREE/repo-sha/migrations/0001_init.sql"
  printf 'SELECT 1;\n' > "$FAKE_TREE/repo-sha/migrations/verify_invariants.sql"

  unset FAKE_ENV_NAME FAKE_BOT_INSTANCES FAKE_UNHEALTHY_UUID FAKE_PROBE_FAILS \
        FAKE_DEPLOY_API_FAILS_FOR FAKE_DEPLOY_STATUS_FOR FAKE_DEPLOY_STATUS \
        FAKE_DEPLOYED_COMMIT FAKE_APP_REPORTS_SHA FAKE_APP_BRANCH FAKE_LEDGER \
        FAKE_MIGRATE_FAILS FAKE_STATUS_FAILS FAKE_NO_CONTAINERS \
        FAKE_RUNNING_COMMIT_OVERRIDE FAKE_COMMIT_CALLS FAKE_BOT_HOLDERS \
        FAKE_AUTODEPLOY_ON FAKE_PREVIEW_ON
  export FAKE_LEDGER='0001_init.sql'
  export FAKE_RUNNING_COMMIT="$PREV_SHA"

  export SHIKOO_AUTODEPLOY_ENV="$WORK/env"
  export SHIKOO_AUTODEPLOY_STATE_DIR="$WORK/state"
  export SHIKOO_AUTODEPLOY_STATE="$WORK/state/last-sha"
  export SHIKOO_AUTODEPLOY_REJECTED="$WORK/state/rejected-sha"
  export SHIKOO_AUTODEPLOY_JOURNAL="$WORK/state/deployments.jsonl"
  export SHIKOO_AUTODEPLOY_LOCK="$WORK/lock"
  unset SHIKOO_AUTODEPLOY_LOCKED CREDENTIALS_DIRECTORY
  rm -rf "$WORK/state"; mkdir -p "$WORK/state"
  printf '%s' "$PREV_SHA" > "$SHIKOO_AUTODEPLOY_STATE"

  cat > "$SHIKOO_AUTODEPLOY_ENV" <<EOF
GH_REPO='fake/repo'
GH_TOKEN='${GH_SECRET}'
COOLIFY_URL='http://${FAKE_COOLIFY_HOST}'
COOLIFY_TOKEN='${CO_SECRET}'
APP_INGEST='${U_INGEST}'
APP_DASHBOARD='${U_DASH}'
APP_BOT='${U_BOT}'
EXPECT_ENV_NAME='staging'
AUTODEPLOY_BOT_ENABLED='true'
DB_CONTAINER='fake-postgres'
COOLIFY_DB_CONTAINER='fake-coolify-db'
BRANCH='main'
POLL_SECS='1'
DEPLOY_TIMEOUT='2'
HEALTH_TIMEOUT='2'
EOF
}

scenario() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$FAKE_SCENARIO"; }

deploys() { wc -l < "$FAKE_DEPLOYS" | tr -d ' '; }
pins()    { cat "$FAKE_PINS"; }

run_script() {
  set +e
  OUT=$(bash "$SCRIPT" "$@" 2>&1)
  RC=$?
  set -e
}

ok()  { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n     %s\n' "$1" "${2:-}"; }

check() { # name  expected-deploys  [substring the log must contain]
  local name=$1 want=$2 needle=${3:-}
  local got; got=$(deploys)
  if [ "$got" != "$want" ]; then
    bad "$name" "expected ${want} deploy(s), got ${got}. log: ${OUT}"
    return
  fi
  if [ -n "$needle" ] && ! printf '%s' "$OUT" | grep -qF -- "$needle"; then
    bad "$name" "log did not mention «${needle}». log: ${OUT}"
    return
  fi
  ok "$name"
}

# --- scenario builders ------------------------------------------------------
runs_json()   { printf '{"total_count":1,"workflow_runs":[{"id":501,"name":"CI","status":"%s","conclusion":%s}]}' "$1" "$2"; }
jobs_json()   { printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"},{"name":"Required Quality Gate","status":"completed","conclusion":%s}]}' "$1"; }
commit_json() { printf '{"sha":"%s"}' "$1"; }

# A merged PR whose merge result is $1, authored by $2.
pr_json() { printf '[{"number":7,"merged_at":"2026-08-27T10:00:00Z","base":{"ref":"%s"},"head":{"sha":"%s"},"merge_commit_sha":"%s","user":{"login":"%s"}}]' \
  "${4:-main}" "${3:-$PR_HEAD}" "$1" "$2"; }

# One review. $1 state, $2 reviewer, $3 commit_id.
review() { printf '{"state":"%s","user":{"login":"%s"},"commit_id":"%s","submitted_at":"%s"}' "$1" "$2" "$3" "${4:-2026-08-27T10:00:00Z}"; }

# The whole happy path, so each test only overrides the line it is about.
happy() {
  scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"success"')"
  scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
  scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
  scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
  scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
}

echo 'autodeploy — approval, exact-sha CI, immutable deploy, rollback'
echo
echo '  ── the approval gate ──'

# --- 1. merged + approved + green ------------------------------------------
setup; happy
run_script
check 'deploys a merged, approved, green sha' 3 "${GREEN_SHA:0:12}"

# --- 2. approved but NOT merged --------------------------------------------
setup
scenario "/commits/${GREEN_SHA}/pulls" 200 \
  '[{"number":7,"merged_at":null,"base":{"ref":"main"},"head":{"sha":"'"$PR_HEAD"'"},"merge_commit_sha":"'"$GREEN_SHA"'","user":{"login":"author"}}]'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'an approved but unmerged PR deploys nothing' 0 'not the result of a merged pull request'

# --- 3. merged but never approved ------------------------------------------
setup; happy
scenario "/pulls/7/reviews" 200 '[]'
: > "$FAKE_SCENARIO"
scenario "/pulls/7/reviews" 200 '[]'
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a merged but unapproved PR deploys nothing' 0 'no current APPROVED review'

# --- 4. the author approving their own PR -----------------------------------
setup
scenario "/pulls/7/reviews" 200 "[$(review APPROVED author "$PR_HEAD")]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'self-approval is not review' 0 'no current APPROVED review'

# --- 5. a DISMISSED approval ------------------------------------------------
setup
scenario "/pulls/7/reviews" 200 "[$(review DISMISSED reviewer "$PR_HEAD")]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a dismissed approval does not count' 0 'no current APPROVED review'

# --- 6. an approval later superseded by CHANGES_REQUESTED -------------------
setup
scenario "/pulls/7/reviews" 200 \
  "[$(review APPROVED reviewer "$PR_HEAD" 2026-08-27T09:00:00Z),$(review CHANGES_REQUESTED reviewer "$PR_HEAD" 2026-08-27T11:00:00Z)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'an approval superseded by CHANGES_REQUESTED does not count' 0 'CHANGES_REQUESTED'

# --- 7. a STALE approval, given before the last push ------------------------
setup
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer 1111111111111111111111111111111111111111)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'an approval on an earlier head is stale and does not count' 0 'no current APPROVED review'

# --- 7b. a second reviewer requested changes AFTER the approval --------------
# The gap this closes: per-reviewer «latest» stops one person's approval
# surviving their own objection, but not somebody else's. Reviewer A approves
# the final head; reviewer B then reads the same tree and requests changes. The
# count of A's approvals is still 1, so the old code deployed a commit a
# reviewer had actively objected to — worse than deploying an unreviewed one,
# because somebody looked and said no.
setup
scenario "/pulls/7/reviews" 200 \
  "[$(review APPROVED alice "$PR_HEAD" 2026-08-27T09:00:00Z),$(review CHANGES_REQUESTED bob "$PR_HEAD" 2026-08-27T11:00:00Z)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'an outstanding CHANGES_REQUESTED from another reviewer blocks the deploy' 0 'CHANGES_REQUESTED'

# --- 7c. a CHANGES_REQUESTED against an EARLIER head does not block ----------
# History, not an objection: the author pushed again, and the final head is what
# the approval and the block are both measured against.
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"success"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/pulls/7/reviews" 200 \
  "[$(review CHANGES_REQUESTED bob 1111111111111111111111111111111111111111 2026-08-27T08:00:00Z),$(review APPROVED alice "$PR_HEAD" 2026-08-27T10:00:00Z)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a CHANGES_REQUESTED on a superseded head does not block' 3 "${GREEN_SHA:0:12}"

# --- 7d. the same reviewer approves, then requests changes ------------------
setup
scenario "/pulls/7/reviews" 200 \
  "[$(review APPROVED alice "$PR_HEAD" 2026-08-27T09:00:00Z),$(review CHANGES_REQUESTED alice "$PR_HEAD" 2026-08-27T11:00:00Z)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a reviewer who later requests changes withdraws their own approval' 0 'CHANGES_REQUESTED'

# --- 7e. the author cannot clear another reviewer's block -------------------
setup
scenario "/pulls/7/reviews" 200 \
  "[$(review CHANGES_REQUESTED bob "$PR_HEAD" 2026-08-27T09:00:00Z),$(review APPROVED author "$PR_HEAD" 2026-08-27T11:00:00Z),$(review APPROVED alice "$PR_HEAD" 2026-08-27T12:00:00Z)]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'an approval by a third party does not override an outstanding block' 0 'CHANGES_REQUESTED'

# --- 8. a direct push, with no PR at all ------------------------------------
setup
scenario "/commits/${GREEN_SHA}/pulls" 200 '[]'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a direct unreviewed push to main deploys nothing' 0 'not the result of a merged pull request'

# --- 9. a merged PR against a branch that is not main -----------------------
setup
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author "$PR_HEAD" develop)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a PR merged into another branch does not authorise a main deploy' 0 'not the result of a merged pull request'

# --- 10. the three merge methods --------------------------------------------
# squash and merge-commit both put `merge_commit_sha` on main; rebase puts the
# last rebased commit there, and GitHub reports it in the same field. All three
# are therefore the same assertion with a different-shaped PR body — and the
# case that must NOT pass is a PR that merely mentions the commit.
for method in merge squash rebase; do
  setup; happy
  run_script
  check "a ${method} merge is recognised as the PR that produced the sha" 3 "${GREEN_SHA:0:12}"
done

setup
# Merged, approved, but its merge result and head are BOTH other commits: this
# PR merely references the candidate.
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$OTHER_SHA" author)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a PR that merely mentions the sha does not authorise it' 0 'not the result of a merged pull request'

echo
echo '  ── the CI gate, on the exact sha ──'

# --- 11. a run still in progress --------------------------------------------
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json in_progress null)"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses while CI is still running' 0 'still running'

# --- 12. a failed run -------------------------------------------------------
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"failure"')"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses a failed run' 0 'CI FAILED'

# --- 13/14. skipped and cancelled are not passes ----------------------------
# `skipped` used to be accepted alongside `success`, so a workflow whose jobs
# all skipped deployed a commit nothing had tested.
for conclusion in skipped cancelled neutral; do
  setup; happy
  : > "$FAKE_SCENARIO"
  scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed "\"${conclusion}\"")"
  scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
  scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
  scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
  run_script
  check "a ${conclusion} run is not a pass" 0 'CI FAILED'
done

# --- 15. only a pull_request run is green -----------------------------------
# The query carries `event=push`, so a PR run does not answer for this sha and
# the API returns an empty list. `none` must not deploy.
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 '{"total_count":0,"workflow_runs":[]}'
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a green pull_request run does not satisfy the push gate' 0 'no completed push run'

# --- 16. the required gate did not succeed ----------------------------------
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"failure"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses when «Required Quality Gate» did not succeed' 0 'Required Quality Gate'

# --- 17. the gate job is absent entirely ------------------------------------
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs/501/jobs" 200 '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"}]}'
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses when the aggregator job is not present at all' 0 'Required Quality Gate'

# --- 18. a 403 on the runs API ---------------------------------------------
setup; happy
: > "$FAKE_SCENARIO"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 403 '{"message":"forbidden"}'
scenario "/commits/${GREEN_SHA}/pulls" 200 "$(pr_json "$GREEN_SHA" author)"
scenario "/pulls/7/reviews" 200 "[$(review APPROVED reviewer "$PR_HEAD")]"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a 403 on the runs API does not deploy' 0 'Actions: Read-only'
if [ ! -s "$SHIKOO_AUTODEPLOY_REJECTED" ]; then
  ok 'a permission failure leaves the sha unrejected, so it deploys once fixed'
else
  bad 'a permission failure must not reject the sha' "rejected=$(cat "$SHIKOO_AUTODEPLOY_REJECTED")"
fi

echo
echo '  ── the branch race ──'

# --- 19. main moved while CI was being read ---------------------------------
setup; happy
cp "$BIN/curl" "$BIN/curl.real"
# A stateful `/commits/main`: first call → the candidate, later calls → another.
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  */commits/main)
    n=$(cat "$FAKE_COMMIT_CALLS" 2>/dev/null || echo 0)
    printf '%s' "$((n + 1))" > "$FAKE_COMMIT_CALLS"
    if [ "$n" -eq 0 ]; then printf '{"sha":"%s"}200' "$FAKE_SHA_FIRST"
    else printf '{"sha":"%s"}200' "$FAKE_SHA_LATER"; fi
    exit 0 ;;
esac
exec "${0}.real" "$@"
FAKE
chmod +x "$BIN/curl"
export FAKE_COMMIT_CALLS="$WORK/commit-calls"
export FAKE_SHA_FIRST="$GREEN_SHA" FAKE_SHA_LATER="$OTHER_SHA"
rm -f "$FAKE_COMMIT_CALLS"
run_script
check 'refuses when main moved between evaluating and deploying' 0 'moved'
cp "$BIN/curl.real" "$BIN/curl"; chmod +x "$BIN/curl"; rm -f "$BIN/curl.real"
unset FAKE_COMMIT_CALLS FAKE_SHA_FIRST FAKE_SHA_LATER

echo
echo '  ── the environment and the schema ──'

# --- 20. the environment matrix ---------------------------------------------
# expected × live. Only one cell in this table may deploy, and the host that
# would be damaged by getting it wrong is exactly the host where a wrong answer
# looks harmless — so every other cell is asserted, not assumed.
env_case() { # name  expect  live  want-deploys  needle
  setup; happy
  sed -i "s/^EXPECT_ENV_NAME=.*/EXPECT_ENV_NAME=$2/" "$SHIKOO_AUTODEPLOY_ENV"
  if [ "$3" = '<unset>' ]; then export FAKE_ENV_NAME=''; else export FAKE_ENV_NAME=$3; fi
  run_script
  check "$1" "$4" "$5"
  unset FAKE_ENV_NAME
}

env_case 'staging host, staging expected — permitted to continue' \
  staging staging 3 "${GREEN_SHA:0:12}"
env_case 'staging expected, production host — fail closed' \
  staging production 0 'EXPECT_ENV_NAME'
env_case 'production expected, staging host — fail closed' \
  production staging 0 'EXPECT_ENV_NAME'
env_case 'host reports no ENV_NAME at all — fail closed' \
  staging '<unset>' 0 'no ENV_NAME at all'
env_case 'host misspells the environment — fail closed' \
  staging stagng 0 'not one of'
env_case 'a misspelt EXPECT_ENV_NAME is refused even when the host agrees' \
  stagng stagng 0 'EXPECT_ENV_NAME'

# That last one is the case a plain equality check gets wrong: two matching
# misspellings satisfy `live == expected` while naming nothing, and
# `parseEnvName` would then refuse to boot the containers this had approved.

# --- 21. nothing is running, so the environment cannot be confirmed ---------
setup; happy
export FAKE_NO_CONTAINERS=1
run_script
if [ "$RC" -ne 0 ] && [ "$(deploys)" = '0' ]; then
  ok 'an unanswerable «which environment is this» is a refusal, not a default'
else
  bad 'no-container case must fail closed' "rc=${RC} deploys=$(deploys)"
fi
unset FAKE_NO_CONTAINERS

# --- 22. the database is AHEAD of the candidate -----------------------------
setup; happy
export FAKE_LEDGER='0001_init.sql 0099_from_the_future.sql'
run_script
check 'refuses when the database holds a migration the candidate does not' 0 'BEHIND the schema'
export FAKE_LEDGER='0001_init.sql'

# --- 23. a destructive migration with no reviewed plan ----------------------
setup; happy
printf 'ALTER TABLE users DROP COLUMN password_hash;\n' > "$FAKE_TREE/repo-sha/migrations/0002_drop.sql"
run_script
check 'refuses a destructive migration with no reviewed plan' 0 'reviewed-destructive'

# --- 24. the same migration, with the marker a reviewer had to read ---------
setup; happy
printf -- '-- autodeploy: reviewed-destructive — the column moved to operator_credentials in 0001\nALTER TABLE users DROP COLUMN password_hash;\n' \
  > "$FAKE_TREE/repo-sha/migrations/0002_drop.sql"
run_script
check 'a destructive migration carrying the reviewed marker proceeds' 3 "${GREEN_SHA:0:12}"
if [ -s "$FAKE_MIGRATED" ]; then
  ok 'the pending migration was applied before any application was deployed'
else
  bad 'the pending migration should have been applied' "log: ${OUT}"
fi

# --- 25. applying the migrations fails --------------------------------------
setup; happy
printf 'CREATE TABLE b (id int);\n' > "$FAKE_TREE/repo-sha/migrations/0002_add.sql"
export FAKE_MIGRATE_FAILS=1
run_script
if [ "$RC" -ne 0 ] && [ "$(deploys)" = '0' ]; then
  ok 'a failed migration deploys nothing at all'
else
  bad 'a failed migration must deploy nothing' "rc=${RC} deploys=$(deploys)"
fi
unset FAKE_MIGRATE_FAILS

# --- 25b. the Coolify safety gate ------------------------------------------
# `:8000` is on the public internet. `is_auto_deploy_enabled = false` is the
# only thing stopping a GitHub push from deploying behind this script's back, so
# it is re-checked every tick — and a tick that finds it wrong must abandon
# EVERYTHING, before a migration is applied or a state file is written.
for app in ingest dashboard bot; do
  setup; happy
  case $app in
    ingest) u=$U_INGEST ;;
    dashboard) u=$U_DASH ;;
    bot) u=$U_BOT ;;
  esac
  # A pending migration, so the test proves the gate fires BEFORE migrating.
  printf 'CREATE TABLE gate_probe (id int);\n' > "$FAKE_TREE/repo-sha/migrations/0002_probe.sql"
  export FAKE_AUTODEPLOY_ON="$u"
  run_script
  if [ "$(deploys)" = '0' ] && [ "$(pins)" = '' ] && [ ! -s "$FAKE_MIGRATED" ]; then
    ok "native Auto Deploy enabled on ${app} aborts the tick before any mutation"
  else
    bad "auto-deploy gate (${app})" "deploys=$(deploys) pins=$(pins) migrated=$(cat "$FAKE_MIGRATED" 2>/dev/null). log: ${OUT}"
  fi
  unset FAKE_AUTODEPLOY_ON
done

setup; happy
printf 'CREATE TABLE gate_probe (id int);\n' > "$FAKE_TREE/repo-sha/migrations/0002_probe.sql"
export FAKE_PREVIEW_ON="$U_DASH"
run_script
if [ "$(deploys)" = '0' ] && [ ! -s "$FAKE_MIGRATED" ]; then
  ok 'preview deployments enabled aborts the tick before any mutation'
else
  bad 'preview gate' "deploys=$(deploys). log: ${OUT}"
fi
unset FAKE_PREVIEW_ON

setup; happy
export FAKE_AUTODEPLOY_ON="$U_BOT"
run_script
if printf '%s' "$OUT" | grep -qF 'Auto Deploy is ENABLED'; then
  ok 'the refusal names the application whose flag is wrong'
else
  bad 'auto-deploy refusal message' "log: ${OUT}"
fi
unset FAKE_AUTODEPLOY_ON

# And the gate must not block a correctly-configured host.
setup; happy
run_script
check 'the safety gate passes when all three are correctly configured' 3 'coolify safety gate passed'

echo
echo '  ── the deploy is of an immutable sha ──'

# --- 26. Coolify is pinned to the exact sha, in dependency order ------------
setup; happy
run_script
expected=$(printf '%s %s\n%s %s\n%s %s\n' "$U_INGEST" "$GREEN_SHA" "$U_DASH" "$GREEN_SHA" "$U_BOT" "$GREEN_SHA")
if [ "$(pins)" = "$expected" ]; then
  ok 'each application is pinned to the exact sha, ingest → dashboard → bot'
else
  bad 'git_commit_sha pinning' "got:
$(pins)
want:
${expected}"
fi

# --- 27. Coolify read-back disagrees with what was asked for ----------------
setup; happy
export FAKE_APP_REPORTS_SHA="$OTHER_SHA"
run_script
if [ "$(deploys)" = '0' ] && [ "$RC" -ne 0 ]; then
  ok 'refuses to deploy an application that did not take the pin'
else
  bad 'a mis-pinned application must not be deployed' "rc=${RC} deploys=$(deploys). log: ${OUT}"
fi
unset FAKE_APP_REPORTS_SHA

# --- 28. Coolify reports a DIFFERENT commit for the finished deployment -----
setup; happy
export FAKE_DEPLOYED_COMMIT="$OTHER_SHA"
run_script
if printf '%s' "$OUT" | grep -qF 'not '"${GREEN_SHA:0:12}"; then
  ok 'a deployment that finished on another commit is a failure'
else
  bad 'Coolify deploying a different sha must fail' "log: ${OUT}"
fi
unset FAKE_DEPLOYED_COMMIT

# --- 29. the application is not on main any more ----------------------------
setup; happy
export FAKE_APP_BRANCH=develop
run_script
if [ "$(deploys)" = '0' ]; then
  ok 'refuses when the application is no longer tracking main'
else
  bad 'a branch change must stop the deploy' "log: ${OUT}"
fi
unset FAKE_APP_BRANCH

echo
echo '  ── failure, and the rollback ──'

# --- 30. the deploy API refuses the first application -----------------------
setup; happy
export FAKE_DEPLOY_API_FAILS_FOR="$U_INGEST"
run_script
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF 'ROLLING BACK'; then
  ok 'a deployment API failure stops and rolls back'
else
  bad 'deploy API failure' "rc=${RC}. log: ${OUT}"
fi
unset FAKE_DEPLOY_API_FAILS_FOR

# --- 31. a partial failure: dashboard fails, the bot is never touched -------
setup; happy
export FAKE_DEPLOY_STATUS_FOR="$U_DASH" FAKE_DEPLOY_STATUS=failed
run_script
if printf '%s' "$OUT" | grep -qF 'Applications after it in the order were not touched' &&
   ! printf '%s' "$OUT" | grep -qF 'bot: deployment'; then
  ok 'a mid-order failure never reaches the applications behind it'
else
  bad 'partial deployment failure' "log: ${OUT}"
fi
# and the rollback pinned the PREVIOUS sha back onto what had moved
if awk -v s="$PREV_SHA" '$2==s{n++} END{exit !(n>=2)}' "$FAKE_PINS"; then
  ok 'the applications that had moved are pinned back to the previous sha'
else
  bad 'rollback pinning' "pins:
$(pins)"
fi
if [ "$(cat "$SHIKOO_AUTODEPLOY_STATE")" = "$PREV_SHA" ]; then
  ok 'a failed candidate is NOT recorded as deployed'
else
  bad 'the failed candidate must not be recorded' "state=$(cat "$SHIKOO_AUTODEPLOY_STATE")"
fi
unset FAKE_DEPLOY_STATUS_FOR FAKE_DEPLOY_STATUS

# --- 32. the health check fails --------------------------------------------
setup; happy
export FAKE_PROBE_FAILS=1
run_script
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF 'ROLLING BACK'; then
  ok 'a health-check failure rolls back'
else
  bad 'health-check failure' "rc=${RC}. log: ${OUT}"
fi
unset FAKE_PROBE_FAILS

# --- 33. the rollback itself fails ------------------------------------------
setup; happy
rm -f "$SHIKOO_AUTODEPLOY_STATE"        # no previous sha to go back to
export FAKE_PROBE_FAILS=1
run_script
if [ "$RC" -ne 0 ] && printf '%s' "$OUT" | grep -qF 'ROLLBACK IMPOSSIBLE'; then
  ok 'a rollback with nowhere to go says so instead of claiming success'
else
  bad 'rollback failure' "rc=${RC}. log: ${OUT}"
fi
unset FAKE_PROBE_FAILS

echo
echo '  ── the bot rollout switch ──'

# Deploying the bot connects OUT: it long-polls Telegram and sweeps verified
# claims. So it is opt-in, and anything that is not exactly `true` is off.
bot_off() { sed -i "s/^AUTODEPLOY_BOT_ENABLED=.*/AUTODEPLOY_BOT_ENABLED=$1/" "$SHIKOO_AUTODEPLOY_ENV"; }

for value in 'false' '' 'yes' '1' 'TRUE' 'True'; do
  setup; happy
  bot_off "$value"
  run_script
  n=$(deploys)
  botcalls=$(grep -cF "$U_BOT" "$FAKE_DEPLOYS" 2>/dev/null || true)
  botpins=$(awk -v u="$U_BOT" '$1==u' "$FAKE_PINS" 2>/dev/null | wc -l)
  if [ "$n" = '2' ] && [ "${botcalls:-0}" = '0' ] && [ "$botpins" = '0' ]; then
    ok "AUTODEPLOY_BOT_ENABLED='${value}' deploys only ingest and dashboard, zero bot calls"
  else
    bad "bot rollout '${value}'" "deploys=${n} botDeployCalls=${botcalls} botPins=${botpins}. log: ${OUT}"
  fi
done

# The one value that turns it on.
setup; happy
run_script
if [ "$(deploys)" = '3' ] && [ "$(grep -cF "$U_BOT" "$FAKE_DEPLOYS")" = '1' ]; then
  ok "AUTODEPLOY_BOT_ENABLED='true' is the only value that deploys the bot"
else
  bad 'bot rollout on' "deploys=$(deploys). log: ${OUT}"
fi

# Off must not mean «unsafe»: the bot's Coolify safety configuration is still
# validated, because auto-deploy being on for the bot is dangerous whether or
# not this script is the thing deploying it.
setup; happy
bot_off false
export FAKE_AUTODEPLOY_ON="$U_BOT"
run_script
if [ "$(deploys)" = '0' ] && printf '%s' "$OUT" | grep -qF 'Auto Deploy is ENABLED'; then
  ok 'the bot is still safety-checked while its rollout is off'
else
  bad 'bot safety check with rollout off' "deploys=$(deploys). log: ${OUT}"
fi
unset FAKE_AUTODEPLOY_ON

# And the refusal is stated, not silent.
setup; happy
bot_off false
run_script
if printf '%s' "$OUT" | grep -qF 'bot rollout is OFF'; then
  ok 'the log says the bot was deliberately excluded'
else
  bad 'bot exclusion message' "log: ${OUT}"
fi

# A failure in dashboard must not roll back a bot that was never touched.
setup; happy
bot_off false
export FAKE_DEPLOY_STATUS_FOR="$U_DASH" FAKE_DEPLOY_STATUS=failed
run_script
if [ "$(grep -cF "$U_BOT" "$FAKE_DEPLOYS" 2>/dev/null || true)" = '0' ] &&
   [ "$(awk -v u="$U_BOT" '$1==u' "$FAKE_PINS" | wc -l)" = '0' ]; then
  ok 'a rollback never touches the bot when its rollout is off'
else
  bad 'rollback touched the excluded bot' "pins:
$(pins)"
fi
unset FAKE_DEPLOY_STATUS_FOR FAKE_DEPLOY_STATUS

echo
echo '  ── the bot is a singleton ──'

# --- 34. two bot containers are never accepted as healthy -------------------
setup; happy
export FAKE_BOT_INSTANCES=2
run_script
if printf '%s' "$OUT" | grep -qF '2 containers up'; then
  ok 'two bot containers are never accepted as a healthy deploy'
else
  bad 'bot singleton' "log: ${OUT}"
fi
unset FAKE_BOT_INSTANCES

# --- 34b. one container, but TWO pollers hold the lock ----------------------
# The case counting containers cannot see, and the reason the lock is asked
# about at all: an old container mid-exit still holds its advisory lock while a
# new one polls, so Telegram is handing updates to a process about to die.
setup; happy
export FAKE_BOT_HOLDERS=2
run_script
if printf '%s' "$OUT" | grep -qF '2 advisory-lock holder'; then
  ok 'two lock holders are refused even when only one container is up'
else
  bad 'bot lock holders' "log: ${OUT}"
fi
unset FAKE_BOT_HOLDERS

# --- 34c. a healthy container that is polling nothing ----------------------
# Zero holders means the process is up, the heartbeat may even be fresh, and
# nobody is talking to Telegram. «Healthy» must not cover for that.
setup; happy
export FAKE_BOT_HOLDERS=0
run_script
if printf '%s' "$OUT" | grep -qF '0 advisory-lock holder'; then
  ok 'a bot holding no lock is not accepted as deployed'
else
  bad 'zero lock holders' "log: ${OUT}"
fi
unset FAKE_BOT_HOLDERS

echo
echo '  ── idempotence, locking, dry run, secrets ──'

# --- 35. the same sha twice deploys once ------------------------------------
setup; happy
run_script; first=$(deploys)
run_script; second=$(deploys)
if [ "$first" = '3' ] && [ "$second" = '3' ]; then
  ok 'the same sha twice deploys once'
else
  bad 'idempotence' "first=${first} second=${second}"
fi

# --- 36. a refused sha is refused silently the second time ------------------
setup
scenario "/commits/${GREEN_SHA}/pulls" 200 '[]'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script; run_script
if [ -z "$OUT" ]; then
  ok 'a sha refused for a terminal reason is not re-announced every tick'
else
  bad 'refusal should be said once' "second run said: ${OUT}"
fi

# --- 37. two at once: only one proceeds -------------------------------------
# Real `flock`, real contention, and BOTH copies fully credentialled against the
# fakes — so the winner reaches and holds the actual critical section rather
# than bailing early on a missing token. An early exit would make this test pass
# for the wrong reason: nothing would have been mutually excluded, because
# nothing would have run.
setup; happy
# `rc=0; … || rc=$?` rather than `…; echo $?`: this file runs under `set -e`,
# so a non-zero script would kill the subshell before the exit code was ever
# recorded — which is exactly what happened, and it looked like a missing file
# rather than a failing run.
( rc=0; bash "$SCRIPT" >"$WORK/a.log" 2>&1 || rc=$?; echo "$rc" > "$WORK/a.rc" ) &
( rc=0; bash "$SCRIPT" >"$WORK/b.log" 2>&1 || rc=$?; echo "$rc" > "$WORK/b.rc" ) &
wait || true
a_rc=$(cat "$WORK/a.rc"); b_rc=$(cat "$WORK/b.rc")
if [ "$(deploys)" = '3' ]; then
  ok 'two concurrent runs deploy the three applications exactly once between them'
else
  bad 'duplicate execution' "deploys=$(deploys)
a: $(cat "$WORK/a.log")
b: $(cat "$WORK/b.log")"
fi
# Exactly one of them must have done the work; the other must have been turned
# away by the lock rather than by an error.
if grep -qF 'another run holds' "$WORK/a.log" || grep -qF 'another run holds' "$WORK/b.log"; then
  ok 'the loser reports «another run holds …» rather than failing silently'
else
  ok 'the two runs serialised without overlapping (no contention window hit)'
fi
if [ "$a_rc" = '0' ] && [ "$b_rc" = '0' ]; then
  ok 'a benign overlap exits 0, so it does not paint the unit red'
else
  bad 'overlap exit code' "a=${a_rc} b=${b_rc}"
fi
# Nothing about the holder — no path beyond the lock file, no pid, no credential.
if grep -hoE 'ghs-FAKE[A-Za-z0-9-]*|coolify-FAKE[A-Za-z0-9-]*' "$WORK/a.log" "$WORK/b.log" | head -1 | grep -q .; then
  bad 'the «already running» message must not leak a secret' 'a token appeared'
else
  ok 'the «already running» message carries no secret'
fi

# --- 37b. the lock is held BEFORE anything is asked of GitHub or Coolify ----
# Hold the lock from outside, then run. If the lock were taken late, the script
# would have made its GitHub calls before discovering it could not proceed.
setup; happy
exec 9>"$SHIKOO_AUTODEPLOY_LOCK"
flock -n 9
run_script
exec 9>&-
if [ "$(deploys)" = '0' ] && [ "$(pins)" = '' ] && printf '%s' "$OUT" | grep -qF 'another run holds'; then
  ok 'a locked-out run touches neither GitHub nor Coolify'
else
  bad 'lock ordering' "deploys=$(deploys) pins=$(pins) log: ${OUT}"
fi

# --- 37c. two concurrent DRY RUNS: only one enters the critical section -----
# The shape §7 asks for, and the shape the installed script is exercised in
# against the real APIs: nothing may be deployed either way, and the loser must
# say so plainly.
setup; happy
( bash "$SCRIPT" --dry-run >"$WORK/d1.log" 2>&1 || true ) &
( bash "$SCRIPT" --dry-run >"$WORK/d2.log" 2>&1 || true ) &
wait || true
if [ "$(deploys)" = '0' ] && [ "$(pins)" = '' ]; then
  ok 'two concurrent dry runs deploy nothing and pin nothing'
else
  bad 'concurrent dry runs must not mutate' "deploys=$(deploys) pins=$(pins)"
fi
entered=$(grep -lF 'DECISION' "$WORK/d1.log" "$WORK/d2.log" 2>/dev/null | wc -l)
if [ "$entered" -ge 1 ]; then
  ok "at least one dry run reached a decision (${entered}/2 entered the section)"
else
  bad 'neither dry run reached a decision' "d1: $(cat "$WORK/d1.log")"
fi

# --- 37d. a crashed holder does not block deployment for ever --------------
# `flock` is a kernel lock on an open file description: it dies with the
# process, so a SIGKILLed run cannot wedge the timer. Asserted rather than
# assumed, because the alternative — a lock file whose mere existence blocks —
# is a very common and very bad way to write this.
setup; happy
# `exec sleep`, not `sleep`. Without the exec the subshell forks sleep as a
# CHILD which inherits fd 8; killing the subshell then leaves the child holding
# the lock for the full sixty seconds, which wedges every test after this one.
# That is not a hypothetical — it is what this line did before the exec.
( exec 8>"$SHIKOO_AUTODEPLOY_LOCK"; flock -n 8 && exec sleep 60 ) &
holder=$!
sleep 0.3
kill -9 "$holder" 2>/dev/null || true
wait "$holder" 2>/dev/null || true
sleep 0.2
run_script
if [ "$(deploys)" = '3' ]; then
  ok 'a SIGKILLed holder releases the lock — the next run proceeds normally'
else
  bad 'crashed holder blocked deployment' "deploys=$(deploys). log: ${OUT}"
fi

# --- 37e. the same sha stays idempotent across a contended run -------------
setup; happy
run_script; first=$(deploys)
( bash "$SCRIPT" >"$WORK/e1.log" 2>&1 || true ) &
( bash "$SCRIPT" >"$WORK/e2.log" 2>&1 || true ) &
wait || true
if [ "$first" = '3' ] && [ "$(deploys)" = '3' ]; then
  ok 'an already-deployed sha stays idempotent even under contention'
else
  bad 'idempotence under contention' "first=${first} after=$(deploys)"
fi

# --- 38. --dry-run writes nothing -------------------------------------------
setup; happy
run_script --dry-run
if [ "$(deploys)" = '0' ] && [ "$(pins)" = '' ] && [ "$(cat "$SHIKOO_AUTODEPLOY_STATE")" = "$PREV_SHA" ]; then
  ok '--dry-run deploys nothing, pins nothing and records nothing'
else
  bad '--dry-run must not write' "deploys=$(deploys) pins=$(pins)"
fi
for field in 'candidate main sha' 'merged PR' 'approval' 'workflow run id' 'Required Quality Gate' 'DECISION'; do
  if printf '%s' "$OUT" | grep -qF -- "$field"; then
    ok "--dry-run reports «${field}»"
  else
    bad "--dry-run must report «${field}»" "log: ${OUT}"
  fi
done

# --- 39. a dry run of a sha that would NOT deploy still reports -------------
setup
scenario "/commits/${GREEN_SHA}/pulls" 200 '[]'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script --dry-run
if printf '%s' "$OUT" | grep -qF 'WOULD NOT DEPLOY'; then
  ok '--dry-run names the refusal rather than printing nothing'
else
  bad '--dry-run should report a refusal' "log: ${OUT}"
fi

# --- 40. no secret ever reaches the log -------------------------------------
# Every scenario above ran through `run_script`, which captures stdout AND
# stderr — which is exactly what the journal gets.
setup; happy
run_script
if printf '%s' "$OUT" | grep -qF -- "$GH_SECRET" || printf '%s' "$OUT" | grep -qF -- "$CO_SECRET"; then
  bad 'no secret reaches the log' 'a token appeared in the output'
else
  ok 'neither token appears anywhere in the log'
fi
if grep -rqF -- "$GH_SECRET" "$SHIKOO_AUTODEPLOY_STATE_DIR" 2>/dev/null; then
  bad 'no secret reaches the state directory' 'a token was written to state'
else
  ok 'neither token is written to the state directory'
fi

# --- 41. fails closed --------------------------------------------------------
setup
scenario "/commits/main" 500 '{"message":"server error"}'
run_script
if [ "$RC" -ne 0 ] && [ "$(deploys)" = '0' ]; then
  ok 'fails closed and non-zero when GitHub errors on the branch read'
else
  bad 'fails closed on a GitHub error' "rc=${RC} deploys=$(deploys). log: ${OUT}"
fi

setup
scenario "/commits/main" 200 'not json at all'
run_script
if [ "$RC" -ne 0 ] && [ "$(deploys)" = '0' ]; then
  ok 'fails closed on a malformed branch body'
else
  bad 'fails closed on a malformed body' "rc=${RC} deploys=$(deploys). log: ${OUT}"
fi

setup; happy
: > "$FAKE_SCENARIO"
scenario "/commits/${GREEN_SHA}/pulls" 500 '{"message":"server error"}'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
if [ "$RC" -ne 0 ] && [ "$(deploys)" = '0' ]; then
  ok 'fails closed when GitHub cannot say which PR produced the sha'
else
  bad 'fails closed on a PR lookup error' "rc=${RC} deploys=$(deploys). log: ${OUT}"
fi

echo
echo '  ── the unit that runs it ──'

# --- 42. the unit must not take the lock the script takes -------------------
# `flock` locks an open file DESCRIPTION. When the unit wrapped ExecStart in
# `flock -n <path>` and the script re-exec'd under `flock -n <same path>`, the
# inner one opened the path afresh, conflicted with the lock the unit still
# held, and returned 1 — printing nothing. The script's body never ran under
# systemd for a whole day and `systemctl status` said only «status=1/FAILURE».
UNIT="${HERE}/../shikoo-autodeploy.service"
if [ -r "$UNIT" ]; then
  if grep -q '^ExecStart=.*flock' "$UNIT"; then
    bad 'the unit must not wrap ExecStart in flock' \
      'the script self-locks on the same path; a second flock -n always loses and exits 1 silently'
  else
    ok 'the unit invokes the script directly — the only flock is the one inside it'
  fi
  if grep -q '^LoadCredential=' "$UNIT" && ! grep -q '^EnvironmentFile=' "$UNIT"; then
    ok 'the unit passes the credential file rather than loading it into the environment'
  else
    bad 'credential handling' 'EnvironmentFile= exposes every value via systemctl show -p Environment'
  fi
  if grep -q '^UMask=0077' "$UNIT"; then
    ok 'the unit sets UMask=0077'
  else
    bad 'UMask' 'the unit must set UMask=0077'
  fi
  if grep -q '^WorkingDirectory=' "$UNIT" && grep -q '^TimeoutStartSec=' "$UNIT"; then
    ok 'the unit has an explicit working directory and a bounded timeout'
  else
    bad 'unit hardening' 'WorkingDirectory= and TimeoutStartSec= are both required'
  fi
  if grep -qE '^ExecStart=.*(TOKEN|ghp_|ghs_|github_pat)' "$UNIT"; then
    bad 'no secret on ExecStart' 'a credential appears on the command line'
  else
    ok 'no secret appears on ExecStart'
  fi
else
  bad 'the unit file' "cannot read ${UNIT}"
fi

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
