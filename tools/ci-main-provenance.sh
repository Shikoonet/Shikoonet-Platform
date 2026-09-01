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
#      final head, in a run whose event was `pull_request`. A `push` run on the
#      same sha does not count: this is asking about the run that validated the
#      BRANCH, not one that validated something else.
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

# Every exit from here on goes through this. `proven` defaults to false and is
# set to true on exactly one line, at the very bottom.
PROVEN=false
finish() {
  echo "[provenance] proven=${PROVEN}"
  if [ -n "${GITHUB_OUTPUT:-}" ]; then
    printf 'proven=%s\n' "$PROVEN" >>"$GITHUB_OUTPUT"
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
[ "$count" = '1' ] ||
  no "${SHA:0:12} is claimed by ${count} merged pull request(s) into ${BRANCH}, not exactly one"

PR_NUMBER=$(printf '%s' "$matches" | jq -r '.[0].number // empty')
PR_HEAD=$(printf '%s' "$matches" | jq -r '.[0].head.sha // empty')
if [ -z "$PR_NUMBER" ] || [ -z "$PR_HEAD" ]; then
  no 'the merged PR came back without a number or a head sha'
fi
[[ $PR_HEAD =~ ^[0-9a-f]{40}$ ]] || no "PR #${PR_NUMBER} reported a malformed head sha"
say "PR #${PR_NUMBER}, final head ${PR_HEAD:0:12}"

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
for id in $ids; do
  gh "/actions/runs/${id}/jobs?per_page=100" || no "could not read the jobs of run ${id}"
  if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
    'any(.jobs[]?; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
    gate_ok=true
    say "«${REQUIRED_JOB}» succeeded on the PR head in run ${id}"
    break
  fi
done
[ "$gate_ok" = 'true' ] || no "«${REQUIRED_JOB}» did not succeed on the PR head ${PR_HEAD:0:12}"

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
