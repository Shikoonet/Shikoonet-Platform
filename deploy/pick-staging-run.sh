#!/usr/bin/env bash
#
# Which staging run a promotion takes its digest from — and whether that run is
# allowed to be the source at all.
#
# Given a run id, it is used AND VERIFIED. Given nothing, the latest successful
# `Deploy Staging` run for the commit `main` currently points at is chosen.
# Either way the same checks apply, because a run id typed into a dispatch form
# is exactly the input that must not be trusted: it names a run in this
# repository, but nothing about it is otherwise guaranteed.
#
# ## What is checked, and why each one matters
#
#   · the run belongs to `deploy-staging.yml`     — another workflow can upload
#     an artifact called `staging-digest` containing anything at all
#   · status is `completed`                       — an in-flight run's artifact
#     is a half-written record
#   · conclusion is `success`                     — a failed staging deploy
#     proves the opposite of what promotion needs
#   · the trigger is one of the ways this workflow actually starts — for
#     `deploy-staging.yml` that is `workflow_run` (after CI) or
#     `workflow_dispatch` (the no-input manual redeploy). Anything else was
#     hand-made. The dispatch path is NOT a weaker source: it resolves the sha
#     from the ref on the server, requires a green CI push run for it, and goes
#     through the same approval gate — see the header of `require-ci-run.sh`.
#   · head_branch is `main`                       — a run for a branch never
#     deployed staging
#
# The manifest cross-checks — that this run's head_sha matches the manifest and
# that the manifest names this run — happen in `verify-release-manifest.sh`,
# which is where both values are in scope.

set -Eeuo pipefail

REPO=${1:?usage: pick-staging-run.sh <owner/repo>}
: "${GH_TOKEN:?GH_TOKEN is required}"

# Overridable so `Cutover Production` can select its own upstream run — a
# successful `Prepare Production` — through the same verified path rather than
# a near-copy of this file that would drift from it.
WORKFLOW_FILE=${WORKFLOW_FILE:-deploy-staging.yml}
ALLOWED_EVENTS=${ALLOWED_EVENTS:-workflow_run workflow_dispatch}
LABEL=${LABEL:-Deploy Staging}

fail() {
  echo "::error::$*"
  exit 1
}

# The raw input, validated whole-string.
#
# It used to have whitespace STRIPPED first, which quietly turned «12 34» into
# «1234» — a different run, accepted without comment. Malformed input must be
# refused as malformed, not repaired into something plausible.
GIVEN=${GIVEN:-}

if [ -n "$GIVEN" ]; then
  [[ $GIVEN =~ ^[0-9]{1,20}$ ]] || fail "run id '${GIVEN}' is not a run id"
  RUN_ID=$GIVEN
  echo "${LABEL} run given: ${RUN_ID}"
else
  HEAD_SHA=$(gh api "repos/${REPO}/commits/main" --jq '.sha') ||
    fail "could not read the head of main"
  [[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || fail "main head is not a commit sha"

  RUN_ID=$(gh api "repos/${REPO}/actions/workflows/${WORKFLOW_FILE}/runs?per_page=50&status=success" \
    --jq "[.workflow_runs[] | select(.head_sha == \"${HEAD_SHA}\")] | sort_by(.run_started_at) | last | .id // empty") ||
    fail "could not list ${LABEL} runs"

  [ -n "$RUN_ID" ] ||
    fail "no successful ${LABEL} run for ${HEAD_SHA:0:12} — let it finish, or pass a run id"
  echo "selected the latest successful ${LABEL} run for ${HEAD_SHA:0:12}: ${RUN_ID}"
fi

# Verified against the API whether it was chosen or given. A run id is an
# integer somebody can type; everything below is what makes it evidence.
RUN_JSON=$(gh api "repos/${REPO}/actions/runs/${RUN_ID}") ||
  fail "run ${RUN_ID} does not exist in ${REPO}"

field() { printf '%s' "$RUN_JSON" | python3 -c 'import json,sys; print(json.load(sys.stdin).get(sys.argv[1]) or "")' "$1"; }

RUN_PATH=$(field path)
RUN_STATUS=$(field status)
RUN_CONCLUSION=$(field conclusion)
RUN_EVENT=$(field event)
RUN_BRANCH=$(field head_branch)
RUN_HEAD_SHA=$(field head_sha)

[ "$RUN_PATH" = ".github/workflows/${WORKFLOW_FILE}" ] ||
  fail "run ${RUN_ID} belongs to '${RUN_PATH:-unknown}', not ${WORKFLOW_FILE} — its artifact is not a staging release"
[ "$RUN_STATUS" = 'completed' ] ||
  fail "run ${RUN_ID} is '${RUN_STATUS:-unknown}', not completed — its artifact is a half-written record"
[ "$RUN_CONCLUSION" = 'success' ] ||
  fail "run ${RUN_ID} concluded '${RUN_CONCLUSION:-unknown}', not success — staging did not pass"
event_allowed=false
for e in $ALLOWED_EVENTS; do
  [ "$RUN_EVENT" = "$e" ] && event_allowed=true
done
[ "$event_allowed" = 'true' ] ||
  fail "run ${RUN_ID} was triggered by '${RUN_EVENT:-unknown}', not one of: ${ALLOWED_EVENTS} — real ${LABEL} runs start no other way"
[ "$RUN_BRANCH" = 'main' ] ||
  fail "run ${RUN_ID} is for branch '${RUN_BRANCH:-unknown}', not main"
[[ $RUN_HEAD_SHA =~ ^[0-9a-f]{40}$ ]] ||
  fail "run ${RUN_ID} reports no usable head sha"

echo "run ${RUN_ID} verified: ${WORKFLOW_FILE}, completed/success, ${RUN_EVENT} on main, head ${RUN_HEAD_SHA:0:12}"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'run_id=%s\n' "$RUN_ID"
    printf 'head_sha=%s\n' "$RUN_HEAD_SHA"
  } >>"$GITHUB_OUTPUT"
fi
