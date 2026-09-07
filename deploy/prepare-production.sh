#!/usr/bin/env bash
# P1–P10: everything a production release can do while customers are elsewhere.
#
# ─────────────────────────────────────────────────────────────────────────────
# Runs on the box. Creates nothing customers can see, moves no domain, and never
# touches the production bot. When it finishes, the candidates are serving the
# new digest on temporary domains against the migrated schema, and the old
# applications are still answering every live request.
#
# ── Why this delegates rather than reimplements ───────────────────────────
#
# The migrate → ingest → dashboard → smoke-test → assert-digest → roll-back
# sequence already exists, tested, in `deploy.sh`. A second copy here would be a
# second thing to keep in step, and the copy that drifts is the one running
# during an incident. So this file does the parts that are genuinely new —
# backups, duplicate cleanup, ensuring the canonical applications exist — and
# hands the rolling to `deploy.sh` with the candidate uuids.
#
# ── The order is load-bearing ─────────────────────────────────────────────
#
# Backups before mutations, because a recovery point taken after the thing it
# was meant to recover from is not one. Duplicate cleanup before candidates,
# because `deploy.sh` refuses an application with a duplicated key and finding
# that out after creating three is a wasted run. Candidates created STOPPED
# before the migration, because an image that needs schema 37 must never start
# against schema 34.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: prepare-production.sh <sha> <digest> <staging_run_id>

set -Eeuo pipefail

SHA_ARG=${1:-}
DIGEST_ARG=${2:-}
STAGING_RUN=${3:-}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

ENV_ARG=production
CONF=${CONF:-/etc/shikoo/$ENV_ARG/deploy.env}
STATE=${STATE:-/var/lib/shikoo/$ENV_ARG}
BACKUP_DIR=${BACKUP_DIR:-$STATE/backups}
ATTESTATION=${ATTESTATION:-$STATE/attestation}
# The comment here used to say this path took the production release lock. It
# did not — there was no flock anywhere in this script, so Prepare could read
# `current` in the middle of the rehearsal's swap. Both sides now use one
# protocol from one file, and this is the side that actually acquires it.
# shellcheck source=deploy/attestation-store.sh
. "$HERE/attestation-store.sh"

say() { echo "[prepare] $*"; }
die() {
  echo "[prepare] STOP: $*" >&2
  exit 1
}

[[ $SHA_ARG =~ ^[0-9a-f]{40}$ ]] || die "sha '$SHA_ARG' is not a commit sha"
[[ $DIGEST_ARG =~ ^sha256:[0-9a-f]{64}$ ]] || die "digest '$DIGEST_ARG' is not immutable"
[[ $STAGING_RUN =~ ^[0-9]{1,20}$ ]] || die "staging run id '$STAGING_RUN' is not a run id"
[ -r "$CONF" ] || die "cannot read $CONF — run as the shikoo-deploy user"

# ── the dump rehearsal, before anything at all ────────────────────────────
#
# First act, deliberately. It lives on this host because the dump may not leave
# it, so it cannot be checked in the workflow gate — but it is checked before a
# migration, a Coolify write or a ledger line, which is what the ordering was
# for.
say "P0. the production-dump rehearsal covers this release"
# The ROOT is passed, not a version directory. Resolving the pointer here and
# handing the result to the verifier looked tidier and was worse: the verifier
# then had a directory chosen by its caller, took its standalone branch, and
# checked the whole attestation with no lock held. One resolution, inside the
# verifier, under the shared lock, for the whole read.
EXPECTED_SHA="$SHA_ARG" EXPECTED_DIGEST="$DIGEST_ARG" \
  EXPECTED_STAGING_RUN_ID="$STAGING_RUN" \
  bash "$HERE/verify-dump-attestation.sh" "$ATTESTATION" ||
  # NOT «the dump attestation does not cover this release». That sentence was
  # pasted over every non-zero exit of the verifier — a missing lock file, an
  # unresolvable pointer, an unreadable directory — and it names a cause the
  # caller has not established. It cost a real diagnosis twice: on 2026-08-28
  # over «no attestation.env», and on 2026-09-07 over a release lock that did
  # not exist, where it sent the reader off to re-run a rehearsal that would
  # have died at the identical line. The verifier has already printed the
  # precise reason as `::error::` and the store has printed the mechanism as
  # `[att]`; both reach the log, so the only job left here is not to overwrite
  # them. This is the rule verify-dump-attestation.sh's own header argues for —
  # missing, malformed, stale and mismatched are different failures — applied
  # one level up, where it had been lost.
  die "P0 refused — the ::error:: line above says which check failed"

# ── P1/P2. recovery points ────────────────────────────────────────────────
say "P1/P2. snapshot and encrypted Coolify recovery backup"
cfg() { sed -n "s/^$1=//p" "$CONF" | head -n1; }
OLD_INGEST=$(cfg APP_INGEST)
OLD_DASHBOARD=$(cfg APP_DASHBOARD)
OLD_BOT=$(cfg APP_BOT)
for v in "$OLD_INGEST" "$OLD_DASHBOARD" "$OLD_BOT"; do
  [ -n "$v" ] || die "$CONF does not name all three current production applications"
done

ENV_BACKUP_ID="envbak-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$STATE/env-backups"
bash "$HERE/backup-coolify-env.sh" "$STATE/env-backups/$ENV_BACKUP_ID" \
  "$OLD_INGEST" "$OLD_DASHBOARD" "$OLD_BOT" ||
  die "the Coolify recovery backup failed — nothing is deleted or created without one"

# ── P3. database backup, and a restore that proves it ─────────────────────
say "P3. database backup and restore proof"
BACKUP_ID="backup-$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"

# ── the backup this step is named after, which was never actually taken ───
#
# `BACKUP_ID` was minted here, written into the preparation manifest, and then
# nothing wrote a file. The directory was created empty and left that way, so
# the manifest recorded a recovery point that did not exist — and cutover, which
# refuses unless `backup_present=present` (observe-production.sh:94-98,
# verify-preparation-manifest.sh:97), could never pass. Two checks agreeing
# about a backup nobody had taken.
#
# `-Fc` because that is what `pg_restore` reads, and the restore drill is the
# only reason to keep a dump at all. Written to a temporary name and renamed
# only after `pg_dump` succeeds: a half-written dump that is 1 KB and growing
# satisfies the «present» probe exactly like a real one.
BACKUP_DB=$(cfg PGDATABASE)
BACKUP_DB=${BACKUP_DB:-shikoo}
BACKUP_CONTAINER=$(cfg DB_CONTAINER)
[ -n "$BACKUP_CONTAINER" ] || die "$CONF does not name DB_CONTAINER — cannot take the pre-migration backup"
BACKUP_USER=$(cfg PGUSER)
[ -n "$BACKUP_USER" ] ||
  BACKUP_USER=$(docker exec "$BACKUP_CONTAINER" printenv POSTGRES_USER 2>/dev/null || true)
BACKUP_USER=${BACKUP_USER:-postgres}
BACKUP_TMP="$BACKUP_DIR/.$BACKUP_ID.dump.partial"
rm -f "$BACKUP_TMP"
# Created 0600 BEFORE a byte of it exists. The shell applies the process umask
# to a `>` redirection, so on a default umask this file was world-readable for
# the whole time pg_dump streamed the customer database into it, and the chmod
# below only closed the window after the last row had already gone through it.
( umask 077; : >"$BACKUP_TMP" ) || die "cannot create $BACKUP_TMP"
docker exec "$BACKUP_CONTAINER" pg_dump -U "$BACKUP_USER" -d "$BACKUP_DB" -Fc >"$BACKUP_TMP" || {
  rm -f "$BACKUP_TMP"
  die "pg_dump of $BACKUP_DB failed — nothing is migrated without a recovery point"
}
# A dump that restores into nothing is the failure that looks like success, so
# the size is asserted rather than hoped for. The probe cutover uses is >1k.
[ "$(stat -c '%s' "$BACKUP_TMP")" -gt 1024 ] || {
  rm -f "$BACKUP_TMP"
  die "the pre-migration dump is under 1 KB — that is not a backup of this database"
}
chmod 600 "$BACKUP_TMP"
mv -f "$BACKUP_TMP" "$BACKUP_DIR/$BACKUP_ID.dump"
say "    pre-migration dump: $BACKUP_DIR/$BACKUP_ID.dump ($(stat -c '%s' "$BACKUP_DIR/$BACKUP_ID.dump") bytes)"

# `restore-drill.sh` finds the newest dump itself, restores it into a throwaway
# database beside the real one, checks what came back is the database we think
# it is, and tears it down. It needs root.
#
# ── Why this no longer tries to run it, and what it checks instead ────────
#
# This used to demand root or blanket passwordless sudo, and on this host it
# gets neither: the only sudo grant is `hessamx` limited to fixed task-runner
# subcommands, and the installer's own negative test asserts that
# `restore-drill-production` is NOT among them. So P3 could not pass, and the
# only ways to make it pass were to give the deploy account a passwordless root
# command on production or to hand the runner a production drill — widening the
# blast radius of a release path, to prove a backup.
#
# There was already a better answer in the repository. The drill writes a
# non-secret, checksummed attestation of exactly what it proved, and the task
# runner already lists it as evidence. So P3 verifies THAT, and the drill is run
# beforehand by the owner — the same shape as the Coolify contract attestation
# that P5 requires, for the same reason: the proof has to exist before the
# release, and the release only has to be able to read it.
#
# The inline path is kept for the case where preparation legitimately has root,
# so nothing is lost where the privilege already exists.
# `/var/lib/shikoo`, not `$STATE` — the drill writes ONE attestation for the
# whole host (restore-drill.sh:94,276), not one per environment. That is also
# why the `environment=` field below is checked rather than assumed: a staging
# drill overwrites this same file, and `restore-drill-staging` is the drill the
# task runner actually grants.
RESTORE_STATE=${RESTORE_STATE:-/var/lib/shikoo}
RESTORE_ATT=${RESTORE_ATT:-$RESTORE_STATE/restore-attestation.env}
RESTORE_MAX_AGE_H=${RESTORE_MAX_AGE_H:-48}
if [ "$(id -u)" = '0' ]; then
  sh "$HERE/restore-drill.sh" ||
    die "the restore of the newest backup could not be proven — refusing to migrate production on it"
  say "P3. restore drill run inline (this preparation has root)"
else
  # Checksum first, before a single field is read — same order as the dump
  # attestation, and for the same reason.
  [ -r "$RESTORE_ATT" ] ||
    die "no restore attestation at $RESTORE_ATT — run the drill on this host first (sudo sh /usr/local/lib/shikoo-step-e/restore-drill.sh production), then re-dispatch. The migration below has no recovery path until a restore has actually been proven, and a backup nobody has restored is a belief rather than a backup."
  # ── who wrote it matters more than what it says ──────────────────────────
  #
  # This attestation is trusted BECAUSE root produced it. A checksum proves the
  # file is internally consistent, and this account can compute one — so if
  # `shikoo-deploy` could write here, preparation could write itself the proof
  # that preparation is safe, and P3 would be a mirror rather than a control.
  # Ownership is therefore checked before a field is read, exactly as
  # `att_require_lock_file` does for the release lock.
  for f in "$RESTORE_ATT" "$(dirname "$RESTORE_ATT")/restore-attestation.sha256"; do
    [ ! -L "$f" ] || die "$f is a symlink — refusing to read the restore proof through it"
    [ -f "$f" ] || die "$f is missing or not a regular file"
    [ "$(stat -c '%u' "$f")" = '0' ] ||
      die "$f is owned by uid $(stat -c '%u' "$f"), not root — a restore proof this account could write proves nothing"
    # `-perm /022` is «group-write OR other-write set», which is the whole
    # question. A glob over the mode string answers only about the last digit,
    # so `0660` — group-writable, and the mode a careless chmod produces — would
    # have read as safe.
    [ -z "$(find "$f" -maxdepth 0 -perm /022 -print 2>/dev/null)" ] ||
      die "$f is group- or world-writable (mode $(stat -c '%a' "$f")) — anyone who can rewrite it can forge the restore proof"
  done
  ( cd "$(dirname "$RESTORE_ATT")" && sha256sum -c --status restore-attestation.sha256 ) ||
    die "the restore attestation does not match its checksum — it was altered after the drill wrote it"
  rfield() { sed -n "s/^$1=//p" "$RESTORE_ATT" | head -1; }
  [ "$(rfield schema_version)" = '1' ] ||
    die "unsupported restore attestation schema_version '$(rfield schema_version)'"
  # The environment, because a staging drill proves nothing about production's
  # backups — and `restore-drill-staging` is the one the runner DOES grant, so
  # this is the confusion most likely to actually happen.
  [ "$(rfield environment)" = "$ENV_ARG" ] ||
    die "the restore attestation is for environment '$(rfield environment)', not $ENV_ARG"
  for f in migration_checksums:pass invariants:pass scratch_dropped:yes; do
    [ "$(rfield "${f%%:*}")" = "${f##*:}" ] ||
      die "the restore attestation does not record ${f%%:*}=${f##*:} — the drill did not prove what P3 requires"
  done
  # `yes` (already current) or `prefix` (an initial run with a pending tail).
  # Both mean no unknown migration, no gap and no drifted checksum; before the
  # first cutover the honest answer is `prefix`, and demanding `yes` here would
  # re-create the contradiction the drill was just fixed for.
  case "$(rfield migration_set_exact)" in
    yes | prefix) ;;
    *) die "the restore attestation records migration_set_exact='$(rfield migration_set_exact)' — the restored ledger is not an initial run of the shipped migrations" ;;
  esac
  # Freshness. An old drill proves an old backup, and the one this release will
  # fall back to is the newest one.
  att_epoch=$(date -u -d "$(rfield created_at)" +%s 2>/dev/null) ||
    die "the restore attestation has an unreadable created_at"
  age_h=$(( ( $(date -u +%s) - att_epoch ) / 3600 ))
  [ "$age_h" -ge 0 ] ||
    die "the restore attestation is dated in the future — refusing to reason about it"
  [ "$age_h" -le "$RESTORE_MAX_AGE_H" ] ||
    die "the restore attestation is ${age_h}h old, older than the ${RESTORE_MAX_AGE_H}h this release accepts — run the drill again and re-dispatch"
  say "P3. restore proven by attestation: dump $(rfield dump_file), ledger $(rfield schema_migrations), ${age_h}h old"
fi

# ── P4. the exact duplicate row ───────────────────────────────────────────
#
# Classification is read-only and prints no value; the deletion is by the exact
# row id it identified. Refused rather than guessed if the classification is
# ambiguous — two rows that mean the same thing still have to be told apart by
# something other than hope.
say "P4. duplicate environment rows"
bash "$HERE/classify-duplicate-envs.sh" "$ENV_ARG" "$OLD_INGEST" "$OLD_DASHBOARD" "$OLD_BOT" ||
  die "duplicate classification failed — refusing to delete a row nobody has identified"

# ── P5. the canonical applications, stopped ───────────────────────────────
say "P5. canonical Docker Image applications"
CANDIDATES=$(bash "$HERE/ensure-production-candidates.sh" "$ENV_ARG") ||
  die "could not ensure the production candidates exist"
CAND_INGEST=$(printf '%s' "$CANDIDATES" | sed -n 's/^candidate_ingest=//p')
CAND_DASHBOARD=$(printf '%s' "$CANDIDATES" | sed -n 's/^candidate_dashboard=//p')
CAND_BOT=$(printf '%s' "$CANDIDATES" | sed -n 's/^candidate_bot=//p')
CREATED_COUNT=$(printf '%s' "$CANDIDATES" | sed -n 's/^applications_created=//p')
for v in "$CAND_INGEST" "$CAND_DASHBOARD" "$CAND_BOT"; do
  [ -n "$v" ] || die "the candidate applications were not all identified"
done
say "    candidates: ingest=${CAND_INGEST} dashboard=${CAND_DASHBOARD} bot=${CAND_BOT} (created ${CREATED_COUNT})"

# ── P5b. the temporary domains ────────────────────────────────────────────
#
# Nothing did this, and P10 has always required its result. `observe-production`
# probes `sms-next` and `shikoo-next`; `ensure-production-candidates.sh` creates
# the candidates deliberately domainless ("no domain, no ports published,
# auto-deploy off") and no later step gave them one. So `temp_domain_verify`
# could only ever read `fail`, and a preparation that had done everything else
# perfectly would die at its own verification — the whole point of preparing on
# temporary names being that they are reachable.
#
# The temporary names, not the live ones. Moving `shikoo.chopon.uk` or
# `sms.chopon.uk` is `cutover-production.sh`, a separate dispatch; this only
# ever writes the `-next` names, and it refuses if a live name is what it was
# handed.
TEMP_INGEST_URL=${TEMP_INGEST_URL:-https://sms-next.chopon.uk}
TEMP_DASHBOARD_URL=${TEMP_DASHBOARD_URL:-https://shikoo-next.chopon.uk}
export TEMP_INGEST_URL TEMP_DASHBOARD_URL
say "P5b. temporary domains ${TEMP_INGEST_URL} and ${TEMP_DASHBOARD_URL}"

LIVE_INGEST_DOMAIN=${LIVE_INGEST_DOMAIN:-sms.chopon.uk}
LIVE_DASHBOARD_DOMAIN=${LIVE_DASHBOARD_DOMAIN:-shikoo.chopon.uk}
# The HOSTNAME is compared, not the URL string. Exact-string matching looked
# sufficient and was not: `https://sms.chopon.uk:443`, a trailing slash, a path,
# or any change of case all slip past it — and Coolify lowercases and keeps the
# port, so the PATCH would have handed a candidate the live customer hostname
# while this guard read «not a live domain». The one thing this must never do,
# defeated by a colon.
host_of() { # url -> lowercased hostname, no scheme, no port, no path
  local h=${1#*://}
  h=${h%%/*}
  h=${h%%\?*}
  h=${h##*@}
  h=${h%%:*}
  printf '%s' "$h" | tr 'A-Z' 'a-z'
}
for u in "$TEMP_INGEST_URL" "$TEMP_DASHBOARD_URL"; do
  case "$u" in
    https://* | http://*) ;;
    *) die "temporary domain '$u' is not an http(s) URL" ;;
  esac
  h=$(host_of "$u")
  [ -n "$h" ] || die "temporary domain '$u' has no hostname"
  for live in "$LIVE_INGEST_DOMAIN" "$LIVE_DASHBOARD_DOMAIN"; do
    [ "$h" != "$(host_of "https://$live")" ] ||
      die "a temporary domain resolves to the LIVE customer hostname '${h}' (from '$u') — preparation does not move live traffic"
  done
done

# shellcheck source=deploy/coolify-api.sh
. "$HERE/coolify-api.sh"
coolify_api_init "$CONF" || die "could not prepare the Coolify client for the temporary domains"
trap coolify_api_cleanup EXIT

# Checked, not assumed: `curl -sS` exits 0 for a 401 and for a 500, so a
# «PATCH || die» would read Coolify refusing the write as success and then
# verify against a domain that was never set. Same lesson cutover records.
set_temp_domain() { # uuid url
  coolify_api PATCH "/applications/$1" \
    "$(python3 -c 'import json,sys; print(json.dumps({"domains": sys.argv[1]}))' "$2")" || return 1
  case "$API_STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}
set_temp_domain "$CAND_INGEST" "$TEMP_INGEST_URL" ||
  die "could not set ${TEMP_INGEST_URL} on the candidate ingest (Coolify said ${API_STATUS})"
set_temp_domain "$CAND_DASHBOARD" "$TEMP_DASHBOARD_URL" ||
  die "could not set ${TEMP_DASHBOARD_URL} on the candidate dashboard (Coolify said ${API_STATUS})"
say "    temporary domains assigned to the candidates; the live domains are untouched"

# ── P6–P9. migrate, then roll ingest and dashboard only ───────────────────
#
# `deploy.sh` is the tested sequence: it migrates, rolls ingest then dashboard,
# smoke-tests each against the digest it pulled, asserts no host port is
# published, and rolls back on failure. The bot is off, which is what keeps this
# a preparation: `DEPLOY_BOT_ENABLED=false` means the candidate bot is neither
# pinned, deployed, started nor health-checked.
say "P6–P9. migrate, then ingest and dashboard on temporary domains"
CANDIDATE_CONF="$STATE/candidate.deploy.env"
{
  sed '/^APP_INGEST=/d;/^APP_DASHBOARD=/d;/^APP_BOT=/d' "$CONF"
  printf 'APP_INGEST=%s\n' "$CAND_INGEST"
  printf 'APP_DASHBOARD=%s\n' "$CAND_DASHBOARD"
  printf 'APP_BOT=%s\n' "$CAND_BOT"
} >"$CANDIDATE_CONF"
chmod 600 "$CANDIDATE_CONF"

DEPLOY_BOT_ENABLED=false DEPLOY_APPROVAL_POLICY=promoted-by-hand \
  CONF="$CANDIDATE_CONF" bash "$HERE/deploy.sh" "$ENV_ARG" \
  "${IMAGE_REF:?IMAGE_REF is required}" "$SHA_ARG" '' ||
  die "the candidate rollout failed — deploy.sh has rolled back what it changed"

# ── P7/P10. the old applications, and the new ones ────────────────────────
say "P10. verification"
OBS=$(bash "$HERE/observe-production.sh") || die "could not read production back"
TEMP_OK=$(printf '%s' "$OBS" | sed -n 's/^temp_domain_verify=//p')
SCHEMA=$(printf '%s' "$OBS" | sed -n 's/^schema_version=//p')
LOCKS=$(printf '%s' "$OBS" | sed -n 's/^bot_locks=//p')
LIVE_ING=$(printf '%s' "$OBS" | sed -n 's/^live_ingest_owner=//p')
LIVE_DASH=$(printf '%s' "$OBS" | sed -n 's/^live_dashboard_owner=//p')

[ "$TEMP_OK" = 'pass' ] || die "the candidates do not answer on their temporary domains"

# The old bot must still be the only poller: preparation does not touch it, and
# a count that is not 1 means something else did.
[ "$LOCKS" = '1' ] || die "production holds ${LOCKS} bot advisory lock(s), expected exactly 1 — preparation does not touch the bot, so something else did"

# P7: the old applications still serve the migrated schema. This is what keeps
# image rollback a real recovery path rather than a hope.
OLD_OK=pass
for url in "https://sms.chopon.uk/health" "https://shikoo.chopon.uk/api/v1/health"; do
  code=$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 "$url" 2>/dev/null || echo 000)
  [ "$code" = '200' ] || OLD_OK=fail
done
[ "$OLD_OK" = 'pass' ] ||
  die "an old production application stopped serving after the migration — image rollback is no longer a recovery path, and this stops here rather than cutting over into that"

# ── the manifest ──────────────────────────────────────────────────────────
MANIFEST_DIR=$(mktemp -d)
MAIN_SHA="$SHA_ARG" DIGEST="$DIGEST_ARG" STAGING_RUN_ID="$STAGING_RUN" \
  CANDIDATE_INGEST="$CAND_INGEST" CANDIDATE_DASHBOARD="$CAND_DASHBOARD" CANDIDATE_BOT="$CAND_BOT" \
  BACKUP_ID="$BACKUP_ID" ENV_BACKUP_ID="$ENV_BACKUP_ID" SCHEMA_VERSION="$SCHEMA" \
  TEMP_DOMAIN_VERIFY="$TEMP_OK" OLD_APPS_HEALTHY="$OLD_OK" \
  LIVE_INGEST_OWNER="$LIVE_ING" LIVE_DASHBOARD_OWNER="$LIVE_DASH" \
  BOT_ADVISORY_LOCKS="$LOCKS" \
  bash "$HERE/write-preparation-manifest.sh" "$MANIFEST_DIR" ||
  die "the preparation manifest could not be written"

# The host-side ledger: the same record, kept where the box can be asked about
# it independently of any artifact GitHub is holding.
mkdir -p "$STATE"
cp "$MANIFEST_DIR/preparation.env" "$STATE/preparation.env"
cp "$MANIFEST_DIR/preparation.sha256" "$STATE/preparation.sha256"

# Fenced so the workflow can lift exactly the manifest out of the log without
# a temporary file crossing the ssh boundary.
echo 'BEGIN-PREPARATION-MANIFEST'
cat "$MANIFEST_DIR/preparation.env"
echo 'END-PREPARATION-MANIFEST'
rm -rf "$MANIFEST_DIR"

say "READY FOR CUTOVER — nothing customers can see has changed"
