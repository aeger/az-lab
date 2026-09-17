#!/usr/bin/env bash
# bridge-heartbeat.sh — sourced by the watchdog's heartbeat hooks.
#
# `~/.wren-watchdog/heartbeat` is written by hooks that fire in EVERY Claude
# Code session on this host. On 2026-09-17 Jeff SSH'd in from 192.168.1.254 and
# started his own interactive session; its prompts kept that shared file warm
# and the watchdog logged "Recovered to healthy" over and over while the bridge
# sat behind a login wall answering nothing.
#
# So: when the hook is running inside the bridge session, it also stamps
# `heartbeat.bridge`, and that is the file the watchdog trusts. The shared file
# is still written so nothing that reads it today breaks.

WREN_BRIDGE_MATCH="${WREN_BRIDGE_MATCH:---name discord-bridge}"

# True when any ancestor of this hook is the bridge's own `claude` process.
# Process ancestry is used rather than $TMUX or a session id because it is the
# same signal channel-health.ts asserts on, and it needs no cooperation from
# the model or the hook payload.
wren_in_bridge_session() {
  local pid=$$ hops=0 cmdline exe
  while [[ "$pid" != "1" && "$pid" != "0" && -n "$pid" && $hops -lt 20 ]]; do
    cmdline=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null)
    # The ancestor must BE a claude process, not merely a command that mentions
    # the flag — the same rule channel-health.ts applies, and for the same
    # reason: `tmux new-session ... --name discord-bridge` and any shell whose
    # argv quotes the fragment would otherwise match.
    exe=${cmdline%% *}
    if [[ "${exe##*/}" == "claude" && "$cmdline" == *"$WREN_BRIDGE_MATCH"* ]]; then
      return 0
    fi
    pid=$(awk '{print $4}' "/proc/$pid/stat" 2>/dev/null)
    hops=$((hops + 1))
  done
  return 1
}

# Stamp the shared heartbeat, plus the bridge-scoped one when we are the bridge.
wren_write_heartbeat() {
  local dir="${1:-$HOME/.wren-watchdog}"
  local now
  now=$(date +%s)
  printf '%s\n' "$now" > "$dir/heartbeat.tmp" && mv "$dir/heartbeat.tmp" "$dir/heartbeat"
  if wren_in_bridge_session; then
    printf '%s\n' "$now" > "$dir/heartbeat.bridge.tmp" \
      && mv "$dir/heartbeat.bridge.tmp" "$dir/heartbeat.bridge"
  fi
}
