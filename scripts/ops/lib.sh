#!/usr/bin/env bash
# Shared helpers for backup.sh / restore.sh / restore-test.sh. Source it, do not run it.
#
# Everything is taken from the environment, so CI and production run the same code:
#   PROJECT_DIR          repo root holding the compose files and .env   (default: repo root of this script)
#   COMPOSE_FILES        space-separated compose files                  (default: docker-compose.yml)
#   COMPOSE_PROJECT_NAME the production compose project                 (default: compose's own)
#   BACKUP_DIR           where backups live                             (default: /var/backups/ai-import-assistant)
#   BACKUP_KEEP_DAILY    complete backups to keep                       (default: 14)
#   BACKUP_RCLONE_REMOTE optional offsite remote, e.g. gdrive:ai-import-backups
#   BACKUP_RCLONE_KEEP_DAYS optional: delete offsite copies older than N days
# BACKUP_* may also be put in $PROJECT_DIR/.env (the environment wins).

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="${PROJECT_DIR:-$(cd "$LIB_DIR/../.." && pwd)}"
COMPOSE_FILES="${COMPOSE_FILES:-docker-compose.yml}"
ALPINE_IMAGE="${ALPINE_IMAGE:-alpine:3.20}"

# Main tables whose row counts go into the manifest (all exist in src/db/schema.sql).
BACKUP_TABLES="users workspaces folders files conversations messages"

# Read NAME from $PROJECT_DIR/.env without sourcing it (last assignment wins, quotes stripped).
dotenv_get() {
  [ -f "$PROJECT_DIR/.env" ] || return 0
  sed -n "s/^[[:space:]]*$1=//p" "$PROJECT_DIR/.env" | tail -n 1 | tr -d '\r' | sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}

for _v in BACKUP_DIR BACKUP_KEEP_DAILY BACKUP_RCLONE_REMOTE BACKUP_RCLONE_KEEP_DAYS; do
  if [ -z "${!_v:-}" ]; then
    _val="$(dotenv_get "$_v")"
    [ -n "$_val" ] && printf -v "$_v" '%s' "$_val"
  fi
done
unset _v _val
BACKUP_DIR="${BACKUP_DIR:-/var/backups/ai-import-assistant}"
BACKUP_KEEP_DAILY="${BACKUP_KEEP_DAILY:-14}"
BACKUP_RCLONE_REMOTE="${BACKUP_RCLONE_REMOTE:-}"
BACKUP_RCLONE_KEEP_DAYS="${BACKUP_RCLONE_KEEP_DAYS:-}"

# Compose project override for dc(); empty = whatever compose resolves on its own.
CP=""

dc() {
  local args=(compose --project-directory "$PROJECT_DIR") f
  if [ -n "$CP" ]; then args+=(-p "$CP"); fi
  for f in $COMPOSE_FILES; do
    case "$f" in
      /*) args+=(-f "$f") ;;
      *) args+=(-f "$PROJECT_DIR/$f") ;;
    esac
  done
  docker "${args[@]}" "$@"
}

utc_now() { date -u +%Y-%m-%dT%H:%M:%SZ; }

sha256_of() { sha256sum "$1" | cut -d' ' -f1; }
size_of() { wc -c <"$1" | tr -d ' '; }

# Name of the production compose project: env, else `compose config`, else the directory name.
prod_project_name() {
  local n="${COMPOSE_PROJECT_NAME:-}"
  if [ -z "$n" ]; then
    n="$(CP="" dc config --format json 2>/dev/null | sed -n 's/^  "name": "\(.*\)",\{0,1\}$/\1/p' | head -n 1 || true)"
  fi
  if [ -z "$n" ]; then
    n="$(basename "$PROJECT_DIR" | tr '[:upper:]' '[:lower:]' | sed 's/[^a-z0-9_-]//g')"
  fi
  printf '%s' "$n"
}

# The compose project the running postgres container really belongs to.
running_project() {
  local id
  id="$(dc ps -q postgres | head -n 1)"
  [ -n "$id" ] || return 1
  docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$id"
}

# Name of the project's storage_data volume ("" if it does not exist yet).
storage_volume() {
  docker volume ls -q \
    --filter "label=com.docker.compose.project=$1" \
    --filter "label=com.docker.compose.volume=storage_data" | head -n 1
}

# Same, creating it (with the labels compose expects) when missing.
ensure_storage_volume() {
  local v
  v="$(storage_volume "$1")"
  if [ -z "$v" ]; then
    v="$1_storage_data"
    docker volume create \
      --label "com.docker.compose.project=$1" \
      --label "com.docker.compose.volume=storage_data" "$v" >/dev/null
  fi
  printf '%s' "$v"
}

# Run one SQL statement in the current project's postgres; credentials come from the container env.
psql_c() {
  # shellcheck disable=SC2016 # expanded inside the container, on purpose
  dc exec -T postgres sh -c 'psql -X -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "$1"' sh "$1"
}

# "table count" lines for BACKUP_TABLES in the current project.
current_counts() {
  local t
  for t in $BACKUP_TABLES; do
    printf '%s %s\n' "$t" "$(psql_c "SELECT count(*) FROM $t")"
  done
}

# --- manifest readers (the manifest is written one key per line, see backup.sh) ---
manifest_sha() { # <backup-dir> <artifact>
  sed -n "s/.*\"$2\": {\"bytes\": [0-9]*, \"sha256\": \"\([0-9a-f]*\)\".*/\1/p" "$1/manifest.json" | head -n 1
}
manifest_counts() { # <backup-dir> -> "table count" lines
  awk '/"row_counts"/ {f=1; next} f && /^  }/ {f=0} f {gsub(/[",:]/, " "); if (NF >= 2) print $1, $2}' "$1/manifest.json"
}
manifest_value() { # <backup-dir> <key> -> scalar number/string value
  sed -n "s/^  \"$2\": \"\{0,1\}\([^\",]*\)\"\{0,1\},\{0,1\}\$/\1/p" "$1/manifest.json" | head -n 1
}

# Check that a backup dir is complete and every artifact matches the manifest sha256.
verify_backup() {
  local dir="$1" a want got
  [ -d "$dir" ] || { echo "not a directory: $dir" >&2; return 1; }
  case "$dir" in *.partial|*.partial/) echo "refusing a .partial (unfinished) backup: $dir" >&2; return 1 ;; esac
  for a in manifest.json db.dump storage.tar.gz; do
    [ -f "$dir/$a" ] || { echo "missing $a in $dir" >&2; return 1; }
  done
  for a in db.dump storage.tar.gz; do
    want="$(manifest_sha "$dir" "$a")"
    [ -n "$want" ] || { echo "manifest has no sha256 for $a" >&2; return 1; }
    got="$(sha256_of "$dir/$a")"
    if [ "$want" != "$got" ]; then
      echo "CHECKSUM MISMATCH for $a (manifest $want, actual $got)" >&2
      return 1
    fi
    echo "  sha256 ok  $a"
  done
}

# Newest complete backup directory under BACKUP_DIR ("" if none).
latest_backup() {
  local d best=""
  for d in "$BACKUP_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]; do
    [ -f "$d/manifest.json" ] && best="$d"
  done
  printf '%s' "$best"
}

# Compare manifest row counts with the current project's database. Prints a line per table.
compare_counts() { # <backup-dir>
  local dir="$1" t exp got rc=0 n=0
  while read -r t exp; do
    n=$((n + 1))
    got="$(psql_c "SELECT count(*) FROM $t")"
    if [ "$got" = "$exp" ]; then
      echo "  ok    $t: $got rows"
    else
      echo "  FAIL  $t: manifest=$exp restored=$got"
      rc=1
    fi
  done < <(manifest_counts "$dir")
  if [ "$n" -eq 0 ]; then echo "  FAIL  manifest has no row counts"; rc=1; fi
  return "$rc"
}

# Unpack storage.tar.gz into a volume, replacing whatever was in it.
restore_storage_into() { # <volume> <archive>
  docker run --rm -i -v "$1:/data" "$ALPINE_IMAGE" \
    sh -c 'find /data -mindepth 1 -delete && tar xzf - -C /data' <"$2"
}

# Load db.dump into the current project's postgres (must be up and healthy).
restore_db_into() { # <dump>
  # shellcheck disable=SC2016 # expanded inside the container, on purpose
  dc exec -T postgres sh -c 'pg_restore --clean --if-exists --no-owner -U "$POSTGRES_USER" -d "$POSTGRES_DB"' <"$1"
}
