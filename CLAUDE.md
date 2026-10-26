# CLAUDE.md — B Ledger Backend

House standard for this API. **§1–§10 are the rules to follow** (§10 is how
money moves through the books). §11 is the honest list of what is still missing.

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
npm run dev           # node --watch (restarts on change)
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
├── utils/                 # permissions registry, helpers, singletons, and the
│                          #   money rules: ledger, orderPosting, partyPosting,
│                          #   courierInvoice, cashbook (see §10)
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

| Model             | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `User`            | Account, one `role` ref, optional `permissionOverrides`, `assignedBusinesses`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Role`            | Named permission grid; `fullAccess` + `isSystem` on Admin                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Category`        | Product category (Clothing, Cosmetics…). Referenced by Business + Subcategory; deletion blocked while either references it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Subcategory`     | Second taxonomy level (Stitched/Unstitched) under a Category. Carries **embedded** `attributes` (Size → SM–XXL) — Shopify's "options." Unique name per category                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `Business`        | One brand/storefront and its channels, plus the per-business FBR `codTax` profile. **The scoping anchor for all authorization.**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Partner`         | An owner/partner — an **equity** stake (NOT a trade party), with a profit-share `%`. Owns a dedicated equity account (`capitalAccount`) so their capital sits in the balance sheet's Equity section on its own. Investments credit it, drawings debit it, and profit is allocated to it by share at distribution. Balance derived from that account, never stored                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `Party`           | A contact with a running account, scoped to a `business` — `supplier`, `reseller`, `employee`, **`courier`**, **`customer`**, or **`lender`** (Loan Payable is sub-ledgered to a lender for a per-loan statement). Balance is derived from the journal lines tagged to it, never stored. A courier party carries an `accountId`; orders reference it and COD is sub-ledgered to it. A `customer` party is a walk-in buyer we've extended credit to: an unpaid counter sale's balance is sub-ledgered to it, so its outstanding amount shows on one statement. An `employee`'s salary owed **and** any advance they hold share one account (Salaries Payable) — negative = we owe them, positive = they hold an advance                                                                                                                                                                                                                                      |
| `Product`         | Stock, scoped to a `business`. **`category` is derived from the business** — a business has one category, and the controller strips any client-sent category so the two can't diverge. **Every price/stock/barcode lives on an embedded `variant`** — a simple product is one variant with no options; a variant product has one per size. Auto `articleNumber` (4-char) + per-SKU `barcode` (12-digit). Variants validated against the subcategory's attributes in a pre-validate hook                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Order`           | Scoped to a `business`. Sequential `orderNumber` (via `Counter`). Line items snapshot `productName`/`variantLabel`/`unitCost` at order time. **Two independent status axes**: `status` (fulfillment) and `paymentStatus` (unpaid→paid). Money derived: `total` = Σ items, `codAmount` = total − `advanceAmount`. Stock reserved on create, restored on cancel/return. A delivery order picks its `courier` (a courier party) and `trackingId` **at dispatch**; the courier's charge is taken **at the outcome** — `deliveryChargePaisa` on delivery, `returnChargePaisa` on a return or exchange pickup (§10.1). `paidPaisa` records part-payments of a credit counter sale; `courierSettlement` links an order whose COD a courier invoice paid (§10.2). A **walk-in** (`source: 'walk-in'`) is a counter sale: born `delivered`, no courier, no COD taxes — `advanceAmount` is cash taken now and any balance is credit sub-ledgered to a `customerParty` |
| `Customer`        | Per-business, unique by `phone`. **Upserted from every order**, never created via a form — dedupes repeat buyers into a contact list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Expense`         | Per-business spend. Auto-created on a return (the courier's return charge), or added manually. The expense side of P&L                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Counter`         | Atomic named sequences (`getNextSequence`). Powers the order number — never "count + 1" (races)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `ProductionBatch` | A multi-variant production run that builds an article's cost from **itemized cost lines** (cloth/tailor/packing), each funded from cash/bank or **on credit to a supplier**. Per-variant independent stock/cost with a moving-average cost; closing posts Inventory + payables, itemized under the article                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Consignment`     | Sale-or-return goods out with a **reseller** — a header with many lines, each tracking issued/returned/kept. Goods stay yours (Goods-on-Approval at cost) until kept (then a sale) or returned. A second money axis (`billedPaisa`/`paidPaisa`) tracks what the reseller owes vs has paid                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Account`         | One line of the per-business **chart of accounts** (`code`, `name`, `type`, derived `normalBalance`). Seeded from a standard chart on first use (`chartOfAccounts.js`); per-partner capital accounts are added dynamically                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `JournalEntry`    | A balanced **double-entry** posting — both sides in `lines[]` (`account`, optional `party`/`product`/`batch`/`label`, `debitPaisa`/`creditPaisa`). The pre-validate hook **rejects unbalanced entries**. `source.kind` traces what posted it (order, consignment, capital, loan, asset, `courier-settlement`…)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `PeriodLock`      | Freezes entries dated on/before a cutoff so reported history can't change after the fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `Notification`    | In-app notification (new order, order paid, low stock) — drives the header bell                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

### 6.4 Accountant tools are their own resource

Everyday users are not accountants (see §10). The raw tools — `POST
/finance/manual` (a debit/credit General entry), `/finance/depreciation` and
`/finance/close` — are gated by the **`accounting`** resource, not `journal`.
Admins have it through `fullAccess`; nobody else does unless a role is given
"Accountant tools". Everyday money goes through the named endpoints (expense,
salary, party transactions…) whose double entry is fixed in code.

### 6.4b Picking is not seeing — lookups

A task often needs to _choose_ something that lives in a resource the person must not _browse_. A
dispatcher picks a courier; an order taker picks the account an advance went into. If the only
way to fill that box is the resource's own list, the role must be given the whole resource — and
`GET /parties` carries every party's balance, `GET /finance/money-accounts` every bank balance.
(Found 2026-10-25: a dispatcher given Khata access to find a courier could read the whole Khata.)

So a picker gets its own narrow endpoint that returns only what choosing needs — never a balance,
note or statement — and is allowed by the permission for the **task**, not the resource:

| Endpoint                             | Returns                                     | Allowed with                                                               |
| ------------------------------------ | ------------------------------------------- | -------------------------------------------------------------------------- |
| `GET /parties/lookup?type=`          | name, phone, account id, `booksWithService` | `parties:read`, or the task's permission per type (`utils/partyLookup.js`) |
| `GET /finance/money-accounts/lookup` | account/partner names, no balances          | `journal:read`, `orders:create`, `orders:update`                           |

Rules for a new picker: add the lookup beside the resource, put the permission table in code, keep
the scope check (own business only, 404 outside it), return no money, test that a role with only the
task permission can pick and can **not** browse. Never widen a list endpoint to serve a picker.

### 6.5 Rules

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
2. **`utils/permissions.js`** — register `things` with its `ownFilter`, a plain
   `description`, and a `can` phrase for **every action a route will require**
   (the Roles screen shows these to non-technical admins).
   _Do this first; the middleware 500s on an unregistered resource, and
   `test/permissionDescriptions.test.js` fails if a route needs an action with no
   phrase._
3. `controllers/thingController.js` — five handlers, `asyncHandler`-wrapped.
4. `routes/things.js` — `protect`, then `can()` on every route.
5. `routes/index.js` — `router.use('/things', thingRoutes)`.
6. `config/swagger.js` — add `components.schemas.Thing`.
7. Swagger JSDoc above each route.

---

## 10. Money Flows

The people using this system think like **DigiKhata users** — "who owes whom,
how much cash do I have" — not like accountants. So the rule is: **the books are
full double-entry, but no request ever asks the user for a debit, a credit or an
account.** Each flow below is a named action whose posting is fixed in code, and
each lives in one util so the accounting is auditable in one place.

### 10.1 Order outcomes — charges usually come later, on the invoice

The courier bills by weight, city and what happened, and only tells you on its
weekly invoice. So the outcome takes the charge **only if it is already known**;
left out, it stays **open** (`deliveryChargePaisa` / `returnChargePaisa` unset)
until an invoice bills it (§10.2). `utils/orderPosting.js`:

| Step       | Takes                                     | Books                                                                                                                                                                                |
| ---------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| dispatched | courier + **tracking id** (both required) | nothing                                                                                                                                                                              |
| delivered  | delivery charge (optional, may be 0)      | sale + COGS; COD net of fee + FBR taxes to COD-receivable [courier]. A fee larger than the COD (a **prepaid** order) leaves a _credit_ there — the courier keeps it out of other COD |
| returned   | return charge (optional, may be 0)        | sale reversed; Dr Return charges / **Cr COD-receivable [courier]** — couriers deduct charges from COD, so cash never moves                                                           |
| exchanged  | pickup charge (optional, may be 0)        | the sale becomes customer **credit** for the replacement; COD, delivery fee and taxes stand (§10.2b)                                                                                 |

### 10.2 Courier invoice

A courier pays weekly against an invoice listing parcels by tracking id. Each
parcel has **two things settled independently** — its COD and its charge(s) —
because TCS bills a parcel's charge one week and pays its COD the next.
`utils/courierInvoice.js` (`POST /parties/:id/courier-invoices`):

- **Open items** (`GET /parties/:id/courier-items`): a delivered unpaid COD; a
  delivery charge unset on a delivered/exchanged order; a return charge unset on
  a returned/exchanged order.
- **One entry**: Dr the money account (what arrived, if anything) + Dr Delivery /
  Return charges per parcel, Cr COD-receivable [courier] (received + charges).
  Ticked CODs become paid (`courierSettlement` = the entry); charges are stored
  on the orders with their entry. A shortfall simply stays on the courier's
  balance. The courier's `defaultMoneyAccount` remembers where money landed.
- **Invoice number is optional** (a TCS week can have none). When one is typed it is unique per courier (partial index); the per-parcel checks stop double settling either way.
- **Reversing** the entry reopens its CODs and charges and frees the number
  (`undoCourierInvoice`). An order paid this way can't be marked unpaid, and a
  courier order is never marked paid by hand.
- The P&L returns `unbilledCharges`: parcels in the period whose charge is
  still open — profit is provisional until they're billed.

### 10.2a Customer advances and refunds

The payment screenshot is money in the books **the day it arrives**, not at
delivery. `utils/customerMoney.js` (`POST /orders/:id/advances`, `/refunds`,
`DELETE /orders/:id/customer-money/:rowId`):

- **Advance**: Dr the money account (or a partner) / Cr **Advances from
  customers** (2300, liability). Each is a row in `order.customerMoney`;
  `advanceAmount` is their net (advances − refunds).
- **COD rule**: `codAmount` = total − advance **until dispatch, then frozen** —
  the courier collects what it printed. An advance after dispatch doesn't touch
  the COD; it becomes `refundDuePaisa`.
- **Delivery** uses (total − COD) from the liability instead of cash. Anything
  held beyond that is refund due; a cancelled / returned / exchanged order owes
  back everything held.
- **Refund**: Dr Advances from customers / Cr money, at most the refund due.
- **Keep as credit** (`POST /orders/:id/credit`, cancelled / returned only):
  Dr Advances from customers / Cr Accounts Receivable [customer party, upserted
  by phone] — the customer's khata shows what we owe them.
- **Reopen**: cancelled → pending re-reserves the stock; any money still held
  comes off the COD again.
- **Remove** (a mistake) reverses the row's entry — refused if the order would
  then hold less than the COD was reduced by. Such entries can't be reversed
  from the journal; they're undone on the order.
- A **counter sale** is different: its "paid now" goes into the sale itself,
  into `counterAccount`, with no liability.

### 10.2b Exchanges — the customer's payment becomes credit

An exchange never refunds and re-charges. `utils/exchange.js`:

- **Sale → credit**: Dr Sales / Cr Advances from customers (total). The order
  gets a `transfer-in` row for the COD part, since its advances were already
  held. The courier's COD receivable, delivery charge and FBR taxes are
  **untouched** — the courier did deliver and collect.
- **Goods back**: `releaseStock` + Dr Inventory / Cr COGS.
- **The replacement is a new order**, made on the order form:
  - it holds stock items and/or custom work (including made from scratch), the
    courier chosen for it, and the customer's details (which may be new);
  - it carries the credit: a `transfer-in` row on it and a `transfer-out` on
    the original — rows only, no entry;
  - its COD is the difference; if it costs less, the excess is a refund due.
- **Return first** (`/exchange-return`, then `/exchange-replacement`) does
  sale → credit and goods back together.
  - The customer sends it on a courier of their choice, at their cost. Its name
    and tracking number are kept for reference (`returnShipping.courierName`,
    `reversalTrackingId`).
  - `returnChargePaisa = 0`: it is never on our invoice.
- **Swap at the door** (`/swap`, then `/receive-return`): sale → credit and the
  replacement at once. Stock is reserved first, and the credit entry is undone
  if creating fails.
  - The replacement keeps the original's courier (`isSwap`), because it swaps
    both parcels in one visit. The schema takes no courier, and dispatching it
    with another courier is refused.
  - It carries no COD: a difference the customer owes is paid to us directly
    (`differenceAccount`) and booked as an advance on the replacement. The swap
    is refused until that account is given.
  - Our courier handles the reversal on its own tracking number
    (`reversalTrackingId`, searchable).
  - Its charge is billed on the invoice, or closed at 0 with "No charge" when
    the old item is received.
  - `awaitingReturn` stays set until the old item is received.
- **Counter sales** aren't exchanged here — only courier parcels.

### 10.2b-2 Refund after delivery (`utils/refundReturn.js`)

A delivered order sent back for the customer's money: status **refunded**.

- It starts like an exchange: the sale becomes credit, and the goods go back to
  stock.
- **Kept back** (normally the delivery charge + FBR tax, from `/refund-quote`):
  Dr Advances / Cr Charges kept from refunds (4100). It shows as a `kept`
  customer-money row.
- **Return shipping — `returnShipping.by`:**
  - `customer` (normal): their own courier, named for reference only. Setting
    `returnChargePaisa = 0` means it never waits on our invoice. Our agreed share
    of their shipping is Dr Return charges / Cr Advances, a `shipping` row that
    adds to the refund.
  - `us`: a pickup on our courier, left open for its invoice. Their agreed share
    is also kept back.
- The rest is the refund due, paid with the order's **Refund paid** (or kept as
  credit).
- `kept` / `shipping` rows can't be removed on their own.
- Exchanged and refunded parcels were still delivered, so their COD and delivery
  charge stay open on the courier invoice until settled (`DELIVERED_ONCE`).

### 10.2c Custom work and its material

- **Custom work lines** (`order.customWork`) add to the total. A negative price is
  a reduction ("no dupatta"), 0 is a free change, and the total can't go below 0.
  Made-from-scratch work needs no stock item.
- **Material bought for it** (`/custom-costs`, needs "See costs & profit";
  pending or confirmed only):
  - when spent: Dr Custom work in progress (1330) / Cr money;
  - or **from the material store** (`material` + `materialQty`): Dr 1330 / Cr Raw
    materials (1340) at the average — no money moves; removing it puts the stock
    back at what it was taken at;
  - at delivery: moves to COGS;
  - on cancel or return of a **made-from-scratch** order: never a loss. Each piece
    goes into stock as its own product (`customized: true`), named and priced
    in the cancel / return / refund dialog (`utils/scratchStock.js`).
    - Accounting: Dr Inventory / Cr Custom WIP, or Cr COGS if the order was
      already delivered.
    - A second piece with the same name joins the first as more stock.
    - Reopening takes it back out, and is refused if the piece has been sold
      since.
  - on cancel or return of other custom work (an alteration on a stock item):
    written off (5130), and reopening reverses the write-off.
- These entries are undone on the order, never from the journal.

### 10.2d Raw materials — bought in bulk, stock until used

Dye, thread cones, lace and ready embroidered pieces are often bought before
any article exists. They are **stock, not an expense**, so they hit profit only
once, when the article made from them sells.

- **Buy** (`POST /materials/:id/purchases`): Dr Raw materials (1340) / Cr money
  or the supplier's payable. No profit effect.
  - **Paid now with a named supplier** books four lines: Dr Raw materials /
    Cr payable (bill) / Dr payable (paid) / Cr money. Their Khata shows both
    rows and the balance is unchanged.
- **A batch uses it** (a cost line with `material` + `materialQty`):
  - while the batch is a draft, the amount is only an estimate at today's average;
  - at close the stock is taken, and the amount is fixed at that moment's
    average;
  - the close entry credits 1340 instead of money.
  - All or nothing: if one material is short, nothing is taken and the batch
    stays open.
- **Waste / shelf count** (`/adjust`): the difference goes to Material wasted or
  lost (5140), in either direction. This is the only way materials reach profit
  directly.
- **Valuation** is moving average. `Material.valuePaisa` stores the total, not a
  unit cost, so the last unit out takes exactly what is left.
- **Invariant:** Σ `valuePaisa` = the 1340 balance. All stock changes go through
  `utils/materials.js` (optimistic writes, so two closes can't both take the last
  cone).
- **Undo:** only a material's latest purchase or adjustment can be undone, on the
  material. Material entries are never reversed from the journal.
- **Correcting a closed batch** keeps its material lines exactly as they were.
- **Permission:** `materials` covers quantities. Prices are cost fields, hidden
  without "See costs & profit".
- **Counted once — enforced.** What goods cost to make has exactly one way into
  profit, through the article. Material is bought into 1340 (Raw materials page,
  or "Material for stock" on a Shop expense or a supplier bill in Khata);
  tailoring goes on the batch. The everyday expense and supplier-bill paths
  refuse Raw Material (5100) and Tailoring (5110) — `PRODUCTION_COST_CODES`.
  Those accounts stay for history and accountant entries only.

### 10.2f Reversing from a person's Khata (`utils/khataReverse.js`)

`POST /parties/:id/entries/:entryId/reverse` (`journal:create`). Only what the
Khata itself creates is reversible here: sources `payment`, `expense`,
`salary`, `loan` and `opening` (`KHATA_REVERSIBLE`).

- Order, courier-invoice, material, batch and consignment entries are refused
  with the place to undo them (`reverseMessage`) — those records must stay in
  step with the books.
- A reversal can't be reversed, and an entry can't be reversed twice. The
  original stays in the history.
- **Credit customer payment:** reversing takes it back off their counter sales,
  newest first (`unallocateCustomerPayment`), marking a sale unpaid again once
  it is no longer covered.
- **Loan taken:** can't be reversed while part of it is repaid — reverse the
  repayments first.
- The statement rows carry `isReversal`, `reversed` and `canReverse`.

### 10.2g Stitching — pieces move between sizes of one product

A batch may name `sourceVariantId` (e.g. Unstitched). Closing it takes every
line's quantity out of that size instead of adding new stock.

- Each line gets a server-written **from-stock** cost line (`fromStock`),
  priced at the source's average cost. It posts **nothing** — stock moved from
  one size to another, so nothing was spent. A client-sent `fromStock` line is
  ignored.
- Only the other costs (tailor, lace from materials) post. A stitch with none
  posts no entry at all.
- The target size's cost = moved cost + stitching cost, per piece, averaged into
  its stock. The source size's cost doesn't change.
- **Close order matters:** the source is reduced (a conditional, atomic update)
  _before_ the product document is loaded, because that document is saved at the
  end and an earlier copy would write the source's old stock back. Any later
  failure puts the pieces (and any material) back.
- Correcting a closed stitch keeps its from-stock lines exactly as they closed.

### 10.2h Supplier goods — bought outright, sent back if unsold (`utils/goodsReceipt.js`)

Finished goods delivered by a supplier (`/goods-receipts`, resource
`goodsReceipts`). No purchase-order step: it records what actually arrived.

| Step                         | Posting                                                          |
| ---------------------------- | ---------------------------------------------------------------- |
| Goods arrive                 | Dr Inventory (1300) / Cr Payables (2000) [supplier] — the bill   |
| Paid now (optional, ≤ total) | Dr Payables [supplier] / Cr the chosen money account             |
| Send pieces back             | Dr Payables [supplier] / Cr Inventory, at the **receipt's** cost |

- **The Khata shows both rows** when paid now (Bill and Paid), so the balance is
  what is still owed — the same shape as a paid-now material purchase. A delivery
  is not an expense: it reaches profit only when the article sells (COGS).
- **A line is an existing size** (`product`, `variantId`, `quantity`, `unitCost`)
  or **a new article** (`newProduct` with its sizes, prices and quantities), which is
  created with its generated article number in the same step. Stock goes up with
  the usual moving-average cost (`weightedAverageCost`).
- **A send-back is credited at what the supplier billed**, not today's average, and
  removes exactly that value from the size's stock before re-averaging the rest
  (nothing left ⇒ cost 0) — so the Inventory account and Σ stock × cost move
  together. Each line is capped at what arrived, less what already went, **and**
  at what is on the shelf: sold pieces can not go back. The shelf is looked at
  **before** anything posts, so a refused send-back leaves nothing in the Khata.
- **If the supplier was already paid**, a send-back leaves their balance negative
  ("they owe us"); the money coming back is recorded with **You got** in their
  Khata — there is no separate refund flow.
- **Undo** (`POST /goods-receipts/:id/undo`) only while nothing was sent back and
  every size still holds what arrived. It claims the receipt first (received →
  reversed, atomically, so two undos can't both run), takes the stock back, then
  reverses the entry; any failure releases the claim and restores the stock. An
  article the delivery created **stays, at zero stock** — deleting products is a
  separate feature.
- **Stock writes are optimistic** (`changeVariant`): the write only lands if the
  size's stock and cost are still what was read, and `totalStock` is moved in
  the same write. The receipt itself has `optimisticConcurrency`, so two
  send-backs racing on one receipt can't both count the same pieces; the loser is
  unwound (entry reversed, stock restored).
- **Order of writes:** the entry first (a locked period refuses before any stock
  moves), then the shelf; on any failure everything is undone — never goods in
  the books but not on the shelf, or the reverse.
- **Khata can't reverse these entries** (`reverseMessage`: "Undo this on the goods
  receipt"). **Costs:** `unitCostPaisa`, `totalCostPaisa`, `paidNowPaisa` and
  `valuePaisa` are stripped for anyone without "See costs" (`hideCosts`).
- **Don't also enter finished goods as a Shop expense** — that counts the cost
  twice. (Raw materials and tailoring have a refusal for this, §10.2d; finished
  goods do not.)

### 10.2e Opening balances (`utils/opening.js`)

What the business already had and owed the day it starts on B Ledger. It was
earned or spent before, so it never moves cash or this period's profit. Every
opening posts against **Opening balances (3200, equity)**:

- **Khata** (`POST /parties/:id/opening`, `owesUs`): the person's own running
  account against 3200.
  - Accounts by type: supplier → AP, reseller/customer → AR, employee →
    Salaries payable, courier → COD receivable, lender → Loan payable.
  - A lender can only be owed.
- **Opening stock:** a batch cost line with `fund: 'opening'` (`opening: true`)
  credits 3200 instead of money.
- **Material on the shelf:** a material purchase with `opening: true` credits 3200.
- **Cash and bank** go in as capital ("Owner put money in"), not here.
- The Getting started step `opening` ticks once any entry touches 3200.

### 10.3 Party transactions — "You gave" / "You got"

`POST /parties/:id/transactions` — the DigiKhata action. The party's **type**
picks the account (`utils/partyPosting.js`):

| Party              | gave                                                     | got                                                                         |
| ------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| supplier           | payment (AP)                                             | a **bill** — requires `category` (an expense code), expense owed on AP      |
| reseller, customer | money given (AR)                                         | payment received (AR); a customer's is applied to its counter sales (§10.4) |
| employee           | salary paid (§10.5), or `purpose: 'advance'`             | salary due                                                                  |
| lender             | principal repaid (≤ owed; interest via `/finance/loans`) | loan taken                                                                  |
| courier            | refused                                                  | refused — recorded on its invoice (§10.2)                                   |

### 10.4 Credit counter sales

A walk-in left unpaid is owed by a `customer` party. A payment on the party is
applied to its unpaid counter sales **oldest first**, recorded per order in
`paidPaisa`; fully covered orders flip to paid. "Mark paid" on the order then
books only what is still owed. An order paid from the customer's account can't
be marked unpaid from the order (record a refund on the party instead).

### 10.5 Salary and advances

Both live on **Salaries Payable**, tagged to the employee — never tag the
salary _expense_, or a paid employee reads as owing us. `salaryLines`:

- **Salary due** (accrue): Dr Salaries / Cr Salaries Payable.
- **Salary paid**: clears what is owed **first**; only the rest is new expense —
  so accrue-then-pay books the salary once.
- **Advance**: Dr Salaries Payable / Cr Cash — not an expense. It nets off the
  next salary due, or is cut from a payment with `deductAdvance` (the expense is
  cash paid + advance cut; the cut can't exceed the advance held).

### 10.6 Cash book and the home numbers

`GET /finance/cashbook` is the Cash (or Bank) account's ledger for a range, read
as opening / in / out / closing — it can't disagree with the books. The client
sends its **local** day bounds. Rows run by Pakistan day, then by when each entry
was recorded (`recordedAt`) — a form's date is stored as midnight UTC, so the
stored time is not the time to show or sort by. `GET /finance/summary` returns cash, bank, to
get, to give for the home screen. Both need `journal:read`.

### 10.7 Courier performance (`utils/courierPerformance.js`) — counts, not money

`GET /finance/reports/courier-performance?business=&from=&to=&by=` (`reports:read`;
`by` = `courier` | `city` | `courier-city`; dates are Pakistan days, at most a
year). The measure is parcels **dispatched** in the range, per business — a
courier is a business's own party, so nothing is combined across businesses.

| Term                      | Definition                                                                                                                                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Delivered                 | status `delivered`, `refunded` or `exchanged` — the courier delivered; the customer sent it back **afterwards**                                                                                  |
| Returned                  | status `returned` (refused at the door, or brought back)                                                                                                                                         |
| In transit                | status `dispatched`                                                                                                                                                                              |
| Decided                   | delivered + returned                                                                                                                                                                             |
| Delivered % / Returned %  | over **decided** only                                                                                                                                                                            |
| Sent back by customer %   | (refunded + exchanged) ÷ delivered — **informational**; never ranks a courier, because the customer decides and no reason is recorded                                                            |
| Avg days                  | mean of `deliveredAt − dispatchedAt` over delivered parcels, weighted in the totals                                                                                                              |
| First-attempt %           | delivered parcels with **no** logged failed attempt ÷ delivered parcels where `attemptsTracked` is true; `null` when none are tracked                                                            |
| `tooFew`                  | decided under `MIN_DECIDED` (10) — a ratio on a handful of parcels is noise, and the UI says so                                                                                                  |
| `cancelledBeforeDispatch` | **one number for the period**, by `cancelledAt` — `cancelled` is only reachable from `pending`/`confirmed` (`ORDER_TRANSITIONS`), before a courier is chosen, so it can never be a courier's row |

- **Failed attempts** (`POST /orders/:id/attempts`, `orders:update`, dispatched
  parcels only) go in `Order.deliveryAttempts`; they change no status and book
  nothing. `attemptsTracked` is set at dispatch, so a parcel sent before this
  existed is never mistaken for a first-time delivery.
- **One city list.** `utils/cities.js` is the source of truth (`GET /system/cities`
  serves it to the order form). `normalizeCity` is a Mongoose **setter** on
  `Order.city` and `Customer.city` (so create, edit and update queries agree):
  listed names and known aliases become the listed name, anything else is only
  tidied into Title Case — never guessed. Old data is cleaned by
  `npm run backfill:cities` (dry run by default, `-- --apply` writes; take a backup
  first). It lists every place the list does not know, for a person to review.
- A past period can still move: a parcel sent in September and refunded in
  November changes September's refunded count the next time the report runs.

### 10.9 Courier integration — PostEx books the parcel and reports back

A courier Party can be connected to its own service (`Party.integration`; PostEx today, TCS later behind the same adapter in `utils/couriers/`). **One key per courier, so one per business**, stored AES-256-GCM encrypted (`utils/secretBox.js`, master key `COURIER_SECRET_KEY` in env, never in the DB). The key is write-only: `select:false`, stripped from `toJSON`, redacted in logs, admin-only routes (`/parties/:id/connection`).

- **Dispatch** with `bookWithCourier` calls `bookParcel` (`utils/couriers/booking.js`): an atomic claim, the PostEx call, then the tracking number is saved on `order.courierBooking` before anything else can fail. A double tap makes one parcel; a refusal leaves the order where it was.
- **Status check** (`utils/courierSync.js`, every 15 min, in-process like the booking reminders, shown in `/health`) only **marks** `courierBooking.confirmable`. It never changes `order.status` — delivered posts revenue, COGS and stock and is terminal, so a person confirms.
- **Confirm** (`POST /orders/confirm-courier`, ≤ 50) runs the ordinary `updateOrderStatus` per order, filling the delivery/return charge with the courier's `fee + tax` when it reported one (otherwise blank → the courier invoice, §10.2). One order failing never stops the rest.
- The courier's fee/tax is **its delivery charge**, not the FBR COD withholding — check one settled parcel against the statement before trusting the prefill.
- Tests inject `courierDeps.fetchImpl`; no test can reach a real courier. `npm run postex:check` is a read-only local check of a key.

### 10.10 Round 8 rules — names, remarks, payees (2026-10-26)

- **Names follow the product until dispatch, then freeze** (`utils/orderNames.js`). A line's
  `productName` is a snapshot, but renaming a product renames it on orders in `pending | confirmed |
booked` (`renameOnOpenOrders`), and booking a parcel reads the **live** name for the slip and saves it
  on the order in the same write. Dispatched and later orders keep the name they sold under. The profit
  report shows the live name once per article.
- **The slip carries what the customer asked for.** `transactionNotes` = the dispatcher's
  `courierRemarks` (default: the order's **Customer note**, max 250), never the internal `note`. The
  booking saves `courierBooking.remarks` and `sentContents`, so the order can say what was given and warn
  when the note changed afterwards (PostEx can not update a booked parcel).
- **Preview before booking** — `GET /orders/:id/parcel-preview` calls the same `parcelFor` as the booking
  and sends nothing; it lists every problem in plain words.
- **A cost that is Paid names who was paid** (production batch costs and order custom-work costs). It posts
  the way goods-received "paid now" does — Dr cost / Cr Payables [supplier], then Dr Payables [supplier] /
  Cr the account — so the supplier's Khata shows the bill **and** the payment and ends at zero. An open
  draft with an unnamed paid cost can not close. "On credit" is unchanged.
- **Cancel a courier parcel** (`POST /orders/:id/courier-cancel`): `reopen: true` sends the order back to
  **Confirmed** (tracking and booking cleared, stock still held — dispatching posts nothing), otherwise it
  is returned with no charge. A parcel the courier already shows as cancelled does not block it.
- **Test and demo settings can not reach real data:** `POSTEX_BASE_URL` / `COURIER_SYNC_SECONDS` stop the
  server starting in production; tests refuse a database whose name lacks "test"; `npm run find:testdata`
  is a read-only scan of a real database for records that look like test data.

### 10.8 Selling without stock, owner withdrawals, idempotent orders, branding

- **Selling without stock.** `Product.allowOversell` (a new article starts from
  `Business.defaultAllowOversell`) lets **customer orders** take stock below zero.
  `utils/stock.js reserveStock(items, { allowOversell: true })` — every order call
  passes it; **consignments never do** (you can not hand a reseller pieces you do not
  have). The decrement is unconditional only for those articles, and each line gets
  `item.oversold` (pieces not on the shelf). `variants.stock` has **no `min`** on
  purpose — `$inc` skips validators, and a floor would make a later `product.save()`
  fail on an article that is merely short. Never add one back.
- **Per size.** `Product.allowOversell` covers every size of the article, but a size can be
  switched OFF with `variants[].allowOversell: false` (absent = follow the article; no backfill).
  The one rule is `canOversell(product, variant)` in `utils/stock.js` — an article that is off
  is never overridden by a size. `updateProduct` rebuilds each variant by hand, so it must carry
  the flag or every edit would wipe it (tested). The order form mirrors the rule in
  `frontend/src/lib/stock.ts keepsSelling`; keep the two in step.
- **Cost of those pieces.** The order snapshots `unitCost` at create. At **delivery**
  `refreshOversoldCost` (`utils/orderPosting.js`) re-reads the article's current cost
  for any line that was oversold or had cost 0; if it is still 0 the line is booked
  at 0 and flagged `costUnknown`. The books are **not** back-corrected when stock
  arrives later (accepted — see §11). `weightedAverageCost` clamps negative stock to
  0, so after -10 + 12 the cost is the new batch's. Goods-received send-back and undo
  still refuse unless the shelf holds the pieces.
- **Shopify order number is a reference, never a series.** `Order.shopifyOrderNumber` (cleaned by
  `utils/shopifyNumber.js`: `#12,355` → `12355`) lets staff trace our order to the store's.
  Optional, not unique (a cancelled order is re-entered), editable at any status through
  `PUT /orders/:id/shopify-number`, searchable. Our `orderNumber` / daily serial are untouched.
- **`GET /orders/summary?business=`** returns today's dispatched / delivered (by the day the event
  happened, a Pakistan day), `pending` (all dates) and `byStatus` — one round trip for the Orders
  strip. Out-of-scope business → 404.
- **Booked orders.** Status `booked` + `Order.bookedFor` (a Pakistan day) = taken now, wanted
  later. It behaves like pending/confirmed (`BEFORE_DISPATCH` in `utils/constants.js`: editable,
  takes advances and custom costs, **holds stock**; cancelling releases it) and may move to
  pending/confirmed/dispatched/cancelled; pending/confirmed may move to booked. Booking needs a
  day that is not past. `utils/bookingReminders.js` runs at boot and every 10 minutes: for each
  booked order whose day has come it **claims** the order with one atomic update
  (`bookingAlertedOn = today`) and only then `notify()`s — at most once per order per day even
  with two processes — from 09:00 Pakistan time, and keeps nudging daily until the order leaves
  booked. `/api/v1/health` carries `reminders.lastRunAt`; a stale value means it stopped. Any
  code that lists order statuses must learn `booked` (the trap).
- **Self delivery** (`Order.selfDelivery` + `deliveredBy`, a name — not a user). A parcel we
  take ourselves has **no courier**: dispatch needs only `deliveredBy` (tracking optional), and
  `postOrderSale` takes the non-courier branch — **no COD tax, no courier receivable, no courier
  invoice**. At delivery `collected` (default) books the cash straight into `collectInto` (Cash
  if omitted) and marks the order paid; `collected:false` leaves it owed on the customer's khata
  (a customer party is made) and unpaid. The trip's cost (`deliveryCharge`, with `note` as the
  memo) is a Delivery/Return-charges expense paid from `costAccount` (`postCourierCost`'s
  `options.account`). The courier report skips these (`courier: {$ne: null}`) and returns them
  apart as `selfDelivery` per person. `GET /orders/deliverers` suggests names.
- **Customers: phone is one spelling.** `Customer.phone` is always saved as `03XXXXXXXXX`
  (`utils/phone.js`; a landline or foreign number is kept as digits, never refused), so
  `0300-1234567` and `+92 300 1234567` are one customer. Orders, hand-added and imported
  customers all go through it. **Run `npm run normalize:phones` once** (dry run first, backup
  first) to merge the old duplicates. `POST /customers` (`customers:create`) adds one;
  `POST /customers/import` takes ≤500 rows, **skips** existing phones (never overwrites),
  safe to send twice; `GET /customers/export?business=` streams one business as a UTF-8 CSV
  (BOM, formula-injection guard in `utils/csv.js`), logs who exported, 10 an hour per user.
  `Customer.source` is `order` | `manual` | `import`.
- **Presence.** `utils/presence.js`: a person is **online** with ≥1 live socket (tabs count once;
  a 20 s grace stops a refresh blinking them offline). **Last active** is a different fact:
  `User.lastActiveAt`, written from `protect` at most once a minute per person (no `updatedAt`
  churn) and when they go offline. `GET /users/presence` lists who is online; changes are emitted
  on `presence` **only** to the `presence` room, which sockets join if they can read users.
  Every session now connects its socket, but business events are joined only with
  `notifications:read` (the rule was client-only before). In memory = one API process; scaling
  out needs the Socket.IO Redis adapter.
- **Owner withdrawals are not an expense.** `profitAndLoss` also returns
  `ownerTookPaisa` (every capital-sourced entry's debit to an equity account, except
  Retained Earnings — so Drawings **and** partner capital accounts, but not a profit
  share) and `leftInBusinessPaisa`. `POST /finance/capital` takes an optional
  `purpose` (`home` | `personal`) that only changes the cash-book words.
- **Owner money needs a partner when there are partners.** `POST /finance/capital`
  (the shared owner account) answers **400** while the business has an **active**
  partner — for money in _and_ out — and says to choose the partner. Owner money then
  goes through `POST /partners/:id/invest|withdraw`, which names who it was. Enforced
  on the server because the screen can't be trusted to: someone with Money access but
  no Partners access can't even read the partner list, so the screen thinks there are
  none. A partner who has left (`isActive: false`) no longer blocks it. Raw accountant
  entries (`/finance/manual`) stay outside this rule.
- **More expense accounts.** `META_ADS` 5500, `OTHER_ADS` 5510, `OFFICE` 5420 are in
  `DEFAULT_CHART`; `ensureChart` adds missing accounts to existing businesses the
  first time they are used, so no migration is needed. Do not rename an existing
  account's `name` in `DEFAULT_CHART` — only new businesses would see it.
- **Idempotent order creation.** `Order.clientRef` (made by the app) with a **partial**
  unique index on `{ business, clientRef }` — partial, not sparse, because a sparse
  compound index still indexes every order. `createOrder` answers a repeat with the
  existing order (**200**, not 201), and the unique-index loser of two racing sends
  gives its stock back and returns the winner. A racing loser can burn one order
  number (accepted).
- **Order notes.** `Order.customerNote` is what the customer asked for (set at
  create, `PUT /orders/:id/customer-note`); `Order.note` is the team's, shown as
  **Reason** in the UI — the field was not renamed, so no migration or API change.
- **Business look.** `Business.logo` is a base64 `data:` URL of **png/jpeg/webp only,
  ≤ 150 KB** (never SVG — it can carry script — and never a remote URL; limits in
  `utils/constants.js`, enforced in `schemas/businesses.js` and the model) and
  `brandColor` is `#rrggbb`. `null` removes either. The business **list** and
  `/auth/me`'s assigned businesses include them, so the switcher can draw them —
  keep them out of any other lean list.

---

## 11. Known Gaps

Honest list. Nothing here is a blocker for building features, but each will
cost more the longer it waits.

### Should do next

| Gap                          | Why it matters                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Request validation (Zod)** | Done (core routes): `middlewares/validate.js` + `schemas/` runs Zod after `protect`/`can`, before the controller — it 400s with the field-error array (§4.1), strips unknown keys, and preserves the JWT-stamped `createdBy`/`updatedBy`. Wired on **finance, partners, orders, consignments, auth, push, businesses, categories, parties, customers, roles, users**. **Still to do:** `products` and `production` (deeply nested variant/cost-line bodies — do each with a live create check). |
| **Tests**                    | Done (initial, risk-based): `node:test` accounting + permission suite in `test/` (ledger invariants, order/walk-in/courier posting, charges at outcome, courier settlement, party transactions, salary + advances, cash book, batch correction, partner distribution, resolver matrix), run against a throwaway Mongo (`MONGO_TEST_URI`). Run via `npm test`, enforced in CI. Expand to more controllers over time.                                                                             |
| **ESLint + Prettier**        | Done: oxlint + Prettier configured (`.oxlintrc.json`, `.prettierrc.json`), a composite `npm run check`, a CI workflow, and a husky/lint-staged pre-commit that blocks unformatted / lint-broken commits.                                                                                                                                                                                                                                                                                        |
| **Structured logging**       | Done: `pino` + `pino-http` route every runtime log through one logger (`utils/logger.js`) — JSON in prod, pretty in dev, `silent` under test; per-request correlation ids; redacts the `authorization`/`cookie` headers and any `password`. Mounted where morgan was (§5). The seeder (a CLI) and `config/env.js` (runs before the logger exists) intentionally stay on `console`.                                                                                                              |
| **Env validation at boot**   | Done: `config/env.js` (imported first in `server.js`) fails fast on a missing `MONGODB_URI`/`JWT_SECRET` instead of surfacing it at first login.                                                                                                                                                                                                                                                                                                                                                |

### Deferred deliberately

- **TypeScript.** Do Zod first — `z.infer` writes most of the types for you.
- **Auth token model (done).** Short-lived **access** JWT (`JWT_ACCESS_EXPIRE`,
  ~15m, carries `tokenVersion`) traded via `POST /auth/refresh` for a rotating
  **refresh** token — a random secret stored only as a SHA-256 hash
  (`models/RefreshToken.js`, TTL-swept) and delivered as an **httpOnly** cookie
  (`utils/refreshTokens.js`). Rotation consumes each token so a replay 401s
  (reuse defence). Logout revokes the token, clears the cookie, and bumps
  `tokenVersion`. Cross-origin deploys set `COOKIE_SAMESITE=none` (HTTPS).
- **File uploads.** Removed. If added back, note that writing to `public/` does
  **not** work on Vercel serverless — use S3, Cloudinary or Vercel Blob.

### Accepted trade-offs in the money flows

- **Oversold pieces are costed late.** A line delivered before any stock arrived is
  booked at cost 0 (flagged `costUnknown`), and the books are not corrected when
  stock comes in. Profit on it is overstated until then. A cost catch-up entry on
  arrival would fix it — not built.

- **Staff advances sit on Salaries Payable**, so an advance shows as a negative
  liability on the balance sheet rather than a separate asset. Profit is right.
- **An employee repaying an advance in cash** has no endpoint; it is cut from
  salary instead.
- **Undoing a courier settlement** is an accountant action (reverse the entry in
  the journal); everyday users can't.
- The older finance read endpoints (trial balance…) answer **403** for a business
  outside scope; newer ones (`/parties/summary`, `/finance/cashbook`,
  `/finance/summary`) answer **404** as §6 requires. Align the old ones.

### Operational

- **`POST /system/reset` (admin data wipe) is a testing aid — and it clears ONE business.**
  It refuses unless `ALLOW_DATA_RESET=true`, refuses a business with `isProtected`
  ("real data", admin-only flag), and needs that business's exact name typed. It deletes
  every record carrying that `business` (read from the model registry, in
  `utils/businessData.js`), keeps the business, users, roles, categories and the order
  counter, and writes a JSON-lines copy to `ops/reset-snapshots/` first (gitignored; holds
  customer data). `GET /system/reset-preview` shows the counts. Remove the flag and the
  feature before real go-live.

- **Rotate the VAPID keypair per environment.** A fresh pair is in the local
  envs; the one committed to the old repository is public — never reuse it.
  `npx web-push generate-vapid-keys`.
