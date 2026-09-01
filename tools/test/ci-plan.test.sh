#!/usr/bin/env bash
#
# The two files that decide what CI does not run.
#
# A selector is the one piece of CI whose bugs are invisible: everything stays
# green, and what changes is how much was actually checked. So both halves are
# executed here rather than read — `tools/ci-plan.sh` against real path lists,
# and `tools/ci-main-provenance.sh` against a fake GitHub and a real git repo,
# with the happy path broken in one place at a time.
#
# The cases that matter most are the negative ones. `ci-plan.sh` is asked, for
# every path the brief requires to force the complete gate, whether it does —
# including each of them buried in a change that is otherwise pure
# documentation, which is the shape a misclassification would actually take.
# `ci-main-provenance.sh` is broken sixteen ways and must answer `proven=false`
# to all of them, and the whole log of every one of those runs is searched for
# `proven=true` afterwards, so a future refactor cannot leave the string
# somewhere that a caller would read.
#
# Since 2026-09-01 the selector can also skip suites for a change confined to
# `apps/`, and `tools/test/ci-suite-map.test.sh` is the other half of proving
# that safe: it recomputes the app map from the workspace's own dependency
# graph. This file proves the RULES; that one proves the TABLE.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PLAN="$ROOT/tools/ci-plan.sh"
PROV="$ROOT/tools/ci-main-provenance.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

# ═════════════════════════════════════════════════════ part one: the selector

plan() { # event  is_draft  changed-files  -> key=value lines
  EVENT="$1" IS_DRAFT="$2" CHANGED_FILES="$3" bash "$PLAN"
}

field() { # output  key
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k { print $2 }'
}

expect() { # label  output  key  want
  local got
  got=$(field "$2" "$3")
  if [ "$got" = "$4" ]; then ok "$1 → ${3}=${4}"; else bad "$1" "${3}=${got}, expected ${4}"; fi
}

# Every selectable output is `true`. The complete gate, and nothing less.
expect_everything() { # label  output
  local k got missing=''
  for k in static unit db e2e deploy_suites; do
    got=$(field "$2" "$k")
    [ "$got" = 'true' ] || missing="${missing} ${k}=${got}"
  done
  if [ -z "$missing" ]; then ok "$1 runs the complete gate"; else bad "$1" "not everything:${missing}"; fi
}

# Nothing expensive. `static` may still be true — that is Fast mode.
expect_nothing_expensive() { # label  output
  local k got extra=''
  for k in unit db e2e deploy_suites; do
    got=$(field "$2" "$k")
    [ "$got" = 'false' ] || extra="${extra} ${k}=${got}"
  done
  if [ -z "$extra" ]; then ok "$1 starts no database, no browser, no docker"; else bad "$1" "ran:${extra}"; fi
}

section 'A. draft pull request — fast feedback only'
out=$(plan pull_request true $'apps/bot/src/handler.ts\npackages/domain/src/money.ts')
expect_nothing_expensive 'a draft with application code' "$out"
expect 'a draft with application code' "$out" static true
expect 'a draft with application code' "$out" mode fast

# The draft flag is matched against the exact lowercase string, the same way
# `approval-gate.sh` matches its mode. Anything else is NOT a draft — which
# runs MORE, never less. This is the direction the mistake has to fall in.
for weird in TRUE True yes 1 '' banana; do
  out=$(plan pull_request "$weird" 'packages/domain/src/x.ts')
  if [ "$(field "$out" db)" = 'true' ]; then
    ok "IS_DRAFT='${weird}' is not a draft — it runs the complete gate"
  else
    bad "IS_DRAFT='${weird}' must not be read as a draft" "db=$(field "$out" db)"
  fi
done

section 'B. ready for review — a shared package runs the complete gate'
out=$(plan pull_request false $'packages/domain/src/handler.ts')
expect_everything 'a ready PR touching shared domain logic' "$out"
expect 'a ready PR touching shared domain logic' "$out" mode full

section 'C. documentation only'
out=$(plan pull_request false $'docs/RELEASE.md\nREADME.md\napps/bot/NOTES.md\nLICENSE')
expect_nothing_expensive 'a docs-only PR' "$out"
expect 'a docs-only PR' "$out" mode docs
expect 'a docs-only PR still runs the static checks' "$out" static true

section 'D. unknown runs everything'
for probe in 'UNKNOWN' '' '   '; do
  out=$(plan pull_request false "$probe")
  expect_everything "an unusable file list (${probe:-empty})" "$out"
  expect "an unusable file list (${probe:-empty})" "$out" mode full
done

# A path that matches no rule at all is code, not documentation, and it is not
# an application either — so it runs everything. This is the allowlist doing
# its job in both directions.
out=$(plan pull_request false $'weird/unheard-of/thing.xyz')
expect_everything 'a path matching no rule' "$out"
expect 'a path matching no rule is not documentation' "$out" mode full

section 'E. events that are never optimised'
for ev in merge_group workflow_dispatch some_event_from_the_future; do
  out=$(plan "$ev" false 'docs/README.md')
  expect_everything "event '${ev}' on a docs-only diff" "$out"
done

section 'F. the paths that MUST force the complete gate'
#
# The brief's list, path by path. Each one is presented buried in a change that
# is otherwise pure documentation — which is the shape a misclassification
# would actually take, and the shape a deny-list would get wrong.
CORE_PATHS=(
  'pnpm-lock.yaml'                       # lockfiles
  'pnpm-workspace.yaml'                  # workspace configuration
  'package.json'                         # workspace configuration
  'apps/bot/package.json'                # an app's own dependency list
  'packages/domain/src/money.ts'         # money/wallet/order/payment logic
  'packages/contracts/src/index.ts'      # shared contracts
  'packages/database/src/adapter.ts'     # database adapters
  'packages/db/src/schema.ts'            # database code
  'packages/sms-parser/src/parse.ts'     # SMS parsing
  'packages/migrate/src/mysql.ts'        # database code
  'packages/seed/src/sim.ts'             # test infrastructure
  'migrations/0038_add_a_column.sql'     # migrations
  'migrations/verify_invariants.sql'     # the money invariants
  'deploy/deploy.sh'                     # deployment scripts
  'deploy/approval-gate.sh'              # deployment scripts
  'deploy/test/autodeploy.test.sh'       # deployment test infrastructure
  '.github/workflows/ci.yml'             # workflow files
  '.github/workflows/deploy-staging.yml' # workflow files
  '.github/ci-baseline.json'             # CI test infrastructure
  'tools/ci-run-tests.sh'                # CI test infrastructure
  'tools/ci-integration.sh'              # CI test infrastructure
  'tools/ci-verify-gate.ts'              # CI test infrastructure
  'tools/ci-plan.sh'                     # the test-selection logic itself
  'tools/ci-main-provenance.sh'          # the test-selection logic itself
  'Dockerfile'                           # the deployable artifact
  'sim/docker-compose.yml'               # CI test infrastructure
  'vitest.coverage.ts'                   # the coverage floors
  'eslint.config.mjs'                    # the lint rules
)
for p in "${CORE_PATHS[@]}"; do
  out=$(plan pull_request false "docs/CHANGELOG.md"$'\n'"$p")
  expect_everything "${p}" "$out"
done

section 'G. nothing is both documentation and code'
#
# `is_docs` is an allowlist and the app map is a `case`, so nothing structural
# stops a future edit from adding a pattern to both. If one ever did, a path
# could be documentation AND a code path at once, and the docs-only verdict
# would skip a suite that changed.
overlap=0
for p in "${CORE_PATHS[@]}" apps/bot/src/x.ts apps/admin-web/src/y.tsx weird/thing.xyz; do
  a=$(plan pull_request false "$p")
  if [ "$(field "$a" mode)" = 'docs' ]; then
    bad 'a code path was classified as documentation' "$p"
    overlap=$((overlap + 1))
  fi
done
[ "$overlap" -eq 0 ] && ok 'no code path is classified as documentation'

section 'H. change-aware selection — the brief, scenario by scenario'

# 3. Ready UI-only PR → the UI-relevant suites, and not the database.
out=$(plan pull_request false $'apps/admin-web/src/pages/StatsPage.tsx\napps/admin-web/test/stats-page.test.tsx')
expect 'admin UI only' "$out" mode apps
expect 'admin UI only runs its own unit suite' "$out" unit true
expect 'admin UI only runs the browser walk' "$out" e2e true
expect 'admin UI only does not start a database' "$out" db false
expect 'admin UI only does not run the deploy suites' "$out" deploy_suites false

# 4. Ready bot change → bot/domain/DB coverage, and no browser.
out=$(plan pull_request false $'apps/bot/src/tokenWatch.ts')
expect 'bot only' "$out" mode apps
expect 'bot only runs the database executor' "$out" db true
expect 'bot only does not run the browser walk' "$out" e2e false
expect 'bot only does not run the deploy suites' "$out" deploy_suites false

# The panel serves the SPA, so a dashboard change needs both.
out=$(plan pull_request false $'apps/dashboard-worker/src/botRoutes.ts')
expect 'dashboard-worker' "$out" db true
expect 'dashboard-worker also drives the browser walk' "$out" e2e true

out=$(plan pull_request false $'apps/ingest-worker/src/sms.ts')
expect 'ingest only runs the database executor' "$out" db true
expect 'ingest only does not run the browser walk' "$out" e2e false

# 6. workflow/deploy change → the complete workflow/deploy validation.
out=$(plan pull_request false $'deploy/autodeploy.sh')
expect_everything 'a deployment-only change' "$out"
out=$(plan pull_request false $'.github/workflows/promote-production.yml')
expect_everything 'a workflow-only change' "$out"

# The union across a mixed apps/ change, not the last one to be read.
out=$(plan pull_request false $'apps/admin-web/src/a.tsx\napps/bot/src/b.ts')
expect 'admin-web and bot together' "$out" unit true
expect 'admin-web and bot together' "$out" db true
expect 'admin-web and bot together' "$out" e2e true

# One non-app path among app work pulls the whole gate back in.
out=$(plan pull_request false $'apps/admin-web/src/a.tsx\npackages/contracts/src/x.ts')
expect_everything 'one shared package among app work' "$out"

section 'I. selection must be capable of saying no'
# If every branch selected everything, sections H would pass for the wrong
# reason and this file would be proving nothing.
out=$(plan pull_request false 'apps/bot/src/a.ts')
if [ "$(field "$out" e2e)" = 'false' ] && [ "$(field "$out" deploy_suites)" = 'false' ] &&
  [ "$(field "$out" unit)" = 'false' ]; then
  ok 'an apps/-only change really does select suites away'
else
  bad 'selection is decoration — nothing was ever skipped' "$out"
fi

section 'J. push to main — proven, blocked, and everything else'

push() { # proven  association -> output
  EVENT=push IS_DRAFT=false CHANGED_FILES=UNKNOWN PROVEN="$1" ASSOCIATION="$2" bash "$PLAN"
}

out=$(push true merged)
expect 'a proven main tree' "$out" mode main-proven
expect_nothing_expensive 'a proven main tree' "$out"
expect 'a proven main tree still verifies the image' "$out" image true
expect 'a proven main tree does not re-run the static half' "$out" static false

out=$(push false none)
expect 'a direct push to main' "$out" mode main-blocked
expect_nothing_expensive 'a direct push to main' "$out"
expect 'a direct push builds no image either' "$out" image false

# Every OTHER way of being unproven runs the complete gate. `none` is the only
# value that may reach the cheap path, and it must be exact.
for assoc in unknown '' ambiguous NONE None 'none '; do
  out=$(push false "$assoc")
  m=$(field "$out" mode)
  if [ "$m" = 'main-full' ]; then
    ok "unproven with association='${assoc}' runs the complete gate"
  else
    bad "unproven with association='${assoc}' must run the complete gate" "mode=${m}"
  fi
done
out=$(push false unknown)
expect_everything 'an unproven main push' "$out"
expect 'an unproven main push verifies the image' "$out" image true

# `proven` is matched exactly too: anything that is not 'true' is not proven.
for weird in TRUE True yes 1 '' banana; do
  out=$(EVENT=push IS_DRAFT=false CHANGED_FILES=UNKNOWN PROVEN="$weird" ASSOCIATION=unknown bash "$PLAN")
  if [ "$(field "$out" mode)" = 'main-full' ]; then
    ok "PROVEN='${weird}' is not proven — the complete gate runs"
  else
    bad "PROVEN='${weird}' must not be read as proven" "mode=$(field "$out" mode)"
  fi
done

# ═══════════════════════════════════════════════ part two: the main provenance

section 'K. main provenance — a real git repo and a fake GitHub'

REPO_DIR="$WORK/repo"
mkdir -p "$REPO_DIR"
(
  cd "$REPO_DIR"
  git init -q .
  git config user.email ci@example.test
  git config user.name ci
  echo 'hello' >file.txt
  git add file.txt
  git commit -qm 'the merged tree'
)
LOCAL_TREE=$(cd "$REPO_DIR" && git rev-parse 'HEAD^{tree}')
OTHER_TREE=$(printf '%040d' 7 | tr '0' 'b')

SHA_MAIN=$(printf 'a%.0s' {1..40})
SHA_HEAD=$(printf 'b%.0s' {1..40})
SHA_P1=$(printf 'c%.0s' {1..40})

BIN="$WORK/bin"
mkdir -p "$BIN"
SCEN="$WORK/scenarios.tsv"

# A fake `curl` that answers from a scenario table, matching the URL by
# substring, first row wins. Same shape as `deploy/test/deploy-pipeline.test.sh`
# uses, so there is one way to fake GitHub in this repository rather than two.
cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
# The LONGEST matching fragment wins, not the first one registered. Registration
# order used to decide it, which meant `/commits/<sha>` silently shadowed
# `/commits/<sha>/pulls` the moment an override put the shorter row on top —
# a test harness bug that reads exactly like a script bug.
url=''
for a in "$@"; do case "$a" in https://*) url=$a ;; esac; done
best_len=-1 best_status='' best_file=''
while IFS=$'\t' read -r frag status file; do
  case "$url" in
    *"$frag"*)
      if [ "${#frag}" -gt "$best_len" ]; then
        best_len=${#frag}; best_status=$status; best_file=$file
      fi
      ;;
  esac
done <"$FAKE_SCEN"
if [ "$best_len" -ge 0 ]; then
  cat "$best_file"; printf '%s' "$best_status"; exit 0
fi
printf '{"message":"no scenario for %s"}404' "$url"
FAKE
chmod +x "$BIN/curl"
export FAKE_SCEN="$SCEN"

n=0
scenario() { # url-fragment  status  body
  n=$((n + 1))
  printf '%s' "$3" >"$WORK/body.$n"
  printf '%s\t%s\t%s\n' "$1" "$2" "$WORK/body.$n" >>"$SCEN"
}

# The jobs of a COMPLETE pull_request run under the consolidated shape.
# `integration-e2e` is listed as `success` here; the happy path's file list is
# `apps/bot`, which does not require it, so this also proves that an executor
# running when it was not required does not by itself refuse the proof.
full_run_jobs() {
  printf '{"jobs":['
  printf '{"name":"Required Quality Gate","status":"completed","conclusion":"success"},'
  printf '{"name":"image","status":"completed","conclusion":"skipped"},'
  local first=1 j
  for j in 'checks' 'integration-db' 'integration-e2e'; do
    [ $first -eq 1 ] || printf ','
    first=0
    printf '{"name":"%s","status":"completed","conclusion":"success"}' "$j"
  done
  printf ']}'
}

# A FAST-mode run: exactly what a DRAFT pull request leaves behind — a green
# «Required Quality Gate» over a run in which every executor skipped.
fast_run_jobs() {
  printf '{"jobs":['
  printf '{"name":"Required Quality Gate","status":"completed","conclusion":"success"},'
  printf '{"name":"checks","status":"completed","conclusion":"success"},'
  printf '{"name":"integration-db","status":"completed","conclusion":"skipped"},'
  printf '{"name":"integration-e2e","status":"completed","conclusion":"skipped"}'
  printf ']}'
}

# Order matters: `/commits/<sha>/pulls` contains `/commits/<sha>`, so the more
# specific fragment has to be registered first or the general one swallows it.
happy() {
  : >"$SCEN"
  scenario "/commits/${SHA_MAIN}/pulls" 200 \
    "$(printf '[{"number":7,"merged_at":"2026-09-01T10:00:00Z","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' "$SHA_MAIN" "$SHA_HEAD")"
  # The file list the proof re-classifies. `apps/bot` only, so the expectation
  # it derives is `checks` + `integration-db` and NOT `integration-e2e`.
  scenario "/pulls/7/files" 200 '[{"filename":"apps/bot/src/x.ts"}]'
  scenario "/actions/runs?head_sha=${SHA_HEAD}" 200 \
    '{"workflow_runs":[{"id":9001,"event":"pull_request","conclusion":"success"}]}'
  scenario "/actions/runs/9001/jobs" 200 "$(full_run_jobs)"
  scenario "/commits/${SHA_MAIN}" 200 \
    "$(printf '{"commit":{"tree":{"sha":"%s"}},"parents":[{"sha":"%s"}]}' "$LOCAL_TREE" "$SHA_P1")"
  scenario "/commits/${SHA_HEAD}" 200 \
    "$(printf '{"commit":{"tree":{"sha":"%s"}}}' "$LOCAL_TREE")"
  scenario "/compare/${SHA_P1}...${SHA_HEAD}" 200 \
    "$(printf '{"merge_base_commit":{"sha":"%s"},"files":[{"filename":"apps/bot/src/x.ts"}]}' "$SHA_P1")"
}

# Put a replacement row for one fragment AHEAD of the happy table, so it wins.
ov=0
override() { # fragment  body
  ov=$((ov + 1))
  printf '%s' "$2" >"$WORK/ov.$ov"
  printf '%s\t%s\t%s\n' "$1" 200 "$WORK/ov.$ov" >"$WORK/tmp.tsv"
  cat "$SCEN" >>"$WORK/tmp.tsv"
  mv "$WORK/tmp.tsv" "$SCEN"
}

LOG="$WORK/prov.log"
ALL="$WORK/all-negative.log"
: >"$ALL"

run_prov() { # -> exit code; output in $LOG
  set +e
  (
    cd "$REPO_DIR"
    PATH="$BIN:$PATH" GITHUB_TOKEN="${TOKEN_OVERRIDE-t0ken}" \
      GITHUB_API='https://api.github.com' \
      PLAN_SCRIPT="$PLAN" \
      bash "$PROV" 'Shikoonet/Shikoonet-Platform' "${SHA_OVERRIDE:-$SHA_MAIN}"
  ) >"$LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}

proven() { grep -q 'proven=true' "$LOG"; }

# ── the happy path ────────────────────────────────────────────────────────
happy
if run_prov && proven; then
  ok 'a merged, fully validated, fast-forwarded PR is proven'
else
  bad 'the happy path must be proven' "$(tail -5 "$LOG")"
fi

# ── the selected happy path ───────────────────────────────────────────────
#
# The whole point of re-deriving the expectation: an `apps/bot` pull request
# legitimately never runs `integration-e2e`, and demanding it would make every
# selected run unprovable — which would have cost more minutes on `main` than
# selection ever saved on the branch.
happy
override "/actions/runs/9001/jobs" \
  '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"success"},{"name":"checks","status":"completed","conclusion":"success"},{"name":"integration-db","status":"completed","conclusion":"success"},{"name":"integration-e2e","status":"completed","conclusion":"skipped"}]}'
if run_prov && proven; then
  ok 'a bot-only PR that skipped integration-e2e is still proven'
else
  bad 'a legitimately selected run must still be provable' "$(tail -5 "$LOG")"
fi

# ── every way it must refuse ──────────────────────────────────────────────
denies() { # label  reason-substring
  cat "$LOG" >>"$ALL"
  if [ "${LAST_RC}" -ne 0 ]; then
    bad "$1" "exited ${LAST_RC}; it must exit 0 and report proven=false"
    return
  fi
  if proven; then
    bad "$1" 'reported proven=true'
    return
  fi
  if [ -n "${2:-}" ] && ! grep -qF "$2" "$LOG"; then
    bad "$1" "did not say «${2}» — $(grep 'NOT PROVEN' "$LOG" | head -1)"
    return
  fi
  ok "$1"
}

try() { LAST_RC=0; run_prov || LAST_RC=$?; }

# 1. a direct push: no merged pull request claims the commit. This one must
#    ALSO report `association=none`, because that single value is what buys the
#    cheap blocked verdict instead of a complete gate on an undeployable tree.
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 '[]'
try
denies 'a direct push to main is not proven' 'not exactly one'
if grep -q 'association=none' "$LOG"; then
  ok 'a direct push reports association=none'
else
  bad 'a direct push must report association=none' "$(grep provenance "$LOG" | tail -1)"
fi

# 2. an ambiguous association is NOT a direct push — somebody merged something,
#    and «which PR vouches for this tree» has no reviewable answer. It must run
#    the complete gate, not the cheap blocked path.
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 \
  "$(printf '[{"number":7,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}},{"number":8,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' \
    "$SHA_MAIN" "$SHA_HEAD" "$SHA_MAIN" "$SHA_HEAD")"
try
denies 'two merged PRs claiming one commit is not proven' 'not exactly one'
if grep -q 'association=unknown' "$LOG"; then
  ok 'an ambiguous association is NOT reported as a direct push'
else
  bad 'an ambiguous association must not reach the blocked path' "$(grep provenance "$LOG" | tail -1)"
fi

# 3. an unmerged PR does not count
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 \
  "$(printf '[{"number":7,"merged_at":null,"base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' "$SHA_MAIN" "$SHA_HEAD")"
try
denies 'an open pull request does not prove anything' 'not exactly one'

# 4. the changed-file list is unavailable — the expectation cannot be derived,
#    so nothing below it can be believed.
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 \
  "$(printf '[{"number":7,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' "$SHA_MAIN" "$SHA_HEAD")"
try
denies 'an unreadable changed-file list is not proven' 'could not list the files'

# 5. a pull request larger than one page classifies as UNKNOWN, which requires
#    every executor — so the bot-only job list above no longer satisfies it.
happy
{
  printf '['
  for i in $(seq 1 100); do
    [ "$i" -eq 1 ] || printf ','
    printf '{"filename":"apps/bot/f%s.ts"}' "$i"
  done
  printf ']'
} >"$WORK/manyfiles"
override "/pulls/7/files" "$(cat "$WORK/manyfiles")"
override "/actions/runs/9001/jobs" \
  '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"success"},{"name":"checks","status":"completed","conclusion":"success"},{"name":"integration-db","status":"completed","conclusion":"success"},{"name":"integration-e2e","status":"completed","conclusion":"skipped"}]}'
try
denies 'a PR too big to classify requires every executor' 'integration-e2e'

# 6. the gate did not succeed on the head
happy
override "/actions/runs/9001/jobs" \
  '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"failure"}]}'
try
denies 'a red Required Quality Gate on the head is not proven' 'complete suite passed'

# 7. the gate is absent from the run entirely
happy
override "/actions/runs/9001/jobs" '{"jobs":[{"name":"checks","status":"completed","conclusion":"success"}]}'
try
denies 'a run without the gate job at all is not proven' 'complete suite passed'

# 8. THE DRAFT HOLE. A green gate over a Fast-mode run must not be proof.
#
# This is the case CodeRabbit caught on PR #47. Without it: merge a still-draft
# pull request, its head carries a perfectly green «Required Quality Gate» from
# a run that skipped every executor, `main` believes it, skips the gate too, and
# Deploy Staging ships a tree whose tests never ran anywhere.
#
# The expectation is re-derived with IS_DRAFT=false, which is what makes the
# draft's own plan irrelevant to the answer.
happy
override "/actions/runs/9001/jobs" "$(fast_run_jobs)"
try
denies 'a green gate over a DRAFT fast run is not proof the gate ran' 'complete suite passed'
if grep -q 'integration-db' "$LOG"; then
  ok 'the refusal names the executor that did not run'
else
  bad 'the refusal names the executor that did not run' "$(grep 'NOT PROVEN' "$LOG")"
fi

# 9. one red executor in an otherwise complete run is also refused
happy
override "/actions/runs/9001/jobs" \
  '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"success"},{"name":"checks","status":"completed","conclusion":"success"},{"name":"integration-db","status":"completed","conclusion":"failure"}]}'
try
denies 'a red integration-db in an otherwise complete run is not proven' 'complete suite passed'

# 10. the only green run on the head was a `push`, not a `pull_request`
happy
override "/actions/runs?head_sha=${SHA_HEAD}" \
  '{"workflow_runs":[{"id":9001,"event":"push","conclusion":"success"}]}'
try
denies 'a push run on the head does not stand in for the pull_request run' 'no successful pull_request run'

# 11. the merged tree is NOT the tested tree
happy
override "/commits/${SHA_HEAD}" "$(printf '{"commit":{"tree":{"sha":"%s"}}}' "$OTHER_TREE")"
try
denies 'a merged tree that differs from the tested tree is not proven' 'differs from the tested head tree'

# 12. GitHub describes a commit that is not the one on this runner
happy
override "/commits/${SHA_MAIN}" \
  "$(printf '{"commit":{"tree":{"sha":"%s"}},"parents":[{"sha":"%s"}]}' "$OTHER_TREE" "$SHA_P1")"
try
denies 'a checkout whose tree is not the reported one is not proven' 'is not the tree GitHub reports'

# 13. the merge was not a fast-forward — the merge ref carried other bytes
happy
override "/compare/${SHA_P1}...${SHA_HEAD}" \
  "$(printf '{"merge_base_commit":{"sha":"%s"},"files":[]}' "$(printf 'd%.0s' {1..40})")"
try
denies 'a merge that was not a fast-forward is not proven' 'is not an ancestor of the PR head'

# 14. the pull request edited the CI trust surface
for surface in '.github/workflows/ci.yml' '.github/ci-baseline.json' 'tools/ci-plan.sh' 'tools/ci-verify-gate.ts'; do
  happy
  override "/compare/${SHA_P1}...${SHA_HEAD}" \
    "$(printf '{"merge_base_commit":{"sha":"%s"},"files":[{"filename":"%s"}]}' "$SHA_P1" "$surface")"
  try
  denies "a PR that edits ${surface} is not proven" 'the CI trust surface changed'
done

# 15. a comparison capped at 300 files cannot answer the trust-surface question
happy
{
  printf '{"merge_base_commit":{"sha":"%s"},"files":[' "$SHA_P1"
  for i in $(seq 1 300); do
    [ "$i" -eq 1 ] || printf ','
    printf '{"filename":"apps/bot/f%s.ts"}' "$i"
  done
  printf ']}'
} >"$WORK/capped"
override "/compare/${SHA_P1}...${SHA_HEAD}" "$(cat "$WORK/capped")"
try
denies 'a truncated comparison is refused rather than searched' 'capped at 300'

# 16. the API is simply unavailable
: >"$SCEN"
try
denies 'an unreachable GitHub is not proven' 'could not ask which PR produced'

# 17. no token
happy
TOKEN_OVERRIDE='' try
unset TOKEN_OVERRIDE
denies 'no GITHUB_TOKEN is not proven' 'no GITHUB_TOKEN'

# 18. a malformed sha
happy
SHA_OVERRIDE='not-a-sha' try
unset SHA_OVERRIDE
denies 'a malformed sha is not proven' 'not a full 40-character commit sha'

section 'L. no refusal ever emitted proven=true'
# Every negative log above, concatenated. `proven=true` appearing anywhere in
# any of them would mean a caller reading the output could be misled, whatever
# the exit code said.
if grep -q 'proven=true' "$ALL"; then
  bad 'no refusal emits proven=true' "$(grep -n 'proven=true' "$ALL" | head -3)"
else
  ok "none of the $(grep -c 'proven=false' "$ALL") refusals emitted proven=true"
fi

section 'M. the workflow believes exactly these outputs'
# `ci-plan.sh` publishing a key `ci.yml` does not read, or `ci.yml` reading one
# `ci-plan.sh` does not publish, would be a silent `if:` on an empty string —
# which GitHub evaluates as false, so the job would skip and the gate would
# expect it to have run. Red, but for a reason nobody could see. This pins the
# contract between the two files.
CI_YML="$ROOT/.github/workflows/ci.yml"
for k in static unit db e2e deploy_suites image mode; do
  if plan pull_request false 'apps/bot/x.ts' | grep -q "^${k}="; then
    ok "ci-plan.sh publishes '${k}'"
  else
    bad "ci-plan.sh publishes '${k}'" 'absent from its output'
  fi
done
# `static` steers steps INSIDE `checks`, so it is read as
# `steps.decide.outputs.static`; the rest steer other jobs and are read as
# `needs.checks.outputs.*`. Either spelling counts — what is being pinned is
# that every published key has a consumer, not which one.
for k in static unit db e2e deploy_suites image mode; do
  if grep -q "checks.outputs.${k}" "$CI_YML" || grep -q "decide.outputs.${k}" "$CI_YML"; then
    ok "ci.yml reads '${k}'"
  else
    bad "ci.yml reads '${k}'" 'no job or step consults it'
  fi
done

# The aggregator has to name every job it gates on, or a job could fail with
# nothing noticing.
for j in 'integration-db' 'integration-e2e' 'image'; do
  if grep -q "needs\.${j}\.result" "$CI_YML"; then
    ok "the gate reads the result of '${j}'"
  else
    bad "the gate reads the result of '${j}'" 'it is not among the results checked'
  fi
done
if grep -q 'needs.checks.result' "$CI_YML"; then
  ok "the gate reads the result of 'checks'"
else
  bad "the gate reads the result of 'checks'" 'it is not among the results checked'
fi

# A blocked direct push must be red, not green. The gate's own `exit 1` on that
# branch is the whole of Lever B's safety, so it is pinned here.
if grep -q "MODE.*=.*'main-blocked'" "$CI_YML" && \
   awk '/main-blocked/{f=1} f && /exit 1/{print; exit}' "$CI_YML" | grep -q 'exit 1'; then
  ok 'the gate fails on a blocked direct push rather than reporting success'
else
  bad 'the gate must fail on main-blocked' 'no exit 1 on that branch'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
