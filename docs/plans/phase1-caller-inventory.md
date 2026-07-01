# Phase 1 — Programmatic Claude Caller Inventory

> Part of **2026-07-01-azlab-modernization-and-max-plan-migration**, Part B.4 Step 1.
> Discovery sweep on svc-podman-01, 2026-07-01. Third-party noise (vscode-server,
> podman container overlays, Claude Code plugins, code-server extensions) excluded —
> those are not lab-owned callers.

## Real programmatic Claude callers (migration surface)

| # | Caller | File | Auth today | Model(s) | Action |
|---|--------|------|-----------|----------|--------|
| 1 | **Agent Bus `/chat`** (Lumen/Hermes backend) | `~/claude/agent-bus/server.py` (~L280–356) | API key (`~/.anthropic_api_key`) → NemoClaw fallback | `claude-sonnet-5` → `nemotron-120b` | **Primary migration.** Swap direct calls for `claude_call.call_claude(...)` — gains Tier 0 in front, keeps existing 1→2. |
| 2 | **Episodic distillation** (nightly) | `~/azlab/services/memory-mcp-server/episodic_distill.py` (~L199–243) | NemoClaw primary; Haiku via API key fallback | Nemotron primary, `claude-haiku` fallback | Migrate the Haiku fallback path to `claude_call` (allow_tiers ordering keeps NemoClaw-first if desired). |
| 3 | **Episodic consolidation** | `~/azlab/infrastructure/memory-consolidation/consolidate_episodic_memories.py` (~L152–208) | API key (read from `memory-mcp-server/.env`) | Claude (abstraction) | Migrate `call_claude()` local fn → shared module. |

## Already on the Max subscription (no change)
| Caller | Auth |
|--------|------|
| **Wren** (this Claude Code, svc-podman-01) | OAuth/Max — `~/.claude/.credentials.json` (`subscriptionType: max`, `default_claude_max_5x`) |
| **Wren Discord bot** | `~/.config/systemd/user/claude-discord.service` runs the Claude Code CLI → same OAuth/Max session |
| **Forge / Atlas** (Desktop Claude Code) | OAuth/Max (Claude Code login) — confirm on their host |

## Not real callers (excluded from the sweep)
vscode-server + code-server Copilot/Claude extensions; podman overlay diffs (immich,
changedetection, website build artifacts, code-server image); Claude Code marketplace
plugin hooks. None of these draw the lab's API key.

## Migration order (Part B.4 Step 4 — rollback-friendly, one at a time)
1. **Agent Bus `/chat`** — highest value, well understood, easy to verify a live `/chat`
   draws Tier 0. Confirm fallback by temporarily revoking the broker token.
2. **consolidate_episodic_memories.py** — batch, off-peak, low risk.
3. **episodic_distill.py** — already NemoClaw-first; only the cloud fallback moves to Tier 0.

Each migration is a small independent diff on `beta`, revertible on its own.

## Status (2026-07-01)
- ✅ Shared module `~/claude/lib/claude_call.py` built + tested (Tier 1 & Tier 2 verified live; Tier 0 falls through cleanly until broker has a token).
- ✅ `claude-token-broker` service built + installed + running (serves 503 until login).
- ⏳ **Blocked on Jeff:** one-time `login.py` browser approval to seed the Max refresh token → activates Tier 0.
- ⬜ Migrate the 3 callers above (after Tier 0 verified end-to-end).
- ⬜ Spend metric surfaced to dashboard (Phase 2) — JSONL groundwork emitting at `~/.local/state/claude-spend/usage.jsonl`.
