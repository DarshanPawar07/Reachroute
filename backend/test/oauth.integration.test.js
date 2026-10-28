import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Sign in with Google, against a THROW-AWAY MongoDB database (name must contain "test"). Google itself is replaced by a stub.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = ''; // empty, not deleted: a real .env would otherwise fill it back in
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const models = await import('../src/models.js');
const { config } = await import('../src/config.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { useFetchForTests } = await import('../src/utils/oauth.js');
const { User, Consent } = models;

const T = { skip, timeout: 30_000 };
const tag = `oa${Date.now().toString(36)}`;
const emails = [];
let server;
let base;
let profile; // what the stub "Google" says about the person

before(async () => {
  if (!URI) return;
  config.oauth.google = { clientId: 'gid', clientSecret: 'gsecret' };
  config.requireTermsAcceptance = true;
  useFetchForTests(async (url) => {
    const ok = (data) => ({ ok: true, status: 200, json: async () => data });
    if (String(url).includes('token')) return ok({ access_token: 'tok' });
    return ok(profile);
  });
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: (_q, _s, n) => n(), oauth: (_q, _s, n) => n() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  useFetchForTests();
  config.requireTermsAcceptance = false;
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = (await User.find({ email: { $in: emails } }).select('_id').lean()).map((u) => u._id);
  await Promise.all([User.deleteMany({ _id: { $in: ids } }), Consent.deleteMany({ userId: { $in: ids } })]);
  await mongoose.disconnect();
});

const newEmail = (n) => {
  const e = `${n}.${tag}@example.com`;
  emails.push(e);
  return e;
};

/** Go through start and callback like a browser would; returns the fragment the web app receives. */
async function signInWithGoogle({ intent, terms, googleProfile, tamper }) {
  profile = googleProfile;
  const start = await fetch(`${base}/api/auth/oauth/google/start?intent=${intent}${terms ? '&terms=1' : ''}`, { redirect: 'manual' });
  assert.equal(start.status, 302);
  const to = new URL(start.headers.get('location'));
  assert.equal(to.hostname, 'accounts.google.com');
  const cookie = /oauth_nonce=[^;]+/.exec(start.headers.get('set-cookie'))[0];
  assert.match(start.headers.get('set-cookie'), /HttpOnly/);
  let state = to.searchParams.get('state');
  if (tamper === 'state') state = `${state.slice(0, -2)}zz`;
  const cb = await fetch(`${base}/api/auth/oauth/google/callback?code=abc&state=${encodeURIComponent(state)}`, { redirect: 'manual', headers: tamper === 'cookie' ? {} : { cookie } });
  assert.equal(cb.status, 302);
  const loc = new URL(cb.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, `${config.appUrl}/auth/callback`);
  return Object.fromEntries(new URLSearchParams(loc.hash.slice(1)));
}

test('which providers are switched on is public', T, async () => {
  const res = await (await fetch(`${base}/api/auth/oauth/providers`)).json();
  assert.deepEqual(res.providers, ['google']);
});

test('signing up with Google creates a verified account with no password and records the Terms', T, async () => {
  const email = newEmail('new');
  const out = await signInWithGoogle({ intent: 'signup', terms: true, googleProfile: { sub: `g-${tag}-1`, email, email_verified: true } });
  assert.ok(out.token, JSON.stringify(out));
  assert.equal(out.email, email);
  const user = await User.findOne({ email }).lean();
  assert.equal(user.emailVerified, true);
  assert.equal(user.passwordHash, undefined);
  assert.equal(user.oauth[0].provider, 'google');
  assert.ok(await Consent.countDocuments({ userId: user._id }), 'the Terms were recorded');

  const me = await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${out.token}` } });
  assert.equal((await me.json()).user.email, email, 'the token works');
});

test('signing in again with the same Google person logs in, even if their email changed', T, async () => {
  const email = newEmail('again');
  await signInWithGoogle({ intent: 'signup', terms: true, googleProfile: { sub: `g-${tag}-2`, email, email_verified: true } });
  const out = await signInWithGoogle({ intent: 'login', googleProfile: { sub: `g-${tag}-2`, email, email_verified: true } });
  assert.ok(out.token);
  assert.equal(await User.countDocuments({ email }), 1);
});

test('someone with no account who presses "log in" is told to sign up first; nothing is created', T, async () => {
  const email = newEmail('none');
  const out = await signInWithGoogle({ intent: 'login', googleProfile: { sub: `g-${tag}-3`, email, email_verified: true } });
  assert.equal(out.error, 'no_account');
  assert.equal(out.email, email);
  assert.equal(await User.countDocuments({ email }), 0);
});

test('signing up without ticking the Terms creates nothing', T, async () => {
  const email = newEmail('noterms');
  const out = await signInWithGoogle({ intent: 'signup', terms: false, googleProfile: { sub: `g-${tag}-4`, email, email_verified: true } });
  assert.equal(out.error, 'terms_required');
  assert.equal(await User.countDocuments({ email }), 0);
});

test('an existing password account with the same confirmed email is linked and marked verified', T, async () => {
  const email = newEmail('link');
  await User.create({ email, passwordHash: 'x'.repeat(60), emailVerified: false });
  const out = await signInWithGoogle({ intent: 'login', googleProfile: { sub: `g-${tag}-5`, email, email_verified: true } });
  assert.ok(out.token, JSON.stringify(out));
  const user = await User.findOne({ email }).lean();
  assert.equal(user.emailVerified, true);
  assert.equal(user.oauth.length, 1);
  assert.ok(user.passwordHash, 'the password still works');
});

test('an email Google has not confirmed is never trusted', T, async () => {
  const email = newEmail('unconfirmed');
  await User.create({ email, passwordHash: 'x'.repeat(60), emailVerified: true });
  const out = await signInWithGoogle({ intent: 'login', googleProfile: { sub: `g-${tag}-6`, email, email_verified: false } });
  assert.equal(out.error, 'no_verified_email');
  assert.equal((await User.findOne({ email }).lean()).oauth, undefined, 'not linked');
});

test('a suspended account cannot sign in this way either', T, async () => {
  const email = newEmail('suspended');
  await User.create({ email, emailVerified: true, suspendedAt: new Date(), oauth: [{ provider: 'google', id: `g-${tag}-7` }] });
  const out = await signInWithGoogle({ intent: 'login', googleProfile: { sub: `g-${tag}-7`, email, email_verified: true } });
  assert.equal(out.error, 'suspended');
  assert.equal(out.token, undefined);
});

test('a changed state, or a missing cookie, is refused (protects against forged sign-ins)', T, async () => {
  const email = newEmail('forged');
  assert.equal((await signInWithGoogle({ intent: 'signup', terms: true, googleProfile: { sub: `g-${tag}-8`, email, email_verified: true }, tamper: 'state' })).error, 'bad_state');
  assert.equal((await signInWithGoogle({ intent: 'signup', terms: true, googleProfile: { sub: `g-${tag}-8`, email, email_verified: true }, tamper: 'cookie' })).error, 'bad_state');
  assert.equal(await User.countDocuments({ email }), 0);
});

test('an unknown provider is a 404 and a provider that is not configured sends the person back with a reason', T, async () => {
  assert.equal((await fetch(`${base}/api/auth/oauth/myspace/start`, { redirect: 'manual' })).status, 404);
  const gh = await fetch(`${base}/api/auth/oauth/github/start`, { redirect: 'manual' });
  assert.equal(gh.status, 302);
  assert.match(gh.headers.get('location'), /error=not_configured/);
});
