# gmail-mcp-server

Full-featured Gmail MCP server for the az-lab homelab. Runs as a stateless HTTP service behind Traefik, giving Claude (Cowork, Claude Code, or any MCP client) complete Gmail management.

**13 tools:** search, read, trash, permanent delete, archive, batch trash, batch delete, batch archive, mark read/unread, list labels, apply labels.

---

## Architecture

```
Cowork Desktop  ──┐
                  ├──▶  https://gmail-mcp.az-lab.dev/mcp  ──▶  az-gmail-mcp container  ──▶  Gmail API
Claude Code SSH ──┘          (Traefik · lan-allow)               svc-podman-01
```

Both Claude environments hit the same endpoint — no split brain.

---

## Setup

### 1. Enable Gmail API

In your existing Google Cloud project (same one as the dashboard Calendar API):

1. APIs & Services → Library → **Gmail API** → Enable
2. APIs & Services → Credentials → **+ Create Credentials → OAuth Client ID**
   - Type: **Desktop app**
   - Add redirect URI: `http://localhost:3000/callback`
3. Copy Client ID and Client Secret

### 2. Generate Refresh Token (one-time, run locally)

```bash
cd gmail-mcp-server
npm install
export GMAIL_CLIENT_ID=your_client_id
export GMAIL_CLIENT_SECRET=your_client_secret
npm run auth
```

Browser opens → authorize → terminal prints your `GMAIL_REFRESH_TOKEN`.

### 3. Create `.env`

```bash
cp .env.example .env
# Fill in GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN
```

### 4. Deploy

```bash
# On svc-podman-01 (or via your normal deploy process)
docker compose up -d --build
```

Traefik picks it up automatically at `https://gmail-mcp.az-lab.dev`.

---

## MCP Client Config

### Cowork / Claude Desktop

```json
{
  "mcpServers": {
    "gmail": {
      "url": "https://gmail-mcp.az-lab.dev/mcp"
    }
  }
}
```

### Claude Code (SSH session on server)

```json
{
  "mcpServers": {
    "gmail": {
      "url": "http://192.168.1.181:3000/mcp"
    }
  }
}
```

Or add to `~/.claude/claude_desktop_config.json` on the server.

---

## Tools

| Tool | Description |
|------|-------------|
| `gmail_get_profile` | Account info & message counts |
| `gmail_search_messages` | Search with full Gmail query syntax |
| `gmail_read_message` | Read full message content |
| `gmail_trash_message` | Move single message to Trash |
| `gmail_delete_message` | Permanently delete single message |
| `gmail_batch_trash` | ⭐ Trash multiple messages at once |
| `gmail_batch_delete` | Permanently delete multiple messages |
| `gmail_archive_message` | Archive single message |
| `gmail_batch_archive` | ⭐ Archive multiple messages at once |
| `gmail_mark_read` | Mark messages as read |
| `gmail_mark_unread` | Mark messages as unread |
| `gmail_list_labels` | List all Gmail labels |
| `gmail_apply_label` | Add/remove labels on messages |

---

## Troubleshooting

**401 Auth failed** — Refresh token revoked. Re-run `npm run auth` locally, update `.env`, redeploy.

**No refresh token from auth** — Revoke app access at https://myaccount.google.com/permissions, then re-run auth.

**Health check** — `curl https://gmail-mcp.az-lab.dev/health` → `{"status":"ok"}`
