#!/usr/bin/env bash
# The second production release must create nothing.
#
# "Create three Docker Image applications" is correct exactly once. Run it again
# and there are six; a third time and there are nine, half holding stale
# variables, all named almost the same, and the one owning the live domain is
# whichever a person last remembered. This suite is mostly about the SECOND
# run, because the first one is the easy half and the one everybody tests.

set -Eeuo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
SCRIPT="$ROOT/deploy/ensure-production-candidates.sh"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf '  ok   %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n       %s\n' "$1" "$2"; }
section() { printf '\n%s\n' "$1"; }

BIN="$WORK/bin"
mkdir -p "$BIN"
PATH="$BIN:$PATH"
export PATH

SECRET_TOKEN='0|NEVER-PRINT-THIS-TOKEN'
CONF="$WORK/deploy.env"
cat >"$CONF" <<EOF
COOLIFY_URL=http://127.0.0.1:8000
COOLIFY_TOKEN=${SECRET_TOKEN}
EOF

CONTRACT="$WORK/coolify-contract.env"
cat >"$CONTRACT" <<'EOF'
schema_version=2
instant_deploy_false_creates_nothing=proven
autogenerate_domain_false_creates_no_domain=proven
auto_deploy_disabled_before_configuration=proven
previews_disabled_before_configuration=proven
delete_leaves_no_row=proven
EOF

# The fake panel keeps its applications in a file, so a second run of the script
# sees what the first one created — which is the whole property under test.
STATE="$WORK/apps.json"
POSTS="$WORK/posts.log"
printf '[]' >"$STATE"
: >"$POSTS"

cat >"$BIN/curl" <<FAKE
#!/usr/bin/env bash
set -Eeuo pipefail
method=GET
body=''
url=\${*: -1}
prev=''
for a in "\$@"; do
  [ "\$prev" = '-X' ] && method="\$a"
  [ "\$prev" = '--data-binary' ] && body="\$a"
  prev="\$a"
done
case "\$url" in
  */projects)     printf '[{"name":"shikoo","uuid":"projuuid00000000000001"}]200' ;;
  */servers)      printf '[{"uuid":"srvuuid000000000000001"}]200' ;;
  */applications)
    if [ "\$method" = 'GET' ]; then
      printf '%s200' "\$(cat "$STATE")"
    else
      printf '%s\n' "\$body" >>"$POSTS"
      name=\$(printf '%s' "\$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
      uuid="uuid\$(printf '%s' "\$name" | md5sum | cut -c1-20)"
      python3 - "$STATE" "\$name" "\$uuid" <<'PY'
import json,sys
p,name,uuid=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p))
d.append({"name":name,"uuid":uuid,"build_pack":"dockerimage",
          "environment":{"name":"production","project":{"uuid":"projuuid00000000000001"}}})
json.dump(d,open(p,"w"))
PY
      printf '{"uuid":"%s"}201' "\$uuid"
    fi ;;
  */applications/dockerimage)
    printf '%s\n' "\$body" >>"$POSTS"
    name=\$(printf '%s' "\$body" | python3 -c 'import json,sys; print(json.load(sys.stdin)["name"])')
    uuid="uuid\$(printf '%s' "\$name" | md5sum | cut -c1-20)"
    python3 - "$STATE" "\$name" "\$uuid" <<'PY'
import json,sys
p,name,uuid=sys.argv[1],sys.argv[2],sys.argv[3]
d=json.load(open(p))
d.append({"name":name,"uuid":uuid,"build_pack":"dockerimage",
          "environment":{"name":"production","project":{"uuid":"projuuid00000000000001"}}})
json.dump(d,open(p,"w"))
PY
    printf '{"uuid":"%s"}201' "\$uuid" ;;
  */applications/*)
    # The hardening PATCH, matched AFTER the create above. The wildcard here
    # also matches the dockerimage create path, and putting it first made every
    # create return an empty body with a 200.
    printf '{}200' ;;
  *) printf '{}404' ;;
esac
FAKE
chmod +x "$BIN/curl"

# `coolify_harden_settings` verifies through Coolify's database, so the fake
# has to answer that read. `f|f` is a successfully hardened application.
cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'f|f\n'
FAKE
chmod +x "$BIN/docker"

run_ensure() { # -> output in $1
  set +e
  env CONF="$CONF" CONTRACT="$CONTRACT" bash "$SCRIPT" production >"$1" 2>&1
  local rc=$?
  set -e
  return $rc
}

section 'the first release creates three, the second creates none'

OUT1="$WORK/run1.txt"
if run_ensure "$OUT1"; then ok 'the first run succeeds'; else
  bad 'the first run succeeds' "$(tail -3 "$OUT1")"
fi

if grep -qF 'created this run: 3' "$OUT1"; then
  ok 'the first run creates exactly three applications'
else
  bad 'the first run creates exactly three applications' "$(grep 'created this run' "$OUT1" || tail -2 "$OUT1")"
fi

for role in ingest dashboard bot; do
  if grep -qE "^candidate_${role}=uuid" "$OUT1"; then
    ok "the first run reports a ${role} uuid"
  else
    bad "the first run reports a ${role} uuid" "$(tail -3 "$OUT1")"
  fi
done

POSTS_AFTER_FIRST=$(grep -c . "$POSTS" || true)

OUT2="$WORK/run2.txt"
if run_ensure "$OUT2"; then ok 'the second run succeeds'; else
  bad 'the second run succeeds' "$(tail -3 "$OUT2")"
fi

# The property this file exists for.
if grep -qF 'created this run: 0' "$OUT2"; then
  ok 'the second run creates ZERO applications'
else
  bad 'the second run creates ZERO applications' "$(grep 'created this run' "$OUT2" || tail -2 "$OUT2")"
fi

POSTS_AFTER_SECOND=$(grep -c . "$POSTS" || true)
if [ "$POSTS_AFTER_FIRST" = "$POSTS_AFTER_SECOND" ]; then
  ok 'the second run makes no create call at all'
else
  bad 'the second run makes no create call at all' \
    "create calls went from ${POSTS_AFTER_FIRST} to ${POSTS_AFTER_SECOND}"
fi

# Same uuids, not merely the same count.
for role in ingest dashboard bot; do
  a=$(grep -E "^candidate_${role}=" "$OUT1" | head -1)
  b=$(grep -E "^candidate_${role}=" "$OUT2" | head -1)
  if [ -n "$a" ] && [ "$a" = "$b" ]; then
    ok "the ${role} candidate keeps the same uuid across releases"
  else
    bad "the ${role} candidate keeps the same uuid across releases" "'${a}' vs '${b}'"
  fi
done

# A third release, because "idempotent once" is not idempotent.
OUT3="$WORK/run3.txt"
run_ensure "$OUT3" || true
TOTAL_APPS=$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$STATE")
if [ "$TOTAL_APPS" = '3' ]; then
  ok 'after three releases the panel still holds exactly three applications'
else
  bad 'after three releases the panel still holds exactly three applications' "found ${TOTAL_APPS}"
fi

section 'what the create call actually asks for'

first_post=$(head -1 "$POSTS")
want_field() { # name  json-path  expected
  local got
  got=$(printf '%s' "$first_post" | python3 -c 'import json,sys
v=json.load(sys.stdin).get(sys.argv[1])
print("" if v is None else ("true" if v is True else ("false" if v is False else v)))' "$2")
  if [ "$got" = "$3" ]; then ok "$1"; else bad "$1" "got '${got}', wanted '${3}'"; fi
}
want_field 'the create asks for no instant deploy' instant_deploy false
want_field 'the create asks for no autogenerated domain' autogenerate_domain false
want_field 'the create names the project' project_uuid projuuid00000000000001
want_field 'the create names the server' server_uuid srvuuid000000000000001
want_field 'the create names the environment' environment_name production

if printf '%s' "$first_post" | grep -qE '"(domains|fqdn|ports_mappings)"'; then
  bad 'the create requests no domain and no host port mapping' 'it names one'
else
  ok 'the create requests no domain and no host port mapping'
fi

section 'refusals'

# Creating production applications against an API contract nobody verified on
# this instance is exactly what the probe exists to prevent.
OUT4="$WORK/run4.txt"
set +e
env CONF="$CONF" CONTRACT="$WORK/absent.env" bash "$SCRIPT" production >"$OUT4" 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ] && grep -qF 'unverified API contract' "$OUT4"; then
  ok 'it refuses to create without a Coolify contract attestation'
else
  bad 'it refuses to create without a Coolify contract attestation' "$(tail -2 "$OUT4")"
fi

printf 'schema_version=1\n' >"$WORK/weak.env"
set +e
env CONF="$CONF" CONTRACT="$WORK/weak.env" bash "$SCRIPT" production >"$OUT4" 2>&1
rc=$?
set -e
if [ "$rc" -ne 0 ]; then
  ok 'it refuses an attestation that does not record the proofs'
else
  bad 'it refuses an attestation that does not record the proofs' 'it proceeded'
fi

section 'a candidate that cannot be hardened is deleted, not left exposed'

# The failure this guards is specific and quiet: the create endpoint accepts
# `is_auto_deploy_enabled: false` and discards it, so a new production
# application has push-to-deploy ON until the PATCH lands. If the PATCH cannot
# be proven, leaving the application behind leaves that exposure behind with
# nobody's name against it.
DELETES="$WORK/deletes.log"
: >"$DELETES"
printf '[]' >"$STATE"
: >"$POSTS"

cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 't|f
'   # the PATCH answered 200 and Auto Deploy is still on
FAKE
chmod +x "$BIN/docker"

OUT5="$WORK/run5.txt"
set +e
# DELETE_TIMEOUT is capped because the abort path waits for the deletion it
# just requested to converge, and this fake never reports convergence. The real
# one converges in about a second; the default 120s would make this suite two
# minutes of sleeping.
env CONF="$CONF" CONTRACT="$CONTRACT" DELETE_TIMEOUT=2 bash "$SCRIPT" production >"$OUT5" 2>&1
rc=$?
set -e

if [ "$rc" -ne 0 ]; then
  ok 'it fails when Auto Deploy cannot be proven off'
else
  bad 'it fails when Auto Deploy cannot be proven off' 'it proceeded'
fi

if grep -qF 'deleted rather than left exposed' "$OUT5"; then
  ok 'it says the application was deleted rather than left exposed'
else
  bad 'it says the application was deleted rather than left exposed' "$(tail -2 "$OUT5")"
fi

if grep -qE 'hardening failed — deleting uuid' "$OUT5"; then
  ok 'it deletes the exact uuid it just created'
else
  bad 'it deletes the exact uuid it just created' "$(tail -3 "$OUT5")"
fi

# Restore a healthy fake for anything after this section.
cat >"$BIN/docker" <<'FAKE'
#!/usr/bin/env bash
set -Eeuo pipefail
printf 'f|f
'
FAKE
chmod +x "$BIN/docker"

section 'the token never appears in the output'

for f in "$OUT1" "$OUT2" "$OUT3" "$OUT4" "$POSTS"; do
  if grep -qF -- "$SECRET_TOKEN" "$f" 2>/dev/null; then
    bad "the token never appears in $(basename "$f")" 'it was printed'
  else
    ok "the token never appears in $(basename "$f")"
  fi
done

printf '\n%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
