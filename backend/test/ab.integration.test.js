import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// A/B subject lines, against a THROW-AWAY MongoDB database (name must contain "test").
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
const { User, SmtpSettings, EmailCampaign, EmailRecipient } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `rep${Date.now().toString(36)}`;
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
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8'); // unlike res.text(), this keeps a byte order mark
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text, headers: res.headers };
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

async function emailUser() {
  const u = await newUser();
  const fromEmail = `from.${tag}.${counter}@example.com`;
  const saved = await call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail, fromName: 'Me' } });
  assert.equal(saved.status, 200, say(saved));
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { verifiedEmail: fromEmail, verifiedAt: new Date() } });
  return u;
}

const startCampaign = (u, name, rows, extra = {}) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('subject', 'Hi {{name}}');
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  fd.append('body', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob([`name,email\n${rows.join('\n')}\n`], { type: 'text/csv' }), 'c.csv');
  return call('POST', '/api/email/campaigns', { token: u.token, form: fd });
};

const people = (n) => Array.from({ length: n }, (_, i) => `P${i},p${i}.${tag}@example.com`);

test('two subjects split the list as asked, and each person keeps their version', T, async () => {
  const u = await emailUser();
  const res = await startCampaign(u, 'AB', people(10), { subjectB: 'Offer for {{name}}', splitB: '30' });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.campaign.subjectB, 'Offer for {{name}}');
  assert.equal(res.body.campaign.splitB, 30);
  const rows = await EmailRecipient.find({ campaignId: res.body.campaign._id }).lean();
  assert.equal(rows.filter((r) => r.variant === 'B').length, 3);
  assert.equal(rows.filter((r) => r.variant === 'A').length, 7);

  await EmailRecipient.updateMany({ campaignId: res.body.campaign._id, variant: 'A' }, { $set: { status: 'sent' } });
  await EmailRecipient.updateOne({ campaignId: res.body.campaign._id, variant: 'B' }, { $set: { status: 'sent', feedback: 'bounced' } });
  const detail = await call('GET', `/api/email/campaigns/${res.body.campaign._id}`, { token: u.token });
  assert.equal(detail.status, 200, say(detail));
  assert.equal(detail.body.campaign.variants.A.people, 7);
  assert.equal(detail.body.campaign.variants.A.sent, 7);
  assert.equal(detail.body.campaign.variants.B.people, 3);
  assert.equal(detail.body.campaign.variants.B.sent, 1);
  assert.equal(detail.body.campaign.variants.B.bounced, 1);
  assert.ok(detail.body.recipients.every((r) => r.variant === 'A' || r.variant === 'B'));

  const csv = await call('GET', `/api/email/campaigns/${res.body.campaign._id}/report.csv`, { token: u.token });
  const lines = csv.text.replace(/^\uFEFF/, '').split('\r\n').filter(Boolean);
  assert.match(lines[0], /,Subject version$/);
  assert.equal(lines.filter((l) => l.endsWith(',B')).length, 3);
});

test('without a second subject there is no test', T, async () => {
  const u = await emailUser();
  const res = await startCampaign(u, 'Plain', people(4));
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.campaign.subjectB, '');
  const rows = await EmailRecipient.find({ campaignId: res.body.campaign._id }).lean();
  assert.ok(rows.every((r) => r.variant === null));
  const detail = await call('GET', `/api/email/campaigns/${res.body.campaign._id}`, { token: u.token });
  assert.equal(detail.body.campaign.variants, undefined);
});

test('wrong A/B input is refused and creates nothing', T, async () => {
  const u = await emailUser();
  const before = await EmailCampaign.countDocuments({ userId: u.id });
  for (const extra of [{ subjectB: 'hi {{name}}' }, { subjectB: 'Other', splitB: '0' }, { subjectB: 'Other', splitB: '100' }, { subjectB: 'Other', splitB: 'x' }, { subjectB: 'Hello {{nope}}' }]) {
    const res = await startCampaign(u, 'Bad', people(3), extra);
    assert.equal(res.status, 400, `${JSON.stringify(extra)} ${say(res)}`);
  }
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), before);
});
