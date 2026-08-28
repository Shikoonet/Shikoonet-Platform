#!/usr/bin/env bash
# A recovery point for Coolify environment rows, taken before any are deleted.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY A ROW LIST IS NOT A BACKUP
#
# The obvious snapshot — id, key, application — is the one that is safe to read,
# and it cannot restore anything. Deleting the wrong `DATABASE_URL` row leaves
# nothing to put back: the value is gone, and no inventory of keys will bring it
# back. Calling that snapshot "reversible" is how a cleanup becomes an outage.
#
# So this writes the rows AS STORED — Laravel's ciphertext, untouched and
# undecrypted — to a root-owned 0600 file, and writes the readable inventory
# separately. The first is the recovery path and nobody reads it; the second is
# what a person reviews.
#
# ── The dependency nobody writes down ──────────────────────────────────────
#
# The ciphertext is only restorable while Coolify's APP_KEY is the same key. A
# backup taken across a key rotation restores rows that decrypt to nothing, and
# it will look completely healthy until something tries to boot.
#
# This script does NOT check that, and says so rather than implying it: it
# holds no Coolify API token, and reading APP_KEY to test it would be reading
# the one secret whose disclosure invalidates every row in the file.
#
# `classify-duplicate-envs.sh` is what proves it, as a side effect of the work
# it already does: it asks Coolify's own API to decrypt these variables, so a
# successful classification IS the evidence that the current key still opens
# these rows. Hence the order in the runbook — classify first, back up second,
# delete third — which is not the order it looks like it should be.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: backup-coolify-env.sh <out-dir> <uuid> [uuid...]
#
# Requires root: the output holds encrypted secrets and is chmod 600. Refusing
# to run unprivileged is deliberate — a 0600 file owned by a deploy user is
# readable by that user's every process.

set -Eeuo pipefail

OUT=${1:-}
shift || true
if [ -z "$OUT" ] || [ "$#" -eq 0 ]; then
  echo "usage: backup-coolify-env.sh <out-dir> <uuid> [uuid...]" >&2
  exit 2
fi

COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}
say() { echo "[env-backup] $*"; }
die() {
  echo "[env-backup] REFUSED: $*" >&2
  exit 1
}

# Not a root requirement, and the reason matters.
#
# The obvious rule is "only root may write a file of encrypted secrets". But the
# user that runs this is the deploy user, and the deploy user holds the Coolify
# API token — so it can already read every one of these values in PLAINTEXT, at
# will, through the API. A file of ciphertext it could already decrypt adds no
# exposure it does not already have.
#
# What does matter is that nobody ELSE gains access, so the file is 0600 in a
# 0700 directory and that is asserted rather than assumed. Demanding root would
# have meant either a sudo rule or running the release as root, both of which
# widen the blast radius to buy a guarantee that was already there.
umask 077

for uuid in "$@"; do
  [[ $uuid =~ ^[a-z0-9]{20,32}$ ]] || die "'$uuid' is not a Coolify application uuid"
done

coolify_db() { docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' -c "$1"; }

# `quote_literal` and `quote_nullable` do the escaping in the database, which is
# the only place that knows its own rules. Building INSERTs by string-joining in
# shell is how a value containing a quote becomes a syntax error at 3am, on the
# one file whose whole job is to still work then.
list=''
for uuid in "$@"; do list="${list}${list:+,}'${uuid}'"; done

mkdir -p "$OUT"
chmod 700 "$OUT"
ROWS="$OUT/coolify-env-rows.sql"
INVENTORY="$OUT/inventory.tsv"

# Written 0600 BEFORE anything goes into it, so there is no window in which the
# ciphertext sits under a default umask.
umask 077
: >"$ROWS"
chmod 600 "$ROWS"

{
  printf -- '-- Coolify environment_variables, as stored. Encrypted; never decrypted here.\n'
  printf -- '-- Restore one row:  docker exec -i %s psql -U coolify -d coolify -c "<the INSERT>"\n' "$COOLIFY_DB_CONTAINER"
  printf -- '-- Only valid while Coolify APP_KEY is unchanged. Continuity is proven by a\n'
  printf -- '-- successful classify-duplicate-envs.sh run, not by this file.\n'
  coolify_db "select 'INSERT INTO environment_variables (id, key, value, is_preview, is_shown_once, is_multiline, version, is_literal, uuid, \"order\", is_required, is_shared, resourceable_type, resourceable_id, is_runtime, is_buildtime, comment, created_at, updated_at) VALUES ('
    || ev.id || ', ' || quote_literal(ev.key) || ', ' || quote_nullable(ev.value) || ', '
    || ev.is_preview || ', ' || ev.is_shown_once || ', ' || ev.is_multiline || ', '
    || quote_literal(ev.version) || ', ' || ev.is_literal || ', ' || quote_literal(ev.uuid) || ', '
    || coalesce(ev.\"order\"::text, 'NULL') || ', ' || ev.is_required || ', ' || ev.is_shared || ', '
    || quote_nullable(ev.resourceable_type) || ', ' || coalesce(ev.resourceable_id::text, 'NULL') || ', '
    || ev.is_runtime || ', ' || ev.is_buildtime || ', ' || quote_nullable(ev.comment) || ', '
    || quote_nullable(ev.created_at::text) || ', ' || quote_nullable(ev.updated_at::text) || ');'
    from environment_variables ev
    join applications a on a.id = ev.resourceable_id and ev.resourceable_type = 'App\\Models\\Application'
    where a.uuid in (${list}) order by ev.id;"
} >>"$ROWS" || die "could not read the environment rows from ${COOLIFY_DB_CONTAINER}"

# Verified, not assumed. An empty recovery file is the failure mode that looks
# exactly like success until the moment it is needed.
inserts=$(grep -c '^INSERT INTO environment_variables' "$ROWS" || true)
[ "${inserts:-0}" -gt 0 ] ||
  die "the recovery file contains no rows — refusing to report a backup that would restore nothing"

# The readable half. Ids, keys and applications; no values, ever. This is the
# artefact a person reviews and quotes.
umask 022
coolify_db "select a.name, a.uuid, ev.id, ev.key,
    count(*) over (partition by ev.resourceable_id, ev.key) as copies
  from environment_variables ev
  join applications a on a.id = ev.resourceable_id and ev.resourceable_type = 'App\\Models\\Application'
  where a.uuid in (${list}) order by a.name, ev.key, ev.id;" >"$INVENTORY" ||
  die "could not write the redacted inventory"

say "wrote ${inserts} encrypted row(s) to ${ROWS} (0600, root)"
say "wrote the redacted inventory to ${INVENTORY}"
say "restore a row with: docker exec -i ${COOLIFY_DB_CONTAINER} psql -U coolify -d coolify -f - <<< '<the INSERT line>'"
