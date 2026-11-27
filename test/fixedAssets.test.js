import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { connect, clear, disconnect, makeBusiness, runHandler, oid, userId } from './helpers/db.js';
import FixedAsset from '../models/FixedAsset.js';
import JournalEntry from '../models/JournalEntry.js';
import { accountByCode, CODES } from '../utils/chartOfAccounts.js';
import { accountBalance, trialBalance } from '../utils/ledger.js';
import { clearLedger } from '../utils/ledgerClear.js';
import { toPaisa } from '../utils/money.js';
import { recordAsset, reverseJournalEntry } from '../controllers/financeController.js';
import {
  getAssets,
  getAsset,
  sellFixedAsset,
  undoFixedAssetSale
} from '../controllers/fixedAssetController.js';
import { assetSchema, assetSellSchema } from '../schemas/finance.js';

/**
 * Fixed assets: a list of what the business bought to keep, and selling or throwing one away books the gain or loss by
 * itself — bought 2,800, sold 2,500 is a Rs 300 loss. Every entry must balance.
 */
const snapshotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bledger-assets-'));
process.env.RESET_SNAPSHOT_DIR = snapshotDir;

before(connect);
after(async () => {
  fs.rmSync(snapshotDir, { recursive: true, force: true });
  await disconnect();
});
afterEach(clear);

const ADMIN = { id: userId, role: { fullAccess: true } };
const EVERYDAY = {
  id: userId,
  permissionOverrides: [],
  assignedBusinesses: [],
  role: {
    fullAccess: false,
    permissions: [
      { resource: 'journal', actions: ['read', 'create', 'update', 'delete'], scope: 'all' }
    ]
  }
};

const bal = async (biz, code) => accountBalance(biz._id, (await accountByCode(biz._id, code))._id);

const buy = (biz, body = {}) =>
  runHandler(recordAsset, {
    user: ADMIN,
    body: assetSchema.parse({
      business: String(biz._id),
      name: 'Light stand',
      amount: 2800,
      method: 'cash',
      ...body
    })
  }).then(r => r.body.data);

const sell = (asset, body, user = ADMIN) =>
  runHandler(sellFixedAsset, {
    user,
    resource: asset,
    body: assetSellSchema.parse({ method: 'cash', ...body })
  }).then(r => r.body.data);

const fresh = id => FixedAsset.findById(id);

const everyEntryBalances = async biz => {
  for (const e of await JournalEntry.find({ business: biz._id })) {
    const debit = e.lines.reduce((s, l) => s + l.debitPaisa, 0);
    const credit = e.lines.reduce((s, l) => s + l.creditPaisa, 0);
    assert.equal(debit, credit, `"${e.memo}" balances`);
  }
  assert.equal((await trialBalance(biz._id)).balanced, true);
};

test('buying lists the asset with its cost and links it to the purchase', async () => {
  const biz = await makeBusiness();
  const out = await buy(biz);
  assert.equal(out.asset.name, 'Light stand');
  assert.equal(out.asset.costPaisa, toPaisa(2800));
  assert.equal(String(out.asset.purchaseEntry), String(out._id));
  assert.equal(await bal(biz, CODES.CASH), -toPaisa(2800));
  assert.equal(await bal(biz, CODES.FIXED_ASSETS), toPaisa(2800));
});

test('an older app that sends only a memo still lists the asset, named from it', async () => {
  const biz = await makeBusiness();
  const out = await buy(biz, { name: undefined, memo: 'Sewing machine' });
  assert.equal(out.asset.name, 'Sewing machine');
  const plain = await buy(biz, { name: undefined, memo: undefined });
  assert.match(plain.asset.name, /^Asset bought \d{4}-\d{2}-\d{2}$/);
});

test('bought 2,800, sold 2,500: the cash comes in and Rs 300 is a loss to the business', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz);
  const sold = await sell(asset, { price: 2500, buyerName: 'Bilal' });

  assert.equal(sold.status, 'sold');
  assert.equal(sold.sale.gainLossPaisa, -toPaisa(300));
  assert.equal(sold.gainLoss, -300);
  assert.equal(await bal(biz, CODES.CASH), -toPaisa(300), '2,500 in, 2,800 out');
  assert.equal(await bal(biz, CODES.FIXED_ASSETS), 0);
  assert.equal(await bal(biz, CODES.ASSET_SALE_LOSS), toPaisa(300));
  assert.equal(await bal(biz, CODES.ASSET_SALE_GAIN), 0);
  await everyEntryBalances(biz);
});

test('sold for more than it cost: the extra is a gain', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz);
  const sold = await sell(asset, { price: 3000 });
  assert.equal(sold.sale.gainLossPaisa, toPaisa(200));
  assert.equal(await bal(biz, CODES.ASSET_SALE_GAIN), -toPaisa(200), 'income: credit balance');
  await everyEntryBalances(biz);
});

test('an accountant can count depreciation for the item; anyone else is refused', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz);
  await assert.rejects(sell(asset, { price: 2000, depreciation: 500 }, EVERYDAY), /accountant/);
  assert.equal((await fresh(asset._id)).status, 'in-use', 'nothing happened');

  // The pooled depreciation account must hold it first (an accountant posted it earlier).
  const accumulated = (await accountByCode(biz._id, CODES.ACCUMULATED_DEPRECIATION))._id;
  const expense = (await accountByCode(biz._id, CODES.DEPRECIATION))._id;
  const { postEntry } = await import('../utils/ledger.js');
  await postEntry({
    business: biz._id,
    memo: 'Depreciation',
    lines: [
      { account: expense, debitPaisa: toPaisa(500) },
      { account: accumulated, creditPaisa: toPaisa(500) }
    ],
    userId
  });
  const sold = await sell(asset, { price: 2000, depreciation: 500 });
  // book value 2,300, sold 2,000 → a loss of 300
  assert.equal(sold.sale.gainLossPaisa, -toPaisa(300));
  assert.equal(await bal(biz, CODES.ACCUMULATED_DEPRECIATION), 0, 'its share is cleared');
  await everyEntryBalances(biz);
});

test('thrown away: the whole value is a loss and no money moves', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz);
  const gone = await sell(asset, { throwAway: true, method: undefined });
  assert.equal(gone.status, 'thrown-away');
  assert.equal(gone.sale.gainLossPaisa, -toPaisa(2800));
  assert.equal(await bal(biz, CODES.CASH), -toPaisa(2800), 'only the purchase moved cash');
  assert.equal(await bal(biz, CODES.ASSET_SALE_LOSS), toPaisa(2800));
  await everyEntryBalances(biz);
});

test('it can not be sold twice, before it was bought, or with the money nowhere', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz, { date: '2026-11-10' });
  await assert.rejects(
    sell(asset, { price: 100, date: '2026-11-01' }),
    /before the day it was bought/
  );
  await assert.rejects(
    runHandler(sellFixedAsset, {
      user: ADMIN,
      resource: asset,
      body: assetSellSchema.parse({ price: 100 })
    }),
    /where the money came in/
  );
  await assert.rejects(
    runHandler(sellFixedAsset, { user: ADMIN, resource: asset, body: assetSellSchema.parse({}) }),
    /sold for/
  );
  await sell(asset, { price: 100 });
  await assert.rejects(sell(await fresh(asset._id), { price: 100 }), /already been sold/);
});

test('undoing a sale restores the books and the asset; a second undo is refused', async () => {
  const biz = await makeBusiness();
  const { asset } = await buy(biz);
  await sell(asset, { price: 2500 });
  const back = await runHandler(undoFixedAssetSale, {
    user: ADMIN,
    resource: await fresh(asset._id)
  });
  assert.equal(back.body.data.status, 'in-use');
  assert.equal(back.body.data.sale, undefined);
  assert.equal(await bal(biz, CODES.FIXED_ASSETS), toPaisa(2800));
  assert.equal(await bal(biz, CODES.ASSET_SALE_LOSS), 0);
  assert.equal(await bal(biz, CODES.CASH), -toPaisa(2800));
  await assert.rejects(
    runHandler(undoFixedAssetSale, { user: ADMIN, resource: await fresh(asset._id) }),
    /has not been sold/
  );
  await everyEntryBalances(biz);
});

test('the journal refuses to reverse a sale, or the purchase of a sold asset; an unsold purchase may be reversed', async () => {
  const biz = await makeBusiness();
  const first = await buy(biz);
  await sell(first.asset, { price: 2500 });
  const saleEntry = await JournalEntry.findOne({ business: biz._id, 'source.kind': 'asset-sale' });
  const reverse = entry =>
    runHandler(reverseJournalEntry, { user: ADMIN, resource: entry, body: {} });
  await assert.rejects(reverse(saleEntry), /Undo this on the asset/);
  await assert.rejects(
    reverse(await JournalEntry.findById(first._id)),
    /sold — undo the sale first/
  );

  const second = await buy(biz, { name: 'Sewing machine', amount: 9000 });
  await reverse(await JournalEntry.findById(second._id));
  const marked = await fresh(second.asset._id);
  assert.equal(marked.status, 'thrown-away');
  assert.equal(marked.note, 'Purchase reversed');
  assert.equal(
    await bal(biz, CODES.FIXED_ASSETS),
    toPaisa(2800) - toPaisa(2800),
    'only the sold one remains, at 0'
  );
});

test('the list filters by status, and another business is not found', async () => {
  const biz = await makeBusiness();
  const a = await buy(biz);
  await buy(biz, { name: 'Mannequin', amount: 5000 });
  await sell(a.asset, { price: 2500 });

  const list = status =>
    runHandler(getAssets, { query: { business: String(biz._id), status }, accessFilter: {} }).then(
      r => r.body.data
    );
  assert.equal((await list('in-use')).length, 1);
  assert.equal((await list('sold')).length, 1);
  assert.equal((await list(undefined)).length, 2);
  assert.equal(
    (await list('sold'))[0].bookValue,
    0 + 2800,
    'its book value is its cost less depreciation'
  );

  await assert.rejects(
    runHandler(getAssets, {
      query: { business: String(biz._id) },
      accessFilter: { business: { $in: [oid()] } }
    }),
    /not found/
  );
  const one = await runHandler(getAsset, { resource: await fresh(a.asset._id) });
  assert.equal(one.body.data.cost, 2800);
});

test('clearing the hand-entered money deletes the asset list with its entries, and keeps a copy', async () => {
  const biz = await makeBusiness({ name: 'Clear Me' });
  const a = await buy(biz);
  await sell(a.asset, { price: 2500 });
  await buy(biz, { name: 'Mannequin', amount: 5000 });

  const out = await clearLedger({ business: biz._id, userId });
  assert.equal(out.assets, 2);
  assert.equal(await FixedAsset.countDocuments({ business: biz._id }), 0);
  const file = fs.readdirSync(snapshotDir).find(f => f.startsWith(`${biz._id}-ledger-`));
  const lines = fs
    .readFileSync(path.join(snapshotDir, file), 'utf8')
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.equal(lines.filter(l => l.collection === 'fixedassets').length, 2);
});

// ── the one-off that lists earlier purchases ────────────────────────────────

import { importFixedAssets } from '../utils/importFixedAssets.js';
import { postEntry, reverseEntry } from '../utils/ledger.js';

/** An asset purchase as it was posted before the list existed: only the entry, no asset row. */
const oldPurchase = async (biz, rupees, memo) => {
  const entry = await postEntry({
    business: biz._id,
    date: new Date('2026-09-05T10:00:00Z'),
    memo,
    source: { kind: 'asset' },
    lines: [
      {
        account: (await accountByCode(biz._id, CODES.FIXED_ASSETS))._id,
        debitPaisa: toPaisa(rupees)
      },
      { account: (await accountByCode(biz._id, CODES.CASH))._id, creditPaisa: toPaisa(rupees) }
    ],
    userId
  });
  return entry;
};

test('import: a dry run counts, apply lists each earlier purchase once, a second run finds nothing', async () => {
  const biz = await makeBusiness();
  await oldPurchase(biz, 2800, 'Light stand');
  await oldPurchase(biz, 9000, 'Fixed asset purchase');
  const reversedOne = await oldPurchase(biz, 500, 'Bought by mistake');
  await reverseEntry(reversedOne._id, { userId });
  await buy(biz, { name: 'Already listed', amount: 100 }); // a new-style purchase: has its asset already

  const dry = await importFixedAssets();
  assert.equal(dry.assets, 2, 'the reversed one and the listed one are not counted');
  assert.equal(dry.businesses[0].costPaisa, toPaisa(11800));
  assert.equal(
    await FixedAsset.countDocuments({ business: biz._id }),
    1,
    'a dry run writes nothing'
  );

  await importFixedAssets({ apply: true });
  const names = (await FixedAsset.find({ business: biz._id })).map(a => a.name).sort();
  assert.deepEqual(names, ['Already listed', 'Asset bought 2026-09-05', 'Light stand']);
  const stand = await FixedAsset.findOne({ name: 'Light stand' });
  assert.equal(stand.costPaisa, toPaisa(2800));
  assert.equal(stand.boughtOn.toISOString(), '2026-09-05T10:00:00.000Z');

  assert.equal((await importFixedAssets({ apply: true })).assets, 0, 'safe to run twice');
  // An imported asset sells like any other.
  const sold = await sell(stand, { price: 2500 });
  assert.equal(sold.sale.gainLossPaisa, -toPaisa(300));
});

test('import: reports the depreciation ever posted, so an accountant can split it later', async () => {
  const biz = await makeBusiness();
  await oldPurchase(biz, 2800, 'Light stand');
  await postEntry({
    business: biz._id,
    memo: 'Depreciation',
    lines: [
      { account: (await accountByCode(biz._id, CODES.DEPRECIATION))._id, debitPaisa: toPaisa(400) },
      {
        account: (await accountByCode(biz._id, CODES.ACCUMULATED_DEPRECIATION))._id,
        creditPaisa: toPaisa(400)
      }
    ],
    userId
  });
  const out = await importFixedAssets();
  assert.equal(out.businesses[0].depreciationPaisa, toPaisa(400));
});
