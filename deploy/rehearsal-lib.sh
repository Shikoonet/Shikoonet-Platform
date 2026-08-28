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
