#!/usr/bin/env bash
#
# The GitHub half of a deploy: put THIS commit's `deploy.sh` on the box and run
# it there. Everything a deploy actually decides — migrations first, the bot
# last, the smoke test, the rollback — is in that script and stays on the host.
#
# It is a file rather than a `run:` block so the repository's own shellcheck
# sweep covers it: `ci.yml` scans `deploy` and `tools`, and a heredoc inside
# YAML is checked by actionlint with none of the same flags.
#
# ## Why deploy.sh is copied up every time
#
# The version that runs is then always the version that was reviewed on the
# commit being deployed. A copy that lives only on the server drifts from the
# repository silently, which is exactly how this file came to be missing while
# `/opt/shikoo/deploy.sh` sat there being nobody's.
#
# ## What is NOT here
#
# No secret reaches a command line. The registry token goes to the remote script
# on stdin, and the SSH key is written to a file the runner destroys with itself
# — `argv` is readable by every process on both machines, and a GitHub log is
# only redacted for values GitHub knows are secret.

set -Eeuo pipefail

ENV_ARG=${1:-}
case "$ENV_ARG" in
  staging | production) ;;
  *)
    echo "usage: over-ssh.sh <staging|production>" >&2
    exit 2
    ;;
esac

# An immutable digest or nothing. `deploy.sh` refuses a mutable tag too, but
# refusing it HERE means a bad promotion input never reaches the box, never
# opens an SSH session and never takes the deploy flock.
case "${IMAGE_REF:-}" in
  *@sha256:*) ;;
  *)
    echo "refusing: IMAGE_REF is not an immutable digest: '${IMAGE_REF:-}'" >&2
    exit 1
    ;;
esac

for required in DEPLOY_SSH_KEY DEPLOY_KNOWN_HOSTS DEPLOY_HOST DEPLOY_USER REGISTRY_TOKEN IMAGE_REF; do
  [ -n "${!required:-}" ] || {
    echo "refusing: $required is empty — check the $ENV_ARG environment's secrets" >&2
    exit 1
  }
done

# `GITHUB_SHA` is the workflow's own commit on a `workflow_run` re-run, so the
# deploy takes the sha explicitly from the environment the workflow set.
SHA=${SHA:-}
echo "$SHA" | grep -qE '^[0-9a-f]{40}$' || {
  echo "refusing: SHA is not a full 40-character commit sha: '$SHA'" >&2
  exit 1
}

PORT=${DEPLOY_PORT:-22}

# Normalised to exactly `true` or exactly `false` before it crosses the wire, so
# the remote script is never handed `TRUE`, `1` or `yes` to interpret. Both ends
# fail closed on their own; this is the second of the two.
if [ "${DEPLOY_BOT_ENABLED:-}" = 'true' ]; then
  BOT_FLAG=true
else
  BOT_FLAG=false
fi
echo "==> $ENV_ARG: bot enabled = $BOT_FLAG"

# Which policy allowed this deploy, carried through to the ledger on the box.
# Defaulted to a value that is obviously not a policy, so a deploy run outside
# the workflow is recorded as what it is rather than inheriting a claim.
POLICY=${DEPLOY_APPROVAL_POLICY:-unrecorded}
case "$POLICY" in
  team-approved | solo-owner | promoted-by-hand | unrecorded) ;;
  *) POLICY=unrecorded ;;
esac
echo "==> $ENV_ARG: approval policy = $POLICY"

# 0700 dir, 0600 key. `ssh` refuses a key any wider than that, which is a
# check worth keeping rather than working around with `-o StrictModes=no`.
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
  # Not `accept-new`, and never `no`: the host key is a secret precisely so that
  # a deploy cannot be pointed at somebody else's box by DNS alone.
  -o StrictHostKeyChecking=yes
  -o BatchMode=yes
  -o ConnectTimeout=15
)

echo "==> $ENV_ARG: uploading deploy.sh from $SHA"
scp "${SSH_OPTS[@]}" -P "$PORT" deploy/deploy.sh \
  "$DEPLOY_USER@$DEPLOY_HOST:/opt/shikoo/deploy.sh"

echo "==> $ENV_ARG: deploying $IMAGE_REF"
# Positional 4 is the dry-run slot and is deliberately empty: the script reads
# `--registry-token-stdin` from position 5 and nowhere else.
#
# The token arrives on stdin. `ssh -T` because there is no terminal to allocate
# and asking for one puts the remote script's prompt characters in the log.
printf '%s' "$REGISTRY_TOKEN" |
  ssh -T "${SSH_OPTS[@]}" -p "$PORT" "$DEPLOY_USER@$DEPLOY_HOST" \
    "DEPLOY_BOT_ENABLED='$BOT_FLAG' DEPLOY_APPROVAL_POLICY='$POLICY' bash /opt/shikoo/deploy.sh $ENV_ARG '$IMAGE_REF' '$SHA' '' --registry-token-stdin"
