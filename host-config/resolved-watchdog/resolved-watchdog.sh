#!/bin/bash
# resolved-watchdog — detect wedged DNS and remediate BOTH causes, in order.
#
# Background
# ----------
# 2026-06-29: an AdGuard (192.168.99.2) blip left systemd-resolved stuck returning
# EMPTY responses for ~2h instead of failing over to its fallbacks. A plain
# `systemctl restart systemd-resolved` cleared it instantly. v1 of this watchdog
# automated exactly that, and only that.
#
# 2026-08-22: a second wedge, ~1h, four kill switches (task_poller, argus, sage,
# gmail_mcp). This time the fault was INSIDE AdGuard: it served cache hits
# normally but timed out 8/8 on UNCACHED lookups, while 1.1.1.1 direct was 8/8 at
# 0.03s. v1 restarted systemd-resolved 10 times over that hour and could not help
# by design — restarting the local stub cannot clear a wedge on the upstream side.
# Recovery coincided with a /control/test_upstream_dns call that forced AdGuard to
# open fresh upstream connections.
#
# Two defects in v1 that this version fixes:
#   1. BLIND SPOT. The probe used cloudflare.com / google.com / one.one.one.one —
#      names AdGuard always has cached. The 2026-08-22 signature is "cache hits
#      fine, uncached dead", which the cached probe cannot see. We now probe an
#      uncached random name as well.
#   2. MISATTRIBUTION. v1 logged "restart OK" whenever a cached lookup succeeded
#      afterwards, crediting the restart for AdGuard intermittently serving. The
#      post-restart verification now uses the uncached probe too.
#
# 2026-09-02: a ~2h19m Cox WAN outage (10:06 -> 12:25 UTC). Stage 2 correctly
# called it 94 times. But on the run at 12:25:23 the WAN came back mid-script:
# the DoH probe passed, so we fell through to stage 3, poked AdGuard, and logged
# "stage 3 RECOVERED — AdGuard upstream wedge cleared". AdGuard was never at
# fault — the WAN recovered on its own and the poke took the credit. That is the
# very defect #2 above, one stage further down the ladder.
#
#   3. RECOVERY ATTRIBUTION. A stage-1/stage-3 remediation may only claim credit
#      if the fault was already localized to that component on a PREVIOUS run.
#      If the last run reported a WAN outage, recovery on this run is far more
#      likely the WAN returning, so we say so instead of blaming AdGuard.
#
# Ladder: probe -> restart systemd-resolved -> localize fault -> poke AdGuard ->
# alert. Each remediation has a cooldown so a long outage does not turn into a
# restart loop (v1 restarted every ~2 min for an hour).
set -u

ADGUARD_IP="${ADGUARD_IP:-192.168.99.2}"
ENV_FILE="${ENV_FILE:-/etc/resolved-watchdog.env}"
STATE_DIR="${STATE_DIR:-/run/resolved-watchdog}"
WEBHOOK_FILE="${WEBHOOK_FILE:-/home/almty1/claude/agent-bus/discord_webhooks.json}"

# Random labels are prefixed onto this zone for the uncached probe. Any domain
# whose NXDOMAIN is authoritative and stable works; example.com is reserved by
# RFC 2606 and will never be delegated out from under us.
PROBE_ZONE="${PROBE_ZONE:-example.com}"

CACHED_NAMES=(cloudflare.com google.com one.one.one.one)

RESOLVED_RESTART_COOLDOWN="${RESOLVED_RESTART_COOLDOWN:-300}"   # 5 min
ADGUARD_POKE_COOLDOWN="${ADGUARD_POKE_COOLDOWN:-600}"           # 10 min
ALERT_COOLDOWN="${ALERT_COOLDOWN:-1800}"                        # 30 min

log()  { logger -t resolved-watchdog "$*"; }
warn() { logger -t resolved-watchdog -p daemon.err "$*"; }

mkdir -p "$STATE_DIR" 2>/dev/null || true

# ── cooldown bookkeeping ─────────────────────────────────────────────────────
# State lives in /run (tmpfs) so a reboot starts clean.
cooldown_ok() {  # <key> <seconds>
  local f="$STATE_DIR/$1" last now
  now=$(date +%s)
  last=$(cat "$f" 2>/dev/null || echo 0)
  [[ "$last" =~ ^[0-9]+$ ]] || last=0
  (( now - last >= $2 ))
}
stamp() { date +%s > "$STATE_DIR/$1" 2>/dev/null || true; }

# ── probes ───────────────────────────────────────────────────────────────────

# Normal resolution path (glibc -> 127.0.0.53 -> resolved -> AdGuard). Mostly
# answered from cache, so this alone is NOT sufficient — see defect 1 above.
probe_cached() {
  local n
  for n in "${CACHED_NAMES[@]}"; do
    getent hosts "$n" >/dev/null 2>&1 && return 0
  done
  return 1
}

# Uncached probe. Healthy means the server ANSWERED — NXDOMAIN is a perfectly
# good answer here; what we are testing is whether the resolver can still reach
# its upstreams at all. A wedged resolver times out instead.
#
# Retried with a fresh random label each attempt: residual single-packet UDP/53
# loss (~1 in 15 after the 2026-08-22 incident) must not trip a false alarm.
probe_uncached() {  # <server> [attempts]
  local server="$1" attempts="${2:-3}" i out
  command -v dig >/dev/null 2>&1 || return 0   # no dig: skip, don't false-alarm
  for (( i = 0; i < attempts; i++ )); do
    out=$(dig +time=3 +tries=1 "@$server" "wd$RANDOM$$$i.$PROBE_ZONE" 2>/dev/null)
    grep -qE 'status: (NXDOMAIN|NOERROR)' <<<"$out" && return 0
  done
  return 1
}

# Upstream reachability, over HTTPS instead of port 53.
#
# This network NAT-redirects ALL outbound :53 — verified 2026-08-24, queries to
# 192.0.2.99 and 203.0.113.77 (both RFC 5737 TEST-NET, no host can exist there)
# come back answered. So "dig @1.1.1.1" does NOT bypass the local resolver and is
# worthless for localizing a fault. DoH on 443 cannot be intercepted that way.
probe_doh() {
  local u
  for u in "https://1.1.1.1/dns-query?name=wd$RANDOM$$.$PROBE_ZONE&type=A" \
           "https://8.8.8.8/resolve?name=wd$RANDOM$$.$PROBE_ZONE&type=A"; do
    curl -sf --max-time 8 -H 'accept: application/dns-json' "$u" >/dev/null 2>&1 && return 0
  done
  return 1
}

healthy() { probe_cached && probe_uncached 127.0.0.53; }

# ── AdGuard remediation ──────────────────────────────────────────────────────
# Re-tests AdGuard's own configured upstreams through its control API, which
# forces it to open fresh upstream connections. This is the lever that coincided
# with recovery on 2026-08-22. It is a probe, not a config write — it cannot
# change AdGuard's settings.
poke_adguard() {
  if [ ! -r "$ENV_FILE" ]; then
    warn "cannot reach AdGuard control API: $ENV_FILE missing or unreadable"
    return 1
  fi
  # shellcheck source=/dev/null
  . "$ENV_FILE"
  if [ -z "${ADGUARD_USERNAME:-}" ] || [ -z "${ADGUARD_PASSWORD:-}" ]; then
    warn "cannot reach AdGuard control API: credentials not set in $ENV_FILE"
    return 1
  fi

  local auth="$ADGUARD_USERNAME:$ADGUARD_PASSWORD" ups
  ups=$(curl -sf --max-time 10 -u "$auth" "http://$ADGUARD_IP/control/dns_info" \
        | jq -c '{upstream_dns}' 2>/dev/null)
  if [ -z "$ups" ] || [ "$ups" = "null" ]; then
    warn "AdGuard control API unreachable or returned no upstreams"
    return 1
  fi

  curl -sf --max-time 25 -u "$auth" -X POST -H 'Content-Type: application/json' \
       -d "$ups" "http://$ADGUARD_IP/control/test_upstream_dns" >/dev/null 2>&1
}

# ── alerting ─────────────────────────────────────────────────────────────────
# Always to the journal at daemon.err; Discord is best-effort on top.
alert() {
  warn "$*"
  cooldown_ok alert "$ALERT_COOLDOWN" || return 0
  stamp alert
  [ -r "$WEBHOOK_FILE" ] || return 0
  local url
  url=$(jq -r '."claude-code" // empty' "$WEBHOOK_FILE" 2>/dev/null)
  [ -n "$url" ] || return 0
  curl -sf --max-time 10 -H 'Content-Type: application/json' \
       -d "$(jq -nc --arg c "🌐 **resolved-watchdog @ $(hostname):** $*" '{content:$c}')" \
       "$url" >/dev/null 2>&1 || true
}

# ── main ─────────────────────────────────────────────────────────────────────

if healthy; then
  if [ -f "$STATE_DIR/degraded" ]; then
    rm -f "$STATE_DIR/degraded"
    if [ -f "$STATE_DIR/wan_outage" ]; then
      log "DNS healthy again — previous run saw a WAN/upstream outage, so this is the WAN returning, not local remediation"
    else
      log "DNS healthy again (cached + uncached both answering)"
    fi
  fi
  rm -f "$STATE_DIR/wan_outage"
  exit 0
fi

probe_cached && cached=ok || cached=FAIL
probe_uncached 127.0.0.53 1 && uncached=ok || uncached=FAIL
touch "$STATE_DIR/degraded" 2>/dev/null || true
log "DNS unhealthy — cached=$cached uncached=$uncached"

# Stage 1 — the local stub. Cheap, non-disruptive, fixes the 2026-06-29 mode.
if cooldown_ok resolved_restart "$RESOLVED_RESTART_COOLDOWN"; then
  stamp resolved_restart
  log "stage 1: restarting systemd-resolved"
  systemctl restart systemd-resolved
  sleep 3
  if healthy; then
    if [ -f "$STATE_DIR/wan_outage" ]; then
      log "stage 1 recovered DNS, but the previous run was a WAN/upstream outage — cause NOT confirmed as a systemd-resolved wedge"
    else
      log "stage 1 RECOVERED — systemd-resolved was wedged"
    fi
    rm -f "$STATE_DIR/degraded"
    exit 0
  fi
  log "stage 1 did NOT recover DNS — escalating"
else
  log "stage 1 skipped (systemd-resolved restarted <${RESOLVED_RESTART_COOLDOWN}s ago)"
fi

# Stage 2 — localize. Is the internet fine and only our resolver broken?
if ! probe_doh; then
  # Marker consumed by stage 1/stage 3 on the NEXT run, and by anyone triaging a
  # `silent_agent` kill switch: agent heartbeats cannot leave the box right now.
  touch "$STATE_DIR/wan_outage" 2>/dev/null || true
  alert "DNS down and DoH to 1.1.1.1/8.8.8.8 also fails — WAN/upstream outage, no local remediation available"
  exit 1
fi

if [ -f "$STATE_DIR/wan_outage" ]; then
  log "stage 2: DoH answers again, but the previous run was a WAN/upstream outage — treating this as WAN recovery in progress, not an AdGuard fault"
else
  log "stage 2: fault localized to AdGuard $ADGUARD_IP (DoH upstreams answer, local resolver does not)"
fi

# Stage 3 — poke AdGuard into re-establishing its upstream connections.
if cooldown_ok adguard_poke "$ADGUARD_POKE_COOLDOWN"; then
  stamp adguard_poke
  log "stage 3: re-testing AdGuard upstreams to force fresh connections"
  if poke_adguard; then
    sleep 5
    if healthy; then
      if [ -f "$STATE_DIR/wan_outage" ]; then
        log "stage 3 recovered DNS, but the previous run was a WAN/upstream outage — cause NOT confirmed; do not record this as an AdGuard wedge"
      else
        log "stage 3 RECOVERED — AdGuard upstream wedge cleared"
      fi
      rm -f "$STATE_DIR/degraded" "$STATE_DIR/wan_outage"
      exit 0
    fi
    log "stage 3 did NOT recover DNS"
  fi
else
  log "stage 3 skipped (AdGuard poked <${ADGUARD_POKE_COOLDOWN}s ago)"
fi

alert "AdGuard $ADGUARD_IP is wedged (serving cache, failing uncached lookups) and did not recover after an upstream re-test. DoH upstreams answer fine, so this is AdGuard, not the WAN. Needs a human — restart AdGuard."
exit 1
