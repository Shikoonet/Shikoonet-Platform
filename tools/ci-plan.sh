#!/usr/bin/env bash
#
# «Which jobs does this event actually need?»
#
# One pure function of three inputs, so it can be tested without a runner —
# see `tools/test/ci-plan.test.sh`, which is what stops this file from being
# the place a skipped suite hides.
#
# ─────────────────────────────────────────────────────────────────────────────
# The one rule
#
# UNKNOWN RUNS EVERYTHING. Every branch that cannot prove a path is safe to
# skip falls through to the complete suite: an empty file list, a truncated
# one, an event this file does not recognise, a path that matches no rule.
# There is no branch that skips because it ran out of ideas, which is the only
# way a selector like this stays honest as the repository grows paths it was
# never told about.
#
# ─────────────────────────────────────────────────────────────────────────────
# The three outputs, and what each one buys
#
#   static=        typecheck, eslint, architecture boundaries, gitleaks,
#                  actionlint, shellcheck. ~150s in ONE job. Never skipped on
#                  a pull request — it is the whole of Fast Feedback, and it
#                  is cheap enough that selecting it would save nothing worth
#                  the risk of being wrong.
#
#   heavy=         unit, db-shard ×2, migrations, e2e. ~14 billed minutes.
#                  This is what a draft PR does not pay for, and what a
#                  docs-only PR does not pay for.
#
#   deploy_suites= the 22 bash suites over `deploy/`. ~3 billed minutes.
#                  They read `deploy/`, `.github/workflows/` and the migrator,
#                  and nothing else — so a pull request touching none of those
#                  cannot change their result. That is the ONLY change-aware
#                  selection this file does over test code, and it is the only
#                  one where the read-surface is small enough to be checked by
#                  reading it.
#
# The vitest suites, the database shards, the migration rehearsal and the
# browser walk are NOT selected. They either all run or none of them does, and
# `.github/ci-baseline.json` still demands every one of them report. Selecting
# them by dependency graph was considered and declined: it would mean teaching
# `tools/ci-verify-gate.ts` which suites were deliberately absent, and a
# verifier that accepts an absence is a verifier that accepts the wrong one.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run:  EVENT=… IS_DRAFT=… CHANGED_FILES=… ci-plan.sh
#
#   EVENT          the GitHub event name
#   IS_DRAFT       'true' when the pull request is a draft
#   CHANGED_FILES  newline-separated paths, or the literal string UNKNOWN when
#                  the diff could not be established (API failure, truncation,
#                  a pull request larger than one page of files)

set -Eeuo pipefail

EVENT=${EVENT:-}
IS_DRAFT=${IS_DRAFT:-false}
CHANGED_FILES=${CHANGED_FILES:-UNKNOWN}

# ────────────────────────────────────────────────────────── the docs allowlist
#
# An ALLOWLIST, not a deny-list. A path is documentation only if it matches one
# of these; everything else — including a path nobody has thought of yet — is
# code. Written this way round on purpose: a deny-list that forgets a pattern
# silently downgrades a real change to docs-only, and the failure is invisible.
is_docs() { # path
  case "$1" in
    docs/*) return 0 ;;
    *.md) return 0 ;;
    LICENSE | .gitignore | .editorconfig | .gitattributes) return 0 ;;
    graphify-out/*) return 0 ;;
    .coderabbit.yaml) return 0 ;;
    *) return 1 ;;
  esac
}

# ─────────────────────────────────────────── what the deploy bash suites read
#
# A deliberate SUPERSET of their actual read-surface. The suites read `deploy/`
# and `.github/workflows/*.yml`; `d1-contract.test.sh` also regenerates the
# table manifest from `packages/migrate`'s source.
#
# Everything else named here — every shared package, the lockfile, the
# workspace file, `tools/`, `migrations/`, `sim/`, the Dockerfile — is on the
# list because those are the paths that must force the complete suite whatever
# else is true. The whole of `packages/` is here rather than `packages/migrate`
# alone: the first draft of this file named only the migrator, and
# `tools/test/ci-plan.test.sh` caught it — `packages/db` is database code and
# `packages/domain` is a shared package, and both are on the brief's
# must-run-everything list whether or not a bash suite happens to read them.
#
# What is left OUT, and is the whole of what this selection buys: `apps/` and
# documentation. A change confined to those two cannot alter what a deploy
# script does. The cost of being wrong in this direction is three billed
# minutes; the cost of being wrong in the other is a deploy script that
# changed with nothing checking it.
touches_deploy_surface() { # path
  case "$1" in
    deploy/* | .github/*) return 0 ;;
    tools/* | migrations/* | sim/*) return 0 ;;
    packages/*) return 0 ;;
    Dockerfile | .dockerignore) return 0 ;;
    pnpm-lock.yaml | pnpm-workspace.yaml | package.json) return 0 ;;
    *) return 1 ;;
  esac
}

emit() { # static heavy deploy_suites mode reason
  printf 'static=%s\n' "$1"
  printf 'heavy=%s\n' "$2"
  printf 'deploy_suites=%s\n' "$3"
  printf 'mode=%s\n' "$4"
  printf 'reason=%s\n' "$5"
}

# ───────────────────────────────────────────────────────────────── the events
#
# `merge_group` and `workflow_dispatch` get the complete suite unconditionally.
# A merge queue is validating a tree nobody has seen, and a dispatch is
# somebody asking for a run on purpose — neither is a place to economise.
case "$EVENT" in
  pull_request) ;;
  merge_group | workflow_dispatch | push)
    emit true true true full "event ${EVENT} always runs the complete suite"
    exit 0
    ;;
  *)
    emit true true true full "unrecognised event «${EVENT}» — running everything"
    exit 0
    ;;
esac

# ────────────────────────────────────────────────────────── A. the draft path
#
# Fast Feedback and nothing else. The full gate arrives when the pull request
# is marked Ready for Review, which fires `ready_for_review` and re-enters this
# file with IS_DRAFT=false.
#
# Matched against the exact lowercase string, the same way `approval-gate.sh`
# matches its mode: 'TRUE' and 'True' are not 'true', and anything that is not
# exactly 'true' is treated as not-a-draft — which runs MORE, not less.
if [ "$IS_DRAFT" = 'true' ]; then
  emit true false false fast 'draft pull request — fast feedback only'
  exit 0
fi

# ─────────────────────────────────────────────── B. the ready-for-review path
if [ "$CHANGED_FILES" = 'UNKNOWN' ]; then
  emit true true true full 'the changed-file list could not be established — running everything'
  exit 0
fi

if [ -z "${CHANGED_FILES//[[:space:]]/}" ]; then
  emit true true true full 'no changed files were reported — running everything'
  exit 0
fi

docs_only=true
deploy=false
files=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  files=$((files + 1))
  is_docs "$path" || docs_only=false
  if touches_deploy_surface "$path"; then deploy=true; fi
done <<<"$CHANGED_FILES"

if [ "$files" -eq 0 ]; then
  emit true true true full 'no changed files were reported — running everything'
  exit 0
fi

if [ "$docs_only" = 'true' ]; then
  # `deploy_suites` is false here BECAUSE the docs allowlist and the deploy
  # surface are disjoint by construction: nothing that matches `is_docs` can
  # also match `touches_deploy_surface`. The test suite asserts that, so the
  # two lists cannot drift into an overlap where a docs-only verdict silently
  # skips a deploy script that changed.
  emit true false false docs "all ${files} changed path(s) are documentation"
  exit 0
fi

emit true true "$deploy" full "${files} changed path(s), deploy surface touched: ${deploy}"
