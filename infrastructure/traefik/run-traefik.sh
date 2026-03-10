#!/usr/bin/env bash
set -euo pipefail

# Traefik v3 rootless Podman runner (Docker provider + File provider)
# - Network: proxy
# - Env: ~/traefik/cf.env (Cloudflare token, etc.)
# - Data: ~/traefik/data (acme.json)
# - Secrets: ~/traefik/secrets (htpasswd)
# - Dynamic config: ~/traefik/dynamic (*.yml)
# - Local certs: ~/traefik/certs (home-arpa.crt/key etc.)

TRAEFIK_HOSTNAME="traefik.az-lab.dev"
ACME_EMAIL="almty1@gmail.com"

BASE_DIR="${HOME}/traefik"
CF_ENV_FILE="${BASE_DIR}/cf.env"
DATA_DIR="${BASE_DIR}/data"
SECRETS_DIR="${BASE_DIR}/secrets"
DYNAMIC_DIR="${BASE_DIR}/dynamic"
CERTS_DIR="${BASE_DIR}/certs"

PODMAN_SOCK="/run/user/$(id -u)/podman/podman.sock"

mkdir -p "${DATA_DIR}" "${SECRETS_DIR}" "${DYNAMIC_DIR}" "${CERTS_DIR}"

if [[ ! -f "${CF_ENV_FILE}" ]]; then
  echo "Missing ${CF_ENV_FILE}"
  exit 1
fi

if [[ ! -f "${SECRETS_DIR}/traefik.htpasswd" ]]; then
  echo "Missing ${SECRETS_DIR}/traefik.htpasswd"
  echo "Create with:"
  echo "  htpasswd -nbB admin 'STRONG_PASSWORD' > ${SECRETS_DIR}/traefik.htpasswd"
  exit 1
fi

# Recommended perms for secrets (best-effort)
chmod 600 "${CF_ENV_FILE}" 2>/dev/null || true
chmod 600 "${SECRETS_DIR}/traefik.htpasswd" 2>/dev/null || true

# Ensure network exists
podman network exists proxy 2>/dev/null || podman network create proxy >/dev/null

# Recreate Traefik container cleanly
podman rm -f traefik 2>/dev/null || true

# Build the command as an array to avoid line-continuation/paste corruption.
cmd=(
  podman run -d
  --name traefik
  --restart=unless-stopped
  --network proxy
  --dns=1.1.1.1 --dns=8.8.8.8
  -p 80:80
  -p 443:443
  -p 8080:8080
  --env-file "${CF_ENV_FILE}"
  -v "${PODMAN_SOCK}:/var/run/docker.sock:ro"
  -v "${DATA_DIR}:/data"
  -v "${SECRETS_DIR}:/secrets:ro"
  -v "${DYNAMIC_DIR}:/dynamic:ro"
  -v "${CERTS_DIR}:/certs:ro"

  -l "traefik.enable=true"
  -l "traefik.http.routers.traefik.rule=Host(\`${TRAEFIK_HOSTNAME}\`)"
  -l "traefik.http.routers.traefik.entrypoints=websecure"
  -l "traefik.http.routers.traefik.tls=true"
  -l "traefik.http.routers.traefik.tls.certresolver=le"
  -l "traefik.http.routers.traefik.service=api@internal"
  -l "traefik.http.middlewares.traefik-auth.basicauth.usersfile=/secrets/traefik.htpasswd"
  -l "traefik.http.middlewares.traefik-allow.ipallowlist.sourcerange=192.168.1.0/24,10.7.0.0/24,10.89.0.0/16"
  -l "traefik.http.routers.traefik.middlewares=traefik-allow,traefik-auth"

  docker.io/traefik:v3.1

  --log.level=INFO
  --accesslog=true
  --api.dashboard=true

  --entrypoints.web.address=:80
  --entrypoints.websecure.address=:443
  --entrypoints.web.http.redirections.entrypoint.to=websecure
  --entrypoints.web.http.redirections.entrypoint.scheme=https

  --providers.docker=true
  --providers.docker.endpoint=unix:///var/run/docker.sock
  --providers.docker.exposedbydefault=false

  --providers.file.directory=/dynamic
  --providers.file.watch=true

  --certificatesresolvers.le.acme.email="${ACME_EMAIL}"
  --certificatesresolvers.le.acme.storage=/data/acme.json
  --certificatesresolvers.le.acme.dnschallenge=true
  --certificatesresolvers.le.acme.dnschallenge.provider=cloudflare
  --certificatesresolvers.le.acme.dnschallenge.delaybeforecheck=10
  --certificatesresolvers.le.acme.dnschallenge.resolvers=1.1.1.1:53,8.8.8.8:53
)

echo "=== Running Traefik ==="
printf '%q ' "${cmd[@]}"
echo
echo "======================="

"${cmd[@]}"

echo "Traefik started."
echo "Dashboard: https://${TRAEFIK_HOSTNAME}/"
echo "Dynamic config dir: ${DYNAMIC_DIR}"
echo "Certs dir: ${CERTS_DIR}"
