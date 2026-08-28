#!/usr/bin/env bash
# Which of the two rows is the right one — answered without printing either.
#
# ─────────────────────────────────────────────────────────────────────────────
# `deploy.sh` already REFUSES an application with a duplicated key, and refusing
# is correct: nothing in a deploy reads a value, so nothing in a deploy can tell
# which copy was meant. But a refusal is not a repair, and the person holding
# the panel still has to know which API row uuid to delete.
#
# This is that missing half. It is read-only, it deletes nothing, and it never
# prints a value.
#
# ── Why the database cannot answer this ────────────────────────────────────
#
# The obvious approach — compare the two `value` columns — is worse than
# useless, it is confidently wrong. Laravel encrypts each row with a random IV,
# so two rows holding the SAME plaintext have completely different ciphertext.
# `count(distinct value) > 1` therefore reports "these differ" for every
# duplicate pair in the database, including the identical ones. Anyone reading
# that as evidence would conclude a choice has to be made where there is none.
#
# So classification goes through Coolify's own API, which decrypts. That the
# API returns anything sensible is also the proof that Coolify's APP_KEY still
# opens these rows — which is why this runs BEFORE the recovery backup rather
# than after it.
#
# ── What "without printing it" means, key by key ───────────────────────────
#
#   ENV_NAME, SERVICE, APP_VERSION, AUTO_*, MIRZABOT_*, TRUSTED_PROXY_*
#       Not secrets. Printed as they are, because the whole question is which
#       of `staging` and `production` a row says.
#
#   DATABASE_URL
#       Parsed without connecting. Only the database container hostname is
#       reported — enough to distinguish staging from production, while user,
#       password, port and database name are discarded.
#
#   TELEGRAM_BOT_TOKEN
#       `getMe`, and only the bot's public id and @username are reported. Those
#       are printed on the bot's profile; the token is not derivable from them.
#
#   anything else
#       Reported as `present` and nothing more. An unrecognised key is assumed
#       to be a secret, because the failure of guessing wrong in that direction
#       is a disclosure and in the other direction is an inconvenience.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: classify-duplicate-envs.sh <env> <uuid> [uuid...]
#   <env>  staging | production — which system_identifier to expect
#
# Reads the Coolify token the same way `deploy.sh` does, from
# /etc/shikoo/<env>/deploy.env, as text rather than by sourcing it: a Coolify
# token is `<id>|<random>` and a shell would run the pipe.

set -Eeuo pipefail

ENV_ARG=${1:-}
shift || true
if [ -z "$ENV_ARG" ] || [ "$#" -eq 0 ]; then
  echo "usage: classify-duplicate-envs.sh <staging|production> <uuid> [uuid...]" >&2
  exit 2
fi
case "$ENV_ARG" in staging | production) ;; *) echo "refusing: env must be staging or production" >&2; exit 2 ;; esac

CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
say() { echo "[classify] $*"; }
die() {
  echo "[classify] REFUSED: $*" >&2
  exit 1
}

# The two database containers, by the hostname a DATABASE_URL uses. Not
# secrets — they are container names — and writing them down is what turns
# "some database" into "the wrong one".
STAGING_DB_HOST=${STAGING_DB_HOST:-bea6ac92holn5k6vjgopy2ai}
PRODUCTION_DB_HOST=${PRODUCTION_DB_HOST:-qd2vduj7kv05sp9ejdrmclmu}

cfg() { # key -> value, read as text, never sourced
  sed -n "s/^$1=//p" "$CONF" | head -n1
}
[ -r "$CONF" ] || die "cannot read $CONF"
COOLIFY_URL=$(cfg COOLIFY_URL)
COOLIFY_TOKEN=$(cfg COOLIFY_TOKEN)
# Spelled as an `if` rather than `A && B || C`: shellcheck reads that as a
# possible if-then-else mistake (SC2015), and it is right to — `C` runs when
# `A` is true and `B` is false. Same correction ca14816 made in the gate.
if [ -z "$COOLIFY_URL" ] || [ -z "$COOLIFY_TOKEN" ]; then
  die "$CONF has no COOLIFY_URL/COOLIFY_TOKEN"
fi

HERE=$(dirname "${BASH_SOURCE[0]}")
# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
# shellcheck source=deploy/coolify-secret-io.sh
. "$HERE/coolify-secret-io.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
secret_io_init
cleanup_all() { coolify_api_cleanup; secret_io_cleanup; }
trap cleanup_all EXIT INT TERM

# `staging`/`production`/`unknown`, from a URL this function is handed and does
# not echo.
#
# Parsed, never dialled. There is no psql on this host and Coolify's database
# hostnames do not resolve outside the container network, so the connecting
# version reported every row "unreachable" — two impossibilities wearing the
# look of a network problem. It should not have connected regardless:
# classifying a row as production by opening a session to production is a
# strange way to learn you should not be touching it.
#
# The hostname is the database container's own name. Only that name and the
# verdict are printed; user, password, port and database are discarded.
classify_database_url() { # url -> classification
  local host
  host=$(pg_host_of "$1")
  case "$host" in
    "$STAGING_DB_HOST")    printf 'staging (host %s)\n' "$host" ;;
    "$PRODUCTION_DB_HOST") printf 'PRODUCTION (host %s)\n' "$host" ;;
    '')                    printf 'not a postgres url\n' ;;
    *)                     printf 'unknown host (%s)\n' "$host" ;;
  esac
}

# The bot's public identity, from a token this function is handed and does not
# echo. Both fields are on the bot's public profile.
classify_bot_token() { # token -> "id=<n> username=<name>"
  local identity botid botname
  identity=$(tg_get_me "$1")
  [ -n "$identity" ] || { printf 'invalid or unreachable\n'; return 0; }
  botid=${identity%% *}
  if [[ $identity == *' '* ]]; then botname=${identity#* }; else botname=''; fi
  printf 'id=%s username=@%s\n' "$botid" "$botname"
}

for uuid in "$@"; do
  [[ $uuid =~ ^[a-z0-9]{20,32}$ ]] || die "'$uuid' is not a Coolify application uuid"
  say "── application ${uuid}"
  # Checked, not assumed. `curl -sS` exits 0 on a 401, so an unchecked call
  # returns an error document, parses to zero duplicate rows, and reports
  # «nothing to fix» about an application it was never allowed to read.
  coolify_api GET "/applications/${uuid}/envs" || die "could not reach Coolify while reading ${uuid}"
  [ "$API_STATUS" = '200' ] ||
    die "reading the environment of ${uuid} was refused (HTTP ${API_STATUS}) — refusing to report «no duplicates» about an application this token cannot read"
  envs=$API_BODY

  # One line per row of a duplicated key: uuid, key, and a base64 transport for
  # the value. The encoding is never printed; it keeps tabs and newlines inside
  # a value from becoming fake rows in this internal stream.
  decoded=$(printf '%s' "$envs" | python3 -c 'import json,sys
import base64,re
from collections import Counter
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if not isinstance(rows,list) or not all(isinstance(r,dict) for r in rows):
    raise SystemExit(2)
for r in rows:
    if not isinstance(r.get("key"),str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",r["key"]):
        raise SystemExit(3)
dupes = {k for k, n in Counter(r["key"] for r in rows).items() if n > 1}
selected=[]
for r in rows:
    if r["key"] not in dupes: continue
    u=r.get("uuid")
    if not isinstance(u,str) or not re.fullmatch(r"[A-Za-z0-9_-]{3,64}",u) or "value" not in r:
        raise SystemExit(4)
    selected.append(r)
for r in sorted(selected,key=lambda r:(r["key"],r["uuid"])):
    value=r.get("value") or ""
    encoded=base64.b64encode(value.encode()).decode()
    print("%s\t%s\t%s" % (r["uuid"],r["key"],encoded))') ||
    die "Coolify returned malformed environment rows for ${uuid} — refusing to classify an unreadable response"

  # Keys that appear once are not listed — they are not the question.
  while IFS=$'\t' read -r row_uuid key encoded; do
    [ -n "$row_uuid" ] || continue
    value=$(printf '%s' "$encoded" | base64 -d) ||
      die "could not decode ${row_uuid} without exposing its value"
    case "$key" in
      ENV_NAME | SERVICE | APP_VERSION | AUTO_* | MIRZABOT_* | TRUSTED_PROXY_*)
        printf '  row %-24s %-28s = %s\n' "$row_uuid" "$key" "$value" ;;
      DATABASE_URL)
        printf '  row %-24s %-28s -> %s\n' "$row_uuid" "$key" "$(classify_database_url "$value")" ;;
      TELEGRAM_BOT_TOKEN)
        printf '  row %-24s %-28s -> %s\n' "$row_uuid" "$key" "$(classify_bot_token "$value")" ;;
      *)
        printf '  row %-24s %-28s -> present (treated as a secret; not shown)\n' "$row_uuid" "$key" ;;
    esac
  done <<<"$decoded"
done

say "nothing was deleted. Delete the wrong row by uuid, after backup-coolify-env.sh has written a recovery point."
