#!/usr/bin/env bash
# Release the hub to dev or production.
#
#   pnpm release:dev    — deploy the current dev/* branch to the dev workers
#   pnpm release:prod   — deploy merged main to production (admin-approved only)
#
# Nothing reaches production without a merged PR: `prod` refuses unless HEAD is
# on main and identical to origin/main, so the admin's merge IS the gate.
#
# Flags:  --plan       print what would happen, run the guards, change nothing
#         --skip-tests skip lint/typecheck/test (use only to retry a failed deploy)
#
# Rollback: see docs/release-process.md
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

MODE="${1:-}"
shift || true

PLAN=0
SKIP_TESTS=0
for arg in "$@"; do
  case "$arg" in
    --plan) PLAN=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    *) echo "Unknown flag: $arg" >&2; exit 2 ;;
  esac
done

case "$MODE" in
  dev|prod) ;;
  *) echo "Usage: release.sh <dev|prod> [--plan] [--skip-tests]" >&2; exit 2 ;;
esac

VERSION="$(node -p "require('./package.json').version")"
TS="$(date -u +%Y%m%dT%H%M%SZ)"

die() { echo "FAIL: $*" >&2; exit 1; }
step() { echo ""; echo "==> $*"; }
run() { if [[ $PLAN -eq 1 ]]; then echo "     [plan] $*"; else "$@"; fi; }

# ---------------------------------------------------------------------------
# Guards
# ---------------------------------------------------------------------------

step "Guards ($MODE, v$VERSION)"

[[ -n "$(git status --porcelain)" ]] && die "working tree is dirty — commit or stash first"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
git fetch --quiet origin

if [[ "$MODE" == "dev" ]]; then
  [[ "$VERSION" == *-dev.* ]] || die "version '$VERSION' has no -dev.N suffix; bump it with: npm version <x.y.z>-dev.1 --no-git-tag-version"
  [[ "$BRANCH" == dev/* ]] || die "not on a dev/* branch (on '$BRANCH')"

  # Someone else may have pushed while we were working. Refuse to ship a dev
  # build from a stale base — it would deploy code that was never reconciled.
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  [[ "$BEHIND" -eq 0 ]] || die "$BEHIND commit(s) behind origin/main — rebase first: git rebase origin/main"

  TARGET_DESC="DEV (dashboard-worker-dev + ingest-worker-dev, payment-hub-dev)"
else
  [[ "$VERSION" == *-dev.* ]] && die "version '$VERSION' is a dev version; bump to a release version first"
  [[ "$BRANCH" == "main" ]] || die "production releases run from main (on '$BRANCH')"

  # The admin merging the PR is the approval. If HEAD is not exactly origin/main,
  # either the PR is unmerged or there are local commits nobody approved.
  [[ "$(git rev-parse HEAD)" == "$(git rev-parse origin/main)" ]] \
    || die "HEAD != origin/main — the admin has not merged the PR (or you have unpushed commits)"

  TARGET_DESC="PRODUCTION (dashboard-worker + ingest-worker, payment-hub-staging)"
fi

echo "     branch:  $BRANCH @ $(git rev-parse --short HEAD)"
echo "     version: v$VERSION"
echo "     target:  $TARGET_DESC"

if [[ "$MODE" == "prod" && $PLAN -eq 0 ]]; then
  echo ""
  echo "  payment-hub-staging IS THE PRODUCTION DATABASE."
  if [[ "${DEPLOY_CONFIRM:-}" != "yes" ]]; then
    read -r -p "Deploy v$VERSION to PRODUCTION? [yes/N] " CONFIRM
    [[ "$(echo "$CONFIRM" | tr '[:upper:]' '[:lower:]')" == "yes" ]] || die "aborted"
  fi
fi

# ---------------------------------------------------------------------------
# Build the SPA — dist/ is gitignored and the dashboard worker mounts it via
# [assets], so without this the deploy ships a stale or missing bundle. It runs
# before the tests because @cloudflare/vitest-pool-workers reads the same
# wrangler.toml and refuses to start when assets.directory does not exist.
# ---------------------------------------------------------------------------

step "Building the dashboard SPA"
run pnpm --filter @hub/dashboard-web build

# ---------------------------------------------------------------------------
# Quality gates
# ---------------------------------------------------------------------------

if [[ $SKIP_TESTS -eq 1 ]]; then
  step "Quality gates SKIPPED (--skip-tests)"
else
  step "Quality gates"
  run pnpm lint
  run pnpm typecheck
  if [[ $PLAN -eq 1 ]]; then
    echo "     [plan] pnpm test"
  elif ! pnpm test; then
    # The Worker suites run under @cloudflare/vitest-pool-workers, whose
    # isolated-storage cleanup asserts on a lowercase .sqlite path and breaks on
    # Windows' case-insensitive filesystem. Nothing is wrong with the code, but
    # do not paper over it — say so and let the operator decide.
    if [[ "$(uname -s)" == MINGW* || "$(uname -s)" == MSYS* || "$(uname -s)" == CYGWIN* ]]; then
      echo ""
      echo "  Tests failed on Windows. If the failures are all of the form"
      echo "    'Isolated storage failed' / 'Expected .sqlite, got ...SQLITE-SHM.tmp'"
      echo "  they are a known @cloudflare/vitest-pool-workers incompatibility with"
      echo "  the Windows filesystem, not a defect in this change. The ingest-worker"
      echo "  and dashboard-worker suites only pass on Linux/macOS."
      echo ""
      echo "  Run the release from WSL or a Linux box, or — if you have verified the"
      echo "  failures are only those — re-run with --skip-tests."
    fi
    die "quality gates failed"
  fi
fi

# ---------------------------------------------------------------------------
# Production only: back up D1 before touching schema
# ---------------------------------------------------------------------------

if [[ "$MODE" == "prod" ]]; then
  step "Backing up production D1"
  BACKUP=".deploy-backups/payment-hub-staging-${TS}-pre-v${VERSION}.sql"
  run mkdir -p .deploy-backups
  if [[ $PLAN -eq 1 ]]; then
    echo "     [plan] wrangler d1 export DB --remote --output ../../$BACKUP  (from apps/dashboard-worker)"
  else
    ( cd apps/dashboard-worker && pnpm exec wrangler d1 export DB --remote --output "../../$BACKUP" )
    sha256sum "$BACKUP" > "$BACKUP.sha256"
    echo "     $BACKUP"
  fi
fi

# ---------------------------------------------------------------------------
# Migrations — wrangler deploy does NOT run these. Skipping this step is what
# caused the 2026-08-05 production 500s (docs/verification/final-report.md).
# ---------------------------------------------------------------------------

step "Applying migrations"
if [[ "$MODE" == "dev" ]]; then
  run pnpm --filter @hub/dashboard-worker db:migrate:dev
  run pnpm --filter @hub/ingest-worker db:migrate:dev
else
  run pnpm --filter @hub/dashboard-worker db:migrate:prod
  run pnpm --filter @hub/ingest-worker db:migrate:prod
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

step "Deploying workers"
if [[ "$MODE" == "dev" ]]; then
  run pnpm --filter @hub/ingest-worker exec wrangler deploy -c wrangler.dev.toml \
    --var "APP_VERSION:$VERSION" --message "v$VERSION"
  run pnpm --filter @hub/dashboard-worker exec wrangler deploy -c wrangler.dev.toml \
    --var "APP_VERSION:$VERSION" --message "v$VERSION"
else
  run pnpm --filter @hub/ingest-worker exec wrangler deploy \
    --var "APP_VERSION:$VERSION" --message "v$VERSION"
  run pnpm --filter @hub/dashboard-worker exec wrangler deploy \
    --var "APP_VERSION:$VERSION" --message "v$VERSION"
fi

# ---------------------------------------------------------------------------
# Smoke test — the ingest /version route is public, so curl can reach it.
# The dashboard's is behind Access; check its badge in the browser instead.
# ---------------------------------------------------------------------------

step "Smoke test"
if [[ "$MODE" == "dev" ]]; then
  INGEST_HOST="https://ingest-worker-dev.samsos.workers.dev"
  DASH_HOST="https://dashboard-worker-dev.samsos.workers.dev"
else
  INGEST_HOST="https://ingest-worker.samsos.workers.dev"
  DASH_HOST="https://dashboard-worker.samsos.workers.dev"
fi

if [[ $PLAN -eq 1 ]]; then
  echo "     [plan] curl $INGEST_HOST/version"
else
  SEEN="$(curl -fsS "$INGEST_HOST/version")"
  echo "     $SEEN"
  case "$SEEN" in
    *"\"version\":\"$VERSION\""*) ;;
    *) die "ingest worker is not serving v$VERSION — deploy did not take" ;;
  esac
fi

# ---------------------------------------------------------------------------
# Record and tag
# ---------------------------------------------------------------------------

if [[ "$MODE" == "prod" && $PLAN -eq 0 ]]; then
  step "Writing release record"
  REC=".deploy-backups/release-v${VERSION}.md"
  {
    echo "# Release v$VERSION"
    echo ""
    echo "- Deployed at: $TS (UTC)"
    echo "- Commit: $(git rev-parse HEAD)"
    echo "- D1 backup: \`$BACKUP\` (sha256 in \`$BACKUP.sha256\`)"
    echo "- Migrations dir: \`migrations/\` (applied with \`db:migrate:prod\`)"
    echo ""
    echo "## Deployed versions"
    echo '```'
    ( cd apps/dashboard-worker && pnpm exec wrangler deployments list 2>/dev/null | head -20 ) || true
    echo '```'
  } > "$REC"
  echo "     $REC"
fi

step "Tagging"
run git tag -a "v$VERSION" -m "v$VERSION"
if [[ "$MODE" == "prod" ]]; then
  run git push origin "v$VERSION"
else
  echo "     dev tag kept local — push it only if the admin needs to see it"
fi

echo ""
echo "Done: v$VERSION on $MODE"
echo "  dashboard: $DASH_HOST"
echo "  ingest:    $INGEST_HOST"
