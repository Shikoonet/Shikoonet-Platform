#!/usr/bin/env bash
# One-time, as root, on the server: create the dedicated deployment user.
#
#   sh provision-deploy-user.sh "ssh-ed25519 AAAA… deploy@github"
#
# GitHub Actions must never hold the root key from .notes/ — it can do
# anything, forever, and rotating it means re-keying the whole box. This user
# can run docker and write the deploy directories, and nothing else. (Membership
# in the docker group is root-equivalent on this host in practice — dockerd
# runs as root — but the blast radius of a leaked GitHub secret is still a key
# that can be deleted in one line, not the key to everything.)
#
# Until this has been run, CD has no way in: that is a deployment blocker by
# design, not an oversight.
set -Eeuo pipefail

[ "$(id -u)" = "0" ] || {
  echo "run as root" >&2
  exit 1
}
[ $# -eq 1 ] || {
  echo "usage: provision-deploy-user.sh \"<ssh public key line>\"" >&2
  exit 2
}
PUBKEY="$1"
case "$PUBKEY" in
  "ssh-ed25519 "* | "ssh-rsa "* | "ecdsa-sha2-"*) ;;
  *)
    echo "that does not look like an SSH public key" >&2
    exit 2
    ;;
esac

USERNAME=shikoo-deploy

id "$USERNAME" >/dev/null 2>&1 || useradd --create-home --shell /bin/bash "$USERNAME"
usermod -aG docker "$USERNAME"
passwd -l "$USERNAME" >/dev/null # key-only, like the rest of the box

HOME_DIR="$(getent passwd "$USERNAME" | cut -d: -f6)"
install -d -m 700 -o "$USERNAME" -g "$USERNAME" "$HOME_DIR/.ssh"
printf '%s\n' "$PUBKEY" >"$HOME_DIR/.ssh/authorized_keys"
chmod 600 "$HOME_DIR/.ssh/authorized_keys"
chown "$USERNAME:$USERNAME" "$HOME_DIR/.ssh/authorized_keys"

# Where CD syncs the deploy script, and where deploy history lives.
install -d -m 755 -o "$USERNAME" -g "$USERNAME" /opt/shikoo
install -d -m 755 -o "$USERNAME" -g "$USERNAME" /var/lib/shikoo/staging /var/lib/shikoo/production

# Env files are root-owned and group-readable: the deploy user can read them,
# only root edits them. deploy.env holds the Coolify API token.
install -d -m 750 -o root -g "$USERNAME" /etc/shikoo /etc/shikoo/staging /etc/shikoo/production

cat <<EOF
created: $USERNAME (docker group, password locked, key installed)
created: /opt/shikoo  /var/lib/shikoo/{staging,production}  /etc/shikoo/{staging,production}

still to do by hand, per environment (0640, root:$USERNAME), values from the
Coolify application envs — see deploy/README.md «CI/CD»:
  /etc/shikoo/<env>/bot.env         DATABASE_URL, TELEGRAM_BOT_TOKEN, ENV_NAME=<env>, …
  /etc/shikoo/<env>/ingest.env      DATABASE_URL, ENV_NAME=<env>, MIRZABOT_*/AUTO_* decided out loud, …
  /etc/shikoo/<env>/dashboard.env   DATABASE_URL, ENV_NAME=<env>, TRUSTED_PROXY_IP_HEADER, …
  /etc/shikoo/<env>/deploy.env      COOLIFY_URL=http://localhost:8000,
                                    COOLIFY_TOKEN=<read,write,deploy abilities>,
                                    APP_INGEST / APP_DASHBOARD / APP_BOT=<uuids>,
                                    DB_CONTAINER=<that env's Postgres container>
EOF
