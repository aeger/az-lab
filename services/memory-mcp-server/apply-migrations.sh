#!/usr/bin/env bash
# Apply pending Supabase migrations that require direct DB access.
# Usage: PGPASSWORD=<db_password> ./apply-migrations.sh
# Or:    DATABASE_URL=postgresql://postgres:[pass]@db.ogqjjlbupqnvlcyrfnxi.supabase.co:5432/postgres ./apply-migrations.sh
#
# The Supabase project DB password is set in:
#   https://supabase.com/dashboard/project/ogqjjlbupqnvlcyrfnxi/settings/database

set -euo pipefail

SUPABASE_REF="ogqjjlbupqnvlcyrfnxi"
SUPABASE_URL="https://ogqjjlbupqnvlcyrfnxi.supabase.co"
SUPABASE_KEY="${SUPABASE_SECRET_KEY:-$(grep SUPABASE_SECRET_KEY .env | cut -d= -f2)}"

DB_HOST="${DB_HOST:-db.${SUPABASE_REF}.supabase.co}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-postgres}"
DB_USER="${DB_USER:-postgres}"

if [ -n "${DATABASE_URL:-}" ]; then
  PSQL_CONN="$DATABASE_URL"
else
  PSQL_CONN="postgresql://${DB_USER}:${PGPASSWORD:-MISSING_PASSWORD}@${DB_HOST}:${DB_PORT}/${DB_NAME}?sslmode=require"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${SCRIPT_DIR}/migrations"

echo "=== memory-mcp-server migration runner ==="
echo "DB: ${DB_HOST}:${DB_PORT}/${DB_NAME}"
echo ""

check_migration() {
  local name="$1"
  local rpc="$2"
  local result
  result=$(curl -s -X POST "${SUPABASE_URL}/rest/v1/rpc/${rpc}" \
    -H "Authorization: Bearer ${SUPABASE_KEY}" \
    -H "apikey: ${SUPABASE_KEY}" \
    -H "Content-Type: application/json" \
    -d '{}' 2>/dev/null)
  echo "  ${name}: ${result}"
}

apply_migration() {
  local file="$1"
  echo "Applying: $(basename ${file}) ..."
  psql "${PSQL_CONN}" -f "${file}" && echo "  OK" || echo "  FAILED"
}

echo "--- Current migration status (via REST sentinels) ---"
check_migration "007 BM25" "apply_bm25_migration_if_missing"
check_migration "009 Trigram" "apply_trigram_fallback_if_missing"
check_migration "011 agent_id+skills" "apply_agent_visibility_if_missing"
check_migration "012 agent_scope" "apply_agent_scope_if_missing"
check_migration "014 hybrid_search+consolidation" "apply_consolidation_migration_if_missing"
check_migration "015 task_queue_dependencies" "apply_task_dependency_migration_if_missing"
echo ""

if ! command -v psql &>/dev/null; then
  echo "ERROR: psql not found. Install postgresql-client:"
  echo "  sudo apt-get install -y postgresql-client"
  echo ""
  echo "Then re-run this script with:"
  echo "  PGPASSWORD=<db_password> ./apply-migrations.sh"
  echo ""
  echo "DB password location:"
  echo "  https://supabase.com/dashboard/project/${SUPABASE_REF}/settings/database"
  exit 1
fi

echo "--- Applying pending migrations ---"

# Check if agent_id column exists
AGENT_ID_EXISTS=$(curl -s "${SUPABASE_URL}/rest/v1/memories?select=agent_id&limit=0" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "apikey: ${SUPABASE_KEY}" 2>/dev/null | grep -c "42703" || true)

if [ "${AGENT_ID_EXISTS}" -gt 0 ]; then
  echo "Migration 011 (agent_id + skills hierarchy): PENDING"
  apply_migration "${MIGRATIONS_DIR}/011_skills_hierarchy.sql"
else
  echo "Migration 011 (agent_id + skills hierarchy): already applied"
fi

echo ""
AGENT_SCOPE_EXISTS=$(curl -s "${SUPABASE_URL}/rest/v1/memories?select=agent_scope&limit=0" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "apikey: ${SUPABASE_KEY}" 2>/dev/null | grep -c "42703" || true)

if [ "${AGENT_SCOPE_EXISTS}" -gt 0 ]; then
  echo "Migration 012 (agent_scope array): PENDING"
  apply_migration "${MIGRATIONS_DIR}/012_agent_scope.sql"
else
  echo "Migration 012 (agent_scope array): already applied"
fi

echo ""
CONSOLIDATION_EXISTS=$(curl -s "${SUPABASE_URL}/rest/v1/rpc/apply_consolidation_migration_if_missing" \
  -X POST -H "Authorization: Bearer ${SUPABASE_KEY}" -H "apikey: ${SUPABASE_KEY}" \
  -H "Content-Type: application/json" -d '{}' 2>/dev/null | grep -c "PGRST202" || true)

if [ "${CONSOLIDATION_EXISTS}" -gt 0 ]; then
  echo "Migration 014 (hybrid_search_memories + consolidation): PENDING"
  apply_migration "${MIGRATIONS_DIR}/014_hybrid_search_and_consolidation.sql"
else
  echo "Migration 014 (hybrid_search_memories + consolidation): already applied"
fi

echo ""
TASK_DEP_EXISTS=$(curl -s "${SUPABASE_URL}/rest/v1/task_queue?select=blocked_by_task_ids&limit=0" \
  -H "Authorization: Bearer ${SUPABASE_KEY}" \
  -H "apikey: ${SUPABASE_KEY}" 2>/dev/null | grep -c "42703" || true)

if [ "${TASK_DEP_EXISTS}" -gt 0 ]; then
  echo "Migration 015 (task_queue dependency tracking): PENDING"
  apply_migration "${MIGRATIONS_DIR}/015_task_queue_dependencies.sql"
else
  echo "Migration 015 (task_queue dependency tracking): already applied"
fi

echo ""
echo "--- Post-migration status ---"
check_migration "011 agent_id+skills" "apply_agent_visibility_if_missing"
check_migration "012 agent_scope" "apply_agent_scope_if_missing"
check_migration "014 hybrid_search+consolidation" "apply_consolidation_migration_if_missing"
check_migration "015 task_queue_dependencies" "apply_task_dependency_migration_if_missing"
echo ""
echo "Done."
