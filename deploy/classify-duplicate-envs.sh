#!/usr/bin/env bash
# Which of the two rows is the right one — answered without printing either.
#
# ─────────────────────────────────────────────────────────────────────────────
# `deploy.sh` already REFUSES an application with a duplicated key, and refusing
# is correct: nothing in a deploy reads a value, so nothing in a deploy can tell
# which copy was meant. But a refusal is not a repair, and the person holding
# the panel still has to know which row id to delete.
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
#       Connected to, and only the cluster's `system_identifier` is reported —
#       a number that identifies which database this is and reveals no host, no
#       user and no password. Compared against the identifiers this file knows,
#       so the answer is `staging`, `production` or `unknown` rather than a
#       string somebody has to squint at.
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

# shellcheck source=deploy/coolify-api.sh
. "$(dirname "${BASH_SOURCE[0]}")/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

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
  host=$(python3 - "$1" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
if p.scheme in ("postgres", "postgresql") and p.hostname:
    print(p.hostname)
PY
)
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
  local body
  body=$(curl -sS -m 20 "https://api.telegram.org/bot$1/getMe" 2>/dev/null) || {
    printf 'unreachable\n'
    return 0
  }
  printf '%s' "$body" | jq -er '
    if .ok then "id=\(.result.id) username=@\(.result.username)" else "invalid token (Telegram refused it)" end
  ' 2>/dev/null || printf 'unreadable answer from Telegram\n'
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

  # One line per row of a duplicated key: id, key, and a verdict. Keys that
  # appear once are not listed — they are not the question.
  while IFS=$'\t' read -r id key value; do
    [ -n "$id" ] || continue
    case "$key" in
      ENV_NAME | SERVICE | APP_VERSION | AUTO_* | MIRZABOT_* | TRUSTED_PROXY_*)
        printf '  row %-6s %-28s = %s\n' "$id" "$key" "$value" ;;
      DATABASE_URL)
        printf '  row %-6s %-28s -> %s\n' "$id" "$key" "$(classify_database_url "$value")" ;;
      TELEGRAM_BOT_TOKEN)
        printf '  row %-6s %-28s -> %s\n' "$id" "$key" "$(classify_bot_token "$value")" ;;
      *)
        printf '  row %-6s %-28s -> present (treated as a secret; not shown)\n' "$id" "$key" ;;
    esac
  done < <(printf '%s' "$envs" | python3 -c 'import json,sys
from collections import Counter
try:
    rows = json.load(sys.stdin)
except Exception:
    rows = []
rows = rows if isinstance(rows, list) else []
dupes = {k for k, n in Counter(r.get("key") for r in rows).items() if n > 1 and k}
for r in sorted((r for r in rows if r.get("key") in dupes), key=lambda r: (r.get("key") or "", r.get("id") or 0)):
    print("%s\t%s\t%s" % (r.get("id"), r.get("key"), r.get("value") or ""))')
done

say "nothing was deleted. Delete the wrong row by id, after backup-coolify-env.sh has written a recovery point."
