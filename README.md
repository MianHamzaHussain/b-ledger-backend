# B Ledger — Backend API

REST API for the **B Ledger** operations platform: several e-commerce
businesses (Shopify storefronts, social pages, WhatsApp) run from one system —
orders, dispatch, payments, expenses, double-entry accounting and per-business
profit & loss.

Node.js · Express · MongoDB · Socket.io · JWT auth.

> **Coding standard:** [`CLAUDE.md`](./CLAUDE.md) owns the conventions, folder
> rules and the authorization model. Read §6 before touching any route.

---

## Table of contents

- [Prerequisites](#prerequisites)
- [Quick start](#quick-start)
- [Environment variables](#environment-variables)
- [Running the server](#running-the-server-dev--prod)
- [Seeding the first admin](#seeding-the-first-admin)
- [Scripts](#scripts)
- [Testing](#testing)
- [Logging](#logging)
- [The API](#the-api)
- [Deploying to production](#deploying-to-production)
- [Troubleshooting](#troubleshooting)

---

## Prerequisites

| Tool        | Version                | Notes                                                                     |
| ----------- | ---------------------- | ------------------------------------------------------------------------- |
| **Node.js** | **24 LTS** (`24.18.0`) | pinned in `.nvmrc` — run `nvm use`. Needs ≥ 20.6 anyway for `--env-file`. |
| **MongoDB** | 6 or 7                 | local (`mongodb://localhost:27017`) or MongoDB Atlas.                     |
| **Mailpit** | optional               | local email catcher for dev — SMTP `1025`, inbox `:8025`.                 |

```bash
nvm use            # picks up .nvmrc (24.18.0)
```

There is **no `dotenv`** — the npm scripts load env with Node's built-in
`--env-file=.env`.

---

## Quick start

```bash
npm install
cp example.env .env      # then open .env and fill in the required values
npm run seed             # creates the Admin role + your first admin user
npm run dev              # starts on http://localhost:5000 with hot reload
```

The **minimum** you must set in `.env` before this works:

- `MONGODB_URI` — a reachable MongoDB.
- `JWT_SECRET` — any long random string (generate one below).
- `SEED_ADMIN_PASSWORD` (+ email/phone) — the seeder refuses to run without a
  password; there is deliberately no default.

Generate a JWT secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

> The server **fails fast**: if `MONGODB_URI` or `JWT_SECRET` is missing it
> exits immediately with a message naming the variable (see `config/env.js`),
> rather than breaking later at first login.

### Running the whole stack (API + web app)

Two terminals, two repos:

```bash
# terminal 1 — this repo
cd backend  && npm install && cp example.env .env && npm run seed && npm run dev

# terminal 2 — the web app
cd frontend && npm install && cp .env.example .env && npm run dev
```

The frontend dev server (`:3000`) proxies `/api` to this API (`:5000`), so both
run **same-origin** in development — no CORS to configure. See
[`../frontend/README.md`](../frontend/README.md).

---

## Environment variables

Every variable, copied from [`example.env`](./example.env). **Required** ones
have no safe default; the rest fall back sensibly for local dev.

### Core

| Variable    | Required | Example / default             | Purpose                                                            |
| ----------- | :------: | ----------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`  |    –     | `development`                 | `development` \| `production` \| `test`.                           |
| `PORT`      |    –     | `5000`                        | Port the API listens on.                                           |
| `APP_NAME`  |    –     | `B Ledger`                    | Shown in emails and the seeder.                                    |
| `LOG_LEVEL` |    –     | `info` (prod) / `debug` (dev) | pino level: `trace`…`fatal`, or `silent`. See [Logging](#logging). |

### Database & auth

| Variable                    | Required | Example                             | Purpose                                                                    |
| --------------------------- | :------: | ----------------------------------- | -------------------------------------------------------------------------- |
| `MONGODB_URI`               | **yes**  | `mongodb://localhost:27017/bledger` | The database. Atlas / VPS URI in production.                               |
| `JWT_SECRET`                | **yes**  | _(48-byte random hex)_              | Signs the access token. Keep it secret.                                    |
| `JWT_ACCESS_EXPIRE`         |    –     | `15m`                               | Short access-token lifetime (the client refreshes it from the cookie).     |
| `REFRESH_TOKEN_EXPIRE_DAYS` |    –     | `30`                                | Refresh-token (httpOnly cookie) lifetime, in days.                         |
| `COOKIE_SAMESITE`           |    –     | `lax`                               | Refresh-cookie SameSite. `lax` same-origin; `none` (HTTPS) cross-origin.   |
| `COOKIE_SECURE`             |    –     | _(auto in prod)_                    | Force `Secure` on the cookie outside production (e.g. behind a TLS proxy). |

**Auth model.** Login returns a short **access** JWT in the body (sent as
`Authorization: Bearer`) and sets a long-lived **refresh** token as an
**httpOnly** cookie. The client trades the cookie for a new access token at
`POST /auth/refresh` (rotated on every call — a replay is rejected). Logout,
password change and reset bump a per-user `tokenVersion` that `protect`
re-checks, so a token can be revoked server-side.

### URLs & CORS

| Variable          | Required | Example                   | Purpose                                                                                                                                 |
| ----------------- | :------: | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `FRONTEND_URL`    |    –     | `http://localhost:3000`   | Builds invite / password-reset links **and** is an allowed origin.                                                                      |
| `ALLOWED_ORIGINS` |    –     | `https://app.b-ledger.pk` | Extra allowed origins, comma-separated. Governs **both** REST CORS and the **Socket.io** handshake. `localhost:3000` is always allowed. |
| `SERVER_URI`      |    –     | `http://localhost:5000`   | This API's public URL, shown in Swagger.                                                                                                |

> **Cross-origin production:** if the web app is served from a different host
> than this API, that host's URL **must** appear in `ALLOWED_ORIGINS` (or
> `FRONTEND_URL`) or its WebSocket handshake is rejected by CORS.

### Email (SMTP)

| Variable     | Required | Dev (Mailpit)          | Purpose                                    |
| ------------ | :------: | ---------------------- | ------------------------------------------ |
| `SMTP_HOST`  |    –     | `localhost`            | SMTP server.                               |
| `SMTP_PORT`  |    –     | `1025`                 | `465` = implicit TLS, else STARTTLS/plain. |
| `SMTP_USER`  |    –     | _(blank)_              | Leave blank for Mailpit (no auth).         |
| `SMTP_PASS`  |    –     | _(blank)_              |                                            |
| `FROM_NAME`  |    –     | `B Ledger`             | Sender name.                               |
| `FROM_EMAIL` |    –     | `no-reply@b-ledger.pk` | Sender address.                            |

### Web Push (PWA notifications)

| Variable            | Required | Purpose                                                               |
| ------------------- | :------: | --------------------------------------------------------------------- |
| `VAPID_PUBLIC_KEY`  |    –     | Public half — **must equal** `VITE_VAPID_PUBLIC_KEY` in the frontend. |
| `VAPID_PRIVATE_KEY` |    –     | Private half — **secret**, never commit.                              |
| `VAPID_MAILTO`      |    –     | Contact URI for the push service, e.g. `mailto:admin@…`.              |

Generate a fresh pair (do this per environment):

```bash
npx web-push generate-vapid-keys
```

### Seeder (`npm run seed`)

| Variable              | Required | Purpose                                         |
| --------------------- | :------: | ----------------------------------------------- |
| `SEED_ADMIN_NAME`     |    –     | First admin's display name.                     |
| `SEED_ADMIN_EMAIL`    | **yes**  | First admin's login email.                      |
| `SEED_ADMIN_PHONE`    | **yes**  | First admin's phone.                            |
| `SEED_ADMIN_PASSWORD` | **yes**  | First admin's password (≥ 8 chars). No default. |

---

## Running the server (dev & prod)

| Mode            | Command       | What it does                                                       |
| --------------- | ------------- | ------------------------------------------------------------------ |
| **Development** | `npm run dev` | `nodemon` + `--env-file=.env`, hot reload, pretty colourised logs. |
| **Production**  | `npm start`   | `node --env-file=.env`, JSON logs. Set `NODE_ENV=production`.      |

On a platform that injects env vars for you (Render, Railway, a Docker image),
you can run `node server.js` directly and drop `--env-file`.

---

## Seeding the first admin

```bash
npm run seed          # create the Admin role + first admin (idempotent — safe to re-run)
npm run seed:destroy  # wipe users/roles/businesses (refuses when NODE_ENV=production)
```

`seed` reads the `SEED_ADMIN_*` variables. Log in as that admin, then create
other roles and users from the app.

---

## Scripts

| Command                | Purpose                                                  |
| ---------------------- | -------------------------------------------------------- |
| `npm run dev`          | Development server with hot reload.                      |
| `npm start`            | Production server.                                       |
| `npm run seed`         | Create Admin role + first admin (idempotent).            |
| `npm run seed:destroy` | Wipe users/roles/businesses (blocked in production).     |
| `npm test`             | `node:test` suite against a throwaway Mongo (see below). |
| `npm run lint`         | oxlint.                                                  |
| `npm run format`       | Prettier write. `format:check` verifies without writing. |
| `npm run check`        | lint + format check + tests — **run before pushing**.    |

---

## Testing

Tests run on the real driver against a **throwaway database** — no mocks of
Mongo. Point them at any MongoDB you don't mind being wiped:

```bash
# defaults to mongodb://127.0.0.1:27017/b_ledger_test
MONGO_TEST_URI="mongodb://127.0.0.1:27017/b_ledger_test" npm test
```

They cover the accounting invariants (balanced double-entry, order/walk-in/
courier posting, partner distribution, year-end close), the permission
resolver, and the request-validation middleware. CI spins up a Mongo service
and runs `npm run check` on every push.

---

## Logging

Structured logging via **pino** + **pino-http** (`utils/logger.js`):

- **Development** — one concise, colourised line per request
  (`GET /api/v1/orders 200 (12ms)`).
- **Production** — newline-delimited **JSON** with full `req`/`res` for log
  aggregators.
- **Test** — `silent`, so `npm test` output stays clean.
- Every request carries a **correlation id**; the `authorization` / `cookie`
  headers and any `password` field are **redacted**.

Control verbosity with `LOG_LEVEL` (`trace` `debug` `info` `warn` `error`
`fatal` `silent`). The `/api/v1/health` probe is never logged.

---

## The API

- **Base path:** `/api/v1`
- **Interactive docs (Swagger):** `/api-docs`
- **Health check:** `/api/v1/health`
- **Auth:** `Authorization: Bearer <token>` from `POST /api/v1/auth/login`.

Resources: `auth`, `users`, `roles`, `categories`, `products`, `orders`,
`customers`, `businesses`, `parties`, `finance`, `production`, `consignments`,
`partners`, `notifications`, `push`.

**Response envelope** — always `success` first, never a bare array:

```jsonc
{ "success": true, "data": { } }                                  // single
{ "success": true, "count": 10, "total": 42, "pagination": {}, "data": [] } // list
{ "success": false, "error": "…" }                                // error (string or array)
```

**Authorization in a paragraph:** each user has one **role** carrying a grid of
`resource → actions` (`read` `create` `update` `delete`) with a read **scope**
(`all` = every row, `own` = rows in the user's `assignedBusinesses`). Per-user
**overrides** grant or deny on top — **deny always wins**. The **Admin** role
has `fullAccess`, bypassing the grid; it can't be edited or deleted.
`GET /api/v1/roles/registry` lists every permissionable resource.

---

## Deploying to production

1. **Host:** deploy to a platform that runs a **persistent Node process** —
   Render, Railway, Fly, a VPS, a container. ⚠️ **Vercel/Lambda serverless
   functions cannot hold the Socket.io WebSocket**, so real-time notifications
   won't work there. If you don't need real-time, serverless is possible, but
   file writes to `public/` won't persist — use object storage.
2. **Env:** set every required variable (above) in the host's dashboard, with
   `NODE_ENV=production`. Use a **strong, unique** `JWT_SECRET` and a **fresh**
   VAPID pair (never the committed one).
3. **Database:** a managed MongoDB (Atlas). Whitelist the host's IP.
4. **CORS:** set `ALLOWED_ORIGINS` (or `FRONTEND_URL`) to the **web app's**
   deployed origin, or both its API calls and its WebSocket are rejected.
5. **Start command:** `npm start` (or `node server.js` if the platform injects
   env). Run `npm run seed` **once** to create the first admin.
6. **Verify:** `GET /api/v1/health` returns `{ success: true, status: "ok" }`.

---

## Troubleshooting

| Symptom                                              | Cause & fix                                                                                |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Server exits at boot naming a variable               | A required env var is missing. Fill it in `.env` (see the table above).                    |
| `MongooseServerSelectionError` / can't connect       | MongoDB isn't running or `MONGODB_URI` is wrong. Start Mongo or fix the URI.               |
| `npm run seed` refuses                               | `SEED_ADMIN_PASSWORD` is unset or under 8 chars. Set it in `.env`.                         |
| Login works but WebSocket fails in production        | The web app's origin isn't in `ALLOWED_ORIGINS`/`FRONTEND_URL`, or the host is serverless. |
| Emails don't send in dev                             | Start Mailpit (SMTP `1025`, inbox `http://localhost:8025`), or leave SMTP blank to skip.   |
| `[vite] ws proxy error` in the **frontend** terminal | Dev-proxy noise — usually this API being down/restarting. See the frontend README.         |

> Never commit `.env`. `example.env` holds placeholders only. A leaked secret is
> burned even after you delete the commit — **rotate it**.
