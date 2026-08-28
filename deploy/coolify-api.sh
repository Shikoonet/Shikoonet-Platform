# One Coolify API client, because four of them were four copies of one bug.
#
# ─────────────────────────────────────────────────────────────────────────────
# THE BUG THIS FILE EXISTS TO NOT HAVE FOUR TIMES
#
# The natural way to write a client that needs both a body and a status code is
# to return the body on stdout and leave the status in a variable:
#
#     api_status=0
#     api() { out=$(curl -w '%{http_code}' …); api_status=${out: -3}; printf '%s' "${out:0:-3}"; }
#     body=$(api GET /teams/current)
#     [ "$api_status" = '200' ] || die "refused (HTTP $api_status)"
#
# That reads correctly and is always wrong. `body=$(api …)` runs `api` in a
# SUBSHELL, so the assignment to `api_status` dies with it and the parent still
# sees `0`. Every request then looks refused, whatever the server said — which
# is exactly how a working token and a 200 response produced «the token was
# refused (HTTP 0)».
#
# It is the same shape as the created-count bug in
# `ensure-production-candidates.sh`: a value written inside `$(...)` and read
# outside it. Bash gives no warning for either.
#
# So there is no command substitution here. `coolify_api` is called as a plain
# command and leaves BOTH results in globals, which survive because nothing
# forked to produce them:
#
#     coolify_api GET /teams/current || die "could not reach Coolify"
#     [ "$API_STATUS" = '200' ] || die "refused (HTTP $API_STATUS)"
#     name=$(printf '%s' "$API_BODY" | …)
#
# ── Transport failure and HTTP failure are different answers ──────────────
#
# `curl -sS` exits 0 for a 401 and non-zero when it could not speak to anything
# at all, and those need telling apart: one means "the server said no", the
# other means "there was no server". A caller that collapses them reports an
# auth problem during an outage. So a transport failure returns non-zero with
# `API_STATUS=000`, and an HTTP failure returns 0 with the real code — the
# status is the answer, and the return value is whether there was one.
#
# ── The token ────────────────────────────────────────────────────────────
#
# Read as text, never `source`d: a Coolify token is `<id>|<random>` and a shell
# would execute the pipe. It reaches curl through a 0600 config file and never
# through argv, which every process on the host can read. It is never printed,
# never logged and never returned.
#
# Sourced, not executed. `ci.yml` runs shellcheck with `-x`, so this file is
# checked as part of each of its callers.

# shellcheck shell=bash

# Read by every caller of `coolify_api`, which shellcheck cannot see from
# inside this file alone.
# shellcheck disable=SC2034
API_BODY=''
API_STATUS=000
COOLIFY_API_DIR=''

# Reads COOLIFY_URL/COOLIFY_TOKEN out of a deploy.env and prepares curl.
coolify_api_init() { # <path-to-deploy.env>
  local conf=$1 url token
  [ -r "$conf" ] || {
    echo "cannot read ${conf}" >&2
    return 1
  }
  url=$(sed -n 's/^COOLIFY_URL=//p' "$conf" | head -n1)
  token=$(sed -n 's/^COOLIFY_TOKEN=//p' "$conf" | head -n1)
  if [ -z "$url" ] || [ -z "$token" ]; then
    echo "${conf} has no COOLIFY_URL/COOLIFY_TOKEN" >&2
    return 1
  fi
  COOLIFY_URL=$url
  COOLIFY_API_DIR=$(mktemp -d)
  chmod 700 "$COOLIFY_API_DIR"
  {
    printf 'header = "Authorization: Bearer %s"\n' "$token"
    printf 'header = "Accept: application/json"\n'
  } >"$COOLIFY_API_DIR/c"
  chmod 600 "$COOLIFY_API_DIR/c"
  # Out of the environment the moment curl can read it from the file instead.
  unset token
}

coolify_api_cleanup() {
  [ -z "$COOLIFY_API_DIR" ] || rm -rf "$COOLIFY_API_DIR"
  COOLIFY_API_DIR=''
}

# coolify_api METHOD PATH [json-body]
#   returns 0 when the server answered at all; API_STATUS carries what it said
#   returns 1 when nothing answered;         API_STATUS is 000
coolify_api() {
  local method=$1 path=$2 body=${3:-} out
  API_BODY=''
  API_STATUS=000
  if [ -n "$body" ]; then
    out=$(curl -sS -m 45 -w '%{http_code}' -K "$COOLIFY_API_DIR/c" \
      -X "$method" -H 'Content-Type: application/json' \
      --data-binary "$body" "${COOLIFY_URL}/api/v1${path}" 2>/dev/null) || return 1
  else
    out=$(curl -sS -m 45 -w '%{http_code}' -K "$COOLIFY_API_DIR/c" \
      -X "$method" "${COOLIFY_URL}/api/v1${path}" 2>/dev/null) || return 1
  fi
  # The status is the LAST three characters, appended by -w. Splitting on a
  # newline instead breaks on any body ending in one, which every
  # pretty-printed error does.
  [ ${#out} -ge 3 ] || return 1
  API_STATUS=${out: -3}
  # shellcheck disable=SC2034
  API_BODY=${out:0:${#out}-3}
  return 0
}

# The common case: answered, and answered with a 2xx.
coolify_api_ok() { # METHOD PATH [body]
  coolify_api "$@" || return 1
  case "$API_STATUS" in 2??) return 0 ;; *) return 1 ;; esac
}
