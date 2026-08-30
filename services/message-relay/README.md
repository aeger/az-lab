# message-relay — the agent Relay pathway (Wren side)

Realtime push messaging between agents, replacing "file a queue row and wait
for a poll" for interactive traffic. Designed + approved 2026-08-29
(plan: `~/.claude/plans/currently-agent-atlas-is-mossy-thompson.md`).

## Architecture

One new table, `public.agent_messages` (migration 146), fans out over Supabase
Realtime (raw Phoenix **vsn=1.0.0** WebSocket — supabase-js's vsn=2.0.0 is
rejected by this project; client pattern from memory-mcp's
`startMemorySyncListener`). Each surface runs a listener:

| Surface | Listener | Push? |
|---|---|---|
| Wren (this host) | `message-relay.service` (this dir) | yes — WS |
| Atlas (Windows) | `../atlas-helper/` Scheduled Task | yes — WS |
| Jeff | dashboard `/lab/messages` (SSE from Next.js server) | yes — SSE |
| Iris (Cowork) | none possible (cloud, outbound-only) — reads/writes rows via her Supabase MCP | no |

`task_queue` remains the durable work store. A message with `kind='task'` is
escalated into a `task_queue` row (linked via `agent_messages.task_id`).

## What this service does

1. **agent_messages INSERT** to `wren`/`claude-code`/broadcast → stamp
   `delivered_at`, check `check_kill_switch('wren')`, spawn headless
   `claude -p` (concurrency 1, 5 min timeout), post the session's final output
   back as the reply row, stamp `acked_at`. `kind='task'` → INSERT task_queue
   row instead. `status`/`system` kinds are informational, ignored.
2. **task_queue INSERT** (target claude-code/wren/auto, status
   pending/ready/delegated) → debounced
   `systemctl --user start claude-queue-poll.service`. This replaces the dead
   `claude-queue-realtime.service` (`realtime_listener.py`), whose Python
   `realtime` lib hangs silently on reconnect (zombie since 2026-08-25).
3. **Catch-up on every (re)connect**: undelivered messages (7-day window) are
   drained, so downtime loses nothing.

## Ops

```bash
systemctl --user status message-relay      # unit: ~/.config/systemd/user/message-relay.service
journalctl --user -u message-relay -f
./send-message.sh atlas "check the vault"  # send from CLI (FROM=jeff to impersonate)
./send-message.sh all "broadcast"          # to_agent NULL
```

Env comes from `~/azlab/services/memory-mcp-server/.env` (SUPABASE_URL /
SUPABASE_PUBLISHABLE_KEY for the WS, SUPABASE_SECRET_KEY for REST).
`RELAY_CLAUDE_BIN` pins the claude binary (`~/.bun/bin/claude`).

Reply loops are prevented structurally: the relay ignores messages from
`wren`, and replies are always direct (never broadcast).

## Retired by this service

- `claude-queue-realtime.service` — disable after this is live.
- `memory-realtime.service` — same Python-lib zombie; memory-sync is already
  covered by the working TS listener inside memory-mcp-server.

## Updating the Atlas helper (Windows)

The tray and the listener reload differently, which is easy to get wrong:

| You changed | What picks it up |
|---|---|
| `helper.mjs` | tray right-click -> **Restart Helper** (re-spawns node from disk) |
| `config.json` | **Restart Helper**, or the **Auto-execute tasks** toggle (which restarts for you) |
| `atlas-tray.ps1` | tray right-click -> **Reload Tray Script (full restart)** — PowerShell holds the script as loaded at launch, so "Restart Helper" alone will NOT pick up tray changes |

Runtime dir is `C:\Tools\atlas-helper\` (what the "Atlas Relay Helper" Scheduled Task
executes). `Downloads\atlas-helper` is only the staging copy you run the installer from —
copy updated files into `C:\Tools\atlas-helper\` (or re-run the installer, which is
idempotent and reuses the existing `config.json`).
