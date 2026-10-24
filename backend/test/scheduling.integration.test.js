import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Tests for scheduled campaigns and send windows. They run against a THROW-AWAY MongoDB database
// (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
// Nothing is really sent: delivery is a stub, and the email routes never start the dispatcher.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST ??= 'smtp.test.invalid';
process.env.SMTP_FROM_EMAIL ??= 'no-reply@test.invalid';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { closeAllSenders } = await import('../src/email/mailer.js');
const { createEngine } = await import('../src/engine/sendEngine.js');
const { isOpen, nextOpen } = await import('../src/engine/window.js');
const { Campaign, Recipient, EmailCampaign, EmailRecipient, User } = models;

config.maxActiveCampaigns = 20; // these tests start several campaigns for one account

let server;
let base;
const accounts = [];
const engineUsers = [];

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
  closeAllSenders();
  const ids = [...accounts.map((a) => a.id), ...engineUsers];
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    Campaign.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

const T = { skip, timeout: 40_000 };
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const iso = (ms) => new Date(ms).toISOString();

const newUserId = () => {
  const id = new mongoose.Types.ObjectId();
  engineUsers.push(id);
  return id;
};
const contacts = (n, from = 0) => Array.from({ length: n }, (_, i) => ({ name: `P${from + i}`, phone: `9190000${String(from + i).padStart(5, '0')}` }));
const fields = { name: 'scheduling test', template: 'hi {{name}}' };

/** A WhatsApp-shaped channel with a stub delivery and no pauses between sends, only for the given users. */
function channelWith(deliver, limits = {}, owners) {
  return {
    name: 'whatsapp',
    Campaign,
    Recipient,
    contactField: 'phone',
    limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0, ...limits },
    deliver,
    ownedUserIds: () => owners.map(String),
  };
}

const ok = async () => ({ outcome: 'sent' });
const makeDue = (c) => Recipient.updateMany({ campaignId: c._id, status: 'pending', scheduledFor: { $ne: null } }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
const times = async (c) => (await Recipient.find({ campaignId: c._id, status: 'pending' }).lean()).map((r) => r.scheduledFor?.getTime());
const count = (c, status) => Recipient.countDocuments({ campaignId: c._id, status });

async function waitUntil(fn, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(50);
  }
  throw new Error('timed out waiting for the condition');
}

/** Minutes after midnight (UTC) for a moment. */
const utcMinutes = (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes();
/** A UTC window that is open now: from an hour ago to an hour ahead. */
const openNow = () => ({ start: (utcMinutes(Date.now()) - 60 + 1440) % 1440, end: (utcMinutes(Date.now()) + 60) % 1440, timezone: 'UTC', days: [] });
/** A UTC window that is closed now and opens in two hours, for one hour. */
const closedNow = () => ({ start: (utcMinutes(Date.now()) + 120) % 1440, end: (utcMinutes(Date.now()) + 180) % 1440, timezone: 'UTC', days: [] });

// ---------------------------------------------------------------- scheduled start

test('a scheduled campaign waits for its start time, then sends', T, async () => {
  const userId = newUserId();
  let delivered = 0;
  const engine = createEngine(channelWith(async () => (delivered++, { outcome: 'sent' }), {}, [userId]));
  const startAt = new Date(Date.now() + 2 * HOUR);
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(3), startAt });

  assert.equal(c.status, 'running');
  assert.equal(c.startAt.getTime(), startAt.getTime());
  const planned = await times(c);
  assert.equal(planned.length, 3);
  assert.ok(planned.every((t) => t >= startAt.getTime()), 'nothing is planned before the start time');
  assert.equal(Math.min(...planned), startAt.getTime(), 'the first message goes out exactly at the start time');

  for (let i = 0; i < 3; i++) {
    await engine.tick();
    await sleep(50);
  }
  assert.equal(delivered, 0, 'nothing is sent before the start time');

  // the start time arrives
  await Campaign.updateOne({ _id: c._id }, { startAt: new Date(Date.now() - 1000) });
  await makeDue(c);
  await engine.tick();
  await waitUntil(async () => (await count(c, 'sent')) === 3);
  assert.equal(delivered, 3);
});

test('a start time in the past or "now" simply starts right away', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, {}, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(2), startAt: new Date(Date.now() - 1000) });
  assert.equal(c.startAt, null);
  assert.ok(Math.max(...(await times(c))) < Date.now() + MIN);
});

test('a campaign waiting for a future start does not hold up one that starts now', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { minDelay: 1, maxDelay: 1 }, [userId]));
  const later = await engine.createCampaign({ userId, fields: { ...fields, name: 'later' }, contacts: contacts(5), startAt: new Date(Date.now() + 5 * HOUR) });
  const now = await engine.createCampaign({ userId, fields: { ...fields, name: 'now' }, contacts: contacts(2, 100) });
  assert.ok(Math.min(...(await times(now))) < Date.now() + MIN, 'the immediate campaign starts at once');
  assert.ok(Math.min(...(await times(later))) >= Date.now() + 5 * HOUR - MIN);
});

test('a campaign that is already sending still makes a new one wait its turn', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { minDelay: 10, maxDelay: 10 }, [userId]));
  const first = await engine.createCampaign({ userId, fields, contacts: contacts(5) });
  const second = await engine.createCampaign({ userId, fields: { ...fields, name: 'second' }, contacts: contacts(2, 100) });
  assert.ok(Math.min(...(await times(second))) > Math.max(...(await times(first))), 'one account never sends two campaigns at the same moment');
});

test('pausing and resuming keeps the start time', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, {}, [userId]));
  const startAt = new Date(Date.now() + 3 * HOUR);
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(3), startAt });
  await engine.pause(userId, c._id);
  assert.ok((await times(c)).every((t) => t === undefined), 'a paused campaign has no send times');
  await engine.resume(userId, c._id);
  const planned = await times(c);
  assert.equal(planned.length, 3);
  assert.ok(planned.every((t) => t >= startAt.getTime()), 'resuming does not start it early');
});

// ---------------------------------------------------------------- daily limit and scheduling

test('the daily limit counts a scheduled campaign on the day it sends, not on the day it was created', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { dailyCap: 5 }, [userId]));
  const inThreeDays = () => new Date(Date.now() + 3 * DAY);

  await engine.createCampaign({ userId, fields, contacts: contacts(5), startAt: inThreeDays() });
  // today is still completely free
  assert.equal(await engine.remainingToday(userId), 5);
  const today = await engine.createCampaign({ userId, fields: { ...fields, name: 'today' }, contacts: contacts(5, 100) });
  assert.equal(today.status, 'running');
  // but today is now full, and so is the day of the first campaign
  await assert.rejects(engine.createCampaign({ userId, fields, contacts: contacts(1, 200) }), (e) => e.status === 429);
  await assert.rejects(engine.createCampaign({ userId, fields, contacts: contacts(1, 300), startAt: inThreeDays() }), (e) => e.status === 429);
  // a day with nothing planned is free
  const farAway = await engine.createCampaign({ userId, fields: { ...fields, name: 'far' }, contacts: contacts(5, 400), startAt: new Date(Date.now() + 10 * DAY) });
  assert.equal(farAway.status, 'running');
  assert.equal(await engine.remainingToday(userId, Date.now() + 3 * DAY), 0);
});

test('messages sent yesterday and waiting messages both count; old sent messages do not', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { dailyCap: 10 }, [userId]));
  const base = { userId, campaignId: new mongoose.Types.ObjectId(), name: 'x' };
  await Recipient.collection.insertMany([
    { ...base, phone: '919100000001', status: 'sent', sentAt: new Date(Date.now() - 2 * HOUR), createdAt: new Date(), updatedAt: new Date() },
    { ...base, phone: '919100000002', status: 'sent', sentAt: new Date(Date.now() - 30 * HOUR), createdAt: new Date(Date.now() - 30 * HOUR), updatedAt: new Date() },
    // created long ago but only now due: it is waiting, so it counts
    { ...base, phone: '919100000003', status: 'pending', scheduledFor: new Date(Date.now() + HOUR), createdAt: new Date(Date.now() - 5 * DAY), updatedAt: new Date() },
    // waiting, but for next week
    { ...base, phone: '919100000004', status: 'pending', scheduledFor: new Date(Date.now() + 7 * DAY), createdAt: new Date(), updatedAt: new Date() },
  ]);
  assert.equal(await engine.remainingToday(userId), 10 - 2);
  await Recipient.deleteMany({ userId });
});

// ---------------------------------------------------------------- send window

test('a send window that is closed delays the first message until it opens, and every message is inside it', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { minDelay: 1, maxDelay: 1 }, [userId]));
  const sendWindow = closedNow();
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(4), sendWindow });
  assert.equal(c.sendWindow.timezone, 'UTC');
  assert.equal(c.sendWindow.start, sendWindow.start);

  const planned = await times(c);
  const opening = nextOpen(Date.now(), sendWindow);
  assert.ok(opening > Date.now() + HOUR, 'the window opens in about two hours');
  assert.ok(Math.min(...planned) >= opening);
  assert.ok(planned.every((t) => isOpen(t, sendWindow)));
});

test('an open send window changes nothing: sending starts right away', T, async () => {
  const userId = newUserId();
  let delivered = 0;
  const engine = createEngine(channelWith(async () => (delivered++, { outcome: 'sent' }), {}, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(2), sendWindow: openNow() });
  await makeDue(c);
  await engine.tick();
  await waitUntil(async () => (await count(c, 'sent')) === 2);
  assert.equal(delivered, 2);
});

test('when the window closes, messages that come due are moved to the next opening instead of being sent', T, async () => {
  const userId = newUserId();
  let delivered = 0;
  const engine = createEngine(channelWith(async () => (delivered++, { outcome: 'sent' }), { minDelay: 1, maxDelay: 1 }, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(6), sendWindow: openNow() });

  // the window is now closed (the campaign's rules change underneath it), and the messages are due
  const closed = closedNow();
  await Campaign.updateOne({ _id: c._id }, { sendWindow: closed });
  await makeDue(c);
  for (let i = 0; i < 3; i++) {
    await engine.tick();
    await sleep(60);
  }
  assert.equal(delivered, 0, 'nothing is sent while the window is closed');
  assert.equal(await count(c, 'pending'), 6, 'and nothing is lost');
  const planned = await times(c);
  assert.ok(planned.every((t) => t >= nextOpen(Date.now(), closed) && isOpen(t, closed)), 'every message waits for the next opening');
  assert.equal(new Set(planned).size, 6, 'and they are spread out again, not sent together');
});

// ---------------------------------------------------------------- changing the schedule

test('the send window of a running campaign can be changed, and waiting messages are planned again', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { minDelay: 1, maxDelay: 1 }, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(4) });
  assert.ok(Math.min(...(await times(c))) < Date.now() + MIN);

  const window = closedNow();
  const updated = await engine.updateSchedule(userId, c._id, { sendWindow: window });
  assert.equal(updated.sendWindow.end, window.end);
  const planned = await times(c);
  assert.equal(planned.length, 4);
  assert.ok(planned.every((t) => isOpen(t, window) && t >= nextOpen(Date.now(), window)));

  const cleared = await engine.updateSchedule(userId, c._id, { sendWindow: null });
  assert.equal(cleared.sendWindow, null);
  assert.ok(Math.min(...(await times(c))) < Date.now() + MIN, 'without a window the messages are due again');
});

test('the start time can be moved before sending begins, and not after', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, {}, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(3), startAt: new Date(Date.now() + 2 * HOUR) });

  const moved = new Date(Date.now() + 6 * HOUR);
  const a = await engine.updateSchedule(userId, c._id, { startAt: moved });
  assert.equal(a.startAt.getTime(), moved.getTime());
  assert.equal(Math.min(...(await times(c))), moved.getTime());

  const b = await engine.updateSchedule(userId, c._id, { startAt: null });
  assert.equal(b.startAt, null);
  assert.ok(Math.min(...(await times(c))) < Date.now() + MIN, 'with no start time it goes out now');

  await Recipient.updateOne({ campaignId: c._id, status: 'pending' }, { $set: { status: 'sent', sentAt: new Date() } });
  await assert.rejects(engine.updateSchedule(userId, c._id, { startAt: moved }), (e) => e.status === 409 && /before sending begins/.test(e.message));
});

test('a paused campaign takes the new window when it is resumed', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, {}, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(3) });
  await engine.pause(userId, c._id);
  const window = closedNow();
  await engine.updateSchedule(userId, c._id, { sendWindow: window });
  assert.ok((await times(c)).every((t) => t === undefined), 'still not scheduled while paused');
  await engine.resume(userId, c._id);
  assert.ok((await times(c)).every((t) => isOpen(t, window) && t >= nextOpen(Date.now(), window)));
});

test('moving the start time cannot be used to get around the daily limit', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, { dailyCap: 5 }, [userId]));
  const day = Date.now() + 4 * DAY;
  await engine.createCampaign({ userId, fields, contacts: contacts(5), startAt: new Date(day) });
  const second = await engine.createCampaign({ userId, fields: { ...fields, name: 'second' }, contacts: contacts(5, 100), startAt: new Date(day + 3 * DAY) });
  await assert.rejects(engine.updateSchedule(userId, second._id, { startAt: new Date(day + HOUR) }), (e) => e.status === 429);
  const same = await engine.updateSchedule(userId, second._id, { startAt: new Date(day + 3 * DAY + HOUR) });
  assert.ok(same.startAt, 'a move that stays within the limit is fine');
});

test('only running or paused campaigns can be rescheduled, and only by their owner', T, async () => {
  const userId = newUserId();
  const engine = createEngine(channelWith(ok, {}, [userId]));
  const c = await engine.createCampaign({ userId, fields, contacts: contacts(2) });
  await assert.rejects(engine.updateSchedule(newUserId(), c._id, { sendWindow: null }), (e) => e.status === 404);
  await engine.cancel(userId, c._id);
  await assert.rejects(engine.updateSchedule(userId, c._id, { sendWindow: null }), (e) => e.status === 404);
});

// ---------------------------------------------------------------- the HTTP API

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (form) {
    body = form;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(base + path, { method, headers, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (res) => JSON.stringify(res.body);

async function newAccount() {
  const email = `s-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: 'correct horse battery' } });
  assert.equal(res.status, 201, say(res));
  const account = { token: res.body.token, id: res.body.user.id };
  accounts.push(account);
  return account;
}

function emailForm(fields, rows = 3) {
  const fd = new FormData();
  for (const [k, v] of Object.entries({ name: 'api test', subject: 'Hi', body: 'Hello {{name}}', consentConfirmed: 'true', ...fields })) fd.append(k, v);
  const csv = ['name,email', ...Array.from({ length: rows }, (_, i) => `P${i},p${i}@example.com`)].join('\n');
  fd.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv');
  return fd;
}

test('API: a campaign can be created with a start time and a send window', T, async () => {
  const u = await newAccount();
  const startAt = iso(Date.now() + 3 * HOUR);
  const res = await call('POST', '/api/email/campaigns', {
    token: u.token,
    form: emailForm({ startAt, windowStart: '09:00', windowEnd: '18:00', timezone: 'Asia/Kolkata', windowDays: '1,2,3,4,5' }),
  });
  assert.equal(res.status, 201, say(res));
  const c = res.body.campaign;
  assert.equal(new Date(c.startAt).toISOString(), startAt);
  assert.deepEqual({ ...c.sendWindow }, { start: 540, end: 1080, timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5] });

  const detail = await call('GET', `/api/email/campaigns/${c._id}`, { token: u.token });
  assert.equal(detail.status, 200);
  const next = new Date(detail.body.campaign.nextSendAt).getTime();
  assert.ok(next >= Date.parse(startAt), 'the next send is not before the start time');
  assert.equal(isOpen(next, { start: 540, end: 1080, timezone: 'Asia/Kolkata', days: [1, 2, 3, 4, 5] }), true, 'and it is inside the window');
});

test('API: bad scheduling input is refused with a clear message and creates nothing', T, async () => {
  const u = await newAccount();
  const bad = async (fields, pattern) => {
    const res = await call('POST', '/api/email/campaigns', { token: u.token, form: emailForm(fields) });
    assert.equal(res.status, 400, say(res));
    assert.match(res.body.error, pattern);
  };
  await bad({ startAt: iso(Date.now() - DAY) }, /already passed/);
  await bad({ startAt: iso(Date.now() + 90 * DAY) }, /at most 30 days/);
  await bad({ startAt: '2030-01-01' }, /must look like/);
  await bad({ windowStart: '09:00', timezone: 'Asia/Kolkata' }, /both a start and an end/);
  await bad({ windowStart: '09:00', windowEnd: '09:00', timezone: 'Asia/Kolkata' }, /different times/);
  await bad({ windowStart: '09:00', windowEnd: '18:00' }, /timezone/);
  await bad({ windowStart: '09:00', windowEnd: '18:00', timezone: 'Nowhere/City' }, /not a known timezone/);
  await bad({ windowStart: '25:00', windowEnd: '18:00', timezone: 'UTC' }, /24-hour/);
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), 0);
});

test('API: change the schedule of a campaign, and refuse empty or foreign requests', T, async () => {
  const u = await newAccount();
  const stranger = await newAccount();
  const created = await call('POST', '/api/email/campaigns', { token: u.token, form: emailForm({ startAt: iso(Date.now() + 2 * HOUR) }) });
  assert.equal(created.status, 201, say(created));
  const id = created.body.campaign._id;

  const patch = (token, json) => call('PATCH', `/api/email/campaigns/${id}/schedule`, { token, json });
  assert.equal((await patch(u.token, {})).status, 400, 'nothing to change');
  assert.equal((await patch(stranger.token, { removeWindow: true })).status, 404, 'not their campaign');
  assert.equal((await patch(undefined, { removeWindow: true })).status, 401);

  const window = await patch(u.token, { windowStart: '22:00', windowEnd: '06:00', timezone: 'UTC' });
  assert.equal(window.status, 200, say(window));
  assert.equal(window.body.campaign.sendWindow.start, 1320);
  assert.equal(window.body.campaign.sendWindow.end, 360);

  const moved = iso(Date.now() + 5 * HOUR);
  const start = await patch(u.token, { startAt: moved });
  assert.equal(start.status, 200, say(start));
  assert.equal(new Date(start.body.campaign.startAt).toISOString(), moved);

  const removed = await patch(u.token, { removeWindow: true });
  assert.equal(removed.status, 200, say(removed));
  assert.equal(removed.body.campaign.sendWindow, null);

  const now = await patch(u.token, { startAt: null });
  assert.equal(now.status, 200, say(now));
  assert.equal(now.body.campaign.startAt, null);

  assert.equal((await patch(u.token, { windowStart: '09:00', windowEnd: '18:00', removeWindow: true, timezone: 'UTC' })).status, 400);
});

test('API: the dashboard shows when a scheduled campaign starts, and its share of the daily limit', T, async () => {
  const u = await newAccount();
  const startAt = iso(Date.now() + 4 * HOUR);
  const created = await call('POST', '/api/email/campaigns', { token: u.token, form: emailForm({ startAt }) });
  assert.equal(created.status, 201, say(created));
  const dash = await call('GET', '/api/dashboard', { token: u.token });
  assert.equal(dash.status, 200, say(dash));
  const row = dash.body.recent.find((r) => r.id === created.body.campaign._id);
  assert.equal(new Date(row.startAt).toISOString(), startAt);
  assert.equal(dash.body.email.remainingToday, dash.body.email.dailyCap - 3, 'a campaign that sends within a day uses that day\'s limit');
});
