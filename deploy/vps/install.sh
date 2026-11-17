#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Odyssey Panel — one-command VPS installer (panel + Xray Reality)
#
#   sudo bash deploy/vps/install.sh
#
# What it does:
#   1. installs Docker + compose plugin if missing (apt/dnf)
#   2. builds and starts the panel container (SQLite on a volume)
#   3. waits for the panel, logs in with the admin password
#   4. stores THIS server's public IP as the VPS-Reality backend
#   5. downloads the xray server config from the panel
#   6. starts the xray container with that config (Reality on :443)
#
# After it finishes: open http://SERVER_IP:3000, log in, change the admin
# password (Settings → Panel), then create users — their default config is
# VLESS-Reality on this VPS.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

CD="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"   # deploy/vps
ROOT="$(cd "$CD/../.." && pwd)"                      # repo root
PANEL_PORT="${PANEL_PORT:-3000}"
PANEL_URL="http://127.0.0.1:${PANEL_PORT}"

log() { printf '\033[1;36m[odyssey]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[odyssey] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "run as root: sudo bash deploy/vps/install.sh"

# ── 1. docker ────────────────────────────────────────────────────────────────
if ! command -v docker >/dev/null 2>&1; then
  log "installing Docker ..."
  if command -v apt-get >/dev/null 2>&1; then
    apt-get update -y && apt-get install -y ca-certificates curl gnupg
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" > /etc/apt/sources.list.d/docker.list
    apt-get update -y && apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  elif command -v dnf >/dev/null 2>&1; then
    dnf -y install dnf-plugins-core && dnf config-manager --add-repo https://download.docker.com/linux/fedora/docker-ce.repo && dnf -y install docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  else
    die "install Docker manually first (https://docs.docker.com/engine/install/)"
  fi
  systemctl enable --now docker
fi
docker compose version >/dev/null 2>&1 || die "docker compose plugin missing — install docker-compose-plugin"

# ── 2. panel ────────────────────────────────────────────────────────────────
log "building + starting the panel (first build takes a few minutes) ..."
docker compose -f "$CD/docker-compose.yml" up -d --build

log "waiting for the panel ..."
for i in $(seq 1 60); do
  if curl -sf -o /dev/null "$PANEL_URL/api/cron" || curl -sf -o /dev/null "$PANEL_URL/"; then break; fi
  sleep 2
  [ "$i" = 60 ] && die "panel did not come up — check: docker compose -f $CD/docker-compose.yml logs panel"
done

# ── 3. admin login ──────────────────────────────────────────────────────────
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
if [ -z "$ADMIN_PASSWORD" ]; then
  read -r -p "Admin password (press Enter for the default 'admin123'): " ADMIN_PASSWORD || true
  ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin123}"
fi
COOKIES="$(mktemp)"
code=$(curl -s -o /tmp/odyssey-login.json -w '%{http_code}' -c "$COOKIES" -H 'content-type: application/json' -d "{\"password\":\"$ADMIN_PASSWORD\"}" "$PANEL_URL/api/auth/login" || true)
[ "$code" = "200" ] || die "login failed (HTTP $code) — $(cat /tmp/odyssey-login.json 2>/dev/null)"

# ── 4. register THIS server as the Reality backend ───────────────────────────
SERVER_IP="${SERVER_IP:-}"
[ -z "$SERVER_IP" ] && SERVER_IP=$(curl -s --max-time 10 https://api.ipify.org || true)
[ -z "$SERVER_IP" ] && die "could not detect the server public IP — set SERVER_IP=... and rerun"
log "registering VPS backend: $SERVER_IP:443"
curl -sf -b "$COOKIES" -H 'content-type: application/json' \
  -d "{\"vpsHost\":\"$SERVER_IP\",\"vpsPort\":\"443\",\"vpsSni\":\"www.samsung.com\"}" \
  "$PANEL_URL/api/admin/settings" >/dev/null || die "failed to save settings"

# ── 5. xray server config from the panel ────────────────────────────────────
mkdir -p "$CD/xray"
log "exporting xray config from the panel ..."
# create the deployment keypair by exporting once (a fresh install has no
# Reality accounts yet — the config still starts and gains inbounds as you
# create users; re-run step 5 after adding users)
curl -sf -b "$COOKIES" "$PANEL_URL/api/admin/vps/xray-config" -o "$CD/xray/config.json" \
  || log "no Reality accounts yet — config.json is a stub; re-run 'curl ... /api/admin/vps/xray-config' after creating users"

# ── 6. xray up ──────────────────────────────────────────────────────────────
docker compose -f "$CD/docker-compose.yml" up -d xray
rm -f "$COOKIES" /tmp/odyssey-login.json

cat <<EOF

  ──────────────────────────────────────────────────────────────
   Odyssey is up.

     Panel      : http://$SERVER_IP:${PANEL_PORT}   (log in, change the password!)
     Reality    : vless on $SERVER_IP:443  (SNI: www.samsung.com)
     Data       : docker volume panel-data  (/data/odyssey.db)
     Xray logs  : docker compose -f $CD/docker-compose.yml logs -f xray

   Next steps:
     1. open the panel → Settings → change the admin password
     2. create a user (mode "VPS · Reality" or fast mode) — the default
        config is VLESS-Reality on this VPS
     3. after adding users, refresh the xray config:
        curl -b <admin-cookie> $PANEL_URL/api/admin/vps/xray-config > $CD/xray/config.json
        docker compose -f $CD/docker-compose.yml restart xray
     4. subscribe on the phone: the /s/ page QR works with v2rayNG / Hiddify
  ──────────────────────────────────────────────────────────────
EOF
