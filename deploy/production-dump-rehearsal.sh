#!/usr/bin/env bash
# The rehearsal Prepare Production refuses to run without.
#
# ─────────────────────────────────────────────────────────────────────────────
# Prepare Production stopped at P0 with "no attestation.env". That was correct:
# the gate works. What was missing was the thing that produces the evidence —
# `write-dump-attestation.sh` and `verify-dump-attestation.sh` both existed, and
# nothing in between ever ran the rehearsal they describe.
#
# This is that missing middle. It takes no arguments at all.
#
# ── Why no arguments ──────────────────────────────────────────────────────
#
# Every value this needs is either read from a root-owned configuration file or
# resolved from GitHub. Nothing arrives through argv: not the dump path, not a
# DATABASE_URL, not a token, and above all not `main_sha`, `digest`,
# `ci_run_id` or `staging_run_id`. An attestation whose subject is chosen by the
# caller attests to whatever the caller wanted, which is the opposite of the
# job. It resolves what the release actually is and then measures that.
#
# ── Where it runs, and what it is allowed to touch ───────────────────────
#
# Throwaway containers and throwaway databases, every one of them removed on
# exit, on failure and on signal. It never opens a writable connection to the
# live production database — the only production thing it reads is the newest
# backup, and it restores that into a container of its own.
#
# ── What it will not do ──────────────────────────────────────────────────
#
# It will not substitute a fixture for the real dump. `synthetic-migration.test.ts`
# exists for the tooling; the 49 dump-gated assertions are about the actual
# Mirzabot dataset — the real discount codes, the 963 customers who never
# accepted the rules — and a fixture that made them pass would make them
# meaningless. A missing dump stops the run and names the one thing to fix.
#
# It writes no attestation unless EVERY measurement passes. Partial success is
# not evidence.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: production-dump-rehearsal.sh          (no arguments, ever)

set -Eeuo pipefail

[ "$#" -eq 0 ] || {
  echo "production-dump-rehearsal takes no arguments" >&2
  exit 2
}

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
CONF=${REHEARSAL_CONF:-/etc/shikoo/production/rehearsal.env}
STATE=${STATE:-/var/lib/shikoo/production}
ATTEST_DIR="$STATE/attestation"
REPO=Shikoonet/Shikoonet-Platform

say() { echo "[rehearsal] $*"; }
die() {
  echo "[rehearsal] STOP: $*" >&2
  exit 1
}

# ── everything this creates, removed however this ends ───────────────────
#
# Registered as it is created, not at the end, so a failure halfway still
# tears down what already exists. A rehearsal that leaves a container holding
# a copy of the production dataset is worse than one that did not run.
CLEANUP_CONTAINERS=''
CLEANUP_DIRS=''
cleanup() {
  local c d
  for c in $CLEANUP_CONTAINERS; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  for d in $CLEANUP_DIRS; do
    [ -z "$d" ] || rm -rf "$d"
  done
}
trap cleanup EXIT INT TERM

[ -r "$CONF" ] || die "cannot read ${CONF} — this rehearsal is configured by a root-owned file, not by arguments"

# Read as text, never sourced: a token is `<id>|<random>` and a shell would
# execute the pipe.
cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
DUMP_PATH=$(cfg MIRZABOT_DUMP)
REPO_DIR=$(cfg REPO_DIR)
GH_TOKEN_VALUE=$(cfg GITHUB_TOKEN)
PG_IMAGE=$(cfg PG_IMAGE); PG_IMAGE=${PG_IMAGE:-postgres:16-alpine}
MYSQL_IMAGE=$(cfg MYSQL_IMAGE); MYSQL_IMAGE=${MYSQL_IMAGE:-mysql:8}
PROD_BACKUP_DIR=$(cfg PROD_BACKUP_DIR)

# ── 1. the dump, or one exact owner action ───────────────────────────────
say "1. locating the production dump"
if [ -z "$DUMP_PATH" ] || [ ! -r "$DUMP_PATH" ]; then
  echo "[rehearsal] STOP: the Mirzabot production dump is not available." >&2
  echo "[rehearsal] Owner action, exactly one:" >&2
  echo "[rehearsal]   place the dump on this host and set MIRZABOT_DUMP=<path> in ${CONF}" >&2
  echo "[rehearsal] No fixture is substituted: the 49 dump-gated assertions are about" >&2
  echo "[rehearsal] the real dataset, and a fixture that made them pass would make them" >&2
  echo "[rehearsal] mean nothing." >&2
  exit 1
fi
# The path itself is never printed — only its digest and date, which is all the
# attestation may carry.
DUMP_SHA=$(sha256sum "$DUMP_PATH" | cut -d' ' -f1)
DUMP_DATE=$(date -u -r "$DUMP_PATH" +%Y-%m-%d)
DUMP_ID="sha256:${DUMP_SHA} ${DUMP_DATE}"
say "   dump identified (sha256 recorded, path not logged)"

if [ -z "$REPO_DIR" ] || [ ! -d "$REPO_DIR/.git" ]; then
  die "REPO_DIR in ${CONF} is not a git checkout"
fi
[ -n "$GH_TOKEN_VALUE" ] || die "${CONF} has no GITHUB_TOKEN — release provenance cannot be cross-checked without it"

# ── 2. what release is this, resolved rather than asserted ───────────────
say "2. resolving the release from GitHub"
gh_api() { # path -> body on stdout
  GH_TOKEN="$GH_TOKEN_VALUE" gh api -H 'Accept: application/vnd.github+json' "$1" 2>/dev/null
}

MAIN_SHA=$(gh_api "repos/${REPO}/commits/main" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha") or "")') ||
  die "could not read the head of main"
[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] || die "main head is not a commit sha"
say "   main_sha=${MAIN_SHA}"

# The same picker Prepare Production uses, so the run this attests to is the
# run that would be promoted — not a different one that happens to be green.
STAGING_RUN_ID=$(cd "$REPO_DIR" && GH_TOKEN="$GH_TOKEN_VALUE" bash deploy/pick-staging-run.sh "$REPO" 2>/dev/null |
  sed -n 's/^run_id=//p' | head -1)
if [ -z "$STAGING_RUN_ID" ]; then
  STAGING_RUN_ID=$(gh_api "repos/${REPO}/actions/workflows/deploy-staging.yml/runs?per_page=50&status=success" |
    python3 -c 'import json,sys
d=json.load(sys.stdin).get("workflow_runs") or []
m=[r for r in d if r.get("head_sha")==sys.argv[1]]
print(sorted(m,key=lambda r:r.get("run_started_at") or "")[-1]["id"] if m else "")' "$MAIN_SHA")
fi
[ -n "$STAGING_RUN_ID" ] || die "no successful Deploy Staging run for ${MAIN_SHA:0:12} — staging has not accepted this release"
say "   staging_run_id=${STAGING_RUN_ID}"

CI_RUN_ID=$(gh_api "repos/${REPO}/actions/workflows/ci.yml/runs?per_page=100&head_sha=${MAIN_SHA}" |
  python3 -c 'import json,sys
d=json.load(sys.stdin).get("workflow_runs") or []
m=[r for r in d if r.get("event")=="push" and r.get("status")=="completed"
   and r.get("conclusion")=="success" and r.get("head_branch")=="main"]
print(sorted(m,key=lambda r:r.get("run_started_at") or "")[-1]["id"] if m else "")')
[ -n "$CI_RUN_ID" ] || die "no completed successful CI push run on main for ${MAIN_SHA:0:12}"
say "   ci_run_id=${CI_RUN_ID}"

# The digest comes from the manifest staging wrote, verified rather than read.
ART=$(mktemp -d); CLEANUP_DIRS="$CLEANUP_DIRS $ART"
( cd "$ART" && GH_TOKEN="$GH_TOKEN_VALUE" gh run download "$STAGING_RUN_ID" --repo "$REPO" -n staging-digest -D . >/dev/null 2>&1 ) ||
  die "could not download the staging-digest artifact from run ${STAGING_RUN_ID}"
EXPECTED_REPO="$REPO" EXPECTED_RUN_ID="$STAGING_RUN_ID" EXPECTED_RUN_HEAD_SHA="$MAIN_SHA" \
  bash "$HERE/verify-release-manifest.sh" "$ART" >/dev/null ||
  die "the staging release manifest does not verify for ${MAIN_SHA:0:12}"
DIGEST=$(sed -n 's/^digest=//p' "$ART/manifest.env" | head -1)
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "the manifest carries no immutable digest"
MANIFEST_CI=$(sed -n 's/^ci_run_id=//p' "$ART/manifest.env" | head -1)
[ "$MANIFEST_CI" = "$CI_RUN_ID" ] ||
  die "the manifest names CI run ${MANIFEST_CI}, GitHub names ${CI_RUN_ID} for this commit"
say "   digest=${DIGEST}"

# ── 3. throwaway MySQL holding the dump ──────────────────────────────────
say "3. loading the dump into a throwaway MySQL"
SUFFIX=$$-$(date -u +%s)
MYSQL_C="shikoo-rehearsal-mysql-${SUFFIX}"
PG_C="shikoo-rehearsal-pg-${SUFFIX}"
RESTORE_C="shikoo-rehearsal-restore-${SUFFIX}"

docker run -d --name "$MYSQL_C" \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=1 -e MYSQL_DATABASE=mirzabot \
  "$MYSQL_IMAGE" >/dev/null || die "could not start the throwaway MySQL"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $MYSQL_C"
for _ in $(seq 1 60); do
  docker exec "$MYSQL_C" mysqladmin ping --silent >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$MYSQL_C" mysqladmin ping --silent >/dev/null 2>&1 || die "the throwaway MySQL never became ready"
docker exec -i "$MYSQL_C" mysql mirzabot <"$DUMP_PATH" || die "the dump would not load"
say "   dump loaded"

# ── 4. throwaway Postgres, migrated ──────────────────────────────────────
say "4. migrating a throwaway Postgres"
docker run -d --name "$PG_C" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=shikoo \
  "$PG_IMAGE" >/dev/null || die "could not start the throwaway Postgres"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $PG_C"
for _ in $(seq 1 60); do
  docker exec "$PG_C" pg_isready -q >/dev/null 2>&1 && break
  sleep 2
done
docker exec "$PG_C" pg_isready -q >/dev/null 2>&1 || die "the throwaway Postgres never became ready"

MIG_LIST=$(find "$REPO_DIR/migrations" -maxdepth 1 -name '0*.sql' -type f | sort)
MIG_BEFORE=$(printf '%s\n' "$MIG_LIST" | grep -c .)
for f in $MIG_LIST; do
  docker exec -i "$PG_C" psql -U postgres -d shikoo -v ON_ERROR_STOP=1 -q <"$f" ||
    die "migration $(basename "$f") failed against the dump-derived schema"
done
MIG_FIRST=$(basename "$(printf '%s\n' "$MIG_LIST" | head -1)" | cut -c1-4)
MIG_LAST=$(basename "$(printf '%s\n' "$MIG_LIST" | tail -1)" | cut -c1-4)
MIGRATION_RANGE="${MIG_FIRST}..${MIG_LAST}"
say "   applied ${MIG_BEFORE} migration(s), range ${MIGRATION_RANGE}"

# ── 5. the 49, all of them, none skipped ─────────────────────────────────
say "5. the production-dump suites"
MYSQL_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$MYSQL_C")
PG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$PG_C")
REPORT="$ART/migrate-report.json"
set +e
( cd "$REPO_DIR" && \
  MIGRATE_PRODUCTION_DUMP=1 \
  MIGRATE_MYSQL_URL="mysql://root@${MYSQL_IP}:3306/mirzabot" \
  DATABASE_URL="postgres://postgres:rehearsal@${PG_IP}:5432/shikoo" \
  pnpm --filter @shikoo/migrate exec vitest run --reporter=json --outputFile.json="$REPORT" ) >/dev/null 2>&1
set -e
[ -s "$REPORT" ] || die "the migrate suite produced no report"

read -r DUMP_PASSED DUMP_SKIPPED <<EOF
$(python3 -c '
import json,sys
d=json.load(open(sys.argv[1]))
passed=skipped=0
for f in d.get("testResults") or []:
    for a in f.get("assertionResults") or []:
        if "mysql" not in (f.get("name") or ""): continue
        s=a.get("status")
        if s=="passed": passed+=1
        elif s in ("skipped","pending","todo"): skipped+=1
print(passed, skipped)' "$REPORT")
EOF
say "   dump-gated: ${DUMP_PASSED} passed, ${DUMP_SKIPPED} skipped"
[ "$DUMP_SKIPPED" = '0' ] ||
  die "${DUMP_SKIPPED} dump-gated test(s) were skipped — the dump was not actually exercised"
[ "$DUMP_PASSED" = '49' ] ||
  die "${DUMP_PASSED}/49 dump-gated tests passed — every one of them has to"
DUMP_SUITES="49/49"

# ── 6. the invariants ────────────────────────────────────────────────────
say "6. schema invariants"
INV_LOG="$ART/invariants.log"
docker exec -i "$PG_C" psql -U postgres -d shikoo -v ON_ERROR_STOP=1 \
  <"$REPO_DIR/migrations/verify_invariants.sql" >"$INV_LOG" 2>&1 ||
  die "verify_invariants.sql did not complete"
INV_PASS=$(grep -c 'PASS ' "$INV_LOG" || true)
say "   invariants: ${INV_PASS}/32"
[ "$INV_PASS" = '32' ] || die "${INV_PASS}/32 invariants passed — all thirty-two have to"
INVARIANTS="32/32"

# ── 7. financial comparison ──────────────────────────────────────────────
#
# Compared, recorded as a verdict, and never printed. The aggregate NAMES are
# safe; the amounts are the shop's money.
say "7. financial totals"
FIN_AGGREGATES='wallets.balance_irr,sum(wallet_entries.amount_irr)'

# The money invariant, asked of every wallet at once: a stored balance must
# equal the sum of the entries behind it. An earlier draft of this compared one
# query with itself, which is a check that cannot fail and therefore is not one.
#
# The count is a count of DISAGREEMENTS. It is safe to print; the balances it
# counts are not, and are never read out of the database.
FIN_DRIFT=$(docker exec -i "$PG_C" psql -U postgres -d shikoo -tAc "
  select count(*) from wallets w
   where w.balance_irr <> coalesce(
     (select sum(e.amount_irr) from wallet_entries e where e.user_id = w.user_id), 0)" 2>/dev/null || echo 'ERR')
[ "$FIN_DRIFT" != 'ERR' ] || die "the financial aggregates could not be read from the migrated schema"
if [ "$FIN_DRIFT" = '0' ]; then FINANCIAL_TOTALS=match; else FINANCIAL_TOTALS=mismatch; fi
say "   financial_totals=${FINANCIAL_TOTALS} (${FIN_DRIFT} wallet(s) disagree; amounts not logged)"
[ "$FINANCIAL_TOTALS" = 'match' ] || die "the migration changed a financial total — that is a stop, not a warning"

# ── 8. a restore that is actually performed ──────────────────────────────
say "8. restore"
if [ -z "$PROD_BACKUP_DIR" ] || [ ! -d "$PROD_BACKUP_DIR" ]; then
  die "PROD_BACKUP_DIR in ${CONF} does not name a readable backup directory"
fi
NEWEST=$(find "$PROD_BACKUP_DIR" -maxdepth 1 -name '*.dmp' -type f -printf '%T@ %p\n' 2>/dev/null |
  sort -rn | head -1 | cut -d' ' -f2-)
[ -n "$NEWEST" ] || die "no backup dump found to restore"
docker run -d --name "$RESTORE_C" -e POSTGRES_PASSWORD=rehearsal -e POSTGRES_DB=restored \
  "$PG_IMAGE" >/dev/null || die "could not start the restore target"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $RESTORE_C"
for _ in $(seq 1 60); do
  docker exec "$RESTORE_C" pg_isready -q >/dev/null 2>&1 && break
  sleep 2
done
RESTORE_START=$(date +%s)
if docker exec -i "$RESTORE_C" pg_restore -U postgres -d restored --no-owner <"$NEWEST" >/dev/null 2>&1; then
  RESTORE_RESULT=pass
else
  RESTORE_RESULT=fail
fi
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_START ))
say "   restore ${RESTORE_RESULT} in ${RESTORE_SECONDS}s"
[ "$RESTORE_RESULT" = 'pass' ] || die "the newest backup did not restore — rollback has no floor under it"

# ── 9. the CURRENT production image against the migrated schema ──────────
#
# This is what keeps image rollback a real recovery path. If today's running
# image cannot serve tomorrow's schema, rolling back to it is not a recovery,
# and that has to be known before the migration runs rather than after.
say "9. old-image compatibility"
OLD_IMAGE=$(cfg CURRENT_PRODUCTION_IMAGE)
[ -n "$OLD_IMAGE" ] || die "CURRENT_PRODUCTION_IMAGE is not set in ${CONF}"
if docker run --rm -e ENV_NAME=production -e SERVICE=migrate \
     -e DATABASE_URL="postgres://postgres:rehearsal@${PG_IP}:5432/shikoo" \
     "$OLD_IMAGE" >/dev/null 2>&1; then
  OLD_APP_SCHEMA_COMPAT=pass
else
  OLD_APP_SCHEMA_COMPAT=fail
fi
say "   old_app_schema_compat=${OLD_APP_SCHEMA_COMPAT}"
[ "$OLD_APP_SCHEMA_COMPAT" = 'pass' ] ||
  die "the current production image cannot serve the migrated schema — image rollback would be void, and this blocks the attestation"

# ── 10. the attestation, atomically, only now ────────────────────────────
say "10. writing the attestation"
TMP_ATT=$(mktemp -d); CLEANUP_DIRS="$CLEANUP_DIRS $TMP_ATT"
MAIN_SHA="$MAIN_SHA" DIGEST="$DIGEST" CI_RUN_ID="$CI_RUN_ID" STAGING_RUN_ID="$STAGING_RUN_ID" \
  DUMP_ID="$DUMP_ID" MIGRATION_RANGE="$MIGRATION_RANGE" DUMP_SUITES="$DUMP_SUITES" \
  INVARIANTS="$INVARIANTS" FINANCIAL_TOTALS="$FINANCIAL_TOTALS" \
  FINANCIAL_AGGREGATES="$FIN_AGGREGATES" \
  RESTORE_RESULT="$RESTORE_RESULT" RESTORE_SECONDS="$RESTORE_SECONDS" \
  OLD_APP_SCHEMA_COMPAT="$OLD_APP_SCHEMA_COMPAT" GITHUB_REPOSITORY="$REPO" \
  bash "$HERE/write-dump-attestation.sh" "$TMP_ATT" >/dev/null ||
  die "the attestation could not be written"

# Atomic: staged complete, then moved into place. A reader must never find a
# half-written attestation, because a half-written one still parses.
mkdir -p "$ATTEST_DIR"
mv -f "$TMP_ATT/attestation.env" "$ATTEST_DIR/.attestation.env.new"
mv -f "$TMP_ATT/attestation.sha256" "$ATTEST_DIR/.attestation.sha256.new"
mv -f "$ATTEST_DIR/.attestation.env.new" "$ATTEST_DIR/attestation.env"
mv -f "$ATTEST_DIR/.attestation.sha256.new" "$ATTEST_DIR/attestation.sha256"

# ── 11. verify what was just written ─────────────────────────────────────
say "11. verifying"
( cd "$ATTEST_DIR" && sha256sum -c --status attestation.sha256 ) ||
  die "the attestation just written does not match its own checksum"
EXPECTED_REPO="$REPO" EXPECTED_SHA="$MAIN_SHA" EXPECTED_DIGEST="$DIGEST" \
  EXPECTED_CI_RUN_ID="$CI_RUN_ID" EXPECTED_STAGING_RUN_ID="$STAGING_RUN_ID" \
  bash "$HERE/verify-dump-attestation.sh" "$ATTEST_DIR" ||
  die "the attestation does not verify against the release it was written for"

say ""
say "REHEARSAL COMPLETE for ${MAIN_SHA:0:12} @ ${DIGEST:0:19}…"
say "attestation: ${ATTEST_DIR}/attestation.env"
