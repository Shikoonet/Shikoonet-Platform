#!/bin/sh
# Which of the three this container is.
#
# Set `SERVICE` to bot, ingest or dashboard. There is no default on purpose: an
# image that picks one for you starts the wrong process on a typo and looks
# healthy doing it. Same reasoning as the boot guards inside the services —
# a setting nobody decided is refused here rather than guessed.
set -eu

case "${SERVICE:-}" in
  bot)       exec node --import tsx apps/bot/src/server.ts ;;
  ingest)    exec node --import tsx apps/ingest-worker/src/server.ts ;;
  dashboard) exec node --import tsx apps/dashboard-worker/src/server.ts ;;
  '')
    echo "SERVICE is required: one of bot, ingest, dashboard" >&2
    exit 1
    ;;
  *)
    echo "SERVICE=${SERVICE} is not one of bot, ingest, dashboard" >&2
    exit 1
    ;;
esac
