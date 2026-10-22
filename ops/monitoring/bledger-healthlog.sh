#!/usr/bin/env bash
# One line per run: time, HTTP status, seconds taken. Cron runs it every minute
# (see bledger-healthlog.cron); bledger-uptime reads the result.
#
#   2026-10-23T02:07:01+02:00 200 0.012
#
# Installed as /usr/local/bin/bledger-healthlog. Setup: ops/monitoring/README.md.
URL="${HEALTH_URL:-http://127.0.0.1:5000/api/v1/health}"
LOG="${HEALTH_LOG:-/var/log/bledger-health.log}"

# -m 5: a hung API counts as down after 5 seconds instead of blocking the next run.
out=$(curl -s -o /dev/null -m 5 -w "%{http_code} %{time_total}" "$URL" 2>/dev/null) || out="000 0"
echo "$(date -Is) $out" >>"$LOG"
