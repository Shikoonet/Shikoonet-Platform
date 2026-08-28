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
if grep -qE '\$\{?[1-9][0-9]*\}?' "$R" | grep -v '^#'; then
  bad 'no positional parameter is read anywhere' 'one is'
else
  ok 'no positional parameter is read anywhere'
fi
has "$R" 'REHEARSAL_CONF:-/etc/shikoo/production/rehearsal.env' 'configuration comes from a root-owned file'
has "$R" 'never sourced' 'the config is read as text, not sourced'

section 'the release is resolved and cross-checked, not asserted'

has "$R" 'repos/${REPO}/commits/main' 'main_sha is read from GitHub'
has "$R" 'workflows/ci.yml/runs' 'the CI run is resolved from GitHub'
has "$R" 'pick-staging-run.sh' 'the staging run uses the same picker Prepare uses'
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
if grep -qiE 'synthetic|fixture.*fallback|MIGRATE_FIXTURE_MYSQL' "$R" | grep -v '^#'; then
  bad 'it never falls back to the synthetic fixture' 'a fallback exists'
else
  ok 'it never falls back to the synthetic fixture'
fi
has "$R" 'MIGRATE_PRODUCTION_DUMP=1' 'the dump-gated suites are actually enabled'

section 'the thresholds are exact'

has "$R" '[ "$DUMP_SKIPPED" = ' 'a skipped dump test is a failure'
has "$R" 'were skipped — the dump was not actually exercised' 'skipping is named as not exercising the dump'
has "$R" '[ "$DUMP_PASSED" = ' "49 is required exactly"
has "$R" '/49 dump-gated tests passed' 'the message names the shortfall'
has "$R" '[ "$INV_PASS" = ' '32 invariants are required exactly'
has "$R" '/32 invariants passed' 'the invariant message names the shortfall'

# A threshold expressed as >= would pass a suite that grew a test and lost one.
if grep -qE '\-ge (49|32)|\-gt (48|31)' "$R"; then
  bad 'the thresholds are equality, not inequality' 'an inequality is used'
else
  ok 'the thresholds are equality, not inequality'
fi

section 'the financial comparison can actually fail'

has "$R" 'balance_irr <> coalesce' 'it compares stored balance against its entries'
has "$R" 'FIN_DRIFT' 'it counts disagreements'
has "$R" 'that is a stop, not a warning' 'a mismatch stops the run'
# The first draft compared one query with itself, which is a check that cannot
# fail and therefore is not one.
if grep -q 'cannot fail and therefore is not one' "$R"; then
  ok 'the self-comparing version is recorded as the mistake it was'
else
  bad 'the self-comparing version is recorded' 'the note is gone'
fi

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

has "$R" 'CURRENT_PRODUCTION_IMAGE' 'the current production image is named by config'
has "$R" 'OLD_APP_SCHEMA_COMPAT' 'compatibility is measured'
has "$R" 'image rollback would be void' 'a failure explains what it costs'
# It must be checked BEFORE the attestation is written.
compat=$(grep -n 'OLD_APP_SCHEMA_COMPAT" = ' "$R" | head -1 | cut -d: -f1)
write=$(grep -n 'bash "$HERE/write-dump-attestation.sh"' "$R" | head -1 | cut -d: -f1)
if [ -n "$compat" ] && [ -n "$write" ] && [ "$compat" -lt "$write" ]; then
  ok 'compatibility is required before the attestation is written'
else
  bad 'compatibility is required before the attestation is written' "compat@${compat:-?} write@${write:-?}"
fi

section 'the attestation is written last, atomically, and verified'

# Every measurement gate must precede the write. Partial success is not
# evidence, and an attestation is the one artifact that must never be optimistic.
for gate in 'DUMP_SKIPPED' 'DUMP_PASSED' 'INV_PASS' 'FINANCIAL_TOTALS' 'RESTORE_RESULT' 'OLD_APP_SCHEMA_COMPAT'; do
  g=$(grep -n "\[ \"\$${gate}\"" "$R" | head -1 | cut -d: -f1)
  if [ -n "$g" ] && [ "$g" -lt "$write" ]; then
    ok "${gate} is gated before the attestation is written"
  else
    bad "${gate} is gated before the attestation is written" "gate@${g:-?} write@${write}"
  fi
done
has "$R" '.attestation.env.new' 'the attestation is staged before being moved into place'
has "$R" 'still parses' 'the reason for atomicity is recorded'
has "$R" '/var/lib/shikoo/production' 'it writes to the directory Prepare Production reads'
has "$R" 'sha256sum -c --status attestation.sha256' 'the checksum is verified immediately'
has "$R" 'verify-dump-attestation.sh' 'the verifier is run against the same release'
has "$R" 'EXPECTED_STAGING_RUN_ID=' 'verification pins the staging run too'

section 'it cleans up however it ends'

has "$R" 'trap cleanup EXIT INT TERM' 'cleanup runs on exit, interrupt and terminate'
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
