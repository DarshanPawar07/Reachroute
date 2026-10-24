import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A restricted WhatsApp number: detection, pause, the switch to a different number and the resume, against a THROW-AWAY
// MongoDB database (name must contain "test"). No real WhatsApp connection is made.
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
const R = await import('../src/whatsapp/restriction.js');
const { User, Campaign, Recipient, WaRestriction, Notification, AuditLog, SessionLease } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.maxActiveCampaigns = 20;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `res${Date.now().toString(36)}`;
const made = [];
let server;
let base;
let counter = 0;
let phoneCounter = 0;

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
    Campaign.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
    WaRestriction.deleteMany({ userId: { $in: ids } }),
    Notification.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ $or: [{ actorId: { $in: ids } }, { targetId: { $in: ids } }] }),
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

async function newUser() {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  made.push(user);
  return user;
}

const contacts = (n) => Array.from({ length: n }, (_, i) => ({ name: `C${i}`, phone: `9193${String(++phoneCounter).padStart(8, '0')}` }));
const startCampaign = (u, n = 4, name = 'big send') => whatsappEngine.createCampaign({ userId: u.id, fields: { name, template: 'hi' }, contacts: contacts(n) });
const OLD = '919100000111';
const NEW = '919100000222';
const refused = (u, phone = OLD) => R.handleRestriction(u.id, { phone, source: 'send', code: 403, reason: 'forbidden' }, { engine: whatsappEngine });

test('a refused number pauses every running campaign and tells the owner once', T, async () => {
  const u = await newUser();
  const a = await startCampaign(u, 3, 'first');
  const b = await startCampaign(u, 2, 'second');
  // some of the first campaign was already sent before the number was refused
  const some = await Recipient.find({ campaignId: a._id }).sort({ _id: 1 }).limit(1);
  await Recipient.updateOne({ _id: some[0]._id }, { $set: { status: 'sent', sentAt: new Date() } });
  await Campaign.updateOne({ _id: a._id }, { $set: { sentCount: 1 } });

  const first = await refused(u);
  assert.equal(first.created, true);
  assert.equal(first.paused, 2);
  for (const id of [a._id, b._id]) {
    const c = await Campaign.findById(id);
    assert.equal(c.status, 'paused');
    assert.ok(c.pauseReason.startsWith(R.RESTRICTED_PREFIX));
    assert.match(c.pauseReason, /\+919100000111/);
  }
  assert.equal(await Recipient.countDocuments({ campaignId: a._id, status: 'pending' }), 2, 'nobody was marked failed');
  assert.equal(await Recipient.countDocuments({ campaignId: a._id, status: 'failed' }), 0);

  const doc = await WaRestriction.findOne({ userId: u.id, status: 'active' });
  assert.equal(doc.phone, OLD);
  const hours = (doc.until - doc.detectedAt) / 3_600_000;
  assert.equal(hours, config.waRestrictionHours);
  assert.equal(await Notification.countDocuments({ userId: u.id, type: 'whatsapp_restricted' }), 1);
  assert.equal(await AuditLog.countDocuments({ targetId: u.id, action: 'whatsapp.restricted' }), 1);

  const again = await refused(u);
  assert.equal(again.created, false, 'a second report changes nothing');
  assert.equal(await WaRestriction.countDocuments({ userId: u.id, status: 'active' }), 1);
  assert.equal(await Notification.countDocuments({ userId: u.id, type: 'whatsapp_restricted' }), 1);
});

test('the app can see the restriction, what is waiting, and what to do next', T, async () => {
  const u = await newUser();
  assert.deepEqual((await call('GET', '/api/whatsapp/restriction', { token: u.token })).body, { restricted: false, state: 'none', campaigns: [], next: 'none' });
  await startCampaign(u, 5, 'waiting one');
  await refused(u);
  const res = await call('GET', '/api/whatsapp/restriction', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.restricted, true);
  assert.equal(res.body.state, 'active');
  assert.equal(res.body.phone, OLD);
  assert.equal(res.body.next, 'link_number', 'nothing is linked here');
  assert.ok(res.body.msLeft > 0 && res.body.msLeft <= config.waRestrictionHours * 3_600_000);
  assert.deepEqual(res.body.campaigns.map((c) => [c.name, c.total, c.sent, c.remaining]), [['waiting one', 5, 0, 5]]);
  assert.equal((await call('GET', '/api/whatsapp/restriction')).status, 401);
});

test('a restricted number cannot start or resume campaigns; the error says why', T, async () => {
  const u = await newUser();
  const c = await startCampaign(u, 2);
  await refused(u);
  const fd = new FormData();
  fd.append('name', 'blocked');
  fd.append('message', 'Hello');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob(['name,phone\nAsha,919100000901\n'], { type: 'text/csv' }), 'c.csv');
  const create = await call('POST', '/api/whatsapp/campaigns', { token: u.token, form: fd });
  assert.equal(create.status, 409, say(create));
  assert.equal(create.body.code, 'whatsapp_restricted');
  assert.match(create.body.error, /different WhatsApp number/);
  const resume = await call('POST', `/api/whatsapp/campaigns/${c._id}/resume`, { token: u.token });
  assert.equal(resume.status, 409, say(resume));
  assert.equal(resume.body.code, 'whatsapp_restricted');
  assert.equal((await Campaign.findById(c._id)).status, 'paused', 'still paused');
  // linking the same number again does not help while the time is not up
  await assert.rejects(R.assertCanSend(u.id, OLD), (e) => e.code === 'whatsapp_restricted' && e.status === 409);
  await assert.rejects(R.resumeRestricted(u.id, { engine: whatsappEngine, phone: OLD }), (e) => e.code === 'whatsapp_restricted');
  await assert.rejects(R.resumeRestricted(u.id, { engine: whatsappEngine, phone: null }), (e) => e.status === 409 && /Link a WhatsApp number/.test(e.message));
});

test('linking a different number lets the campaign carry on from the first unsent contact', T, async () => {
  const u = await newUser();
  const c = await startCampaign(u, 4, 'resume me');
  const [first, second] = await Recipient.find({ campaignId: c._id }).sort({ _id: 1 }).limit(2);
  for (const r of [first, second]) await Recipient.updateOne({ _id: r._id }, { $set: { status: 'sent', sentAt: new Date() } });
  await Campaign.updateOne({ _id: c._id }, { $set: { sentCount: 2 } });
  await refused(u);

  const state = await R.getRestriction(u.id, { phone: NEW });
  assert.equal(state.next, 'resume', 'a different number is linked');
  assert.equal((await R.getRestriction(u.id, { phone: OLD })).next, 'wait', 'the same number must wait');

  const out = await R.resumeRestricted(u.id, { engine: whatsappEngine, phone: NEW });
  assert.deepEqual(out.failed, []);
  assert.deepEqual(out.resumed.map((x) => [x.name, x.remaining]), [['resume me', 2]]);
  const after = await Campaign.findById(c._id);
  assert.equal(after.status, 'running');
  assert.equal(after.pauseReason, null);
  assert.equal(after.sentCount, 2, 'what was sent stays sent');
  assert.equal(await Recipient.countDocuments({ campaignId: c._id, status: 'sent' }), 2);
  const pending = await Recipient.find({ campaignId: c._id, status: 'pending' }).lean();
  assert.equal(pending.length, 2);
  assert.ok(pending.every((r) => r.scheduledFor), 'the two that were not sent are scheduled again');

  const resolved = await WaRestriction.findOne({ userId: u.id }).lean();
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.resolvedBy, 'switched');
  assert.equal(await WaRestriction.countDocuments({ userId: u.id, status: 'active' }), 0);
  assert.equal((await R.getRestriction(u.id, { phone: NEW })).restricted, false);
  await R.assertCanSend(u.id, NEW); // allowed now
});

test('when the time is up, the same number may carry on', T, async () => {
  const u = await newUser();
  const c = await startCampaign(u, 2);
  await refused(u);
  await WaRestriction.updateOne({ userId: u.id, status: 'active' }, { $set: { until: new Date(Date.now() - 1000) } });
  const state = await R.getRestriction(u.id, { phone: OLD });
  assert.equal(state.state, 'expired');
  assert.equal(state.next, 'resume');
  const out = await R.resumeRestricted(u.id, { engine: whatsappEngine, phone: OLD });
  assert.equal(out.resumed.length, 1);
  assert.equal((await Campaign.findById(c._id)).status, 'running');
  assert.equal((await WaRestriction.findOne({ userId: u.id }).lean()).resolvedBy, 'expired');
});

test('when the old number is not known, linking another after "switch number" counts as new', T, async () => {
  const u = await newUser();
  await R.handleRestriction(u.id, { phone: '', source: 'connection', code: 403, reason: '' }, { engine: whatsappEngine });
  await assert.rejects(R.assertCanSend(u.id, NEW), (e) => e.code === 'whatsapp_restricted', 'cannot tell yet whether it is a different number');
  const doc = await R.markSwitching(u.id);
  assert.ok(doc.switchRequestedAt);
  await R.assertCanSend(u.id, NEW);
  assert.equal((await WaRestriction.findOne({ userId: u.id }).lean()).resolvedBy, 'switched');
});

test('switching needs a restriction; restricted accounts are not reconnected by themselves until they switch', T, async () => {
  const u = await newUser();
  const none = await call('POST', '/api/whatsapp/switch-number', { token: u.token });
  assert.equal(none.status, 409, say(none));
  await assert.rejects(R.markSwitching(u.id), (e) => e.status === 409);
  assert.equal((await call('POST', '/api/whatsapp/restriction/resume', { token: u.token })).status, 409, 'nothing is linked');

  await refused(u);
  assert.ok((await R.restrictedUserIds()).map(String).includes(String(u.id)));
  await R.markSwitching(u.id);
  assert.ok(!(await R.restrictedUserIds()).map(String).includes(String(u.id)), 'once they start linking another number it may connect');
  assert.equal(await AuditLog.countDocuments({ actorId: u.id, action: 'whatsapp.number_switch' }), 1);
});

test('an ordinary account is not affected', T, async () => {
  const u = await newUser();
  await R.assertCanSend(u.id, null);
  await R.assertCanSend(u.id, NEW);
  assert.ok(!(await R.restrictedUserIds()).map(String).includes(String(u.id)));
});
