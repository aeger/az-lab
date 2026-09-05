#!/usr/bin/env bash
# Guard against duplicate migration numbers in migrations/.
#
# Why: the daily preamble reads the deployed schema head as
#   ls migrations/ | grep -E "^[0-9]" | sort -n | tail -1
# Two files sharing a numeric prefix make that read ambiguous and give any
# glob+sort tool a nondeterministic order. On 2026-08-15 both
# 119_consult_capture_rate.sql and 119_outcome_utility_coverage_caveat.sql
# shipped as 119; the latter was renumbered to 120.
#
# Prefix = the token before the first underscore, so a letter-suffixed patch
# migration (116a) is intentionally distinct from its base (116).
#
# Usage: ./check-migration-numbering.sh [migrations_dir]
# Exit 0 = clean, 1 = duplicate prefix found.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIGRATIONS_DIR="${1:-${SCRIPT_DIR}/migrations}"

if [ ! -d "${MIGRATIONS_DIR}" ]; then
  echo "check-migration-numbering: no such directory: ${MIGRATIONS_DIR}" >&2
  exit 1
fi

dupes=$(
  ls -1 "${MIGRATIONS_DIR}" \
    | grep -E '^[0-9]+[a-z]?_.*\.sql$' \
    | sed -E 's/_.*//' \
    | sort \
    | uniq -d
)

if [ -n "${dupes}" ]; then
  echo "ERROR: duplicate migration number prefix(es) in ${MIGRATIONS_DIR}:" >&2
  while read -r prefix; do
    [ -z "${prefix}" ] && continue
    echo "  ${prefix}:" >&2
    ls -1 "${MIGRATIONS_DIR}" | grep -E "^${prefix}_" | sed 's/^/    /' >&2
  done <<< "${dupes}"
  echo "" >&2
  echo "Renumber the later-authored file to the next free number so that" >&2
  echo "  ls migrations/ | grep -E '^[0-9]' | sort -n | tail -1" >&2
  echo "returns a single unambiguous schema head." >&2
  exit 1
fi

head=$(ls -1 "${MIGRATIONS_DIR}" | grep -E '^[0-9]' | sort -n | tail -1)
echo "check-migration-numbering: OK — schema head is ${head}"
