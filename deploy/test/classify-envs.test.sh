#!/usr/bin/env bash
# The one property `classify-duplicate-envs.sh` must never lose: it decides
# which duplicate row is which by DECRYPTING both, and it must not print either.
#
# A tool that reads secrets in order to describe them is one careless `printf`
# away from putting a production DATABASE_URL and a bot token into a terminal
# scrollback, a CI log and somebody's clipboard. So the assertions here are
# mostly negative — the sentinel values are searched for in the whole output —
# and the positive ones only check that the non-secret ANSWER survived.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/classify-duplicate-envs.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() {
  PASS=$((PASS + 1))
  printf '  ok   %s\n' "$1"
}
bad() {
  FAIL=$((FAIL + 1))
  printf '  FAIL %s\n       %s\n' "$1" "$2"
}
section() { printf '\n%s\n' "$1"; }

# The values that must never appear in the output, whatever else happens.
SECRET_DB_STAGING='postgres://shikoo:SUPERSECRETPW@bea6ac92holn5k6vjgopy2ai:5432/shikoo'
SECRET_DB_PROD='postgres://shikoo:OTHERSECRETPW@qd2vduj7kv05sp9ejdrmclmu:5432/shikoo'
SECRET_TOKEN_A='111111:AAAA-SECRET-TOKEN-AAAA'
SECRET_TOKEN_B='222222:BBBB-SECRET-TOKEN-BBBB'

BIN="$WORK/bin"
mkdir -p "$BIN"
REAL_PYTHON=$(command -v python3)
PYTHON_ARGV="$WORK/python.argv"
CURL_ARGV="$WORK/curl.argv"
: >"$PYTHON_ARGV"
: >"$CURL_ARGV"
cat >"$BIN/python3" <<FAKE
#!/usr/bin/env bash
printf '%s\n' "\$*" >>"$PYTHON_ARGV"
exec "$REAL_PYTHON" "\$@"
FAKE
chmod +x "$BIN/python3"
PATH="$BIN:$PATH"
export PATH

CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=0|not-a-real-token
EOF

UUID='aaaaaaaaaaaaaaaaaaaaaaaa'

# The live API shape: uuid, no numeric id.
cat >"$WORK/envs.json" <<EOF
[
 {"uuid":"env-db-staging","key":"DATABASE_URL","value":"${SECRET_DB_STAGING}"},
 {"uuid":"env-db-prod","key":"DATABASE_URL","value":"${SECRET_DB_PROD}"},
 {"uuid":"env-bot-prod","key":"TELEGRAM_BOT_TOKEN","value":"${SECRET_TOKEN_A}"},
 {"uuid":"env-bot-staging","key":"TELEGRAM_BOT_TOKEN","value":"${SECRET_TOKEN_B}"},
 {"uuid":"env-name-staging","key":"ENV_NAME","value":"staging"},
 {"uuid":"env-name-prod","key":"ENV_NAME","value":"production"},
 {"uuid":"env-panel-a","key":"PANEL_SECRET_KEY","value":"a-secret-with-no-special-handling"},
 {"uuid":"env-panel-b","key":"PANEL_SECRET_KEY","value":"another-secret-value"},
 {"uuid":"env-once","key":"APPEARS_ONCE","value":"not-a-duplicate-and-must-not-be-listed"}
]
EOF

# Fake Coolify + Telegram. Coolify carries its URL as the last argument;
# Telegram carries its credentialed URL only in the 0600 -K file.
cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$*" >>"$CURL_ARGV"
url=\${*: -1}
cfg=''
prev=''
for a in "\$@"; do [ "\$prev" = '-K' ] && cfg="\$a"; prev="\$a"; done
if [ -n "\$cfg" ] && grep -q 'api.telegram.org' "\$cfg" 2>/dev/null; then
  if grep -q '${SECRET_TOKEN_A}' "\$cfg"; then
    printf '{"ok":true,"result":{"id":8856185613,"username":"Test_Shikoo_bot"}}'
  elif grep -q '${SECRET_TOKEN_B}' "\$cfg"; then
    printf '{"ok":true,"result":{"id":9900112233,"username":"Shikoo_Staging_bot"}}'
  else
    printf '{"ok":false,"description":"Unauthorized"}'
  fi
  exit 0
fi
case "\$url" in
  */envs)
    cat "$WORK/envs.json"
    printf '200'
    exit 0 ;;
esac
printf '{}404'
FAKE
chmod +x "$BIN/curl"

OUT="$WORK/out.txt"
set +e
CONF="$CONF" bash "$SCRIPT" staging "$UUID" >"$OUT" 2>&1
rc=$?
set -e

section 'classify-duplicate-envs — it reads secrets and prints none of them'

if [ "$rc" -eq 0 ]; then ok 'it runs'; else bad 'it runs' "exit ${rc}: $(tail -2 "$OUT")"; fi

for secret in "$SECRET_DB_STAGING" "$SECRET_DB_PROD" "$SECRET_TOKEN_A" "$SECRET_TOKEN_B" \
  'SUPERSECRETPW' 'OTHERSECRETPW' 'AAAA-SECRET-TOKEN-AAAA' 'BBBB-SECRET-TOKEN-BBBB' \
  'a-secret-with-no-special-handling' 'another-secret-value'; do
  if grep -qF -- "$secret" "$OUT"; then
    bad "the output never contains «${secret:0:24}…»" 'it was printed'
  else
    ok "the output never contains «${secret:0:24}…»"
  fi
done

section 'classify-duplicate-envs — the answer survives the redaction'

want() { # name  substring
  if grep -qF -- "$2" "$OUT"; then ok "$1"; else bad "$1" "missing: $2"; fi
}

# The whole point: which row is which, by API uuid, in words a person can act on.
want 'the staging DATABASE_URL row is named as staging' 'staging (host bea6ac92holn5k6vjgopy2ai)'
want 'the production DATABASE_URL row is named as PRODUCTION' 'PRODUCTION'
want 'the DATABASE_URL rows are identified by uuid' 'row env-db-staging'
want 'both DATABASE_URL rows are classified' 'row env-db-prod'
want 'the production bot token is named by its public username' '@Test_Shikoo_bot'
want 'the staging bot token is named by its public username' '@Shikoo_Staging_bot'
want 'the bot rows are identified by uuid' 'row env-bot-prod'
want 'ENV_NAME is shown, because it is not a secret' 'ENV_NAME'
want 'an unrecognised key is reported as present and nothing more' 'treated as a secret'

# A key with one row is not a question and must not be in the answer.
if grep -qF 'APPEARS_ONCE' "$OUT"; then
  bad 'a key that appears once is not listed' 'it was listed'
else
  ok 'a key that appears once is not listed'
fi

# It is a classifier, not a repair tool.
if grep -qiE 'DELETE FROM|deleted [0-9]' "$OUT"; then
  bad 'it deletes nothing' 'the output suggests a deletion happened'
else
  ok 'it deletes nothing'
fi

for secret in "$SECRET_DB_STAGING" "$SECRET_DB_PROD" "$SECRET_TOKEN_A" "$SECRET_TOKEN_B"; do
  if grep -qF -- "$secret" "$PYTHON_ARGV" "$CURL_ARGV"; then
    bad 'no database URL or bot token reaches process argv' "secret reached argv: ${secret:0:20}…"
  else
    ok "«${secret:0:20}…» appears in no process argv"
  fi
done

section 'classify-duplicate-envs — refusals'

refuses() { # name  args...
  local name=$1
  shift
  set +e
  CONF="$CONF" bash "$SCRIPT" "$@" >/dev/null 2>&1
  local rc=$?
  set -e
  if [ "$rc" -eq 0 ]; then bad "$name" 'it was accepted'; else ok "$name"; fi
}
refuses 'refuses an unknown environment name' 'prod' "$UUID"
refuses 'refuses an application id that is not a uuid' 'staging' 'not a uuid'
refuses 'refuses being given no application at all' 'staging'

printf '{not-json' >"$WORK/envs.json"
refuses 'refuses malformed JSON from Coolify' 'staging' "$UUID"
printf '{"rows":[]}' >"$WORK/envs.json"
refuses 'refuses a non-list Coolify response' 'staging' "$UUID"
printf '[{"key":"ENV_NAME","value":"staging"},{"key":"ENV_NAME","value":"staging"}]' >"$WORK/envs.json"
refuses 'refuses a duplicated row without uuid' 'staging' "$UUID"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
