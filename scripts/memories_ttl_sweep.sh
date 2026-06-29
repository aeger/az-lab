#!/usr/bin/env bash
# memories_ttl_sweep.sh — DELETE memories rows past their expires_at.
# Runs hourly via systemd timer. Backstop for bench/research jobs that set
# a TTL on inserted rows; cleans up if their explicit cleanup pass was missed.

set -euo pipefail

ENV_FILE="${SUPABASE_ENV_FILE:-$HOME/azlab/services/memory-mcp-server/.env}"

URL=$(awk -F= '/^SUPABASE_URL=/{sub(/^SUPABASE_URL=/,""); print}' "$ENV_FILE")
KEY=$(awk -F= '/^SUPABASE_SECRET_KEY=/{sub(/^SUPABASE_SECRET_KEY=/,""); print}' "$ENV_FILE")
if [[ -z "$URL" || -z "$KEY" ]]; then
  echo "ERROR: SUPABASE_URL or SUPABASE_SECRET_KEY missing from $ENV_FILE" >&2
  exit 1
fi

NOW=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Count first so we have a number to log; only DELETE when there's something.
COUNT=$(curl -sS -o /dev/null -w "%{header_json}" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Prefer: count=exact" -H "Range: 0-0" \
  "$URL/rest/v1/memories?expires_at=lt.$NOW&select=id" \
  | python3 -c '
import json, sys
h = json.loads(sys.stdin.read())
cr = (h.get("content-range") or ["0/0"])[0]
print(cr.split("/")[-1] or "0")
')

if [[ "$COUNT" == "0" || -z "$COUNT" ]]; then
  echo "[$(date -u +%FT%TZ)] sweep: 0 expired rows"
  exit 0
fi

curl -sS -X DELETE \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  "$URL/rest/v1/memories?expires_at=lt.$NOW" >/dev/null

echo "[$(date -u +%FT%TZ)] sweep: deleted $COUNT expired memories rows"
