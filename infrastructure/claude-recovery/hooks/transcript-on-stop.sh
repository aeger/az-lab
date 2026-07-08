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
SERVICE_KEY="${SUPABASE_SECRET_KEY:-}"

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
    'description': 'Session transcript handoff from Wren ($SESSION_DATE) — review the transcript in context and extract any memories, decisions, or follow-up items. (task_queue.description is NOT NULL — this field is required.)',
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

# Prefer the validating task-queue Worker (enforces title/description + schema,
# retries -> DLQ). Fall back to a direct Supabase insert if the Worker is
# unreachable so a transcript is never lost during migration. Failures are
# logged to stderr (journald), NOT silently swallowed.
WORKER_URL="https://az-task-queue-worker.almty1.workers.dev/enqueue"
INGEST_SECRET=$(cat "$HOME/.cloudflare/ingest-secret" 2>/dev/null)

HTTP=$(curl -s -m 6 -o /dev/null -w '%{http_code}' -X POST "$WORKER_URL" \
  -H "x-ingest-secret: ${INGEST_SECRET}" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

if [[ "$HTTP" != "202" ]]; then
  echo "transcript-on-stop: worker enqueue failed (HTTP ${HTTP:-000}); falling back to direct insert" >&2
  curl -s -m 8 -X POST "${SUPABASE_URL}/rest/v1/task_queue" \
    -H "apikey: ${SERVICE_KEY}" \
    -H "Authorization: Bearer ${SERVICE_KEY}" \
    -H "Content-Type: application/json" \
    -d "$PAYLOAD" >/dev/null 2>&1 \
    || echo "transcript-on-stop: fallback direct insert ALSO failed" >&2
fi

exit 0
