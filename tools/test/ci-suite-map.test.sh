#!/usr/bin/env bash
#
# «Does `ci-plan.sh`'s app map still cover the workspace's real dependency
# graph?»
#
# `tools/ci-plan.sh` selects suites away for a change confined to `apps/`. It
# does that from a table written by hand:
#
#   apps/admin-web        → unit, e2e
#   apps/dashboard-worker → db,   e2e
#   apps/bot              → db
#   apps/ingest-worker    → db
#
# A hand-written table is exactly the thing that rots. `apps/ingest-worker`
# already depends on `@shikoo/dashboard` — an app importing another app — so
# «one directory, one suite» is not true here and was never going to stay true
# by luck.
#
# So this file does not READ the table. It recomputes what the table should say,
# from the workspace's own `package.json` files and `.github/ci-baseline.json`,
# and runs `ci-plan.sh` to check that a change to each application selects at
# least every executor that owns a suite which could observe it.
#
# The direction of the check is one-way on purpose: the plan may select MORE
# than the graph requires and still pass. It may never select less. Adding a
# dependency edge that the table does not cover fails here, in a suite that
# runs on every pull request touching the CI surface, rather than as a green
# gate over a suite nobody ran.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
PLAN="$ROOT/tools/ci-plan.sh"

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }

# ───────────────────────────────────── the graph, from the workspace's own files
#
# Emits one line per application: `<app-dir> <executor> [<executor> ...]` — the
# executors that own a vitest suite belonging to that application or to
# anything that (transitively) depends on it.
closure() {
  node -e '
const fs = require("node:fs");
const path = require("node:path");
const root = process.argv[1];

const dirs = [];
for (const group of ["apps", "packages"]) {
  for (const entry of fs.readdirSync(path.join(root, group))) {
    const p = path.join(group, entry);
    if (fs.existsSync(path.join(root, p, "package.json"))) dirs.push(p);
  }
}

const nameOf = new Map();   // dir  -> @shikoo/x
const dirOf  = new Map();   // @shikoo/x -> dir
const deps   = new Map();   // dir  -> [@shikoo/x]
for (const d of dirs) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, d, "package.json"), "utf8"));
  nameOf.set(d, pkg.name);
  dirOf.set(pkg.name, d);
  deps.set(d, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })
    .filter((k) => k.startsWith("@shikoo/")));
}

// Which executor owns each package s suite. From the baseline, so this test
// and the gate verifier cannot disagree about where a suite runs.
const baseline = JSON.parse(
  fs.readFileSync(path.join(root, ".github/ci-baseline.json"), "utf8"));
const executorOf = new Map();
for (const [dir, suite] of Object.entries(baseline.suites)) executorOf.set(dir, suite.shard);

// Everything that depends on "start", transitively, including itself.
function dependents(start) {
  const seen = new Set([start]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of dirs) {
      if (seen.has(d)) continue;
      if (deps.get(d).some((n) => seen.has(dirOf.get(n)))) { seen.add(d); grew = true; }
    }
  }
  return seen;
}

for (const app of dirs.filter((d) => d.startsWith("apps/"))) {
  const executors = new Set();
  for (const d of dependents(app)) {
    const e = executorOf.get(d);
    if (e !== undefined) executors.add(e);
  }
  console.log([app, ...[...executors].sort()].join(" "));
}
' "$ROOT"
}

field() { # output  key
  printf '%s\n' "$1" | awk -F= -v k="$2" '$1 == k { print $2 }'
}

printf '\nthe app map against the workspace dependency graph\n'

# Which plan output has to be `true` for each executor to run at all.
flag_for() { # executor
  case "$1" in
    checks) printf 'unit\n' ;;
    integration-db) printf 'db\n' ;;
    *) printf 'UNMAPPED\n' ;;
  esac
}

while read -r app executors; do
  [ -n "$app" ] || continue
  out=$(EVENT=pull_request IS_DRAFT=false CHANGED_FILES="${app}/src/whatever.ts" bash "$PLAN")

  # The plan must not have fallen through to the complete gate — if it did, the
  # check below would pass for the wrong reason and this file would be proving
  # nothing.
  mode=$(field "$out" mode)
  if [ "$mode" != 'apps' ]; then
    bad "${app} selects" "mode=${mode}, expected «apps» — the app map no longer recognises this directory"
    continue
  fi

  for executor in $executors; do
    flag=$(flag_for "$executor")
    if [ "$flag" = 'UNMAPPED' ]; then
      bad "${app} → ${executor}" "no plan output is known to steer executor «${executor}»"
      continue
    fi
    got=$(field "$out" "$flag")
    if [ "$got" = 'true' ]; then
      ok "${app} → ${executor} (${flag}=true)"
    else
      bad "${app} → ${executor}" \
        "${flag}=${got}, but a suite in «${executor}» depends on ${app}"
    fi
  done
done <<<"$(closure)"

# ───────────────────────────────────────── the two edges that are not vitest
#
# The browser walk owns no baseline suite entry, so the closure above cannot
# find it. It drives the built SPA (`apps/admin-web`) served by
# `apps/dashboard-worker`, and a change to either can break it.
printf '\nthe browser walk, which owns no vitest suite\n'
for app in apps/admin-web apps/dashboard-worker; do
  out=$(EVENT=pull_request IS_DRAFT=false CHANGED_FILES="${app}/src/whatever.ts" bash "$PLAN")
  got=$(field "$out" e2e)
  if [ "$got" = 'true' ]; then ok "${app} → e2e"; else bad "${app} → e2e" "e2e=${got}"; fi
done

# ───────────────────────────────────── every baseline suite reaches an executor
#
# A suite whose `shard` is a name no plan output steers would be a suite that
# can never be required — invisible, and green by omission.
printf '\nevery baseline suite belongs to an executor the plan can steer\n'
while read -r dir executor; do
  [ -n "$dir" ] || continue
  if [ "$(flag_for "$executor")" = 'UNMAPPED' ]; then
    bad "${dir}" "baseline shard «${executor}» is not an executor this plan can select"
  else
    ok "${dir} → ${executor}"
  fi
done <<<"$(node -e '
const b = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
for (const [d, s] of Object.entries(b.suites)) console.log(d, s.shard);
' "$ROOT/.github/ci-baseline.json")"

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
