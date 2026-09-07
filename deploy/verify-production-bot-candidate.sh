#!/usr/bin/env bash
# Prove the bot Cutover is about to start — and then prove what it started.
#
# Coolify's /applications/{uuid}/start endpoint queues a deployment. It does
# not merely restart an already-created container, so the application record's
# image tag is part of the release contract. Preparation pins that stopped
# record; Cutover runs this file once before moving anything and once after the
# replacement has acquired its singleton lock.
#
# Run: verify-production-bot-candidate.sh <prepared|running> <uuid> <sha> <digest>

set -Eeuo pipefail

MODE=${1:-}
APP_UUID=${2:-}
EXPECTED_SHA=${3:-}
EXPECTED_DIGEST=${4:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CONF=${CONF:-/etc/shikoo/production/deploy.env}
IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}

die() {
  echo "[cutover-bot] REFUSED: $*" >&2
  exit 1
}

case "$MODE" in prepared | running) ;; *) die "mode must be prepared or running" ;; esac
[[ $APP_UUID =~ ^[a-z0-9]{20,32}$ ]] || die "candidate uuid is malformed"
[[ $EXPECTED_SHA =~ ^[0-9a-f]{40}$ ]] || die "prepared sha is malformed"
[[ $EXPECTED_DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "prepared digest is malformed"
EXPECTED_TAG="sha256-${EXPECTED_DIGEST#sha256:}"

# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client"
trap coolify_api_cleanup EXIT

coolify_api GET "/applications/$APP_UUID" ||
  die "could not read the candidate bot application"
[ "$API_STATUS" = '200' ] ||
  die "candidate bot application read was refused (HTTP ${API_STATUS})"
if ! printf '%s' "$API_BODY" | python3 -c '
import json, sys
try:
    app = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
ok = (
    isinstance(app, dict)
    and app.get("build_pack") == "dockerimage"
    and app.get("docker_registry_image_name") == sys.argv[1]
    and app.get("docker_registry_image_tag") == sys.argv[2]
)
raise SystemExit(0 if ok else 1)
' "$IMAGE_NAME" "$EXPECTED_TAG"; then
  die "candidate bot is not a Docker Image application pinned to the prepared digest"
fi

coolify_api GET "/applications/$APP_UUID/envs" ||
  die "could not read the candidate bot environment"
[ "$API_STATUS" = '200' ] ||
  die "candidate bot environment read was refused (HTTP ${API_STATUS})"
if ! printf '%s' "$API_BODY" | python3 -c '
import json, sys
from collections import Counter
try:
    rows = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if not isinstance(rows, list) or not all(isinstance(row, dict) for row in rows):
    raise SystemExit(1)
keys = [row.get("key") for row in rows]
if any(not isinstance(key, str) for key in keys):
    raise SystemExit(1)
if any(count != 1 for count in Counter(keys).values()):
    raise SystemExit(1)
values = {row["key"]: row.get("value") for row in rows}
ok = (
    values.get("ENV_NAME") == "production"
    and values.get("SERVICE") == "bot"
    and values.get("APP_VERSION") == sys.argv[1]
    and isinstance(values.get("DATABASE_URL"), str)
    and bool(values["DATABASE_URL"].strip())
)
raise SystemExit(0 if ok else 1)
' "$EXPECTED_SHA"; then
  die "candidate bot environment is missing, duplicated, or not bound to this production release"
fi

CONTAINERS=$(docker ps -q --filter "label=coolify.name=$APP_UUID" 2>/dev/null || true)
COUNT=$(printf '%s\n' "$CONTAINERS" | sed '/^$/d' | wc -l)
if [ "$MODE" = prepared ]; then
  [ "$COUNT" = 0 ] ||
    die "candidate bot already has a running container before the old poller is stopped"
  echo "[cutover-bot] prepared: exact digest and sha, production bot environment, no running container"
  exit 0
fi

[ "$COUNT" = 1 ] ||
  die "candidate bot has ${COUNT} running containers after start, expected exactly one"
CID=$(printf '%s\n' "$CONTAINERS" | head -1)
IMAGE_ID=$(docker inspect --format '{{.Image}}' "$CID" 2>/dev/null) ||
  die "could not identify the running candidate bot image"
REPO_DIGESTS=$(docker inspect --format '{{range .RepoDigests}}{{println .}}{{end}}' "$IMAGE_ID" 2>/dev/null || true)
case "$REPO_DIGESTS" in
  *"$EXPECTED_DIGEST"*) ;;
  *) die "running candidate bot does not carry the prepared digest" ;;
esac

# Inspect only the three public identity fields, and print none of the rest.
# `docker inspect` necessarily returns the whole environment, including
# credentials; it goes straight to the parser on stdin and never to output.
if ! docker inspect --format '{{json .Config.Env}}' "$CID" 2>/dev/null | python3 -c '
import json, sys
from collections import Counter
try:
    entries = json.load(sys.stdin)
except Exception:
    raise SystemExit(1)
if not isinstance(entries, list) or not all(isinstance(item, str) for item in entries):
    raise SystemExit(1)
pairs = [item.split("=", 1) for item in entries if "=" in item]
keys = [pair[0] for pair in pairs if pair[0] in {"ENV_NAME", "SERVICE", "APP_VERSION"}]
if Counter(keys) != Counter({"ENV_NAME": 1, "SERVICE": 1, "APP_VERSION": 1}):
    raise SystemExit(1)
values = dict(pairs)
ok = values.get("ENV_NAME") == "production" and values.get("SERVICE") == "bot" and values.get("APP_VERSION") == sys.argv[1]
raise SystemExit(0 if ok else 1)
' "$EXPECTED_SHA"; then
  die "running candidate bot does not identify as the prepared production bot"
fi

echo "[cutover-bot] running: exact digest and sha, production bot identity verified"
