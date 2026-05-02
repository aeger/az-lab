#!/usr/bin/env bash
# apply_sql.sh — execute arbitrary SQL against the azlab-memory Supabase project
# via the Management API, using the SUPABASE_ACCESS_TOKEN PAT.
#
# Usage:
#   apply_sql.sh <path-to-sql-file>
#   apply_sql.sh -                  # read from stdin
#   echo "SELECT 1" | apply_sql.sh -
#
# Returns the JSON response body. Exits non-zero on HTTP error.
#
# Requires SUPABASE_ACCESS_TOKEN in either:
#   - env var
#   - ~/azlab/services/memory-mcp-server/.env  (default location)
#
# This is the canonical DDL path for Wren on svc-podman-01. PostgREST
# can't run DDL with the service_role JWT; the Management API can with
# a Personal Access Token (sbp_*). This wrapper lets every migration,
# REVOKE, ALTER, etc. run from a script without manual dashboard pastes.

set -euo pipefail

PROJECT_REF="${SUPABASE_PROJECT_REF:-ogqjjlbupqnvlcyrfnxi}"
ENV_FILE="${SUPABASE_ENV_FILE:-$HOME/azlab/services/memory-mcp-server/.env}"

# ── Load token ────────────────────────────────────────────────────────────────
TOKEN="${SUPABASE_ACCESS_TOKEN:-}"
if [[ -z "$TOKEN" && -r "$ENV_FILE" ]]; then
  TOKEN=$(awk -F= '/^SUPABASE_ACCESS_TOKEN=/{sub(/^SUPABASE_ACCESS_TOKEN=/,""); print}' "$ENV_FILE")
fi
if [[ -z "$TOKEN" ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN not in env or $ENV_FILE" >&2
  exit 2
fi
if [[ ! "$TOKEN" =~ ^sbp_ ]]; then
  echo "ERROR: SUPABASE_ACCESS_TOKEN doesn't start with sbp_ — wrong token type?" >&2
  exit 2
fi

# ── Read SQL ──────────────────────────────────────────────────────────────────
if [[ $# -lt 1 ]]; then
  echo "Usage: $(basename "$0") <path-to-sql-file>|-" >&2
  exit 1
fi

if [[ "$1" == "-" ]]; then
  SQL=$(cat)
else
  if [[ ! -r "$1" ]]; then
    echo "ERROR: cannot read $1" >&2
    exit 1
  fi
  SQL=$(cat "$1")
fi

if [[ -z "$SQL" ]]; then
  echo "ERROR: empty SQL input" >&2
  exit 1
fi

# ── Build JSON payload (python handles SQL → JSON escaping cleanly) ──────────
PAYLOAD=$(SQL="$SQL" python3 -c '
import json, os
print(json.dumps({"query": os.environ["SQL"]}))
')

# ── POST ──────────────────────────────────────────────────────────────────────
# User-Agent matters — the Cloudflare WAF in front of api.supabase.com rejects
# requests without one (returns HTTP 403, error code 1010).
RESPONSE=$(
  curl -sS --fail-with-body --max-time 120 \
    -X POST "https://api.supabase.com/v1/projects/$PROJECT_REF/database/query" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "User-Agent: az-lab-wren/1.0" \
    --data "$PAYLOAD"
) || {
  rc=$?
  echo "$RESPONSE" >&2
  exit $rc
}

echo "$RESPONSE"
