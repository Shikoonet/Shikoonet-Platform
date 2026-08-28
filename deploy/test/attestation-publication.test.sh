#!/usr/bin/env bash
# Can a reader ever see half an attestation?
#
# The design this replaces could. It activated a versioned directory by
# swapping `current`, then copied `attestation.env` and `attestation.sha256`
# up into a flat directory and renamed them one after the other — two events,
# after the swap. A reader arriving between them saw a new .env beside an old
# .sha256, which verifies against neither, and a failure in that second half
# turned an already-successful activation into a failed run.
#
# These tests are cross-process and use FIFOs rather than sleeps, so "the
# reader arrived while the publisher held the lock" is a fact the test
# arranges rather than a race it hopes for.
set -uo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }

# shellcheck source=deploy/test/rehearsal-world.sh
. "$HERE/rehearsal-world.sh"
rehearsal_become_root "$0" "$@"

. "$ROOT/deploy/attestation-store.sh"

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
export ATT_LOCK="$W/release.lock" ATT_LOCK_GROUP=root ATT_LOCK_WAIT=15
: >"$ATT_LOCK"; chmod 660 "$ATT_LOCK"
ATT="$W/attestation"; mkdir -p "$ATT/versions"

SHA_A=$(printf '%040d' 1 | tr '0' 'a'); DIG_A="sha256:$(printf '%064d' 1 | tr '0' 'a')"
SHA_B=$(printf '%040d' 2 | tr '0' 'b'); DIG_B="sha256:$(printf '%064d' 2 | tr '0' 'b')"

mkver() { # name sha digest -> version dir
  local d="$ATT/versions/$1"
  mkdir -p "$d"
  { printf 'schema_version=1\n'; printf 'main_sha=%s\n' "$2"; printf 'digest=%s\n' "$3"; } >"$d/attestation.env"
  ( cd "$d" && sha256sum attestation.env >attestation.sha256 )
  printf '%s' "$d"
}

# ── the lock is validated, not adopted ───────────────────────────────────
chmod 666 "$ATT_LOCK"
if ( att_require_lock_file ) 2>/dev/null; then
  bad "a world-writable lock is refused" "accepted mode 666"
else ok "a world-writable lock is refused"; fi
chmod 660 "$ATT_LOCK"

mv "$ATT_LOCK" "$W/real.lock"; ln -s "$W/real.lock" "$ATT_LOCK"
if ( att_require_lock_file ) 2>/dev/null; then
  bad "a symlinked lock is refused" "accepted a symlink"
else ok "a symlinked lock is refused"; fi
rm -f "$ATT_LOCK"; mv "$W/real.lock" "$ATT_LOCK"; chmod 660 "$ATT_LOCK"

# ── 1. first publication ─────────────────────────────────────────────────
V1=$(mkver v1 "$SHA_A" "$DIG_A")
if att_publish "$ATT" "$V1" "$SHA_A" "$DIG_A" 2>"$W/e1"; then ok "first publication activates"
else bad "first publication activates" "$(cat "$W/e1")"; fi
if [ "$(readlink -f "$ATT/current")" = "$V1" ]; then
  ok "current points at the first version"
else
  bad "current points at the first version" "$(readlink -f "$ATT/current")"
fi
if [ "$(att_read "$ATT")" = "$V1" ]; then ok "a reader resolves the first version"; else bad "a reader resolves the first version" ""; fi

# No flat pair may exist: one source of truth means one.
if [ -e "$ATT/attestation.env" ] || [ -e "$ATT/attestation.sha256" ]; then
  bad "publication leaves no second copy" "a flat attestation pair exists"
else ok "publication leaves no second copy"; fi

V1_SUM=$(sha256sum "$V1/attestation.env" | cut -d' ' -f1)

# ── 2. second publication replaces the first ─────────────────────────────
V2=$(mkver v2 "$SHA_B" "$DIG_B")
if att_publish "$ATT" "$V2" "$SHA_B" "$DIG_B" 2>"$W/e2"; then ok "second publication activates"
else bad "second publication activates" "$(cat "$W/e2")"; fi
if [ "$(readlink -f "$ATT/current")" = "$V2" ]; then ok "current moves to the second version"; else bad "current moves to the second version" ""; fi
if [ "$(sha256sum "$V1/attestation.env" | cut -d' ' -f1)" = "$V1_SUM" ]; then ok "the previous version is byte-identical after a successful replacement"; else bad "the previous version is byte-identical after a successful replacement" ""; fi

# ── 3. failures before the swap leave the pointer alone ──────────────────
before=$(readlink -f "$ATT/current")

V3=$(mkver v3 "$SHA_A" "$DIG_A")
printf 'tampered\n' >>"$V3/attestation.env"
if att_publish "$ATT" "$V3" "$SHA_A" "$DIG_A" 2>"$W/e3"; then
  bad "a checksum failure refuses to activate" "it activated"
elif grep -q 'checksum' "$W/e3"; then ok "a checksum failure refuses to activate"
else bad "a checksum failure refuses to activate" "$(cat "$W/e3")"; fi

V4=$(mkver v4 "$SHA_A" "$DIG_A")
if att_publish "$ATT" "$V4" "$SHA_B" "$DIG_A" 2>"$W/e4"; then
  bad "a version naming another release refuses to activate" "it activated"
elif grep -q 'main_sha' "$W/e4"; then ok "a version naming another release refuses to activate"
else bad "a version naming another release refuses to activate" "$(cat "$W/e4")"; fi

V5=$(mkver v5 "$SHA_A" "$DIG_A")
if att_publish "$ATT" "$V5" "$SHA_A" "$DIG_B" 2>"$W/e5"; then
  bad "a version naming another digest refuses to activate" "it activated"
elif grep -q 'digest' "$W/e5"; then ok "a version naming another digest refuses to activate"
else bad "a version naming another digest refuses to activate" "$(cat "$W/e5")"; fi

if [ "$(readlink -f "$ATT/current")" = "$before" ]; then ok "no failed attempt moved the pointer"; else bad "no failed attempt moved the pointer" ""; fi
if [ "$(att_read "$ATT")" = "$V2" ]; then ok "readers still resolve the last good version after three failures"; else bad "readers still resolve the last good version after three failures" ""; fi

# ── 4. the swap itself failing ───────────────────────────────────────────
#
# `mv -T` is atomic, but it is not infallible: renaming onto a name that is a
# NON-EMPTY DIRECTORY fails with ENOTEMPTY. That is the one way this design's
# single inode operation can refuse, so it is the one that has to be tested —
# and running as root, a mode-based test would have proved nothing, because
# root ignores the mode.
V6=$(mkver v6 "$SHA_A" "$DIG_A")
rm -f "$ATT/current"
mkdir -p "$ATT/current/occupied"
printf 'x\n' >"$ATT/current/occupied/f"
if att_publish "$ATT" "$V6" "$SHA_A" "$DIG_A" 2>"$W/e6"; then
  bad "a pointer-swap failure is reported" "it reported success"
else
  if grep -q 'pointer swap failed\|previous attestation is untouched' "$W/e6"; then
    ok "a pointer-swap failure is reported as such"
  else
    bad "a pointer-swap failure is reported as such" "$(cat "$W/e6")"
  fi
fi
if [ -e "$ATT/.current.new" ]; then
  bad "a failed swap leaves no half-written pointer" "the temporary pointer survived"
else
  ok "a failed swap leaves no half-written pointer"
fi
if [ -f "$ATT/current/occupied/f" ]; then ok "a failed swap did not disturb what stood in its way"; else bad "a failed swap did not disturb what stood in its way" "the obstruction was destroyed"; fi
[ "$(sha256sum "$V2/attestation.env" | cut -d' ' -f1)" = "$(sha256sum "$V2/attestation.env" | cut -d' ' -f1)" ] &&
  if [ -f "$V2/attestation.env" ]; then ok "the previous version survives a failed swap byte for byte"; else bad "the previous version survives a failed swap byte for byte" ""; fi

# Put the pointer back and confirm readers recover.
rm -rf "$ATT/current"
ln -sfn "$V2" "$ATT/current"
if [ "$(att_read "$ATT")" = "$V2" ]; then ok "readers recover once the pointer is restored"; else bad "readers recover once the pointer is restored" ""; fi

# ── 5. concurrency, arranged rather than hoped for ───────────────────────
#
# The publisher takes the exclusive lock, tells the test it holds it, and waits
# for permission before swapping. A reader launched in between must not be able
# to observe anything until the swap has completed.
mkfifo "$W/held" "$W/go"
V7=$(mkver v7 "$SHA_A" "$DIG_A")
(
  . "$ROOT/deploy/attestation-store.sh"
  att_lock_exclusive || exit 1
  echo held >"$W/held"
  read -r _ <"$W/go"
  ln -sfn "$V7" "$ATT/.current.new" && mv -Tf "$ATT/.current.new" "$ATT/current"
  att_unlock
) & PUB=$!
read -r _ <"$W/held"

# A concurrent reader while the publisher holds the lock: it must block, not
# read through the swap. Its answer, whenever it arrives, must be complete.
( att_read "$ATT" >"$W/reader.out" 2>"$W/reader.err"; echo $? >"$W/reader.rc" ) & RD=$!
if kill -0 "$RD" 2>/dev/null; then ok "a concurrent reader waits for the publisher's lock"
else bad "a concurrent reader waits for the publisher's lock" "it did not block"; fi

# A concurrent Prepare-style verification attempt, same protocol.
( att_read "$ATT" >"$W/prep.out" 2>&1; echo $? >"$W/prep.rc" ) & PR=$!

echo go >"$W/go"
wait "$PUB"; wait "$RD" 2>/dev/null; wait "$PR" 2>/dev/null

if [ "$(cat "$W/reader.rc")" = 0 ] && [ "$(cat "$W/reader.out")" = "$V7" ]; then
  ok "the concurrent reader saw the complete new version"
else
  bad "the concurrent reader saw the complete new version" "rc=$(cat "$W/reader.rc") out=$(cat "$W/reader.out")"
fi
if [ "$(cat "$W/prep.rc")" = 0 ] && [ "$(cat "$W/prep.out")" = "$V7" ]; then
  ok "the concurrent Prepare-side read saw the complete new version"
else
  bad "the concurrent Prepare-side read saw the complete new version" "$(cat "$W/prep.out")"
fi

# The lock actually excludes, proven without a race.
#
# The concurrency test above shows a reader ending up with the complete new
# version, but a reader that took no lock at all could also end up there if it
# happened to run after the swap. This asks the narrower question directly: with
# the publisher holding the exclusive lock, a shared acquisition must TIME OUT.
mkfifo "$W/held2" "$W/go2"
(
  . "$ROOT/deploy/attestation-store.sh"
  att_lock_exclusive || exit 1
  echo held >"$W/held2"
  read -r _ <"$W/go2"
  att_unlock
) & HOLD=$!
read -r _ <"$W/held2"
if ( ATT_LOCK_WAIT=1 att_lock_shared ) 2>/dev/null; then
  bad "a shared read cannot proceed while the pointer is being swapped" "it acquired the lock"
else
  ok "a shared read cannot proceed while the pointer is being swapped"
fi
if ( ATT_LOCK_WAIT=1 att_lock_exclusive ) 2>/dev/null; then
  bad "a second publisher cannot hold the lock at the same time" "it acquired the lock"
else
  ok "a second publisher cannot hold the lock at the same time"
fi
echo go >"$W/go2"
wait "$HOLD"
# And once released, both succeed.
if att_lock_shared; then att_unlock; ok "the lock is released, not leaked"
else bad "the lock is released, not leaked" "still held"; fi

# ── 6. a reader can never observe a mixed pair ───────────────────────────
#
# Swaps back and forth while readers hammer the pointer. Every read must
# resolve to a version whose checksum verifies and whose main_sha is one of
# the two — never a blend of both.
V8=$(mkver v8 "$SHA_B" "$DIG_B")
: >"$W/mixed"
(
  for _ in $(seq 1 40); do
    ln -sfn "$V7" "$ATT/.n" && mv -Tf "$ATT/.n" "$ATT/current"
    ln -sfn "$V8" "$ATT/.n" && mv -Tf "$ATT/.n" "$ATT/current"
  done
) & SW=$!
for _ in $(seq 1 120); do
  cur=$(att_read "$ATT" 2>/dev/null) || { echo "unreadable" >>"$W/mixed"; continue; }
  s=$(sed -n 's/^main_sha=//p' "$cur/attestation.env")
  case "$s" in "$SHA_A" | "$SHA_B") ;; *) echo "blend:$s" >>"$W/mixed" ;; esac
done
wait "$SW"
if [ ! -s "$W/mixed" ]; then
  ok "120 concurrent reads during 80 swaps saw no mixed or unreadable pair"
else
  bad "120 concurrent reads during 80 swaps saw no mixed or unreadable pair" "$(sort -u "$W/mixed" | head -3)"
fi

# ── 6b. the published read path, as the promotion gate uses it ───────────
#
# Every reader must go through `current` and hold the shared lock for the whole
# read. Two escapes had to be closed: the verifier released the lock as soon as
# it had resolved, and Prepare resolved the pointer itself and handed the
# verifier a directory of its own choosing, which took an unlocked branch.
VERIFY="$ROOT/deploy/verify-dump-attestation.sh"
VSHA=$(printf '%040d' 5 | tr '0' 'e')
VDIG="sha256:$(printf '%064d' 5 | tr '0' 'e')"
VATT="$W/vatt"; mkdir -p "$VATT/versions"
VV="$VATT/versions/v1"; mkdir -p "$VV"
env MAIN_SHA="$VSHA" DIGEST="$VDIG" CI_RUN_ID=1 STAGING_RUN_ID=2   DUMP_ID="sha256:$(printf 'a%.0s' $(seq 64)) 2026-08-28"   MIGRATION_RANGE='0035..0037' DUMP_SUITES='49/49' INVARIANTS='32/32'   FINANCIAL_TOTALS=match RESTORE_RESULT=pass RESTORE_SECONDS=1   OLD_APP_SCHEMA_COMPAT=pass LEGACY_IMPORT=pass PROD_RESTORE_MIGRATED=pass   PROD_INVARIANTS='32/32' PROD_MIGRATION_RANGE='0035..0037'   OLD_APP_SCHEMA_SUBJECT=production-restore   D1_EXPORT_ID="sha256:$(printf 'b%.0s' $(seq 64))"   GITHUB_REPOSITORY='Shikoonet/Shikoonet-Platform'   bash "$ROOT/deploy/write-dump-attestation.sh" "$VV" >/dev/null 2>&1

# Not yet published: the promotion path must refuse rather than read it.
if env EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG" bash "$VERIFY" "$VATT" >"$W/v1" 2>&1; then
  bad "an unactivated attestation is refused on the published path" "it was accepted"
elif grep -q 'is not a pointer' "$W/v1"; then
  ok "an unactivated attestation is refused on the published path"
else
  bad "an unactivated attestation is refused on the published path" "$(head -1 "$W/v1")"
fi

# A caller naming a version directory directly must not get an unlocked read.
if env EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG" bash "$VERIFY" "$VV" >"$W/v2" 2>&1; then
  bad "a caller-named version directory is refused" "it was accepted"
else
  ok "a caller-named version directory is refused"
fi

if att_publish "$VATT" "$VV" "$VSHA" "$VDIG" 2>/dev/null; then
  ok "the version activates"
else
  bad "the version activates" ""
fi

if env EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG" bash "$VERIFY" "$VATT" >"$W/v3" 2>&1; then
  ok "the published attestation verifies through current"
else
  bad "the published attestation verifies through current" "$(head -1 "$W/v3")"
fi

# The pre-publication branch has to be asked for by name, and refuses once the
# thing it is checking is reachable through a pointer.
if env ATTESTATION_UNPUBLISHED=1 EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG"      bash "$VERIFY" "$VATT" >"$W/v4" 2>&1; then
  bad "the pre-publication branch refuses a directory that has a pointer" "it was accepted"
elif grep -q 'has a current pointer' "$W/v4"; then
  ok "the pre-publication branch refuses a directory that has a pointer"
else
  bad "the pre-publication branch refuses a directory that has a pointer" "$(head -1 "$W/v4")"
fi

# And it holds the lock while it reads: with a publisher holding the exclusive
# lock, a verification of the published path must not complete.
mkfifo "$W/held3" "$W/go3"
(
  . "$ROOT/deploy/attestation-store.sh"
  att_lock_exclusive || exit 1
  echo held >"$W/held3"
  read -r _ <"$W/go3"
  att_unlock
) & VHOLD=$!
read -r _ <"$W/held3"
if env ATT_LOCK_WAIT=1 EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG"      bash "$VERIFY" "$VATT" >"$W/v5" 2>&1; then
  bad "verification cannot proceed while a publisher holds the lock" "it completed"
elif grep -q 'release lock could not be taken' "$W/v5"; then
  ok "verification cannot proceed while a publisher holds the lock"
else
  bad "verification cannot proceed while a publisher holds the lock" "$(head -1 "$W/v5")"
fi
echo go >"$W/go3"
wait "$VHOLD"
if env EXPECTED_SHA="$VSHA" EXPECTED_DIGEST="$VDIG" bash "$VERIFY" "$VATT" >/dev/null 2>&1; then
  ok "verification succeeds once the publisher releases"
else
  bad "verification succeeds once the publisher releases" ""
fi

# ── 7. signals and stale versions, driven through the real script ────────
export FAKE_PROD_DB_UUID=qd2vduj7kv05sp9ejdrmclmu
export FAKE_STAGING_DB_UUID=bea6ac92holn5k6vjgopy2ai
export FAKE_UUID_INGEST=d9ulbwkdjpvg2ajalecruxzh
export FAKE_UUID_DASHBOARD=huneuqvzyw0cjd4u0f7s37cf
export FAKE_UUID_BOT=3xetld1oi3x7viq8cr8is0ls
# Read by build_world and run_rehearsal in rehearsal-world.sh.
# shellcheck disable=SC2034
SHA=''
# shellcheck disable=SC2034
DIGEST="sha256:$(printf '%064d' 3 | tr '0' 'c')"

signal_run() { # signame expected-code
  local sig=$1 want=$2
  local sw="$W/sig$sig" rc job
  build_world "$sw"
  # A backgrounded subshell inherits SIGINT as ignored — POSIX requires it for
  # asynchronous commands — and bash keeps an inherited-ignored signal ignored
  # even when the child installs a trap. Without resetting it here the INT case
  # silently tests nothing: the run would finish normally and the test would
  # have to be read as passing. `trap - INT TERM` restores the default
  # disposition before the real script is exec'd.
  ( trap - INT TERM; run_rehearsal "$sw"; echo $? >"$sw/rc" ) &
  job=$!
  # Wait for the run to have created its containers — past the point where a
  # naive `trap cleanup INT TERM` would have resumed and carried on.
  for _ in $(seq 1 400); do
    grep -q '^run-daemon' "$sw/log" 2>/dev/null && break
    sleep 0.05
  done
  pkill -"$sig" -f "$sw/bin/rehearsal.sh" 2>/dev/null
  wait "$job" 2>/dev/null
  rc=$(cat "$sw/rc" 2>/dev/null || echo missing)
  if [ "$rc" = "$want" ]; then ok "a $sig exits $want rather than resuming"; else bad "a $sig exits $want rather than resuming" "exit was $rc"; fi
  if [ ! -e "$sw/state/attestation/current" ]; then ok "a $sig before activation leaves no attestation"; else bad "a $sig before activation leaves no attestation" "an attestation was activated"; fi
  local left
  left=$(find "$sw/state/attestation/versions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)
  if [ "$left" = 0 ]; then ok "a $sig leaves no unactivated version directory"; else bad "a $sig leaves no unactivated version directory" "$left left behind"; fi
  if grep -q 'tearing down and stopping' "$sw/out"; then ok "a $sig says why it stopped"; else bad "a $sig says why it stopped" ""; fi
  rm -rf "$sw"
}
signal_run INT 130
signal_run TERM 143

# A run that fails after building its version directory must not leave it.
SW="$W/stale"; build_world "$SW"
FAKE_VITEST_RC=1 run_rehearsal "$SW"
if [ "$(find "$SW/state/attestation/versions" -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l)" = 0 ]; then ok "an ordinary failure leaves no unactivated version directory"; else bad "an ordinary failure leaves no unactivated version directory" ""; fi
if [ ! -e "$SW/state/attestation/current" ]; then ok "an ordinary failure activates nothing"; else bad "an ordinary failure activates nothing" ""; fi

echo
printf 'publication: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
