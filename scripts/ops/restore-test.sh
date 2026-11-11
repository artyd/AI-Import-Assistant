#!/usr/bin/env bash
# Restore drill: proves that the newest (or a given) backup really restores.
#
#   bash scripts/ops/restore-test.sh [backup-dir]
#
# Restores into the scratch compose project (RESTORE_PROJECT_NAME, default
# "aiia-restore") through restore.sh, then checks row counts against the manifest and
# a random sample of files (SAMPLE_FILES, default 20) against the archive. Prints
# PASS/FAIL and the elapsed time (the measured RTO). The scratch project is always
# torn down afterwards (KEEP_SCRATCH=1 keeps it for debugging). Production volumes
# are never touched.
# Environment: see scripts/ops/lib.sh.
set -Eeuo pipefail

# shellcheck source=scripts/ops/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SAMPLE_FILES="${SAMPLE_FILES:-20}"
SCRATCH="${RESTORE_PROJECT_NAME:-aiia-restore}"
PROD="$(prod_project_name)"
RESULT="FAIL"
FAILURES=0

if [ "$SCRATCH" = "$PROD" ]; then
  echo "REFUSING: scratch project '$SCRATCH' is the production project." >&2
  exit 2
fi
case "$SCRATCH" in
  '' | *[!a-z0-9_-]*) echo "bad RESTORE_PROJECT_NAME '$SCRATCH'" >&2; exit 2 ;;
esac

BACKUP="${1:-$(latest_backup)}"
BACKUP="${BACKUP%/}"
[ -n "$BACKUP" ] || { echo "no complete backup found in $BACKUP_DIR" >&2; exit 1; }

teardown() {
  # Only ever touches the scratch project (name asserted != production above).
  if [ "${KEEP_SCRATCH:-0}" = "1" ]; then
    echo "KEEP_SCRATCH=1: leaving project '$SCRATCH' running"
    return 0
  fi
  CP="$SCRATCH" dc down -v --remove-orphans >/dev/null 2>&1 || true
  docker volume ls -q --filter "label=com.docker.compose.project=$SCRATCH" |
    xargs -r docker volume rm -f >/dev/null 2>&1 || true
}
finish() {
  local rc=$?
  teardown
  if [ "$RESULT" != "PASS" ] && [ "$rc" -eq 0 ]; then rc=1; fi
  echo "RESTORE DRILL $RESULT in ${SECONDS}s (measured RTO) - backup $(basename "$BACKUP"), scratch project '$SCRATCH'"
  exit "$rc"
}
trap finish EXIT

teardown # start from a clean slate

echo "== restore drill: $BACKUP -> project '$SCRATCH' =="
bash "$LIB_DIR/restore.sh" "$BACKUP"

CP="$SCRATCH"
VOLUME="$(storage_volume "$SCRATCH")"
[ -n "$VOLUME" ] || { echo "scratch storage volume missing" >&2; exit 1; }

echo "== row counts vs manifest =="
compare_counts "$BACKUP" || FAILURES=$((FAILURES + 1))

echo "== storage file count vs manifest =="
EXPECTED_FILES="$(manifest_value "$BACKUP" storage_file_count)"
ACTUAL_FILES="$(docker run --rm -v "$VOLUME:/data:ro" "$ALPINE_IMAGE" sh -c 'find /data -type f | wc -l' | tr -d ' ')"
if [ "$EXPECTED_FILES" = "$ACTUAL_FILES" ]; then
  echo "  ok    $ACTUAL_FILES files"
else
  echo "  FAIL  manifest=$EXPECTED_FILES restored=$ACTUAL_FILES"
  FAILURES=$((FAILURES + 1))
fi

echo "== sample of up to $SAMPLE_FILES files vs archive =="
# Regular files only ('-' in `tar tv`). The storage tree (`_tree/`) is made of hard links;
# tar stores the second name of a hard-linked file as a link entry with no data, so
# `tar xO` of that entry prints nothing and would look like an empty (corrupt) file.
mapfile -t SAMPLE < <(tar --quoting-style=literal -tvzf "$BACKUP/storage.tar.gz" |
  sed -nE 's/^-[^ ]+ +[^ ]+ +[0-9]+ +[0-9-]+ +[0-9:]+ //p' | shuf -n "$SAMPLE_FILES" || true)
if [ "${#SAMPLE[@]}" -eq 0 ]; then
  echo "  (archive holds no files - nothing to sample)"
else
  EXPECT_FILE="$(mktemp)"
  ACTUAL_FILE="$(mktemp)"
  trap 'rm -f "$EXPECT_FILE" "$ACTUAL_FILE"; finish' EXIT
  for m in "${SAMPLE[@]}"; do
    rel="${m#./}"
    printf '%s  /data/%s\n' "$(tar xzOf "$BACKUP/storage.tar.gz" -- "$m" | sha256sum | cut -d' ' -f1)" "$rel" >>"$EXPECT_FILE"
  done
  for m in "${SAMPLE[@]}"; do printf '%s\n' "${m#./}"; done |
    docker run --rm -i -v "$VOLUME:/data:ro" "$ALPINE_IMAGE" \
      sh -c 'while IFS= read -r f; do sha256sum "/data/$f"; done' >"$ACTUAL_FILE"
  if diff <(sort "$EXPECT_FILE") <(sort "$ACTUAL_FILE") >/dev/null; then
    echo "  ok    ${#SAMPLE[@]} files identical to the archive"
  else
    echo "  FAIL  sampled files differ from the archive:"
    diff <(sort "$EXPECT_FILE") <(sort "$ACTUAL_FILE") || true
    FAILURES=$((FAILURES + 1))
  fi
fi

if [ "$FAILURES" -eq 0 ]; then RESULT="PASS"; else exit 1; fi
