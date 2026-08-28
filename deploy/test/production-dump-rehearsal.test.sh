#!/usr/bin/env bash
# shellcheck disable=SC2016  # assertions are literal strings searched for in
# another file; expansion is exactly what must not happen to them.
#
# The rehearsal, and every way it must refuse.
#
# Prepare Production stopped at P0 because no attestation existed. The gate was
# right; the thing that produces the evidence was missing. What matters about
# the replacement is not that it can succeed — it is that it cannot produce an
# attestation on anything less than a complete pass, and that it leaves nothing
# behind when it fails.
#
# Most of this is therefore about refusals, cleanup and silence.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
R="$ROOT/deploy/production-dump-rehearsal.sh"
RUNNER="$ROOT/deploy/shikoo-task-runner"
SUDOERS="$ROOT/deploy/shikoo-task-runner.sudoers"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }
has() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3" "missing: $2"; fi; }
lacks() { if grep -qF -- "$2" "$1"; then bad "$3" "still present: $2"; else ok "$3"; fi; }

section 'it accepts nothing through argv'

has "$R" '[ "$#" -eq 0 ]' 'it refuses any argument at all'
# The four release values are the ones that must never be caller-chosen: an
# attestation whose subject the caller picks attests to whatever they wanted.
for v in MAIN_SHA DIGEST CI_RUN_ID STAGING_RUN_ID; do
  if grep -qE "^${v}=\\\$\{?[1-9]" "$R"; then
    bad "${v} is not read from a positional argument" 'it is'
  else
    ok "${v} is not read from a positional argument"
  fi
done
# This was `grep -q ... | grep -v '^#'`, and `grep -q` prints nothing, so the
# second grep read empty input, exited 1, and the condition could never be
# true — it reported ok whatever the script did.
#
# Corrected, it then failed, because a text search cannot tell the script's own
# `$1` from a `$1` inside `cfg()` or `wait_pg()`. The property wanted here is
# behavioural, so it is tested behaviourally: the script must refuse arguments,
# and refuse them before it does anything at all.
# `set -e` is on in this suite, so the non-zero exit has to be caught rather
# than assigned and inspected afterwards.
ARGRC=0
ARGOUT=$(bash "$R" unexpected-argument 2>&1) || ARGRC=$?
if [ "$ARGRC" -eq 2 ] && printf '%s' "$ARGOUT" | grep -q 'takes no arguments'; then
  ok 'it refuses an argument, with exit 2'
else
  bad 'it refuses an argument, with exit 2' "rc=${ARGRC}: $(printf '%s' "$ARGOUT" | head -1)"
fi
# And refuses before reading its configuration, so an argument cannot steer
# anything it opens.
if printf '%s' "$ARGOUT" | grep -qE 'host dependency|rehearsal config'; then
  bad 'it refuses the argument before doing any work' 'it had already started'
else
  ok 'it refuses the argument before doing any work'
fi
has "$R" 'REHEARSAL_CONF:-/etc/shikoo/production/rehearsal.env' 'configuration comes from a root-owned file'
has "$R" 'never sourced' 'the config is read as text, not sourced'

section 'the host is checked before anything sensitive is opened'

has "$R" 'rehearsal_require_host_deps' 'the host dependency contract runs'
# Ordering is the point of the contract. A missing tool discovered halfway
# through has already caused the config to be read, the dump to be opened and a
# temp directory holding customer data to exist.
deps=$(grep -n 'rehearsal_require_host_deps "$DEP_PROBE"' "$R" | head -1 | cut -d: -f1)
for later in 'rehearsal_require_secure_file "$CONF"' \
             'DUMP_PATH=$(cfg MIRZABOT_DUMP)' \
             'rehearsal_validate_d1_export' \
             'find "$PROD_BACKUP_DIR"' \
             'docker network create' \
             'VERSION_DIR='; do
  l=$(grep -nF "$later" "$R" | head -1 | cut -d: -f1)
  if [ -n "$deps" ] && [ -n "$l" ] && [ "$deps" -lt "$l" ]; then
    ok "the host contract precedes: ${later:0:40}"
  else
    bad "the host contract precedes: ${later:0:40}" "deps@${deps:-?} later@${l:-?}"
  fi
done

section 'the release is resolved and cross-checked, not asserted'

has "$R" 'repos/${REPO}/commits/main' 'main_sha is read from GitHub'
has "$R" 'workflows/ci.yml/runs' 'the CI run is resolved from GitHub'
# `pick-staging-run.sh` is gh-based and gh is not installed on that host, so the
# same criteria are applied against the API directly: deploy-staging.yml,
# success, and this exact head sha.
has "$R" 'workflows/deploy-staging.yml/runs' 'the staging run is resolved by workflow and status'
has "$R" 'r.get("head_sha")==sys.argv[1]' 'it is matched to this exact commit'
has "$R" 'verify-release-manifest.sh' 'the digest comes from a verified release manifest'
has "$R" 'the manifest names CI run' 'the manifest and GitHub must agree on the CI run'
# Hard-coding any of them would make the attestation describe a release chosen
# at authoring time rather than the one in front of it.
for lit in 43b2f146893ed7b4657783e1c00fecfe37ab124f \
           074f104f4ca4d7b7eefe7bcfcdd37a332b383af692df20fa579a8e7d973d399f \
           33183969374 33185798400; do
  if grep -qF "$lit" "$R"; then
    bad "the release value ${lit:0:12}… is not hard-coded" 'it appears in the script'
  else
    ok "the release value ${lit:0:12}… is not hard-coded"
  fi
done

section 'no fixture is ever substituted for the dump'

has "$R" 'No fixture is substituted' 'a missing dump names one exact owner action'
has "$R" 'MIRZABOT_DUMP=<path>' 'the owner action is the exact line to add'
if grep -v '^[[:space:]]*#' "$R" | grep -qiE 'synthetic|fixture.*fallback|MIGRATE_FIXTURE_MYSQL'; then
  bad 'it never falls back to the synthetic fixture' 'a fallback exists'
else
  ok 'it never falls back to the synthetic fixture'
fi
has "$R" 'MIGRATE_PRODUCTION_DUMP=1' 'the dump-gated suites are actually enabled'
# The contract loadConfig() actually reads. MIGRATE_MYSQL_URL is read by
# nothing, so setting it pointed the suite at 127.0.0.1:3307 instead.
has "$R" 'MYSQL_HOST=' 'the real MySQL config contract is used'
has "$R" 'D1_EXPORT_DIR=/d1' 'the D1 export is supplied'
# Comment lines excluded: the header records the mistake deliberately so a
# future reader knows why the contract is spelled out.
if grep -v '^[[:space:]]*#' "$R" | grep -q 'MIGRATE_MYSQL_URL'; then
  bad 'MIGRATE_MYSQL_URL is not used in code' 'it is, and loadConfig ignores it'
else
  ok 'MIGRATE_MYSQL_URL is not used in code'
fi
has "$R" 'pnpm --filter @shikoo/migrate migrate' 'the real migrator is executed'
has "$R" 'schema-only destination is not a rehearsal' 'a zero-row destination is refused'
has "$R" 'rehearsal_pending_range' 'the range is derived from the restored ledger'
has "$R" 'rehearsal_check_vitest' 'the suite exit code is judged'
has "$R" 'on_signal' 'signals end the run'
# The publication mechanism now lives in attestation-store.sh, shared by the
# publisher and every reader. These stay as a cheap structural check; the
# behaviour is proven cross-process in attestation-publication.test.sh.
S="$ROOT/deploy/attestation-store.sh"
has "$S" 'mv -Tf' 'activation is an atomic rename'
has "$S" 'flock -w' 'activation takes the release lock'
has "$S" 'flock -s -w' 'readers take the same lock, shared'
has "$R" 'att_publish' 'the rehearsal publishes through the shared store'
lacks "$R" 'cp -f "$VERSION_DIR/attestation.env"' 'no flat copy is published beside the pointer'

section 'the thresholds are exact'

has "$R" 'rehearsal_check_vitest "$ART/migrate-report.json"' '49/0-skipped is enforced by the library'
has "$R" '[ "$INV_PASS" = ' '32 invariants are required exactly'

# A threshold expressed as >= would pass a suite that grew a test and lost one.
if grep -qE '\-ge (49|32)|\-gt (48|31)' "$R"; then
  bad 'the thresholds are equality, not inequality' 'an inequality is used'
else
  ok 'the thresholds are equality, not inequality'
fi

section 'the financial comparison can actually fail'

has "$R" 'rehearsal_compare_totals' 'it compares source aggregates against destination'
has "$R" 'balance_irr <> coalesce' 'the internal wallet invariant is kept as well'
has "$R" 'FIN_DRIFT' 'it keeps the internal wallet invariant too'
has "$R" 'that is a stop, not a warning' 'a mismatch stops the run'

section 'nothing production is written'

has "$R" 'throwaway' 'it works in throwaway containers'
if grep -qE 'docker run .*(--name "\$MYSQL_C"|--name "\$PG_C"|--name "\$RESTORE_C")' "$R"; then
  ok 'every database it creates is one of its own'
else
  bad 'every database it creates is one of its own' 'a container is unaccounted for'
fi
# The only production thing it touches is the newest backup, read-only.
if grep -qE 'psql .*(qd2vduj7|production).*-c *"(insert|update|delete|alter|drop)' "$R"; then
  bad 'it opens no writable connection to production' 'a write appears'
else
  ok 'it opens no writable connection to production'
fi
has "$R" 'pg_restore' 'the restore happens into a container of its own'
has "$R" 'RESTORE_SECONDS' 'the restore is timed'
has "$R" 'rollback has no floor under it' 'a failed restore stops the run'

section 'old-image compatibility blocks the attestation'

# The key is gone entirely. A value that is consulted and then silently loses
# to live state makes a wrong config look successful.
if grep -q 'CURRENT_PRODUCTION_IMAGE' "$R"; then
  bad 'CURRENT_PRODUCTION_IMAGE was removed' 'it is still referenced'
else
  ok 'CURRENT_PRODUCTION_IMAGE was removed'
fi
has "$R" 'rehearsal_check_live_production' 'the old image comes from live state'
has "$R" 'LIVE_IMAGES' 'the derived images are what compatibility is tested against'
has "$R" 'OLD_APP_SCHEMA_COMPAT' 'compatibility is measured'
has "$R" 'image rollback would be void' 'a failure explains what it costs'
# It must be checked BEFORE the attestation is written.
compat=$(grep -n 'OLD_APP_SCHEMA_COMPAT" = ' "$R" | head -1 | cut -d: -f1)
write=$(grep -n 'bash "\$HERE/write-dump-attestation.sh" "\$TMP_ATT"' "$R" | head -1 | cut -d: -f1)
if [ -n "$compat" ] && [ -n "$write" ] && [ "$compat" -lt "$write" ]; then
  ok 'compatibility is required before the attestation is written'
else
  bad 'compatibility is required before the attestation is written' "compat@${compat:-?} write@${write:-?}"
fi

section 'the attestation is written last, atomically, and verified'

# Every measurement gate must precede the write. Partial success is not
# evidence, and an attestation is the one artifact that must never be optimistic.
# Every measurement must be gated BEFORE the attestation is written. Partial
# success is not evidence, and an attestation is the one artifact that must
# never be optimistic. The counts themselves now live in the library, which has
# its own executed tests; what is checked here is the ordering.
for gate in 'the newest production backup did not restore' \
            'pending migration range could not be derived' \
            'production-dump suites did not pass as required' \
            'invariants passed — all thirty-two have to' \
            'empty or unmeasured destination is not a match' \
            'financial totals disagree' \
            'disagree with their own entries' \
            'invariants on the migrated production copy' \
            'cannot serve the migrated schema'; do
  g=$(grep -n "$gate" "$R" | head -1 | cut -d: -f1)
  if [ -n "$g" ] && [ -n "$write" ] && [ "$g" -lt "$write" ]; then
    ok "gated before the attestation: ${gate:0:44}"
  else
    bad "gated before the attestation: ${gate:0:44}" "gate@${g:-missing} write@${write:-missing}"
  fi
done
has "$R" 'VERSION_DIR' 'the attestation is built as a complete version first'
has "$S" 'mixed pair' 'the reason one pointer replaces the flat pair is recorded'
has "$S" 'previous attestation is untouched' 'a failed swap preserves the previous version'
has "$R" '/var/lib/shikoo/production' 'it writes to the directory Prepare Production reads'
has "$S" 'sha256sum -c --status attestation.sha256' 'the checksum is verified before activation'
has "$R" 'verify-dump-attestation.sh' 'the verifier is run against the same release'
has "$R" 'EXPECTED_STAGING_RUN_ID' 'verification pins the staging run too'

section 'it cleans up however it ends'

has "$R" "trap 'on_signal INT 130' INT" 'INT is handled by a handler that exits'
has "$R" "trap 'on_signal TERM 143' TERM" 'TERM is handled by a handler that exits'
has "$R" 'trap cleanup EXIT' 'cleanup also runs on normal exit'
has "$R" 'RESUMES after the interrupted command' 'the reason a bare trap was wrong is recorded'
has "$R" 'CLEANED' 'cleanup is idempotent so the double fire is safe'
has "$R" 'CLEANUP_CONTAINERS' 'containers are tracked for removal'
has "$R" 'docker rm -f' 'containers are removed'
has "$R" 'as it is created, not at the end' 'resources are registered as they are created'
has "$R" 'is worse than one that did not run' 'the reason cleanup matters is recorded'

section 'it prints nothing it should not'

has "$R" 'path not logged' 'the dump path is never printed'
has "$R" 'amounts not logged' 'financial amounts are never printed'
if grep -qE 'echo .*\$(DUMP_PATH|GH_TOKEN_VALUE|DATABASE_URL)|say .*\$(DUMP_PATH|GH_TOKEN_VALUE)' "$R"; then
  bad 'no credential or path reaches output' 'one does'
else
  ok 'no credential or path reaches output'
fi
# The token must not become an argument either.
if grep -qE 'gh api .*--header .*\$GH_TOKEN_VALUE|curl .*\$GH_TOKEN_VALUE' "$R"; then
  bad 'the GitHub token never appears in argv' 'it does'
else
  ok 'the GitHub token never appears in argv'
fi

section 'no network during the rehearsal'

has "$R" 'rehearsal_require_digest_ref' 'each image reference must be a digest'
has "$R" 'rehearsal_require_local_images' 'each image must already be local'
has "$R" 'it does not pull' 'the refusal says preload rather than pull'
n_run=$(grep -c 'docker run' "$R" || true)
n_never=$(grep -c 'pull=never' "$R" || true)
if [ "$n_run" = "$n_never" ] && [ "$n_run" -gt 0 ]; then
  ok "every docker run uses --pull=never (${n_run}/${n_run})"
else
  bad 'every docker run uses --pull=never' "${n_never} of ${n_run}"
fi
for forbidden in 'docker pull' 'docker build' 'docker manifest' 'buildx'; do
  if grep -v '^[[:space:]]*#' "$R" | grep -qF "$forbidden"; then
    bad "the rehearsal never calls ${forbidden}" 'it does'
  else
    ok "the rehearsal never calls ${forbidden}"
  fi
done
# Images are validated before the dump or the backup is opened.
img=$(grep -n 'rehearsal_require_local_images' "$R" | head -1 | cut -d: -f1)
dump=$(grep -n 'sha256sum "$DUMP_PATH"' "$R" | head -1 | cut -d: -f1)
bk=$(grep -n 'find "$PROD_BACKUP_DIR"' "$R" | head -1 | cut -d: -f1)
if [ -n "$img" ] && [ -n "$dump" ] && [ "$img" -lt "$dump" ]; then
  ok 'images are validated before the dump is opened'
else
  bad 'images are validated before the dump is opened' "img@${img:-?} dump@${dump:-?}"
fi
if [ -n "$img" ] && [ -n "$bk" ] && [ "$img" -lt "$bk" ]; then
  ok 'images are validated before the backup is read'
else
  bad 'images are validated before the backup is read' "img@${img:-?} backup@${bk:-?}"
fi

section 'the D1 export has no default and no fallback'

has "$R" 'rehearsal_validate_d1_export' 'the export is validated'
has "$R" 'd1-export-manifest.py' 'the owner action names the provenance generator'
has "$R" 'does not generate the export' 'no cloud export is performed'
has "$R" 'not infer' 'authenticity is not inferred from the rows'
if grep -v '^[[:space:]]*#' "$R" | grep -qE 'D1_EXPORT_DIR=\$\{D1_EXPORT_DIR:-'; then
  bad 'D1_EXPORT_DIR has no default' 'a default is applied'
else
  ok 'D1_EXPORT_DIR has no default'
fi

section 'the grant is exactly one more command'

has "$SUDOERS" 'shikoo-task-runner production-dump-rehearsal' 'sudoers grants the rehearsal'
if grep -E '^hessamx ' "$SUDOERS" | grep -qE 'production-dump-rehearsal +[^ ]'; then
  bad 'the grant takes no argument' 'an argument is permitted'
else
  ok 'the grant takes no argument'
fi
for forbidden in 'restore-drill-production' 'production-restore' 'cutover'; do
  if grep -E '^hessamx ' "$SUDOERS" | grep -q "$forbidden"; then
    bad "sudoers grants no ${forbidden}" 'it does'
  else
    ok "sudoers grants no ${forbidden}"
  fi
done
has "$RUNNER" 'production-dump-rehearsal)' 'the runner implements the subcommand'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
