#!/usr/bin/env bash
# The record that a production-dump rehearsal happened, and what it found.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHEN THIS RUNS, AND WHY THE ORDER IS THE POINT
#
# After the pull request is merged, after post-merge CI is green, and after
# staging has actually deployed that exact commit. Not before.
#
# It cannot run earlier: the thing it exists to bind is the immutable image
# digest that staging accepted, and that digest does not exist until staging has
# deployed. An attestation written before the merge would be a rehearsal of
# something other than what is about to ship, wearing the same words.
#
# ── What it is not ─────────────────────────────────────────────────────────
#
# It is not the dump, and the dump never leaves the secure host. `dump_id` is a
# sha256 and a date: enough to prove two runs used the same dump, not enough to
# reconstruct a byte of it. Nothing here holds a row, a total, a name or a
# credential — the financial comparison is recorded as `match` or `mismatch`
# and the aggregate names, never the amounts.
#
# ── Why every field is refused rather than defaulted ───────────────────────
#
# The whole value of this file is that `verify-dump-attestation.sh` can refuse a
# promotion on it. A field that defaults to something plausible when the caller
# forgets to pass it turns that refusal into a rubber stamp — which is the exact
# failure `ci_run_id` had in the release manifest, where it silently fell back
# to the wrong run and read like evidence for weeks.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: write-dump-attestation.sh <out-dir>
# All of the following are required, and validated:
#   MAIN_SHA DIGEST CI_RUN_ID STAGING_RUN_ID DUMP_ID MIGRATION_RANGE
#   DUMP_SUITES INVARIANTS FINANCIAL_TOTALS RESTORE_RESULT RESTORE_SECONDS
#   OLD_APP_SCHEMA_COMPAT

set -Eeuo pipefail

OUT_DIR=${1:?usage: write-dump-attestation.sh <out-dir>}
mkdir -p "$OUT_DIR"

: "${MAIN_SHA:?MAIN_SHA is required — the merged commit this rehearsal is for}"
: "${DIGEST:?DIGEST is required — the exact digest staging accepted}"
: "${CI_RUN_ID:?CI_RUN_ID is required — the successful post-merge CI push run}"
: "${STAGING_RUN_ID:?STAGING_RUN_ID is required — the successful Deploy Staging run}"
: "${DUMP_ID:?DUMP_ID is required — sha256:<hex> of the dump, plus its date}"
: "${MIGRATION_RANGE:?MIGRATION_RANGE is required, e.g. 0035..0037}"
: "${DUMP_SUITES:?DUMP_SUITES is required, e.g. 49/49}"
: "${INVARIANTS:?INVARIANTS is required, e.g. 32/32}"
: "${FINANCIAL_TOTALS:?FINANCIAL_TOTALS is required: match or mismatch}"
: "${RESTORE_RESULT:?RESTORE_RESULT is required: pass or fail}"
: "${RESTORE_SECONDS:?RESTORE_SECONDS is required}"
: "${OLD_APP_SCHEMA_COMPAT:?OLD_APP_SCHEMA_COMPAT is required: pass or fail}"

refuse() {
  echo "refusing: $*" >&2
  exit 1
}

[[ $MAIN_SHA =~ ^[0-9a-f]{40}$ ]] || refuse "MAIN_SHA is not a 40-character commit sha"
[[ $DIGEST =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "DIGEST is not sha256: plus 64 lowercase hex"
[[ $CI_RUN_ID =~ ^[0-9]{1,20}$ ]] || refuse "CI_RUN_ID is not a run id"
[[ $STAGING_RUN_ID =~ ^[0-9]{1,20}$ ]] || refuse "STAGING_RUN_ID is not a run id"
# A dump id that is a path is a dump id that names a file on a secure host in a
# document that leaves it.
[[ $DUMP_ID =~ ^sha256:[0-9a-f]{64}\ [0-9]{4}-[0-9]{2}-[0-9]{2}$ ]] ||
  refuse "DUMP_ID must be 'sha256:<64 hex> YYYY-MM-DD' — never a filename or a path"
[[ $MIGRATION_RANGE =~ ^[0-9]{4}\.\.[0-9]{4}$ ]] || refuse "MIGRATION_RANGE is not NNNN..NNNN"
[[ $RESTORE_SECONDS =~ ^[0-9]{1,7}$ ]] || refuse "RESTORE_SECONDS is not a whole number of seconds"

# The four verdicts are compared as whole strings, so «49/50» and «passed» are
# refused here rather than at the reader — the writer knows what it measured.
[ "$DUMP_SUITES" = '49/49' ] ||
  refuse "DUMP_SUITES is '${DUMP_SUITES}' — every production-dump suite has to run, and all of them have to pass"
[ "$INVARIANTS" = '32/32' ] ||
  refuse "INVARIANTS is '${INVARIANTS}' — all thirty-two have to pass"
case "$FINANCIAL_TOTALS" in match | mismatch) ;; *) refuse "FINANCIAL_TOTALS must be 'match' or 'mismatch'" ;; esac
case "$RESTORE_RESULT" in pass | fail) ;; *) refuse "RESTORE_RESULT must be 'pass' or 'fail'" ;; esac
case "$OLD_APP_SCHEMA_COMPAT" in pass | fail) ;; *) refuse "OLD_APP_SCHEMA_COMPAT must be 'pass' or 'fail'" ;; esac

IMAGE_NAME=${IMAGE_NAME:-ghcr.io/shikoonet/shikoonet-platform}
IMAGE_REF="${IMAGE_NAME}@${DIGEST}"

# Canonical order. The checksum is over exactly these lines, so the order is
# part of the contract and not a formatting choice.
{
  printf 'schema_version=1\n'
  printf 'repository=%s\n' "${GITHUB_REPOSITORY:-Shikoonet/Shikoonet-Platform}"
  printf 'main_sha=%s\n' "$MAIN_SHA"
  printf 'digest=%s\n' "$DIGEST"
  printf 'image_ref=%s\n' "$IMAGE_REF"
  printf 'ci_run_id=%s\n' "$CI_RUN_ID"
  printf 'staging_run_id=%s\n' "$STAGING_RUN_ID"
  printf 'dump_id=%s\n' "$DUMP_ID"
  printf 'migration_range=%s\n' "$MIGRATION_RANGE"
  printf 'dump_suites=%s\n' "$DUMP_SUITES"
  printf 'invariants=%s\n' "$INVARIANTS"
  printf 'financial_totals=%s\n' "$FINANCIAL_TOTALS"
  printf 'financial_aggregates=%s\n' "${FINANCIAL_AGGREGATES:-wallet_balance,ledger_sum,order_total}"
  printf 'restore_result=%s\n' "$RESTORE_RESULT"
  printf 'restore_seconds=%s\n' "$RESTORE_SECONDS"
  printf 'old_app_schema_compat=%s\n' "$OLD_APP_SCHEMA_COMPAT"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$OUT_DIR/attestation.env"

( cd "$OUT_DIR" && sha256sum attestation.env >attestation.sha256 )

echo "[attestation] wrote ${OUT_DIR}/attestation.env for ${MAIN_SHA:0:12} @ ${DIGEST:0:19}…"
