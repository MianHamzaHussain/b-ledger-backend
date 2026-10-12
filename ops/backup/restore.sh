#!/usr/bin/env bash
# Restore one backup into a NEW database name, never over the live one.
# Compare, then switch MONGODB_URI (or copy back) once you are sure.
#
#   restore.sh <backup file or rclone path> <age key file> <target db name>
#
#   restore.sh b2:bledger-backups/hourly/mongo-2026-10-12_1400.archive.gz.age \
#              ~/bledger-backup.key bledger_restored
set -euo pipefail

SRC="${1:?backup file (local path or remote:path)}"
KEY="${2:?age private key file}"
TARGET="${3:?target database name, e.g. bledger_restored}"
# The live database name, read from the app's .env unless given.
ENV_FILE="${ENV_FILE:-/var/www/sites/b-ledger-backend/.env}"
SOURCE_DB="${SOURCE_DB:-$(grep -m1 '^MONGODB_URI=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'" | sed -E 's|^[^/]*//[^/]*/([^?]*).*|\1|')}"
# Where to restore to: a throwaway test server, or the real one in a disaster.
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
