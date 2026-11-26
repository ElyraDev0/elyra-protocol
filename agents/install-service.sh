#!/bin/bash
# Runs Sentinel and Steward as services: they start with the server and restart by themselves if they stop.
#   sudo bash install-service.sh                     Sepolia  → elyra-sentinel, elyra-steward            (uses .env)
#   sudo NETWORK=orbinum bash install-service.sh     Orbinum  → elyra-sentinel-orbinum, elyra-steward-orbinum (uses .env.orbinum)
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"; USER_NAME="${SUDO_USER:-$USER}"; NODE="$(command -v node)"
if [ "$NETWORK" = "orbinum" ]; then SUFFIX="-orbinum"; ENVFILE=".env.orbinum"; else SUFFIX=""; ENVFILE=".env"; fi
for name in sentinel steward; do
  [ -f "$DIR/$name/$ENVFILE" ] || { echo "Missing $name/$ENVFILE: run 'NETWORK=${NETWORK:-sepolia} npm run setup' first."; exit 1; }
  cat > /etc/systemd/system/elyra-$name$SUFFIX.service <<UNIT
[Unit]
Description=Elyra reference agent: $name${SUFFIX:+ (Orbinum)}
After=network-online.target
Wants=network-online.target

[Service]
User=$USER_NAME
WorkingDirectory=$DIR/$name
EnvironmentFile=$DIR/$name/$ENVFILE
ExecStart=$NODE dist/agents/$name/src/main.js
Restart=always
RestartSec=20

[Install]
WantedBy=multi-user.target
UNIT
done
systemctl daemon-reload
systemctl enable elyra-sentinel$SUFFIX elyra-steward$SUFFIX
systemctl restart elyra-sentinel$SUFFIX elyra-steward$SUFFIX
echo "Started. Logs:  journalctl -u elyra-sentinel$SUFFIX -f   ·   journalctl -u elyra-steward$SUFFIX -f"
