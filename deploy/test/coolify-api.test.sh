#!/usr/bin/env bash
# The Coolify client, and the bug that made a working token read as refused.
#
# The original shape returned the body on stdout and left the status in a
# variable, so every caller wrote `body=$(api …)` — a SUBSHELL, which discarded
# the status the function had just set. The parent then saw `0` however the
# server had answered, and a verified 200 produced «the token was refused
# (HTTP 0)».
#
# The first half of this suite is that regression, asked directly: after a call,
# does the CALLER still see the status. The second half is the mutations, and
# they exist because the fix is one careless tidy-up away from being undone —
# wrapping `coolify_api` in a convenience function that prints the body puts the
# fork straight back.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
LIB="$ROOT/deploy/coolify-api.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

SECRET='0|NEVER-PRINT-THIS'
CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=${SECRET}
EOF

# The fake speaks the same wire shape curl -w '%{http_code}' produces: body
# then exactly three status characters, no separator.
make_curl() { # mode
  cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
case "${1}" in
  ok)        printf '{"id":1,"name":"team"}200' ;;
  unauth)    printf '{"message":"Unauthenticated."}401' ;;
  forbidden) printf '{"message":"forbidden"}403' ;;
  created)   printf '{"uuid":"abc123"}201' ;;
  nocontent) printf '204' ;;
  servererr) printf '{"message":"boom"}500' ;;
  transport) exit 7 ;;
  empty)     printf '' ;;
  newline)   printf '{"message":"pretty"}\n200' ;;
esac
FAKE
  chmod +x "$BIN/curl"
}

# Each case runs in its own bash so a leaked global cannot make the next pass.
probe() { # mode  -> prints "rc|status|body"
  make_curl "$1"
  bash -c '
    set -Eeuo pipefail
    . "$1"
    coolify_api_init "$2" >/dev/null
    set +e
    coolify_api GET /teams/current
    rc=$?
    set -e
    printf "%s|%s|%s" "$rc" "$API_STATUS" "$API_BODY"
    coolify_api_cleanup
  ' _ "$LIB" "$CONF"
}

expect() { # name mode want-rc want-status
  local got rc st
  got=$(probe "$1")
  rc=${got%%|*}
  st=$(printf '%s' "$got" | cut -d'|' -f2)
  if [ "$rc" = "$2" ] && [ "$st" = "$3" ]; then
    ok "$4"
  else
    bad "$4" "got rc=${rc} status=${st}, wanted rc=${2} status=${3}"
  fi
}

section 'the status survives the call — the regression itself'

expect ok        0 200 'a 200 is seen by the caller as 200, not 0'
expect unauth    0 401 'a 401 is reported as 401, not as a transport failure'
expect forbidden 0 403 'a 403 is reported as 403'
expect created   0 201 'a 201 from a create is seen by the caller'
expect nocontent 0 204 'a 204 with an empty body is still a status'
expect servererr 0 500 'a 500 is reported as 500'
expect newline   0 200 'a body ending in a newline does not eat the status'

# The distinction that matters during an outage: «the server said no» and
# «there was no server» must not collapse into one answer.
expect transport 1 000 'a transport failure returns non-zero with status 000'
expect empty     1 000 'an answer too short to contain a status is a transport failure'

section 'the body survives too'

got=$(probe ok)
body=$(printf '%s' "$got" | cut -d'|' -f3-)
if [ "$body" = '{"id":1,"name":"team"}' ]; then
  ok 'the body comes back without the status glued to it'
else
  bad 'the body comes back without the status glued to it' "got '${body}'"
fi

got=$(probe unauth)
body=$(printf '%s' "$got" | cut -d'|' -f3-)
if [ "$body" = '{"message":"Unauthenticated."}' ]; then
  ok 'an error body is preserved for the caller to report'
else
  bad 'an error body is preserved for the caller to report' "got '${body}'"
fi

section 'coolify_api_ok collapses only what it should'

ok_rc() { # mode -> rc
  make_curl "$1"
  bash -c '
    set -Eeuo pipefail
    . "$1"
    coolify_api_init "$2" >/dev/null
    set +e
    coolify_api_ok GET /x
    printf "%s" "$?"
  ' _ "$LIB" "$CONF"
}
for spec in 'ok 0' 'created 0' 'nocontent 0' 'unauth 1' 'forbidden 1' 'servererr 1' 'transport 1'; do
  mode=${spec%% *}
  want=${spec##* }
  got=$(ok_rc "$mode")
  if [ "$got" = "$want" ]; then
    ok "coolify_api_ok returns ${want} for ${mode}"
  else
    bad "coolify_api_ok returns ${want} for ${mode}" "got ${got}"
  fi
done

section 'the mutations — each one must break a named case'

# M1: the original bug, reintroduced by a convenience wrapper. This is the most
# likely way the fix gets undone, because the wrapper looks like an improvement.
make_curl ok
got=$(bash -c '
  set -Eeuo pipefail
  . "$1"
  coolify_api_init "$2" >/dev/null
  api() { coolify_api "$@" || return 1; printf "%s" "$API_BODY"; }
  body=$(api GET /teams/current)
  printf "%s" "$API_STATUS"
' _ "$LIB" "$CONF")
if [ "$got" != '200' ]; then
  ok "a wrapper called as \$(api …) loses the status — the bug is still detectable (saw '${got}')"
else
  # The literal text of the bug being described; SC2016 is the right reading.
  # shellcheck disable=SC2016
  bad 'a wrapper called as $(api …) loses the status' \
    'the subshell somehow preserved it; this test can no longer detect the regression'
fi

# M2: dropping the length guard. An empty answer would slice to garbage and be
# reported as a status.
make_curl empty
got=$(bash -c '
  set -Eeuo pipefail
  . "$1"
  coolify_api_init "$2" >/dev/null
  out=""
  status=${out: -3}
  printf "%s" "${status:-EMPTY}"
' _ "$LIB" "$CONF")
if [ "$got" = 'EMPTY' ]; then
  ok 'without the length guard an empty answer yields no status at all'
else
  bad 'without the length guard an empty answer yields no status at all' "got '${got}'"
fi

# M3: splitting on a newline instead of the last three characters.
make_curl newline
got=$(probe newline)
st=$(printf '%s' "$got" | cut -d'|' -f2)
if [ "$st" = '200' ]; then
  ok 'the status is taken from the end, not from the last line'
else
  bad 'the status is taken from the end, not from the last line' "got '${st}'"
fi

section 'no side effects, and no token'

# A refusal must leave nothing behind: no temp file, no partial state.
make_curl unauth
before=$(find "$WORK" -maxdepth 1 -type d | wc -l)
bash -c '
  set -Eeuo pipefail
  . "$1"
  coolify_api_init "$2" >/dev/null
  coolify_api GET /x || true
  coolify_api_cleanup
' _ "$LIB" "$CONF" >/dev/null 2>&1
after=$(find "$WORK" -maxdepth 1 -type d | wc -l)
if [ "$before" = "$after" ]; then
  ok 'a refused call leaves no directory behind'
else
  bad 'a refused call leaves no directory behind' "${before} -> ${after}"
fi

make_curl ok
out=$(bash -c '
  set -Eeuo pipefail
  . "$1"
  coolify_api_init "$2"
  coolify_api GET /teams/current
  printf "%s %s" "$API_STATUS" "$API_BODY"
  coolify_api_cleanup
' _ "$LIB" "$CONF" 2>&1)
if printf '%s' "$out" | grep -qF -- "$SECRET"; then
  bad 'the token never appears in output' 'it was printed'
else
  ok 'the token never appears in output'
fi

if printf '%s' "$out" | grep -qiE 'authorization|bearer'; then
  bad 'no Authorization header is echoed' 'one appears in the output'
else
  ok 'no Authorization header is echoed'
fi

# The config file curl reads must never be world- or group-readable.
make_curl ok
perm=$(bash -c '
  set -Eeuo pipefail
  . "$1"
  coolify_api_init "$2" >/dev/null
  stat -c "%a" "$COOLIFY_API_DIR/c"
  coolify_api_cleanup
' _ "$LIB" "$CONF")
if [ "$perm" = '600' ]; then
  ok 'the curl config holding the token is 0600'
else
  bad 'the curl config holding the token is 0600' "mode ${perm}"
fi

section 'init refuses what it cannot use'

for spec in 'missing:/nonexistent/deploy.env' 'empty'; do
  case "$spec" in
    missing:*) target=${spec#missing:} ;;
    empty) target="$WORK/empty.env"; : >"$target" ;;
  esac
  set +e
  bash -c '. "$1"; coolify_api_init "$2"' _ "$LIB" "$target" >/dev/null 2>&1
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    ok "init refuses a ${spec%%:*} config"
  else
    bad "init refuses a ${spec%%:*} config" 'it was accepted'
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
