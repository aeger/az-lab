#!/bin/bash
# Install the DNS watchdog. Run with sudo:  sudo ./install.sh
#
# Stage 3 (AdGuard remediation) needs AdGuard Home control-API credentials in
# /etc/resolved-watchdog.env. This script seeds that file from the memory-mcp
# .env if it exists and the target isn't already present. The watchdog degrades
# gracefully without it — stages 1 and 2 still run, stage 3 logs and alerts.
set -euo pipefail
cd "$(dirname "$0")"

install -m 0755 resolved-watchdog.sh /usr/local/sbin/resolved-watchdog.sh
install -m 0644 resolved-watchdog.service /etc/systemd/system/resolved-watchdog.service
install -m 0644 resolved-watchdog.timer   /etc/systemd/system/resolved-watchdog.timer

SRC_ENV=/home/almty1/azlab/services/memory-mcp-server/.env
if [ ! -f /etc/resolved-watchdog.env ] && [ -r "$SRC_ENV" ]; then
  umask 077
  {
    echo "# AdGuard Home control API credentials for resolved-watchdog stage 3."
    grep -E '^ADGUARD_(USERNAME|PASSWORD)=' "$SRC_ENV" || true
  } > /etc/resolved-watchdog.env
  chmod 0600 /etc/resolved-watchdog.env
  echo "Seeded /etc/resolved-watchdog.env from $SRC_ENV"
elif [ -f /etc/resolved-watchdog.env ]; then
  echo "/etc/resolved-watchdog.env already present — left untouched"
else
  echo "WARNING: no AdGuard credentials installed — stage 3 will alert instead of remediate" >&2
fi

systemctl daemon-reload
systemctl enable --now resolved-watchdog.timer

echo "Installed. Status:"
systemctl status resolved-watchdog.timer --no-pager || true
echo
echo "Run the probe once now to confirm it works:"
systemctl start resolved-watchdog.service
journalctl -t resolved-watchdog -n 5 --no-pager || true
