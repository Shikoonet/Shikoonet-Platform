#!/usr/bin/env bash
#
# `deploy/autodeploy.sh`, driven against a fake GitHub and a fake Coolify.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why a shell test and not a vitest one
#
# The thing under test IS a shell script. Reimplementing its logic in
# TypeScript to test it would test the reimplementation; running it with a
# `curl` on PATH that answers from fixtures runs the real control flow — the
# `set -e`, the subshell that once swallowed an HTTP status, the `jq` filters,
# the order of the two branch reads.
#
# ─────────────────────────────────────────────────────────────────────────────
# How the fake works
#
# A directory is put at the front of PATH holding a `curl` that reads a
# scenario file instead of the network. Each scenario maps a URL fragment to a
# body; the fake appends the status code the way real `curl -w '%{http_code}'`
# does, because the script parses the last three characters and that parsing is
# itself something worth exercising.
#
# `flock` is faked too — the real one needs `/run`, which a test should not
# touch — and Coolify POSTs are recorded to a file so a test can assert how
# many deploys were queued.
#
# ─────────────────────────────────────────────────────────────────────────────
# What is asserted
#
# The nine properties a deploy trigger has to have. Each has at least one test
# that fails if the guard is removed:
#
#   1. deploys the exact green sha
#   2. refuses a run that is still in progress
#   3. refuses when any run concluded failure
#   4. refuses when a run was SKIPPED   (was accepted as green before)
#   5. refuses when only a pull_request run is green for the sha
#   6. refuses when «Required Quality Gate» did not succeed
#   7. refuses when the branch moved between reading CI and deploying
#   8. is idempotent — the same sha twice deploys once
#   9. fails closed on a GitHub error or a malformed body
#
# Run: bash deploy/test/autodeploy.test.sh

set -Eeuo pipefail

HERE=$(cd -- "$(dirname -- "$0")" && pwd)
SCRIPT="${HERE}/../autodeploy.sh"
[ -r "$SCRIPT" ] || { echo "cannot read $SCRIPT"; exit 1; }

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

BIN="$WORK/bin"
mkdir -p "$BIN"

# ---------------------------------------------------------------------------
# The fake curl.
#
# Scenario lines are `<url-fragment>\t<status>\t<body>`. First match wins, so a
# scenario can put a narrower fragment above a broader one. A URL that matches
# nothing is a test bug and says so loudly rather than defaulting to 200 —
# defaulting would let a test pass because the script never made the call it
# was supposed to make.
# ---------------------------------------------------------------------------
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''
for a in "$@"; do
  case "$a" in
    http*) url="$a" ;;
  esac
done

# A Coolify deploy: record it and answer.
case "$url" in
  *coolify*|*"/api/v1/deploy"*)
    printf '%s\n' "$url" >> "$FAKE_DEPLOYS"
    printf '{"message":"queued"}'
    exit 0
    ;;
esac

while IFS=$'\t' read -r frag status body; do
  [ -n "${frag:-}" ] || continue
  case "$url" in
    *"$frag"*)
      printf '%s%s' "$body" "$status"
      exit 0
      ;;
  esac
done < "$FAKE_SCENARIO"

echo "FAKE CURL: no scenario line matched $url" >&2
exit 99
FAKE
chmod +x "$BIN/curl"

# `flock` in the test replaces the real one: same contract (`flock -n FILE CMD
# ARGS`), no `/run`.
cat > "$BIN/flock" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
shift            # -n
shift            # the lock path
exec "$@"
FAKE
chmod +x "$BIN/flock"

export PATH="$BIN:$PATH"

# ---------------------------------------------------------------------------
# Harness
# ---------------------------------------------------------------------------
PASS=0
FAIL=0

GREEN_SHA=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
OTHER_SHA=bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb

setup() {
  export FAKE_SCENARIO="$WORK/scenario"
  export FAKE_DEPLOYS="$WORK/deploys"
  : > "$FAKE_SCENARIO"
  : > "$FAKE_DEPLOYS"

  export SHIKOO_AUTODEPLOY_ENV="$WORK/env"
  export SHIKOO_AUTODEPLOY_STATE="$WORK/state"
  export SHIKOO_AUTODEPLOY_LOCK="$WORK/lock"
  unset SHIKOO_AUTODEPLOY_LOCKED
  rm -f "$SHIKOO_AUTODEPLOY_STATE"

  cat > "$SHIKOO_AUTODEPLOY_ENV" <<EOF
GH_REPO='fake/repo'
GH_TOKEN='fake-token'
COOLIFY_URL='http://coolify.invalid:8000'
COOLIFY_TOKEN='fake-coolify'
APP_UUIDS='app-one app-two app-three'
BRANCH='main'
EOF
}

scenario() { printf '%s\t%s\t%s\n' "$1" "$2" "$3" >> "$FAKE_SCENARIO"; }

deploys() { wc -l < "$FAKE_DEPLOYS" | tr -d ' '; }

run_script() {
  set +e
  OUT=$(bash "$SCRIPT" 2>&1)
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

# Convenience: the standard run list for a sha, with a single completed push
# run whose conclusion is $2 and whose jobs include a gate with conclusion $3.
runs_json() { printf '{"total_count":1,"workflow_runs":[{"id":501,"name":"CI","status":"%s","conclusion":%s}]}' "$1" "$2"; }
jobs_json() { printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"},{"name":"Required Quality Gate","status":"completed","conclusion":%s}]}' "$1"; }
commit_json() { printf '{"sha":"%s"}' "$1"; }

echo 'autodeploy — exact-SHA behaviour'

# --- 1. the happy path ------------------------------------------------------
setup
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"success"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'deploys the exact green sha' 3 "${GREEN_SHA:0:12}"

# --- 2. a run still in progress --------------------------------------------
setup
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json in_progress null)"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses while CI is still running' 0 'still running'

# --- 3. a failed run --------------------------------------------------------
setup
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"failure"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses a failed run' 0 'CI FAILED'

# --- 4. a SKIPPED run is not a pass ----------------------------------------
# This is the regression that mattered: `skipped` used to be accepted
# alongside `success`, so a workflow whose jobs all skipped deployed a commit
# nothing had tested.
setup
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"skipped"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses a skipped run — skipped is not success' 0 'CI FAILED'

# --- 5. only a pull_request run is green -----------------------------------
# The query now carries `event=push`, so a PR run does not answer for this sha
# and the API returns an empty list. `none` must not deploy.
setup
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 '{"total_count":0,"workflow_runs":[]}'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses when no push run exists for the sha' 0 'no workflow run'

# --- 6. the required gate did not succeed ----------------------------------
setup
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"failure"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses when «Required Quality Gate» did not succeed' 0 'Required Quality Gate'

# --- 6b. the gate job is absent entirely -----------------------------------
setup
scenario "/actions/runs/501/jobs" 200 '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"}]}'
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'refuses when the gate job is not present at all' 0 'Required Quality Gate'

# --- 7. the branch moved while CI was being read ---------------------------
# The first `/commits/main` answers the green sha; a second scenario line
# cannot be reached (first match wins), so the race is expressed by making the
# jobs call ALSO advance the branch — done here with a scenario whose commit
# body is the other sha, placed so the RE-READ sees it.
setup
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"success"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
# A stateful commit endpoint: first call → green sha, later calls → other sha.
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *"/api/v1/deploy"*) printf '%s\n' "$url" >> "$FAKE_DEPLOYS"; printf '{"message":"queued"}'; exit 0 ;;
esac
case "$url" in
  */commits/main)
    n=$(cat "$FAKE_COMMIT_CALLS" 2>/dev/null || echo 0)
    printf '%s' "$((n + 1))" > "$FAKE_COMMIT_CALLS"
    if [ "$n" -eq 0 ]; then printf '{"sha":"%s"}200' "$FAKE_SHA_FIRST"
    else printf '{"sha":"%s"}200' "$FAKE_SHA_LATER"; fi
    exit 0 ;;
esac
while IFS=$'\t' read -r frag status body; do
  [ -n "${frag:-}" ] || continue
  case "$url" in *"$frag"*) printf '%s%s' "$body" "$status"; exit 0 ;; esac
done < "$FAKE_SCENARIO"
echo "FAKE CURL: no scenario line matched $url" >&2
exit 99
FAKE
chmod +x "$BIN/curl"
export FAKE_COMMIT_CALLS="$WORK/commit-calls"
export FAKE_SHA_FIRST="$GREEN_SHA"
export FAKE_SHA_LATER="$OTHER_SHA"
rm -f "$FAKE_COMMIT_CALLS"
run_script
check 'refuses when the branch moved between reading CI and deploying' 0 'moved'

# Restore the plain fake for the remaining tests.
cat > "$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
url=''
for a in "$@"; do case "$a" in http*) url="$a" ;; esac; done
case "$url" in
  *"/api/v1/deploy"*) printf '%s\n' "$url" >> "$FAKE_DEPLOYS"; printf '{"message":"queued"}'; exit 0 ;;
esac
while IFS=$'\t' read -r frag status body; do
  [ -n "${frag:-}" ] || continue
  case "$url" in *"$frag"*) printf '%s%s' "$body" "$status"; exit 0 ;; esac
done < "$FAKE_SCENARIO"
echo "FAKE CURL: no scenario line matched $url" >&2
exit 99
FAKE
chmod +x "$BIN/curl"

# --- 8. idempotent on the same sha -----------------------------------------
setup
scenario "/actions/runs/501/jobs" 200 "$(jobs_json '"success"')"
scenario "/actions/runs?head_sha=${GREEN_SHA}" 200 "$(runs_json completed '"success"')"
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
first=$(deploys)
run_script
second=$(deploys)
if [ "$first" = '3' ] && [ "$second" = '3' ]; then
  ok 'the same sha twice deploys once'
else
  bad 'the same sha twice deploys once' "first=${first} second=${second}"
fi

# --- 9. fails closed --------------------------------------------------------
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

setup
scenario "/actions/runs?head_sha=${GREEN_SHA}" 403 '{"message":"forbidden"}'
scenario "/commits/main" 200 "$(commit_json "$GREEN_SHA")"
run_script
check 'a 403 on the runs API does not deploy and does not record the sha' 0 'Actions: Read-only'
if [ ! -s "$SHIKOO_AUTODEPLOY_STATE" ]; then
  ok 'a permission failure leaves the sha unseen, so it deploys once fixed'
else
  bad 'a permission failure must not record the sha' "state=$(cat "$SHIKOO_AUTODEPLOY_STATE")"
fi

echo
printf '%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]