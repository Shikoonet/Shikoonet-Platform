#!/usr/bin/env bash
# Put reviewed scripts on the box and run one of them there.
#
# ─────────────────────────────────────────────────────────────────────────────
# `over-ssh.sh` does this for a deploy, and only for a deploy: its body is about
# an image reference, a bot flag and an approval policy, none of which a
# production preparation or a cutover has. Adding two more modes to it would
# mean four code paths sharing one set of assumptions that three of them do not
# hold — so this is the sibling that carries only the transport.
#
# Same guarantees, deliberately copied rather than diverged:
#   · the scripts that run are THIS commit's, uploaded every time, so what
#     executes is what was reviewed on the commit being released
#   · the SSH key is a 0600 file in a directory the runner destroys with itself
#   · nothing secret reaches a command line, because argv is readable by every
#     process on both machines
#   · `StrictHostKeyChecking=yes`, never `accept-new`: the host key is a secret
#     precisely so a release cannot be pointed at somebody else's box by DNS
#
# The remote directory is per-run and removed afterwards. It is NOT
# `/opt/shikoo`, which belongs to the deploy path — mixing the two would let a
# half-finished preparation leave a script behind that a later deploy picks up.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: run-on-host.sh <script-to-run> [args...]
# Every file named in UPLOAD (default: all of deploy/) travels with it.

set -Eeuo pipefail

ENTRY=${1:-}
shift || true
if [ -z "$ENTRY" ]; then
  echo "usage: run-on-host.sh <script-to-run> [args...]" >&2
  exit 2
fi
[ -r "$ENTRY" ] || {
  echo "refusing: '$ENTRY' is not a readable file in this checkout" >&2
  exit 1
}

for required in DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS DEPLOY_HOST DEPLOY_USER; do
  [ -n "${!required:-}" ] || {
    echo "refusing: $required is empty" >&2
    exit 1
  }
done

PORT=${DEPLOY_PORT:-22}

KEYDIR=$(mktemp -d)
trap 'rm -rf "$KEYDIR"' EXIT
chmod 700 "$KEYDIR"
printf '%s\n' "$DEPLOY_SSH_KEY" >"$KEYDIR/id"
chmod 600 "$KEYDIR/id"
printf '%s\n' "$DEPLOY_KNOWN_HOSTS" >"$KEYDIR/known_hosts"

SSH_OPTS=(
  -i "$KEYDIR/id"
  -o IdentitiesOnly=yes
  -o UserKnownHostsFile="$KEYDIR/known_hosts"
  -o StrictHostKeyChecking=yes
  -o BatchMode=yes
  -o ConnectTimeout=15
)

# A name the remote side cannot collide with, and that says what left it there
# if anything ever does.
REMOTE_DIR="/tmp/shikoo-release-$(date -u +%Y%m%d%H%M%S)-$$"

echo "==> uploading $(basename "$ENTRY") and its siblings to ${REMOTE_DIR}"
ssh "${SSH_OPTS[@]}" -p "$PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
  "mkdir -p '$REMOTE_DIR' && chmod 700 '$REMOTE_DIR'"

# Everything, not just the entry point: these scripts call each other, and
# uploading only the one named here is how a release dies three steps in with
# «no such file» on a script that is sitting in the repository.
scp "${SSH_OPTS[@]}" -q -P "$PORT" deploy/*.sh \
  "$DEPLOY_USER@$DEPLOY_HOST:$REMOTE_DIR/"

cleanup_remote() {
  ssh "${SSH_OPTS[@]}" -p "$PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
    "rm -rf '$REMOTE_DIR'" >/dev/null 2>&1 || true
  rm -rf "$KEYDIR"
}
trap cleanup_remote EXIT

echo "==> running $(basename "$ENTRY") $*"
# `-T` because there is no terminal to allocate and asking for one puts prompt
# characters in the log. The token, when there is one, arrives on stdin.
if [ -n "${REGISTRY_TOKEN:-}" ]; then
  printf '%s' "$REGISTRY_TOKEN" |
    ssh -T "${SSH_OPTS[@]}" -p "$PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
      "cd '$REMOTE_DIR' && IMAGE_REF='${IMAGE_REF:-}' SHA='${SHA:-}' bash '$REMOTE_DIR/$(basename "$ENTRY")' $*"
else
  ssh -T "${SSH_OPTS[@]}" -p "$PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
    "cd '$REMOTE_DIR' && IMAGE_REF='${IMAGE_REF:-}' SHA='${SHA:-}' bash '$REMOTE_DIR/$(basename "$ENTRY")' $*" </dev/null
fi
