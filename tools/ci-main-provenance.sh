#!/usr/bin/env bash
#
# «Has the complete suite already passed on THIS EXACT TREE?»
#
# Asked once, on `main`, after a merge. When the answer is yes the push-to-main
# run does not re-run fourteen billed minutes of tests that can only reach the
# same verdict, because they would be running against the same bytes.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this is not a fail-open
#
# The optimisation this file authorises is «skip the suite». So the ONLY thing
# it may ever get wrong in the cheap direction is saying `proven=false` when it
# could have said true — which costs minutes and nothing else.
#
# Every failure therefore prints `proven=false` and EXITS 0: an API that
# timed out, a field that was absent, a shape that did not parse, a repository
# that answered 500. The caller runs the complete suite. There is no error path
# that reaches `proven=true`, and no `|| true` anywhere near one.
#
# ─────────────────────────────────────────────────────────────────────────────
# What has to be true, in order, for `proven=true`
#
#   1. `$SHA` is the result of exactly ONE merged pull request into `main`.
#      A direct push matches none. An ambiguous association has no reviewable
#      answer. Both are refused — this is the same question, and the same
#      endpoint, that `deploy/approval-gate.sh` already asks at deploy time.
#
#   2. «Required Quality Gate» completed successfully on that pull request's
#      final head, in a run whose event was `pull_request`, AND that run
#      actually ran the complete suite.
#
#      The second half is not redundant, and leaving it out was a fail-open.
#      A DRAFT pull request produces a green «Required Quality Gate» over a
#      run in which `unit`, both `db-shard`s, `migrations` and `e2e` were all
#      skipped — that is the entire point of Fast mode. Merging such a PR
#      while it is still a draft would then satisfy the gate check here, and
#      `main` would skip the suite too, and Deploy Staging would ship a tree
#      whose tests had never run anywhere.
#
#      So the required suites are named and each one must have COMPLETED
#      SUCCESSFULLY in that same run. `deploy-suites` and `image` are
#      deliberately NOT in the list: the first is legitimately path-gated away
#      on a change confined to `apps/`, and the second never runs on a pull
#      request at all.
#
#   3. The tree GitHub reports for `$SHA` is the tree we actually checked out.
#      Local `git rev-parse HEAD^{tree}` against the API's answer, so every
#      claim below is about the bytes on this runner rather than about a
#      commit id somebody handed us.
#
#   4. tree($SHA) == tree(PR head). Byte-for-byte. Not «the diff is empty» and
#      not «the same files changed» — the same tree object id, which is a hash
#      of the entire recursive content.
#
#   5. The first parent of `$SHA` — the tip of `main` immediately before the
#      merge — is an ANCESTOR of the pull request head.
#
#      This is the step that makes (4) mean something. A `pull_request` run
#      does not check out the head; it checks out `refs/pull/N/merge`, the
#      merge of the head into the base. If the base is an ancestor of the head
#      then that merge is a fast-forward, so the merge ref's tree IS the head's
#      tree — which is the tree (4) just matched. Without this step, (4) proves
#      main matches a commit whose merge ref may have carried different bytes,
#      and the whole chain would be about a tree nothing ever tested.
#
#      It also covers the base having moved between the run and the merge: if
#      the pre-merge tip P1 is an ancestor of the head, so is every commit
#      before P1, so every merge ref this pull request ever had was the same
#      fast-forward.
#
#   6. The pull request changed NOTHING in the CI trust surface —
#      `.github/`, `tools/ci-*`, `.github/ci-baseline.json`.
#
#      A `pull_request` run executes the workflow file FROM THE BRANCH. Without
#      this step a contributor could weaken `Required Quality Gate` on their own
#      branch, get it green, and have main believe it. With it, any pull request
#      that touches how CI decides anything gets the complete suite re-run on
#      main from main's own trusted copy of these files.
#
# Nothing a contributor uploads is read. No artifact, no report, no job output
# — only GitHub's own record of what ran, and git's own record of what is here.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: ci-main-provenance.sh <owner/repo> <sha>

set -Eeuo pipefail

REPO=${1:-}
SHA=${2:-}
API=${GITHUB_API:-https://api.github.com}
BRANCH=${BRANCH:-main}
REQUIRED_JOB=${REQUIRED_JOB:-Required Quality Gate}

# The jobs whose green is what «the complete gate passed» actually means.
#
# Since 2026-09-01 the gate SELECTS: a pull request confined to `apps/` runs
# only the executors that own a suite which could observe it. So this list can
# no longer be a constant — a bot-only pull request legitimately never runs
# `integration-e2e`, and demanding it would make every selected run unprovable.
#
# It is therefore RE-DERIVED, below, from two things a contributor cannot
# write: GitHub's own list of the files the pull request changed, and THIS
# checkout's copy of `tools/ci-plan.sh` — which is `main`'s copy, because this
# script only ever runs on a `main` checkout. The plan the branch published is
# never read.
#
# That is safe because of condition 6: any pull request that touched `.github/`,
# `tools/ci-*` or the baseline is refused outright, so a branch cannot change
# how selection works and then be believed. And it is computed with
# IS_DRAFT=false, so a run that was green only because it was a DRAFT still
# fails here — the fail-open this file was corrected for on PR #47.
# Normally EMPTY, and re-derived below from GitHub's own file list and this
# checkout's own copy of `tools/ci-plan.sh`. Settable only so the test suite can
# pin it; nothing in CI sets it.
REQUIRED_SUITES=${REQUIRED_SUITES:-}
PLAN_SCRIPT=${PLAN_SCRIPT:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/ci-plan.sh}

# Every exit from here on goes through this. `proven` defaults to false and is
# set to true on exactly one line, at the very bottom.
PROVEN=false

# WHY the answer is what it is, and it is consulted for exactly one purpose:
# `none` — GitHub answered, and NO merged pull request claims this sha — is a
# direct push, which `deploy/approval-gate.sh` condition 1 already refuses to
# deploy. `tools/ci-plan.sh` turns that one value into a cheap blocked verdict
# instead of a complete suite nothing could ever ship.
#
# It starts at `unknown` and is set to `none` on exactly ONE line, reached only
# when the API returned 200 AND jq counted zero. Every other outcome — a
# timeout, a 500, an unparseable body, two claimants, or any later step — leaves
# it `unknown`, and `unknown` runs the complete fallback. A blocked verdict is
# cheaper than the suite, so `unknown` is the safe direction and the only
# default.
ASSOCIATION=unknown
finish() {
  echo "[provenance] proven=${PROVEN} association=${ASSOCIATION}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'proven=%s\n' "$PROVEN" >>"$GITHUB_OUTPUT"
    printf 'association=%s\n' "$ASSOCIATION" >>"$GITHUB_OUTPUT"
  fi
  exit 0
}
no() {
  echo "[provenance] NOT PROVEN: $*"
  echo "[provenance] the complete suite will run on this commit"
  finish
}
say() { echo "[provenance] $*"; }

# Spelled as an `if` rather than `A && B || C`, which shellcheck reads as a
# possible if-then-else mistake (SC2015) — the same correction `approval-gate.sh`
# carries, for the same reason.
if [ -z "$REPO" ] || [ -z "$SHA" ]; then
  no 'usage: ci-main-provenance.sh <owner/repo> <sha>'
fi
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || no "'${SHA}' is not a full 40-character commit sha"
[ -n "${GITHUB_TOKEN:-}" ] || no 'no GITHUB_TOKEN'

# The token reaches curl through a config file, never through argv — argv is
# readable by every process on the runner. Same handling as
# `deploy/approval-gate.sh`, for the same reason.
CURLDIR=$(mktemp -d)
trap 'rm -rf "$CURLDIR"' EXIT
chmod 700 "$CURLDIR"
{
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} >"$CURLDIR/gh"
chmod 600 "$CURLDIR/gh"

gh_body=''
gh() {
  local out status
  out=$(curl -sS -m 30 -w '%{http_code}' -K "$CURLDIR/gh" "${API}/repos/${REPO}$1") || return 1
  status=${out: -3}
  gh_body=${out:0:${#out}-3}
  [ "$status" = '200' ]
}

# ───────────────────────────────────────── 1. exactly one merged pull request
gh "/commits/${SHA}/pulls" || no "could not ask which PR produced ${SHA:0:12}"

matches=$(printf '%s' "$gh_body" | jq -c --arg sha "$SHA" --arg base "$BRANCH" '
  if type != "array" then [] else
    [ .[] | select(
        .merged_at != null
        and .base.ref == $base
        and (.merge_commit_sha == $sha or .head.sha == $sha)) ]
  end') || no 'could not parse the pull request list'

count=$(printf '%s' "$matches" | jq -r 'length') || no 'could not count the matching pull requests'
# Zero claimants, from an API call that succeeded and a body that parsed: a
# direct push. Two or more is an ambiguous association, which is NOT a direct
# push and stays `unknown` — somebody merged something, and which PR vouches
# for this tree has no reviewable answer.
if [ "$count" = '0' ]; then
  ASSOCIATION=none
fi
[ "$count" = '1' ] ||
  no "${SHA:0:12} is claimed by ${count} merged pull request(s) into ${BRANCH}, not exactly one"

PR_NUMBER=$(printf '%s' "$matches" | jq -r '.[0].number // empty')
PR_HEAD=$(printf '%s' "$matches" | jq -r '.[0].head.sha // empty')
if [ -z "$PR_NUMBER" ] || [ -z "$PR_HEAD" ]; then
  no 'the merged PR came back without a number or a head sha'
fi
[[ $PR_HEAD =~ ^[0-9a-f]{40}$ ]] || no "PR #${PR_NUMBER} reported a malformed head sha"
say "PR #${PR_NUMBER}, final head ${PR_HEAD:0:12}"

# ─────────────── 1b. which executors SHOULD have run on this pull request
if [ -z "$REQUIRED_SUITES" ]; then
  gh "/pulls/${PR_NUMBER}/files?per_page=100" ||
    no "could not list the files PR #${PR_NUMBER} changed"

  file_count=$(printf '%s' "$gh_body" | jq -r 'if type == "array" then length else -1 end') ||
    no 'could not parse the changed-file list'
  if [ "$file_count" -lt 0 ]; then
    no 'the changed-file list did not come back as an array'
  fi

  # One page, and one page only. A pull request with 100 files might have 101,
  # and a truncated list would classify as something smaller than the truth.
  # `UNKNOWN` is what `ci-plan.sh` turns into «run everything», which is the
  # direction this has to fall in.
  if [ "$file_count" -ge 100 ]; then
    say "PR #${PR_NUMBER} changed ${file_count}+ files — more than one page, classifying as UNKNOWN"
    PR_FILES=UNKNOWN
  else
    PR_FILES=$(printf '%s' "$gh_body" | jq -r '.[].filename') ||
      no 'could not read the changed-file names'
    [ -n "$PR_FILES" ] || PR_FILES=UNKNOWN
  fi

  [ -r "$PLAN_SCRIPT" ] || no "cannot read the plan script at ${PLAN_SCRIPT}"
  plan_out=$(EVENT=pull_request IS_DRAFT=false CHANGED_FILES="$PR_FILES" bash "$PLAN_SCRIPT") ||
    no 'the plan script would not run'

  plan_field() { printf '%s\n' "$plan_out" | awk -F= -v k="$1" '$1 == k { print $2 }'; }
  want_db=$(plan_field db)
  want_e2e=$(plan_field e2e)
  want_deploy=$(plan_field deploy_suites)

  # `checks` is not conditional: every pull request runs it, so it is always
  # required. The two integration executors are required exactly when the plan
  # says their contents were selected. An unreadable field is empty, which is
  # not 'false', so it is treated as required — the fail-closed direction.
  suites='["checks"]'
  if [ "$want_db" != 'false' ]; then
    suites=$(printf '%s' "$suites" | jq -c '. + ["integration-db"]') ||
      no 'could not build the required-suite list'
  fi
  if [ "$want_e2e" != 'false' ] || [ "$want_deploy" != 'false' ]; then
    suites=$(printf '%s' "$suites" | jq -c '. + ["integration-e2e"]') ||
      no 'could not build the required-suite list'
  fi
  REQUIRED_SUITES=$suites
  say "PR #${PR_NUMBER} required: $(printf '%s' "$REQUIRED_SUITES" | jq -r 'join(", ")')"
fi

# ──────────────────────── 2. the gate passed on that head, as a pull_request
#
# `event == "pull_request"` is not decoration. The same sha can be the head of
# a branch that was ALSO pushed somewhere, and a `push` run on it proves
# nothing about the branch having been validated as a pull request.
gh "/actions/runs?head_sha=${PR_HEAD}&per_page=100" ||
  no "could not list the runs on the PR head ${PR_HEAD:0:12}"

ids=$(printf '%s' "$gh_body" | jq -r '
  [ .workflow_runs[]? | select(.event == "pull_request" and .conclusion == "success") | .id ] | .[]
') || no 'could not parse the run list for the PR head'
[ -n "$ids" ] || no "no successful pull_request run on the PR head ${PR_HEAD:0:12}"

gate_ok=false
missing_report=''
for id in $ids; do
  gh "/actions/runs/${id}/jobs?per_page=100" || no "could not read the jobs of run ${id}"

  # The successful job names in this run, once, then two questions against it:
  # was the gate green, and did every required suite actually run and pass.
  missing=$(printf '%s' "$gh_body" | jq -r --arg n "$REQUIRED_JOB" --argjson want "$REQUIRED_SUITES" '
    [ .jobs[]? | select(.status == "completed" and .conclusion == "success") | .name ] as $ok
    | (if ($ok | index($n)) == null then [$n] else [] end) + ($want - $ok)
    | join(", ")
  ') || no "could not read the job list of run ${id}"

  if [ -z "$missing" ]; then
    gate_ok=true
    say "«${REQUIRED_JOB}» and every required suite succeeded on the PR head in run ${id}"
    break
  fi
  missing_report="run ${id} did not have: ${missing}"
done
if [ "$gate_ok" != 'true' ]; then
  # Named rather than summarised, because «a draft was merged» and «a suite
  # went red» are different problems and the log should say which.
  no "the PR head ${PR_HEAD:0:12} has no run in which the gate AND the complete suite passed — ${missing_report}"
fi

# ─────────────────────── 3. the API is describing the commit we checked out
gh "/commits/${SHA}" || no "could not read ${SHA:0:12}"
MAIN_TREE=$(printf '%s' "$gh_body" | jq -r '.commit.tree.sha // empty') ||
  no "could not parse ${SHA:0:12}"
PARENT1=$(printf '%s' "$gh_body" | jq -r '.parents[0].sha // empty') ||
  no "could not read the first parent of ${SHA:0:12}"
if [ -z "$MAIN_TREE" ] || [ -z "$PARENT1" ]; then
  no "${SHA:0:12} came back without a tree or a parent"
fi

LOCAL_TREE=$(git rev-parse 'HEAD^{tree}' 2>/dev/null) ||
  no 'could not read the tree of the local checkout'
[ "$LOCAL_TREE" = "$MAIN_TREE" ] ||
  no "the checkout's tree ${LOCAL_TREE:0:12} is not the tree GitHub reports for ${SHA:0:12} (${MAIN_TREE:0:12})"
say "the checkout is ${SHA:0:12}, tree ${MAIN_TREE:0:12}"

# ────────────────────────────────── 4. the merged tree IS the tested tree
gh "/commits/${PR_HEAD}" || no "could not read the PR head ${PR_HEAD:0:12}"
HEAD_TREE=$(printf '%s' "$gh_body" | jq -r '.commit.tree.sha // empty') ||
  no "could not parse the PR head ${PR_HEAD:0:12}"
[ -n "$HEAD_TREE" ] || no "the PR head came back without a tree"

[ "$MAIN_TREE" = "$HEAD_TREE" ] ||
  no "the merged tree ${MAIN_TREE:0:12} differs from the tested head tree ${HEAD_TREE:0:12}"
say "the merged tree is byte-for-byte the PR head tree (${MAIN_TREE:0:12})"

# ───────────────── 5. the merge was a fast-forward, so the merge ref matched
gh "/compare/${PARENT1}...${PR_HEAD}" ||
  no "could not compare the pre-merge tip ${PARENT1:0:12} with the PR head"
MERGE_BASE=$(printf '%s' "$gh_body" | jq -r '.merge_base_commit.sha // empty') ||
  no 'could not parse the comparison'
[ "$MERGE_BASE" = "$PARENT1" ] ||
  no "the pre-merge tip ${PARENT1:0:12} is not an ancestor of the PR head — refs/pull/${PR_NUMBER}/merge carried a tree nothing here can account for"
say "the pre-merge tip ${PARENT1:0:12} is an ancestor of the head — the merge ref was a fast-forward"

# ─────────────────────────────────────── 6. the CI trust surface is untouched
#
# `/compare` caps its file list at 300. A capped list cannot answer «did this
# pull request touch .github/», so a capped list is refused rather than
# searched — the truncation is exactly where a change would hide.
truncated=$(printf '%s' "$gh_body" | jq -r '(.files // []) | length') ||
  no 'could not read the comparison file list'
[ "$truncated" -lt 300 ] ||
  no "the comparison lists ${truncated} files and is capped at 300 — cannot prove the trust surface is untouched"

trust=$(printf '%s' "$gh_body" | jq -r '
  [ (.files // [])[].filename
    | select(startswith(".github/") or startswith("tools/ci-")) ] | .[]
') || no 'could not scan the comparison for trust-surface changes'

if [ -n "$trust" ]; then
  say 'this pull request changed how CI decides things:'
  printf '%s\n' "$trust" | sed 's/^/  /'
  no 'the CI trust surface changed — main re-runs the complete suite from its own copy'
fi
say 'the CI trust surface is untouched by this pull request'

PROVEN=true
say "PASS — ${SHA:0:12} is the merge of PR #${PR_NUMBER}, whose head ${PR_HEAD:0:12} passed «${REQUIRED_JOB}» on this exact tree ${MAIN_TREE:0:12}"
finish
