# Webtop

Ubuntu XFCE remote desktop via [linuxserver/webtop](https://docs.linuxserver.io/images/docker-webtop/).

## Access

- URL: `https://svc-podman-01.az-lab.dev`
- Auth: Authelia (forward auth via Traefik)
- Network: LAN-only (192.168.1.0/24, 10.7.0.0/24)

## Quick Start

```bash
cp .env.example .env    # adjust if needed
podman compose up -d
```

## Files

| File | Purpose |
|------|---------|
| `compose.yml` | Podman compose definition |
| `.env` | Runtime configuration (not committed) |
| `.env.example` | Template for .env |
| `config/` | Persistent desktop data (volume mount, not committed) |

## Traefik

Dynamic config lives at `~/traefik/dynamic/webtop.yml` (outside this repo).
Routes `svc-podman-01.az-lab.dev` → container port 3000 with `lan-allow` + `authelia-auth` middlewares.

## Resource Limits

- CPU: 4 cores
- Memory: 4GB (512MB reserved)
- Shared memory: 1GB
