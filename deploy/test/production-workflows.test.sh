#!/usr/bin/env bash
# The two production dispatches, asserted on their shape.
#
# actionlint checks that these files are valid YAML with valid expressions. It
# cannot check that `Cutover Production` is the only one that moves a domain, or
# that neither accepts a field naming what to ship — those are properties of
# what the files MEAN, and they are exactly the properties whose loss would be
# invisible in review.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PREP="$ROOT/.github/workflows/prepare-production.yml"
CUT="$ROOT/.github/workflows/cutover-production.yml"
STAGE="$ROOT/.github/workflows/deploy-staging.yml"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

has() { grep -qF -- "$2" "$1"; }
want() { # file name substring
  if has "$1" "$3"; then ok "$2"; else bad "$2" "$(basename "$1") does not contain: $3"; fi
}
refute() { # file name substring
  if has "$1" "$3"; then bad "$2" "$(basename "$1") still contains: $3"; else ok "$2"; fi
}

for f in "$PREP" "$CUT"; do
  [ -r "$f" ] || { echo "missing workflow: $f" >&2; exit 1; }
done

section 'neither production dispatch names what to ship'

# The load-bearing pair. Every other guard in this pipeline exists to prove that
# what ships is what was reviewed; a field naming the artifact hands that answer
# to whoever pressed the button.
for f in "$PREP" "$CUT"; do
  n=$(basename "$f" .yml)
  for forbidden in sha ref digest image tag run_id revision commit; do
    if grep -qE "inputs\.${forbidden}\b" "$f"; then
      bad "${n}: no user-supplied ${forbidden}" "it reads inputs.${forbidden}"
    else
      ok "${n}: no user-supplied ${forbidden}"
    fi
  done
  # `confirm` is the only input either of them may have.
  inputs=$(awk '/^on:/,/^permissions:/' "$f" | grep -cE '^      [a-z_]+:' || true)
  if [ "${inputs:-0}" -eq 1 ]; then
    ok "${n}: confirm is the only input"
  else
    bad "${n}: confirm is the only input" "found ${inputs} inputs"
  fi
done

section 'both are manual, owner-only, main-only, and default to cancel'

for f in "$PREP" "$CUT"; do
  n=$(basename "$f" .yml)
  want "$f" "${n}: dispatch only" 'workflow_dispatch:'
  want "$f" "${n}: refuses any ref but main" "refs/heads/main"
  # The single quotes are the point: this is the literal text of the workflow
  # file, not an expression to expand. SC2016 is the expected reading.
  # shellcheck disable=SC2016
  want "$f" "${n}: checks the actor against the owner" 'ACTOR" != "$OWNER'
  want "$f" "${n}: the confirm choice defaults to cancel" "default: 'no — cancel'"
  want "$f" "${n}: shares the deploy concurrency group" 'group: shikoo-deploy'
  want "$f" "${n}: never cancels a running release" 'cancel-in-progress: false'
  # A production release must not be startable by anything that is not a person.
  if awk '/^on:/,/^permissions:/' "$f" | grep -qE '^\s+(push|pull_request|workflow_run|schedule|repository_dispatch):'; then
    bad "${n}: no automatic trigger can reach production" 'it has an automatic trigger'
  else
    ok "${n}: no automatic trigger can reach production"
  fi
done

want "$PREP" 'prepare requires the exact word PREPARE' "'PREPARE'"
want "$CUT" 'cutover requires the exact word CUTOVER' "'CUTOVER'"
refute "$PREP" 'prepare cannot be confirmed with the cutover word' "!= 'CUTOVER'"

section 'the gate holds no deployment credential'

for f in "$PREP" "$CUT"; do
  n=$(basename "$f" .yml)
  gate=$(awk '/^  (prepare|cutover)-gate:/,/^  (prepare|cutover):$/' "$f")
  if printf '%s' "$gate" | grep -q 'secrets.DEPLOY_'; then
    bad "${n}: the gate job holds no DEPLOY_* secret" 'it references one'
  else
    ok "${n}: the gate job holds no DEPLOY_* secret"
  fi
  if printf '%s' "$gate" | grep -q 'environment:'; then
    bad "${n}: the gate job enters no environment" 'it names one'
  else
    ok "${n}: the gate job enters no environment"
  fi
done

section 'only cutover moves customer traffic'

# Preparation exists precisely so that everything reversible happens while the
# old applications are still serving. If it learned to move a domain or touch
# the bot, that separation would be gone and nobody would see it go.
refute "$PREP" 'preparation never moves a live domain' 'cutover-production.sh'
refute "$PREP" 'preparation never starts or stops a bot' '/start'
want "$PREP" 'preparation runs the P1–P10 script' 'prepare-production.sh'
want "$CUT" 'cutover runs the P11–P17 script' 'cutover-production.sh'
want "$CUT" 'cutover observes production before comparing' 'observe-production.sh'
want "$CUT" 'cutover compares against the preparation manifest' 'verify-preparation-manifest.sh'

# The circularity that would make the drift check meaningless: reading the sha
# and digest out of the preparation manifest and then checking the manifest
# against them is the manifest agreeing with itself.
want "$CUT" 'cutover derives sha and digest from the staging release, not the preparation' \
  'verify-release-manifest.sh'

section 'provenance is resolved server-side in both'

for f in "$PREP" "$CUT"; do
  n=$(basename "$f" .yml)
  want "$f" "${n}: selects the staging run rather than accepting one" 'pick-staging-run.sh'
done
want "$CUT" 'cutover selects the preparation run by workflow, not by input' 'WORKFLOW_FILE: prepare-production.yml'
want "$CUT" 'cutover accepts only a dispatched preparation run' 'ALLOWED_EVENTS: workflow_dispatch'

section 'the staging workflow still cannot reach production'

refute "$STAGE" 'deploy-staging names no production environment' 'environment: production'
refute "$STAGE" 'deploy-staging does not move production domains' 'cutover-production'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
