#!/bin/bash
# Run nightly PageRank computation via Supabase RPC
set -e

# Load env from memory-mcp-server config
ENV_FILE="/home/almty1/azlab/services/memory-mcp-server/.env"
if [ -f "$ENV_FILE" ]; then
  # shellcheck disable=SC1090
  set -o allexport
  source "$ENV_FILE"
  set +o allexport
fi

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_SECRET_KEY="${SUPABASE_SECRET_KEY:-}"

if [ -z "$SUPABASE_URL" ] || [ -z "$SUPABASE_SECRET_KEY" ]; then
  echo "ERROR: Missing SUPABASE_URL or SUPABASE_SECRET_KEY" >&2
  exit 1
fi

echo "[$(date -u)] Running PageRank computation..."
RESULT=$(curl -s -X POST \
  "${SUPABASE_URL}/rest/v1/rpc/compute_pagerank" \
  -H "apikey: ${SUPABASE_SECRET_KEY}" \
  -H "Authorization: Bearer ${SUPABASE_SECRET_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"damping": 0.85, "iterations": 20}')
echo "[$(date -u)] PageRank complete. Updated rows: $RESULT"

# Check for error in result
if echo "$RESULT" | grep -q '"code"'; then
  echo "ERROR: PageRank RPC returned an error:" >&2
  echo "$RESULT" >&2
  exit 1
fi
