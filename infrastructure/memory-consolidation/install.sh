#!/usr/bin/env bash
# Install episodic-to-semantic memory consolidation systemd timer
# Run as: bash install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
UNIT_DIR="${HOME}/.config/systemd/user"

echo "=== Memory Consolidation Installer ==="
echo "Script dir: ${SCRIPT_DIR}"
echo "Unit dir:   ${UNIT_DIR}"

# 1. Make sure the script is executable
chmod +x "${SCRIPT_DIR}/consolidate_episodic_memories.py"
echo "✓ Script is executable"

# 2. Ensure systemd user unit directory exists
mkdir -p "${UNIT_DIR}"

# 3. Symlink units into systemd user directory
ln -sf "${SCRIPT_DIR}/memory-consolidation.service" "${UNIT_DIR}/memory-consolidation.service"
ln -sf "${SCRIPT_DIR}/memory-consolidation.timer"   "${UNIT_DIR}/memory-consolidation.timer"
echo "✓ Units symlinked into ${UNIT_DIR}"

# 4. Reload daemon and enable timer
systemctl --user daemon-reload
systemctl --user enable memory-consolidation.timer
systemctl --user start  memory-consolidation.timer
echo "✓ Timer enabled and started"

# 5. Show status
echo ""
echo "=== Timer status ==="
systemctl --user status memory-consolidation.timer --no-pager || true
echo ""
echo "=== Next trigger ==="
systemctl --user list-timers memory-consolidation.timer --no-pager || true
echo ""
echo "=== Manual test (dry run) ==="
echo "  python3 ${SCRIPT_DIR}/consolidate_episodic_memories.py --dry-run"
echo ""
echo "=== Apply the Supabase migration before first run ==="
echo "  https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/sql/new"
echo "  Paste: ${SCRIPT_DIR}/../../../services/memory-mcp-server/migrations/006_episodic_semantic_types.sql"
