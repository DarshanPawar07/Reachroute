import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Plans and per-account limits against a THROW-AWAY MongoDB database (name must contain "test").
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
delete process.env.SMTP_HOST;
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { whatsappEngine } = await import('../src/engine/channels.js');
const { resolveLimits, engineLimits, forgetAllLimits } = await import('../src/plans/limits.js');
const { User, Plan, ContactList, Template, Campaign, Recipient, AuditLog, SessionLease } = models;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `pln${Date.now().toString(36)}`;
const made = [];
const planKeys = [];
let server;
let base;
let counter = 0;

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: (_req, _res, next) => next() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    Plan.deleteMany({ key: { $in: planKeys } }),
    ContactList.deleteMany({ userId: { $in: ids } }),
    Template.deleteMany({ userId: { $in: ids } }),
    Campaign.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ actorId: { $in: ids } }),
    SessionLease.deleteMany({ _id: { $in: ids.map(String) } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (r) => JSON.stringify(r.body);

async function newUser({ admin = false } = {}) {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  if (admin) await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });
  made.push(user);
  return user;
}
const newPlan = async (admin, suffix, limits = {}, name = 'Test plan') => {
  const key = `${tag}-${suffix}`;
  planKeys.push(key);
  const res = await call('POST', '/api/admin/plans', { token: admin.token, json: { key, name, limits } });
  assert.equal(res.status, 201, say(res));
  return key;
};
const setPlan = (admin, user, plan) => call('PUT', `/api/admin/users/${user.id}/plan`, { token: admin.token, json: { plan } });
const setLimits = (admin, user, limits) => call('PUT', `/api/admin/users/${user.id}/limits`, { token: admin.token, json: { limits } });
const csvForm = (name, rows) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('kind', 'email');
  fd.append('file', new Blob([`name,email\n${rows.map((r, i) => `P${i},${r}`).join('\n')}\n`], { type: 'text/csv' }), 'c.csv');
  return fd;
};

test('without a plan an account gets the platform defaults', T, async () => {
  const u = await newUser();
  const r = await resolveLimits(u.id);
  assert.deepEqual(r.plan, { key: 'default', name: 'Default' });
  assert.equal(r.limits.waDailyCap, config.dailyCap);
  assert.equal(r.limits.maxTemplates, config.maxTemplates);
  const mine = await call('GET', '/api/account/plan', { token: u.token });
  assert.equal(mine.status, 200, say(mine));
  assert.equal(mine.body.plan.key, 'default');
  assert.ok(mine.body.limits.every((l) => l.source === 'default'));
  assert.deepEqual(mine.body.usage, { lists: 0, templates: 0, attachments: 0, storageBytes: 0 });
  assert.equal((await call('GET', '/api/account/plan')).status, 401);
});

test('plan management is for administrators and validates its input', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  assert.equal((await call('GET', '/api/admin/plans', { token: u.token })).status, 403);
  assert.equal((await call('POST', '/api/admin/plans', { token: u.token, json: { key: 'xx', name: 'x' } })).status, 403);
  const list = await call('GET', '/api/admin/plans', { token: admin.token });
  assert.equal(list.status, 200, say(list));
  assert.equal(list.body.plans[0].key, 'default');
  assert.equal(list.body.plans[0].builtIn, true);

  const post = (json) => call('POST', '/api/admin/plans', { token: admin.token, json });
  assert.equal((await post({ key: 'default', name: 'x' })).status, 400);
  assert.equal((await post({ key: 'Bad Key!', name: 'x' })).status, 400);
  assert.equal((await post({ key: `${tag}-nn`, name: '' })).status, 400);
  assert.equal((await post({ key: `${tag}-nl`, name: 'x', limits: { nope: 1 } })).status, 400);
  assert.equal((await post({ key: `${tag}-nv`, name: 'x', limits: { maxLists: 0 } })).status, 400);

  const key = await newPlan(admin, 'dup', { maxLists: 3 });
  assert.equal((await post({ key, name: 'again' })).status, 409);
  assert.equal((await call('PUT', '/api/admin/plans/Bad_Key', { token: admin.token, json: { name: 'x' } })).status, 404);
  assert.equal((await call('PUT', `/api/admin/plans/${tag}-missing`, { token: admin.token, json: { name: 'x' } })).status, 404);
  assert.equal((await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: {} })).status, 400);
  const upd = await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: { name: 'Renamed', limits: { maxLists: 4 } } });
  assert.equal(upd.status, 200, say(upd));
  assert.equal(upd.body.plan.name, 'Renamed');
  assert.deepEqual(upd.body.plan.limits, { maxLists: 4 });
});

test('a plan changes what its accounts can do, and the account can see it', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const key = await newPlan(admin, 'small', { maxTemplates: 1, maxLists: 1, maxListContacts: 2 });
  assert.equal((await setPlan(admin, u, key)).status, 200);
  assert.equal((await setPlan(admin, u, `${tag}-nosuch`)).status, 404);

  const mine = await call('GET', '/api/account/plan', { token: u.token });
  assert.equal(mine.body.plan.key, key);
  const row = (k) => mine.body.limits.find((l) => l.key === k);
  assert.deepEqual([row('maxTemplates').value, row('maxTemplates').source], [1, 'plan']);
  assert.equal(row('waDailyCap').source, 'default');

  const tpl = (name) => call('POST', '/api/templates', { token: u.token, json: { kind: 'whatsapp', name, message: 'hi' } });
  assert.equal((await tpl('one')).status, 201);
  assert.equal((await tpl('two')).status, 429);
  assert.equal((await call('GET', '/api/templates', { token: u.token })).body.limit, 1);

  const tooMany = await call('POST', '/api/lists', { token: u.token, form: csvForm('big', ['a@example.com', 'b@example.com', 'c@example.com']) });
  assert.equal(tooMany.status, 400, say(tooMany));
  assert.equal((await call('POST', '/api/lists', { token: u.token, form: csvForm('ok', ['a@example.com', 'b@example.com']) })).status, 201);
  const second = await call('POST', '/api/lists', { token: u.token, form: csvForm('second', ['a@example.com']) });
  assert.equal(second.status, 429, say(second));

  // other accounts are not affected
  const other = await newUser();
  assert.equal((await call('POST', '/api/templates', { token: other.token, json: { kind: 'whatsapp', name: 'a', message: 'x' } })).status, 201);
  assert.equal((await call('POST', '/api/templates', { token: other.token, json: { kind: 'whatsapp', name: 'b', message: 'x' } })).status, 201);

  // changing the plan reaches its accounts at once on this instance
  await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: { limits: { maxTemplates: 5 } } });
  assert.equal((await tpl('two')).status, 201);

  // moving back to default lifts the plan's limits
  assert.equal((await setPlan(admin, u, 'default')).status, 200);
  assert.equal((await resolveLimits(u.id)).plan.key, 'default');
});

test('limits set for one account beat its plan, and {} clears them', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const key = await newPlan(admin, 'plan2', { maxTemplates: 1 });
  await setPlan(admin, u, key);
  assert.equal((await setLimits(admin, u, { maxTemplates: 3, bogus: 1 })).status, 400);
  assert.equal((await setLimits(admin, u, { maxTemplates: 3 })).status, 200);
  let r = await resolveLimits(u.id);
  assert.equal(r.limits.maxTemplates, 3);
  assert.deepEqual(r.overrides, { maxTemplates: 3 });
  const detail = await call('GET', `/api/admin/users/${u.id}`, { token: admin.token });
  assert.equal(detail.body.plan.key, key);
  assert.deepEqual(detail.body.overrides, { maxTemplates: 3 });
  assert.equal(detail.body.limits.maxTemplates, 3);
  const mine = await call('GET', '/api/account/plan', { token: u.token });
  assert.equal(mine.body.limits.find((l) => l.key === 'maxTemplates').source, 'account');

  assert.equal((await setLimits(admin, u, {})).status, 200);
  r = await resolveLimits(u.id);
  assert.equal(r.limits.maxTemplates, 1, 'back to the plan');
  assert.deepEqual(r.overrides, {});
  assert.equal((await setLimits(admin, { id: new mongoose.Types.ObjectId() }, { maxLists: 2 })).status, 404);
});

test('a plan with accounts cannot be deleted; an empty one can; counts are right', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const key = await newPlan(admin, 'del');
  await setPlan(admin, u, key);
  const listed = (await call('GET', '/api/admin/plans', { token: admin.token })).body.plans;
  assert.equal(listed.find((p) => p.key === key).users, 1);
  assert.ok(listed.find((p) => p.key === 'default').users >= 1);
  assert.equal((await call('GET', `/api/admin/users?search=${u.email}`, { token: admin.token })).body.users[0].plan, key);
  assert.equal((await call('DELETE', `/api/admin/plans/${key}`, { token: admin.token })).status, 409);
  await setPlan(admin, u, null);
  assert.equal((await call('DELETE', `/api/admin/plans/${key}`, { token: admin.token })).status, 200);
  assert.equal((await call('DELETE', `/api/admin/plans/${key}`, { token: admin.token })).status, 404);
});

test('a plan that vanished counts as the default plan', T, async () => {
  const u = await newUser();
  await User.updateOne({ _id: u.id }, { $set: { planKey: `${tag}-gone` } });
  forgetAllLimits();
  const r = await resolveLimits(u.id);
  assert.equal(r.plan.key, 'default');
  assert.equal(r.limits.maxLists, config.maxLists);
});

test('the daily cap and the unfinished-campaign limit follow the account', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const key = await newPlan(admin, 'camp', { waDailyCap: 2, maxActiveCampaigns: 1, waHourlyCap: 7 });
  await setPlan(admin, u, key);
  assert.deepEqual(await engineLimits('whatsapp', u.id), { dailyCap: 2, hourlyCap: 7, maxActive: 1 });
  assert.equal((await engineLimits('email', u.id)).dailyCap, config.emailDailyCap);
  assert.equal((await engineLimits('email', u.id)).hourlyCap, undefined);

  const contacts = (n, base) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, phone: `${base}${i}` }));
  await assert.rejects(whatsappEngine.createCampaign({ userId: u.id, fields: { name: 'too big', template: 'hi' }, contacts: contacts(3, '91910001') }), (e) => e.status === 429);
  await whatsappEngine.createCampaign({ userId: u.id, fields: { name: 'fits', template: 'hi' }, contacts: contacts(2, '91910002') });
  await assert.rejects(whatsappEngine.createCampaign({ userId: u.id, fields: { name: 'second', template: 'hi' }, contacts: contacts(1, '91910003') }), (e) => e.status === 429);
  assert.equal(await whatsappEngine.remainingToday(u.id), 0, 'the plan cap of 2 is fully booked');
});

test('plan and limit changes are written to the audit log', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const key = await newPlan(admin, 'audit', { maxLists: 9 });
  await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: { name: 'Audited' } });
  await setPlan(admin, u, key);
  await setLimits(admin, u, { maxTemplates: 4 });
  await call('PUT', `/api/admin/users/${u.id}/plan`, { token: admin.token, json: { plan: null } });
  await call('DELETE', `/api/admin/plans/${key}`, { token: admin.token });
  const entries = await AuditLog.find({ actorId: admin.id }).sort({ createdAt: 1 }).lean();
  const actions = entries.map((e) => e.action);
  for (const a of ['plan.created', 'plan.updated', 'user.plan_changed', 'user.limits_changed', 'plan.deleted']) assert.ok(actions.includes(a), `${a} in ${actions}`);
  const changed = entries.find((e) => e.action === 'user.limits_changed');
  assert.equal(changed.targetEmail, u.email);
  assert.match(changed.detail, /maxTemplates=4/);
});
