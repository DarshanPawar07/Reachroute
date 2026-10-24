import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// The CSV report of a campaign, against a THROW-AWAY MongoDB database (name must contain "test").
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

const startCampaign = (u, name, rows) => {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('subject', 'Hi');
  fd.append('body', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob([`name,email\n${rows.join('\n')}\n`], { type: 'text/csv' }), 'c.csv');
  return call('POST', '/api/email/campaigns', { token: u.token, form: fd });
};

test('the report lists every person, with a clear status and safe cells', T, async () => {
  const u = await emailUser();
  const rows = [`Asha,asha.${tag}@example.com`, `"Rao, Ravi",ravi.${tag}@example.com`, `"=HYPERLINK(""http://x"")",evil.${tag}@example.com`];
  const made1 = await startCampaign(u, 'Diwali offer 2026!', rows);
  assert.equal(made1.status, 201, say(made1));
  const id = made1.body.campaign._id;

  await EmailRecipient.updateOne({ campaignId: id, email: `asha.${tag}@example.com` }, { $set: { status: 'sent', sentAt: new Date('2026-10-23T04:30:00Z'), feedback: 'bounced' } });
  await EmailRecipient.updateOne({ campaignId: id, email: `ravi.${tag}@example.com` }, { $set: { status: 'failed', error: '550 mailbox, unavailable' } });

  const res = await call('GET', `/api/email/campaigns/${id}/report.csv`, { token: u.token });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="Diwali-offer-2026-\d{4}-\d{2}-\d{2}\.csv"$/);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(res.text.startsWith('﻿'), 'starts with the byte order mark');

  const lines = res.text.slice(1).split('\r\n').filter(Boolean);
  assert.equal(lines[0], 'Name,Email,Status,Detail,Sent at,After delivery');
  assert.equal(lines.length, 4);
  const byEmail = (email) => lines.find((l) => l.includes(email));
  assert.equal(byEmail(`asha.${tag}`), `Asha,asha.${tag}@example.com,sent,,2026-10-23T04:30:00.000Z,bounced`);
  assert.equal(byEmail(`ravi.${tag}`), `"Rao, Ravi",ravi.${tag}@example.com,failed,"550 mailbox, unavailable",,`);
  assert.ok(byEmail(`evil.${tag}`).startsWith(`"'=HYPERLINK(""http://x"")"`), 'a formula is not left to run');
  assert.match(byEmail(`evil.${tag}`), /,waiting,/);
});

test('only the owner can download a report, and only when signed in', T, async () => {
  const owner = await emailUser();
  const other = await newUser();
  const c = await startCampaign(owner, 'Private', [`a.${tag}@example.com`.replace(/^/, 'A,')]);
  const id = c.body.campaign._id;
  assert.equal((await call('GET', `/api/email/campaigns/${id}/report.csv`, { token: other.token })).status, 404);
  assert.equal((await call('GET', `/api/email/campaigns/${id}/report.csv`)).status, 401);
  assert.equal((await call('GET', `/api/email/campaigns/not-an-id/report.csv`, { token: owner.token })).status, 404);
  assert.equal((await call('GET', `/api/email/campaigns/507f1f77bcf86cd799439011/report.csv`, { token: owner.token })).status, 404);
});
