# B Ledger — Backend API

REST API for the B Ledger operations platform: multiple e-commerce
businesses (Shopify stores, social pages, WhatsApp) tracked in one system —
orders, payments, expenses and per-business profit/loss.

Built with Node.js, Express and MongoDB.

> **Conventions:** see [CLAUDE.md](./CLAUDE.md) for the coding standard,
> folder rules and the authorization model. Read §6 before adding routes.

## Requirements

- **Node.js ≥ 22** (the `--env-file` flag used by the npm scripts needs 20.6+)
- MongoDB (local or Atlas)

## Setup

```bash
npm install
cp example.env .env     # then fill in the values
npm run seed            # creates the Admin role + first admin user
npm run dev
```

`npm run seed` reads `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD` and
`SEED_ADMIN_PHONE` from `.env`. There is deliberately no default password —
the seeder exits if they are unset.

## Scripts

| Command                | Purpose                                                        |
| ---------------------- | -------------------------------------------------------------- |
| `npm run dev`          | Development with hot reload                                    |
| `npm start`            | Production                                                     |
| `npm run seed`         | Create Admin role + first admin (idempotent)                   |
| `npm run seed:destroy` | Wipe users/roles/businesses (refuses if `NODE_ENV=production`) |

## API

- Base path: `/api/v1`
- Interactive docs: `/api-docs`
- Health check: `/api/v1/health`

Authenticate with `Authorization: Bearer <token>` from `POST /api/v1/auth/login`.

### Authorization in one paragraph

Each user has one **role**, which carries a grid of `resource → actions` with a
read **scope**. Actions are `read`, `create`, `update`, `delete`. Scope is `all`
(every row) or `own` (only rows belonging to the user's `assignedBusinesses`).
Per-user **overrides** can grant or deny on top of the role — deny always wins.
The **Admin** role has `fullAccess`, which bypasses the grid entirely and cannot
be edited or deleted.

`GET /api/v1/roles/registry` returns every permissionable resource so the admin
UI can render its checkbox grid without hardcoding names.

## Notes

- Uploads are not configured. If you add them, note that writing to `public/`
  does **not** persist on Vercel serverless — use object storage.
- Web Push requires a VAPID keypair: `npx web-push generate-vapid-keys`.
  Never commit it.
