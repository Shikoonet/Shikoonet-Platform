#!/usr/bin/env bash
# The attestation store: one pointer, one lock protocol, one reader.
#
# What this replaces. Publication used to activate a versioned directory by
# swapping `attestation/current`, and then — separately, after the swap —
# copy `attestation.env` and `attestation.sha256` up into the flat directory
# and rename them one after the other. Three things were wrong with that:
#
#   1. Two renames are two events. A reader between them sees the new `.env`
#      beside the old `.sha256`: a mixed pair that verifies against neither.
#   2. Those copies happened AFTER the pointer swap, so a failure there turned
#      an already-successful activation into a failed run, and left the flat
#      pair describing a different release than `current` did.
#   3. The flat pair was a second, independently writable copy of the same
#      fact. Two sources of truth is none.
#
# So the flat pair is gone. `current` is a symlink to an immutable version
# directory, and a symlink swap by `mv -T` is one inode operation: a reader
# following it gets the whole old version or the whole new one. There is no
# state in which half of an attestation is visible, because there is no
# second file to get out of step.
#
# Readers resolve THROUGH the pointer and never name a version directory
# directly, so "the current attestation" has exactly one answer at any moment.

# ── the lock ──────────────────────────────────────────────────────────────
#
# `/var/lock` is a sticky world-writable directory on this host — it is a
# symlink to `/run/lock`, mode 1777. Anyone can create a file there. If the
# lock file does not already exist, an attacker creates it first, owns it, and
# the "shared" lock silently becomes a lock on a file they control: they can
# hold it forever (deadlocking every release) and root would wait politely.
#
# The path stays where it is documented, but it is no longer trusted on faith.
# The installer creates it root-owned, group `shikoo-deploy`, 0660 — which is
# what lets the root rehearsal and the group's Prepare path share one lock
# without either needing more sudo — and every user validates that before
# flocking it. A lock file that is not exactly that is refused, not adopted.
ATT_LOCK=${ATT_LOCK:-/var/lock/shikoo-deploy-production.lock}
ATT_LOCK_GROUP=${ATT_LOCK_GROUP:-shikoo-deploy}
ATT_LOCK_WAIT=${ATT_LOCK_WAIT:-120}

att_require_lock_file() {
  local mode owner group
  [ ! -L "$ATT_LOCK" ] || { echo "[att] ${ATT_LOCK} is a symlink — refusing" >&2; return 1; }
  [ -f "$ATT_LOCK" ] || { echo "[att] ${ATT_LOCK} does not exist; the installer creates it" >&2; return 1; }
  mode=$(stat -c '%a' "$ATT_LOCK" 2>/dev/null) || return 1
  owner=$(stat -c '%U' "$ATT_LOCK" 2>/dev/null) || return 1
  group=$(stat -c '%G' "$ATT_LOCK" 2>/dev/null) || return 1
  [ "$owner" = root ] ||
    { echo "[att] ${ATT_LOCK} is owned by ${owner}, not root — refusing" >&2; return 1; }
  [ "$group" = "$ATT_LOCK_GROUP" ] ||
    { echo "[att] ${ATT_LOCK} is group ${group}, not ${ATT_LOCK_GROUP} — refusing" >&2; return 1; }
  case "$mode" in
    660) ;;
    *) echo "[att] ${ATT_LOCK} is mode ${mode}, not 660 — refusing" >&2; return 1 ;;
  esac
  return 0
}

# Exclusive: the publisher, for the pointer swap alone.
att_lock_exclusive() {
  att_require_lock_file || return 1
  exec 8>>"$ATT_LOCK" || return 1
  flock -w "$ATT_LOCK_WAIT" 8 || { echo "[att] another release step holds ${ATT_LOCK}" >&2; return 1; }
  return 0
}

# Shared: every reader. Concurrent verification does not serialise against
# other verification, only against an in-flight swap.
att_lock_shared() {
  att_require_lock_file || return 1
  exec 8>>"$ATT_LOCK" || return 1
  flock -s -w "$ATT_LOCK_WAIT" 8 || { echo "[att] timed out waiting for ${ATT_LOCK}" >&2; return 1; }
  return 0
}

# `exec 8>&- 2>/dev/null` — which is what this was — does not redirect stderr
# for that one command. `exec` with redirections and no command changes the
# SHELL's own file descriptors, permanently: every later error message in the
# publisher went to /dev/null, including the one explaining why a pointer swap
# had just failed. The redirection has to stay off the exec.
att_unlock() {
  flock -u 8 2>/dev/null || true
  exec 8>&- || true
}

# ── resolution ────────────────────────────────────────────────────────────
#
# The one way to answer "which attestation is current". Prints the resolved
# version directory; every caller reads its files from there and nowhere else.
att_resolve() { # attest_dir
  local dir=$1 cur
  [ -n "$dir" ] || { echo "[att] no attestation directory given" >&2; return 1; }
  [ -L "$dir/current" ] || {
    echo "[att] ${dir}/current is not a pointer — no attestation has been activated" >&2
    return 1
  }
  cur=$(readlink -f -- "$dir/current" 2>/dev/null) || cur=''
  if [ -z "$cur" ] || [ ! -d "$cur" ]; then
    echo "[att] ${dir}/current does not resolve to a version directory" >&2
    return 1
  fi
  if [ ! -r "$cur/attestation.env" ] || [ ! -r "$cur/attestation.sha256" ]; then
    echo "[att] the current version directory is incomplete" >&2
    return 1
  fi
  printf '%s\n' "$cur"
}

# Resolve and prove intact, under the shared lock, as one operation. This is
# what a reader wants: never the pointer on its own.
att_read() { # attest_dir  → prints version dir
  local dir=$1 cur rc=0
  att_lock_shared || return 1
  cur=$(att_resolve "$dir") || rc=1
  if [ "$rc" -eq 0 ]; then
    ( cd "$cur" && sha256sum -c --status attestation.sha256 ) || {
      echo "[att] the current attestation does not match its own checksum" >&2
      rc=1
    }
  fi
  att_unlock
  [ "$rc" -eq 0 ] || return 1
  printf '%s\n' "$cur"
}

# ── publication ───────────────────────────────────────────────────────────
#
# Order is the whole design, and it is not negotiable:
#
#   1. the version directory is built and closed
#   2. its checksum and its release values are verified   ← every fallible step
#   3. the lock is taken
#   4. the pointer is swapped                              ← one inode operation
#   5. the lock is released
#
# Nothing fallible happens after step 4. That is what makes a successful
# activation final: there is no later operation left that could fail and
# report the run as unsuccessful while the new attestation is already live.
att_publish() { # attest_dir version_dir expected_main_sha expected_digest
  local dir=$1 ver=$2 want_sha=$3 want_digest=$4 got

  [ -d "$ver" ] || { echo "[att] ${ver} is not a directory" >&2; return 1; }
  ( cd "$ver" && sha256sum -c --status attestation.sha256 ) || {
    echo "[att] the new version does not match its own checksum — not activating it" >&2
    return 1
  }
  # The pointer must never come to rest on an attestation for another release.
  got=$(sed -n 's/^main_sha=//p' "$ver/attestation.env" | head -1)
  [ "$got" = "$want_sha" ] ||
    { echo "[att] the new version names another main_sha — not activating it" >&2; return 1; }
  got=$(sed -n 's/^digest=//p' "$ver/attestation.env" | head -1)
  [ "$got" = "$want_digest" ] ||
    { echo "[att] the new version names another digest — not activating it" >&2; return 1; }

  att_lock_exclusive || return 1
  # `ln -sfn` writes a fresh symlink under a temporary name, `mv -T` renames it
  # over the pointer. Rename is atomic within a directory, so `current` is only
  # ever the old target or the new one.
  if ! ln -sfn "$ver" "$dir/.current.new" || ! mv -Tf "$dir/.current.new" "$dir/current"; then
    rm -f "$dir/.current.new" 2>/dev/null || true
    att_unlock
    echo "[att] the pointer swap failed — the previous attestation is untouched" >&2
    return 1
  fi
  att_unlock
  return 0
}
