# az-lab

Home lab infrastructure mono repo for the az-lab.dev environment.

## Structure

```
azlab/
├── infrastructure/       # Core infra (Traefik, Authelia, DNS, network)
│   ├── traefik/
│   ├── authelia/
│   ├── dns/
│   └── network/
├── services/             # Application containers
│   └── webtop/           # LinuxServer.io Webtop (Ubuntu XFCE)
├── hosts/                # Host-specific configs and notes
│   ├── ms-01/            # Proxmox host (MINISFORUM MS-01)
│   └── svc-podman-01/    # Podman VM (primary container host)
├── scripts/              # Deploy helpers, backup scripts
└── docs/                 # Architecture, runbooks, decisions
```

## Hosts

| Host | Hardware | Role |
|------|----------|------|
| **ms-01** | MINISFORUM MS-01, i9-13900H, 32GB DDR5, 1TB SSD + 4TB NVMe | Proxmox hypervisor |
| **svc-podman-01** | VM on ms-01 | Rootless Podman container host |

## Services

| Service | URL | Status |
|---------|-----|--------|
| Webtop | `https://svc-podman-01.az-lab.dev` | Active |

## Network

- Domain: `az-lab.dev` (Cloudflare DNS)
- LAN: `192.168.1.0/24`
- Router: MikroTik RB5009UPr+S+in
- Switch: MikroTik CRS309-1G-8S+in (10G)
- Reverse proxy: Traefik v3.1 (rootless Podman)
- Auth: Authelia (forward auth)
- DNS filtering: AdGuard Home (RouterOS container)

## Getting Started

1. Clone this repo to `~/azlab` on svc-podman-01
2. Copy `.env.example` to the relevant service directory as `.env`
3. Start services with `podman compose up -d` from their directory

## License

[MIT](LICENSE)
