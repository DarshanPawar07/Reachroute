import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Tests for saved templates, previews and {{column}} variables. They run against a THROW-AWAY MongoDB database
// (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
// Nothing is sent: the dispatcher is not started, and no SMTP server is contacted.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST ??= 'smtp.test.invalid';
process.env.SMTP_FROM_EMAIL ??= 'no-reply@test.invalid';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { closeAllSenders } = await import('../src/email/mailer.js');
const { createEngine } = await import('../src/engine/sendEngine.js');
const { whatsappChannel, emailChannel } = await import('../src/engine/channels.js');
const { Template, ContactList, ListContact, EmailCampaign, EmailRecipient, Campaign, Recipient, User } = models;

config.maxActiveCampaigns = 20;

let server;
let base;
const accounts = [];
const engineUsers = [];

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
  closeAllSenders();
  const ids = [...accounts.map((a) => a.id), ...engineUsers];
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    Template.deleteMany({ userId: { $in: ids } }),
    ContactList.deleteMany({ userId: { $in: ids } }),
    ListContact.deleteMany({ userId: { $in: ids } }),
    EmailCampaign.deleteMany({ userId: { $in: ids } }),
    EmailRecipient.deleteMany({ userId: { $in: ids } }),
    Campaign.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

const T = { skip, timeout: 30_000 };

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

async function newAccount() {
  const email = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: 'correct horse battery' } });
  assert.equal(res.status, 201, say(res));
  const account = { token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  accounts.push(account);
  return account;
}

const csvFile = (fd, csv) => fd.append('file', new Blob([csv], { type: 'text/csv' }), 'contacts.csv');

function form(fields, csv) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  if (csv !== undefined) csvFile(fd, csv);
  return fd;
}

const CONTACTS = 'name,email,company,city\nAsha Rao,asha@example.com,Acme,Pune\nRahul Shah,rahul@example.com,,Mumbai\nMeera,meera@example.com,Globex,\n';

const makeList = (u, name, csv = CONTACTS, kind = 'email') => call('POST', '/api/lists', { token: u.token, form: form({ name, kind }, csv) });
const startEmail = (u, fields, csv = CONTACTS) =>
  call('POST', '/api/email/campaigns', { token: u.token, form: form({ name: 'tpl test', subject: 'Hi', body: 'Hello {{name}}', consentConfirmed: 'true', ...fields }, csv) });

// ---------------------------------------------------------------- columns in lists

test('lists remember the extra columns of their contacts', T, async () => {
  const u = await newAccount();
  const res = await makeList(u, 'Customers');
  assert.equal(res.status, 201, say(res));
  assert.deepEqual(res.body.list.columns.sort(), ['city', 'company']);
  assert.deepEqual(res.body.summary.columns.sort(), ['city', 'company']);

  const detail = await call('GET', `/api/lists/${res.body.list.id}`, { token: u.token });
  assert.deepEqual(detail.body.list.columns.sort(), ['city', 'company']);
  const asha = detail.body.contacts.find((c) => c.value === 'asha@example.com');
  assert.deepEqual(asha.fields, { company: 'Acme', city: 'Pune' });
  assert.deepEqual(detail.body.contacts.find((c) => c.value === 'rahul@example.com').fields, { city: 'Mumbai' });

  const all = await call('GET', '/api/lists', { token: u.token });
  assert.deepEqual(all.body.lists[0].columns.sort(), ['city', 'company']);
});

test('adding contacts adds their new columns, and keeps the old ones', T, async () => {
  const u = await newAccount();
  const made = await makeList(u, 'Growing');
  const id = made.body.list.id;
  const more = await call('POST', `/api/lists/${id}/contacts`, { token: u.token, form: form({}, 'name,email,plan\nNew One,new@example.com,gold\n') });
  assert.equal(more.status, 200, say(more));
  assert.equal(more.body.added, 1);
  assert.deepEqual(more.body.columns, ['plan']);
  const detail = await call('GET', `/api/lists/${id}`, { token: u.token });
  assert.deepEqual(detail.body.list.columns.sort(), ['city', 'company', 'plan']);
  assert.deepEqual(detail.body.contacts.find((c) => c.value === 'new@example.com').fields, { plan: 'gold' });
});

test('a list without extra columns has none, and too many columns are reported', T, async () => {
  const u = await newAccount();
  const plain = await makeList(u, 'Plain', 'name,email\nA,a@example.com\n');
  assert.deepEqual(plain.body.list.columns, []);
  const headers = Array.from({ length: 23 }, (_, i) => `c${i + 1}`);
  const wide = await makeList(u, 'Wide', `name,email,${headers.join(',')}\nA,a@example.com,${headers.map((_, i) => `v${i}`).join(',')}\n`);
  assert.equal(wide.status, 201, say(wide));
  assert.equal(wide.body.list.columns.length, 20);
  assert.equal(wide.body.summary.ignoredColumns.length, 3);
});

// ---------------------------------------------------------------- campaigns with variables

test('a campaign can use the columns of the file, and each contact keeps their own values', T, async () => {
  const u = await newAccount();
  const res = await startEmail(u, { subject: 'News for {{first_name}}', body: 'Hi {{name}} at {{company|your company}} in {{city|your city}}' });
  assert.equal(res.status, 201, say(res));
  assert.deepEqual(res.body.summary.blankValues, {}, 'every variable has a fallback');
  const rows = await EmailRecipient.find({ campaignId: res.body.campaign._id }).lean();
  const by = Object.fromEntries(rows.map((r) => [r.email, r.fields ?? null]));
  assert.deepEqual(by['asha@example.com'], { company: 'Acme', city: 'Pune' });
  assert.deepEqual(by['rahul@example.com'], { city: 'Mumbai' });
  assert.deepEqual(by['meera@example.com'], { company: 'Globex' });
});

test('a variable the file has no column for stops the campaign, and nothing is created', T, async () => {
  const u = await newAccount();
  const res = await startEmail(u, { body: 'Hello {{name}}, your {{order_no}} is ready' });
  assert.equal(res.status, 400, say(res));
  assert.match(res.body.error, /uses \{\{order_no\}\}.*no "order_no" column.*Columns found: city, company/);
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), 0);
  assert.equal(await EmailRecipient.countDocuments({ userId: u.id }), 0);

  const inSubject = await startEmail(u, { subject: 'About {{order_no}}' });
  assert.equal(inSubject.status, 400, say(inSubject));
  const withFallback = await startEmail(u, { body: 'Your {{order_no|order}} is ready' });
  assert.equal(withFallback.status, 201, 'a fallback is enough');
});

test('a misspelt placeholder stops the campaign instead of reaching people as it is', T, async () => {
  const u = await newAccount();
  for (const body of ['Hi {{first-name}}', 'Hi {{ }}', 'Hi {{city|a|b}}']) {
    const res = await startEmail(u, { body });
    assert.equal(res.status, 400, `${body}: ${say(res)}`);
    assert.match(res.body.error, /is not a valid variable/);
  }
  assert.equal(await EmailCampaign.countDocuments({ userId: u.id }), 0);
});

test('contacts that have no value for a column without a fallback are counted, not hidden', T, async () => {
  const u = await newAccount();
  const res = await startEmail(u, { body: 'Hi {{name}} from {{company}} in {{city}}' });
  assert.equal(res.status, 201, say(res));
  assert.deepEqual(res.body.summary.blankValues, { company: 1, city: 1 });
});

test('a campaign from a saved list uses the list\'s columns, and a list missing one is refused and gives its people back', T, async () => {
  const u = await newAccount();
  const made = await makeList(u, 'Customers');
  const listId = made.body.list.id;

  const bad = await call('POST', '/api/email/campaigns', {
    token: u.token,
    form: form({ name: 'from list', subject: 'Hi', body: 'Plan {{plan}}', consentConfirmed: 'true', listId }),
  });
  assert.equal(bad.status, 400, say(bad));
  assert.match(bad.body.error, /no "plan" column/);
  assert.equal((await call('GET', `/api/lists/${listId}`, { token: u.token })).body.list.fresh, 3, 'nobody was marked as messaged');

  const ok = await call('POST', '/api/email/campaigns', {
    token: u.token,
    form: form({ name: 'from list', subject: 'Hi', body: 'From {{company|home}} in {{city|town}}', consentConfirmed: 'true', listId }),
  });
  assert.equal(ok.status, 201, say(ok));
  const rows = await EmailRecipient.find({ campaignId: ok.body.campaign._id }).lean();
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find((r) => r.email === 'asha@example.com').fields, { company: 'Acme', city: 'Pune' });
});

test('engine: the columns reach the delivery step with the recipient', T, async () => {
  const userId = new mongoose.Types.ObjectId();
  engineUsers.push(userId);
  const seen = [];
  const engine = createEngine({
    name: 'whatsapp', Campaign, Recipient, contactField: 'phone', limits: { dailyCap: 100, minDelay: 0, maxDelay: 0 },
    deliver: async ({ recipient }) => (seen.push({ phone: recipient.phone, fields: recipient.fields ?? null }), { outcome: 'sent' }),
    ownedUserIds: () => [String(userId)],
  });
  const c = await engine.createCampaign({
    userId,
    fields: { name: 'cols', template: 'hi {{city}}' },
    contacts: [{ name: 'A', phone: '919100000101', fields: { city: 'Pune' } }, { name: 'B', phone: '919100000102' }],
  });
  await Recipient.updateMany({ campaignId: c._id }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });
  for (let i = 0; i < 30 && seen.length < 2; i++) {
    await engine.tick();
    await new Promise((r) => setTimeout(r, 50));
  }
  assert.deepEqual(seen.sort((a, b) => a.phone.localeCompare(b.phone)), [{ phone: '919100000101', fields: { city: 'Pune' } }, { phone: '919100000102', fields: null }]);
});

test('both channels say which texts can contain variables', T, () => {
  assert.deepEqual(whatsappChannel.templateTexts({ template: 'T' }), ['T']);
  assert.deepEqual(emailChannel.templateTexts({ subject: 'S', body: 'B' }), ['S', 'B']);
});

// ---------------------------------------------------------------- saved templates

const WA = { kind: 'whatsapp', name: 'Welcome', message: 'Hi {{first_name}}, welcome to {{company|our shop}}!' };
const EMAIL = { kind: 'email', name: 'Newsletter', subject: 'News for {{first_name}}', body: '<p>Hi {{name}}</p>', bodyFormat: 'html' };

test('templates: save, list, change and delete', T, async () => {
  const u = await newAccount();
  const wa = await call('POST', '/api/templates', { token: u.token, json: WA });
  assert.equal(wa.status, 201, say(wa));
  assert.deepEqual({ kind: wa.body.template.kind, name: wa.body.template.name, message: wa.body.template.message }, WA);
  const email = await call('POST', '/api/templates', { token: u.token, json: EMAIL });
  assert.equal(email.status, 201, say(email));
  assert.equal(email.body.template.bodyFormat, 'html');
  assert.equal(email.body.template.message, undefined, 'only the fields of its own kind');

  const all = await call('GET', '/api/templates', { token: u.token });
  assert.equal(all.body.templates.length, 2);
  assert.equal(all.body.limit, config.maxTemplates);
  assert.deepEqual((await call('GET', '/api/templates?kind=email', { token: u.token })).body.templates.map((t) => t.name), ['Newsletter']);
  assert.equal((await call('GET', '/api/templates?kind=sms', { token: u.token })).status, 400);

  const id = wa.body.template.id;
  const put = await call('PUT', `/api/templates/${id}`, { token: u.token, json: { name: 'Welcome v2', message: 'Hello {{name}}' } });
  assert.equal(put.status, 200, say(put));
  assert.equal(put.body.template.name, 'Welcome v2');
  assert.equal(put.body.template.message, 'Hello {{name}}');
  const keepName = await call('PUT', `/api/templates/${id}`, { token: u.token, json: { message: 'Only the message' } });
  assert.equal(keepName.body.template.name, 'Welcome v2', 'the name stays when not sent');

  assert.equal((await call('DELETE', `/api/templates/${id}`, { token: u.token })).status, 200);
  assert.equal((await call('DELETE', `/api/templates/${id}`, { token: u.token })).status, 404);
  assert.equal((await call('GET', '/api/templates', { token: u.token })).body.templates.length, 1);
});

test('templates: names are unique per kind, and bad input is refused', T, async () => {
  const u = await newAccount();
  assert.equal((await call('POST', '/api/templates', { token: u.token, json: WA })).status, 201);
  assert.equal((await call('POST', '/api/templates', { token: u.token, json: WA })).status, 409, 'same name, same kind');
  assert.equal((await call('POST', '/api/templates', { token: u.token, json: { ...EMAIL, name: 'Welcome' } })).status, 201, 'the same name for the other kind is fine');

  const other = await call('POST', '/api/templates', { token: u.token, json: { ...WA, name: 'Second' } });
  const clash = await call('PUT', `/api/templates/${other.body.template.id}`, { token: u.token, json: { name: 'Welcome', message: 'x' } });
  assert.equal(clash.status, 409);

  const bad = (json) => call('POST', '/api/templates', { token: u.token, json });
  assert.equal((await bad({ ...WA, kind: 'sms' })).status, 400);
  assert.equal((await bad({ ...WA, name: '  ' })).status, 400);
  assert.equal((await bad({ kind: 'whatsapp', name: 'x' })).status, 400, 'no message');
  assert.equal((await bad({ ...WA, name: 'long', message: 'x'.repeat(1001) })).status, 400);
  assert.equal((await bad({ ...EMAIL, name: 'e1', subject: '' })).status, 400);
  assert.equal((await bad({ ...EMAIL, name: 'e2', body: 'x'.repeat(20_001) })).status, 400);
  const broken = await bad({ ...WA, name: 'broken', message: 'Hi {{first-name}}' });
  assert.equal(broken.status, 400);
  assert.match(broken.body.error, /not a valid variable/);
  assert.equal((await call('PUT', `/api/templates/${other.body.template.id}`, { token: u.token, json: { message: 'Hi {{}}' } })).status, 400);
  assert.equal((await call('PUT', `/api/templates/${other.body.template.id}`, { token: u.token, json: { subject: 's', body: 'b' } })).status, 400, 'a WhatsApp template needs a message');
});

test('templates: there is a limit per account', T, async () => {
  const u = await newAccount();
  const was = config.maxTemplates;
  config.maxTemplates = 2;
  try {
    assert.equal((await call('POST', '/api/templates', { token: u.token, json: { ...WA, name: 'one' } })).status, 201);
    assert.equal((await call('POST', '/api/templates', { token: u.token, json: { ...WA, name: 'two' } })).status, 201);
    const third = await call('POST', '/api/templates', { token: u.token, json: { ...WA, name: 'three' } });
    assert.equal(third.status, 429, say(third));
  } finally {
    config.maxTemplates = was;
  }
});

test('templates: nobody sees, changes or removes another account\'s templates, and login is required', T, async () => {
  const a = await newAccount();
  const b = await newAccount();
  const made = await call('POST', '/api/templates', { token: a.token, json: WA });
  const id = made.body.template.id;
  assert.deepEqual((await call('GET', '/api/templates', { token: b.token })).body.templates, []);
  assert.equal((await call('PUT', `/api/templates/${id}`, { token: b.token, json: { message: 'mine now' } })).status, 404);
  assert.equal((await call('DELETE', `/api/templates/${id}`, { token: b.token })).status, 404);
  assert.equal((await call('PUT', '/api/templates/not-an-id', { token: a.token, json: {} })).status, 404);
  assert.equal((await call('GET', '/api/templates')).status, 401);
  assert.equal((await call('GET', '/api/templates/variables')).status, 401);
  assert.equal((await Template.findById(id)).message, WA.message);
});

test('templates: the list of things you can write', T, async () => {
  const u = await newAccount();
  const res = await call('GET', '/api/templates/variables', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.builtIn.map((v) => v.key), ['name', 'first_name']);
  assert.ok(res.body.syntax.some((s) => s.example === '{{city|your city}}'));
});

// ---------------------------------------------------------------- preview

test('preview: a WhatsApp message for a made-up contact', T, async () => {
  const u = await newAccount();
  const res = await call('POST', '/api/templates/preview', {
    token: u.token,
    json: { kind: 'whatsapp', message: 'Hi {{first_name}} from {{city|town}}, {{company}}!', sample: { name: 'Asha Rao', fields: { 'City': 'Pune', company: 'Acme' } } },
  });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.previews.length, 1);
  assert.equal(res.body.previews[0].text, 'Hi Asha from Pune, Acme!\n\nReply STOP to opt out.');
  assert.deepEqual(res.body.variables.map((v) => v.key).sort(), ['city', 'company']);
  assert.deepEqual(res.body.problems, []);

  const without = await call('POST', '/api/templates/preview', { token: u.token, json: { kind: 'whatsapp', message: 'Hi {{name}}', appendOptOut: false } });
  assert.equal(without.body.previews[0].text, 'Hi Asha Rao', 'a default sample contact, and no opt-out line when switched off');
});

test('preview: an email shows subject, text and html', T, async () => {
  const u = await newAccount();
  const res = await call('POST', '/api/templates/preview', {
    token: u.token,
    json: { ...EMAIL, subject: 'News for {{first_name}} at {{company}}', body: '<p>Hi {{name}}</p>', sample: { name: 'Asha Rao', fields: { company: 'Acme' } } },
  });
  assert.equal(res.status, 200, say(res));
  const p = res.body.previews[0];
  assert.equal(p.subject, 'News for Asha at Acme');
  assert.ok(p.text.includes('Hi Asha Rao'));
  assert.ok(p.html.includes('Hi Asha Rao') && p.html.includes('Unsubscribe'));
});

test('preview: with a list it uses the first contacts and their real columns, and warns about missing ones', T, async () => {
  const u = await newAccount();
  const made = await makeList(u, 'Customers');
  const listId = made.body.list.id;
  const res = await call('POST', '/api/templates/preview', {
    token: u.token,
    json: { kind: 'email', subject: 'Hi {{first_name}}', body: 'From {{company|home}} in {{city|town}}', bodyFormat: 'text', listId, count: 2 },
  });
  assert.equal(res.status, 200, say(res));
  assert.equal(res.body.previews.length, 2);
  assert.equal(res.body.previews[0].subject, 'Hi Asha');
  assert.ok(res.body.previews[0].text.includes('From Acme in Pune'));
  assert.ok(res.body.previews[1].text.includes('From home in Mumbai'), 'the second contact has no company, so the fallback shows');
  assert.deepEqual(res.body.columns.sort(), ['city', 'company']);
  assert.deepEqual(res.body.problems, []);

  const missing = await call('POST', '/api/templates/preview', { token: u.token, json: { kind: 'email', subject: 's', body: 'Plan {{plan}} and {{first-name}}', listId } });
  assert.equal(missing.body.problems.length, 2);
  assert.ok(missing.body.problems.some((p) => /no "plan" column/.test(p)));
  assert.ok(missing.body.problems.some((p) => /not a valid variable/.test(p)));

  const many = await call('POST', '/api/templates/preview', { token: u.token, json: { kind: 'email', subject: 's', body: 'b', listId, count: 99 } });
  assert.equal(many.body.previews.length, 3, 'only as many as the list has, never more than 5');
});

test('preview: a list that is not yours, not found, or of the other kind is refused', T, async () => {
  const a = await newAccount();
  const b = await newAccount();
  const made = await makeList(a, 'Private');
  const listId = made.body.list.id;
  const preview = (token, json) => call('POST', '/api/templates/preview', { token, json });
  assert.equal((await preview(b.token, { kind: 'email', subject: 's', body: 'b', listId })).status, 404);
  assert.equal((await preview(a.token, { kind: 'whatsapp', message: 'x', listId })).status, 404, 'an email list cannot preview a WhatsApp message');
  assert.equal((await preview(a.token, { kind: 'email', subject: 's', body: 'b', listId: 'nope' })).status, 404);
  assert.equal((await preview(a.token, { kind: 'email', subject: 's', body: 'b', listId: String(new mongoose.Types.ObjectId()) })).status, 404);
  assert.equal((await preview(a.token, { kind: 'sms', message: 'x' })).status, 400);
  assert.equal((await preview(a.token, { kind: 'whatsapp' })).status, 400);
  assert.equal((await call('POST', '/api/templates/preview', { json: { kind: 'whatsapp', message: 'x' } })).status, 401);
});

test('preview: broken placeholders are reported, not refused', T, async () => {
  const u = await newAccount();
  const res = await call('POST', '/api/templates/preview', { token: u.token, json: { kind: 'whatsapp', message: 'Hi {{first-name}}' } });
  assert.equal(res.status, 200, say(res));
  assert.match(res.body.problems[0], /not a valid variable/);
});
