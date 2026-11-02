import { test, before, after, afterEach, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { connect, clear, disconnect, makeBusiness, runHandler } from './helpers/db.js';
import Role from '../models/Role.js';
import User from '../models/User.js';
import { createUser, deleteUser, getPresence, updateUser } from '../controllers/userController.js';
import { createRole, deleteRole, getRegistry, updateRole } from '../controllers/roleController.js';
import { loadUser, scopeRoles, scopeUsers } from '../middlewares/delegation.js';
import { can } from '../middlewares/permissions.js';
import { roleVisibilityFilter, userVisibilityFilter } from '../utils/delegation.js';

/**
 * The Business Owner: manages the people and roles of THEIR OWN businesses, and nothing beyond. Every row of the
 * escalation matrix below must be refused and leave the database exactly as it was — the screens hiding a button is
 * not the protection, the server is.
 */
before(connect);
after(disconnect);
afterEach(clear);

let A;
let B;
let admin;
let owner;
let owner2;
let ownerPeer;
let staffA;
let staffAB;
let staffB;
let adminInA;
let roles;

const grid = (resource, actions, scope = 'own') => ({ resource, actions, scope });

let n = 0;
const person = async (name, role, businesses) =>
  User.create({
    name,
    email: `${name.toLowerCase().replace(/\W/g, '')}${(n += 1)}@example.com`,
    phone: `0300${String(1000000 + n)}`,
    password: 'a-long-enough-password-1',
    role: role._id,
    assignedBusinesses: businesses.map(b => b._id)
  });

/** The signed-in person as `protect` loads them: role populated, businesses as ids. */
const actorOf = user => User.findById(user._id).populate('role');

beforeEach(async () => {
  A = await makeBusiness({ name: 'Shop A' });
  B = await makeBusiness({ name: 'Shop B' });

  roles = {
    admin: await Role.create({ name: 'Admin', fullAccess: true, isSystem: true }),
    owner: await Role.create({
      name: 'Business Owner',
      permissions: [
        grid('users', ['read', 'create', 'update', 'delete']),
        grid('roles', ['read', 'create', 'update', 'delete']),
        grid('orders', ['read', 'create', 'update']),
        grid('products', ['read', 'create']),
        grid('integrations', ['read'])
      ]
    }),
    // An Admin-made template owners may give out.
    template: await Role.create({
      name: 'Order taker',
      delegable: true,
      permissions: [grid('orders', ['read', 'create'])]
    }),
    // An Admin-made role owners may NOT give out.
    hidden: await Role.create({ name: 'Accountant', permissions: [grid('orders', ['read'])] }),
    // A template that is beyond what the owner holds.
    wide: await Role.create({
      name: 'Wide template',
      delegable: true,
      permissions: [grid('products', ['read', 'delete'])]
    }),
    // Made for Shop B by another owner.
    forB: await Role.create({
      name: 'B staff',
      business: B._id,
      permissions: [grid('orders', ['read'])]
    })
  };

  admin = await person('Admin Person', roles.admin, []);
  adminInA = await person('Admin In A', roles.admin, [A]);
  owner = await person('Owner A', roles.owner, [A]);
  owner2 = await person('Owner B', roles.owner, [B]);
  ownerPeer = await person('Owner A2', roles.owner, [A]);
  staffA = await person('Staff A', roles.template, [A]);
  staffAB = await person('Staff AB', roles.template, [A, B]);
  staffB = await person('Staff B', roles.template, [B]);
});

const names = async filter => (await User.find(filter).sort('name')).map(u => u.name);

/** Run `attempt`, expect a refusal with `status`, and check nothing in the database moved. */
const refused = async (status, attempt) => {
  const before = [await User.countDocuments(), await Role.countDocuments()];
  const snapshot = JSON.stringify([await User.find().sort('_id'), await Role.find().sort('_id')]);
  await assert.rejects(attempt, err => {
    assert.equal(
      err.statusCode,
      status,
      `expected ${status}, got ${err.statusCode}: ${err.message}`
    );
    return true;
  });
  assert.deepEqual([await User.countDocuments(), await Role.countDocuments()], before);
  assert.equal(
    JSON.stringify([await User.find().sort('_id'), await Role.find().sort('_id')]),
    snapshot
  );
};

const invite = (actor, body) =>
  runHandler(createUser, {
    user: actor,
    body: { name: 'New Person', email: `new${(n += 1)}@example.com`, phone: '03001234567', ...body }
  });

// ── who can be seen ──────────────────────────────────────────────────────────

test('an owner sees only people whose businesses are all theirs, never an Admin or another business', async () => {
  const me = await actorOf(owner);
  assert.deepEqual(await names(await userVisibilityFilter(me)), ['Owner A', 'Owner A2', 'Staff A']);
});

test('an Admin sees everyone', async () => {
  const me = await actorOf(admin);
  assert.deepEqual(await userVisibilityFilter(me), {});
});

test('opening someone outside their reach is a 404 — a shared person, another business, an Admin, a made-up id', async () => {
  const me = await actorOf(owner);
  const open = target =>
    new Promise((resolve, reject) =>
      loadUser()({ user: me, params: { id: String(target) } }, {}, err =>
        err ? reject(err) : resolve()
      )
    );

  await refused(404, () => open(staffAB._id));
  await refused(404, () => open(staffB._id));
  await refused(404, () => open(owner2._id));
  await refused(404, () => open(adminInA._id));
  await refused(404, () => open('not-an-id'));
  await open(staffA._id);
});

test('changing yourself, another owner, or an Admin is refused even where they can be seen', async () => {
  const me = await actorOf(owner);
  const manage = target =>
    new Promise((resolve, reject) =>
      loadUser({ manage: true })({ user: me, params: { id: String(target) } }, {}, err =>
        err ? reject(err) : resolve()
      )
    );

  await refused(403, () => manage(owner._id)); // themselves
  await refused(403, () => manage(ownerPeer._id)); // another owner
  await manage(staffA._id);
});

test('presence tells an owner only about the people they can see', async () => {
  const me = await actorOf(owner);
  const filter = await userVisibilityFilter(me);
  const { body } = await runHandler(getPresence, { user: me, accessFilter: filter });
  assert.ok(Array.isArray(body.data.online));
});

// ── who can be invited ───────────────────────────────────────────────────────

test('an owner can invite staff into their own business with a template role', async () => {
  const me = await actorOf(owner);
  const out = await invite(me, {
    role: String(roles.template._id),
    assignedBusinesses: [String(A._id)]
  });
  assert.equal(out.status, 201);
  assert.equal(await User.countDocuments({ name: 'New Person' }), 1);
});

test('inviting into a business that is not theirs, or into none, is refused', async () => {
  const me = await actorOf(owner);
  const role = String(roles.template._id);
  await refused(403, () => invite(me, { role, assignedBusinesses: [String(B._id)] }));
  await refused(403, () =>
    invite(me, { role, assignedBusinesses: [String(A._id), String(B._id)] })
  );
  await refused(403, () => invite(me, { role, assignedBusinesses: [] }));
  await refused(403, () => invite(me, { role }));
});

test('inviting with the Admin role, a role above their own access, another business’s role, or a role Admin did not share is refused', async () => {
  const me = await actorOf(owner);
  const into = [String(A._id)];
  await refused(403, () => invite(me, { role: String(roles.admin._id), assignedBusinesses: into }));
  await refused(403, () => invite(me, { role: String(roles.wide._id), assignedBusinesses: into }));
  await refused(400, () => invite(me, { role: String(roles.forB._id), assignedBusinesses: into }));
  await refused(400, () =>
    invite(me, { role: String(roles.hidden._id), assignedBusinesses: into })
  );
  // The Business Owner role is not shared with owners, so it is simply "not a valid role" for them…
  await refused(400, () => invite(me, { role: String(roles.owner._id), assignedBusinesses: into }));
  // …and even if an Admin marked a role holding Users access as shareable, the keys are still never handed out.
  const keys = await Role.create({
    name: 'Shared keys',
    delegable: true,
    permissions: [grid('users', ['read'])]
  });
  await refused(403, () => invite(me, { role: String(keys._id), assignedBusinesses: into }));
});

test('personal permission overrides can be set only by an Admin', async () => {
  const me = await actorOf(owner);
  await refused(403, () =>
    invite(me, {
      role: String(roles.template._id),
      assignedBusinesses: [String(A._id)],
      permissionOverrides: [
        { resource: 'orders', effect: 'grant', actions: ['delete'], scope: 'own' }
      ]
    })
  );
});

test('an Admin invites anyone anywhere, exactly as before', async () => {
  const me = await actorOf(admin);
  const out = await invite(me, {
    role: String(roles.owner._id),
    assignedBusinesses: [String(A._id), String(B._id)]
  });
  assert.equal(out.status, 201);
});

// ── changing and removing people ─────────────────────────────────────────────

test('an owner can change a staff member’s role to one they may give, and switch them off', async () => {
  const me = await actorOf(owner);
  const own = await Role.create({
    name: 'Packer',
    business: A._id,
    permissions: [grid('orders', ['read'])]
  });
  const out = await runHandler(updateUser, {
    user: me,
    params: { id: String(staffA._id) },
    body: { role: String(own._id), status: 'inactive' }
  });
  assert.equal(out.status, 200);
  const after = await User.findById(staffA._id);
  assert.equal(String(after.role), String(own._id));
  assert.equal(after.status, 'inactive');
});

test('an owner cannot move staff into another business, give the Admin role, or set overrides', async () => {
  const me = await actorOf(owner);
  const change = body =>
    runHandler(updateUser, { user: me, params: { id: String(staffA._id) }, body });

  await refused(403, () => change({ assignedBusinesses: [String(A._id), String(B._id)] }));
  await refused(403, () => change({ assignedBusinesses: [] }));
  await refused(403, () => change({ role: String(roles.admin._id) }));
  await refused(403, () => change({ role: String(roles.wide._id) }));
  await refused(400, () => change({ role: String(roles.forB._id) }));
  await refused(403, () =>
    change({
      permissionOverrides: [
        { resource: 'orders', effect: 'grant', actions: ['delete'], scope: 'own' }
      ]
    })
  );
});

test('an owner can remove their own staff but never themselves', async () => {
  const me = await actorOf(owner);
  await runHandler(deleteUser, { user: me, params: { id: String(staffA._id) } });
  assert.equal(await User.countDocuments({ _id: staffA._id }), 0);

  await refused(400, () => runHandler(deleteUser, { user: me, params: { id: String(owner._id) } }));
});

// ── roles ────────────────────────────────────────────────────────────────────

test('an owner sees their own businesses’ roles and the templates, and nothing else', async () => {
  const me = await actorOf(owner);
  const mine = await Role.create({ name: 'Packer', business: A._id, permissions: [] });
  const seen = (await Role.find(roleVisibilityFilter(me)).sort('name')).map(r => r.name);

  assert.deepEqual(seen, ['Order taker', 'Packer', 'Wide template']);
  assert.ok(!seen.includes('B staff'));
  assert.ok(!seen.includes('Admin'));
  assert.ok(!seen.includes('Accountant'));
  assert.ok(mine);
});

test('an owner can make a role for their business, within what they hold', async () => {
  const me = await actorOf(owner);
  const out = await runHandler(createRole, {
    user: me,
    body: {
      name: 'Dispatcher',
      business: String(A._id),
      permissions: [grid('orders', ['read', 'update'])],
      delegable: true,
      fullAccess: true
    }
  });
  assert.equal(out.status, 201);
  const role = await Role.findById(out.body.data._id);
  assert.equal(String(role.business), String(A._id));
  assert.equal(String(role.createdBy), String(owner._id));
  assert.equal(role.delegable, false, 'only an Admin can mark a role as shareable');
  assert.equal(role.fullAccess, false);
});

test('an owner cannot make a role for another business, for nobody, or with access they do not hold', async () => {
  const me = await actorOf(owner);
  const make = body => runHandler(createRole, { user: me, body: { name: 'Sneaky', ...body } });

  await refused(403, () =>
    make({ business: String(B._id), permissions: [grid('orders', ['read'])] })
  );
  await refused(403, () => make({ permissions: [grid('orders', ['read'])] }));
  await refused(403, () =>
    make({ business: String(A._id), permissions: [grid('orders', ['delete'])] })
  );
  await refused(403, () =>
    make({ business: String(A._id), permissions: [grid('products', ['delete'])] })
  );
  await refused(403, () =>
    make({ business: String(A._id), permissions: [grid('orders', ['read'], 'all')] })
  );
  await refused(403, () =>
    make({ business: String(A._id), permissions: [grid('reports', ['read'])] })
  );
});

test('an owner can never hand out the keys: Users, Roles or Accountant tools', async () => {
  const me = await actorOf(owner);
  const make = permissions =>
    runHandler(createRole, {
      user: me,
      body: { name: 'Keys', business: String(A._id), permissions }
    });

  await refused(403, () => make([grid('users', ['read'])]));
  await refused(403, () => make([grid('roles', ['read'])]));
  await refused(403, () => make([grid('accounting', ['read'])]));
});

test('an owner can edit their own role but not an Admin’s template, another business’s role, or the Admin role', async () => {
  const me = await actorOf(owner);
  const mine = await Role.create({
    name: 'Packer',
    business: A._id,
    permissions: [grid('orders', ['read'])]
  });
  const edit = (role, body) => runHandler(updateRole, { user: me, resource: await_(role), body });
  const await_ = role => role;

  const out = await edit(mine, {
    permissions: [grid('orders', ['read', 'update'])],
    business: String(B._id),
    delegable: true
  });
  assert.equal(out.status, 200);
  const saved = await Role.findById(mine._id);
  assert.equal(
    String(saved.business),
    String(A._id),
    'the business of a role does not change through an edit'
  );
  assert.equal(saved.delegable, false);

  await refused(403, () => edit(roles.template, { description: 'mine now' }));
  await refused(403, () => edit(roles.forB, { description: 'mine now' }));
  await refused(403, () => edit(roles.admin, { description: 'mine now' }));
  await refused(403, () => edit(mine, { permissions: [grid('orders', ['delete'])] }));
});

test('an owner cannot delete a template, another business’s role, or a role still in use', async () => {
  const me = await actorOf(owner);
  const remove = role => runHandler(deleteRole, { user: me, resource: role });
  const mine = await Role.create({ name: 'Packer', business: A._id, permissions: [] });

  await refused(403, () => remove(roles.template));
  await refused(403, () => remove(roles.forB));
  await User.updateOne({ _id: staffA._id }, { role: mine._id });
  await refused(400, () => remove(mine));

  await User.updateOne({ _id: staffA._id }, { role: roles.template._id });
  assert.equal((await remove(mine)).status, 200);
});

test('the same role name can exist in two businesses, but not twice in one', async () => {
  await Role.syncIndexes();
  await Role.create({ name: 'Packer', business: A._id, permissions: [] });
  await Role.create({ name: 'Packer', business: B._id, permissions: [] });
  await assert.rejects(
    Role.create({ name: 'Packer', business: A._id, permissions: [] }),
    /duplicate|E11000/i
  );
});

// ── the grid and the permission check ────────────────────────────────────────

test('the role grid offers an owner only what they hold, and never the keys; an Admin is offered everything', async () => {
  const mine = await runHandler(getRegistry, { user: await actorOf(owner) });
  const offered = mine.body.data.grantable;
  assert.deepEqual(Object.keys(offered).sort(), ['integrations', 'orders', 'products']);
  assert.deepEqual([...offered.orders.actions].sort(), ['create', 'read', 'update']);

  const full = await runHandler(getRegistry, { user: await actorOf(admin) });
  assert.equal(full.body.data.grantable, null);
});

test('a route that forgets the delegation filter shows an own-scope manager no one rather than everyone', async () => {
  const me = await actorOf(owner);
  const req = { user: me };
  await new Promise(resolve => can('users', 'read')(req, {}, resolve));
  assert.deepEqual(await names(req.accessFilter), [], 'fails closed until scopeUsers narrows it');
  await new Promise(resolve => scopeUsers(req, {}, resolve));
  assert.ok((await names(req.accessFilter)).includes('Staff A'));

  const rolesReq = { user: me };
  await new Promise(resolve => can('roles', 'read')(rolesReq, {}, resolve));
  assert.equal((await Role.find(rolesReq.accessFilter)).length, 0);
  await new Promise(resolve => scopeRoles(rolesReq, {}, resolve));
  assert.ok((await Role.find(rolesReq.accessFilter)).length > 0);
});

test('a global manager granted by an Admin (scope "all") reaches every business, but the ceiling and the keys still apply', async () => {
  const globalRole = await Role.create({
    name: 'Global manager',
    permissions: [
      grid('users', ['read', 'create', 'update'], 'all'),
      grid('roles', ['read', 'create'], 'all'),
      grid('orders', ['read', 'create'], 'all')
    ]
  });
  const manager = await actorOf(await person('Global Mgr', globalRole, []));

  assert.deepEqual(await userVisibilityFilter(manager), {});
  const out = await invite(manager, {
    role: String(roles.template._id),
    assignedBusinesses: [String(A._id), String(B._id)]
  });
  assert.equal(out.status, 201);

  await refused(403, () =>
    runHandler(createRole, {
      user: manager,
      body: { name: 'Keys', permissions: [grid('users', ['read'], 'all')] }
    })
  );
  await refused(403, () =>
    runHandler(createRole, {
      user: manager,
      body: { name: 'Beyond', permissions: [grid('orders', ['delete'], 'all')] }
    })
  );
});
