import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Terms, Privacy Policy and the record of who accepted them, against a THROW-AWAY MongoDB database (name must contain "test").
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
const { getDocument, VERSIONS } = await import('../src/legal/documents.js');
const accounts = await import('../src/admin/accounts.js');
const { User, Consent, AuditLog, SessionLease } = models;

config.requireTermsAcceptance = true;
config.requireEmailVerification = false;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `leg${Date.now().toString(36)}`;
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
    Consent.deleteMany({ userId: { $in: ids } }),
    AuditLog.deleteMany({ actorId: { $in: ids } }),
    SessionLease.deleteMany({ _id: { $in: ids.map(String) } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form, raw } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  if (raw) return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (r) => JSON.stringify(r.body);
const VERSION_BODY = { versions: { terms: VERSIONS.terms, privacy: VERSIONS.privacy } };

async function register(extra = {}) {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD, ...extra } });
  if (res.status === 201) made.push({ id: new mongoose.Types.ObjectId(res.body.user.id) });
  return { res, email, token: res.body.token, id: res.body.user && new mongoose.Types.ObjectId(res.body.user.id) };
}

test('the documents are public, as data and as web pages', T, async () => {
  const list = await call('GET', '/api/legal');
  assert.equal(list.status, 200, say(list));
  assert.deepEqual(list.body.documents.map((d) => [d.doc, d.version]), [['terms', VERSIONS.terms], ['privacy', VERSIONS.privacy]]);
  for (const name of ['terms', 'privacy']) {
    const one = await call('GET', `/api/legal/${name}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.document.hash, getDocument(name).hash);
    assert.ok(one.body.document.sections.length >= 8);
    const page = await call('GET', `/legal/${name}`, { raw: true });
    assert.equal(page.status, 200);
    assert.match(page.type, /html/);
    assert.match(page.text, new RegExp(one.body.document.title));
  }
  for (const bad of ['nope', '__proto__', 'constructor']) {
    assert.equal((await call('GET', `/api/legal/${bad}`)).status, 404, bad);
    assert.equal((await call('GET', `/legal/${bad}`, { raw: true })).status, 404, bad);
  }
});

test('the privacy text states the real retention settings, and the hash changes with the text', T, async () => {
  const before = getDocument('privacy');
  assert.ok(before.sections.some((s) => s.paragraphs.join(' ').includes(`${config.retentionDays} days`)));
  const keep = config.legalContactEmail;
  config.legalContactEmail = 'privacy@example.org';
  try {
    const after = getDocument('privacy');
    assert.notEqual(after.hash, before.hash);
    assert.ok(JSON.stringify(after.sections).includes('privacy@example.org'));
  } finally {
    config.legalContactEmail = keep;
  }
});

test('signing up needs the box ticked, and the acceptance is recorded', T, async () => {
  for (const acceptTerms of [undefined, false, 'true', 1]) {
    const r = await register(acceptTerms === undefined ? {} : { acceptTerms });
    assert.equal(r.res.status, 400, `acceptTerms=${acceptTerms}: ${say(r.res)}`);
    assert.match(r.res.body.error, /accept/i);
    assert.equal(await User.countDocuments({ email: r.email }), 0, 'no account without it');
  }
  const ok = await register({ acceptTerms: true });
  assert.equal(ok.res.status, 201, say(ok.res));
  const rows = await Consent.find({ userId: ok.id }).sort({ doc: 1 }).lean();
  assert.deepEqual(rows.map((r) => [r.doc, r.version, r.via]), [['privacy', VERSIONS.privacy, 'register'], ['terms', VERSIONS.terms, 'register']]);
  for (const r of rows) {
    assert.equal(r.textHash, getDocument(r.doc).hash);
    assert.ok(r.acceptedAt instanceof Date);
  }
  const status = await call('GET', '/api/account/legal', { token: ok.token });
  assert.equal(status.body.required, true);
  assert.deepEqual(status.body.pending, []);
  assert.ok(status.body.documents.every((d) => d.accepted && d.acceptedAt));
});

test('the requirement can be switched off, and then the box is optional', T, async () => {
  config.requireTermsAcceptance = false;
  try {
    const none = await register();
    assert.equal(none.res.status, 201, say(none.res));
    assert.equal(await Consent.countDocuments({ userId: none.id }), 0);
    const ticked = await register({ acceptTerms: true });
    assert.equal(await Consent.countDocuments({ userId: ticked.id }), 2);
    const statusOff = await call('GET', '/api/account/legal', { token: none.token });
    assert.equal(statusOff.body.required, false);
  } finally {
    config.requireTermsAcceptance = true;
  }
});

const campaignForm = () => {
  const fd = new FormData();
  fd.append('name', 'terms check');
  fd.append('message', 'Hello {{name}}');
  fd.append('consentConfirmed', 'true');
  fd.append('file', new Blob(['name,phone\nAsha,919100000901\n'], { type: 'text/csv' }), 'c.csv');
  return fd;
};

test('an account that has not accepted cannot start a campaign; accepting lets it through', T, async () => {
  config.requireTermsAcceptance = false;
  const u = await register(); // an older account: no record
  config.requireTermsAcceptance = true;

  const blocked = await call('POST', '/api/whatsapp/campaigns', { token: u.token, form: campaignForm() });
  assert.equal(blocked.status, 403, say(blocked));
  assert.equal(blocked.body.code, 'terms_required');
  assert.deepEqual((await call('GET', '/api/account/legal', { token: u.token })).body.pending, ['terms', 'privacy']);

  // a stale or wrong request is refused and records nothing
  assert.equal((await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: { terms: '1999-01-01' } } })).status, 409);
  assert.equal((await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: { cookies: '1' } } })).status, 400);
  assert.equal((await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: { terms: 5 } } })).status, 400);
  assert.equal((await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: {} } })).status, 400);
  assert.equal((await call('POST', '/api/account/legal/accept', { token: u.token, json: {} })).status, 400);
  assert.equal(await Consent.countDocuments({ userId: u.id }), 0);
  assert.equal((await call('POST', '/api/account/legal/accept')).status, 401);

  // accept only the terms: privacy is still pending
  const half = await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: { terms: VERSIONS.terms } } });
  assert.equal(half.status, 200, say(half));
  assert.deepEqual(half.body.pending, ['privacy']);
  assert.equal((await call('POST', '/api/whatsapp/campaigns', { token: u.token, form: campaignForm() })).body.code, 'terms_required');

  const all = await call('POST', '/api/account/legal/accept', { token: u.token, json: VERSION_BODY });
  assert.deepEqual(all.body.pending, []);
  assert.equal(await Consent.countDocuments({ userId: u.id }), 2, 'repeating never adds a second row for the same version');
  const through = await call('POST', '/api/whatsapp/campaigns', { token: u.token, form: campaignForm() });
  assert.notEqual(through.body.code, 'terms_required', 'no longer stopped for the documents (WhatsApp is simply not connected)');

  const audit = await AuditLog.find({ actorId: u.id, action: 'terms.accepted' }).lean();
  assert.equal(audit.length, 2);
});

test('a new version of a document asks again, and the old acceptance stays on record', T, async () => {
  const u = await register({ acceptTerms: true });
  const old = VERSIONS.terms;
  VERSIONS.terms = '2099-01-01';
  try {
    const status = await call('GET', '/api/account/legal', { token: u.token });
    assert.deepEqual(status.body.pending, ['terms']);
    const terms = status.body.documents.find((d) => d.doc === 'terms');
    assert.equal(terms.lastAcceptedVersion, old);
    assert.equal(terms.currentVersion, '2099-01-01');
    assert.equal((await call('POST', '/api/whatsapp/campaigns', { token: u.token, form: campaignForm() })).body.code, 'terms_required');
    await call('POST', '/api/account/legal/accept', { token: u.token, json: { versions: { terms: '2099-01-01' } } });
    assert.deepEqual((await call('GET', '/api/account/legal', { token: u.token })).body.pending, []);
    const rows = await Consent.find({ userId: u.id, doc: 'terms' }).lean();
    assert.deepEqual(rows.map((r) => r.version).sort(), ['2099-01-01', old].sort());
  } finally {
    VERSIONS.terms = old;
  }
});

test('administrators can see which versions an account accepted', T, async () => {
  const admin = await register({ acceptTerms: true });
  await User.updateOne({ _id: admin.id }, { $set: { role: 'admin' } });
  const u = await register({ acceptTerms: true });
  const detail = await call('GET', `/api/admin/users/${u.id}`, { token: admin.token });
  assert.equal(detail.status, 200, say(detail));
  assert.deepEqual(detail.body.consents.map((c) => c.doc).sort(), ['privacy', 'terms']);
  assert.ok(detail.body.consents.every((c) => c.via === 'register' && c.acceptedAt));
  assert.ok(!JSON.stringify(detail.body.consents).match(/"ip"|userAgent|textHash/), 'only the facts an administrator needs');
  assert.ok(accounts);
});
