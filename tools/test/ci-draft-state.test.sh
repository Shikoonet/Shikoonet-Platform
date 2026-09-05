#!/usr/bin/env bash
#
# The two questions `ci-draft-state.sh` answers, against a fake `gh`.
#
# This exists for the same reason `ci-plan.test.sh` does: a check about CI is
# the one whose bugs are invisible. If `state` ever answered `true` when it
# could not reach the API, every run on a Ready pull request would quietly
# become the fast gate — and everything would still be green.
#
# So the failure cases are the point. `gh` is replaced by a script on PATH that
# can be told to fail, to hang up, or to answer nonsense, and the assertions are
# about which direction each answer falls in.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SUT="$ROOT/tools/ci-draft-state.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }

# A `gh` that answers with $1 on stdout, or fails when $1 is the word `down`.
fake_gh() {
  mkdir -p "$WORK/bin"
  if [ "$1" = down ]; then
    printf '#!/usr/bin/env bash\necho "API rate limit exceeded" >&2\nexit 1\n' >"$WORK/bin/gh"
  else
    printf '#!/usr/bin/env bash\necho %s\n' "$1" >"$WORK/bin/gh"
  fi
  chmod +x "$WORK/bin/gh"
  export PATH="$WORK/bin:$PATH"
}

run() { # answer  args...  -> stdout, exit code in $?
  local answer=$1
  shift
  (
    fake_gh "$answer"
    bash "$SUT" "$@"
  )
}

printf '\nwhat the pull request is now\n'

for answer in true false; do
  got=$(run "$answer" state acme/repo 7)
  [ "$got" = "$answer" ] && ok "reports draft=${answer} from the API" ||
    bad "reports draft=${answer} from the API" "got '${got}'"
done

# The direction that matters: no answer must mean the COMPLETE gate, never the
# fast one. A `true` here would skip the database and browser suites on every
# run that happened to hit a rate limit.
got=$(run down state acme/repo 7 2>/dev/null)
[ "$got" = false ] && ok 'an unreachable API plans as NOT a draft' ||
  bad 'an unreachable API plans as NOT a draft' "got '${got}'"

got=$(run '"maybe"' state acme/repo 7 2>/dev/null)
[ "$got" = false ] && ok 'an answer that is neither true nor false plans as NOT a draft' ||
  bad 'an answer that is neither true nor false plans as NOT a draft' "got '${got}'"

printf '\nwhether the plan survived the run\n'

# The bug this whole file exists for: a run that planned as a draft, landing
# green on a pull request that is Ready by the time the gate speaks.
if run false assert-fresh true acme/repo 7 >/dev/null 2>&1; then
  bad 'a draft plan on a Ready pull request is refused' 'it passed'
else
  ok 'a draft plan on a Ready pull request is refused'
fi

for pair in 'true true' 'false false' 'false true'; do
  set -- $pair
  if run "$2" assert-fresh "$1" acme/repo 7 >/dev/null 2>&1; then
    ok "planned=${1}, now=${2} is accepted"
  else
    bad "planned=${1}, now=${2} is accepted" 'it was refused'
  fi
done

# A gate that goes red because GitHub had a bad minute is a gate people re-run
# without reading. This one is a SECOND opinion about work already done, so it
# abstains rather than guesses — the opposite direction from `state` above, and
# deliberately so.
if run down assert-fresh true acme/repo 7 >/dev/null 2>&1; then
  ok 'an unreachable API does not claim the plan is stale'
else
  bad 'an unreachable API does not claim the plan is stale' 'it was refused'
fi

printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
