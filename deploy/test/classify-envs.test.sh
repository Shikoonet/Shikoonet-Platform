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
SECRET_DB_STAGING='postgres://shikoo:SUPERSECRETPW@db-stg:5432/shikoo'
SECRET_DB_PROD='postgres://shikoo:OTHERSECRETPW@db-prd:5432/shikoo'
SECRET_TOKEN_A='111111:AAAA-SECRET-TOKEN-AAAA'
SECRET_TOKEN_B='222222:BBBB-SECRET-TOKEN-BBBB'

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=0|not-a-real-token
EOF

UUID='aaaaaaaaaaaaaaaaaaaaaaaa'

# Fake Coolify + Telegram. Routed on the url, which is the last argument.
cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
url=\${*: -1}
case "\$url" in
  *api.telegram.org*getMe*)
    case "\$url" in
      *${SECRET_TOKEN_A}*) printf '{"ok":true,"result":{"id":8856185613,"username":"Test_Shikoo_bot"}}' ;;
      *${SECRET_TOKEN_B}*) printf '{"ok":true,"result":{"id":9900112233,"username":"Shikoo_Staging_bot"}}' ;;
      *) printf '{"ok":false,"description":"Unauthorized"}' ;;
    esac
    exit 0 ;;
  */envs)
    # curl writes the http_code with no separator, so the fake has to as well.
    # Written as one printf rather than a heredoc: a heredoc nested inside the
    # heredoc that generates this file is a quoting puzzle, and the version
    # that got it wrong failed as «could not reach Coolify» — pointing at the
    # network rather than at itself.
    printf '%s200' '[
 {"id":95,"key":"DATABASE_URL","value":"${SECRET_DB_STAGING}"},
 {"id":96,"key":"DATABASE_URL","value":"${SECRET_DB_PROD}"},
 {"id":111,"key":"TELEGRAM_BOT_TOKEN","value":"${SECRET_TOKEN_A}"},
 {"id":112,"key":"TELEGRAM_BOT_TOKEN","value":"${SECRET_TOKEN_B}"},
 {"id":97,"key":"ENV_NAME","value":"staging"},
 {"id":98,"key":"ENV_NAME","value":"production"},
 {"id":50,"key":"PANEL_SECRET_KEY","value":"a-secret-with-no-special-handling"},
 {"id":51,"key":"PANEL_SECRET_KEY","value":"another-secret-value"},
 {"id":60,"key":"APPEARS_ONCE","value":"not-a-duplicate-and-must-not-be-listed"}
]'
    exit 0 ;;
esac
printf '{}404'
FAKE
chmod +x "$BIN/curl"

# Fake psql: answers with a system_identifier chosen by which url it was given.
cat >"$BIN/psql" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
url=\${1:-}
case "\$url" in
  *db-stg*) printf '7678322244250038305\n' ;;
  *db-prd*) printf '7678248300486692898\n' ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$BIN/psql"

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

# The whole point: which row is which, by id, in words a person can act on.
want 'the staging DATABASE_URL row is named as staging' '7678322244250038305'
want 'the production DATABASE_URL row is named as PRODUCTION' 'PRODUCTION'
want 'the DATABASE_URL rows are identified by id' 'row 95'
want 'both DATABASE_URL rows are classified' 'row 96'
want 'the production bot token is named by its public username' '@Test_Shikoo_bot'
want 'the staging bot token is named by its public username' '@Shikoo_Staging_bot'
want 'the bot rows are identified by id' 'row 111'
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

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
