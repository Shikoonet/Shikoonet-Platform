#!/usr/bin/env bash
# The restore drill has to find the database before it can prove anything.
#
# Its defaults named `zpuyfk3p3nqfpebybbxz6opy`, a container that does not exist
# on this host — the databases are `qd2vduj7kv05sp9ejdrmclmu` and
# `bea6ac92holn5k6vjgopy2ai`. So the drill would have died on its first docker
# exec, which is the worst way for a backup verifier to fail: it never ran, and
# nothing anywhere said the backups were therefore unverified.
#
# Target resolution is tested separately from the restore protocol. The latter
# is driven through a stateful fake Docker client so success, ledger drift and
# a failed pg_restore all prove their cleanup and evidence behaviour.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
DRILL="$ROOT/deploy/restore-drill.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

DOCKER_ANSWER="$WORK/docker.answer"
export DOCKER_ANSWER
cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
if [ "${FAKE_FULL:-0}" = '1' ]; then
  printf '%s\n' "$*" >>"$FULL_LOG"
  case " $* " in
    *' pg_restore '*)
      [ "${FAIL_RESTORE:-0}" = '1' ] && exit 9
      exit 0 ;;
    *'SELECT count(*) FROM schema_migrations'*) printf '1\n'; exit 0 ;;
    *'SELECT name FROM schema_migrations ORDER BY name DESC LIMIT 1'*)
      printf '0001_test.sql\n'; exit 0 ;;
    *'SELECT name FROM schema_migrations ORDER BY name'*)
      printf '0001_test.sql\n'
      [ "${LEDGER_EXTRA:-0}" = '1' ] && printf '9999_unshipped.sql\n'
      exit 0 ;;
    *'SELECT checksum FROM schema_migrations'*)
      printf '%s\n' "$MIGRATION_CHECKSUM"; exit 0 ;;
    *) exit 0 ;;
  esac
fi
a=$(cat "$DOCKER_ANSWER" 2>/dev/null || true)
[ "$a" = 'ERROR' ] && exit 1
printf '%s\n' "$a"
FAKE
chmod +x "$BIN/docker"

run() { # env-prefix... -> rc, output in $WORK/out
  set +e
  env "$@" sh "$DRILL" "${DRILL_ENV:-production}" >"$WORK/out" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'the target is resolved, not assumed'

# The bug: a hardcoded container that is not on this host. Comment lines are
# excluded deliberately — the header records the stale uuid on purpose, so that
# somebody reading a future failure knows what it used to be. What must not come
# back is the uuid in executable code.
if grep -v '^[[:space:]]*#' "$DRILL" | grep -q 'zpuyfk3p3nqfpebybbxz6opy'; then
  bad 'no hardcoded database container remains in code' 'the stale uuid is still executable'
else
  ok 'no hardcoded database container remains in code'
fi

if grep -q 'standalone_postgresqls' "$DRILL"; then
  ok 'the container is resolved from Coolify'
else
  bad 'the container is resolved from Coolify' 'no lookup found'
fi

section 'it refuses rather than drilling the wrong thing'

printf 'ERROR' >"$DOCKER_ANSWER"
if run BACKUP_DIR= DB_CONTAINER=; then
  bad 'an unreachable Coolify database is refused' 'it continued'
else
  if grep -qF 'could not resolve' "$WORK/out"; then
    ok 'an unreachable Coolify database is refused'
  else
    bad 'an unreachable Coolify database is refused' "$(tail -2 "$WORK/out")"
  fi
fi

printf '' >"$DOCKER_ANSWER"
if run BACKUP_DIR= DB_CONTAINER=; then
  bad 'an empty answer is refused, not treated as a container name' 'it continued'
else
  ok 'an empty answer is refused, not treated as a container name'
fi

# A database with no scheduled backup has nothing to restore, and the drill has
# to say that rather than reporting a missing dump as a failed restore.
printf 'bea6ac92holn5k6vjgopy2ai' >"$DOCKER_ANSWER"
if run BACKUP_DIR= DB_CONTAINER=; then
  bad 'a database with no backup directory is refused by name' 'it continued'
else
  if grep -qF 'no scheduled backup' "$WORK/out"; then
    ok 'a database with no backup directory is refused by name'
  else
    bad 'a database with no backup directory is refused by name' "$(tail -2 "$WORK/out")"
  fi
fi

section 'the environment argument'

printf 'x' >"$DOCKER_ANSWER"
DRILL_ENV=nonsense
if run BACKUP_DIR= DB_CONTAINER=; then
  bad 'an unknown environment is refused' 'it continued'
else
  ok 'an unknown environment is refused'
fi
DRILL_ENV=production

# Staging maps to Coolify's `dev-fleet`, which is the name the panel uses and
# not the word anybody would guess.
if grep -q "dev-fleet" "$DRILL"; then
  ok 'staging maps to the dev-fleet environment Coolify actually has'
else
  bad 'staging maps to the dev-fleet environment Coolify actually has' 'no mapping found'
fi

section 'the restore protocol cleans up and writes durable proof'

FULL="$WORK/full"
BACKUPS="$FULL/backups"
MIGRATIONS="$FULL/migrations"
mkdir -p "$BACKUPS" "$MIGRATIONS"
printf '%s\n' 'select 1;' >"$MIGRATIONS/0001_test.sql"
printf '%s\n' 'select 1;' >"$MIGRATIONS/verify_invariants.sql"
MIGRATION_CHECKSUM=$(sha256sum "$MIGRATIONS/0001_test.sql" | cut -d' ' -f1)
export MIGRATION_CHECKSUM
DUMP="$BACKUPS/staging-$(date +%s).dmp"
printf 'fake custom-format dump\n' >"$DUMP"

run_full() { # state-dir [extra env...]
  local state=$1
  shift
  mkdir -p "$state"
  : >"$FULL_LOG"
  run \
    FAKE_FULL=1 \
    FULL_LOG="$FULL_LOG" \
    BACKUP_DIR="$BACKUPS" \
    DB_CONTAINER=staging-db \
    STATE_DIR="$state" \
    MIGRATIONS_DIR="$MIGRATIONS" \
    INVARIANTS="$MIGRATIONS/verify_invariants.sql" \
    SCRATCH=restore_test_scratch \
    "$@"
}
FULL_LOG="$FULL/docker.log"
export FULL_LOG

STATE_OK="$FULL/state-ok"
if run_full "$STATE_OK"; then
  if (cd "$STATE_OK" && sha256sum -c restore-attestation.sha256 >/dev/null) &&
     grep -qx 'environment=production' "$STATE_OK/restore-attestation.env" &&
     grep -qx 'migration_set_exact=yes' "$STATE_OK/restore-attestation.env" &&
     grep -qx 'migration_checksums=pass' "$STATE_OK/restore-attestation.env" &&
     grep -qx 'invariants=pass' "$STATE_OK/restore-attestation.env" &&
     grep -qx 'scratch_dropped=yes' "$STATE_OK/restore-attestation.env"; then
    ok 'a successful drill writes checksummed, non-secret evidence'
  else
    bad 'a successful drill writes checksummed, non-secret evidence' "$(cat "$WORK/out")"
  fi
else
  bad 'a successful drill writes checksummed, non-secret evidence' "$(tail -10 "$WORK/out")"
fi

if [ "$(grep -c 'DROP DATABASE IF EXISTS restore_test_scratch' "$FULL_LOG")" -ge 2 ]; then
  ok 'success drops stale scratch before restore and the restored scratch afterwards'
else
  bad 'success drops stale scratch before restore and the restored scratch afterwards' "$(cat "$FULL_LOG")"
fi

STATE_FAIL="$FULL/state-fail"
if run_full "$STATE_FAIL" FAIL_RESTORE=1; then
  bad 'a failed pg_restore is refused' 'the drill returned success'
else
  if [ "$(grep -c 'DROP DATABASE IF EXISTS restore_test_scratch' "$FULL_LOG")" -ge 2 ] &&
     [ ! -e "$STATE_FAIL/restore-attestation.env" ]; then
    ok 'a failed pg_restore removes scratch and writes no attestation'
  else
    bad 'a failed pg_restore removes scratch and writes no attestation' "$(cat "$FULL_LOG")"
  fi
fi

STATE_EXTRA="$FULL/state-extra"
if run_full "$STATE_EXTRA" LEDGER_EXTRA=1; then
  bad 'an extra ledger migration not shipped with the drill is refused' 'the drill returned success'
else
  if grep -qF 'filename sets differ' "$WORK/out" &&
     [ "$(grep -c 'DROP DATABASE IF EXISTS restore_test_scratch' "$FULL_LOG")" -ge 2 ] &&
     [ ! -e "$STATE_EXTRA/restore-attestation.env" ]; then
    ok 'an extra ledger migration is refused, cleaned up and not attested'
  else
    bad 'an extra ledger migration is refused, cleaned up and not attested' "$(cat "$WORK/out")"
  fi
fi

if run \
  FAKE_FULL=1 \
  FULL_LOG="$FULL_LOG" \
  BACKUP_DIR="$BACKUPS" \
  DB_CONTAINER=staging-db \
  STATE_DIR="$STATE_OK" \
  MIGRATIONS_DIR="$MIGRATIONS" \
  SCRATCH='unsafe-name'; then
  bad 'an unsafe scratch database name is refused before Docker' 'the drill returned success'
else
  if grep -qF 'unsafe scratch database name' "$WORK/out"; then
    ok 'an unsafe scratch database name is refused before Docker'
  else
    bad 'an unsafe scratch database name is refused before Docker' "$(cat "$WORK/out")"
  fi
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
