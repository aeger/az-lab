# Claude Code Recovery Guide
> Pre-upgrade snapshot: 2026-03-21
> Recovery branch: `backup/pre-upgrade-2026-03-21`

## Quick Recovery (Something Went Wrong)

### Restore to pre-upgrade state
```bash
cd ~/azlab
git fetch origin
git checkout backup/pre-upgrade-2026-03-21

# Restore Claude settings
cp infrastructure/claude-recovery/settings.json ~/.claude/settings.json
cp infrastructure/claude-recovery/settings.local.json ~/.claude/settings.local.json

# Restart memory-mcp-server
systemctl --user restart compose-stack@memory-mcp-server

# Rollback Ollama (if installed during upgrade)
podman stop ollama && podman rm ollama
systemctl --user disable --now claude-ollama.service 2>/dev/null || true

# Verify memory sync still works
bash ~/claude/scripts/sync-memory.sh && echo "memory sync OK"
```

## What Exists At This Snapshot

### Services (Podman / systemd --user)
- `compose-stack@memory-mcp-server` — MCP server at memory-mcp.az-lab.dev
- `compose-stack@traefik` — reverse proxy
- `claude-queue-poll.timer` — task queue poller (every 5 min)
- All other az-lab services (see azlab/services/)

### Memory System
- **Supabase project:** azlab-memory (ogqjjlbupqnvlcyrfnxi)
- **Schema:** memories table (id, type, name, description, content, tags[], source, embedding vector)
- **Sync:** SessionStart hook → ~/claude/scripts/sync-memory.sh → writes to ~/.claude/projects/-home-almty1/memory/
- **25 memories** as of this snapshot (no embeddings — all NULL at this point)

### Claude Config
- Settings snapshotted to this directory (settings.json, settings.local.json)
- SessionStart hook: bash ~/claude/scripts/sync-memory.sh
- Discord plugin enabled

### Key File Locations
| File | Purpose |
|---|---|
| `~/.claude/settings.json` | Main Claude Code settings |
| `~/.claude/settings.local.json` | Local overrides (extra permissions) |
| `~/claude/RECOVERY.md` | Full bootstrap guide |
| `~/claude/scripts/sync-memory.sh` | Supabase → local memory sync |
| `~/azlab/services/memory-mcp-server/` | MCP server source |
| `~/azlab/infrastructure/task-queue/` | Task queue poller |
| `~/.config/systemd/user/` | Systemd user units |

## Upgrade Being Applied (2026-03-21)

The following is being added. Roll back by reversing these steps:

### Phase 1: Ollama + Semantic Memory
- **Rollback:** `podman stop ollama && podman rm ollama`
- **Rollback:** revert memory-mcp-server to pre-upgrade git state
- **Rollback:** embeddings column stays populated (harmless, just not used)

### Phase 2: Subagents
- **Rollback:** `rm -rf ~/.claude/agents/`
- No system impact — just removes agent definitions

### Phase 3: NemoClaw
- **Rollback:** `podman stop nemoclaw && podman rm nemoclaw`
- **Rollback:** `systemctl --user disable --now nemoclaw.service`
