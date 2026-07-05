#!/bin/bash
# Install the systemd-resolved watchdog. Run with sudo:  sudo ./install.sh
set -euo pipefail
cd "$(dirname "$0")"

install -m 0755 resolved-watchdog.sh /usr/local/sbin/resolved-watchdog.sh
install -m 0644 resolved-watchdog.service /etc/systemd/system/resolved-watchdog.service
install -m 0644 resolved-watchdog.timer   /etc/systemd/system/resolved-watchdog.timer

systemctl daemon-reload
systemctl enable --now resolved-watchdog.timer

echo "Installed. Status:"
systemctl status resolved-watchdog.timer --no-pager || true
echo
echo "Run the probe once now to confirm it works:"
systemctl start resolved-watchdog.service
journalctl -t resolved-watchdog -n 5 --no-pager || true
