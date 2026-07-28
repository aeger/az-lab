#!/usr/bin/env bash
# Health check for the episodic→semantic distillation pipeline.
#
# Replaces the retired nightly "Run nightly episodic memory consolidation"
# cowork queue task (see migration 088). That task invoked a deprecated no-op
# script and had to be triaged by hand every morning. This checks the thing
# that actually does the work — episodic-distill.timer / episodic_distill.py
# Phase 0 — and stays SILENT when healthy, so it never recreates that noise.
#
# Fires at 03:30 UTC, 30 min after episodic-distill.service runs at 03:00.
#
# Alerts (agent bus -> Discord) only when:
#   - the timer is not enabled/active, or
#   - the last service run exited non-zero, or
#   - the last run is older than MAX_AGE_HOURS, or
#   - the log has no completion line from the last run.

set -uo pipefail

SERVICE="episodic-distill.service"
TIMER="episodic-distill.timer"
LOG="$HOME/azlab/services/memory-mcp-server/episodic_distill.log"
ENV_FILE="$HOME/azlab/services/memory-mcp-server/.env"
MAX_AGE_HOURS=26

AGENT_BUS_URL="${AGENT_BUS_URL:-http://localhost:8765}"
AGENT_BUS_SECRET="${AGENT_BUS_SECRET:-}"
if [[ -z "$AGENT_BUS_SECRET" && -r "$ENV_FILE" ]]; then
  AGENT_BUS_SECRET="$(grep -m1 '^AGENT_BUS_SECRET=' "$ENV_FILE" | cut -d= -f2- || true)"
fi

problems=()   # fatal — trigger an alert
notes=()      # informational — ride along on an alert, never cause one

# ── timer wiring ─────────────────────────────────────────────────────────────
if ! systemctl --user is-enabled --quiet "$TIMER" 2>/dev/null; then
  problems+=("$TIMER is not enabled")
fi
if ! systemctl --user is-active --quiet "$TIMER" 2>/dev/null; then
  problems+=("$TIMER is not active")
fi

# ── last run result ──────────────────────────────────────────────────────────
exec_status="$(systemctl --user show "$SERVICE" -p ExecMainStatus --value 2>/dev/null)"
result="$(systemctl --user show "$SERVICE" -p Result --value 2>/dev/null)"
last_run="$(systemctl --user show "$SERVICE" -p ExecMainExitTimestamp --value 2>/dev/null)"

if [[ -n "$exec_status" && "$exec_status" != "0" ]]; then
  problems+=("last run exited $exec_status (Result=$result)")
fi

if [[ -z "$last_run" ]]; then
  problems+=("$SERVICE has no recorded run")
else
  last_epoch="$(date -d "$last_run" +%s 2>/dev/null || echo 0)"
  now_epoch="$(date +%s)"
  age_h=$(( (now_epoch - last_epoch) / 3600 ))
  if (( last_epoch == 0 )); then
    problems+=("could not parse last-run timestamp: $last_run")
  elif (( age_h > MAX_AGE_HOURS )); then
    problems+=("last run was ${age_h}h ago (>${MAX_AGE_HOURS}h) — timer may not be firing")
  fi
fi

# ── log completion line ──────────────────────────────────────────────────────
if [[ ! -r "$LOG" ]]; then
  problems+=("log not readable: $LOG")
else
  tail_txt="$(tail -40 "$LOG" 2>/dev/null)"
  if ! grep -q '=== Total:' <<<"$tail_txt"; then
    problems+=("no '=== Total:' completion line in last 40 log lines")
  fi
  # Non-fatal, but worth surfacing: the NemoClaw summarization timeout that
  # degrades summary quality while the pipeline still falls back and succeeds.
  # A note alone must never raise an alert — that is exactly the every-morning
  # noise this check replaced.
  if grep -qi 'read timeout\|ReadTimeout' <<<"$tail_txt"; then
    notes+=("LLM summarization timed out — fallback used, summary quality degraded")
  fi
fi

# ── report ───────────────────────────────────────────────────────────────────
if (( ${#problems[@]} == 0 )); then
  echo "OK: $SERVICE healthy (last run $last_run, exit $exec_status)"
  for n in ${notes+"${notes[@]}"}; do echo "note: ${n}"; done
  exit 0
fi

msg="⚠️ **episodic-distill health check** on svc-podman-01"$'\n'
for p in "${problems[@]}"; do
  msg+="• ${p}"$'\n'
done
for n in ${notes+"${notes[@]}"}; do
  msg+="• (non-fatal) ${n}"$'\n'
done
msg+="Last run: ${last_run:-unknown} | tail: ${LOG}"

echo "$msg"

curl -s --max-time 10 -X POST "$AGENT_BUS_URL/message" \
  -H "Content-Type: application/json" \
  -H "X-Agent-Secret: $AGENT_BUS_SECRET" \
  --data "$(jq -Rn --arg t "$msg" '{text:$t}')" >/dev/null 2>&1 || true

exit 1
