#!/usr/bin/env bash
#
# Whether a staging release manifest may be promoted to production.
#
# The artifact travels between two workflow runs, so everything about it is
# treated as input rather than as fact: the checksum is recomputed, the fields
# are re-validated, and the commit is checked against `main` here rather than
# trusted from the run that wrote it.
#
# Every refusal is a refusal. There is no "warn and continue" path, because the
# only thing downstream of this script is a production deploy.

set -Eeuo pipefail

DIR=${1:?usage: verify-release-manifest.sh <artifact-dir>}

fail() {
  echo "::error::$*"
  exit 1
}

[ -r "$DIR/manifest.env" ] || fail "no manifest.env in the staging artifact — this run did not come from Deploy Staging"
[ -r "$DIR/manifest.sha256" ] || fail "no manifest.sha256 — the manifest carries no checksum"

# The checksum first, before a single field is read. A manifest that was
# altered in transit must not get as far as being parsed.
( cd "$DIR" && sha256sum -c --status manifest.sha256 ) ||
  fail "manifest checksum does not verify — the artifact was altered after staging wrote it"

field() { sed -n "s/^$1=//p" "$DIR/manifest.env" | head -1; }

SCHEMA=$(field schema_version)
[ "$SCHEMA" = '1' ] || fail "unsupported manifest schema_version '${SCHEMA:-none}'"

REPO=$(field repository)
[ -n "${EXPECTED_REPO:-}" ] || fail "EXPECTED_REPO is not set"
[ "$REPO" = "$EXPECTED_REPO" ] ||
  fail "manifest is from repository '${REPO}', not '${EXPECTED_REPO}'"

DIGEST=$(field digest)
SHA=$(field main_sha)
IMAGE_REF=$(field image_ref)
POLICY=$(field approval_policy)

# Whole-string matches. `grep` would match line by line, so a field carrying a
# newline would pass on the strength of one of its lines.
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] ||
  fail "manifest digest is not an immutable sha256 reference"
[[ $SHA =~ ^[0-9a-f]{40}$ ]] ||
  fail "manifest main_sha is not a 40-character commit sha"
[[ $IMAGE_REF =~ ^[^@[:space:]]+@sha256:[0-9a-f]{64}$ ]] ||
  fail "manifest image_ref is not an immutable digest reference"
[ "${IMAGE_REF##*@}" = "$DIGEST" ] ||
  fail "manifest image_ref and digest disagree"

case "$POLICY" in
  team-approved | solo-owner) ;;
  *) fail "manifest approval_policy is '${POLICY:-none}' — staging did not record an approved policy" ;;
esac

# The commit must still be on `main`. A manifest for a commit that was reverted,
# or that only ever lived on a branch, is not a thing to put in front of
# customers however green its staging run was.
git rev-parse --verify "$SHA^{commit}" >/dev/null 2>&1 ||
  fail "commit ${SHA:0:12} is not in this repository"
git merge-base --is-ancestor "$SHA" origin/main 2>/dev/null ||
  git merge-base --is-ancestor "$SHA" main 2>/dev/null ||
  fail "commit ${SHA:0:12} is not reachable from main — it was reverted, or never merged"

# The two files the deploy path reads. Re-derived from the verified manifest
# rather than trusted from the artifact, so a tampered `digest` file cannot
# disagree with the manifest that was checked.
printf '%s\n' "$DIGEST" >"$DIR/digest"
printf '%s\n' "$SHA" >"$DIR/sha"

if [ -n "${GITHUB_OUTPUT:-}" ]; then
  {
    printf 'digest=%s\n' "$DIGEST"
    printf 'sha=%s\n' "$SHA"
    printf 'policy=%s\n' "$POLICY"
  } >>"$GITHUB_OUTPUT"
fi

echo "manifest verified: ${SHA:0:12} @ ${DIGEST:0:19}… policy=${POLICY}"
