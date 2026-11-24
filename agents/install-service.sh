#!/bin/bash
# Runs Sentinel and Steward as services: they start with the server and restart by themselves if they stop.
#   sudo bash install-service.sh
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"; USER_NAME="${SUDO_USER:-$USER}"; NODE="$(command -v node)"
for name in sentinel steward; do
  cat > /etc/systemd/system/elyra-$name.service <<UNIT
[Unit]
Description=Elyra reference agent: $name
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR/$name
EnvironmentFile=$DIR/$name/.env
ExecStart=$NODE dist/agents/$name/src/main.js
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable --now elyra-sentinel elyra-steward
echo "Started. Logs:  journalctl -u elyra-sentinel -f   ·   journalctl -u elyra-steward -f"
