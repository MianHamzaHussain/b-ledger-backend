#!/usr/bin/env bash
# Restore one backup into a NEW database name, never over the live one.
# Compare, then switch MONGODB_URI (or copy back) once you are sure.
#
#   restore.sh <backup file or rclone path> <age key file> <target db name>
#
#   restore.sh b2:bledger-backups/hourly/mongo-2026-10-12_1400.archive.gz.age \
#              ~/bledger-backup.key b_ledger_restored
set -euo pipefail

SRC="${1:?backup file (local path or remote:path)}"
KEY="${2:?age private key file}"
TARGET="${3:?target database name, e.g. b_ledger_restored}"
# The live database name; override if production uses a different one.
SOURCE_DB="${SOURCE_DB:-b_ledger}"
URI_FILE="${URI_FILE:-/etc/bledger-backup/restore.yaml}"

if [ "$TARGET" = "$SOURCE_DB" ]; then
  echo "Refusing to restore over the live database '$SOURCE_DB'. Pick a new name." >&2
  exit 1
fi

if [ -f "$SRC" ]; then read_src() { cat "$SRC"; }; else read_src() { rclone cat "$SRC"; }; fi

read_src | age -d -i "$KEY" |
  mongorestore --config="$URI_FILE" --archive --gzip \
    --nsInclude="$SOURCE_DB.*" --nsFrom="$SOURCE_DB.*" --nsTo="$TARGET.*"

echo "Restored $SOURCE_DB → $TARGET. Check it with:"
echo "  mongosh --quiet \"<admin uri>\" --eval 'db.getSiblingDB(\"$TARGET\").getCollectionNames().forEach(c=>print(c, db.getSiblingDB(\"$TARGET\")[c].countDocuments()))'"
