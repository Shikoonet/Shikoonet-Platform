#!/usr/bin/env bash
#
# What staging actually ran, written down so a promotion cannot be handed
# anything else.
#
# ## Why a manifest and not just a digest file
#
# A promotion needs to answer more than «which bytes». It needs to know that
# those bytes were built from a commit on `main`, by a run that finished, under
# a named approval policy, and that staging then migrated and smoke-tested
# them. A bare digest answers none of that, so a later reader has to trust the
# person pasting it.
#
# ## Why it carries a checksum of itself
#
# The artifact travels between two workflow runs. The checksum is over the
# canonical field order below, so a manifest edited in transit — or assembled
# by something that is not this script — fails to verify rather than deploying.
# It is not a signature and does not pretend to be: it detects accident and
# mismatch, not a determined forger who can also rewrite the checksum.
#
# ## What is NOT in here
#
# No token, no DATABASE_URL, no bot token. The staging bot's IDENTITY may be
# recorded, never its credential.

set -Eeuo pipefail

OUT_DIR=${1:?usage: write-release-manifest.sh <out-dir>}
mkdir -p "$OUT_DIR"

: "${MAIN_SHA:?MAIN_SHA is required}"
: "${DIGEST:?DIGEST is required}"
# Required, not defaulted. It used to fall back to `GITHUB_RUN_ID`, which is
# this workflow's own id — so `ci_run_id` was always identical to
# `staging_run_id` and recorded nothing. A provenance field that silently
# describes the wrong run is worse than an absent one, because it reads like
# evidence.
: "${CI_RUN_ID:?CI_RUN_ID is required — the CI run that gated this deploy}"

# Every field is validated on the way IN. A manifest is only useful if the
# thing that wrote it refused to write nonsense.
[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] ||
  { echo "refusing: MAIN_SHA is not a 40-character commit sha" >&2; exit 1; }
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] ||
  { echo "refusing: DIGEST is not sha256: plus 64 lowercase hex" >&2; exit 1; }
[[ $CI_RUN_ID =~ ^[0-9]{1,20}$ ]] ||
  { echo "refusing: CI_RUN_ID is not a run id" >&2; exit 1; }
[ "$CI_RUN_ID" != "${GITHUB_RUN_ID:-}" ] ||
  { echo "refusing: CI_RUN_ID equals this run's own id — that is the fallback this field was built to stop" >&2; exit 1; }

IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}
IMAGE_REF="${IMAGE_NAME}@${DIGEST}"
POLICY=${POLICY:-unrecorded}
case "$POLICY" in team-approved | solo-owner) ;; *) POLICY=unrecorded ;; esac

# The two files the promotion path reads directly. Kept beside the manifest so
# a reader that only needs the digest does not have to parse JSON.
printf '%s\n' "$DIGEST" >"$OUT_DIR/digest"
printf '%s\n' "$MAIN_SHA" >"$OUT_DIR/sha"

# Canonical order. The checksum below is over exactly these lines, so the order
# is part of the contract rather than a formatting choice.
{
  printf 'schema_version=1\n'
  printf 'repository=%s\n' "${GITHUB_REPOSITORY:-unknown}"
  printf 'main_sha=%s\n' "$MAIN_SHA"
  printf 'image_ref=%s\n' "$IMAGE_REF"
  printf 'digest=%s\n' "$DIGEST"
  printf 'ci_run_id=%s\n' "$CI_RUN_ID"
  printf 'staging_run_id=%s\n' "${GITHUB_RUN_ID:-unknown}"
  printf 'workflow=%s\n' "${GITHUB_WORKFLOW:-unknown}"
  printf 'approval_policy=%s\n' "$POLICY"
  printf 'pr_number=%s\n' "${PR_NUMBER:-unknown}"
  printf 'staging_bot_id=%s\n' "${STAGING_BOT_ID:-not-deployed}"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT_DIR/manifest.env"

CHECKSUM=$(sha256sum "$OUT_DIR/manifest.env" | cut -d' ' -f1)

# JSON for humans and for anything that would rather parse it; the .env above
# is what the checksum covers, because a JSON serialiser can reorder keys and
# a checksum over reordered keys is a checksum over nothing.
{
  printf '{\n'
  while IFS='=' read -r k v; do
    printf '  "%s": "%s",\n' "$k" "$v"
  done <"$OUT_DIR/manifest.env"
  printf '  "manifest_sha256": "%s"\n}\n' "$CHECKSUM"
} >"$OUT_DIR/release-manifest.json"

printf '%s  manifest.env\n' "$CHECKSUM" >"$OUT_DIR/manifest.sha256"

echo "release manifest written: ${MAIN_SHA:0:12} @ ${DIGEST:0:19}… policy=${POLICY}"
