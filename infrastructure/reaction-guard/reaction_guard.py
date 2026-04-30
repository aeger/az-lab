#!/usr/bin/env python3
"""
wren-reaction-guard — Discord reaction enforcement sidecar.
Polls Discord for new messages and ensures 👀/✅ reactions fire
independently of Claude Code hook health.
"""

import json
import os
import time
import logging
import requests
from pathlib import Path

CHANNEL_ID = "1012721652049657896"
POLL_INTERVAL = 3
REACTION_TIMEOUT = 600

DISCORD_ENV = Path.home() / ".claude/channels/discord/.env"
SUPABASE_ENV = Path.home() / "azlab/services/memory-mcp-server/.env"
STATE_FILE = Path.home() / ".wren-watchdog/reaction_state.json"
LOG_FILE = Path.home() / ".wren-watchdog/reaction_guard.log"

DISCORD_API = "https://discord.com/api/v10"
EYES_EMOJI = "%F0%9F%91%80"
CHECK_EMOJI = "%E2%9C%85"
EYES_LABEL = "👀"
CHECK_LABEL = "✅"

logging.basicConfig(
    filename=str(LOG_FILE),
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)
log = logging.getLogger(__name__)


def load_env(path: Path) -> dict:
    env = {}
    try:
        for line in path.read_text().splitlines():
            line = line.strip()
            if "=" in line and not line.startswith("#"):
                k, v = line.split("=", 1)
                env[k.strip()] = v.strip()
    except Exception as e:
        log.error(f"Failed to load env {path}: {e}")
    return env


def load_state() -> dict:
    try:
        return json.loads(STATE_FILE.read_text())
    except Exception:
        return {"seen_ids": [], "pending": {}, "last_heartbeat_ts": None}


def save_state(state: dict):
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    tmp = str(STATE_FILE) + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f)
    os.replace(tmp, str(STATE_FILE))


def get_messages(bot_token: str) -> list:
    try:
        r = requests.get(
            f"{DISCORD_API}/channels/{CHANNEL_ID}/messages",
            headers={"Authorization": f"Bot {bot_token}"},
            params={"limit": 10},
            timeout=5,
        )
        r.raise_for_status()
        return r.json()
    except Exception as e:
        log.warning(f"poll_discord failed: {e}")
        return []


def put_reaction(bot_token: str, message_id: str, emoji: str) -> bool:
    try:
        r = requests.put(
            f"{DISCORD_API}/channels/{CHANNEL_ID}/messages/{message_id}/reactions/{emoji}/@me",
            headers={"Authorization": f"Bot {bot_token}", "Content-Length": "0"},
            timeout=5,
        )
        label = EYES_LABEL if emoji == EYES_EMOJI else CHECK_LABEL
        if r.status_code in (200, 204):
            log.info(f"reacted {label} to {message_id}")
            return True
        else:
            log.warning(f"react {label} failed {r.status_code} for {message_id}")
            return False
    except Exception as e:
        log.warning(f"put_reaction error: {e}")
        return False


def get_heartbeat(supabase_url: str, service_key: str):
    try:
        r = requests.get(
            f"{supabase_url}/rest/v1/agent_heartbeat",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
            },
            params={"agent": "eq.wren", "select": "updated_at"},
            timeout=5,
        )
        r.raise_for_status()
        rows = r.json()
        if rows:
            return rows[0].get("updated_at")
    except Exception as e:
        log.warning(f"poll_heartbeat failed: {e}")
    return None


def log_activity(supabase_url: str, service_key: str, content: str):
    try:
        requests.post(
            f"{supabase_url}/rest/v1/agent_activity",
            headers={
                "apikey": service_key,
                "Authorization": f"Bearer {service_key}",
                "Content-Type": "application/json",
                "Prefer": "return=minimal",
            },
            json={"agent": "wren", "activity_type": "status", "content": content},
            timeout=5,
        )
    except Exception as e:
        log.warning(f"log_activity failed: {e}")


def main():
    log.info("wren-reaction-guard starting")

    discord_env = load_env(DISCORD_ENV)
    supabase_env = load_env(SUPABASE_ENV)

    bot_token = discord_env.get("DISCORD_BOT_TOKEN", "")
    supabase_url = supabase_env.get("SUPABASE_URL", "")
    service_key = supabase_env.get("SUPABASE_SECRET_KEY", "")

    if not bot_token or not supabase_url or not service_key:
        log.error("Missing required credentials — exiting")
        return

    state = load_state()
    state.setdefault("seen_ids", [])
    state.setdefault("pending", {})
    state.setdefault("last_heartbeat_ts", None)

    # Seed seen_ids on fresh start so we don't 👀 historical messages
    if not state["seen_ids"]:
        startup_msgs = get_messages(bot_token)
        for msg in startup_msgs:
            mid = msg.get("id", "")
            if mid:
                state["seen_ids"].append(mid)
        log.info(f"seeded {len(state['seen_ids'])} existing messages on startup")
        save_state(state)

    while True:
        try:
            messages = get_messages(bot_token)
            now = time.time()

            for msg in messages:
                msg_id = msg.get("id", "")
                if not msg_id or msg_id in state["seen_ids"]:
                    continue
                author = msg.get("author", {})
                if author.get("bot"):
                    state["seen_ids"].append(msg_id)
                    continue
                # New non-bot message — react 👀
                state["seen_ids"].append(msg_id)
                ok = put_reaction(bot_token, msg_id, EYES_EMOJI)
                if ok:
                    log_activity(supabase_url, service_key, f"reacted 👀 to {msg_id}")
                state["pending"][msg_id] = now

            if len(state["seen_ids"]) > 500:
                state["seen_ids"] = state["seen_ids"][-500:]

            current_hb = get_heartbeat(supabase_url, service_key)
            if current_hb and current_hb != state["last_heartbeat_ts"]:
                hb_advanced = True
                state["last_heartbeat_ts"] = current_hb
            else:
                hb_advanced = False

            resolved = []
            for msg_id, arrived_at in list(state["pending"].items()):
                elapsed = now - arrived_at
                if hb_advanced:
                    put_reaction(bot_token, msg_id, CHECK_EMOJI)
                    log_activity(supabase_url, service_key, f"reacted ✅ to {msg_id}")
                    resolved.append(msg_id)
                elif elapsed > REACTION_TIMEOUT:
                    log.warning(f"reaction_timeout for {msg_id} after {elapsed:.0f}s")
                    log_activity(supabase_url, service_key, f"reaction_timeout for {msg_id}")
                    resolved.append(msg_id)

            for msg_id in resolved:
                state["pending"].pop(msg_id, None)

            save_state(state)

        except Exception as e:
            log.error(f"main loop error: {e}")

        time.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    main()
