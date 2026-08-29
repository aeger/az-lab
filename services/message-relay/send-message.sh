#!/usr/bin/env bash
# send-message.sh — post a Relay message to agent_messages.
# Usage: send-message.sh <to_agent|all> <body...>       (from_agent defaults to wren)
#        FROM=jeff send-message.sh atlas "check the vault sync"
set -euo pipefail
ENV_FILE="${ENV_FILE:-$HOME/azlab/services/memory-mcp-server/.env}"
SUPABASE_URL="${SUPABASE_URL:-$(grep '^SUPABASE_URL=' "$ENV_FILE" | cut -d= -f2)}"
KEY="${SUPABASE_SECRET_KEY:-$(grep '^SUPABASE_SECRET_KEY=' "$ENV_FILE" | cut -d= -f2)}"

TO="${1:?usage: send-message.sh <to_agent|all> <body...>}"; shift
BODY="$*"
[ -n "$BODY" ] || { echo "empty body" >&2; exit 1; }
TO_JSON="\"$TO\""; [ "$TO" = "all" ] && TO_JSON="null"

curl -sf "$SUPABASE_URL/rest/v1/agent_messages" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" -H "Prefer: return=representation" \
  -d "$(jq -n --arg from "${FROM:-wren}" --arg body "$BODY" --argjson to "$TO_JSON" \
        '{from_agent:$from, to_agent:$to, kind:"chat", body:$body, meta:{via:"send-message.sh"}}')" \
  | jq -r '.[0].id'
