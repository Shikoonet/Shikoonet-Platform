#!/usr/bin/env bash
#
# Push to `main` → Coolify deploys, once CI is green.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why this POLLS instead of being a webhook.
#
# Every conventional answer here is inbound: a GitHub webhook into Coolify's
# `manual_webhook_secret_github`, or a GitHub Action calling
# `POST /api/v1/deploy`. Both need GitHub to reach this box, and it cannot.
# Coolify listens on `0.0.0.0:8000` but the router in front only forwards 80 and
# 443, so `:8000` answers nothing from the internet — measured 2026-08-26, and
# that is the posture we want kept. Exposing the Coolify API through Traefik to
# get a webhook would put the whole control plane of this server on the internet
# behind one bearer token, to save 60 seconds of latency.
#
# Outbound works fine: `api.github.com` answers this box in 0.4s. So the box
# asks, rather than being told.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why it waits for CI.
#
# The point of the gate in `.github/workflows/ci.yml` is that a commit which
# fails it never reaches customers. A deploy triggered by the push itself would
# race the gate and usually win — the whole gate takes minutes, a webhook fires
# in milliseconds. So the sha is deployed only once GitHub reports every check
# on it complete and successful.
#
# A sha whose CI FAILED is recorded as seen and never deployed. It is not
# retried: the fix for a red commit is another commit, and a loop that keeps
# asking would rebuild a known-bad tree every minute.
#
# ─────────────────────────────────────────────────────────────────────────────
# What it does NOT do.
#
# It does not roll back, it does not wait for the deploy to go healthy, and it
# does not check that the running sha caught up. Coolify owns all three and says
# so in its own UI; duplicating that here would mean this script deciding to
# revert production, which is a person's decision.
#
# ponytail: one state file, no lockfile of its own — systemd's `Type=oneshot`
# plus the timer's `AccountingEnabled` do not overlap runs, and `flock` below is
# belt to that braces because a hand-run while the timer fires is the one way
# two of these meet.

set -euo pipefail

CONFIG=${SHIKOO_AUTODEPLOY_ENV:-/etc/shikoo/autodeploy.env}
STATE=${SHIKOO_AUTODEPLOY_STATE:-/var/lib/shikoo-autodeploy/last-sha}

# `logger` so this lands in the journal beside the units, and stdout so a hand
# run says something. `systemd-cat` would do one or the other, not both.
log() { printf '%s autodeploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

die() {
  log "FAILED: $*"
  exit 1
}

[ -r "$CONFIG" ] || die "$CONFIG is missing or unreadable"
# shellcheck source=/dev/null
. "$CONFIG"

: "${GH_REPO:?GH_REPO must be set, as owner/name}"
: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${COOLIFY_URL:?COOLIFY_URL must be set}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN must be set}"
: "${APP_UUIDS:?APP_UUIDS must be set, space separated}"
BRANCH=${BRANCH:-main}

mkdir -p "$(dirname "$STATE")"

# The reply, in two globals rather than on stdout.
#
# Returning the body through stdout reads better and does not work: every caller
# would write `x=$(gh ...)`, which runs the function in a SUBSHELL, and the
# status it recorded would die with that subshell. The first version did exactly
# that and reported «HTTP 0» for a 403 — the one number that had to survive.
#
# `-f` is deliberately absent for the same reason: it collapses every failure
# into exit 22 with no body, and «the token cannot read checks» and «GitHub is
# down» are the whole of what an operator needs told apart here.
gh_status=0
gh_body=''
gh() {
  local out
  out=$(curl -sS -m 30 -w '%{http_code}' \
    -H "Authorization: Bearer ${GH_TOKEN}" \
    -H 'Accept: application/vnd.github+json' \
    -H 'X-GitHub-Api-Version: 2022-11-28' \
    "https://api.github.com/repos/${GH_REPO}$1") || { gh_status=0; gh_body=''; return 1; }
  # The status is the LAST three characters, appended by -w. Splitting on a
  # newline instead breaks on any body that ends in one, which every
  # pretty-printed GitHub error does.
  gh_status=${out: -3}
  gh_body=${out:0:${#out}-3}
  [ "$gh_status" = "200" ]
}
gh "/commits/${BRANCH}" ||
  die "could not ask GitHub for ${BRANCH} (HTTP ${gh_status})"
head_sha=$(printf %s "$gh_body" | jq -r '.sha // empty')
[ -n "$head_sha" ] || die "GitHub returned no sha for ${BRANCH}"

seen=$(cat "$STATE" 2>/dev/null || true)
if [ "$head_sha" = "$seen" ]; then
  exit 0
fi

log "${BRANCH} is at ${head_sha:0:12}, last seen ${seen:0:12}"

# Every workflow run on the commit, collapsed to one word.
#
# `/actions/runs?head_sha=` rather than `/commits/:sha/check-runs`, and not by
# preference: GitHub no longer offers **Checks** in the fine-grained token
# permission list at all — checked 2026-08-26, the list runs
# «Attestations · Code quality · Code scanning alerts» with nothing between
# them. So the check-runs API cannot be granted to a PAT any more.
#
# `Commit statuses` is the substitute it looks like and is not: the CI here is
# a GitHub Actions workflow, Actions reports through check runs, and the legacy
# combined status is empty for this repository — «no CI configured», the one
# answer that must never read as a pass. The runs themselves carry the same
# verdict and open with `Actions: Read-only`.
if ! gh "/actions/runs?head_sha=${head_sha}&per_page=100"; then
  if [ "$gh_status" = "403" ] || [ "$gh_status" = "404" ]; then
    # Not a failure of this box, and not something a retry fixes. The PAT in
    # /etc/shikoo/autodeploy.env is fine-grained and was issued for the deploy
    # key work, so it carries `Contents: Read-only` and nothing else. Reading
    # whether CI passed needs one more: **Actions: Read-only** on this repo.
    #
    # 404 is the same answer wearing a different number: a fine-grained token
    # without the scope is told the resource does not exist, rather than that
    # it may not look.
    #
    # Deliberately quiet, and deliberately NOT recorded: the sha stays unseen,
    # so the minute the permission is added this deploys with nobody re-pushing.
    log "cannot read CI on ${head_sha:0:12} — the GitHub token needs «Actions: Read-only» on ${GH_REPO}. NOT deploying."
    exit 0
  fi
  die "could not read the workflow runs on ${head_sha:0:12} (HTTP ${gh_status})"
fi
checks=$gh_body

verdict=$(printf '%s' "$checks" | jq -r '
  if (.total_count // 0) == 0 then "none"
  elif any(.workflow_runs[]; .status != "completed") then "pending"
  elif all(.workflow_runs[]; .conclusion == "success" or .conclusion == "neutral" or .conclusion == "skipped") then "green"
  else "red" end
')

case "$verdict" in
  none)
    # Not deployed, and not recorded either: a workflow that has not registered
    # its checks yet looks exactly like this for the first few seconds after a
    # push. Recording it here would skip the commit forever.
    log "no workflow run on ${head_sha:0:12} yet — waiting"
    exit 0
    ;;
  pending)
    log "CI still running on ${head_sha:0:12} — waiting"
    exit 0
    ;;
  red)
    failed=$(printf '%s' "$checks" |
      jq -r '[.workflow_runs[] | select(.conclusion != "success" and .conclusion != "neutral" and .conclusion != "skipped") | .name] | join(", ")')
    # Recorded, so this is said once rather than every minute. A red commit is
    # fixed by pushing another one, and that one gets its own turn.
    printf '%s' "$head_sha" > "$STATE"
    log "CI FAILED on ${head_sha:0:12} (${failed}) — not deploying, and not asking again"
    exit 0
    ;;
  green) ;;
  *) die "could not read the check verdict" ;;
esac

log "CI green on ${head_sha:0:12} — deploying"

# Recorded BEFORE the deploys, not after.
#
# If Coolify accepts the first app and the box loses power before the third, the
# next tick must not start the whole thing again from a half-deployed state — it
# must leave a human looking at Coolify, which is where the truth is. The log
# line above is what tells them which sha it was.
printf '%s' "$head_sha" > "$STATE"

failures=0
for uuid in $APP_UUIDS; do
  if out=$(curl -fsS -m 60 -X POST \
    -H "Authorization: Bearer ${COOLIFY_TOKEN}" \
    "${COOLIFY_URL}/api/v1/deploy?uuid=${uuid}" 2>&1); then
    log "queued ${uuid}: $(printf '%s' "$out" | head -c 200)"
  else
    failures=$((failures + 1))
    log "ERROR queueing ${uuid}: $(printf '%s' "$out" | head -c 200)"
  fi
done

[ "$failures" -eq 0 ] || die "${failures} app(s) did not queue"
log "all apps queued for ${head_sha:0:12}"
