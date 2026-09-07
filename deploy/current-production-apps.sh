#!/usr/bin/env bash
# Resolve or atomically adopt the three Docker Image applications that normal
# production promotions target after the one-time Git/Dockerfile cutover.
#
# The root-owned deploy.env remains the source of credentials and database
# identity. Only application UUIDs move, and they move after Cutover has proven
# the new web services and the single bot poller. Keeping this small pointer in
# the deploy-owned state directory avoids requiring passwordless root merely to
# make the next release target the applications that now own production.

set -Eeuo pipefail

MODE=${1:-}
FILE=${2:-}

die() {
  echo "[current-apps] REFUSED: $*" >&2
  exit 1
}

valid_uuid() { [[ $1 =~ ^[a-z0-9]{20,32}$ ]]; }

validate_three() { # ingest dashboard bot
  local ingest=$1 dashboard=$2 bot=$3
  valid_uuid "$ingest" || die "ingest application uuid is missing or malformed"
  valid_uuid "$dashboard" || die "dashboard application uuid is missing or malformed"
  valid_uuid "$bot" || die "bot application uuid is missing or malformed"
  if [ "$ingest" = "$dashboard" ] || [ "$ingest" = "$bot" ] || [ "$dashboard" = "$bot" ]; then
    die "the three production roles must name distinct applications"
  fi
}

field() { # file key
  sed -n "s/^$2=//p" "$1" | head -1
}

resolve_pointer() {
  [ ! -L "$FILE" ] || die "$FILE is a symlink"
  [ -f "$FILE" ] || die "$FILE is not a regular file"
  [ -r "$FILE" ] || die "$FILE is not readable"
  if cut -d= -f1 "$FILE" | LC_ALL=C sort | uniq -d | grep -q .; then
    die "$FILE contains a duplicate key"
  fi
  local expected actual schema ingest dashboard bot sha digest
  expected=$(printf '%s\n' adopted_at app_bot app_dashboard app_ingest digest main_sha schema_version | LC_ALL=C sort)
  actual=$(cut -d= -f1 "$FILE" | LC_ALL=C sort)
  [ "$actual" = "$expected" ] || die "$FILE has missing or unexpected fields"
  schema=$(field "$FILE" schema_version)
  ingest=$(field "$FILE" app_ingest)
  dashboard=$(field "$FILE" app_dashboard)
  bot=$(field "$FILE" app_bot)
  sha=$(field "$FILE" main_sha)
  digest=$(field "$FILE" digest)
  [ "$schema" = 1 ] || die "$FILE has unsupported schema_version '$schema'"
  validate_three "$ingest" "$dashboard" "$bot"
  [[ $sha =~ ^[0-9a-f]{40}$ ]] || die "$FILE has a malformed main_sha"
  [[ $digest =~ ^sha256:[0-9a-f]{64}$ ]] || die "$FILE has a malformed digest"
  printf 'app_ingest=%s\napp_dashboard=%s\napp_bot=%s\napplications_source=adopted\n' \
    "$ingest" "$dashboard" "$bot"
}

case "$MODE" in
  resolve)
    CONF=${3:-}
    if [ -z "$FILE" ] || [ -z "$CONF" ]; then
      die "usage: $0 resolve <pointer> <deploy.env>"
    fi
    if [ -e "$FILE" ] || [ -L "$FILE" ]; then
      resolve_pointer
      exit 0
    fi
    [ -r "$CONF" ] || die "$CONF is not readable and no adopted application pointer exists"
    ingest=$(field "$CONF" APP_INGEST)
    dashboard=$(field "$CONF" APP_DASHBOARD)
    bot=$(field "$CONF" APP_BOT)
    validate_three "$ingest" "$dashboard" "$bot"
    printf 'app_ingest=%s\napp_dashboard=%s\napp_bot=%s\napplications_source=config\n' \
      "$ingest" "$dashboard" "$bot"
    ;;
  adopt)
    INGEST=${3:-}
    DASHBOARD=${4:-}
    BOT=${5:-}
    SHA=${6:-}
    DIGEST=${7:-}
    [ -n "$FILE" ] || die "usage: $0 adopt <pointer> <ingest> <dashboard> <bot> <sha> <digest>"
    validate_three "$INGEST" "$DASHBOARD" "$BOT"
    [[ $SHA =~ ^[0-9a-f]{40}$ ]] || die "main sha is malformed"
    [[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "digest is malformed"
    parent=$(dirname "$FILE")
    [ -d "$parent" ] || die "$parent does not exist"
    if [ -e "$FILE" ] || [ -L "$FILE" ]; then
      die "$FILE already exists — canonical production applications may be adopted only once"
    fi
    tmp=$(mktemp "$parent/.current-applications.XXXXXX") || die "cannot stage the application pointer"
    trap 'rm -f "$tmp"' EXIT
    chmod 600 "$tmp"
    {
      printf 'schema_version=1\n'
      printf 'app_ingest=%s\n' "$INGEST"
      printf 'app_dashboard=%s\n' "$DASHBOARD"
      printf 'app_bot=%s\n' "$BOT"
      printf 'main_sha=%s\n' "$SHA"
      printf 'digest=%s\n' "$DIGEST"
      printf 'adopted_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    } >"$tmp"
    # Parse the staged file through the same strict reader the next promotion
    # will use. An atomic rename then makes partial state impossible.
    staged=$FILE
    FILE=$tmp
    resolve_pointer >/dev/null
    FILE=$staged
    mv -f "$tmp" "$FILE"
    trap - EXIT
    echo "[current-apps] adopted the three canonical production applications"
    ;;
  *) die "usage: $0 resolve <pointer> <deploy.env> | adopt <pointer> <ingest> <dashboard> <bot> <sha> <digest>" ;;
esac
