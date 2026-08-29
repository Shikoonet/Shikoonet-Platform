#!/usr/bin/env bash
set -Eeuo pipefail

COMMAND="${1:-check}"
AUTO_REBOOT=0

if [[ "${1:-}" == "--auto-reboot" ]]; then
    COMMAND="fix"
    AUTO_REBOOT=1
elif [[ "${2:-}" == "--auto-reboot" ]]; then
    AUTO_REBOOT=1
fi

PROJECT_DIR="${PASARGUARDBOT_CONFIG_DIR:-/opt/pasarguardbot}"

TARGET="${PASARGUARDBOT_NETPLAN_TARGET:-/etc/netplan/99-custom.yaml}"

BACKUP_DIR="${PASARGUARDBOT_NETPLAN_BACKUP_DIR:-$PROJECT_DIR/backups/netplan}"

STATE_DIR="${PASARGUARDBOT_STATE_DIR:-$PROJECT_DIR/data/state}"

MARKER="$STATE_DIR/netplan-wildcard-disabled"

IMAGE="${PASARGUARDBOT_NETCHECK_IMAGE:-alpine:latest}"

TEST_PREFIX="${PASARGUARDBOT_NETCHECK_PREFIX:-pasarguardbot-netcheck}"
TEST_ID="${TEST_PREFIX}-$$-$(date +%s)"

TEST_NET="$TEST_ID"
TEST_SERVER="${TEST_ID}-server"
TEST_CLIENT="${TEST_ID}-client"

log()  { printf '%s\n' "$*"; }
warn() { printf '[!] %s\n' "$*"; }
ok()   { printf '[✓] %s\n' "$*"; }
err()  { printf '[✗] %s\n' "$*" >&2; }

cleanup_test() {
    docker rm -f "$TEST_CLIENT" "$TEST_SERVER" >/dev/null 2>&1 || true
    docker network rm "$TEST_NET" >/dev/null 2>&1 || true
}
trap cleanup_test EXIT

require_root() {
    if [[ "$(id -u)" -ne 0 ]]; then
        err "Run this script as root."
        exit 20
    fi
}

require_supported_host() {
    if [[ ! -r /etc/os-release ]]; then
        err "Cannot detect the operating system."
        exit 20
    fi

    # shellcheck disable=SC1091
    . /etc/os-release

    if [[ "${ID:-}" != "ubuntu" ]]; then
        err "Automatic repair is supported only on Ubuntu."
        exit 20
    fi

    for cmd in docker netplan networkctl ip systemctl; do
        if ! command -v "$cmd" >/dev/null 2>&1; then
            err "Required command is missing: $cmd"
            exit 20
        fi
    done

    if ! systemctl is-active --quiet systemd-networkd; then
        err "systemd-networkd is not active; this repair is not applicable."
        exit 20
    fi

    if ! systemctl is-active --quiet docker; then
        systemctl start docker
    fi
}

ensure_test_image() {
    if docker image inspect "$IMAGE" >/dev/null 2>&1; then
        return 0
    fi

    log "[*] Pulling $IMAGE for an isolated Docker network test..."
    if ! docker pull "$IMAGE" >/dev/null; then
        err "Could not pull $IMAGE; Docker bridge health could not be tested."
        exit 30
    fi
}

bridge_test() {
    cleanup_test

    docker network create "$TEST_NET" >/dev/null || return 1

    docker run -d \
        --name "$TEST_SERVER" \
        --network "$TEST_NET" \
        --network-alias pg-server \
        "$IMAGE" \
        sh -c 'mkdir -p /www; printf ok > /www/index.html; exec httpd -f -p 39000 -h /www' \
        >/dev/null || return 1

    docker run -d \
        --name "$TEST_CLIENT" \
        --network "$TEST_NET" \
        "$IMAGE" sleep 30 \
        >/dev/null || return 1

    sleep 1

    docker exec "$TEST_CLIENT" \
        sh -c 'test "$(wget -q -T 3 -O - http://pg-server:39000/)" = ok' \
        >/dev/null 2>&1
}

show_failed_bridge_state() {
    local net_id bridge
    net_id="$(docker network inspect -f '{{.Id}}' "$TEST_NET" 2>/dev/null || true)"
    [[ -n "$net_id" ]] || return 0

    bridge="br-${net_id:0:12}"
    warn "Docker bridge test failed."
    ip -br address show "$bridge" 2>/dev/null || true
    bridge link show master "$bridge" 2>/dev/null || true
}

has_exact_wildcard() {
    grep -Eq \
        "^[[:space:]]*name:[[:space:]]*['\"]?\*['\"]?[[:space:]]*(#.*)?$" \
        "$TARGET"
}

contains_sensitive_network_settings() {
    grep -Eq \
        '^[[:space:]]*(addresses|routes|gateway4|gateway6|nameservers|bridges|bonds|vlans|wifis|tunnels|set-name):' \
        "$TARGET"
}

default_interface_is_configured_elsewhere() {
    local default_if file
    default_if="$(ip -4 route show default | awk 'NR==1 {print $5}')"

    [[ -n "$default_if" ]] || return 1

    case "$default_if" in
        docker0|br-*|veth*) return 1 ;;
    esac

    while IFS= read -r -d '' file; do
        [[ "$file" == "$TARGET" ]] && continue

        if grep -Eq \
            "^[[:space:]]*${default_if}:[[:space:]]*(#.*)?$|^[[:space:]]*set-name:[[:space:]]*[\"']?${default_if}[\"']?[[:space:]]*(#.*)?$" \
            "$file"; then
            return 0
        fi
    done < <(find /etc/netplan -maxdepth 1 -type f -name '*.yaml' -print0)

    return 1
}

known_generated_wildcard_is_active() {
    local generated="/run/systemd/network/10-netplan-all.network"
    [[ -f "$generated" ]] || return 1
    grep -Eq '^Name=\*$' "$generated"
}

backup_and_disable_target() {
    local timestamp backup_file archive
    timestamp="$(date +%Y%m%d-%H%M%S)"

    install -d -m 0700 "$BACKUP_DIR" "$STATE_DIR"
    backup_file="$BACKUP_DIR/99-custom.yaml.$timestamp.disabled"
    archive="$BACKUP_DIR/netplan.$timestamp.tar.gz"

    tar -C /etc -czf "$archive" netplan
    mv "$TARGET" "$backup_file"

    printf '%s\n' "$backup_file" > "$MARKER"

    log "[*] Netplan backup: $archive"
    log "[*] Disabled file: $backup_file"
}

restore_after_generate_failure() {
    local backup_file
    backup_file="$(cat "$MARKER" 2>/dev/null || true)"

    if [[ -n "$backup_file" && -f "$backup_file" ]]; then
        mv "$backup_file" "$TARGET"
        netplan generate >/dev/null 2>&1 || true
    fi

    rm -f "$MARKER"
}

apply_live_repair() {
    netplan generate
    networkctl reload

    # Recreate Docker bridges and veth interfaces after networkd reloads its files.
    systemctl restart docker

    for _ in {1..20}; do
        if docker info >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
    done

    return 1
}

rollback_fix() {
    local backup_file
    backup_file="$(cat "$MARKER" 2>/dev/null || true)"

    if [[ -z "$backup_file" || ! -f "$backup_file" ]]; then
        err "No repair marker or disabled Netplan file was found."
        exit 50
    fi

    if [[ -e "$TARGET" ]]; then
        err "$TARGET already exists; refusing to overwrite it."
        exit 50
    fi

    mv "$backup_file" "$TARGET"
    netplan generate
    networkctl reload
    rm -f "$MARKER"

    ok "Original Netplan file restored."
    warn "Reboot the server to complete rollback."
    exit 10
}

require_root

if [[ "$COMMAND" == "rollback" ]]; then
    require_supported_host
    rollback_fix
fi

require_supported_host
ensure_test_image

log "[*] Testing Docker bridge networking..."
if bridge_test; then
    ok "Docker bridge networking is working."
    exit 0
fi
show_failed_bridge_state

if [[ "$COMMAND" == "check" ]]; then
    exit 1
fi

if [[ "$COMMAND" != "fix" ]]; then
    err "Usage: $0 [check|fix|rollback] [--auto-reboot]"
    exit 20
fi

if [[ ! -f "$TARGET" ]]; then
    err "Known CGI Netplan file was not found: $TARGET"
    exit 21
fi

if ! has_exact_wildcard; then
    err "$TARGET does not contain an exact match.name wildcard."
    exit 21
fi

if contains_sensitive_network_settings; then
    err "$TARGET contains additional sensitive network settings."
    err "Automatic repair was refused; inspect the file manually."
    exit 40
fi

if ! default_interface_is_configured_elsewhere; then
    err "The default interface is not explicitly configured in another Netplan YAML file."
    err "Removing $TARGET could disconnect the server, so no changes were made."
    exit 40
fi

if ! known_generated_wildcard_is_active; then
    err "The expected generated wildcard file is not active."
    err "Automatic repair was refused because the failure may have another cause."
    exit 40
fi

warn "Broken Netplan wildcard detected in $TARGET"
backup_and_disable_target

if ! netplan generate; then
    err "Netplan validation failed; restoring the original file."
    restore_after_generate_failure
    exit 41
fi

log "[*] Attempting repair without reboot..."
if ! apply_live_repair; then
    warn "Docker did not become ready after restart."
fi
ensure_test_image

if bridge_test; then
    ok "Docker bridge networking was repaired without reboot."
    log "[*] Rollback marker: $MARKER"
    exit 0
fi

show_failed_bridge_state
warn "The configuration was repaired, but a reboot is still required."

if [[ "$AUTO_REBOOT" -eq 1 ]]; then
    warn "Rebooting now. Run the installer again after the server returns."
    sync
    systemctl reboot
fi

exit 10