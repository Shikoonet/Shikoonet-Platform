#!/usr/bin/env bash
# The restore drill has to find the database before it can prove anything.
#
# Its defaults named `zpuyfk3p3nqfpebybbxz6opy`, a container that does not exist
# on this host — the databases are `qd2vduj7kv05sp9ejdrmclmu` and
# `bea6ac92holn5k6vjgopy2ai`. So the drill would have died on its first docker
# exec, which is the worst way for a backup verifier to fail: it never ran, and
# nothing anywhere said the backups were therefore unverified.
#
# These cases are about target resolution and its refusals. The restore itself
# needs a real dump and root, and is the owner's command.

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
cat >"$BIN/docker" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
a=\$(cat "$DOCKER_ANSWER" 2>/dev/null || true)
[ "\$a" = 'ERROR' ] && exit 1
printf '%s\n' "\$a"
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

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
