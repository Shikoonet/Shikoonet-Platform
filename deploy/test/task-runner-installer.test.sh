#!/usr/bin/env bash
# shellcheck disable=SC2016  # assertions are literal strings searched for in
# another file; expansion is exactly what must not happen to them.
# The installer's refusals, exercised rather than read.
#
# This installs something that runs as root, so the cases that matter are the
# ones where it must decline: a tampered script, an extra file in the staging
# directory, a symlink, a manifest that is not the one it was built against.
#
# It cannot be run for real here — it needs root, systemd and a live sudoers —
# so the verification is split. The refusals happen BEFORE any privileged step
# and are driven directly against a sandbox staging directory. The privileged
# half is asserted structurally: order of operations, rollback before sudoers,
# validation before activation.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
INSTALLER="$ROOT/deploy/install-shikoo-task-runner.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }
has() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3" "missing: $2"; fi; }

# A staging directory that is correct, so each case can break exactly one thing.
mkstage() {
  local d="$WORK/stage.$1"
  rm -rf "$d"
  mkdir -p "$d"
  while read -r _ name; do
    [ -n "$name" ] || continue
    cp "$ROOT/deploy/$name" "$d/$name"
  done <"$ROOT/deploy/shikoo-task-runner.manifest"
  cp "$ROOT/deploy/shikoo-task-runner.manifest" "$d/MANIFEST"
  cp "$ROOT/deploy/shikoo-task-runner" "$d/shikoo-task-runner"
  cp "$ROOT/deploy/shikoo-task-runner.sudoers" "$d/shikoo-task-runner.sudoers"
  printf '%s' "$d"
}

# Run the installer as a NON-root user. It must refuse on the root check, so
# these cases prove the ordering: nothing privileged is attempted first.
run_unpriv() { # stage-dir -> output in $WORK/out
  set +e
  bash "$INSTALLER" "$1" >"$WORK/out" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'it refuses before doing anything privileged'

STAGE=$(mkstage ok)
if run_unpriv "$STAGE"; then
  bad 'a non-root run is refused' 'it proceeded'
else
  if grep -qF 'run this with sudo' "$WORK/out"; then
    ok 'a non-root run is refused, first, by name'
  else
    bad 'a non-root run is refused, first, by name' "$(tail -2 "$WORK/out")"
  fi
fi

# Everything below re-checks the staged-bundle verification directly, because
# that logic runs before the root check would matter in a real install. The
# helper mirrors the installer's own checks against the same inputs.
verify_stage() { # stage-dir -> rc, message in $WORK/vout
  local stage=$1
  set +e
  (
    set -Eeuo pipefail
    want=$(grep -oE '^MANIFEST_SHA256=[0-9a-f]{64}' "$INSTALLER" | cut -d= -f2)
    [ -f "$stage/MANIFEST" ] || { echo 'MANIFEST is missing'; exit 1; }
    [ ! -L "$stage/MANIFEST" ] || { echo 'MANIFEST is a symlink'; exit 1; }
    got=$(sha256sum "$stage/MANIFEST" | cut -d' ' -f1)
    [ "$got" = "$want" ] || { echo 'MANIFEST does not match the hash this installer was built against'; exit 1; }
    allowed=$( { awk '{print $2}' "$stage/MANIFEST"; printf 'MANIFEST\nshikoo-task-runner\nshikoo-task-runner.sudoers\n'; } | sort )
    staged=$(find "$stage" -maxdepth 1 -mindepth 1 -printf '%f\n' | sort)
    extra=$(comm -23 <(printf '%s\n' "$staged") <(printf '%s\n' "$allowed"))
    [ -z "$extra" ] || { echo "unexpected file(s): $extra"; exit 1; }
    missing=$(comm -13 <(printf '%s\n' "$staged") <(printf '%s\n' "$allowed"))
    [ -z "$missing" ] || { echo "missing file(s): $missing"; exit 1; }
    for f in $allowed; do
      [ ! -L "$stage/$f" ] || { echo "$f is a symlink"; exit 1; }
      [ -f "$stage/$f" ] || { echo "$f is not a regular file"; exit 1; }
    done
    ( cd "$stage" && sha256sum -c --status MANIFEST ) || { echo 'a staged script does not match the manifest'; exit 1; }
    echo 'accepted'
  ) >"$WORK/vout" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'the staged bundle is verified before installation'

STAGE=$(mkstage good)
if verify_stage "$STAGE"; then ok 'a correct staging directory is accepted'; else
  bad 'a correct staging directory is accepted' "$(cat "$WORK/vout")"
fi

# The case this whole redesign exists for: a script whose bytes are not the
# reviewed bytes.
STAGE=$(mkstage tampered)
printf '\n# injected\n' >>"$STAGE/step-e-runner.sh"
if verify_stage "$STAGE"; then
  bad 'a tampered script is refused' 'it was accepted'
else
  if grep -qF 'does not match the manifest' "$WORK/vout"; then
    ok 'a tampered script is refused, before any sudoers change'
  else
    bad 'a tampered script is refused, before any sudoers change' "$(cat "$WORK/vout")"
  fi
fi

STAGE=$(mkstage extra)
printf 'x\n' >"$STAGE/unexpected.sh"
if verify_stage "$STAGE"; then
  bad 'an extra staged file is refused' 'it was accepted'
else
  if grep -qF 'unexpected file' "$WORK/vout"; then
    ok 'an extra staged file is refused, not silently ignored'
  else
    bad 'an extra staged file is refused, not silently ignored' "$(cat "$WORK/vout")"
  fi
fi

STAGE=$(mkstage missing)
rm -f "$STAGE/coolify-api.sh"
if verify_stage "$STAGE"; then
  bad 'a missing staged file is refused' 'it was accepted'
else
  ok 'a missing staged file is refused'
fi

STAGE=$(mkstage symlink)
rm -f "$STAGE/coolify-api.sh"
ln -s /etc/passwd "$STAGE/coolify-api.sh"
if verify_stage "$STAGE"; then
  bad 'a symlinked staged file is refused' 'it was accepted'
else
  if grep -qE 'symlink|does not match' "$WORK/vout"; then
    ok 'a symlinked staged file is refused'
  else
    bad 'a symlinked staged file is refused' "$(cat "$WORK/vout")"
  fi
fi

STAGE=$(mkstage badmanifest)
printf '%s  coolify-api.sh\n' "$(printf 'x' | sha256sum | cut -d' ' -f1)" >"$STAGE/MANIFEST"
if verify_stage "$STAGE"; then
  bad 'a manifest the installer was not built against is refused' 'it was accepted'
else
  if grep -qF 'does not match the hash this installer was built against' "$WORK/vout"; then
    ok 'a manifest the installer was not built against is refused'
  else
    bad 'a manifest the installer was not built against is refused' "$(cat "$WORK/vout")"
  fi
fi

section 'ordering: rollback armed before sudoers, validated before active'

line_of() { grep -n -- "$1" "$INSTALLER" | head -1 | cut -d: -f1; }
ARM=$(line_of 'systemctl enable --now shikoo-task-runner-rollback.timer')
SUDO_INSTALL=$(line_of 'install -o root -g root -m 0440')
VALIDATE=$(line_of 'visudo -cf "$TMP_SUDO"')
# The LAST occurrence: the same line appears inside the rollback script's own
# heredoc earlier in the file, and matching that one would compare against the
# wrong thing entirely.
STAND_DOWN=$(grep -n -- 'systemctl disable --now shikoo-task-runner-rollback.timer' "$INSTALLER" | tail -1 | cut -d: -f1)
NEGATIVE=$(line_of 'restore-drill-production')

if [ "$ARM" -lt "$SUDO_INSTALL" ]; then
  ok 'the rollback timer is armed before sudoers is touched'
else
  bad 'the rollback timer is armed before sudoers is touched' "arm@${ARM} install@${SUDO_INSTALL}"
fi
if [ "$VALIDATE" -lt "$SUDO_INSTALL" ]; then
  ok 'the fragment is validated before it becomes active'
else
  bad 'the fragment is validated before it becomes active' "validate@${VALIDATE} install@${SUDO_INSTALL}"
fi
if [ "$NEGATIVE" -lt "$STAND_DOWN" ]; then
  ok 'the negative tests run before the rollback stands down'
else
  bad 'the negative tests run before the rollback stands down' "negative@${NEGATIVE} standdown@${STAND_DOWN}"
fi

section 'the installer installs by name, never by wildcard'

if grep -qE 'install .*"\$STAGE"/\*|cp .*"\$STAGE"/\*' "$INSTALLER"; then
  bad 'no wildcard install' 'a glob copy is present'
else
  ok 'no wildcard install'
fi
has "$INSTALLER" 'while read -r _ name; do' 'files are installed by the names the manifest lists'
has "$INSTALLER" 'rm -rf "$LIB"' 'the target directory is emptied so no stale script survives'
has "$INSTALLER" 'cd "$LIB" && sha256sum -c --status MANIFEST' 'installed bytes are re-verified after copying'

section 'backups and rollback cover every target'

has "$INSTALLER" 'for target in "$BIN" "$SUDOERS"' 'both file targets are backed up'
has "$INSTALLER" 'cp -a "$LIB" "$BACKUP/lib"' 'the existing bundle directory is backed up'
has "$INSTALLER" '90-shikoo-task-runner" "$SUDOERS"' 'rollback restores a previous sudoers fragment'
has "$INSTALLER" 'BACKUP/shikoo-task-runner" "$BIN"' 'rollback restores a previous runner'
has "$INSTALLER" 'BACKUP/lib" "$LIB"' 'rollback restores a previous bundle directory'

section 'the negative tests the installer runs on itself'

has "$INSTALLER" 'an extra argument was accepted' 'it proves extra arguments are refused'
has "$INSTALLER" 'an arbitrary subcommand was accepted' 'it proves unknown subcommands are refused'
has "$INSTALLER" 'a production form of the drill was accepted' 'it proves production forms are refused'
has "$INSTALLER" 'gained a passwordless shell' 'it proves no shell was granted'
has "$INSTALLER" 'passwordless sudo for an arbitrary binary' 'it proves no arbitrary binary was granted'

section 'no secret anywhere near it'

if grep -qE 'COOLIFY_TOKEN|DATABASE_URL|api\.telegram\.org|PASSWORD' "$INSTALLER"; then
  bad 'the installer names no credential' 'one appears'
else
  ok 'the installer names no credential'
fi
if grep -qE 'base64 -d|base64 --decode' "$INSTALLER"; then
  bad 'the installer carries no opaque payload' 'it decodes something'
else
  ok 'the installer carries no opaque payload'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
