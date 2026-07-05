#!/usr/bin/env bash
# rotate-lab-logs.sh — size-capped rotation for append-forever lab logs that
# bypass journald (StandardOutput=append: files + claude_call's usage.jsonl).
# Rotates any listed file over MAX_MB to <file>.1 (previous .1 replaced).
# usage.jsonl keeps its tail in place so the dashboard's month-to-date spend
# widget stays accurate after rotation.
#
# Installed by: log-rotation units (weekly timer). Wren, 2026-07-03.
set -u

MAX_MB=5
KEEP_TAIL_LINES=20000   # usage.jsonl only — ~months of per-call rows

rotate_plain() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size_mb=$(( $(stat -c%s "$f") / 1048576 ))
  if [ "$size_mb" -ge "$MAX_MB" ]; then
    mv -f "$f" "$f.1"
    : > "$f"
    echo "rotated $f (${size_mb}MB -> .1)"
  fi
}

rotate_jsonl_keep_tail() {
  local f="$1"
  [ -f "$f" ] || return 0
  local size_mb=$(( $(stat -c%s "$f") / 1048576 ))
  if [ "$size_mb" -ge "$MAX_MB" ]; then
    cp -f "$f" "$f.1"
    tail -n "$KEEP_TAIL_LINES" "$f" > "$f.tmp" && mv -f "$f.tmp" "$f"
    echo "rotated $f (${size_mb}MB; kept ${KEEP_TAIL_LINES}-line tail, full copy in .1)"
  fi
}

rotate_jsonl_keep_tail "$HOME/.local/state/claude-spend/usage.jsonl"
rotate_plain "$HOME/azlab/services/memory-mcp-server/episodic_distill.log"
rotate_plain "$HOME/azlab/services/memory-mcp-server/dreaming_consolidate.log"
rotate_plain "$HOME/azlab/infrastructure/memory-consolidation/consolidate.log"
exit 0
