#!/usr/bin/env bash
# Stop hook — queues session transcript to task_queue (target=cowork) for Iris to process.
# Reads transcript_path from Stop hook JSON input (stdin).

SUPABASE_URL="https://ogqjjlbupqnvlcyrfnxi.supabase.co"
SERVICE_KEY="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im9ncWpqbGJ1cHFudmxjeXJmbnhpIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3NDA0NTU3NiwiZXhwIjoyMDg5NjIxNTc2fQ.nxAesbiMgcogKp4rOS0VodJLI127mmMbSFMHcvRKNa0"

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
