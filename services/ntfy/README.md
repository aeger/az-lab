# ntfy — self-hosted mobile push (az-lab)

Fills the mobile-push gap (Discord is noisy, Sentinel is desktop-only, dashboard
is pull-only). Single Podman container behind Traefik + LE. Sentinel stays the
alerting brain; ntfy is an added transport.

Design doc: `~/azlab/docs/notification-service-evaluation.md`.
Program plan: `~/azlab/docs/plans/2026-07-01-azlab-modernization-and-max-plan-migration.md` (Phase 2).

## Decisions (Jeff, 2026-07-01)

| Decision | Choice |
|----------|--------|
| Exposure | **Public-with-auth** — websecure, NO `lan-allow`; ntfy enforces `deny-all` + per-topic tokens |
| Platform | **Android-only** — no `upstream-base-url`; fully self-hosted end-to-end (no ntfy.sh relay) |
| Never push to phone | **low-severity Sentinel events** and **agent-to-agent chatter** — Discord/dashboard only (not ntfy topics) |

## Topics

| Topic | Purpose | Writers |
|-------|---------|---------|
| `atlas-tasks` | Task delivery to Jeff | agent-bus |
| `ha-alerts` | HA safety alerts (door/leak/etc.) | Home Assistant |
| `grafana` | Critical Grafana alerts | Grafana contact point |
| `wren-ops` | Wren infra events / "Needs Jeff" | Wren, agent-bus |
| `adhoc` | One-off CLI pings | any script |

Excluded by policy (stay on Discord, NOT ntfy topics): low-sev Sentinel, agent chatter.
Reserve **priority 5** for HA safety + Sentinel-critical only; default P3.

## Deploy runbook

DNS: `ntfy.az-lab.dev` already resolves publicly via the `*.az-lab.dev`
wildcard → `70.167.221.51` (Traefik). LE cert auto-issues via DNS-01 on first
request. For LAN devices add an AdGuard per-host rewrite (split-DNS is per-host,
NOT wildcard here): `ntfy.az-lab.dev → 192.168.1.181` at 192.168.99.2.

```bash
# 1. systemd drop-in (mono-repo services need WorkingDirectory override)
mkdir -p ~/.config/systemd/user/compose-stack@ntfy.service.d
cat > ~/.config/systemd/user/compose-stack@ntfy.service.d/override.conf <<'EOF'
[Service]
WorkingDirectory=/home/almty1/azlab/services/ntfy
EOF
systemctl --user daemon-reload

# 2. pull + start (deny-all in server.yml means it is SAFE the instant it is public)
cd ~/azlab/services/ntfy && podman pull binwiederhier/ntfy:latest
systemctl --user enable --now compose-stack@ntfy.service
# or: podman compose up -d

# 3. verify container + local health (before trusting public)
podman ps --filter name=ntfy
podman exec ntfy wget -qO- http://localhost:80/v1/health   # {"healthy":true}

# 4. verify Traefik picked up the router + cert
curl -s -o /dev/null -w '%{http_code}\n' https://ntfy.az-lab.dev/v1/health   # expect 200

# 5. seed auth — users + per-topic ACLs (deny-all is the default)
# GOTCHA: `ntfy access` takes ONE topic per invocation. A comma-separated list
# (`atlas-tasks,wren-ops`) fails with "invalid argument" on ntfy 2.26.3 — loop instead.
# `ntfy user add` reads the password from $NTFY_PASSWORD, so it can run non-interactively.
ic(){ podman exec ntfy ntfy "$@"; }              # helper
NTFY_PASSWORD=... podman exec -e NTFY_PASSWORD ntfy ntfy user add --role=admin admin
NTFY_PASSWORD=... podman exec -e NTFY_PASSWORD ntfy ntfy user add jeff   # phone reader
for t in atlas-tasks ha-alerts grafana wren-ops adhoc; do ic access jeff "$t" rw; done

# 6. write-only service tokens (one per source; store each in Supabase credentials)
for svc in sentinel homeassistant grafana agent-bus adhoc; do
  NTFY_PASSWORD=... podman exec -e NTFY_PASSWORD ntfy ntfy user add "svc-$svc"
done
for t in atlas-tasks wren-ops; do ic access svc-agent-bus "$t" write-only; done
ic access svc-homeassistant ha-alerts write-only
ic access svc-grafana    grafana      write-only
ic access svc-sentinel   wren-ops     write-only
ic access svc-adhoc      adhoc        write-only
ic token add svc-agent-bus   # → returns tk_...  (repeat per svc, store tokens in Supabase)
```

## Integration (after deploy)

- **agent-bus**: POST `https://ntfy.az-lab.dev/atlas-tasks` (Bearer svc-agent-bus token) for task delivery + "Needs Jeff".
- **HA**: REST notify → `ha-alerts` for safety-critical only; info stays on Discord.
- **Grafana**: webhook contact point → `grafana` for critical alerts.
- **Sentinel**: add an ntfy notifier for **critical** only (never low-sev). One file in `~/azlab/services/sentinel/src/`.
- **ad-hoc**: `curl -H "Authorization: Bearer <svc-adhoc>" -d "msg" https://ntfy.az-lab.dev/adhoc`
- Wire agent "Needs Jeff" + future Council "escalate to Jeff" (Phase 5) to `wren-ops` at **P5**.

## Notes

- `server.yml` is bind-mounted `:ro`. If the host enforces SELinux and ntfy
  can't read it, change the mount to `:ro,z`.
- Rollback: `systemctl --user disable --now compose-stack@ntfy.service` — additive
  service, removing it drops the Traefik router; no other service is affected.
- Sequencing (per plan): land after the Sentinel cleanup so ntfy notifier isn't
  added to a half-fixed Sentinel config.

## Deploy status — 2026-07-28 (Jeff: "Option A is a go")

Deployed on svc-podman-01: ntfy 2.26.3, `compose-stack@ntfy.service` enabled,
LE cert issued (CN=ntfy.az-lab.dev, expires 2026-10-26), auth seeded
(7 users, per-topic ACLs, 5 write-only service tokens).

Verified via the local edge (`curl --resolve ntfy.az-lab.dev:443:192.168.1.181`):
health 200, anonymous publish 403, authed publish 200, wrong-topic-with-token 403.

**OPEN — inbound reachability unverified.** The whole point of Option A is off-LAN
Android push, and that is NOT yet confirmed working:

- WAN egress IP is **70.166.111.99**, but every `az-lab.dev` A record (including the
  `*` wildcard) points at **70.167.221.51**. `cf-ddns` is **not running** (no container).
- An external fetch of `https://ntfy.az-lab.dev/v1/health` returned `ECONNREFUSED
  70.167.221.51:443`. `https://az-lab.dev/` from outside failed identically, so this
  is an **edge-wide** condition, not ntfy-specific.
- Hairpin NAT does not work from svc-podman-01, so it cannot self-test the public path.

Next step is Jeff's: install the ntfy Android app, point it at `https://ntfy.az-lab.dev`,
log in as `jeff`, and try it **on cellular with WiFi off**. If it fails, the fix is at
the RB5009 / Cox edge (443 forward on the static, or DNS pointed at the wrong IP) — not
in this stack. Nothing here changes either way; ntfy already works on-LAN.

**Credentials NOT yet in the Supabase store.** They are on svc-podman-01 at
`~/.ntfy-credentials` (0600) pending an admin token at `~/.secret-drop/az-admin-token`;
`upsert_credential` requires it. Move them and shred the file.
