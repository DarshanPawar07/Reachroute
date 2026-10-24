import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Proving the "from" address with a code, against a THROW-AWAY MongoDB database (name must contain "test").
// No email is really sent: with no platform SMTP the app keeps the message in memory (the "outbox").
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = ''; // no platform mail server: the app keeps messages in memory instead of sending them
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { outbox } = await import('../src/utils/systemMail.js');
const { getSender, closeAllSenders } = await import('../src/email/mailer.js');
const V = await import('../src/email/senderVerification.js');
const { User, SmtpSettings, SenderOtp, RateBucket, EmailCampaign, EmailRecipient, AuditLog } = models;

config.allowPrivateSmtp = true; // the test host name does not need to resolve
config.requireTermsAcceptance = false;
config.requireEmailVerification = false;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `snd${Date.now().toString(36)}`;
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
  closeAllSenders();
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    SmtpSettings.deleteMany({ userId: { $in: ids } }),
    SenderOtp.deleteMany({ userId: { $in: ids } }),
    RateBucket.deleteMany({ $or: [{ _id: { $in: ids.map((i) => `otp:user:${i}`) } }, { _id: { $regex: tag } }] }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ actorId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
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

const fromAddress = (n = 0) => `sender${n}.${tag}.${counter}@example.com`;
const saveSettings = (u, extra = {}) =>
  call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail: u.from, fromName: 'Me', ...extra } });

async function withSettings() {
  const u = await newUser();
  u.from = fromAddress();
  const saved = await saveSettings(u);
  assert.equal(saved.status, 200, say(saved));
  return u;
}

/** The code in the latest verification email sent to this address. */
const lastCode = (to) => {
  const mails = outbox.filter((m) => m.to === to && /verification code/.test(m.subject));
  assert.ok(mails.length, `no code was emailed to ${to}`);
  return mails[mails.length - 1].subject.match(/^(\d{6}) /)[1];
};
const wrongCode = (right) => (right === '000000' ? '000001' : '000000');
const askCode = (u) => call('POST', '/api/email/sender/code', { token: u.token });
const sendCode = (u, code) => call('POST', '/api/email/sender/verify', { token: u.token, json: { code } });
const resetGap = (u) => SenderOtp.updateOne({ userId: u.id }, { $set: { sentAt: new Date(Date.now() - 120_000) } });

const campaignForm = () => {
  const fd = new FormData();
  fd.append('name', 'verify check');
  fd.append('subject', 'Hi');
  fd.append('body', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob(['name,email\nAsha,asha.verify@example.com\n'], { type: 'text/csv' }), 'c.csv');
  return fd;
};
const startCampaign = (u) => call('POST', '/api/email/campaigns', { token: u.token, form: campaignForm() });

test('before any settings there is nothing to verify, and a code cannot be asked for', T, async () => {
  const u = await newUser();
  const status = await call('GET', '/api/email/sender', { token: u.token });
  assert.equal(status.status, 200, say(status));
  assert.deepEqual(status.body, { mode: 'none', email: null, verified: false, needsVerification: false, verifiedAt: null, code: null });
  assert.equal((await askCode(u)).status, 409);
  assert.equal((await sendCode(u, '123456')).status, 400);
  assert.equal((await call('GET', '/api/email/sender')).status, 401);
  assert.equal((await call('POST', '/api/email/sender/code')).status, 401);
  const providers = await call('GET', '/api/email/providers', { token: u.token });
  assert.ok(providers.body.providers.some((p) => p.name === 'Gmail' && p.host === 'smtp.gmail.com'));
});

test('with own settings but no proof, sending is refused with a clear code', T, async () => {
  const u = await withSettings();
  const settings = await call('GET', '/api/email/settings', { token: u.token });
  assert.equal(settings.body.sender.mode, 'own');
  assert.equal(settings.body.sender.needsVerification, true);
  assert.equal(settings.body.sender.email, u.from);
  const blocked = await startCampaign(u);
  assert.equal(blocked.status, 403, say(blocked));
  assert.equal(blocked.body.code, 'sender_not_verified');
  assert.match(blocked.body.error, new RegExp(u.from.replace(/\./g, '\\.')));
  await assert.rejects(getSender(u.id), (e) => e.code === 'SENDER_NOT_VERIFIED' && e.kind === 'fatal');
  assert.ok(await getSender(u.id, { allowUnverified: true }), 'the settings test can still use it');
});

test('the code goes to the "from" address, and entering it unlocks sending', T, async () => {
  const u = await withSettings();
  const sent = await askCode(u);
  assert.equal(sent.status, 200, say(sent));
  assert.equal(sent.body.email, u.from);
  assert.equal(sent.body.sender.code.sentTo, u.from);
  const code = lastCode(u.from);
  assert.match(code, /^\d{6}$/);
  const mail = outbox.filter((m) => m.to === u.from).pop();
  assert.ok(mail.text.includes(code));
  assert.ok(!JSON.stringify(await SenderOtp.findOne({ userId: u.id }).lean()).includes(code), 'only a hash of the code is stored');

  const again = await askCode(u);
  assert.equal(again.status, 429, 'one code a minute');
  assert.match(again.body.error, /Wait \d+ second/);

  assert.equal((await sendCode(u, 'abc')).status, 400);
  assert.equal((await sendCode(u, '12345')).status, 400);
  const wrong = await sendCode(u, wrongCode(code));
  assert.equal(wrong.status, 400, say(wrong));
  assert.match(wrong.body.error, /4 tries left/);
  assert.equal((await call('GET', '/api/email/sender', { token: u.token })).body.verified, false);

  const ok = await sendCode(u, ` ${code.slice(0, 3)} ${code.slice(3)} `); // spaces are ignored
  assert.equal(ok.status, 200, say(ok));
  assert.equal(ok.body.verified, true);
  assert.equal(ok.body.sender.verified, true);
  assert.equal(ok.body.sender.needsVerification, false);
  assert.equal(await SenderOtp.countDocuments({ userId: u.id }), 0, 'the code is used up');
  assert.equal((await sendCode(u, code)).status, 400, 'a used code does not work again');
  assert.equal((await askCode(u)).body.alreadyVerified, true);

  const campaign = await startCampaign(u);
  assert.equal(campaign.status, 201, say(campaign));
  assert.ok(await getSender(u.id));
  for (const action of ['smtp.otp_sent', 'smtp.sender_verified']) assert.equal(await AuditLog.countDocuments({ actorId: u.id, action }), 1, action);
});

test('too many wrong codes lock that code, even the right one; a new code starts fresh', T, async () => {
  const u = await withSettings();
  await askCode(u);
  const code = lastCode(u.from);
  for (let i = 4; i >= 0; i--) {
    const r = await sendCode(u, wrongCode(code));
    assert.equal(r.status, i === 0 ? 429 : 400, say(r));
  }
  const locked = await sendCode(u, code);
  assert.equal(locked.status, 429, say(locked));
  assert.match(locked.body.error, /new one/);
  assert.equal((await call('GET', '/api/email/sender', { token: u.token })).body.verified, false);

  await resetGap(u);
  assert.equal((await askCode(u)).status, 200);
  const fresh = lastCode(u.from);
  assert.equal((await sendCode(u, fresh)).status, 200);
});

test('parallel guesses cannot beat the limit', T, async () => {
  const u = await withSettings();
  await askCode(u);
  const code = lastCode(u.from);
  const guesses = ['000000', '000001', '000002', '000003', '000004', '000005', '000006', '000007'].filter((g) => g !== code);
  await Promise.all(guesses.map((g) => sendCode(u, g)));
  assert.equal((await SenderOtp.findOne({ userId: u.id }).lean()).attempts, 5, 'no more than 5 tries were counted');
  assert.equal((await sendCode(u, code)).status, 429);
});

test('an expired code is refused', T, async () => {
  const u = await withSettings();
  await askCode(u);
  const code = lastCode(u.from);
  await SenderOtp.updateOne({ userId: u.id }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const r = await sendCode(u, code);
  assert.equal(r.status, 400, say(r));
  assert.match(r.body.error, /expired/);
  assert.equal((await call('GET', '/api/email/sender', { token: u.token })).body.code, null);
});

test('changing the "from" address needs a new proof; other changes do not', T, async () => {
  const u = await withSettings();
  await askCode(u);
  assert.equal((await sendCode(u, lastCode(u.from))).status, 200);

  // host and password change, same address: still proven
  assert.equal((await saveSettings(u, { host: 'smtp2.example.com', pass: 'another-secret' })).status, 200);
  assert.equal((await call('GET', '/api/email/sender', { token: u.token })).body.verified, true);

  // a code waiting for the old address cannot be used for a new one
  await resetGap(u);
  const oldFrom = u.from;
  u.from = fromAddress(1);
  const changed = await saveSettings(u);
  assert.equal(changed.status, 200, say(changed));
  assert.equal(changed.body.sender.verified, false);
  assert.equal(changed.body.sender.email, u.from);
  assert.equal((await startCampaign(u)).body.code, 'sender_not_verified');

  assert.equal((await askCode(u)).status, 200);
  const newCode = lastCode(u.from);
  assert.ok(outbox.filter((m) => m.to === oldFrom).length >= 1);
  assert.equal((await sendCode(u, newCode)).status, 200);
  assert.equal((await call('GET', '/api/email/sender', { token: u.token })).body.email, u.from);

  // the code was for one address: change again before using it
  await resetGap(u);
  assert.equal((await askCode(u)).body.alreadyVerified, true);
  const third = fromAddress(2);
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { fromEmail: third } });
  await SenderOtp.create({ userId: u.id, email: u.from, codeHash: 'ab'.repeat(32), sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) }).catch(() => {});
  const stale = await sendCode(u, '123456');
  assert.equal(stale.status, 409, say(stale));
  assert.equal(await SenderOtp.countDocuments({ userId: u.id }), 0);
});

test('codes are limited per account and per address', T, async () => {
  const u = await withSettings();
  const start = Date.now();
  for (let i = 0; i < 5; i++) await V.sendSenderCode(u.id, { now: start + i * 61_000 });
  await assert.rejects(V.sendSenderCode(u.id, { now: start + 5 * 61_000 }), (e) => e.status === 429 && /Too many codes requested/.test(e.message));

  // many accounts cannot flood one inbox either
  const shared = `shared.${tag}@example.com`;
  const others = [];
  for (let i = 0; i < 6; i++) {
    const other = await newUser();
    other.from = shared;
    assert.equal((await saveSettings(other)).status, 200);
    others.push(other);
  }
  const results = [];
  for (const o of others) results.push(await V.sendSenderCode(o.id, { now: start }).then(() => 'ok', (e) => e.status));
  assert.deepEqual(results, ['ok', 'ok', 'ok', 'ok', 'ok', 429]);
});

test('without a mail server for the platform, production refuses rather than pretending', T, async () => {
  const u = await withSettings();
  const keep = config.isProd;
  config.isProd = true;
  try {
    await assert.rejects(V.sendSenderCode(u.id), (e) => e.status === 503);
  } finally {
    config.isProd = keep;
  }
  assert.equal(await SenderOtp.countDocuments({ userId: u.id }), 0);
});
