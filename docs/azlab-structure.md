azlab/
├── README.md
├── infrastructure/
│   ├── traefik/              # Traefik config + compose
│   ├── authelia/             # Authelia config + compose
│   ├── dns/                  # AdGuard/DNS configs
│   └── network/              # RouterOS exports, VLAN docs
├── services/
│   ├── dashboard/            # This repo (git subtree or just move it)
│   ├── immich/               # Compose + env template
│   ├── rustdesk/             # Compose + config
│   ├── portainer/            # Quadlet files
│   └── grafana/              # Dashboards + provisioning
├── hosts/
│   ├── ms-01/                # Proxmox notes, VM inventory
│   └── svc-podman-01/        # Quadlets, systemd units
├── scripts/                  # Deploy helpers, backup scripts
├── docs/                     # Architecture, runbooks, decisions
│   ├── architecture.md
│   ├── networking.md
│   └── disaster-recovery.md
└── .env.example              # Template for all secrets
