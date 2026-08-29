#!/usr/bin/env bash
# Restaging, and the ten ways it must refuse.
#
# The failure this prevents is one that already happened twice: an owner
# staging directory holding files from an earlier revision, followed by an
# instruction to run `sha256sum -c MANIFEST` inside it. That check passes on a
# stale bundle, because a manifest and its files are perfectly consistent with
# each other no matter which commit they came from. Provenance has to come from
# the checkout, and the checkout has to be verified.
# `-Ee` like the other two suites in this cohort. Without errexit a failure in
# `mkco` was silent — the clone's stderr is discarded and nothing checked its
# status — so the suite ran on against an incomplete checkout and reported
# refusals for the wrong reason.
set -Eeuo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
STAGE="$ROOT/deploy/stage-owner-bundle.sh"
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }
section() { printf '\n%s\n' "$1"; }

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
CO="$W/checkout"
DEST="$W/owner-bundle"

# A checkout that looks like the real one to every check this script makes.
mkco() {
  rm -rf "$CO"
  git -c init.defaultBranch=main clone -q --no-hardlinks "$ROOT" "$CO" 2>/dev/null
  git -C "$CO" remote set-url origin https://github.com/Shikoonet/Shikoonet-Platform.git
  git -C "$CO" checkout -q HEAD -- . 2>/dev/null || true
  git -C "$CO" clean -qfdx 2>/dev/null || true
  SHA=$(git -C "$CO" rev-parse HEAD)
  publish   # the commit has to be one origin/main carries
}

# The stager requires the SHA to be reachable from `refs/remotes/origin/main`,
# because a local `origin` URL is configuration anyone can set while a
# remote-tracking ref exists only because a fetch produced one. In these
# fixtures the "remote" is this repository itself, so origin/main is pointed at
# whatever the fixture just committed — modelling a commit the remote published.
publish() {
  git -C "$CO" update-ref refs/remotes/origin/main "$(git -C "$CO" rev-parse HEAD)"
}
run() { bash "$STAGE" "$CO" "${1:-$SHA}" "$DEST" >"$W/out" 2>"$W/err"; }
refuses() { # label want
  if run "${3:-$SHA}"; then bad "$1" 'it was accepted'
  elif grep -qF "$2" "$W/err"; then ok "$1"
  else bad "$1" "refused, but not for '$2': $(grep 'STOP:' "$W/err" | head -1)"; fi
}

mkco

section 'a clean checkout at the named sha stages'

if run; then ok 'a verified checkout stages'; else bad 'a verified checkout stages' "$(cat "$W/err")"; fi
if [ -f "$DEST/MANIFEST" ]; then ok 'the manifest is staged'; else bad 'the manifest is staged' 'absent'; fi
if [ -f "$DEST/shikoo-task-runner" ]; then ok 'the runner is staged'; else bad 'the runner is staged' 'absent'; fi
# A sibling, not a member: the installer refuses any file in the staging
# directory the manifest does not list, and would refuse itself.
if [ -f "$W/install-shikoo-task-runner.sh" ]; then
  ok 'the installer is staged beside the bundle, from the same revision'
else
  bad 'the installer is staged beside the bundle, from the same revision' 'absent'
fi
if [ -e "$DEST/install-shikoo-task-runner.sh" ]; then
  bad 'the installer is not inside the bundle it installs' 'it is'
else
  ok 'the installer is not inside the bundle it installs'
fi
if ( cd "$DEST" && sha256sum -c --status MANIFEST ); then
  ok 'the staged files match the manifest'
else
  bad 'the staged files match the manifest' 'they do not'
fi
if [ "$(sed -n 's/^staged_from_sha=//p' "$W/owner-bundle.provenance")" = "$SHA" ]; then
  ok 'the bundle records which sha it came from'
else
  bad 'the bundle records which sha it came from' 'it does not'
fi
if grep -rqiE 'ghp_|password|BEGIN [A-Z ]*PRIVATE KEY' "$W/out" "$W/err"; then
  bad 'restaging prints no secret' 'a match was found'
else
  ok 'restaging prints no secret'
fi
# It needs no network and no token once the checkout exists.
if grep -qE 'gh |curl |git fetch|git clone' "$STAGE"; then
  bad 'restaging performs no network operation' 'a fetch appears in the script'
else
  ok 'restaging performs no network operation'
fi

section 'ten ways it refuses, each leaving the previous bundle in place'

GOOD=$(cd "$DEST" && sha256sum MANIFEST | cut -d' ' -f1)
intact() { # label
  if [ "$(cd "$DEST" && sha256sum MANIFEST | cut -d' ' -f1)" = "$GOOD" ] &&
     [ -f "$W/install-shikoo-task-runner.sh" ]; then
    ok "$1"
  else
    bad "$1" 'the previous bundle was disturbed'
  fi
}

# 1. a stale checkout — the exact failure that motivated this script
mkco
# An explicit identity, like every other commit in this file. Without one this
# `git commit` fails on a runner with no global git config, HEAD never moves,
# and the case silently becomes "stage a checkout that IS at the named sha" —
# which passes, and proves nothing. CI caught exactly that.
git -C "$CO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'a later commit'
publish
[ "$(git -C "$CO" rev-parse HEAD)" != "$SHA" ] ||
  { echo "the fixture did not move HEAD; this case would prove nothing" >&2; exit 1; }
refuses 'a checkout at another sha is refused' 'not the' "$SHA"
intact 'a stale-checkout refusal leaves the bundle alone'

# 2. wrong remote
mkco; git -C "$CO" remote set-url origin https://evil.example/x/Shikoonet/Shikoonet-Platform.git
refuses 'a checkout with an unknown remote is refused' 'not a known remote'

# 3. dirty tree — a tracked file modified
mkco; printf '\n# local edit\n' >>"$CO/deploy/shikoo-task-runner"
refuses 'a modified tracked file is refused' 'local modifications'

# 4. dirty tree — an untracked file
mkco; printf 'x\n' >"$CO/deploy/stowaway.sh"
refuses 'an untracked file is refused' 'local modifications'

# 5. a file the manifest lists is missing from the revision
mkco; rm -f "$CO/deploy/rehearsal-lib.sh"; git -C "$CO" -c user.email=t@t -c user.name=t commit -qam 'drop'
publish
SHA2=$(git -C "$CO" rev-parse HEAD)
refuses 'a manifest file missing from the revision is refused' 'missing from this revision' "$SHA2"

# 6. a manifest file replaced by a symlink
mkco; rm -f "$CO/deploy/rehearsal-lib.sh"; ln -s /etc/hostname "$CO/deploy/rehearsal-lib.sh"
git -C "$CO" -c user.email=t@t -c user.name=t commit -qam 'symlink'
publish
SHA3=$(git -C "$CO" rev-parse HEAD)
refuses 'a symlinked manifest file is refused' 'symlink' "$SHA3"

# 7. a manifest file whose contents no longer hash to what the manifest says
mkco; printf '\n# drift\n' >>"$CO/deploy/rehearsal-lib.sh"
git -C "$CO" -c user.email=t@t -c user.name=t commit -qam 'drift'
publish
SHA4=$(git -C "$CO" rev-parse HEAD)
refuses 'a modified manifest file is refused' 'do not match the manifest' "$SHA4"

# 8. the installer was built against a different manifest
mkco; sed -i 's/^MANIFEST_SHA256=.*/MANIFEST_SHA256=0000000000000000000000000000000000000000000000000000000000000000/' \
  "$CO/deploy/install-shikoo-task-runner.sh"
git -C "$CO" -c user.email=t@t -c user.name=t commit -qam 'pin drift'
publish
SHA5=$(git -C "$CO" rev-parse HEAD)
refuses 'an installer built against another manifest is refused' 'built against a different manifest' "$SHA5"

# 9. not a checkout at all
mkco; CO_REAL="$CO"; CO="$W/not-a-repo"; mkdir -p "$CO"
refuses 'a directory that is not a checkout is refused' 'not a git checkout'
CO="$CO_REAL"

# 10. a malformed sha
mkco
refuses 'a sha that is not 40 hex characters is refused' 'not 40 lowercase hex' 'deadbeef'

intact 'after every refusal the previous bundle is still the one in place'

# A checkout whose origin URL is right but whose commit the remote never
# published — an unrelated repository with `origin` pointed at the allowlist.
mkco
git -C "$CO" -c user.email=t@t -c user.name=t commit -q --allow-empty -m 'never published'
UNPUB=$(git -C "$CO" rev-parse HEAD)
# deliberately NOT published: origin/main stays where it was
refuses 'a commit the remote never published is refused' 'not reachable from origin/main' "$UNPUB"

mkco
git -C "$CO" update-ref -d refs/remotes/origin/main
refuses 'a checkout with no origin/main tracking ref is refused' 'no origin/main remote-tracking ref' "$SHA"

section 'an interrupted restage replaces nothing'

mkco
# `exec`, so $! is the stager itself and the signal goes to a PID this test
# owns. `pkill -f 'stage-owner-bundle.sh'` matched THIS FILE's own command line
# as well — the suite was signalling itself, which errexit then surfaced as an
# exit of 130 with no failing assertion to explain it.
( trap - INT TERM; exec bash "$STAGE" "$CO" "$SHA" "$DEST" >/dev/null 2>&1 ) & job=$!
# Wait until the subshell has actually exec'd the stager. Signalling before
# that kills the wrapper instead, and the stager never runs — so the case would
# assert about a directory nothing had touched.
for _ in $(seq 1 400); do
  tr '\0' ' ' <"/proc/$job/cmdline" 2>/dev/null | grep -q 'deploy/stage-owner-bundle.sh' && break
  sleep 0.02
done
# `|| true`: if the stager already finished, `kill` returns non-zero and
# errexit would end the suite before `wait` could report. Completing before the
# signal lands is an accepted outcome of this case.
kill -INT "$job" 2>/dev/null || true
RC=0
wait "$job" || RC=$?
case "$RC" in
  130) ok 'an interrupted restage exits 130' ;;
  0)   ok 'the restage completed before the signal landed (nothing was left half-replaced)' ;;
  *)   bad 'an interrupted restage exits 130' "exit was $RC" ;;
esac
if [ -z "$(find "$W" -maxdepth 1 -name 'owner-bundle.new.*' -print -quit)" ]; then
  ok 'no half-built staging directory survives'
else
  bad 'no half-built staging directory survives' "$(find "$W" -maxdepth 1 -name 'owner-bundle.new.*')"
fi
if [ -z "$(find "$W" -maxdepth 1 -name 'owner-bundle.old.*' -print -quit)" ]; then
  ok 'no orphaned previous bundle is left behind'
else
  bad 'no orphaned previous bundle is left behind' "$(find "$W" -maxdepth 1 -name 'owner-bundle.old.*')"
fi
if ( cd "$DEST" && sha256sum -c --status MANIFEST ); then
  ok 'the staging directory is a complete bundle either way'
else
  bad 'the staging directory is a complete bundle either way' 'it is not'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
