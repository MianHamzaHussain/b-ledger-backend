# Backups

Every hour the VPS dumps MongoDB, encrypts it, keeps 48 hours of copies on the
server and copies each one to Backblaze B2. The bucket keeps:

| Folder     | What                        | Kept    |
| ---------- | --------------------------- | ------- |
| `hourly/`  | every hour                  | 2 days  |
| `daily/`   | the 00:00 dump + the `.env` | 31 days |
| `monthly/` | the 00:00 dump on the 1st   | 1 year  |

Times in file names are Pakistan time: `mongo-2026-10-12_1400.archive.gz.age`
is 2pm on 12 October.

**Why this design:**

- Everything is encrypted with [age](https://age-encryption.org) before it
  leaves the server. The private key is **not on the VPS**, so someone who
  breaks into the server, or into B2, still cannot read the backups.
- The script never deletes anything in B2. The bucket's lifecycle rules expire
  old files, so the key on the server only needs to write.
- A missed or failed backup sends an alert through healthchecks.io.

> **Lose the age private key and every backup is useless.** Keep it in your
> password manager **and** in one more place (a USB drive or a printed copy).

---

## One-time setup

Run on the VPS as a sudo user, from the deployed repo
(`/var/www/sites/b-ledger-backend`), unless a step says "on your laptop".

### 1. Install the tools

```bash
sudo apt update && sudo apt install -y age rclone cron curl
```

### 2. Make the encryption key (on your laptop, not the VPS)

```powershell
winget install FiloSottile.age
age-keygen -o bledger-backup.key
```

It prints `Public key: age1…`. Copy that line; it goes in step 4. Store
`bledger-backup.key` safely, as described above.

### 3. Set up the B2 bucket

1. Sign up at backblaze.com → **B2 Cloud Storage**. The first 10 GB are free.
2. **Create a bucket**:
   - **Private**.
   - The name must be unique worldwide, for example `bledger-backups-qamar`.
   - Turn default encryption on.
3. Open the bucket → **Lifecycle Settings** → **Use custom lifecycle rules**,
   and add three rules:

   | File name prefix | Days till hide | Days till delete |
   | ---------------- | -------------- | ---------------- |
   | `hourly/`        | 2              | 1                |
   | `daily/`         | 31             | 1                |
   | `monthly/`       | 366            | 1                |

4. **Application Keys** → **Add a New Application Key**:
   - Restrict it to this bucket only.
   - Choose Read and Write.
   - Copy the **keyID** and **applicationKey**. B2 shows the key only once.

### 4. Connect rclone and write the settings

Cron runs the backup as root, so configure rclone as root too:

```bash
sudo rclone config
#   n  (new remote) → name: b2 → storage: b2
#   account: <keyID>   key: <applicationKey>   everything else: default
sudo rclone lsd b2:                          # must list your bucket
```

Then the settings file. **There is no database login to set up:** the script
reads `MONGODB_URI` from the app's own `.env`, so it dumps the same database
the app uses, with the same login.

```bash
cd /var/www/sites/b-ledger-backend
sudo install -d -m 700 /etc/bledger-backup
sudo install -m 600 ops/backup/backup.env.example /etc/bledger-backup/backup.env
sudo nano /etc/bledger-backup/backup.env
#   AGE_RECIPIENT=age1…                 (from step 2)
#   RCLONE_REMOTE=b2:bledger-backups-qamar
```

Check the login works. This throws the data away and prints only the
`done dumping` lines:

```bash
sudo bash -c 'set -a; . /var/www/sites/b-ledger-backend/.env; mongodump --uri="$MONGODB_URI" --archive=/dev/null' 2>&1 | grep -c "done dumping"
```

A number above 0 means the login can read the database.

### 5. Install, then run once by hand

```bash
sudo install -m 755 ops/backup/backup.sh  /usr/local/bin/bledger-backup
sudo install -m 755 ops/backup/restore.sh /usr/local/bin/bledger-restore

sudo bledger-backup                          # prints "… ok mongo-….age 1.2M"
sudo rclone ls b2:bledger-backups-qamar      # shows hourly/mongo-….age
```

### 6. Alerts

1. Sign up at healthchecks.io (free) → **Add Check**.
2. Set **Period 1 hour, Grace 30 minutes**.
3. Add your email, or WhatsApp/Telegram, as an integration.
4. Put the ping URL in `HEALTHCHECK_URL=` in `/etc/bledger-backup/backup.env`,
   then run `sudo bledger-backup` once so the check turns green.

You now get a message if a backup fails or stops arriving.

### 7. Prove the restore works

Do this before turning on the schedule, then once a month. See **Testing a
restore** below. The test never touches the live database.

### 8. Turn on the schedule

```bash
sudo install -m 644 ops/backup/bledger-backup.cron /etc/cron.d/bledger-backup
```

Cron runs it at minute 7 of every hour. The log is
`/var/log/bledger-backup.log`.

---

## Testing a restore

This restores into a **throwaway MongoDB on port 27018**, so it needs no extra
users and cannot hurt the live data. Do it after each setup change and once a
month.

1. **Pick the newest backup** and bring the private key up for this test only.
   From your laptop:

   ```powershell
   scp $HOME\bledger-keys\bledger-backup.key <user>@<vps>:/tmp/k
   ```

2. **Start the throwaway server** on the VPS:

   ```bash
   mkdir -p /tmp/rt && mongod --dbpath /tmp/rt --port 27018 --bind_ip 127.0.0.1 \
     --fork --logpath /tmp/rt/mongod.log
   printf 'uri: mongodb://127.0.0.1:27018\n' | sudo tee /etc/bledger-backup/restore.yaml >/dev/null
   sudo chmod 600 /etc/bledger-backup/restore.yaml
   ```

3. **Restore the newest backup:**

   ```bash
   sudo rclone ls b2:bledger-backups-qamar/hourly/ | sort -k2 | tail -1
   sudo chmod 600 /tmp/k
   sudo bledger-restore b2:bledger-backups-qamar/hourly/<newest file> /tmp/k bledger_restored
   ```

4. **Check the counts.** The test copy should hold the same collections as
   the live one:

   ```bash
   mongosh --port 27018 --quiet --eval \
     'db.getSiblingDB("bledger_restored").getCollectionNames().forEach(c => print(c, db.getSiblingDB("bledger_restored")[c].countDocuments()))'
   ```

   Compare a few numbers (orders, parties) with the app. A collection written
   to since that hour may be slightly lower, which is fine.

5. **Clean up:**

   ```bash
   mongod --dbpath /tmp/rt --shutdown
   rm -rf /tmp/rt && sudo shred -u /tmp/k /etc/bledger-backup/restore.yaml
   ```

---

## Recovering real data

Use this when data was deleted or broken. Take your time and keep the damaged
copy.

1. **Pick the last good backup** with `sudo rclone ls b2:bledger-backups-qamar`.
   Choose `hourly/` for the last two days, `daily/` for the last month, and
   `monthly/` for older.
2. **Take a safety backup of the damaged state first**: `sudo bledger-backup`.
3. **Stop the app:** `pm2 stop bledger-api`.
4. **Restore it over the live database.** `--drop` replaces each collection
   with the backup's copy:

   ```bash
   scp bledger-backup.key <user>@<vps>:/tmp/k          # from your laptop
   sudo bash -c 'set -a; . /var/www/sites/b-ledger-backend/.env
     rclone cat b2:bledger-backups-qamar/hourly/<file> | age -d -i /tmp/k |
     mongorestore --uri="$MONGODB_URI" --archive --gzip --drop'
   sudo shred -u /tmp/k
   ```

5. **Start the app:** `pm2 start bledger-api`, then check the latest orders and
   payments in the app.

**If the whole VPS is gone:**

1. Build a new server: Ubuntu, MongoDB 8 with a user for the app, Node 24, pm2.
2. Clone the repo to `/var/www/sites/b-ledger-backend`.
3. Download the newest `daily/env-….age` from the B2 website, then decrypt it:
   `age -d -i bledger-backup.key env-….age > .env`.
4. Restore the newest `hourly/` dump as in step 4 above.
5. Run `npm ci --omit=dev`, start with pm2, point DNS at the new server, and
   repeat this setup.
