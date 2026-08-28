#!/usr/bin/env bash
# Restage the owner bundle from an exact merged SHA.
#
# Why this exists as a script rather than a paragraph in a runbook: twice in
# this work, `~/shikoo-owner-step-e` and `~/install-shikoo-task-runner.sh` held
# files from an earlier revision, and the instruction that followed them was
# `sha256sum -c MANIFEST`. That command answers "do these files match the
# manifest sitting beside them" — it says nothing about which commit either
# came from. A stale bundle passes it perfectly.
#
# So provenance is established here, once, from a checkout this script verifies:
# the remote is one of this repository's known URLs, HEAD is the SHA the caller
# named, the tree is clean, and every file copied is one the tracked runner
# manifest lists. Anything else — a missing file, an extra file, a modified
# file, a symlink — stops the restage before the old bundle is touched.
#
# It needs no GitHub token when the verified checkout already exists, and it
# prints no secret.
#
#   stage-owner-bundle.sh <checkout-dir> <expected-sha> [staging-dir]
set -Eeuo pipefail

CHECKOUT=${1:-}
WANT_SHA=${2:-}
STAGING=${3:-$HOME/shikoo-owner-step-e}

say() { echo "[stage] $*" >&2; }
die() { echo "[stage] STOP: $*" >&2; exit 1; }

if [ -z "$CHECKOUT" ] || [ -z "$WANT_SHA" ]; then
  die "usage: stage-owner-bundle.sh <checkout-dir> <expected-sha> [staging-dir]"
fi
[[ $WANT_SHA =~ ^[0-9a-f]{40}$ ]] || die "the expected sha is not 40 lowercase hex characters"

TMP=''
cleanup() { [ -z "$TMP" ] || rm -rf "$TMP"; }
on_signal() { # signame code
  echo "[stage] received $1 — the existing staging directory is untouched" >&2
  cleanup
  exit "$2"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap cleanup EXIT

# ── 1. the checkout is what it claims to be ──────────────────────────────
[ -d "$CHECKOUT/.git" ] || die "${CHECKOUT} is not a git checkout"

REMOTE=$(git -C "$CHECKOUT" remote get-url origin 2>/dev/null || true)
case "$REMOTE" in
  https://github.com/Shikoonet/Shikoonet-Platform | \
  https://github.com/Shikoonet/Shikoonet-Platform.git | \
  git@github.com:Shikoonet/Shikoonet-Platform | \
  git@github.com:Shikoonet/Shikoonet-Platform.git | \
  ssh://git@github.com/Shikoonet/Shikoonet-Platform | \
  ssh://git@github.com/Shikoonet/Shikoonet-Platform.git) ;;
  *) die "the checkout's origin is not a known remote for this repository" ;;
esac

HEAD_SHA=$(git -C "$CHECKOUT" rev-parse HEAD)
[ "$HEAD_SHA" = "$WANT_SHA" ] ||
  die "the checkout is at ${HEAD_SHA:0:12}, not the ${WANT_SHA:0:12} this bundle is for"

# A dirty tree means the bytes about to be staged are not the reviewed ones.
# `--porcelain` lists untracked files as `??`, so this covers additions too.
[ -z "$(git -C "$CHECKOUT" status --porcelain)" ] ||
  die "the checkout has local modifications or untracked files"

say "checkout verified at ${WANT_SHA:0:12}, clean, correct remote"

# ── 2. the manifest decides what is copied ───────────────────────────────
MANIFEST="$CHECKOUT/deploy/shikoo-task-runner.manifest"
[ -f "$MANIFEST" ] || die "the tracked runner manifest is missing from this revision"

TMP=$(mktemp -d "${STAGING}.new.XXXXXX")
chmod 700 "$TMP"

n=0
while read -r _ name; do
  [ -n "$name" ] || continue
  case "$name" in
    migrations/*) src="$CHECKOUT/$name" ;;
    *)            src="$CHECKOUT/deploy/$name" ;;
  esac
  [ ! -L "$src" ] || die "${name} is a symlink in the checkout — refusing"
  [ -f "$src" ] || die "${name} is listed by the manifest but missing from this revision"
  mkdir -p "$TMP/$(dirname "$name")"
  cp -- "$src" "$TMP/$name"
  n=$((n + 1))
done <"$MANIFEST"

# The three files that are the mechanism itself, not its payload.
for extra in shikoo-task-runner shikoo-task-runner.sudoers; do
  [ ! -L "$CHECKOUT/deploy/$extra" ] || die "${extra} is a symlink in the checkout — refusing"
  [ -f "$CHECKOUT/deploy/$extra" ] || die "${extra} is missing from this revision"
  cp -- "$CHECKOUT/deploy/$extra" "$TMP/$extra"
done
cp -- "$MANIFEST" "$TMP/MANIFEST"

say "staged ${n} manifest file(s) plus the runner, its sudoers and the manifest"

# ── 3. verified in the staging directory, before it replaces anything ────
( cd "$TMP" && sha256sum -c --status MANIFEST ) ||
  die "the staged files do not match the manifest from this revision"

# No extra/missing comparison here: this directory was created empty by
# `mktemp -d` and filled only from the manifest, so neither can occur. The
# installer makes exactly that comparison on exactly this directory — where it
# is reachable, because it did not create it — and is tested for it.

# The installer travels with the bundle from this same revision, so the thing
# that runs as root and the thing it installs cannot come from two commits. It
# is staged as a SIBLING of the bundle, not inside it: the installer refuses
# any file in the staging directory that the manifest does not list, and would
# refuse itself.
INSTALLER="$CHECKOUT/deploy/install-shikoo-task-runner.sh"
if [ ! -f "$INSTALLER" ] || [ -L "$INSTALLER" ]; then
  die "the installer is missing or is a symlink"
fi

# The installer refuses a manifest it was not built against; checking it here
# means a mismatched pair is caught during restaging rather than under sudo.
PIN=$(sed -n 's/^MANIFEST_SHA256=\([0-9a-f]\{64\}\).*/\1/p' "$INSTALLER" | head -1)
ACTUAL=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
[ "$PIN" = "$ACTUAL" ] ||
  die "the installer at this revision was built against a different manifest"

# ── 4. replacement ───────────────────────────────────────────────────────
#
# The installer and the provenance record are siblings of the bundle, written
# completely under temporary names and renamed into place. `mv -T` onto an
# existing directory fails with ENOTEMPTY, so the old bundle is moved aside
# first and removed only once the new one is in place — at no moment is there a
# staging directory holding half of each.
#
# If the bundle swap fails after the installer has been replaced, the two are
# from different revisions and the installer's own MANIFEST_SHA256 pin refuses
# to run. Every ordering here fails closed.
PARENT=$(dirname -- "$STAGING")
INST_OUT="$PARENT/install-shikoo-task-runner.sh"
PROV_OUT="$PARENT/$(basename -- "$STAGING").provenance"

TMP_INST="${INST_OUT}.new.$$"
TMP_PROV="${PROV_OUT}.new.$$"
cp -- "$INSTALLER" "$TMP_INST"
chmod 0644 "$TMP_INST"
{
  printf 'staged_from_sha=%s\n' "$WANT_SHA"
  printf 'manifest_sha256=%s\n' "$ACTUAL"
  printf 'files=%s\n' "$n"
} >"$TMP_PROV"
chmod 0644 "$TMP_PROV"

# The swap is not interruptible. `on_signal` removes $TMP and exits, and between
# moving the old bundle aside and moving the new one in there is a window where
# doing that would leave NO staging directory — the opposite of what the header
# of this script promises. Blocking both signals across those two renames means
# the sequence completes or never starts.
trap '' INT TERM
if [ -e "$STAGING" ]; then
  OLD="${STAGING}.old.$$"
  mv -T "$STAGING" "$OLD"
  if mv -T "$TMP" "$STAGING"; then
    rm -rf "$OLD"
  else
    mv -T "$OLD" "$STAGING"
    rm -f "$TMP_INST" "$TMP_PROV"
    die "the staging directory could not be replaced — the previous bundle is back in place"
  fi
else
  mv -T "$TMP" "$STAGING"
fi
TMP=''
mv -Tf "$TMP_INST" "$INST_OUT"
mv -Tf "$TMP_PROV" "$PROV_OUT"
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM

say "staging directory replaced: ${STAGING}"
say "installer: ${INST_OUT}"
echo "$WANT_SHA"
