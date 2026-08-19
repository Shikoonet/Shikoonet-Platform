#!/bin/sh
# Which of the three this container is.
#
# Set `SERVICE` to bot, ingest or dashboard. There is no default on purpose: an
# image that picks one for you starts the wrong process on a typo and looks
# healthy doing it. Same reasoning as the boot guards inside the services —
# a setting nobody decided is refused here rather than guessed.
set -eu

# ---------------------------------------------------------------------------
# The schema gate.
#
# On 2026-08-17 the dashboard was deployed with the operator-login code while
# `0021_operator_auth.sql` had never been run against production. Everything
# looked fine: the image built, the container started, the health check passed.
# The only symptom was every login answering 500 with `column "password_hash"
# does not exist`. The ledger that followed can SEE that gap — nothing was
# stopping a container from starting across it.
#
# Here rather than inside the three services, because it is one rule and this
# is the one place all three pass through. Three copies would be three places
# for it to drift, and the service that forgot its copy is the one that breaks.
#
# `gate`, not `status`: a database AHEAD of this checkout is a warning, not a
# refusal. That case is a rollback, and a gate that blocks yesterday's image
# blocks the one deploy you make when something is already wrong.
#
# Skippable only by `SERVICE=migrate` below, which is how you fix what it finds.
# ---------------------------------------------------------------------------
schema_gate() {
  if [ -z "${DATABASE_URL:-}" ]; then
    # Not this script's rule to enforce — every service already refuses to boot
    # without it, and with a better message than this one could give.
    return 0
  fi
  node --import tsx packages/db/src/schemaCli.ts gate
}

case "${SERVICE:-}" in
  bot)       schema_gate; exec node --import tsx apps/bot/src/server.ts ;;
  ingest)    schema_gate; exec node --import tsx apps/ingest-worker/src/server.ts ;;
  dashboard) schema_gate; exec node --import tsx apps/dashboard-worker/src/server.ts ;;
  # Applies what the gate refuses to start on, then exits. A one-off container
  # rather than a step inside the three, because a service that migrates on boot
  # migrates once per replica and once per restart loop, and the moment it runs
  # is whenever the scheduler felt like it. Here it is a thing somebody decided
  # to do. It is safe to run twice and safe to run concurrently — `up()` holds a
  # Postgres advisory lock and records each file with the transaction that ran
  # it.
  migrate)   exec node --import tsx packages/db/src/schemaCli.ts up ;;
  '')
    echo "SERVICE is required: one of bot, ingest, dashboard, migrate" >&2
    exit 1
    ;;
  *)
    echo "SERVICE=${SERVICE} is not one of bot, ingest, dashboard, migrate" >&2
    exit 1
    ;;
esac
