#!/usr/bin/env bash
# Install the Claude task queue poller as a user-level systemd service.
# No sudo required — linger must be enabled for the user.
# Usage: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
QUEUE_DIR="$HOME/claude-queue"
SYSTEMD_DIR="$HOME/.config/systemd/user"

echo "Installing Claude task queue poller for $USER"

# Link (do NOT copy) the poller script.
#
# This used to be `install -m 755`, i.e. a copy. On 2026-08-16 that copy was
# found to be two days stale: the running poller predated migration 118 and was
# still telling Iris to use the retired `review_needed` status, which is how
# task f07163d0 got stuck in a status 118 had already removed. A copy means
# every commit to the repo file silently does nothing until someone remembers
# to re-run this script. A symlink makes the repo the only content, so the
# split-brain cannot re-form.
#
# Safe because poll_queue.py imports stdlib only and never reads __file__ —
# nothing depends on its on-disk location. Re-check that before adding a
# sibling-module import.
mkdir -p "$QUEUE_DIR"
ln -sfn "$SCRIPT_DIR/poll_queue.py" "$QUEUE_DIR/poll_queue.py"
echo "Linked poll_queue.py -> $SCRIPT_DIR/poll_queue.py"

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
