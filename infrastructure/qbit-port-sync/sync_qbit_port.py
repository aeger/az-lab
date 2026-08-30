#!/usr/bin/env python3
"""Keep qBittorrent's listen port equal to gluetun's forwarded port.

Why this exists
---------------
Every time the downloads stack is recreated, gluetun negotiates a NEW
forwarded port with the VPN provider (observed 59165 -> 52459 -> 59220 over
three recreates in six days). qBittorrent's `Session\\Port` does not follow.
When they disagree, inbound peer connections land on a port nothing is
listening on: torrents still work, but only via outbound connections, so it
degrades quietly rather than failing loudly. It was hand-synced three times
before this script existed.

gluetun can also re-negotiate mid-session without any container restart -- its
log shows "port forwarding" refresh failures followed by a new port -- which is
why this runs on a timer rather than only at stack start.

How
---
qBittorrent's config file is owned by the container user and is rewritten from
memory on shutdown, so editing it on disk requires stopping the container and
`podman unshare`. The WebUI API avoids all of that: `WebUI\\LocalHostAuth=false`
means requests from inside the netns need no credentials, and setPreferences
applies immediately AND persists. No restart, no interrupted torrents.

Exit codes: 0 = in sync (changed or already correct), 1 = could not sync.
"""

import json
import subprocess
import sys

GLUETUN = 'gluetun'
QBIT = 'qbittorrent'
PORT_FILE = '/tmp/gluetun/forwarded_port'
API = 'http://localhost:8080/api/v2'


def podman(*args: str, timeout: int = 20) -> tuple[int, str]:
    try:
        r = subprocess.run(['podman', *args], capture_output=True,
                           text=True, timeout=timeout)
        return r.returncode, (r.stdout or '').strip()
    except (subprocess.TimeoutExpired, OSError) as e:
        return 1, f'{type(e).__name__}: {e}'


def running(container: str) -> bool:
    rc, out = podman('inspect', container, '--format', '{{.State.Status}}')
    return rc == 0 and out == 'running'


def forwarded_port() -> int | None:
    rc, out = podman('exec', GLUETUN, 'cat', PORT_FILE)
    if rc != 0 or not out.isdigit():
        return None
    port = int(out)
    return port if 1 <= port <= 65535 else None


def listen_port() -> int | None:
    rc, out = podman('exec', QBIT, 'curl', '-s', '-m', '10',
                     f'{API}/app/preferences')
    if rc != 0 or not out:
        return None
    try:
        return int(json.loads(out).get('listen_port'))
    except (json.JSONDecodeError, TypeError, ValueError):
        return None


def set_listen_port(port: int) -> bool:
    # setPreferences takes a form field named `json` holding a JSON object.
    rc, _ = podman('exec', QBIT, 'curl', '-s', '-m', '10', '-f',
                   '-X', 'POST', f'{API}/app/setPreferences',
                   '--data-urlencode', f'json={{"listen_port":{port}}}')
    return rc == 0


def main() -> int:
    for c in (GLUETUN, QBIT):
        if not running(c):
            # Not an error worth alerting on: the stack is legitimately down or
            # mid-restart. Say so and exit clean so the timer stays green.
            print(f'{c} is not running — nothing to sync')
            return 0

    want = forwarded_port()
    if want is None:
        print('could not read gluetun forwarded port — is port forwarding up?',
              file=sys.stderr)
        return 1

    have = listen_port()
    if have is None:
        print('could not read qBittorrent listen_port from the WebUI API',
              file=sys.stderr)
        return 1

    if have == want:
        print(f'in sync: {want}')
        return 0

    if not set_listen_port(want):
        print(f'failed to set listen_port {have} -> {want}', file=sys.stderr)
        return 1

    confirmed = listen_port()
    if confirmed != want:
        print(f'set accepted but readback shows {confirmed}, expected {want}',
              file=sys.stderr)
        return 1

    print(f'listen_port {have} -> {want}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
