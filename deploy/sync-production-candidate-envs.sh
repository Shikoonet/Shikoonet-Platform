#!/usr/bin/env bash
# Give the first Docker Image candidates the configuration of the applications
# they replace, without putting a secret in a log or a process argument.
#
# Candidate creation is deliberately configuration-free: until native Auto
# Deploy and previews have been PATCHed off and verified against Coolify's own
# database, a production token or DATABASE_URL has no business being attached
# to the new resource. That safe ordering leaves one more step, though. A
# stopped, hardened candidate still cannot boot until its service environment
# has been copied. `prepare-production.sh` calls this immediately after the
# three applications have been ensured and before one is deployed.
#
# The source is the CURRENT production application for the same role. Only
# active (non-preview) rows are copied, and the flags that change how Coolify
# presents a variable to the build and runtime are preserved. Coolify itself
# creates one dormant preview twin whenever a new active application variable
# is inserted, even when preview deployments are disabled. Target validation
# therefore permits one twin for a managed active key, but still refuses a
# preview-only key or a duplicate in either scope. APP_VERSION and
# SOURCE_COMMIT describe running bytes rather than service configuration, so
# the deploy writes the new APP_VERSION and Coolify owns SOURCE_COMMIT. The
# dashboard's INGEST_URL is also release-specific: deploy.sh derives it from
# the candidate ingest domain before the dashboard starts.
#
# Coolify 4.3.4's PATCH /applications/{uuid}/envs/bulk is an upsert. Using it
# matters: the single-row POST endpoint on this installation has been observed
# creating two identical rows. The read-before-write and read-after-write
# checks below make the operation idempotent and refuse any ambiguity rather
# than choosing whichever duplicate Coolify would put last in a container.
#
# Run:
#   sync-production-candidate-envs.sh \
#     <source-ingest> <candidate-ingest> \
#     <source-dashboard> <candidate-dashboard> \
#     <source-bot> <candidate-bot>

set -Eeuo pipefail

SRC_INGEST=${1:-}
DST_INGEST=${2:-}
SRC_DASHBOARD=${3:-}
DST_DASHBOARD=${4:-}
SRC_BOT=${5:-}
DST_BOT=${6:-}

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONF=${CONF:-/etc/shikoo/production/deploy.env}

say() { echo "[candidate-envs] $*"; }
die() {
  echo "[candidate-envs] REFUSED: $*" >&2
  exit 1
}

for uuid in "$SRC_INGEST" "$DST_INGEST" "$SRC_DASHBOARD" "$DST_DASHBOARD" "$SRC_BOT" "$DST_BOT"; do
  [[ $uuid =~ ^[a-z0-9]{20,32}$ ]] ||
    die "'$uuid' is not a Coolify application uuid"
done

# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

SYNC_DIR="$COOLIFY_API_DIR/candidate-envs"
mkdir -p "$SYNC_DIR"
chmod 700 "$SYNC_DIR"

# One parser for both sides of the comparison, so the verifier cannot quietly
# disagree with the serializer about a default flag. JSON arrives on stdin;
# secret values therefore never enter python's argv. In source mode it emits
# the exact bulk-upsert body. In target mode it emits nothing and returns:
#   0: every managed row is present and identical
#   3: a managed row is absent or differs (safe to upsert)
#   2: the candidate is ambiguous or contains unmanaged configuration
env_shape() { # source|target role desired-file-or-dash
  python3 -c '
import json, re, sys
from collections import Counter, defaultdict

mode, role, desired_path = sys.argv[1:4]
transient = {"APP_VERSION", "SOURCE_COMMIT"}
if role == "dashboard":
    transient.add("INGEST_URL")

def refuse(message, code=2):
    print(message, file=sys.stderr)
    raise SystemExit(code)

try:
    rows = json.load(sys.stdin)
except Exception:
    refuse("Coolify returned invalid environment JSON")
if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
    refuse("Coolify environment response is not an array of rows")

def flag(row, name, default):
    value = row.get(name, default)
    if not isinstance(value, bool):
        refuse("%s has a non-boolean %s flag" % (row.get("key") or "an environment row", name))
    return value

def canonical(row):
    key = row.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        refuse("Coolify returned an invalid environment key")
    if "value" not in row:
        # is_shown_once rows are hidden even from a token allowed to read other
        # secrets. Replacing such a value with null would be data loss wearing
        # the shape of a successful copy.
        refuse("%s has no readable value; it cannot be copied safely" % key)
    value = row["value"]
    if value is not None and not isinstance(value, str):
        refuse("%s has a non-string value" % key)
    comment = row.get("comment")
    if comment is not None and not isinstance(comment, str):
        refuse("%s has a non-string comment" % key)
    if isinstance(comment, str) and len(comment) > 256:
        refuse("%s has a comment Coolify bulk update cannot accept" % key)
    return {
        "key": key,
        "value": value,
        "is_preview": flag(row, "is_preview", False),
        "is_literal": flag(row, "is_literal", False),
        "is_multiline": flag(row, "is_multiline", False),
        "is_shown_once": flag(row, "is_shown_once", False),
        "is_runtime": flag(row, "is_runtime", True),
        "is_buildtime": flag(row, "is_buildtime", True),
        "comment": comment,
    }

if mode == "source":
    grouped = defaultdict(list)
    for row in rows:
        if flag(row, "is_preview", False):
            continue
        item = canonical(row)
        if item["key"] in transient:
            continue
        grouped[item["key"]].append(item)

    desired = []
    for key in sorted(grouped):
        copies = grouped[key]
        first = copies[0]
        if any(item != first for item in copies[1:]):
            refuse("source key %s is duplicated with different values or flags" % key)
        desired.append(first)

    by_key = {item["key"]: item for item in desired}
    for required in ("ENV_NAME", "SERVICE", "DATABASE_URL"):
        if required not in by_key:
            refuse("source %s has no %s" % (role, required))
    if by_key["ENV_NAME"]["value"] != "production":
        refuse("source %s is not ENV_NAME=production" % role)
    if by_key["SERVICE"]["value"] != role:
        refuse("source %s has the wrong SERVICE" % role)
    database_url = by_key["DATABASE_URL"]["value"]
    if not isinstance(database_url, str) or not database_url.strip():
        refuse("source %s has an empty DATABASE_URL" % role)

    print(json.dumps({"data": desired}, separators=(",", ":")))
    raise SystemExit(0)

if mode != "target":
    refuse("unknown environment comparison mode")

try:
    with open(desired_path, encoding="utf-8") as handle:
        desired = json.load(handle)["data"]
except Exception:
    refuse("the private candidate environment snapshot is invalid")

wanted = {item["key"]: item for item in desired}
active_keys = []
preview_keys = []
target = {}
for row in rows:
    key = row.get("key")
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", key):
        refuse("candidate contains an invalid environment key")
    is_preview = flag(row, "is_preview", False)
    (preview_keys if is_preview else active_keys).append(key)
    if key in transient:
        continue
    if is_preview:
        # EnvironmentVariable::created() in Coolify creates this dormant twin
        # for every new active application variable. Preview deployments are
        # disabled and proven separately; here the safety boundary is that a
        # twin may name only a managed active key and may occur only once.
        continue
    target[key] = canonical(row)

active_duplicates = sorted(key for key, count in Counter(active_keys).items() if count > 1)
if active_duplicates:
    refuse("candidate has duplicate active key(s): %s" % ", ".join(active_duplicates))

preview_duplicates = sorted(key for key, count in Counter(preview_keys).items() if count > 1)
if preview_duplicates:
    refuse("candidate has duplicate preview key(s): %s" % ", ".join(preview_duplicates))

unexpected_preview = sorted(set(preview_keys) - set(wanted) - transient)
if unexpected_preview:
    refuse("candidate has unmanaged preview key(s): %s" % ", ".join(unexpected_preview))

unexpected = sorted(set(target) - set(wanted))
if unexpected:
    refuse("candidate has unmanaged active key(s): %s" % ", ".join(unexpected))

if set(target) != set(wanted):
    raise SystemExit(3)
for key, item in wanted.items():
    if target[key] != item:
        raise SystemExit(3)
raise SystemExit(0)
' "$1" "$2" "$3"
}

read_envs() { # uuid description
  coolify_api GET "/applications/$1/envs" ||
    die "$2 environment could not be read from Coolify"
  [ "$API_STATUS" = '200' ] ||
    die "$2 environment read was refused (HTTP ${API_STATUS})"
}

sync_one() { # source candidate role
  local source=$1 candidate=$2 role=$3 desired before after count
  desired="$SYNC_DIR/${role}.json"
  before="$SYNC_DIR/${role}.source-before.json"
  after="$SYNC_DIR/${role}.source-after.json"

  read_envs "$source" "source ${role}"
  if ! printf '%s' "$API_BODY" | env_shape source "$role" - >"$desired"; then
    die "source ${role} configuration is not safe to copy"
  fi
  chmod 600 "$desired"
  count=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))["data"]))' "$desired")

  # Once the first cutover is history the canonical Docker Image application
  # may itself be the source. Validate it, but never PATCH an application from
  # a snapshot of itself.
  if [ "$source" = "$candidate" ]; then
    if ! printf '%s' "$API_BODY" | env_shape target "$role" "$desired"; then
      die "canonical ${role} application is not a unique, exact copy of its own source configuration"
    fi
    say "${role}: source is already the canonical application (${count} managed variables); nothing copied"
    return 0
  fi

  read_envs "$candidate" "candidate ${role}"
  if printf '%s' "$API_BODY" | env_shape target "$role" "$desired"; then
    say "${role}: ${count} managed variables already match; nothing written"
    return 0
  else
    case $? in
      3) ;;
      *) die "candidate ${role} configuration is ambiguous; nothing was written" ;;
    esac
  fi

  # Read the source a second time immediately before the write. A UI edit is
  # not covered by the release flock, so a source that moved underneath this
  # run must be retried from one coherent snapshot.
  cp "$desired" "$before"
  chmod 600 "$before"
  read_envs "$source" "source ${role}"
  if ! printf '%s' "$API_BODY" | env_shape source "$role" - >"$after"; then
    die "source ${role} configuration changed into an unreadable shape"
  fi
  chmod 600 "$after"
  cmp -s "$before" "$after" ||
    die "source ${role} configuration changed while it was being copied; retry from a stable source"

  coolify_api PATCH "/applications/${candidate}/envs/bulk" "$(<"$desired")" ||
    die "candidate ${role} environment update could not reach Coolify"
  case "$API_STATUS" in
    2??) ;;
    *) die "candidate ${role} environment update was refused (HTTP ${API_STATUS})" ;;
  esac

  read_envs "$candidate" "candidate ${role} after update"
  if ! printf '%s' "$API_BODY" | env_shape target "$role" "$desired"; then
    die "candidate ${role} did not read back exactly what Coolify accepted"
  fi
  say "${role}: copied and verified ${count} managed variables"
}

sync_one "$SRC_INGEST" "$DST_INGEST" ingest
sync_one "$SRC_DASHBOARD" "$DST_DASHBOARD" dashboard
sync_one "$SRC_BOT" "$DST_BOT" bot
say "all candidate environments match their production sources"
