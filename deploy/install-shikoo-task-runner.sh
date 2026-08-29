#!/usr/bin/env bash
# Install the staging task runner. Small on purpose, so it can be read.
#
# ─────────────────────────────────────────────────────────────────────────────
# An earlier version of this carried its payload as 117 KB of embedded base64
# with a self-checksum. That was wrong, and the reason is worth keeping: a
# self-checksum proves a file is internally consistent, not that anybody
# reviewed what is inside it. Something that runs as root has to be readable in
# the pull request that introduces it, and reviewed there.
#
# So this installs from a staged directory and hard-codes the one hash that
# makes that safe — the manifest's — while the manifest itself is version
# controlled beside this file. Nothing is copied that the manifest does not
# name, and nothing is copied that does not match its recorded hash.
#
# ── What this grants ──────────────────────────────────────────────────────
#
# hessamx may run /usr/local/sbin/shikoo-task-runner as root with one of eight
# fixed subcommands and no arguments of their own. Not a shell, not an
# interpreter, not sudo -u with a chosen command, not docker, not systemctl,
# not a wildcard.
#
# ── Before it touches sudoers ────────────────────────────────────────────
#
# It backs up every target it will replace and arms a systemd timer that
# restores them in fifteen minutes. A broken /etc/sudoers.d fragment can lock
# an administrator out of sudo, so the machine has to be able to undo this
# without anybody remembering to. The timer is cancelled only after every
# positive AND negative test passes.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: sudo bash deploy/install-shikoo-task-runner.sh [staged-dir]
#
# staged-dir defaults to /home/hessamx/shikoo-owner-step-e and must contain
# exactly the files the manifest names, plus the manifest, the runner and the
# sudoers template.

set -Eeuo pipefail

STAGE=${1:-/home/hessamx/shikoo-owner-step-e}
LIB=/usr/local/lib/shikoo-step-e
BIN=/usr/local/sbin/shikoo-task-runner
SUDOERS=/etc/sudoers.d/90-shikoo-task-runner
GRANTEE=hessamx
RUN_AS=shikoo-deploy
BACKUP=/var/backups/shikoo-task-runner-$(date -u +%Y%m%dT%H%M%SZ)

# The one hard-coded value. Everything else is derived from the manifest it
# pins, and a CI test asserts this still equals
# sha256sum deploy/shikoo-task-runner.manifest.
MANIFEST_SHA256=98a1735d332ee656d4c5f45a2285d04455c0f04ae111004684cdca558a62fc23

say() { echo "[install] $*"; }
die() { echo "[install] FAILED: $*" >&2; exit 1; }

[ "$(id -u)" = '0' ] || die "run this with sudo"
id -u "$GRANTEE" >/dev/null 2>&1 || die "user $GRANTEE does not exist"
id -u "$RUN_AS" >/dev/null 2>&1 || die "user $RUN_AS does not exist"
[ -d "$STAGE" ] || die "staged directory $STAGE does not exist"
[ ! -L "$STAGE" ] || die "$STAGE is a symlink — refusing"

# ── verify the staged bundle, before anything is copied ──────────────────
[ -f "$STAGE/MANIFEST" ] || die "$STAGE/MANIFEST is missing"
[ ! -L "$STAGE/MANIFEST" ] || die "$STAGE/MANIFEST is a symlink — refusing"
actual=$(sha256sum "$STAGE/MANIFEST" | cut -d' ' -f1)
[ "$actual" = "$MANIFEST_SHA256" ] ||
  die "$STAGE/MANIFEST does not match the hash this installer was built against"
say "manifest verified"

# The allowlist IS the manifest, plus the three files that are this mechanism.
# `LC_ALL=C` on both sides: this host's collation makes `sort` and `comm`
# disagree about ordering, and comm then rejects input sort produced.
ALLOWED=$( { awk '{print $2}' "$STAGE/MANIFEST"; printf 'MANIFEST\nshikoo-task-runner\nshikoo-task-runner.sudoers\n'; } | LC_ALL=C sort )

# Extra staged files are refused rather than ignored. Something unexpected in
# the directory a root install copies from is a question, not a rounding error.
# Symlinks are LISTED, not skipped, so the per-file check below names one as a
# symlink instead of reporting it as a missing file. A refusal that describes
# the wrong problem sends the reader to the wrong place.
staged=$(find "$STAGE" \( -type f -o -type l \) -printf '%P\n' | LC_ALL=C sort)
extra=$(LC_ALL=C comm -23 <(printf '%s\n' "$staged") <(printf '%s\n' "$ALLOWED"))
[ -z "$extra" ] || die "unexpected file(s) in $STAGE: $(printf '%s' "$extra" | tr '\n' ' ')"
missing=$(LC_ALL=C comm -13 <(printf '%s\n' "$staged") <(printf '%s\n' "$ALLOWED"))
[ -z "$missing" ] || die "missing file(s) in $STAGE: $(printf '%s' "$missing" | tr '\n' ' ')"

check_staged() { # name
  local p="$STAGE/$1"
  [ -e "$p" ] || die "$p is missing"
  [ ! -L "$p" ] || die "$p is a symlink — refusing"
  [ -f "$p" ] || die "$p is not a regular file"
}
for f in $ALLOWED; do check_staged "$f"; done
( cd "$STAGE" && sha256sum -c --status MANIFEST ) ||
  die "a staged script does not match the manifest"
say "all $(grep -c . "$STAGE/MANIFEST") script(s) match the manifest"

# ── back up every target this will replace ───────────────────────────────
mkdir -p "$BACKUP"
chmod 700 "$BACKUP"
for target in "$BIN" "$SUDOERS"; do
  [ -e "$target" ] || continue
  cp -a "$target" "$BACKUP/$(basename "$target")"
  say "backed up $target"
done
[ ! -d "$LIB" ] || { cp -a "$LIB" "$BACKUP/lib" && say "backed up $LIB"; }

# ── arm the rollback BEFORE sudoers changes ──────────────────────────────
cat >/usr/local/sbin/shikoo-task-runner-rollback <<ROLLBACK
#!/bin/sh
set -eu
rm -f "$SUDOERS" "$BIN"
rm -rf "$LIB"
[ ! -e "$BACKUP/90-shikoo-task-runner" ] || cp -a "$BACKUP/90-shikoo-task-runner" "$SUDOERS"
[ ! -e "$BACKUP/shikoo-task-runner" ] || cp -a "$BACKUP/shikoo-task-runner" "$BIN"
[ ! -d "$BACKUP/lib" ] || cp -a "$BACKUP/lib" "$LIB"
logger -t shikoo-task-runner "automatic rollback executed from $BACKUP"
systemctl disable --now shikoo-task-runner-rollback.timer 2>/dev/null || true
ROLLBACK
chmod 0700 /usr/local/sbin/shikoo-task-runner-rollback

cat >/etc/systemd/system/shikoo-task-runner-rollback.service <<'UNIT'
[Unit]
Description=Undo an unconfirmed shikoo-task-runner installation
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/shikoo-task-runner-rollback
UNIT
cat >/etc/systemd/system/shikoo-task-runner-rollback.timer <<'UNIT'
[Unit]
Description=Undo an unconfirmed shikoo-task-runner installation
[Timer]
OnActiveSec=15min
AccuracySec=10s
[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now shikoo-task-runner-rollback.timer >/dev/null 2>&1 ||
  die "could not arm the rollback timer — refusing to change sudoers without one"
say "rollback armed: everything reverts in 15 minutes unless this run succeeds"

fail_back() { die "$* — the rollback timer will undo this"; }

# ── install, by exact name, never a wildcard ─────────────────────────────
rm -rf "$LIB"
install -d -o root -g root -m 0755 "$LIB"
# `-D` because the manifest names paths, not just basenames: migrations ship
# beside the scripts so the restore drill can check the ledger and the
# invariants, which it cannot do from an installed directory otherwise.
while read -r _ name; do
  [ -n "$name" ] || continue
  install -D -o root -g root -m 0644 "$STAGE/$name" "$LIB/$name"
done <"$STAGE/MANIFEST"
install -o root -g root -m 0644 "$STAGE/MANIFEST" "$LIB/MANIFEST"
install -o root -g root -m 0755 "$STAGE/shikoo-task-runner" "$BIN"
say "installed $LIB and $BIN"

# Installed bytes must equal staged bytes, and nothing may be writable by the
# grantee or by the account the tasks run as.
( cd "$LIB" && sha256sum -c --status MANIFEST ) || fail_back "installed scripts do not match the manifest"
while IFS= read -r f; do
  [ "$(stat -c '%u:%g' "$f")" = '0:0' ] || fail_back "$f is not root:root"
  case "$(stat -c '%a' "$f")" in 644 | 755) ;; *) fail_back "$f has mode $(stat -c '%a' "$f")" ;; esac
done < <(find "$LIB" -type f; printf '%s\n' "$BIN")
say "installed files are root:root and not writable by $GRANTEE or $RUN_AS"

# ── the release lock ─────────────────────────────────────────────────────
#
# Created here, by root, so that neither side has to create it later. That
# matters more than it looks: /var/lock is a symlink to /run/lock, mode 1777,
# so whoever gets there first owns the file. If the rehearsal or Prepare
# created it on demand, an unprivileged local account could create it first
# and then hold it — every release would wait on a lock owned by someone else.
#
# root:shikoo-deploy 0660 is the whole grant. It lets the root rehearsal take
# it exclusively to swap the pointer, and the shikoo-deploy Prepare path take
# it shared to read through the pointer, with no additional sudo rule and no
# world-writable file anywhere in the protocol.
RELEASE_LOCK=/var/lock/shikoo-deploy-production.lock
[ ! -L "$RELEASE_LOCK" ] || fail_back "$RELEASE_LOCK is a symlink — refusing to adopt it"
if [ -e "$RELEASE_LOCK" ] && [ "$(stat -c '%u' "$RELEASE_LOCK")" != '0' ]; then
  fail_back "$RELEASE_LOCK already exists and is not owned by root — someone else created it first"
fi
# Adopted, never replaced — and created atomically when it is absent.
#
# `install ... /dev/null "$RELEASE_LOCK"` writes a NEW inode at that path every
# time, and GNU install unlinks the destination first by design. If a rehearsal
# or a Prepare run is holding flock on the old inode it keeps holding it, while
# everything that opens the path afterwards locks a different file: the mutual
# exclusion disappears with no error anywhere.
#
# `if [ ! -e ] ... install` fixed that but introduced two of its own. The test
# and the create are separate steps, so two installs can both see it absent;
# and `-e` follows symlinks, so a symlink planted at that path would take the
# `else` branch and chown/chmod its TARGET. `set -C` makes the create fail if
# anything already exists at the path — one syscall, O_EXCL — and the symlink
# case is refused above rather than followed.
if [ -L "$RELEASE_LOCK" ]; then
  fail_back "$RELEASE_LOCK is a symlink — refusing to adopt or replace it"
fi
if ( set -C; : >"$RELEASE_LOCK" ) 2>/dev/null; then
  say "created $RELEASE_LOCK"
else
  # It already existed. Adopt it only if it is a regular file — never a
  # symlink, a directory, or a device — AND only if it was already root's.
  #
  # A local account can create and flock a regular file in the window between
  # the symlink check and this create. Adopting it would chown their file to
  # root while they keep the lock, and every task-runner command afterwards
  # would block at `flock -n` until root noticed and repaired it. Ownership is
  # therefore checked BEFORE chown, not asserted after it.
  if [ ! -f "$RELEASE_LOCK" ] || [ -L "$RELEASE_LOCK" ]; then
    fail_back "$RELEASE_LOCK exists and is not a regular file"
  fi
  lock_owner=$(stat -c '%u' "$RELEASE_LOCK")
  [ "$lock_owner" = '0' ] ||
    fail_back "$RELEASE_LOCK already exists and is owned by uid ${lock_owner}, not root — someone else created it; remove it by hand once you know no release holds it"
  say "adopting the existing root-owned $RELEASE_LOCK (a holder's flock stays valid)"
fi
chown root:"$RUN_AS" "$RELEASE_LOCK"
chmod 0660 "$RELEASE_LOCK"
[ "$(stat -c '%U:%G:%a' "$RELEASE_LOCK")" = "root:$RUN_AS:660" ] ||
  fail_back "$RELEASE_LOCK is not root:$RUN_AS 0660 after installation"
say "release lock $RELEASE_LOCK is root:$RUN_AS 0660"

# ── sudoers ──────────────────────────────────────────────────────────────
TMP_SUDO=$(mktemp)
cp "$STAGE/shikoo-task-runner.sudoers" "$TMP_SUDO"
visudo -cf "$TMP_SUDO" >/dev/null || fail_back "the sudoers fragment does not validate"
install -o root -g root -m 0440 "$TMP_SUDO" "$SUDOERS"
rm -f "$TMP_SUDO"
visudo -cf "$SUDOERS" >/dev/null || fail_back "the installed fragment does not validate"
visudo -cf /etc/sudoers >/dev/null || fail_back "/etc/sudoers no longer validates"
say "sudoers validated"

# ── prove it works, and only the way it should ───────────────────────────
runas_grantee() { sudo -n -u "$GRANTEE" "$@"; }

runas_grantee sudo -n "$BIN" status >/dev/null 2>&1 ||
  fail_back "$GRANTEE cannot run the permitted 'status' command"
say "positive: $GRANTEE can run 'status'"

# Negative tests. Each of these succeeding would mean the grant is wider than
# it reads, which is the failure this whole shape exists to prevent.
! runas_grantee sudo -n "$BIN" status extra >/dev/null 2>&1 ||
  fail_back "an extra argument was accepted"
! runas_grantee sudo -n "$BIN" not-a-subcommand >/dev/null 2>&1 ||
  fail_back "an arbitrary subcommand was accepted"
! runas_grantee sudo -n "$BIN" restore-drill-production >/dev/null 2>&1 ||
  fail_back "a production form of the drill was accepted"
! runas_grantee sudo -n /bin/bash -c true >/dev/null 2>&1 ||
  fail_back "$GRANTEE gained a passwordless shell"
! runas_grantee sudo -n /bin/sh -c true >/dev/null 2>&1 ||
  fail_back "$GRANTEE gained a passwordless shell"
! runas_grantee sudo -n /usr/bin/id >/dev/null 2>&1 ||
  fail_back "$GRANTEE gained passwordless sudo for an arbitrary binary"
say "negative: extra arguments, unknown subcommands, production forms and shells all refused"

# ── success: stand the rollback down ─────────────────────────────────────
systemctl disable --now shikoo-task-runner-rollback.timer >/dev/null 2>&1 || true
rm -f /etc/systemd/system/shikoo-task-runner-rollback.timer \
      /etc/systemd/system/shikoo-task-runner-rollback.service \
      /usr/local/sbin/shikoo-task-runner-rollback
systemctl daemon-reload

say "done. Backups of anything replaced are in $BACKUP"
say ""
say "verify (read-only):"
say "  sudo -n $BIN status"
say "  sudo -l -U $GRANTEE | sed -n '/shikoo-task-runner/p'"
say "revoke when finished:"
say "  sudo -n $BIN revoke-access"
