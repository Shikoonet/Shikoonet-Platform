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
# shellcheck source=deploy/rehearsal-lib.sh
. "$HERE/rehearsal-lib.sh"
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
CLEANUP_NETWORKS=''
CLEANED=0
cleanup() {
  local c d n
  [ "$CLEANED" -eq 0 ] || return 0
  CLEANED=1
  for c in $CLEANUP_CONTAINERS; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  for d in $CLEANUP_DIRS; do
    [ -z "$d" ] || rm -rf "$d"
  done
  for n in $CLEANUP_NETWORKS; do
    docker network rm "$n" >/dev/null 2>&1 || true
  done
}

# A signal must END the run, not merely tidy up during it.
#
# `trap cleanup INT TERM` — which is what the first version had — runs the
# handler and then RESUMES after the interrupted command. A rehearsal that is
# terminated halfway would carry on and could still reach the attestation,
# which is the one artifact that must never be written by a run nobody watched
# finish. So the handler exits, and `cleanup` is idempotent because EXIT will
# fire again on the way out.
on_signal() { # signame code
  echo "[rehearsal] received $1 — tearing down and stopping; no attestation will be written" >&2
  cleanup
  exit "$2"
}
trap 'on_signal INT 130' INT
trap 'on_signal TERM 143' TERM
trap cleanup EXIT

# Checked before it is read. The config names a dump, a backup directory and a
# token; a file anybody can rewrite can redirect all three, and "is it
# readable" — the only check the first version made — does not notice that.
rehearsal_require_secure_file "$CONF" 640 "the rehearsal config" ||
  die "the rehearsal config is not secured as required"
REQUIRED_KEYS='MIRZABOT_DUMP D1_EXPORT_DIR REPO_DIR GITHUB_TOKEN PROD_BACKUP_DIR PG_IMAGE MYSQL_IMAGE NODE_IMAGE'
# shellcheck disable=SC2086
rehearsal_parse_config "$CONF" $REQUIRED_KEYS ||
  die "the rehearsal config is malformed or incomplete"

# Read as text, never sourced: a token is `<id>|<random>` and a shell would
# execute the pipe.
cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
DUMP_PATH=$(cfg MIRZABOT_DUMP)
REPO_DIR=$(cfg REPO_DIR)
GH_TOKEN_VALUE=$(cfg GITHUB_TOKEN)
D1_EXPORT_DIR=$(cfg D1_EXPORT_DIR)
PG_IMAGE=$(cfg PG_IMAGE)
MYSQL_IMAGE=$(cfg MYSQL_IMAGE)
NODE_IMAGE=$(cfg NODE_IMAGE)

# Digest-pinned, present locally, and never pulled.
#
# A tag names whatever was pushed last: `postgres:16-alpine` on Tuesday and on
# Thursday are two different rehearsals, and the one that matters is whichever
# ran while nobody was watching. There are no defaults for the same reason — a
# default is a tag nobody chose.
#
# Checked HERE, before the dump is opened, before the backup is read, and
# before any container or network exists, so an absent image is a refusal
# rather than a failure halfway through with resources already created.
rehearsal_require_digest_ref "$PG_IMAGE" PG_IMAGE ||
  die "PG_IMAGE must be an immutable digest reference"
rehearsal_require_digest_ref "$MYSQL_IMAGE" MYSQL_IMAGE ||
  die "MYSQL_IMAGE must be an immutable digest reference"
rehearsal_require_digest_ref "$NODE_IMAGE" NODE_IMAGE ||
  die "NODE_IMAGE must be an immutable digest reference"
rehearsal_require_local_images docker "$PG_IMAGE" "$MYSQL_IMAGE" "$NODE_IMAGE" ||
  die "preload the pinned images before the rehearsal; it does not pull"

PROD_BACKUP_DIR=$(cfg PROD_BACKUP_DIR)
COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}

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
# The D1 export: required, real, and never the repository fixture.
#
# `loadConfig()` defaults this to a path inside `legacy/hub-cloudflare/`, so a
# rehearsal that let the default stand would report 49/49 about a checked-in
# fixture. There is no default here and no fallback.
# The set comes from the committed contract, generated from the migrator's own
# source, and NOT from the environment. An overridable list is a check the
# caller can switch off, and the first version's four tables were a fifth of
# the real twenty-three — so nineteen could have been missing and it passed.
D1_MANIFEST="$HERE/d1-tables.manifest"
rehearsal_require_secure_file "$D1_MANIFEST" 644 "the D1 table contract" ||
  die "the D1 table contract is not secured as required"
D1_TABLES=$(tr '\n' ',' <"$D1_MANIFEST" | sed 's/,$//')
[ -n "$D1_TABLES" ] || die "the D1 table contract is empty"
if ! rehearsal_validate_d1_export "$D1_EXPORT_DIR" "$D1_TABLES"; then
  echo "[rehearsal] STOP: the production D1 export is missing or is not production data." >&2
  echo "[rehearsal] Owner action, exactly one:" >&2
  echo "[rehearsal]   place the real D1 export on this host, root-owned and not" >&2
  echo "[rehearsal]   world-writable, then set D1_EXPORT_DIR=<path> in ${CONF}." >&2
  echo "[rehearsal]   The repository fixture is refused; no export is generated here." >&2
  exit 1
fi
say "   D1 export validated"

[ -n "$GH_TOKEN_VALUE" ] || die "${CONF} has no GITHUB_TOKEN — release provenance cannot be cross-checked without it"

# ── 2. what release is this, resolved rather than asserted ───────────────
say "2. resolving the release from GitHub"
# curl with a 0600 config, not `gh`.
#
# `gh` is not installed on this host — verified, not assumed — and adding it
# would be a new dependency on the one machine where a missing tool stops a
# release. The token goes into the config file's header lines, never into argv,
# and the file dies with the directory.
GH_DIR=$(mktemp -d); CLEANUP_DIRS="$CLEANUP_DIRS $GH_DIR"
chmod 700 "$GH_DIR"
umask 077
{
  printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN_VALUE"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
  printf 'silent\nshow-error\nmax-time = 30\n'
} >"$GH_DIR/gh"
chmod 600 "$GH_DIR/gh"
unset GH_TOKEN_VALUE

# Status-aware. The previous version returned only a body, so a 401 or 404 was
# parsed as if it had succeeded and surfaced later as a sentence about the
# release when the truth was about the token.
gh_api() { # path label -> body on stdout, refuses on any non-2xx
  gh_request "$GH_DIR/gh" "https://api.github.com/$1" || {
    gh_classify 000 "$2"
    return 1
  }
  gh_classify "$GH_STATUS" "$2" || return 1
  printf '%s' "$GH_BODY"
}

MAIN_SHA=$(gh_api "repos/${REPO}/commits/main" "reading the head of main" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("sha") or "")') ||
  die "could not read the head of main"
[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] || die "main head is not a commit sha"
say "   main_sha=${MAIN_SHA}"

# The same picker Prepare Production uses, so the run this attests to is the
# run that would be promoted — not a different one that happens to be green.
STAGING_RUN_ID=$(gh_api "repos/${REPO}/actions/workflows/deploy-staging.yml/runs?per_page=50&status=success" "listing Deploy Staging runs" |
    python3 -c 'import json,sys
d=json.load(sys.stdin).get("workflow_runs") or []
m=[r for r in d if r.get("head_sha")==sys.argv[1]]
print(sorted(m,key=lambda r:r.get("run_started_at") or "")[-1]["id"] if m else "")' "$MAIN_SHA")
[ -n "$STAGING_RUN_ID" ] || die "no successful Deploy Staging run for ${MAIN_SHA:0:12} — staging has not accepted this release"
say "   staging_run_id=${STAGING_RUN_ID}"

CI_RUN_ID=$(gh_api "repos/${REPO}/actions/workflows/ci.yml/runs?per_page=100&head_sha=${MAIN_SHA}" "listing CI runs" |
  python3 -c 'import json,sys
d=json.load(sys.stdin).get("workflow_runs") or []
m=[r for r in d if r.get("event")=="push" and r.get("status")=="completed"
   and r.get("conclusion")=="success" and r.get("head_branch")=="main"]
print(sorted(m,key=lambda r:r.get("run_started_at") or "")[-1]["id"] if m else "")')
[ -n "$CI_RUN_ID" ] || die "no completed successful CI push run on main for ${MAIN_SHA:0:12}"
say "   ci_run_id=${CI_RUN_ID}"

# The digest comes from the manifest staging wrote, verified rather than read.
ART=$(mktemp -d); CLEANUP_DIRS="$CLEANUP_DIRS $ART"
ART_URL=$(gh_api "repos/${REPO}/actions/runs/${STAGING_RUN_ID}/artifacts" "listing staging artifacts" |
  python3 -c 'import json,sys
d=json.load(sys.stdin).get("artifacts") or []
m=[a for a in d if a.get("name")=="staging-digest" and not a.get("expired")]
print(m[0]["archive_download_url"] if m else "")')
[ -n "$ART_URL" ] || die "run ${STAGING_RUN_ID} has no staging-digest artifact"
DL_STATUS=$(curl -K "$GH_DIR/gh" -L -o "$ART/a.zip" -w '%{http_code}' "$ART_URL" 2>/dev/null || echo 000)
gh_classify "$DL_STATUS" "downloading the staging-digest artifact" ||
  die "the staging-digest artifact could not be downloaded"
( cd "$ART" && python3 -c 'import zipfile,sys; zipfile.ZipFile("a.zip").extractall(".")' ) ||
  die "the staging-digest artifact did not unpack"
EXPECTED_REPO="$REPO" EXPECTED_RUN_ID="$STAGING_RUN_ID" EXPECTED_RUN_HEAD_SHA="$MAIN_SHA" \
  bash "$HERE/verify-release-manifest.sh" "$ART" >/dev/null ||
  die "the staging release manifest does not verify for ${MAIN_SHA:0:12}"
DIGEST=$(sed -n 's/^digest=//p' "$ART/manifest.env" | head -1)
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || die "the manifest carries no immutable digest"
MANIFEST_CI=$(sed -n 's/^ci_run_id=//p' "$ART/manifest.env" | head -1)
[ "$MANIFEST_CI" = "$CI_RUN_ID" ] ||
  die "the manifest names CI run ${MANIFEST_CI}, GitHub names ${CI_RUN_ID} for this commit"
say "   digest=${DIGEST}"

# ── 3. the repository, verified rather than trusted ──────────────────────
say "3. verifying the checkout"
# `… || true` was here, which made this a security check that could not fail.
# An assertion that always passes is worse than no assertion: it reads like
# coverage.
rehearsal_require_secure_file "$REPO_DIR/.git/HEAD" 644 "the checkout's git HEAD" ||
  die "the checkout's git metadata is not secured as required"

# An exact allowlist. `*Shikoonet/Shikoonet-Platform*` also matches
# `https://evil.example/x/Shikoonet/Shikoonet-Platform-backdoor`, which is the
# whole problem with substring tests on identity.
REMOTE=$(git -C "$REPO_DIR" remote get-url origin 2>/dev/null || true)
rehearsal_require_known_remote "$REMOTE" ||
  die "REPO_DIR's origin is not an exact known remote for this repository"
[ "$(git -C "$REPO_DIR" rev-parse HEAD)" = "$MAIN_SHA" ] ||
  die "REPO_DIR is not at the release commit — code from an arbitrary checkout is not what this attests to"
# `--porcelain` already lists untracked files as `??`, so this covers both
# modifications and additions. An untracked file in the checkout is code that
# is not in the release.
[ -z "$(git -C "$REPO_DIR" status --porcelain)" ] ||
  die "REPO_DIR has local modifications or untracked files; the rehearsal runs the release, not a working copy"
[ -f "$REPO_DIR/pnpm-lock.yaml" ] || die "REPO_DIR has no committed lockfile"
say "   checkout is ${MAIN_SHA:0:12}, clean, correct remote"

SUFFIX=$$-$(date -u +%s)
MYSQL_C="shikoo-rehearsal-mysql-${SUFFIX}"
DEST_C="shikoo-rehearsal-dest-${SUFFIX}"
RESTORE_C="shikoo-rehearsal-restore-${SUFFIX}"
NET="shikoo-rehearsal-net-${SUFFIX}"
docker network create "$NET" >/dev/null || die "could not create the rehearsal network"
CLEANUP_NETWORKS="$NET"

wait_pg() { for _ in $(seq 1 60); do docker exec "$1" pg_isready -q >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }

# ── 4. the newest PRODUCTION backup, restored into a throwaway ───────────
#
# Selected from Coolify's own record of the production database's backups, not
# from a directory somebody named. A caller-supplied path could just as easily
# be staging's, and restoring staging while calling it production is a
# rehearsal that proves the wrong thing confidently.
say "4. restoring the newest production backup"
PROD_DB_UUID=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -c \
  "select p.uuid from standalone_postgresqls p join environments e on e.id=p.environment_id
    where e.name='production' limit 1;" 2>/dev/null || true)
[ -n "$PROD_DB_UUID" ] || die "could not identify the production database in Coolify"
STAGING_DB_UUID=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -c \
  "select p.uuid from standalone_postgresqls p join environments e on e.id=p.environment_id
    where e.name='dev-fleet' limit 1;" 2>/dev/null || true)
[ "$PROD_DB_UUID" != "$STAGING_DB_UUID" ] || die "production and staging resolved to the same database"
BACKUP_OK=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -c \
  "select count(*) from scheduled_database_backups b
     join standalone_postgresqls p on p.id = b.database_id
    where p.uuid = '${PROD_DB_UUID}' and b.enabled;" 2>/dev/null || echo 0)
[ "${BACKUP_OK:-0}" -ge 1 ] || die "production has no enabled scheduled backup to rehearse from"
# Not a substring test: `/tmp/evil-<uuid>-staging` contains the uuid too.
rehearsal_backup_dir_belongs "$PROD_BACKUP_DIR" "$PROD_DB_UUID" ||
  die "PROD_BACKUP_DIR is not the backup directory of the production database"

NEWEST=$(find "$PROD_BACKUP_DIR" -maxdepth 1 -name '*.dmp' -type f -printf '%T@ %p\n' 2>/dev/null |
  sort -rn | head -1 | cut -d' ' -f2-)
[ -n "$NEWEST" ] || die "no production backup dump found to restore"
# The selected dump itself, not just the directory it sits in.
[ ! -L "$NEWEST" ] || die "the selected backup is a symlink — refusing"
[ -f "$NEWEST" ] || die "the selected backup is not a regular file"
case "$(stat -c '%a' "$NEWEST")" in
  *[2367]) die "the selected backup is group- or world-writable" ;;
esac
# And the dump the legacy half reads.
[ ! -L "$DUMP_PATH" ] || die "the Mirzabot dump is a symlink — refusing"
[ -f "$DUMP_PATH" ] || die "the Mirzabot dump is not a regular file"

docker run --pull=never -d --name "$RESTORE_C" --network "$NET" -e POSTGRES_PASSWORD=rehearsal \
  -e POSTGRES_DB=prodrestore "$PG_IMAGE" >/dev/null || die "could not start the restore target"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $RESTORE_C"
wait_pg "$RESTORE_C" || die "the restore target never became ready"
RESTORE_START=$(date +%s)
if docker exec -i "$RESTORE_C" pg_restore -U postgres -d prodrestore --no-owner <"$NEWEST" >/dev/null 2>&1; then
  RESTORE_RESULT=pass
else
  RESTORE_RESULT=fail
fi
RESTORE_SECONDS=$(( $(date +%s) - RESTORE_START ))
say "   restore ${RESTORE_RESULT} in ${RESTORE_SECONDS}s"
[ "$RESTORE_RESULT" = 'pass' ] || die "the newest production backup did not restore — rollback has no floor under it"

# ── 5. the pending range, from that ledger ───────────────────────────────
say "5. deriving the pending migration range"
docker exec -i "$RESTORE_C" psql -U postgres -d prodrestore -At \
  -c 'select name from schema_migrations order by name' >"$ART/applied.txt" 2>/dev/null ||
  die "the restored production database has no readable schema_migrations ledger"
MIGRATION_RANGE=$(rehearsal_pending_range "$ART/applied.txt" "$REPO_DIR/migrations") ||
  die "the pending migration range could not be derived from the restored ledger"
say "   pending range ${MIGRATION_RANGE} (production ledger had $(grep -c . "$ART/applied.txt"))"

# ── 6. the legacy source ─────────────────────────────────────────────────
say "6. loading the legacy dump"
docker run --pull=never -d --name "$MYSQL_C" --network "$NET" \
  -e MYSQL_ALLOW_EMPTY_PASSWORD=1 -e MYSQL_DATABASE=mirzabot \
  "$MYSQL_IMAGE" >/dev/null || die "could not start the throwaway MySQL"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $MYSQL_C"
for _ in $(seq 1 90); do docker exec "$MYSQL_C" mysqladmin ping --silent >/dev/null 2>&1 && break; sleep 2; done
docker exec "$MYSQL_C" mysqladmin ping --silent >/dev/null 2>&1 || die "the throwaway MySQL never became ready"
docker exec -i "$MYSQL_C" mysql mirzabot <"$DUMP_PATH" || die "the dump would not load"
SRC_ROWS=$(docker exec -i "$MYSQL_C" mysql -N -B mirzabot -e 'select count(*) from user' 2>/dev/null || echo 0)
[ "${SRC_ROWS:-0}" -gt 0 ] || die "the loaded dump has no users — this is not the real dataset"
say "   dump loaded (${SRC_ROWS} source users)"

# ── 7. the REAL migration ────────────────────────────────────────────────
#
# The first version applied schema SQL and stopped. A destination with tables
# and no rows passes every "each wallet equals its own entries" check by having
# no wallets, and that is what the attestation would have certified.
say "7. running the migrator"
docker run --pull=never -d --name "$DEST_C" --network "$NET" -e POSTGRES_PASSWORD=rehearsal \
  -e POSTGRES_DB=shikoo "$PG_IMAGE" >/dev/null || die "could not start the migration destination"
CLEANUP_CONTAINERS="$CLEANUP_CONTAINERS $DEST_C"
wait_pg "$DEST_C" || die "the migration destination never became ready"
MIG_LIST=$(find "$REPO_DIR/migrations" -maxdepth 1 -name '0*.sql' -type f | sort)
for f in $MIG_LIST; do
  docker exec -i "$DEST_C" psql -U postgres -d shikoo -v ON_ERROR_STOP=1 -q <"$f" ||
    die "migration $(basename "$f") failed"
done

# The environment the application actually reads. `MIGRATE_MYSQL_URL` — which
# the first version exported — is read by nothing: `loadConfig()` wants
# MYSQL_HOST/PORT/USER/PASSWORD/DATABASE and D1_EXPORT_DIR, so that run would
# have connected to 127.0.0.1:3307 and measured a different database entirely.
NODE_RUN=(docker run --pull=never --rm --network "$NET"
  -v "$REPO_DIR:/repo:ro" -v "$ART:/out"
  -v "$D1_EXPORT_DIR:/d1:ro"
  -w /repo
  -e MYSQL_HOST="$MYSQL_C" -e MYSQL_PORT=3306 -e MYSQL_USER=root
  -e MYSQL_PASSWORD= -e MYSQL_DATABASE=mirzabot
  -e D1_EXPORT_DIR=/d1
  -e DATABASE_URL="postgres://postgres:rehearsal@${DEST_C}:5432/shikoo"
  "$NODE_IMAGE")
"${NODE_RUN[@]}" sh -lc 'corepack enable >/dev/null 2>&1; pnpm --filter @shikoo/migrate migrate' >/dev/null ||
  die "the migrator failed against the real dump"
DEST_ROWS=$(docker exec -i "$DEST_C" psql -U postgres -d shikoo -At -c 'select count(*) from users' 2>/dev/null || echo 0)
[ "${DEST_ROWS:-0}" -gt 0 ] || die "the migration produced no rows — a schema-only destination is not a rehearsal"
say "   migrated (${DEST_ROWS} destination users)"

# ── 8. the 49, judged on the exit code too ───────────────────────────────
say "8. the production-dump suites"
set +e
"${NODE_RUN[@]}" -e MIGRATE_PRODUCTION_DUMP=1 sh -lc \
  'corepack enable >/dev/null 2>&1; pnpm --filter @shikoo/migrate exec vitest run --reporter=json --outputFile.json=/out/migrate-report.json' \
  >/dev/null 2>&1
VITEST_RC=$?
set -e
DUMP_SUITES=$(rehearsal_check_vitest "$ART/migrate-report.json" "$VITEST_RC" 49) ||
  die "the production-dump suites did not pass as required"
say "   dump-gated: ${DUMP_SUITES}, zero skipped, suite exit 0"

# ── 9. invariants ────────────────────────────────────────────────────────
say "9. schema invariants"
INV_LOG="$ART/invariants.log"
docker exec -i "$DEST_C" psql -U postgres -d shikoo -v ON_ERROR_STOP=1 \
  <"$REPO_DIR/migrations/verify_invariants.sql" >"$INV_LOG" 2>&1 ||
  die "verify_invariants.sql did not complete"
INV_PASS=$(grep -c 'PASS ' "$INV_LOG" || true)
[ "$INV_PASS" = '32' ] || die "${INV_PASS}/32 invariants passed — all thirty-two have to"
INVARIANTS="32/32"
say "   invariants ${INVARIANTS}"

# ── 10. financial totals, source against destination ─────────────────────
say "10. financial totals"
FIN_AGGREGATES='wallet_balance,ledger_sum,order_total'
docker exec -i "$MYSQL_C" mysql -N -B mirzabot -e \
  "select concat('wallet_balance=', coalesce(sum(Balance),0)) from user;
   select concat('ledger_sum=', coalesce(sum(Balance),0)) from user;
   select concat('order_total=', coalesce(sum(price),0)) from invoice;" >"$ART/src.agg" 2>/dev/null ||
  die "the source aggregates could not be measured"
{
  docker exec -i "$DEST_C" psql -U postgres -d shikoo -At -c \
    "select 'wallet_balance='||coalesce(sum(balance_irr),0) from wallets"
  docker exec -i "$DEST_C" psql -U postgres -d shikoo -At -c \
    "select 'ledger_sum='||coalesce(sum(amount_irr),0) from wallet_entries"
  docker exec -i "$DEST_C" psql -U postgres -d shikoo -At -c \
    "select 'order_total='||coalesce(sum(total_irr),0) from orders"
} >"$ART/dst.agg" 2>/dev/null || die "the destination aggregates could not be measured"

FINANCIAL_TOTALS=$(rehearsal_compare_totals "$ART/src.agg" "$ART/dst.agg") ||
  die "the financial comparison failed — an empty or unmeasured destination is not a match"
case "$FINANCIAL_TOTALS" in
  match) ;;
  *) die "financial totals disagree (${FINANCIAL_TOTALS}) — that is a stop, not a warning" ;;
esac
say "   financial_totals=match across ${FIN_AGGREGATES} (amounts not logged)"

# The internal invariant is kept as well; it is cheap and it is not the same
# question as the cross-dataset comparison.
FIN_DRIFT=$(docker exec -i "$DEST_C" psql -U postgres -d shikoo -tAc "
  select count(*) from wallets w
   where w.balance_irr <> coalesce(
     (select sum(e.amount_irr) from wallet_entries e where e.user_id = w.user_id), 0)" 2>/dev/null || echo 'ERR')
[ "$FIN_DRIFT" = '0' ] || die "${FIN_DRIFT} migrated wallet(s) disagree with their own entries"

# ── 11. the pending migrations on the restored PRODUCTION copy ───────────
say "11. applying the pending range to the restored production copy"
for f in $MIG_LIST; do
  n=$(basename "$f" | cut -c1-4)
  [ "$n" \> "${MIGRATION_RANGE%%..*}" ] || [ "$n" = "${MIGRATION_RANGE%%..*}" ] || continue
  docker exec -i "$RESTORE_C" psql -U postgres -d prodrestore -v ON_ERROR_STOP=1 -q <"$f" ||
    die "pending migration $(basename "$f") failed against the restored production copy"
done
docker exec -i "$RESTORE_C" psql -U postgres -d prodrestore -v ON_ERROR_STOP=1 \
  <"$REPO_DIR/migrations/verify_invariants.sql" >"$ART/prod-inv.log" 2>&1 ||
  die "the invariants do not hold on the migrated production copy"
PROD_INV=$(grep -c 'PASS ' "$ART/prod-inv.log" || true)
[ "$PROD_INV" = '32' ] || die "${PROD_INV}/32 invariants on the migrated production copy"
say "   pending range applied, invariants ${PROD_INV}/32"

# ── 12. can today's image still serve tomorrow's schema ──────────────────
#
# The first version ran the old image with SERVICE=migrate, which proves its
# migration entrypoint exits. That is not the question. The question is whether
# the code CURRENTLY SERVING customers can start and answer against the migrated
# schema — so the real service entrypoints are used, with their schema gates,
# and their health endpoints are asked.
#
# No Telegram token is supplied and no poller is started: the bot is checked by
# its schema gate alone, which is the part that touches the migrated tables.
say "12. old-image compatibility"
# Derived from what is actually serving. There is no configured value to
# disagree with any more: a key that is consulted and then silently loses to
# live state makes a wrong config look successful, which is worse than not
# having the key at all.
# The uuids come from the root-controlled deployment config — the same file
# `deploy.sh` reads — and are then required to agree with Coolify exactly. A
# name is a label somebody can change; the uuid is the identity.
DEPLOY_CONF=${DEPLOY_CONF:-/etc/shikoo/production/deploy.env}
rehearsal_require_secure_file "$DEPLOY_CONF" 640 "the production deploy config" ||
  die "the production deploy config is not secured as required"
dcfg() { sed -n "s/^$1=//p" "$DEPLOY_CONF" | head -n1; }
EXP_INGEST=$(dcfg APP_INGEST); EXP_DASHBOARD=$(dcfg APP_DASHBOARD); EXP_BOT=$(dcfg APP_BOT)
for pair in "APP_INGEST=$EXP_INGEST" "APP_DASHBOARD=$EXP_DASHBOARD" "APP_BOT=$EXP_BOT"; do
  v=${pair#*=}
  printf '%s' "$v" | grep -qE '^[a-z0-9]{20,32}$' ||
    die "${pair%%=*} in ${DEPLOY_CONF} is not a Coolify uuid"
done

# Observed uuids must match the configured ones exactly, as a set.
OBSERVED="$ART/observed-uuids.txt"
: >"$OBSERVED"
for app in shikoo-ingest shikoo-dashboard shikoo-bot; do
  u=$(docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -c \
    "select a.uuid from applications a join environments e on e.id = a.environment_id
      where a.name = '${app}' and e.name = 'production';" 2>/dev/null)
  n=$(printf '%s\n' "$u" | grep -c . || true)
  [ "${n:-0}" -eq 1 ] || die "${app} matched ${n:-0} production applications, expected exactly 1"
  printf '%s|%s\n' "$app" "$u" >>"$OBSERVED"
done
rehearsal_check_app_uuids "$OBSERVED" \
  "shikoo-ingest=${EXP_INGEST},shikoo-dashboard=${EXP_DASHBOARD},shikoo-bot=${EXP_BOT}" >/dev/null ||
  die "the live production application uuids do not match the deployment config exactly"
say "   application uuids agree with ${DEPLOY_CONF}"

LIVE_FACTS="$ART/live.txt"
: >"$LIVE_FACTS"
while IFS='|' read -r app a_uuid; do
  [ -n "$app" ] || continue
  a_name=$app
  a_env=production
  cid=$(docker ps --filter "label=coolify.name=${a_uuid}" --format '{{.Names}}' | head -1)
  n_c=$(docker ps --filter "label=coolify.name=${a_uuid}" --format '{{.Names}}' | grep -c . || true)
  [ "${n_c:-0}" -eq 1 ] || die "${app} resolves to ${n_c:-0} running containers, expected exactly 1"
  img=$(docker inspect -f '{{.Image}}' "$cid" 2>/dev/null || true)
  hlth=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}running{{end}}' "$cid" 2>/dev/null || true)
  printf '%s|%s|%s|%s|%s\n' "$a_name" "$a_env" "$cid" "$img" "$hlth" >>"$LIVE_FACTS"
done <"$OBSERVED"
LIVE_IMAGES=$(rehearsal_check_live_production "$LIVE_FACTS" 'shikoo-ingest,shikoo-dashboard,shikoo-bot') ||
  die "the live production applications could not be resolved to exactly one healthy container each"
say "   live production images resolved by immutable id"

OLD_APP_SCHEMA_COMPAT=pass
for entry in $(printf '%s' "$LIVE_IMAGES" | tr ',' ' '); do
  app=${entry%%=*}
  img=${entry#*=}
  case "$app" in
    shikoo-ingest) svc=ingest ;;
    shikoo-dashboard) svc=dashboard ;;
    *) svc=bot ;;
  esac
  # The real service entrypoint's schema gate, against the migrated restore.
  # No Telegram token is supplied and no poller is started: the bot is checked
  # by the gate that touches the migrated tables and nothing else.
  docker run --pull=never --rm --network "$NET" \
    -e ENV_NAME=production -e SERVICE="$svc" -e SCHEMA_GATE_ONLY=1 \
    -e DATABASE_URL="postgres://postgres:rehearsal@${RESTORE_C}:5432/prodrestore" \
    --entrypoint /bin/sh "$img" -lc \
    'node --import tsx -e "import(\"@shikoo/db\").then(async m=>{const {db,pool}=m.createPostgresD1();const s=await m.status(db);if(s.pending.length){console.error(\"pending\");process.exit(1)}await pool.end()})"' \
    >/dev/null 2>&1 || OLD_APP_SCHEMA_COMPAT=fail
done
say "   old_app_schema_compat=${OLD_APP_SCHEMA_COMPAT}"
[ "$OLD_APP_SCHEMA_COMPAT" = 'pass' ] ||
  die "the live production image cannot serve the migrated schema — image rollback would be void"

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

# Pair-atomic, which the two separate `mv` calls were not.
#
# Moving attestation.env and attestation.sha256 one after the other leaves a
# window in which a reader sees a NEW env beside an OLD checksum — which does
# not verify, and looks exactly like tampering. A failure between the two moves
# also destroys a previously valid attestation, which is worse: the evidence
# that a release was rehearsed disappears because the NEXT rehearsal failed.
#
# So a complete versioned directory is built and verified, and only then does a
# symlink swap make it current. `ln -sfn` onto a temporary name followed by
# `mv -T` is atomic on the same filesystem: a reader either follows the old
# directory or the new one, never a mixture. A run that fails before this point
# touches neither, so the previous valid attestation is preserved byte for byte.
#
# The swap takes the same lock Prepare Production takes, so Prepare cannot read
# the pointer while it is moving.
VERSION_DIR="$ATTEST_DIR/versions/${MAIN_SHA}-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$VERSION_DIR"
mv -f "$TMP_ATT/attestation.env" "$VERSION_DIR/attestation.env"
mv -f "$TMP_ATT/attestation.sha256" "$VERSION_DIR/attestation.sha256"
( cd "$VERSION_DIR" && sha256sum -c --status attestation.sha256 ) ||
  die "the freshly written attestation does not match its own checksum — not activating it"

LOCKFILE=${REHEARSAL_LOCK:-/var/lock/shikoo-deploy-production.lock}
exec 8>"$LOCKFILE" || die "cannot open ${LOCKFILE}"
flock -w 120 8 || die "another release step holds ${LOCKFILE}"
ln -sfn "$VERSION_DIR" "$ATTEST_DIR/.current.new"
mv -Tf "$ATTEST_DIR/.current.new" "$ATTEST_DIR/current"
# Compatibility for readers that expect the flat names: both are replaced from
# the SAME verified directory, so the pair can never be mixed.
cp -f "$VERSION_DIR/attestation.env" "$ATTEST_DIR/.attestation.env.new"
cp -f "$VERSION_DIR/attestation.sha256" "$ATTEST_DIR/.attestation.sha256.new"
mv -Tf "$ATTEST_DIR/.attestation.env.new" "$ATTEST_DIR/attestation.env"
mv -Tf "$ATTEST_DIR/.attestation.sha256.new" "$ATTEST_DIR/attestation.sha256"
flock -u 8

# ── 14. verify what was just activated ───────────────────────────────────
#
# Against the release it was written for, not against itself. Writing an
# attestation and trusting it because you wrote it is the failure this whole
# file exists to prevent.
say "14. verifying the activated attestation"
( cd "$ATTEST_DIR" && sha256sum -c --status attestation.sha256 ) ||
  die "the activated attestation does not match its own checksum"
EXPECTED_REPO="$REPO" EXPECTED_SHA="$MAIN_SHA" EXPECTED_DIGEST="$DIGEST" \
  EXPECTED_CI_RUN_ID="$CI_RUN_ID" EXPECTED_STAGING_RUN_ID="$STAGING_RUN_ID" \
  bash "$HERE/verify-dump-attestation.sh" "$ATTEST_DIR" ||
  die "the activated attestation does not verify against this release"

say ""
say "REHEARSAL COMPLETE for ${MAIN_SHA:0:12} @ ${DIGEST:0:19}…"
say "attestation: ${ATTEST_DIR}/attestation.env"
