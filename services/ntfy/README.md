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
ic(){ podman exec ntfy ntfy "$@"; }              # helper
ic user add --role=admin admin                    # prompts for password → store in Supabase credentials
ic user add jeff                                   # phone reader
ic access jeff atlas-tasks,ha-alerts,grafana,wren-ops,adhoc rw

# 6. write-only service tokens (one per source; store each in Supabase credentials)
for svc in sentinel homeassistant grafana agent-bus adhoc; do ic user add "svc-$svc"; done
ic access svc-agent-bus  atlas-tasks,wren-ops write-only
ic access svc-homeassistant ha-alerts        write-only
ic access svc-grafana    grafana             write-only
ic access svc-sentinel   wren-ops            write-only
ic access svc-adhoc      adhoc               write-only
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
