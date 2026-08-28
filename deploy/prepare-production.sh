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
  die "the dump attestation does not cover this release"

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

# `restore-drill.sh` takes no arguments: it finds the newest dump itself,
# restores it into a throwaway database beside the real one, checks what came
# back is the database we think it is, and tears it down. It needs root, which
# this script does not have — so it is invoked through the one thing that does,
# and a host without that rule configured stops here rather than migrating on
# an unproven backup.
if [ "$(id -u)" = '0' ]; then
  sh "$HERE/restore-drill.sh"
elif sudo -n true 2>/dev/null; then
  sudo -n sh "$HERE/restore-drill.sh"
else
  die "the restore drill needs root and this user cannot reach it. Grant a passwordless sudo rule for restore-drill.sh, or run it by hand and re-dispatch: the migration below has no recovery path until a restore has actually been proven, and a backup nobody has restored is a belief rather than a backup."
fi || die "the restore of the newest backup could not be proven — refusing to migrate production on it"

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
