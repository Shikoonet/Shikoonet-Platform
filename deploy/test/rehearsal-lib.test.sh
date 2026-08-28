#!/usr/bin/env bash
# The rehearsal's guards, executed rather than grepped.
#
# The previous suite for this feature was 69 textual assertions. They proved the
# script CONTAINED certain strings; they could not have caught a single one of
# the review findings, because every one of those was about behaviour. These
# call the real functions with real inputs.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
# shellcheck source=deploy/rehearsal-lib.sh
. "$ROOT/deploy/rehearsal-lib.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

accepts() { # name  cmd...
  local n=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$n"; else bad "$n" "it refused: $("$@" 2>&1 | tail -1)"; fi
}
refuses() { # name  want-substring  cmd...
  local n=$1 want=$2; shift 2
  local out rc
  set +e; out=$("$@" 2>&1); rc=$?; set -e
  if [ "$rc" -eq 0 ]; then bad "$n" 'it was accepted'; return; fi
  case "$out" in *"$want"*) ok "$n" ;; *) bad "$n" "refused, but not for '${want}': ${out}" ;; esac
}

# ── pending range ────────────────────────────────────────────────────────
section 'the pending range comes from the restored ledger'

MIGDIR="$WORK/migrations"; mkdir -p "$MIGDIR"
for n in 0001 0002 0003 0004 0005; do : >"$MIGDIR/${n}_m.sql"; done
led() { printf '%s\n' "$@" >"$WORK/led"; printf '%s' "$WORK/led"; }

got=$(rehearsal_pending_range "$(led 0001_m.sql 0002_m.sql)" "$MIGDIR")
if [ "$got" = '0003..0005' ]; then ok 'a ledger behind the repo yields the pending range only'; else
  bad 'a ledger behind the repo yields the pending range only' "got '${got}'"
fi

# The bug this replaces: deriving the range from every file in the repository.
if [ "$got" = '0001..0005' ]; then
  bad 'the range is not the whole repository' 'it is'
else
  ok 'the range is not the whole repository'
fi

got=$(rehearsal_pending_range "$(led 0001_m.sql 0002_m.sql 0003_m.sql 0004_m.sql)" "$MIGDIR")
eq() { if [ "$2" = "$1" ]; then ok "$3"; else bad "$3" "got '$2'"; fi; }
eq '0005..0005' "$got" 'a single pending migration is a one-element range'

refuses 'a ledger naming an unknown migration is refused' 'does not contain' \
  rehearsal_pending_range "$(led 0001_m.sql 0099_ghost.sql)" "$MIGDIR"
refuses 'a gap in the applied set is refused' 'there is a gap' \
  rehearsal_pending_range "$(led 0001_m.sql 0003_m.sql)" "$MIGDIR"
refuses 'a fully-applied ledger is refused' 'already has every migration' \
  rehearsal_pending_range "$(led 0001_m.sql 0002_m.sql 0003_m.sql 0004_m.sql 0005_m.sql)" "$MIGDIR"
refuses 'an empty repository is refused' 'no migrations' \
  rehearsal_pending_range "$(led 0001_m.sql)" "$WORK"

# ── vitest judgement ─────────────────────────────────────────────────────
section 'the suite is judged on its exit code, not only its counts'

mkreport() { # failed_file passed skipped extra_failed_assertion
  python3 - "$WORK/report.json" "$1" "$2" "$3" "$4" <<'PY'
import json,sys
path, failfile, passed, skipped, extrafail = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4]), sys.argv[5]
files=[]
per = passed // 10
rem = passed - per*10
for i in range(10):
    n = per + (1 if i < rem else 0)
    ar = [{"status":"passed"} for _ in range(n)]
    if i == 0:
        ar += [{"status":"skipped"} for _ in range(skipped)]
    files.append({"name": f"/r/packages/migrate/test/f{i}.mysql.test.ts",
                  "status":"passed", "assertionResults": ar})
if failfile == "yes":
    files.append({"name":"/r/packages/migrate/test/other.test.ts","status":"failed",
                  "assertionResults":[{"status":"failed"}]})
elif extrafail == "yes":
    files.append({"name":"/r/packages/migrate/test/other.test.ts","status":"passed",
                  "assertionResults":[{"status":"failed"}]})
else:
    files.append({"name":"/r/packages/migrate/test/other.test.ts","status":"passed",
                  "assertionResults":[{"status":"passed"}]})
json.dump({"testResults":files}, open(path,"w"))
PY
  printf '%s' "$WORK/report.json"
}

accepts 'a clean run with 49 passed is accepted' \
  rehearsal_check_vitest "$(mkreport no 49 0 no)" 0 49

# The mutation the review named: 49 pass, another file fails.
refuses 'a non-zero exit code is refused even with 49 passing' 'a suite that fails anywhere' \
  rehearsal_check_vitest "$(mkreport no 49 0 no)" 1 49
refuses 'a failed test FILE is refused' 'a test file failed' \
  rehearsal_check_vitest "$(mkreport yes 49 0 no)" 0 49
refuses 'a failed assertion elsewhere is refused' 'assertion(s) failed' \
  rehearsal_check_vitest "$(mkreport no 49 0 yes)" 0 49
refuses 'a skipped dump test is refused' 'were skipped' \
  rehearsal_check_vitest "$(mkreport no 48 1 no)" 0 49
refuses 'fewer than 49 is refused' '/49 dump-gated' \
  rehearsal_check_vitest "$(mkreport no 48 0 no)" 0 49
refuses 'an unparsable report is refused' 'did not parse' \
  rehearsal_check_vitest /dev/null 0 49

printf '{"testResults":[]}' >"$WORK/empty.json"
refuses 'an empty report is refused' 'contains no files' \
  rehearsal_check_vitest "$WORK/empty.json" 0 49

# Wrong number of dump files collected: the suite did not run what it claims.
python3 -c '
import json,sys
files=[{"name":f"/r/packages/migrate/test/f{i}.mysql.test.ts","status":"passed",
        "assertionResults":[{"status":"passed"}]*7} for i in range(7)]
json.dump({"testResults":files},open(sys.argv[1],"w"))' "$WORK/short.json"
refuses 'a partial set of dump files is refused' 'production-dump file(s) ran, expected 10' \
  rehearsal_check_vitest "$WORK/short.json" 0 49

# ── financial comparison ─────────────────────────────────────────────────
section 'the financial comparison is across datasets and fails on zero rows'

mkagg() { printf 'wallet_balance=%s\nledger_sum=%s\norder_total=%s\n' "$2" "$3" "$4" >"$WORK/$1"; printf '%s' "$WORK/$1"; }

got=$(rehearsal_compare_totals "$(mkagg src 100 100 250)" "$(mkagg dst 100 100 250)")
eq match "$got" 'equal aggregates report match'

got=$(rehearsal_compare_totals "$(mkagg src 100 100 250)" "$(mkagg dst 100 99 250)")
case "$got" in mismatch:*ledger_sum*) ok 'a differing aggregate is named' ;; *) bad 'a differing aggregate is named' "got '${got}'" ;; esac

# The amounts must never appear in the verdict.
case "$got" in *100*|*99*|*250*) bad 'no amount appears in the verdict' "got '${got}'" ;; *) ok 'no amount appears in the verdict' ;; esac

# The bug this replaces: a schema-only destination has zero rows, so every
# self-comparison agrees and the run reports match.
refuses 'an all-zero destination is refused, not reported as match' 'empty destination is not a match' \
  rehearsal_compare_totals "$(mkagg src 100 100 250)" "$(mkagg dst 0 0 0)"

refuses 'an unmeasured aggregate is refused' 'not measured' \
  rehearsal_compare_totals "$(mkagg src 1 1 1)" /dev/null

# ── config security ──────────────────────────────────────────────────────
section 'the configuration file is checked before it is read'

CFG="$WORK/rehearsal.env"
printf 'MIRZABOT_DUMP=/x\nREPO_DIR=/y\n' >"$CFG"
accepts 'a well-formed config parses' rehearsal_parse_config "$CFG" MIRZABOT_DUMP REPO_DIR
refuses 'a missing required key is refused' 'missing required key' \
  rehearsal_parse_config "$CFG" MIRZABOT_DUMP REPO_DIR PROD_BACKUP_DIR

printf 'MIRZABOT_DUMP=/x\nMIRZABOT_DUMP=/z\n' >"$CFG"
refuses 'a duplicate key is refused rather than last-one-wins' 'appears more than once' \
  rehearsal_parse_config "$CFG" MIRZABOT_DUMP

printf 'MIRZABOT_DUMP=/x\nthis is not a setting\n' >"$CFG"
refuses 'a malformed line is refused' 'neither a comment nor' \
  rehearsal_parse_config "$CFG" MIRZABOT_DUMP

printf 'MIRZABOT_DUMP=/x\x01/y\n' >"$CFG"
refuses 'a control character in a value is refused' 'control character' \
  rehearsal_parse_config "$CFG" MIRZABOT_DUMP

printf '# a comment\n\nMIRZABOT_DUMP=/x\n' >"$CFG"
accepts 'comments and blank lines are allowed' rehearsal_parse_config "$CFG" MIRZABOT_DUMP

section 'file ownership and mode are enforced'

OWNED="$WORK/owned.env"
: >"$OWNED"; chmod 600 "$OWNED"
# Running as a normal user, so the root-owner check must refuse — which is the
# assertion: the check is real and not a comment.
# The expected text is the FILE-owner message specifically. An earlier version
# of this asserted "not root", which the parent-directory message also contains
# — so removing the file-owner check entirely still passed, for the wrong
# reason. A mutation test caught it.
refuses 'a non-root-owned config is refused, by its own owner check' 'is owned by' \
  rehearsal_require_secure_file "$OWNED" 600 'the config'
ln -sf "$OWNED" "$WORK/link.env"
refuses 'a symlinked config is refused' 'symlink' \
  rehearsal_require_secure_file "$WORK/link.env" 600 'the config'
refuses 'a missing config is refused' 'does not exist' \
  rehearsal_require_secure_file "$WORK/nope.env" 600 'the config'
refuses 'a directory is refused' 'not a regular file' \
  rehearsal_require_secure_file "$WORK" 600 'the config'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
