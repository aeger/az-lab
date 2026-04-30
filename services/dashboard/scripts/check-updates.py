#!/usr/bin/env python3
"""
Check running podman containers for image updates.
Writes results to data/updates.json for the dashboard widget.
Skips locally-built images (localhost/ prefix).
"""
import json, subprocess, sys, os
from datetime import datetime, timezone
from pathlib import Path

OUTPUT = Path('/home/almty1/azlab/services/dashboard/data/updates.json')

# Containers to skip (locally built, no registry to check)
SKIP_PREFIXES = ('localhost/',)

def get_running_containers():
    result = subprocess.run(
        ['podman', 'ps', '--format', 'json'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return []
    containers = json.loads(result.stdout)
    return [
        {'name': c['Names'][0], 'image': c['Image']}
        for c in containers
        if not any(c['Image'].startswith(p) for p in SKIP_PREFIXES)
    ]

def get_local_digest(image):
    result = subprocess.run(
        ['podman', 'image', 'inspect', image, '--format', '{{index .RepoDigests 0}}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return None
    digest = result.stdout.strip()
    return digest if '@sha256:' in digest else None

def get_remote_digest(image):
    """Pull image manifest without downloading layers using podman manifest inspect."""
    result = subprocess.run(
        ['podman', 'manifest', 'inspect', image],
        capture_output=True, text=True, timeout=30
    )
    if result.returncode == 0:
        try:
            data = json.loads(result.stdout)
            # For manifest lists, get the first platform digest
            if 'manifests' in data:
                return data['manifests'][0].get('digest')
            return data.get('config', {}).get('digest')
        except Exception:
            pass
    return None

def check_update_via_pull(container_name, image):
    """
    Pull the image and compare the new ID with the running container's image ID.
    Returns True if an update was pulled.
    """
    # Get current image ID of running container
    result = subprocess.run(
        ['podman', 'inspect', container_name, '--format', '{{.Image}}'],
        capture_output=True, text=True
    )
    if result.returncode != 0:
        return False
    current_id = result.stdout.strip()

    # Pull latest
    result = subprocess.run(
        ['podman', 'pull', '--quiet', image],
        capture_output=True, text=True, timeout=120
    )
    if result.returncode != 0:
        return False
    new_id = result.stdout.strip()

    return bool(new_id) and new_id != current_id

def main():
    containers = get_running_containers()
    print(f"Checking {len(containers)} containers for updates...", flush=True)

    results = []
    for c in containers:
        name = c['name']
        image = c['image']
        print(f"  {name} ({image})...", end=' ', flush=True)
        try:
            has_update = check_update_via_pull(name, image)
            status = 'UPDATE' if has_update else 'current'
            print(status)
        except subprocess.TimeoutExpired:
            has_update = False
            print('timeout')
        except Exception as e:
            has_update = False
            print(f'error: {e}')

        results.append({
            'name': name,
            'image': image,
            'has_update': has_update,
        })

    output = {
        'checked_at': datetime.now(timezone.utc).isoformat(),
        'containers': results,
    }

    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUTPUT, 'w') as f:
        json.dump(output, f, indent=2)

    updates = [r for r in results if r['has_update']]
    print(f"\nDone. {len(updates)} updates available: {[u['name'] for u in updates]}")

if __name__ == '__main__':
    main()
