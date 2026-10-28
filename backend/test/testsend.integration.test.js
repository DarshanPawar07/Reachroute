import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Test emails (a preview sent to the account's own address), against a THROW-AWAY MongoDB database (name must contain "test").
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
const { User, SmtpSettings, EmailCampaign, EmailRecipient, Attachment } = models;
const { primeSenderForTests } = await import('../src/email/mailer.js');

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
    Attachment.deleteMany({ userId: { $in: ids } }),
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


/** A user whose outgoing mail is captured in memory instead of going to an SMTP server. */
async function userWithMailbox({ failWith } = {}) {
  const u = await newUser();
  const sent = [];
  primeSenderForTests(u.id, {
    async sendMail(mail) {
      if (failWith) throw failWith;
      sent.push(mail);
    },
  });
  return { ...u, sent };
}

const post = (u, json) => call('POST', '/api/email/campaigns/test', { token: u.token, json });
const good = { subject: 'Hi {{name}}', body: 'Hello {{name}}, our offer is live.' };

test('a test email goes only to the account owner, marked as a test, with a working unsubscribe link', T, async () => {
  const u = await userWithMailbox();
  const res = await post(u, { ...good, sampleName: 'Asha' });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.sentTo, u.email);
  assert.equal(res.body.sent, 1);
  assert.equal(u.sent.length, 1);
  const mail = u.sent[0];
  assert.equal(mail.to, u.email);
  assert.equal(mail.subject, '[Test] Hi Asha');
  assert.match(mail.text, /Hello Asha, our offer is live\./);
  assert.match(mail.text, /Unsubscribe: .*\/unsubscribe\//);
  assert.match(mail.html, /Unsubscribe/);
  // nothing was created or counted
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), 0);
  assert.equal(await EmailRecipient.countDocuments({ userId: u.id }), 0);
});

test('the person to send to cannot be chosen: a "to" in the request is ignored', T, async () => {
  const u = await userWithMailbox();
  const res = await post(u, { ...good, to: 'victim@example.com', email: 'victim@example.com' });
  assert.equal(res.status, 200, say(res));
  assert.equal(u.sent.length, 1);
  assert.equal(u.sent[0].to, u.email);
});

test('with two subject lines, one test email is sent per version', T, async () => {
  const u = await userWithMailbox();
  const res = await post(u, { ...good, subjectB: 'Offer for {{name}}', splitB: 50 });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.sent, 2);
  assert.deepEqual(u.sent.map((m) => m.subject), ['[Test, subject A] Hi Test name', '[Test, subject B] Offer for Test name']);
});

test('html bodies are sanitised like a real campaign', T, async () => {
  const u = await userWithMailbox();
  const res = await post(u, { subject: 'S', body: '<p>Hi <b>{{name}}</b></p><script>alert(1)</script>', bodyFormat: 'html' });
  assert.equal(res.status, 200, say(res));
  assert.doesNotMatch(u.sent[0].html, /<script/);
  assert.match(u.sent[0].html, /<b>Test name<\/b>/);
});

test('columns that come from the contact file are reported as blank in the test', T, async () => {
  const u = await userWithMailbox();
  const res = await post(u, { subject: 'Hi', body: 'Hello {{name}}, news from {{city}} and {{shop|our shop}}.' });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.notFilled.sort(), ['city', 'shop']);
});

test('attachments are included in the test email', T, async () => {
  const u = await userWithMailbox();
  const fd = new FormData();
  fd.append('file', new Blob(['name,email\nA,a@example.com\n'], { type: 'text/csv' }), 'list.csv');
  const up = await call('POST', '/api/attachments', { token: u.token, form: fd });
  assert.equal(up.status, 201, say(up));
  const id = up.body.attachment._id || up.body.attachment.id;
  const res = await post(u, { ...good, attachmentIds: [id] });
  assert.equal(res.status, 200, say(res));
  assert.equal(u.sent[0].attachments.length, 1);
  assert.equal(u.sent[0].attachments[0].filename, 'list.csv');
});

test("another account's attachment cannot be used", T, async () => {
  const owner = await userWithMailbox();
  const other = await userWithMailbox();
  const fd = new FormData();
  fd.append('file', new Blob(['x,y\n1,2\n'], { type: 'text/csv' }), 'mine.csv');
  const up = await call('POST', '/api/attachments', { token: owner.token, form: fd });
  const id = up.body.attachment._id || up.body.attachment.id;
  const res = await post(other, { ...good, attachmentIds: [id] });
  assert.equal(res.status, 404, say(res));
  assert.equal(other.sent.length, 0);
});

test('missing or broken input is refused and nothing is sent', T, async () => {
  const u = await userWithMailbox();
  for (const json of [{ body: 'x' }, { subject: 'x' }, { subject: 'x', body: 'Hi {{first-name}}' }, { subject: 'x'.repeat(201), body: 'x' }]) {
    const res = await post(u, json);
    assert.equal(res.status, 400, say(res));
  }
  assert.equal(u.sent.length, 0);
});

test('without email settings the user is told to add them', T, async () => {
  const u = await newUser();
  const res = await post(u, good);
  assert.equal(res.status, 409, say(res));
  assert.match(res.body.error, /settings/i);
});

test('a mail server failure is explained, not hidden', T, async () => {
  const u = await userWithMailbox({ failWith: Object.assign(new Error('auth'), { code: 'EAUTH', responseCode: 535 }) });
  const res = await post(u, good);
  assert.equal(res.status, 422, say(res));
  assert.match(res.body.error, /test email could not be sent/i);
});
