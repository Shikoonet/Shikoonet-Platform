#!/usr/bin/env bash
# The fixture world the rehearsal runs in, shared by every test that drives the
# real script. Kept in one file so the subject-separation tests and the
# publication tests cannot drift into testing two different rehearsals.
#
# Nothing here relaxes a guard. The fixtures are made to satisfy the real
# ownership and mode checks — inside a user namespace, which maps this user to
# root so `stat -c %U` answers honestly — rather than the checks being softened
# to accept the fixtures.

# These tests exercise guards that require root ownership — of the config, of
# the release lock, of the checkout. The guards are right to require it, so the
# tests acquire root rather than the guards being relaxed to accept a fixture.
#
# A user namespace is the cheap way and is what runs locally. Ubuntu 24.04
# restricts unprivileged namespaces under AppArmor, so a CI runner may refuse
# it; there, passwordless sudo on an ephemeral runner is the fallback. If
# neither works the tests FAIL rather than skip: a suite that quietly does
# nothing is worse than one that is red, because it reports as evidence.
rehearsal_become_root() { # "$0" "$@"
  [ "$(id -u)" -ne 0 ] || return 0
  if unshare -Ur true 2>/dev/null; then
    exec unshare -Ur bash "$@"
  fi
  if sudo -n true 2>/dev/null; then
    exec sudo -n -E bash "$@"
  fi
  echo "this suite needs root, through an unprivileged user namespace or" >&2
  echo "passwordless sudo, and neither is available here. It is not skipped." >&2
  exit 1
}

# ── the world the rehearsal expects ──────────────────────────────────────
build_world() { # root  [script-override]
  local w=$1 i
  mkdir -p "$w"/{etc,state,repo/migrations,d1,backups,art,bin,lock,tmp}
  # 34 applied in production, 37 in the repository: the pending range is three.
  for i in $(seq 1 37); do
    printf 'select 1;\n' >"$w/repo/migrations/$(printf '%04d' "$i")_m.sql"
  done
  printf -- '-- verify_invariants\nselect 1;\n' >"$w/repo/migrations/verify_invariants.sql"
  printf 'lock\n' >"$w/repo/pnpm-lock.yaml"
  ( cd "$w/repo" && git init -q -b main . && git config user.email t@t && git config user.name t &&
    git remote add origin https://github.com/Shikoonet/Shikoonet-Platform.git &&
    git add -A && git commit -qm x ) >/dev/null 2>&1
  # The checkout must be at MAIN_SHA; the fake GitHub is told what git says.
  SHA=$(git -C "$w/repo" rev-parse HEAD)
  # This host's umask is 002, which leaves group-writable files behind; the
  # secure-file guards are right to refuse those, so the fixture is made to
  # look like a real checkout rather than the guard made to tolerate one.
  find "$w/repo" -type d -exec chmod 755 {} + 2>/dev/null
  find "$w/repo" -type f -exec chmod 644 {} + 2>/dev/null

  # The D1 export, with the provenance sidecar its generator writes.
  local t
  while read -r t; do
    printf '[{"id":1}]\n' >"$w/d1/${t}.json"
  done <"$ROOT/deploy/d1-tables.manifest"
  printf 'dump\n' >"$w/dump.sql"
  python3 "$ROOT/tools/d1-export-manifest.py" "$w/d1" "$w/dump.sql" \
    "$ROOT/deploy/d1-tables.manifest" >/dev/null
  chmod 755 "$w/d1"; chmod 640 "$w"/d1/*.json "$w/d1/d1-export.manifest"

  # Coolify's own backup location, and the directory the config names: the
  # canonical comparison has to see the same inode from both sides.
  mkdir -p "$w/backups/prod-$FAKE_PROD_DB_UUID"
  printf 'dmp\n' >"$w/backups/prod-$FAKE_PROD_DB_UUID/b.dmp"
  chmod 640 "$w/backups/prod-$FAKE_PROD_DB_UUID/b.dmp"

  cat >"$w/etc/rehearsal.env" <<CONF
MIRZABOT_DUMP=$w/dump.sql
D1_EXPORT_DIR=$w/d1
REPO_DIR=$w/repo
GITHUB_TOKEN=ghp_faketokenfortests000000000000000000
PROD_BACKUP_DIR=$w/backups/prod-$FAKE_PROD_DB_UUID
PG_IMAGE=postgres@sha256:$(printf '%064d' 1 | tr '0' 'd')
MYSQL_IMAGE=mysql@sha256:$(printf '%064d' 1 | tr '0' 'e')
NODE_IMAGE=node@sha256:$(printf '%064d' 1 | tr '0' 'f')
CONF
  chmod 640 "$w/etc/rehearsal.env"; chmod 755 "$w/etc"
  cat >"$w/etc/deploy.env" <<DCONF
APP_INGEST=$FAKE_UUID_INGEST
APP_DASHBOARD=$FAKE_UUID_DASHBOARD
APP_BOT=$FAKE_UUID_BOT
DCONF
  chmod 640 "$w/etc/deploy.env"
  : >"$w/lock/release.lock"; chmod 660 "$w/lock/release.lock"

  cp "$HERE/fake/docker" "$HERE/fake/curl" "$w/bin/"
  # The script under test, so a mutation is applied to a copy and never to the
  # repository's own file.
  cp "${2:-$ROOT/deploy/production-dump-rehearsal.sh}" "$w/bin/rehearsal.sh"
  cp "$ROOT/deploy/rehearsal-lib.sh" "$ROOT/deploy/attestation-store.sh" \
     "$ROOT/deploy/write-dump-attestation.sh" "$ROOT/deploy/verify-dump-attestation.sh" \
     "$ROOT/deploy/verify-release-manifest.sh" \
     "$ROOT/deploy/d1-tables.manifest" "$w/bin/"
  chmod 644 "$w/bin/d1-tables.manifest"
}

# One run of the real orchestration inside a user namespace, which is what
# lets the genuine root-ownership guards run unmodified against files this
# test owns. Nothing here relaxes a check to make the test pass.
run_rehearsal() { # world -> exit code; stdout+stderr in $world/out
  local w=$1
  # Already inside a namespace when the caller made one; nesting is neither
  # needed nor permitted.
  local NS=(unshare -Ur)
  [ "$(id -u)" -ne 0 ] || NS=()
  # shellcheck disable=SC2016  # $1/$2 are the inner shell's positionals, not ours
  "${NS[@]}" env \
    PATH="$w/bin:/usr/bin:/bin" \
    TMPDIR="$w/tmp" \
    REHEARSAL_CONF="$w/etc/rehearsal.env" \
    DEPLOY_CONF="$w/etc/deploy.env" \
    STATE="$w/state" \
    BACKUP_ROOT="$w/backups" \
    D1_MANIFEST="$w/bin/d1-tables.manifest" \
    ATT_LOCK="$w/lock/release.lock" \
    ATT_LOCK_GROUP=root \
    FAKE_LOG="$w/log" FAKE_STATE="$w/state" \
    FAKE_MAIN_SHA="$SHA" FAKE_DIGEST="$DIGEST" \
    FAKE_PROD_DB_UUID="$FAKE_PROD_DB_UUID" FAKE_STAGING_DB_UUID="$FAKE_STAGING_DB_UUID" \
    FAKE_UUID_INGEST="$FAKE_UUID_INGEST" FAKE_UUID_DASHBOARD="$FAKE_UUID_DASHBOARD" \
    FAKE_UUID_BOT="$FAKE_UUID_BOT" \
    FAKE_PROD_LEDGER="${FAKE_PROD_LEDGER:-34}" FAKE_FULL_LEDGER="${FAKE_FULL_LEDGER:-37}" \
    FAKE_VITEST_RC="${FAKE_VITEST_RC:-0}" FAKE_RESTORE_RC="${FAKE_RESTORE_RC:-0}" \
    FAKE_GH_STATUS="${FAKE_GH_STATUS:-200}" \
    FAKE_LEDGER_DRIFT="${FAKE_LEDGER_DRIFT:-0}" \
    bash -c 'cd "$1" && exec bash "$2"' _ "$w/repo" "$w/bin/rehearsal.sh" >"$w/out" 2>&1
}

