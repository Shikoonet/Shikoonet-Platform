#!/usr/bin/env bash
# The sidecar generator, audited as the privileged thing it is.
#
# The previous round tested what the CONSUMER does with a sidecar and took the
# producer on trust. That is the wrong way round: the generator runs on the
# secure host, beside the production dump, and it is the only component that
# writes a file the promotion gate later believes. Its own refusals, its own
# publication, and what it prints are all part of the contract.
set -uo pipefail

HERE=$(CDPATH='' ; cd -- "$(dirname -- "$0")" && pwd)
ROOT=$(CDPATH='' ; cd -- "$HERE/../.." && pwd)
GEN="$ROOT/tools/d1-export-manifest.py"
PASS=0; FAIL=0; SKIPPED=0
ok()  { PASS=$((PASS+1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf '  FAIL %s\n     %s\n' "$1" "${2-}"; }
section() { printf '\n%s\n' "$1"; }

W=$(mktemp -d); trap 'rm -rf "$W"' EXIT
TABLES="$W/d1-tables.manifest"
cp "$ROOT/deploy/d1-tables.manifest" "$TABLES"; chmod 644 "$TABLES"

D1="$W/d1"; DUMP="$W/mirzabot.sql"

build() { # -> a complete, in-contract bundle, unsealed
  # `rm` first, always: a previous case may have left $DUMP as a symlink, and a
  # redirection onto a symlink writes through it rather than replacing it.
  rm -rf "$D1"; rm -f "$DUMP"; mkdir -p "$D1"
  local t
  while read -r t; do
    [ -n "$t" ] || continue
    if [ "$t" = payment_claims ]; then
      printf '[{"id":1,"source_system":"MIRZABOT","external_order_id":"ORD-7001"}]' >"$D1/${t}.json"
    else
      printf '[{"id":1,"email":"ops@shikoo.ir"}]' >"$D1/${t}.json"
    fi
  done <"$TABLES"
  printf 'INSERT INTO invoice VALUES (1,"ORD-7001",5000);\n' >"$DUMP"
  chmod 755 "$D1"; chmod 640 "$D1"/*.json "$DUMP"
}

run() { python3 "$GEN" "$D1" "$DUMP" "$TABLES" >"$W/out" 2>"$W/err"; }

refuses() { # label want-substring
  if run; then
    bad "$1" 'it was accepted'
  elif grep -qF "$2" "$W/err"; then
    ok "$1"
  else
    bad "$1" "refused, but not for '$2': $(head -1 "$W/err")"
  fi
}

section 'it seals a complete bundle and says almost nothing'

build
if run; then ok 'a complete in-contract bundle is sealed'; else bad 'a complete in-contract bundle is sealed' "$(cat "$W/err")"; fi
ID=$(cat "$W/out")
case "$ID" in sha256:*) ok 'it prints the bundle identity' ;; *) bad 'it prints the bundle identity' "got '$ID'" ;; esac
if [ "$(wc -l <"$W/out")" = 1 ]; then ok 'it prints exactly one line'; else bad 'it prints exactly one line' "$(wc -l <"$W/out") lines"; fi

# Nothing it prints may name a path, a customer value, a token, or a record.
if grep -qE "$W|ORD-7001|ops@shikoo.ir|/tmp/|mirzabot.sql" "$W/out" "$W/err"; then
  bad 'it prints no path, customer value or record identifier' "$(cat "$W/out" "$W/err" | head -2)"
else
  ok 'it prints no path, customer value or record identifier'
fi
# Nor may the sidecar itself.
if grep -qE "$W|ORD-7001|ops@shikoo\.ir|/tmp/" "$D1/d1-export.manifest"; then
  bad 'the sidecar carries no path, customer value or record identifier' 'a match was found'
else
  ok 'the sidecar carries no path, customer value or record identifier'
fi
# Counts and verdicts only.
for f in schema_version capture_id table_count mysql_dump_sha256 capture_window_seconds \
         capture_window_max capture_order coherence_checked coherence_missing coherence; do
  if grep -q "^${f}=" "$D1/d1-export.manifest"; then ok "the sidecar records ${f}"; else bad "the sidecar records ${f}" 'absent'; fi
done

section 'the mode is enforced after publication, not merely requested'

# `mkstemp` honours the umask and an existing sidecar could carry any mode; the
# mode is set on the object that becomes the sidecar, so neither can leak in.
build; ( umask 000; run )
if [ "$(stat -c '%a' "$D1/d1-export.manifest")" = 640 ]; then
  ok 'a permissive umask cannot widen the sidecar'
else
  bad 'a permissive umask cannot widen the sidecar' "mode $(stat -c '%a' "$D1/d1-export.manifest")"
fi
build; : >"$D1/d1-export.manifest"; chmod 666 "$D1/d1-export.manifest"; run
if [ "$(stat -c '%a' "$D1/d1-export.manifest")" = 640 ]; then
  ok 'an existing world-writable sidecar cannot keep its mode'
else
  bad 'an existing world-writable sidecar cannot keep its mode' "mode $(stat -c '%a' "$D1/d1-export.manifest")"
fi

section 'it refuses its inputs before it reads them'

build; chmod 777 "$D1"
refuses 'a world-writable export directory is refused' 'group- or world-writable'
build; chmod 666 "$D1/devices.json"
refuses 'a world-writable table file is refused' 'group- or world-writable'
build; chmod 666 "$DUMP"
refuses 'a world-writable dump is refused' 'group- or world-writable'
build; chmod 666 "$TABLES"
refuses 'a world-writable table manifest is refused' 'group- or world-writable'
chmod 644 "$TABLES"

build; rm -f "$D1/devices.json"; ln -s "$DUMP" "$D1/devices.json"
refuses 'a symlinked table file is refused' 'symlink'
build; rm -f "$DUMP"; ln -s "$W/elsewhere.sql" "$DUMP"; printf 'x\n' >"$W/elsewhere.sql"
refuses 'a symlinked dump is refused' 'symlink'
build
D1REAL="$D1"; D1="$W/d1link"; ln -sfn "$D1REAL" "$D1"
# realpath collapses the link, so the directory that is checked and the one
# written to are the same object — which is the point of canonicalising first.
if run; then ok 'a symlinked export directory resolves to its target'; else bad 'a symlinked export directory resolves to its target' "$(head -1 "$W/err")"; fi
D1="$D1REAL"; rm -f "$W/d1link"

build; printf 'not_a_real_table\n' >>"$TABLES"
refuses 'a table manifest that is not the reviewed one is refused' 'not the reviewed'
cp "$ROOT/deploy/d1-tables.manifest" "$TABLES"; chmod 644 "$TABLES"

build; rm -f "$D1/comments.json"
refuses 'an incomplete export is refused' 'incomplete'
build; printf '[]' >"$D1/not_in_contract.json"
refuses 'an extra file is refused' 'not part of the contract'

section 'the bounded-consistency contract is enforced at the source'

build; touch -d '-3 hours' "$D1/devices.json"
refuses 'a capture window beyond the bound is refused' 'capture window'

# Just over the line. `int(round(3600.4))` is 3600, so a bundle that genuinely
# exceeded the window sealed anyway; the span has to be compared before it is
# rounded, and recorded rounded UP.
build
BASE=1800000000
while read -r t; do touch -d "@${BASE}" "$D1/${t}.json"; done <"$TABLES"
touch -d "@$(python3 -c "print(f'{$BASE + 3600.4:.1f}')")" "$DUMP"
refuses 'a window of 3600.4s is refused, not rounded down to 3600' 'capture window'
build
while read -r t; do touch -d "@${BASE}" "$D1/${t}.json"; done <"$TABLES"
touch -d "@$(python3 -c "print(f'{$BASE + 3599.4:.1f}')")" "$DUMP"
if run; then ok 'a window of 3599.4s is accepted'; else bad 'a window of 3599.4s is accepted' "$(head -1 "$W/err")"; fi
if [ "$(sed -n 's/^capture_window_seconds=//p' "$D1/d1-export.manifest")" = 3600 ]; then
  ok 'the recorded window is rounded up, never down'
else
  bad 'the recorded window is rounded up, never down' "recorded $(sed -n 's/^capture_window_seconds=//p' "$D1/d1-export.manifest")"
fi

build; touch -d '-10 minutes' "$DUMP"
refuses 'a dump older than the newest D1 file is refused' 'older than the newest D1 file'

build; printf 'INSERT INTO invoice VALUES (1,"ORD-0000",1);\n' >"$DUMP"; chmod 640 "$DUMP"
refuses 'a dump missing a referenced order is refused' 'absent from this dump'

# The bare prefix with no order after it. `mirzabot:test:` is permitted by the
# schema and strips to an empty string, whose boundary regex matches ordinary
# dump text at any non-identifier position — so the bundle would have recorded
# coherence=pass having looked for nothing at all.
build
printf '[{"id":1,"source_system":"MIRZABOT","external_order_id":"mirzabot:test:"}]' >"$D1/payment_claims.json"
chmod 640 "$D1/payment_claims.json"; touch "$DUMP"
refuses 'a prefix-only order reference is refused' 'names nothing to look for'

build
printf '[{"id":1,"source_system":"MIRZABOT","external_order_id":""}]' >"$D1/payment_claims.json"
chmod 640 "$D1/payment_claims.json"; touch "$DUMP"
refuses 'an empty order reference is refused' 'carries no external_order_id'

# The prefixed form still works when it actually names an order.
build
printf '[{"id":1,"source_system":"MIRZABOT","external_order_id":"mirzabot:test:ORD-7001"}]' >"$D1/payment_claims.json"
chmod 640 "$D1/payment_claims.json"; touch "$DUMP"
if run; then ok 'a prefixed reference naming a real order is accepted'; else bad 'a prefixed reference naming a real order is accepted' "$(head -1 "$W/err")"; fi

section 'publication is atomic, and a failure leaves the previous sidecar alone'

build
run || { echo "the reference bundle would not seal: $(cat "$W/err")" >&2; exit 1; }
cp "$D1/d1-export.manifest" "$W/good.manifest"

# A rename failure: the sidecar name is occupied by a non-empty directory, so
# `os.rename` raises ENOTEMPTY. This is the one way the final step can fail.
build; cp "$W/good.manifest" "$D1/d1-export.manifest"
rm -f "$D1/d1-export.manifest"; mkdir -p "$D1/d1-export.manifest/occupied"
printf 'x\n' >"$D1/d1-export.manifest/occupied/f"
if run; then
  bad 'a rename failure is reported, not swallowed' 'it reported success'
elif grep -q 'could not be published' "$W/err"; then
  ok 'a rename failure is reported, not swallowed'
else
  bad 'a rename failure is reported, not swallowed' "$(head -1 "$W/err")"
fi
if [ -f "$D1/d1-export.manifest/occupied/f" ]; then
  ok 'a failed rename destroys nothing that stood in its way'
else
  bad 'a failed rename destroys nothing that stood in its way' 'the obstruction is gone'
fi
if [ -z "$(find "$D1" -maxdepth 1 -name '.d1-export.manifest.*' -print -quit)" ]; then
  ok 'a failed rename leaves no partial sidecar'
else
  bad 'a failed rename leaves no partial sidecar' "$(find "$D1" -maxdepth 1 -name '.d1-export.manifest.*')"
fi
rm -rf "$D1/d1-export.manifest"

# A write failure: the export directory is read-only, so the temporary file
# cannot be created. Root ignores the mode, so this proves nothing there and is
# reported as skipped rather than counted as a pass.
build; cp "$W/good.manifest" "$D1/d1-export.manifest"; chmod 640 "$D1/d1-export.manifest"
BEFORE=$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)
if [ "$(id -u)" -eq 0 ]; then
  SKIPPED=$((SKIPPED + 2))
  printf '  SKIP a write failure is reported (running as root: mode 500 does not stop root)\n'
  printf '  SKIP a write failure leaves the previous sidecar byte-identical (same reason)\n'
else
  chmod 500 "$D1"
  run >/dev/null 2>&1
  RC=$?
  chmod 755 "$D1"
  if [ "$RC" -ne 0 ]; then ok 'a write failure is reported'; else bad 'a write failure is reported' 'it reported success'; fi
  if [ "$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)" = "$BEFORE" ]; then
    ok 'a write failure leaves the previous sidecar byte-identical'
  else
    bad 'a write failure leaves the previous sidecar byte-identical' 'it changed'
  fi
fi

# The write-back verification, exercised by injecting the fault it exists for.
#
# A short write is not something a test can provoke on a healthy filesystem, so
# the read that checks for one is injected against instead: a sitecustomize
# module wraps `open` and hands back truncated content for the temporary
# sidecar, and nothing else. Without this the check could be deleted and no
# test would notice — which is exactly what the mutation matrix reported.
mkdir -p "$W/inject"
cat >"$W/inject/sitecustomize.py" <<'PY'
import builtins

_real = builtins.open


class _Truncated:
    def read(self, *_a):
        return "this is not what was written"

    def __enter__(self):
        return self

    def __exit__(self, *_e):
        return False

    def close(self):
        pass


def _open(file, mode="r", *a, **k):
    # Only the sidecar's own write-back read, and only in text mode: every
    # other open in the generator behaves normally.
    if (
        isinstance(file, str)
        and ".d1-export.manifest." in file
        and "r" in mode
        and "b" not in mode
    ):
        return _Truncated()
    return _real(file, mode, *a, **k)


builtins.open = _open
PY

build
cp "$W/good.manifest" "$D1/d1-export.manifest"; chmod 640 "$D1/d1-export.manifest"
BEFORE=$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)
if PYTHONPATH="$W/inject" python3 "$GEN" "$D1" "$DUMP" "$TABLES" >/dev/null 2>"$W/err"; then
  bad 'a sidecar that does not survive its own write is not published' 'it was published'
elif grep -q 'did not survive its own write' "$W/err"; then
  ok 'a sidecar that does not survive its own write is not published'
else
  bad 'a sidecar that does not survive its own write is not published' "$(head -1 "$W/err")"
fi
if [ "$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)" = "$BEFORE" ]; then
  ok 'a failed write-back leaves the previous sidecar byte-identical'
else
  bad 'a failed write-back leaves the previous sidecar byte-identical' 'it changed'
fi
if [ -z "$(find "$D1" -maxdepth 1 -name '.d1-export.manifest.*' -print -quit)" ]; then
  ok 'a failed write-back leaves no partial sidecar'
else
  bad 'a failed write-back leaves no partial sidecar' 'a temporary file survived'
fi

# INT and TERM, stopped at a real barrier rather than raced against.
#
# The first version of this made the dump large enough that hashing took a
# while and signalled during it. That passed here and failed on a runner, which
# hashed faster than the poll loop noticed — a test whose result depended on
# relative machine speed. The generator refuses a non-regular dump, so a FIFO
# cannot be the dump; instead a sitecustomize blocks it inside the write-back
# read, which is exactly the window where a complete temporary file exists and
# nothing has been published. The test knows it is there because the generator
# says so on a FIFO before waiting on another.
mkdir -p "$W/barrier"
cat >"$W/barrier/sitecustomize.py" <<'PY'
import builtins
import os

_real = builtins.open


def _open(file, mode="r", *a, **k):
    if (
        isinstance(file, str)
        and ".d1-export.manifest." in file
        and "r" in mode
        and "b" not in mode
    ):
        # The complete temporary sidecar exists and nothing is published yet.
        with _real(os.environ["BARRIER_READY"], "w") as fh:
            fh.write("at-barrier\n")
        with _real(os.environ["BARRIER_GO"], "r") as fh:
            # One line, not `read()`: the test holds the write end open, so
            # EOF never arrives and `read()` would wait for it forever if the
            # signal under test were ever delayed or ignored.
            fh.readline()
    return _real(file, mode, *a, **k)


builtins.open = _open
PY

signal_run() { # signame expected-code
  local sig=$1 want=$2 rc before
  build
  cp "$W/good.manifest" "$D1/d1-export.manifest"; chmod 640 "$D1/d1-export.manifest"
  before=$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)
  rm -f "$W/ready" "$W/go"; mkfifo "$W/ready" "$W/go"
  # Both ends held read-write. Opening a FIFO for writing alone blocks until a
  # reader appears, so releasing the barrier after the signal had already
  # killed the only reader left an orphaned writer behind every run. `<>`
  # never blocks and gives this shell both ends of each pipe.
  exec 8<>"$W/ready" 9<>"$W/go"
  # `exec`, so $! is the interpreter itself and the signal goes to a PID this
  # test owns. `pkill -f d1-export-manifest.py` hit every process on the host
  # whose command line contained that string — a second run of this suite, or
  # any real invocation of the tool, would have been signalled too.
  (
    trap - INT TERM
    exec env PYTHONPATH="$W/barrier" BARRIER_READY="$W/ready" BARRIER_GO="$W/go" \
      python3 "$GEN" "$D1" "$DUMP" "$TABLES" >"$W/gen.out" 2>&1
  ) & local job=$!
  # Waits until the generator says it is inside the window — no polling, no
  # sleep — but bounded, so a generator that refuses BEFORE the barrier fails
  # this test while quoting its own reason instead of hanging it.
  if ! read -r -t 60 _ <&8; then
    bad "$sig: the barrier is reached with a temporary file present" \
      "the generator never reached the barrier: $(head -2 "$W/gen.out" 2>/dev/null)"
    kill "$job" 2>/dev/null; wait "$job" 2>/dev/null
    exec 8>&- 9>&-
    return
  fi
  if [ -z "$(find "$D1" -maxdepth 1 -name '.d1-export.manifest.*' -print -quit)" ]; then
    bad "$sig: the barrier is reached with a temporary file present" 'none found'
  else
    ok "$sig: the barrier is reached with a temporary file present"
  fi
  kill -"$sig" "$job" 2>/dev/null
  # Released unconditionally: a handler that ignored the signal then shows up
  # as the wrong exit code rather than as a hung test.
  echo go >&9
  wait "$job" 2>/dev/null; rc=$?
  exec 8>&- 9>&-
  if [ "$rc" = "$want" ]; then ok "$sig exits $want"; else bad "$sig exits $want" "exit was $rc"; fi
  if [ "$(sha256sum "$D1/d1-export.manifest" | cut -d' ' -f1)" = "$before" ]; then
    ok "$sig leaves the previous sidecar byte-identical"
  else
    bad "$sig leaves the previous sidecar byte-identical" 'it changed'
  fi
  if [ -z "$(find "$D1" -maxdepth 1 -name '.d1-export.manifest.*' -print -quit)" ]; then
    ok "$sig leaves no partial sidecar"
  else
    bad "$sig leaves no partial sidecar" 'a temporary file survived'
  fi
  rm -f "$W/ready" "$W/go"
}
signal_run INT 130
signal_run TERM 143

# The published sidecar is in the same directory as the temporary file, so the
# rename is same-filesystem by construction.
build; run
TMPDEV=$(stat -c '%d' "$D1")
OUTDEV=$(stat -c '%d' "$D1/d1-export.manifest")
if [ "$TMPDEV" = "$OUTDEV" ]; then
  ok 'the temporary file and the sidecar share one filesystem'
else
  bad 'the temporary file and the sidecar share one filesystem' "dev ${TMPDEV} vs ${OUTDEV}"
fi
# Both branches used to call `ok`, so this could not fail and it printed a
# nondeterministic test name. The claim is that a repeat seal differs ONLY in
# the timing fields, so those are stripped and the rest must be identical.
strip_timing() { grep -vE '^(capture_window_seconds|capture_id)=' "$1"; }
if diff <(strip_timing "$W/good.manifest") <(strip_timing "$D1/d1-export.manifest") >/dev/null; then
  ok 'sealing the same bundle twice differs only in the timing fields'
else
  bad 'sealing the same bundle twice differs only in the timing fields' \
    "$(diff <(strip_timing "$W/good.manifest") <(strip_timing "$D1/d1-export.manifest") | head -3)"
fi

if [ "$SKIPPED" -gt 0 ]; then
  printf '\n%s passed, %s failed, %s skipped\n' "$PASS" "$FAIL" "$SKIPPED"
else
  printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
fi
[ "$FAIL" -eq 0 ]
