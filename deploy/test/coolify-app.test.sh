#!/usr/bin/env bash
# The two Coolify behaviours the documentation gets wrong, and their guards.
#
# Both were found the same way — by a probe that measured instead of trusting —
# and both would have been invisible until production:
#
#   · `is_auto_deploy_enabled: false` at create time is ACCEPTED AND DISCARDED
#     for Docker Image applications, so a caller reading the OpenAPI schema
#     believes push-to-deploy is off on a production application when it is on.
#   · DELETE is asynchronous. The API 404s while the row is still in the table,
#     so an immediate assertion fails a deletion that is working perfectly.
#
# The tests below are mostly the failure modes, because the success path of both
# of these looked correct for as long as nobody checked.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }
# Spelled as a function rather than `[ … ] && ok … || bad …`: shellcheck reads
# that as a possible if-then-else mistake (SC2015) and is right to — `bad` runs
# when the test passes but `ok` returns non-zero.
eq() { # want got name
  if [ "$2" = "$1" ]; then ok "$3"; else bad "$3" "got '$2'"; fi
}
ne() { # unwanted got name
  if [ "$2" != "$1" ]; then ok "$3"; else bad "$3" "got '$2'"; fi
}

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

CONF="$WORK/deploy.env"
printf 'COOLIFY_URL=http://127.0.0.1:8000\nCOOLIFY_TOKEN=0|not-real\n' >"$CONF"
UUID='abcdefghijklmnopqrst'

# The fake database answers from a script the test rewrites per case. Each
# invocation consumes one line, so a case can say "true, then false" and model
# a flag that converges — or refuses to.
DBFILE="$WORK/db.lines"
cat >"$BIN/docker" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
# only ever called as: docker exec -i <container> psql ...
line=\$(head -1 "$DBFILE" 2>/dev/null || true)
if [ "\$(wc -l <"$DBFILE" 2>/dev/null || echo 1)" -gt 1 ]; then
  tail -n +2 "$DBFILE" >"$DBFILE.tmp" && mv "$DBFILE.tmp" "$DBFILE"
fi
[ "\$line" = 'ERROR' ] && exit 1
printf '%s\n' "\$line"
FAKE
chmod +x "$BIN/docker"

PATCHFILE="$WORK/patch.status"
cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
st=\$(cat "$PATCHFILE" 2>/dev/null || echo 200)
[ "\$st" = 'TRANSPORT' ] && exit 7
printf '{}%s' "\$st"
FAKE
chmod +x "$BIN/curl"

run() { # script-body -> stdout
  bash -c '
    set -Eeuo pipefail
    . "$1/deploy/coolify-api.sh"
    . "$1/deploy/coolify-app.sh"
    coolify_api_init "$2" >/dev/null
    eval "$3"
    coolify_api_cleanup
  ' _ "$ROOT" "$CONF" "$1" 2>&1
}

harden_rc() { # patch-status  db-lines... -> rc
  printf '%s' "$1" >"$PATCHFILE"
  shift
  printf '%s\n' "$@" >"$DBFILE"
  # Spelled as an `if`, not `cmd; printf "$?"`: the runner has `set -e`, which
  # kills the subshell on the failing call before the printf can report it —
  # and every refusal case then looks like an empty result rather than a 1.
  run 'if coolify_harden_settings '"$UUID"' >/dev/null 2>&1; then printf 0; else printf 1; fi'
}

section 'hardening: the PATCH is never believed on its own'

got=$(harden_rc 200 'f|f')
eq 0 "$got" 'a PATCH that really disabled both flags succeeds'

# The case that matters most: exactly what the CREATE endpoint does — answer
# 200 and change nothing. If hardening trusted the status, a production
# application would go live with push-to-deploy on.
got=$(harden_rc 200 't|f')
eq 1 "$got" 'a 200 that left Auto Deploy true is a failure, not a success'

got=$(harden_rc 200 'f|t')
eq 1 "$got" 'a 200 that left previews true is a failure'

got=$(harden_rc 403 'f|f')
eq 1 "$got" 'a refused PATCH fails even if the flags happen to read false'

got=$(harden_rc 401 'f|f')
eq 1 "$got" 'an unauthorised PATCH fails'

got=$(harden_rc TRANSPORT 'f|f')
eq 1 "$got" 'a PATCH that never reached Coolify fails'

# Unreadable is not false. Assuming it would be exactly the mistake the create
# endpoint already made once.
got=$(harden_rc 200 '')
eq 1 "$got" 'settings that cannot be read back are not assumed false'

got=$(harden_rc 200 'ERROR')
eq 1 "$got" 'a database error while verifying is a failure'

section 'deletion: bounded convergence, both tables'

await() { # timeout  db-lines... -> "rc|seconds"
  local t=$1
  shift
  printf '%s\n' "$@" >"$DBFILE"
  set +e
  # Literal shell for the runner to eval; SC2016 is the expected reading.
  # shellcheck disable=SC2016
  run 'if s=$(coolify_await_deletion '"$UUID"' '"$t"' 1 2>/dev/null); then printf "0|%s" "$s"; else printf "1|"; fi'
  set -e
}

got=$(await 10 '0|0')
eq 0 "${got%%|*}" 'a row already gone converges immediately'
eq 0 "${got##*|}" 'immediate convergence is recorded as 0 seconds'

# The first probe's actual failure: the API had 404'd, the row had not gone yet.
got=$(await 10 '1|1' '1|1' '0|0')
eq 0 "${got%%|*}" 'a delayed deletion converges rather than failing'
ne 0 "${got##*|}" 'a delayed deletion records a non-zero duration'

# The application row can go before its settings row does. Waiting on only one
# of them would call that deleted while a settings row still pointed at it.
got=$(await 10 '0|1' '0|1' '0|0')
eq 0 "${got%%|*}" 'settings outliving the application still counts as not-yet-deleted'

got=$(await 2 '1|1' '1|1' '1|1' '1|1' '1|1' '1|1')
eq 1 "${got%%|*}" 'a deletion that never converges fails closed'

got=$(await 2 '0|1' '0|1' '0|1' '0|1' '0|1' '0|1')
eq 1 "${got%%|*}" 'a permanently orphaned settings row fails closed'

got=$(await 2 'ERROR' 'ERROR' 'ERROR' 'ERROR')
eq 1 "${got%%|*}" 'a database that cannot be asked is not convergence'

section 'the attestation schema the candidate creator demands'

ENSURE="$ROOT/deploy/ensure-production-candidates.sh"
mk() { printf '%s\n' "$@" >"$WORK/att.env"; }
refuses_att() { # name
  set +e
  env CONF="$CONF" CONTRACT="$WORK/att.env" bash "$ENSURE" production >"$WORK/e.log" 2>&1
  local rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then ok "$1"; else bad "$1" 'it proceeded'; fi
}

mk 'schema_version=1' 'instant_deploy_false_creates_nothing=proven' \
   'autogenerate_domain_false_creates_no_domain=proven'
refuses_att 'a schema-1 attestation is refused — it predates the hardening discovery'

mk 'schema_version=2' 'instant_deploy_false_creates_nothing=proven' \
   'autogenerate_domain_false_creates_no_domain=proven' 'delete_leaves_no_row=proven'
refuses_att 'a schema-2 attestation missing the hardening proof is refused'

mk 'schema_version=2' 'instant_deploy_false_creates_nothing=proven' \
   'autogenerate_domain_false_creates_no_domain=proven' \
   'auto_deploy_disabled_before_configuration=failed' \
   'previews_disabled_before_configuration=proven' 'delete_leaves_no_row=proven'
refuses_att 'an attestation recording a FAILED hardening is refused'

# The substring trap: `grep -q` would match `...=proven` inside
# `auto_deploy_disabled_before_configuration=not-proven`.
mk 'schema_version=2' 'instant_deploy_false_creates_nothing=proven' \
   'autogenerate_domain_false_creates_no_domain=proven' \
   'auto_deploy_disabled_before_configuration=not-proven' \
   'previews_disabled_before_configuration=proven' 'delete_leaves_no_row=proven'
refuses_att 'a value merely containing «proven» is refused'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
