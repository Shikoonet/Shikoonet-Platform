#!/usr/bin/env bash
# The manual staging redeploy takes no revision. This is what it deploys instead.
#
# ─────────────────────────────────────────────────────────────────────────────
# WHY THERE IS NO `sha` INPUT
#
# A `workflow_dispatch` input naming a commit, a digest, an image or a ref is a
# way to ask this pipeline to ship something `main` does not contain. Every
# other guard downstream — the approval gate, the revision label, the manifest
# — is about proving that what ships is what was reviewed; an input that names
# the artifact hands the answer to whoever pressed the button.
#
# So the dispatch names nothing. The workflow resolves `refs/heads/main` on the
# server, and this script then refuses to let that sha through unless CI has
# already passed on it, as a push, on main. The automatic path gets that fact
# from `workflow_run` for free; the manual path has to go and ask.
#
# What this replaces is the dummy commit — an empty commit pushed to main
# purely to make `workflow_run` fire. That worked, and it wrote a lie into the
# history of a repository whose whole deployment story is provenance.
#
# ─────────────────────────────────────────────────────────────────────────────
# Run: require-ci-run.sh <owner/repo> <sha>
# Emits `ci_run_id=<id>` to $GITHUB_OUTPUT when it passes. Denies otherwise.

set -Eeuo pipefail

REPO=${1:-}
SHA=${2:-}
if [ -z "$REPO" ] || [ -z "$SHA" ]; then
  echo "usage: require-ci-run.sh <owner/repo> <sha>" >&2
  exit 2
fi
if ! [[ $SHA =~ ^[0-9a-f]{40}$ ]]; then
  echo "refusing: '$SHA' is not a full 40-character commit sha" >&2
  exit 2
fi

: "${GITHUB_TOKEN:?GITHUB_TOKEN must be set}"
API=${GITHUB_API:-https://api.github.com}
BRANCH=${BRANCH:-main}
CI_WORKFLOW=${CI_WORKFLOW:-ci.yml}

say() { echo "[ci-run] $*"; }
deny() {
  echo "[ci-run] DENIED: $*" >&2
  exit 1
}

# Same handling as the approval gate: the token reaches curl through a config
# file, never argv, because argv is readable by every process on the runner.
CURLDIR=$(mktemp -d)
trap 'rm -rf "$CURLDIR"' EXIT
chmod 700 "$CURLDIR"
{
  printf 'header = "Authorization: Bearer %s"\n' "$GITHUB_TOKEN"
  printf 'header = "Accept: application/vnd.github+json"\n'
  printf 'header = "X-GitHub-Api-Version: 2022-11-28"\n'
} >"$CURLDIR/gh"
chmod 600 "$CURLDIR/gh"

gh_status=0
gh_body=''
gh() {
  local out
  out=$(curl -sS -m 30 -w '%{http_code}' -K "$CURLDIR/gh" "${API}/repos/${REPO}$1") || {
    gh_status=0
    gh_body=''
    return 1
  }
  gh_status=${out: -3}
  gh_body=${out:0:${#out}-3}
  [ "$gh_status" = "200" ]
}

gh "/actions/workflows/${CI_WORKFLOW}/runs?head_sha=${SHA}&per_page=100" ||
  deny "could not ask whether CI ran on ${SHA:0:12} (HTTP ${gh_status}) — failing closed"

# All four conditions in one filter, because a run that satisfies three of them
# is not a partial pass:
#
#   event == 'push'          a CI run from a PULL REQUEST must never authorise a
#                            deploy — a fork's run completing is something an
#                            outsider can trigger. This is the same refusal the
#                            `workflow_run` trigger makes on the automatic path.
#   head_branch == 'main'    the same commit can be the head of a branch that
#                            was never merged.
#   status == 'completed'    an in-flight run has concluded nothing.
#   conclusion == 'success'  cancelled and skipped are not passes.
run_id=$(printf '%s' "$gh_body" | jq -r --arg branch "$BRANCH" '
  if (.workflow_runs | type) != "array" then empty else
    [ .workflow_runs[]
      | select(.event == "push"
               and .head_branch == $branch
               and .status == "completed"
               and .conclusion == "success") ]
    | sort_by(.run_started_at) | last | .id // empty
  end') || deny "could not parse the CI runs for ${SHA:0:12}"

# Told apart on purpose. «CI never ran» and «CI ran and failed» are different
# mistakes — the first usually means the sha is not on main at all, the second
# means somebody is trying to redeploy over a red build — and a single message
# covering both sends the reader looking in the wrong place.
if [ -z "$run_id" ]; then
  any=$(printf '%s' "$gh_body" | jq -r '(.workflow_runs | length) // 0') || any=0
  if [ "${any:-0}" -eq 0 ]; then
    deny "no CI run exists for ${SHA:0:12} — nothing has tested this commit"
  fi
  deny "no CI run for ${SHA:0:12} is a completed, successful push on ${BRANCH} (${any} run(s) exist, none qualifying)"
fi

say "CI run ${run_id} passed on ${SHA:0:12} as a push to ${BRANCH}"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  printf 'ci_run_id=%s\n' "$run_id" >>"$GITHUB_OUTPUT"
fi
