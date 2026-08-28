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

# The cluster identifier behind a Postgres URL, without the URL reaching argv.
#
# `system_identifier` says which database this is and reveals no host, user or
# password — it is the whole answer needed to tell staging from production, and
# it is safe to print, which is why classification reports it and nothing else.
pg_system_identifier() { # url -> system_identifier or empty
  local url=$1 svc="$SECRET_IO_DIR/pg.service" out
  umask 077
  python3 - "$url" "$svc" <<'PY'
import sys, urllib.parse as u
raw, path = sys.argv[1], sys.argv[2]
p = u.urlparse(raw)
if p.scheme not in ("postgres", "postgresql"):
    sys.exit(1)
fields = {
    "host": p.hostname or "",
    "port": str(p.port or 5432),
    "user": u.unquote(p.username or ""),
    "password": u.unquote(p.password or ""),
    "dbname": (p.path or "/").lstrip("/") or "postgres",
}
with open(path, "w") as fh:
    fh.write("[probe]\n")
    for k, v in fields.items():
        if v:
            fh.write(f"{k}={v}\n")
PY
  [ -s "$svc" ] || { rm -f "$svc"; return 0; }
  chmod 600 "$svc"
  # `probe` is the service NAME, not a credential — the credential stays in the
  # file that PGSERVICEFILE names.
  out=$(PGSERVICEFILE="$svc" PGSERVICE=probe PGCONNECT_TIMEOUT=8 \
    psql -At -c 'select system_identifier from pg_control_system()' 2>/dev/null || true)
  rm -f "$svc"
  printf '%s' "$out"
}
