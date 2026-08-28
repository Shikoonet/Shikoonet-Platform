# The two Coolify behaviours that documentation gets wrong on this version.
#
# ─────────────────────────────────────────────────────────────────────────────
# 1. HARDENING AUTO-DEPLOY CANNOT BE DONE AT CREATE TIME
#
# `is_auto_deploy_enabled` is in the create endpoint's own `$allowedFields`, and
# in its OpenAPI schema, documented as "Defaults to true". Passing `false`
# therefore looks like it works. It does not, for Docker Image applications:
#
#   · the `dockerimage` branch of `create_application()` has no
#     `if (isset($isAutoDeployEnabled))` block — the git-backed branches do
#   · it is not in `APPLICATION_SETTING_FIELDS`, so `applyApplicationSettings()`
#     does not reach it either
#   · `$application->fill($request->only($allowedFields))` silently drops it,
#     because it is a column of `application_settings`, not of `applications`
#
# So the value is accepted, discarded, and a caller that trusts the field
# believes it has disabled push-to-deploy on a production application when it
# has not. Measured on 4.3.13: a create passing `false` yields `t`.
#
# `PATCH /applications/{uuid}` DOES apply it. Hence create → PATCH → VERIFY,
# and the verify is the point: the PATCH is checked against the database rather
# than against its own 200, because "the API said OK" is what was already
# believed about the create.
#
# ─────────────────────────────────────────────────────────────────────────────
# 2. DELETE IS ASYNCHRONOUS
#
# `delete_by_uuid()` calls `$application->delete()` and then dispatches
# `DeleteResourceJob`. The response says so in as many words — "Application
# deletion request queued." The soft delete hides the row from the API
# immediately, so a GET 404s while the row is still in the table, and the queued
# job removes it a moment later.
#
# An assertion made immediately after the DELETE therefore fails on a deletion
# that is working perfectly. That is not soft deletion in the sense that
# matters: the row converges to gone, settings and all, which is what the
# polling below waits for and what the timeout refuses to assume.

# shellcheck shell=bash

COOLIFY_DB_CONTAINER=${COOLIFY_DB_CONTAINER:-coolify-db}

# The two flags, read from Coolify's own database.
#
# Not from the API: `GET /applications/{uuid}` serialises both as null, because
# they live on `application_settings` which it does not join. Measured
# 2026-08-27. Neither value is a secret.
coolify_settings_flags() { # uuid -> "<auto>|<previews>" or empty
  docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' \
    -c "select s.is_auto_deploy_enabled, s.is_preview_deployments_enabled
          from application_settings s join applications a on a.id = s.application_id
         where a.uuid = '$1';" 2>/dev/null || true
}

# Rows still naming this uuid, by both tables, as one number.
coolify_residue() { # uuid -> "<apps>|<settings>" or empty
  docker exec -i "$COOLIFY_DB_CONTAINER" psql -U coolify -d coolify -At -F'|' \
    -c "select
          (select count(*) from applications where uuid = '$1'),
          (select count(*) from application_settings s
             join applications a on a.id = s.application_id
            where a.uuid = '$1');" 2>/dev/null || true
}

# Disable native Auto Deploy and previews, then prove it from the database.
#
# Returns 0 only when BOTH are observed false. A PATCH that answers 200 and
# leaves the flag true fails here, which is the case this function exists for:
# the create endpoint already does exactly that, silently.
coolify_harden_settings() { # uuid -> 0 when both are proven false
  local uuid=$1 flags auto prev
  coolify_api PATCH "/applications/${uuid}" \
    '{"is_auto_deploy_enabled":false,"is_preview_deployments_enabled":false}' || {
    echo "[harden] could not reach Coolify to disable auto-deploy on ${uuid}" >&2
    return 1
  }
  case "$API_STATUS" in
    2??) ;;
    *)
      echo "[harden] the settings PATCH was refused (HTTP ${API_STATUS}) on ${uuid}" >&2
      return 1
      ;;
  esac

  # Verified against the database, never against the PATCH's own status. A 200
  # is exactly what the create returns while discarding the same field.
  flags=$(coolify_settings_flags "$uuid")
  if [ -z "$flags" ]; then
    echo "[harden] could not read the settings back for ${uuid} — refusing to assume they are false" >&2
    return 1
  fi
  auto=${flags%%|*}
  prev=${flags##*|}
  if [ "$auto" != 'f' ]; then
    echo "[harden] native Auto Deploy is still '${auto}' after a successful PATCH on ${uuid}" >&2
    return 1
  fi
  if [ "$prev" != 'f' ]; then
    echo "[harden] preview deployments are still '${prev}' after a successful PATCH on ${uuid}" >&2
    return 1
  fi
  return 0
}

# Wait for a deleted application to actually disappear, both tables, bounded.
#
# Prints the elapsed whole seconds on success. Returns 1 if it never converges,
# because "it will probably be gone soon" is not a thing a release may assume
# about a row that could still own a name it is about to reuse.
coolify_await_deletion() { # uuid [timeout-seconds] [interval-seconds]
  local uuid=$1 timeout=${2:-120} interval=${3:-2} waited=0 residue apps settings
  while :; do
    residue=$(coolify_residue "$uuid")
    if [ -n "$residue" ]; then
      apps=${residue%%|*}
      settings=${residue##*|}
      if [ "$apps" = '0' ] && [ "$settings" = '0' ]; then
        printf '%s' "$waited"
        return 0
      fi
    fi
    [ "$waited" -lt "$timeout" ] || {
      echo "[await] ${uuid} still has rows after ${timeout}s (applications=${apps:-?} settings=${settings:-?}) — refusing to call it deleted" >&2
      return 1
    }
    sleep "$interval"
    waited=$((waited + interval))
  done
}
