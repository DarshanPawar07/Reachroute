import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// WhatsApp delivery tracking (sent / delivered / read), the "messages are not arriving" check and the new-number limit.
// Runs against a THROW-AWAY MongoDB database (the name must contain "test"). Nothing is sent: delivery is a stub.
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
const { createEngine } = await import('../src/engine/sendEngine.js');
const { whatsappLimits, forgetWarmup } = await import('../src/engine/channels.js');
const { evaluateHealth, checkDelivery } = await import('../src/whatsapp/health.js');
const { recordDelivery } = await import('../src/whatsapp/delivery.js');
const { Campaign, Recipient, Notification, User } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;

const T = { skip, timeout: 60_000 };
const PASSWORD = 'correct horse battery';
const tag = `dlv${Date.now().toString(36)}`;
const made = [];
const ids = [];
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
  config.waHealthAutopause = true;
  config.waWarmupDays = 0;
  const all = [...ids, ...made.map((u) => u.id)];
  await Promise.all([
    User.deleteMany({ _id: { $in: all } }),
    Campaign.deleteMany({ userId: { $in: all } }),
    Recipient.deleteMany({ userId: { $in: all } }),
    Notification.deleteMany({ userId: { $in: all } }),
  ]);
  await mongoose.disconnect();
});

const newUserId = () => {
  const id = new mongoose.Types.ObjectId();
  ids.push(id);
  return id;
};
const MIN = 60_000;
const ago = (minutes) => new Date(Date.now() - minutes * MIN);
const update = (id, status) => ({ key: { id, fromMe: true }, update: { status } });
const fields = { name: 'delivery test', template: 'hi' };

/** A finished campaign with the given rows: { id, sentAgo (minutes), delivered (minutes ago | null), read } */
async function seed(userId, rows, { status = 'completed' } = {}) {
  const campaign = await Campaign.create({ userId, name: 'earlier', template: 'earlier message', status, total: rows.length });
  let n = 0;
  await Recipient.insertMany(
    rows.map((r) => ({
      campaignId: campaign._id,
      userId,
      name: `P${n}`,
      phone: `9190004${String(n++).padStart(5, '0')}`,
      status: 'sent',
      sentAt: ago(r.sentAgo),
      waMessageId: r.id === undefined ? `${tag}-${n}-${userId}` : r.id,
      deliveredAt: r.delivered == null ? null : ago(r.delivered),
      readAt: r.read ? ago(r.read) : null,
    }))
  );
  return campaign;
}
const stuck = (n, sentAgo = 10) => Array.from({ length: n }, () => ({ sentAgo, delivered: null }));
const arrived = (n, sentAgo = 30) => Array.from({ length: n }, () => ({ sentAgo, delivered: sentAgo - 1 }));

// ---------------------------------------------------------------- receipts

test('receipts: delivered and read are saved against the right person, once, for the right account', T, async () => {
  const userId = newUserId();
  const other = newUserId();
  await seed(userId, [{ id: `${tag}-A`, sentAgo: 5 }, { id: `${tag}-B`, sentAgo: 5 }]);
  await seed(other, [{ id: `${tag}-A`, sentAgo: 5 }]); // the same WhatsApp id on another account must not be touched
  const row = (id, u = userId) => Recipient.findOne({ userId: u, waMessageId: `${tag}-${id}` }).lean();

  assert.equal(await recordDelivery(userId, [update(`${tag}-A`, 3)], { retry: false }), 1);
  const first = await row('A');
  assert.ok(first.deliveredAt);
  assert.equal(first.readAt, null);
  assert.equal((await row('B')).deliveredAt, null);
  assert.equal((await row('A', other)).deliveredAt, null);

  await new Promise((r) => setTimeout(r, 20));
  await recordDelivery(userId, [update(`${tag}-A`, 4)], { retry: false });
  const second = await row('A');
  assert.ok(second.readAt, 'read is saved');
  assert.equal(second.deliveredAt.getTime(), first.deliveredAt.getTime(), 'the first delivery time is kept');

  // read before delivered (receipts can arrive in any order): both are filled in
  await recordDelivery(userId, [update(`${tag}-B`, 4)], { retry: false });
  const b = await row('B');
  assert.ok(b.deliveredAt && b.readAt);

  // not ours, one tick, rubbish: nothing happens and nothing throws
  assert.equal(await recordDelivery(userId, [{ key: { id: `${tag}-B`, fromMe: false }, update: { status: 3 } }, update('unknown', 2), null], { retry: false }), 0);
});

test('receipts: a sent message keeps the WhatsApp id the channel returned', T, async () => {
  const userId = newUserId();
  const engine = createEngine({
    name: 'whatsapp',
    ownedUserIds: () => [String(userId)],
    Campaign,
    Recipient,
    contactField: 'phone',
    limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0 },
    deliver: async ({ recipient }) => ({ outcome: 'sent', waMessageId: `${tag}-id-${recipient.phone}` }),
  });
  const c = await engine.createCampaign({ userId, fields, contacts: [{ name: 'A', phone: '919000500001' }] });
  await Recipient.updateMany({ campaignId: c._id }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
  await engine.tick();
  const end = Date.now() + 8000;
  let row;
  while (Date.now() < end) {
    row = await Recipient.findOne({ campaignId: c._id }).lean();
    if (row.status === 'sent') break;
    await new Promise((r) => setTimeout(r, 40));
  }
  assert.equal(row.status, 'sent');
  assert.equal(row.waMessageId, `${tag}-id-919000500001`);
  assert.equal(row.deliveredAt, null);
});

// ---------------------------------------------------------------- "messages are not arriving"

const stub = () =>
  createEngine({ name: 'whatsapp', Campaign, Recipient, contactField: 'phone', limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0 }, deliver: async () => ({ outcome: 'sent' }) });
const running = (engine, userId) => engine.createCampaign({ userId, fields, contacts: [{ name: 'Z', phone: '919000600001' }] });

test('stall: the latest messages all unconfirmed, after earlier ones arrived, pauses the campaign and tells the owner once', T, async () => {
  const engine = stub();
  const userId = newUserId();
  await seed(userId, [...arrived(4, 120), ...stuck(6, 10)]); // the user's case: some went through, then nothing did
  const live = await running(engine, userId);

  const health = await evaluateHealth(userId);
  assert.ok(health.reasons.some((r) => r.code === 'delivery_stall' && r.level === 'risk'));

  const res = await checkDelivery(userId, { engine });
  assert.equal(res.action, 'paused');
  const c = await Campaign.findById(live._id).lean();
  assert.equal(c.status, 'paused');
  assert.match(c.pauseReason, /not being delivered/);
  assert.equal(await Notification.countDocuments({ userId, type: 'whatsapp_delivery_stall' }), 1);

  // the owner resumes anyway: they have been told, so it does not pause again at once
  await engine.resume(userId, live._id);
  assert.equal((await checkDelivery(userId, { engine })).action, 'none');
  assert.equal((await Campaign.findById(live._id).lean()).status, 'running');
  assert.equal(await Notification.countDocuments({ userId, type: 'whatsapp_delivery_stall' }), 1);
});

test('stall: one confirmed message among the latest means it is not a stall', T, async () => {
  const engine = stub();
  const userId = newUserId();
  await seed(userId, [...stuck(5, 10), { sentAgo: 12, delivered: 11 }]);
  await running(engine, userId);
  assert.equal((await checkDelivery(userId, { engine })).action, 'none');
});

test('stall: messages younger than a few minutes are not judged yet', T, async () => {
  const engine = stub();
  const userId = newUserId();
  await seed(userId, [...arrived(2, 120), ...stuck(8, 1)]);
  await running(engine, userId);
  assert.equal((await checkDelivery(userId, { engine })).action, 'none');
});

test('stall: with no confirmation ever seen we only warn, because the receipts may simply not reach us', T, async () => {
  const engine = stub();
  const userId = newUserId();
  await seed(userId, stuck(7, 10));
  const live = await running(engine, userId);
  const res = await checkDelivery(userId, { engine });
  assert.equal(res.action, 'notified');
  assert.equal((await Campaign.findById(live._id).lean()).status, 'running');
  const health = await evaluateHealth(userId);
  assert.equal(health.reasons.find((r) => r.code === 'delivery_stall').level, 'warning');
});

test('stall: with auto-pause switched off the owner is told but nothing is paused', T, async () => {
  const engine = stub();
  const userId = newUserId();
  await seed(userId, [...arrived(2, 120), ...stuck(6, 10)]);
  const live = await running(engine, userId);
  config.waHealthAutopause = false;
  try {
    assert.equal((await checkDelivery(userId, { engine })).action, 'notified');
  } finally {
    config.waHealthAutopause = true;
  }
  assert.equal((await Campaign.findById(live._id).lean()).status, 'running');
});

test('rate: many undelivered messages over a few hours raise a warning, a few do not', T, async () => {
  const userId = newUserId();
  await seed(userId, [...arrived(10, 60), ...stuck(10, 90)]); // half never arrived (the newest ones arrived, so this is not a stall)
  const h = await evaluateHealth(userId);
  assert.equal(h.reasons.find((r) => r.code === 'delivery_low')?.level, 'warning');
  assert.equal(h.metrics.deliveryTracked, 20);
  assert.equal(h.metrics.delivered, 10);

  const fine = newUserId();
  await seed(fine, [...arrived(18, 60), ...stuck(2, 90)]);
  assert.ok(!(await evaluateHealth(fine)).reasons.some((r) => r.code.startsWith('delivery')));

  const old = newUserId();
  await seed(old, stuck(20, 60).map((r) => ({ ...r, id: null }))); // sent before delivery tracking existed: never judged
  assert.ok(!(await evaluateHealth(old)).reasons.some((r) => r.code.startsWith('delivery')));
});

// ---------------------------------------------------------------- the report

async function call(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: json === undefined ? undefined : JSON.stringify(json) });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}
async function account() {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  const u = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  made.push(u);
  return u;
}

test('report: the campaign page and the CSV show delivered, read and not delivered', T, async () => {
  const u = await account();
  const c = await seed(u.id, [
    { id: `${tag}-r1`, sentAgo: 60, delivered: 59, read: 50 }, // read
    { id: `${tag}-r2`, sentAgo: 60, delivered: 59 }, // delivered
    { id: `${tag}-r3`, sentAgo: 60 }, // sent an hour ago, nothing: not delivered
    { id: `${tag}-r4`, sentAgo: 2 }, // too early to say
    { id: null, sentAgo: 60 }, // from before tracking
  ]);

  const detail = await call('GET', `/api/whatsapp/campaigns/${c._id}`, { token: u.token });
  assert.equal(detail.status, 200, detail.text);
  assert.deepEqual(detail.body.campaign.delivery, { tracked: 4, delivered: 2, read: 1, notDelivered: 1, waiting: 1 });
  const by = Object.fromEntries(detail.body.recipients.map((r) => [r.waMessageId || 'old', r.delivery]));
  assert.deepEqual(by, { [`${tag}-r1`]: 'read', [`${tag}-r2`]: 'delivered', [`${tag}-r3`]: 'not delivered', [`${tag}-r4`]: 'sent', old: null });
  assert.deepEqual(detail.body.campaign.resendable, { failed: 0, maybe: 0, unsent: 0, undelivered: 0 }, 'an hour is too early to call it lost');

  const csv = await call('GET', `/api/whatsapp/campaigns/${c._id}/report.csv`, { token: u.token });
  assert.equal(csv.status, 200);
  const lines = csv.text.replace(/^﻿/, '').trim().split(/\r?\n/);
  assert.match(lines[0], /Delivery,Delivered at,Read at/);
  assert.equal(lines.filter((l) => /,read,/.test(l)).length, 1);
  assert.equal(lines.filter((l) => /,not delivered,/.test(l)).length, 1);
});

test('report: after six hours the unconfirmed ones can be sent again', T, async () => {
  const u = await account();
  const c = await seed(u.id, [
    { id: `${tag}-s1`, sentAgo: 400 }, // never confirmed
    { id: `${tag}-s2`, sentAgo: 400 },
    { id: `${tag}-s3`, sentAgo: 400, delivered: 399 },
  ]);
  const detail = await call('GET', `/api/whatsapp/campaigns/${c._id}`, { token: u.token });
  assert.equal(detail.body.campaign.resendable.undelivered, 2);
});

// ---------------------------------------------------------------- new number

test('new number: kept to a small daily amount at first, the plan limit after the warm-up', T, async () => {
  config.waWarmupDays = 14;
  config.waWarmupDailyCap = 40;
  try {
    forgetWarmup();
    const fresh = newUserId();
    const a = await whatsappLimits(fresh);
    assert.equal(a.dailyCap, 40);
    assert.equal(a.warmup.day, 1);

    const veteran = newUserId();
    await seed(veteran, [{ sentAgo: 20 * 24 * 60 }]);
    forgetWarmup();
    const b = await whatsappLimits(veteran);
    assert.ok(b.dailyCap > 40);
    assert.equal(b.warmup, undefined);

    const week = newUserId();
    await seed(week, [{ sentAgo: 5 * 24 * 60 }]);
    forgetWarmup();
    const c = await whatsappLimits(week);
    assert.equal(c.dailyCap, 40);
    assert.equal(c.warmup.day, 6);

    config.waWarmupDays = 0; // switched off
    assert.ok((await whatsappLimits(fresh)).dailyCap > 40);
  } finally {
    config.waWarmupDays = 0;
    forgetWarmup();
  }
});
