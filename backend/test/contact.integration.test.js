import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The public Contact form and the admin inbox, against a THROW-AWAY MongoDB database (the name must contain "test"):
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = ''; // empty, not deleted: a real .env would otherwise fill it back in
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { User, ContactMessage } = models;

const T = { skip, timeout: 30_000 };
const PASSWORD = 'correct horse battery';
const tag = `ct${Date.now().toString(36)}`;
const bypass = (_req, _res, next) => next();
let server;
let base;
const users = [];

async function call(method, path, { token, json } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

const valid = (extra = {}) => ({ name: `Asha ${tag}`, email: `asha.${tag}@example.com`, topic: 'plans', plan: 'starter', message: 'I would like the Starter plan please.', ...extra });

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: bypass, contact: bypass }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([User.deleteMany({ _id: { $in: users.map((u) => u.id) } }), ContactMessage.deleteMany({ name: new RegExp(tag) })]);
  await mongoose.disconnect();
});

async function newUser(admin = false) {
  const email = `${admin ? 'adm' : 'usr'}.${tag}.${users.length}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201);
  const user = { id: res.body.user.id, token: res.body.token };
  if (admin) await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });
  users.push(user);
  return user;
}

test('anyone can send a message, no login needed, and it is saved', T, async () => {
  const res = await call('POST', '/api/contact', { json: valid() });
  assert.equal(res.status, 201);
  const row = await ContactMessage.findOne({ email: `asha.${tag}@example.com` }).lean();
  assert.equal(row.topic, 'plans');
  assert.equal(row.plan, 'starter');
  assert.equal(row.handled, false);
});

test('bad input is refused with a clear message', T, async () => {
  assert.equal((await call('POST', '/api/contact', { json: valid({ email: 'not an email' }) })).status, 400);
  assert.equal((await call('POST', '/api/contact', { json: valid({ name: '' }) })).status, 400);
  assert.equal((await call('POST', '/api/contact', { json: valid({ message: 'hi' }) })).status, 400);
  assert.equal((await call('POST', '/api/contact', { json: valid({ message: 'x'.repeat(4001) }) })).status, 400);
  assert.equal((await call('POST', '/api/contact', { json: valid({ name: { $gt: '' } }) })).status, 400);
});

test('an unknown topic becomes "other" and a plan is only kept for the plans topic', T, async () => {
  await call('POST', '/api/contact', { json: valid({ name: `Ravi ${tag}`, topic: 'weird', plan: 'growth' }) });
  const row = await ContactMessage.findOne({ name: `Ravi ${tag}` }).lean();
  assert.equal(row.topic, 'other');
  assert.equal(row.plan, '');
});

test('the hidden trap field: bots see success and nothing is saved', T, async () => {
  const before = await ContactMessage.countDocuments();
  const res = await call('POST', '/api/contact', { json: valid({ name: `Bot ${tag}`, website: 'http://spam.example' }) });
  assert.equal(res.status, 200);
  assert.equal(await ContactMessage.countDocuments(), before);
});

test('only administrators read the messages, and they can mark them handled', T, async () => {
  const user = await newUser();
  const admin = await newUser(true);
  assert.equal((await call('GET', '/api/admin/messages')).status, 401);
  assert.equal((await call('GET', '/api/admin/messages', { token: user.token })).status, 403);

  const list = await call('GET', '/api/admin/messages', { token: admin.token });
  assert.equal(list.status, 200);
  const mine = list.body.messages.find((m) => m.email === `asha.${tag}@example.com`);
  assert.ok(mine);
  assert.equal(mine.ip, undefined, 'the sender’s address is not shown');

  const done = await call('POST', `/api/admin/messages/${mine._id}/handled`, { token: admin.token, json: { handled: true } });
  assert.equal(done.body.message.handled, true);
  const open = await call('GET', '/api/admin/messages?handled=false', { token: admin.token });
  assert.ok(!open.body.messages.some((m) => m._id === mine._id));
  assert.equal((await call('POST', '/api/admin/messages/not-an-id/handled', { token: admin.token, json: {} })).status, 404);
});
