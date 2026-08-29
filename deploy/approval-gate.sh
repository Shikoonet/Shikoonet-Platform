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
# main` and a production deploy except this file. `deploy-staging.yml` is the only
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
# Two modes, and why the second one exists
#
# `team` is the original policy: somebody who did not write it approved it.
#
# `solo` exists because the original policy became unsatisfiable. This shop has
# one person with repository access, so «a human other than the author» is a
# condition nobody can ever meet, and the gate denied four merges in a row —
# correctly, and uselessly. The tempting fix was to accept any merged PR, which
# would have deleted the provenance chain entirely.
#
# So solo mode does not remove the requirement, it REPLACES it with the
# narrowest thing that is actually checkable for one person: the named owner
# wrote it, the named owner merged it, and CI passed on both the tree they
# pushed and the tree that will be built. No approval is invented, and the audit
# line says «solo-owner» rather than claiming a review happened.
#
# ─────────────────────────────────────────────────────────────────────────────
# What must be true, in order
#
#   1. the sha is the result of a MERGED pull request into the branch, and of
#      exactly ONE — a direct push matches none and fails here, and an
#      ambiguous association has no reviewable answer so it fails too. This is
#      the whole point on a plan that cannot refuse the push itself.
#   2. no outstanding CHANGES_REQUESTED on the final head, from anyone, in
#      either mode: somebody having looked and said no outranks any policy
#      about who may ship.
#   3. team — that PR's FINAL head has at least one APPROVED review from a
#      human who is not its author, and that approval is the reviewer's latest.
#      solo — the PR was written AND merged by the allowlisted owner.
#   4. «Required Quality Gate» completed successfully on that exact final head,
#      and in solo mode on the merge commit too, which on a squash or rebase is
#      a tree that has never existed before and that nobody has reviewed.
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
if ! [[ $SHA =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing: '$SHA' is not a full 40-character commit sha" >&2
  exit 2
fi

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
API=${GITHUB_API:-https://api.github.com}
BRANCH=${BRANCH:-main}
REQUIRED_JOB=${REQUIRED_JOB:-Required Quality Gate}

# ─────────────────────────────────────────────────────────── the approval mode
#
# `team`              — a human who did not write it approved it. The original
#                       policy. It refuses the owner's own solo work, which is
#                       most of this repository's history.
# `solo`              — one named owner writes, merges and ships their own work,
#                       and the audit trail says so in those words instead of
#                       pretending somebody reviewed it. It refuses EVERY
#                       contributor PR, however well reviewed, because the
#                       author check below has no approved branch to fall to.
# `owner-or-approved` — the union, and the live policy. The owner may ship their
#                       own work unreviewed; anybody else needs a real human
#                       approval on the final head from someone who is not the
#                       author, and the owner still has to be the one who merged
#                       it. Nothing is relaxed: CHANGES_REQUESTED, staleness and
#                       the Quality Gate apply to both halves identically.
#
# There is no default. An unset, empty or misspelled mode DENIES rather than
# picking one, because both of the tempting defaults are wrong: defaulting to
# `team` turns a typo into a deploy that never runs, and defaulting to `solo`
# turns a typo into a deploy nobody reviewed. The mode is set in
# `deploy-staging.yml`, which is versioned and reviewed, so «unset» means
# somebody deleted it.
#
# Matched against the exact lowercase string. `SOLO` and `Solo` are not solo —
# they are unknown, and unknown denies.
MODE=${DEPLOY_APPROVAL_MODE:-}
case "$MODE" in
  team | solo | owner-or-approved) ;;
  *)
    echo "[gate] DENIED: DEPLOY_APPROVAL_MODE is «${MODE:-unset}» — it must be exactly 'team', 'solo' or 'owner-or-approved'" >&2
    exit 1
    ;;
esac

# Who the owner is. Versioned beside the mode, so changing who may ship their
# own work is a reviewed diff rather than a setting somebody flipped.
#
# Required by `owner-or-approved` as well as `solo`: without it, the merged-by
# assertion that both modes rely on has nothing to compare against, and an
# empty comparison would pass.
# One name or several. `DEPLOY_OWNERS` is a comma-separated list of the people
# trusted to ship their own work; `SOLO_DEPLOY_OWNER` remains accepted as the
# single-name spelling so an older workflow keeps working unchanged.
#
# A list rather than a name because a two-person team cannot satisfy "approved
# by somebody other than the author" without the other person being the owner —
# so every contributor PR needed the owner twice, to review and to merge. Naming
# the second maintainer here says the quiet part out loud: they may ship
# unreviewed, exactly as the first one may.
DEPLOY_OWNERS_RAW=${DEPLOY_OWNERS:-${SOLO_DEPLOY_OWNER:-}}
if [ "$MODE" != 'team' ] && [ -z "$DEPLOY_OWNERS_RAW" ]; then
  echo "[gate] DENIED: ${MODE} mode needs DEPLOY_OWNERS (or SOLO_DEPLOY_OWNER) — refusing to let anyone ship unreviewed" >&2
  exit 1
fi

# Exact match on a whole element, never a substring.
#
# `case "$list" in *"$who"*)` would let @Isusami2 satisfy a list naming
# @Isusami, and an empty `$who` would match every list there is. Both are
# refused: the login must equal one comma-separated element with nothing left
# over, and an empty login matches nothing.
is_owner() { # login
  local who=$1 rest=${DEPLOY_OWNERS_RAW} item
  [ -n "$who" ] || return 1
  while [ -n "$rest" ]; do
    item=${rest%%,*}
    if [ "$item" = "$rest" ]; then rest=''; else rest=${rest#*,}; fi
    # tolerate spaces around a comma, refuse an empty element
    item=$(printf '%s' "$item" | tr -d '[:space:]')
    [ -n "$item" ] || continue
    [ "$item" != "$who" ] || return 0
  done
  return 1
}

# For the refusals that name who may ship, so a denied contributor is told the
# actual list rather than "the owner".
OWNERS_DISPLAY=$(printf '%s' "$DEPLOY_OWNERS_RAW" | tr -d '[:space:]' | sed 's/,/, @/g')

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

matches=$(printf '%s' "$gh_body" | jq -c --arg sha "$SHA" --arg base "$BRANCH" '
  if type != "array" then [] else
    [ .[] | select(
        .merged_at != null
        and .base.ref == $base
        and (.merge_commit_sha == $sha or .head.sha == $sha)) ]
  end') || deny "could not parse the pull request list"

count=$(printf '%s' "$matches" | jq -r 'length') || deny "could not count the matching pull requests"

[ "$count" != '0' ] ||
  deny "${SHA:0:12} is not the result of a merged pull request into ${BRANCH} — a direct push does not deploy"

# More than one merged PR claiming this commit means «which PR was reviewed» has
# no answer, and picking the first would make the audit line a coin toss. There
# is no safe way to guess, so it denies.
[ "$count" = '1' ] ||
  deny "${SHA:0:12} is claimed by ${count} merged pull requests — the provenance is ambiguous"

pr=$(printf '%s' "$matches" | jq -c '.[0]')

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

# ─────────────────────────────────────────────── the half that differs by mode
#
# The CHANGES_REQUESTED check above applies to both: somebody having looked and
# said no outranks any policy about who may ship.
# Merged BY, as well as written by. The author field alone would let anybody
# with write access merge the owner's branch and ship it under the owner's
# name — which is the whole hole a review would otherwise have covered.
# `/commits/:sha/pulls` does not carry `merged_by`, so the PR is read whole.
#
# Asked by every mode that names an owner, on BOTH of its branches. A
# contributor PR with a perfect review still has to have been merged by the
# owner: an approval says the tree was read, not that shipping it was intended.
require_merged_by_owner() {
  gh "/pulls/${PR_NUMBER}" ||
    deny "could not read PR #${PR_NUMBER} to find who merged it (HTTP ${gh_status}) — failing closed"
  MERGED_BY=$(printf '%s' "$gh_body" | jq -r '.merged_by.login // empty') ||
    deny "could not parse PR #${PR_NUMBER}"
  [ -n "$MERGED_BY" ] ||
    deny "PR #${PR_NUMBER} reports nobody as its merger — failing closed"
  is_owner "$MERGED_BY" ||
    deny "PR #${PR_NUMBER} was merged by @${MERGED_BY}, who is not among the deploy owners (@${OWNERS_DISPLAY})"
}

# The owner's half. No approval is required and none is invented: `approvals`
# is reported as it actually is, which on a self-merged PR is zero.
ship_as_owner() {
  require_merged_by_owner
  POLICY='solo-owner'
  say "solo-owner policy: @${PR_AUTHOR} wrote PR #${PR_NUMBER} and @${MERGED_BY} merged it, both deploy owners; no human review was required or claimed"
}

# The reviewed half. `approvals` was already computed to exclude the author and
# every Bot, and to require `commit_id == final head` — so a self-approval and
# a stale approval are both already zero by the time control arrives here.
ship_as_approved() {
  [ "${approvals:-0}" -ge 1 ] ||
    deny "PR #${PR_NUMBER} has no current APPROVED review from a human other than @${PR_AUTHOR}"
  POLICY='team-approved'
  say "approved by ${approvals} human reviewer(s) other than the author"
}

case "$MODE" in
  team)
    ship_as_approved
    ;;
  solo)
    # What replaces the review is a narrower question — was this the one person
    # allowed to ship their own work, at both ends of the pull request.
    is_owner "$PR_AUTHOR" ||
      deny "solo mode allows only the deploy owners (@${OWNERS_DISPLAY}) to ship unreviewed; PR #${PR_NUMBER} was written by @${PR_AUTHOR}"
    ship_as_owner
    ;;
  owner-or-approved)
    # The author decides WHICH question is asked, never WHETHER one is.
    #
    # This is the line that unblocks contributor work. Under `solo` the author
    # check denied before the merged-by check was ever read, so a contributor
    # PR could not ship however it was reviewed — no approval, no merger, no
    # amount of green rescued it. Here the same PR falls to the approved
    # branch instead of falling off the end.
    if is_owner "$PR_AUTHOR"; then
      ship_as_owner
    else
      ship_as_approved
      # Reviewed is not sufficient on its own: the owner still merged it.
      require_merged_by_owner
      say "owner-or-approved: PR #${PR_NUMBER} by @${PR_AUTHOR} was approved on its final head and merged by @${MERGED_BY}"
    fi
    ;;
esac

# ──────────────────────────────────────── 4. the required job, on which shas
#
# `/actions/runs?head_sha=` and then the run's jobs, rather than
# `/commits/:sha/check-runs`: GitHub does not offer Checks in the fine-grained
# token scopes this workflow can hold, and the name being matched — «Required
# Quality Gate» — is a JOB inside the «CI» workflow, not a workflow itself.
#
# One function, asked twice, because the two questions are genuinely different
# commits: the FINAL HEAD is the tree somebody reviewed (or, in solo mode, the
# tree the owner last pushed), and the MERGE SHA is the tree that will actually
# be built. They differ whenever main moved under the branch, and a squash or
# rebase merge produces a commit that has never been tested as such.
require_gate_on() { # sha  description
  local sha=$1 what=$2 ids id
  gh "/actions/runs?head_sha=${sha}&per_page=100" ||
    deny "could not list the runs on ${what} ${sha:0:12} (HTTP ${gh_status}) — failing closed"

  ids=$(printf '%s' "$gh_body" | jq -r '.workflow_runs[]?.id // empty') ||
    deny "could not parse the run list for ${what} ${sha:0:12}"
  [ -n "$ids" ] ||
    deny "no workflow run at all on ${what} ${sha:0:12}"

  for id in $ids; do
    gh "/actions/runs/${id}/jobs?per_page=100" ||
      deny "could not read the jobs of run ${id} (HTTP ${gh_status}) — failing closed"
    if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
      'any(.jobs[]?; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
      say "«${REQUIRED_JOB}» succeeded on ${what} ${sha:0:12}"
      return 0
    fi
  done
  deny "«${REQUIRED_JOB}» did not succeed on ${what} ${sha:0:12}"
}

require_gate_on "$PR_HEAD" 'the final head'

# The commit that will be BUILT, which on a squash or rebase merge is a tree
# that has never existed before. In team mode a reviewer looked at the branch;
# nobody looked at this. In the owner-merged modes nobody looked at either, so
# the one thing standing between a bad merge and a deploy is that CI passed on
# the exact artifact being shipped.
#
# Asked in `owner-or-approved` on BOTH of its branches, not only the owner one.
# A contributor's approval was given on the final head; the merge commit is a
# different tree, and «somebody approved a tree that is not this one» is exactly
# the gap this check exists to close.
if [ "$MODE" != 'team' ] && [ "$SHA" != "$PR_HEAD" ]; then
  require_gate_on "$SHA" 'the merge commit'
fi

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

# The audit line. It names the POLICY, not just the outcome, because the two
# are answers to different questions and the difference is the whole point of
# this file: «team-approved» means a person other than the author read it, and
# «solo-owner» means nobody did and the shop accepted that on purpose. A log
# that said only «PASS» would make those indistinguishable a month later.
if [ "$POLICY" = 'team-approved' ]; then
  say "PASS [policy=team-approved] — PR #${PR_NUMBER}, ${approvals} human approval(s) other than @${PR_AUTHOR}, quality gate green, branch unmoved"
else
  say "PASS [policy=solo-owner] — PR #${PR_NUMBER} written by @${PR_AUTHOR} and merged by @${MERGED_BY}, both deploy owners, NOT reviewed by anyone else, quality gate green on the final head and on the merge commit, branch unmoved"
fi

# Machine-readable, so the workflow can put this in a step summary and hand the
# policy down to the deploy script without re-asking GitHub.
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'pr_number=%s\n' "$PR_NUMBER"
    printf 'pr_head=%s\n' "$PR_HEAD"
    printf 'approvals=%s\n' "$approvals"
    printf 'policy=%s\n' "$POLICY"
  } >>"$GITHUB_OUTPUT"
fi
