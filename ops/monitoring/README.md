# Uptime monitoring

How to know whether B Ledger was up, for how long it was down, and to be told when
it goes down. Two layers, because each one sees what the other cannot.

| Layer            | Runs where          | Sees                                                        | Misses                                                        |
| ---------------- | ------------------- | ----------------------------------------------------------- | ------------------------------------------------------------- |
| 1. UptimeRobot   | outside, on the web | what a real user sees: DNS, Cloudflare, nginx, the API      | nothing about _why_; checks only every 5 minutes              |
| 2. On-server log | on the VPS          | every minute, with response time; also when the VPS was off | DNS / nginx / Cloudflare problems (it calls the API directly) |

Use both. Layer 1 **tells you** when something breaks. Layer 2 **tells you the numbers**
afterwards (`bledger-uptime`).

---

## Layer 1 — UptimeRobot (alerts)

Free plan is enough. Sign up at uptimerobot.com, then **Add New Monitor** twice:

1. **API** — type _Keyword_, URL `https://backend.bledger.org/api/v1/health`,
   keyword `"status":"ok"`, alert when the keyword is **not** found, interval 5 min.
2. **Site** — type _HTTP(s)_, URL `https://bledger.org/`, interval 5 min.

Add yourself as an alert contact (email, or Telegram). Optionally publish a status page.
UptimeRobot also shows a monthly uptime percentage per monitor.

---

## Layer 2 — on-server log (numbers)

Every minute cron calls the API's health endpoint and appends one line to
`/var/log/bledger-health.log`:

```
2026-10-23T02:07:01+02:00 200 0.012      time, HTTP status, seconds taken
```

### Install (once, on the VPS, from the backend folder)

```bash
cd /var/www/sites/b-ledger-backend
sudo install -m 755 ops/monitoring/bledger-healthlog.sh /usr/local/bin/bledger-healthlog
sudo install -m 755 ops/monitoring/bledger-uptime.sh    /usr/local/bin/bledger-uptime
sudo install -m 644 ops/monitoring/bledger-healthlog.cron /etc/cron.d/bledger-healthlog
```

Safe to run again; the log format is unchanged, so existing history is kept.

### Check uptime

```bash
sudo bledger-uptime        # last 7 days
sudo bledger-uptime 30     # last 30 days
```

Example:

```
Last 7 day(s): 2026-10-16 02:00:01  to  2026-10-23 01:59:01

Checks:            10078 (10070 answered, 8 did not)
API answered:      99.921% of checks
Availability:      99.881%   (outages and gaps counted as down)
Downtime:          12 min  (8 min outages + 4 min with no checks)

Outages:           1
  2026-10-19 14:03:01   down for 8 min
No-data gaps:      1   (server off, rebooting, or cron stopped)
  2026-10-21 03:00:01  to  2026-10-21 03:05:01   no checks for 4 min

Response time:     0.014 s average, 3.210 s slowest, 2 over 2 s
```

How to read it:

- **Outage** — the minute checks ran but the API did not answer 200. The line gives
  when it started and how long it lasted. `STILL DOWN` means it has not recovered.
- **No-data gap** — no check at all: the VPS was off or rebooting, or cron stopped.
  Counted as downtime, because nobody could use the app.
- **Availability** — the honest number: outages plus gaps count as down.
- **Slow responses** — answers taking more than 2 seconds; a warning sign before a crash.

| Availability | Downtime per month | Verdict                        |
| ------------ | ------------------ | ------------------------------ |
| 99.9%        | about 43 min       | excellent                      |
| 99.5%        | about 3.6 h        | acceptable — the target floor  |
| 99%          | about 7.3 h        | investigate the outages listed |

### Quick checks on the server

```bash
uptime -s                                                    # when the VPS last booted
systemctl show bledger-api -p ActiveEnterTimestamp -p NRestarts   # API start time, restarts
journalctl -u bledger-api --since "24 hours ago" | grep -ci started   # starts in 24 h
tail -n 5 /var/log/bledger-health.log                        # latest checks
```

A rising `NRestarts` means the API keeps crashing and systemd keeps reviving it, even
if the percentages still look fine.

### Troubleshooting

- **Log is not growing** — `systemctl status cron`, then `ls -l /etc/cron.d/bledger-healthlog`
  and `sudo /usr/local/bin/bledger-healthlog; tail -n 1 /var/log/bledger-health.log`.
- **`No health log at …`** — the logger is not installed; run the install block above.
- **Disk use** — about 2 MB a month, so no rotation is needed.

### Honest limits

The logger calls `127.0.0.1:5000` directly, so it cannot see a DNS, Cloudflare or nginx
failure, and it cannot log while the VPS itself is off (that shows up as a gap, after
the fact). That is why Layer 1 exists: it checks from outside.
