#!/usr/bin/env bash
# Pre-merge Staging preparation: back up, classify, delete only what is proven wrong.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THIS EXISTS AS ONE SCRIPT
#
# `deploy.sh` refuses any application carrying a duplicated environment key, and
# staging carries fifteen of them across three applications. Until they are
# gone, the first post-merge Deploy Staging cannot succeed — so this is not
# tidying, it is the precondition.
#
# It is one script rather than a runbook of commands because the ordering is
# load-bearing and a human running six steps will eventually run them in five.
# Back up before mutating; classify before deleting; delete by exact row id;
# verify afterwards that nothing else moved.
#
# ── What it will not do ───────────────────────────────────────────────────
#
#   · touch production — every uuid it acts on is checked to be in the staging
#     environment first, by asking Coolify which environment owns it
#   · print, log or hash a secret value
#   · delete a row it cannot positively identify as wrong
#   · guess at a Telegram token — see the bot section, which is a refusal by
#     default and says so
#   · write to Coolify's database directly; every mutation is the supported API
#
# ── The token ─────────────────────────────────────────────────────────────
#
# Read as text from /etc/shikoo/staging/deploy.env, never `source`d, because a
# Coolify token is `<id>|<random>` and a shell would execute the pipe. It
# reaches curl through a 0600 config file and never through argv.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: step-e-runner.sh [--apply]
#
#   without --apply   classify and report; nothing is deleted   (default)
#   with    --apply   back up, then delete the rows proven wrong

set -Eeuo pipefail

APPLY=0
[ "${1:-}" != '--apply' ] || APPLY=1

ENV_ARG=staging
CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
STATE=${STATE:-/var/lib/shikoo}
CONTRACT=${CONTRACT:-$STATE/coolify-contract.env}
LOCK=${LOCK:-/var/lock/shikoo-step-e.lock}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

# The identities that must never be treated as a dedicated staging bot.
#
# `Test_Shikoo_bot` / 8856185613 is what the PRODUCTION bot is polling with
# right now — verified from production's own `settings` row and from getMe.
# Telegram hands each update to exactly one getUpdates caller, so a staging bot
# holding this token would silently take messages away from the bot customers
# are talking to. It is a disqualifier here, not a target.
PRODUCTION_BOT_ID=${PRODUCTION_BOT_ID:-8856185613}

# The two database containers, by the name a DATABASE_URL would use. Not
# secrets — they are container names — and recorded here so that "this row
# points at production" is a comparison rather than an impression.
STAGING_DB_HOST=${STAGING_DB_HOST:-bea6ac92holn5k6vjgopy2ai}
PRODUCTION_DB_HOST=${PRODUCTION_DB_HOST:-qd2vduj7kv05sp9ejdrmclmu}
COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}

say() { echo "[step-e] $*"; }
warn() { echo "[step-e] ! $*" >&2; }
die() {
  echo "[step-e] STOP: $*" >&2
  exit 1
}

# One at a time. Two of these racing would classify against a world the other
# is changing, and the loser would delete a row the winner had already proven.
exec 9>"$LOCK" || die "cannot open $LOCK"
flock -n 9 || die "another step-e run holds $LOCK"

[ -r "$CONF" ] || die "cannot read $CONF — run this as the shikoo-deploy user"

# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
# shellcheck source=deploy/coolify-app.sh
. "$HERE/coolify-app.sh"
# shellcheck source=deploy/coolify-secret-io.sh
. "$HERE/coolify-secret-io.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
secret_io_init
# One trap, both cleanups, and it fires on signal as well as on exit: a
# credential file that outlives its command is the problem it was created to
# avoid.
cleanup_all() { coolify_api_cleanup; secret_io_cleanup; }
trap cleanup_all EXIT INT TERM

coolify_db() {
  docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' -c "$1" 2>/dev/null || true
}

# ── preflight ─────────────────────────────────────────────────────────────
say "0. preflight"

[ -r "$CONTRACT" ] || die "no Coolify contract attestation at $CONTRACT"
( cd "$(dirname "$CONTRACT")" && sha256sum -c --status "$(basename "${CONTRACT%.env}.sha256")" ) ||
  die "the contract attestation checksum does not verify"
grep -qx 'schema_version=2' "$CONTRACT" || die "$CONTRACT is not a schema-2 attestation"
say "   contract attestation verified"

coolify_api GET '/teams/current' || die "cannot reach Coolify"
[ "$API_STATUS" = '200' ] || die "the token was refused (HTTP ${API_STATUS})"

# Every application this touches, resolved by name INSIDE the staging
# environment and then pinned to its uuid. A name alone is not enough: there is
# a `shikoo-ingest` in production too.
declare -A APP_UUID=()
declare -A APP_ROLE=()
for spec in 'shikoo-dev-ingest:ingest' 'shikoo-dev-dashboard:dashboard' 'shikoo-dev-bot:bot'; do
  name=${spec%%:*}
  role=${spec##*:}
  uuid=$(coolify_db "select a.uuid from applications a
      join environments e on e.id = a.environment_id
     where a.name = '${name}' and e.name = 'dev-fleet' limit 1;")
  [ -n "$uuid" ] || die "no staging application named ${name}"
  APP_UUID[$name]=$uuid
  APP_ROLE[$name]=$role
  say "   ${name} = ${uuid} (${role})"
done

# Production must be provably out of scope, by uuid, before anything mutates.
for name in "${!APP_UUID[@]}"; do
  env_of=$(coolify_db "select e.name from applications a
      join environments e on e.id = a.environment_id where a.uuid = '${APP_UUID[$name]}';")
  [ "$env_of" = 'dev-fleet' ] ||
    die "${name} (${APP_UUID[$name]}) is in environment '${env_of}', not dev-fleet — refusing"
done
say "   all three applications are in dev-fleet; production is out of scope"

# Auto Deploy and previews must already be off, and must still be off at the
# end. Recorded now so the comparison at the end is against observed fact.
FLAGS_BEFORE=''
for name in shikoo-dev-ingest shikoo-dev-dashboard shikoo-dev-bot; do
  f=$(coolify_settings_flags "${APP_UUID[$name]}")
  [ "$f" = 'f|f' ] || die "${name} has auto_deploy|previews = '${f}', expected f|f"
  FLAGS_BEFORE="${FLAGS_BEFORE}${name}=${f} "
done
say "   auto-deploy and previews are off on all three"

# ── the duplicated keys, from Coolify's own database ──────────────────────
say "1. duplicated keys"
DUPES=$(coolify_db "select a.name, ev.key, count(*)
    from environment_variables ev
    join applications a on a.id = ev.resourceable_id
     and ev.resourceable_type = 'App\\Models\\Application'
    join environments e on e.id = a.environment_id
   where e.name = 'dev-fleet'
   group by a.name, ev.key having count(*) > 1
   order by a.name, ev.key;")
DUPE_COUNT=$(printf '%s\n' "$DUPES" | grep -c . || true)
[ "${DUPE_COUNT:-0}" -gt 0 ] || {
  say "   none — staging already has one row per key"
  exit 0
}
say "   ${DUPE_COUNT} duplicated key(s)"
EXPECTED_DUPES=$(printf '%s\n' "$DUPES" | awk -F'|' 'NF >= 2 { print $1 "/" $2 }' | sort)

# ── classification ────────────────────────────────────────────────────────
#
# Values are read through the API, which decrypts them. Nothing is printed:
# each key is reduced to a verdict, and the verdicts are what the operator
# reads. Comparing the stored ciphertext instead would be worse than useless —
# Laravel uses a random IV, so two rows holding the same plaintext differ.
say "2. classification"

KEEP=''   # "<uuid>:<rowid>" per key
DROP=''   # "<uuid>:<rowid>"
BLOCKED=''
CLASSIFIED_DUPES=''

duplicate_keys() { # rows -> one validated environment key per line
  printf '%s' "$1" | python3 -c '
import json,re,sys
from collections import Counter
try:
    rows=json.load(sys.stdin)
except Exception:
    raise SystemExit(2)
if not isinstance(rows,list) or not all(isinstance(r,dict) for r in rows):
    raise SystemExit(2)
for r in rows:
    if not isinstance(r.get("key"),str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*",r["key"]):
        raise SystemExit(3)
    if "value" not in r:
        raise SystemExit(4)
for key,n in sorted(Counter(r["key"] for r in rows).items()):
    if n > 1:
        print(key)'
}

classify_app() { # app-name
  local name=$1 uuid=${APP_UUID[$1]} role=${APP_ROLE[$1]} rows keys key ids
  coolify_api GET "/applications/${uuid}/envs" || die "could not read ${name}'s environment"
  [ "$API_STATUS" = '200' ] ||
    die "reading ${name}'s environment was refused (HTTP ${API_STATUS}) — refusing to report «no duplicates» about an application this token cannot read"
  rows=$API_BODY

  keys=$(duplicate_keys "$rows") ||
    die "${name}: Coolify returned malformed environment rows — refusing to classify an unreadable response"
  for key in $keys; do
    CLASSIFIED_DUPES="${CLASSIFIED_DUPES}${name}/${key}"$'\n'
    ids=$(printf '%s' "$rows" | python3 -c '
import json,re,sys
d=json.load(sys.stdin)
out=[]
for r in d:
    if r.get("key")!=sys.argv[1]: continue
    u=r.get("uuid")
    if not isinstance(u,str) or not re.fullmatch(r"[A-Za-z0-9_-]{3,64}",u):
        sys.stderr.write("row without a safe uuid\n"); sys.exit(3)
    out.append(u)
print(" ".join(out))' "$key") ||
      die "${name} ${key}: a row came back without a safe uuid — refusing to act on rows this API cannot address"

    case "$key" in
      ENV_NAME)      classify_literal "$name" "$uuid" "$key" "$ids" 'staging' "$rows" ;;
      SERVICE)       classify_literal "$name" "$uuid" "$key" "$ids" "$role" "$rows" ;;
      DATABASE_URL)  classify_database "$name" "$uuid" "$key" "$ids" "$rows" ;;
      TELEGRAM_BOT_TOKEN) classify_bot "$name" "$uuid" "$key" "$ids" "$rows" ;;
      *)             classify_effective "$name" "$uuid" "$key" "$ids" "$rows" ;;
    esac
  done
}

# ── row identity ──────────────────────────────────────────────────────────
#
# The API row identity is `uuid`, and only `uuid`.
#
# The first version of this script indexed `r["id"]` and died with `KeyError:
# 'id'` before it mutated anything — which was the good outcome of a real bug:
# this Coolify serialises environment variables with a `uuid` and NO numeric
# `id`. Measured on the live instance: 14/14 rows carry `uuid`, 0/14 carry `id`.
#
# A numeric id still exists in the database, and the recovery backup is written
# from the database, so the two have to be tied together. That mapping is made
# by exact uuid plus exact resourceable, and it must match exactly one row —
# never by position in the response, never by key, and never by comparing
# values or ciphertext. Correlating rows by their order in a JSON array is the
# kind of shortcut that works until the day the array is ordered differently.
#
# `value` is the canonical decrypted field, not `real_value`. `value` is cast
# `encrypted` on the model, so the serialiser hands back plaintext.
# `real_value` is an appended accessor that additionally resolves shared
# variables and then runs `escapeEnvVariables()`, wrapping literal and
# multiline values in quotes — a shell-ready rendering, which is the wrong
# thing to compare and the wrong thing to store.
value_of() { # rows row-uuid -> value on stdout (never displayed by callers)
  printf '%s' "$1" | python3 -c '
import json,sys
d=json.load(sys.stdin)
for r in (d if isinstance(d,list) else []):
    if r.get("uuid")==sys.argv[1]:
        sys.stdout.write(r.get("value") or ""); break' "$2"
}

# The database row behind an API uuid. Exactly one, or the run stops.
db_id_for() { # app-uuid row-uuid -> numeric id
  local app_uuid=$1 row_uuid=$2 n id
  [[ $app_uuid =~ ^[a-z0-9]{20,32}$ ]] ||
    die "application uuid '${app_uuid}' is not safe to use in the identity lookup"
  [[ $row_uuid =~ ^[A-Za-z0-9_-]{3,64}$ ]] ||
    die "environment uuid '${row_uuid}' is not safe to use in the identity lookup"
  n=$(coolify_db "select count(*) from environment_variables ev
        join applications a on a.id = ev.resourceable_id
       where ev.uuid = '${row_uuid}'
         and ev.resourceable_type = 'App\\Models\\Application'
         and a.uuid = '${app_uuid}';")
  [ "$n" = '1' ] ||
    die "environment row ${row_uuid} on ${app_uuid} matches ${n:-0} database rows, expected exactly 1 — refusing to guess which"
  id=$(coolify_db "select ev.id from environment_variables ev
        join applications a on a.id = ev.resourceable_id
       where ev.uuid = '${row_uuid}'
         and ev.resourceable_type = 'App\\Models\\Application'
         and a.uuid = '${app_uuid}';")
  printf '%s' "$id"
}

# Non-secret keys: the correct value is known, so the verdict can name it.
classify_literal() { # name uuid key ids want rows
  local name=$1 uuid=$2 key=$3 ids=$4 want=$5 rows=$6 id v keep='' drop=''
  for id in $ids; do
    v=$(value_of "$rows" "$id")
    if [ "$v" = "$want" ]; then keep="${keep}${id} "; else drop="${drop}${id} "; fi
  done
  record "$name" "$uuid" "$key" "$keep" "$drop" "wanted '${want}'" "$rows"
}

# A URL is never shown or dialled. Its container hostname is parsed on stdin;
# that is enough to distinguish the two databases while user, password, port
# and database name are discarded.
classify_database() { # name uuid key ids rows
  local name=$1 uuid=$2 key=$3 ids=$4 rows=$5 id v host keep='' drop='' detail=''
  for id in $ids; do
    v=$(value_of "$rows" "$id")
    # Parsed, not dialled. See the header of coolify-secret-io.sh: the host is
    # the database container's own name, which answers the question without a
    # connection — and without opening a session to production in order to
    # discover that this row points at production.
    host=$(pg_host_of "$v")
    # The hostname is reported, not just the verdict: it is non-secret, it is
    # the actual evidence, and «staging» with no number behind it is a claim
    # rather than a proof.
    #
    # An unreachable row adds itself to NEITHER list — it must not be kept and
    # must not be deleted. It does not clear the lists either: an earlier
    # version did, which silently discarded a correct verdict already reached
    # for a sibling row and turned a clean classification into a blocked one.
    # An unparsable or unknown host joins NEITHER list: it must not be kept and
    # must not be deleted. It does not clear the lists either — an earlier
    # version did, discarding a correct verdict already reached for a sibling.
    case "$host" in
      "$STAGING_DB_HOST")    keep="${keep}${id} "; detail="${detail}${id}=staging(${host}) " ;;
      "$PRODUCTION_DB_HOST") drop="${drop}${id} "; detail="${detail}${id}=PRODUCTION(${host}) " ;;
      '')                    detail="${detail}${id}=unparsable " ;;
      *)                     detail="${detail}${id}=unknown-host(${host}) " ;;
    esac
  done
  record "$name" "$uuid" "$key" "$keep" "$drop" "$detail" "$rows"
}

# The bot token is classified by its PUBLIC identity and nothing else.
classify_bot() { # name uuid key ids rows
  local name=$1 uuid=$2 key=$3 ids=$4 rows=$5 id v identity botid botname keep='' drop='' detail=''
  local ids_seen=''
  for id in $ids; do
    v=$(value_of "$rows" "$id")
    # The token reaches curl through a 0600 config, never through argv.
    identity=$(tg_get_me "$v")
    botid=${identity%% *}
    if [[ $identity == *' '* ]]; then botname=${identity#* }; else botname=''; fi
    [ -n "$identity" ] || { botid=''; botname=''; }
    if [ -z "$botid" ]; then
      detail="${detail}${id}=invalid "
    elif [ "$botid" = "$PRODUCTION_BOT_ID" ]; then
      detail="${detail}${id}=PRODUCTION-BOT(@${botname}) "
    else
      detail="${detail}${id}=@${botname}(${botid}) "
      keep="${keep}${id} "
      case " $ids_seen " in *" $botid "*) ;; *) ids_seen="${ids_seen}${botid} " ;; esac
    fi
  done
  # Rows that resolve to the SAME dedicated bot are not ambiguous.
  #
  # Telegram issues one active token per bot and invalidates the previous one on
  # revoke, so two tokens that both answer getMe with the same id are the same
  # credential. Whichever row survives, the bot is that bot. Refusing here was
  # the wrong refusal: it left the application undeployable to protect against
  # a choice that does not exist.
  #
  # Genuine ambiguity — two DIFFERENT non-production bots, or none — still
  # leaves both rows alone, because something would have to say which, and
  # nothing here can.
  local nkeep distinct
  nkeep=$(printf '%s' "$keep" | wc -w)
  distinct=$(printf '%s' "$ids_seen" | tr ' ' '\n' | grep -c . || true)
  if [ "$nkeep" -ge 1 ] && [ "$distinct" -eq 1 ]; then
    local id first=''
    for id in $keep; do
      if [ -z "$first" ]; then first=$id; else drop="${drop}${id} "; fi
    done
    for id in $ids; do
      case " $keep " in *" $id "*) ;; *) drop="${drop}${id} " ;; esac
    done
    keep=$first
    record "$name" "$uuid" "$key" "$keep" "$drop" "$detail" "$rows"
  else
    BLOCKED="${BLOCKED}${name}/${key} "
    say "   ${name} ${key}: AMBIGUOUS — ${detail}— both rows left untouched"
  fi
}

# Everything else: the running container is the authority. Whatever it is
# using is, by definition, the value this environment has been working with.
classify_effective() { # name uuid key ids rows
  local name=$1 uuid=$2 key=$3 ids=$4 rows=$5 id v cid line eff keep='' drop=''
  cid=$(docker ps --filter "label=coolify.name=${uuid}" --format '{{.Names}}' 2>/dev/null | head -1)
  if [ -z "$cid" ]; then
    BLOCKED="${BLOCKED}${name}/${key} "
    say "   ${name} ${key}: no running container to resolve the effective value — left untouched"
    return
  fi
  line=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$cid" 2>/dev/null |
    awk -v prefix="${key}=" 'index($0,prefix)==1 { print; exit }')
  if [ -z "$line" ]; then
    BLOCKED="${BLOCKED}${name}/${key} "
    say "   ${name} ${key}: the running container has no such environment key — left untouched"
    return
  fi
  eff=${line#*=}
  for id in $ids; do
    v=$(value_of "$rows" "$id")
    if [ "$v" = "$eff" ]; then keep="${keep}${id} "; else drop="${drop}${id} "; fi
  done
  record "$name" "$uuid" "$key" "$keep" "$drop" "matched the running container" "$rows"
}

# All candidates hold byte-identical values?
#
# This is the shape MOST duplicates actually have: one form submitted twice, so
# both rows say `staging`, both say `ingest`, both hold the same URL. An earlier
# version called that "2 rows qualify" and refused — which is the wrong
# refusal. When every candidate is correct AND identical, deleting all but one
# cannot change what the container reads, and refusing leaves the application
# undeployable for no benefit at all.
#
# Different values that both look correct are a different matter and stay
# refused: something has to say WHICH, and nothing here can.
all_identical() { # rows id...
  local rows=$1 first='' v have_first=0
  shift
  for v in "$@"; do
    v=$(value_of "$rows" "$v")
    if [ "$have_first" -eq 0 ]; then
      first=$v
      have_first=1
    elif [ "$v" != "$first" ]; then
      return 1
    fi
  done
  return 0
}

record() { # name uuid key keep drop detail rows
  local name=$1 uuid=$2 key=$3 keep=$4 drop=$5 detail=$6 rows=${7:-} id
  local nkeep
  nkeep=$(printf '%s' "$keep" | wc -w)

  # More than one qualifying row, all holding the same value: keep the first
  # and drop the rest. Deterministic, so two runs agree.
  # $keep is a space-separated list of row uuids and is meant to split into
  # arguments here; the uuids are [a-z0-9] and cannot glob.
  # shellcheck disable=SC2086
  if [ "$nkeep" -gt 1 ] && [ -n "$rows" ] && all_identical "$rows" $keep; then
    local first='' rest=''
    for id in $keep; do
      if [ -z "$first" ]; then first=$id; else rest="${rest}${id} "; fi
    done
    say "   ${name} ${key}: ${nkeep} identical rows — keep ${first}, drop ${rest% } (${detail})"
    KEEP="${KEEP}${uuid}:${first} "
    for id in $rest; do DROP="${DROP}${uuid}:${id} "; done
    for id in $drop; do DROP="${DROP}${uuid}:${id} "; done
    return
  fi

  if [ "$nkeep" -ne 1 ]; then
    BLOCKED="${BLOCKED}${name}/${key} "
    say "   ${name} ${key}: ${nkeep} rows qualify (${detail}) — left untouched"
    return
  fi
  say "   ${name} ${key}: keep ${keep% }, drop ${drop:-none} (${detail})"
  for id in $keep; do KEEP="${KEEP}${uuid}:${id} "; done
  for id in $drop; do DROP="${DROP}${uuid}:${id} "; done
}

for name in shikoo-dev-ingest shikoo-dev-dashboard shikoo-dev-bot; do
  classify_app "$name"
done

CLASSIFIED_DUPES=$(printf '%s' "$CLASSIFIED_DUPES" | sed '/^$/d' | sort)
[ "$CLASSIFIED_DUPES" = "$EXPECTED_DUPES" ] ||
  die "Coolify API duplicate keys do not match the database inventory — refusing a partial or stale classification"

DROP_COUNT=$(printf '%s' "$DROP" | wc -w)
BLOCKED_COUNT=$(printf '%s' "$BLOCKED" | wc -w)
say "   ${DROP_COUNT} row(s) proven wrong; ${BLOCKED_COUNT} key(s) left untouched"

if [ "$APPLY" -eq 0 ]; then
  say ""
  say "DRY RUN — nothing was changed. Re-run with --apply to back up and delete."
  exit 0
fi

# ── 3. the recovery point, before a single deletion ───────────────────────
#
# The rows as stored, ciphertext untouched, so a wrong deletion is undoable.
# A list of ids and keys is not a backup: it cannot restore a DATABASE_URL.
say "3. recovery backup"
ENV_BACKUP_ID="stepe-$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_PATH="$STATE/env-backups/$ENV_BACKUP_ID"
bash "$HERE/backup-coolify-env.sh" "$BACKUP_PATH" \
  "${APP_UUID[shikoo-dev-ingest]}" "${APP_UUID[shikoo-dev-dashboard]}" "${APP_UUID[shikoo-dev-bot]}" ||
  die "the recovery backup failed — nothing is deleted without one"

# Every row about to be deleted must be IN that backup, checked by its DATABASE
# id — the backup is written from the database and knows nothing about API
# uuids. The mapping is made per row, and a uuid that does not resolve to
# exactly one database row stops the run rather than being skipped.
DROP_DBIDS=''
for pair in $DROP; do
  app_uuid=${pair%%:*}
  row_uuid=${pair##*:}
  dbid=$(db_id_for "$app_uuid" "$row_uuid")
  [ -n "$dbid" ] || die "could not resolve a database id for row ${row_uuid}"
  grep -q "VALUES (${dbid}," "$BACKUP_PATH/coolify-env-rows.sql" ||
    die "database row ${dbid} (api ${row_uuid}) is not in the recovery backup — refusing to delete a row that cannot be put back"
  DROP_DBIDS="${DROP_DBIDS}${dbid} "
done
say "   all ${DROP_COUNT} row(s) to be deleted are present in ${BACKUP_PATH}"

# ── 4. delete, by exact row id, through the supported API ─────────────────
say "4. deleting"

# Non-secret digests of every row that is being KEPT, taken before anything is
# removed. `md5(value)` over ciphertext reveals nothing and is only ever
# compared with itself — it is the evidence that a delete of one row did not
# quietly rewrite its neighbour.
# Database ids for the rows being kept, resolved the same exact way.
KEEP_DBIDS=''
for pair in $KEEP; do
  app_uuid=${pair%%:*}
  row_uuid=${pair##*:}
  dbid=$(db_id_for "$app_uuid" "$row_uuid")
  KEEP_DBIDS="${KEEP_DBIDS}${dbid},"
done
KEEP_DBIDS=${KEEP_DBIDS%,}

# Non-secret digests of every row being KEPT, taken before anything is removed.
# `md5(value)` over the stored column reveals nothing and is only ever compared
# with itself — it is the evidence that deleting one row did not quietly
# rewrite its neighbour.
DIGESTS_BEFORE=$(coolify_db "select id||'='||md5(value) from environment_variables
   where id in (${KEEP_DBIDS:-0}) order by id;")

KEYSET_BEFORE=$(coolify_db "select a.name||':'||ev.key
    from environment_variables ev
    join applications a on a.id = ev.resourceable_id and ev.resourceable_type = 'App\\Models\\Application'
    join environments e on e.id = a.environment_id
   where e.name = 'dev-fleet' group by a.name, ev.key order by 1;")

for pair in $DROP; do
  app_uuid=${pair%%:*}
  row_uuid=${pair##*:}
  # Re-resolved immediately before the delete. If the row moved, vanished or
  # became ambiguous between classification and now, `db_id_for` stops the run
  # rather than letting the deletion land somewhere else.
  dbid=$(db_id_for "$app_uuid" "$row_uuid")
  [ -n "$dbid" ] || die "row ${row_uuid} no longer resolves — refusing to continue on a moved target"
  coolify_api DELETE "/applications/${app_uuid}/envs/${row_uuid}" ||
    die "could not reach Coolify to delete row ${row_uuid}"
  case "$API_STATUS" in
    2??) say "   deleted row ${row_uuid} (db ${dbid}) from ${app_uuid}" ;;
    *) die "deleting row ${row_uuid} was refused (HTTP ${API_STATUS})" ;;
  esac
done

# ── 5. prove only what was meant to change, changed ───────────────────────
say "5. verification"

STILL_DUPED=$(coolify_db "select a.name||':'||ev.key
    from environment_variables ev
    join applications a on a.id = ev.resourceable_id and ev.resourceable_type = 'App\\Models\\Application'
    join environments e on e.id = a.environment_id
   where e.name = 'dev-fleet' group by a.name, ev.key having count(*) > 1 order by 1;")
STILL_COUNT=$(printf '%s\n' "$STILL_DUPED" | grep -c . || true)

KEYSET_AFTER=$(coolify_db "select a.name||':'||ev.key
    from environment_variables ev
    join applications a on a.id = ev.resourceable_id and ev.resourceable_type = 'App\\Models\\Application'
    join environments e on e.id = a.environment_id
   where e.name = 'dev-fleet' group by a.name, ev.key order by 1;")
[ "$KEYSET_BEFORE" = "$KEYSET_AFTER" ] ||
  die "the set of KEYS changed — a deletion removed the last row of a key, which is not what any of this was for"
say "   the keyset is unchanged: every key that existed still exists"

# The rows that were kept must be byte-identical to what the backup captured,
# so a deletion cannot have quietly rewritten a neighbour.
DIGESTS_AFTER=$(coolify_db "select id||'='||md5(value) from environment_variables
   where id in (${KEEP_DBIDS:-0}) order by id;")
[ "$DIGESTS_BEFORE" = "$DIGESTS_AFTER" ] ||
  die "a row that was supposed to be untouched changed value during the cleanup"
say "   every kept row is present and byte-identical to before the deletions"

FLAGS_AFTER=''
for name in shikoo-dev-ingest shikoo-dev-dashboard shikoo-dev-bot; do
  f=$(coolify_settings_flags "${APP_UUID[$name]}")
  [ "$f" = 'f|f' ] || die "${name} auto_deploy|previews became '${f}' during cleanup"
  FLAGS_AFTER="${FLAGS_AFTER}${name}=${f} "
done
say "   auto-deploy and previews are still off"

DEPLOYS=$(coolify_db "select count(*) from application_deployment_queues
   where application_id in ('${APP_UUID[shikoo-dev-ingest]}','${APP_UUID[shikoo-dev-dashboard]}','${APP_UUID[shikoo-dev-bot]}')
     and created_at > now() - interval '10 minutes';")
[ "${DEPLOYS:-0}" = '0' ] || die "${DEPLOYS} deployment(s) were queued during cleanup — editing a variable must not deploy"
say "   no deployment was queued"

# ── 6. the evidence, with nothing secret in it ────────────────────────────
EVIDENCE="$STATE/step-e-evidence.env"
{
  printf 'schema_version=1\n'
  printf 'environment=staging\n'
  printf 'app_ingest=%s\n' "${APP_UUID[shikoo-dev-ingest]}"
  printf 'app_dashboard=%s\n' "${APP_UUID[shikoo-dev-dashboard]}"
  printf 'app_bot=%s\n' "${APP_UUID[shikoo-dev-bot]}"
  printf 'duplicated_keys_before=%s\n' "$DUPE_COUNT"
  printf 'rows_deleted=%s\n' "$DROP_COUNT"
  printf 'deleted_api_uuids=%s\n' "$(printf '%s' "$DROP" | tr ' ' ',' | sed 's/,$//')"
  printf 'deleted_db_ids=%s\n' "$(printf '%s' "$DROP_DBIDS" | tr ' ' ',' | sed 's/,$//')"
  printf 'keys_left_untouched=%s\n' "${BLOCKED:-none}"
  printf 'duplicated_keys_after=%s\n' "${STILL_COUNT:-0}"
  printf 'keyset_unchanged=yes\n'
  printf 'auto_deploy_before=%s\n' "${FLAGS_BEFORE% }"
  printf 'auto_deploy_after=%s\n' "${FLAGS_AFTER% }"
  printf 'deployments_triggered=%s\n' "${DEPLOYS:-0}"
  printf 'env_backup=%s\n' "$BACKUP_PATH"
  printf 'env_backup_owner=%s\n' "$(stat -c '%U:%G' "$BACKUP_PATH/coolify-env-rows.sql" 2>/dev/null || echo unknown)"
  printf 'env_backup_mode=%s\n' "$(stat -c '%a' "$BACKUP_PATH/coolify-env-rows.sql" 2>/dev/null || echo unknown)"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$EVIDENCE"
( cd "$STATE" && sha256sum step-e-evidence.env >step-e-evidence.sha256 )

say ""
say "evidence: $EVIDENCE"
cat "$EVIDENCE"
if [ "${STILL_COUNT:-0}" -ne 0 ]; then
  say ""
  warn "${STILL_COUNT} key(s) still duplicated and deliberately untouched: ${BLOCKED% }"
  warn "deploy.sh will still refuse those applications until they are resolved."
  exit 1
fi
say "one row per key on all three staging applications."
