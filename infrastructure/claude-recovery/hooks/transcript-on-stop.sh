#!/usr/bin/env bash
# Stop hook — queues session transcript to task_queue (target=cowork) for Iris to process.
# Reads transcript_path from Stop hook JSON input (stdin).

# Load credentials from env file (never hardcode secrets in tracked files)
ENV_FILE="/home/almty1/azlab/services/memory-mcp-server/.env"
if [[ -f "$ENV_FILE" ]]; then
  set -o allexport
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +o allexport
fi

SUPABASE_URL="${SUPABASE_URL:-}"
SERVICE_KEY="${SUPABASE_SERVICE_KEY:-}"

if [[ -z "$SUPABASE_URL" || -z "$SERVICE_KEY" ]]; then
  exit 0
fi

# Read Stop hook JSON from stdin
HOOK_JSON=$(cat)

TRANSCRIPT_PATH=$(echo "$HOOK_JSON" | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('transcript_path',''))" 2>/dev/null || true)

if [[ -z "$TRANSCRIPT_PATH" || ! -f "$TRANSCRIPT_PATH" ]]; then
  exit 0
fi

SESSION_DATE=$(date +%Y-%m-%d)

# Get last 4000 chars of transcript
TRANSCRIPT_TAIL=$(python3 -c "
content = open('$TRANSCRIPT_PATH', 'r', errors='replace').read()
print(content[-4000:])
" 2>/dev/null || true)

if [[ -z "$TRANSCRIPT_TAIL" ]]; then
  exit 0
fi

# Build payload safely via python
PAYLOAD=$(python3 - <<PYEOF
import json, sys

transcript = open('$TRANSCRIPT_PATH', 'r', errors='replace').read()[-4000:]
ctx = {
    'transcript': transcript,
    'agent': 'wren',
    'session_date': '$SESSION_DATE'
}
task = {
    'title': 'Process session transcript',
    'target': 'cowork',
    'source': 'claude-code',
    'priority': 2,
    'context': ctx,
    'tags': ['transcript']
}
print(json.dumps(task))
PYEOF
)

if [[ -z "$PAYLOAD" ]]; then
  exit 0
fi

curl -sf -X POST "${SUPABASE_URL}/rest/v1/task_queue" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  &>/dev/null &

exit 0
