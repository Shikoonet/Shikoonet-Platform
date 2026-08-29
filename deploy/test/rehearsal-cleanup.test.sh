#!/usr/bin/env bash
# What does the rehearsal leave behind, and what does it say out loud?
#
# Both questions have to be answered by running it, not by reading it. A
# cleanup trap that is registered is not a cleanup trap that ran, and a script
# that never prints a token in the source can still put one in argv, where
# every other process on the box can read it out of /proc.
#
# Credential inventory, from the script itself:
#
#   owner-held production read credentials
#     the production backup dump      read-only, opened by path, never copied out
#     the Coolify database            reached as `docker exec coolify-db psql -U coolify`,
#                                     a local socket inside a container, no password
#   GitHub credential
#     GITHUB_TOKEN                    from the 0640 root-owned config, written into a
#                                     0600 curl config file, never into argv, unset
#                                     from the shell once written
#   throwaway container credentials
#     POSTGRES_PASSWORD=rehearsal     invented per run, on containers this run created
#     MYSQL_ALLOW_EMPTY_PASSWORD      no password at all
#
# The throwaway password is the one that looks alarming in a diff, so the tests
# below prove the thing that actually matters about it: it is only ever offered
# to a container this run created, on a network this run created, and it is
# never presented to anything in production.
set -uo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
PASS=0; FAIL=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }

# shellcheck source=deploy/test/rehearsal-world.sh
. "$HERE/rehearsal-world.sh"
rehearsal_become_root "$0" "$@"
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
TOKEN=ghp_faketokenfortests000000000000000000

WORKROOT=$(mktemp -d); trap 'rm -rf "$WORKROOT"' EXIT
SCRIPT="$ROOT/deploy/production-dump-rehearsal.sh"

echo "rehearsal cleanup and credentials"

# ── the token never reaches argv ─────────────────────────────────────────
#
# The static half: curl is configured through a file, so the only way the token
# could reach a command line is if someone added a header flag.
if grep -nE 'curl[^|]*(-H|--header)[^|]*Authorization' "$SCRIPT" "$ROOT/deploy/rehearsal-lib.sh"; then
  bad "no curl invocation carries the token in argv" "a header flag was found"
else ok "no curl invocation carries the token in argv"; fi
# shellcheck disable=SC2016  # the '$NAME' here are the literals being searched for
if grep -nE '\$GH_TOKEN_VALUE|\$GITHUB_TOKEN' "$SCRIPT" | grep -vE 'printf|cfg GITHUB_TOKEN|GH_TOKEN_VALUE=\$|unset|\[ -n'; then
  bad "the token is only ever written into the curl config" "another use was found"
else ok "the token is only ever written into the curl config"; fi
if grep -q '^unset GH_TOKEN_VALUE' "$SCRIPT"; then ok "the token is unset from the shell once the config is written"; else bad "the token is unset from the shell once the config is written" ""; fi

# The script must not create the credential files a psql/mysql client would
# read from disk; it does not use any, and a future edit that did would put a
# secret somewhere this cleanup does not know about.
if grep -nE '\.pgpass|pg_service\.conf|\.my\.cnf|--password=|MYSQL_PWD' "$SCRIPT"; then
  bad "no libpq or MySQL credential file is created" "one was found"
else ok "no libpq or MySQL credential file is created"; fi

# ── a successful run cleans everything it made ───────────────────────────
W="$WORKROOT/ok"; build_world "$W"
run_rehearsal "$W"; RC=$?
if [ "$RC" -eq 0 ]; then ok "the reference run succeeds"; else bad "the reference run succeeds" "$(tail -3 "$W/out")"; fi

check_clean() { # world label
  local w=$1 label=$2
  local c n
  # Every temporary directory the run made — the curl config holding the token,
  # the GitHub artifact and what was unpacked from it, the staging area the
  # attestation was written in — lived under TMPDIR, so an empty TMPDIR is the
  # whole claim rather than a sample of it.
  n=$(find "$w/tmp" -mindepth 1 2>/dev/null | wc -l)
  if [ "$n" = 0 ]; then
    ok "$label: no temporary directory survives"
  else
    bad "$label: no temporary directory survives" "$(find "$w/tmp" -mindepth 1 | head -3)"
  fi

  while read -r c; do
    [ -n "$c" ] || continue
    n=$(grep -c "^rm|$c|" "$w/log")
    if [ "$n" = 1 ]; then
      ok "$label: $(echo "$c" | cut -d- -f3) removed exactly once"
    else
      bad "$label: $(echo "$c" | cut -d- -f3) removed exactly once" "removed $n time(s)"
    fi
  # Containers only. Now that argv is logged, `shikoo-rehearsal-net-…` appears
  # in it too, and a network is removed by `network rm`, not `rm` — so a
  # wildcard here invented a container that was never removed.
  done < <(grep -oE 'shikoo-rehearsal-(restore|mysql|dest)-[0-9-]*' "$w/log" 2>/dev/null | sort -u)
  n=$(grep -c '^network|||rm' "$w/log" 2>/dev/null) || n=0
  if [ "$n" = 1 ]; then ok "$label: the rehearsal network is removed exactly once"; else bad "$label: the rehearsal network is removed exactly once" "removed $n time(s)"; fi
}
check_clean "$W" "success"

# ── nothing sensitive was said out loud ──────────────────────────────────
leak_check() { # world label
  local w=$1 label=$2
  local hits
  hits=$(grep -ciE "$TOKEN|POSTGRES_PASSWORD=rehearsal|postgres://postgres:rehearsal" "$w/out" || true)
  if [ "$hits" = 0 ]; then ok "$label: no credential in stdout or stderr"; else bad "$label: no credential in stdout or stderr" "$hits line(s)"; fi
  # The dump path and the backup path are on the secure host and name customer
  # data; neither belongs in output that leaves it.
  hits=$(grep -cF "$w/dump.sql" "$w/out" || true)
  if [ "$hits" = 0 ]; then ok "$label: the dump path is never printed"; else bad "$label: the dump path is never printed" "$hits line(s)"; fi
  hits=$(grep -ciE 'wallet_balance=[0-9]|ledger_sum=[0-9]|order_total=[0-9]|1234 (source|destination)? *users?' "$w/out" || true)
  case "$label:$hits" in
    *:0) ok "$label: no financial value or row identifier is printed" ;;
    *) bad "$label: no financial value or row identifier is printed" "$hits line(s)" ;;
  esac
}
leak_check "$W" "success"

# The token must not have reached any child process's arguments. The fake
# docker records what it was called with; the fake curl records the URL. If the
# token were in argv anywhere, it would be in this log.
if grep -qF "$TOKEN" "$W/log"; then
  bad "the token never appears in a child process's arguments" "found in the invocation log"
else ok "the token never appears in a child process's arguments"; fi

# The throwaway credential is offered only to containers this run created.
# At least one URI must have been observed, or this proves nothing: a log with
# no connection string at all left BADHOST at 0 and reported a pass.
BADHOST=0; SEEN=0
while IFS= read -r line; do
  SEEN=$((SEEN + 1))
  case "$line" in
    *shikoo-rehearsal-*) ;;
    *) BADHOST=1 ;;
  esac
done < <(grep -oE 'postgres://postgres:rehearsal@[^:]*' "$W/log" 2>/dev/null || true)
if [ "$SEEN" -eq 0 ]; then
  bad "the throwaway password is only ever presented to this run's own containers" \
    "no connection URI was recorded at all — the check had nothing to inspect"
elif [ "$BADHOST" = 0 ]; then
  ok "the throwaway password is only ever presented to this run's own containers (${SEEN} observed)"
else
  bad "the throwaway password is only ever presented to this run's own containers" "a foreign host appeared"
fi
# And it is never presented to the production database or to Coolify's.
#
# What was here grepped `^(query|migration|invariants)\|(coolify-db|live-)`
# — verb lines whose fields are a container, a database and some SQL. A
# password could not appear on those lines at all, so the first stage matched
# nothing, the second read empty input, and the else branch reported a pass.
# Even on a match, `grep -q 'rehearsal'` was testing for the container-name
# substring rather than for the credential.
#
# The argv lines are where a credential would actually be, so that is what is
# searched: every invocation carrying the throwaway password, checked for a
# production target.
PRODHIT=0
while IFS= read -r line; do
  case "$line" in
    *coolify-db*|*live-*) PRODHIT=$((PRODHIT + 1)) ;;
  esac
done < <(grep -F 'postgres:rehearsal@' "$W/log" 2>/dev/null || true)
if [ "$PRODHIT" -eq 0 ]; then
  ok "the throwaway password never reaches production or Coolify"
else
  bad "the throwaway password never reaches production or Coolify" "${PRODHIT} invocation(s) named a production target"
fi
# And the converse: nothing aimed at a production target carries it.
if grep -F 'argv|' "$W/log" | grep -E 'coolify-db|live-' | grep -q 'rehearsal@'; then
  bad "no production-targeted invocation carries the throwaway credential" "one does"
else
  ok "no production-targeted invocation carries the throwaway credential"
fi

# ── the attestation and the fixtures are clean too ───────────────────────
# `readlink -f` prints a path whose final component does not exist, so `-n
# "$VER"` was true even for a run that published nothing — `grep` then failed
# and the else branch reported this credential check as passing.
VER=$(readlink -f "$W/state/attestation/current" 2>/dev/null || true)
if [ -n "$VER" ] && [ -f "$VER/attestation.env" ]; then
  if grep -qiE "$TOKEN|rehearsal@|/tmp/|wallet_balance=[0-9]" "$VER/attestation.env"; then
    bad "the attestation carries no credential, path or amount" "$(grep -ciE "$TOKEN|/tmp/" "$VER/attestation.env")"
  else ok "the attestation carries no credential, path or amount"; fi
else bad "the attestation carries no credential, path or amount" "no attestation"; fi

if grep -rqiE 'ghp_[A-Za-z0-9]{20,}' "$ROOT/deploy/test/fake" 2>/dev/null; then
  bad "the test fixtures carry no realistic credential" "a token-shaped string is committed"
else ok "the test fixtures carry no realistic credential"; fi

# ── ordinary failure, INT and TERM all clean up, exactly once ────────────
W2="$WORKROOT/fail"; build_world "$W2"
FAKE_VITEST_RC=1 run_rehearsal "$W2"; RC=$?
if [ "$RC" -ne 0 ]; then ok "an ordinary failure exits non-zero"; else bad "an ordinary failure exits non-zero" ""; fi
check_clean "$W2" "failure"
leak_check "$W2" "failure"

signal_clean() { # sig code
  local sig=$1 want=$2
  local w="$WORKROOT/sig$sig" rc job
  build_world "$w"
  # A backgrounded subshell inherits SIGINT as ignored — POSIX requires it for
  # asynchronous commands — and bash keeps an inherited-ignored signal ignored
  # even when the child installs a trap. Without resetting it here the INT case
  # silently tests nothing: the run would finish normally and the test would
  # have to be read as passing. `trap - INT TERM` restores the default
  # disposition before the real script is exec'd.
  ( trap - INT TERM; run_rehearsal "$w"; echo $? >"$w/rc" ) &
  job=$!
  for _ in $(seq 1 400); do grep -q '^run-daemon' "$w/log" 2>/dev/null && break; sleep 0.05; done
  pkill -"$sig" -f "$w/bin/rehearsal.sh" 2>/dev/null
  wait "$job" 2>/dev/null
  rc=$(cat "$w/rc" 2>/dev/null || echo missing)
  if [ "$rc" = "$want" ]; then ok "$sig exits with the signal-derived code $want"; else bad "$sig exits with the signal-derived code $want" "exit was $rc"; fi
  check_clean "$w" "$sig"
  leak_check "$w" "$sig"
}
signal_clean INT 130
signal_clean TERM 143

echo
printf 'cleanup: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
