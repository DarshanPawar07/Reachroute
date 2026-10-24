import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The admin area against a THROW-AWAY MongoDB database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
// Nothing is sent: the dispatchers are never started.
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
const accounts = await import('../src/admin/accounts.js');
const { User, ContactList, Template, Campaign, Recipient, SmtpSettings, SessionLease, OptOut } = models;

config.maxActiveCampaigns = 20;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
let server;
let base;
const made = [];
const tag = `adm${Date.now().toString(36)}`;

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
    ContactList.deleteMany({ userId: { $in: ids } }),
    Template.deleteMany({ userId: { $in: ids } }),
    Campaign.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    OptOut.deleteMany({ userId: { $in: ids } }),
    SessionLease.deleteMany({ _id: { $in: ids.map(String) } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (res) => JSON.stringify(res.body);

let counter = 0;
async function newUser({ admin = false, name } = {}) {
  const email = `${name || `u${counter++}`}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  if (admin) await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });
  made.push(user);
  return user;
}
const login = (email, password = PASSWORD) => call('POST', '/api/auth/login', { json: { email, password } });

// ---------------------------------------------------------------- access

test('only administrators get in, and nobody can make themselves one', T, async () => {
  const user = await newUser();
  const admin = await newUser({ admin: true });
  for (const path of ['/api/admin/overview', '/api/admin/users', `/api/admin/users/${user.id}`]) {
    assert.equal((await call('GET', path)).status, 401, `${path} needs a login`);
    assert.equal((await call('GET', path, { token: user.token })).status, 403, `${path} is not for ordinary accounts`);
    assert.equal((await call('GET', path, { token: admin.token })).status, 200, `${path} works for an admin`);
  }
  assert.equal((await call('POST', `/api/admin/users/${user.id}/suspend`, { token: user.token, json: {} })).status, 403);

  // asking for the role while registering, or any other way, does nothing
  const sneaky = await call('POST', '/api/auth/register', { json: { email: `sneaky.${tag}@example.com`, password: PASSWORD, role: 'admin' } });
  made.push({ id: new mongoose.Types.ObjectId(sneaky.body.user.id) });
  assert.equal((await User.findById(sneaky.body.user.id).lean()).role, undefined);
  assert.equal((await call('GET', '/api/admin/overview', { token: sneaky.body.token })).status, 403);
});

test('the admin role comes from the command-line helper, and works at once', T, async () => {
  const user = await newUser();
  assert.equal((await call('GET', '/api/admin/overview', { token: user.token })).status, 403);
  assert.deepEqual(await accounts.setRole(user.email.toUpperCase(), 'admin'), { id: user.id, email: user.email, role: 'admin' });
  assert.equal((await call('GET', '/api/admin/overview', { token: user.token })).status, 200, 'no new login needed');
  assert.equal((await call('GET', '/api/auth/me', { token: user.token })).body.user.role, 'admin');
  await accounts.setRole(user.email, 'user');
  assert.equal((await call('GET', '/api/admin/overview', { token: user.token })).status, 403, 'and it ends at once');
  assert.equal((await call('GET', '/api/auth/me', { token: user.token })).body.user.role, 'user');
  assert.equal(await accounts.setRole(`nobody.${tag}@example.com`, 'admin'), null);
  await assert.rejects(accounts.setRole(user.email, 'superuser'), /Role must be admin or user/);
});

// ---------------------------------------------------------------- overview and list

test('overview: platform numbers', T, async () => {
  const admin = await newUser({ admin: true });
  await newUser();
  const res = await call('GET', '/api/admin/overview', { token: admin.token });
  assert.equal(res.status, 200, say(res));
  const { users, sentLast24h, whatsappLinked, queue } = res.body;
  assert.ok(users.total >= 2 && users.newLast24h >= 2 && users.newLast7d >= users.newLast24h);
  assert.ok(users.admins >= 1 && users.unverified >= 2);
  for (const key of ['activeLast7d', 'suspended']) assert.equal(typeof users[key], 'number');
  assert.equal(typeof sentLast24h.whatsapp, 'number');
  assert.equal(typeof sentLast24h.email, 'number');
  assert.equal(typeof whatsappLinked, 'number');
  assert.deepEqual(Object.keys(queue).sort(), ['email', 'whatsapp']);
  assert.equal(typeof queue.whatsapp.running, 'number');
});

test('user list: search, filters, order and pages', T, async () => {
  const admin = await newUser({ admin: true });
  const z = `zed${Math.random().toString(36).slice(2, 8)}`; // unique to this run, so leftovers never match
  const a = await newUser({ name: `${z}.one` });
  const b = await newUser({ name: `${z}.two` });
  const c = await newUser({ name: `${z}.three` });
  await accounts.suspendUser(c.id, 'spam');
  const list = (query) => call('GET', `/api/admin/users?${query}`, { token: admin.token });

  const found = await list(`search=${z.toUpperCase()}.&sort=oldest`);
  assert.equal(found.status, 200, say(found));
  assert.deepEqual(found.body.users.map((u) => u.email), [a.email, b.email, c.email], 'case does not matter, and "oldest" is oldest first');
  assert.equal(found.body.total, 3);
  assert.equal((await list(`search=${z}.one`)).body.users.length, 1);
  assert.equal((await list(`search=${encodeURIComponent(`${z}.(`)}`)).status, 200, 'what is typed is never a pattern');
  assert.equal((await list(`search=${encodeURIComponent('.*')}`)).body.total, 0, 'a pattern does not match everything');
  assert.deepEqual((await list(`search=${z}.&status=suspended`)).body.users.map((u) => u.email), [c.email]);
  assert.equal((await list(`search=${z}.&status=active`)).body.total, 2);
  assert.ok((await list(`status=admin`)).body.users.every((u) => u.role === 'admin'));
  assert.ok((await list(`search=${z}.&status=unverified`)).body.total === 3);

  const page2 = await list(`search=${z}.&sort=oldest&limit=2&page=2`);
  assert.deepEqual(page2.body.users.map((u) => u.email), [c.email]);
  assert.deepEqual({ page: page2.body.page, pages: page2.body.pages, limit: page2.body.limit, total: page2.body.total }, { page: 2, pages: 2, limit: 2, total: 3 });
  assert.equal((await list('limit=5000')).body.limit, 100, 'a page is never larger than 100');
  assert.equal((await list('page=-4&limit=abc')).body.page, 1);

  const row = found.body.users[2];
  assert.deepEqual(Object.keys(row).sort(), ['createdAt', 'email', 'emailVerified', 'id', 'lastLoginAt', 'plan', 'role', 'suspendedAt', 'suspendedReason']);
  assert.equal(row.suspendedReason, 'spam');
  assert.ok(!JSON.stringify(found.body).match(/passwordHash|tokenVersion|webhookKey/));

  assert.equal((await list('status=banned')).status, 400);
  assert.equal((await list('sort=random')).status, 400);
  assert.equal((await list(`search=${'x'.repeat(101)}`)).status, 400);
  assert.equal((await list('search=a&search=b')).status, 400);
});

// ---------------------------------------------------------------- one account

test('account detail: usage numbers and names, never secrets or contents', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  await ContactList.collection.insertMany([{ userId: u.id, name: 'L1', kind: 'email' }, { userId: u.id, name: 'L2', kind: 'whatsapp' }]);
  await Template.collection.insertOne({ userId: u.id, kind: 'whatsapp', name: 'T1', message: 'SECRET TEXT {{name}}' });
  await SmtpSettings.collection.insertOne({ userId: u.id, host: 'smtp.example.com', port: 587, user: 'me', passEncrypted: 'ENCRYPTEDSECRET', fromEmail: 'me@example.com' });
  await OptOut.collection.insertMany([{ userId: u.id, phone: '919100000401' }, { userId: u.id, phone: '919100000402' }]);
  await SessionLease.collection.insertOne({ _id: String(u.id), owner: 'x', status: 'connected', expiresAt: new Date(Date.now() + 60_000) });
  const camp = await Campaign.collection.insertOne({ userId: u.id, name: 'Diwali offer', status: 'running', template: 'SECRET TEXT', total: 3, sentCount: 2, failedCount: 0, createdAt: new Date(), updatedAt: new Date() });
  await Recipient.collection.insertMany([
    { campaignId: camp.insertedId, userId: u.id, phone: '919100000411', name: 'Private Person', status: 'sent', sentAt: new Date(Date.now() - 3600_000), createdAt: new Date(), updatedAt: new Date() },
    { campaignId: camp.insertedId, userId: u.id, phone: '919100000412', name: '', status: 'sent', sentAt: new Date(Date.now() - 3 * 86_400_000), createdAt: new Date(), updatedAt: new Date() },
    { campaignId: camp.insertedId, userId: u.id, phone: '919100000413', name: '', status: 'pending', createdAt: new Date(), updatedAt: new Date() },
  ]);

  const res = await call('GET', `/api/admin/users/${u.id}`, { token: admin.token });
  assert.equal(res.status, 200, say(res));
  const { user, usage } = res.body;
  assert.equal(user.email, u.email);
  assert.equal(user.role, 'user');
  assert.equal(usage.lists, 2);
  assert.equal(usage.templates, 1);
  assert.equal(usage.whatsapp.session, 'connected');
  assert.equal(usage.whatsapp.stopped, 2);
  assert.deepEqual(usage.whatsapp.campaigns, { total: 1, running: 1, paused: 0 });
  assert.equal(usage.whatsapp.sentLast24h, 1);
  assert.equal(usage.whatsapp.sentLast7d, 2);
  assert.equal(usage.whatsapp.recentCampaigns[0].name, 'Diwali offer');
  assert.deepEqual(usage.email.ownSmtp, { host: 'smtp.example.com', fromEmail: 'me@example.com' });
  assert.deepEqual(usage.email.campaigns, { total: 0, running: 0, paused: 0 });
  const text = JSON.stringify(res.body);
  for (const secret of ['SECRET TEXT', 'ENCRYPTEDSECRET', 'Private Person', '919100000411', 'passwordHash', 'tokenVersion']) assert.ok(!text.includes(secret), `${secret} must not be shown`);

  const fresh = await newUser();
  const empty = (await call('GET', `/api/admin/users/${fresh.id}`, { token: admin.token })).body.usage;
  assert.equal(empty.whatsapp.session, 'offline');
  assert.equal(empty.email.ownSmtp, null);

  assert.equal((await call('GET', `/api/admin/users/${new mongoose.Types.ObjectId()}`, { token: admin.token })).status, 404);
  assert.equal((await call('GET', '/api/admin/users/not-an-id', { token: admin.token })).status, 404);
});

// ---------------------------------------------------------------- suspending

test('suspending: signed out, cannot log in, campaigns paused, nothing deleted; unsuspending lets them back in', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const campaign = await whatsappEngine.createCampaign({ userId: u.id, fields: { name: 'running one', template: 'hi' }, contacts: [{ name: 'A', phone: '919100000421' }, { name: 'B', phone: '919100000422' }] });
  assert.equal((await Campaign.findById(campaign._id)).status, 'running');
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).status, 200);

  const res = await call('POST', `/api/admin/users/${u.id}/suspend`, { token: admin.token, json: { reason: '  sent spam  ' } });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body, { ok: true, pausedCampaigns: 1 });

  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).status, 401, 'the old login stops working');
  const blocked = await login(u.email);
  assert.equal(blocked.status, 403);
  assert.match(blocked.body.error, /suspended/);
  assert.equal((await login(u.email, 'wrong password here')).status, 401, 'a wrong password reveals nothing');
  assert.equal((await login(`never.${tag}@example.com`)).status, 401);

  const paused = await Campaign.findById(campaign._id).lean();
  assert.equal(paused.status, 'paused');
  assert.match(paused.pauseReason, /suspended/);
  assert.equal(await Recipient.countDocuments({ campaignId: campaign._id }), 2, 'nothing was deleted');
  assert.equal(await Recipient.countDocuments({ campaignId: campaign._id, scheduledFor: null }), 2, 'nothing is waiting to be sent');

  const detail = (await call('GET', `/api/admin/users/${u.id}`, { token: admin.token })).body.user;
  assert.equal(detail.suspendedReason, 'sent spam');
  assert.ok(detail.suspendedAt);
  assert.equal((await call('POST', `/api/admin/users/${u.id}/suspend`, { token: admin.token, json: {} })).status, 409, 'already suspended');

  assert.equal((await call('POST', `/api/admin/users/${u.id}/unsuspend`, { token: admin.token })).status, 200);
  const back = await login(u.email);
  assert.equal(back.status, 200, say(back));
  assert.equal((await Campaign.findById(campaign._id).lean()).status, 'paused', 'campaigns wait for their owner to resume them');
  assert.equal((await call('POST', `/api/admin/users/${u.id}/unsuspend`, { token: admin.token })).status, 409, 'not suspended');
  assert.ok((await User.findById(u.id).lean()).lastLoginAt, 'the login was noted');
});

test('suspending: not yourself, not an admin, not a stranger, and the reason has a limit', T, async () => {
  const admin = await newUser({ admin: true });
  const other = await newUser({ admin: true });
  const u = await newUser();
  const suspend = (id, json = {}) => call('POST', `/api/admin/users/${id}/suspend`, { token: admin.token, json });
  assert.equal((await suspend(admin.id)).status, 400);
  const adminTarget = await suspend(other.id);
  assert.equal(adminTarget.status, 403);
  assert.match(adminTarget.body.error, /make-admin/);
  assert.equal((await suspend(new mongoose.Types.ObjectId())).status, 404);
  assert.equal((await suspend('nope')).status, 404);
  assert.equal((await suspend(u.id, { reason: 'x'.repeat(301) })).status, 400);
  assert.equal((await suspend(u.id, { reason: { a: 1 } })).status, 400);
  assert.equal((await User.findById(u.id).lean()).suspendedAt, null, 'refused requests change nothing');
  assert.equal((await call('POST', `/api/admin/users/${new mongoose.Types.ObjectId()}/unsuspend`, { token: admin.token })).status, 404);
});

test('a suspended administrator is locked out of the admin area too', T, async () => {
  const admin = await newUser({ admin: true });
  await User.updateOne({ _id: admin.id }, { $set: { suspendedAt: new Date() } });
  assert.equal((await call('GET', '/api/admin/overview', { token: admin.token })).status, 403);
});

test('force sign-out and manual email confirmation', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).body.user.emailVerified, false);
  assert.equal((await call('POST', `/api/admin/users/${u.id}/verify-email`, { token: admin.token })).status, 200);
  assert.equal((await call('POST', `/api/admin/users/${u.id}/verify-email`, { token: admin.token })).status, 200, 'safe to repeat');
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).body.user.emailVerified, true);

  assert.equal((await call('POST', `/api/admin/users/${u.id}/force-logout`, { token: admin.token })).status, 200);
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).status, 401);
  assert.equal((await login(u.email)).status, 200, 'they can simply log in again');
  assert.equal((await call('POST', `/api/admin/users/${new mongoose.Types.ObjectId()}/force-logout`, { token: admin.token })).status, 404);
  assert.equal((await call('POST', `/api/admin/users/${new mongoose.Types.ObjectId()}/verify-email`, { token: admin.token })).status, 404);
});
