#!/usr/bin/env bash
# A candidate is safe to create without configuration and impossible to run
# without it. This suite proves the bridge between those two states: one exact,
# secret-silent copy per role, then no write at all on the second run.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/sync-production-candidate-envs.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

SECRET_TOKEN='0|TOKEN-THAT-MUST-NOT-PRINT'
SECRET_DATABASE='postgres://shikoo:DB-PASSWORD-MUST-NOT-PRINT@postgres:5432/shikoo'
SECRET_INGEST='INGEST-HMAC-MUST-NOT-PRINT'
SECRET_SESSION='SESSION-SECRET-MUST-NOT-PRINT'
SECRET_BOT='BOT-TOKEN-MUST-NOT-PRINT'

CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=$SECRET_TOKEN
EOF

SRC_INGEST='aaaaaaaaaaaaaaaaaaaaaaa1'
DST_INGEST='bbbbbbbbbbbbbbbbbbbbbbb1'
SRC_DASHBOARD='aaaaaaaaaaaaaaaaaaaaaaa2'
DST_DASHBOARD='bbbbbbbbbbbbbbbbbbbbbbb2'
SRC_BOT='aaaaaaaaaaaaaaaaaaaaaaa3'
DST_BOT='bbbbbbbbbbbbbbbbbbbbbbb3'

export FAKE_SRC_INGEST="$SRC_INGEST" FAKE_DST_INGEST="$DST_INGEST"
export FAKE_SRC_DASHBOARD="$SRC_DASHBOARD" FAKE_DST_DASHBOARD="$DST_DASHBOARD"
export FAKE_SRC_BOT="$SRC_BOT" FAKE_DST_BOT="$DST_BOT"
export FAKE_WORK="$WORK"
export FAKE_WRITES="$WORK/writes.log"
: >"$FAKE_WRITES"

write_sources() {
  cat >"$WORK/ingest.source.json" <<EOF
[
  {"uuid":"i1","key":"ENV_NAME","value":"production","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"i2","key":"SERVICE","value":"ingest","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"i3","key":"DATABASE_URL","value":"$SECRET_DATABASE","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":null},
  {"uuid":"i4","key":"INGEST_HMAC_SECRET","value":"$SECRET_INGEST","is_preview":false,"is_literal":true,"is_multiline":true,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":"runtime only"},
  {"uuid":"i5","key":"APP_VERSION","value":"old-sha","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"i6","key":"SOURCE_COMMIT","value":"old-source","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"ip","key":"PREVIEW_ONLY","value":"not-production","is_preview":true,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null}
]
EOF
  cat >"$WORK/dashboard.source.json" <<EOF
[
  {"uuid":"d1","key":"ENV_NAME","value":"production","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"d2","key":"SERVICE","value":"dashboard","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"d3","key":"DATABASE_URL","value":"$SECRET_DATABASE","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":null},
  {"uuid":"d4","key":"SESSION_SECRET","value":"$SECRET_SESSION","is_preview":false,"is_literal":true,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":null},
  {"uuid":"d5","key":"INGEST_URL","value":"https://sms.chopon.uk/api/v1/sms","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null}
]
EOF
  cat >"$WORK/bot.source.json" <<EOF
[
  {"uuid":"b1","key":"ENV_NAME","value":"production","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"b1-copy","key":"ENV_NAME","value":"production","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"b2","key":"SERVICE","value":"bot","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":true,"comment":null},
  {"uuid":"b3","key":"DATABASE_URL","value":"$SECRET_DATABASE","is_preview":false,"is_literal":false,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":null},
  {"uuid":"b4","key":"TELEGRAM_BOT_TOKEN","value":"$SECRET_BOT","is_preview":false,"is_literal":true,"is_multiline":false,"is_shown_once":false,"is_runtime":true,"is_buildtime":false,"comment":null}
]
EOF
}

empty_candidates() {
  printf '[]' >"$WORK/ingest.candidate.json"
  printf '[]' >"$WORK/dashboard.candidate.json"
  printf '[]' >"$WORK/bot.candidate.json"
}

reset_reads() {
  printf '0' >"$WORK/ingest.reads"
  printf '0' >"$WORK/dashboard.reads"
  printf '0' >"$WORK/bot.reads"
}

write_sources
empty_candidates
reset_reads

cat >"$BIN/curl" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
method=GET
body=''
url=${*: -1}
prev=''
for arg in "$@"; do
  [ "$prev" = '-X' ] && method=$arg
  [ "$prev" = '--data-binary' ] && body=$arg
  prev=$arg
done
[ "$body" = '@-' ] && body=$(cat)

role=''
kind=''
case "$url" in
  */applications/$FAKE_SRC_INGEST/envs) role=ingest; kind=source ;;
  */applications/$FAKE_DST_INGEST/envs) role=ingest; kind=candidate ;;
  */applications/$FAKE_DST_INGEST/envs/bulk) role=ingest; kind=bulk ;;
  */applications/$FAKE_SRC_DASHBOARD/envs) role=dashboard; kind=source ;;
  */applications/$FAKE_DST_DASHBOARD/envs) role=dashboard; kind=candidate ;;
  */applications/$FAKE_DST_DASHBOARD/envs/bulk) role=dashboard; kind=bulk ;;
  */applications/$FAKE_SRC_BOT/envs) role=bot; kind=source ;;
  */applications/$FAKE_DST_BOT/envs) role=bot; kind=candidate ;;
  */applications/$FAKE_DST_BOT/envs/bulk) role=bot; kind=bulk ;;
  *) printf '{"message":"not found"}404'; exit 0 ;;
esac

if [ "$kind" = source ]; then
  reads=$(cat "$FAKE_WORK/$role.reads")
  reads=$((reads + 1))
  printf '%s' "$reads" >"$FAKE_WORK/$role.reads"
  if [ "${FAKE_MUTATE_ROLE:-}" = "$role" ] && [ "$reads" = 2 ]; then
    python3 - "$FAKE_WORK/$role.source.json" <<'PY'
import json, sys
rows = json.load(open(sys.argv[1]))
for row in rows:
    if row.get("key") == "DATABASE_URL":
        row["comment"] = "changed during copy"
        break
print(json.dumps(rows, separators=(",", ":")), end="")
PY
  else
    cat "$FAKE_WORK/$role.source.json"
  fi
  printf '200'
  exit 0
fi

if [ "$kind" = candidate ]; then
  cat "$FAKE_WORK/$role.candidate.json"
  printf '200'
  exit 0
fi

[ "$method" = PATCH ] || { printf '{}405'; exit 0; }
printf '%s\n' "$role" >>"$FAKE_WRITES"
# Read the body through a temporary file because the fake panel's Python
# program itself comes from a here-document. This is test infrastructure, not
# the code under test; the file lives in a private mktemp directory.
body_file="$FAKE_WORK/request-body.json"
(umask 077; printf '%s' "$body" >"$body_file")
python3 - "$FAKE_WORK/$role.candidate.json" "$body_file" <<'PY'
import json, sys
state_path, body_path = sys.argv[1:]
rows = json.load(open(state_path))
data = json.load(open(body_path))["data"]
by_key = {row.get("key"): row for row in rows}
for item in data:
    old = by_key.get(item["key"])
    if old is None:
        old = {"uuid": "fake-" + item["key"].lower()}
        rows.append(old)
        by_key[item["key"]] = old
    old.update(item)
json.dump(rows, open(state_path, "w"), separators=(",", ":"))
print(json.dumps(rows, separators=(",", ":")), end="")
PY
rm -f "$body_file"
printf '201'
FAKE
chmod +x "$BIN/curl"

run_sync() { # output-file [environment overrides]
  local output=$1
  shift
  set +e
  env CONF="$CONF" "$@" bash "$SCRIPT" \
    "$SRC_INGEST" "$DST_INGEST" \
    "$SRC_DASHBOARD" "$DST_DASHBOARD" \
    "$SRC_BOT" "$DST_BOT" >"$output" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'the first copy is complete and the second is a no-op'

OUT1="$WORK/run1.log"
if run_sync "$OUT1"; then ok 'the first environment sync succeeds'; else
  bad 'the first environment sync succeeds' "$(tail -5 "$OUT1")"
fi

if [ "$(wc -l <"$FAKE_WRITES")" = 3 ]; then
  ok 'the first sync makes one bulk upsert per service'
else
  bad 'the first sync makes one bulk upsert per service' "$(cat "$FAKE_WRITES")"
fi

check_candidate() { # role secret-key secret-value
  python3 - "$WORK/$1.candidate.json" "$2" "$3" "$1" <<'PY'
import json, sys
path, secret_key, secret_value, role = sys.argv[1:]
rows = json.load(open(path))
by_key = {row["key"]: row for row in rows}
expected = {"ENV_NAME", "SERVICE", "DATABASE_URL", secret_key}
assert set(by_key) == expected, (role, sorted(by_key))
assert by_key["ENV_NAME"]["value"] == "production"
assert by_key["SERVICE"]["value"] == role
assert by_key[secret_key]["value"] == secret_value
assert by_key[secret_key]["is_runtime"] is True
assert by_key[secret_key]["is_buildtime"] is False
PY
}

if check_candidate ingest INGEST_HMAC_SECRET "$SECRET_INGEST"; then
  ok 'ingest receives every managed value and its flags'
else
  bad 'ingest receives every managed value and its flags' 'candidate JSON differs'
fi
if check_candidate dashboard SESSION_SECRET "$SECRET_SESSION"; then
  ok 'dashboard receives service configuration but not the old INGEST_URL'
else
  bad 'dashboard receives service configuration but not the old INGEST_URL' 'candidate JSON differs'
fi
if check_candidate bot TELEGRAM_BOT_TOKEN "$SECRET_BOT"; then
  ok 'bot receives its token once even when the source has an identical duplicate'
else
  bad 'bot receives its token once even when the source has an identical duplicate' 'candidate JSON differs'
fi

OUT2="$WORK/run2.log"
reset_reads
if run_sync "$OUT2"; then ok 'the second environment sync succeeds'; else
  bad 'the second environment sync succeeds' "$(tail -5 "$OUT2")"
fi
if [ "$(wc -l <"$FAKE_WRITES")" = 3 ]; then
  ok 'the second sync writes NOTHING'
else
  bad 'the second sync writes NOTHING' "$(cat "$FAKE_WRITES")"
fi

section 'ambiguous or incoherent configuration is refused before a write'

# A duplicate on the candidate means Coolify, not this script, would choose
# which value reaches the container. Even identical rows are refused there:
# the target must have one row per key after the bulk endpoint has done its job.
python3 - "$WORK/ingest.candidate.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.load(open(path))
rows.append(dict(next(row for row in rows if row.get("key") == "ENV_NAME"), uuid="duplicate-env-name"))
json.dump(rows, open(path, "w"))
PY
OUT3="$WORK/duplicate-target.log"
before=$(wc -l <"$FAKE_WRITES")
reset_reads
if run_sync "$OUT3"; then
  bad 'a duplicated candidate key is refused' 'the sync proceeded'
elif grep -qF 'candidate has duplicate key(s): ENV_NAME' "$OUT3"; then
  ok 'a duplicated candidate key is refused'
else
  bad 'a duplicated candidate key is refused' "$(tail -4 "$OUT3")"
fi
if [ "$(wc -l <"$FAKE_WRITES")" = "$before" ]; then
  ok 'a duplicated target causes no write'
else
  bad 'a duplicated target causes no write' 'the panel was mutated'
fi

write_sources
empty_candidates
reset_reads
python3 - "$WORK/ingest.source.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.load(open(path))
rows.append(dict(rows[1], uuid="conflicting-service", value="bot"))
json.dump(rows, open(path, "w"))
PY
OUT4="$WORK/duplicate-source.log"
before=$(wc -l <"$FAKE_WRITES")
if run_sync "$OUT4"; then
  bad 'conflicting source duplicates are refused' 'the sync proceeded'
elif grep -qF 'source key SERVICE is duplicated with different values or flags' "$OUT4"; then
  ok 'conflicting source duplicates are refused'
else
  bad 'conflicting source duplicates are refused' "$(tail -4 "$OUT4")"
fi
if [ "$(wc -l <"$FAKE_WRITES")" = "$before" ]; then
  ok 'ambiguous source rows cause no write'
else
  bad 'ambiguous source rows cause no write' 'the panel was mutated'
fi

write_sources
empty_candidates
reset_reads
python3 - "$WORK/ingest.source.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.load(open(path))
next(row for row in rows if row.get("key") == "ENV_NAME")["value"] = "staging"
json.dump(rows, open(path, "w"))
PY
OUT5="$WORK/wrong-environment.log"
if run_sync "$OUT5"; then
  bad 'a non-production source is refused' 'the sync proceeded'
elif grep -qF 'source ingest is not ENV_NAME=production' "$OUT5"; then
  ok 'a non-production source is refused'
else
  bad 'a non-production source is refused' "$(tail -4 "$OUT5")"
fi

write_sources
empty_candidates
reset_reads
python3 - "$WORK/ingest.source.json" <<'PY'
import json, sys
path = sys.argv[1]
rows = json.load(open(path))
del next(row for row in rows if row.get("key") == "INGEST_HMAC_SECRET")["value"]
json.dump(rows, open(path, "w"))
PY
OUT6="$WORK/hidden-secret.log"
if run_sync "$OUT6"; then
  bad 'an unreadable source secret is refused' 'the sync replaced it with an empty value'
elif grep -qF 'INGEST_HMAC_SECRET has no readable value' "$OUT6"; then
  ok 'an unreadable source secret is refused instead of erased'
else
  bad 'an unreadable source secret is refused instead of erased' "$(tail -4 "$OUT6")"
fi

write_sources
empty_candidates
reset_reads
OUT7="$WORK/moving-source.log"
before=$(wc -l <"$FAKE_WRITES")
if run_sync "$OUT7" FAKE_MUTATE_ROLE=ingest; then
  bad 'a source edited during the copy is refused' 'the sync proceeded from two snapshots'
elif grep -qF 'source ingest configuration changed while it was being copied' "$OUT7"; then
  ok 'a source edited during the copy is refused'
else
  bad 'a source edited during the copy is refused' "$(tail -4 "$OUT7")"
fi
if [ "$(wc -l <"$FAKE_WRITES")" = "$before" ]; then
  ok 'a moving source causes no write'
else
  bad 'a moving source causes no write' 'the panel was mutated'
fi

section 'no credential reaches output'

for secret in "$SECRET_TOKEN" "$SECRET_DATABASE" "$SECRET_INGEST" "$SECRET_SESSION" "$SECRET_BOT"; do
  if grep -qF -- "$secret" "$OUT1" "$OUT2" "$OUT3" "$OUT4" "$OUT5" "$OUT6" "$OUT7"; then
    bad 'candidate environment output contains no credential' 'a fake credential was printed'
  else
    ok 'candidate environment output contains no credential'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
