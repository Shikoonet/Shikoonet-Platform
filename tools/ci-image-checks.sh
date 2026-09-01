#!/usr/bin/env bash
#
# The three checks that measure the ARTIFACT rather than the source.
#
# One copy, two callers, because they run at two different times for two
# different reasons:
#
#   `migrations` (pull request, merge_group)
#       The job already has a Postgres and a docker, and 40s of image checks
#       inside a 104-second job costs nothing — both 104s and 64s round up to
#       the same two billed minutes. Splitting them out «to be tidy» was
#       measured and cost two billed minutes per pull request for no saving,
#       which is how they ended up back here.
#
#   `image` (push to main)
#       On a proven main run no test is re-run, because the tree is provably
#       one the suite already passed. The image is rebuilt anyway, and that is
#       not redundant: a docker build is the one thing in this repository that
#       is not hermetic. `FROM` resolves against a registry and `apt` against a
#       mirror, so the same tree can produce a different image tomorrow than it
#       did yesterday. This is what catches that, on the commit Deploy Staging
#       is about to build for real.
#
# Needs: a docker, and a DATABASE_URL pointing at a Postgres it may create a
# database on. Nothing else — no `pnpm install`, no node_modules, no
# migrations. The third check wants an EMPTY database and makes its own.
#
# Run: DATABASE_URL=… ci-image-checks.sh

set -Eeuo pipefail

: "${DATABASE_URL:?DATABASE_URL must be set}"
TAG=${TAG:-shikoo-ci}

# ─────────────────────────────────────────────────────────────── the build
#
# No registry login, no push, no layer cache. This image never leaves the
# runner: Deploy Staging builds its own, from the same Dockerfile, with
# `no-cache: true` and a revision label it reads back off the pulled image.
# Nothing here can write a layer that a deployment would later pull.
echo "::group::docker build"
docker build -t "$TAG" .
echo '::endgroup::'

# ────────────────────────────────────────── 1. the image reaches its entrypoint
#
# On 2026-08-16 every check was green, the image built and pushed, and not one
# container could start: `deploy/entrypoint.sh` was committed 100644 and `COPY`
# carries the source mode, so `runc` refused the entrypoint with «permission
# denied». Nothing that reads TypeScript can see that, and the first thing that
# did was a production deploy.
echo '--- the image reaches its entrypoint'
out=$(docker run --rm "$TAG" 2>&1 || true)
echo "$out"
echo "$out" | grep -q 'SERVICE is required'

# ──────────────────────── 2. what is in the artifact, not what the manifests say
#
# `runtime` was `FROM build` until 2026-08-22, so the image three public-facing
# services run from carried vitest, playwright, eslint and typescript — 29 of
# its 290 packages — along with every test file in the repository. Nothing ran
# them, which is why it went unnoticed for months: `pnpm audit --prod` reads
# manifests and reported zero the whole time, while a scanner reads layers.
echo '--- the production image carries no test runner and no tests'
dev=$(docker run --rm --entrypoint sh "$TAG" -c \
  'ls node_modules/.pnpm | grep -ciE "^(vitest|@vitest|playwright|@playwright|eslint|typescript|@typescript-eslint)@" || true')
ours=$(docker run --rm --entrypoint sh "$TAG" -c \
  'find /app/apps /app/packages \( -name "*.test.ts" -o -name "*.spec.ts" \) | wc -l')
echo "dev-tooling packages: $dev   our test files: $ours"
[ "$dev" = '0' ] && [ "$ours" = '0' ]

# ──────────────── 3. the schema gate, measured on the artifact not on the source
#
# Its own database, created empty here, so the container is pointed at a schema
# that is behind by every migration there is and must refuse to start.
echo '--- a container refuses to start on a schema it does not match'
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -q -c 'CREATE DATABASE behind_by_everything'
behind="${DATABASE_URL%/*}/behind_by_everything"
out=$(docker run --rm --network host -e SERVICE=bot -e DATABASE_URL="$behind" "$TAG" 2>&1 || true)
echo "$out"
echo "$out" | grep -q 'refusing to start'

echo 'image checks: all three passed'
