#!/usr/bin/env bash
# Stop hook — fires when Claude actually finishes a response.
# - Writes heartbeat (real liveness proof — if Claude is frozen, this never runs)
# - Adds ✅ to the Discord message that triggered this response

HEARTBEAT_DIR="$HOME/.wren-watchdog"
HEARTBEAT_FILE="$HEARTBEAT_DIR/heartbeat"
COUNTER_FILE="$HEARTBEAT_DIR/prompt_count"
PENDING_REACTION="$HEARTBEAT_DIR/pending_reaction.json"
BOT_TOKEN_FILE="$HOME/.claude/channels/discord/.env"
SUPABASE_URL="https://ogqjjlbupqnvlcyrfnxi.supabase.co"
# Read rotated secret key from watchdog.env (legacy JWT disabled 2026-04-30).
SERVICE_KEY="$(grep -E '^SUPABASE_(SECRET_KEY|SERVICE_KEY)=' "$HOME/.wren-watchdog/watchdog.env" 2>/dev/null | head -1 | cut -d= -f2- | tr -d '"')"
mkdir -p "$HEARTBEAT_DIR"

# Write heartbeat — proof Claude actually responded.
# Bridge-scoped heartbeat (2026-09-17): a heartbeat written by some other
# Claude session on this host must not vouch for the bridge.
BRIDGE_HELPER="$HOME/azlab/services/watchdog/hooks/bridge-heartbeat.sh"
if [[ -r "$BRIDGE_HELPER" ]]; then
  # shellcheck source=/dev/null
  source "$BRIDGE_HELPER"
  wren_write_heartbeat "$HEARTBEAT_DIR"
else
  date +%s > "$HEARTBEAT_FILE.tmp" && mv "$HEARTBEAT_FILE.tmp" "$HEARTBEAT_FILE"
fi

COUNT=$(cat "$COUNTER_FILE" 2>/dev/null || echo 0)
curl -sf -X POST "${SUPABASE_URL}/rest/v1/rpc/upsert_agent_heartbeat" \
  -H "apikey: ${SERVICE_KEY}" \
  -H "Authorization: Bearer ${SERVICE_KEY}" \
  -H "Content-Type: application/json" \
  -d "{\"p_agent\":\"wren\",\"p_prompt_count\":${COUNT}}" \
  &>/dev/null &

# Add ✅ to the Discord message — confirms response was delivered
if [[ -f "$PENDING_REACTION" ]]; then
  CHAT_ID=$(python3 -c "import json; d=json.load(open('$PENDING_REACTION')); print(d.get('chat_id',''))" 2>/dev/null || true)
  MESSAGE_ID=$(python3 -c "import json; d=json.load(open('$PENDING_REACTION')); print(d.get('message_id',''))" 2>/dev/null || true)
  rm -f "$PENDING_REACTION"

  if [[ -n "$CHAT_ID" && -n "$MESSAGE_ID" ]]; then
    BOT_TOKEN=$(grep '^DISCORD_BOT_TOKEN=' "$BOT_TOKEN_FILE" 2>/dev/null | cut -d= -f2-)
    if [[ -n "$BOT_TOKEN" ]]; then
      curl -sf -X PUT \
        "https://discord.com/api/v10/channels/${CHAT_ID}/messages/${MESSAGE_ID}/reactions/%E2%9C%85/@me" \
        -H "Authorization: Bot ${BOT_TOKEN}" \
        -H "Content-Length: 0" \
        2>/dev/null &
    fi
  fi
fi

exit 0
