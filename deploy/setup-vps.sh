#!/usr/bin/env bash
# One-shot server setup for telinha on a fresh Ubuntu 24.04 VPS.
# Usage (as root, after the app has been rsynced to /opt/telinha):
#   bash /opt/telinha/deploy/setup-vps.sh <domain>
# Installs Node 22, Caddy (HTTPS), coturn (TURN relay), a systemd service,
# and a UFW firewall, then patches /opt/telinha/.env with the public URL
# and generated TURN credentials.
set -euo pipefail

DOMAIN="${1:?usage: setup-vps.sh <domain>}"
APP_DIR=/opt/telinha
ENV_FILE="$APP_DIR/.env"

[ -f "$ENV_FILE" ] || { echo "Missing $ENV_FILE — rsync the app (including .env) first."; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update

# --- Node 22 ---
if ! command -v node >/dev/null || [ "$(node -e 'console.log(process.versions.node.split(".")[0])')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

# --- Caddy (auto-HTTPS reverse proxy) ---
if ! command -v caddy >/dev/null; then
  apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list
  apt-get update && apt-get install -y caddy
fi

cat > /etc/caddy/Caddyfile <<EOF
$DOMAIN {
    handle_path /livekit* {
        reverse_proxy localhost:7880
    }
    reverse_proxy localhost:3000
}
EOF
systemctl enable --now caddy
systemctl reload caddy

# --- coturn (TURN relay for viewers behind strict NATs) ---
apt-get install -y coturn ufw rsync

TURN_USER=telinha
TURN_PASS=$(head -c 24 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 24)
EXTERNAL_IP=$(curl -fsS https://api.ipify.org)
LOCAL_IP=$(hostname -I | awk '{print $1}')

{
  echo "listening-port=3478"
  echo "fingerprint"
  echo "lt-cred-mech"
  echo "user=$TURN_USER:$TURN_PASS"
  echo "realm=$DOMAIN"
  echo "min-port=49152"
  echo "max-port=65535"
  echo "no-cli"
  echo "no-multicast-peers"
  # Needed on providers that NAT the public IP (e.g. AWS); harmless otherwise.
  [ "$EXTERNAL_IP" != "$LOCAL_IP" ] && echo "external-ip=$EXTERNAL_IP/$LOCAL_IP"
} > /etc/turnserver.conf

sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn 2>/dev/null || true
systemctl enable --now coturn
systemctl restart coturn

# --- LiveKit SFU (media server) ---
if ! command -v livekit-server >/dev/null; then
  curl -sL https://github.com/livekit/livekit/releases/download/v1.13.5/livekit_1.13.5_linux_amd64.tar.gz | tar xz -C /usr/local/bin livekit-server
fi
if [ ! -f /etc/livekit.yaml ]; then
  LK_KEY="LK$(head -c 16 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 12)"
  LK_SECRET=$(head -c 48 /dev/urandom | base64 | tr -dc 'a-zA-Z0-9' | head -c 40)
  {
    echo "port: 7880"
    echo "rtc:"
    echo "  port_range_start: 50000"
    echo "  port_range_end: 60000"
    echo "  tcp_port: 7881"
    echo "  use_external_ip: true"
    echo "keys:"
    echo "  $LK_KEY: $LK_SECRET"
  } > /etc/livekit.yaml
  chmod 600 /etc/livekit.yaml
  sed -i '/^LIVEKIT_/d' "$ENV_FILE"
  printf 'LIVEKIT_URL=wss://%s/livekit\nLIVEKIT_API_KEY=%s\nLIVEKIT_API_SECRET=%s\n' "$DOMAIN" "$LK_KEY" "$LK_SECRET" >> "$ENV_FILE"
fi
cat > /etc/systemd/system/livekit.service <<'EOF'
[Unit]
Description=LiveKit SFU
After=network-online.target

[Service]
ExecStart=/usr/local/bin/livekit-server --config /etc/livekit.yaml
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now livekit

# --- app user + env ---
id -u telinha &>/dev/null || useradd --system --home "$APP_DIR" --shell /usr/sbin/nologin telinha

sed -i \
  -e "s|^BASE_URL=.*|BASE_URL=https://$DOMAIN|" \
  -e "s|^#\? *TURN_URL=.*|TURN_URL=turn:$DOMAIN:3478|" \
  -e "s|^#\? *TURN_USERNAME=.*|TURN_USERNAME=$TURN_USER|" \
  -e "s|^#\? *TURN_PASSWORD=.*|TURN_PASSWORD=$TURN_PASS|" \
  "$ENV_FILE"
grep -q '^TURN_URL=' "$ENV_FILE" || printf 'TURN_URL=turn:%s:3478\nTURN_USERNAME=%s\nTURN_PASSWORD=%s\n' "$DOMAIN" "$TURN_USER" "$TURN_PASS" >> "$ENV_FILE"

cd "$APP_DIR" && npm ci --omit=dev
chown -R telinha:telinha "$APP_DIR"
chmod 600 "$ENV_FILE"

# --- systemd service ---
cat > /etc/systemd/system/telinha.service <<'EOF'
[Unit]
Description=telinha screenshare server + Discord bot
After=network-online.target
Wants=network-online.target

[Service]
User=telinha
WorkingDirectory=/opt/telinha
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now telinha
systemctl restart telinha

# --- firewall ---
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 3478/tcp
ufw allow 3478/udp
ufw allow 7881/tcp
ufw allow 49152:65535/udp
ufw allow 50000:60000/udp
ufw --force enable

echo
echo "== telinha deployed =="
echo "URL:        https://$DOMAIN"
echo "TURN:       turn:$DOMAIN:3478 (user: $TURN_USER)"
echo "App logs:   journalctl -u telinha -f"
systemctl --no-pager --lines=5 status telinha || true
