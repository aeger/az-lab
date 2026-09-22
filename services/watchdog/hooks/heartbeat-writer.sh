#!/usr/bin/env bash
# UserPromptSubmit hook — writes heartbeat for real prompts.
# Input is JSON: {"prompt": "...", ...}
# Canary pings are excluded so the watchdog measures actual Claude responsiveness.

HEARTBEAT_DIR="$HOME/.wren-watchdog"
HEARTBEAT_FILE="$HEARTBEAT_DIR/heartbeat"
COUNTER_FILE="$HEARTBEAT_DIR/prompt_count"
SUPABASE_URL="https://ogqjjlbupqnvlcyrfnxi.supabase.co"
# Rotated 2026-04-30 — legacy service_role JWT returns 401 UNAUTHORIZED_DISABLED_LEGACY_KEY.
SERVICE_KEY="$(grep -E '^SUPABASE_(SECRET_KEY|SERVICE_KEY)=' "$HEARTBEAT_DIR/watchdog.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"

mkdir -p "$HEARTBEAT_DIR"

RAW=$(cat)

# Extract prompt text from JSON (canary check — canary text has no special chars so works either way,
# but parsing JSON is correct and future-proof)
PROMPT=$(echo "$RAW" | python3 -c "
import sys, json
try:
    d = json.load(sys.stdin)
    print(d.get('prompt', ''))
except:
    print(sys.stdin.read())
" 2>/dev/null || echo "$RAW")

# Canaries must not refresh heartbeat — only real Claude responses (Stop hook) confirm liveness
if echo "$PROMPT" | grep -q 'watchdog-canary-'; then
  exit 0
fi


# Bridge-scoped heartbeat (2026-09-17): a heartbeat written by some other
# Claude session on this host must not vouch for the bridge.
BRIDGE_HELPER="$HOME/azlab/services/watchdog/hooks/bridge-heartbeat.sh"
if [[ -r "$BRIDGE_HELPER" ]]; then
  # shellcheck source=/dev/null
  source "$BRIDGE_HELPER"
  wren_write_heartbeat "$HEARTBEAT_DIR"
else
  # Helper missing — keep the old behaviour rather than losing the heartbeat.
  date +%s > "$HEARTBEAT_FILE.tmp" && mv "$HEARTBEAT_FILE.tmp" "$HEARTBEAT_FILE"
fi

# Record genuine inbound Discord prompts for the watchdog hang detector.
# Only real Discord messages (not terminal prompts) expect a Discord reply, so
# this matches the last_response_at signal's lifecycle (pending_reaction.json).
if echo "$PROMPT" | grep -q 'source="plugin:discord:discord"'; then
  date +%s > "$HEARTBEAT_DIR/last_prompt_at.tmp" && mv "$HEARTBEAT_DIR/last_prompt_at.tmp" "$HEARTBEAT_DIR/last_prompt_at"
fi

COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
COUNT=$((COUNT + 1))
echo "$COUNT" > "$COUNTER_FILE"

curl -sf -X POST "${SUPABASE_URL}/rest/v1/rpc/upsert_agent_heartbeat" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"p_agent\":\"wren\",\"p_prompt_count\":${COUNT}}" \
  &>/dev/null &

exit 0
