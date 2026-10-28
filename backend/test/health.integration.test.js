import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Tests for the hourly cap and the WhatsApp health checks. They run against a THROW-AWAY MongoDB database
// (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb+srv://.../bulk_messenger_test npm test
// Nothing is sent: the delivery function in these tests is a stub.
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
const { evaluateHealth, checkUser } = await import('../src/whatsapp/health.js');
const { Campaign, Recipient, OptOut, Notification, User } = models;

let server;
let base;
const users = [];

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
  await Promise.all(
    users.flatMap((userId) => [
      Campaign.deleteMany({ userId }),
      Recipient.deleteMany({ userId }),
      OptOut.deleteMany({ userId }),
      Notification.deleteMany({ userId }),
      User.deleteMany({ _id: userId }),
    ])
  );
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

const newUserId = () => {
  const id = new mongoose.Types.ObjectId();
  users.push(id);
  return id;
};
const T = { skip, timeout: 60_000 };

// `owners` = the accounts this engine may send for. Other test files share the database, so never touch their rows.
const channelWith = (deliver, limits = {}, owners = null) => ({
  name: 'whatsapp',
  ownedUserIds: owners ? () => owners.map(String) : undefined,
  Campaign,
  Recipient,
  contactField: 'phone',
  limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0, ...limits },
  deliver,
});
const fields = { name: 'health test', template: 'hi' };
const contacts = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9190002${String(i).padStart(5, '0')}` }));

async function waitUntil(check, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) assert.fail('timed out waiting for the database to reach the expected state');
    await sleep(40);
  }
}

/** Put past results into the database: a finished campaign with `sent`, `failed` and "not on WhatsApp" rows. */
async function seed(userId, { sent = 0, failed = 0, notOnWhatsapp = 0, firstSentAt = null } = {}) {
  const campaign = await Campaign.create({ userId, name: 'earlier', template: 'earlier message', status: 'completed', total: sent + failed + notOnWhatsapp });
  let n = 0;
  const row = (extra) => ({ campaignId: campaign._id, userId, name: '', phone: `9190003${String(n++).padStart(5, '0')}`, ...extra });
  const rows = [
    ...Array.from({ length: sent }, () => row({ status: 'sent', sentAt: new Date() })),
    ...Array.from({ length: failed }, () => row({ status: 'failed', error: 'boom' })),
    ...Array.from({ length: notOnWhatsapp }, () => row({ status: 'skipped', error: 'not on WhatsApp' })),
  ];
  if (rows.length) await Recipient.insertMany(rows);
  if (firstSentAt) await Recipient.collection.insertOne({ ...row({ status: 'sent', sentAt: firstSentAt }), createdAt: firstSentAt, updatedAt: firstSentAt });
}
const codes = (h) => h.reasons.map((r) => r.code).sort();

// ---------------------------------------------------------------- hourly cap

test('hourly cap: an account never sends more than the cap in a rolling hour; the rest wait', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(async () => ({ outcome: 'sent' }), { hourlyCap: 3 }, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(7) });
  const count = (status) => Recipient.countDocuments({ campaignId: c._id, status });

  // everything is due now; the dispatcher may only let three through
  await Recipient.updateMany({ campaignId: c._id, status: 'pending' }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
  await engine.tick();
  await waitUntil(async () => (await count('sent')) === 3);
  for (let i = 0; i < 3; i++) {
    await engine.tick();
    await sleep(100);
  }
  assert.equal(await count('sent'), 3, 'no more than the cap went out');
  assert.equal(await count('pending'), 4);
  const waiting = await Recipient.find({ campaignId: c._id, status: 'pending' }).lean();
  assert.ok(waiting.every((r) => r.scheduledFor.getTime() > Date.now() + 10_000), 'the held-back messages were rescheduled into the future');

  // an hour later the slots are free again
  await Recipient.collection.updateMany({ campaignId: c._id, status: 'sent' }, { $set: { sentAt: new Date(Date.now() - 61 * 60_000) } });
  await Recipient.updateMany({ campaignId: c._id, status: 'pending' }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
  await engine.tick();
  await waitUntil(async () => (await count('sent')) === 6);
  await engine.tick();
  await sleep(200);
  assert.equal(await count('sent'), 6, 'the cap applies to the new hour as well');
  assert.equal(await count('pending'), 1);
});

test('hourly cap: it is per account, one account at its cap does not hold up another', T, async () => {
  const busy = newUserId();
  const other = newUserId();
  const engine = createEngine(channelWith(async () => ({ outcome: 'sent' }), { hourlyCap: 2 }, [busy, other]));
  const a = await engine.createCampaign({ userId: busy, fields, contacts: contacts(5) });
  const b = await engine.createCampaign({ userId: other, fields, contacts: contacts(2) });
  await Recipient.updateMany({ campaignId: { $in: [a._id, b._id] } }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
  for (let i = 0; i < 4; i++) {
    await engine.tick();
    await sleep(100);
  }
  await waitUntil(async () => (await Recipient.countDocuments({ campaignId: b._id, status: 'sent' })) === 2);
  assert.equal(await Recipient.countDocuments({ campaignId: a._id, status: 'sent' }), 2, 'the busy account stopped at its cap');
});

// ---------------------------------------------------------------- health rules

test('health: a fresh account is fine and shows the hourly limit', T, async () => {
  const h = await evaluateHealth(newUserId());
  assert.equal(h.level, 'ok');
  assert.deepEqual(h.reasons, []);
  assert.deepEqual(h.hourly, { cap: config.waHourlyCap, used: 0, resetsAt: null });
});

test('health: failure rate needs enough messages, then warns at 20% and is a risk at 40%', T, async () => {
  const few = newUserId();
  await seed(few, { sent: 5, failed: 4 }); // 9 attempts: too few to judge
  assert.equal((await evaluateHealth(few)).level, 'ok');

  const warn = newUserId();
  await seed(warn, { sent: 8, failed: 2 });
  const w = await evaluateHealth(warn);
  assert.equal(w.level, 'warning');
  assert.deepEqual(codes(w), ['failures']);

  const risk = newUserId();
  await seed(risk, { sent: 6, failed: 4 });
  const r = await evaluateHealth(risk);
  assert.equal(r.level, 'risk');
  assert.match(r.reasons[0].message, /40%/);
});

test('health: numbers that are not on WhatsApp, STOP replies, disconnects and fast ramp-up are each noticed', T, async () => {
  const invalid = newUserId();
  await seed(invalid, { sent: 3, notOnWhatsapp: 7 });
  const i = await evaluateHealth(invalid);
  assert.deepEqual([i.level, ...codes(i)], ['risk', 'invalid_numbers']);

  const stops = newUserId();
  await seed(stops, { sent: 20 });
  await OptOut.insertMany(['919000400001', '919000400002', '919000400003'].map((phone) => ({ userId: stops, phone })));
  const s = await evaluateHealth(stops);
  assert.deepEqual([s.level, ...codes(s)], ['risk', 'opt_outs']); // 3 of 20 = 15%

  const flaky = newUserId();
  await Notification.insertMany(Array.from({ length: 3 }, () => ({ userId: flaky, type: 'whatsapp_disconnected', title: 'WhatsApp disconnected' })));
  const f = await evaluateHealth(flaky);
  assert.deepEqual([f.level, ...codes(f)], ['warning', 'disconnects']);

  const fast = newUserId();
  await seed(fast, { sent: 45 });
  const n = await evaluateHealth(fast);
  assert.deepEqual([n.level, ...codes(n)], ['warning', 'new_number']);

  const established = newUserId();
  await seed(established, { sent: 45, firstSentAt: new Date(Date.now() - 30 * 86_400_000) });
  assert.equal((await evaluateHealth(established)).level, 'ok', 'a number that has been sending for a month may send more');
});

test('health: the hourly figures show how much of the hour is used and when it frees up', T, async () => {
  const userId = newUserId();
  await seed(userId, { sent: config.waHourlyCap });
  const h = await evaluateHealth(userId);
  assert.equal(h.hourly.used, config.waHourlyCap);
  assert.ok(new Date(h.hourly.resetsAt).getTime() > Date.now() + 50 * 60_000, 'a slot frees up in about an hour');
});

// ---------------------------------------------------------------- the monitor

test('monitor: a risky account is warned and its campaigns paused, once; a warning only informs', T, async () => {
  const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));

  const risky = newUserId();
  await seed(risky, { sent: 6, failed: 4 });
  const running = await engine.createCampaign({ userId: risky, fields, contacts: contacts(3) });
  let res = await checkUser(risky, { engine });
  assert.equal(res.action, 'paused');
  const paused = await Campaign.findById(running._id).lean();
  assert.equal(paused.status, 'paused');
  assert.match(paused.pauseReason, /protect your WhatsApp number/);
  assert.equal(await Notification.countDocuments({ userId: risky, type: 'whatsapp_health_risk' }), 1);

  // the owner resumes anyway: they have been told, so they are left alone for a day
  await engine.resume(risky, running._id);
  res = await checkUser(risky, { engine });
  assert.equal(res.action, 'none');
  assert.equal((await Campaign.findById(running._id).lean()).status, 'running');
  assert.equal(await Notification.countDocuments({ userId: risky, type: 'whatsapp_health_risk' }), 1, 'not told again');

  const careful = newUserId();
  await seed(careful, { sent: 8, failed: 2 });
  const quiet = await engine.createCampaign({ userId: careful, fields, contacts: contacts(2) });
  res = await checkUser(careful, { engine });
  assert.equal(res.action, 'notified');
  assert.equal((await Campaign.findById(quiet._id).lean()).status, 'running', 'a warning does not pause anything');
  assert.equal(await Notification.countDocuments({ userId: careful, type: 'whatsapp_health_warning' }), 1);

  const fine = newUserId();
  assert.equal((await checkUser(fine, { engine })).action, 'none');
  assert.equal(await Notification.countDocuments({ userId: fine }), 0);
});

test('monitor: with auto-pause switched off the owner is told but nothing is paused', T, async () => {
  const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));
  const userId = newUserId();
  await seed(userId, { sent: 6, failed: 4 });
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(2) });
  config.waHealthAutopause = false;
  try {
    const res = await checkUser(userId, { engine });
    assert.equal(res.action, 'notified');
    assert.equal((await Campaign.findById(c._id).lean()).status, 'running');
    assert.equal(await Notification.countDocuments({ userId, type: 'whatsapp_health_risk' }), 1);
  } finally {
    config.waHealthAutopause = true;
  }
});

// ---------------------------------------------------------------- the endpoint

test('GET /api/whatsapp/health needs a login and returns the report', T, async () => {
  const email = `h-${Date.now()}@example.com`;
  const reg = await fetch(`${base}/api/auth/register`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password: 'correct horse battery' }) });
  const { token, user } = await reg.json();
  users.push(new mongoose.Types.ObjectId(user.id));

  const anon = await fetch(`${base}/api/whatsapp/health`);
  assert.equal(anon.status, 401);

  const res = await fetch(`${base}/api/whatsapp/health`, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.level, 'ok');
  assert.equal(body.hourly.cap, config.waHourlyCap);
  assert.deepEqual(body.reasons, []);
});
