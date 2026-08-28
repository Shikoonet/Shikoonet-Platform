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

section 'row identity is the API uuid, never a numeric id'

# The first run died with `KeyError: 'id'` before mutating anything — a real
# bug with a lucky outcome. This Coolify serialises environment variables with
# a `uuid` and NO numeric `id`: measured live, 14/14 rows carry `uuid`, 0/14
# carry `id`.
if grep -nE 'r\["id"\]|r\.get\("id"\)' "$RUNNER" | grep -qv '^[0-9]*:#'; then
  bad 'no code indexes a numeric id on an API row' 'r["id"] is still used'
else
  ok 'no code indexes a numeric id on an API row'
fi
has "$RUNNER" 'r.get("uuid")' 'rows are addressed by uuid'
has "$RUNNER" 'db_id_for' 'a database id is resolved rather than assumed'
has "$RUNNER" "ev.uuid = " 'the mapping keys on the exact row uuid'
has "$RUNNER" 'resourceable_type' 'the mapping constrains resourceable_type'
has "$RUNNER" "a.uuid = " 'the mapping constrains the owning application'
has "$RUNNER" 'expected exactly 1' 'a uuid matching other than one database row stops the run'
has "$RUNNER" 'refusing to act on rows this API cannot address' 'a row without a uuid is refused'

# Correlating by position in a JSON array works until the array is ordered
# differently, which is the kind of bug that only appears in production.
# Narrowed to indexing of the PARSED RESPONSE. `${BASH_SOURCE[0]}` is a bash
# array subscript and has nothing to do with row correlation; a pattern broad
# enough to catch it is a pattern that will be silenced rather than fixed.
if grep -qE 'd\[[0-9]+\]|rows\[[0-9]+\]|enumerate\(|zip\(' "$RUNNER"; then
  bad 'rows are never correlated by response order' 'positional indexing of the response found'
else
  ok 'rows are never correlated by response order'
fi

section 'the canonical decrypted field is value, not real_value'

# `value` is cast `encrypted` on the model, so the serialiser returns plaintext.
# `real_value` is an appended accessor that also resolves shared variables and
# then runs escapeEnvVariables(), quoting literal and multiline values — a
# shell-ready rendering, which is the wrong thing to compare.
has "$RUNNER" 'r.get("value")' 'classification reads value'
if grep -q 'real_value' "$RUNNER"; then
  if grep -n 'real_value' "$RUNNER" | grep -qv ':#'; then
    bad 'real_value is never read as the canonical field' 'it is used in code'
  else
    ok 'real_value is never read as the canonical field'
  fi
else
  ok 'real_value is never read as the canonical field'
fi

section 'no secret reaches process argv'

SIO="$ROOT/deploy/coolify-secret-io.sh"
# `ps` is readable by every process on the host, so a token in a URL argument
# is a token handed to anybody logged in.
if grep -qE 'curl .*api\.telegram\.org' "$RUNNER"; then
  bad 'the bot token never appears in a curl argument' 'a telegram URL is built inline'
else
  ok 'the bot token never appears in a curl argument'
fi
if grep -qE 'psql "\$[A-Za-z_]*(URL|url)' "$RUNNER"; then
  bad 'the database URL never appears in a psql argument' 'a URL is passed positionally'
else
  ok 'the database URL never appears in a psql argument'
fi
has "$SIO" 'curl -K' 'the telegram request is configured from a file'
has "$SIO" 'PGSERVICEFILE' 'libpq is configured from a service file'
has "$SIO" 'chmod 600' 'the credential files are 0600'
has "$SIO" 'rm -f' 'the credential files are removed after use'
has "$RUNNER" 'trap cleanup_all EXIT INT TERM' 'credentials are cleaned up on signal as well as exit'
has "$RUNNER" 'tg_get_me' 'the runner uses the secret-safe telegram helper'
has "$RUNNER" 'pg_host_of' 'the runner classifies a database URL by parsing it'
# It must not dial. There is no psql on the host and Coolify hostnames do not
# resolve outside the container network, so a connecting version reports every
# row unreachable — and classifying a row as production by connecting TO
# production is the wrong way to learn you should not touch it.
# Comment lines excluded: the header records the removed shape on purpose, so
# a future reader knows what it used to do and why it could not work.
if grep -v '^[[:space:]]*#' "$SIO" | grep -qE '\bpsql\b'; then
  bad 'the database classifier opens no connection' 'it calls psql'
else
  ok 'the database classifier opens no connection'
fi

# Only the public half of each answer may be reported.
has "$SIO" 'p.hostname' 'only the hostname is taken from a database URL'
if grep -qE 'password|p\.username' "$SIO" | grep -v '^#'; then
  bad 'the credential halves of the URL are discarded' 'they are read'
else
  ok 'the credential halves of the URL are discarded'
fi
if grep -A4 'tg_get_me' "$SIO" | grep -qE 'print\(.*token|echo .*token'; then
  bad 'the telegram helper never echoes the token' 'it does'
else
  ok 'the telegram helper never echoes the token'
fi

section 'partial cleanup survives a blocked bot row'

# An unresolved bot token must leave shikoo-dev-bot undeployable WITHOUT
# preventing ingest and dashboard from being cleaned — otherwise one ambiguous
# row blocks the whole release.
has "$RUNNER" 'BLOCKED=' 'blocked keys are tracked separately from dropped rows'
if awk '/^classify_bot/,/^}/' "$RUNNER" | grep -q 'die '; then
  bad 'an ambiguous bot token does not abort the run' 'classify_bot can die'
else
  ok 'an ambiguous bot token does not abort the run'
fi
has "$RUNNER" 'still duplicated and deliberately untouched' 'it reports what it left alone'
has "$RUNNER" 'will still refuse those applications' 'it says which applications stay undeployable'

section 'the recovery backup covers every deleted row'

has "$RUNNER" 'is not in the recovery backup' 'a row absent from the backup is never deleted'
has "$RUNNER" 'DROP_DBIDS' 'deleted database ids are recorded as evidence'
has "$RUNNER" 'env_backup_owner' 'the evidence records the real backup owner'
has "$RUNNER" 'env_backup_mode' 'the evidence records the real backup mode'
if grep -q '0600, root' "$ROOT/deploy/backup-coolify-env.sh"; then
  bad 'the backup no longer claims root ownership it does not have' 'the claim is still there'
else
  ok 'the backup no longer claims root ownership it does not have'
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
