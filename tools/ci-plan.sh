#!/usr/bin/env bash
#
# «Which suites does this event actually need?»
#
# One pure function of four inputs, so it can be tested without a runner —
# see `tools/test/ci-plan.test.sh`, which is what stops this file from being
# the place a skipped suite hides.
#
# ─────────────────────────────────────────────────────────────────────────────
# The one rule
#
# UNKNOWN RUNS EVERYTHING. Every branch that cannot prove a suite is safe to
# skip falls through to the complete gate: an empty file list, a truncated
# one, an event this file does not recognise, a path that matches no rule.
# There is no branch that skips because it ran out of ideas, which is the only
# way a selector like this stays honest as the repository grows paths it was
# never told about.
#
# ─────────────────────────────────────────────────────────────────────────────
# The outputs, and which job each one steers
#
#   static=         typecheck, eslint, architecture boundaries, gitleaks,
#                   actionlint, shellcheck. Runs inside `checks`. Never skipped
#                   on a pull request — it is the whole of Fast mode, and it is
#                   cheap enough that selecting it would save nothing worth the
#                   risk of being wrong.
#
#   unit=           the three suites that need no database — contracts,
#                   sms-parser, admin-web. Also inside `checks`, ~49s.
#
#   db=             the `integration-db` job: both database shards, the
#                   migration rehearsal, the money invariants and the image
#                   checks. ~5 billed minutes.
#
#   e2e=            the browser walk, inside `integration-e2e`.
#
#   deploy_suites=  the 22 bash suites over `deploy/`, also inside
#                   `integration-e2e`. The job runs when EITHER is true.
#
#   image=          the deployable-artifact checks. A `main` job only.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why selection is safe HERE and was not safe before
#
# The 2026-09-01 shape ran every suite on every ready pull request, and said so
# out loud: selecting them «would mean teaching ci-verify-gate.ts which suites
# were deliberately absent, and a verifier that accepts an absence is a verifier
# that can be talked into accepting the wrong one».
#
# That objection is answered, not ignored. Three things carry it:
#
#   1. `ci-verify-gate.ts` is not taught to ACCEPT an absence. It is handed this
#      file's published expectation and requires the reported set to equal it
#      EXACTLY — a suite that reported when the plan said it would not is as red
#      as one that is missing. An absence is only ever tolerated when the plan
#      said so before the suites ran.
#
#   2. `tools/ci-main-provenance.sh` re-derives this same expectation from
#      GitHub's own file list and `main`'s own copy of this script, and requires
#      the pull request run to have satisfied it. It never reads the plan the
#      branch published.
#
#   3. Condition 6 of that proof already refuses to believe any pull request
#      that touched `.github/`, `tools/ci-*` or the baseline. So a branch cannot
#      weaken this file, get itself green, and have `main` believe it: any
#      change to this file forces the complete suite on `main` from main's own
#      trusted copy.
#
# ─────────────────────────────────────────────────────────────────────────────
# What may be selected away, and what may never be
#
# ONLY `apps/` and documentation. Everything else — every shared package, the
# lockfile, the workspace file, `tools/`, `deploy/`, `.github/`, `migrations/`,
# `sim/`, the Dockerfile, any `package.json`, and every path nobody has thought
# of yet — runs the complete gate.
#
# That is deliberately blunt. The brief's must-always-run list is: the lockfile,
# workspace configuration, shared contracts, database adapters, domain logic,
# migrations, authentication, money/wallet/order/payment logic, SMS parsing,
# bot singleton behaviour, deployment scripts, workflows, CI classification and
# test infrastructure. Every one of those lives outside `apps/`, so «not an app
# and not documentation ⇒ everything» covers the whole list by construction
# rather than by a pattern list somebody has to keep in step with it.
#
# ─────────────────────────────────────────────────────────────────────────────
# The app map, and the reverse dependency that makes it non-obvious
#
#   apps/admin-web        → unit, e2e
#   apps/dashboard-worker → db,   e2e
#   apps/bot              → db
#   apps/ingest-worker    → db
#
# `apps/admin-web` owns a vitest suite that needs no database (`unit`) and IS
# the single-page app the browser walk drives (`e2e`).
#
# `apps/dashboard-worker` owns the `db:hub` suite and serves the SPA at
# `/admin`, so it needs both. And `apps/ingest-worker` DEPENDS ON IT
# (`@shikoo/dashboard` is in its dependencies) — a reverse edge that directory
# matching alone would miss. It costs nothing here because ingest's suite is in
# the same `integration-db` job, but «it happens to work out» is not a thing to
# leave unchecked: `tools/test/ci-suite-map.test.sh` recomputes the closure from
# the workspace's own package.json files and fails if this table ever stops
# covering it.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run:  EVENT=… IS_DRAFT=… CHANGED_FILES=… [PROVEN=… ASSOCIATION=…] ci-plan.sh
#
#   EVENT          the GitHub event name
#   IS_DRAFT       'true' when the pull request is a draft
#   CHANGED_FILES  newline-separated paths, or the literal string UNKNOWN when
#                  the diff could not be established (API failure, truncation,
#                  a pull request larger than one page of files)
#   PROVEN         push only: 'true' when ci-main-provenance.sh proved the tree
#   ASSOCIATION    push only: 'none' when GitHub answered and NO merged pull
#                  request claims the sha — a direct push

set -Eeuo pipefail

EVENT=${EVENT:-}
IS_DRAFT=${IS_DRAFT:-false}
CHANGED_FILES=${CHANGED_FILES:-UNKNOWN}
PROVEN=${PROVEN:-false}
ASSOCIATION=${ASSOCIATION:-unknown}

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

emit() { # static unit db e2e deploy_suites image mode reason
  printf 'static=%s\n' "$1"
  printf 'unit=%s\n' "$2"
  printf 'db=%s\n' "$3"
  printf 'e2e=%s\n' "$4"
  printf 'deploy_suites=%s\n' "$5"
  printf 'image=%s\n' "$6"
  printf 'mode=%s\n' "$7"
  printf 'reason=%s\n' "$8"
}

everything() { # mode reason  — the only shape that runs the complete gate
  emit true true true true true "$1" "$2" "$3"
}

# ───────────────────────────────────────────────────────────────── the events
#
# `merge_group` and `workflow_dispatch` get the complete suite unconditionally.
# A merge queue is validating a tree nobody has seen, and a dispatch is
# somebody asking for a run on purpose — neither is a place to economise.
case "$EVENT" in
  pull_request) ;;

  push)
    # ── `main`. Three answers, and only one of them is cheap by choice.
    if [ "$PROVEN" = 'true' ]; then
      # The tree already passed the complete gate as a pull request. `image`
      # still runs: a docker build is the one thing here that is not hermetic,
      # and this is the commit Deploy Staging is about to build for real.
      emit false false false false false true main-proven \
        'the complete gate already passed on this exact tree'
      exit 0
    fi
    if [ "$ASSOCIATION" = 'none' ]; then
      # A DIRECT PUSH. `deploy/approval-gate.sh` condition 1 already refuses to
      # deploy any sha that is not exactly one merged pull request — «a direct
      # push matches none and fails here» — so this commit cannot reach
      # staging or production whatever this workflow does.
      #
      # Running the complete suite on it therefore buys a green tick on a
      # commit that is already forbidden to ship. The gate reports BLOCKED
      # instead, which is a failure: `deploy-staging.yml` starts only on
      # `workflow_run.conclusion == 'success'`, so a blocked verdict is a
      # second refusal on top of the gate's, never a way past it.
      #
      # The cost is that a direct push's breakage is not measured until the
      # next pull request builds on it. It cannot ship in the meantime, and
      # that pull request runs the complete gate against a base containing it.
      emit false false false false false false main-blocked \
        'direct push to main — not deployable, so not tested; open a pull request'
      exit 0
    fi
    # Every OTHER way of failing to prove provenance: an ambiguous association,
    # a red suite on the head, a tree that moved, an API that would not answer,
    # a pull request that touched the CI trust surface. Deploy Staging CAN
    # consume this commit, so it gets the complete gate.
    everything true main-full 'provenance not established — running the complete gate'
    exit 0
    ;;

  merge_group | workflow_dispatch)
    everything false full "event ${EVENT} always runs the complete gate"
    exit 0
    ;;

  *)
    everything false full "unrecognised event «${EVENT}» — running everything"
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
  emit true false false false false false fast 'draft pull request — fast feedback only'
  exit 0
fi

# ─────────────────────────────────────────────── B. the ready-for-review path
if [ "$CHANGED_FILES" = 'UNKNOWN' ]; then
  everything false full 'the changed-file list could not be established — running everything'
  exit 0
fi

if [ -z "${CHANGED_FILES//[[:space:]]/}" ]; then
  everything false full 'no changed files were reported — running everything'
  exit 0
fi

docs_only=true
want_unit=false
want_db=false
want_e2e=false
files=0

while IFS= read -r path; do
  [ -n "$path" ] || continue
  files=$((files + 1))

  if is_docs "$path"; then
    continue
  fi
  docs_only=false

  # Not documentation. The ONLY paths that may select anything away are the
  # four applications; every other path — shared package, tool, workflow,
  # migration, lockfile, Dockerfile, or something this file has never heard of
  # — runs the complete gate and stops the scan.
  #
  # And not every path INSIDE an application is source. The app map is a
  # statement about what imports what, derived from the dependency graph — so
  # it says nothing about a file that CHANGES that graph, or that changes how
  # the app is built or tested. A manifest, a tsconfig or a bundler config
  # under `apps/` is workspace configuration, and the brief puts workspace
  # configuration on the always-run list.
  case "${path##*/}" in
    package.json | tsconfig*.json | vite.config.* | vitest.config.* | playwright.config.*)
      everything false full "«${path}» is build or dependency configuration — running the complete gate"
      exit 0
      ;;
  esac

  case "$path" in
    apps/admin-web/*)
      want_unit=true
      want_e2e=true
      ;;
    apps/dashboard-worker/*)
      want_db=true
      want_e2e=true
      ;;
    apps/bot/* | apps/ingest-worker/*)
      want_db=true
      ;;
    *)
      everything false full "«${path}» is outside apps/ — running the complete gate"
      exit 0
      ;;
  esac
done <<<"$CHANGED_FILES"

if [ "$files" -eq 0 ]; then
  everything false full 'no changed files were reported — running everything'
  exit 0
fi

if [ "$docs_only" = 'true' ]; then
  emit true false false false false false docs \
    "all ${files} changed path(s) are documentation"
  exit 0
fi

# An `apps/`-only change. `static` always; the rest as the map decided.
# `deploy_suites` is false BECAUSE the 22 bash suites read `deploy/`,
# `.github/workflows/` and the migrator's source and nothing else — none of
# which an `apps/`-only change can reach. Any path under those forced the
# complete gate above and never got here.
emit true "$want_unit" "$want_db" "$want_e2e" false false apps \
  "${files} changed path(s), all under apps/ or documentation"
