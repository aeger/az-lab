# AZ-Lab Home Dashboard

A self-hosted family and homelab dashboard built with Next.js, designed to run behind Traefik on a Podman-based infrastructure.

![Next.js](https://img.shields.io/badge/Next.js-16-black?logo=next.js)
![React](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![Tailwind CSS](https://img.shields.io/badge/Tailwind_CSS-4-06B6D4?logo=tailwindcss)

## Overview

Two-view dashboard serving both family and homelab needs:

- **Family View** (`/`) — Clock, weather, Google Calendar, Immich photo slideshow, news feeds, quick links, and a message banner
- **Lab View** (`/lab`) — Service monitoring, host metrics, container management, network/DNS stats, and tech news

## Features

### Family View
- **Google Calendar** — Full CRUD with multi-calendar support, recurring events, month grid with event dots, and agenda view
- **Photo Slideshow** — Rotating photos from Immich with proxy support
- **Weather** — Current conditions and forecast via Open-Meteo (no API key needed)
- **News** — RSS feeds with Reddit JSON API support, file-based caching, and feed management UI
- **Message Banner** — Configurable announcement banner with severity levels (info, success, warning, alert)
- **Quick Links** — Configurable shortcuts to frequently used services

### Lab View
- **Service Status** — Real-time monitoring via Uptime Kuma
- **Host Metrics** — CPU, RAM, and disk usage from Prometheus/node_exporter
- **Container List** — Running containers from Portainer
- **Network Stats** — DNS query stats and blocking info from AdGuard Home
- **RustDesk** — Remote desktop status via TCP probe
- **Tech News** — Curated RSS feeds for homelab/self-hosted content

## Tech Stack

| Component | Technology |
|-----------|-----------|
| Framework | Next.js 16 (App Router, standalone output) |
| UI | React 19, Tailwind CSS 4 |
| Language | TypeScript 5 |
| Container | Podman (rootless), multi-stage Dockerfile |
| Reverse Proxy | Traefik |
| Config | YAML (volume-mounted) |

## Integrations

| Service | Purpose | Auth |
|---------|---------|------|
| Google Calendar | Calendar events CRUD | Service account (JWT) |
| Immich | Photo slideshow | API key |
| Uptime Kuma | Service monitoring | Unauthenticated (internal) |
| Prometheus | Host metrics | Unauthenticated (internal) |
| Portainer | Container management | API key |
| AdGuard Home | DNS/network stats | Username/password |
| RustDesk | Remote desktop status | TCP probe |
| Open-Meteo | Weather data | No auth needed |

## Quick Start

### Prerequisites
- Podman with `podman-compose`
- Traefik reverse proxy (or adapt for your setup)
- Services you want to integrate (Immich, Uptime Kuma, etc.)

### 1. Configure

Copy and edit the config file:

```bash
cp config/dashboard.yaml.example config/dashboard.yaml
```

Create a `.env` file with your secrets:

```env
IMMICH_URL=http://immich-server:2283
IMMICH_API_KEY=your-key
UPTIME_KUMA_URL=http://uptime-kuma:3001
PROMETHEUS_URL=http://prometheus:9090
PORTAINER_URL=http://portainer:9000
PORTAINER_API_KEY=your-key
ADGUARD_URL=http://your-adguard-ip
ADGUARD_USERNAME=admin
ADGUARD_PASSWORD=your-password
GOOGLE_SERVICE_ACCOUNT_KEY=base64-encoded-json
GOOGLE_CALENDAR_IDS=calendar1@gmail.com,calendar2@gmail.com
ADMIN_SECRET=your-admin-secret
RUSTDESK_HOST=your-rustdesk-host
RUSTDESK_KEY=your-key
```

### 2. Deploy

```bash
podman compose build dashboard
podman compose up -d dashboard
```

### 3. Access

The dashboard will be available at your configured domain (e.g., `https://home.your-domain.dev`).

## Project Structure

```
app/
├── page.tsx                    # Family view (/)
├── lab/page.tsx                # Lab view (/lab)
└── api/                        # API routes
    ├── calendar/               # Google Calendar CRUD
    ├── containers/             # Portainer containers
    ├── dns/                    # AdGuard stats
    ├── feeds/                  # Feed management
    ├── message/                # Banner message
    ├── metrics/                # Prometheus metrics
    ├── news/                   # RSS news
    ├── photos/                 # Immich photos
    ├── rustdesk/               # RustDesk status
    ├── services/               # Uptime Kuma monitors
    └── weather/                # Open-Meteo weather
components/
├── family/                     # Family view widgets
│   ├── calendar/               # Calendar sub-components
│   ├── CalendarWidget.tsx
│   ├── ClockWidget.tsx
│   ├── MessageBlock.tsx
│   ├── NewsWidget.tsx
│   ├── PhotoSlideshow.tsx
│   ├── QuickLinks.tsx
│   └── WeatherWidget.tsx
├── lab/                        # Lab view widgets
└── shared/                     # Shared components
lib/                            # Service integrations
config/
└── dashboard.yaml              # Dashboard configuration
```

## Configuration

All configuration is in `config/dashboard.yaml` (volume-mounted, read-only). Secrets are passed via environment variables through `compose.yml`.

The config file controls:
- Weather location and units
- Quick links for both views
- News feed sources
- Prometheus host targets
- Lab service URLs

## Google Calendar Setup

1. Create a Google Cloud project and enable the Calendar API
2. Create a service account and download the JSON key
3. Base64-encode the key: `base64 -w 0 < key.json`
4. Set `GOOGLE_SERVICE_ACCOUNT_KEY` env var with the encoded value
5. Share your calendars with the service account email
6. Set `GOOGLE_CALENDAR_IDS` with comma-separated calendar IDs

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.
