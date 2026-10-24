import { EventEmitter } from 'node:events';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { assignVariants } from '../utils/ab.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { withLock } from '../utils/mutex.js';
import { nextSlotAt, planTimes } from './schedule.js';
import { isOpen, windowOf } from './window.js';

const rand = (min, max) => Math.floor(Math.random() * (max - min + 1)) + min;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Emits 'paused' { channel, userId, campaignId, campaignName, reason } (automatic pauses only) and 'completed' { channel, userId, campaignId, campaignName, total, sent, failed, skipped }. */
export const engineEvents = new EventEmitter();

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error('Sending timed out'), { code: 'SEND_TIMEOUT' })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * One engine per channel (WhatsApp, email). MongoDB is the single source of truth:
 *
 *  - every recipient row carries its own `scheduledFor` time
 *  - a dispatcher loop (running on every instance) atomically "claims" due rows (pending -> sending),
 *    so two instances can never send the same row
 *  - pause / cancel only change database state, nothing has to be hunted down in a queue
 *  - rows stuck in `sending` after a crash are found by the reaper and marked failed (never re-sent blindly)
 *
 * A channel supplies: { name, Campaign, Recipient, contactField, limits, deliver, ownedUserIds?, purgeExpired?, limitsFor? }
 *   limits: { dailyCap, minDelay, maxDelay, hourlyCap? }  hourlyCap = most sends per account in any rolling hour
 *   limitsFor(userId) -> { dailyCap, hourlyCap?, maxActive }  the limits of one account (its plan); without it everyone gets `limits`
 *   deliver({ campaign, recipient }) must resolve to one of
 *     { outcome: 'sent' }
 *     { outcome: 'skipped', reason }
 *     { outcome: 'defer', delayMs, maxDefers, reason, exhausted: 'fail' | 'pause' }   try again later
 *     { outcome: 'failed', error, ambiguous? }
 *     { outcome: 'failed', pause: 'why' }        a problem with the channel itself: pause the campaign
 */
export function createEngine(channel) {
  const { name, Campaign, Recipient, contactField, limits, deliver, ownedUserIds, purgeExpired } = channel;
  const log = logger.child({ engine: name });
  // Daily and hourly limits and the number of unfinished campaigns, for one account.
  const limitsFor = channel.limitsFor || (async () => ({ dailyCap: limits.dailyCap, hourlyCap: limits.hourlyCap, maxActive: config.maxActiveCampaigns }));
  const gap = () => rand(limits.minDelay, limits.maxDelay) * 1000;
  const lockKey = (userId) => `schedule:${name}:${userId}`;

  let inFlight = 0;
  let ticking = false;
  let stopping = false;
  const timers = [];

  // ------------------------------------------------------------------ bookkeeping

  /** Recompute a campaign's counters from its recipient rows (self-heals any drift). */
  async function recount(campaignId) {
    const rows = await Recipient.aggregate([{ $match: { campaignId: oid(campaignId) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    const by = Object.fromEntries(rows.map((r) => [r._id, r.n]));
    await Campaign.updateOne(
      { _id: campaignId },
      { $set: { sentCount: by.sent || 0, failedCount: by.failed || 0, skippedCount: by.skipped || 0 } }
    );
    return by;
  }

  async function counts(campaignId) {
    const rows = await Recipient.aggregate([{ $match: { campaignId: oid(campaignId) } }, { $group: { _id: '$status', n: { $sum: 1 } } }]);
    return Object.fromEntries(rows.map((r) => [r._id, r.n]));
  }

  async function finishIfDone(campaignId) {
    const open = await Recipient.countDocuments({ campaignId, status: { $in: ['pending', 'sending'] } });
    if (open > 0) return;
    const done = await Campaign.findOneAndUpdate({ _id: campaignId, status: 'running' }, { $set: { status: 'completed', finishedAt: new Date() } }, { returnDocument: 'after' });
    if (!done) return;
    const by = await recount(campaignId);
    engineEvents.emit('completed', {
      channel: name, userId: String(done.userId), campaignId: String(done._id), campaignName: done.name,
      total: done.total, sent: by.sent || 0, failed: by.failed || 0, skipped: by.skipped || 0,
    });
  }

  /** Pause because of a problem (not because the user asked). `silent` skips the alert (the caller sends its own). */
  async function autoPause(campaignId, reason, { silent = false } = {}) {
    const c = await Campaign.findOneAndUpdate({ _id: campaignId, status: 'running' }, { status: 'paused', pauseReason: reason }, { returnDocument: 'after' });
    if (c) {
      await Recipient.updateMany({ campaignId, status: 'pending' }, { $set: { scheduledFor: null } });
      if (!silent) engineEvents.emit('paused', { channel: name, userId: String(c.userId), campaignId: String(c._id), campaignName: c.name, reason });
    }
    return c;
  }

  /** Pause everything a user has running. Returns how many campaigns were paused. */
  async function pauseAllForUser(userId, reason) {
    const running = await Campaign.find({ userId, status: 'running' }).select('_id').lean();
    let paused = 0;
    for (const c of running) if (await autoPause(c._id, reason, { silent: true })) paused += 1;
    return paused;
  }

  /**
   * How much of the daily limit is taken in the 24 hours around `atMs` (default: now): messages sent in the last 24h,
   * the ones being sent, and the ones still waiting that are scheduled within a day either side of `atMs` (or not scheduled yet).
   * A campaign scheduled for next week therefore does not use up today's limit, but two campaigns that would send
   * on the same day share it. `exceptCampaign` leaves one campaign's own waiting messages out.
   */
  async function usedInDay(userId, atMs = Date.now(), { exceptCampaign = null } = {}) {
    const from = new Date(atMs - DAY_MS);
    const to = new Date(atMs + DAY_MS);
    const other = exceptCampaign ? { campaignId: { $ne: exceptCampaign } } : {};
    return Recipient.countDocuments({
      userId,
      ...other,
      $or: [
        { status: 'sent', sentAt: { $gte: from } },
        { status: 'sending' },
        { status: 'pending', scheduledFor: null },
        { status: 'pending', scheduledFor: { $gte: from, $lte: to } },
      ],
    });
  }

  /** How many more messages this user may queue for the day around `atMs` (default: today). */
  async function remainingToday(userId, atMs = Date.now()) {
    const { dailyCap } = await limitsFor(userId);
    return Math.max(0, dailyCap - (await usedInDay(userId, atMs)));
  }

  // ------------------------------------------------------------------ scheduling

  /** Where a campaign's own timing rules put its sends: not before its start time, and inside its send window. */
  const planFor = (campaign) => ({ notBeforeMs: campaign.startAt ? new Date(campaign.startAt).getTime() : 0, window: windowOf(campaign) });

  /**
   * Give each pending recipient a send time, after anything this user already has scheduled.
   * Campaigns that are waiting for a future start do not hold anyone else back.
   */
  async function schedule(userId, recipientIds, { notBeforeMs = 0, window = null } = {}) {
    if (!recipientIds.length) return;
    const waiting = await Campaign.distinct('_id', { userId, startAt: { $gt: new Date() } });
    const latest = await Recipient.findOne({ userId, status: 'pending', scheduledFor: { $ne: null }, ...(waiting.length ? { campaignId: { $nin: waiting } } : {}) })
      .sort({ scheduledFor: -1 })
      .select('scheduledFor')
      .lean();
    const times = planTimes({ now: Date.now(), latestMs: latest ? latest.scheduledFor.getTime() : 0, count: recipientIds.length, gap, notBeforeMs, window });
    await Recipient.bulkWrite(
      recipientIds.map((id, i) => ({ updateOne: { filter: { _id: id, status: 'pending' }, update: { $set: { scheduledFor: new Date(times[i]) } } } })),
      { ordered: false }
    );
  }

  /** Plan the send times of all waiting recipients of a campaign again (its start time or send window changed). The caller holds the user's lock. */
  async function replan(campaign) {
    const rows = await Recipient.find({ campaignId: campaign._id, status: 'pending' }).sort({ scheduledFor: 1, _id: 1 }).select('_id').lean();
    if (!rows.length) return;
    await Recipient.updateMany({ campaignId: campaign._id, status: 'pending' }, { $set: { scheduledFor: null } });
    await schedule(campaign.userId, rows.map((r) => r._id), planFor(campaign));
  }

  /** The send window of a running campaign is closed but messages came due (a retry, a wait that ended late): move them all to the next opening. */
  async function rescheduleCampaign(campaignId) {
    const owner = await Campaign.findById(campaignId).select('userId').lean();
    if (!owner) return;
    await withLock(lockKey(owner.userId), async () => {
      const c = await Campaign.findOne({ _id: campaignId, status: 'running' }).lean();
      if (c) await replan(c);
    });
  }

  // ------------------------------------------------------------------ campaign lifecycle (called by routes)

  async function createCampaign({ userId, fields, contacts, startAt = null, sendWindow = null }) {
    return withLock(lockKey(userId), async () => {
      const own = await limitsFor(userId);
      const active = await Campaign.countDocuments({ userId, status: { $in: ['preparing', 'running', 'paused'] } });
      if (active >= own.maxActive) {
        throw bad(`You can have at most ${own.maxActive} unfinished campaigns. Finish or cancel one first.`, 429);
      }
      const start = startAt && new Date(startAt).getTime() > Date.now() ? new Date(startAt) : null;
      const used = await usedInDay(userId, start ? start.getTime() : Date.now());
      if (used + contacts.length > own.dailyCap) {
        throw bad(
          `Daily limit is ${own.dailyCap} per account. ${used} already used around ${start ? 'that start time' : 'now'}, this campaign needs ${contacts.length}.`,
          429
        );
      }

      // Recipients are inserted while the campaign is still 'preparing', so nothing can be sent half-built.
      const campaign = await Campaign.create({ userId, ...fields, startAt: start, sendWindow, total: contacts.length, status: 'preparing' });
      try {
        // An email campaign with two subject lines: decide now who gets which, so a retry or a resume sends the same one.
        const variants = campaign.subjectB ? assignVariants(contacts.length, campaign.splitB) : null;
        const rows = contacts.map((c, i) => ({ campaignId: campaign._id, userId, name: c.name, [contactField]: c[contactField], ...(c.fields ? { fields: c.fields } : {}), ...(variants ? { variant: variants[i] } : {}) }));
        const inserted = await Recipient.insertMany(rows);
        await schedule(userId, inserted.map((r) => r._id), planFor(campaign));
        return await Campaign.findByIdAndUpdate(campaign._id, { status: 'running' }, { returnDocument: 'after' });
      } catch (err) {
        await Recipient.deleteMany({ campaignId: campaign._id }).catch(() => {});
        await Campaign.deleteOne({ _id: campaign._id }).catch(() => {});
        throw err;
      }
    });
  }

  async function pause(userId, id) {
    const c = await Campaign.findOneAndUpdate({ _id: id, userId, status: 'running' }, { status: 'paused', pauseReason: 'Paused by you' }, { returnDocument: 'after' });
    if (!c) throw bad('No running campaign with that id', 404);
    await Recipient.updateMany({ campaignId: c._id, status: 'pending' }, { $set: { scheduledFor: null } });
    return c;
  }

  async function resume(userId, id) {
    return withLock(lockKey(userId), async () => {
      const c = await Campaign.findOneAndUpdate(
        { _id: id, userId, status: 'paused' },
        { status: 'running', pauseReason: null, consecutiveFailures: 0 },
        { returnDocument: 'after' }
      );
      if (!c) throw bad('No paused campaign with that id', 404);
      const pending = await Recipient.find({ campaignId: c._id, status: 'pending' }).select('_id').lean();
      await Recipient.updateMany({ campaignId: c._id, status: 'pending' }, { $set: { deferCount: 0 } });
      await schedule(userId, pending.map((p) => p._id), planFor(c));
      await finishIfDone(c._id);
      return Campaign.findById(c._id);
    });
  }

  async function cancel(userId, id) {
    const c = await Campaign.findOneAndUpdate({ _id: id, userId, status: { $in: ['running', 'paused'] } }, { status: 'cancelled', pauseReason: null, finishedAt: new Date() }, { returnDocument: 'after' });
    if (!c) throw bad('No active campaign with that id', 404);
    await Recipient.updateMany({ campaignId: c._id, status: 'pending' }, { $set: { status: 'skipped', error: 'cancelled', scheduledFor: null } });
    await recount(c._id);
    return Campaign.findById(c._id);
  }

  /**
   * Change when a campaign starts and/or the hours it may send in. `undefined` keeps a value, `null` clears it.
   * The start time can only change before anything was sent. Waiting messages are planned again right away.
   */
  async function updateSchedule(userId, id, { startAt, sendWindow }) {
    return withLock(lockKey(userId), async () => {
      const c = await Campaign.findOne({ _id: id, userId, status: { $in: ['running', 'paused'] } });
      if (!c) throw bad('No running or paused campaign with that id', 404);

      const set = {};
      if (sendWindow !== undefined) set.sendWindow = sendWindow;
      if (startAt !== undefined) {
        if (await Recipient.exists({ campaignId: c._id, status: { $in: ['sent', 'failed', 'sending'] } })) {
          throw bad('The start time can only be changed before sending begins.', 409);
        }
        const when = startAt && startAt.getTime() > Date.now() ? startAt : null;
        const waiting = await Recipient.countDocuments({ campaignId: c._id, status: 'pending' });
        const used = await usedInDay(userId, when ? when.getTime() : Date.now(), { exceptCampaign: c._id });
        const { dailyCap } = await limitsFor(userId);
        if (used + waiting > dailyCap) throw bad(`Daily limit is ${dailyCap} per account. ${used} already used around that start time, this campaign needs ${waiting}.`, 429);
        set.startAt = when;
      }
      if (!Object.keys(set).length) return c;

      const updated = await Campaign.findOneAndUpdate({ _id: c._id, status: c.status }, { $set: set }, { returnDocument: 'after' });
      if (!updated) throw bad('The campaign changed while you were editing it. Reload and try again.', 409);
      if (updated.status === 'running') await replan(updated); // a paused campaign is planned when it is resumed
      return updated;
    });
  }

  /** Put failed recipients back in line. Ones where delivery is unknown are skipped unless asked for. */
  async function retryFailed(userId, id, { includeAmbiguous = false } = {}) {
    return withLock(lockKey(userId), async () => {
      const c = await Campaign.findOne({ _id: id, userId });
      if (!c || !['running', 'paused', 'completed'].includes(c.status)) throw bad('This campaign cannot be retried', 404);

      const filter = { campaignId: c._id, status: 'failed', ...(includeAmbiguous ? {} : { ambiguous: { $ne: true } }) };
      const failed = await Recipient.find(filter).select('_id').lean();
      if (!failed.length) throw bad('There are no failed messages to retry', 400);

      const used = await usedInDay(userId);
      const { dailyCap } = await limitsFor(userId);
      if (used + failed.length > dailyCap) throw bad(`Retrying ${failed.length} would pass your daily limit of ${dailyCap}.`, 429);

      const ids = failed.map((f) => f._id);
      await Recipient.updateMany({ _id: { $in: ids } }, { $set: { status: 'pending', error: null, ambiguous: false, scheduledFor: null, deferCount: 0 } });
      if (c.status === 'completed') await Campaign.updateOne({ _id: c._id }, { status: 'running', consecutiveFailures: 0, finishedAt: null });
      if (c.status !== 'paused') await schedule(userId, ids, planFor(c)); // a paused campaign is scheduled when it is resumed
      await recount(c._id);
      return Campaign.findById(c._id);
    });
  }

  // ------------------------------------------------------------------ sending

  async function release(r, extra = {}) {
    await Recipient.updateOne(
      { _id: r._id, status: 'sending' },
      { $set: { status: 'pending', scheduledFor: null, claimedAt: null, claimedBy: null, ...extra } }
    );
  }

  async function markFailed(campaign, r, error, ambiguous = false) {
    const res = await Recipient.updateOne(
      { _id: r._id, status: 'sending' },
      { $set: { status: 'failed', error: String(error || 'Failed').slice(0, 300), ambiguous, scheduledFor: null, claimedAt: null, claimedBy: null } }
    );
    if (!res.modifiedCount) return;
    const updated = await Campaign.findOneAndUpdate({ _id: campaign._id }, { $inc: { failedCount: 1, consecutiveFailures: 1 } }, { returnDocument: 'after' });
    // Several failures in a row usually means a bad list, a blocked sender or a dropped login: stop and let the user look.
    if (updated && updated.consecutiveFailures >= config.maxConsecutiveFailures) {
      await autoPause(campaign._id, `Paused after ${updated.consecutiveFailures} failures in a row. Check the failed rows, then resume.`);
    }
  }

  async function applyResult(campaign, r, res) {
    const done = { claimedAt: null, claimedBy: null, scheduledFor: null };
    switch (res.outcome) {
      case 'sent': {
        const u = await Recipient.updateOne({ _id: r._id, status: 'sending' }, { $set: { status: 'sent', sentAt: new Date(), error: null, ambiguous: false, ...done } });
        if (u.modifiedCount) await Campaign.updateOne({ _id: campaign._id }, { $inc: { sentCount: 1 }, $set: { consecutiveFailures: 0 } });
        return;
      }
      case 'skipped': {
        const u = await Recipient.updateOne({ _id: r._id, status: 'sending' }, { $set: { status: 'skipped', error: res.reason || 'skipped', ...done } });
        if (u.modifiedCount) await Campaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } });
        return;
      }
      case 'defer': {
        const attempts = (r.deferCount || 0) + 1;
        if (attempts > (res.maxDefers ?? 3)) {
          if (res.exhausted === 'pause') {
            await release(r);
            await autoPause(campaign._id, res.reason || 'Paused after repeated temporary problems.');
            return;
          }
          return markFailed(campaign, r, res.reason || 'Gave up after repeated temporary errors');
        }
        await Recipient.updateOne(
          { _id: r._id, status: 'sending' },
          { $set: { status: 'pending', scheduledFor: new Date(Date.now() + (res.delayMs || 60_000)), deferCount: attempts, claimedAt: null, claimedBy: null } }
        );
        return;
      }
      default: {
        if (res.pause) {
          await release(r);
          await autoPause(campaign._id, res.pause);
          return;
        }
        return markFailed(campaign, r, res.error, Boolean(res.ambiguous));
      }
    }
  }

  async function processOne(r) {
    const campaign = await Campaign.findById(r.campaignId);
    if (!campaign) return;
    if (campaign.status === 'cancelled') {
      const u = await Recipient.updateOne({ _id: r._id, status: 'sending' }, { $set: { status: 'skipped', error: 'cancelled', scheduledFor: null, claimedAt: null, claimedBy: null } });
      if (u.modifiedCount) await Campaign.updateOne({ _id: campaign._id }, { $inc: { skippedCount: 1 } });
      return;
    }
    if (campaign.status !== 'running') return release(r); // paused after we claimed it: give it back

    let result;
    try {
      result = await withTimeout(deliver({ campaign, recipient: r }), config.sendTimeoutMs);
    } catch (err) {
      if (err.code === 'SEND_TIMEOUT') {
        result = { outcome: 'failed', error: 'Timed out while sending. It may or may not have been delivered.', ambiguous: true };
      } else {
        log.error({ err, recipientId: String(r._id) }, 'deliver threw');
        result = { outcome: 'failed', error: err.message || 'Unexpected error' };
      }
    }
    await applyResult(campaign, r, result);
    await finishIfDone(campaign._id);
  }

  /** How many messages each of these users has sent in the last hour, plus the ones being sent right now. */
  async function hourlyUsage(userIds) {
    if (!userIds.length) return new Map();
    const since = new Date(Date.now() - HOUR_MS);
    const rows = await Recipient.aggregate([
      { $match: { userId: { $in: userIds.map(oid) }, $or: [{ status: 'sent', sentAt: { $gte: since } }, { status: 'sending' }] } },
      { $group: { _id: '$userId', n: { $sum: 1 } } },
    ]);
    return new Map(rows.map((r) => [String(r._id), r.n]));
  }

  /** Reschedule rows of accounts that reached the hourly cap to when a slot frees up, one gap apart. */
  async function holdBack(held) {
    const now = Date.now();
    const ops = [];
    for (const [userId, ids] of held) {
      const { hourlyCap } = await limitsFor(userId);
      const recent = await Recipient.find({ userId: oid(userId), status: 'sent', sentAt: { $gte: new Date(now - HOUR_MS) } })
        .sort({ sentAt: -1 })
        .limit(hourlyCap)
        .select('sentAt')
        .lean();
      const free = nextSlotAt({ sentAtDesc: recent.map((r) => r.sentAt.getTime()), cap: hourlyCap, now });
      // free === 0 means only messages being sent right now fill the hour: look again shortly.
      let t = (free || now + 30_000) + rand(1, 5) * 1000;
      for (const id of ids) {
        ops.push({ updateOne: { filter: { _id: id, status: 'pending' }, update: { $set: { scheduledFor: new Date(t) } } } });
        t += gap();
      }
    }
    if (ops.length) await Recipient.bulkWrite(ops, { ordered: false });
  }

  /** One dispatcher pass: claim whatever is due (up to the free worker slots) and start sending it. */
  async function tick() {
    if (stopping || ticking || inFlight >= config.sendConcurrency) return;
    ticking = true;
    try {
      const now = new Date();
      const filter = { status: 'pending', scheduledFor: { $lte: now } };
      if (ownedUserIds) {
        const owned = ownedUserIds();
        if (!owned.length) return;
        filter.userId = { $in: owned.map(oid) };
      }
      const slots = config.sendConcurrency - inFlight;
      const due = await Recipient.find(filter).sort({ scheduledFor: 1 }).limit(slots * 3).select('_id campaignId userId').lean();
      if (!due.length) return;

      const campaignIds = [...new Set(due.map((d) => String(d.campaignId)))];
      const states = await Campaign.find({ _id: { $in: campaignIds } }).select('_id status sendWindow').lean();
      const idsWhere = (status) => new Set(states.filter((c) => c.status === status).map((c) => String(c._id)));
      const running = idsWhere('running');
      const preparing = idsWhere('preparing'); // still being set up: leave its rows alone, it starts running within moments

      // Due rows of paused, cancelled or deleted campaigns would block the head of the queue: unschedule them.
      const stale = due.filter((d) => !running.has(String(d.campaignId)) && !preparing.has(String(d.campaignId))).map((d) => d._id);
      if (stale.length) await Recipient.updateMany({ _id: { $in: stale }, status: 'pending' }, { $set: { scheduledFor: null } });

      // A campaign outside its send window sends nothing now: all its waiting messages move to the next opening.
      const closed = new Set(states.filter((c) => c.status === 'running' && !isOpen(now.getTime(), windowOf(c))).map((c) => String(c._id)));
      for (const id of closed) {
        await rescheduleCampaign(id).catch((err) => log.error({ err, campaignId: id }, 'could not move a campaign to its next send window'));
      }

      // Hourly cap: how much each account has already used of its rolling hour (each account has its own cap, from its plan).
      const waiting = [...new Set(due.filter((d) => running.has(String(d.campaignId))).map((d) => String(d.userId)))];
      const caps = new Map();
      for (const who of waiting) caps.set(who, (await limitsFor(who)).hourlyCap || 0);
      const capped = waiting.filter((who) => caps.get(who));
      const used = capped.length ? await hourlyUsage(capped) : null;
      const held = new Map(); // userId -> rows to push back because the account is at its cap

      for (const d of due) {
        if (inFlight >= config.sendConcurrency) break;
        if (!running.has(String(d.campaignId)) || closed.has(String(d.campaignId))) continue;
        const who = String(d.userId);
        if (used && caps.get(who) && (used.get(who) || 0) >= caps.get(who)) {
          if (!held.has(who)) held.set(who, []);
          held.get(who).push(d._id);
          continue;
        }
        const claimed = await Recipient.findOneAndUpdate(
          { _id: d._id, status: 'pending', scheduledFor: { $lte: new Date() } },
          { $set: { status: 'sending', claimedAt: new Date(), claimedBy: config.instanceId } },
          { returnDocument: 'after' }
        );
        if (!claimed) continue; // another instance got it first
        if (used) used.set(who, (used.get(who) || 0) + 1);
        inFlight += 1;
        processOne(claimed)
          .catch((err) => log.error({ err, recipientId: String(claimed._id) }, 'processing failed'))
          .finally(() => {
            inFlight -= 1;
          });
      }
      if (held.size) await holdBack(held);
    } finally {
      ticking = false;
    }
  }

  // ------------------------------------------------------------------ housekeeping

  /** Recover from crashes: rows stuck in `sending`, and campaigns abandoned while `preparing`. */
  async function reap() {
    const cutoff = new Date(Date.now() - config.claimTimeoutMs);
    const stuck = await Recipient.find({ status: 'sending', claimedAt: { $lt: cutoff } }).select('_id campaignId').limit(500).lean();
    if (stuck.length) {
      await Recipient.updateMany(
        { _id: { $in: stuck.map((s) => s._id) }, status: 'sending' },
        { $set: { status: 'failed', ambiguous: true, scheduledFor: null, claimedAt: null, claimedBy: null, error: 'Interrupted while sending. It may or may not have been delivered, so it was not retried automatically.' } }
      );
      for (const id of new Set(stuck.map((s) => String(s.campaignId)))) {
        await recount(id);
        await finishIfDone(oid(id));
      }
      log.warn({ count: stuck.length }, 'recovered rows stuck in sending');
    }

    const abandoned = await Campaign.find({ status: 'preparing', createdAt: { $lt: new Date(Date.now() - 10 * 60_000) } }).select('_id').lean();
    for (const c of abandoned) {
      await Recipient.deleteMany({ campaignId: c._id });
      await Campaign.deleteOne({ _id: c._id, status: 'preparing' });
    }

    await repairUnscheduled();
  }

  let lastRepair = 0;
  /**
   * A running campaign whose pending rows have no send time would never finish (data from an older version,
   * or a crash between two steps). Give those rows a time. Takes the same lock as resume/retry so they can't overlap.
   */
  async function repairUnscheduled() {
    if (Date.now() - lastRepair < 5 * 60_000) return;
    lastRepair = Date.now();
    const campaignIds = await Recipient.distinct('campaignId', { status: 'pending', scheduledFor: null });
    if (!campaignIds.length) return;
    const running = await Campaign.find({ _id: { $in: campaignIds }, status: 'running' }).select('_id userId startAt sendWindow').lean();
    for (const c of running) {
      await withLock(lockKey(c.userId), async () => {
        const rows = await Recipient.find({ campaignId: c._id, status: 'pending', scheduledFor: null }).select('_id').limit(1000).lean();
        if (!rows.length) return;
        await schedule(c.userId, rows.map((r) => r._id), planFor(c));
        log.warn({ campaignId: String(c._id), count: rows.length }, 'gave a send time to recipients that had none');
      });
    }
  }

  /** Delete finished campaigns (and their recipients) older than RETENTION_DAYS, a small batch at a time. */
  async function purgeOld() {
    if (!config.retentionDays) return;
    const cutoff = new Date(Date.now() - config.retentionDays * 24 * 60 * 60 * 1000);
    if (purgeExpired) await purgeExpired(cutoff);
    const old = await Campaign.find({ status: { $in: ['completed', 'cancelled'] }, updatedAt: { $lt: cutoff } }).select('_id').limit(100).lean();
    if (!old.length) return;
    const ids = old.map((c) => c._id);
    await Recipient.deleteMany({ campaignId: { $in: ids } });
    await Campaign.deleteMany({ _id: { $in: ids } });
    log.info({ campaigns: ids.length }, 'purged old campaigns');
  }

  function start() {
    stopping = false;
    const every = (fn, ms, label) =>
      timers.push(setInterval(() => fn().catch((err) => log.error({ err }, `${label} failed`)), ms));
    every(tick, config.dispatchIntervalMs, 'dispatch');
    every(reap, 60_000, 'reaper');
    every(purgeOld, 60 * 60_000, 'purge');
    reap().catch((err) => log.error({ err }, 'initial reap failed'));
  }

  /** Stop picking up work and wait (up to timeoutMs) for sends already in progress. */
  async function stop(timeoutMs = 20_000) {
    stopping = true;
    timers.splice(0).forEach(clearInterval);
    const deadline = Date.now() + timeoutMs;
    while (inFlight > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
    if (inFlight > 0) log.warn({ inFlight }, 'stopped with sends still in progress; the reaper will mark them');
  }

  return { name, createCampaign, updateSchedule, pause, resume, cancel, retryFailed, pauseAllForUser, remainingToday, counts, recount, start, stop, tick, reap, purgeOld };
}
