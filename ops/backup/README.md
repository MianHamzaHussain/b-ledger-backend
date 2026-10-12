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

It prints `Public key: age1…`. Copy that line; it goes in step 5. Store
`bledger-backup.key` safely, as described above.

### 3. Give MongoDB a backup-only user

The backup user can read every database but cannot change anything.

```bash
mongosh "mongodb://<admin-user>@127.0.0.1:27017/admin"
```

```js
db.getSiblingDB('admin').createUser({
  user: 'bledger_backup',
  pwd: passwordPrompt(),
  roles: [{ role: 'backup', db: 'admin' }]
});
```

While you are in mongosh, note the live database's name:
`db.adminCommand({ listDatabases: 1 }).databases.map(d => d.name)`.
`restore.sh` assumes `b_ledger`; set `SOURCE_DB=` if it is different.

### 4. Set up the B2 bucket

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

### 5. Connect rclone and write the config

Cron runs the backup as root, so configure rclone as root too:

```bash
sudo rclone config
#   n  (new remote) → name: b2 → storage: b2
#   account: <keyID>   key: <applicationKey>   everything else: default
sudo rclone lsd b2:bledger-backups-qamar     # must not error
```

Then write the config files:

```bash
sudo install -d -m 700 /etc/bledger-backup
sudo install -m 600 ops/backup/backup.env.example /etc/bledger-backup/backup.env
sudo nano /etc/bledger-backup/backup.env
#   AGE_RECIPIENT=age1…                 (from step 2)
#   RCLONE_REMOTE=b2:bledger-backups-qamar
```

```bash
sudo nano /etc/bledger-backup/mongodump.yaml
#   uri: mongodb://bledger_backup:<password>@127.0.0.1:27017/?authSource=admin
sudo chmod 600 /etc/bledger-backup/mongodump.yaml
```

If the password contains `@ : / ? # %`, URL-encode it. For example, `@`
becomes `%40`.

### 6. Install, then run once by hand

```bash
sudo install -m 755 ops/backup/backup.sh  /usr/local/bin/bledger-backup
sudo install -m 755 ops/backup/restore.sh /usr/local/bin/bledger-restore
sudo install -m 644 ops/backup/bledger-backup.cron /etc/cron.d/bledger-backup

sudo bledger-backup                          # prints "… ok mongo-….age 1.2M"
sudo rclone ls b2:bledger-backups-qamar      # shows hourly/mongo-….age
```

After that, cron runs it at minute 7 of every hour. The log is
`/var/log/bledger-backup.log`.

### 7. Alerts

1. Sign up at healthchecks.io (free) → **Add Check**.
2. Set **Period 1 hour, Grace 30 minutes**.
3. Add your email, or WhatsApp/Telegram, as an integration.
4. Put the ping URL in `HEALTHCHECK_URL=` in `/etc/bledger-backup/backup.env`.

You now get a message if a backup fails or stops arriving.

### 8. Prove the restore works: do this now, then once a month

Follow **Restoring** below with the newest backup into `b_ledger_restore_test`.
Check that the counts match the live database, then drop the test database.

---

## Restoring

Never restore straight over the live database. Restore under a new name,
check it, and only then switch.

1. **Pick the backup.**

   ```bash
   sudo rclone ls b2:bledger-backups-qamar | sort -k2
   ```

2. **Bring the private key to the server for the restore only.** From your
   laptop:

   ```powershell
   scp bledger-backup.key <user>@<vps>:/tmp/k
   ```

3. **Write `/etc/bledger-backup/restore.yaml`** (chmod 600). It needs a user
   with the `restore` role, such as your admin user:

   ```yaml
   uri: mongodb://<admin-user>:<password>@127.0.0.1:27017/?authSource=admin
   ```

4. **Restore into a new database name:**

   ```bash
   sudo bledger-restore b2:bledger-backups-qamar/hourly/mongo-2026-10-12_1400.archive.gz.age /tmp/k b_ledger_restored
   shred -u /tmp/k
   ```

5. **Check `b_ledger_restored`.** Look at order counts and the latest
   payments.
6. **Switch over.** Either:
   - point `MONGODB_URI` in `.env` at `b_ledger_restored` and run
     `pm2 restart bledger-api`; or
   - stop the API, rename the databases, and start it again.

   Keep the damaged database until you are sure.

**If the whole VPS is gone:**

1. Build a new server: Ubuntu, MongoDB 8, Node 24, pm2.
2. Clone the repo.
3. Restore the newest `daily/env-….age` with `age -d -i bledger-backup.key`
   to get `.env` back.
4. Restore the newest `hourly/` dump as above.
5. Repeat this setup on the new server.
