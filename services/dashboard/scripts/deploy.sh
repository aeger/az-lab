#!/usr/bin/env bash
# Deploy dashboard: sync source → build context, rebuild image, restart container
# data/ is excluded — it's a bind-mounted runtime directory, not source
set -e

SRC="$HOME/dashboard"
DST="$HOME/azlab/services/dashboard"

echo "[deploy] Syncing source to build context..."
rsync -a --delete \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.next' \
  --exclude='data/' \
  --exclude='docs/' \
  "$SRC/" "$DST/"

echo "[deploy] Building image..."
cd "$DST"
podman compose build --no-cache

echo "[deploy] Restarting container..."
podman compose down
podman compose up -d

echo "[deploy] Done."
