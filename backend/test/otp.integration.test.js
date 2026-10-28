import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Sign-up code by email, and the specific login errors, against a THROW-AWAY MongoDB database (name must contain "test"):
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = ''; // empty, not deleted: a real .env would otherwise fill it back in
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { outbox } = await import('../src/utils/systemMail.js');
const { User, SignupOtp, AuthToken } = models;

const T = { skip, timeout: 30_000 };
const PASSWORD = 'correct horse battery';
const off = (_req, _res, next) => next();
const emails = [];
let server;
let base;

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: off, passwordReset: off, login: off, signupOtp: off }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = (await User.find({ email: { $in: emails } }).select('_id').lean()).map((u) => u._id);
  await Promise.all([User.deleteMany({ _id: { $in: ids } }), SignupOtp.deleteMany({ userId: { $in: ids } }), AuthToken.deleteMany({ userId: { $in: ids } })]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: json ? JSON.stringify(json) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (r) => JSON.stringify(r.body);

async function signUp() {
  const email = `otp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  emails.push(email);
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  return { email, token: res.body.token, id: res.body.user.id };
}

/** The code from the newest confirmation email for an address (emails are sent after the response). */
async function codeFor(email, count = 1) {
  for (let i = 0; i < 100; i++) {
    const mails = outbox.filter((m) => m.to === email && /confirm your email/i.test(m.subject));
    if (mails.length >= count) return /code is (\d{6})/.exec(mails.at(-1).text)?.[1];
    await sleep(30);
  }
  assert.fail(`no confirmation email for ${email}`);
}
const verify = (u, code) => call('POST', '/api/auth/verify-otp', { token: u.token, json: { code } });

test('sign-up emails a 6-digit code (and keeps the link as a fallback); the right code verifies once', T, async () => {
  const u = await signUp();
  const mail = outbox.find((m) => m.to === u.email) || (await codeFor(u.email), outbox.find((m) => m.to === u.email));
  assert.match(mail.text, /verification code is \d{6}/);
  assert.match(mail.text, /verify-email\?token=/, 'the one-click link is still there');
  const code = await codeFor(u.email);
  assert.match(code, /^\d{6}$/);

  const stored = await SignupOtp.findOne({ userId: u.id }).lean();
  assert.ok(!stored.codeHash.includes(code), 'only a hash of the code is stored');
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).body.user.emailVerified, false);

  const ok = await verify(u, code);
  assert.equal(ok.status, 200, say(ok));
  assert.equal(ok.body.user.emailVerified, true);
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).body.user.emailVerified, true);
  assert.equal(await SignupOtp.countDocuments({ userId: u.id }), 0, 'the code is gone');
  assert.equal(await AuthToken.countDocuments({ userId: u.id, type: 'verify' }), 0, 'and so is the link');
  assert.equal((await verify(u, code)).body.alreadyVerified, true);
});

test('a wrong code says so and counts the tries; five wrong ones lock that code', T, async () => {
  const u = await signUp();
  const code = await codeFor(u.email);
  const wrong = code === '000000' ? '111111' : '000000';

  const first = await verify(u, wrong);
  assert.equal(first.status, 400);
  assert.equal(first.body.code, 'code_wrong');
  assert.match(first.body.error, /4 tries left/);
  assert.equal((await verify(u, 'abc')).body.code, 'code_format');
  assert.equal((await verify(u, '12345')).body.code, 'code_format');

  for (let i = 0; i < 3; i++) await verify(u, wrong);
  const last = await verify(u, wrong);
  assert.equal(last.status, 429, say(last));
  assert.equal(last.body.code, 'code_locked');
  assert.equal((await verify(u, code)).status, 429, 'even the right code no longer works');
  assert.equal((await call('GET', '/api/auth/me', { token: u.token })).body.user.emailVerified, false);
});

test('an expired code is refused and a new one works; asking again too soon is told to wait', T, async () => {
  const u = await signUp();
  const old = await codeFor(u.email);
  await SignupOtp.collection.updateOne({ userId: new mongoose.Types.ObjectId(u.id) }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  const res = await verify(u, old);
  assert.equal(res.body.code, 'code_expired', say(res));

  const soon = await call('POST', '/api/auth/resend-verification', { token: u.token });
  assert.equal(soon.status, 429);
  assert.equal(soon.body.code, 'cooldown');

  await AuthToken.collection.updateMany({ userId: new mongoose.Types.ObjectId(u.id) }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
  assert.equal((await call('POST', '/api/auth/resend-verification', { token: u.token })).status, 200);
  const fresh = await codeFor(u.email, 2);
  assert.equal((await verify(u, fresh)).status, 200);
});

test('verify-otp needs a login', T, async () => {
  assert.equal((await call('POST', '/api/auth/verify-otp', { json: { code: '123456' } })).status, 401);
});

test('login says exactly what is wrong', T, async () => {
  const u = await signUp();
  const login = (email, password) => call('POST', '/api/auth/login', { json: { email, password } });

  let r = await login('', PASSWORD);
  assert.equal(r.body.code, 'email_required');
  r = await login('not-an-email', PASSWORD);
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid_email');
  r = await login(u.email, '');
  assert.equal(r.body.code, 'password_required');

  r = await login(`ghost-${Date.now()}@example.com`, PASSWORD);
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'no_account');
  assert.match(r.body.error, /no account/i);

  r = await login(u.email, 'definitely the wrong one');
  assert.equal(r.status, 401);
  assert.equal(r.body.code, 'wrong_password');
  assert.match(r.body.error, /wrong password/i);

  r = await login(u.email, PASSWORD);
  assert.equal(r.status, 200, say(r));
  assert.equal(r.body.user.emailVerified, false, 'the app uses this to ask for the code');
});

test('repeated wrong passwords warn, then lock, and say so', T, async () => {
  const u = await signUp();
  const login = (password) => call('POST', '/api/auth/login', { json: { email: u.email, password } });
  let r;
  for (let i = 0; i < 5; i++) r = await login('wrong password here');
  assert.match(r.body.error, /3 more wrong tries/);
  for (let i = 0; i < 2; i++) r = await login('wrong password here');
  assert.match(r.body.error, /1 more wrong try /);
  r = await login('wrong password here');
  assert.equal(r.status, 429);
  assert.equal(r.body.code, 'locked');
  r = await login(PASSWORD);
  assert.equal(r.status, 429, 'locked even for the right password');
  assert.equal(r.body.code, 'locked');
});

test('an account made with a provider has no password and is told where to sign in', T, async () => {
  const email = `oauthonly-${Date.now()}@example.com`;
  emails.push(email);
  await User.create({ email, emailVerified: true, oauth: [{ provider: 'google', id: `g-${Date.now()}` }] });
  const r = await call('POST', '/api/auth/login', { json: { email, password: PASSWORD } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'use_oauth');
  assert.match(r.body.error, /Google/);
  assert.match(r.body.error, /Forgot password/);
});

test('sign-up with an address that already has an account says so', T, async () => {
  const u = await signUp();
  const r = await call('POST', '/api/auth/register', { json: { email: u.email, password: PASSWORD } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'email_taken');
  const bad = await call('POST', '/api/auth/register', { json: { email: 'nope', password: PASSWORD } });
  assert.equal(bad.body.code, 'invalid_email');
});
