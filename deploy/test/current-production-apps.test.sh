#!/usr/bin/env bash
# The first cutover changes application identity once. Prove that later normal
# promotions resolve the adopted Docker Image UUIDs, while malformed or
# ambiguous state fails closed and never exposes deploy.env credentials.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/current-production-apps.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }

OLD_INGEST=aaaaaaaaaaaaaaaaaaaaaaa1
OLD_DASHBOARD=aaaaaaaaaaaaaaaaaaaaaaa2
OLD_BOT=aaaaaaaaaaaaaaaaaaaaaaa3
NEW_INGEST=bbbbbbbbbbbbbbbbbbbbbbb1
NEW_DASHBOARD=bbbbbbbbbbbbbbbbbbbbbbb2
NEW_BOT=bbbbbbbbbbbbbbbbbbbbbbb3
SHA=1111111111111111111111111111111111111111
DIGEST=sha256:27fc8cda20a91beed15e11df848a2b0c7313cae193ae06032990c529dca8014a
SECRET='TOKEN-MUST-NOT-PRINT'
CONF="$WORK/deploy.env"
POINTER="$WORK/current-applications.env"
cat >"$CONF" <<EOF
COOLIFY_TOKEN=$SECRET
APP_INGEST=$OLD_INGEST
APP_DASHBOARD=$OLD_DASHBOARD
APP_BOT=$OLD_BOT
EOF

OUT="$WORK/output.log"
if bash "$SCRIPT" resolve "$POINTER" "$CONF" >"$OUT" 2>&1 &&
  grep -qF "app_ingest=$OLD_INGEST" "$OUT" &&
  grep -qF 'applications_source=config' "$OUT"; then
  ok 'before cutover the root config supplies the legacy application UUIDs'
else
  bad 'before cutover the root config supplies the legacy application UUIDs' "$(cat "$OUT")"
fi

if bash "$SCRIPT" adopt "$POINTER" "$NEW_INGEST" "$NEW_DASHBOARD" "$NEW_BOT" "$SHA" "$DIGEST" \
  >>"$OUT" 2>&1; then
  ok 'a successful cutover atomically adopts the canonical UUIDs'
else
  bad 'a successful cutover atomically adopts the canonical UUIDs' "$(tail -3 "$OUT")"
fi
if [ "$(stat -c '%a' "$POINTER")" = 600 ]; then
  ok 'the adopted pointer is private to the deploy account'
else
  bad 'the adopted pointer is private to the deploy account' "mode $(stat -c '%a' "$POINTER")"
fi

if bash "$SCRIPT" resolve "$POINTER" "$CONF" >"$WORK/adopted.log" 2>&1 &&
  grep -qF "app_ingest=$NEW_INGEST" "$WORK/adopted.log" &&
  grep -qF "app_dashboard=$NEW_DASHBOARD" "$WORK/adopted.log" &&
  grep -qF "app_bot=$NEW_BOT" "$WORK/adopted.log" &&
  grep -qF 'applications_source=adopted' "$WORK/adopted.log"; then
  ok 'later promotions resolve all three canonical UUIDs'
else
  bad 'later promotions resolve all three canonical UUIDs' "$(cat "$WORK/adopted.log")"
fi

cp "$POINTER" "$WORK/good.env"
if bash "$SCRIPT" adopt "$POINTER" "$OLD_INGEST" "$OLD_DASHBOARD" "$OLD_BOT" "$SHA" "$DIGEST" \
  >"$WORK/readopt.log" 2>&1; then
  bad 'an existing canonical pointer cannot be replaced' 'a second adoption overwrote production identity'
elif grep -qF 'may be adopted only once' "$WORK/readopt.log" &&
  cmp -s "$POINTER" "$WORK/good.env"; then
  ok 'an existing canonical pointer cannot be replaced'
else
  bad 'an existing canonical pointer cannot be replaced' "$(cat "$WORK/readopt.log")"
fi

# Materialise a competing, valid pointer at the exact commit boundary. A
# check-then-move implementation overwrites it; atomic no-replace must lose the
# race and leave the other cutover's identity byte-for-byte intact.
RACE_BIN="$WORK/race-bin"
RACE_POINTER="$WORK/race-current.env"
RACE_WINNER="$WORK/race-winner.env"
mkdir -p "$RACE_BIN"
cp "$WORK/good.env" "$RACE_WINNER"
sed -i "s/^app_ingest=.*/app_ingest=$OLD_INGEST/; s/^app_dashboard=.*/app_dashboard=$OLD_DASHBOARD/; s/^app_bot=.*/app_bot=$OLD_BOT/" "$RACE_WINNER"
cat >"$RACE_BIN/ln" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
cp "$RACE_WINNER" "$RACE_POINTER"
exec /usr/bin/ln "$@"
FAKE
chmod +x "$RACE_BIN/ln"
export RACE_WINNER RACE_POINTER
if PATH="$RACE_BIN:$PATH" bash "$SCRIPT" adopt "$RACE_POINTER" \
  "$NEW_INGEST" "$NEW_DASHBOARD" "$NEW_BOT" "$SHA" "$DIGEST" \
  >"$WORK/race.log" 2>&1; then
  bad 'concurrent adoption cannot replace the winning pointer' 'the losing adoption reported success'
elif grep -qF 'appeared while adopting' "$WORK/race.log" &&
  cmp -s "$RACE_POINTER" "$RACE_WINNER"; then
  ok 'concurrent adoption cannot replace the winning pointer'
else
  bad 'concurrent adoption cannot replace the winning pointer' "$(cat "$WORK/race.log")"
fi

printf 'app_bot=ccccccccccccccccccccccc3\n' >>"$POINTER"
if bash "$SCRIPT" resolve "$POINTER" "$CONF" >"$WORK/duplicate.log" 2>&1; then
  bad 'a duplicate pointer key is refused' 'it resolved ambiguously'
elif grep -qF 'contains a duplicate key' "$WORK/duplicate.log"; then
  ok 'a duplicate pointer key is refused'
else
  bad 'a duplicate pointer key is refused' "$(cat "$WORK/duplicate.log")"
fi

cp "$WORK/good.env" "$POINTER"
sed -i 's/^app_bot=.*/app_bot=not-a-uuid/' "$POINTER"
if bash "$SCRIPT" resolve "$POINTER" "$CONF" >"$WORK/malformed.log" 2>&1; then
  bad 'a malformed adopted UUID is refused' 'it reached deployment'
elif grep -qF 'bot application uuid is missing or malformed' "$WORK/malformed.log"; then
  ok 'a malformed adopted UUID is refused'
else
  bad 'a malformed adopted UUID is refused' "$(cat "$WORK/malformed.log")"
fi

rm -f "$POINTER"
ln -s "$WORK/good.env" "$POINTER"
if bash "$SCRIPT" resolve "$POINTER" "$CONF" >"$WORK/symlink.log" 2>&1; then
  bad 'a symlinked application pointer is refused' 'it was followed'
elif grep -qF 'is a symlink' "$WORK/symlink.log"; then
  ok 'a symlinked application pointer is refused'
else
  bad 'a symlinked application pointer is refused' "$(cat "$WORK/symlink.log")"
fi

if grep -qF "$SECRET" "$OUT" "$WORK/adopted.log" "$WORK/duplicate.log" \
  "$WORK/readopt.log" "$WORK/race.log" "$WORK/malformed.log" "$WORK/symlink.log"; then
  bad 'the resolver never prints a credential from deploy.env' 'the fake token reached output'
else
  ok 'the resolver never prints a credential from deploy.env'
fi

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
