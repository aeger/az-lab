#!/usr/bin/env bash
# Install the Claude task queue poller as a user-level systemd service.
# No sudo required — linger must be enabled for the user.
# Usage: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_DIR="$HOME/claude-queue"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "Installing Claude task queue poller for $USER"

# Install poller script
mkdir -p "$QUEUE_DIR"
install -m 755 "$SCRIPT_DIR/poll_queue.py" "$QUEUE_DIR/poll_queue.py"
echo "Installed poll_queue.py -> $QUEUE_DIR/poll_queue.py"

# Install systemd user units
mkdir -p "$SYSTEMD_DIR"
install -m 644 "$SCRIPT_DIR/claude-queue-poll.service" "$SYSTEMD_DIR/"
install -m 644 "$SCRIPT_DIR/claude-queue-poll.timer"   "$SYSTEMD_DIR/"
echo "Installed systemd user units"

# Reload and enable
systemctl --user daemon-reload
systemctl --user enable --now claude-queue-poll.timer
echo "Timer enabled and started"

echo ""
echo "Done! Verify with:"
echo "  systemctl --user status claude-queue-poll.timer"
echo "  journalctl --user -u claude-queue-poll.service -f"
echo ""
echo "Trigger a manual poll:"
echo "  systemctl --user start claude-queue-poll.service"
