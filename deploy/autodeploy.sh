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
# ─────────────────────────────────────────────────────────────────────────────
# The lock.
#
# `shikoo-autodeploy.service` already wraps this in `flock -n`, so the TIMER
# path cannot overlap itself. What that does not cover is the case its own
# comment names: a hand-run while the timer fires. `/opt/shikoo/autodeploy.sh`
# invoked directly does not go through the unit, takes no lock, and two copies
# then read the same sha and queue three builds each.
#
# So the script takes the same lock itself, on the same path, and re-executes
# under it once. `flock` is a no-op when the caller already holds it via the
# unit — same file, same fd semantics — so the timer path is unchanged.

set -Eeuo pipefail

LOCK=${SHIKOO_AUTODEPLOY_LOCK:-/run/shikoo-autodeploy.lock}
if [ "${SHIKOO_AUTODEPLOY_LOCKED:-}" != '1' ]; then
  export SHIKOO_AUTODEPLOY_LOCKED=1
  # Through `bash "$0"`, not `"$0"`. Re-executing the path directly needs the
  # exec bit, and the deploy step copies this file with `install -m 0755` —
  # but the copy in the repository is 0644, so a hand-run from a checkout
  # (which is how it is tested, and how somebody debugs it) died on
  # «Permission denied» before reaching a single line of logic.
  exec flock -n "$LOCK" bash "$0" "$@"
fi

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
# `event=push` and `branch=` are not decoration. Without them a
# `pull_request` run — which builds the MERGE commit, not this tree, and which
# any contributor can trigger — satisfies the gate for this sha. Narrowing to
# pushes on the protected branch means the run being consulted is the run that
# built exactly what is about to be deployed.
if ! gh "/actions/runs?head_sha=${head_sha}&event=push&branch=${BRANCH}&status=completed&per_page=100"; then
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

# `skipped` is NOT a pass.
#
# The previous version accepted `success`, `neutral` OR `skipped` for every
# run. A whole workflow that skipped — a path filter that stopped matching, a
# job whose `if:` went false, a run cancelled at the queue — therefore read as
# green, and a commit nothing had tested would deploy. That is the precise
# failure `Required Quality Gate` was built to make impossible, undone one
# level up.
#
# Now: at least one completed `push` run, none of them still going, and every
# one concluded `success`. Nothing else is a pass.
verdict=$(printf '%s' "$checks" | jq -r '
  if (.total_count // 0) == 0 then "none"
  elif any(.workflow_runs[]; .status != "completed") then "pending"
  elif all(.workflow_runs[]; .conclusion == "success") then "green"
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

# The required gate, by name, on this exact sha.
#
# «every run concluded success» is necessary and not sufficient: it is true of
# a repository where the gate workflow never ran at all, and true again the day
# somebody adds a second trivial workflow and deletes the real one. What has to
# be true is that the ONE check the branch ruleset requires reported success
# for this commit.
#
# Asked at the JOB level, because that is where the name lives: the workflow is
# «CI» and the aggregator is a job inside it called «Required Quality Gate».
# `/actions/runs/:id/jobs` is covered by the same `Actions: Read-only` scope
# already needed above, so this costs a permission nobody has to grant.
REQUIRED_JOB=${REQUIRED_JOB:-Required Quality Gate}

gate_ok=0
for run_id in $(printf '%s' "$checks" | jq -r '.workflow_runs[].id'); do
  if ! gh "/actions/runs/${run_id}/jobs?per_page=100"; then
    die "could not read the jobs of run ${run_id} (HTTP ${gh_status})"
  fi
  if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
    'any(.jobs[]; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
    gate_ok=1
    break
  fi
done

if [ "$gate_ok" -ne 1 ]; then
  # NOT recorded. Unlike a red commit, this is usually a transient shape — the
  # aggregator queued but not yet reported — and recording it would skip the
  # commit for ever on a race the next tick would have resolved.
  log "«${REQUIRED_JOB}» has not succeeded on ${head_sha:0:12} — not deploying"
  exit 0
fi

# The branch race.
#
# Everything above describes a sha that may already be history: between the
# first call and this line, CI takes minutes, and somebody can push twice in
# that window. Deploying now would build `main` — whatever `main` currently is
# — while REPORTING the sha that passed. The log would name a commit that is
# not what went out, which is the worst kind of wrong: it looks like an audit
# trail.
#
# So the branch is read again and must be unchanged. If it moved, this tick
# does nothing and the next one evaluates the new head on its own merits.
gh "/commits/${BRANCH}" ||
  die "could not re-read ${BRANCH} before deploying (HTTP ${gh_status})"
head_now=$(printf %s "$gh_body" | jq -r '.sha // empty')
[ -n "$head_now" ] || die "GitHub returned no sha on the re-read of ${BRANCH}"

if [ "$head_now" != "$head_sha" ]; then
  log "${BRANCH} moved ${head_sha:0:12} → ${head_now:0:12} while CI was being read — not deploying, the new head gets its own turn"
  exit 0
fi

log "CI green on ${head_sha:0:12}, «${REQUIRED_JOB}» succeeded, ${BRANCH} unmoved — deploying"

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
