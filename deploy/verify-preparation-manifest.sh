#!/usr/bin/env bash
# Whether the world still looks the way Prepare Production left it.
#
# ─────────────────────────────────────────────────────────────────────────────
# Cutover is the step that moves customer traffic, and it runs minutes or hours
# after the preparation it depends on. Everything in between is somebody else's
# opportunity: a Coolify variable edited by hand, a candidate that fell over, a
# migration applied outside the pipeline, `main` moving, native Auto Deploy
# switched back on, a domain already repointed.
#
# So this compares the manifest against OBSERVED state, field by field, and
# refuses on any disagreement — before a credential is used to move anything.
# «Everything matched except the one I did not check» is the shape of every
# deployment that goes wrong in a way nobody predicted.
#
# The observations arrive as environment variables, gathered by the caller from
# the box. This script does no I/O of its own: it is the comparison, kept
# separate from the gathering so that both are testable and neither can quietly
# skip the other.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: verify-preparation-manifest.sh <artifact-dir>
#
# Required expectations (from the promotion gate):
#   EXPECTED_SHA EXPECTED_DIGEST EXPECTED_STAGING_RUN_ID
# Required observations (gathered from the box, now):
#   OBSERVED_SCHEMA_VERSION OBSERVED_CANDIDATE_HEALTH OBSERVED_LIVE_INGEST_OWNER
#   OBSERVED_LIVE_DASHBOARD_OWNER OBSERVED_AUTO_DEPLOY OBSERVED_BOT_LOCKS
#   OBSERVED_TEMP_DOMAIN_VERIFY OBSERVED_BACKUP_PRESENT

set -Eeuo pipefail

DIR=${1:?usage: verify-preparation-manifest.sh <artifact-dir>}

fail() {
  echo "::error::$*"
  exit 1
}

[ -r "$DIR/preparation.env" ] ||
  fail "no preparation.env — this cutover has no Prepare Production run behind it. Run Prepare Production, read its evidence, then cut over."
[ -r "$DIR/preparation.sha256" ] || fail "no preparation.sha256 — the preparation manifest carries no checksum"

( cd "$DIR" && sha256sum -c --status preparation.sha256 ) ||
  fail "preparation manifest checksum does not verify — it was altered after Prepare Production wrote it"

field() { sed -n "s/^$1=//p" "$DIR/preparation.env" | head -1; }

[ "$(field schema_version)" = '1' ] || fail "unsupported preparation schema_version '$(field schema_version)'"

: "${EXPECTED_SHA:?EXPECTED_SHA is not set — refusing to verify against nothing}"
: "${EXPECTED_DIGEST:?EXPECTED_DIGEST is not set — refusing to verify against nothing}"
: "${EXPECTED_STAGING_RUN_ID:?EXPECTED_STAGING_RUN_ID is not set — refusing to verify against nothing}"

# Every observation is required. An unset one is a check that did not happen,
# and a check that did not happen must never read as a check that passed — the
# same lesson `verify-release-manifest.sh` records about its own optional
# guards, which were made unconditional for exactly this reason.
for v in OBSERVED_SCHEMA_VERSION OBSERVED_CANDIDATE_HEALTH OBSERVED_LIVE_INGEST_OWNER \
  OBSERVED_LIVE_DASHBOARD_OWNER OBSERVED_AUTO_DEPLOY OBSERVED_BOT_LOCKS \
  OBSERVED_TEMP_DOMAIN_VERIFY OBSERVED_BACKUP_PRESENT; do
  [ -n "${!v:-}" ] || fail "${v} was not gathered — an absent observation is not a passing one"
done

# ── the release this cutover is for ────────────────────────────────────────
[ "$(field main_sha)" = "$EXPECTED_SHA" ] ||
  fail "the preparation was for commit $(field main_sha), this cutover is for ${EXPECTED_SHA} — main moved, or the wrong preparation run was selected"
[ "$(field digest)" = "$EXPECTED_DIGEST" ] ||
  fail "the preparation prepared digest $(field digest), this cutover would deploy ${EXPECTED_DIGEST}"
[ "$(field staging_run_id)" = "$EXPECTED_STAGING_RUN_ID" ] ||
  fail "the preparation came from Deploy Staging run $(field staging_run_id), this cutover names ${EXPECTED_STAGING_RUN_ID}"

# ── the state it left behind ───────────────────────────────────────────────
[ "$(field db_schema_version)" = "$OBSERVED_SCHEMA_VERSION" ] ||
  fail "the database was at schema $(field db_schema_version) after preparation and is at ${OBSERVED_SCHEMA_VERSION} now — something migrated outside this pipeline"

[ "$OBSERVED_CANDIDATE_HEALTH" = 'healthy' ] ||
  fail "the production candidates are '${OBSERVED_CANDIDATE_HEALTH}', not healthy — cutting over to an unhealthy candidate is the outage this two-step exists to prevent"

# The one that is easy to omit and matters most: cutover moves the customer
# domains, so it has to be moving them from what preparation saw.
[ "$OBSERVED_LIVE_INGEST_OWNER" = "$(field live_ingest_owner)" ] ||
  fail "the live ingest domain answered from '$(field live_ingest_owner)' at preparation and answers from '${OBSERVED_LIVE_INGEST_OWNER}' now — somebody already moved it"
[ "$OBSERVED_LIVE_DASHBOARD_OWNER" = "$(field live_dashboard_owner)" ] ||
  fail "the live dashboard domain answered from '$(field live_dashboard_owner)' at preparation and answers from '${OBSERVED_LIVE_DASHBOARD_OWNER}' now — somebody already moved it"

[ "$OBSERVED_AUTO_DEPLOY" = 'off' ] ||
  fail "native Auto Deploy or preview deployments are ON somewhere in production ('${OBSERVED_AUTO_DEPLOY}') — a push could deploy behind this cutover"

# Exactly one poller, still, before the handover that briefly has to have none.
[ "$OBSERVED_BOT_LOCKS" = '1' ] ||
  fail "production holds ${OBSERVED_BOT_LOCKS} bot advisory lock(s), expected exactly 1 — the bot handover starts from a known single poller or not at all"

[ "$OBSERVED_TEMP_DOMAIN_VERIFY" = 'pass' ] ||
  fail "the temporary-domain checks do not pass now ('${OBSERVED_TEMP_DOMAIN_VERIFY}') — the candidates verified at preparation and do not verify today"

[ "$OBSERVED_BACKUP_PRESENT" = 'present' ] ||
  fail "the pre-cutover backup $(field backup_id) is not present — the only recovery path for the migration is gone, and cutover does not proceed without it"

echo "[cutover] preparation $(field prepare_run_id) verified: ${EXPECTED_SHA:0:12} @ ${EXPECTED_DIGEST:0:19}…, schema $(field db_schema_version), candidates healthy, live domains unmoved, one poller"
