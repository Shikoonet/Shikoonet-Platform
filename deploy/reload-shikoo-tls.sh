#!/bin/sh
#
# certbot deploy hook — reload the TLS terminator that actually serves our cert.
#
# Install on the server as root:
#
#     install -m 0755 deploy/reload-shikoo-tls.sh \
#       /etc/letsencrypt/renewal-hooks/deploy/reload-shikoo-tls.sh
#
# Why this file has to exist, measured on 2026-08-23 rather than reasoned:
# `/etc/letsencrypt/renewal-hooks/deploy/` held two scripts, `reload-nginx.sh`
# and `reload-nginx-cdn.sh`, and BOTH run `systemctl reload nginx` — the HOST
# nginx. Nothing on that host serves shikoo.mahamsteel.ir or sms.mahamsteel.ir;
# they are served by the `shikoo-tls` container on :9443, which mounts
# /etc/letsencrypt whole. A renewal rewrites `archive/` and repoints the
# `live/` symlink, but nginx holds the certificate it parsed at startup until
# it is told to reload.
#
# So the failure this closes is the quiet one: a renewal that SUCCEEDS, reports
# success, and leaves the expired certificate on the wire until somebody
# restarts the container by hand. `certbot certificates` would show the new
# expiry while browsers saw the old one.
#
# `shikoo-tls` is a plain `docker run` with `--restart unless-stopped`, not a
# Coolify application, so unlike the app containers its name is stable and safe
# to write down here. See `coolify-container-names-are-not-stable` for why that
# distinction matters.

# Scoped to our lineage: this box also renews two miragerunner.com certificates
# that have nothing to do with this container. certbot sets RENEWED_LINEAGE to
# the live directory of whichever certificate was just renewed.
[ "${RENEWED_LINEAGE##*/}" = "shikoo" ] || exit 0

# A reload, not a restart: it keeps live connections, and it cannot leave :9443
# dark. `nginx -t` first so a bad config or a broken mount fails loudly here
# instead of quietly serving nothing.
if ! docker exec shikoo-tls nginx -t; then
  echo "reload-shikoo-tls: nginx -t failed, refusing to reload" >&2
  exit 1
fi

if ! docker exec shikoo-tls nginx -s reload; then
  echo "reload-shikoo-tls: reload failed — :9443 is still serving the OLD certificate" >&2
  exit 1
fi

echo "reload-shikoo-tls: reloaded after ${RENEWED_LINEAGE}"
