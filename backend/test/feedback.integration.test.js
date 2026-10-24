import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Tests for email bounce / spam-complaint webhooks and the "never email again" list. They run against a THROW-AWAY
// MongoDB database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
// Nothing is sent and no provider is contacted: notices are posted to the app directly.
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
const { emailChannel } = await import('../src/engine/channels.js');
const { signUnsubscribe } = await import('../src/utils/unsubscribeToken.js');
const { EmailCampaign, EmailRecipient, EmailOptOut, Notification, User } = models;

let server;
let base;
const accounts = [];

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
  const ids = accounts.map((a) => a.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    EmailOptOut.deleteMany({ userId: { $in: ids } }),
    Notification.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

const T = { skip, timeout: 30_000 };
const DAY = 24 * 60 * 60_000;

async function call(method, path, { token, json, raw, type = 'application/json' } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (raw !== undefined) {
    headers['Content-Type'] = type;
    body = raw;
  } else if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(base + path, { method, headers, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (res) => JSON.stringify(res.body);

async function newAccount() {
  const email = `f-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: 'correct horse battery' } });
  assert.equal(res.status, 201, say(res));
  const account = { token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  accounts.push(account);
  return account;
}

/** The part of the webhook address after /hooks/email/ */
const keyOf = (url) => url.split('/hooks/email/')[1];
const hookPath = (url) => `/hooks/email/${keyOf(url)}`;

async function withWebhook() {
  const u = await newAccount();
  const created = await call('POST', '/api/email/feedback/key', { token: u.token });
  assert.equal(created.status, 201, say(created));
  return { ...u, url: created.body.webhookUrl, path: hookPath(created.body.webhookUrl) };
}

/** A campaign that emailed these addresses. */
async function campaignTo(userId, addresses) {
  const campaign = await EmailCampaign.create({ userId, name: 'Newsletter', subject: 's', body: 'b', status: 'completed' });
  const now = new Date();
  await EmailRecipient.collection.insertMany(
    addresses.map((email) => ({ userId, campaignId: campaign._id, email, name: '', status: 'sent', sentAt: now, createdAt: now, updatedAt: now, deferCount: 0, ambiguous: false, feedback: null }))
  );
  return campaign;
}

const reasonOf = async (userId, email) => (await EmailOptOut.findOne({ userId, email }).lean())?.reason ?? null;
const feedbackOf = async (userId, email) => (await EmailRecipient.findOne({ userId, email }).sort({ sentAt: -1 }).lean())?.feedback ?? null;

// ---------------------------------------------------------------- the webhook address

test('the webhook address: create, show again, replace, remove', T, async () => {
  const u = await newAccount();
  const none = await call('GET', '/api/email/feedback', { token: u.token });
  assert.equal(none.status, 200, say(none));
  assert.equal(none.body.webhookUrl, null);
  assert.deepEqual(none.body.counts, { unsubscribed: 0, bounced: 0, complaint: 0 });
  assert.ok(none.body.providers.length >= 5);

  const first = await call('POST', '/api/email/feedback/key', { token: u.token });
  assert.equal(first.status, 201, say(first));
  assert.ok(first.body.webhookUrl.startsWith(`${config.publicUrl}/hooks/email/`));
  assert.match(keyOf(first.body.webhookUrl), /^[A-Za-z0-9_-]{32}$/);
  assert.equal((await call('GET', '/api/email/feedback', { token: u.token })).body.webhookUrl, first.body.webhookUrl, 'it can be shown again');
  assert.equal((await call('POST', hookPath(first.body.webhookUrl), { json: [] })).status, 200);

  const second = await call('POST', '/api/email/feedback/key', { token: u.token });
  assert.notEqual(second.body.webhookUrl, first.body.webhookUrl);
  assert.equal((await call('POST', hookPath(first.body.webhookUrl), { json: [] })).status, 404, 'the old address stopped working');
  assert.equal((await call('POST', hookPath(second.body.webhookUrl), { json: [] })).status, 200);

  const removed = await call('DELETE', '/api/email/feedback/key', { token: u.token });
  assert.equal(removed.body.webhookUrl, null);
  assert.equal((await call('POST', hookPath(second.body.webhookUrl), { json: [] })).status, 404);
  assert.equal((await call('GET', '/api/email/feedback', { token: u.token })).body.webhookUrl, null);
});

test('the secret is not stored in readable form', T, async () => {
  const u = await withWebhook();
  const stored = await User.findById(u.id).lean();
  assert.ok(stored.webhookKeyHash && stored.webhookKeyEnc);
  assert.ok(!JSON.stringify(stored).includes(keyOf(u.url)), 'the key itself is not in the database');
});

test('wrong, malformed or missing secrets get 404 and change nothing', T, async () => {
  for (const key of ['short', 'x'.repeat(32), 'has spaces in it xxxxxxxxxxxxxxxxxxxxxxx', `${'a'.repeat(31)}%00`, 'a'.repeat(200)]) {
    const res = await call('POST', `/hooks/email/${encodeURIComponent(key)}`, { json: [{ type: 'bounce', email: 'a@x.com' }] });
    assert.equal(res.status, 404, key);
  }
  assert.equal((await call('POST', '/hooks/email', { json: [] })).status, 404);
  assert.equal((await call('GET', hookPath('https://x/hooks/email/' + 'a'.repeat(32)))).status, 404, 'only POST is accepted');
});

test('the management endpoints need a login', T, async () => {
  for (const [method, path] of [['GET', '/api/email/feedback'], ['POST', '/api/email/feedback/key'], ['DELETE', '/api/email/feedback/key'], ['GET', '/api/email/feedback/suppressed']]) {
    assert.equal((await call(method, path)).status, 401, `${method} ${path}`);
  }
});

// ---------------------------------------------------------------- receiving notices

test('SendGrid notice: bounces, complaints and unsubscribes stop future emails and show in the campaign', T, async () => {
  const u = await withWebhook();
  const campaign = await campaignTo(u.id, ['gone@x.com', 'angry@x.com', 'leaving@x.com', 'fine@x.com', 'full@x.com']);

  const res = await call('POST', u.path, {
    json: [
      { event: 'bounce', email: 'gone@x.com', type: 'bounce', reason: '550 5.1.1 user unknown' },
      { event: 'spamreport', email: 'Angry@X.com' },
      { event: 'unsubscribe', email: 'leaving@x.com' },
      { event: 'delivered', email: 'fine@x.com' },
      { event: 'bounce', email: 'full@x.com', type: 'blocked', reason: 'mailbox full' },
    ],
  });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual({ ok: res.body.ok, received: res.body.received, stopped: res.body.stopped }, { ok: true, received: 3, stopped: 3 });

  assert.equal(await reasonOf(u.id, 'gone@x.com'), 'bounced');
  assert.equal(await reasonOf(u.id, 'angry@x.com'), 'complaint');
  assert.equal(await reasonOf(u.id, 'leaving@x.com'), 'unsubscribed');
  assert.equal(await reasonOf(u.id, 'fine@x.com'), null);
  assert.equal(await reasonOf(u.id, 'full@x.com'), null, 'a temporary block is not a reason to stop');
  assert.match((await EmailOptOut.findOne({ userId: u.id, email: 'gone@x.com' })).detail, /user unknown/);

  assert.equal(await feedbackOf(u.id, 'gone@x.com'), 'bounced');
  assert.equal(await feedbackOf(u.id, 'angry@x.com'), 'complaint');
  assert.equal(await feedbackOf(u.id, 'leaving@x.com'), 'unsubscribed');
  assert.equal(await feedbackOf(u.id, 'fine@x.com'), null);

  const detail = await call('GET', `/api/email/campaigns/${campaign._id}`, { token: u.token });
  assert.deepEqual(detail.body.campaign.feedback, { bounced: 1, complaint: 1, unsubscribed: 1 });
  assert.equal(detail.body.recipients.find((r) => r.email === 'angry@x.com').feedback, 'complaint');
  assert.equal(detail.body.recipients.find((r) => r.email === 'fine@x.com').feedback, null);

  const alerts = await Notification.find({ userId: u.id, type: 'email_complaint' }).lean();
  assert.equal(alerts.length, 1, 'one alert about the spam complaint');
  assert.match(alerts[0].title, /1 person marked your email as spam/);

  const stats = await call('GET', '/api/stats', { token: u.token });
  assert.deepEqual([stats.body.optOuts.emailBounced, stats.body.optOuts.emailComplaints, stats.body.optOuts.emailUnsubscribed], [1, 1, 1]);
  const summary = await call('GET', '/api/email/feedback', { token: u.token });
  assert.deepEqual(summary.body.counts, { unsubscribed: 1, bounced: 1, complaint: 1 });
  assert.deepEqual(summary.body.recent.map((r) => r.email).sort(), ['angry@x.com', 'gone@x.com']);
});

test('the same notice twice changes nothing and does not alert twice', T, async () => {
  const u = await withWebhook();
  await campaignTo(u.id, ['a@x.com', 'b@x.com']);
  const notice = [{ event: 'bounce', email: 'a@x.com', type: 'bounce' }, { event: 'spamreport', email: 'b@x.com' }];
  assert.equal((await call('POST', u.path, { json: notice })).status, 200);
  assert.equal((await call('POST', u.path, { json: notice })).status, 200);
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 2);
  assert.equal(await Notification.countDocuments({ userId: u.id, type: 'email_complaint' }), 1);
});

test('a spam complaint outranks an earlier unsubscribe or bounce, and nothing lowers it again', T, async () => {
  const u = await withWebhook();
  await campaignTo(u.id, ['x@x.com', 'y@x.com']);
  await EmailOptOut.create({ userId: u.id, email: 'x@x.com', reason: 'unsubscribed' });
  await EmailOptOut.create({ userId: u.id, email: 'y@x.com', reason: 'bounced' });

  await call('POST', u.path, { json: [{ type: 'complaint', email: 'x@x.com', reason: 'abuse' }, { type: 'complaint', email: 'y@x.com' }] });
  assert.equal(await reasonOf(u.id, 'x@x.com'), 'complaint');
  assert.equal(await reasonOf(u.id, 'y@x.com'), 'complaint');
  assert.equal((await EmailOptOut.findOne({ userId: u.id, email: 'x@x.com' })).detail, 'abuse');
  assert.equal(await feedbackOf(u.id, 'x@x.com'), 'complaint');

  await call('POST', u.path, { json: [{ type: 'bounce', email: 'x@x.com' }, { type: 'unsubscribe', email: 'y@x.com' }] });
  assert.equal(await reasonOf(u.id, 'x@x.com'), 'complaint');
  assert.equal(await reasonOf(u.id, 'y@x.com'), 'complaint');
  assert.equal(await feedbackOf(u.id, 'x@x.com'), 'complaint', 'the campaign still shows the complaint');
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 2);
});

test('an address that was never emailed is still stopped (it may have been emailed outside the app)', T, async () => {
  const u = await withWebhook();
  const res = await call('POST', u.path, { json: { type: 'bounce', email: 'stranger@x.com' } });
  assert.equal(res.status, 200);
  assert.equal(await reasonOf(u.id, 'stranger@x.com'), 'bounced');
});

test('Amazon SES through SNS: JSON sent as text/plain, bounces and complaints', T, async () => {
  const u = await withWebhook();
  await campaignTo(u.id, ['ses1@x.com', 'ses2@x.com', 'ses3@x.com']);
  const bounce = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Permanent', bouncedRecipients: [{ emailAddress: 'ses1@x.com' }] } }) };
  const soft = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Bounce', bounce: { bounceType: 'Transient', bouncedRecipients: [{ emailAddress: 'ses3@x.com' }] } }) };
  const complaint = { Type: 'Notification', Message: JSON.stringify({ notificationType: 'Complaint', complaint: { complainedRecipients: [{ emailAddress: 'ses2@x.com' }] } }) };
  for (const n of [bounce, soft, complaint]) {
    const res = await call('POST', u.path, { raw: JSON.stringify(n), type: 'text/plain; charset=UTF-8' });
    assert.equal(res.status, 200, say(res));
  }
  assert.equal(await reasonOf(u.id, 'ses1@x.com'), 'bounced');
  assert.equal(await reasonOf(u.id, 'ses2@x.com'), 'complaint');
  assert.equal(await reasonOf(u.id, 'ses3@x.com'), null);
});

test('SNS subscription confirmation: a link that is not Amazon\'s is never opened', T, async () => {
  const u = await withWebhook();
  const res = await call('POST', u.path, { raw: JSON.stringify({ Type: 'SubscriptionConfirmation', SubscribeURL: 'https://evil.test/confirm' }), type: 'text/plain' });
  assert.equal(res.status, 200, say(res));
  assert.ok(!res.body.subscriptionConfirmed);
  const local = await call('POST', u.path, { json: { Type: 'SubscriptionConfirmation', SubscribeURL: 'http://127.0.0.1:1/' } });
  assert.equal(local.body.subscriptionConfirmed, undefined, 'not even attempted');
});

test('other providers: Mailgun, Postmark, Resend', T, async () => {
  const u = await withWebhook();
  await campaignTo(u.id, ['mg@x.com', 'pm@x.com', 'rs@x.com']);
  await call('POST', u.path, { json: { signature: { token: 't' }, 'event-data': { event: 'failed', severity: 'permanent', recipient: 'mg@x.com' } } });
  await call('POST', u.path, { json: { RecordType: 'SpamComplaint', Email: 'pm@x.com' } });
  await call('POST', u.path, { json: { type: 'email.bounced', data: { to: ['rs@x.com'], bounce: { type: 'Permanent' } } } });
  assert.deepEqual([await reasonOf(u.id, 'mg@x.com'), await reasonOf(u.id, 'pm@x.com'), await reasonOf(u.id, 'rs@x.com')], ['bounced', 'complaint', 'bounced']);
});

test('notices we cannot use are accepted quietly; broken JSON is refused', T, async () => {
  const u = await withWebhook();
  for (const json of [[], {}, { hello: 'world' }, [{ event: 'open', email: 'a@x.com' }], { type: 'bounce', email: 'not an address' }]) {
    const res = await call('POST', u.path, { json });
    assert.equal(res.status, 200, JSON.stringify(json));
  }
  assert.equal((await call('POST', u.path)).status, 200, 'an empty request');
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 0);
  const broken = await call('POST', u.path, { raw: '{"type": "bounce", ', type: 'application/json' });
  assert.equal(broken.status, 400);
  assert.equal((await call('POST', u.path, { raw: '"just text"' })).status, 400, 'JSON that is not an object or a list');
});

test('a big batch is handled, and one account\'s notice never touches another account', T, async () => {
  const a = await withWebhook();
  const b = await withWebhook();
  await campaignTo(a.id, ['shared@x.com']);
  await campaignTo(b.id, ['shared@x.com']);
  const batch = Array.from({ length: 600 }, (_, i) => ({ event: 'bounce', type: 'bounce', email: `bulk${i}@x.com` }));
  batch.push({ event: 'spamreport', email: 'shared@x.com' });
  const res = await call('POST', a.path, { json: batch });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.stopped, 601);
  assert.equal(await EmailOptOut.countDocuments({ userId: a.id }), 601);
  assert.equal(await EmailOptOut.countDocuments({ userId: b.id }), 0);
  assert.equal(await feedbackOf(b.id, 'shared@x.com'), null);
  assert.equal(await feedbackOf(a.id, 'shared@x.com'), 'complaint');
});

// ---------------------------------------------------------------- effects on sending and unsubscribing

test('sending skips stopped addresses and says why', T, async () => {
  const u = await newAccount();
  await EmailOptOut.create([
    { userId: u.id, email: 'b@x.com', reason: 'bounced' },
    { userId: u.id, email: 'c@x.com', reason: 'complaint' },
    { userId: u.id, email: 'u@x.com', reason: 'unsubscribed' },
  ]);
  const skip = async (email) => emailChannel.deliver({ campaign: {}, recipient: { userId: u.id, email } });
  assert.deepEqual(await skip('b@x.com'), { outcome: 'skipped', reason: 'address bounced before' });
  assert.deepEqual(await skip('c@x.com'), { outcome: 'skipped', reason: 'reported an earlier email as spam' });
  assert.deepEqual(await skip('u@x.com'), { outcome: 'skipped', reason: 'unsubscribed' });
});

test('a stopped address is left out of a new campaign\'s list', T, async () => {
  const u = await newAccount();
  await EmailOptOut.create({ userId: u.id, email: 'c@x.com', reason: 'complaint' });
  const { allowed, skipped } = await emailChannel.filterOptOuts(u.id, [{ email: 'c@x.com' }, { email: 'ok@x.com' }]);
  assert.deepEqual(allowed.map((c) => c.email), ['ok@x.com']);
  assert.equal(skipped, 1);
});

test('unsubscribing through the link shows in the campaign results too', T, async () => {
  const u = await newAccount();
  const campaign = await campaignTo(u.id, ['reader@x.com']);
  const token = signUnsubscribe({ userId: u.id, email: 'reader@x.com' });
  const res = await fetch(`${base}/unsubscribe/${token}`, { method: 'POST' });
  assert.equal(res.status, 200);
  assert.equal(await reasonOf(u.id, 'reader@x.com'), 'unsubscribed');
  assert.equal(await feedbackOf(u.id, 'reader@x.com'), 'unsubscribed');
  const detail = await call('GET', `/api/email/campaigns/${campaign._id}`, { token: u.token });
  assert.deepEqual(detail.body.campaign.feedback, { unsubscribed: 1 });
});

test('a WhatsApp campaign detail still works and shows no email feedback', T, async () => {
  const u = await newAccount();
  const c = await models.Campaign.create({ userId: u.id, name: 'wa', template: 'hi', status: 'completed' });
  const res = await call('GET', `/api/whatsapp/campaigns/${c._id}`, { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.campaign.feedback, {});
  await models.Campaign.deleteOne({ _id: c._id });
});

// ---------------------------------------------------------------- the list of stopped addresses

test('the stopped list: filter, page, and what can be removed', T, async () => {
  const u = await newAccount();
  const t = Date.now();
  await EmailOptOut.collection.insertMany([
    { userId: u.id, email: 'old-bounce@x.com', reason: 'bounced', detail: '', createdAt: new Date(t - 3 * DAY), updatedAt: new Date() },
    { userId: u.id, email: 'unsub@x.com', reason: 'unsubscribed', detail: '', createdAt: new Date(t - 2 * DAY), updatedAt: new Date() },
    { userId: u.id, email: 'spam@x.com', reason: 'complaint', detail: 'abuse', createdAt: new Date(t - DAY), updatedAt: new Date() },
  ]);
  const get = (q = '') => call('GET', `/api/email/feedback/suppressed${q}`, { token: u.token });

  const all = await get();
  assert.deepEqual(all.body.addresses.map((a) => a.email), ['spam@x.com', 'unsub@x.com', 'old-bounce@x.com'], 'newest first');
  assert.equal(all.body.nextBefore, null);
  assert.deepEqual((await get('?reason=complaint')).body.addresses.map((a) => a.email), ['spam@x.com']);
  assert.equal((await get('?reason=complaint')).body.addresses[0].detail, 'abuse');

  const page1 = await get('?limit=2');
  assert.equal(page1.body.addresses.length, 2);
  assert.ok(page1.body.nextBefore);
  const page2 = await get(`?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`);
  assert.deepEqual(page2.body.addresses.map((a) => a.email), ['old-bounce@x.com']);

  assert.equal((await get('?reason=nonsense')).status, 400);
  assert.equal((await get('?before=soon')).status, 400);

  const byEmail = Object.fromEntries(all.body.addresses.map((a) => [a.email, a._id]));
  const del = (id) => call('DELETE', `/api/email/feedback/suppressed/${id}`, { token: u.token });
  assert.equal((await del(byEmail['spam@x.com'])).status, 409, 'a spam complaint cannot be undone');
  assert.equal((await del(byEmail['unsub@x.com'])).status, 409, 'neither can an unsubscribe');
  assert.equal((await del(byEmail['old-bounce@x.com'])).status, 200, 'a bounce can');
  assert.equal(await reasonOf(u.id, 'old-bounce@x.com'), null);
  assert.equal((await del(byEmail['old-bounce@x.com'])).status, 404);
  assert.equal((await del('not-an-id')).status, 404);
});

test('nobody sees or removes another account\'s stopped addresses', T, async () => {
  const a = await newAccount();
  const b = await newAccount();
  const row = await EmailOptOut.create({ userId: a.id, email: 'private@x.com', reason: 'bounced' });
  assert.deepEqual((await call('GET', '/api/email/feedback/suppressed', { token: b.token })).body.addresses, []);
  assert.equal((await call('DELETE', `/api/email/feedback/suppressed/${row._id}`, { token: b.token })).status, 404);
  assert.equal(await reasonOf(a.id, 'private@x.com'), 'bounced');
  assert.equal((await call('GET', '/api/email/feedback', { token: b.token })).body.counts.bounced, 0);
});
