import { test, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler } from './helpers/db.js';
import Partner from '../models/Partner.js';
import {
  createPartner,
  investPartner,
  distributeProfit
} from '../controllers/partnerController.js';
import { accountBalance } from '../utils/ledger.js';
import { toPaisa } from '../utils/money.js';

before(connect);
after(disconnect);
afterEach(clear);

// A partner's capital is the credit balance of their equity account.
const capital = async partner => -(await accountBalance(partner.business, partner.capitalAccount));

const addPartner = (business, name, sharePercent) =>
  runHandler(createPartner, { body: { business: String(business), name, sharePercent } }).then(
    r => r.body.data
  );

test('a new partner gets a dedicated equity capital account', async () => {
  const biz = await makeBusiness();
  const ali = await addPartner(biz._id, 'Ali', 100);
  assert.ok(ali.capitalAccount, 'capital account created');
});

test('invest raises the partner’s capital', async () => {
  const biz = await makeBusiness();
  const ali = await addPartner(biz._id, 'Ali', 100);
  await runHandler(investPartner, {
    resource: await Partner.findById(ali._id),
    body: { amount: 5000, method: 'cash' }
  });
  assert.equal(await capital(await Partner.findById(ali._id)), toPaisa(5000));
});

test('distributeProfit splits by share and each capital rises accordingly', async () => {
  const biz = await makeBusiness();
  const ali = await addPartner(biz._id, 'Ali', 40);
  const sana = await addPartner(biz._id, 'Sana', 60);

  await runHandler(distributeProfit, { body: { business: String(biz._id), amount: 1000 } });

  assert.equal(await capital(await Partner.findById(ali._id)), toPaisa(400));
  assert.equal(await capital(await Partner.findById(sana._id)), toPaisa(600));
});

test('distributeProfit refuses when active shares do not total 100%', async () => {
  const biz = await makeBusiness();
  await addPartner(biz._id, 'Ali', 40);
  await addPartner(biz._id, 'Sana', 60);
  await addPartner(biz._id, 'Zed', 10); // now 110%

  await assert.rejects(
    runHandler(distributeProfit, { body: { business: String(biz._id), amount: 1000 } }),
    /100%/
  );
});
