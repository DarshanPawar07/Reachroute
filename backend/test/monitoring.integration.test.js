import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

// /metrics, queue numbers and the watchdog against a THROW-AWAY MongoDB database (the name must contain "test"). Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.ALERT_EMAILS = 'false';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { collectQueueStats, clearStatsCache, createWatchdog } = await import('../src/monitoring/ops.js');
const { Recipient, EmailRecipient, Lock } = models;

const T = { skip, timeout: 30_000 };
const TOKEN = 'metrics-token-for-tests-1234';
let server;
let base;
let draining = false;
const userId = new mongoose.Types.ObjectId();

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: (_req, _res, next) => next() }, { isDraining: () => draining }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (!URI) return;
  config.metricsToken = '';
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await Promise.all([Recipient.deleteMany({ userId }), EmailRecipient.deleteMany({ userId }), Lock.deleteMany({ _id: /^ops-alert:/ })]);
  await mongoose.disconnect();
});

const get = async (path, token) => {
  const res = await fetch(base + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: res.status, type: res.headers.get('content-type'), text: await res.text() };
};

const overdue = (extra = {}) => ({
  campaignId: new mongoose.Types.ObjectId(),
  userId,
  name: '',
  status: 'pending',
  scheduledFor: new Date(Date.now() - 60 * 60_000),
  createdAt: new Date(),
  updatedAt: new Date(),
  ...extra,
});

test('/metrics is switched off without a token, and locked with one', T, async () => {
  config.metricsToken = '';
  assert.equal((await get('/metrics', TOKEN)).status, 404);
  config.metricsToken = TOKEN;
  assert.equal((await get('/metrics')).status, 401);
  assert.equal((await get('/metrics', 'wrong-token-wrong-token')).status, 401);
  const ok = await get('/metrics', TOKEN);
  assert.equal(ok.status, 200);
  assert.match(ok.type, /^text\/plain/);
});

test('/metrics shows process, database and queue numbers, and counts requests by route', T, async () => {
  config.metricsToken = TOKEN;
  await fetch(`${base}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }); // a refused login on a known route
  await fetch(`${base}/unsubscribe/not-a-real-token-1234567890`); // a known route with a secret in its address
  await fetch(`${base}/nowhere/${'a'.repeat(24)}`);
  clearStatsCache();
  const { text } = await get('/metrics', TOKEN);
  assert.match(text, /bulkmessenger_database_up 1/);
  assert.match(text, /bulkmessenger_draining 0/);
  assert.match(text, /bulkmessenger_process_uptime_seconds \d+/);
  assert.match(text, /bulkmessenger_queue_due\{channel="whatsapp"\} \d+/);
  assert.match(text, /bulkmessenger_queue_due\{channel="email"\} \d+/);
  assert.match(text, /bulkmessenger_campaigns\{channel="email",status="running"\} \d+/);
  assert.match(text, /bulkmessenger_http_requests_total\{method="POST",route="\/api\/auth\/login",status="4xx"\} \d+/);
  assert.match(text, /bulkmessenger_http_requests_total\{method="GET",route="\/unsubscribe\/:token",status="\dxx"\} 1/);
  assert.ok(!text.includes('not-a-real-token'), 'the token itself never appears');
  assert.match(text, /bulkmessenger_http_requests_total\{method="GET",route="unmatched",status="4xx"\} \d+/);
  assert.match(text, /bulkmessenger_http_request_duration_seconds_bucket\{method="GET",route="unmatched",le="0.01"\}/);
  assert.ok(!text.includes('a'.repeat(24)), 'no ids from real addresses');
  assert.ok(!/route="\/metrics"|route="\/health"/.test(text), 'probes and scrapes are not counted');
  draining = true;
  assert.match((await get('/metrics', TOKEN)).text, /bulkmessenger_draining 1/);
  draining = false;
});

test('queue numbers see overdue, sending and stuck messages per channel', T, async () => {
  await Recipient.deleteMany({});
  await EmailRecipient.deleteMany({});
  await Recipient.collection.insertMany([
    overdue({ phone: '919100000201' }),
    overdue({ phone: '919100000202', scheduledFor: new Date(Date.now() + 3600_000) }), // not due yet
    overdue({ phone: '919100000203', scheduledFor: null }), // paused / not scheduled
    overdue({ phone: '919100000204', status: 'sending', claimedAt: new Date(Date.now() - 60 * 60_000) }),
  ]);
  await EmailRecipient.collection.insertOne(overdue({ email: 'a@example.com', status: 'sending', claimedAt: new Date() }));
  const s = await collectQueueStats({ fresh: true });
  assert.equal(s.whatsapp.due, 1);
  assert.ok(s.whatsapp.oldestDueSeconds >= 3590 && s.whatsapp.oldestDueSeconds < 3700);
  assert.equal(s.whatsapp.sending, 1);
  assert.equal(s.whatsapp.stuckSending, 1);
  assert.deepEqual({ due: s.email.due, sending: s.email.sending, stuck: s.email.stuckSending, wait: s.email.oldestDueSeconds }, { due: 0, sending: 1, stuck: 0, wait: 0 });
});

test('the watchdog waits for two bad checks, alerts once, and stays quiet once it clears', T, async () => {
  await Recipient.deleteMany({});
  await EmailRecipient.deleteMany({});
  await Lock.deleteMany({ _id: /^ops-alert:/ });
  await Recipient.collection.insertOne(overdue({ phone: '919100000301' })); // waited an hour
  const calls = [];
  const dog = createWatchdog({ notifyOps: async (p) => calls.push(p.key) });

  const first = await dog.runOnce();
  assert.deepEqual(first.problems.map((p) => p.key), ['whatsapp-backlog']);
  assert.deepEqual(first.fired, [], 'one bad check is not enough');
  const second = await dog.runOnce();
  assert.deepEqual(second.fired.map((p) => p.key), ['whatsapp-backlog']);
  assert.match(second.fired[0].message, /whatsapp: 1 message\(s\) are due and the oldest has waited \d+ minutes/);
  await dog.runOnce();
  assert.deepEqual(calls, ['whatsapp-backlog'], 'reported once');

  // another instance that notices the same problem does not send a second alert
  const other = createWatchdog({ notifyOps: async (p) => calls.push(`other:${p.key}`) });
  await other.runOnce();
  const again = await other.runOnce();
  assert.deepEqual(again.fired, []);
  assert.deepEqual(calls, ['whatsapp-backlog']);

  // the problem goes away, comes back, and is reported again after the quiet period
  await Recipient.deleteMany({});
  assert.deepEqual((await dog.runOnce()).problems, []);
  await Lock.deleteMany({ _id: /^ops-alert:/ });
  await Recipient.collection.insertOne(overdue({ phone: '919100000302' }));
  await dog.runOnce();
  assert.deepEqual((await dog.runOnce()).fired.map((p) => p.key), ['whatsapp-backlog']);
  assert.deepEqual(calls, ['whatsapp-backlog', 'whatsapp-backlog']);
});

test('the watchdog flags messages stuck in "sending", and a short wait is not a problem', T, async () => {
  await Recipient.deleteMany({});
  await EmailRecipient.deleteMany({});
  await Lock.deleteMany({ _id: /^ops-alert:/ });
  await EmailRecipient.collection.insertMany([
    overdue({ email: 'late@example.com', status: 'sending', claimedAt: new Date(Date.now() - 60 * 60_000) }),
    overdue({ email: 'fresh@example.com', scheduledFor: new Date(Date.now() - 30_000) }), // due 30 seconds ago: normal
  ]);
  const dog = createWatchdog({ notifyOps: async () => {} });
  const { problems } = await dog.runOnce();
  assert.deepEqual(problems.map((p) => p.key), ['email-stuck']);
});
