#!/usr/bin/env bash
# The Step-E runner against the response this Coolify actually returns.
#
# The static suite proves the code does not index `id`. This one proves the
# runner survives the real thing: a 20-field row with `uuid`, without a numeric
# `id`, carrying both `value` and `real_value`. That is the shape whose absence
# of `id` killed the first run before it mutated anything.
#
# Everything here is a DRY RUN. The apply path deletes rows from a live Coolify
# and is the owner's to trigger; what is tested is that a dry run classifies
# correctly and changes nothing.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUNNER="$ROOT/deploy/step-e-runner.sh"
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

SECRET_STAGING_URL='postgres://shikoo:STAGINGPW@db-stg:5432/shikoo'
SECRET_PROD_URL='postgres://shikoo:PRODPW@db-prd:5432/shikoo'
SECRET_TOKEN_PROD='111111:PRODUCTION-BOT-TOKEN'
SECRET_TOKEN_OTHER='222222:SOME-OTHER-TOKEN'

CONF="$WORK/deploy.env"
printf 'COOLIFY_URL=http://127.0.0.1:8000\nCOOLIFY_TOKEN=0|not-real\n' >"$CONF"
STATE="$WORK/state"
mkdir -p "$STATE"
printf 'schema_version=2\ninstant_deploy_false_creates_nothing=proven\n' >"$STATE/coolify-contract.env"
( cd "$STATE" && sha256sum coolify-contract.env >coolify-contract.sha256 )

APP_ING=aaaaaaaaaaaaaaaaaaaaaaa1
APP_DASH=aaaaaaaaaaaaaaaaaaaaaaa2
APP_BOT=aaaaaaaaaaaaaaaaaaaaaaa3

# A row with all twenty fields the live API returns, `uuid` present, numeric
# `id` absent, and both `value` and `real_value`.
row() { # uuid key value
  python3 -c '
import json,sys
u,k,v = sys.argv[1], sys.argv[2], sys.argv[3]
print(json.dumps({
 "uuid":u,"key":k,"value":v,"real_value":v+"-ESCAPED",
 "is_preview":False,"is_shown_once":False,"is_multiline":False,"version":"4.0.0",
 "is_literal":False,"order":1,"is_required":False,"is_shared":False,
 "resourceable_type":"App\\\\Models\\\\Application","resourceable_id":7,
 "is_runtime":True,"is_buildtime":True,"comment":None,
 "created_at":"2026-08-26T00:00:00Z","updated_at":"2026-08-26T00:00:00Z",
 "is_buildpack_control":False,"is_coolify":False}))' "$1" "$2" "$3"
}

mkrows() { python3 -c 'import sys; print("["+",".join(sys.argv[1:])+"]")' "$@"; }

ENVS_ING=$(mkrows \
  "$(row eu-ing-env-ok  ENV_NAME staging)" \
  "$(row eu-ing-env-bad ENV_NAME production)" \
  "$(row eu-ing-svc-ok  SERVICE ingest)" \
  "$(row eu-ing-svc-bad SERVICE dashboard)")
ENVS_DASH=$(mkrows \
  "$(row eu-dsh-db-ok  DATABASE_URL "$SECRET_STAGING_URL")" \
  "$(row eu-dsh-db-bad DATABASE_URL "$SECRET_PROD_URL")")
ENVS_BOT=$(mkrows \
  "$(row eu-bot-tok-a TELEGRAM_BOT_TOKEN "$SECRET_TOKEN_PROD")" \
  "$(row eu-bot-tok-b TELEGRAM_BOT_TOKEN "$SECRET_TOKEN_OTHER")")

printf '%s' "$ENVS_ING"  >"$WORK/envs.$APP_ING"
printf '%s' "$ENVS_DASH" >"$WORK/envs.$APP_DASH"
printf '%s' "$ENVS_BOT"  >"$WORK/envs.$APP_BOT"

CURL_ARGV="$WORK/curl.argv"
: >"$CURL_ARGV"
cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$*" >>"$CURL_ARGV"
url=\${*: -1}
cfg=''
prev=''
for a in "\$@"; do [ "\$prev" = '-K' ] && cfg="\$a"; prev="\$a"; done
# The telegram helper passes ONLY -K <cfg>; the url lives inside the file.
if [ -n "\$cfg" ] && grep -q 'api.telegram.org' "\$cfg" 2>/dev/null; then
  if grep -q '${SECRET_TOKEN_PROD}' "\$cfg"; then
    printf '{"ok":true,"result":{"id":8856185613,"username":"Test_Shikoo_bot"}}'
  else
    printf '{"ok":true,"result":{"id":9900112233,"username":"Shikoo_Staging_bot"}}'
  fi
  exit 0
fi
case "\$url" in
  */teams/current) printf '{"id":0,"name":"Root Team"}200' ;;
  *${APP_ING}/envs)  printf '%s200' "\$(cat "$WORK/envs.$APP_ING")" ;;
  *${APP_DASH}/envs) printf '%s200' "\$(cat "$WORK/envs.$APP_DASH")" ;;
  *${APP_BOT}/envs)  printf '%s200' "\$(cat "$WORK/envs.$APP_BOT")" ;;
  *) printf '{}404' ;;
esac
FAKE
chmod +x "$BIN/curl"

PSQL_ARGV="$WORK/psql.argv"
: >"$PSQL_ARGV"
cat >"$BIN/psql" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$*" >>"$PSQL_ARGV"
# The helper puts credentials in a service file; the service NAME is all that
# may appear here.
if [ "\${PGSERVICE:-}" = 'probe' ] && [ -r "\${PGSERVICEFILE:-/nonexistent}" ]; then
  if grep -q 'db-stg' "\$PGSERVICEFILE"; then printf '7678322244250038305\n'
  elif grep -q 'db-prd' "\$PGSERVICEFILE"; then printf '7678248300486692898\n'
  else printf '\n'; fi
  exit 0
fi
printf '\n'
FAKE
chmod +x "$BIN/psql"

DOCKER_ARGV="$WORK/docker.argv"
: >"$DOCKER_ARGV"
cat >"$BIN/docker" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
printf '%s\n' "\$*" >>"$DOCKER_ARGV"
q=\$*
case "\$q" in
  *"a.name = 'shikoo-dev-ingest'"*)    printf '${APP_ING}\n' ;;
  *"a.name = 'shikoo-dev-dashboard'"*) printf '${APP_DASH}\n' ;;
  *"a.name = 'shikoo-dev-bot'"*)       printf '${APP_BOT}\n' ;;
  *"select e.name from applications"*) printf 'dev-fleet\n' ;;
  *is_auto_deploy_enabled*)            printf 'f|f\n' ;;
  *"having count(*) > 1"*)             printf 'x|y|2\n' ;;
  *)                                   printf '\n' ;;
esac
FAKE
chmod +x "$BIN/docker"

OUT="$WORK/out.txt"
set +e
env CONF="$CONF" STATE="$STATE" CONTRACT="$STATE/coolify-contract.env" \
  LOCK="$WORK/lock" bash "$RUNNER" >"$OUT" 2>&1
RC=$?
set -e

section 'the runner survives the live response shape'

if grep -qF "KeyError" "$OUT"; then
  bad 'no KeyError on a response with uuid and no numeric id' "$(grep -m1 KeyError "$OUT")"
else
  ok 'no KeyError on a response with uuid and no numeric id'
fi

if [ "$RC" -eq 0 ]; then ok 'the dry run completes'; else
  bad 'the dry run completes' "rc=${RC}: $(tail -3 "$OUT")"
fi

section 'classification, by uuid'

want() { if grep -qF -- "$2" "$OUT"; then ok "$1"; else bad "$1" "missing: $2"; fi; }
want 'the correct ENV_NAME row is kept by uuid' 'keep eu-ing-env-ok'
want 'the wrong ENV_NAME row is dropped by uuid' 'drop eu-ing-env-bad'
want 'the correct SERVICE row is kept' 'keep eu-ing-svc-ok'
want 'the staging DATABASE_URL is identified by cluster id' '7678322244250038305'
want 'the production DATABASE_URL is named as PRODUCTION' 'PRODUCTION'

section 'the bot row is refused, and only the bot'

want 'the production bot token is recognised' 'PRODUCTION-BOT'
want 'the ambiguous bot key is left untouched' 'left untouched'
# One blocked bot row must not stop ingest/dashboard being cleaned.
if grep -qE 'drop eu-ing-env-bad|drop eu-ing-svc-bad' "$OUT"; then
  ok 'ingest cleanup still proceeds despite the blocked bot row'
else
  bad 'ingest cleanup still proceeds despite the blocked bot row' "$(tail -4 "$OUT")"
fi

section 'a dry run mutates nothing'

want 'it says it changed nothing' 'DRY RUN'
if grep -qE '^-X DELETE| -X DELETE' "$CURL_ARGV"; then
  bad 'no DELETE was issued during the dry run' 'a delete appears in curl argv'
else
  ok 'no DELETE was issued during the dry run'
fi
if grep -qiE 'delete from|insert into|update ' "$DOCKER_ARGV"; then
  bad 'no database write was issued during the dry run' 'a write appears'
else
  ok 'no database write was issued during the dry run'
fi

section 'no secret reached argv or output'

for secret in "$SECRET_STAGING_URL" "$SECRET_PROD_URL" "$SECRET_TOKEN_PROD" "$SECRET_TOKEN_OTHER" \
  'STAGINGPW' 'PRODPW' 'PRODUCTION-BOT-TOKEN' 'SOME-OTHER-TOKEN'; do
  for f in "$CURL_ARGV" "$PSQL_ARGV" "$DOCKER_ARGV" "$OUT"; do
    if grep -qF -- "$secret" "$f" 2>/dev/null; then
      bad "«${secret:0:22}…» never appears in $(basename "$f")" 'it does'
      continue 2
    fi
  done
  ok "«${secret:0:22}…» appears in no argv and no output"
done

# The escaped rendering must never be what got compared.
if grep -qF -- '-ESCAPED' "$OUT"; then
  bad 'real_value is never used as the canonical value' 'the escaped rendering leaked into output'
else
  ok 'real_value is never used as the canonical value'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
