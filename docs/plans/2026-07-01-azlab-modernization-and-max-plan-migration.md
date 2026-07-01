---
title: AZ-Lab Modernization & Max-Plan Migration — Program Plan
author: Wren (Claude Code, svc-podman-01)
date: 2026-07-01
status: proposed
scope: infrastructure-wide (Max plan routing, dashboard, metrics, inventory, security, agents, vision)
branch_policy: all work on `beta`, merge to `main` only on explicit confirmation
---

# AZ-Lab Modernization & Max-Plan Migration — Program Plan

> **How to read this:** Part A is what already shipped today. Part B is the funded core ask —
> route the *entire* lab's programmatic Claude usage onto the Max plan with safe fallbacks. Part C
> is the current-state snapshot (grounding, from a live sweep on 2026-07-01). Part D is the phased
> program covering dashboard, metrics, modularity, inventory, security, agents, and vision. Part E
> is risks/rollback/decisions. Appendices carry the raw tables.

---

## Part A — Shipped today (2026-07-01)

Two items from the "Sonnet 5 + Advisor" thread are **done and deployed**; this plan builds on them.

| # | Change | State |
|---|--------|-------|
| A1 | **Agent Bus `/chat` → `claude-sonnet-5`** (was `sonnet-4-6`), `thinking: disabled` to keep interactive chat snappy/cheap. | Live on `~/claude/agent-bus/server.py`, bus restarted, verified answering as `claude-sonnet-5`. |
| A2 | **Lumen chat gains real data tools** — `create_task`, `list_tasks`, `search_memory`, `save_memory` — always-on, running against live Supabase via Hermes. Chat was previously toolless and its prompt forbade task/memory access. | Extension **v0.2.2** built + published (sha `4dcfbc65`). Committed to `beta` (`07d9751`). Needs desktop-updater pull + Edge reload. |

**Deferred deliberately:** the **Advisor tool** (Sonnet 5 executor + Opus 4.8 advisor). Rationale: the advisor pays off in *multi-step agentic* work; Lumen chat is now agentic (A2) but still lightweight. Revisit once the agentic tool loop is exercised in production — it slots naturally into Phase 5.

---

## Part B — CORE: route the entire lab onto the Max plan (with safe fallbacks)

**Objective:** every programmatic Claude call in the lab draws from the **Max 5x plan's $100/mo programmatic credit bucket** (prepaid, already funded) instead of pay-as-you-go **API credits** — with automatic, graceful fallback so nothing ever hard-fails on an auth/quota problem.

### B.1 — Why this is the right move (the numbers)
- **Max 5x includes a $100/mo programmatic bucket**, billed at API rates, currently **$0 used** — all programmatic traffic runs on the *separate* API key.
- **Actual programmatic API spend: $9.34 last month, $0.11 MTD.** ~10× headroom under the bucket you already pay for.
- **Extended use is ON and funded** (per Jeff) to cover overage — so the bucket is a soft target, not a hard ceiling. The migration is about *reclaiming already-paid value* and *centralizing auth*, not cost-cutting.

### B.2 — What's already on the subscription vs. on the API key
This is the migration surface. A discovery pass (B.4) will confirm, but the known split:

| Caller | Auth today | Action |
|--------|-----------|--------|
| **Wren** (this Claude Code, svc-podman-01) | **OAuth / Max sub** (`~/.claude/.credentials.json` → `sk-ant-oat01`, `subscriptionType`) | Already on the plan. No change. |
| **Forge / Atlas** (Desktop Claude Code) | OAuth / Max sub (Claude Code login) | Already on the plan. Confirm. |
| **Agent Bus `/chat`** (Lumen backend) | **API key** (`~/.anthropic_api_key`, `sk-ant-api…`) | **Migrate → OAuth broker.** |
| Daily research / dreaming / consolidation / Guardian / gmail-triage jobs | **Mixed** — some API key, some NemoClaw (local, free), some via Wren | **Audit (B.4), migrate API-key ones.** |

> Key insight: **Wren already runs on the Max sub.** The API-key spend is almost entirely the Agent Bus and a handful of cron jobs. Migrating *those* completes "entire infrastructure on the Max plan."

### B.3 — The blocker and the chosen design
The clean way to mint subscription OAuth tokens for arbitrary callers is the `ant` CLI (`ant auth login` → `ant auth print-credentials --access-token`). **But `ant` has no clean install here:** the GitHub release is source-only (no binary), and there's no Go, Homebrew, or npm package on the box. Three ways forward, evaluated:

| Option | Verdict |
|--------|---------|
| A. Install Go toolchain → `go install .../ant@latest` | Works, but drags a whole toolchain onto a production host for one CLI. |
| B. Reuse Wren's `~/.claude/.credentials.json` OAuth token directly in the bus | **Rejected.** Bus + Claude Code refreshing the *same* refresh token can invalidate each other — risks logging Wren out mid-task. |
| **C. A dedicated OAuth token-broker service** (chosen) | Robust, decoupled: one service owns the OAuth login + refresh, every consumer reads a fresh access token from it. Solves the missing-CLI problem *and* the shared-refresh conflict. |

### B.4 — Implementation (Phase 1 work, funded)

**Step 1 — Discover every programmatic caller.**
`grep -rl 'ANTHROPIC_API_KEY\|anthropic_api_key\|api.anthropic.com' ~ --include=*.py --include=*.ts --include=*.sh` across `~/azlab`, `~/claude`, `~/dashboard`, and systemd units. Produce a caller inventory (name, file, auth method, model, est. volume).

**Step 2 — Build `claude-token-broker` (systemd service on svc-podman-01).**
- One-time: perform the OAuth device-code login against the **Max 5x** account; store the **refresh token** in `~/.secret-drop/claude-oauth.json` (mode 600), *separate from Wren's `~/.claude` store* so the two never contend.
- Runtime: a small Python service + `claude-token-broker.timer` refreshes the access token before expiry and writes it to `~/.config/claude-oauth/access_token` (mode 600) plus exposes `GET http://127.0.0.1:8770/token` (loopback only) returning `{access_token, expires_at}`.
- If installing `ant` proves easier than hand-rolling the OAuth refresh, the broker can shell out to `ant auth print-credentials --access-token` instead — same interface to consumers. (Installing Go for `ant` becomes a sub-task only if we choose that path.)

**Step 3 — A shared "Claude call" module with the fallback chain.**
Factor the LLM-call logic (today duplicated in `agent-bus/server.py`) into one helper used by every migrated caller. The **safe fallback chain**, in order:

```
Tier 0  OAuth (Max bucket)      Authorization: Bearer <broker token> + anthropic-beta: oauth-2025-04-20
   │      on 401/403/token-missing  ─┐
Tier 1  API key (pay-as-you-go)  x-api-key: <~/.anthropic_api_key>      ◄─┘   (extended-use covers overage)
   │      on error/unavailable     ─┐
Tier 2  NemoClaw (local Nemotron) free, already wired in the bus         ◄─┘   (final graceful degrade)
```

- On a **429 from the programmatic bucket** (bucket exhausted for the month) → drop to Tier 1 automatically; log a metric so the dashboard can show "bucket exhausted, on API credits."
- Every tier transition is logged; a single request never hard-fails while *any* tier is available.
- The Agent Bus already implements Tier 1→2; this adds Tier 0 in front and generalizes it into the shared module.

**Step 4 — Migrate callers, one at a time (rollback-friendly).**
Start with Agent Bus `/chat` (highest-value, well-understood). Verify a live `/chat` draws Tier 0, confirm fallback by temporarily revoking the token, then roll to the next caller. Each migration is a small diff, revertible independently.

**Step 5 — Spend/quota metrics.**
A dashboard widget tracking programmatic spend vs. the $100 bucket (see Phase 2 / D2). Source: local per-call token accounting (input+output × model rate) emitted by the shared module to Prometheus; optionally cross-check against Anthropic's usage API if an admin key is provisioned.

### B.5 — Safety, rollback, and guardrails
- **No hard failures:** the 3-tier chain guarantees graceful degrade. Worst case (broker down + API key bad) → NemoClaw answers.
- **Rollback:** each caller migration is one commit; revert restores API-key auth instantly. The broker is additive — removing it just means callers fall to Tier 1.
- **Secret hygiene:** the OAuth refresh token lives in `~/.secret-drop` (600), never committed, never in the sandbox. Aligns with the existing credentials-in-Supabase / secret-drop convention.
- **Constitution compliance:** no deletion, reasoning logged before state changes, escalate on irreversible steps — the broker + migration respect all P0 rules.

**Phase 1 effort:** ~1–2 focused sessions. **Risk:** low (additive, fully reversible). **Vision link:** Strategy 2 (Infra reliability), Strategy 4 (Operational practices — model diversification/routing).

---

## Part C — Current-state snapshot (live sweep, 2026-07-01)

Condensed; full tables in the Appendices.

### C.1 Infrastructure
- **Proxmox (MS-01):** 4 LXC running (homebridge 102, stirling-pdf 105, AMP game 106, grocy 109); 6 VMs — **svc-podman-01 (100), haos (107), nemoclaw-01 (108), nextcloud (110) running**; **`svc-docker-01` (103) and `ubuntu-24-docker-base` (104) STOPPED** (reclaim candidates).
- **svc-podman-01:** 34 podman containers, **all Up**, no crashes. 23 `compose-stack@*` units, all healthy. No failed systemd units.
- **Traefik:** ~35 routers (podman-label + file-provider). **Orphans/hygiene:** `drydock` route with no container; `webmin` route with no backend; `portainer` defined twice (label + file); `shelfmark` standalone compose superseded by the `downloads` stack; `lan-services.yml.bak` lingering; **VLAN99 mgmt** still not in `lan-allow` (now partially fixed earlier today — `lan-allow@file` got 99; `traefik-allow` label too).

### C.2 Agents
| Agent | Surface | Role | Liveness |
|-------|---------|------|----------|
| Wren | Claude Code / svc-podman-01 | Server/infra/code/deploy | **Active today** (14.8k events) |
| Iris | Cowork (claude.ai) | Planning, research, memory, CRIT/HIGH evaluator | Log-stale (1 row, 3 wks) — still mandated evaluator |
| Atlas | Claude Desktop (Windows) | Windows/OneDrive/Obsidian, absorbed **Forge** (merged 2026-05-04) | Task target, no activity rows |
| Volt | Nemotron 120B / nemoclaw-01 | Local/free inference, classification | Backend (no logging) |
| Hermes | Agent Bus :8765 | Inter-agent comms, Discord, A2A | Service (no logging) |
| Lumen | Edge extension | Browser agent; **now agentic (v0.2.2)** | No activity rows |

**Not agents:** Forge (deprecated → Atlas), Sentinel (notification service), **Argus (task-poller/monitor service)**, Dispatch (phone-bridge feature), Clawd_CF (past merge bot).
**Gap:** only Wren logs to `agent_activity`; cross-agent liveness is effectively unobservable — a metrics target (Phase 5).

### C.3 Vision & goals (live subtree)
- **Vision:** "Build the best agentic homelab a small lab can run."
- **Strategy 1 (Memory):** backbone, ~16 milestones **all shipped**. No open children.
- **Strategy 2 (Infra reliability):** open — Oversight/self-monitoring milestone (Guardian ✓, Constitution ✓, anomaly ✓; **paused:** Council of Agents, Transparency mandates; **planned:** Voice Satellite Pi, Pi Cluster Phase 1). Recoverability milestone (kill-switch ✓, backups ✓; **planned P0:** rollback-first design; **paused P1:** Gmail OAuth long-term fix).
- **Strategies 3–5 (Action Gating, Operational Practices, Architectural Isolation):** **entirely `planned`/0%** — the largest unstarted block, and the natural target of this program.
- **Task queue:** **empty** (0 open; 1004 completed). Clean slate for a new initiative.

### C.4 Security posture (top risks from the sweep)
**High:** ① `grimoire.az-lab.dev` has **no access-control middleware** (every sibling has `lan-allow`/Authelia). ② Authelia's own config (`configuration.yml`, `users_database.yml`, `hash.txt`) is **world-readable (664)** with plaintext secrets → chmod 600 + rotate the SMTP credential. ③ **`~/.ssh/id_ed25519_dashboard` is world-readable (mode 604)** — private key exposed. ④ 8 other world-readable files likely holding live creds (agent-bus signing key, Gmail refresh token, SMTP relay key, Calibre secret).
**Medium:** ⑤ No 2FA anywhere in Authelia (password-only for Traefik dashboard, Portainer, LLDAP, Webtop). ⑥ Public website router points at a **nonexistent `cloudflare` cert resolver** → broken TLS on the one public domain. ⑦ Agent Bus (8765/6/7) binds 0.0.0.0 with nothing in front — confirm no WAN forward. ⑧ Authelia forward-auth (9091) binds all interfaces. ⑨ Real WAN exposure hinges on RB5009 NAT — unverifiable from this host, needs a workstation-side audit.
**Low:** unidentified listeners (44321-3, 9882); orphaned ACME certs (hello/openclaw/drydock); unused `lan-auth` basicAuth; ufw state unverifiable unprivileged.

---

## Part D — Phased program

Six phases. Phase 1 is the funded core (Part B). Phases 2–6 cover the workstreams Jeff named. Each is independently shippable; ordering reflects dependency + risk, not hard sequence.

### Phase 1 — Max-plan routing foundation *(funded core; see Part B)*
- **Deliver:** `claude-token-broker` service; shared LLM-call module with Tier 0/1/2 fallback; Agent Bus migrated; spend metric emitted.
- **Advances:** Strategy 2, Strategy 4. **Risk:** low. **Rollback:** per-commit.

### Phase 2 — Dashboard: lab page redesign, metrics, modularity, feature review
- **Lab page redesign/update** (source of truth: `~/dashboard/`, **never** the stale `~/azlab/services/dashboard/`): a rebuilt "Lab" landing view — infra map (hosts/guests/containers with live health), service directory (from Traefik routers), and quick links.
- **Better metrics:** surface the Prometheus stack that already exists (node/blackbox/snmp/podman/cadvisor exporters + Grafana) directly in the dashboard: host CPU/mem/disk, container health, ZFS pool usage (nvme-fast is ~75% full per prior audit), **Claude programmatic spend vs. $100 bucket** (from Phase 1), agent liveness (from Phase 5).
- **Modularity:** refactor dashboard widgets into self-contained modules with a documented data-source contract, so new tiles (metrics, agents, spend) drop in without touching core.
- **Feature review:** audit existing dashboard tabs (Goals, Tasks, Scheduled, Agent terminal, Gmail widget) — keep/merge/retire; document each tile's purpose and data source.
- **Advances:** Strategy 2 (observability), Strategy 4 (documentation/visibility). **Risk:** low-med (UI). **Rollback:** dashboard is git-tracked + image-built; revert + rebuild.

### Phase 3 — Infrastructure inventory & hygiene
- **Reclaim** stopped VMs 103/104 (confirm unused → archive/delete, free 16 GB RAM / 128 GB disk) — **destructive, Jeff-gated.**
- **Traefik cleanup:** remove `drydock`/`webmin` orphan routes, de-duplicate `portainer`, drop `shelfmark` standalone compose + `lan-services.yml.bak`, prune orphaned ACME certs (hello/openclaw/drydock).
- **Formal inventory doc** committed to the repo (this snapshot → living `INVENTORY.md`), regenerated by a scheduled job.
- **Put `~/claude/agent-bus` under git** (currently untracked — the Sonnet 5 change lives only on disk).
- **Advances:** Strategy 2, Strategy 5 (isolation/least-privilege groundwork). **Risk:** med (VM reclaim). **Rollback:** config reverts; VM deletion gated + snapshot-first.

### Phase 4 — Security sweep & hardening
- **Quick wins (can do immediately, low risk):** `chmod 600 ~/.ssh/id_ed25519_dashboard`; `chmod 600` the Authelia config set; lock down the 8 world-readable credential files; add `lan-allow`/Authelia to `grimoire`; fix the website `cloudflare`→`le` cert resolver.
- **Rotate** exposed secrets (Authelia SMTP credential, anything that sat world-readable).
- **2FA:** enable Authelia `two_factor`/TOTP for infra-critical panels (Traefik dashboard, Portainer, LLDAP, Webtop).
- **Bindings:** move Agent Bus + Authelia forward-auth off 0.0.0.0 to LAN/loopback where possible; confirm host `ufw` state (needs root).
- **NAT audit** from Jeff's workstation (RB5009 port-forwards for .51/.52) — the one piece this host can't see.
- **Advances:** Strategy 3 (Action Gating), Strategy 5 (Architectural Isolation), Strategy 2 (fail-safes). **Risk:** med (auth changes can lock out — stage carefully, keep a break-glass path). **Rollback:** config-file reverts; test 2FA on a non-critical route first.

### Phase 5 — Agent inventory & role review
- **Formalize the roster** (6 agents + Lumen) into a canonical `AGENTS.md` with surface, role, auth (post-Phase-1), and escalation path; reconcile the "not-agents" (Argus/Sentinel/Dispatch) as *services*.
- **Fix the telemetry gap:** make every agent write to `agent_activity` (or a heartbeat) so liveness is observable; surface it in the dashboard (Phase 2).
- **Model-routing review:** update `model_routing_primary` now that **Sonnet 5 / Opus 4.8 / Fable 5** exist — codify Sonnet 5 as the default agentic executor, Opus 4.8 for hard reasoning, NemoClaw for bulk/free, and (optionally) the **Advisor pattern** for multi-step agent loops.
- **Revive paused governance objectives:** Council of Agents (multi-model consensus for Guardian), Transparency mandates (visible scratchpads) — both align with Strategies 3–4.
- **Advances:** Vision core (multi-agent collaboration + governance), Strategy 4. **Risk:** low. **Rollback:** doc/config.

### Phase 6 — Vision & goals execution
Tackle the unstarted governance frontier (the bulk of the vision that's `planned`/0%):
- **Strategy 3 (Action Gating):** implement the tiered-autonomy model (low→auto, medium→auto+log+review, high→gated) as enforced policy, not just doctrine. Ties to the Guardian/constitution machinery already live.
- **Strategy 5 (Architectural Isolation):** Supabase RLS + immutable audit logs (RLS enforcement rule already exists); network/hardware scoping; containerize/micro-VM hardening.
- **P0 `rollback-first design`** and **paused P1 `Gmail OAuth long-term fix`** (7-day refresh-token expiry — chronic pain, now solvable with the same OAuth-broker pattern from Phase 1).
- **Hardware objectives:** Pi Cluster Phase 1 (3-node Proxmox, 2× Pi 5), Wyoming Voice Satellite + Sense HAT Pi — as capacity/interest allows.
- **Advances:** the whole vision. **Risk:** varies. **Rollback:** per-objective.

---

## Part E — Risks, rollback, and decision points

### Cross-cutting guardrails
- **Branch policy:** everything on `beta`; merge to `main` only on Jeff's explicit say-so.
- **Reversibility:** every change is a small, independently-revertible commit. Destructive steps (VM reclaim, secret rotation, 2FA) are **gated on Jeff** and snapshot/backup-first.
- **Constitution:** no deletion without verified backup; log reasoning before state changes; escalate on irreversible actions; no self-modification without in-session approval.
- **Extended use funded:** overage beyond the $100 bucket is acceptable per Jeff — so migration is not throttled by cost.

### Decisions needed from Jeff
1. **Phase 1 auth path:** OK to build the `claude-token-broker` (device-code login once, you approve the browser step), vs. installing Go for `ant`? (Broker recommended.)
2. **VM reclaim (Phase 3):** confirm `svc-docker-01` (103) and `ubuntu-24-docker-base` (104) are dead → delete after snapshot?
3. **Security quick-wins (Phase 4):** want me to apply the low-risk fixes (chmod the exposed key + Authelia configs, `grimoire` access-control, website cert-resolver) **now**, ahead of the phased work? These are High-severity and ~5 minutes.
4. **2FA rollout (Phase 4):** enable TOTP on Authelia infra panels? (Requires you to enroll an authenticator.)
5. **Sequencing:** run phases in order, or pull Security (Phase 4 quick-wins) forward immediately?

---

## Appendix 1 — Infrastructure inventory (full)

**Proxmox LXC:** 102 homebridge, 105 stirling-pdf, 106 lxc-amp-game-server-01, 109 grocy — all running.
**Proxmox VMs:** 100 svc-podman-01 (24GB/400GB, running), 103 svc-docker-01 (8GB/64GB, **stopped**), 104 ubuntu-24-docker-base (8GB/64GB, **stopped**), 107 haos (16GB/100GB, running), 108 nemoclaw-01 (8GB/40GB, running), 110 nextcloud (8GB/64GB, running).
**Podman (34, all Up):** traefik, authelia, lldap, az-dashboard, az-grimoire, az-memory-mcp, az-tei-reranker, az-gmail-mcp, sentinel-api, az-ms-smtp-relay, website, lumen-dist, changedetection, uptime-kuma, portainer, code-server, webtop, calibre-web-automated, audiobookshelf, immich (server/ML/redis/postgres), downloads stack (gluetun/qbittorrent/prowlarr/flaresolverr/shelfmark), ollama, rustdesk (hbbs/hbbr), monitoring (prometheus/grafana/node_exporter/blackbox/snmp_exporter/podman_exporter/cadvisor).
**Traefik hostnames:** www/az-lab.dev, gmail-mcp, abs, grafana, calibre, drydock*, shelfmark, lumen, uptime, memory-mcp, changedetect, smtp-relay, photos, grimoire, qbit, prowlarr, sentinel-api, portainer, games, auth, code, crs309.home.arpa, grocy, ha, homebridge, nextcloud, pdf, webmin*, webtop, svc-podman-01. (*=orphan/no backend.)

## Appendix 2 — Active system rules (governance control plane)
P0: `wren_constitution` (7 principles), `kill_switch_check`. P1: `priority_scale`, `auto_rls_enforcement`, `model_routing_primary` (Opus→Sonnet→Haiku), `model_routing_fallback_1` (gpt-4o). P2: `agent_routing_awareness`, `task_routing_infra_remediation` (infra → claude-code/Wren), `startup_supabase_check`, flag semantics. P3–P6: auto-approve perms, no confirmation prompts, memory-during-work, **Arizona MST display**, docs→Obsidian. P7–P11: git default `beta`, injection resistance, `agent_names`, `iris_identity`, `remote_deploy_diff_first`, `supabase_project_id`. P12+: `task_failure_protocol`, `evaluator_protocol` (Iris on CRIT/HIGH), `bootstrap_architecture`, `obsidian_sync_on_doc_creation`, `pending_eval_protocol`, `guardian_enabled` (Haiku post-task audit).

## Appendix 3 — Security top-risks (prioritized)
**High:** grimoire no-auth; Authelia config world-readable + plaintext secrets; `id_ed25519_dashboard` mode 604; 8 world-readable credential files.
**Medium:** no 2FA in Authelia; website `cloudflare` cert-resolver broken; Agent Bus 0.0.0.0 binding; Authelia 9091 all-interfaces; RB5009 NAT unaudited.
**Low:** unidentified listeners 44321-3/9882; orphaned ACME certs; unused `lan-auth`; ufw state unverified.

---
*Generated by Wren on svc-podman-01, 2026-07-01. Inputs: live infra/agent/security sweep + Supabase goals/rules. Times Arizona MST. This document is a proposal — no changes in Parts C–F are made without the decisions in Part E.*
