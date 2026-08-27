#!/usr/bin/env bash
#
# A merged, approved, green commit on `main` → deployed to Coolify at that exact
# sha. Nothing else deploys.
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
# asks, rather than being told. It also means the Coolify token never leaves
# loopback — see COOLIFY_URL below.
#
# ─────────────────────────────────────────────────────────────────────────────
# Why the approval check is HERE, and not on GitHub.
#
# The right place for «no unreviewed commit reaches main» is a branch ruleset,
# and this repository cannot have one: rulesets on a private repository need
# GitHub Team, and `GET /repos/:r/rulesets` answers 403 «Upgrade to GitHub Pro»
# — measured 2026-08-27. So the deployment controller does the check itself.
#
# That is not a workaround to delete the day the plan is upgraded. A ruleset
# governs what may land on `main`; this governs what may reach customers, and
# the two answer to different people. Keep both.
#
# What «approved» has to mean, and each one is a test in
# `deploy/test/autodeploy.test.sh`:
#
#   · the sha is the result of a pull request that was MERGED, not merely
#     approved — an approval on an open PR deploys nothing
#   · the PR's base was exactly `main`
#   · the sha is that PR's merge result or its head — so a commit that merely
#     happens to be mentioned by an unrelated PR does not qualify
#   · at least one review in state APPROVED
#   · by somebody other than the PR's author — self-approval is not review
#   · on the PR's FINAL head sha, so an approval given before another push is
#     stale and does not count
#   · the reviewer's LATEST review is the one consulted, so an approval later
#     superseded by CHANGES_REQUESTED does not count
#   · a sha GitHub cannot associate with a merged PR fails closed
#
# ─────────────────────────────────────────────────────────────────────────────
# Why it waits for CI.
#
# The point of the gate in `.github/workflows/ci.yml` is that a commit which
# fails it never reaches customers. A deploy triggered by the push itself would
# race the gate and usually win — the whole gate takes minutes, a webhook fires
# in milliseconds. So the sha is deployed only once GitHub reports the `push`
# run on that exact sha complete and successful, and the one job the ruleset
# would require — `Required Quality Gate` — succeeded inside it.
#
# ─────────────────────────────────────────────────────────────────────────────
# The lock.
#
# One lock, taken HERE, and nowhere else.
#
# `shikoo-autodeploy.service` used to wrap this in `flock -n` on the same path
# as well, on the theory that a second `flock` is a no-op when the caller
# already holds the lock. It is not: `flock` locks an open file DESCRIPTION, and
# the re-exec below opens the path again and asks for its own — which the unit
# is still holding. `flock -n` therefore returned 1 immediately, printed
# nothing, and the whole body of this script never ran under systemd. Measured
# on the staging host 2026-08-27, after it had been believed to work for a day.
#
# So the unit invokes this script directly and the lock lives here. That covers
# the timer path AND the case the unit could never see: a hand-run of
# `/opt/shikoo/autodeploy.sh` while the timer fires, where two copies read the
# same sha and queue three builds each.
#
# ─────────────────────────────────────────────────────────────────────────────
# `--dry-run`
#
# Every read, no writes: resolves the candidate, runs all four gates, prints the
# decision it WOULD take, and exits. This is what you run against the real
# staging configuration before letting the timer near it.

set -Eeuo pipefail

# The lock is taken HERE, on line one of the work, and that placement is the
# whole guarantee: before the config is read, before the first GitHub call,
# before anything is asked of Coolify and long before anything is changed. A
# lock taken later would leave a window in which two ticks both decide to
# deploy and only then discover each other.
#
# `-E 99` so «I could not get the lock» is distinguishable from «the script ran
# and exited 1». Without it both are exit 1, and an overlap is indistinguishable
# from a failure — which is how a benign overlap ends up looking like a broken
# deploy in `systemctl status`.
LOCK=${SHIKOO_AUTODEPLOY_LOCK:-/run/shikoo-autodeploy.lock}
if [ "${SHIKOO_AUTODEPLOY_LOCKED:-}" != '1' ]; then
  export SHIKOO_AUTODEPLOY_LOCKED=1
  # Through `bash "$0"`, not `"$0"`. Re-executing the path directly needs the
  # exec bit, and the deploy step copies this file with `install -m 0755` —
  # but the copy in the repository is 0644, so a hand-run from a checkout
  # (which is how it is tested, and how somebody debugs it) died on
  # «Permission denied» before reaching a single line of logic.
  #
  # Not `exec`: this shell has to survive to tell the difference between the
  # two exit codes below.
  # `|| rc=$?` and not a bare call: `set -e` is on, so a non-zero flock would
  # abort this shell here — before the 99 could ever be translated into the
  # message below. The lock-out would then be silent, which is the exact
  # failure this block exists to prevent.
  rc=0
  flock -n -E 99 "$LOCK" bash "$0" "$@" || rc=$?
  if [ "$rc" -eq 99 ]; then
    # Benign and expected: a hand-run met a tick, or a deploy is still going.
    # Exit 0 so a normal overlap does not paint the unit red. Nothing about the
    # holder is printed — there is nothing to say that is not a guess, and
    # nothing here may leak a path or a credential.
    printf '%s autodeploy: another run holds %s — this invocation did nothing\n' \
      "$(date -u +%FT%TZ)" "$LOCK"
    exit 0
  fi
  exit "$rc"
fi

DRY_RUN=0
[ "${1:-}" = '--dry-run' ] && DRY_RUN=1

# Where the two tokens come from.
#
# `$CREDENTIALS_DIRECTORY` first, because that is what `LoadCredential=` in
# `shikoo-autodeploy.service` sets: a per-invocation ramfs copy, mode 0400,
# owned by this service and invisible to `systemctl show -p Environment`. The
# unit path is the one that runs sixty times an hour, so it gets the safest
# mechanism.
#
# `/etc/shikoo/autodeploy.env` second, for a hand-run and for `--dry-run`, which
# do not go through systemd and so have no credential directory. Same file, same
# 0600 root:root — LoadCredential reads it from exactly there.
if [ -n "${CREDENTIALS_DIRECTORY:-}" ] && [ -r "${CREDENTIALS_DIRECTORY}/autodeploy.env" ]; then
  CONFIG="${CREDENTIALS_DIRECTORY}/autodeploy.env"
else
  CONFIG=${SHIKOO_AUTODEPLOY_ENV:-/etc/shikoo/autodeploy.env}
fi
STATE_DIR=${SHIKOO_AUTODEPLOY_STATE_DIR:-/var/lib/shikoo-autodeploy}
# The sha that DEPLOYED, and nothing else. It is the rollback target, so a
# candidate that failed halfway must never land here.
STATE=${SHIKOO_AUTODEPLOY_STATE:-$STATE_DIR/last-sha}
# A sha refused for a reason another tick cannot change — red CI, no approving
# review, a destructive migration with no plan. Recorded only so the refusal is
# said once instead of sixty times an hour.
REJECTED=${SHIKOO_AUTODEPLOY_REJECTED:-$STATE_DIR/rejected-sha}
# One line per deployment attempt: candidate, previous, per-app deployment
# uuids, timestamps, verdict.
JOURNAL=${SHIKOO_AUTODEPLOY_JOURNAL:-$STATE_DIR/deployments.jsonl}

# `logger` so this lands in the journal beside the units, and stdout so a hand
# run says something. `systemd-cat` would do one or the other, not both.
log() { printf '%s autodeploy: %s\n' "$(date -u +%FT%TZ)" "$*"; }

die() {
  log "FAILED: $*"
  exit 1
}

[ -r "$CONFIG" ] || die "$CONFIG is missing or unreadable"

# Read as text. NOT `.`-sourced, and that is a security property rather than a
# style: sourcing hands anybody who can write that file arbitrary code as this
# user, and it makes every value a shell expression. A Coolify API token is
# literally `<id>|<random>` — sourced unquoted, the `|` becomes a pipeline and
# the rest of the token runs as a command. The old file worked around that by
# single-quoting every value and saying so in the README, which is a rule a
# human has to keep; this needs no rule, because nothing is interpreted.
#
# Surrounding quotes are stripped if present, so a file written the old way
# still reads correctly. `tail -1` so a duplicated key takes the last one, the
# way a sourced file behaved.
cfg() {
  local v first last
  v=$(sed -n "s/^[[:space:]]*$1=//p" "$CONFIG" | tail -1)
  v=${v%$'\r'}
  # One matching pair of surrounding quotes, single or double, removed. Written
  # out longhand rather than as a `case` glob because the pattern for a literal
  # double quote inside a single-quoted case arm is unreadable and easy to get
  # subtly wrong.
  if [ ${#v} -ge 2 ]; then
    first=${v:0:1}
    last=${v: -1}
    if [ "$first" = "$last" ] && { [ "$first" = "'" ] || [ "$first" = '"' ]; }; then
      v=${v:1:${#v}-2}
    fi
  fi
  printf '%s' "$v"
}

# Environment first, file second — so a one-off verification run can supply a
# credential without writing it to disk, and the file stays authoritative for
# the unit, which has no environment at all.
GH_REPO=${GH_REPO:-$(cfg GH_REPO)}
GH_TOKEN=${GH_TOKEN:-$(cfg GH_TOKEN)}
COOLIFY_URL=${COOLIFY_URL:-$(cfg COOLIFY_URL)}
COOLIFY_TOKEN=${COOLIFY_TOKEN:-$(cfg COOLIFY_TOKEN)}
APP_INGEST=${APP_INGEST:-$(cfg APP_INGEST)}
APP_DASHBOARD=${APP_DASHBOARD:-$(cfg APP_DASHBOARD)}
APP_BOT=${APP_BOT:-$(cfg APP_BOT)}
EXPECT_ENV_NAME=${EXPECT_ENV_NAME:-$(cfg EXPECT_ENV_NAME)}
DB_CONTAINER=${DB_CONTAINER:-$(cfg DB_CONTAINER)}
BRANCH=${BRANCH:-$(cfg BRANCH)}
REQUIRED_JOB=${REQUIRED_JOB:-$(cfg REQUIRED_JOB)}
PGUSER=${PGUSER:-$(cfg PGUSER)}
PGDATABASE=${PGDATABASE:-$(cfg PGDATABASE)}
DEPLOY_TIMEOUT=${DEPLOY_TIMEOUT:-$(cfg DEPLOY_TIMEOUT)}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-$(cfg HEALTH_TIMEOUT)}
POLL_SECS=${POLL_SECS:-$(cfg POLL_SECS)}
BOT_HEARTBEAT_MAX_AGE=${BOT_HEARTBEAT_MAX_AGE:-$(cfg BOT_HEARTBEAT_MAX_AGE)}

: "${GH_REPO:?GH_REPO must be set, as owner/name}"
: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${COOLIFY_URL:?COOLIFY_URL must be set}"
: "${COOLIFY_TOKEN:?COOLIFY_TOKEN must be set}"
: "${APP_INGEST:?APP_INGEST must be set to the Coolify application uuid}"
: "${APP_DASHBOARD:?APP_DASHBOARD must be set to the Coolify application uuid}"
: "${APP_BOT:?APP_BOT must be set to the Coolify application uuid}"
# Not defaulted. «Which environment is this» is the one question a deploy script
# must never answer for you: the box that would be damaged by guessing wrong is
# exactly the box where the guess looks harmless.
: "${EXPECT_ENV_NAME:?EXPECT_ENV_NAME must be set — the ENV_NAME this host is allowed to deploy to}"
: "${DB_CONTAINER:?DB_CONTAINER must be set to the Postgres container name}"
BRANCH=${BRANCH:-main}
REQUIRED_JOB=${REQUIRED_JOB:-Required Quality Gate}
PGUSER=${PGUSER:-postgres}
PGDATABASE=${PGDATABASE:-shikoo}
DEPLOY_TIMEOUT=${DEPLOY_TIMEOUT:-900}
HEALTH_TIMEOUT=${HEALTH_TIMEOUT:-180}
# Floored at one second. `POLL_SECS=0` is a plausible thing to write in a
# config meaning «poll fast», and it makes `waited=$((waited + POLL_SECS))`
# never advance — so every bounded wait below becomes unbounded, and the unit
# sits on the lock until TimeoutStartSec fires. Found by the test suite hanging
# rather than failing.
POLL_SECS=${POLL_SECS:-5}
[ "$POLL_SECS" -ge 1 ] 2>/dev/null || POLL_SECS=1
# The bot's heartbeat contract, from `Dockerfile:186`. Stated here so a change
# to one is visibly a change to the other.
BOT_HEARTBEAT_MAX_AGE=${BOT_HEARTBEAT_MAX_AGE:-90}

mkdir -p "$STATE_DIR"
chmod 0700 "$STATE_DIR" 2>/dev/null || true

# ---------------------------------------------------------------------------
# Both tokens, out of argv.
#
# `curl -H "Authorization: Bearer $TOKEN"` puts the token in the command line,
# where every user on the box can read it out of `ps` for as long as the call
# takes. A curl config file is read from disk instead, so argv carries a path
# and nothing else. 0700 directory, and removed on any exit including a trap.
# ---------------------------------------------------------------------------
container_for() {
  docker ps --filter "name=^${1}-" --format '{{.Names}}' 2>/dev/null | head -1
}

env_of() {
  docker inspect "$1" --format '{{range .Config.Env}}{{println .}}{{end}}' 2>/dev/null |
    sed -n "s/^${2}=//p" | head -1
}

CURLDIR=$(mktemp -d)
chmod 0700 "$CURLDIR"
WORKDIR=$(mktemp -d)
chmod 0700 "$WORKDIR"

# ---------------------------------------------------------------------------
# What a dry run has to say, and why it is printed from a trap.
#
# `--dry-run` has to report the same facts whether the answer is «would deploy»
# or «would refuse at gate 2», and the refusals are `exit`s scattered through
# four gates. Collecting them at each exit point would mean eight copies that
# drift; an EXIT trap has exactly one.
#
# Every field below is a fact READ from GitHub or Coolify on this run. None of
# them is a token, and none of them is derived from one.
# ---------------------------------------------------------------------------
R_SHA='-'; R_PR='-'; R_APPROVAL='not reached'; R_RUN_ID='-'
R_GATE='not reached'; R_ENV='not reached'; R_MIGRATIONS='not reached'
R_DECISION='no decision reached'

# Fills in a gate the run short-circuited past.
#
# The deploy path short-circuits on purpose — the first «no» is the answer and
# every call after it is wasted. A dry run wants the opposite: ALL the reasons,
# so an operator fixes them in one pass instead of one per tick. Rather than
# tangle that into the control flow that decides real deployments, the report
# asks for what it is missing, itself, read-only.
dry_fill_gate() {
  local rid
  [ "$R_GATE" = 'not reached' ] || return 0
  gh "/actions/runs?head_sha=${R_SHA}&event=push&branch=${BRANCH}&status=completed&per_page=100" || {
    R_GATE="unreadable (HTTP ${gh_status})"; return 0
  }
  if [ "$(printf '%s' "$gh_body" | jq -r '.total_count // 0')" = '0' ]; then
    R_GATE='no completed push run on this sha'; return 0
  fi
  rid=$(printf '%s' "$gh_body" | jq -r '.workflow_runs[0].id // empty')
  R_RUN_ID=${rid:--}
  [ -n "$rid" ] || { R_GATE='no run id'; return 0; }
  gh "/actions/runs/${rid}/jobs?per_page=100" || { R_GATE="jobs unreadable (HTTP ${gh_status})"; return 0; }
  if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
    'any(.jobs[]; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
    R_GATE='completed / success'
  else
    R_GATE="present but not succeeded: $(printf '%s' "$gh_body" | jq -r --arg n "$REQUIRED_JOB" '[.jobs[] | select(.name == $n) | "\(.status)/\(.conclusion)"] | if length == 0 then "job absent" else join(",") end')"
  fi
}

dry_fill_env() {
  local c
  [ "$R_ENV" = 'not reached' ] || return 0
  c=$(container_for "$APP_INGEST")
  if [ -n "$c" ]; then
    R_ENV="$(env_of "$c" ENV_NAME) (host reports; EXPECT_ENV_NAME=${EXPECT_ENV_NAME})"
  else
    R_ENV='no running ingest container — unanswerable'
  fi
}

dry_report() {
  [ "$DRY_RUN" -eq 1 ] || return 0
  local name uuid live
  dry_fill_gate
  dry_fill_env
  printf '\n──────── autodeploy --dry-run ────────\n'
  printf '  branch                  %s\n' "$BRANCH"
  printf '  candidate main sha      %s\n' "$R_SHA"
  printf '  merged PR               %s\n' "$R_PR"
  printf '  approval                %s\n' "$R_APPROVAL"
  printf '  workflow run id         %s\n' "$R_RUN_ID"
  printf '  «%s»  %s\n' "$REQUIRED_JOB" "$R_GATE"
  printf '  ENV_NAME                %s\n' "$R_ENV"
  printf '  migrations              %s\n' "$R_MIGRATIONS"
  printf '  coolify                 %s (api %s)\n' "$COOLIFY_URL" "$(co /version >/dev/null 2>&1 && printf %s "$co_body" || printf 'unreachable')"
  for app in "ingest:$APP_INGEST" "dashboard:$APP_DASHBOARD" "bot:$APP_BOT"; do
    name=${app%%:*}; uuid=${app#*:}
    if co "/applications/${uuid}"; then
      live=$(container_for "$uuid")
      printf '  %-10s %s  pinned=%s branch=%s status=%s running=%s\n' \
        "$name" "$uuid" \
        "$(printf '%s' "$co_body" | jq -r '.git_commit_sha // "-"')" \
        "$(printf '%s' "$co_body" | jq -r '.git_branch // "-"')" \
        "$(printf '%s' "$co_body" | jq -r '.status // "-"')" \
        "$([ -n "$live" ] && env_of "$live" SOURCE_COMMIT | cut -c1-12 || printf 'no container')"
    else
      printf '  %-10s %s  UNREADABLE (HTTP %s)\n' "$name" "$uuid" "$co_status"
    fi
  done
  printf '  last recorded deploy    %s\n' "${deployed:-none}"
  printf '  DECISION                %s\n' "$R_DECISION"
  printf '  nothing was written, nothing was deployed\n'
  printf '──────────────────────────────────────\n'
}

trap 'dry_report; rm -rf "$CURLDIR" "$WORKDIR"' EXIT

{
  printf 'header = "Authorization: Bearer %s"\n' "$GH_TOKEN"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} > "$CURLDIR/gh"
printf 'header = "Authorization: Bearer %s"\n' "$COOLIFY_TOKEN" > "$CURLDIR/coolify"
chmod 0600 "$CURLDIR/gh" "$CURLDIR/coolify"

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
  out=$(curl -sS -m 30 -w '%{http_code}' -K "$CURLDIR/gh" \
    "https://api.github.com/repos/${GH_REPO}$1") || { gh_status=0; gh_body=''; return 1; }
  # The status is the LAST three characters, appended by -w. Splitting on a
  # newline instead breaks on any body that ends in one, which every
  # pretty-printed GitHub error does.
  gh_status=${out: -3}
  gh_body=${out:0:${#out}-3}
  [ "$gh_status" = "200" ]
}

# Same shape for Coolify. `$2` is an optional method, `$3` an optional JSON body.
co_status=0
co_body=''
co() {
  local path=$1 method=${2:-GET} body=${3:-} out
  local args=(-sS -m 60 -w '%{http_code}' -K "$CURLDIR/coolify" -X "$method")
  if [ -n "$body" ]; then
    args+=(-H 'Content-Type: application/json' --data-binary "$body")
  fi
  out=$(curl "${args[@]}" "${COOLIFY_URL}/api/v1${path}") || { co_status=0; co_body=''; return 1; }
  co_status=${out: -3}
  co_body=${out:0:${#out}-3}
  case "$co_status" in 200|201|202) return 0 ;; *) return 1 ;; esac
}

# A terminal refusal: said once, then never again for this sha.
refuse() {
  R_DECISION="WOULD NOT DEPLOY — $2"
  if [ "$DRY_RUN" -eq 0 ]; then
    printf '%s' "$1" > "$REJECTED"
  fi
  log "$2"
  exit 0
}

# A transient refusal: nothing recorded, the next tick asks again.
wait_out() {
  R_DECISION="WOULD NOT DEPLOY (yet) — $1"
  log "$1"
  exit 0
}

# ═══════════════════════════════════════════════════════════════════════════
# 1. The candidate
# ═══════════════════════════════════════════════════════════════════════════
gh "/commits/${BRANCH}" ||
  die "could not ask GitHub for ${BRANCH} (HTTP ${gh_status})"
head_sha=$(printf %s "$gh_body" | jq -r '.sha // empty')
[ -n "$head_sha" ] || die "GitHub returned no sha for ${BRANCH}"

R_SHA=$head_sha
deployed=$(cat "$STATE" 2>/dev/null || true)
rejected=$(cat "$REJECTED" 2>/dev/null || true)

if [ "$DRY_RUN" -eq 0 ]; then
  # Idempotence, in the only two forms it takes: this sha already went out, or
  # this sha was already refused for a reason a retry cannot change.
  [ "$head_sha" = "$deployed" ] && exit 0
  [ "$head_sha" = "$rejected" ] && exit 0
fi

log "${BRANCH} is at ${head_sha:0:12}, last deployed ${deployed:0:12}"

# ═══════════════════════════════════════════════════════════════════════════
# 2. Merged, and approved by somebody who did not write it
# ═══════════════════════════════════════════════════════════════════════════
#
# `/commits/:sha/pulls` is the only endpoint that answers «which pull request
# produced this commit» for all three merge methods at once:
#
#   merge commit  the merge commit IS `merge_commit_sha`
#   squash        the squashed commit IS `merge_commit_sha`
#   rebase        `merge_commit_sha` is the last rebased commit, which is what
#                 `main` points at afterwards — and `main`'s head is the only
#                 thing this script ever evaluates
#   merge queue   the queue sets `merge_commit_sha` to the commit it landed
#
# Accepting `head.sha` as well covers the case where the PR head itself is what
# ended up on the branch. Anything else — a commit merely *referenced* by some
# PR — does not match either field and is refused.
gh "/commits/${head_sha}/pulls" ||
  die "could not ask GitHub which PR produced ${head_sha:0:12} (HTTP ${gh_status})"

pr=$(printf '%s' "$gh_body" | jq -c --arg sha "$head_sha" --arg base "$BRANCH" '
  if type != "array" then empty else
    [ .[] | select(
        .merged_at != null
        and .base.ref == $base
        and (.merge_commit_sha == $sha or .head.sha == $sha)) ]
    | first // empty
  end')

if [ -z "$pr" ]; then
  # Fails closed, and terminal: a commit that reached `main` without a merged
  # pull request will never grow one. This is the direct-push case, and it is
  # the whole reason this check exists on a plan that cannot enforce a ruleset.
  refuse "$head_sha" \
    "${head_sha:0:12} is not the result of a merged pull request against ${BRANCH} — NOT deploying"
fi

pr_number=$(printf '%s' "$pr" | jq -r '.number')
R_PR="#${pr_number}"
pr_author=$(printf '%s' "$pr" | jq -r '.user.login // empty')
pr_head=$(printf '%s' "$pr" | jq -r '.head.sha // empty')
if [ -z "$pr_author" ] || [ -z "$pr_head" ]; then
  die "PR #${pr_number} came back without an author or a head sha"
fi

gh "/pulls/${pr_number}/reviews?per_page=100" ||
  die "could not read the reviews on PR #${pr_number} (HTTP ${gh_status})"

# One review per reviewer — their LATEST — and it has to be an APPROVED one, on
# the head the PR was merged at, by somebody other than the author.
#
# Taking the latest is what makes a superseded approval stop counting: GitHub
# keeps the old APPROVED row forever, so `any(.state == "APPROVED")` says yes
# long after the same reviewer asked for changes. Dismissed reviews come back
# with `state == "DISMISSED"` and are excluded by the same filter.
#
# `commit_id == $head` is the staleness test. An approval given before another
# push approved a different tree, and GitHub itself calls that stale.
approvals=$(printf '%s' "$gh_body" | jq -r --arg author "$pr_author" --arg head "$pr_head" '
  if type != "array" then 0 else
    [ .[] | select(.user.login != null and .user.login != $author) ]
    | group_by(.user.login)
    | map(sort_by(.submitted_at) | last)
    | map(select(.state == "APPROVED" and .commit_id == $head))
    | length
  end')

if [ "${approvals:-0}" -lt 1 ]; then
  refuse "$head_sha" \
    "PR #${pr_number} (${head_sha:0:12}) has no current APPROVED review from anyone but @${pr_author} — NOT deploying"
fi

R_APPROVAL="APPROVED by ${approvals} reviewer(s) other than the author"
log "PR #${pr_number} merged into ${BRANCH}, approved by ${approvals} reviewer(s) other than its author"

# ═══════════════════════════════════════════════════════════════════════════
# 3. The exact green run, and the required job inside it
# ═══════════════════════════════════════════════════════════════════════════
#
# `/actions/runs?head_sha=` rather than `/commits/:sha/check-runs`, and not by
# preference: GitHub no longer offers **Checks** in the fine-grained token
# permission list at all — checked 2026-08-26 — so the check-runs API cannot be
# granted to a PAT any more. `Commit statuses` is the substitute it looks like
# and is not: Actions reports through check runs, so the legacy combined status
# is empty here and would read as «no CI configured», the one answer that must
# never pass.
#
# `event=push` and `branch=` are not decoration. Without them a `pull_request`
# run — which builds the MERGE commit, not this tree, and which any contributor
# can trigger — satisfies the gate for this sha.
if ! gh "/actions/runs?head_sha=${head_sha}&event=push&branch=${BRANCH}&status=completed&per_page=100"; then
  if [ "$gh_status" = "403" ] || [ "$gh_status" = "404" ]; then
    # Not a failure of this box, and not something a retry fixes. Reading
    # whether CI passed needs **Actions: Read-only** on this repo. 404 is the
    # same answer wearing a different number: a fine-grained token without the
    # scope is told the resource does not exist, rather than that it may not
    # look.
    #
    # Deliberately quiet, and deliberately NOT recorded: the sha stays
    # unrejected, so the minute the permission is added this deploys with
    # nobody re-pushing.
    R_GATE="unreadable — the GitHub token needs «Actions: Read-only» on ${GH_REPO}"
    wait_out "cannot read CI on ${head_sha:0:12} — the GitHub token needs «Actions: Read-only» on ${GH_REPO}. NOT deploying."
  fi
  die "could not read the workflow runs on ${head_sha:0:12} (HTTP ${gh_status})"
fi
checks=$gh_body

# `skipped` is NOT a pass, and neither is `neutral` or `cancelled`.
#
# A whole workflow that skipped — a path filter that stopped matching, a job
# whose `if:` went false, a run cancelled at the queue — used to read as green,
# and a commit nothing had tested would deploy. That is the precise failure
# `Required Quality Gate` was built to make impossible, undone one level up.
#
# Now: at least one completed `push` run on this exact sha, none of them still
# going, and every one concluded `success`. Nothing else is a pass.
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
    R_GATE='no completed push run on this sha yet'
    wait_out "no completed push run on ${head_sha:0:12} yet — waiting"
    ;;
  pending)
    R_GATE='CI still running'
    wait_out "CI still running on ${head_sha:0:12} — waiting"
    ;;
  red)
    failed=$(printf '%s' "$checks" |
      jq -r '[.workflow_runs[] | select(.conclusion != "success") | "\(.name)=\(.conclusion)"] | join(", ")')
    refuse "$head_sha" \
      "CI FAILED on ${head_sha:0:12} (${failed}) — not deploying, and not asking again"
    ;;
  green) ;;
  *) die "could not read the check verdict" ;;
esac

# «every run concluded success» is necessary and not sufficient: it is true of a
# repository where the gate workflow never ran at all, and true again the day
# somebody adds a second trivial workflow and deletes the real one. What has to
# be true is that the ONE check a ruleset would require reported success for
# this commit.
#
# Asked at the JOB level, because that is where the name lives: the workflow is
# «CI» and the aggregator is a job inside it called «Required Quality Gate».
gate_ok=0
for run_id in $(printf '%s' "$checks" | jq -r '.workflow_runs[].id'); do
  if ! gh "/actions/runs/${run_id}/jobs?per_page=100"; then
    die "could not read the jobs of run ${run_id} (HTTP ${gh_status})"
  fi
  if printf '%s' "$gh_body" | jq -e --arg n "$REQUIRED_JOB" \
    'any(.jobs[]; .name == $n and .status == "completed" and .conclusion == "success")' >/dev/null; then
    gate_ok=1
    R_RUN_ID=$run_id
    R_GATE='completed / success'
    break
  fi
done

if [ "$gate_ok" -ne 1 ]; then
  # NOT recorded. Unlike a red commit, this is usually a transient shape — the
  # aggregator queued but not yet reported — and recording it would skip the
  # commit for ever on a race the next tick would have resolved.
  R_GATE='did not succeed on this sha'
  wait_out "«${REQUIRED_JOB}» has not succeeded on ${head_sha:0:12} — not deploying"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 4. The branch race
# ═══════════════════════════════════════════════════════════════════════════
#
# Everything above describes a sha that may already be history: between the
# first call and this line, CI takes minutes, and somebody can push twice in
# that window. Deploying now would build `main` — whatever `main` currently is
# — while REPORTING the sha that passed. The log would name a commit that is
# not what went out, which is the worst kind of wrong: it looks like an audit
# trail.
gh "/commits/${BRANCH}" ||
  die "could not re-read ${BRANCH} before deploying (HTTP ${gh_status})"
head_now=$(printf %s "$gh_body" | jq -r '.sha // empty')
[ -n "$head_now" ] || die "GitHub returned no sha on the re-read of ${BRANCH}"

if [ "$head_now" != "$head_sha" ]; then
  wait_out "${BRANCH} moved ${head_sha:0:12} → ${head_now:0:12} while it was being evaluated — not deploying, the new head gets its own turn"
fi

# ═══════════════════════════════════════════════════════════════════════════
# 5. This host, and which environment it is
# ═══════════════════════════════════════════════════════════════════════════
#
# Read off a RUNNING container rather than out of the config file, because a
# config file states an intention and a container states a fact. If they ever
# disagree the container is right, and it is the one holding the DATABASE_URL
# that migrations are about to be applied through.
#
# No container running means the question cannot be answered, and an
# unanswerable «which environment is this» is a refusal, not a default.
ingest_container=$(container_for "$APP_INGEST")
[ -n "$ingest_container" ] ||
  die "no running container for the ingest application — cannot confirm which environment this is, so not deploying"

# Both sides validated against the same four names `packages/contracts/src/env.ts`
# accepts, and neither is allowed to be something else.
#
# Checking only `live == expected` is not enough on its own: two matching
# misspellings match each other. `EXPECT_ENV_NAME=stagng` against a host that
# also says `stagng` would sail through the equality test while meaning nothing,
# and `parseEnvName` would then refuse to boot the very containers this had
# just approved. So the vocabulary is checked before the comparison.
env_is_known() {
  case "$1" in
    local | test | staging | production) return 0 ;;
    *) return 1 ;;
  esac
}

if ! env_is_known "$EXPECT_ENV_NAME"; then
  die "EXPECT_ENV_NAME=«${EXPECT_ENV_NAME}» is not one of: local, test, staging, production"
fi

live_env=$(env_of "$ingest_container" ENV_NAME)

if [ -z "$live_env" ]; then
  # Unset is its own message. «expected staging, got nothing» reads like a
  # mismatch; it is a container that would not have booted at all, because
  # `parseEnvName` throws on undefined rather than defaulting.
  log "REFUSING: the running ingest container reports no ENV_NAME at all. Not deploying anything."
  exit 0
fi

if ! env_is_known "$live_env"; then
  log "REFUSING: this host reports ENV_NAME=«${live_env}», which is not one of: local, test, staging, production. Not deploying anything."
  exit 0
fi

if [ "$live_env" != "$EXPECT_ENV_NAME" ]; then
  # NOT recorded as rejected: this is a property of the host, not of the sha,
  # and the moment somebody fixes the mismatch every waiting commit is eligible.
  R_ENV="«${live_env:-unset}» — MISMATCH, expected «${EXPECT_ENV_NAME}»"
  wait_out "REFUSING: this host reports ENV_NAME=«${live_env:-unset}» but EXPECT_ENV_NAME=«${EXPECT_ENV_NAME}». Not deploying anything."
fi

R_ENV="${live_env} (matches EXPECT_ENV_NAME)"
log "environment confirmed: ENV_NAME=${live_env}"

# ═══════════════════════════════════════════════════════════════════════════
# 6. Migration preflight
# ═══════════════════════════════════════════════════════════════════════════
#
# What is asked, in order, and any «no» stops the tick:
#
#   · does the ledger hold a migration this candidate does not have?
#     That is the database being AHEAD of the code — what a rollback looks like
#     — and deploying forward over it is how two databases quietly stop being
#     the same schema.
#   · do the migrations this candidate would newly apply contain destructive or
#     backward-incompatible DDL? Then a human has to have said so in the file.
#
# The ledger is read straight out of Postgres with the same `docker exec psql`
# idiom `deploy/restore-drill.sh` already uses, and the column is `name` —
# checked against the running database, not assumed.
psql_() { docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -qtA "$@"; }

# How many processes hold the bot's polling lock. Empty rather than an error if
# the database cannot be asked, so the caller treats «cannot tell» as «not one».
bot_lock_holders() {
  psql_ -c "SELECT count(DISTINCT pid) FROM pg_locks WHERE locktype = 'advisory' AND granted AND classid = 1399324672" 2>/dev/null || printf ''
}

applied=$(psql_ -c 'SELECT name FROM schema_migrations ORDER BY name' 2>/dev/null) ||
  die "could not read schema_migrations out of ${DB_CONTAINER}"

# The candidate's own migrations, at that sha. A tarball rather than 34 content
# calls: one request, one consistent tree, and the same bytes are what gets
# applied a few lines below — so nothing can be checked here and different there.
curl -sS -m 120 -L -K "$CURLDIR/gh" -o "$WORKDIR/src.tgz" \
  "https://api.github.com/repos/${GH_REPO}/tarball/${head_sha}" ||
  die "could not download the tree at ${head_sha:0:12}"

mkdir -p "$WORKDIR/migrations"
# `--strip-components=2` drops GitHub's `owner-repo-sha/migrations/` prefix.
tar -xzf "$WORKDIR/src.tgz" -C "$WORKDIR/migrations" --strip-components=2 --wildcards '*/migrations/*' ||
  die "the tree at ${head_sha:0:12} has no migrations/ directory"

# `|| true` on the grep, and it is not defensive noise: `grep` exits 1 when it
# filters everything away, and under `set -e` a command substitution that ends
# in a failing grep kills the tick with NO message at all — the failure mode
# this very line shipped with, found by the test below.
candidate_migrations=$(find "$WORKDIR/migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' |
  { grep -v '^verify_invariants\.sql$' || true; } | sort)

# An empty list is not «this repository has no migrations», it is «the tarball
# did not unpack where it was expected». Said out loud, because the alternative
# is a preflight that silently approves everything.
[ -n "$candidate_migrations" ] ||
  die "the tree at ${head_sha:0:12} unpacked no migrations — refusing to reason about the schema"

applied_sorted=$(printf '%s\n' "$applied" | { grep -v '^$' || true; } | sort)
unknown=$(comm -23 <(printf '%s\n' "$applied_sorted") <(printf '%s\n' "$candidate_migrations"))
if [ -n "$unknown" ]; then
  refuse "$head_sha" \
    "the database has migration(s) this candidate does not: $(printf '%s' "$unknown" | tr '\n' ' ') — ${head_sha:0:12} is BEHIND the schema. Not deploying."
fi

pending=$(comm -13 <(printf '%s\n' "$applied_sorted") <(printf '%s\n' "$candidate_migrations"))

# Destructive DDL, and what makes it allowed anyway.
#
# `DROP TABLE`, `DROP COLUMN`, `DROP CONSTRAINT`, `TRUNCATE`, a type change and
# a rename are all one-way doors: the forward migration runs fine and the
# PREVIOUS image can no longer read the database, so the rollback path this
# script relies on stops existing the moment the migration commits.
#
# So they are refused unless the file itself carries the marker below. That is
# deliberately a line in the migration rather than a flag on this script or a
# row in a table: it travels with the change, it is visible in the pull request
# diff the approving reviewer read, and it cannot be set by whoever is deploying.
DESTRUCTIVE_RE='(DROP[[:space:]]+(TABLE|COLUMN|CONSTRAINT|TYPE|SCHEMA|INDEX)|TRUNCATE|ALTER[[:space:]]+COLUMN[[:space:]]+[a-zA-Z_"]+[[:space:]]+TYPE|RENAME[[:space:]]+(TO|COLUMN))'
PLAN_MARKER='autodeploy: reviewed-destructive'

for m in $pending; do
  f="$WORKDIR/migrations/$m"
  if grep -qiE "$DESTRUCTIVE_RE" "$f" && ! grep -qF "$PLAN_MARKER" "$f"; then
    refuse "$head_sha" \
      "${m} contains destructive or backward-incompatible DDL and carries no «${PLAN_MARKER}» line — a reviewed migration plan is required. NOT deploying ${head_sha:0:12}."
  fi
done

if [ -n "$pending" ]; then
  R_MIGRATIONS="would apply: $(printf '%s' "$pending" | tr '\n' ' ')"
  log "migrations to apply: $(printf '%s' "$pending" | tr '\n' ' ')"
else
  R_MIGRATIONS='none pending'
  log "no pending migrations"
fi

# ═══════════════════════════════════════════════════════════════════════════
# The decision
# ═══════════════════════════════════════════════════════════════════════════
if [ "$DRY_RUN" -eq 1 ]; then
  R_DECISION="WOULD DEPLOY ${head_sha} to all three applications"
  exit 0
fi

log "deploying ${head_sha:0:12}: merged PR #${pr_number}, approved, «${REQUIRED_JOB}» green, ${BRANCH} unmoved"

started=$(date -u +%FT%TZ)

# ═══════════════════════════════════════════════════════════════════════════
# 7. Schema, before anything that would refuse to start without it
# ═══════════════════════════════════════════════════════════════════════════
#
# `deploy/entrypoint.sh` gates every service on the ledger matching its own
# checkout, so a container built from a candidate with pending migrations
# refuses to start. The migrations therefore have to be applied BEFORE the first
# application is deployed, not by it.
#
# Applied by handing the candidate's migration files to a container that already
# holds the DATABASE_URL, rather than by putting a second copy of that URL in
# this script's config. `MIGRATIONS_DIR` is an override `packages/db/src/schemaCli.ts`
# already has, `up()` already takes the Postgres advisory lock and already writes
# a ledger row per file inside that file's own transaction — so this adds a path
# and no mechanism.
#
# ponytail: the RUNNING container's migration runner applies the CANDIDATE's SQL,
# so a candidate that changes `up()` itself takes effect one deploy late. Move to
# a one-off container built from the candidate image if the runner ever becomes
# the thing that changes.
if [ -n "$pending" ]; then
  docker cp "$WORKDIR/migrations" "${ingest_container}:/tmp/shikoo-migrations-${head_sha}" >/dev/null ||
    die "could not hand the candidate's migrations to ${ingest_container}"
  if ! docker exec -e "MIGRATIONS_DIR=/tmp/shikoo-migrations-${head_sha}" "$ingest_container" \
    node --import tsx packages/db/src/schemaCli.ts up; then
    die "applying the migrations for ${head_sha:0:12} failed — nothing was deployed"
  fi
  # Proven, not assumed. `status` exits 1 on any of pending, DRIFT or UNKNOWN.
  docker exec -e "MIGRATIONS_DIR=/tmp/shikoo-migrations-${head_sha}" "$ingest_container" \
    node --import tsx packages/db/src/schemaCli.ts status ||
    die "the schema still does not match ${head_sha:0:12} after applying — nothing was deployed"
  docker exec "$ingest_container" rm -rf "/tmp/shikoo-migrations-${head_sha}" 2>/dev/null || true
fi

# The invariants, from the candidate's own tree. A forward migration that
# preserved every constraint and broke a money guarantee passes every check
# above this line and fails here.
if [ -r "$WORKDIR/migrations/verify_invariants.sql" ]; then
  if docker exec -i "$DB_CONTAINER" psql -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1 -q \
    < "$WORKDIR/migrations/verify_invariants.sql" >/dev/null 2>&1; then
    log "database invariants pass"
  else
    die "the database invariants FAILED after migrating to ${head_sha:0:12} — nothing was deployed, and no migration was reversed"
  fi
fi

# ═══════════════════════════════════════════════════════════════════════════
# 8. Deploy, one application at a time, to that exact sha
# ═══════════════════════════════════════════════════════════════════════════
#
# The order is read off the code, not chosen:
#
#   ingest     first, because `apps/dashboard-worker` is configured with
#              INGEST_URL and the reverse edge does not exist
#   dashboard  second
#   bot        last, and alone. `apps/bot/src/singleton.ts` holds a session-level
#              Postgres advisory lock keyed on the token for the life of the
#              process, and a second poller BLOCKS on it rather than racing —
#              so Coolify's start-new-then-stop-old window cannot produce two
#              `getUpdates` callers. Deploying it last means that window is the
#              only thing still moving when it opens.
#
# Postgres is not in the list and never will be: it is a Coolify database
# resource, this script only ever names the three application uuids, and a
# deploy has no business restarting the thing holding the data.
APP_ORDER="ingest:${APP_INGEST} dashboard:${APP_DASHBOARD} bot:${APP_BOT}"

deployed_uuids=''   # apps this tick has already pointed at the candidate
deploy_records=''   # "name=<uuid>" pairs for the journal

# Point one application at an immutable sha and wait for it to land.
#
# `git_commit_sha` is what makes this immutable rather than «deploy whatever
# main is now»: Coolify's `ApplicationDeploymentJob::shouldResolveBranchHeadCommit()`
# resolves the branch head ONLY when the field is empty or the literal `HEAD`,
# and checks out the exact commit otherwise. The same value becomes the image
# tag and the container's `SOURCE_COMMIT`, which is what the health checks below
# read back.
deploy_app() { # name uuid sha
  local name=$1 uuid=$2 sha=$3 dep_uuid got

  co "/applications/${uuid}" PATCH "$(jq -nc --arg s "$sha" '{git_commit_sha:$s}')" ||
    { log "ERROR pinning ${name} to ${sha:0:12} (HTTP ${co_status})"; return 1; }

  co "/applications/${uuid}" ||
    { log "ERROR re-reading ${name} (HTTP ${co_status})"; return 1; }
  got=$(printf '%s' "$co_body" | jq -r '.git_commit_sha // empty')
  if [ "$got" != "$sha" ]; then
    log "ERROR ${name} reports git_commit_sha=${got:-unset}, expected ${sha:0:12} — refusing to deploy it"
    return 1
  fi
  if [ "$(printf '%s' "$co_body" | jq -r '.git_branch // empty')" != "$BRANCH" ]; then
    log "ERROR ${name} is not on ${BRANCH} any more — refusing to deploy it"
    return 1
  fi

  co "/deploy?uuid=${uuid}" POST ||
    { log "ERROR queueing ${name} (HTTP ${co_status})"; return 1; }
  dep_uuid=$(printf '%s' "$co_body" | jq -r '.deployments[0].deployment_uuid // empty')
  [ -n "$dep_uuid" ] ||
    { log "ERROR ${name}: Coolify queued nothing"; return 1; }
  log "${name}: deployment ${dep_uuid} queued for ${sha:0:12}"
  deploy_records="${deploy_records}${deploy_records:+ }${name}=${dep_uuid}"

  wait_deployment "$name" "$dep_uuid" "$sha"
}

# Bounded, and terminal-state rather than «looks done». Coolify's own enum is
# queued · in_progress · finished · failed · cancelled-by-user.
wait_deployment() { # name deployment_uuid sha
  local name=$1 dep_uuid=$2 sha=$3 waited=0 status commit
  while [ "$waited" -lt "$DEPLOY_TIMEOUT" ]; do
    if co "/deployments/${dep_uuid}"; then
      status=$(printf '%s' "$co_body" | jq -r '.status // empty')
      case "$status" in
        finished)
          commit=$(printf '%s' "$co_body" | jq -r '.commit // empty')
          if [ "$commit" != "$sha" ]; then
            log "ERROR ${name}: Coolify deployed ${commit:0:12}, not ${sha:0:12}"
            return 1
          fi
          log "${name}: deployment finished at ${sha:0:12}"
          return 0
          ;;
        failed|cancelled-by-user)
          log "ERROR ${name}: deployment ${status}"
          return 1
          ;;
      esac
    fi
    sleep "$POLL_SECS"
    waited=$((waited + POLL_SECS))
  done
  log "ERROR ${name}: deployment ${dep_uuid} did not reach a terminal state in ${DEPLOY_TIMEOUT}s"
  return 1
}

# Does the thing that is now RUNNING answer, and is it the sha we asked for.
#
# Nothing here weakens a gate to get an answer. The dashboard's
# `/api/v1/version` sits behind the session gate and stays there — a 401 from it
# is treated as proof the process is answering, and the sha comes from the
# container's own `SOURCE_COMMIT`, which only somebody on this box can read.
health_check() { # name uuid sha
  local name=$1 uuid=$2 sha=$3 waited=0 c
  while [ "$waited" -lt "$HEALTH_TIMEOUT" ]; do
    c=$(container_for "$uuid")
    if [ -n "$c" ] && [ "$(env_of "$c" SOURCE_COMMIT)" = "$sha" ]; then
      case "$name" in
        ingest)
          # 200 on /health, and /version naming this sha and this environment.
          if docker exec "$c" node -e '
            const want = process.argv[1], env = process.argv[2];
            const base = "http://127.0.0.1:" + (process.env.PORT || 8787);
            (async () => {
              const h = await fetch(base + "/health");
              if (h.status !== 200) process.exit(1);
              const v = await (await fetch(base + "/version")).json();
              process.exit(v.version === want && v.env === env ? 0 : 1);
            })().catch(() => process.exit(1));
          ' "$sha" "$EXPECT_ENV_NAME" 2>/dev/null; then
            log "${name}: /health 200, /version ${sha:0:12} env=${EXPECT_ENV_NAME}"
            return 0
          fi
          ;;
        dashboard)
          # Container healthy, and the protected route still refuses anonymously.
          if [ "$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null)" = 'healthy' ] &&
            docker exec "$c" node -e '
              const base = "http://127.0.0.1:" + (process.env.PORT || 8788);
              (async () => {
                const pub = await fetch(base + "/api/v1/health");
                const gated = await fetch(base + "/api/v1/version");
                process.exit(pub.status === 200 && gated.status === 401 ? 0 : 1);
              })().catch(() => process.exit(1));
            ' 2>/dev/null; then
            log "${name}: container healthy, /api/v1/version still 401 anonymously, SOURCE_COMMIT=${sha:0:12}"
            return 0
          fi
          ;;
        bot)
          # Three separate claims, and the third is the one that matters.
          #
          #   containers   how many are up. Cheap, and wrong on its own: during
          #                a deploy Coolify starts the new one before stopping
          #                the old, so two containers is a normal transient.
          #   healthy      the image's own HEALTHCHECK (Dockerfile:186), which
          #                for the bot is the heartbeat file's age.
          #   lock holders `pg_advisory_lock` holders in Postgres. THIS is what
          #                «exactly one poller» means. A container can be up and
          #                healthy while blocked on the lock and polling nothing;
          #                it can also be mid-exit while still holding it.
          #
          # 1399324672 is 0x5368_0000 — `BOT_LOCK_NAMESPACE` in
          # `apps/bot/src/singleton.ts`, read out of the code rather than
          # assumed. One granted holder is one poller for this token. Two means
          # a deploy overlapped and Telegram is handing updates to a container
          # that is about to die; zero means nothing is polling, however healthy
          # the container looks.
          local n holders
          n=$(docker ps --filter "name=^${uuid}-" --format '{{.Names}}' | wc -l)
          holders=$(bot_lock_holders)
          if [ "$n" -ne 1 ]; then
            log "${name}: ${n} containers up — waiting for the singleton lock to settle"
          elif [ "$holders" != '1' ]; then
            log "${name}: ${holders:-no} advisory-lock holder(s) — waiting for exactly one poller"
          elif [ "$(docker inspect "$c" --format '{{.State.Health.Status}}' 2>/dev/null)" = 'healthy' ]; then
            log "${name}: exactly one poller holds the lock, heartbeat fresher than ${BOT_HEARTBEAT_MAX_AGE}s, SOURCE_COMMIT=${sha:0:12}"
            return 0
          fi
          ;;
      esac
    fi
    sleep "$POLL_SECS"
    waited=$((waited + POLL_SECS))
  done
  log "ERROR ${name}: did not become healthy at ${sha:0:12} within ${HEALTH_TIMEOUT}s"
  return 1
}

# What a failure costs, and what it does not.
#
# The applications go back to the previous sha. The DATABASE DOES NOT: a forward
# migration is not reversed here, ever, and this script does not pretend it was.
# What makes the code rollback survivable is that `schemaCli`'s gate treats a
# database AHEAD of the checkout as a WARNING rather than a refusal — so the
# previous image starts on the migrated schema. A candidate whose migration is
# irreversible never reaches this point: it was refused in the preflight above
# unless a human wrote a plan into the file.
rollback() {
  local prev=$1 app name uuid failed=0
  if [ -z "$prev" ]; then
    log "ROLLBACK IMPOSSIBLE: no previously deployed sha is recorded. Applications are left as they are — a person has to look."
    return 1
  fi
  log "ROLLING BACK to ${prev:0:12}"
  for app in $deployed_uuids; do
    name=${app%%:*}; uuid=${app#*:}
    if deploy_app "$name" "$uuid" "$prev" && health_check "$name" "$uuid" "$prev"; then
      log "${name}: rolled back to ${prev:0:12} and healthy"
    else
      failed=$((failed + 1))
      log "ROLLBACK FAILED for ${name} — it is on neither sha cleanly. A person has to look."
    fi
  done
  return "$failed"
}

record() { # verdict
  printf '{"at":"%s","finished":"%s","candidate":"%s","previous":"%s","pr":%s,"deployments":"%s","verdict":"%s"}\n' \
    "$started" "$(date -u +%FT%TZ)" "$head_sha" "$deployed" "$pr_number" "$deploy_records" "$1" >> "$JOURNAL"
  chmod 0600 "$JOURNAL" 2>/dev/null || true
}

for app in $APP_ORDER; do
  app_name=${app%%:*}
  app_uuid=${app#*:}
  if deploy_app "$app_name" "$app_uuid" "$head_sha"; then
    deployed_uuids="${deployed_uuids}${deployed_uuids:+ }${app_name}:${app_uuid}"
    if health_check "$app_name" "$app_uuid" "$head_sha"; then
      continue
    fi
  else
    # It may or may not have been pinned before it failed. Treat it as changed:
    # rolling back something that never moved is a no-op, and NOT rolling back
    # something that did is how a half-deployed sha survives a failure.
    deployed_uuids="${deployed_uuids}${deployed_uuids:+ }${app_name}:${app_uuid}"
  fi

  # Stop. Everything after this application in the order depends on it, and
  # deploying a bot against an ingest that did not come up is how one failure
  # becomes three.
  log "STOPPING: ${app_name} did not come up at ${head_sha:0:12}. Applications after it in the order were not touched."
  log "diagnostics: $(docker ps -a --filter "name=^${app_uuid}-" --format '{{.Names}} {{.Status}}' | head -3 | tr '\n' ';')"
  if rollback "$deployed"; then
    record 'failed-rolled-back'
    die "${head_sha:0:12} failed at ${app_name} and was rolled back to ${deployed:0:12}. NOT recorded as deployed."
  fi
  record 'failed-rollback-incomplete'
  die "${head_sha:0:12} failed at ${app_name} AND the rollback did not complete. NOT recorded as deployed. A person has to look."
done

# Recorded only now: every application is on this sha and every check passed.
printf '%s' "$head_sha" > "$STATE"
rm -f "$REJECTED"
record 'deployed'
log "${head_sha:0:12} is deployed and healthy on ingest, dashboard and bot"
