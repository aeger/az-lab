#!/usr/bin/env bash
# Install claude-r2-backup systemd timer (daily at 02:00 UTC)
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UNIT_DIR="$HOME/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cp "$SCRIPT_DIR/claude-r2-backup.service" "$UNIT_DIR/"
cp "$SCRIPT_DIR/claude-r2-backup.timer" "$UNIT_DIR/"
systemctl --user daemon-reload
systemctl --user enable --now claude-r2-backup.timer
echo "Installed: claude-r2-backup.timer (next run: $(systemctl --user show claude-r2-backup.timer -p NextElapseUSecRealtime --value))"
