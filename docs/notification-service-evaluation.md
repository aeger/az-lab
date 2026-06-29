# Self-Hosted Notification Service — Evaluation & Plan

**Status:** Evaluation only. Deployment requires Jeff's green-light.
**Date:** 2026-05-28
**Author:** Wren (delegated by Atlas)
**Scope:** Add a self-hosted notification surface focused on **mobile push (Android + iOS)** to supplement — not replace — Sentinel.

---

## 1. Problem statement

Current notification surfaces in the lab:

| Surface | Mobile push? | Notes |
|---|---|---|
| Discord | Yes (via Discord app) | Works, but noisy — every channel ping competes with social/server pings. Bad UX for high-priority alerts. |
| Sentinel extension (Edge) | No (desktop only) | Browser/desktop notifications when Edge is open. Strong for at-the-desk, useless when away. |
| Dashboard (home.az-lab.dev) | No | Pull-only surface. |

**Gap:** there is no dedicated mobile-push path for lab events. We want a clean, deduped, topic-aware channel so events like "Atlas task arrived", "HA: garage left open", "Grafana: disk > 90%", or ad-hoc `curl` pings reach Jeff's phone with native OS notifications — independent of Discord's social noise.

---

## 2. Goals & non-goals

**Goals**

1. Receive webhook POSTs from Sentinel, Grafana, HA, and ad-hoc one-liners (`curl -d "msg" https://...`).
2. Native push to **Android and iOS**.
3. Topic / channel routing (e.g. `atlas-tasks`, `ha-alerts`, `grafana`, `adhoc`).
4. Priority levels and notification actions (open URL, ack/dismiss).
5. Run on existing Podman stack on svc-podman-01 with Traefik + LE TLS.
6. Low ongoing maintenance — single binary or single container preferred.
7. Memory-friendly UX: clear titles, dedup, snoozable, low-volume by default (per Jeff's working-style guidance).

**Non-goals**

- Replacing Sentinel. Sentinel stays the homelab alerting brain. The new service is a **transport** for selected Sentinel events plus other sources.
- Replacing Discord for social/agent chatter.
- SMS / email / pager. Out of scope.
- Multi-user / family notifications. Single-user (Jeff) for now.

---

## 3. Candidate evaluation

### 3.1 Comparison matrix

| Criterion | ntfy | Gotify | Apprise API alone | ntfy + Apprise |
|---|---|---|---|---|
| **Android push** | Yes — official F-Droid + Play app, WebSocket or Firebase | Yes — official Play + F-Droid | No native app | Yes (via ntfy) |
| **iOS push** | Yes — official App Store app. *Self-hosted iOS requires upstream relay via ntfy.sh* (see §3.2) | **No official iOS app** — community shims only | No native app | Yes (via ntfy) |
| **Self-host story** | Single Go binary, single container, SQLite or no-DB | Single Go binary, single container, SQLite | Python container, no UI | Two containers |
| **HTTP API simplicity** | `curl -d "msg" https://host/topic` — best-in-class | `curl -X POST -H 'X-Gotify-Key: …' …` — token-per-app | Heavier — needs URL schemes per target | ntfy ergonomics preserved |
| **Topics / channels** | First-class topic-per-URL; subscribe by topic name | Per-app token; each "channel" is an app entry | N/A | Topics via ntfy |
| **Priority levels** | 1–5, maps to OS importance | 0–10, maps to importance | N/A directly | Yes |
| **Notification actions** | `view`, `http`, `broadcast` actions — supports "Open dashboard" / "Ack via HTTP" | View only | N/A | Yes |
| **Attachments / icons** | Yes (files, emoji tags, icons) | Limited | N/A | Yes |
| **Auth** | Optional, ACL per topic, tokens | Mandatory per-app token | Basic | ntfy ACL + Apprise |
| **Maintenance burden** | Very low — `ntfy serve`, occasional binary bump | Very low | Low | Low–medium (two services) |
| **Resource footprint** | ~30 MB RAM idle | ~25 MB RAM idle | ~80 MB Python | ~110 MB combined |
| **License** | Apache 2.0 | MIT | BSD-2 | Mixed |
| **Sentinel integration effort** | Add ntfy webhook in Sentinel's notifier list; ~1 file change | Same shape, more verbose | Sentinel would need Apprise URL schemes — most work | Sentinel → ntfy direct; Apprise only for fan-out cases |

### 3.2 iOS reality check for ntfy (critical detail)

ntfy's iOS app cannot poll a self-hosted server directly because iOS doesn't allow long-running background sockets. The official path is:

- The iOS app subscribes via Apple Push Notification Service (APNS).
- ntfy.sh runs an APNS relay. When your self-hosted ntfy receives a message on a topic the iOS device subscribed to, it forwards the notification metadata to ntfy.sh, which relays via APNS.
- Configured by setting `upstream-base-url: https://ntfy.sh` in `server.yml`.
- **Trade-off:** message **title/body** transit ntfy.sh's relay for iOS delivery. End-to-end self-host on iOS is not currently practical with any FOSS option.

Acceptable mitigations:
- Send only non-sensitive payloads to iOS topics, or use ntfy's E2EE option (passphrase-based, opt-in).
- Keep sensitive alerts (credentials, internal IPs in error messages) on Android-only topics, where self-host is end-to-end.

### 3.3 Why Gotify falls out

Gotify is technically excellent and would be a clean fit *except* it has no iOS app. Community wrappers (UnifiedPush bridges) exist but require ongoing care. Given Jeff has at least one iOS device in the household and APNS is the only realistic iOS push path, Gotify can't carry the iOS leg.

### 3.4 Why Apprise alone falls out

Apprise is a **router**, not a push service. It would still need ntfy/Gotify/Pushover as a downstream to reach a phone. Useful as an add-on, not a primary.

### 3.5 ntfy + Apprise hybrid

Real value only if we want one ingest endpoint that fans out to ntfy + Discord + email + Slack from a single webhook. Sentinel already does multi-destination notify, so the hybrid adds a layer that duplicates Sentinel's job. **Skip for now**; revisit if a non-Sentinel source ever needs multi-destination fan-out.

---

## 4. Recommendation

**Adopt ntfy. Single-container deploy on svc-podman-01 behind Traefik. Use ntfy.sh upstream relay for iOS only.**

Reasoning:
- Only candidate that covers both Android and iOS with official apps.
- Lowest-friction HTTP API — ad-hoc `curl` from any agent/script is one line.
- First-class topics, priorities, actions — maps cleanly to "atlas-tasks", "ha-alerts", "grafana", "wren-ops".
- Single binary, single container, no DB required for our scale.
- Active upstream, sane licensing, well-documented.
- iOS relay caveat is acceptable given the alternative is no iOS push at all.

Sentinel stays in place. ntfy becomes an additional notifier in Sentinel's config plus a direct webhook endpoint for HA, Grafana, and ad-hoc.

---

## 5. Deployment plan (proposal — not executed)

### 5.1 Topology

- **Host:** svc-podman-01 (this host). No new VM/LXC needed — ntfy is light.
- **Container:** `binwiederhier/ntfy:latest` via Podman, compose-stack systemd unit, matching the rest of `~/azlab/services/`.
- **Persistence:** `./data/` for cache + attachments, `./server.yml` for config.
- **Network:** existing `proxy` external network (Traefik).

### 5.2 DNS + TLS

- New A record: `ntfy.az-lab.dev` → `192.168.1.181` (Cloudflare, DNS-only — required for ACME DNS-01, per CLAUDE.md guardrail).
- Cert via existing LE `certresolver=le`.
- **Public exposure:** ntfy needs to be reachable from Jeff's phones **outside the LAN** (otherwise push only works on Wi-Fi). Two options:
  - **5a.** Expose via Traefik on `websecure` *without* the `lan-allow@file` middleware (i.e., public). Protect with ntfy's built-in auth (`auth-default-access: deny-all`, per-topic ACLs, bearer tokens).
  - **5b.** Keep LAN-only and rely on Tailscale/WireGuard on the phones. Lower attack surface but requires the VPN to be up whenever Jeff is out.
  - **Recommended:** 5a with strict ntfy auth. Same posture as Discord (publicly reachable with auth). Document tokens in Supabase `credentials` table.

### 5.3 Firewall

- Port 443 on Cox static-1 (70.167.221.51) already routes to Traefik; no router changes needed if going public.
- If LAN-only path chosen, no port-forward needed.

### 5.4 ntfy config sketch (`~/azlab/services/ntfy/server.yml`)

- `base-url: https://ntfy.az-lab.dev`
- `listen-http: ":80"` (Traefik terminates TLS)
- `cache-file: /var/cache/ntfy/cache.db`, `cache-duration: 12h`
- `behind-proxy: true`
- `auth-file: /var/lib/ntfy/auth.db`, `auth-default-access: deny-all`
- `upstream-base-url: https://ntfy.sh` (iOS relay only)
- `attachment-cache-dir: /var/lib/ntfy/attachments`, sane size limits
- Topics: `atlas-tasks`, `ha-alerts`, `grafana`, `wren-ops`, `adhoc`. Per-topic read tokens for phones; write tokens for each source service.

### 5.5 Mobile app setup

- Android: install ntfy from F-Droid (preferred — push via WebSocket, fully self-host) or Play Store. Add `ntfy.az-lab.dev` as default server. Subscribe to topics with read tokens.
- iOS: install ntfy from App Store. Add server. iOS app will register with ntfy.sh upstream automatically on first subscribe; no extra config beyond setting the default server URL.

### 5.6 Integration plan

| Source | Path | Migration |
|---|---|---|
| Atlas task delivery to Jeff | New: POST to `ntfy.az-lab.dev/atlas-tasks` from agent-bus | New channel — no migration. Replaces some Discord task pings. |
| HA alerts (door open, water leak, etc.) | Existing HA REST notify integration → ntfy | Migrate HA-critical alerts off Discord. Keep HA info-level on Discord. |
| Grafana alert contact point | New webhook contact point → ntfy | Migrate critical alerts. Keep warning/info on Discord. |
| Sentinel | Add ntfy notifier in Sentinel's notification config | Sentinel keeps Discord + dashboard outputs unchanged. ntfy added as a parallel high-priority output. |
| Ad-hoc CLI / scripts | `curl -d "msg" -H "Authorization: Bearer …" https://ntfy.az-lab.dev/adhoc` | New capability. |

### 5.7 What stays on Discord

- Agent-to-agent chatter
- Daily research digests, breakthrough watch
- Non-urgent Sentinel events
- Anything currently routed there that isn't time-sensitive

### 5.8 Anti-storm guardrails (per Jeff's memory-loss UX needs)

- Per-topic rate caps in ntfy where supported; otherwise enforce upstream in Sentinel/agent-bus before posting.
- Use ntfy priority levels strictly: P5 (urgent) reserved for HA safety + Sentinel-critical only; default P3.
- Use ntfy's dedup via `X-Dedup` header or stable message IDs for repeating alerts (e.g., disk usage every 5 min should collapse, not pile up).
- Quiet hours: ntfy supports server-side per-topic schedules; configure `atlas-tasks` and `grafana` warn-level to be quiet 23:00–07:00 local.

---

## 6. Open questions for Jeff before deployment

1. **Public or VPN-only?** §5.2 — recommended public-with-auth, but Jeff's call.
2. **iOS in scope right now?** Confirms whether we need the upstream-relay caveat at all. If Android-only suffices, ntfy stays fully end-to-end self-hosted.
3. **Are there events Jeff explicitly does NOT want to ever land on the phone?** (e.g., research digests, low-sev Sentinel.) Helps lock topic ACLs at deploy time.
4. **Sentinel wrinkles session:** worth landing the ntfy notifier *after* the upcoming Sentinel cleanup session so we don't pile changes on a half-fixed config.

---

## 7. Estimated effort (if approved)

- Compose unit + server.yml + auth seeding: ~30 min
- Cloudflare DNS record + Traefik labels: ~10 min
- HA + Grafana webhook contact points: ~20 min
- Sentinel notifier addition: ~30 min (1 file in `~/azlab/services/sentinel/src/`)
- Mobile app install + topic subscribe: ~10 min
- **Total:** ~2 hours, single session.

---

## 8. Decision

**Pending Jeff's green-light.** No deployment actions taken under this task.
