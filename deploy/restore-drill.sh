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

# Which environment's backup to drill. `production` unless told otherwise,
# because that is the one whose restore anybody actually needs at 3am.
ENV_ARG="${1:-production}"
case "$ENV_ARG" in
  staging | production) ;;
  *) echo "usage: restore-drill.sh [staging|production]" >&2; exit 2 ;;
esac

# Resolved from Coolify, not hardcoded.
#
# Both of these used to be literals naming `zpuyfk3p3nqfpebybbxz6opy`, and that
# container does not exist on this host — the databases are
# `qd2vduj7kv05sp9ejdrmclmu` (production) and `bea6ac92holn5k6vjgopy2ai`
# (staging). So the drill would have died on its first docker exec, which is a
# particularly bad way for a backup verifier to fail: it never ran, and nothing
# said the backups were unverified.
#
# Asking Coolify's own database is the same read path `deploy.sh` already uses
# for application settings. Neither value is a secret.
COOLIFY_DB_CONTAINER="${COOLIFY_DB_CONTAINER:-coolify-db}"
coolify_env_name=production
[ "$ENV_ARG" = 'staging' ] && coolify_env_name=dev-fleet

if [ -z "${DB_CONTAINER:-}" ]; then
  DB_CONTAINER=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At \
    -c "select p.uuid from standalone_postgresqls p
          join environments e on e.id = p.environment_id
         where e.name = '${coolify_env_name}' limit 1;" 2>/dev/null || true)
  [ -n "$DB_CONTAINER" ] || {
    echo "could not resolve the ${ENV_ARG} database container from Coolify" >&2
    exit 1
  }
fi

# Coolify names each backup directory `<db-name>-<uuid>`, so the uuid is what
# finds it. Searched rather than composed: the team segment of the path is
# Coolify's to choose and has changed before.
if [ -z "${BACKUP_DIR:-}" ]; then
  BACKUP_DIR=$(find /data/coolify/backups/databases -maxdepth 2 -type d \
    -name "*${DB_CONTAINER}" 2>/dev/null | head -1)
  [ -n "$BACKUP_DIR" ] || {
    echo "no backup directory for ${ENV_ARG} database ${DB_CONTAINER} under /data/coolify/backups/databases" >&2
    echo "  (a database with no scheduled backup has nothing to restore — configure one in Coolify first)" >&2
    exit 1
  }
fi
say_target() { printf 'target  %s  container=%s  dir=%s\n' "$ENV_ARG" "$DB_CONTAINER" "$BACKUP_DIR"; }
# Named for what it is, so nobody wonders whether it matters. Dropped at the end
# and dropped again on the way in, because a drill that died halfway must not
# make the next one fail.
SCRATCH="${SCRATCH:-restore_drill_scratch}"
PGUSER="${PGUSER:-postgres}"
STATE_DIR="${STATE_DIR:-/var/lib/shikoo}"
case "$SCRATCH" in
  '' | [0-9]* | *[!A-Za-z0-9_]*)
    echo "unsafe scratch database name: $SCRATCH" >&2
    exit 2 ;;
esac
if [ ! -d "$STATE_DIR" ] || [ ! -w "$STATE_DIR" ]; then
  echo "state directory is absent or not writable: $STATE_DIR" >&2
  exit 1
fi

# The SQL this drill checks against travels WITH the drill.
#
# It used to read `/tmp/verify_invariants.sql`, an unversioned path with no
# checksum: whatever somebody last copied there is what the money invariants
# were checked against, and a stale copy passes just as quietly as a current
# one. Now both the invariants and the migration list are resolved relative to
# this file, so the thing being checked and the thing checking it ship as one
# unit. Override only if you have deliberately split them.
# `env CDPATH='' cd ...` was here, and it cannot work: `env` execs a PROGRAM,
# and `cd` is a shell builtin. The drill died with `env: 'cd': No such file or
# directory` on its very first run — which also means it had never run before,
# because that failure is immediate and unmissable.
#
# The subshell does the same job correctly: the assignment is scoped to it, so
# a developer's CDPATH cannot make `cd ..` land somewhere else, and `cd` stays
# the builtin it has to be.
#
# Two layouts have to work. In the repository this file is `deploy/`, with
# migrations at `../migrations`. Installed, it is `/usr/local/lib/shikoo-step-e/`
# with migrations shipped beside it. Both are checked rather than assumed,
# because guessing wrong here fails as "ledger mismatch" — a wrong answer that
# looks like a real finding.
if [ -z "${MIGRATIONS_DIR:-}" ]; then
  _here=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
  if [ -d "$_here/migrations" ]; then
    MIGRATIONS_DIR="$_here/migrations"
  else
    MIGRATIONS_DIR="$_here/../migrations"
  fi
fi
INVARIANTS="${INVARIANTS:-$MIGRATIONS_DIR/verify_invariants.sql}"

say() { printf '%s\n' "$*"; }
say_target
psql_() { docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 -q "$@"; }

# Once a scratch database might exist, every exit path removes it. The previous
# version dropped it only on the success path and three named refusals; a failed
# pg_restore or invariant query left the scratch copy behind, contrary to the
# drill's safety contract.
SCRATCH_ACTIVE=0
TMP_ATTESTATION=''
TMP_CHECKSUM=''
cleanup_scratch() {
  [ "$SCRATCH_ACTIVE" -eq 0 ] ||
    psql_ -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH" >/dev/null 2>&1 || true
}
cleanup_all() {
  cleanup_scratch
  [ -z "$TMP_ATTESTATION" ] || rm -f -- "$TMP_ATTESTATION"
  [ -z "$TMP_CHECKSUM" ] || rm -f -- "$TMP_CHECKSUM"
}
trap cleanup_all 0
trap 'exit 130' 2
trap 'exit 143' 15

# Newest `.dmp` by mtime. `find -printf` sorts on the timestamp itself rather
# than on `ls` output, so a filename with a newline in it cannot shift the
# answer by a line (SC2012). The names this writes are `<name>-<epoch>.dmp`,
# but the dump directory is operator-writable and the drill must not be the
# thing that trusts it.
DUMP=$(find "$BACKUP_DIR" -maxdepth 1 -name '*.dmp' -type f -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)
[ -n "$DUMP" ] || { say "no dump found in $BACKUP_DIR"; exit 1; }
DUMP_BASE=$(basename "$DUMP")
case "$DUMP_BASE" in
  *[!A-Za-z0-9_.-]*) say "refusing a backup filename with unsafe characters"; exit 1 ;;
esac

DUMP_EPOCH=$(printf '%s' "$DUMP_BASE" | sed -n 's/.*-\([0-9][0-9]*\)\.dmp$/\1/p')
case "$DUMP_EPOCH" in '' | *[!0-9]*) say "cannot derive a numeric epoch from $DUMP_BASE"; exit 1 ;; esac
NOW=$(date +%s)
[ "$DUMP_EPOCH" -le $((NOW + 300)) ] || { say "backup timestamp is in the future: $DUMP_BASE"; exit 1; }
AGE_H=$(( ( NOW - DUMP_EPOCH ) / 3600 ))
DUMP_BYTES=$(wc -c <"$DUMP" | tr -d ' ')
say "dump    $DUMP_BASE  $(date -u -d "@$DUMP_EPOCH" +%Y-%m-%dT%H:%MZ)  ${AGE_H}h old  $(du -h "$DUMP" | cut -f1)"

# The age is reported, not enforced. What counts as too old is an RPO decision
# and it belongs in deploy/README.md where a person can see it, not hidden in a
# constant here that silently disagrees with it.
[ "$AGE_H" -gt 48 ] && say "WARNING: newest backup is older than two days"

say "restoring into $SCRATCH …"
SCRATCH_ACTIVE=1
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

# The header of this file promises this check says the ledger is CURRENT. For a
# long time the line above was the whole check, and `count > 0` is not
# currency — a dump three migrations behind passes it exactly as a fresh one
# does, which is the gap the boot gate exists to catch. Rule 7 of CLAUDE.md:
# the check has to be at least as strict as the thing it claims to check.
#
# Current is measured against something OUTSIDE the ledger — the migration
# files that shipped beside this script — rather than against the ledger's own
# count, which can only ever agree with itself.
[ -d "$MIGRATIONS_DIR" ] || {
  say "FAIL: $MIGRATIONS_DIR not found — copy migrations/ next to deploy/ on this host"
  exit 1
}
# The ledger stores the file name WITH its extension, and beside it the sha256
# of the file's bytes — verified against `sha256sum` on 2026-08-23, so this
# compares like with like rather than trusting the column's name. The checksum
# is the half that matters: a name-only check passes a migration whose content
# was edited after it was applied, which is the shape of drift that hurts.
MISSING=""
DRIFTED=""
DISK_NAMES=$(find "$MIGRATIONS_DIR" -maxdepth 1 -type f -name '0*.sql' -printf '%f\n' | sort)
LEDGER_NAMES=$(psql_ -tAd "$SCRATCH" -c "SELECT name FROM schema_migrations ORDER BY name")
[ "$DISK_NAMES" = "$LEDGER_NAMES" ] || {
  say "FAIL: the restored ledger and shipped migration filename sets differ"
  exit 1
}
for f in "$MIGRATIONS_DIR"/*.sql; do
  n=$(basename "$f")
  [ "$n" = "verify_invariants.sql" ] && continue
  want=$(sha256sum "$f" | cut -d' ' -f1)
  got=$(psql_ -tAd "$SCRATCH" -c "SELECT checksum FROM schema_migrations WHERE name = '$n'")
  if [ -z "$got" ]; then
    MISSING="$MISSING $n"
  elif [ "$got" != "$want" ]; then
    DRIFTED="$DRIFTED $n"
  fi
done
if [ -n "$MISSING" ] || [ -n "$DRIFTED" ]; then
  say "FAIL: the restored copy does not match the migrations shipped with this drill."
  [ -n "$MISSING" ] && say "      absent from its ledger:$MISSING"
  [ -n "$DRIFTED" ] && say "      present but a DIFFERENT file was applied:$DRIFTED"
  say "      a dump that restores into an older or divergent schema than the"
  say "      running code cannot be deployed onto — that is this check's point."
  exit 1
fi
say "  ledger is current against $MIGRATIONS_DIR (name + sha256, every file)"

say "money invariants against the restored copy:"
if [ -f "$INVARIANTS" ]; then
  docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -v ON_ERROR_STOP=1 -q -d "$SCRATCH" < "$INVARIANTS"
  say "  invariants PASS ($INVARIANTS)"
else
  say "FAIL: $INVARIANTS not found — migrations/ must ship beside deploy/ on this host"
  exit 1
fi

psql_ -d postgres -c "DROP DATABASE IF EXISTS $SCRATCH"
SCRATCH_ACTIVE=0
say "scratch dropped — drill PASSED"

# Non-secret, checksummed proof for the task runner. The earlier runner checked
# for this file but the drill never wrote it, so a successful restore was
# indistinguishable from one that had never run.
ATTESTATION="$STATE_DIR/restore-attestation.env"
TMP_ATTESTATION=$(mktemp "$STATE_DIR/.restore-attestation.XXXXXX")
umask 027
{
  printf 'schema_version=1\n'
  printf 'environment=%s\n' "$ENV_ARG"
  printf 'database_container=%s\n' "$DB_CONTAINER"
  printf 'dump_file=%s\n' "$DUMP_BASE"
  printf 'dump_bytes=%s\n' "$DUMP_BYTES"
  printf 'dump_age_hours=%s\n' "$AGE_H"
  printf 'schema_migrations=%s\n' "$LEDGER"
  printf 'latest_migration=%s\n' "$LATEST"
  printf 'migration_set_exact=yes\n'
  printf 'migration_checksums=pass\n'
  printf 'invariants=pass\n'
  printf 'scratch_dropped=yes\n'
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$TMP_ATTESTATION"
chmod 0640 "$TMP_ATTESTATION"
mv -f "$TMP_ATTESTATION" "$ATTESTATION"
TMP_ATTESTATION=''
TMP_CHECKSUM=$(mktemp "$STATE_DIR/.restore-attestation-sha.XXXXXX")
( cd "$STATE_DIR" && sha256sum "$(basename "$ATTESTATION")" ) >"$TMP_CHECKSUM"
chmod 0640 "$TMP_CHECKSUM"
mv -f "$TMP_CHECKSUM" "$STATE_DIR/restore-attestation.sha256"
TMP_CHECKSUM=''
say "attestation written — $ATTESTATION"
