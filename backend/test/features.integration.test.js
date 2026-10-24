import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Tests for saved contact lists, usage stats and alerts. They run the real app against a THROW-AWAY MongoDB
// database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb+srv://.../bulk_messenger_test npm test
// Nothing is ever sent: the dispatcher is not started, and no real SMTP server is contacted.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';

// A platform SMTP makes the email channel "ready" without any network access. Alert emails are switched off.
process.env.SMTP_HOST ??= 'smtp.test.invalid';
process.env.SMTP_FROM_EMAIL ??= 'no-reply@test.invalid';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { closeAllSenders } = await import('../src/email/mailer.js');
const { createEngine, engineEvents } = await import('../src/engine/sendEngine.js');
const { notify } = await import('../src/utils/notify.js');
const { ContactList, ListContact, EmailCampaign, EmailRecipient, Campaign, Recipient, Notification, User } = models;

config.maxActiveCampaigns = 3; // the tests below rely on this

let server;
let base;
const createdUsers = [];

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  // The sign-up limit (10 per hour per IP) would stop these tests, which all come from one IP.
  server = http.createServer(buildApp({ ...createLimiters(), register: (_req, _res, next) => next() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  closeAllSenders();
  const ids = createdUsers.map((u) => u.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    ContactList.deleteMany({ userId: { $in: ids } }),
    ListContact.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    Notification.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

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

function formWith(fields, rows) {
  const fd = new FormData();
  for (const [key, value] of Object.entries(fields)) fd.append(key, value);
  if (rows) fd.append('file', new Blob([['name,email', ...rows].join('\n')], { type: 'text/csv' }), 'contacts.csv');
  return fd;
}

const people = (n, from = 0) => Array.from({ length: n }, (_, i) => `P${from + i},p${from + i}@example.com`);
const say = (res) => JSON.stringify(res.body);

/** A fresh account. The register limiter allows 10 per hour, so the tests below use at most 10. */
async function newUser() {
  const email = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: 'correct horse battery' } });
  assert.equal(res.status, 201, say(res));
  const user = { token: res.body.token, id: res.body.user.id, email };
  createdUsers.push(user);
  return user;
}

async function makeList(u, name, n) {
  const res = await call('POST', '/api/lists', { token: u.token, form: formWith({ name, kind: 'email' }, people(n)) });
  assert.equal(res.status, 201, say(res));
  return res.body.list;
}

const startCampaign = (u, fields) =>
  call('POST', '/api/email/campaigns', {
    token: u.token,
    form: formWith({ name: 'test campaign', subject: 'Hi', body: 'Hello {{name}}', consentConfirmed: 'true', ...fields }),
  });

const freshCount = (listId) => ListContact.countDocuments({ listId, lastCampaignAt: null });
const emailsOf = async (campaignId) => (await EmailRecipient.find({ campaignId }).lean()).map((r) => r.email).sort();
const T = { skip, timeout: 30_000 };

/** Events are announced a moment after the status changes, so wait for them instead of checking at once. */
async function waitFor(check, ms = 3000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) assert.fail('timed out waiting for the engine event');
    await sleep(20);
  }
}

// ---------------------------------------------------------------- saved contact lists

test('lists: create, show, rename, and refuse duplicates or bad input', T, async () => {
  const u = await newUser();
  let res = await call('POST', '/api/lists', {
    token: u.token,
    form: formWith({ name: 'Customers', kind: 'email' }, ['Asha,asha@example.com', 'Rahul,rahul@example.com', 'Bad,not-an-email', 'Again,ASHA@example.com']),
  });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.list.total, 2);
  assert.equal(res.body.summary.invalidCount, 1);
  assert.equal(res.body.summary.duplicatesRemoved, 1);
  const id = res.body.list.id;

  res = await call('GET', '/api/lists', { token: u.token });
  assert.equal(res.body.lists.length, 1);
  assert.deepEqual([res.body.lists[0].name, res.body.lists[0].total, res.body.lists[0].fresh], ['Customers', 2, 2]);

  res = await call('GET', `/api/lists/${id}`, { token: u.token });
  assert.deepEqual(res.body.contacts.map((c) => c.value).sort(), ['asha@example.com', 'rahul@example.com']);

  res = await call('PATCH', `/api/lists/${id}`, { token: u.token, json: { name: 'Best customers' } });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.list.name, 'Best customers');

  const dup = await call('POST', '/api/lists', { token: u.token, form: formWith({ name: 'Best customers', kind: 'email' }, people(1)) });
  assert.equal(dup.status, 409, say(dup));
  const noName = await call('POST', '/api/lists', { token: u.token, form: formWith({ name: ' ', kind: 'email' }, people(1)) });
  assert.equal(noName.status, 400);
  const badKind = await call('POST', '/api/lists', { token: u.token, form: formWith({ name: 'X', kind: 'sms' }, people(1)) });
  assert.equal(badKind.status, 400);
  const noFile = await call('POST', '/api/lists', { token: u.token, form: formWith({ name: 'Y', kind: 'email' }) });
  assert.equal(noFile.status, 400);
  const empty = await call('POST', '/api/lists', { token: u.token, form: formWith({ name: 'Z', kind: 'email' }, ['Bad,nope']) });
  assert.equal(empty.status, 400, say(empty));
  assert.equal(await ContactList.countDocuments({ userId: u.id }), 1, 'a refused upload must not leave a list behind');
});

test('lists: adding contacts skips people already there; removing contacts and lists works', T, async () => {
  const u = await newUser();
  const list = await makeList(u, 'Base', 3); // p0, p1, p2

  let res = await call('POST', `/api/lists/${list.id}/contacts`, { token: u.token, form: formWith({}, people(3, 2)) }); // p2 (already there), p3, p4
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.added, 2);
  assert.equal(res.body.alreadyInList, 1);

  res = await call('GET', `/api/lists/${list.id}`, { token: u.token });
  assert.equal(res.body.list.total, 5);

  const victim = res.body.contacts[0]._id;
  res = await call('DELETE', `/api/lists/${list.id}/contacts/${victim}`, { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.equal((await call('GET', `/api/lists/${list.id}`, { token: u.token })).body.list.total, 4);

  res = await call('DELETE', `/api/lists/${list.id}`, { token: u.token });
  assert.equal(res.status, 200);
  assert.equal((await call('GET', `/api/lists/${list.id}`, { token: u.token })).status, 404);
  assert.equal(await ListContact.countDocuments({ listId: list.id }), 0, 'deleting a list deletes its contacts');
});

test('lists: one user can never see or change another user\'s list', T, async () => {
  const a = await newUser();
  const b = await newUser();
  const list = await makeList(a, 'Private', 2);

  assert.equal((await call('GET', '/api/lists', { token: b.token })).body.lists.length, 0);
  assert.equal((await call('GET', `/api/lists/${list.id}`, { token: b.token })).status, 404);
  assert.equal((await call('DELETE', `/api/lists/${list.id}`, { token: b.token })).status, 404);
  assert.equal((await call('POST', `/api/lists/${list.id}/reset`, { token: b.token })).status, 404);
  const campaign = await startCampaign(b, { listId: list.id });
  assert.equal(campaign.status, 404, say(campaign));
  assert.equal((await call('GET', '/api/lists')).status, 401, 'login is required');
});

// ---------------------------------------------------------------- campaigns from a list

test('campaign from a list: takes the next people not messaged yet, then says when everyone was messaged', T, async () => {
  const u = await newUser();
  const list = await makeList(u, 'Five', 5);

  const seen = new Set();
  const take = async (fields, expected) => {
    const r = await startCampaign(u, fields);
    assert.equal(r.status, 201, say(r));
    const emails = await emailsOf(r.body.campaign._id);
    assert.equal(emails.length, expected);
    for (const e of emails) assert.ok(!seen.has(e), `${e} was picked twice`);
    emails.forEach((e) => seen.add(e));
    return r;
  };

  let res = await take({ listId: list.id, limit: '2' }, 2);
  assert.equal(res.body.summary.queued, 2);
  assert.equal(res.body.summary.list.notMessagedYet, 3);
  await take({ listId: list.id, limit: '2' }, 2);
  res = await take({ listId: list.id }, 1); // no limit: everything that is left
  assert.equal(res.body.summary.list.notMessagedYet, 0);
  assert.equal(seen.size, 5);

  res = await startCampaign(u, { listId: list.id });
  assert.equal(res.status, 400, say(res));
  assert.match(res.body.error, /already been messaged/);
});

test('two campaigns started at the same moment never pick the same person', T, async () => {
  const u = await newUser();
  const list = await makeList(u, 'Race', 4);

  const results = await Promise.all([startCampaign(u, { listId: list.id, limit: '3' }), startCampaign(u, { listId: list.id, limit: '3' })]);
  for (const r of results) assert.ok([201, 400].includes(r.status), say(r));

  const emails = (await EmailRecipient.find({ userId: u.id }).lean()).map((r) => r.email);
  assert.equal(new Set(emails).size, emails.length, 'a person was queued twice');
  assert.equal(await freshCount(list.id), 4 - emails.length, 'people marked as messaged must match the people actually queued');
});

test('a campaign that cannot be created gives its people back; reset and "everyone" mode work', T, async () => {
  const u = await newUser();
  const list = await makeList(u, 'Retry', 4);

  // Fill the allowance of unfinished campaigns, so creating another one is refused.
  const blockers = await EmailCampaign.insertMany(
    Array.from({ length: config.maxActiveCampaigns }, (_, i) => ({ userId: u.id, name: `blocker ${i}`, subject: 's', body: 'b', status: 'running' }))
  );
  assert.equal(blockers.length, config.maxActiveCampaigns);

  let res = await startCampaign(u, { listId: list.id, limit: '2' });
  assert.equal(res.status, 429, say(res));
  assert.equal(await freshCount(list.id), 4, 'the refused campaign must not use up anyone');

  await EmailCampaign.deleteMany({ _id: { $in: blockers.map((b) => b._id) } });
  res = await startCampaign(u, { listId: list.id, limit: '2' });
  assert.equal(res.status, 201, say(res));
  assert.equal(await freshCount(list.id), 2);

  res = await call('POST', `/api/lists/${list.id}/reset`, { token: u.token });
  assert.equal(res.body.reset, 2);
  assert.equal(await freshCount(list.id), 4);

  res = await startCampaign(u, { listId: list.id, onlyNew: 'false', limit: '3' });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.summary.queued, 3);
  assert.equal(await freshCount(list.id), 1, 'only the three people just messaged are marked');

  res = await startCampaign(u, { listId: list.id, limit: '0' });
  assert.equal(res.status, 400, 'a limit below 1 is refused');
});

// ---------------------------------------------------------------- usage stats

test('stats: counts, success rate, failure reasons and what is left of today\'s limit', T, async () => {
  const u = await newUser();
  const campaign = await EmailCampaign.create({ userId: u.id, name: 'stats', subject: 's', body: 'b', status: 'completed', total: 4 });
  const now = new Date();
  await EmailRecipient.insertMany([
    ...[0, 1, 2].map((i) => ({ campaignId: campaign._id, userId: u.id, email: `s${i}@example.com`, status: 'sent', sentAt: now })),
    { campaignId: campaign._id, userId: u.id, email: 'f0@example.com', status: 'failed', error: 'mailbox full' },
  ]);

  let res = await call('GET', '/api/stats?days=7&tz=Asia/Kolkata', { token: u.token });
  assert.equal(res.status, 200, say(res));
  const email = res.body.email;
  assert.equal(email.sent, 3);
  assert.equal(email.failed, 1);
  assert.equal(email.successRate, 75);
  assert.equal(email.daily.length, 7);
  assert.equal(email.daily.at(-1).sent, 3, 'today is the last day and holds the three sends');
  assert.deepEqual(email.topFailures, [{ reason: 'mailbox full', count: 1 }]);
  assert.equal(email.remainingToday, email.dailyCap - 3);
  assert.equal(email.campaigns.total, 1);
  assert.equal(res.body.whatsapp.sent, 0);
  assert.equal(res.body.whatsapp.successRate, null, 'no attempts means no rate');
  assert.deepEqual(Object.keys(res.body.optOuts).sort(), ['emailBounced', 'emailComplaints', 'emailUnsubscribed', 'whatsappStopped']);

  res = await call('GET', '/api/stats?days=1000&tz=Not/AZone', { token: u.token });
  assert.equal(res.body.days, 90, 'the range is capped at 90 days');
  assert.equal(res.body.timeZone, 'UTC', 'an unknown time zone falls back to UTC');
});

// ---------------------------------------------------------------- alerts

test('alerts: saved, not repeated within moments, counted, marked read and cleared', T, async () => {
  const u = await newUser();
  const first = await notify(u.id, { type: 'campaign_paused', level: 'warning', title: 'Paused', message: 'because', dedupeKey: 'k1' });
  assert.ok(first);
  assert.equal(await notify(u.id, { type: 'campaign_paused', level: 'warning', title: 'Paused', dedupeKey: 'k1' }), null, 'the same alert twice in a row is dropped');
  await notify(u.id, { type: 'campaign_completed', level: 'success', title: 'Done', message: 'all sent' });

  let res = await call('GET', '/api/notifications', { token: u.token });
  assert.equal(res.body.notifications.length, 2);
  assert.equal(res.body.unread, 2);
  assert.equal((await call('GET', '/api/notifications/unread-count', { token: u.token })).body.unread, 2);

  res = await call('POST', '/api/notifications/read', { token: u.token, json: { id: String(first._id) } });
  assert.equal(res.body.unread, 1);
  res = await call('POST', '/api/notifications/read', { token: u.token, json: { all: true } });
  assert.equal(res.body.unread, 0);
  assert.equal((await call('POST', '/api/notifications/read', { token: u.token, json: {} })).status, 400);

  const other = await newUser();
  assert.equal((await call('GET', '/api/notifications', { token: other.token })).body.notifications.length, 0, 'alerts are private');

  res = await call('DELETE', '/api/notifications', { token: u.token });
  assert.equal((await call('GET', '/api/notifications', { token: u.token })).body.notifications.length, 0);
});

// ---------------------------------------------------------------- engine events (what feeds the alerts)

/** Run the dispatcher by hand, pretending waiting time has passed, until the campaign reaches `until`. */
async function drive(engine, campaignId, until, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await Recipient.updateMany({ campaignId, status: 'pending', scheduledFor: { $ne: null } }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
    await engine.tick();
    const c = await Campaign.findById(campaignId).lean();
    if (until(c)) return c;
    if (Date.now() > deadline) assert.fail(`timed out: campaign is "${c.status}"`);
    await sleep(30);
  }
}

const channelWith = (deliver) => ({
  name: 'whatsapp',
  Campaign,
  Recipient,
  contactField: 'phone',
  limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0 },
  deliver,
});
const fields = { name: 'events', template: 'hi' };
const contacts = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9190001${String(i).padStart(5, '0')}` }));

test('engine events: "completed" is announced once with the totals, "paused" only for automatic pauses', T, async () => {
  const userId = new mongoose.Types.ObjectId();
  const seen = { completed: [], paused: [] };
  const onCompleted = (e) => seen.completed.push(e);
  const onPaused = (e) => seen.paused.push(e);
  engineEvents.on('completed', onCompleted);
  engineEvents.on('paused', onPaused);
  try {
    // finishes normally
    const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));
    const c = await engine.createCampaign({ userId, fields, contacts: contacts(2) });
    await drive(engine, c._id, (x) => x.status === 'completed');
    await waitFor(() => seen.completed.some((e) => e.campaignId === String(c._id)));
    await sleep(150); // a second, duplicate announcement would have arrived by now
    const done = seen.completed.filter((e) => e.campaignId === String(c._id));
    assert.equal(done.length, 1);
    assert.deepEqual([done[0].sent, done[0].failed, done[0].total, done[0].channel], [2, 0, 2, 'whatsapp']);
    assert.equal(done[0].userId, String(userId));

    // a user's own pause is silent; pauseAllForUser reports how many it paused and is silent too (the caller sends the alert)
    const c2 = await engine.createCampaign({ userId, fields, contacts: contacts(2) });
    assert.equal(await engine.pauseAllForUser(userId, 'WhatsApp disconnected'), 1);
    assert.equal(await engine.pauseAllForUser(userId, 'again'), 0, 'nothing left to pause');
    assert.equal(seen.paused.filter((e) => e.campaignId === String(c2._id)).length, 0);
    await engine.cancel(userId, c2._id);

    // an automatic pause (several failures in a row) is announced with its reason
    const failing = createEngine(channelWith(async () => ({ outcome: 'failed', error: 'boom' })));
    const c3 = await failing.createCampaign({ userId, fields, contacts: contacts(10) });
    await drive(failing, c3._id, (x) => x.status === 'paused');
    await waitFor(() => seen.paused.some((e) => e.campaignId === String(c3._id)));
    await sleep(150);
    const paused = seen.paused.filter((e) => e.campaignId === String(c3._id));
    assert.equal(paused.length, 1);
    assert.match(paused[0].reason, /failures in a row/);
    assert.equal(paused[0].campaignName, 'events');

    assert.equal(await failing.remainingToday(userId), 1000 - (await Recipient.countDocuments({ userId, createdAt: { $gte: new Date(Date.now() - 86_400_000) }, status: { $in: ['pending', 'sending', 'sent'] } })));
  } finally {
    engineEvents.off('completed', onCompleted);
    engineEvents.off('paused', onPaused);
    await Promise.all([Recipient.deleteMany({ userId }), Campaign.deleteMany({ userId })]);
  }
});
