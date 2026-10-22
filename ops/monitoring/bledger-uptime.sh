#!/usr/bin/env bash
# How much of the last N days (default 7) the API was up, read from the health log
# that bledger-healthlog writes every minute.
#
#   bledger-uptime        last 7 days
#   bledger-uptime 30     last 30 days
#
# It reports three kinds of trouble:
#   - checks where the API did not answer 200 (an outage, with its start and length),
#   - gaps with no check at all (the whole server was off, rebooting, or cron stopped),
#   - slow answers.
# Installed as /usr/local/bin/bledger-uptime. Setup: ops/monitoring/README.md.
set -euo pipefail

DAYS="${1:-7}"
LOG="${HEALTH_LOG:-/var/log/bledger-health.log}"

case "$DAYS" in '' | *[!0-9]* | 0) echo "usage: bledger-uptime [days]   (a whole number, 1 or more)" >&2; exit 2 ;; esac
[ -r "$LOG" ] || { echo "No health log at $LOG — is the logger installed? See ops/monitoring/README.md." >&2; exit 1; }

NOW="${NOW_EPOCH:-$(date +%s)}"

# Plain POSIX awk (the server's awk is mawk): the timestamps are turned into seconds by
# hand, so nothing here needs gawk or a per-line call to date.
awk -v now="$NOW" -v days="$DAYS" -v slow=2 -v gapmax=150 '
# "2026-10-23T02:07:01+02:00" -> seconds since 1970 (UTC).
function epoch(s,   y, m, d, era, yoe, doy, doe, off, sign) {
  y = substr(s, 1, 4) + 0; m = substr(s, 6, 2) + 0; d = substr(s, 9, 2) + 0
  if (m <= 2) y -= 1
  era = int(y / 400); yoe = y - era * 400
  doy = int((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1
  doe = yoe * 365 + int(yoe / 4) - int(yoe / 100) + doy
  off = 0
  if (length(s) >= 25) {
    sign = (substr(s, 20, 1) == "-") ? -1 : 1
    off = sign * (substr(s, 21, 2) * 3600 + substr(s, 24, 2) * 60)
  }
  return (era * 146097 + doe - 719468) * 86400 + substr(s, 12, 2) * 3600 + substr(s, 15, 2) * 60 + substr(s, 18, 2) - off
}
function span(sec,   m) {
  m = int(sec / 60 + 0.5)
  if (m < 60) return m " min"
  return int(m / 60) " h " (m % 60) " min"
}
function human(s) { return substr(s, 1, 10) " " substr(s, 12, 8) }

NF >= 3 && $1 ~ /^[0-9][0-9][0-9][0-9]-/ {
  e = epoch($1)
  if (e < now - days * 86400) next
  n++
  if (n == 1) { first_e = e; first_s = $1 }
  if (prev_e && e - prev_e > gapmax) {
    gaps++; gapsec += e - prev_e - 60
    gapline[gaps] = "  " human(prev_s) "  to  " human($1) "   no checks for " span(e - prev_e - 60)
  }
  down = ($2 != 200)
  if (down) { fail++ } else { ok++ }
  if (down && !inout) { inout = 1; out_e = e; out_s = $1 }
  if (!down && inout) {
    outages++; outsec += e - out_e
    outline[outages] = "  " human(out_s) "   down for " span(e - out_e)
    inout = 0
  }
  t = $3 + 0; sumt += t; if (t > maxt) maxt = t; if (t > slow) nslow++
  prev_e = e; prev_s = $1
}
END {
  if (!n) { print "No checks in the last " days " day(s) — is the logger running?"; exit 1 }
  if (inout) {
    outages++; outsec += prev_e - out_e + 60
    outline[outages] = "  " human(out_s) "   STILL DOWN (" span(prev_e - out_e + 60) " so far)"
  }
  total = prev_e - first_e + 60
  avail = 100 * (1 - (outsec + gapsec) / total)
  if (avail < 0) avail = 0
  printf "Last %d day(s): %s  to  %s\n\n", days, human(first_s), human(prev_s)
  printf "Checks:            %d (%d answered, %d did not)\n", n, ok, fail
  printf "API answered:      %.3f%% of checks\n", 100 * ok / n
  printf "Availability:      %.3f%%   (outages and gaps counted as down)\n", avail
  printf "Downtime:          %s  (%s outages + %s with no checks)\n\n", span(outsec + gapsec), span(outsec), span(gapsec)
  printf "Outages:           %d\n", outages
  for (i = 1; i <= outages; i++) print outline[i]
  printf "No-data gaps:      %d%s\n", gaps, (gaps ? "   (server off, rebooting, or cron stopped)" : "")
  for (i = 1; i <= gaps; i++) print gapline[i]
  printf "\nResponse time:     %.3f s average, %.3f s slowest, %d over %d s\n", sumt / n, maxt, nslow, slow
}
' "$LOG"
