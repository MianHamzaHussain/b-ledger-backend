#!/usr/bin/env bash
# Hourly MongoDB backup: dump → encrypt → keep locally → copy off-site.
# Installed as /usr/local/bin/bledger-backup and run by /etc/cron.d/bledger-backup.
# Setup and restore steps: ops/backup/README.md.
set -euo pipefail

CONFIG=/etc/bledger-backup/backup.env
# shellcheck source=/dev/null
source "$CONFIG"

: "${AGE_RECIPIENT:?set AGE_RECIPIENT in $CONFIG}"
: "${RCLONE_REMOTE:?set RCLONE_REMOTE in $CONFIG}"
LOCAL_DIR="${LOCAL_DIR:-/var/backups/bledger}"
LOCAL_KEEP_HOURS="${LOCAL_KEEP_HOURS:-48}"
ENV_FILE="${ENV_FILE:-/var/www/sites/b-ledger-backend/.env}"

notify() { [ -n "${HEALTHCHECK_URL:-}" ] && curl -fsS -m 10 --retry 3 -o /dev/null "$HEALTHCHECK_URL$1" || true; }
# A backup that fails quietly is worse than none — tell the healthcheck so it alerts.
trap 'echo "$(date -Is) backup FAILED" >&2; notify /fail' ERR

# Two runs overlapping would race on the same file name.
exec 9>/run/lock/bledger-backup.lock
flock -n 9 || { echo "$(date -Is) previous backup still running, skipping"; exit 0; }

# Named in Pakistan time because that is how the owners will ask for "yesterday 4pm".
STAMP=$(TZ=Asia/Karachi date +%F_%H00)
HOUR=$(TZ=Asia/Karachi date +%H)
DAY=$(TZ=Asia/Karachi date +%d)
NAME="mongo-$STAMP.archive.gz.age"

umask 077
mkdir -p "$LOCAL_DIR"
TMP="$LOCAL_DIR/.$NAME.partial"

# Same login and database as the app, read from its own .env so there is nothing
# to keep in sync. It goes through a private temp file rather than the command
# line, so the password never shows up in `ps`.
URI=$(grep -m1 '^MONGODB_URI=' "$ENV_FILE" | cut -d= -f2- | tr -d "\"'")
DB_NAME=$(printf %s "$URI" | sed -E 's|^[^/]*//[^/]*/([^?]*).*|\1|')
[ -n "$URI" ] && [ -n "$DB_NAME" ] || { echo "no MONGODB_URI with a database name in $ENV_FILE" >&2; false; }
MONGO_CFG=$(mktemp)
trap 'rm -f "$MONGO_CFG"' EXIT
printf 'uri: %s\n' "$URI" >"$MONGO_CFG"

mongodump --config="$MONGO_CFG" --db="$DB_NAME" --archive --gzip --quiet |
  age -r "$AGE_RECIPIENT" >"$TMP"
[ -s "$TMP" ] || { echo "empty dump" >&2; false; }
mv "$TMP" "$LOCAL_DIR/$NAME"

# Retention is enforced by the bucket's lifecycle rules, not here, so the key on
# this server never needs delete rights (see README → Storage).
rclone copyto "$LOCAL_DIR/$NAME" "$RCLONE_REMOTE/hourly/$NAME"
if [ "$HOUR" = "00" ]; then
  rclone copyto "$LOCAL_DIR/$NAME" "$RCLONE_REMOTE/daily/$NAME"
  age -r "$AGE_RECIPIENT" <"$ENV_FILE" | rclone rcat "$RCLONE_REMOTE/daily/env-$STAMP.age"
  if [ "$DAY" = "01" ]; then
    rclone copyto "$LOCAL_DIR/$NAME" "$RCLONE_REMOTE/monthly/$NAME"
  fi
fi

find "$LOCAL_DIR" -name 'mongo-*.age' -mmin +$((LOCAL_KEEP_HOURS * 60)) -delete
find "$LOCAL_DIR" -name '.*.partial' -mmin +120 -delete

echo "$(date -Is) ok $NAME $(du -h "$LOCAL_DIR/$NAME" | cut -f1)"
notify ""
