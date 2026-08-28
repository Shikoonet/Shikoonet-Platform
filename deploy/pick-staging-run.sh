#!/usr/bin/env bash
#
# Which staging run a promotion should take its digest from.
#
# Given a run id, it is used as given. Given nothing, the latest SUCCESSFUL
# `Deploy Staging` run for the commit `main` currently points at is chosen —
# never «the most recent run», which could be a failure, and never a run for a
# different commit.

set -Eeuo pipefail

REPO=${1:?usage: pick-staging-run.sh <owner/repo>}
: "${GH_TOKEN:?GH_TOKEN is required}"

fail() {
  echo "::error::$*"
  exit 1
}

GIVEN=${GIVEN:-}
GIVEN=${GIVEN//[[:space:]]/}

if [ -n "$GIVEN" ]; then
  [[ $GIVEN =~ ^[0-9]{1,20}$ ]] || fail "staging_run_id '${GIVEN}' is not a run id"
  RUN_ID=$GIVEN
  echo "using the staging run given: ${RUN_ID}"
else
  HEAD_SHA=$(gh api "repos/${REPO}/commits/main" --jq '.sha') ||
    fail "could not read the head of main"
  [[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || fail "main head is not a commit sha"

  RUN_ID=$(gh api "repos/${REPO}/actions/workflows/deploy-staging.yml/runs?per_page=50&status=success" \
    --jq "[.workflow_runs[] | select(.head_sha == \"${HEAD_SHA}\")] | sort_by(.run_started_at) | last | .id // empty") ||
    fail "could not list Deploy Staging runs"

  [ -n "$RUN_ID" ] ||
    fail "no successful Deploy Staging run for ${HEAD_SHA:0:12} — merge and let staging finish first, or pass a run id"
  echo "selected the latest successful staging run for ${HEAD_SHA:0:12}: ${RUN_ID}"
fi

[ -z "${GITHUB_OUTPUT:-}" ] || printf 'run_id=%s\n' "$RUN_ID" >>"$GITHUB_OUTPUT"
