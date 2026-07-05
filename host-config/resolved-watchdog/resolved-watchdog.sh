#!/bin/bash
# resolved-watchdog — detect a wedged systemd-resolved and restart it.
#
# Background: on 2026-06-29 an AdGuard (192.168.99.2) blip left systemd-resolved
# stuck returning EMPTY responses for ~2h instead of failing over to its
# fallbacks (1.1.1.1/8.8.8.8). podman aardvark-dns forwards to resolved, so every
# container got EAI_AGAIN and the dashboard widgets hung on 10s timeouts. A simple
# `systemctl restart systemd-resolved` cleared it instantly. This watchdog does
# that automatically.
#
# Logic: probe the local stub resolver (127.0.0.53 via getent) up to 3x. If all
# fail, resolved is wedged (or DNS is genuinely down — restart is harmless either
# way). Restarting is cheap and non-disruptive.
set -u

PROBE_NAMES=(cloudflare.com google.com one.one.one.one)

for attempt in 1 2 3; do
  name="${PROBE_NAMES[$((attempt-1))]}"
  if getent hosts "$name" >/dev/null 2>&1; then
    exit 0   # DNS healthy
  fi
  sleep 2
done

logger -t resolved-watchdog "systemd-resolved unhealthy (3x DNS lookup failure) — restarting"
systemctl restart systemd-resolved
# Give it a moment, then verify so the log shows the outcome.
sleep 2
if getent hosts cloudflare.com >/dev/null 2>&1; then
  logger -t resolved-watchdog "restart OK — DNS resolving again"
else
  logger -t resolved-watchdog "restart did NOT recover DNS — likely upstream/network outage"
fi
