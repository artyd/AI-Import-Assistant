#!/usr/bin/env bash
# Daily backup of production data: Postgres dump + storage volume + manifest.
#
#   bash scripts/ops/backup.sh
#
# Writes $BACKUP_DIR/<UTC yyyy-mm-dd_HHMMSS>/{db.dump,storage.tar.gz,manifest.json}.
# The backup is built in a ".partial" directory and renamed at the end, so a half
# backup is never mistaken for a good one. Redis is deliberately not backed up
# (BullMQ queues are rebuilt; see DEPLOYMENT.md).
#
# Result is always in $BACKUP_DIR/last-status.json:
#   {"ok":true,"at":"...","backup":"..."}   or   {"ok":false,"at":"...","error":"..."}
# and the exit code is non-zero on any failure (error text goes to stderr).
# Environment: see scripts/ops/lib.sh.
set -Eeuo pipefail
umask 077

# shellcheck source=scripts/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

START_SECONDS=$SECONDS
NAME="$(date -u +%Y-%m-%d_%H%M%S)"
PARTIAL="$BACKUP_DIR/$NAME.partial"
FINAL="$BACKUP_DIR/$NAME"
DONE=0
ERR_MSG=""
ERR_LINE=""
ERR_CMD=""
OFFSITE_ERR=""

json_escape() {
  printf '%s' "$1" | tr -d '\r' | sed ':a;N;$!ba;s/\\/\\\\/g;s/"/\\"/g;s/\n/\\n/g;s/\t/\\t/g'
}

write_status() { # <ok:true|false> <field> <value>
  local tmp="$BACKUP_DIR/.last-status.json.tmp"
  [ -d "$BACKUP_DIR" ] || return 0
  printf '{"ok":%s,"at":"%s","%s":"%s"}\n' "$1" "$(utc_now)" "$2" "$(json_escape "$3")" >"$tmp" &&
    mv -f "$tmp" "$BACKUP_DIR/last-status.json"
}

fail() { ERR_MSG="$*"; exit 1; }

finish() {
  local rc=$?
  if [ "$DONE" -ne 1 ] && [ "$rc" -ne 0 ]; then
    local msg="${ERR_MSG:-command failed (exit $rc) at line ${ERR_LINE:-?}: ${ERR_CMD:-?}}"
    echo "backup.sh: ERROR: $msg" >&2
    if [ -n "$PARTIAL" ] && [ -d "$PARTIAL" ] && [ "${PARTIAL#"$BACKUP_DIR"/}" != "$PARTIAL" ]; then
      rm -rf -- "$PARTIAL"
    fi
    write_status false error "$msg" || true
  fi
}
trap 'ERR_LINE=$LINENO; ERR_CMD=$BASH_COMMAND' ERR
trap finish EXIT

case "$BACKUP_KEEP_DAILY" in
  '' | *[!0-9]* | 0) fail "BACKUP_KEEP_DAILY must be a positive integer (got '$BACKUP_KEEP_DAILY')" ;;
esac
command -v docker >/dev/null || fail "docker is not installed"
mkdir -p "$BACKUP_DIR"

# One backup at a time.
exec 9>"$BACKUP_DIR/.lock"
flock -n 9 || fail "another backup is already running (lock $BACKUP_DIR/.lock)"

# Drop unfinished leftovers from earlier crashed runs (older than a day).
find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d -name '*.partial' -mmin +1440 -exec rm -rf {} + || true

PROJECT="$(running_project)" || fail "postgres container is not running in this compose project (PROJECT_DIR=$PROJECT_DIR COMPOSE_FILES='$COMPOSE_FILES')"
VOLUME="$(storage_volume "$PROJECT")"
[ -n "$VOLUME" ] || fail "no storage_data volume found for compose project '$PROJECT'"

mkdir "$PARTIAL"

# 1. Postgres: custom-format dump. Credentials come from the container's own env
#    (never on a command line visible in `ps`).
# shellcheck disable=SC2016 # expanded inside the container, on purpose
dc exec -T postgres sh -c 'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"' >"$PARTIAL/db.dump"
[ -s "$PARTIAL/db.dump" ] || fail "pg_dump produced an empty file"
# The dump must be readable by pg_restore.
dc exec -T postgres pg_restore -l <"$PARTIAL/db.dump" >/dev/null || fail "pg_restore cannot read the new dump"

# 2. Storage volume: mounted read-only in a throwaway container, streamed to the host.
docker run --rm -v "$VOLUME:/data:ro" "$ALPINE_IMAGE" tar czf - -C /data . >"$PARTIAL/storage.tar.gz"
tar tzf "$PARTIAL/storage.tar.gz" >/dev/null || fail "storage.tar.gz is not a readable archive"
STORAGE_FILES="$(tar tzf "$PARTIAL/storage.tar.gz" | grep -vc '/$' || true)"

# 3. Manifest (one key per line so restore.sh can read it without jq).
GIT_COMMIT="$(git -C "$PROJECT_DIR" rev-parse HEAD 2>/dev/null || echo unknown)"
{
  printf '{\n'
  printf '  "created_at": "%s",\n' "$(utc_now)"
  printf '  "git_commit": "%s",\n' "$GIT_COMMIT"
  printf '  "compose_project": "%s",\n' "$PROJECT"
  printf '  "files": {\n'
  printf '    "db.dump": {"bytes": %s, "sha256": "%s"},\n' "$(size_of "$PARTIAL/db.dump")" "$(sha256_of "$PARTIAL/db.dump")"
  printf '    "storage.tar.gz": {"bytes": %s, "sha256": "%s"}\n' "$(size_of "$PARTIAL/storage.tar.gz")" "$(sha256_of "$PARTIAL/storage.tar.gz")"
  printf '  },\n'
  printf '  "storage_file_count": %s,\n' "$STORAGE_FILES"
  printf '  "row_counts": {\n'
  sep=""
  while read -r t n; do
    printf '%s    "%s": %s' "$sep" "$t" "$n"
    sep=$',\n'
  done < <(current_counts)
  printf '\n  }\n'
  printf '}\n'
} >"$PARTIAL/manifest.json"

# 4. Atomic publish: only now does it count as a backup.
mv "$PARTIAL" "$FINAL"
PARTIAL=""

# 5. Offsite copy (optional). A failure here is reported, but local rotation still runs.
OFFSITE="no"
if [ -n "$BACKUP_RCLONE_REMOTE" ]; then
  if ! command -v rclone >/dev/null; then
    OFFSITE_ERR="BACKUP_RCLONE_REMOTE is set but rclone is not installed"
  elif rclone copy "$FINAL" "${BACKUP_RCLONE_REMOTE%/}/$NAME" --checksum; then
    OFFSITE="yes"
    case "$BACKUP_RCLONE_KEEP_DAYS" in
      '') ;;
      *[!0-9]*) OFFSITE_ERR="BACKUP_RCLONE_KEEP_DAYS must be an integer" ;;
      *)
        rclone delete "${BACKUP_RCLONE_REMOTE%/}" --min-age "${BACKUP_RCLONE_KEEP_DAYS}d" --rmdirs ||
          OFFSITE_ERR="offsite pruning failed"
        ;;
    esac
  else
    OFFSITE_ERR="rclone copy to $BACKUP_RCLONE_REMOTE failed"
  fi
fi

# 6. Rotation: keep the newest BACKUP_KEEP_DAILY complete backups.
mapfile -t COMPLETE < <(
  find "$BACKUP_DIR" -mindepth 1 -maxdepth 1 -type d \
    -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]_[0-9][0-9][0-9][0-9][0-9][0-9]' | sort |
    while read -r d; do [ -f "$d/manifest.json" ] && echo "$d"; done
)
EXCESS=$((${#COMPLETE[@]} - BACKUP_KEEP_DAILY))
if [ "$EXCESS" -gt 0 ]; then
  for d in "${COMPLETE[@]:0:EXCESS}"; do
    [ "${d#"$BACKUP_DIR"/}" != "$d" ] && rm -rf -- "$d"
  done
fi
KEPT=$((${#COMPLETE[@]} - (EXCESS > 0 ? EXCESS : 0)))

if [ -n "$OFFSITE_ERR" ]; then fail "local backup $NAME is fine, but: $OFFSITE_ERR"; fi

DONE=1
write_status true backup "$NAME"
echo "backup OK: $NAME db=$(size_of "$FINAL/db.dump")B storage=$(size_of "$FINAL/storage.tar.gz")B files=$STORAGE_FILES offsite=$OFFSITE kept=$KEPT in $((SECONDS - START_SECONDS))s -> $FINAL"
