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


# ── images ───────────────────────────────────────────────────────────────
section 'images must be immutable, local, and never pulled'

HEX=$(printf 'a%.0s' $(seq 64))
accepts 'a digest reference is accepted' \
  rehearsal_require_digest_ref "postgres@sha256:${HEX}" PG_IMAGE
accepts 'a registry-qualified digest is accepted' \
  rehearsal_require_digest_ref "ghcr.io/x/y@sha256:${HEX}" NODE_IMAGE

# The mutation the policy exists for: a tag is a name for whatever was pushed
# last, so the same rehearsal on two days is two different rehearsals.
refuses 'a plain tag is refused' 'not an immutable digest' \
  rehearsal_require_digest_ref 'postgres:16-alpine' PG_IMAGE
refuses 'a tag plus digest-looking suffix is refused' 'not an immutable digest' \
  rehearsal_require_digest_ref "postgres:16@sha256:${HEX}x" PG_IMAGE
refuses 'an uppercase digest is refused' 'not an immutable digest' \
  rehearsal_require_digest_ref "postgres@sha256:$(printf 'A%.0s' $(seq 64))" PG_IMAGE
refuses 'a short digest is refused' 'not an immutable digest' \
  rehearsal_require_digest_ref 'postgres@sha256:abc' PG_IMAGE
refuses 'a multiline reference is refused' 'newline' \
  rehearsal_require_digest_ref "postgres@sha256:${HEX}
evil" PG_IMAGE
refuses 'an empty reference is refused' 'not an immutable digest' \
  rehearsal_require_digest_ref '' PG_IMAGE

# Locality, checked with a fake docker so the test needs no images.
FAKED="$WORK/bin"; mkdir -p "$FAKED"
cat >"$FAKED/docker-present" <<'EOF'
#!/bin/sh
exit 0
EOF
cat >"$FAKED/docker-absent" <<'EOF'
#!/bin/sh
[ "$1" = image ] && exit 1
exit 0
EOF
chmod +x "$FAKED/docker-present" "$FAKED/docker-absent"
accepts 'present images pass the locality check' \
  rehearsal_require_local_images "$FAKED/docker-present" "a@sha256:${HEX}"
refuses 'an absent image is refused before anything is created' 'not present locally' \
  rehearsal_require_local_images "$FAKED/docker-absent" "a@sha256:${HEX}"
refuses 'the refusal names preloading rather than pulling' 'it will not pull' \
  rehearsal_require_local_images "$FAKED/docker-absent" "a@sha256:${HEX}"

# ── D1 export ────────────────────────────────────────────────────────────
section 'the D1 export is required, real, and never the fixture'

D1="$WORK/d1"; mkdir -p "$D1"
mkd1() { # tables... -> writes plausible rows
  rm -rf "$D1"; mkdir -p "$D1"
  for t in "$@"; do
    printf '[{"id":1,"email":"ops@shikoo.ir"},{"id":2,"email":"a@b.ir"}]' >"$D1/${t}.json"
  done
}
TABLES='access_users,devices,device_credentials,settings'
mkd1 access_users devices device_credentials settings
accepts 'a complete real-looking export is accepted' rehearsal_validate_d1_export "$D1" "$TABLES"

refuses 'an empty path is refused, with no default' 'no default' \
  rehearsal_validate_d1_export '' "$TABLES"
refuses 'a missing directory is refused' 'does not exist' \
  rehearsal_validate_d1_export "$WORK/nope" "$TABLES"

ln -sfn "$D1" "$WORK/d1link"
refuses 'a symlinked export directory is refused' 'symlink' \
  rehearsal_validate_d1_export "$WORK/d1link" "$TABLES"

mkd1 access_users devices
refuses 'an incomplete table set is refused' 'incomplete' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

mkd1 access_users devices device_credentials settings
: >"$D1/settings.json"
refuses 'an empty table file is refused' 'empty' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

mkd1 access_users devices device_credentials settings
printf '{not json' >"$D1/devices.json"
refuses 'malformed JSON is refused' 'not valid JSON' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

mkd1 access_users devices device_credentials settings
printf '[]' >"$D1/devices.json"
refuses 'a table with no rows is refused' 'no rows' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

# The substitution this policy exists to stop.
mkd1 access_users devices device_credentials settings
printf '[{"id":1,"email":"someone@example.com"}]' >"$D1/access_users.json"
refuses 'a fixture signature is refused' 'fixture signature' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

mkd1 access_users devices device_credentials settings
printf '[{"id":1,"note":"synthetic sample"}]' >"$D1/settings.json"
refuses 'a synthetic marker is refused' 'fixture signature' \
  rehearsal_validate_d1_export "$D1" "$TABLES"

mkd1 access_users devices device_credentials settings
chmod 777 "$D1"
refuses 'a world-writable export directory is refused' 'world-writable' \
  rehearsal_validate_d1_export "$D1" "$TABLES"
chmod 755 "$D1"

# ── live production images ───────────────────────────────────────────────
section 'the old image is derived from live state, never configured'

IMG=sha256:$(printf 'b%.0s' $(seq 64))
IMG2=sha256:$(printf 'c%.0s' $(seq 64))
live() { printf '%s\n' "$@" >"$WORK/live.txt"; printf '%s' "$WORK/live.txt"; }
WANT='shikoo-ingest,shikoo-dashboard,shikoo-bot'

got=$(rehearsal_check_live_production "$(live \
  "shikoo-ingest|production|c1|${IMG}|healthy" \
  "shikoo-dashboard|production|c2|${IMG}|healthy" \
  "shikoo-bot|production|c3|${IMG}|running")" "$WANT")
case "$got" in *shikoo-ingest=${IMG}*) ok 'three healthy production containers resolve' ;;
  *) bad 'three healthy production containers resolve' "got '${got}'" ;; esac

refuses 'a staging container is refused' "not production" \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|dev-fleet|c1|${IMG}|healthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy" \
    "shikoo-bot|production|c3|${IMG}|healthy")" "$WANT"

refuses 'a missing live container is refused' 'no live container for' \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|production|c1|${IMG}|healthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy")" "$WANT"

refuses 'two containers for one application is refused' 'expected exactly 1' \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|production|c1|${IMG}|healthy" \
    "shikoo-ingest|production|c9|${IMG2}|healthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy" \
    "shikoo-bot|production|c3|${IMG}|healthy")" "$WANT"

refuses 'a container with no image id is refused' 'not an immutable image id' \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|production|c1|ghcr.io/x/y:latest|healthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy" \
    "shikoo-bot|production|c3|${IMG}|healthy")" "$WANT"

refuses 'an unhealthy container is refused' 'not healthy' \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|production|c1|${IMG}|unhealthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy" \
    "shikoo-bot|production|c3|${IMG}|healthy")" "$WANT"

refuses 'a stopped application is refused' 'no running container' \
  rehearsal_check_live_production "$(live \
    "shikoo-ingest|production||${IMG}|healthy" \
    "shikoo-dashboard|production|c2|${IMG}|healthy" \
    "shikoo-bot|production|c3|${IMG}|healthy")" "$WANT"


# ── GitHub status awareness ──────────────────────────────────────────────
section 'a GitHub error is never a successful call'

GHBIN="$WORK/ghbin"; mkdir -p "$GHBIN"
mkcurl() { # status body
  cat >"$GHBIN/curl" <<EOF
#!/bin/sh
[ "$1" = TRANSPORT ] && exit 7
printf '%s%s' '$2' '$1'
EOF
  chmod +x "$GHBIN/curl"
  printf '%s' "$GHBIN/curl"
}
gh_probe() { # status body -> "rc|status"
  mkcurl "$1" "$2" >/dev/null
  PATH="$GHBIN:$PATH" bash -c '
    . "$1/deploy/rehearsal-lib.sh"
    set +e
    gh_request /dev/null https://api.github.com/x
    rc=$?
    printf "%s|%s" "$rc" "$GH_STATUS"
  ' _ "$ROOT"
}
for spec in '200|{"sha":"x"}|0|200' '401|{"message":"Bad credentials"}|0|401' \
            '403|{"message":"forbidden"}|0|403' '404|{"message":"Not Found"}|0|404' \
            '500|{"message":"oops"}|0|500'; do
  st=$(printf '%s' "$spec" | cut -d'|' -f1); body=$(printf '%s' "$spec" | cut -d'|' -f2)
  wrc=$(printf '%s' "$spec" | cut -d'|' -f3); wst=$(printf '%s' "$spec" | cut -d'|' -f4)
  got=$(gh_probe "$st" "$body")
  if [ "$got" = "${wrc}|${wst}" ]; then ok "HTTP ${st} is reported as ${st}"; else
    bad "HTTP ${st} is reported as ${st}" "got '${got}'"
  fi
done
got=$(gh_probe TRANSPORT '')
case "$got" in 1\|000) ok 'a transport failure is rc=1 with status 000' ;;
  *) bad 'a transport failure is rc=1 with status 000' "got '${got}'" ;; esac

# The classifier must refuse everything that is not 2xx, and say which.
for spec in '200|0' '204|0' '401|1' '403|1' '404|1' '500|1' '000|1' '302|1'; do
  st=${spec%%|*}; want=${spec##*|}
  set +e; out=$(gh_classify "$st" 'the call' 2>&1); rc=$?; set -e
  if [ "$rc" = "$want" ]; then ok "gh_classify ${st} -> rc ${want}"; else
    bad "gh_classify ${st} -> rc ${want}" "rc=${rc} ${out}"
  fi
done
set +e; out=$(gh_classify 401 'reading main' 2>&1); set -e
case "$out" in *"token is wrong or expired"*) ok 'a 401 names the token, not the release' ;;
  *) bad 'a 401 names the token, not the release' "got '${out}'" ;; esac

# ── exact identity ───────────────────────────────────────────────────────
section 'production resources are matched by exact identity'

U1=d9ulbwkdjpvg2ajalecruxzh; U2=huneuqvzyw0cjd4u0f7s37cf; U3=3xetld1oi3x7viq8cr8is0ls
obs() { printf '%s\n' "$@" >"$WORK/obs.txt"; printf '%s' "$WORK/obs.txt"; }
EXPECT="shikoo-ingest=${U1},shikoo-dashboard=${U2},shikoo-bot=${U3}"

accepts 'matching uuids are accepted' rehearsal_check_app_uuids \
  "$(obs "shikoo-ingest|${U1}" "shikoo-dashboard|${U2}" "shikoo-bot|${U3}")" "$EXPECT"
refuses 'a swapped uuid is refused' 'expected' rehearsal_check_app_uuids \
  "$(obs "shikoo-ingest|${U2}" "shikoo-dashboard|${U2}" "shikoo-bot|${U3}")" "$EXPECT"
refuses 'a missing application is refused' 'application set differs' rehearsal_check_app_uuids \
  "$(obs "shikoo-ingest|${U1}" "shikoo-dashboard|${U2}")" "$EXPECT"
refuses 'an extra application is refused' 'application set differs' rehearsal_check_app_uuids \
  "$(obs "shikoo-ingest|${U1}" "shikoo-dashboard|${U2}" "shikoo-bot|${U3}" "shikoo-dev-bot|${U1}")" "$EXPECT"
refuses 'a non-uuid is refused' 'not a Coolify uuid' rehearsal_check_app_uuids \
  "$(obs "shikoo-ingest|../etc" "shikoo-dashboard|${U2}" "shikoo-bot|${U3}")" "$EXPECT"

section 'the backup directory must BE the resource directory'

accepts 'the canonical backup directory is accepted' \
  rehearsal_backup_dir_belongs "/data/coolify/backups/databases/team/shikoo-postgres-${U1}" "$U1"
refuses 'a directory merely containing the uuid is refused' 'is not the backup directory' \
  rehearsal_backup_dir_belongs "/tmp/evil-${U1}-staging" "$U1"
refuses 'an unrelated directory is refused' 'is not the backup directory' \
  rehearsal_backup_dir_belongs "/data/backups/other-resource" "$U1"

section 'the repository remote is an exact allowlist'

for good in https://github.com/Shikoonet/Shikoonet-Platform \
            https://github.com/Shikoonet/Shikoonet-Platform.git \
            git@github.com:Shikoonet/Shikoonet-Platform.git; do
  accepts "an exact remote is accepted (${good##*/})" rehearsal_require_known_remote "$good"
done
# The substring test this replaces would have accepted every one of these.
for bad_r in https://evil.example/x/Shikoonet/Shikoonet-Platform-backdoor \
             https://github.com/Shikoonet/Shikoonet-Platform-evil \
             https://github.com/Evil/Shikoonet/Shikoonet-Platform \
             '' ; do
  refuses "a lookalike remote is refused (${bad_r:-empty})" 'not an exact known remote' \
    rehearsal_require_known_remote "$bad_r"
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
