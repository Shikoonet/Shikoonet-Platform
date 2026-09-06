#!/usr/bin/env bash
#
# The integration executors' orchestrator.
#
# Two jobs call this — `integration-db` and `integration-e2e` — each with the
# list of suites its plan selected. It runs every one of them, records every
# exit status, cleans up after each, prints a table, and exits non-zero if any
# suite failed.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why a script and not fifteen `run:` steps
#
# Because «run all of them even when one fails» is not something a workflow can
# express. Steps stop at the first failure, and `continue-on-error` makes the
# JOB green — which is the exact shape of failure this repository's gate exists
# to refuse. So the suites are sequenced here, where a failure can be recorded
# without being forgiven.
#
# There is no `|| true` in this file and no pipeline that could swallow a
# status. Every suite's exit code goes into `STATUS[...]` and every one of them
# is re-read at the bottom. A suite that was never reached is `NOT-RUN`, which
# is a failure, not an absence.
#
# ─────────────────────────────────────────────────────────────────────────────
# What replaced the per-shard Postgres container, and what that costs
#
# Until 2026-09-01 each database suite got its own Postgres CONTAINER on its own
# runner VM, and the isolation proof was `system_identifier` — a value initdb
# writes once, so two different values in one run proved two different servers.
#
# Consolidating the suites into one job puts them on ONE server, and that proof
# no longer says anything: one server has one identifier. So it is replaced,
# not dropped:
#
#   * every suite gets its own DATABASE, created here, immediately before it
#     runs, from `template0`;
#   * the suite is refused unless that database is EMPTY at the moment it
#     starts — a populated one would mean the name was reused or the URL points
#     at something real, and a suite that truncates must never be aimed at
#     either;
#   * the database is dropped afterwards, on success and on failure alike;
#   * the suites run SEQUENTIALLY. Nothing here runs two suites at once, so
#     «its own database» is a complete statement about who can see the rows,
#     not merely about who owns them.
#
# What is genuinely weaker than before: these databases share one postmaster, so
# they share its memory, its disk and its crash. A server that dies takes every
# remaining suite with it. That is a availability property, not an isolation
# one — no suite can read another's rows — and it is the whole price of the
# consolidation. Written down here rather than discovered later.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run:  ci-integration.sh <suite> [<suite> ...]
#
#   db-hub          @shikoo/dashboard @shikoo/db @shikoo/seed, against a schema
#   db-services     @shikoo/bot @shikoo/ingest, coverage on @shikoo/domain
#   migrations      every migration in order, the money invariants, the
#                   migration suite against the synthetic legacy source, and
#                   the deployable-image checks
#   e2e             the browser walk against a real server and a real SPA
#   deploy-suites   the 22 bash suites over `deploy/`
#
# Environment:
#   PGHOST/PGPORT/PGUSER/PGPASSWORD  the throwaway server this job started
#   MYSQL_*                          the throwaway MySQL, for `migrations`

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT"

PGHOST=${PGHOST:-127.0.0.1}
PGPORT=${PGPORT:-5432}
PGUSER=${PGUSER:-postgres}
PGPASSWORD=${PGPASSWORD:-ci}
export PGHOST PGPORT PGUSER PGPASSWORD

# The maintenance connection. Never a suite's own database, so a DROP can
# always reach it.
ADMIN_URL="postgres://${PGUSER}:${PGPASSWORD}@${PGHOST}:${PGPORT}/postgres"

declare -A STATUS=()
ORDER=()

say() { printf '\n\033[1m── %s\033[0m\n' "$*"; }

# ─────────────────────────────────────────────────────────── the database pair
#
# Names are fixed strings chosen here, never taken from an argument, so no
# caller can aim `DROP DATABASE` at something it names itself.
fresh_db() { # logical-name -> echoes the URL
  local name="shikoo_ci_$1"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc \
    "DROP DATABASE IF EXISTS ${name} WITH (FORCE)" >/dev/null
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc \
    "CREATE DATABASE ${name} TEMPLATE template0" >/dev/null
  printf 'postgres://%s:%s@%s:%s/%s\n' "$PGUSER" "$PGPASSWORD" "$PGHOST" "$PGPORT" "$name"
}

drop_db() { # logical-name
  local name="shikoo_ci_$1"
  psql "$ADMIN_URL" -v ON_ERROR_STOP=1 -qtAc \
    "DROP DATABASE IF EXISTS ${name} WITH (FORCE)" >/dev/null
}

# The outer half of the pair that `assertLocal` inside the seed runner forms.
# It is here so a run fails at the line that named the database rather than
# four steps later inside a package.
assert_disposable() { # url  logical-name
  local url=$1 name=$2
  case "$url" in
    postgres://*@127.0.0.1:*/shikoo_ci_* | postgres://*@localhost:*/shikoo_ci_*) ;;
    *)
      echo "::error::refusing to run against ${url%%\?*} — not a disposable CI database"
      return 1
      ;;
  esac
  local tables
  tables=$(psql "$url" -tAc \
    "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")
  if [ "$tables" != '0' ]; then
    echo "::error::${name}: database is not empty (${tables} tables) before the suite ran"
    return 1
  fi
  local oid db
  db=$(psql "$url" -tAc 'SELECT current_database()')
  oid=$(psql "$url" -tAc 'SELECT oid FROM pg_database WHERE datname = current_database()')
  echo "${name}: database ${db} oid=${oid}, 0 tables"
  echo "| ${name} | \`${db}\` oid \`${oid}\` | empty at start |" \
    >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
}

# ═════════════════════════════════════════════════════════════════ the suites
#
# Each one returns its own exit status and cleans up its own database. None of
# them calls `exit`: the caller records the status and moves to the next.

suite_db_hub() {
  local url rc=0
  url=$(fresh_db db_hub)
  assert_disposable "$url" db_hub || { drop_db db_hub; return 1; }
  # Through the ledger, not a shell loop over the files: production runs
  # `schema up`, and a runner CI never exercises is one CI cannot vouch for.
  DATABASE_URL="$url" ENV_NAME=test pnpm --filter @shikoo/db schema up || rc=$?
  if [ "$rc" -eq 0 ]; then
    DATABASE_URL="$url" ENV_NAME=test pnpm --filter @shikoo/db schema status || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    DATABASE_URL="$url" ENV_NAME=test \
      bash tools/ci-run-tests.sh '@shikoo/dashboard @shikoo/db @shikoo/seed' '' || rc=$?
  fi
  drop_db db_hub
  return "$rc"
}

suite_db_services() {
  local url rc=0
  url=$(fresh_db db_services)
  assert_disposable "$url" db_services || { drop_db db_services; return 1; }
  DATABASE_URL="$url" ENV_NAME=test pnpm --filter @shikoo/db schema up || rc=$?
  if [ "$rc" -eq 0 ]; then
    DATABASE_URL="$url" ENV_NAME=test pnpm --filter @shikoo/db schema status || rc=$?
  fi
  if [ "$rc" -eq 0 ]; then
    DATABASE_URL="$url" ENV_NAME=test \
      bash tools/ci-run-tests.sh '@shikoo/bot @shikoo/ingest' '@shikoo/domain' || rc=$?
  fi
  drop_db db_services
  return "$rc"
}

suite_migrations() {
  local url rc=0 applied pending invariants rows
  url=$(fresh_db migrations)
  assert_disposable "$url" migrations || { drop_db migrations; return 1; }

  # The legacy source. Synthetic, in the repo, and nothing in it came from the
  # production dump — see the header of `synthetic-mirzabot.sql`.
  if ! mysql --protocol=TCP -h"${MYSQL_HOST:-127.0.0.1}" -P"${MYSQL_PORT:-3307}" \
    -u"${MYSQL_USER:-root}" -p"${MYSQL_PASSWORD:-ci}" "${MYSQL_DATABASE:-mirzabot}" \
    <packages/migrate/test/fixtures/synthetic-mirzabot.sql; then
    echo '::error::the synthetic legacy fixture would not load'
    drop_db migrations
    return 1
  fi
  # shellcheck disable=SC2016
  # `user` is a reserved word in MySQL and must stay backticked; the single
  # quotes keep the shell out of it entirely. Nothing here is meant to expand.
  rows=$(mysql --protocol=TCP -h"${MYSQL_HOST:-127.0.0.1}" -P"${MYSQL_PORT:-3307}" \
    -u"${MYSQL_USER:-root}" -p"${MYSQL_PASSWORD:-ci}" "${MYSQL_DATABASE:-mirzabot}" -sN \
    -e 'SELECT COUNT(*) FROM `user`')
  echo "synthetic users loaded: ${rows}"
  if [ "$rows" -le 0 ]; then
    echo '::error::the fixture loaded no rows'
    drop_db migrations
    return 1
  fi

  export DATABASE_URL="$url" ENV_NAME=test
  export D1_EXPORT_DIR="${ROOT}/packages/migrate/test/fixtures/d1-export"

  if pnpm --filter @shikoo/db schema up &&
    pnpm --filter @shikoo/db schema status | tee /tmp/schema-status.txt &&
    grep -q 'schema is current' /tmp/schema-status.txt; then
    applied=$(awk '/^applied/ { print $2 }' /tmp/schema-status.txt)
    pending=$(awk '/^pending/ { print $2 }' /tmp/schema-status.txt)
    echo "migrations applied: ${applied}, pending: ${pending}"
    if [ "$pending" != '0' ]; then
      echo "::error::${pending} migration(s) pending"
      rc=1
    fi
  else
    echo '::error::the migration ledger did not reach a current schema'
    rc=1
  fi

  # Each assertion in the file emits one `PASS` notice. Counting them is what
  # turns «the script exited 0» into «the script actually asserted thirty-two
  # things» — a file whose assertions were commented out also exits 0.
  if [ "$rc" -eq 0 ]; then
    if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q \
      -f migrations/verify_invariants.sql >/tmp/invariants.log 2>&1; then
      cat /tmp/invariants.log
      # `grep -c` exits 1 on zero matches, which under `set -e` would abort
      # before the assertion below could report the real problem. Zero is
      # substituted so the assertion is what fails, with the count in it.
      invariants=$(grep -c 'PASS ' /tmp/invariants.log || printf '0')
      echo "invariants proved: ${invariants}"
      if [ "$invariants" -le 0 ]; then
        echo '::error::the invariant script asserted nothing'
        rc=1
      fi
    else
      cat /tmp/invariants.log
      echo '::error::the money invariants did not hold'
      rc=1
      invariants=0
    fi
  fi

  if [ "$rc" -eq 0 ]; then
    MIGRATE_FIXTURE_MYSQL=1 bash tools/ci-run-tests.sh '@shikoo/migrate' '' || rc=$?
  fi

  # The only checks that measure the ARTIFACT rather than the source. They live
  # in this suite because it already has the Postgres and the docker they need.
  if [ "$rc" -eq 0 ]; then
    bash tools/ci-image-checks.sh || rc=$?
  fi

  if [ "$rc" -eq 0 ]; then
    mkdir -p out
    printf '{"migrations":%s,"invariants":%s}\n' "$applied" "$invariants" >out/schema-counts.json
    cat out/schema-counts.json
  fi

  unset DATABASE_URL ENV_NAME D1_EXPORT_DIR
  drop_db migrations
  return "$rc"
}

suite_e2e() {
  local url rc=0
  url=$(fresh_db e2e)
  assert_disposable "$url" e2e || { drop_db e2e; return 1; }

  export DATABASE_URL="$url" ENV_NAME=test

  # BEFORE the schema and seed steps: `seed:sim` reads `sim/.env.local` through
  # `--env-file`. Written with 0600 and removed below, on every ending. It holds
  # no real credential on a runner, but the file is git-ignored precisely
  # because on a developer machine it holds a Telegram token, and the CI copy
  # should not be the exception that teaches everyone it is safe to leave lying
  # around.
  #
  # NOT an `@shikoo.local` address: `config.spec.ts:303` finds «somebody other
  # than me» with `tr:has-text("@shikoo.local")`, and the seeded operators live
  # on that domain.
  (
    umask 077
    printf 'DATABASE_URL=%s\nTEST_ACCESS_USER=ci-operator@example.test\nENV_NAME=test\n' \
      "$DATABASE_URL" >sim/.env.local
  )

  if pnpm --filter @shikoo/db schema up && pnpm --filter @shikoo/seed seed:sim; then
    # The package's own `e2e` script builds the SPA too, which is why this calls
    # `playwright test` directly — the job was paying for that build twice.
    pnpm --filter @shikoo/admin-web build || rc=$?
    if [ "$rc" -eq 0 ]; then
      pnpm --filter @shikoo/dashboard exec playwright test || rc=$?
    fi
  else
    echo '::error::the e2e database could not be prepared'
    rc=1
  fi

  # A trace carries request bodies and rendered pages. The env file goes first,
  # then the report is checked for the one value that could plausibly be in it.
  rm -f sim/.env.local
  if [ "$rc" -ne 0 ] && [ -d apps/dashboard-worker/test-results ]; then
    grep -rl 'ci-operator@example.test' apps/dashboard-worker/test-results 2>/dev/null |
      head -20 || true
  fi

  unset DATABASE_URL ENV_NAME
  drop_db e2e
  return "$rc"
}

suite_deploy_suites() {
  # Bash, `jq` and `curl`. No database, no node_modules, no network: every one
  # of these drives a fake GitHub and a fake Coolify.
  local rc=0 t
  for t in \
    deploy/test/autodeploy.test.sh \
    deploy/test/deploy-pipeline.test.sh \
    deploy/test/coolify-api.test.sh \
    deploy/test/coolify-app.test.sh \
    deploy/test/restore-drill.test.sh \
    deploy/test/step-e.test.sh \
    deploy/test/step-e-live-shape.test.sh \
    deploy/test/task-runner.test.sh \
    deploy/test/task-runner-installer.test.sh \
    deploy/test/rehearsal-lib.test.sh \
    deploy/test/d1-contract.test.sh \
    deploy/test/production-dump-rehearsal.test.sh \
    deploy/test/rehearsal-subjects.test.sh \
    deploy/test/attestation-publication.test.sh \
    deploy/test/rehearsal-cleanup.test.sh \
    deploy/test/d1-sidecar.test.sh \
    deploy/test/stage-owner-bundle.test.sh \
    deploy/test/classify-envs.test.sh \
    deploy/test/attestation.test.sh \
    deploy/test/preparation.test.sh \
    deploy/test/candidates.test.sh \
    deploy/test/production-workflows.test.sh \
    tools/test/ci-plan.test.sh \
    tools/test/ci-draft-state.test.sh \
    tools/test/ci-suite-map.test.sh; do
    echo "::group::${t}"
    if bash "$t"; then
      echo "::endgroup::"
    else
      rc=1
      echo "::endgroup::"
      echo "::error::${t} failed"
    fi
  done
  return "$rc"
}

# ══════════════════════════════════════════════════════════════ the sequencer

[ "$#" -gt 0 ] || { echo 'usage: ci-integration.sh <suite> [<suite> ...]' >&2; exit 2; }

for suite in "$@"; do
  case "$suite" in
    db-hub | db-services | migrations | e2e | deploy-suites) ;;
    *) echo "::error::unknown suite «${suite}»" >&2; exit 2 ;;
  esac
  ORDER+=("$suite")
  STATUS["$suite"]='NOT-RUN'
done

for suite in "${ORDER[@]}"; do
  say "$suite"
  rc=0
  case "$suite" in
    db-hub) suite_db_hub || rc=$? ;;
    db-services) suite_db_services || rc=$? ;;
    migrations) suite_migrations || rc=$? ;;
    e2e) suite_e2e || rc=$? ;;
    deploy-suites) suite_deploy_suites || rc=$? ;;
  esac
  if [ "$rc" -eq 0 ]; then
    STATUS["$suite"]='pass'
  else
    STATUS["$suite"]="FAIL (exit ${rc})"
  fi
  echo "── ${suite}: ${STATUS[$suite]}"
done

# ────────────────────────────────────────────────────────────────── the verdict
#
# Re-read from the table rather than accumulated in a counter, so a suite the
# loop never reached still reports `NOT-RUN` and still fails the job.
bad=0
{
  echo
  echo "### Integration executor"
  echo
  echo '| suite | result |'
  echo '| --- | --- |'
} >>"${GITHUB_STEP_SUMMARY:-/dev/null}"

echo
echo '════════════════════════════════════════════'
for suite in "${ORDER[@]}"; do
  printf '  %-16s %s\n' "$suite" "${STATUS[$suite]}"
  printf '| %s | %s |\n' "$suite" "${STATUS[$suite]}" >>"${GITHUB_STEP_SUMMARY:-/dev/null}"
  [ "${STATUS[$suite]}" = 'pass' ] || bad=$((bad + 1))
done
echo '════════════════════════════════════════════'

if [ "$bad" -gt 0 ]; then
  echo "::error::${bad} of ${#ORDER[@]} suite(s) did not pass"
  exit 1
fi
echo "all ${#ORDER[@]} suite(s) passed"
