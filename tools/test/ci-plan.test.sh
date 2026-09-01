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
# every path the brief requires to force the complete suite, whether it does —
# including each of them buried in a change that is otherwise pure
# documentation, which is the shape a misclassification would actually take.
# `ci-main-provenance.sh` is broken eleven ways and must answer `proven=false`
# to all of them, and the whole log of every one of those runs is searched for
# `proven=true` afterwards, so a future refactor cannot leave the string
# somewhere that a caller would read.

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

section 'A. draft pull request — fast feedback only'
out=$(plan pull_request true $'apps/bot/src/handler.ts\npackages/domain/src/money.ts')
expect 'a draft with application code' "$out" heavy false
expect 'a draft with application code' "$out" static true
expect 'a draft with application code' "$out" deploy_suites false
expect 'a draft with application code' "$out" mode fast

# The draft flag is matched against the exact lowercase string, the same way
# `approval-gate.sh` matches its mode. Anything else is NOT a draft — which
# runs MORE, never less. This is the direction the mistake has to fall in.
for weird in TRUE True yes 1 '' banana; do
  out=$(plan pull_request "$weird" 'apps/bot/src/x.ts')
  if [ "$(field "$out" heavy)" = 'true' ]; then
    ok "IS_DRAFT='${weird}' is not a draft — it runs the complete suite"
  else
    bad "IS_DRAFT='${weird}' must not be read as a draft" "heavy=$(field "$out" heavy)"
  fi
done

section 'B. ready for review — the complete suite'
out=$(plan pull_request false $'apps/bot/src/handler.ts')
expect 'a ready PR with application code' "$out" heavy true
expect 'a ready PR with application code' "$out" static true
expect 'a ready PR with application code' "$out" mode full
# The one selection this file makes: apps/ does not reach the deploy suites.
expect 'application-only work does not run the deploy suites' "$out" deploy_suites false

section 'C. documentation only'
out=$(plan pull_request false $'docs/RELEASE.md\nREADME.md\napps/bot/NOTES.md\nLICENSE')
expect 'a docs-only PR' "$out" heavy false
expect 'a docs-only PR' "$out" deploy_suites false
expect 'a docs-only PR' "$out" mode docs
expect 'a docs-only PR still runs the static checks' "$out" static true

section 'D. unknown runs everything'
for probe in 'UNKNOWN' '' '   '; do
  out=$(plan pull_request false "$probe")
  label="an unusable file list (${probe:-empty})"
  if [ "$(field "$out" heavy)" = 'true' ] &&
    [ "$(field "$out" deploy_suites)" = 'true' ] &&
    [ "$(field "$out" mode)" = 'full' ]; then
    ok "${label} runs everything"
  else
    bad "${label} must run everything" "$out"
  fi
done

# A path that matches no rule at all is code, not documentation. This is the
# allowlist doing its job: the docs verdict requires a positive match on every
# single path, so a directory nobody has thought of yet cannot arrive as
# «docs-only» by matching nothing.
out=$(plan pull_request false $'weird/unheard-of/thing.xyz')
expect 'a path matching no rule is not documentation' "$out" heavy true
expect 'a path matching no rule is not documentation' "$out" mode full

section 'E. events that are never optimised'
for ev in merge_group workflow_dispatch push some_event_from_the_future; do
  out=$(plan "$ev" false 'docs/README.md')
  if [ "$(field "$out" heavy)" = 'true' ] && [ "$(field "$out" deploy_suites)" = 'true' ]; then
    ok "event '${ev}' runs everything even on a docs-only diff"
  else
    bad "event '${ev}' must run everything" "$out"
  fi
done

section 'F. the paths that MUST force the complete suite'
#
# The brief's list, path by path. Each one is presented buried in a change that
# is otherwise pure documentation — which is the shape a misclassification
# would actually take, and the shape a deny-list would get wrong.
CORE_PATHS=(
  'pnpm-lock.yaml'                       # lockfiles
  'pnpm-workspace.yaml'                  # workspace configuration
  'package.json'                         # workspace configuration
  'packages/domain/src/money.ts'         # shared packages
  'packages/contracts/src/index.ts'      # shared packages
  'packages/db/src/schema.ts'            # database code
  'packages/migrate/src/mysql.ts'        # database code
  'migrations/0038_add_a_column.sql'     # migrations
  'deploy/deploy.sh'                     # deployment scripts
  'deploy/approval-gate.sh'              # deployment scripts
  '.github/workflows/ci.yml'             # workflow files
  '.github/workflows/deploy-staging.yml' # workflow files
  '.github/ci-baseline.json'             # CI test infrastructure
  'tools/ci-run-tests.sh'                # CI test infrastructure
  'tools/ci-verify-gate.ts'              # CI test infrastructure
  'tools/ci-plan.sh'                     # the test-selection logic itself
  'tools/ci-main-provenance.sh'          # the test-selection logic itself
  'Dockerfile'                           # the deployable artifact
  'sim/docker-compose.yml'               # CI test infrastructure
)
for p in "${CORE_PATHS[@]}"; do
  out=$(plan pull_request false "docs/CHANGELOG.md"$'\n'"$p")
  h=$(field "$out" heavy)
  d=$(field "$out" deploy_suites)
  m=$(field "$out" mode)
  if [ "$h" = 'true' ] && [ "$d" = 'true' ] && [ "$m" = 'full' ]; then
    ok "${p} forces the complete suite"
  else
    bad "${p} must force the complete suite" "heavy=${h} deploy_suites=${d} mode=${m}"
  fi
done

section 'G. the two lists cannot overlap'
#
# `is_docs` and `touches_deploy_surface` are separate `case` statements, so
# nothing structural stops a future edit from adding a pattern to both. If one
# ever did, a path could be documentation AND a deploy trigger at once, and
# the docs-only verdict would skip a deploy script that changed. Every path
# this file names is checked against both.
overlap=0
for p in "${CORE_PATHS[@]}" docs/RELEASE.md README.md LICENSE .gitignore \
  graphify-out/graph.json apps/bot/src/x.ts weird/thing.xyz; do
  # docs-only verdict from this path alone
  a=$(plan pull_request false "$p")
  if [ "$(field "$a" mode)" = 'docs' ] && [ "$(field "$a" deploy_suites)" = 'true' ]; then
    bad 'a path is both documentation and a deploy trigger' "$p"
    overlap=$((overlap + 1))
  fi
done
[ "$overlap" -eq 0 ] && ok 'no path is classified as documentation and as a deploy trigger'

section 'H. the deploy-suite selection actually selects'
# It has to be capable of saying no, or the path filter is decoration.
out=$(plan pull_request false $'apps/bot/src/a.ts\napps/dashboard-worker/src/b.ts')
expect 'application-only work' "$out" deploy_suites false
out=$(plan pull_request false $'apps/bot/src/a.ts\ndeploy/over-ssh.sh')
expect 'one deploy script among application work' "$out" deploy_suites true

# ═══════════════════════════════════════════════ part two: the main provenance

section 'I. main provenance — a real git repo and a fake GitHub'

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
url=''
for a in "$@"; do case "$a" in https://*) url=$a ;; esac; done
while IFS=$'\t' read -r frag status file; do
  case "$url" in
    *"$frag"*) cat "$file"; printf '%s' "$status"; exit 0 ;;
  esac
done <"$FAKE_SCEN"
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

# Order matters: `/commits/<sha>/pulls` contains `/commits/<sha>`, so the more
# specific fragment has to be registered first or the general one swallows it.
happy() {
  : >"$SCEN"
  scenario "/commits/${SHA_MAIN}/pulls" 200 \
    "$(printf '[{"number":7,"merged_at":"2026-09-01T10:00:00Z","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' "$SHA_MAIN" "$SHA_HEAD")"
  scenario "/actions/runs?head_sha=${SHA_HEAD}" 200 \
    '{"workflow_runs":[{"id":9001,"event":"pull_request","conclusion":"success"}]}'
  scenario "/actions/runs/9001/jobs" 200 \
    '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"success"}]}'
  scenario "/commits/${SHA_MAIN}" 200 \
    "$(printf '{"commit":{"tree":{"sha":"%s"}},"parents":[{"sha":"%s"}]}' "$LOCAL_TREE" "$SHA_P1")"
  scenario "/commits/${SHA_HEAD}" 200 \
    "$(printf '{"commit":{"tree":{"sha":"%s"}}}' "$LOCAL_TREE")"
  scenario "/compare/${SHA_P1}...${SHA_HEAD}" 200 \
    "$(printf '{"merge_base_commit":{"sha":"%s"},"files":[{"filename":"apps/bot/src/x.ts"}]}' "$SHA_P1")"
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
      bash "$PROV" 'Shikoonet/Shikoonet-Platform' "${SHA_OVERRIDE:-$SHA_MAIN}"
  ) >"$LOG" 2>&1
  local rc=$?
  set -e
  return $rc
}

proven() { grep -q '^\[provenance\] proven=true$' "$LOG"; }

# ── the happy path ────────────────────────────────────────────────────────
happy
if run_prov && proven; then
  ok 'a merged, fully validated, fast-forwarded PR is proven'
else
  bad 'the happy path must be proven' "$(tail -5 "$LOG")"
fi

# ── every way it must refuse ──────────────────────────────────────────────
denies() { # label  reason-substring
  cat "$LOG" >>"$ALL"
  local rc=0
  # It must EXIT 0 — the caller reads `proven`, and a non-zero exit would fail
  # the plan job instead of falling back to the complete suite.
  if [ "${LAST_RC}" -ne 0 ]; then
    bad "$1" "exited ${LAST_RC}; it must exit 0 and report proven=false"
    return
  fi
  if proven; then
    bad "$1" 'reported proven=true'
    return
  fi
  if [ -n "${2:-}" ] && ! grep -qF "$2" "$LOG"; then
    bad "$1" "did not say «${2}» — $(grep NOT "$LOG" | head -1)"
    return
  fi
  ok "$1"
  return $rc
}

try() { LAST_RC=0; run_prov || LAST_RC=$?; }

# 1. a direct push: no merged pull request claims the commit
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 '[]'
try
denies 'a direct push to main is not proven — the complete suite runs' 'not exactly one'

# 2. an ambiguous association
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 \
  "$(printf '[{"number":7,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}},{"number":8,"merged_at":"x","base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' \
    "$SHA_MAIN" "$SHA_HEAD" "$SHA_MAIN" "$SHA_HEAD")"
try
denies 'two merged PRs claiming one commit is not proven' 'not exactly one'

# 3. an unmerged PR does not count
happy
: >"$SCEN"
scenario "/commits/${SHA_MAIN}/pulls" 200 \
  "$(printf '[{"number":7,"merged_at":null,"base":{"ref":"main"},"merge_commit_sha":"%s","head":{"sha":"%s"}}]' "$SHA_MAIN" "$SHA_HEAD")"
try
denies 'an open pull request does not prove anything' 'not exactly one'

# 4. the gate did not succeed on the head
happy
scenario "/actions/runs/9001/jobs" 200 \
  '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"failure"}]}'
: >"$SCEN"
happy
printf '%s\t%s\t%s\n' "/actions/runs/9001/jobs" 200 "$WORK/failjobs" >"$WORK/tmp.tsv"
printf '{"jobs":[{"name":"Required Quality Gate","status":"completed","conclusion":"failure"}]}' >"$WORK/failjobs"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a red Required Quality Gate on the head is not proven' 'did not succeed on the PR head'

# 5. the gate is absent from the run entirely
happy
printf '%s\t%s\t%s\n' "/actions/runs/9001/jobs" 200 "$WORK/nogate" >"$WORK/tmp.tsv"
printf '{"jobs":[{"name":"lint","status":"completed","conclusion":"success"}]}' >"$WORK/nogate"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a run without the gate job at all is not proven' 'did not succeed on the PR head'

# 6. the only green run on the head was a `push`, not a `pull_request`
happy
printf '%s\t%s\t%s\n' "/actions/runs?head_sha=${SHA_HEAD}" 200 "$WORK/pushrun" >"$WORK/tmp.tsv"
printf '{"workflow_runs":[{"id":9001,"event":"push","conclusion":"success"}]}' >"$WORK/pushrun"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a push run on the head does not stand in for the pull_request run' 'no successful pull_request run'

# 7. the merged tree is NOT the tested tree
happy
printf '%s\t%s\t%s\n' "/commits/${SHA_HEAD}" 200 "$WORK/othertree" >"$WORK/tmp.tsv"
printf '{"commit":{"tree":{"sha":"%s"}}}' "$OTHER_TREE" >"$WORK/othertree"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a merged tree that differs from the tested tree is not proven' 'differs from the tested head tree'

# 8. GitHub describes a commit that is not the one on this runner
happy
printf '%s\t%s\t%s\n' "/commits/${SHA_MAIN}/pulls" 200 "$WORK/body.1" >"$WORK/tmp.tsv"
printf '%s\t%s\t%s\n' "/commits/${SHA_MAIN}" 200 "$WORK/wrongmain" >>"$WORK/tmp.tsv"
printf '{"commit":{"tree":{"sha":"%s"}},"parents":[{"sha":"%s"}]}' "$OTHER_TREE" "$SHA_P1" >"$WORK/wrongmain"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a checkout whose tree is not the reported one is not proven' 'is not the tree GitHub reports'

# 9. the merge was not a fast-forward — the merge ref carried other bytes
happy
printf '%s\t%s\t%s\n' "/compare/${SHA_P1}...${SHA_HEAD}" 200 "$WORK/noff" >"$WORK/tmp.tsv"
printf '{"merge_base_commit":{"sha":"%s"},"files":[]}' "$(printf 'd%.0s' {1..40})" >"$WORK/noff"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a merge that was not a fast-forward is not proven' 'is not an ancestor of the PR head'

# 10. the pull request edited the CI trust surface
for surface in '.github/workflows/ci.yml' '.github/ci-baseline.json' 'tools/ci-plan.sh' 'tools/ci-verify-gate.ts'; do
  happy
  printf '%s\t%s\t%s\n' "/compare/${SHA_P1}...${SHA_HEAD}" 200 "$WORK/trust" >"$WORK/tmp.tsv"
  printf '{"merge_base_commit":{"sha":"%s"},"files":[{"filename":"%s"}]}' "$SHA_P1" "$surface" >"$WORK/trust"
  cat "$SCEN" >>"$WORK/tmp.tsv"
  mv "$WORK/tmp.tsv" "$SCEN"
  try
  denies "a PR that edits ${surface} is not proven" 'the CI trust surface changed'
done

# 11. a comparison capped at 300 files cannot answer the trust-surface question
happy
printf '%s\t%s\t%s\n' "/compare/${SHA_P1}...${SHA_HEAD}" 200 "$WORK/capped" >"$WORK/tmp.tsv"
{
  printf '{"merge_base_commit":{"sha":"%s"},"files":[' "$SHA_P1"
  for i in $(seq 1 300); do
    [ "$i" -eq 1 ] || printf ','
    printf '{"filename":"apps/bot/f%s.ts"}' "$i"
  done
  printf ']}'
} >"$WORK/capped"
cat "$SCEN" >>"$WORK/tmp.tsv"
mv "$WORK/tmp.tsv" "$SCEN"
try
denies 'a truncated comparison is refused rather than searched' 'capped at 300'

# 12. the API is simply unavailable
: >"$SCEN"
try
denies 'an unreachable GitHub is not proven' 'could not ask which PR produced'

# 13. no token
happy
TOKEN_OVERRIDE='' try
unset TOKEN_OVERRIDE
denies 'no GITHUB_TOKEN is not proven' 'no GITHUB_TOKEN'

# 14. a malformed sha
happy
SHA_OVERRIDE='not-a-sha' try
unset SHA_OVERRIDE
denies 'a malformed sha is not proven' 'not a full 40-character commit sha'

section 'J. no refusal ever emitted proven=true'
# Every negative log above, concatenated. `proven=true` appearing anywhere in
# any of them would mean a caller reading the output could be misled, whatever
# the exit code said.
if grep -q 'proven=true' "$ALL"; then
  bad 'no refusal emits proven=true' "$(grep -n 'proven=true' "$ALL" | head -3)"
else
  ok "none of the $(grep -c 'proven=false' "$ALL") refusals emitted proven=true"
fi

section 'K. the workflow believes exactly these four outputs'
# `ci-plan.sh` publishing a key `ci.yml` does not read, or `ci.yml` reading one
# `ci-plan.sh` does not publish, would be a silent `if:` on an empty string —
# which GitHub evaluates as false, so the job would skip and the gate would
# expect it to have run. Red, but for a reason nobody could see. This pins the
# contract between the two files.
CI_YML="$ROOT/.github/workflows/ci.yml"
for k in static heavy deploy_suites mode; do
  if plan pull_request false 'apps/bot/x.ts' | grep -q "^${k}="; then
    ok "ci-plan.sh publishes '${k}'"
  else
    bad "ci-plan.sh publishes '${k}'" 'absent from its output'
  fi
done
for k in static heavy deploy_suites image mode; do
  if grep -q "needs.plan.outputs.${k}" "$CI_YML"; then
    ok "ci.yml reads 'plan.outputs.${k}'"
  else
    bad "ci.yml reads 'plan.outputs.${k}'" 'no job consults it'
  fi
done

# The aggregator has to name every job it gates on, or a job could fail with
# nothing noticing.
for j in static unit db-shard migrations image e2e deploy-suites; do
  if grep -q "needs\.${j}\.result" "$CI_YML"; then
    ok "the gate reads the result of '${j}'"
  else
    bad "the gate reads the result of '${j}'" 'it is not among the results checked'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
