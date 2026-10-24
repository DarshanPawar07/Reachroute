import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// Tests for storing WhatsApp replies and the endpoints that list them. They run against a THROW-AWAY MongoDB
// database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
// Nothing is sent and no WhatsApp connection is made: incoming messages are fed in directly.
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
const { createEngine } = await import('../src/engine/sendEngine.js');
const { recordReply, purgeExpiredReplies } = await import('../src/whatsapp/replies.js');
const { extractIncoming } = await import('../src/whatsapp/incoming.js');
const { handleIncoming } = await import('../src/whatsapp/sessionManager.js');
const { Campaign, Recipient, Reply, OptOut, User } = models;

let server;
let base;
const userIds = [];

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
  await Promise.all([
    User.deleteMany({ _id: { $in: userIds } }),
    Campaign.deleteMany({ userId: { $in: userIds } }),
    Recipient.deleteMany({ userId: { $in: userIds } }),
    Reply.deleteMany({ userId: { $in: userIds } }),
    OptOut.deleteMany({ userId: { $in: userIds } }),
  ]);
  await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

const T = { skip, timeout: 30_000 };
const MIN = 60_000;
const DAY = 24 * 60 * MIN;

const newId = () => {
  const id = new mongoose.Types.ObjectId();
  userIds.push(id);
  return id;
};
const makeCampaign = (userId, name) => Campaign.create({ userId, name, template: 'hi', status: 'completed' });
/** A message we sent to this number in a campaign. */
const sentTo = (userId, campaign, phone, { name = 'Asha', sentAt = new Date(), status = 'sent' } = {}) =>
  Recipient.collection.insertOne({ userId, campaignId: campaign._id, phone, name, status, sentAt, createdAt: sentAt, updatedAt: sentAt, deferCount: 0, ambiguous: false });

let counter = 0;
/** A message from `phone` the way Baileys delivers it. */
const incoming = (phone, text, extra = {}) =>
  extractIncoming({
    key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id: `MSG${Date.now()}${counter++}` },
    message: { conversation: text },
    messageTimestamp: Math.floor(Date.now() / 1000),
    pushName: 'Pushed Name',
    ...extra,
  });
const baileys = (phone, text, id = `B${Date.now()}${counter++}`) => ({
  key: { remoteJid: `${phone}@s.whatsapp.net`, fromMe: false, id },
  message: { conversation: text },
  messageTimestamp: Math.floor(Date.now() / 1000),
});

// ---------------------------------------------------------------- storing replies

test('a reply from someone we messaged is stored and linked to the campaign and the message', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'Diwali offer');
  await sentTo(userId, c, '919100000001', { name: 'Asha' });

  const stored = await recordReply(userId, incoming('919100000001', 'Yes please'));
  assert.ok(stored);
  assert.equal(stored.text, 'Yes please');
  assert.equal(stored.name, 'Asha', 'the name from the campaign list wins');
  assert.equal(String(stored.campaignId), String(c._id));
  assert.ok(stored.recipientId);
  assert.equal(stored.optOut, false);
  assert.equal(stored.readAt, null);
});

test('a chat with someone we never messaged is NOT stored (personal chats stay private)', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000002', { status: 'failed' });
  await sentTo(userId, c, '919100000003', { status: 'pending' });
  assert.equal(await recordReply(userId, incoming('919100000002', 'hello')), null, 'the message to them failed, so they never received it');
  assert.equal(await recordReply(userId, incoming('919100000003', 'hello')), null);
  assert.equal(await recordReply(userId, incoming('919100000004', 'mum here')), null);
  assert.equal(await Reply.countDocuments({ userId }), 0);
});

test('another account\'s campaign contacts do not make a chat count', T, async () => {
  const owner = newId();
  const other = newId();
  const c = await makeCampaign(owner, 'c');
  await sentTo(owner, c, '919100000005');
  assert.equal(await recordReply(other, incoming('919100000005', 'hello')), null);
});

test('the reply is linked to the most recent campaign message sent to that number', T, async () => {
  const userId = newId();
  const older = await makeCampaign(userId, 'older');
  const newer = await makeCampaign(userId, 'newer');
  await sentTo(userId, older, '919100000006', { sentAt: new Date(Date.now() - 5 * DAY), name: 'Old Name' });
  await sentTo(userId, newer, '919100000006', { sentAt: new Date(Date.now() - DAY), name: 'New Name' });
  const stored = await recordReply(userId, incoming('919100000006', 'ok'));
  assert.equal(String(stored.campaignId), String(newer._id));
  assert.equal(stored.name, 'New Name');
});

test('the contact\'s own WhatsApp name is used when the list had no name', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000007', { name: '' });
  assert.equal((await recordReply(userId, incoming('919100000007', 'hi'))).name, 'Pushed Name');
});

test('the same message delivered twice is stored once', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000008');
  const m = incoming('919100000008', 'only once');
  assert.ok(await recordReply(userId, m));
  assert.equal(await recordReply(userId, m), null);
  assert.equal(await Reply.countDocuments({ userId }), 1);
  // two different messages are two replies
  assert.ok(await recordReply(userId, incoming('919100000008', 'a second one')));
  assert.equal(await Reply.countDocuments({ userId }), 2);
});

test('photos and voice notes are stored by kind', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000009');
  const photo = incoming('919100000009', '', { message: { imageMessage: { caption: 'the receipt' } } });
  const stored = await recordReply(userId, photo);
  assert.deepEqual({ kind: stored.kind, text: stored.text }, { kind: 'image', text: 'the receipt' });
});

test('incoming messages: STOP records an opt-out and a marked reply, other replies do not opt anyone out', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000010');
  await sentTo(userId, c, '919100000011');

  await handleIncoming(userId, [baileys('919100000010', 'STOP.'), baileys('919100000011', 'Tell me more'), baileys('919100000099', 'stop')]);

  assert.ok(await OptOut.exists({ userId, phone: '919100000010' }), 'STOP opts the number out');
  assert.equal(await OptOut.exists({ userId, phone: '919100000011' }), null, 'a normal reply does not');
  assert.ok(await OptOut.exists({ userId, phone: '919100000099' }), 'STOP from anyone is still honoured, as before');

  const stop = await Reply.findOne({ userId, phone: '919100000010' });
  assert.equal(stop.optOut, true);
  assert.equal(stop.text, 'STOP.');
  assert.equal((await Reply.findOne({ userId, phone: '919100000011' })).optOut, false);
  assert.equal(await Reply.countDocuments({ userId, phone: '919100000099' }), 0, 'but that chat is not stored');
});

test('incoming messages: one bad message does not stop the rest', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000012');
  await handleIncoming(userId, [null, {}, { key: {} }, { key: { remoteJid: 'x@g.us' }, message: { conversation: 'x' } }, baileys('919100000012', 'still works')]);
  assert.equal(await Reply.countDocuments({ userId, text: 'still works' }), 1);
});

// ---------------------------------------------------------------- clean-up

test('old replies are removed, recent ones stay', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000013');
  const old = await recordReply(userId, incoming('919100000013', 'long ago', { messageTimestamp: Math.floor((Date.now() - 200 * DAY) / 1000) }));
  const fresh = await recordReply(userId, incoming('919100000013', 'today'));
  await purgeExpiredReplies(new Date(Date.now() - 90 * DAY));
  assert.equal(await Reply.exists({ _id: old._id }), null);
  assert.ok(await Reply.exists({ _id: fresh._id }));
});

test('the retention clean-up of the engine removes old replies too', T, async () => {
  const userId = newId();
  const c = await makeCampaign(userId, 'c');
  await sentTo(userId, c, '919100000014');
  const old = await recordReply(userId, incoming('919100000014', 'ancient', { messageTimestamp: Math.floor((Date.now() - 400 * DAY) / 1000) }));
  const was = config.retentionDays;
  config.retentionDays = 90;
  try {
    const engine = createEngine({
      name: 'whatsapp', Campaign, Recipient, contactField: 'phone', limits: { dailyCap: 10, minDelay: 0, maxDelay: 0 },
      deliver: async () => ({ outcome: 'sent' }), ownedUserIds: () => [], purgeExpired: purgeExpiredReplies,
    });
    await engine.purgeOld();
  } finally {
    config.retentionDays = was;
  }
  assert.equal(await Reply.exists({ _id: old._id }), null);
});

// ---------------------------------------------------------------- the HTTP API

async function call(method, path, { token, json } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let body;
  if (json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(json);
  }
  const res = await fetch(base + path, { method, headers, body });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (res) => JSON.stringify(res.body);

async function newAccount() {
  const email = `r-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: 'correct horse battery' } });
  assert.equal(res.status, 201, say(res));
  userIds.push(new mongoose.Types.ObjectId(res.body.user.id));
  return { token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
}

/** An account with two campaigns and replies: 3 to "Spring sale" (one STOP), 2 to "Winter sale". */
async function accountWithReplies() {
  const u = await newAccount();
  const spring = await makeCampaign(u.id, 'Spring sale');
  const winter = await makeCampaign(u.id, 'Winter sale');
  for (const [i, c] of [[1, spring], [2, spring], [3, spring], [4, winter], [5, winter]]) await sentTo(u.id, c, `91920000000${i}`, { name: `Person ${i}` });
  const base = Math.floor(Date.now() / 1000);
  const at = (n) => base - (10 - n) * 60; // reply n arrives n minutes after the start: higher n = newer
  await recordReply(u.id, incoming('919200000001', 'first', { messageTimestamp: at(1) }));
  await recordReply(u.id, incoming('919200000002', 'second', { messageTimestamp: at(2) }));
  await recordReply(u.id, incoming('919200000003', 'STOP', { messageTimestamp: at(3) }), { optOut: true });
  await recordReply(u.id, incoming('919200000004', 'fourth', { messageTimestamp: at(4) }));
  await recordReply(u.id, incoming('919200000005', 'fifth', { messageTimestamp: at(5) }));
  return { ...u, spring, winter };
}

test('API: replies are listed newest first with the campaign name and an unread count', T, async () => {
  const u = await accountWithReplies();
  const res = await call('GET', '/api/whatsapp/replies', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.replies.map((r) => r.text), ['fifth', 'fourth', 'STOP', 'second', 'first']);
  assert.equal(res.body.unread, 5);
  assert.equal(res.body.nextBefore, null);
  const stop = res.body.replies.find((r) => r.text === 'STOP');
  assert.equal(stop.optOut, true);
  assert.equal(stop.campaignName, 'Spring sale');
  assert.equal(stop.name, 'Person 3');
  assert.equal(res.body.replies[0].campaignName, 'Winter sale');
});

test('API: filters and paging', T, async () => {
  const u = await accountWithReplies();
  const spring = await call('GET', `/api/whatsapp/replies?campaignId=${u.spring._id}`, { token: u.token });
  assert.deepEqual(spring.body.replies.map((r) => r.text), ['STOP', 'second', 'first']);

  const page1 = await call('GET', '/api/whatsapp/replies?limit=2', { token: u.token });
  assert.deepEqual(page1.body.replies.map((r) => r.text), ['fifth', 'fourth']);
  assert.ok(page1.body.nextBefore);
  const page2 = await call('GET', `/api/whatsapp/replies?limit=2&before=${encodeURIComponent(page1.body.nextBefore)}`, { token: u.token });
  assert.deepEqual(page2.body.replies.map((r) => r.text), ['STOP', 'second']);
  const page3 = await call('GET', `/api/whatsapp/replies?limit=2&before=${encodeURIComponent(page2.body.nextBefore)}`, { token: u.token });
  assert.deepEqual(page3.body.replies.map((r) => r.text), ['first']);
  assert.equal(page3.body.nextBefore, null);

  assert.equal((await call('GET', '/api/whatsapp/replies?campaignId=nope', { token: u.token })).status, 404);
  assert.equal((await call('GET', '/api/whatsapp/replies?before=yesterday-ish', { token: u.token })).status, 400);
});

test('API: reading, the unread badge and the unread filter', T, async () => {
  const u = await accountWithReplies();
  const post = (json) => call('POST', '/api/whatsapp/replies/read', { token: u.token, json });
  assert.equal((await call('GET', '/api/whatsapp/replies/unread-count', { token: u.token })).body.unread, 5);

  const list = (await call('GET', '/api/whatsapp/replies', { token: u.token })).body.replies;
  const [fifth, fourth, stop, second] = list;
  assert.equal((await post({ id: fifth._id })).body.unread, 4);
  assert.equal((await post({ id: fifth._id })).body.unread, 4, 'twice is fine');
  assert.equal((await post({ ids: [fourth._id, stop._id] })).body.unread, 2);

  const unread = await call('GET', '/api/whatsapp/replies?unread=true', { token: u.token });
  assert.deepEqual(unread.body.replies.map((r) => r.text), ['second', 'first']);
  assert.equal(unread.body.replies[0].readAt, null);

  assert.equal((await post({ campaignId: String(u.spring._id) })).body.unread, 0);
  assert.equal((await call('GET', '/api/whatsapp/replies/unread-count', { token: u.token })).body.unread, 0);

  assert.equal((await post({})).status, 400);
  assert.equal((await post({ id: 'nope' })).status, 404);
  assert.equal((await post({ ids: Array.from({ length: 201 }, () => String(second._id)) })).status, 400);
});

test('API: mark everything as read', T, async () => {
  const u = await accountWithReplies();
  assert.equal((await call('POST', '/api/whatsapp/replies/read', { token: u.token, json: { all: true } })).body.unread, 0);
});

test('API: which campaigns got replies', T, async () => {
  const u = await accountWithReplies();
  await call('POST', '/api/whatsapp/replies/read', { token: u.token, json: { campaignId: String(u.winter._id) } });
  const res = await call('GET', '/api/whatsapp/replies/campaigns', { token: u.token });
  assert.equal(res.status, 200, say(res));
  assert.deepEqual(res.body.campaigns.map((c) => [c.campaignName, c.replies, c.unread, c.optOuts]), [
    ['Winter sale', 2, 0, 0], // newest reply first
    ['Spring sale', 3, 3, 1],
  ]);
});

test('API: delete a reply', T, async () => {
  const u = await accountWithReplies();
  const list = (await call('GET', '/api/whatsapp/replies', { token: u.token })).body.replies;
  const del = await call('DELETE', `/api/whatsapp/replies/${list[0]._id}`, { token: u.token });
  assert.equal(del.status, 200, say(del));
  assert.equal(del.body.unread, 4);
  assert.equal((await call('DELETE', `/api/whatsapp/replies/${list[0]._id}`, { token: u.token })).status, 404);
  assert.equal((await call('DELETE', '/api/whatsapp/replies/not-an-id', { token: u.token })).status, 404);
  assert.equal((await call('GET', '/api/whatsapp/replies', { token: u.token })).body.replies.length, 4);
});

test('API: nobody sees, reads or deletes another account\'s replies, and login is required', T, async () => {
  const a = await accountWithReplies();
  const b = await newAccount();
  assert.equal((await call('GET', '/api/whatsapp/replies', { token: b.token })).body.replies.length, 0);
  assert.equal((await call('GET', '/api/whatsapp/replies/unread-count', { token: b.token })).body.unread, 0);
  assert.equal((await call('GET', `/api/whatsapp/replies?campaignId=${a.spring._id}`, { token: b.token })).body.replies.length, 0);
  assert.deepEqual((await call('GET', '/api/whatsapp/replies/campaigns', { token: b.token })).body.campaigns, []);

  const list = (await call('GET', '/api/whatsapp/replies', { token: a.token })).body.replies;
  assert.equal((await call('DELETE', `/api/whatsapp/replies/${list[0]._id}`, { token: b.token })).status, 404);
  await call('POST', '/api/whatsapp/replies/read', { token: b.token, json: { all: true } });
  await call('POST', '/api/whatsapp/replies/read', { token: b.token, json: { campaignId: String(a.spring._id) } });
  assert.equal((await call('GET', '/api/whatsapp/replies/unread-count', { token: a.token })).body.unread, 5, 'untouched');

  assert.equal((await call('GET', '/api/whatsapp/replies')).status, 401);
});

test('API: a reply whose campaign was cleaned up is still listed, without a campaign name', T, async () => {
  const u = await accountWithReplies();
  await Campaign.deleteOne({ _id: u.winter._id });
  const res = await call('GET', '/api/whatsapp/replies?limit=1', { token: u.token });
  assert.equal(res.body.replies[0].text, 'fifth');
  assert.equal(res.body.replies[0].campaignName, null);
});
