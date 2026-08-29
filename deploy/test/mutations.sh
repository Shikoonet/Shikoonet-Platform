#!/usr/bin/env bash
# The mutation audit, with its accounting kept honest.
#
# A mutation matrix is only evidence if every number in it means what it says.
# Three things can happen when a guard is weakened and its suite is re-run:
#
#   killed      the suite failed — the guard is load-bearing and tested
#   survived    the suite passed — the guard is untested, or untestable
#   invalid     the edit changed the file but changed no behaviour
#
# The third is the dangerous one, because it looks like the first if you only
# count exit codes, and like the second if you only count survivors. One
# mutation in the previous round inserted `cleanup() { :; }` on the line where
# `CLEANED=0` is set — which is ABOVE the real definition, so bash simply
# replaced the stub a few lines later and the run behaved exactly as before.
# It was reported as a survivor. It was neither: it never mutated anything.
#
# So invalid mutations are declared here, with the reason, and each is PROVEN
# invalid rather than asserted — the mutant must both pass its suite and still
# contain the original behaviour. They are excluded from the effective
# denominator and replaced by mutations that do reach the runtime definition.
#
#   effective = matched - invalid          and the bar is: effective survived = 0
#
# Every single-quoted string below is a sed expression whose `$name` has to
# reach sed unexpanded. That is the entire content of this file.
# shellcheck disable=SC2016
# `-Ee`: this edits tracked deploy scripts in place. Without errexit, a failed
# `cp` left no backup while `cmp` reported a difference — so the run proceeded
# as if the mutation had applied, with nothing to restore from — and a failed
# `mv` in `restore` left a tracked deploy script mutated while the run still
# reported success.
set -Eeuo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
cd "$ROOT" || exit 1

# This script edits tracked files in place and restores them afterwards, so
# nothing else may run against this checkout while it does. Running the deploy
# suite beside it produced two "failures" that were only ever this script
# holding a mutated rehearsal-lib.sh while the manifest tests hashed it.
#
# A lock, not just a check. Scanning for leftover `.orig` files is
# time-of-check-to-time-of-use: two runs can both find none, both start, and
# both write `rehearsal-lib.sh.orig` — after which one restore puts back the
# OTHER run's mutant and a weakened deploy script is left in the tree with
# nothing to say so. The lock lives in `.git`, which is per-checkout, owned by
# whoever owns the checkout, and never tracked.
exec 200>"$ROOT/.git/shikoo-mutations.lock"
flock -n 200 || {
  echo "refusing: another mutation run holds the lock on this checkout" >&2
  exit 1
}

for _f in deploy/*.sh tools/*.py; do
  [ ! -e "${_f}.orig" ] || {
    echo "refusing: ${_f}.orig exists — another run is in progress, or a previous one died" >&2
    exit 1
  }
done
unset _f

ATTEMPTS=0; MATCHED=0; INVALID=0; KILLED=0; SURVIVED=0
CHILD=''
NOMATCH_LIST=''; SURVIVOR_LIST=''; INVALID_LIST=''

L=deploy/rehearsal-lib.sh
S=deploy/attestation-store.sh
R=deploy/production-dump-rehearsal.sh
G=tools/d1-export-manifest.py
B=deploy/stage-owner-bundle.sh
V=deploy/verify-dump-attestation.sh

LT=deploy/test/rehearsal-lib.test.sh
PT=deploy/test/attestation-publication.test.sh
ST=deploy/test/rehearsal-subjects.test.sh
CT=deploy/test/rehearsal-cleanup.test.sh
DT=deploy/test/d1-sidecar.test.sh
BT=deploy/test/stage-owner-bundle.test.sh

# Every mutated file restored however this ends.
#
# `restore` ran only on the normal path, and each suite runs under `timeout
# 900`, so an interrupt between `apply` and `restore` is realistic — and these
# mutations DELETE production guards. The working tree would be left holding a
# weakened deploy script, plus a stray `.orig`, with nothing to say so.
restore_all() {
  local f
  for f in deploy/*.sh tools/*.py; do
    [ -e "$f.orig" ] || continue
    mv -f "$f.orig" "$f"
    echo "[mutations] restored $f" >&2
  done
}
on_signal() { # signame code
  echo "[mutations] received $1 — restoring every mutated file" >&2
  [ -z "${CHILD:-}" ] || kill "$CHILD" 2>/dev/null
  restore_all
  exit "$2"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap restore_all EXIT

apply() { # file expr -> 0 if the source changed
  cp "$1" "$1.orig" || { echo "[mutations] could not back up $1" >&2; exit 1; }
  sed -i "$2" "$1" || { mv -f "$1.orig" "$1"; echo "[mutations] sed failed on $1" >&2; exit 1; }
  if cmp -s "$1" "$1.orig"; then mv -f "$1.orig" "$1"; return 1; fi
  return 0
}
restore() {
  mv -f "$1.orig" "$1" || { echo "[mutations] COULD NOT RESTORE $1 — the tree is left mutated" >&2; exit 1; }
}

mut() { # file expr suite label
  local f=$1 expr=$2 suite=$3 label=$4
  ATTEMPTS=$((ATTEMPTS + 1))
  if ! apply "$f" "$expr"; then
    NOMATCH_LIST="${NOMATCH_LIST}
    ${label}"
    printf 'NO-MATCH  %s\n' "$label"
    return
  fi
  MATCHED=$((MATCHED + 1))
  # Backgrounded and waited for, so a signal reaches this driver at once. Bash
  # runs traps BETWEEN commands: with the suite in the foreground an interrupt
  # sat unhandled for up to the full 900s timeout, and the working tree held a
  # weakened deploy script for every second of it.
  timeout 900 bash "$suite" >/dev/null 2>&1 & CHILD=$!
  if wait "$CHILD"; then
    CHILD=''
    SURVIVED=$((SURVIVED + 1))
    SURVIVOR_LIST="${SURVIVOR_LIST}
    ${label}"
    printf 'SURVIVED  %s\n' "$label"
  else
    CHILD=''
    KILLED=$((KILLED + 1))
    printf 'killed    %s\n' "$label"
  fi
  restore "$f"
}

# A mutation declared invalid must EARN that label: the mutant has to pass its
# suite (so it is not a kill) and still exhibit the original behaviour (so it
# is not a survivor either). Anything else is a real result and is reported.
invalid() { # file expr suite label proof-command...
  local f=$1 expr=$2 suite=$3 label=$4; shift 4
  ATTEMPTS=$((ATTEMPTS + 1))
  if ! apply "$f" "$expr"; then
    NOMATCH_LIST="${NOMATCH_LIST}
    ${label}"
    printf 'NO-MATCH  %s\n' "$label"
    return
  fi
  MATCHED=$((MATCHED + 1))
  timeout 900 bash "$suite" >/dev/null 2>&1 & CHILD=$!
  if ! wait "$CHILD"; then
    CHILD=''
    KILLED=$((KILLED + 1))
    printf 'killed    %s  (declared invalid, but its suite failed — treating as a real kill)\n' "$label"
    restore "$f"; return
  fi
  CHILD=''
  if "$@" >/dev/null 2>&1; then
    INVALID=$((INVALID + 1))
    INVALID_LIST="${INVALID_LIST}
    ${label}"
    printf 'INVALID   %s  (source changed, behaviour did not — excluded)\n' "$label"
  else
    SURVIVED=$((SURVIVED + 1))
    SURVIVOR_LIST="${SURVIVOR_LIST}
    ${label}"
    printf 'SURVIVED  %s  (declared invalid, but the proof failed)\n' "$label"
  fi
  restore "$f"
}

echo "== canonical path identity =="
mut "$L" 's|\[ "$rc" != "$rw" \]|[ "$rc" != "$rw" ] \&\& false|' "$LT" "canonical: accept any path"
mut "$L" 's|rc=$(realpath -e -- "$cand" 2>/dev/null)|rc=$cand|'     "$LT" "canonical: stop resolving the candidate"
mut "$L" 's|\[ ! -L "$cand" \]|true|'                               "$LT" "canonical: allow a symlinked directory"

echo "== the release lock =="
mut "$S" 's|\[ "$owner" = root \]|true|'         "$LT" "lock: accept a non-root owner"
mut "$S" 's|\[ ! -L "$ATT_LOCK" \]|true|'        "$LT" "lock: accept a symlinked lock"
mut "$S" 's|660) ;;|660\|666) ;;|'               "$PT" "lock: accept mode 666"
mut "$S" 's|flock -s -w "$ATT_LOCK_WAIT" 8|true|' "$PT" "reader: take no lock"
mut "$S" 's|flock -w "$ATT_LOCK_WAIT" 8|true|'    "$PT" "publisher: take no lock"

echo "== publication =="
mut "$S" 's|\[ "$got" = "$want_sha" \]|true|'    "$PT" "publish: ignore a wrong main_sha"
mut "$S" 's|\[ "$got" = "$want_digest" \]|true|' "$PT" "publish: ignore a wrong digest"
mut "$S" 's|( cd "$ver" \&\& sha256sum -c --status attestation.sha256 )|true|' "$PT" "publish: skip the checksum"

echo "== the published read path =="
mut "$S" 's|\[ -L "$dir/current" \]|true|' "$PT" "resolve: accept a tree with no pointer"
mut "$V" 's|att_lock_shared \|\| fail|true \|\| fail|' "$PT" "verifier: read without the lock"
mut "$V" 's|\[ ! -e "$DIR/current" \]|true|' "$PT" "verifier: allow the unpublished branch on a published tree"

echo "== D1 bundle binding and bounded consistency =="
mut "$L" 's|refuse(name + . does not match the digest|pass  #|' "$LT" "d1: ignore a modified file"
mut "$L" "s|if sha256_file(dump) != want_dump:|if False:|"      "$LT" "d1: ignore a substituted dump"
mut "$L" "s|if present - want:|if False:|"                      "$LT" "d1: ignore an intruding file"
mut "$L" "s|if want - have:|if False:|"                         "$LT" "d1: ignore a missing table"
mut "$L" "s|if window > CONSUMER_WINDOW_MAX:|if False:|"        "$LT" "d1: ignore the capture window"
mut "$L" "s|if declared_max > CONSUMER_WINDOW_MAX:|if False:|"  "$LT" "d1: let the sidecar declare its own window limit"
mut "$L" "s|if header.get('capture_order') != 'mysql-not-older-than-d1':|if False:|" "$LT" "d1: ignore capture order"
mut "$L" "s|if header.get('coherence') != 'pass':|if False:|"   "$LT" "d1: ignore recorded coherence"

echo "== the sidecar generator =="
mut "$G" 's|if st.st_mode \& 0o022:|if False:|'                      "$DT" "sidecar: accept a writable input"
mut "$G" 's|if os.path.islink(path):|if False:|'                     "$DT" "sidecar: accept a symlinked input"
mut "$G" 's|!= TABLES_MANIFEST_SHA256|!= sha256_file(tables_manifest)|' "$DT" "sidecar: accept any table manifest"
mut "$G" 's|if span > CAPTURE_WINDOW_MAX:|if False:|'                "$DT" "sidecar: seal an out-of-window bundle"
mut "$G" 's|window = math.ceil(span)|window = int(span)|'            "$DT" "sidecar: round the window down instead of up"
mut "$G" 's|if dump_mtime < max(mtimes):|if False:|'                 "$DT" "sidecar: seal a dump older than the export"
mut "$G" 's|if coherence != "pass":|if False:|'                      "$DT" "sidecar: seal an incoherent bundle"
mut "$G" 's|            if not ref:|            if False:|'          "$DT" "sidecar: accept a prefix-only order reference"
mut "$G" 's|            refuse("payment_claims.json is neither a list nor an object")|            rows = []|' "$DT" "sidecar: accept an unknown payment_claims shape"
mut "$G" 's|os.chmod(_TMP_PATH, 0o640)|pass|'                        "$DT" "sidecar: leave the published mode to umask"
mut "$G" 's|if open(_TMP_PATH, encoding="utf-8").read() != text:|if False:|' "$DT" "sidecar: publish without re-reading"
mut "$G" 's|    _cleanup()  # the only cleanup on the refusal path|    pass|' "$DT" "sidecar: refuse without cleaning up"

echo "== owner bundle restaging =="
mut "$B" 's|\[ "$HEAD_SHA" = "$WANT_SHA" \]|true|'  "$BT" "restage: accept a checkout at any sha"
mut "$B" 's|\*) die "the checkout.s origin is not a known remote for this repository" ;;|*) : ;;|' "$BT" "restage: accept any remote"
mut "$B" 's|\[ -z "$(git -C "$CHECKOUT" status --porcelain)" \]|true|' "$BT" "restage: accept a dirty tree"
mut "$B" 's|git -C "$CHECKOUT" merge-base --is-ancestor "$WANT_SHA" refs/remotes/origin/main|true|' "$BT" "restage: accept an unpublished commit"
mut "$B" 's|git -C "$CHECKOUT" rev-parse --verify --quiet refs/remotes/origin/main >/dev/null|true|' "$BT" "restage: accept a checkout with no tracking ref"
mut "$B" 's|\[ ! -L "$src" \]|true|'                "$BT" "restage: accept a symlinked file"
mut "$B" 's|( cd "$TMP" \&\& sha256sum -c --status MANIFEST )|true|' "$BT" "restage: skip the hash check"
mut "$B" 's|\[ "$PIN" = "$ACTUAL" \]|true|'         "$BT" "restage: accept a mismatched installer"

echo "== subject separation =="
mut "$R" 's|\[ "$APPLIED_TO_RESTORE" -eq "$PENDING_COUNT" \]|true|'  "$ST" "subjects: ignore the applied count"
mut "$R" 's|\[ "$LEDGER_NOW" = "$PROD_LEDGER_BEFORE" \]|true|'       "$ST" "subjects: ignore the ledger marker"
mut "$R" 's|\[ "$OLD_APP_TARGET" != "$DEST_C" \]|true|'              "$ST" "subjects: old image against the destination"
mut "$R" 's|    1) OLD_APP_SCHEMA_COMPAT=fail|    1) :|'             "$ST" "subjects: ignore a blocked schema gate"
mut "$R" 's|    \*) die "the schema gate could not be run|    *) : "the schema gate could not be run|' "$ST" "subjects: treat a broken probe as a verdict"
mut "$R" 's|      if grep -q .\^BLOCK. "$ART/gate-${svc}.log"; then|      if true; then|' "$ST" "subjects: exit 1 without BLOCK counts as a verdict"
mut "$R" 's|\[ "$APPLIED_TO_RESTORE" -gt 0 \]|true|'                 "$ST" "subjects: allow zero migrations applied"

echo "== cleanup =="
# The replacement for the invalid mutation below: appended AFTER the real
# definition, so it is the one bash actually calls.
mut "$R" '/^trap cleanup EXIT$/i cleanup() { :; }' "$CT" "cleanup: shadow the real definition (effective)"
mut "$R" 's|docker rm -f "$c" >/dev/null 2>&1 \|\| true|true|'      "$CT" "cleanup: never remove a container"
mut "$R" 's|docker network rm "$n" >/dev/null 2>&1 \|\| true|true|' "$CT" "cleanup: never remove the network"
mut "$R" 's|\[ -z "$d" \] \|\| rm -rf "$d"|:|'                      "$CT" "cleanup: never remove a temp directory"
mut "$R" "s|trap 'on_signal INT 130' INT|trap cleanup INT|"         "$CT" "cleanup: a bare INT trap that resumes"

echo "== declared invalid, and proven so =="
# The one from the previous round, kept so the accounting is auditable rather
# than merely corrected. The proof: with the stub inserted, the mutant's
# `cleanup` still contains the real body, because the later definition wins.
invalid "$R" 's|^CLEANED=0$|CLEANED=0; cleanup() { :; }|' "$CT" \
  "cleanup: stub inserted ABOVE the real definition" \
  grep -q 'docker rm -f "\$c"' "$R"

echo
EFFECTIVE=$((MATCHED - INVALID))
printf 'mutation attempts        %s\n' "$ATTEMPTS"
printf 'matched source           %s\n' "$MATCHED"
printf 'invalid / no-op          %s\n' "$INVALID"
printf 'semantically effective   %s\n' "$EFFECTIVE"
printf 'effective killed         %s\n' "$KILLED"
printf 'effective survived       %s\n' "$SURVIVED"
[ -z "$NOMATCH_LIST" ]  || printf 'did not match source:%s\n' "$NOMATCH_LIST"
[ -z "$INVALID_LIST" ]  || printf 'invalid (excluded):%s\n' "$INVALID_LIST"
[ -z "$SURVIVOR_LIST" ] || printf 'SURVIVORS:%s\n' "$SURVIVOR_LIST"
echo
[ "$SURVIVED" -eq 0 ] && [ -z "$NOMATCH_LIST" ]
