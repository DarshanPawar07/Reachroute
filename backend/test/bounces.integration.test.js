import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Reading bounce notices from a mailbox (a fake in-memory one), against a THROW-AWAY MongoDB database (name must contain "test").
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
const { User, SmtpSettings, EmailCampaign, EmailRecipient, EmailReply, EmailOptOut, ImapSettings, Notification } = models;
const imap = await import('../src/email/imap.js');

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `bnc${Date.now().toString(36)}`;
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
    EmailReply.deleteMany({ userId: { $in: ids } }),
    EmailOptOut.deleteMany({ userId: { $in: ids } }),
    ImapSettings.deleteMany({ userId: { $in: ids } }),
    Notification.deleteMany({ userId: { $in: ids } }),
  ]);
  imap.setImapClientFactory(null);
  imap.setMessageParser(null);
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


// A mailbox in memory. `box.mail` is the list of { uid, msg }; `box.fail` makes every call fail like a bad login.
function fakeMailbox({ uidValidity = 7 } = {}) {
  const box = { uidValidity, mail: [], fail: null, calls: 0, reads: [] };
  box.add = (msg) => {
    const uid = box.mail.length + 1;
    box.mail.push({ uid, msg });
    return uid;
  };
  imap.setImapClientFactory(async () => ({
    async test() {
      if (box.fail) throw box.fail;
      return { uidValidity: box.uidValidity, uidNext: box.mail.length + 1 };
    },
    async read({ uidValidity: seen, afterUid, limit }) {
      box.calls++;
      if (box.fail) throw box.fail;
      const state = { uidValidity: box.uidValidity, uidNext: box.mail.length + 1 };
      box.reads.push({ seen, afterUid });
      if (afterUid == null || seen !== box.uidValidity) return { ...state, baseline: true, messages: [] };
      const messages = box.mail.filter((m) => m.uid > afterUid).slice(0, limit).map((m) => ({ uid: m.uid, source: JSON.stringify(m.msg) }));
      return { ...state, baseline: false, messages };
    },
  }));
  return box;
}
imap.setMessageParser(async (source) => {
  const m = JSON.parse(source);
  if (m.bad) throw new Error('unreadable message');
  return { ...m, date: m.date ? new Date(m.date) : new Date(), headers: m.headers || {} };
});

const mail = (from, text, extra = {}) => ({ messageId: `<${tag}.${counter++}@mail>`, from: { address: from, name: '' }, subject: 'Re: Hi', text, ...extra });
const saveImap = (u) => call('PUT', '/api/email/imap', { token: u.token, json: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: 'mailbox-password' } });
const settingsOf = (u) => ImapSettings.findOne({ userId: u.id });

/** A user with a campaign whose people were all "sent". */
async function sentCampaign(extra = {}) {
  const u = await emailUser();
  const res = await call('POST', '/api/email/campaigns', {
    token: u.token,
    form: (() => {
      const fd = new FormData();
      fd.append('name', 'Replies');
      fd.append('subject', 'Hi {{name}}');
      for (const [k, v] of Object.entries(extra)) fd.append(k, v);
      fd.append('body', 'Hello');
      fd.append('consentConfirmed', 'true');
      fd.append('file', new Blob([`name,email\nAsha,asha.${tag}.${counter}@example.com\nBen,ben.${tag}.${counter}@example.com\n`], { type: 'text/csv' }), 'c.csv');
      return fd;
    })(),
  });
  assert.equal(res.status, 201, say(res));
  await EmailRecipient.updateMany({ campaignId: res.body.campaign._id }, { $set: { status: 'sent', sentAt: new Date() } });
  const rows = await EmailRecipient.find({ campaignId: res.body.campaign._id }).sort({ name: 1 }).lean();
  return { u, campaign: res.body.campaign, asha: rows[0], ben: rows[1] };
}


const dsnText = (who, status, diag, action = 'failed') =>
  `Reporting-MTA: dns; mx.example.net\r\n\r\nFinal-Recipient: rfc822; ${who}\r\nAction: ${action}\r\nStatus: ${status}\r\nDiagnostic-Code: smtp; ${diag}\r\n`;
const bounce = (who, status, diag, extra = {}) =>
  mail('mailer-daemon@googlemail.com', 'Delivery has failed to these recipients.', { subject: 'Delivery Status Notification (Failure)', dsn: dsnText(who, status, diag), headers: { 'content-type': 'multipart/report' }, ...extra });
const saveBouncesOnly = (u, bouncesOnly = true) =>
  call('PUT', '/api/email/imap', { token: u.token, json: { host: 'imap.example.com', port: 993, user: 'me@example.com', pass: 'mailbox-password', bouncesOnly } });
const check = (u) => call('POST', '/api/email/imap/check', { token: u.token });

test('a bounce notice for someone you emailed stops future email to them and marks the campaign', T, async () => {
  const { u, campaign, asha, ben } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveBouncesOnly(u)).status, 200);
  await check(u); // the starting point

  box.add(bounce(asha.email, '5.1.1', '550 5.1.1 The email account that you tried to reach does not exist.'));
  const res = await check(u);
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.bounces, 1);

  const stopped = await EmailOptOut.findOne({ userId: u.id, email: asha.email }).lean();
  assert.equal(stopped.reason, 'bounced');
  assert.match(stopped.detail, /does not exist/);
  assert.equal((await EmailRecipient.findById(asha._id).lean()).feedback, 'bounced');
  assert.equal((await EmailRecipient.findById(ben._id).lean()).feedback, null);
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 0, 'a bounce is not a reply');
  assert.ok(await Notification.findOne({ userId: u.id, type: 'email-bounces' }), 'the owner is told');

  const detail = await call('GET', `/api/email/campaigns/${campaign._id}`, { token: u.token });
  assert.equal(detail.body.campaign.feedback.bounced, 1);

  // read once only
  assert.equal((await check(u)).body.bounces, 0);
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 1);

  // and the address is skipped by the next campaign
  const fd = new FormData();
  fd.append('name', 'Next');
  fd.append('subject', 'Hi');
  fd.append('body', 'Hello');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob([`name,email\nAsha,${asha.email}\n`], { type: 'text/csv' }), 'c.csv');
  const next = await call('POST', '/api/email/campaigns', { token: u.token, form: fd });
  assert.equal(next.status, 400, say(next));
});

test('a bounce naming someone you never emailed changes nothing', T, async () => {
  const { u } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveBouncesOnly(u)).status, 200);
  await check(u);
  box.add(bounce(`never.${tag}@example.com`, '5.1.1', '550 user unknown'));
  const res = await check(u);
  assert.equal(res.body.bounces, 0, say(res));
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 0);
});

test('failures that are not a dead address do not stop anyone', T, async () => {
  const { u, asha, ben } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveBouncesOnly(u)).status, 200);
  await check(u);
  box.add(bounce(asha.email, '5.2.2', '552 5.2.2 mailbox full'));
  box.add(bounce(ben.email, '5.7.1', '550 5.7.1 message rejected as spam'));
  box.add(bounce(ben.email, '4.4.1', '451 4.4.1 timed out'));
  const res = await check(u);
  assert.equal(res.body.bounces, 0, say(res));
  assert.equal(await EmailOptOut.countDocuments({ userId: u.id }), 0);
  assert.equal(await EmailReply.countDocuments({ userId: u.id }), 0);
});

test('"bounces only" keeps no replies from people; the default still does', T, async () => {
  const only = await sentCampaign();
  const boxA = fakeMailbox();
  assert.equal((await saveBouncesOnly(only.u, true)).body.settings.bouncesOnly, true);
  await check(only.u);
  boxA.add(mail(only.asha.email, 'Yes please send more'));
  boxA.add(bounce(only.ben.email, '5.1.1', '550 no such user'));
  const a = await check(only.u);
  assert.equal(a.body.stored, 0);
  assert.equal(a.body.bounces, 1);
  assert.equal(await EmailReply.countDocuments({ userId: only.u.id }), 0);
  assert.equal((await call('GET', '/api/email/imap', { token: only.u.token })).body.settings.bouncesOnly, true);

  const both = await sentCampaign();
  const boxB = fakeMailbox();
  assert.equal((await saveImap(both.u)).body.settings.bouncesOnly, false);
  await check(both.u);
  boxB.add(mail(both.asha.email, 'Yes please send more'));
  boxB.add(bounce(both.ben.email, '5.1.1', '550 no such user'));
  const b = await check(both.u);
  assert.equal(b.body.stored, 1);
  assert.equal(b.body.bounces, 1);
});

test('one unreadable message does not stop the others', T, async () => {
  const { u, asha } = await sentCampaign();
  const box = fakeMailbox();
  assert.equal((await saveBouncesOnly(u)).status, 200);
  await check(u);
  box.add({ bad: true });
  box.add(bounce(asha.email, '5.1.1', '550 user unknown'));
  const res = await check(u);
  assert.equal(res.body.bounces, 1, say(res));
});
