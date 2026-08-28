#!/usr/bin/env bash
# shellcheck disable=SC2016  # assertions are literal strings searched for in
# another file; expansion is exactly what must not happen to them.
# The task runner: eight subcommands, and nothing else.
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
n=$(grep -c ' migrations/0' "$MANIFEST" || true)
if [ "$n" -ge 37 ]; then
  ok "the manifest ships all ${n} migrations"
else
  bad 'the manifest ships every migration' "only ${n} present"
fi

section 'the subcommand list is closed'

for c in step-e-dry-run step-e-apply backup-dry-run backup-apply \
         restore-drill-staging verify-evidence status revoke-access; do
  has "$RUNNER" "  $c)" "the runner implements ${c}"
  has "$SUDOERS" "shikoo-task-runner $c" "sudoers grants ${c}"
done

# Exactly eight grants, and exactly eight case arms plus the catch-all.
n=$(grep -c '^hessamx ALL=(root) NOPASSWD:' "$SUDOERS" || true)
if [ "$n" = '8' ]; then ok 'sudoers grants exactly eight commands'; else
  bad 'sudoers grants exactly eight commands' "found ${n}"
fi

has "$RUNNER" "unknown subcommand" 'an unrecognised subcommand is refused'
has "$RUNNER" 'exactly one subcommand and no arguments' 'extra arguments are refused'

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
if [ "$(grep -cE '^hessamx ALL=\(root\) NOPASSWD: /usr/local/sbin/shikoo-task-runner [a-z-]+$' "$SUDOERS")" = '8' ]; then
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
