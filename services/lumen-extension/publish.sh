#!/usr/bin/env bash
# Build Lumen, package dist/ into lumen-dist.zip, and publish to the static
# server's pub/ dir (served at https://lumen.az-lab.dev/). The desktop updater
# diffs lumen-dist.zip.sha256 to decide whether to pull a new build.
#
# Usage:
#   ./publish.sh           # full: npm run build, then package + publish
#   ./publish.sh --no-build # package the existing dist/ without rebuilding
set -euo pipefail

cd "$(dirname "$0")"
ROOT="$PWD"
PUB="$ROOT/pub"

if [[ "${1:-}" != "--no-build" ]]; then
  echo "[publish] building (npm run build)…"
  npm run build
fi

if [[ ! -f "$ROOT/dist/manifest.json" ]]; then
  echo "[publish] ERROR: dist/manifest.json missing — build first." >&2
  exit 1
fi

VER=$(grep -m1 '"version"' "$ROOT/dist/manifest.json" | sed -E 's/.*"version" *: *"([^"]+)".*/\1/')
echo "[publish] packaging Lumen v$VER…"

# Zip the CONTENTS of dist/ so manifest.json sits at the zip root (required for
# Edge "Load unpacked" after extraction). Uses python3 zipfile (no `zip` dep).
rm -f "$ROOT/lumen-dist.zip"
python3 - "$ROOT/dist" "$ROOT/lumen-dist.zip" <<'PY'
import sys, os, zipfile
src, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
    for root, _, files in os.walk(src):
        for f in sorted(files):
            full = os.path.join(root, f)
            z.write(full, os.path.relpath(full, src))
PY

mkdir -p "$PUB"
cp -f "$ROOT/lumen-dist.zip" "$PUB/lumen-dist.zip"
sha256sum "$PUB/lumen-dist.zip" | awk '{print $1}' > "$PUB/lumen-dist.zip.sha256"
printf '%s\n' "$VER" > "$PUB/version.txt"

echo "[publish] done — v$VER  sha256=$(cat "$PUB/lumen-dist.zip.sha256")"
echo "[publish] live at https://lumen.az-lab.dev/lumen-dist.zip"
