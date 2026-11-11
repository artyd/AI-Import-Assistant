#!/usr/bin/env bash
# Top slow statements from pg_stat_statements. Run on the host in /opt/AI-Import-Assistant.
#   scripts/ops/slow-queries.sh           top 20 by total time and by mean time
#   scripts/ops/slow-queries.sh --reset   clear the collected statistics
set -euo pipefail
cd "$(dirname "$0")/../.."

psql_run() {
  docker compose exec -T postgres sh -c 'psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"'
}

case "${1:-}" in
  --reset)
    echo "SELECT pg_stat_statements_reset();" | psql_run
    echo "pg_stat_statements reset."
    exit 0
    ;;
  "") ;;
  *) echo "usage: $0 [--reset]" >&2; exit 2 ;;
esac

for ORDER in total_exec_time mean_exec_time; do
  echo "=== Top 20 by ${ORDER} ==="
  psql_run <<SQL
SELECT calls,
       round(total_exec_time::numeric, 1) AS total_ms,
       round(mean_exec_time::numeric, 2)  AS mean_ms,
       round(max_exec_time::numeric, 1)   AS max_ms,
       rows,
       left(regexp_replace(query, '\s+', ' ', 'g'), 120) AS query
  FROM pg_stat_statements
 WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database())
 ORDER BY ${ORDER} DESC
 LIMIT 20;
SQL
  echo
done
