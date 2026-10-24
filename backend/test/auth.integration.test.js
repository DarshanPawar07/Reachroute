import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

// Tests for password reset and email verification. They run the real app against a THROW-AWAY MongoDB
// database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb+srv://.../bulk_messenger_test npm test
// No platform SMTP is set here, so the app puts every email it would send into an in-memory outbox that the
// tests read the links from. Nothing is really sent.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
delete process.env.SMTP_HOST;

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { issueToken } = await import('../src/utils/authTokens.js');
const { outbox } = await import('../src/utils/systemMail.js');
const { User, AuthToken } = models;

let server;
let base;
const emails = [];

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  // The sign-up (10 per hour) and forgot-password (5 per hour) limits are per IP, and all these tests come from one IP.
  const off = (_req, _res, next) => next();
  server = http.createServer(buildApp({ ...createLimiters(), register: off, passwordReset: off }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  config.requireEmailVerification = false;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const users = await User.find({ email: { $in: emails } }).select('_id').lean();
  const ids = users.map((u) => u._id);
  await Promise.all([User.deleteMany({ _id: { $in: ids } }), AuthToken.deleteMany({ userId: { $in: ids } })]);
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
const say = (res) => JSON.stringify(res.body);
const PASSWORD = 'correct horse battery';

async function newUser() {
  const email = `a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  emails.push(email);
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  return { email, token: res.body.token, id: res.body.user.id, registered: res.body };
}

/** Emails the app "sent" to an address. */
const mailsTo = (email, subject) => outbox.filter((m) => m.to === email && (!subject || subject.test(m.subject)));

/** Emails are sent after the response, so wait until the expected number has arrived. */
async function waitForMails(email, subject, count = 1) {
  for (let i = 0; i < 100; i++) {
    if (mailsTo(email, subject).length >= count) return mailsTo(email, subject);
    await sleep(30);
  }
  assert.fail(`no "${subject}" email for ${email} (outbox has ${outbox.filter((m) => m.to === email).map((m) => m.subject).join(', ') || 'nothing'})`);
}

const tokenIn = (mail) => /token=([\w-]+)/.exec(mail.text)?.[1];
const VERIFY = /confirm your email/i;
const RESET = /reset your/i;
const CHANGED = /password was changed/i;
const login = (email, password) => call('POST', '/api/auth/login', { json: { email, password } });
const T = { skip, timeout: 30_000 };

// ---------------------------------------------------------------- email verification

test('sign-up sends a confirmation link; opening it verifies the account once', T, async () => {
  const u = await newUser();
  assert.equal(u.registered.user.emailVerified, false);

  const [mail] = await waitForMails(u.email, VERIFY);
  assert.ok(mail.text.includes(`${config.appUrl}/verify-email?token=`), 'the link points at the web app');
  const token = tokenIn(mail);
  assert.ok(token);
  assert.equal((await AuthToken.findOne({ userId: u.id, type: 'verify' }).lean()).tokenHash.includes(token), false, 'only a hash of the token is stored');

  let me = await call('GET', '/api/auth/me', { token: u.token });
  assert.equal(me.body.user.emailVerified, false);

  assert.equal((await call('POST', '/api/auth/verify-email', { json: { token: 'nonsense-nonsense-nonsense' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/verify-email', { json: {} })).status, 400);

  const ok = await call('POST', '/api/auth/verify-email', { json: { token } }); // no login needed
  assert.equal(ok.status, 200, say(ok));
  me = await call('GET', '/api/auth/me', { token: u.token });
  assert.equal(me.body.user.emailVerified, true);
  assert.equal((await login(u.email, PASSWORD)).body.user.emailVerified, true);

  const again = await call('POST', '/api/auth/verify-email', { json: { token } });
  assert.equal(again.status, 400, 'a link works only once');
  assert.equal((await call('GET', '/api/auth/me')).status, 401, 'login is required for /me');
});

test('resend: waits a minute between emails, replaces the old link, and stops once verified', T, async () => {
  const u = await newUser();
  const [first] = await waitForMails(u.email, VERIFY);

  let res = await call('POST', '/api/auth/resend-verification', { token: u.token });
  assert.equal(res.status, 429, 'too soon after the sign-up email');

  // pretend that minute has passed (the raw driver is used because createdAt cannot be changed through the model)
  await AuthToken.collection.updateMany({ userId: new mongoose.Types.ObjectId(u.id) }, { $set: { createdAt: new Date(Date.now() - 5 * 60_000) } });
  res = await call('POST', '/api/auth/resend-verification', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.emailSent, false, 'no SMTP in tests, so the email went to the outbox');

  const mails = await waitForMails(u.email, VERIFY, 2);
  const second = mails.at(-1);
  assert.notEqual(tokenIn(first), tokenIn(second));
  assert.equal((await call('POST', '/api/auth/verify-email', { json: { token: tokenIn(first) } })).status, 400, 'the old link no longer works');
  assert.equal((await call('POST', '/api/auth/verify-email', { json: { token: tokenIn(second) } })).status, 200);

  res = await call('POST', '/api/auth/resend-verification', { token: u.token });
  assert.equal(res.body.alreadyVerified, true);
  assert.equal((await call('POST', '/api/auth/resend-verification')).status, 401);
});

test('when verification is required, unverified accounts cannot start campaigns; verified and older accounts can', T, async () => {
  const campaign = (u) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries({ name: 'c', subject: 's', body: 'b', consentConfirmed: 'true' })) fd.append(k, v);
    fd.append('file', new Blob(['name,email\nAsha,asha@example.com'], { type: 'text/csv' }), 'c.csv');
    return call('POST', '/api/email/campaigns', { token: u.token, form: fd });
  };

  config.requireEmailVerification = true;
  try {
    const fresh = await newUser();
    let res = await campaign(fresh);
    assert.equal(res.status, 403, say(res));
    assert.match(res.body.error, /confirm your email/i);

    const [mail] = await waitForMails(fresh.email, VERIFY);
    await call('POST', '/api/auth/verify-email', { json: { token: tokenIn(mail) } });
    res = await campaign(fresh);
    assert.equal(res.status, 409, `past the verification check, it now stops at "add SMTP settings": ${say(res)}`);

    // an account that existed before this feature has no flag at all and counts as verified
    const old = await newUser();
    await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $unset: { emailVerified: '' } });
    res = await campaign(old);
    assert.equal(res.status, 409, say(res));
    assert.equal((await call('GET', '/api/auth/me', { token: old.token })).body.user.emailVerified, true);
  } finally {
    config.requireEmailVerification = false;
  }
});

// ---------------------------------------------------------------- password reset

test('forgot password: same answer for everyone, one email per minute, and nothing for unknown addresses', T, async () => {
  const u = await newUser();
  const ghost = `nobody-${Date.now()}@example.com`;

  const a = await call('POST', '/api/auth/forgot-password', { json: { email: ghost } });
  const b = await call('POST', '/api/auth/forgot-password', { json: { email: u.email } });
  assert.equal(a.status, 200, say(a));
  assert.deepEqual(a.body, b.body, 'the answer must not reveal whether the account exists');

  const [mail] = await waitForMails(u.email, RESET);
  assert.ok(mail.text.includes(`${config.appUrl}/reset-password?token=`));
  await sleep(200);
  assert.equal(mailsTo(ghost).length, 0, 'unknown address gets no email');

  await call('POST', '/api/auth/forgot-password', { json: { email: u.email } });
  await sleep(300);
  assert.equal(mailsTo(u.email, RESET).length, 1, 'a second request within a minute sends nothing new');

  assert.equal((await call('POST', '/api/auth/forgot-password', { json: { email: 'not-an-email' } })).status, 400);
  assert.equal((await call('POST', '/api/auth/forgot-password', { json: {} })).status, 400);
});

test('reset password: new password works, old one stops, link is single-use, lock and verification are cleared', T, async () => {
  const u = await newUser();
  await call('POST', '/api/auth/forgot-password', { json: { email: u.email } });
  const [mail] = await waitForMails(u.email, RESET);
  const token = tokenIn(mail);

  // locked account and unverified: both are fixed by a successful reset
  await User.updateOne({ _id: u.id }, { $set: { lockedUntil: new Date(Date.now() + 600_000), failedLogins: 3 } });
  assert.equal((await login(u.email, PASSWORD)).status, 429, 'locked before the reset');

  let res = await call('POST', '/api/auth/reset-password', { json: { token, password: 'short' } });
  assert.equal(res.status, 400, 'a too-short password is refused');
  res = await call('POST', '/api/auth/reset-password', { json: { token: 'wrong-wrong-wrong-wrong-wrong', password: 'brand new password' } });
  assert.equal(res.status, 400);

  res = await call('POST', '/api/auth/reset-password', { json: { token, password: 'brand new password' } });
  assert.equal(res.status, 200, `the refused attempts must not have used up the link: ${say(res)}`);

  assert.equal((await login(u.email, PASSWORD)).status, 401, 'old password no longer works');
  const fresh = await login(u.email, 'brand new password');
  assert.equal(fresh.status, 200, say(fresh));
  assert.equal(fresh.body.user.emailVerified, true);
  await waitForMails(u.email, CHANGED);

  res = await call('POST', '/api/auth/reset-password', { json: { token, password: 'another new password' } });
  assert.equal(res.status, 400, 'a link works only once');
  assert.equal((await login(u.email, 'brand new password')).status, 200);
});

test('reset password: an expired link is refused, and asking again replaces the earlier link', T, async () => {
  const u = await newUser();
  const expired = await issueToken(u.id, 'reset');
  await AuthToken.collection.updateMany({ userId: new mongoose.Types.ObjectId(u.id), type: 'reset' }, { $set: { expiresAt: new Date(Date.now() - 1000) } });
  let res = await call('POST', '/api/auth/reset-password', { json: { token: expired, password: 'brand new password' } });
  assert.equal(res.status, 400, 'expired');

  const first = await issueToken(u.id, 'reset');
  const second = await issueToken(u.id, 'reset');
  res = await call('POST', '/api/auth/reset-password', { json: { token: first, password: 'brand new password' } });
  assert.equal(res.status, 400, 'the older link was replaced');
  res = await call('POST', '/api/auth/reset-password', { json: { token: second, password: 'brand new password' } });
  assert.equal(res.status, 200, say(res));
  assert.equal(await AuthToken.countDocuments({ userId: u.id, type: 'reset' }), 0);

  // a verification link cannot be used to reset a password, and the other way round
  const verify = await issueToken(u.id, 'verify');
  res = await call('POST', '/api/auth/reset-password', { json: { token: verify, password: 'sneaky new password' } });
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- signing out of every device

const asUser = (token) => call('GET', '/api/auth/me', { token });

test('"sign out everywhere" ends every older login but keeps the device that asked', T, async () => {
  const u = await newUser();
  const other = (await login(u.email, PASSWORD)).body.token; // a second device
  assert.equal((await asUser(u.token)).status, 200);
  assert.equal((await asUser(other)).status, 200);

  const res = await call('POST', '/api/auth/logout-all', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.equal((await asUser(u.token)).status, 401, 'the old token of this device is replaced');
  assert.equal((await asUser(other)).status, 401, 'the other device is signed out');
  assert.equal((await asUser(res.body.token)).status, 200, 'the fresh token works');
  assert.equal((await login(u.email, PASSWORD)).status, 200, 'logging in again is always possible');
  assert.equal((await call('POST', '/api/auth/logout-all')).status, 401);
});

test('changing the password needs the current one, signs out other devices and keeps this one', T, async () => {
  const u = await newUser();
  const other = (await login(u.email, PASSWORD)).body.token;

  let res = await call('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: 'wrong password', newPassword: 'brand new password' } });
  assert.equal(res.status, 400, 'wrong current password');
  assert.equal((await asUser(u.token)).status, 200, 'a wrong attempt must not sign anyone out');
  res = await call('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: PASSWORD, newPassword: 'short' } });
  assert.equal(res.status, 400);
  res = await call('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: PASSWORD, newPassword: PASSWORD } });
  assert.equal(res.status, 400, 'must differ from the current one');

  res = await call('POST', '/api/auth/change-password', { token: u.token, json: { currentPassword: PASSWORD, newPassword: 'brand new password' } });
  assert.equal(res.status, 200, say(res));
  assert.equal((await asUser(other)).status, 401);
  assert.equal((await asUser(u.token)).status, 401);
  assert.equal((await asUser(res.body.token)).status, 200);
  assert.equal((await login(u.email, PASSWORD)).status, 401);
  assert.equal((await login(u.email, 'brand new password')).status, 200);
  await waitForMails(u.email, CHANGED);
});

test('a password reset signs out every device; accounts older than this feature keep working', T, async () => {
  const u = await newUser();
  await call('POST', '/api/auth/forgot-password', { json: { email: u.email } });
  const [mail] = await waitForMails(u.email, RESET);
  const res = await call('POST', '/api/auth/reset-password', { json: { token: tokenIn(mail), password: 'brand new password' } });
  assert.equal(res.status, 200, say(res));
  assert.equal((await asUser(u.token)).status, 401, 'a stolen session does not survive a reset');

  // an account created before token versions existed has no tokenVersion field, and a token without `v`
  const old = await newUser();
  await User.collection.updateOne({ _id: new mongoose.Types.ObjectId(old.id) }, { $unset: { tokenVersion: '' } });
  assert.equal((await asUser(old.token)).status, 200);
});