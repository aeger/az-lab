# az-lab

Home lab mono repo — infrastructure, services, and agentic automation stack running on `svc-podman-01`.

## Overview

`az-lab` is a self-hosted home lab built on Podman Compose and deployed on a single production VM (`svc-podman-01`, 192.168.1.181, VLAN 10). All services are managed from this mono repo. The repo also houses the agentic automation layer — a multi-Claude system with shared Supabase memory, an inter-agent message bus, and a persistent task queue.

- **Repo:** `github.com/aeger/az-lab` — branches: `main` (stable), `beta` (staging)
- **Host:** svc-podman-01 — Proxmox VM, user `almty1`, linger enabled
- **ISP:** Cox Business 2 Gbps, static IPs: `70.167.221.51` (services), `70.167.221.52` (game DMZ)
- **Domain:** `*.az-lab.dev` via Cloudflare (DNS-01 certs, split-DNS via AdGuard)

---

## Repo Structure

```
azlab/
├── infrastructure/
│   ├── traefik/          # Traefik v3 reverse proxy
│   ├── authelia/         # Authelia SSO
│   ├── cf-ddns/          # Cloudflare DDNS updater
│   └── task-queue/       # Claude Code task queue poller
├── services/
│   ├── dashboard/        # Compose only (source at ~/dashboard/)
│   ├── monitoring/       # Prometheus, Grafana, node_exporter, cadvisor, blackbox, snmp
│   ├── memory-mcp-server/# Custom MCP server (v3.3.0) — agent memory layer
│   ├── lldap/            # LLDAP directory (LDAP :3890, Web UI :17170)
│   ├── webtop/           # Linuxserver Webtop
│   ├── rustdesk/         # RustDesk relay server
│   ├── changedetect/     # Change detection monitoring
│   ├── drydock/          # DryDock container monitor
│   ├── gmail-mcp-server/ # Gmail MCP server
│   └── website/          # Landing page (Astro + Caddy, www.az-lab.dev)
└── README.md
```

---

## Networking

| VLAN | Name  | Subnet              | Notes                        |
|------|-------|---------------------|------------------------------|
| 10   | Main  | 192.168.1.0/24      | Servers, workstations, APs   |
| 20   | IoT   | 192.168.20.0/24     | Smart home devices           |
| 30   | Game  | 192.168.30.0/24     | Game server DMZ              |
| 99   | Mgmt  | 192.168.99.0/24     | Network gear management      |

- **Router:** MikroTik RB5009UPr+S+in (`192.168.1.1`), RouterOS 7.22
- **Switch:** MikroTik CRS309-1G-8S+in (`192.168.99.248`)
- **AP:** Ubiquiti U7 Pro XGS (`192.168.1.246`), UniFi Express 7 mesh (`192.168.1.194`)
- **DNS:** AdGuard Home (`192.168.99.2`, VLAN 99) — internal split-DNS
- **Proxy network:** `10.89.0.0/24` (Podman internal)

---

## Services

| Service           | URL / Port                        | Notes                              |
|-------------------|-----------------------------------|------------------------------------|
| Dashboard         | https://home.az-lab.dev           | Views: / (family), /lab, /haos     |
| Traefik           | https://traefik.az-lab.dev        | v3 reverse proxy + TLS termination |
| Authelia          | http://192.168.1.181:9091         | SSO — protects internal services   |
| Grafana           | https://grafana.az-lab.dev        | 4 provisioned dashboards           |
| Home Assistant    | https://ha.az-lab.dev             | Proxmox VM 107, 192.168.1.161:8123 |
| LLDAP             | http://192.168.1.181:17170        | Directory — LDAP backend           |
| Webtop            | https://webtop.az-lab.dev         | Browser-based Linux desktop        |
| RustDesk          | svc-podman-01:21115-21119         | Self-hosted remote desktop relay   |
| Website           | https://www.az-lab.dev            | Astro static site + Caddy          |
| memory-mcp-server | http://svc-podman-01:3100         | Agent memory MCP (v3.4.0)          |
| Agent Bus         | http://svc-podman-01:8765         | Inter-agent HTTP + MCP server      |

---

## Service Management

Services run as systemd user units under `almty1` (linger enabled).

**Template unit:** `~/.config/systemd/user/compose-stack@.service`
- `WorkingDirectory=%h/%i` — resolves to `~/servicename`
- Mono repo services use drop-in overrides (since `%i` can't handle `/` in paths)

**Overrides exist for:** traefik, cf-ddns, authelia, rustdesk, monitoring, changedetect, lldap, website, drydock

```bash
# Start a service
systemctl --user start compose-stack@services-monitoring

# View logs
journalctl --user -u compose-stack@services-monitoring -f

# Trigger manual task queue poll
systemctl --user start claude-queue-poll@jeff.service
```

---

## Agentic Layer

The home lab runs a multi-agent Claude system. Each interface has a name and role:

| Agent  | Interface              | Role                                      |
|--------|------------------------|-------------------------------------------|
| Wren   | Claude Code (VM)       | Workhorse — executes tasks, git ops, infra|
| Iris   | Cowork (claude.ai)     | Orchestration, planning, memory mgmt      |
| Atlas  | Claude Desktop (Win)   | Windows-side ops, desktop tasks           |
| Forge  | Claude Code (Desktop)  | Desktop-side code execution               |
| Volt   | Nemotron 120B (VM 108) | Free inference for bulk/non-critical tasks|
| Hermes | Agent Bus (:8765)      | Message routing, trigger dispatch         |

### Shared Memory

- **Supabase project:** `azlab-memory` (ogqjjlbupqnvlcyrfnxi.supabase.co)
- **memory-mcp-server v3.4.0:** 18 tools — memory CRUD, hybrid recall (BM25+vector RRF fusion), Zettelkasten auto-links, conflict detection, skills, R2 file storage (incl. `store_file`/`get_file` for large objects >8KB), HA control
- **Decay scoring:** 80% semantic + 20% recency/use frequency

### Task Queue

Cross-Claude work queue in `azlab-memory.task_queue`. Any agent can insert tasks; Wren polls every 5 minutes via systemd timer, claims and executes them, and writes results back.

```bash
# Watch poller logs
journalctl --user -u claude-queue-poll@jeff.service -f
```

### Agent Bus

Python HTTP server at `~/claude/agent-bus/` on port 8765.

- `POST /trigger` — fire system_check / maintenance / ha_presence triggers
- `POST /message` — send a message to an agent
- `GET /health` — server health
- `POST /mcp` — MCP protocol endpoint (no auth required)
- Auth: `X-Agent-Secret: azlab-agent-bus`

---

## Proxmox Host (MS-01)

- **Address:** 192.168.1.182 (az-lab.az-lab.dev)
- **ZFS pools:** `nvme-fast`, `nvme-fast-02`
- **VMs:** svc-podman-01 (production), Home Assistant VM 107, NemoClaw VM 108
- **PCIe mod:** SMBus pins B5/B6 taped — prevents RAM-halving bug on DDR5

---

## Disaster Recovery Runbook

### Triage Checklist

1. **Can you reach svc-podman-01?**
   - Yes → `systemctl --user status` to identify failed units
   - No → access via Proxmox console at 192.168.1.182

2. **Check service status:**
   ```bash
   systemctl --user list-units --state=failed
   journalctl --user -p err -n 50
   ```

3. **Check Traefik** — if all web services are down, Traefik is likely the culprit:
   ```bash
   systemctl --user restart compose-stack@infrastructure-traefik
   ```

4. **Check Podman network:**
   ```bash
   podman network inspect proxy
   ```

5. **Check disk / ZFS** (on Proxmox host):
   ```bash
   zpool status
   df -h
   ```

### Full Rebuild Procedure

> Use this when svc-podman-01 must be rebuilt from scratch.

#### 0. Retrieve backups from R2 (do this before provisioning the new VM)

Nightly backups are in the `az-lab-backups` R2 bucket. Pull them before rebuilding so you have configs and certs ready.

```bash
# Install AWS CLI (or use wrangler / boto3 script)
pip3 install boto3

# Set R2 credentials — get from Supabase credentials table or a known .env backup
export R2_ACCOUNT_ID=157265a71e207b62e3e2d9f36dcd3f3d
export AWS_ACCESS_KEY_ID=<CF_R2_ACCESS_KEY_ID>
export AWS_SECRET_ACCESS_KEY=<CF_R2_SECRET_ACCESS_KEY>
export R2_ENDPOINT=https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com

# List what's available
aws s3 ls s3://az-lab-backups/ --endpoint-url $R2_ENDPOINT --recursive | sort | tail -40

# Pull latest Traefik configs + acme.json (saves re-issuing LE certs)
LATEST_DATE=$(date -u +%Y-%m-%d)
aws s3 cp s3://az-lab-backups/traefik/${LATEST_DATE}/traefik-configs.tar.gz . \
  --endpoint-url $R2_ENDPOINT
tar -xzf traefik-configs.tar.gz   # extracts acme.json + dynamic/*.yml

# Pull latest Supabase snapshot
aws s3 cp s3://az-lab-backups/supabase/${LATEST_DATE}.json supabase-backup.json \
  --endpoint-url $R2_ENDPOINT

# Pull latest LLDAP data
aws s3 cp s3://az-lab-backups/lldap/${LATEST_DATE}/lldap-data.tar.gz . \
  --endpoint-url $R2_ENDPOINT
tar -xzf lldap-data.tar.gz   # extracts users.db + lldap_config.toml

# Pull AdGuard DNS rewrites
aws s3 cp s3://az-lab-backups/adguard/${LATEST_DATE}/adguard-config.json . \
  --endpoint-url $R2_ENDPOINT
```

> **acme.json** is critical — restoring it prevents re-issuing Let's Encrypt certs (rate-limited to 5/week per domain).

#### 1. Provision the VM
- Create VM in Proxmox with Ubuntu 24.04, min 4 vCPU / 8 GB RAM, VLAN 10
- Set static IP 192.168.1.181 in MikroTik DHCP static lease
- Enable linger: `loginctl enable-linger almty1`

#### 2. Clone the repo
```bash
git clone git@github.com:aeger/az-lab.git ~/azlab
cd ~/azlab
git checkout beta   # or main for stable
```

#### 3. Install Podman + systemd user units
```bash
sudo apt install podman podman-compose
mkdir -p ~/.config/systemd/user
# Copy template unit and drop-in overrides from repo
```

#### 4. Restore secrets
- Retrieve credentials from `azlab-memory` Supabase (credentials table, agent-read role)
- Recreate `.env` files in each service directory
- Restore Traefik `acme.json` from Phase 0 R2 backup → `~/azlab/infrastructure/traefik/data/acme.json`
- Restore Traefik dynamic configs from Phase 0 R2 backup → `~/azlab/infrastructure/traefik/dynamic/`
- Restore LLDAP `users.db` from Phase 0 R2 backup → `~/azlab/services/lldap/data/`

#### 5. Start infrastructure first
```bash
systemctl --user start compose-stack@infrastructure-traefik
systemctl --user start compose-stack@infrastructure-authelia
```

#### 6. Start services
```bash
for svc in monitoring lldap dashboard memory-mcp-server gmail-mcp-server; do
  systemctl --user start compose-stack@services-$svc
done
```

#### 7. Restore agentic layer
```bash
# Agent Bus
cd ~/claude/agent-bus && python3 agent_bus.py &

# Task queue poller
cd ~/azlab/infrastructure/task-queue
sudo bash install.sh jeff
systemctl --user start claude-queue-poll@jeff.timer
```

#### 8. Verify
```bash
curl http://localhost:8765/health         # Agent Bus
curl http://localhost:3100/health         # memory-mcp-server
systemctl --user list-units --state=failed
```

---

## Development Workflow

```bash
# All work goes to beta first
git checkout beta
git add -p
git commit -m 'feat: ...'
git push origin beta

# Merge to main after validation
git checkout main
git merge beta
git push origin main
```

---

*Last updated: 2026-03-26 — maintained by Wren (Claude Code) and Iris (Cowork)*
