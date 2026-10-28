import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// "Send again to the people who were not reached", against a THROW-AWAY MongoDB database (name must contain "test").
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = '';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { User, SmtpSettings, EmailCampaign, EmailRecipient, EmailOptOut } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `rsd${Date.now().toString(36)}`;
const made = [];
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
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    EmailOptOut.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}
const say = (r) => JSON.stringify(r.body);

async function emailUser() {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const u = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  made.push(u);
  const fromEmail = `from.${tag}.${counter}@example.com`;
  const saved = await call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail, fromName: 'Me' } });
  assert.equal(saved.status, 200, say(saved));
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { verifiedEmail: fromEmail, verifiedAt: new Date() } });
  return u;
}

const addr = (i) => `p${i}.${tag}@example.com`;

/** A finished campaign of 9 people:
 *  p0,p1 sent | p2,p3 failed | p4 failed but maybe delivered | p5,p6 cancelled before sending | p7 opted out | p8 sent */
async function finishedCampaign(u, { status = 'completed' } = {}) {
  const fd = new FormData();
  fd.append('name', 'Spring');
  fd.append('subject', 'Hi {{name}}');
  fd.append('body', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  const rows = Array.from({ length: 9 }, (_, i) => `P${i},${addr(i)}`);
  fd.append('file', new Blob([`name,email\n${rows.join('\n')}\n`], { type: 'text/csv' }), 'c.csv');
  const res = await call('POST', '/api/email/campaigns', { token: u.token, form: fd });
  assert.equal(res.status, 201, say(res));
  const id = res.body.campaign._id;
  const set = (emails, $set) => EmailRecipient.updateMany({ campaignId: id, email: { $in: emails.map(addr) } }, { $set });
  await set([0, 1, 8], { status: 'sent', sentAt: new Date() });
  await set([2, 3], { status: 'failed', error: 'mailbox full' });
  await set([4], { status: 'failed', error: 'timeout', ambiguous: true });
  await set([5, 6], { status: 'skipped', error: 'cancelled' });
  await set([7], { status: 'skipped', error: 'opted out' });
  if (status) await EmailCampaign.updateOne({ _id: id }, { $set: { status, finishedAt: new Date() } });
  return id;
}

const resend = (u, id, json = {}) => call('POST', `/api/email/campaigns/${id}/resend`, { token: u.token, json });
const emailsOf = async (id) => (await EmailRecipient.find({ campaignId: id }).lean()).map((r) => r.email).sort();

test('a campaign that is still running cannot be sent again', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u, { status: 'running' });
  const res = await resend(u, id);
  assert.equal(res.status, 409, say(res));
  assert.match(res.body.error, /Retry failed/);
});

test('the detail page says how many could be sent again', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  const detail = await call('GET', `/api/email/campaigns/${id}`, { token: u.token });
  assert.deepEqual(detail.body.campaign.resendable, { failed: 2, maybe: 1, unsent: 2 });
  const running = await finishedCampaign(u, { status: 'running' });
  const live = await call('GET', `/api/email/campaigns/${running}`, { token: u.token });
  assert.equal(live.body.campaign.resendable, undefined);
});

test('"both" sends to the failed and the never-tried, copies the message, leaves the original alone', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  const res = await resend(u, id);
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.summary.queued, 4);
  assert.equal(res.body.campaign.name, 'Spring (again)');
  assert.equal(res.body.campaign.subject, 'Hi {{name}}');
  assert.equal(res.body.campaign.body, 'Hello {{name}}');
  assert.equal(res.body.campaign.status, 'running');
  assert.deepEqual(await emailsOf(res.body.campaign._id), [2, 3, 5, 6].map(addr).sort());
  const original = await EmailCampaign.findById(id).lean();
  assert.equal(original.status, 'completed');
  assert.equal(await EmailRecipient.countDocuments({ campaignId: id, status: 'sent' }), 3);
});

test('"maybe delivered" people are only included when asked for', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  const res = await resend(u, id, { who: 'failed', includeMaybeDelivered: true, name: 'Second try' });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.campaign.name, 'Second try');
  assert.deepEqual(await emailsOf(res.body.campaign._id), [2, 3, 4].map(addr).sort());
});

test('"unsent" only picks people the cancelled campaign never reached', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u, { status: 'cancelled' });
  const res = await resend(u, id, { who: 'unsent' });
  assert.equal(res.status, 201, say(res));
  assert.deepEqual(await emailsOf(res.body.campaign._id), [5, 6].map(addr).sort());
});

test('people who unsubscribed since the first round are left out', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  await EmailOptOut.create({ userId: u.id, email: addr(2), reason: 'unsubscribed' });
  const res = await resend(u, id, { who: 'failed' });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.summary.queued, 1);
  assert.equal(res.body.summary.optedOutSkipped, 1);
  assert.deepEqual(await emailsOf(res.body.campaign._id), [addr(3)]);
});

test('bad input, nobody left, and other people\'s campaigns are refused', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  assert.equal((await resend(u, id, { who: 'everyone' })).status, 400);
  assert.equal((await resend(u, id, { who: 'failed', startAt: 'tomorrow-ish' })).status, 400);
  await EmailRecipient.updateMany({ campaignId: id }, { $set: { status: 'sent', error: null, ambiguous: false } });
  const none = await resend(u, id);
  assert.equal(none.status, 400, say(none));
  assert.match(none.body.error, /nobody/i);

  const other = await emailUser();
  const theirs = await resend(other, id);
  assert.equal(theirs.status, 404, say(theirs));
  assert.equal((await EmailCampaign.countDocuments({ userId: other.id })), 0);
});

test('the daily limit still applies', T, async () => {
  const u = await emailUser();
  const id = await finishedCampaign(u);
  const before = config.emailDailyCap;
  config.emailDailyCap = 3; // the original used 9 already, anything more is over the limit
  try {
    const res = await resend(u, id, { who: 'failed' });
    assert.equal(res.status, 429, say(res));
  } finally {
    config.emailDailyCap = before;
  }
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), 1);
});
