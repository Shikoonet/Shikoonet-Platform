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
SKIPPED=0
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
section 'the D1 bundle is sealed, bounded, and coherent — and claims no more'

# What is being tested is BUNDLE BINDING plus a bounded-consistency contract,
# not a snapshot proof. Nothing at this layer can prove two artifacts were read
# from one consistent moment: D1 is a Cloudflare service and Mirzabot's MySQL is
# a different machine. The previous version of this file called it a snapshot
# anyway, which is the kind of overclaim a promotion gate would have believed.
D1="$WORK/d1"
DUMPF="$WORK/mirzabot.sql"
GEN="$ROOT/tools/d1-export-manifest.py"

# The generator pins the reviewed table manifest by digest, so the fixture uses
# the tracked file's exact bytes rather than a list of its own. It is copied at
# 0644 because that is the mode a verified checkout has on the secure host;
# this working tree has umask 002 and leaves it group-writable, which the
# generator is right to refuse.
TABLES_FILE="$WORK/d1-tables.manifest"
cp "$ROOT/deploy/d1-tables.manifest" "$TABLES_FILE"
chmod 644 "$TABLES_FILE"
ALL_TABLES=$(tr '\n' ',' <"$TABLES_FILE" | sed 's/,$//')

mkd1() { # -> a complete, sealed, in-contract export
  rm -rf "$D1"; mkdir -p "$D1"
  local t
  while read -r t; do
    [ -n "$t" ] || continue
    if [ "$t" = payment_claims ]; then
      printf '[{"id":1,"source_system":"MIRZABOT","external_order_id":"ORD-7001"}]' >"$D1/${t}.json"
    else
      printf '[{"id":1,"email":"ops@shikoo.ir"}]' >"$D1/${t}.json"
    fi
  done <"$TABLES_FILE"
  # The dump contains the order the claim references, and is written LAST so
  # MySQL is the later capture — the direction the contract requires.
  printf 'INSERT INTO invoice VALUES (1,"ORD-7001",5000);\n' >"$DUMPF"
  chmod 755 "$D1"; chmod 640 "$D1"/*.json "$DUMPF"
  python3 "$GEN" "$D1" "$DUMPF" "$TABLES_FILE" >/dev/null
}

mkd1
accepts 'a sealed, complete, in-contract bundle is accepted' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

refuses 'an empty path is refused, with no default' 'no default' \
  rehearsal_validate_d1_export '' "$ALL_TABLES" "$DUMPF"
refuses 'a missing directory is refused' 'does not exist' \
  rehearsal_validate_d1_export "$WORK/nope" "$ALL_TABLES" "$DUMPF"

ln -sfn "$D1" "$WORK/d1link"
refuses 'a symlinked export directory is refused' 'symlink' \
  rehearsal_validate_d1_export "$WORK/d1link" "$ALL_TABLES" "$DUMPF"

# No sidecar at all — the case the old heuristic accepted on sight.
mkd1; rm -f "$D1/d1-export.manifest"
refuses 'an export with no provenance is refused' 'no d1-export.manifest' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"
refuses 'the refusal names the generator to run' 'd1-export-manifest.py' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# A stale sidecar from an earlier bundle, kept beside new artifacts.
mkd1; cp "$D1/d1-export.manifest" "$WORK/stale.manifest"
printf '[{"id":2,"email":"new@shikoo.ir"}]' >"$D1/devices.json"
cp "$WORK/stale.manifest" "$D1/d1-export.manifest"
refuses 'a reused stale sidecar is refused' 'modified or replaced' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; rm -f "$D1/comments.json"
refuses 'a missing table file is refused' 'not present' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; printf '[{"id":99}]' >"$D1/devices.json"
refuses 'a modified D1 file is refused' 'modified or replaced' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; printf 'INSERT INTO invoice VALUES (1,"ORD-7001",9999);\n' >"$DUMPF"
refuses 'a modified dump is refused' 'sealed with' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# An arbitrary D1 export paired with a different dump: both internally valid,
# sealed to each other by nothing.
mkd1
OTHERDUMP="$WORK/other.sql"; printf 'INSERT INTO invoice VALUES (1,"ORD-9999",1);\n' >"$OTHERDUMP"
chmod 640 "$OTHERDUMP"
refuses 'an export paired with another dump is refused' 'sealed with' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$OTHERDUMP"

# Files mixed in from a second export.
mkd1
OTHER="$WORK/other"; rm -rf "$OTHER"; mkdir -p "$OTHER"
printf '[{"id":7,"email":"other@shikoo.ir"}]' >"$OTHER/devices.json"
cp "$OTHER/devices.json" "$D1/devices.json"
refuses 'a file from another export is refused' 'modified or replaced' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; printf '[{"id":1}]' >"$D1/not_in_contract.json"
refuses 'an extra table file is refused' 'unexpected file' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1
refuses 'a manifest that does not cover the contract is refused' 'does not cover' \
  rehearsal_validate_d1_export "$D1" "${ALL_TABLES},extra_table" "$DUMPF"

mkd1; rm -f "$D1/comments.json"; ln -s "$DUMPF" "$D1/comments.json"
refuses 'a symlinked table file is refused' 'symlink' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; chmod 666 "$D1/devices.json"
refuses 'a world-writable table file is refused' 'writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# Group-only. Every case here used 666 or 777, both of which set the "other"
# write bit — the one digit the old `*[2367]` pattern actually tested. Mode 770
# and 660 walked straight through, and 660 is the ordinary mode of a Coolify
# backup dump.
mkd1; chmod 770 "$D1"
refuses 'a group-writable export directory is refused' 'writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"
mkd1; chmod 660 "$D1/d1-export.manifest"
refuses 'a group-writable sidecar is refused' 'writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"
mkd1; chmod 660 "$D1/devices.json"
refuses 'a group-writable table file is refused' 'writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"
mkd1; chmod 777 "$D1"
refuses 'a world-writable export directory is refused' 'world-writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"
mkd1; chmod 666 "$D1/d1-export.manifest"
refuses 'a writable provenance sidecar is refused' 'writable' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# ── the bounded-consistency contract, enforced by the consumer ───────────
#
# These edit the sidecar's recorded verdicts directly, because the consumer has
# to refuse a bundle whose own generator recorded an out-of-contract capture —
# not merely trust that the generator would have refused first.
reseal() { # key=value ... -> rewrite the sidecar and its own coverage
  local kv
  for kv in "$@"; do
    sed -i "s|^${kv%%=*}=.*|${kv}|" "$D1/d1-export.manifest"
  done
}
mkd1; reseal 'capture_window_seconds=99999' 'capture_window_max=3600'
refuses 'a capture window outside the bound is refused' 'more than the' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# The limit belongs to this side. A sidecar that declares a wide window is
# declaring how much drift it would like to be forgiven, which is not its
# decision to make — the header is unauthenticated data from the artifact
# being validated.
mkd1; reseal 'capture_window_max=999999' 'capture_window_seconds=7200'
refuses 'a sidecar that declares its own wider window is refused' 'wider than' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; reseal 'capture_order=d1-newer-than-mysql'
refuses 'a D1 export newer than the dump is refused' 'later capture' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; reseal 'coherence=fail' 'coherence_missing=3'
refuses 'a recorded coherence mismatch is refused' 'coherence' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; reseal 'schema_version=1'
refuses 'an old sidecar schema is refused' 'unsupported schema_version' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

mkd1; reseal 'capture_id=short'
refuses 'a sidecar with no capture_id is refused' 'no capture_id' \
  rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF"

# The identity is returned and used, not computed and discarded.
mkd1
D1ID=$(rehearsal_validate_d1_export "$D1" "$ALL_TABLES" "$DUMPF")
case "$D1ID" in
  sha256:*)
    if [ "${#D1ID}" = 71 ]; then
      ok 'the bundle identity is returned for provenance'
    else
      bad 'the bundle identity is returned for provenance' "length ${#D1ID}"
    fi ;;
  *) bad 'the bundle identity is returned for provenance' "got '${D1ID}'" ;;
esac
if grep -qF "${D1ID#sha256:}" "$D1/d1-export.manifest"; then
  bad 'the identity is not any one file digest' 'it matches a listed digest'
else
  ok 'the identity is not any one file digest'
fi

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

section 'the backup directory is compared canonically, not by pattern'

# What was here matched any basename ending in `-<uuid>`, and the negative case
# it was checked against — `/tmp/evil-<uuid>-staging` — does not end in the
# uuid, so it failed for an unrelated reason and the guard looked sound.
# `/tmp/evil-<uuid>` walked straight through. There is no pattern any more:
# both sides are resolved to real paths and compared.
B="$WORK/backups"; rm -rf "$B"
mkdir -p "$B/team/shikoo-postgres-${U1}" "$B/team/shikoo-postgres-${U2}"
REAL="$B/team/shikoo-postgres-${U1}"

accepts 'the canonical backup directory is accepted' \
  rehearsal_canonical_dir_is "$REAL" "$REAL" 'the backup dir'

# The exact attack the pattern permitted.
mkdir -p "/tmp/evil-${U1}"
refuses 'a hostile directory whose name ends in the uuid is refused' 'resolves elsewhere' \
  rehearsal_canonical_dir_is "/tmp/evil-${U1}" "$REAL" 'the backup dir'
rmdir "/tmp/evil-${U1}" 2>/dev/null || true

refuses 'a sibling resource directory is refused' 'resolves elsewhere' \
  rehearsal_canonical_dir_is "$B/team/shikoo-postgres-${U2}" "$REAL" 'the backup dir'

# `..` traversal that lands somewhere else, and one that lands on the right
# place: the first is refused, the second is accepted, because canonicalisation
# is about where a path ENDS UP, not about how it is spelled.
refuses 'a traversal to another directory is refused' 'resolves elsewhere' \
  rehearsal_canonical_dir_is "$B/team/shikoo-postgres-${U1}/../shikoo-postgres-${U2}" "$REAL" 'the backup dir'
accepts 'a traversal that resolves to the right directory is accepted' \
  rehearsal_canonical_dir_is "$B/team/shikoo-postgres-${U2}/../shikoo-postgres-${U1}" "$REAL" 'the backup dir'

# A symlink standing in for the directory.
ln -sfn "$REAL" "$B/link-${U1}"
refuses 'a symlink to the right directory is still refused' 'symlink' \
  rehearsal_canonical_dir_is "$B/link-${U1}" "$REAL" 'the backup dir'

# A symlinked PARENT: the path spells out the expected name, but a component
# above it points somewhere else entirely.
mkdir -p "$B/elsewhere/shikoo-postgres-${U1}"
ln -sfn "$B/elsewhere" "$B/team-link"
refuses 'a symlinked parent component is refused' 'resolves elsewhere' \
  rehearsal_canonical_dir_is "$B/team-link/shikoo-postgres-${U1}" "$REAL" 'the backup dir'

refuses 'an empty candidate is refused' 'is empty' \
  rehearsal_canonical_dir_is '' "$REAL" 'the backup dir'
refuses 'an underivable expectation is refused, not skipped' 'could not be derived' \
  rehearsal_canonical_dir_is "$REAL" '' 'the backup dir'
refuses 'a candidate that does not exist is refused' 'does not resolve' \
  rehearsal_canonical_dir_is "$B/absent" "$REAL" 'the backup dir'

# ── the release lock, judged as an unprivileged user ─────────────────────
section 'the release lock is validated rather than adopted'

# /var/lock is a sticky world-writable directory, so whoever creates the lock
# file first owns it. These run as the invoking user — not root — because that
# is the only context in which "is this file root-owned" can actually be
# answered in the negative.
# shellcheck source=deploy/attestation-store.sh
. "$ROOT/deploy/attestation-store.sh"
LOCKD="$WORK/lockd"; mkdir -p "$LOCKD"

ATT_LOCK="$LOCKD/absent.lock"
refuses 'a lock file that does not exist is refused' 'does not exist' att_require_lock_file

ATT_LOCK="$LOCKD/mine.lock"; : >"$ATT_LOCK"; chmod 660 "$ATT_LOCK"
ATT_LOCK_GROUP=$(stat -c '%G' "$ATT_LOCK")
# Not `ok` when it cannot run. Calling ok for an assertion that never executed
# reports the ownership guard as proven while nothing tested it — and a CI
# container running as root would hide a removed owner check permanently.
if [ "$(id -u)" -eq 0 ]; then
  SKIPPED=$((SKIPPED + 1))
  printf '  SKIP a lock owned by another user is refused (this suite is running as root)\n'
else
  refuses 'a lock owned by another user is refused' 'not root' att_require_lock_file
fi

ln -sfn "$LOCKD/mine.lock" "$LOCKD/link.lock"
ATT_LOCK="$LOCKD/link.lock"
refuses 'a symlinked lock is refused' 'symlink' att_require_lock_file
unset ATT_LOCK ATT_LOCK_GROUP

# ── the host contract ────────────────────────────────────────────────────
section 'the host is proven capable, not merely equipped'

# `command -v` answers "is there a file with that name", which is true for a
# docker client with no daemon, a BusyBox stat with no -c, a date that cannot
# parse -d, and a python3 built without zipfile. Every check is exercised by
# breaking exactly one tool and requiring the refusal to name it.
HB="$WORK/hostbin"
PROBE="$WORK/probe"; mkdir -p "$PROBE"

# A PATH holding real tools, one of which is then replaced.
reset_hostbin() {
  rm -rf "$HB"; mkdir -p "$HB"
  local t real
  for t in bash docker git python3 curl sha256sum flock stat sed grep find date mktemp \
           rm ln mv seq cut tr head wc ls cat chmod mkdir dirname basename; do
    real=$(command -v "$t" 2>/dev/null) && ln -sf "$real" "$HB/$t"
  done
}
break_with() { # name body
  # `rm` first, always: these entries are symlinks to the real binaries, and
  # redirecting onto a symlink writes THROUGH it. Without this the test would
  # be overwriting /usr/bin/docker rather than shadowing it.
  rm -f "$HB/$1"
  printf '#!/bin/sh\n%s\n' "$2" >"$HB/$1"
  chmod +x "$HB/$1"
}
host_refuses() { # name want-substring
  local out rc
  set +e
  out=$(PATH="$HB" bash -c '. '"$ROOT"'/deploy/rehearsal-lib.sh; rehearsal_require_host_deps "'"$PROBE"'"' 2>&1)
  rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then bad "$1" 'the host was accepted'; return; fi
  case "$out" in *"$2"*) ok "$1" ;; *) bad "$1" "refused, but not for '$2': $(printf '%s' "$out" | head -2)" ;; esac
}

reset_hostbin
if PATH="$HB" bash -c '. '"$ROOT"'/deploy/rehearsal-lib.sh; rehearsal_require_host_deps "'"$PROBE"'"' >/dev/null 2>&1; then
  ok 'a capable host is accepted'
else
  bad 'a capable host is accepted' "$(PATH="$HB" bash -c '. '"$ROOT"'/deploy/rehearsal-lib.sh; rehearsal_require_host_deps "'"$PROBE"'"' 2>&1 | head -3)"
fi

# Missing outright.
for t in docker git python3 curl sha256sum flock stat; do
  reset_hostbin; rm -f "$HB/$t"
  host_refuses "a missing ${t} is refused" "${t} is not installed"
done

# Present but incapable — the cases command -v cannot see.
reset_hostbin; break_with docker 'exit 1'
host_refuses 'a docker client with no daemon is refused' 'daemon does not answer'

reset_hostbin; break_with python3 'case "$*" in *zipfile*) exit 1 ;; esac; exit 0'
host_refuses 'a python3 without zipfile is refused' 'cannot import zipfile'

reset_hostbin; break_with curl 'echo "curl 8.0.0"; echo "Protocols: file ftp http"'
host_refuses 'a curl without https is refused' 'no https protocol support'

reset_hostbin; break_with sha256sum 'echo "0000000000000000000000000000000000000000000000000000000000000000  -"'
host_refuses 'a sha256sum that computes the wrong digest is refused' 'known digest'

reset_hostbin; break_with stat 'echo not-a-mode'
host_refuses 'a stat without GNU -c is refused' 'no GNU -c support'

reset_hostbin; break_with flock 'exit 1'
host_refuses 'a flock that cannot lock is refused' 'cannot take a lock'

reset_hostbin; break_with date 'case "$*" in *-d*) exit 1 ;; esac; exit 0'
host_refuses 'a date that cannot parse ISO-8601 is refused' 'cannot parse an ISO-8601'

reset_hostbin; break_with sed 'exit 0'
host_refuses 'a sed that cannot substitute is refused' 'cannot run the substitution'

reset_hostbin; break_with grep 'exit 0'
host_refuses 'a grep that cannot count is refused' 'does not count lines'

reset_hostbin; break_with find 'exit 1'
host_refuses 'a find without -maxdepth is refused' 'does not support -maxdepth'

# The filesystem operation the whole publication design rests on.
reset_hostbin; break_with mv 'exit 1'
host_refuses 'a filesystem that cannot rename a symlink over a name is refused' 'atomic activation is impossible'

reset_hostbin
refuses 'a probe directory that does not exist is refused' 'no writable probe directory' \
  rehearsal_require_host_deps "$WORK/no-such-probe"

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

# Skips are reported, never folded into the pass count. An assertion that did
# not run is not an assertion that succeeded.
if [ "$SKIPPED" -gt 0 ]; then
  printf '\n%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIPPED"
else
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
