#!/usr/bin/env bash
# The Step-E runner, and the four ways it must refuse.
#
# It deletes rows from a live Coolify. The interesting cases are therefore not
# "does it delete the right one" but "does it decline to delete anything" when
# the world is not what it expected — because the cost of a wrong deletion is a
# staging application that boots against production's database.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUNNER="$ROOT/deploy/step-e-runner.sh"
BACKUP_CFG="$ROOT/deploy/ensure-staging-backup.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }
has() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3" "missing: $2"; fi; }
hasnt() { if grep -qF -- "$2" "$1"; then bad "$3" "present: $2"; else ok "$3"; fi; }

section 'the production bot id is a disqualifier, not a target'

# The brief named @Test_Shikoo_bot / 8856185613 as the intended dedicated
# staging identity. It is not: it is what the PRODUCTION bot polls with, proven
# from production's own settings row and from getMe. A staging bot holding it
# would take customer messages away from the live bot, silently, with both
# looking healthy. So the runner treats that id as disqualifying.
has "$RUNNER" 'PRODUCTION_BOT_ID' 'the production bot id is named explicitly'
has "$RUNNER" '8856185613' 'the known production bot id is pinned'
has "$RUNNER" 'PRODUCTION-BOT' 'a row resolving to it is labelled as the production bot'
has "$RUNNER" 'both rows left untouched' 'an ambiguous token leaves both rows alone'

# It must never be in a "keep" branch.
if awk '/^classify_bot/,/^}/' "$RUNNER" | grep -q 'PRODUCTION_BOT_ID.*keep=\|keep=.*PRODUCTION_BOT_ID'; then
  bad 'the production bot is never a keep candidate' 'it appears in a keep branch'
else
  ok 'the production bot is never a keep candidate'
fi

section 'it refuses before mutating'

has "$RUNNER" 'flock -n 9' 'it locks against a concurrent run'
has "$RUNNER" 'sha256sum -c --status' 'it verifies the contract attestation checksum'
has "$RUNNER" 'schema_version=2' 'it requires a schema-2 attestation'
has "$RUNNER" "not in the recovery backup" 'it refuses to delete a row absent from the backup'
has "$RUNNER" 'is in environment' 'it proves each application is in dev-fleet'
has "$RUNNER" 'expected f|f' 'it refuses if auto-deploy is already on'
has "$RUNNER" 'refusing to continue on a moved target' 'it refuses if a row moved between classify and delete'

section 'it never reads or writes production'

hasnt "$RUNNER" "e.name = 'production'" 'it never selects production applications'
has "$RUNNER" "e.name = 'dev-fleet'" 'every lookup is constrained to dev-fleet'
has "$BACKUP_CFG" 'refusing' 'the backup configurator refuses if the lookup returns production'
has "$BACKUP_CFG" 'PROD_UUID' 'the backup configurator compares against the production uuid'

section 'it never exposes a value'

# Values are read — that is the whole job — and must never be printed. The
# verdicts are what the operator reads.
if grep -nE '\$\(value_of' "$RUNNER" | grep -qE 'say |echo |printf .*value'; then
  bad 'no classifier prints a decrypted value' 'a value reaches output'
else
  ok 'no classifier prints a decrypted value'
fi
has "$RUNNER" 'md5(value)' 'kept rows are compared by digest, never by value'
hasnt "$RUNNER" 'source ' 'it never sources the deploy.env'
has "$RUNNER" 'coolify_api_init' 'the token is read as text through the shared client'

section 'mutation is the supported API, never the database'

has "$RUNNER" 'coolify_api DELETE' 'deletion goes through the API'
if grep -E 'coolify_db "' "$RUNNER" | grep -qiE 'delete from|update |insert into'; then
  bad 'it never writes to the Coolify database directly' 'a write statement is present'
else
  ok 'it never writes to the Coolify database directly'
fi

section 'the dry run is the default'

has "$RUNNER" 'APPLY=0' 'it defaults to not applying'
has "$RUNNER" 'DRY RUN' 'it says so when it changes nothing'
has "$BACKUP_CFG" 'DRY RUN' 'the backup configurator also defaults to a dry run'

section 'the backup payload is the documented one'

for f in frequency enabled save_s3 dump_all backup_now database_backup_retention_amount_locally timeout; do
  has "$BACKUP_CFG" "$f" "the payload field ${f} is one Coolify validates"
done
# Anything outside the validator's list would be silently dropped, which is how
# `is_auto_deploy_enabled` was discarded at create time.
if grep -oE '"[a-z_0-9]+":' "$BACKUP_CFG" | sort -u | grep -vE '"(frequency|enabled|save_s3|dump_all|backup_now|database_backup_retention_amount_locally|timeout)":' | grep -q .; then
  bad 'no undocumented field is sent' "$(grep -oE '"[a-z_0-9]+":' "$BACKUP_CFG" | sort -u | tr '\n' ' ')"
else
  ok 'no undocumented field is sent'
fi

section 'evidence carries no secret'

has "$RUNNER" 'step-e-evidence.env' 'it writes an evidence manifest'
has "$RUNNER" 'sha256sum step-e-evidence.env' 'the evidence is checksummed'
if awk '/^EVIDENCE=/,/^} >/' "$RUNNER" | grep -qE 'value|token|password|DATABASE_URL'; then
  bad 'the evidence manifest holds no value, token or URL' 'one appears'
else
  ok 'the evidence manifest holds no value, token or URL'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
