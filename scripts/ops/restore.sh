#!/usr/bin/env bash
# Restore a backup made by backup.sh.
#
#   bash scripts/ops/restore.sh <backup-dir>
#       Restores into a SEPARATE scratch compose project (RESTORE_PROJECT_NAME,
#       default "aiia-restore"). Production is never touched. The scratch project
#       is left running so you can inspect it; remove it with:
#         docker compose -p aiia-restore down -v
#
#   bash scripts/ops/restore.sh --into-production --yes <backup-dir>
#       Overwrites the LIVE project's database and storage volume. Needs both flags.
#       Stops backend/worker/frontend first; start them again afterwards with
#       `docker compose up -d`.
#
# The sha256 of every artifact is verified against manifest.json before anything is
# restored, and row counts are compared with the manifest afterwards.
# Environment: see scripts/ops/lib.sh (plus RESTORE_PROJECT_NAME).
set -Eeuo pipefail

# shellcheck source=scripts/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

usage() {
  sed -n '2,16p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2
  exit 2
}

INTO_PROD=0
YES=0
BACKUP=""
for arg in "$@"; do
  case "$arg" in
    --into-production) INTO_PROD=1 ;;
    --yes) YES=1 ;;
    -h | --help) usage ;;
    -*) echo "unknown option: $arg" >&2; usage ;;
    *) [ -z "$BACKUP" ] || { echo "only one backup directory may be given" >&2; usage; }; BACKUP="${arg%/}" ;;
  esac
done
[ -n "$BACKUP" ] || usage
if [ "$YES" -eq 1 ] && [ "$INTO_PROD" -eq 0 ]; then
  echo "--yes only makes sense together with --into-production" >&2
  exit 2
fi

command -v docker >/dev/null || { echo "docker is not installed" >&2; exit 1; }

PROD_PROJECT="$(prod_project_name)"
SCRATCH_PROJECT="${RESTORE_PROJECT_NAME:-aiia-restore}"

if [ "$INTO_PROD" -eq 1 ]; then
  TARGET="$PROD_PROJECT"
  CP=""
else
  TARGET="$SCRATCH_PROJECT"
  if [ "$TARGET" = "$PROD_PROJECT" ]; then
    echo "REFUSING: scratch project '$TARGET' is the production project. Set RESTORE_PROJECT_NAME to something else." >&2
    exit 2
  fi
  CP="$TARGET"
fi

echo "Backup:  $BACKUP"
echo "Target:  compose project '$TARGET' ($([ "$INTO_PROD" -eq 1 ] && echo PRODUCTION || echo scratch))"
echo "Verifying checksums..."
verify_backup "$BACKUP" || { echo "backup failed verification, nothing was restored" >&2; exit 1; }

if [ "$INTO_PROD" -eq 1 ]; then
  VOL="$(storage_volume "$TARGET")"
  echo
  echo "This will OVERWRITE production data in compose project '$TARGET':"
  echo "  - database: every object in the dump is dropped and recreated (pg_restore --clean --if-exists)"
  echo "  - storage:  ALL files in volume '${VOL:-${TARGET}_storage_data}' are deleted, then replaced by storage.tar.gz"
  echo "  - backend, worker and frontend are stopped first"
  if [ "$YES" -ne 1 ]; then
    echo >&2
    echo "REFUSING: add --yes (together with --into-production) to proceed." >&2
    exit 2
  fi
  echo "Stopping backend worker frontend..."
  dc stop backend worker frontend
fi

echo "Starting postgres..."
dc up -d --wait postgres

VOLUME="$(ensure_storage_volume "$TARGET")"

echo "Restoring database..."
restore_db_into "$BACKUP/db.dump"

echo "Restoring storage into volume $VOLUME..."
restore_storage_into "$VOLUME" "$BACKUP/storage.tar.gz"

echo "Comparing row counts with the manifest:"
compare_counts "$BACKUP" || { echo "ROW COUNT MISMATCH after restore" >&2; exit 1; }

echo "restore OK: $BACKUP -> project '$TARGET'"
if [ "$INTO_PROD" -eq 1 ]; then
  echo "Next: cd $PROJECT_DIR && docker compose up -d --build"
fi
