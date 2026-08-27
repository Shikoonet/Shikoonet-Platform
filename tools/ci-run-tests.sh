#!/usr/bin/env bash
#
# Run one CI shard's packages, serially, and leave a machine-readable report.
#
# Two lists, because coverage is not free. `$1` is the packages whose tests only
# have to run; `$2` is the packages that ALSO carry a coverage floor in
# `vitest.coverage.ts` and so must run under `--coverage` for that floor to be
# enforced. Passing `--coverage` to everything would buy nothing on the seven
# packages that have no thresholds configured and cost ~20% of their runtime.
#
# ## Why `--workspace-concurrency=1` is still here
#
# Sharding moved the packages onto separate runners with separate Postgres
# containers, which is what makes the shards safe to run in parallel. It did
# NOT make the packages *inside* one shard safe to run together: they still
# share that shard's single database and still TRUNCATE between files. The flag
# is the serial boundary at the package level; `fileParallelism: false` in each
# package's vitest config is the serial boundary inside a package. Both are
# load-bearing and neither replaces the other.
#
# ## Why both lists run even when the first one fails
#
# `--no-bail` already says "report every package, do not stop at the first red
# one". Letting `set -e` abort between the two lists would undo that at the list
# boundary, so a failure in the plain list would hide whether coverage held.
# Exit codes are collected and the worst one is returned.
#
# ## Reports
#
# `--outputFile.json=vitest-report.json` is resolved by vitest relative to each
# package's own root, so nine packages write nine files and none of them
# collides. `tools/ci-verify-gate.ts` reads them in the aggregator and is what
# turns "the shard was green" into "the shard actually ran the tests it claims".
set -Eeuo pipefail

plain="${1:-}"
covered="${2:-}"

run() {
  local coverage="$1"
  shift
  [ "$#" -gt 0 ] || return 0

  local args=()
  local pkg
  for pkg in "$@"; do
    args+=(--filter "$pkg")
  done
  args+=(--workspace-concurrency=1 --no-bail test)
  args+=(--reporter=default --reporter=json --outputFile.json=vitest-report.json)
  if [ "$coverage" = 'yes' ]; then
    args+=(--coverage)
  fi

  echo "::group::vitest ${*} (coverage=${coverage})"
  local rc=0
  pnpm "${args[@]}" || rc=$?
  echo '::endgroup::'
  return "$rc"
}

worst=0

# shellcheck disable=SC2086
# Deliberate word splitting. These arrive from the workflow matrix as a
# space-separated list of package names, and each word is one package.
run no $plain || worst=$?
# shellcheck disable=SC2086
run yes $covered || worst=$?

exit "$worst"
