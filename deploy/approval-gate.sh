#!/usr/bin/env bash
#
# «Did a human who did not write this approve it, on the tree that shipped?»
#
# Answered against the GitHub API, and answered BEFORE anything is built and
# before any deployment secret is in scope. Every exit that is not 0 means «do
# not deploy», including every way of failing to get an answer.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this exists at all
#
# On GitHub Free a private repository gets no rulesets, no required reviews and
# no required-reviewer environments. There is nothing between `git push origin
# main` and a production deploy except this file. `deploy.yml` is now the only
# path that deploys, so the guarantees a branch protection rule would have
# given have to be re-derived here, from the same API, at deploy time.
#
# The logic is lifted from `deploy/autodeploy.sh` sections 2–4 rather than
# re-invented: that script's version of these checks has thirteen tests behind
# it, each verified to fail when the guard it names is removed. What changed is
# the shape — no state files, no «wait and try again next tick», because a
# workflow run either deploys this sha now or does not — and one addition, the
# bot-reviewer exclusion, which a polling timer never needed because no bot
# reviews on that path.
#
# ─────────────────────────────────────────────────────────────────────────────
# What must be true, in order
#
#   1. the sha is the result of a MERGED pull request into the branch.
#      A direct push matches no pull request and fails here. This is the whole
#      point on a plan that cannot refuse the push itself.
#   2. that PR's FINAL head has at least one APPROVED review from a human who
#      is not its author, and that approval is the reviewer's latest.
#   3. no outstanding CHANGES_REQUESTED on that same final head, from anyone.
#   4. «Required Quality Gate» completed successfully on that exact final head.
#   5. the branch still points at the sha we were asked about.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: approval-gate.sh <owner/repo> <sha>

set -Eeuo pipefail

REPO=${1:-}
SHA=${2:-}
# Spelled as an `if` rather than `A && B || C`, which shellcheck 0.9.0 reads as
# a possible if-then-else mistake (SC2015) — the same correction ca14816 made
# for the same reason.
if [ -z "$REPO" ] || [ -z "$SHA" ]; then
  echo "usage: approval-gate.sh <owner/repo> <sha>" >&2
  exit 2
fi
echo "$SHA" | grep -qE '^[0-9a-f]{40}$' || {
  echo "refusing: '$SHA' is not a full 40-character commit sha" >&2
  exit 2
}

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
API=${GITHUB_API:-https://api.github.com}
BRANCH=${BRANCH:-main}
REQUIRED_JOB=${REQUIRED_JOB:-Required Quality Gate}

say() { echo "[gate] $*"; }
deny() {
  echo "[gate] DENIED: $*" >&2
  exit 1
}

# The token goes to curl through a config file, never on the command line:
# argv is readable by every process on the runner, and a `ps` in a parallel
# step is not a hypothetical on a shared machine.
CURLDIR=$(mktemp -d)
trap 'rm -rf "$CURLDIR"' EXIT
chmod 700 "$CURLDIR"
{
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} >"$CURLDIR/gh"
chmod 600 "$CURLDIR/gh"

gh_status=0
gh_body=''
gh() {
  local out
  out=$(curl -sS -m 30 -w '%{http_code}' -K "$CURLDIR/gh" "${API}/repos/${REPO}$1") || {
    gh_status=0
    gh_body=''
    return 1
  }
  # The status is the LAST three characters, appended by -w. Splitting on a
  # newline instead breaks on any body ending in one, which every
  # pretty-printed GitHub error does.
  gh_status=${out: -3}
  gh_body=${out:0:${#out}-3}
  [ "$gh_status" = "200" ]
}

# ─────────────────────────────────────────────────── 1. a merged pull request
#
# `/commits/:sha/pulls` is the only endpoint that answers «which pull request
# produced this commit» for all merge methods at once: for a merge commit and
# for a squash the landed commit IS `merge_commit_sha`; for a rebase it is the
# last rebased commit, which is what the branch then points at.
#
# A commit merely REFERENCED by some pull request matches neither field and is
# refused, which is what makes an unrelated open PR useless as a way in.
gh "/commits/${SHA}/pulls" ||
  deny "could not ask which PR produced ${SHA:0:12} (HTTP ${gh_status}) — failing closed"

pr=$(printf '%s' "$gh_body" | jq -c --arg sha "$SHA" --arg base "$BRANCH" '
  if type != "array" then empty else
    [ .[] | select(
        .merged_at != null
        and .base.ref == $base
        and (.merge_commit_sha == $sha or .head.sha == $sha)) ]
    | first // empty
  end') || deny "could not parse the pull request list"

[ -n "$pr" ] ||
  deny "${SHA:0:12} is not the result of a merged pull request into ${BRANCH} — a direct push does not deploy"

PR_NUMBER=$(printf '%s' "$pr" | jq -r '.number')
PR_AUTHOR=$(printf '%s' "$pr" | jq -r '.user.login // empty')
PR_HEAD=$(printf '%s' "$pr" | jq -r '.head.sha // empty')
if [ -z "$PR_AUTHOR" ] || [ -z "$PR_HEAD" ]; then
  deny "PR #${PR_NUMBER} came back without an author or a head sha"
fi
say "PR #${PR_NUMBER} by @${PR_AUTHOR}, final head ${PR_HEAD:0:12}"

# ───────────────────────────────────────── 2 & 3. approved, and not objected to
gh "/pulls/${PR_NUMBER}/reviews?per_page=100" ||
  deny "could not read the reviews on PR #${PR_NUMBER} (HTTP ${gh_status}) — failing closed"
reviews=$gh_body

# One review per reviewer — their LATEST — and it has to be APPROVED, on the
# head that shipped, by a human who is not the author.
#
# Taking the latest is what makes a superseded approval stop counting: GitHub
# keeps the old APPROVED row for ever, so `any(.state == "APPROVED")` says yes
# long after that same reviewer asked for changes.
#
# `commit_id == $head` is the staleness test: an approval given before another
# push approved a different tree, and GitHub itself calls that stale.
#
# `.user.type != "Bot"` is the addition this file makes. A review app that
# approves on green is a machine agreeing with a machine, and the guarantee
# being reconstructed here is that a PERSON looked.
#
# COMMENTED needs no exclusion — it is not APPROVED, so it never matches.
approvals=$(printf '%s' "$reviews" | jq -r --arg author "$PR_AUTHOR" --arg head "$PR_HEAD" '
  if type != "array" then 0 else
    [ .[] | select(.user.login != null and .user.login != $author and (.user.type // "User") != "Bot") ]
    | group_by(.user.login)
    | map(sort_by(.submitted_at) | last)
    | map(select(.state == "APPROVED" and .commit_id == $head))
    | length
  end') || deny "could not parse the reviews on PR #${PR_NUMBER}"

# An outstanding CHANGES_REQUESTED blocks, whoever left it.
#
# The per-reviewer `last` above already stops one person's approval surviving
# their own later objection. It does NOT stop somebody else's: A approves, B
# then reads the same tree and requests changes, and A's approval still counts.
# Deploying then ships a commit a reviewer actively objected to, which is worse
# than shipping an unreviewed one — somebody looked and said no.
#
# Bots are NOT excluded here. A machine's objection is still an objection, and
# the failure mode of honouring one too many is a deploy that waits.
changes_requested=$(printf '%s' "$reviews" | jq -r --arg head "$PR_HEAD" '
  if type != "array" then 0 else
    [ .[] | select(.user.login != null) ]
    | group_by(.user.login)
    | map(sort_by(.submitted_at) | last)
    | map(select(.state == "CHANGES_REQUESTED" and .commit_id == $head))
    | length
  end') || deny "could not parse the reviews on PR #${PR_NUMBER}"

[ "${changes_requested:-0}" -eq 0 ] ||
  deny "PR #${PR_NUMBER} has ${changes_requested} outstanding CHANGES_REQUESTED on its final head"

[ "${approvals:-0}" -ge 1 ] ||
  deny "PR #${PR_NUMBER} has no current APPROVED review from a human other than @${PR_AUTHOR}"

say "approved by ${approvals} human reviewer(s) other than the author"

# ──────────────────────────────── 4. the required job, on the exact final head
#
# `/actions/runs?head_sha=` and then the run's jobs, rather than
# `/commits/:sha/check-runs`: GitHub does not offer Checks in the fine-grained
# token scopes this workflow can hold, and the name being matched — «Required
# Quality Gate» — is a JOB inside the «CI» workflow, not a workflow itself.
#
# Asked about the PR's FINAL HEAD, which is the tree the reviewer approved.
gh "/actions/runs?head_sha=${PR_HEAD}&per_page=100" ||
  deny "could not list the runs on ${PR_HEAD:0:12} (HTTP ${gh_status}) — failing closed"

run_ids=$(printf '%s' "$gh_body" | jq -r '.workflow_runs[]?.id // empty') ||
  deny "could not parse the run list for ${PR_HEAD:0:12}"
[ -n "$run_ids" ] ||
  deny "no workflow run at all on the final head ${PR_HEAD:0:12}"

gate_ok=0
for run_id in $run_ids; do
  gh "/actions/runs/${run_id}/jobs?per_page=100" ||
    deny "could not read the jobs of run ${run_id} (HTTP ${gh_status}) — failing closed"
  if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
    'any(.jobs[]?; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
    gate_ok=1
    break
  fi
done
[ "$gate_ok" -eq 1 ] ||
  deny "«${REQUIRED_JOB}» did not succeed on the final head ${PR_HEAD:0:12}"

say "«${REQUIRED_JOB}» succeeded on ${PR_HEAD:0:12}"

# ────────────────────────────────────────────────────────── 5. the branch race
#
# Everything above describes a sha that may already be history: the API calls
# take seconds and a person can merge twice in that window. Deploying then
# would build whatever the branch NOW is while reporting the sha that passed —
# a log that names a commit which is not what went out, which is worse than no
# log because it looks like an audit trail.
gh "/commits/${BRANCH}" ||
  deny "could not re-read ${BRANCH} (HTTP ${gh_status}) — failing closed"
head_now=$(printf '%s' "$gh_body" | jq -r '.sha // empty')
[ -n "$head_now" ] || deny "GitHub returned no sha for ${BRANCH}"
[ "$head_now" = "$SHA" ] ||
  deny "${BRANCH} moved ${SHA:0:12} → ${head_now:0:12} while this was being evaluated — the new head gets its own run"

say "${BRANCH} is still at ${SHA:0:12}"
say "PASS — PR #${PR_NUMBER}, ${approvals} human approval(s), quality gate green, branch unmoved"

# The only thing written to stdout in a machine-readable shape, so the workflow
# can put the PR number in a summary without re-asking GitHub.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'pr_number=%s\n' "$PR_NUMBER"
    printf 'pr_head=%s\n' "$PR_HEAD"
    printf 'approvals=%s\n' "$approvals"
  } >>"$GITHUB_OUTPUT"
fi
