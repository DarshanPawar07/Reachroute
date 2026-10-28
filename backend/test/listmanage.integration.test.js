import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Contact lists: search, groups, adding and editing contacts, against a THROW-AWAY MongoDB database (name must contain "test").
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
const { User, SmtpSettings, EmailCampaign, EmailRecipient, ContactList, ListContact } = models;

config.requireTermsAcceptance = false;
config.requireEmailVerification = false;
config.allowPrivateSmtp = true;
config.maxActiveCampaigns = 5; // the campaign test starts three

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 60_000 };
const tag = `lst${Date.now().toString(36)}`;
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
    ContactList.deleteMany({ userId: { $in: ids } }),
    ListContact.deleteMany({ userId: { $in: ids } }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, form } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (json !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers, body: form || (json === undefined ? undefined : JSON.stringify(json)) });
  const text = Buffer.from(await res.arrayBuffer()).toString('utf8');
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    /* not JSON */
  }
  return { status: res.status, body, text };
}
const say = (r) => JSON.stringify(r.body);

async function emailUser() {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const u = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  made.push(u);
  const fromEmail = `from.${tag}.${counter}@example.com`;
  const saved = await call('PUT', '/api/email/settings', { token: u.token, json: { host: 'smtp.example.com', port: 587, user: 'me', pass: 'secret-password', fromEmail, fromName: 'Me' } });
  assert.equal(saved.status, 200, say(saved));
  await SmtpSettings.updateOne({ userId: u.id }, { $set: { verifiedEmail: fromEmail, verifiedAt: new Date() } });
  return u;
}



const addr = (i) => `p${i}.${tag}@example.com`;

async function makeList(u, { kind = 'email', name = `L${counter++}`, rows, group } = {}) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('kind', kind);
  if (group !== undefined) fd.append('group', group);
  const text = kind === 'email' ? `name,email\n${rows.join('\n')}\n` : `name,phone\n${rows.join('\n')}\n`;
  fd.append('file', new Blob([text], { type: 'text/csv' }), 'c.csv');
  const res = await call('POST', '/api/lists', { token: u.token, form: fd });
  assert.equal(res.status, 201, say(res));
  return res.body.list.id;
}
const emailRows = (from, to) => Array.from({ length: to - from }, (_, i) => `Person${from + i},${addr(from + i)}`);
const get = (u, id, qs = '') => call('GET', `/api/lists/${id}${qs}`, { token: u.token });
const addFile = (u, id, rows, group) => {
  const fd = new FormData();
  if (group !== undefined) fd.append('group', group);
  fd.append('file', new Blob([`name,email\n${rows.join('\n')}\n`], { type: 'text/csv' }), 'c.csv');
  return call('POST', `/api/lists/${id}/contacts`, { token: u.token, form: fd });
};

test('search finds people by name, email or phone, and says how many matched', T, async () => {
  const u = await emailUser();
  const id = await makeList(u, { rows: ['Asha Rao,asha.rao@example.com', 'Rahul Dev,rahul@example.com', 'Ashok K,ashok@example.org'] });
  const byName = await get(u, id, '?q=ash');
  assert.equal(byName.body.matching, 2);
  assert.equal(byName.body.contacts.length, 2);
  assert.equal(byName.body.list.total, 3, 'the list size does not change with the search');
  assert.equal((await get(u, id, '?q=EXAMPLE.ORG')).body.matching, 1);
  assert.equal((await get(u, id, '?q=nobody')).body.matching, 0);
  assert.equal((await get(u, id, '?q=.*')).body.matching, 0, 'a search is plain text, not a pattern');
  assert.equal((await get(u, id)).body.matching, 3);

  const w = await makeList(u, { kind: 'whatsapp', rows: ['Asha,+919876543210', 'Rahul,+919123456780'] });
  assert.equal((await get(u, w, '?q=%2B91%2098765')).body.matching, 1);
});

test('a group on an upload labels the new people, and the people already in the list', T, async () => {
  const u = await emailUser();
  const id = await makeList(u, { rows: emailRows(0, 3), group: ' Pune ' });
  let d = await get(u, id);
  assert.deepEqual(d.body.groups, [{ name: 'pune', count: 3 }]);
  assert.ok(d.body.contacts.every((c) => c.groups.length === 1 && c.groups[0] === 'pune'));

  const added = await addFile(u, id, emailRows(2, 5), 'customers'); // p2 is already there, p3 and p4 are new
  assert.equal(added.status, 200, say(added));
  assert.equal(added.body.added, 2);
  d = await get(u, id);
  assert.deepEqual(d.body.groups, [{ name: 'customers', count: 3 }, { name: 'pune', count: 3 }]);
  const both = await get(u, id, '?group=pune&q=person2');
  assert.deepEqual(both.body.contacts[0].groups.sort(), ['customers', 'pune']);
  assert.equal((await get(u, id, '?group=customers')).body.matching, 3);
  assert.equal((await get(u, id, '?group=CUSTOMERS')).body.matching, 3, 'group names are not case sensitive');
  assert.equal((await get(u, id, '?group=nope')).body.matching, 0);
});

test('adding one contact by hand', T, async () => {
  const u = await emailUser();
  const id = await makeList(u, { rows: emailRows(0, 1) });
  const add = (json) => call('POST', `/api/lists/${id}/contacts/one`, { token: u.token, json });

  const ok = await add({ name: ' Neha ', value: ` NEHA.${tag}@Example.com `, groups: ' Pune , CUSTOMERS,pune' });
  assert.equal(ok.status, 201, say(ok));
  assert.equal(ok.body.contact.name, 'Neha');
  assert.equal(ok.body.contact.value, `neha.${tag}@example.com`);
  assert.deepEqual(ok.body.contact.groups, ['pune', 'customers']);

  assert.equal((await add({ value: addr(0) })).status, 409, 'already in the list');
  assert.equal((await add({ value: `neha.${tag}@example.com` })).status, 409);
  assert.equal((await add({ value: 'not an email' })).status, 400);
  assert.equal((await add({ value: `x.${tag}@example.com`, groups: Array.from({ length: 11 }, (_, i) => `g${i}`) })).status, 400);
  assert.equal((await add({ value: `x.${tag}@example.com`, groups: ['a'.repeat(31)] })).status, 400);
  assert.equal((await get(u, id)).body.list.total, 2);

  const w = await makeList(u, { kind: 'whatsapp', rows: ['Asha,+919876543210'] });
  const phone = await call('POST', `/api/lists/${w}/contacts/one`, { token: u.token, json: { name: 'Ravi', value: '+91 98765 43211' } });
  assert.equal(phone.status, 201, say(phone));
  assert.equal(phone.body.contact.value, '919876543211');
  assert.equal((await call('POST', `/api/lists/${w}/contacts/one`, { token: u.token, json: { value: '123' } })).status, 400);
  assert.equal((await call('POST', `/api/lists/${w}/contacts/one`, { token: u.token, json: { value: '9876543210' } })).status, 409, 'same number written another way');
});

test('editing a contact', T, async () => {
  const u = await emailUser();
  const id = await makeList(u, { rows: emailRows(0, 2) });
  const [a, b] = (await get(u, id)).body.contacts;
  const edit = (contact, json, token = u.token) => call('PATCH', `/api/lists/${id}/contacts/${contact._id}`, { token, json });

  const renamed = await edit(a, { name: 'New Name', groups: ['vip'] });
  assert.equal(renamed.status, 200, say(renamed));
  assert.equal(renamed.body.contact.name, 'New Name');
  assert.deepEqual(renamed.body.contact.groups, ['vip']);
  assert.equal(renamed.body.contact.value, a.value, 'the address did not change');

  await ListContact.updateOne({ _id: a._id }, { $set: { lastCampaignAt: new Date() } });
  const same = await edit(a, { value: a.value.toUpperCase() }); // same address, written differently
  assert.ok((await ListContact.findById(a._id).lean()).lastCampaignAt, 'the same person stays marked as messaged');
  assert.equal(same.status, 200);
  const moved = await edit(a, { value: `new.${tag}@example.com` });
  assert.equal(moved.status, 200, say(moved));
  assert.equal(moved.body.contact.lastCampaignAt, null, 'a new address is a new person');

  assert.equal((await edit(a, { value: b.value })).status, 409);
  assert.equal((await edit(a, { value: 'nope' })).status, 400);
  assert.equal((await edit(a, {})).status, 400);
  assert.equal((await edit(a, { groups: [] })).body.contact.groups.length, 0, 'groups can be cleared');

  const stranger = await emailUser();
  assert.equal((await edit(a, { name: 'Hacked' }, stranger.token)).status, 404);
  assert.equal((await ListContact.findById(a._id).lean()).name, 'New Name');
});

test('a campaign can use just one group of a list', T, async () => {
  const u = await emailUser();
  const id = await makeList(u, { rows: emailRows(0, 4), group: 'pune' });
  await addFile(u, id, emailRows(4, 6), 'mumbai');
  const start = (extra) => {
    const fd = new FormData();
    fd.append('listId', id);
    fd.append('name', `C${counter++}`);
    fd.append('subject', 'Hi');
    fd.append('body', 'Hello');
    fd.append('consentConfirmed', 'true');
    for (const [k, v] of Object.entries(extra)) fd.append(k, v);
    return call('POST', '/api/email/campaigns', { token: u.token, form: fd });
  };

  const res = await start({ group: 'Mumbai' });
  assert.equal(res.status, 201, say(res));
  assert.equal(res.body.summary.queued, 2);
  const sent = (await EmailRecipient.find({ campaignId: res.body.campaign._id }).lean()).map((r) => r.email).sort();
  assert.deepEqual(sent, [addr(4), addr(5)]);
  assert.equal((await get(u, id)).body.list.fresh, 4, 'only the group was marked as messaged');

  const again = await start({ group: 'mumbai' });
  assert.equal(again.status, 400, 'everyone in the group was already messaged');
  assert.match(again.body.error, /mumbai/);
  assert.equal((await start({ group: 'nobody-here' })).status, 400);

  const rest = await start({});
  assert.equal(rest.status, 201, say(rest));
  assert.equal(rest.body.summary.queued, 4, 'without a group, everyone not messaged yet');
});
