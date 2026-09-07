#!/usr/bin/env bash
# shellcheck disable=SC2016  # assertions are literal strings searched for in
# another file; expansion is exactly what must not happen to them.
# The task runner: nine subcommands, and nothing else.
#
# This is the only thing hessamx will be able to run as root, so the properties
# that matter are the ones a reviewer would otherwise have to take on trust:
# that the subcommand list is closed, that no production form exists, that the
# grant contains no wildcard and no interpreter, and that the hash constant
# still matches the manifest it pins.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
RUNNER="$ROOT/deploy/shikoo-task-runner"
SUDOERS="$ROOT/deploy/shikoo-task-runner.sudoers"
MANIFEST="$ROOT/deploy/shikoo-task-runner.manifest"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }
has() { if grep -qF -- "$2" "$1"; then ok "$3"; else bad "$3" "missing: $2"; fi; }
hasnt() { if grep -qF -- "$2" "$1"; then bad "$3" "present: $2"; else ok "$3"; fi; }

section 'the privileged sources are tracked'

for f in deploy/install-shikoo-task-runner.sh deploy/shikoo-task-runner \
         deploy/shikoo-task-runner.sudoers deploy/shikoo-task-runner.manifest \
         deploy/test/task-runner.test.sh deploy/test/task-runner-installer.test.sh; do
  if git -C "$ROOT" ls-files --error-unmatch "$f" >/dev/null 2>&1; then
    ok "$f is tracked in git"
  else
    bad "$f is tracked in git" 'it is untracked — CI would never review it'
  fi
done

section 'the manifest is the single source of truth'

# The constant appears in two files. If either drifts, the runner would verify
# against a manifest nobody reviewed, or refuse a manifest that is correct.
WANT=$(sha256sum "$MANIFEST" | cut -d' ' -f1)
for f in "$RUNNER" "$ROOT/deploy/install-shikoo-task-runner.sh"; do
  got=$(grep -oE '^MANIFEST_SHA256=[0-9a-f]{64}' "$f" | cut -d= -f2 || true)
  if [ "$got" = "$WANT" ]; then
    ok "$(basename "$f") pins the current manifest hash"
  else
    bad "$(basename "$f") pins the current manifest hash" "has ${got:-none}, manifest is ${WANT}"
  fi
done

# And the manifest must describe the files that actually exist.
# A manifest entry is either a script in deploy/ or a file at the repository
# root (the migrations, which ship beside the scripts so the restore drill can
# check the ledger and the invariants from an installed directory).
src_of() { case "$1" in migrations/*) printf '%s/%s' "$ROOT" "$1" ;; *) printf '%s/deploy/%s' "$ROOT" "$1" ;; esac; }
mismatch=0
while read -r want name; do
  [ -n "$name" ] || continue
  got=$(sha256sum "$(src_of "$name")" 2>/dev/null | cut -d' ' -f1 || true)
  [ "$got" = "$want" ] || { mismatch=$((mismatch + 1)); printf '       drift: %s\n' "$name"; }
done <"$MANIFEST"
if [ "$mismatch" -eq 0 ]; then
  ok "all $(grep -c . "$MANIFEST") manifest entries match their source files"
else
  bad "all manifest entries match their source files" "${mismatch} entr(y|ies) drifted"
fi

# The drill needs both the migration list and the invariants, so their absence
# from the manifest would be a drill that silently checks nothing.
if grep -q ' migrations/verify_invariants.sql$' "$MANIFEST"; then
  ok 'the manifest ships verify_invariants.sql'
else
  bad 'the manifest ships verify_invariants.sql' 'it is absent'
fi
# Counted against the migrations DIRECTORY, never against a literal.
#
# This read `[ "$n" -ge 37 ]` and printed «the manifest ships all ${n}
# migrations». Both halves were wrong in the same way: 37 was frozen the day it
# was written, and the sentence reported the manifest's own count back as if it
# were a total. The repository reached 62 migrations and this stayed green,
# because it never asked the directory anything.
#
# What that cost is not hypothetical. The bundle installed on the production
# host shipped migrations 0001–0037 and a `verify_invariants.sql` written for
# 0059, so the restore drill measured production's ledger against a truncated
# set, reported «ledger is current» for a database 25 migrations behind, and
# then died inside the invariants on an index 0059 was supposed to have
# replaced. A backup verifier answering «current» when it cannot see the
# migrations is worse than one that fails.
#
# `git ls-files` rather than a glob, so an untracked file sitting in the
# working tree cannot make this pass either.
# SETS, not counts. Counting was this check's second mistake in a row: `-ge 37`
# compared against a frozen number, and `-eq $want` compared two totals — which
# a manifest that omits 0042 and lists 0041 twice satisfies exactly. The bundle
# would then be missing a migration from restore verification with the test
# green, which is the failure this whole section exists to prevent, reached by
# a different route.
#
# `git ls-files` rather than a glob, so an untracked file sitting in the working
# tree cannot make this pass either. `LC_ALL=C` on every side because comm
# rejects input this host's collation ordered differently.
disk=$(git -C "$ROOT" ls-files 'migrations/0*.sql' | LC_ALL=C sort)
listed=$(awk '{print $2}' "$MANIFEST" | grep '^migrations/0' | LC_ALL=C sort)
missing=$(LC_ALL=C comm -23 <(printf '%s\n' "$disk") <(printf '%s\n' "$listed") | tr '\n' ' ')
extra=$(LC_ALL=C comm -13 <(printf '%s\n' "$disk") <(printf '%s\n' "$listed") | tr '\n' ' ')
# A duplicate is neither missing nor extra — both sets stay empty — so it is
# counted separately rather than inferred.
dupes=$(printf '%s\n' "$listed" | uniq -d | tr '\n' ' ')
want=$(printf '%s\n' "$disk" | grep -c .)
if [ "$want" -gt 0 ] && [ -z "$missing" ] && [ -z "$extra" ] && [ -z "$dupes" ]; then
  ok "the manifest ships exactly the ${want} migrations in migrations/, each once"
else
  bad 'the manifest ships every migration, each exactly once' \
    "absent: ${missing:-none} · not in migrations/: ${extra:-none} · listed twice: ${dupes:-none}"
fi

section 'the subcommand list is closed'

for c in step-e-dry-run step-e-apply backup-dry-run backup-apply \
         production-dump-rehearsal restore-drill-staging verify-evidence \
         status revoke-access; do
  has "$RUNNER" "  $c)" "the runner implements ${c}"
  has "$SUDOERS" "shikoo-task-runner $c" "sudoers grants ${c}"
done

# Exactly nine grants, and exactly nine case arms plus the catch-all.
n=$(grep -c '^hessamx ALL=(root) NOPASSWD:' "$SUDOERS" || true)
if [ "$n" = '9' ]; then ok 'sudoers grants exactly nine commands'; else
  bad 'sudoers grants exactly nine commands' "found ${n}"
fi

has "$RUNNER" "unknown subcommand" 'an unrecognised subcommand is refused'
has "$RUNNER" 'exactly one subcommand and no arguments' 'extra arguments are refused'

section 'the rehearsal is argument-free and root-only'

has "$RUNNER" 'production-dump-rehearsal.sh' 'the runner invokes the rehearsal script'
# It runs as root deliberately (throwaway containers, the backup directory) and
# must not be handed anything.
# The whole arm, not a fixed line count. `grep -A12` stopped at the line before
# the invocation, so both of these reported ok whatever the arm actually did —
# on a root-privileged path.
ARM=$(awk '/^  production-dump-rehearsal\)/{f=1} f{print} f&&/^    ;;/{exit}' "$RUNNER")
if [ -z "$ARM" ]; then
  bad 'the production-dump-rehearsal arm can be located' 'it could not be extracted'
else
  ok 'the production-dump-rehearsal arm can be located'
fi
if printf '%s\n' "$ARM" | grep -q 'rehearsal.sh'; then
  ok 'the extracted arm contains the invocation'
else
  bad 'the extracted arm contains the invocation' 'the window is still too small'
fi
if printf '%s\n' "$ARM" | grep -q 'as_deploy'; then
  bad 'the rehearsal does not run through as_deploy' 'it does'
else
  ok 'the rehearsal runs as root, not as the deploy user'
fi
if printf '%s\n' "$ARM" | grep -qE 'rehearsal\.sh" +[^|&]'; then
  bad 'the rehearsal is invoked with no arguments' 'an argument is passed'
else
  ok 'the rehearsal is invoked with no arguments'
fi

section 'no production form exists'

for forbidden in restore-drill-production promote-production cutover-production \
                 step-e-production backup-production; do
  hasnt "$RUNNER" "$forbidden" "the runner has no ${forbidden}"
  hasnt "$SUDOERS" "$forbidden" "sudoers has no ${forbidden}"
done
# The drill is called with the literal word, never a variable.
has "$RUNNER" 'restore-drill.sh" staging' 'the drill is invoked with the literal word staging'

section 'the grant is narrow'

# Comment lines are excluded on purpose: the header explains what is absent,
# and a check that matched its own prose would be a check that can only pass.
grants() { grep -vE '^[[:space:]]*#' "$SUDOERS"; }
if grants | grep -q 'NOPASSWD: *ALL'; then
  bad 'sudoers contains no NOPASSWD: ALL' 'a grant line has it'
else
  ok 'sudoers contains no NOPASSWD: ALL'
fi
if grants | grep -q 'SETENV'; then
  bad 'sudoers contains no SETENV' 'a grant line has it'
else
  ok 'sudoers contains no SETENV'
fi
if grants | grep -qE '=\(ALL\)|ALL=\(ALL'; then
  bad 'sudoers names no ALL command target' 'a grant line has it'
else
  ok 'sudoers names no ALL command target'
fi
if grep -E '^hessamx ' "$SUDOERS" | grep -q '\*'; then
  bad 'no command wildcard' 'a * appears in a grant line'
else
  ok 'no command wildcard'
fi
if grep -E '^hessamx ' "$SUDOERS" | grep -qE '/bin/(ba)?sh|/usr/bin/env|python|perl'; then
  bad 'no interpreter is granted' 'an interpreter appears in a grant line'
else
  ok 'no interpreter is granted'
fi
if grep -E '^hessamx ' "$SUDOERS" | grep -qE 'NOPASSWD: */usr/local/sbin/shikoo-task-runner *$'; then
  bad 'no grant omits its subcommand' 'a bare runner invocation is granted'
else
  ok 'no grant omits its subcommand'
fi
# Every grant line names the same absolute, root-owned target.
if [ "$(grep -cE '^hessamx ALL=\(root\) NOPASSWD: /usr/local/sbin/shikoo-task-runner [a-z-]+$' "$SUDOERS")" = '9' ]; then
  ok 'every grant is one complete absolute command'
else
  bad 'every grant is one complete absolute command' 'a line has an unexpected shape'
fi

section 'the runner hardens its own environment'

has "$RUNNER" 'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' 'it fixes PATH'
has "$RUNNER" 'unset CONF STATE CONTRACT LOCK' 'it unsets caller-supplied task variables'
has "$RUNNER" 'BASH_ENV ENV CDPATH' 'it unsets BASH_ENV, ENV and CDPATH'
has "$RUNNER" 'is a symlink — refusing' 'it refuses symlinks'
has "$RUNNER" "is not owned by root:root" 'it refuses non-root-owned scripts'
has "$RUNNER" 'expected one of' 'it refuses unexpected modes'
has "$RUNNER" 'does not match the manifest' 'it refuses a hash mismatch'
has "$RUNNER" 'unmanaged file(s) in' 'it refuses unmanaged files in the bundle directory'
has "$RUNNER" 'flock -n 9' 'it locks against concurrent runs'
has "$RUNNER" 'verify_bundle' 'every task verifies the bundle first'

# Verification must happen before the work, on every path.
for c in step-e-dry-run step-e-apply backup-dry-run backup-apply; do
  if grep -A1 "  ${c})" "$RUNNER" | grep -q 'run_task'; then
    ok "${c} goes through run_task, which verifies first"
  else
    bad "${c} goes through run_task, which verifies first" 'it does not'
  fi
done

section 'revoke removes the grant and nothing else'

has "$RUNNER" 'rm -f "$SUDOERS"' 'revoke removes the sudoers fragment'
has "$RUNNER" 'visudo -cf /etc/sudoers' 'revoke revalidates sudoers afterwards'
has "$RUNNER" 'evidence under $STATE_DIR is untouched' 'revoke leaves evidence alone'
if awk '/^  revoke-access\)/,/^    ;;/' "$RUNNER" | grep -qE 'rm -rf|rm .*STATE_DIR|rm .*BACKUP'; then
  bad 'revoke deletes no evidence, backup or data' 'it removes something else'
else
  ok 'revoke deletes no evidence, backup or data'
fi

section 'no secret in argv or output'

if grep -qE 'COOLIFY_TOKEN=|DATABASE_URL=|api\.telegram\.org' "$RUNNER"; then
  bad 'the runner names no credential' 'one appears'
else
  ok 'the runner names no credential'
fi
has "$RUNNER" 'env -i' 'the task environment is emptied before each script'

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
