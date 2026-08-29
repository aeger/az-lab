#!/usr/bin/env bash
# Atlas SessionStart queue check.
# Queries task_queue for tasks targeted at Atlas (or any/jeff) that are open.
# Prints a compact markdown briefing to stdout, or nothing if queue is empty.
set -euo pipefail

KEY=$(awk -F= '/^SUPABASE_SECRET_KEY=/ {print $2; exit}' ~/azlab/services/memory-mcp-server/.env 2>/dev/null | tr -d '"')
if [ -z "${KEY:-}" ]; then
  echo "[atlas-queue-check] no SUPABASE_SECRET_KEY available" >&2
  exit 0
fi

URL='https://ogqjjlbupqnvlcyrfnxi.supabase.co/rest/v1/task_queue'
URL+='?target=in.(atlas,any,jeff)'
URL+='&status=in.(ready,pending)'
URL+='&archived_at=is.null'
URL+='&order=priority.asc.nullslast,created_at.asc'
URL+='&select=id,title,status,source,priority,created_at,description,tags'
URL+='&limit=20'

resp=$(curl -sS --max-time 5 -H "apikey: $KEY" -H "Authorization: Bearer $KEY" "$URL" 2>/dev/null || true)
[ -z "$resp" ] && exit 0
count=$(echo "$resp" | jq 'length' 2>/dev/null || echo 0)
[ "$count" = "0" ] && exit 0

echo "## Atlas inbox (auto-checked from task_queue at session start)"
echo
echo "$count open task(s) targeting Atlas/any/jeff:"
echo
echo "$resp" | jq -r '.[] |
  "- **[" + .status + " / p" + (.priority|tostring) + "]** " + .title +
  "\n  id: " + .id + " | from: " + (.source // "?") +
  (if .description then "\n  " + (.description | gsub("\n"; " ") | .[0:200]) else "" end)
'
echo
echo "_To claim a task: SELECT claim_task('{id}', 'atlas') — see claim_task() function._"
