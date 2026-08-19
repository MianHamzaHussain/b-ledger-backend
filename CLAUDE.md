# CLAUDE.md — B Ledger Backend

House standard for this API. **§1–§9 are the rules to follow.** §10 is the
honest list of what is still missing.

Project: digitalizing a multi-business e-commerce operation (Shopify stores,
social pages and WhatsApp) — replacing manual Google Sheets with one system
that tracks orders, payments, expenses and per-business profit/loss.

---

## 1. Stack & Runtime

| Concern   | Choice                                                                       |
| --------- | ---------------------------------------------------------------------------- |
| Runtime   | Node 24 LTS, ESM (`"type": "module"` — `.js` extensions required in imports) |
| Framework | Express 5                                                                    |
| Database  | MongoDB / Mongoose 9                                                         |
| Auth      | JWT, `Authorization: Bearer <token>`                                         |
| Authz     | Role permission grid + per-user overrides (§6)                               |
| Realtime  | Socket.io, JWT handshake, room per business                                  |
| Push      | `web-push` (VAPID) for PWA background notifications                          |
| Docs      | `swagger-jsdoc` + `swagger-ui-express` at `/api-docs`                        |
| Mail      | Nodemailer (SMTP)                                                            |
| Logging   | `pino` + `pino-http` — JSON in prod, pretty in dev, request ids, redaction   |
| Hardening | `helmet`, `hpp`, `express-rate-limit`, `express-xss-sanitizer`, `cors`       |

Env is loaded by Node itself (`node --env-file=.env`) — **no `dotenv`**.

```bash
npm run dev           # nodemon
npm start             # production
npm run seed          # create Admin role + first admin (reads SEED_ADMIN_*)
npm run seed:destroy  # wipe users/roles/businesses (refuses in production)
```

---

## 2. Folder Structure

```
backend/
├── server.js              # Composition root: middleware order, mount, listen
├── seeder.js              # CLI: -i import / -d destroy
├── config/
│   ├── db.js
│   ├── env.js             # fail-fast env validation, imported first in server.js
│   └── swagger.js         # OpenAPI definition + shared component schemas
├── models/                # PascalCase, singular
├── controllers/           # <resource>Controller.js — request handling only
├── routes/                # filename = mount path; Swagger JSDoc lives here
├── middlewares/           # auth, permissions, advancedResults, validate, errors
├── schemas/               # Zod request-body schemas (paired with validate)
├── utils/                 # permissions registry, helpers, singletons
├── templates/emails/      # HTML email builders
├── test/                  # node:test suites (+ test/helpers/db.js)
└── public/                # static assets
```

**Layering:** `routes → middlewares → controllers → (models | utils)`.
Controllers never import controllers. Models never import controllers.

A `services/` folder returns when there is real third-party I/O (Shopify sync,
WhatsApp API). Anything that talks to an external system goes there, never in a
controller.

---

## 3. Naming

### 3.1 Files

**camelCase throughout, no dot-suffixes.** The parent directory already states
the role, so `user.controller.js` inside `controllers/` is redundant.

| Layer       | Convention                 | Example                                                |
| ----------- | -------------------------- | ------------------------------------------------------ |
| Models      | `PascalCase`, singular     | `User.js`, `Business.js`, `Role.js`                    |
| Controllers | `camelCase` + `Controller` | `userController.js`, `businessController.js`           |
| Routes      | **filename = mount path**  | `/users` → `users.js`, `/businesses` → `businesses.js` |
| Middlewares | `camelCase`                | `permissions.js`, `advancedResults.js`                 |
| Utils       | `camelCase`                | `permissions.js`, `errorResponse.js`, `cors.js`        |
| Services    | `camelCase` + `Service`    | `shopifyService.js`                                    |

The route rule is mechanical: whatever string appears in `router.use(...)` in
`routes/index.js` is the filename. No singular-vs-plural debate.

### 3.2 Code

- Variables, functions, schema fields: `camelCase`.
- Schema consts: `PascalCase` + `Schema` (`BusinessSchema`).
- Shared enums: `SCREAMING_SNAKE_CASE` in `utils/constants.js`, referenced from
  schema `enum:` arrays. **Never inline a magic string in a schema.**

### 3.3 Handler names

```
getBusinesses    GET    /businesses        (list)
getBusiness      GET    /businesses/:id    (single)
createBusiness   POST   /businesses
updateBusiness   PUT    /businesses/:id
deleteBusiness   DELETE /businesses/:id
```

### 3.4 URLs

Base `/api/v1`. Resources plural and kebab-case. Non-CRUD actions are
sub-paths (`/roles/registry`).

---

## 4. Mongoose Conventions

```js
const ThingSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Please add a name'], // message = user-facing sentence
      trim: true,
      maxlength: [100, 'Name can not be more than 100 characters']
    },
    business: {
      // ref fields named for the model
      type: mongoose.Schema.ObjectId,
      ref: 'Business',
      required: [true, 'Please select a business']
    },
    createdBy: { type: mongoose.Schema.ObjectId, ref: 'User', required: true },
    updatedBy: { type: mongoose.Schema.ObjectId, ref: 'User' }
  },
  { timestamps: true }
);
```

1. **Every validation message is a user-facing sentence** — `errorHandler`
   surfaces them verbatim.
2. **`{ timestamps: true }`** — never hand-roll `createdAt`.
3. **`createdBy` / `updatedBy` on every owned resource.** Stamped automatically
   by `protect` (§5.1) — controllers never set them.
4. **`business` ref on every transactional model.** This is what makes
   `scope: 'own'` work (§6.3). Orders, payments and expenses all carry it.
5. Secrets use `select: false` and must be re-requested: `.select('+password')`.
6. Indexes declared next to the schema, before `mongoose.model()`.

### Current models

| Model             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`            | Account, one `role` ref, optional `permissionOverrides`, `assignedBusinesses`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Role`            | Named permission grid; `fullAccess` + `isSystem` on Admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Category`        | Product category (Clothing, Cosmetics…). Referenced by Business + Subcategory; deletion blocked while either references it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Subcategory`     | Second taxonomy level (Stitched/Unstitched) under a Category. Carries **embedded** `attributes` (Size → SM–XXL) — Shopify's "options." Unique name per category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `Business`        | One brand/storefront and its channels, plus the per-business FBR `codTax` profile. **The scoping anchor for all authorization.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Partner`         | An owner/partner — an **equity** stake (NOT a trade party), with a profit-share `%`. Owns a dedicated equity account (`capitalAccount`) so their capital sits in the balance sheet's Equity section on its own. Investments credit it, drawings debit it, and profit is allocated to it by share at distribution. Balance derived from that account, never stored                                                                                                                                                                                                                                                                                                                        |
| `Party`           | A contact with a running account, scoped to a `business` — `supplier`, `reseller`, `employee`, **`courier`**, **`customer`**, or **`lender`** (Loan Payable is sub-ledgered to a lender for a per-loan statement). Balance is derived from the journal lines tagged to it, never stored. A courier party carries an `accountId`; orders reference it and COD is sub-ledgered to it. A `customer` party is a walk-in buyer we've extended credit to: an unpaid counter sale's balance is sub-ledgered to it, so its outstanding amount shows on one statement                                                                                                                             |
| `Product`         | Stock, scoped to a `business`. **`category` is derived from the business** — a business has one category, and the controller strips any client-sent category so the two can't diverge. **Every price/stock/barcode lives on an embedded `variant`** — a simple product is one variant with no options; a variant product has one per size. Auto `articleNumber` (4-char) + per-SKU `barcode` (12-digit). Variants validated against the subcategory's attributes in a pre-validate hook                                                                                                                                                                                                  |
| `Order`           | Scoped to a `business`. Sequential `orderNumber` (via `Counter`). Line items snapshot `productName`/`variantLabel`/`unitCost` at order time. **Two independent status axes**: `status` (fulfillment) and `paymentStatus` (unpaid→paid). Money derived: `total` = Σ items, `codAmount` = total − `advanceAmount`. Stock reserved on create, restored on cancel/return. A delivery order picks its `courier` (a courier party) **at dispatch**, where the COD net is sub-ledgered to it. A **walk-in** (`source: 'walk-in'`) is a counter sale: born `delivered`, no courier, no COD taxes — `advanceAmount` is cash taken now and any balance is credit sub-ledgered to a `customerParty` |
| `Customer`        | Per-business, unique by `phone`. **Upserted from every order**, never created via a form — dedupes repeat buyers into a contact list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Expense`         | Per-business spend. Auto-created on a return (the courier's return charge), or added manually. The expense side of P&L                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Counter`         | Atomic named sequences (`getNextSequence`). Powers the order number — never "count + 1" (races)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `ProductionBatch` | A multi-variant production run that builds an article's cost from **itemized cost lines** (cloth/tailor/packing), each funded from cash/bank or **on credit to a supplier**. Per-variant independent stock/cost with a moving-average cost; closing posts Inventory + payables, itemized under the article                                                                                                                                                                                                                                                                                                                                                                               |
| `Consignment`     | Sale-or-return goods out with a **reseller** — a header with many lines, each tracking issued/returned/kept. Goods stay yours (Goods-on-Approval at cost) until kept (then a sale) or returned. A second money axis (`billedPaisa`/`paidPaisa`) tracks what the reseller owes vs has paid                                                                                                                                                                                                                                                                                                                                                                                                |
| `Account`         | One line of the per-business **chart of accounts** (`code`, `name`, `type`, derived `normalBalance`). Seeded from a standard chart on first use (`chartOfAccounts.js`); per-partner capital accounts are added dynamically                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `JournalEntry`    | A balanced **double-entry** posting — both sides in `lines[]` (`account`, optional `party`/`product`/`batch`/`label`, `debitPaisa`/`creditPaisa`). The pre-validate hook **rejects unbalanced entries**. `source.kind` traces what posted it (order, consignment, capital, loan, asset…)                                                                                                                                                                                                                                                                                                                                                                                                 |
| `PeriodLock`      | Freezes entries dated on/before a cutoff so reported history can't change after the fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `Notification`    | In-app notification (new order, order paid, low stock) — drives the header bell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

---

## 5. Middleware

`server.js` order — **this order is load-bearing**:

```
helmet → cors → swagger → json/urlencoded → xss → hpp
→ pino-http → rateLimit → static → /api/v1/health
→ /api/v1 routes → 404 → errorHandler
```

Helmet is first so everything below is covered. Swagger sits before the
sanitizers, which rewrite the request in ways its UI does not expect.

`server.js` also sets `query parser: extended` — Express 5's default parser is
"simple" (flat `qty[gte]` keys), so this pins Express 4's qs behaviour that
`advancedResults` (§5.3) and the `$`-operator stripping rely on.

### 5.1 `auth.js` — `protect`

Verifies the Bearer token, loads the user **with `role` populated** (`can()`
needs the grid on every request), rejects inactive accounts, and stamps audit
fields:

```js
if (req.method === 'POST') req.body.createdBy = req.user.id;
else if (['PUT', 'PATCH'].includes(req.method)) req.body.updatedBy = req.user.id;
```

Stamping _after_ auth means a client cannot forge these via the body.

### 5.2 `permissions.js` — `can()` and `loadScoped()`

The authorization layer. See §6.

### 5.3 `advancedResults(model, populate, searchFields)`

Standard list endpoint; sets `res.advancedResults`.

| Query param          | Behaviour                                           |
| -------------------- | --------------------------------------------------- |
| `?search=ali`        | escaped, case-insensitive `$or` over `searchFields` |
| `?select=name,email` | projection                                          |
| `?sort=-createdAt`   | sort (default `-createdAt`)                         |
| `?page=2&limit=25`   | pagination (default 25)                             |
| `?qty[gte]=20`       | operator mapping → `$gte` (`gt gte lt lte in` only) |

It **fails closed**: if `req.accessFilter` is undefined — meaning the route
never called `can()` — it throws instead of listing every row. This is the net
for the classic "someone forgot the guard" bug.

Client-supplied `$` operators are stripped, and the scope filter is merged with
`$and` (not spread, which would let a client `_id` overwrite the scope).

### 5.3.1 Do not hand-write CRUD controllers

`utils/crudController.js` builds the five standard handlers. Extracted once
roles, businesses and categories all needed the same ones — the "second real
duplication" threshold in §5.3.

```js
const handlers = createCrudHandlers({
  model: Business,
  populate: { path: 'category', select: 'name status' },
  protectedFields: ['fullAccess'], // stripped from body
  beforeDelete: blockIfReferencedBy(Business, 'category', 'business')
});

export const { getAll: getBusinesses, create: createBusiness /* … */ } = handlers;
```

It assumes the route chain already ran `can()` → `advancedResults` /
`loadScoped`, so the handlers never re-fetch or re-authorize.

**`blockIfReferencedBy` is not optional for reference data.** Deleting a
category out from under the businesses using it leaves documents whose ref will
not populate and reports that quietly undercount. Blocking is louder and far
cheaper than cascading.

When a doc is referenced from **more than one** model (a Category is now used by
both Business and Subcategory), compose the guards — the first block hit wins:

```js
beforeDelete: blockIfAnyReference([
  blockIfReferencedBy(Business, 'category', 'business'),
  blockIfReferencedBy(Subcategory, 'category', 'subcategory'),
]),
```

**Embed value-objects that have no life of their own.** A Subcategory's
`attributes` (Size → SM–XXL) are edited only through their subcategory and never
queried alone, so they are an embedded sub-schema, not a collection — no CRUD,
no cascade. Reserve a ref + its own model for things that are queried or owned
independently.

Anything genuinely unusual should be a hand-written controller rather than
another option on the factory. The order flow (stock reservation, customer
upsert, sequential number) is the example — see `orderController.js`.

### 5.3.2 Concurrency: mutate contended state atomically

Never read-check-then-write a value two requests can race on (stock is the
case that matters). Use a **conditional update** so the database enforces the
invariant in one operation — see `utils/stock.js`:

```js
Product.updateOne(
  { _id, variants: { $elemMatch: { _id: variantId, stock: { $gte: qty } } } },
  { $inc: { 'variants.$.stock': -qty } }
); // modifiedCount 0 ⇒ not enough stock, reject
```

Two subtleties, both learned the hard way:

- **`$elemMatch` is mandatory** when matching two conditions on the same array
  element. Written as separate `variants._id` / `variants.stock` clauses, Mongo
  may satisfy them with _different_ elements and the positional `$` decrements
  the wrong one — silent overselling.
- The dev database is **standalone (no transactions)**, so a multi-step
  mutation that fails partway is unwound by hand (reserve each line; on any
  failure, release the ones already taken). Never leave a partial deduction.

### 5.4 `asyncHandler`

Every async controller is wrapped. `try/catch` in a controller only for
genuinely optional side effects (notifications).

### 5.5 `errorHandler`

Terminal. Maps `CastError` → 404, `11000` → 400 (naming the field),
`ValidationError` → 400, JWT errors → 401. Logs stack traces for 5xx only.
Always emits `{ success: false, error }`.

---

## 6. Authorization Model

**The most important section. Read before touching any route.**

### 6.1 Shape

A permission is `resource:action`, plus a `scope` for reads.

- **Resources** are declared in `utils/permissions.js` — the server-side
  registry. The admin UI renders its checkbox grid from
  `GET /roles/registry`. The frontend never invents resource names; an unknown
  one fails schema validation rather than silently matching nothing.
- **Actions**: `read`, `create`, `update`, `delete`. Four, not "read/write" —
  "can add but cannot delete" is the single most common real requirement and
  a two-state flag cannot express it.
- **Scopes**: `all` (every row) or `own` (rows belonging to the user's
  `assignedBusinesses`). Forced to `all` for non-scopable resources.

### 6.2 Resolution order

```
Admin (role.fullAccess) ──────────────► allow everything, stop
                │ no
                ▼
role.permissions  →  apply grant overrides  →  apply deny overrides
                                                   (deny always wins)
```

`fullAccess` is checked **before** any grid lookup, so an admin can never be
locked out by a mis-ticked checkbox. It is not settable through the API — only
the seeder creates it, and `isSystem` blocks editing or deleting that role.

Per-user `permissionOverrides` are the escape hatch for "Ali is a Dispatcher
but should also see reports" without cloning a whole role.

### 6.3 Enforcement

Every protected route declares what it needs. This is the only place
authorization is decided:

```js
router
  .route('/')
  .get(can('businesses', 'read'), advancedResults(Business, null, ['name']), getBusinesses)
  .post(can('businesses', 'create'), createBusiness);

router
  .route('/:id')
  .get(can('businesses', 'read'), loadScoped(Business), getBusiness)
  .put(can('businesses', 'update'), loadScoped(Business), updateBusiness);
```

`can()` sets `req.permissionScope` and `req.accessFilter` (`{}` for scope
`all`). `advancedResults` merges the filter into list queries; `loadScoped`
applies the same filter to a single document and caches it on `req.resource`,
so controllers never re-query.

`loadScoped` returns **404, not 403**, for out-of-scope records — a 403 would
confirm that another business's record exists.

### 6.4 Rules

1. Every protected route calls `can()`. No exceptions.
2. Never check `user.role.name === 'X'` in a controller. Roles are data.
3. New resource ⇒ add it to the registry in the **same commit** as its model
   and routes. Never register something with no endpoints.
4. `fullAccess` and `isSystem` are stripped from request bodies in the role
   controller. Keep it that way.

---

## 7. Controllers

Doc block, envelope, guard clauses:

```js
/**
 * @desc      Get single business
 * @route     GET /api/v1/businesses/:id
 * @access    Private (businesses:read — scoped)
 */
export const getBusiness = asyncHandler(async (req, res, next) => {
  res.status(200).json({ success: true, data: req.resource });
});
```

Response envelope — `success` always first, never a bare array:

```js
{ success: true, count, total, pagination: { next, prev }, data: [...] }  // list
{ success: true, data: {...} }                                            // single
{ success: true, data: {} }                                               // delete
{ success: false, error: 'Message' }                                      // error
```

Status codes: `200` read/update, `201` create, `400` validation, `401` unauth,
`403` no permission, `404` missing or out of scope, `429` rate limited.

Errors: `return next(new ErrorResponse(msg, code))` inside a request;
`throw new ErrorResponse(...)` inside a helper. **Never `res.status(500)` by
hand.**

---

## 8. Route Files

```js
// 1. imports: express → middlewares → model → controller
const router = express.Router();

// 2. public routes FIRST (before protect, and before /:id)
router.get('/public', getPublicThings);

// 3. auth gate
router.use(protect);

// 4. literal paths before parameterised ones
router.get('/registry', can('roles', 'read'), getRegistry);

// 5. Swagger JSDoc immediately above the route it documents
router.route('/').get(can('things', 'read'), advancedResults(Thing), getThings);
router.route('/:id').get(can('things', 'read'), loadScoped(Thing), getThing);
```

Chain order is always `can() → loadScoped()/advancedResults() → controller`.

---

## 9. Adding a Resource — Checklist

1. `models/Thing.js` — `timestamps`, `business` ref, `createdBy`/`updatedBy`.
2. **`utils/permissions.js`** — register `things` with its `ownFilter`.
   _Do this first; the middleware 500s on an unregistered resource._
3. `controllers/thingController.js` — five handlers, `asyncHandler`-wrapped.
4. `routes/things.js` — `protect`, then `can()` on every route.
5. `routes/index.js` — `router.use('/things', thingRoutes)`.
6. `config/swagger.js` — add `components.schemas.Thing`.
7. Swagger JSDoc above each route.

---

## 10. Known Gaps

Honest list. Nothing here is a blocker for building features, but each will
cost more the longer it waits.

### Should do next

| Gap                          | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request validation (Zod)** | Done (core routes): `middlewares/validate.js` + `schemas/` runs Zod after `protect`/`can`, before the controller — it 400s with the field-error array (§4.1), strips unknown keys, and preserves the JWT-stamped `createdBy`/`updatedBy`. Wired on the **money routes** (`finance/*`, `partners/*`) and the **order and consignment** routes. **Still to do:** extend the same `validate(schema)` to the remaining CRUD routes. |
| **Tests**                    | Done (initial, risk-based): `node:test` accounting + permission suite in `test/` (ledger invariants, order/walk-in/courier posting, partner distribution, resolver matrix), run against a throwaway Mongo (`MONGO_TEST_URI`). Run via `npm test`, enforced in CI. Expand to more controllers over time.                                                                                                                         |
| **ESLint + Prettier**        | Done: oxlint + Prettier configured (`.oxlintrc.json`, `.prettierrc.json`), a composite `npm run check`, a CI workflow, and a husky/lint-staged pre-commit that blocks unformatted / lint-broken commits.                                                                                                                                                                                                                        |
| **Structured logging**       | Done: `pino` + `pino-http` route every runtime log through one logger (`utils/logger.js`) — JSON in prod, pretty in dev, `silent` under test; per-request correlation ids; redacts the `authorization`/`cookie` headers and any `password`. Mounted where morgan was (§5). The seeder (a CLI) and `config/env.js` (runs before the logger exists) intentionally stay on `console`.                                              |
| **Env validation at boot**   | Done: `config/env.js` (imported first in `server.js`) fails fast on a missing `MONGODB_URI`/`JWT_SECRET` instead of surfacing it at first login.                                                                                                                                                                                                                                                                                |

### Deferred deliberately

- **TypeScript.** Do Zod first — `z.infer` writes most of the types for you.
- **Refresh tokens / token revocation.** `logout` cannot invalidate a JWT
  today; the client discards it and the token stays valid until expiry.
- **File uploads.** Removed. If added back, note that writing to `public/` does
  **not** work on Vercel serverless — use S3, Cloudinary or Vercel Blob.

### Operational

- **Rotate the VAPID keypair per environment.** A fresh pair is in the local
  envs; the one committed to the old repository is public — never reuse it.
  `npx web-push generate-vapid-keys`.
