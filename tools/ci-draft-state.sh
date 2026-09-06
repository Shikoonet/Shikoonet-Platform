#!/usr/bin/env bash
#
# «Is this pull request a draft — right now?»
#
# Not `github.event.pull_request.draft`. That field is a snapshot taken when the
# event was queued, and a run created LATER can carry an OLDER snapshot.
#
# Measured on PR #67, 2026-09-02:
#
#   22:11:18Z  ready_for_review fired
#   22:11:21Z  a run was created, then cancelled
#   22:11:52Z  a run was created — thirty-four seconds after the pull request
#              stopped being a draft — and planned with IS_DRAFT=true
#
# That run skipped `integration-db` and `integration-e2e`, went green, and its
# «Required Quality Gate» sat on a Ready pull request looking like the complete
# gate had passed. The only way to see otherwise was to open the log. Issue #69
# guessed `concurrency` had eaten the ready run; the timeline says the run was
# created and the PAYLOAD was stale.
#
# Two callers, two questions:
#
#   state <repo> <pr>            what the pull request is now — `checks` plans
#                                with this instead of the payload
#   assert-fresh <planned> <repo> <pr>
#                                did the plan's assumption survive the run —
#                                the gate's last word before a green lands
#
# ── Fail-closed, in the direction that costs money rather than trust ──────────
#
# `state` answers `false` — NOT a draft, so the complete gate — when the API
# cannot be reached. The expensive answer is the safe one.
#
# `assert-fresh` does the opposite and says nothing when the API cannot be
# reached: it is a second opinion about a plan that has already been carried
# out, and a check that turns red because GitHub had a bad minute teaches people
# to re-run it without reading it.

set -Eeuo pipefail

usage() {
  echo "usage: ci-draft-state.sh state <repo> <pr>" >&2
  echo "       ci-draft-state.sh assert-fresh <planned-draft> <repo> <pr>" >&2
  exit 2
}

# The API's answer, or `false` when there isn't one. Anything that is not
# literally `true` or `false` is treated as no answer.
draft_now() { # repo  pr  -> true|false
  local repo=$1 pr=$2 out
  if ! out=$(gh api "repos/${repo}/pulls/${pr}" --jq '.draft' 2>/tmp/ci-draft.err); then
    echo "could not read the pull request:" >&2
    cat /tmp/ci-draft.err >&2
    echo unknown
    return 0
  fi
  case "$out" in
    true | false) echo "$out" ;;
    *)
      echo "the API answered '${out}', which is neither true nor false" >&2
      echo unknown
      ;;
  esac
}

case "${1:-}" in
  state)
    [ $# -eq 3 ] || usage
    now=$(draft_now "$2" "$3")
    [ "$now" = unknown ] && now=false
    echo "$now"
    ;;

  assert-fresh)
    [ $# -eq 4 ] || usage
    planned=$2
    now=$(draft_now "$3" "$4")
    if [ "$now" = unknown ]; then
      echo "not claiming the plan is stale: the pull request could not be read"
      exit 0
    fi
    if [ "$planned" = 'true' ] && [ "$now" = 'false' ]; then
      echo "STALE: planned as a draft, and the pull request is Ready now" >&2
      exit 1
    fi
    echo "fresh: planned draft=${planned}, pull request draft=${now}"
    ;;

  *) usage ;;
esac
