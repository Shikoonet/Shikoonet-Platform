# Shared pieces of the production-dump rehearsal, kept separate so they can be
# executed by tests rather than only grepped.
#
# The first version of the rehearsal was reviewed and found to be a
# false-positive generator. The findings are worth recording here, because every
# guard below exists because of one of them:
#
#   · it applied schema SQL and never ran the migrator, so the destination held
#     no rows — and "every wallet agrees with its entries" is trivially true of
#     zero wallets
#   · it set MIGRATE_MYSQL_URL, which `loadConfig()` does not read, so the
#     suite would have silently connected to 127.0.0.1:3307 instead
#   · it derived 0001..0037 from the repository rather than the pending range
#   · it ran vitest under `set +e` and never looked at the exit code
#   · its financial check compared one query with itself
#
# All of those pass. None of them measure anything.

# shellcheck shell=bash

# The backup directory, compared as a canonical path against the one Coolify
# says it is.
#
# The suffix test that was here accepted `/tmp/evil-<uuid>` — the basename ends
# with `-<uuid>`, so it matched — and the negative test only used
# `/tmp/evil-<uuid>-staging`, which does not. The guard was bypassable and the
# test that was supposed to prove otherwise had picked the one hostile input
# that happened to fail for an unrelated reason.
#
# So there is no pattern any more. The expected directory is derived from
# authoritative metadata and both sides are canonicalised, which collapses
# `..`, symlinked parents and trailing slashes before the comparison rather
# than trying to spot them in a string.
rehearsal_canonical_dir_is() { # candidate expected label
  local cand=$1 want=$2 label=$3 rc rw
  [ -n "$cand" ] || { echo "[path] ${label} is empty" >&2; return 1; }
  [ -n "$want" ] || { echo "[path] the expected ${label} could not be derived" >&2; return 1; }
  rc=$(realpath -e -- "$cand" 2>/dev/null) ||
    { echo "[path] ${label} does not resolve to a real path" >&2; return 1; }
  rw=$(realpath -e -- "$want" 2>/dev/null) ||
    { echo "[path] the expected ${label} does not exist on this host" >&2; return 1; }
  if [ "$rc" != "$rw" ]; then
    echo "[path] ${label} resolves elsewhere than the authoritative location" >&2
    return 1
  fi
  # A symlinked component would already have been collapsed by realpath, so the
  # remaining question is whether the directory itself is one.
  [ ! -L "$cand" ] || { echo "[path] ${label} is a symlink — refusing" >&2; return 1; }
  return 0
}

# ── configuration file security ───────────────────────────────────────────
#
# The config names a dump, a backup directory and a GitHub token. A file
# anybody can rewrite is a file that can redirect all three, so its ownership
# and mode are checked before a single line is read — and its directory too,
# because a writable parent means the file can be replaced wholesale.
rehearsal_require_secure_file() { # path max-mode label
  local path=$1 maxmode=$2 label=$3 mode owner dir
  [ -e "$path" ] || { echo "[secure] ${label} does not exist" >&2; return 1; }
  [ ! -L "$path" ] || { echo "[secure] ${label} is a symlink — refusing" >&2; return 1; }
  [ -f "$path" ] || { echo "[secure] ${label} is not a regular file" >&2; return 1; }
  owner=$(stat -c '%U' "$path")
  [ "$owner" = 'root' ] || { echo "[secure] ${label} is owned by ${owner}, not root" >&2; return 1; }
  mode=$(stat -c '%a' "$path")
  [ "$((8#$mode & 8#$maxmode))" = "$((8#$mode))" ] ||
    { echo "[secure] ${label} has mode ${mode}, wider than ${maxmode}" >&2; return 1; }
  dir=$(dirname "$path")
  [ "$(stat -c '%U' "$dir")" = 'root' ] ||
    { echo "[secure] the parent directory of ${label} has a non-root owner" >&2; return 1; }
  case "$(stat -c '%a' "$dir")" in
    *[2367]) echo "[secure] the directory holding ${label} is group- or world-writable" >&2; return 1 ;;
  esac
  return 0
}

# One occurrence of each required key, nothing malformed, no control bytes.
# A duplicate key is not a typo to resolve by taking the last one: it is two
# different intentions in one file, and picking either silently is how a
# rehearsal points at the wrong dump.
rehearsal_parse_config() { # path key...
  local path=$1
  shift
  python3 - "$path" "$@" <<'PY'
import re, sys
path, keys = sys.argv[1], sys.argv[2:]
seen = {}
raw = open(path, 'rb').read()
if b'\x00' in raw:
    print("config contains a NUL byte", file=sys.stderr); sys.exit(1)
text = raw.decode('utf-8', 'strict')
for n, line in enumerate(text.splitlines(), 1):
    if not line.strip() or line.lstrip().startswith('#'):
        continue
    m = re.fullmatch(r'([A-Z][A-Z0-9_]*)=(.*)', line)
    if not m:
        print(f"line {n} is neither a comment nor KEY=value", file=sys.stderr); sys.exit(1)
    k, v = m.group(1), m.group(2)
    if any(ord(c) < 32 or ord(c) == 127 for c in v):
        print(f"line {n} value contains a control character", file=sys.stderr); sys.exit(1)
    if k in seen:
        print(f"key {k} appears more than once (lines {seen[k]} and {n})", file=sys.stderr); sys.exit(1)
    seen[k] = n
missing = [k for k in keys if k not in seen]
if missing:
    print("missing required key(s): " + ", ".join(missing), file=sys.stderr); sys.exit(1)
PY
}

# ── the pending migration range, from the restored ledger ────────────────
#
# Derived, never assumed. The repository is at 0037 and production's ledger was
# at 0034, so the pending range is 0035..0037 — and recording 0001..0037, as the
# first version did, describes a migration nobody is about to run.
#
# Every refusal here is a real shape: a ledger naming something the repository
# does not have means the two have diverged; a gap means an earlier migration
# was skipped; a ledger ahead means production is newer than the release.
rehearsal_pending_range() { # applied-names-file repo-migrations-dir
  python3 - "$1" "$2" <<'PY'
import os, sys, re
applied = [l.strip() for l in open(sys.argv[1]) if l.strip()]
repo = sorted(f for f in os.listdir(sys.argv[2]) if re.fullmatch(r'0\d{3}_.*\.sql', f))
if not repo:
    print("the repository has no migrations", file=sys.stderr); sys.exit(1)
unknown = [a for a in applied if a not in repo]
if unknown:
    print("the ledger names migration(s) this release does not contain: "
          + ", ".join(sorted(unknown)[:5]), file=sys.stderr); sys.exit(1)
idx = [repo.index(a) for a in applied]
if idx and sorted(idx) != list(range(0, max(idx) + 1)):
    print("the applied migrations are not a contiguous prefix — there is a gap",
          file=sys.stderr); sys.exit(1)
if len(applied) > len(repo):
    print("the ledger is ahead of the repository", file=sys.stderr); sys.exit(1)
pending = repo[len(applied):]
if not pending:
    print("nothing is pending: production already has every migration in this release",
          file=sys.stderr); sys.exit(1)
print(pending[0][:4] + ".." + pending[-1][:4])
PY
}

# ── the vitest run, judged on more than a count ──────────────────────────
#
# A suite can have all 49 dump assertions pass while another file fails
# outright. The exit code is the only thing that knows that, and the first
# version threw it away.
rehearsal_check_vitest() { # report.json exit-code expected-passed
  python3 - "$1" "$2" "$3" <<'PY'
import json, sys
report, rc, want = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
if rc != 0:
    print(f"vitest exited {rc} — a suite that fails anywhere is not a pass", file=sys.stderr)
    sys.exit(1)
try:
    d = json.load(open(report))
except Exception as e:
    print(f"the vitest report did not parse: {e}", file=sys.stderr); sys.exit(1)
files = d.get("testResults") or []
if not files:
    print("the vitest report contains no files", file=sys.stderr); sys.exit(1)
dump_files = [f for f in files if ".mysql.test.ts" in (f.get("name") or "")]
if len(dump_files) != 10:
    print(f"{len(dump_files)} production-dump file(s) ran, expected 10", file=sys.stderr)
    sys.exit(1)
passed = skipped = failed = 0
for f in files:
    if (f.get("status") or "") == "failed":
        print(f"a test file failed: {(f.get('name') or '').rsplit('/',1)[-1]}", file=sys.stderr)
        sys.exit(1)
    for a in f.get("assertionResults") or []:
        s = a.get("status")
        if s == "failed":
            failed += 1
        if f in dump_files:
            if s == "passed": passed += 1
            elif s in ("skipped", "pending", "todo"): skipped += 1
if failed:
    print(f"{failed} assertion(s) failed somewhere in the suite", file=sys.stderr); sys.exit(1)
if skipped:
    print(f"{skipped} dump-gated test(s) were skipped — the dump was not exercised",
          file=sys.stderr); sys.exit(1)
if passed != want:
    print(f"{passed}/{want} dump-gated assertions passed", file=sys.stderr); sys.exit(1)
print(f"{passed}/{want}")
PY
}

# ── the financial comparison, across the two datasets ────────────────────
#
# The contract names wallet_balance, ledger_sum and order_total. Comparing the
# destination with itself — which the first version did — is an identity, not a
# comparison. These are read from the legacy source and from the migrated
# destination and compared in memory; only the verdict is ever printed.
#
# A zero-row destination is a FAILURE. "Nothing disagreed" is not a result when
# nothing was there.
rehearsal_compare_totals() { # source-file dest-file
  python3 - "$1" "$2" <<'PY'
import sys
def load(p):
    out = {}
    for line in open(p):
        line = line.strip()
        if not line: continue
        k, _, v = line.partition('=')
        out[k] = v
    return out
src, dst = load(sys.argv[1]), load(sys.argv[2])
names = ["wallet_balance", "ledger_sum", "order_total"]
missing = [n for n in names if n not in src or n not in dst]
if missing:
    print("aggregate(s) not measured: " + ",".join(missing), file=sys.stderr); sys.exit(1)
if all(dst[n] in ("0", "") for n in names):
    print("every destination aggregate is zero — an empty destination is not a match",
          file=sys.stderr)
    sys.exit(1)
bad = [n for n in names if src[n] != dst[n]]
# Names only. The amounts are the shop's money and are never printed.
print("mismatch:" + ",".join(bad) if bad else "match")
PY
}

# ── images: immutable, local, never pulled ────────────────────────────────
#
# A tag is a name for whatever was pushed last. `postgres:16-alpine` on Tuesday
# and on Thursday are two different rehearsals, and the one that matters is
# whichever ran while nobody was watching. So every image is a digest, and the
# digest must already be on the host: a Production rehearsal that reaches the
# internet has made a release depend on a registry being up and on nobody
# having moved a tag.
rehearsal_require_digest_ref() { # ref name
  local ref=$1 name=$2
  case "$ref" in
    *$'\n'*) echo "[image] ${name} contains a newline" >&2; return 1 ;;
  esac
  # repository@sha256:<64 lowercase hex>, whole string, nothing after.
  if ! printf '%s' "$ref" | grep -qE '^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$'; then
    echo "[image] ${name} is not an immutable digest reference: '${ref}'" >&2
    return 1
  fi
  return 0
}

# Present locally, checked before anything is created. `--pull=never` on the
# run would fail too, but by then a container or a network already exists and
# the failure arrives in the middle of the rehearsal rather than before it.
rehearsal_require_local_images() { # docker-cmd ref...
  local docker_cmd=$1
  shift
  local ref missing=0
  for ref in "$@"; do
    if ! $docker_cmd image inspect "$ref" >/dev/null 2>&1; then
      echo "[image] ${ref} is not present locally" >&2
      missing=$((missing + 1))
    fi
  done
  if [ "$missing" -gt 0 ]; then
    echo "[image] ${missing} image(s) absent. Preload them before the rehearsal; it will not pull." >&2
    return 1
  fi
  return 0
}

# ── the D1 export ─────────────────────────────────────────────────────────
#
# Required, with no default and no fixture fallback. The repository's default
# pointed into `legacy/hub-cloudflare/.production-backups/...`, and a rehearsal
# that silently used a checked-in fixture would report 49/49 about data nobody
# ships.
#
# The content-set identifier is computed for provenance and deliberately not
# returned: it is derived from customer data, so it is compared internally and
# never printed.
rehearsal_validate_d1_export() { # dir expected-tables-csv mysql-dump
  local dir=$1 expected=$2 dump=$3
  [ -n "$dir" ] || { echo "[d1] D1_EXPORT_DIR is empty — it has no default" >&2; return 1; }
  [ ! -L "$dir" ] || { echo "[d1] the export directory is a symlink — refusing" >&2; return 1; }
  [ -d "$dir" ] || { echo "[d1] the export directory does not exist" >&2; return 1; }
  case "$(stat -c '%a' "$dir")" in
    *[2367]) echo "[d1] the export directory is group- or world-writable" >&2; return 1 ;;
  esac
  if [ ! -f "$dir/d1-export.manifest" ] || [ -L "$dir/d1-export.manifest" ]; then
    echo "[d1] there is no d1-export.manifest in the export directory." >&2
    echo "[d1] This export carries no provenance, and the rehearsal will not guess at it" >&2
    echo "[d1] from the shape of the rows. Produce it with:" >&2
    echo "[d1]   tools/d1-export-manifest.py <export-dir> <mirzabot-dump> deploy/d1-tables.manifest" >&2
    return 1
  fi
  case "$(stat -c '%a' "$dir/d1-export.manifest")" in
    *[2367]) echo "[d1] d1-export.manifest is group- or world-writable" >&2; return 1 ;;
  esac
  python3 - "$dir" "$expected" "$dump" <<'PY'
import hashlib, os, sys

d, expected, dump = sys.argv[1], [t for t in sys.argv[2].split(',') if t], sys.argv[3]

def sha256_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for chunk in iter(lambda: fh.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()

def refuse(msg):
    print('[d1] ' + msg, file=sys.stderr)
    sys.exit(1)

man_path = os.path.join(d, 'd1-export.manifest')
text = open(man_path, encoding='utf-8').read()

header, listed = {}, {}
for line in text.splitlines():
    if not line.strip():
        continue
    if '=' in line and '  ' not in line:
        k, _, v = line.partition('=')
        header[k.strip()] = v.strip()
    else:
        digest, _, name = line.partition('  ')
        listed[name.strip()] = digest.strip()

if header.get('schema_version') != '1':
    refuse('d1-export.manifest has an unsupported schema_version')

# The set is bound as one object. Assembling an export from parts of two runs
# means one of these three comparisons fails, whichever part was substituted.
want = {t + '.json' for t in expected}
have = set(listed)
if want - have:
    refuse('the manifest does not cover: ' + ','.join(sorted(want - have)))
if have - want:
    refuse('the manifest covers files that are not part of the contract: ' + ','.join(sorted(have - want)))
if header.get('table_count') != str(len(expected)):
    refuse('the manifest declares table_count=%s, the contract has %d tables'
           % (header.get('table_count'), len(expected)))

# Anything else in the directory is an intruder: a file from another export
# dropped in beside these would otherwise ride along unnoticed.
present = {f for f in os.listdir(d) if f.endswith('.json')}
if present - want:
    refuse('unexpected file(s) in the export directory: ' + ','.join(sorted(present - want)))

for name, digest in sorted(listed.items()):
    p = os.path.join(d, name)
    if os.path.islink(p):
        refuse(name + ' is a symlink — refusing')
    if not os.path.isfile(p):
        refuse(name + ' is named by the manifest but is not present')
    mode = os.stat(p).st_mode & 0o777
    if mode & 0o022:
        refuse(name + ' is group- or world-writable')
    actual = sha256_file(p)
    if actual != digest:
        # The filename is safe to name; the two digests are not printed side by
        # side, because a per-file digest of customer data is a fingerprint of
        # customer data.
        refuse(name + ' does not match the digest its own export recorded — it was modified or replaced')

# MySQL and D1 have to be two views of one moment. A D1 export from Tuesday
# against a MySQL dump from Thursday migrates cleanly and produces a database
# that never existed, which is the failure this catches and no row count can.
want_dump = header.get('mysql_dump_sha256', '')
if len(want_dump) != 64:
    refuse('the manifest records no usable mysql_dump_sha256')
if sha256_file(dump) != want_dump:
    refuse('the MySQL dump is not the one this D1 export was taken with — they are from different snapshots and must not be migrated together')

# The export identity: a hash over the manifest, so a hash of hashes. It is
# derived from no customer value directly, and unlike the counterpart it
# replaces it is returned and used rather than computed and discarded.
print('sha256:' + hashlib.sha256(text.encode()).hexdigest())
PY
}

# ── the live production images ────────────────────────────────────────────
#
# Derived from what is actually serving, never from a config value. A key named
# CURRENT_PRODUCTION_IMAGE that silently loses to live state makes a wrong
# config look successful, which is the worst of both: it is consulted, it is
# ignored, and nothing says so.
#
# Input is one line per application: name|environment|container|imageid|health
# so this can be executed against fixtures instead of a live Docker.
rehearsal_check_live_production() { # lines-file expected-names-csv
  python3 - "$1" "$2" <<'PY'
import sys, re
rows = [l.rstrip('\n') for l in open(sys.argv[1]) if l.strip()]
want = [n for n in sys.argv[2].split(',') if n]
seen = {}
for line in rows:
    parts = line.split('|')
    if len(parts) != 5:
        print(f"[live] malformed application record", file=sys.stderr); sys.exit(1)
    name, env, container, image, health = parts
    if env != 'production':
        print(f"[live] {name} is in environment '{env}', not production — refusing", file=sys.stderr)
        sys.exit(1)
    if not container:
        print(f"[live] {name} has no running container", file=sys.stderr); sys.exit(1)
    if health not in ('healthy', 'running'):
        print(f"[live] {name} is '{health}', not healthy", file=sys.stderr); sys.exit(1)
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', image):
        print(f"[live] {name} resolves to '{image}', which is not an immutable image id",
              file=sys.stderr)
        sys.exit(1)
    seen.setdefault(name, []).append(image)
missing = [n for n in want if n not in seen]
if missing:
    print("[live] no live container for: " + ",".join(missing), file=sys.stderr); sys.exit(1)
extra = [n for n in seen if n not in want]
if extra:
    print("[live] unexpected application(s): " + ",".join(sorted(extra)), file=sys.stderr); sys.exit(1)
for n, imgs in seen.items():
    if len(imgs) != 1:
        print(f"[live] {n} resolves to {len(imgs)} containers, expected exactly 1", file=sys.stderr)
        sys.exit(1)
print(",".join(f"{n}={seen[n][0]}" for n in want))
PY
}

# An exact remote, not a substring.
#
# `case "$r" in *Shikoonet/Shikoonet-Platform*)` also matches
# `https://evil.example/x/Shikoonet/Shikoonet-Platform-backdoor`. Identity
# comparisons do not get to be fuzzy.
rehearsal_require_known_remote() { # url
  local r=$1
  case "$r" in
    https://github.com/Shikoonet/Shikoonet-Platform \
    | https://github.com/Shikoonet/Shikoonet-Platform.git \
    | git@github.com:Shikoonet/Shikoonet-Platform \
    | git@github.com:Shikoonet/Shikoonet-Platform.git \
    | ssh://git@github.com/Shikoonet/Shikoonet-Platform \
    | ssh://git@github.com/Shikoonet/Shikoonet-Platform.git)
      return 0 ;;
  esac
  echo "[repo] origin '${r}' is not an exact known remote for this repository" >&2
  return 1
}

# ── GitHub, with the status actually looked at ────────────────────────────
#
# `curl -K cfg "$url"` returns a body and nothing else, so a 401 or a 404 comes
# back as JSON that the next step parses as if it had succeeded. The empty
# result then surfaces as "no successful Deploy Staging run" — a sentence about
# the release when the truth was about the token.
#
# The status is set in the CALLER's shell because this is invoked as a plain
# command, never as `$(...)`. That is the same bug the Coolify client had, and
# it is not being rebuilt here.
# Read by every caller of `gh_request`, which shellcheck cannot see from
# inside this file alone.
# shellcheck disable=SC2034
GH_BODY=''
# shellcheck disable=SC2034
GH_STATUS=000
gh_request() { # curl-config url
  local cfg=$1 url=$2 out
  GH_BODY=''
  GH_STATUS=000
  out=$(curl -K "$cfg" -sS -w '%{http_code}' "$url" 2>/dev/null) || return 1
  [ ${#out} -ge 3 ] || return 1
  # shellcheck disable=SC2034
  GH_STATUS=${out: -3}
  # shellcheck disable=SC2034
  GH_BODY=${out:0:${#out}-3}
  return 0
}

# Turns a status into a decision, so every caller refuses the same way.
gh_classify() { # status label
  case "$1" in
    2??) return 0 ;;
    000) echo "[github] ${2}: nothing answered — transport failure" >&2; return 1 ;;
    401) echo "[github] ${2}: authentication failed (401) — the token is wrong or expired" >&2; return 1 ;;
    403) echo "[github] ${2}: forbidden (403) — the token lacks the scope, or is rate limited" >&2; return 1 ;;
    404) echo "[github] ${2}: not found (404) — the resource does not exist for this token" >&2; return 1 ;;
    5??) echo "[github] ${2}: GitHub returned ${1} — refusing rather than retrying blindly" >&2; return 1 ;;
    *)   echo "[github] ${2}: unexpected status ${1}" >&2; return 1 ;;
  esac
}

# ── production resources, by exact identity ───────────────────────────────
#
# Selecting by the name `production` or `shikoo-ingest` is selecting by a label
# somebody can change. The uuids are the identity, and the configured set must
# agree with what Coolify reports exactly — not as a subset, not as a substring.
rehearsal_check_app_uuids() { # observed-file expected-csv
  python3 - "$1" "$2" <<'PY'
import re, sys
obs = {}
for line in open(sys.argv[1]):
    line = line.strip()
    if not line: continue
    parts = line.split('|')
    if len(parts) != 2:
        print("[uuid] malformed observation", file=sys.stderr); sys.exit(1)
    name, uuid = parts
    if not re.fullmatch(r'[a-z0-9]{20,32}', uuid):
        print(f"[uuid] {name} has uuid '{uuid}', which is not a Coolify uuid", file=sys.stderr)
        sys.exit(1)
    if name in obs:
        print(f"[uuid] {name} matched more than one application", file=sys.stderr); sys.exit(1)
    obs[name] = uuid
want = dict(p.split('=') for p in sys.argv[2].split(',') if p)
if set(obs) != set(want):
    print("[uuid] application set differs: observed " + ",".join(sorted(obs))
          + " expected " + ",".join(sorted(want)), file=sys.stderr)
    sys.exit(1)
for n in sorted(want):
    if obs[n] != want[n]:
        print(f"[uuid] {n} is {obs[n]} in Coolify, expected {want[n]}", file=sys.stderr)
        sys.exit(1)
print("ok")
PY
}

# The backup path must BE the resource's directory, not merely contain its uuid
# somewhere. `/tmp/evil-<uuid>-staging` contains it too.

# ── the host contract, proven before anything sensitive is opened ─────────
#
# The rehearsal used to discover its dependencies by using them. That ordering
# is the problem: by the time `python3 -c 'import zipfile'` fails, the config
# has been read, the production dump has been opened, a temp directory holding
# a copy of customer data exists, and the failure message is about a missing
# module rather than about the machine being wrong for this job. On a host
# where `gh`, `node`, `pnpm` and `psql` are all absent — which is this host —
# assuming any tool is present is a guess.
#
# `command -v` is not the test. It answers "is there a file with that name on
# PATH", which is true for a `docker` client with no reachable daemon, a
# BusyBox `stat` with no `-c`, a `date` that cannot parse `-d`, and a `python3`
# built without zipfile. Each check below therefore performs the exact
# operation the script later depends on, and nothing broader.
#
# Nothing here installs anything and nothing here reaches the network.
rehearsal_require_host_deps() { # probe_dir
  local probe=$1 bad=0 out
  note() { echo "[deps] $*" >&2; bad=1; }

  if [ -z "$probe" ] || [ ! -d "$probe" ]; then
    echo "[deps] no writable probe directory" >&2
    return 1
  fi

  # Bash 4: associative arrays and `${x,,}` are used, and bash 3.2 parses the
  # script but fails at runtime, which is the worst moment to find out.
  [ "${BASH_VERSINFO[0]:-0}" -ge 4 ] ||
    note "bash ${BASH_VERSION:-unknown} is too old — 4.0 or newer is required"

  # Docker: a client alone proves nothing. The daemon has to answer, and the
  # rehearsal runs containers, execs into them and inspects them.
  if ! command -v docker >/dev/null 2>&1; then
    note "docker is not installed"
  elif ! docker version --format '{{.Server.Version}}' >/dev/null 2>&1; then
    note "the docker daemon does not answer — the rehearsal cannot create its isolated databases"
  elif ! docker inspect --format '{{.Id}}' --type image hello-world >/dev/null 2>&1 &&
       ! docker image ls -q >/dev/null 2>&1; then
    note "docker cannot list or inspect images"
  fi

  # Git: the repository checkout is verified against a known commit, so the
  # binary has to support `-C` and plumbing, not merely exist.
  if ! command -v git >/dev/null 2>&1; then
    note "git is not installed"
  elif ! git -C "$probe" init -q "$probe/.gitprobe" 2>/dev/null &&
       ! git --version >/dev/null 2>&1; then
    note "git cannot run"
  fi

  # Python 3 with zipfile: the D1 export arrives as a zip and the contract
  # generator parses the migrator's TypeScript. A python3 without zipfile is a
  # real build, not a hypothetical one.
  if ! command -v python3 >/dev/null 2>&1; then
    note "python3 is not installed"
  else
    python3 -c 'import zipfile, hashlib, json, sys; sys.exit(0)' 2>/dev/null ||
      note "python3 cannot import zipfile/hashlib/json — the D1 export cannot be validated"
  fi

  # curl with TLS: the GitHub calls are https and nothing else.
  if ! command -v curl >/dev/null 2>&1; then
    note "curl is not installed"
  else
    out=$(curl --version 2>/dev/null | head -1)
    case "$out" in
      *' '*) ;;
      *) note "curl does not report a version" ;;
    esac
    curl --version 2>/dev/null | grep -qi 'Protocols:.*https' ||
      note "this curl has no https protocol support"
  fi

  # sha256sum: computed against a known answer rather than trusted to exist,
  # because every checksum in the attestation chain rests on it.
  if ! command -v sha256sum >/dev/null 2>&1; then
    note "sha256sum is not installed"
  else
    out=$(printf 'abc' | sha256sum | cut -d' ' -f1)
    [ "$out" = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' ] ||
      note "sha256sum does not produce the known digest of 'abc'"
  fi

  # flock: the release lock is the only thing standing between a publishing
  # rehearsal and a reading Prepare.
  if ! command -v flock >/dev/null 2>&1; then
    note "flock is not installed — the release lock cannot be taken"
  else
    ( : >"$probe/.flockprobe"; exec 7>>"$probe/.flockprobe"; flock -w 2 7 ) 2>/dev/null ||
      note "flock cannot take a lock on this filesystem"
  fi

  # stat -c: BSD/BusyBox stat spell this `-f`, and every ownership and mode
  # check in this library is written against GNU `-c`.
  if ! command -v stat >/dev/null 2>&1; then
    note "stat is not installed"
  else
    out=$(stat -c '%a' "$probe" 2>/dev/null || true)
    case "$out" in
      [0-7][0-7][0-7] | [0-7][0-7][0-7][0-7]) ;;
      *) note "stat has no GNU -c support — ownership and mode checks would silently not run" ;;
    esac
  fi

  # sed / grep / find, in the exact forms used.
  [ "$(printf 'k=v\n' | sed -n 's/^k=//p')" = 'v' ] ||
    note "sed cannot run the substitution form the config parser uses"
  [ "$(printf 'a\nb\n' | grep -c .)" = '2' ] ||
    note "grep -c does not count lines as expected"
  find "$probe" -maxdepth 1 -type d >/dev/null 2>&1 ||
    note "find does not support -maxdepth/-type"

  # date, in both directions: formatting the version-directory stamp, and
  # parsing an ISO-8601 timestamp back for the staleness check.
  date -u +%Y%m%dT%H%M%SZ >/dev/null 2>&1 ||
    note "date cannot format a UTC timestamp"
  date -u -d '2026-01-02T03:04:05Z' +%s >/dev/null 2>&1 ||
    note "date cannot parse an ISO-8601 timestamp — attestation staleness could not be judged"

  # The filesystem operations publication depends on. `mv -T` over a symlink
  # is the activation; if this filesystem cannot do it atomically the whole
  # publication design is void, and it is better to know that here than to
  # discover it with a half-swapped pointer.
  ( ln -sfn "$probe" "$probe/.lnprobe" && mv -Tf "$probe/.lnprobe" "$probe/.lnprobe2" ) 2>/dev/null ||
    note "this filesystem cannot rename a symlink over a name (mv -T) — atomic activation is impossible here"
  rm -f "$probe/.lnprobe" "$probe/.lnprobe2" 2>/dev/null || true
  mktemp -d "$probe/.mkprobe.XXXXXX" >/dev/null 2>&1 ||
    note "mktemp -d does not work in the state directory"

  rm -rf "$probe/.gitprobe" "$probe/.flockprobe" "$probe"/.mkprobe.* 2>/dev/null || true
  unset -f note
  [ "$bad" -eq 0 ] || return 1
  return 0
}
