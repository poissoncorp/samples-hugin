#!/bin/bash
set -e
set -x

log() {
    echo "$(date -Is) - $1"
}

log "==== Hugin Cleanup started ===="

# Stop only app-specific services (keep AP services running)
for svc in hugin ravendb; do
    if systemctl list-unit-files | grep -q "^${svc}\.service"; then
        if systemctl is-active --quiet "$svc"; then
            log "Stopping service: $svc"
            sudo systemctl stop "$svc" || true
        else
            log "Service not active: $svc (skip stop)"
        fi
    else
        log "Service unit not found: $svc (skip)"
    fi
done

# Disable custom service
if systemctl list-unit-files | grep -q '^hugin\.service'; then
    log "Disabling hugin.service"
    sudo systemctl disable hugin || true
fi

if [ -f /etc/systemd/system/hugin.service ]; then
    log "Removing unit file: /etc/systemd/system/hugin.service"
    sudo rm -f /etc/systemd/system/hugin.service || true
fi

# Remove deployed app files
if [ -d /usr/lib/hugin ]; then
    log "Removing app directory: /usr/lib/hugin"
    sudo rm -rf /usr/lib/hugin || true
else
    log "/usr/lib/hugin not found (skip)"
fi

# Remove logs to avoid confusion (does not affect AP settings)
for f in \
    /var/log/nginx/default.access.log \
    /var/log/nginx/default.error.log \
    /var/log/nginx/probe.access.log \
    /var/log/dnsmasq.log \
    /var/log/hugin-captive-smoke.log \
    /var/log/hugin-validation.log; do
    if [ -f "$f" ]; then
        log "Removing log: $f"
        sudo rm -f "$f" || true
    else
        log "Log not found: $f (skip)"
    fi
done

# Do not touch wpa_supplicant or dnsmasq configuration/state to keep AP running

# Reload daemons and nginx
log "Reloading systemd daemon"
sudo systemctl daemon-reload || true

if nginx -t; then
    log "Reloading nginx"
    sudo systemctl reload nginx || true
else
    log "nginx config test failed; not reloading"
fi

log "==== Cleanup completed ===="
