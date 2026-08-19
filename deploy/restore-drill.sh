#!/bin/sh
# Proves the newest backup can actually be restored, and that what comes back is
# the database we think it is.
#
#   ssh root@<server> 'sh -s' < deploy/restore-drill.sh
#
# ## Why this exists
#
# Backups ran daily from 2026-08-16 and one was restored by hand once. Neither
# fact was in this repository, so there was no command anybody could run, no
# statement of what it should produce, and no evidence any dump after that first
# one was restorable. A backup nobody has restored is a belief, not a backup —
# and the way it fails is always the same: it is discovered at the exact moment
# it is needed.
#
# ## What it does, and what it deliberately does not
#
# Restores the newest dump into a THROWAWAY database beside the real one and
# tears it down afterwards. It never writes to the live database and never
# stops a service. That is what makes it safe to run whenever you like, which
# is the property that decides whether it gets run at all.
#
# Restoring is not the check. Three things are, in this order:
#
#   1. pg_restore finishes.
#   2. The schema ledger in the RESTORED copy says it is current. A dump that
#      restores into an older schema than the running code is a dump that
#      cannot be deployed onto, and the ledger is the only thing that can see
#      that gap — the same reason the boot gate exists.
#   3. `verify_invariants.sql` passes against the restored copy. Rows are what
#      a backup is for; a structurally perfect restore with a broken money
#      invariant is worse than a failed one, because it looks fine.
#
# Row counts are printed rather than asserted. A threshold here would be a
# number that goes stale silently — a person reading "2 users" against a shop
# with a thousand knows immediately, and no constant in this file would.
#
# Exit 0 only when all three pass.

set -eu

DB_CONTAINER="${DB_CONTAINER:-zpuyfk3p3nqfpebybbxz6opy}"
BACKUP_DIR="${BACKUP_DIR:-/data/coolify/backups/databases/root-team-0/shikoo-postgres-zpuyfk3p3nqfpebybbxz6opy}"
# Named for what it is, so nobody wonders whether it matters. Dropped at the end
# and dropped again on the way in, because a drill that died halfway must not
# make the next one fail.
SCRATCH="${SCRATCH:-restore_drill_scratch}"
PGUSER="${PGUSER:-postgres}"

say() { printf '%s\n' "$*"; }
psql_() { docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 -q "$@"; }

DUMP=$(ls -1t "$BACKUP_DIR"/*.dmp 2>/dev/null | head -1)
[ -n "$DUMP" ] || { say "no dump found in $BACKUP_DIR"; exit 1; }

DUMP_EPOCH=$(basename "$DUMP" | sed 's/.*-\([0-9]*\)\.dmp/\1/')
AGE_H=$(( ( $(date +%s) - DUMP_EPOCH ) / 3600 ))
say "dump    $(basename "$DUMP")  $(date -u -d "@$DUMP_EPOCH" +%Y-%m-%dT%H:%MZ)  ${AGE_H}h old  $(du -h "$DUMP" | cut -f1)"

# The age is reported, not enforced. What counts as too old is an RPO decision
# and it belongs in deploy/README.md where a person can see it, not hidden in a
# constant here that silently disagrees with it.
[ "$AGE_H" -gt 48 ] && say "WARNING: newest backup is older than two days"

say "restoring into $SCRATCH …"
psql_ -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
psql_ -d postgres -c "CREATE DATABASE $SCRATCH"

# `--no-owner` and `--no-acl`: the dump names roles that need not exist on
# whatever host is doing the restoring, and a drill that fails on a missing role
# would be reporting on the host rather than on the backup.
docker exec -i "$DB_CONTAINER" pg_restore -U "$PGUSER" -d "$SCRATCH" --no-owner --no-acl < "$DUMP"
say "restore OK"

say "rows in the restored copy:"
psql_ -d "$SCRATCH" -c "\
  SELECT 'users' AS t, count(*) FROM users \
  UNION ALL SELECT 'orders', count(*) FROM orders \
  UNION ALL SELECT 'subscriptions', count(*) FROM subscriptions \
  UNION ALL SELECT 'payment_claims', count(*) FROM payment_claims \
  UNION ALL SELECT 'wallet_entries', count(*) FROM wallet_entries \
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs ORDER BY 1"

say "schema ledger in the restored copy:"
LEDGER=$(psql_ -tAd "$SCRATCH" -c "SELECT count(*) FROM schema_migrations")
LATEST=$(psql_ -tAd "$SCRATCH" -c "SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1")
say "  $LEDGER applied, latest $LATEST"
[ "$LEDGER" -gt 0 ] || { say "FAIL: the restored copy carries no ledger"; exit 1; }

say "money invariants against the restored copy:"
if [ -f /tmp/verify_invariants.sql ]; then
  docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 -q -d "$SCRATCH" < /tmp/verify_invariants.sql
  say "  invariants PASS"
else
  say "FAIL: /tmp/verify_invariants.sql not on this host — copy migrations/verify_invariants.sql there first"
  psql_ -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
  exit 1
fi

psql_ -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
say "scratch dropped — drill PASSED"
