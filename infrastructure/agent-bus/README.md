# Agent Bus

Always-on HTTP server for az-lab inter-agent communication. Runs on svc-podman-01 at port 8765.

**Source:** `~/claude/agent-bus/server.py`

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| GET | `/health` | — | Server status |
| GET | `/agents` | — | List all agent names |
| GET | `/agents/{name}/card` | — | A2A agent card for named agent |
| GET | `/mcp` | — | SSE handshake for Claude Desktop MCP |
| POST | `/mcp` | — | MCP JSON-RPC tool calls |
| POST | `/trigger` | Secret | Fire a trigger event |
| POST | `/message` | Secret | Send Discord message |

Auth header: `X-Agent-Secret: <AGENT_BUS_SECRET>` (default: `azlab-agent-bus`)

## Agent Cards

Agent cards live in `agent-cards/` and follow the A2A Agent Card spec. Each card describes an agent's identity, capabilities, accepted task types, and contact information.

| Agent | File | Runtime | Host |
|-------|------|---------|------|
| Wren | `wren.json` | claude-code | svc-podman-01 |
| Iris | `iris.json` | claude-cowork | claude.ai |
| Atlas | `atlas.json` | claude-desktop | windows-workstation |
| Forge | `forge.json` | claude-code-desktop | windows-workstation |
| Volt | `volt.json` | nvidia-nim | nemoclaw-01 |

Fetch a card: `curl http://192.168.1.181:8765/agents/wren/card`

Cards path is configurable via `AGENT_CARDS_PATH` env var (default: `~/azlab/infrastructure/agent-bus/agent-cards`).

## MCP Tools

Exposed to Claude instances via MCP:

- `send_discord` — send message to Jeff's Discord
- `fire_trigger` — manually invoke a trigger handler
- `get_status` — query agent bus state
- `queue_task` — add task to Claude Code's Supabase task queue

## Trigger Types

| Type | Description |
|------|-------------|
| `ha_presence` | Home Assistant arrival/departure event |
| `system_check` | Manual fire of periodic anomaly checks |
| `maintenance` | Manual fire of maintenance nudge handlers |
| `message` | Direct Discord message send |
