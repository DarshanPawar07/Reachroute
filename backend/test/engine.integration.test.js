import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';

// Runs the real send engine against a real MongoDB. It needs a THROW-AWAY database, because it empties the
// campaign collections first. Example:
//   TEST_MONGO_URI=mongodb://127.0.0.1:27017/bulk_messenger_test npm test
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test" (it is emptied by these tests)');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run the engine tests';

const mongoose = (await import('mongoose')).default;
const { config } = await import('../src/config.js');
const { Campaign, Recipient } = await import('../src/models.js');
const { createEngine } = await import('../src/engine/sendEngine.js');

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all([Campaign.init(), Recipient.init()]);
  await Promise.all([Campaign.deleteMany({}), Recipient.deleteMany({})]);
});
after(async () => {
  if (URI) await mongoose.disconnect();
});

// ---------------------------------------------------------------- helpers

/** A WhatsApp-shaped channel whose delivery is whatever the test says. No pauses between sends. */
const channelWith = (deliver, limits = {}) => ({
  name: 'whatsapp',
  Campaign,
  Recipient,
  contactField: 'phone',
  limits: { dailyCap: 1000, minDelay: 0, maxDelay: 0, ...limits },
  deliver,
});

const people = (n) => Array.from({ length: n }, (_, i) => ({ name: `P${i}`, phone: `9190000${String(i).padStart(5, '0')}` }));
const fields = { name: 'test campaign', template: 'hi {{name}}' };

/** Pretend the waiting time has passed so scheduled messages are due right now. */
const makeDue = (c) =>
  Recipient.updateMany({ campaignId: c._id, status: 'pending', scheduledFor: { $ne: null } }, { $set: { scheduledFor: new Date(Date.now() - 1000) } });

/** Run the dispatcher by hand until the campaign reaches the state the test is waiting for. */
async function drive(engines, campaign, until, ms = 8000) {
  const deadline = Date.now() + ms;
  for (;;) {
    await makeDue(campaign);
    await Promise.all(engines.map((e) => e.tick()));
    const c = await Campaign.findById(campaign._id).lean();
    if (until(c)) return c;
    if (Date.now() > deadline) assert.fail(`timed out: campaign is "${c.status}" (${c.sentCount} sent, ${c.failedCount} failed)`);
    await sleep(30);
  }
}

/** Fresh user per test, and always clean up. */
async function withUser(fn) {
  const userId = new mongoose.Types.ObjectId();
  try {
    await fn(userId);
  } finally {
    await Promise.all([Recipient.deleteMany({ userId }), Campaign.deleteMany({ userId })]);
  }
}
const statuses = async (c) => (await Recipient.find({ campaignId: c._id }).lean()).map((r) => r.status);
const T = { skip, timeout: 30_000 };

// ---------------------------------------------------------------- tests

test('a campaign sends every recipient and completes', T, () =>
  withUser(async (userId) => {
    const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(3) });
    assert.equal(c.status, 'running');
    const done = await drive([engine], c, (x) => x.status === 'completed');
    assert.equal(done.sentCount, 3);
    assert.deepEqual(await statuses(c), ['sent', 'sent', 'sent']);
  }));

test('two instances never send the same recipient twice', T, () =>
  withUser(async (userId) => {
    const calls = new Map();
    const deliver = async ({ recipient }) => {
      calls.set(String(recipient._id), (calls.get(String(recipient._id)) || 0) + 1);
      await sleep(5);
      return { outcome: 'sent' };
    };
    const channel = channelWith(deliver);
    const [a, b] = [createEngine(channel), createEngine(channel)];
    const c = await a.createCampaign({ userId, fields, contacts: people(30) });
    await drive([a, b], c, (x) => x.status === 'completed');
    assert.equal(calls.size, 30);
    assert.ok([...calls.values()].every((n) => n === 1), 'a recipient was delivered more than once');
  }));

test('a paused campaign sends nothing until it is resumed', T, () =>
  withUser(async (userId) => {
    let delivered = 0;
    const engine = createEngine(channelWith(async () => (delivered++, { outcome: 'sent' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(3) });
    await engine.pause(userId, c._id);
    for (let i = 0; i < 4; i++) {
      await makeDue(c);
      await engine.tick();
      await sleep(40);
    }
    assert.equal(delivered, 0);
    await engine.resume(userId, c._id);
    await drive([engine], c, (x) => x.status === 'completed');
    assert.equal(delivered, 3);
  }));

test('a campaign pauses itself after several failures in a row', T, () =>
  withUser(async (userId) => {
    const engine = createEngine(channelWith(async () => ({ outcome: 'failed', error: 'boom' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(12) });
    const paused = await drive([engine], c, (x) => x.status === 'paused');
    assert.match(paused.pauseReason, /failures in a row/);
    assert.ok(paused.failedCount >= config.maxConsecutiveFailures);
  }));

test('failed messages can be retried and then succeed', T, () =>
  withUser(async (userId) => {
    let working = false;
    const engine = createEngine(channelWith(async () => (working ? { outcome: 'sent' } : { outcome: 'failed', error: 'down' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(2) }); // 2 failures stay under the auto-pause limit
    const first = await drive([engine], c, (x) => x.status === 'completed');
    assert.equal(first.failedCount, 2);

    working = true;
    await engine.retryFailed(userId, c._id);
    const second = await drive([engine], c, (x) => x.status === 'completed');
    assert.equal(second.sentCount, 2);
    assert.equal(second.failedCount, 0);
  }));

test('cancelling skips everything that has not been sent', T, () =>
  withUser(async (userId) => {
    let delivered = 0;
    const engine = createEngine(channelWith(async () => (delivered++, { outcome: 'sent' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(3) });
    const cancelled = await engine.cancel(userId, c._id);
    assert.equal(cancelled.status, 'cancelled');
    assert.deepEqual(await statuses(c), ['skipped', 'skipped', 'skipped']);
    assert.equal(delivered, 0);
  }));

test('skipped and temporarily failing recipients are handled', T, () =>
  withUser(async (userId) => {
    let tries = 0;
    const deliver = async ({ recipient }) => {
      if (recipient.name === 'P0') return { outcome: 'skipped', reason: 'opted out' };
      tries++;
      return { outcome: 'defer', delayMs: 0, maxDefers: 2, exhausted: 'fail', reason: 'temp' };
    };
    const engine = createEngine(channelWith(deliver));
    const c = await engine.createCampaign({ userId, fields, contacts: people(2) });
    const done = await drive([engine], c, (x) => x.status === 'completed');
    assert.equal(done.skippedCount, 1);
    assert.equal(done.failedCount, 1);
    assert.equal(tries, 3); // first attempt plus two deferrals, then it gives up
    const failed = await Recipient.findOne({ campaignId: c._id, status: 'failed' }).lean();
    assert.equal(failed.error, 'temp');
  }));

test('a send interrupted by a crash is marked "maybe delivered" and is not retried by default', T, () =>
  withUser(async (userId) => {
    const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));
    const c = await engine.createCampaign({ userId, fields, contacts: people(1) });
    await Recipient.updateOne({ campaignId: c._id }, { $set: { status: 'sending', claimedAt: new Date(Date.now() - 3_600_000), scheduledFor: null } });

    await engine.reap();
    const row = await Recipient.findOne({ campaignId: c._id }).lean();
    assert.equal(row.status, 'failed');
    assert.equal(row.ambiguous, true);
    assert.equal((await Campaign.findById(c._id)).status, 'completed');

    await assert.rejects(engine.retryFailed(userId, c._id), /no failed messages/);
    const retried = await engine.retryFailed(userId, c._id, { includeAmbiguous: true });
    assert.equal(retried.status, 'running');
  }));

test('the daily limit is enforced, counting messages already queued', T, () =>
  withUser(async (userId) => {
    const small = createEngine(channelWith(async () => ({ outcome: 'sent' }), { dailyCap: 5 }));
    await assert.rejects(small.createCampaign({ userId, fields, contacts: people(6) }), (e) => e.status === 429);
    await small.createCampaign({ userId, fields, contacts: people(5) });
    await assert.rejects(small.createCampaign({ userId, fields, contacts: people(1) }), (e) => e.status === 429);
  }));

test('a user cannot have more unfinished campaigns than the limit', T, () =>
  withUser(async (userId) => {
    const engine = createEngine(channelWith(async () => ({ outcome: 'sent' })));
    for (let i = 0; i < config.maxActiveCampaigns; i++) await engine.createCampaign({ userId, fields, contacts: people(1) });
    await assert.rejects(engine.createCampaign({ userId, fields, contacts: people(1) }), (e) => e.status === 429);
  }));
