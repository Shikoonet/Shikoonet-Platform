# Reaching a credentialed service without putting the credential in argv.
#
# ─────────────────────────────────────────────────────────────────────────────
# `ps` is readable by every process on the host, and `/proc/<pid>/cmdline` keeps
# a command line for as long as it runs. So these two shapes, both of which the
# earlier version used, hand a live secret to anybody logged in:
#
#     curl "https://api.telegram.org/bot${token}/getMe"
#     psql "$DATABASE_URL" -c '...'
#
# The token is IN the URL in the first, and a Postgres URL carries host, user
# and password in the second. Neither is fixed by quoting; the value has to stop
# travelling as an argument.
#
# curl already has the answer — `-K file` reads request configuration, including
# `url`, from a file. libpq has one too: a service file, pointed at by
# PGSERVICEFILE, holding host/port/user/password/dbname under a name that IS
# safe to put in argv.
#
# Both files are written 0600 inside a 0700 directory that is removed on exit,
# on failure and on signal — a credential file that survives its command is the
# problem it was written to avoid.

# shellcheck shell=bash

SECRET_IO_DIR=''
secret_io_init() {
  SECRET_IO_DIR=$(mktemp -d)
  chmod 700 "$SECRET_IO_DIR"
}
secret_io_cleanup() {
  [ -z "$SECRET_IO_DIR" ] || rm -rf "$SECRET_IO_DIR"
  SECRET_IO_DIR=''
}

# The bot's public identity, from a token that never becomes an argument.
#
# Prints `<id> <username>` on success, nothing on failure. The token is written
# into a curl config as part of the `url` line, which is exactly where curl
# expects to read it from and exactly where `ps` cannot.
tg_get_me() { # token -> "<id> <username>"
  local token=$1 cfg="$SECRET_IO_DIR/tg.conf" body
  umask 077
  {
    printf 'url = "https://api.telegram.org/bot%s/getMe"\n' "$token"
    printf 'silent\n'
    printf 'show-error\n'
    printf 'max-time = 20\n'
  } >"$cfg"
  chmod 600 "$cfg"
  body=$(curl -K "$cfg" 2>/dev/null || true)
  rm -f "$cfg"
  printf '%s' "$body" | python3 -c '
import json,sys
try: d=json.load(sys.stdin)
except Exception: sys.exit(0)
r=d.get("result") or {}
if d.get("ok") and r.get("id"):
    print(r["id"], r.get("username") or "")'
}

# Which cluster a Postgres URL points at, WITHOUT connecting to it.
#
# The connecting version could never have worked, and finding out cost a dry
# run: there is no psql binary on this host at all, and Coolify's database
# hostnames do not resolve outside the container network. Every DATABASE_URL
# came back "unreachable", which reads like a network problem and was in fact
# two independent impossibilities.
#
# It should not have connected anyway. Classifying a row as production by
# opening a session to the production database is a strange way to find out
# that you should not be touching it.
#
# The hostname in a Coolify DATABASE_URL is the database container's own
# name — a uuid, not a secret, and the whole answer. So the URL is parsed, the
# host compared against the two known containers, and nothing is dialled. Only
# the classification and the matched container name are ever printed; user,
# password, port and database name are parsed and discarded.
pg_host_of() { # url -> hostname, or empty when it is not a postgres url
  python3 - "$1" <<'PY'
import sys, urllib.parse as u
p = u.urlparse(sys.argv[1])
if p.scheme in ("postgres", "postgresql") and p.hostname:
    print(p.hostname)
PY
}
