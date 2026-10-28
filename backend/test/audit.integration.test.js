import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// The audit log against a THROW-AWAY MongoDB database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = ''; // empty, not deleted: a real .env would otherwise fill it back in
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const audit = await import('../src/audit/audit.js');
const { outbox } = await import('../src/utils/systemMail.js');
const { User, AuditLog, SmtpSettings } = models;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `aud${Date.now().toString(36)}`;
let server;
let base;
const made = [];

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
  config.allowPrivateSmtp = false;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  const mine = new RegExp(tag);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ $or: [{ actorId: { $in: ids } }, { targetId: { $in: ids } }, { actorEmail: mine }, { targetEmail: mine }, { action: /\.test$/ }] }),
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
async function newUser({ admin = false } = {}) {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  if (admin) await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });
  made.push(user);
  return user;
}
const entriesFor = (query, token) => call('GET', `/api/admin/audit?${query}`, { token });
const actionsOf = async (id, as) => (await entriesFor(`actor=${id}&limit=200`, as.token)).body.entries.map((e) => e.action);

// ---------------------------------------------------------------- writing entries

test('an entry stores who, whom, where from and what; emails are looked up from ids', T, async () => {
  const a = await newUser();
  const b = await newUser();
  assert.equal(await audit.record({ action: 'unit.test', actorId: a.id, targetId: b.id, ip: '203.0.113.9', requestId: 'req-12345678', detail: 'line one\nline two\u0007' }), true);
  const row = await AuditLog.findOne({ actorId: a.id, action: 'unit.test' }).lean();
  assert.equal(row.actorEmail, a.email);
  assert.equal(row.targetEmail, b.email);
  assert.equal(row.ip, '203.0.113.9');
  assert.equal(row.requestId, 'req-12345678');
  assert.equal(row.detail, 'line one line two', 'control characters are removed');
  assert.ok(row.at instanceof Date);
  assert.equal(row.updatedAt, undefined);
});

test('a problem with the audit log never throws, and is not stored half-way', T, async () => {
  const before = await AuditLog.countDocuments({});
  assert.equal(await audit.record({ action: 'Bad Action!' }), false);
  assert.equal(await audit.record({ action: 'x'.repeat(41) }), false);
  assert.equal(await audit.record({}), false);
  assert.equal(await audit.record({ action: 'unit.test', actorId: 'not-an-id' }), false);
  assert.equal(await AuditLog.countDocuments({}), before);
  assert.equal(await audit.record({ action: 'unit.test', actorId: new mongoose.Types.ObjectId(), detail: 'y'.repeat(900) }), true, 'an unknown account still gets an entry');
  const long = await AuditLog.findOne({ action: 'unit.test', actorEmail: '' }).sort({ _id: -1 }).lean();
  assert.equal(long.detail.length, 500);
});

// ---------------------------------------------------------------- admin actions

test('every admin action is recorded and can be read back, newest first', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  const act = (path, json = {}) => call('POST', `/api/admin/users/${u.id}/${path}`, { token: admin.token, json });
  assert.equal((await act('suspend', { reason: 'sent spam' })).status, 200);
  assert.equal((await act('unsuspend')).status, 200);
  assert.equal((await act('force-logout')).status, 200);
  assert.equal((await act('verify-email')).status, 200);

  const res = await entriesFor(`target=${u.id}`, admin.token);
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.entries.map((e) => e.action), ['user.email_verified', 'user.signed_out', 'user.unsuspended', 'user.suspended']);
  const suspended = res.body.entries[3];
  assert.deepEqual(Object.keys(suspended).sort(), ['action', 'actor', 'at', 'detail', 'id', 'ip', 'requestId', 'target']);
  assert.equal(suspended.actor.email, admin.email);
  assert.equal(String(suspended.actor.id), String(admin.id));
  assert.equal(suspended.target.email, u.email);
  assert.match(suspended.detail, /sent spam \| paused 0 campaign\(s\)/);
  assert.ok(suspended.ip, 'the address the request came from');
  assert.ok(suspended.requestId, 'the id to find the request in the log');
  assert.ok(res.body.entries.every((e) => e.actor.email === admin.email && e.target.email === u.email));

  assert.equal((await call('POST', `/api/admin/users/${admin.id}/suspend`, { token: admin.token, json: {} })).status, 400);
  assert.deepEqual(await actionsOf(admin.id, admin), ['user.email_verified', 'user.signed_out', 'user.unsuspended', 'user.suspended'], 'refused requests leave no entry');
});

test('filters: actor, target, email, action, dates, and pages', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  for (const path of ['suspend', 'unsuspend', 'force-logout']) await call('POST', `/api/admin/users/${u.id}/${path}`, { token: admin.token, json: {} });
  const list = (query) => entriesFor(query, admin.token);

  assert.equal((await list(`actor=${admin.id}`)).body.total, 3);
  assert.equal((await list(`actor=${u.id}`)).body.total, 0);
  assert.equal((await list(`email=${encodeURIComponent(u.email.toUpperCase())}`)).body.total, 3, 'the address of either side, any case');
  assert.equal((await list(`email=${encodeURIComponent(admin.email)}`)).body.total, 3);
  assert.deepEqual((await list(`target=${u.id}&action=user.suspended`)).body.entries.map((e) => e.action), ['user.suspended']);
  assert.equal((await list(`target=${u.id}&from=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).body.total, 3);
  assert.equal((await list(`target=${u.id}&from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).body.total, 0);
  assert.equal((await list(`target=${u.id}&to=${encodeURIComponent(new Date(Date.now() - 60_000).toISOString())}`)).body.total, 0);
  assert.equal((await list(`target=${u.id}&from=2020-01-01&to=2099-01-01`)).body.total, 3);

  const page = await list(`target=${u.id}&limit=2&page=2`);
  assert.deepEqual(page.body.entries.map((e) => e.action), ['user.suspended']);
  assert.deepEqual({ page: page.body.page, pages: page.body.pages, limit: page.body.limit, total: page.body.total }, { page: 2, pages: 2, limit: 2, total: 3 });
  assert.equal((await list('limit=5000')).body.limit, 200);

  for (const bad of ['actor=nope', 'target=123', 'from=yesterday', 'to=not-a-date', 'action=Bad%20Action', 'action=a&action=b']) {
    assert.equal((await list(bad)).status, 400, bad);
  }
});

test('an entry with no actor is shown as coming from the command line', T, async () => {
  const u = await newUser();
  const admin = await newUser({ admin: true });
  await audit.record({ action: 'role.granted', targetId: u.id, detail: 'from the command line (npm run make-admin)' });
  const res = await entriesFor(`target=${u.id}&action=role.granted`, admin.token);
  assert.equal(res.body.entries.length, 1);
  assert.equal(res.body.entries[0].actor, null);
  assert.equal(res.body.entries[0].target.email, u.email);
});

test('ordinary accounts cannot read it, and trying is recorded; the log cannot be changed through the API', T, async () => {
  const u = await newUser();
  const admin = await newUser({ admin: true });
  assert.equal((await call('GET', '/api/admin/audit')).status, 401);
  assert.equal((await call('GET', '/api/admin/audit?limit=1', { token: u.token })).status, 403);
  const denied = (await entriesFor(`actor=${u.id}`, admin.token)).body.entries;
  assert.equal(denied.length, 1);
  assert.equal(denied[0].action, 'admin.denied');
  assert.equal(denied[0].detail, 'GET /api/admin/audit');
  assert.equal((await AuditLog.countDocuments({ actorId: null, action: 'admin.denied' })), 0, 'a missing login is not an entry');

  const id = String(denied[0].id);
  for (const [method, path] of [['DELETE', '/api/admin/audit'], ['DELETE', `/api/admin/audit/${id}`], ['PUT', `/api/admin/audit/${id}`], ['POST', '/api/admin/audit'], ['PATCH', `/api/admin/audit/${id}`]]) {
    assert.equal((await call(method, path, { token: admin.token, json: {} })).status, 404, `${method} ${path}`);
  }
  assert.ok(await AuditLog.exists({ _id: id }));
});

// ---------------------------------------------------------------- account events

test('password and sign-out events are recorded, without any password', T, async () => {
  const u = await newUser();
  const admin = await newUser({ admin: true });
  const changed = await call('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: PASSWORD, newPassword: 'another long passphrase' } });
  assert.equal(changed.status, 200, say(changed));
  assert.equal((await call('POST', '/api/auth/logout-all', { token: changed.body.token })).status, 200);
  const res = await entriesFor(`actor=${u.id}`, admin.token);
  assert.deepEqual(res.body.entries.map((e) => e.action), ['logout.all', 'password.changed']);
  assert.ok(res.body.entries.every((e) => e.target === null && e.actor.email === u.email && e.ip));
  assert.ok(!JSON.stringify(res.body).match(/correct horse|another long passphrase/), 'no password anywhere');
});

test('a reset through the emailed link is recorded', T, async () => {
  const u = await newUser();
  const admin = await newUser({ admin: true });
  outbox.length = 0;
  assert.equal((await call('POST', '/api/auth/forgot-password', { json: { email: u.email } })).status, 200);
  let token;
  for (let i = 0; i < 50 && !token; i++) {
    token = outbox.find((m) => m.to === u.email && /reset/i.test(m.subject))?.text.match(/token=([\w-]+)/)?.[1];
    if (!token) await sleep(100);
  }
  assert.ok(token, 'the reset email was produced');
  assert.equal((await call('POST', '/api/auth/reset-password', { json: { token, password: 'brand new passphrase' } })).status, 200);
  const entry = (await entriesFor(`actor=${u.id}&action=password.reset`, admin.token)).body.entries[0];
  assert.equal(entry.detail, 'through the emailed link');
  assert.ok(!JSON.stringify(entry).includes(token));
});

test('a locked account and a blocked suspended login are recorded', T, async () => {
  const admin = await newUser({ admin: true });
  const u = await newUser();
  await User.updateOne({ _id: u.id }, { $set: { failedLogins: 7 } });
  assert.equal((await call('POST', '/api/auth/login', { json: { email: u.email, password: 'wrong password here' } })).status, 429, 'the wrong password that locks the account says so');
  assert.deepEqual((await entriesFor(`actor=${u.id}`, admin.token)).body.entries.map((e) => [e.action, e.detail]), [['login.locked', 'after 8 wrong passwords']]);

  const s = await newUser();
  await call('POST', `/api/admin/users/${s.id}/suspend`, { token: admin.token, json: {} });
  assert.equal((await call('POST', '/api/auth/login', { json: { email: s.email, password: PASSWORD } })).status, 403);
  const blocked = (await entriesFor(`actor=${s.id}`, admin.token)).body.entries;
  assert.deepEqual(blocked.map((e) => e.action), ['login.blocked']);
  assert.equal((await call('POST', '/api/auth/login', { json: { email: s.email, password: 'a wrong one' } })).status, 401);
  assert.equal((await entriesFor(`actor=${s.id}`, admin.token)).body.total, 1, 'a wrong password is not an entry for the suspended account');
});

test('webhook address and SMTP changes are recorded, and the SMTP password never is', T, async () => {
  const u = await newUser();
  const admin = await newUser({ admin: true });
  assert.equal((await call('POST', '/api/email/feedback/key', { token: u.token })).status, 201);
  assert.equal((await call('DELETE', '/api/email/feedback/key', { token: u.token })).status, 200);

  config.allowPrivateSmtp = true;
  const smtp = { host: 'localhost', port: 2525, fromEmail: 'me@example.com', user: '', pass: 'supersecretpw' };
  assert.equal((await call('PUT', '/api/email/settings', { token: u.token, json: smtp })).status, 200);
  assert.equal((await call('PUT', '/api/email/settings', { token: u.token, json: { ...smtp, pass: undefined } })).status, 200);
  assert.equal((await call('DELETE', '/api/email/settings', { token: u.token })).status, 200);
  config.allowPrivateSmtp = false;

  const res = await entriesFor(`actor=${u.id}`, admin.token);
  assert.deepEqual(res.body.entries.map((e) => e.action), ['smtp.removed', 'smtp.saved', 'smtp.saved', 'webhook_key.removed', 'webhook_key.created']);
  assert.equal(res.body.entries[2].detail, 'localhost:2525, from me@example.com, password changed');
  assert.equal(res.body.entries[1].detail, 'localhost:2525, from me@example.com, password unchanged');
  assert.ok(!JSON.stringify(res.body).includes('supersecretpw'));
});

// ---------------------------------------------------------------- keeping it tidy

test('old entries are deleted after the retention period; 0 keeps everything', T, async () => {
  const day = 24 * 60 * 60_000;
  await AuditLog.collection.insertMany([
    { action: 'old.test', at: new Date(Date.now() - 400 * day), detail: '' },
    { action: 'old.test', at: new Date(Date.now() - 366 * day), detail: '' },
    { action: 'recent.test', at: new Date(Date.now() - 364 * day), detail: '' },
    { action: 'recent.test', at: new Date(), detail: '' },
  ]);
  assert.equal(await audit.purgeAudit({ days: 0 }), 0);
  assert.equal(await AuditLog.countDocuments({ action: 'old.test' }), 2, 'nothing is removed when retention is 0');
  assert.ok((await audit.purgeAudit({ days: 365 })) >= 2);
  assert.equal(await AuditLog.countDocuments({ action: 'old.test' }), 0);
  assert.equal(await AuditLog.countDocuments({ action: 'recent.test' }), 2);
  assert.equal(config.auditRetentionDays, 365, 'a year by default');
});
