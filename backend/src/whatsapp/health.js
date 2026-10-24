import mongoose from 'mongoose';
import { config } from '../config.js';
import { nextSlotAt } from '../engine/schedule.js';
import { Campaign, Notification, OptOut, Recipient } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { logger } from '../utils/logger.js';
import { notify } from '../utils/notify.js';

const log = logger.child({ mod: 'waHealth' });
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

// When does a sending account look unhealthy? Each rule has a "warning" and a "risk" level.
// Rates only count once there are enough messages behind them, so one bad message never raises an alarm.
export const THRESHOLDS = {
  failures: { warning: 0.2, risk: 0.4, minAttempts: 10 }, // failed / (sent + failed), last 24 hours
  invalidNumbers: { warning: 0.3, risk: 0.6, minAttempts: 10 }, // "not on WhatsApp" / (sent + not on WhatsApp), last 24 hours
  optOuts: { warning: 0.05, risk: 0.1, minSent: 20 }, // people who replied STOP / messages sent, last 7 days
  disconnects: { warning: 3, risk: 6 }, // times WhatsApp disconnected, last 7 days
  newNumber: { days: 14, dailyLimit: 40 }, // WhatsApp watches new bulk senders closely
};

const pct = (x) => `${Math.round(x * 100)}%`;
const rank = { ok: 0, warning: 1, risk: 2 };
const levelFor = (value, t) => (value >= t.risk ? 'risk' : value >= t.warning ? 'warning' : null);

/**
 * How healthy is this person's WhatsApp sending? Returns
 *   { level: 'ok' | 'warning' | 'risk', reasons: [{ code, level, message }], metrics, hourly: { cap, used, resetsAt } }
 * `hourly.used` counts up to `cap`; `resetsAt` is when the next message may go out (null when one may go now).
 */
export async function evaluateHealth(userId, { now = Date.now() } = {}) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const since24 = new Date(now - DAY);
  const since7 = new Date(now - 7 * DAY);
  const cap = (await resolveLimits(userId)).limits.waHourlyCap;

  const [byStatus, notOnWhatsapp, sent7, optOuts7, disconnects7, first, lastHour] = await Promise.all([
    Recipient.aggregate([
      { $match: { userId: uid, status: { $in: ['sent', 'failed'] }, updatedAt: { $gte: since24 } } },
      { $group: { _id: '$status', n: { $sum: 1 } } },
    ]),
    Recipient.countDocuments({ userId: uid, status: 'skipped', error: 'not on WhatsApp', updatedAt: { $gte: since24 } }),
    Recipient.countDocuments({ userId: uid, status: 'sent', sentAt: { $gte: since7 } }),
    OptOut.countDocuments({ userId: uid, createdAt: { $gte: since7 } }),
    Notification.countDocuments({ userId: uid, type: 'whatsapp_disconnected', createdAt: { $gte: since7 } }),
    Recipient.findOne({ userId: uid, status: 'sent' }).sort({ sentAt: 1 }).select('sentAt').lean(),
    Recipient.find({ userId: uid, status: 'sent', sentAt: { $gte: new Date(now - HOUR) } }).sort({ sentAt: -1 }).limit(cap).select('sentAt').lean(),
  ]);

  const by = Object.fromEntries(byStatus.map((r) => [r._id, r.n]));
  const sent24 = by.sent || 0;
  const failed24 = by.failed || 0;
  const attempts = sent24 + failed24;
  const failureRate = attempts >= THRESHOLDS.failures.minAttempts ? failed24 / attempts : null;
  const invalidBase = sent24 + notOnWhatsapp;
  const invalidRate = invalidBase >= THRESHOLDS.invalidNumbers.minAttempts ? notOnWhatsapp / invalidBase : null;
  const optOutRate = sent7 >= THRESHOLDS.optOuts.minSent ? optOuts7 / sent7 : null;
  const firstSendAt = first?.sentAt ? first.sentAt.getTime() : null;
  const daysSending = firstSendAt === null ? null : Math.floor((now - firstSendAt) / DAY);

  const reasons = [];
  const add = (code, level, message) => level && reasons.push({ code, level, message });

  if (failureRate !== null) {
    add('failures', levelFor(failureRate, THRESHOLDS.failures),
      `${pct(failureRate)} of your messages in the last 24 hours failed (${failed24} of ${attempts}). Check your contact list and your WhatsApp connection.`);
  }
  if (invalidRate !== null) {
    add('invalid_numbers', levelFor(invalidRate, THRESHOLDS.invalidNumbers),
      `${notOnWhatsapp} of the numbers you messaged in the last 24 hours (${pct(invalidRate)}) are not on WhatsApp. Sending to many invalid numbers can get a number restricted, so clean your list first.`);
  }
  if (optOutRate !== null) {
    add('opt_outs', levelFor(optOutRate, THRESHOLDS.optOuts),
      `${optOuts7} people replied STOP in the last 7 days (${pct(optOutRate)} of ${sent7} messages). Only message people who expect to hear from you.`);
  }
  add('disconnects', levelFor(disconnects7, THRESHOLDS.disconnects),
    `WhatsApp disconnected ${disconnects7} times in the last 7 days. Keep your phone online and connected: unstable links can lead to restrictions.`);
  if (daysSending !== null && daysSending < THRESHOLDS.newNumber.days && sent24 > THRESHOLDS.newNumber.dailyLimit) {
    add('new_number', 'warning',
      `This number started bulk sending ${daysSending === 0 ? 'today' : `${daysSending} day${daysSending === 1 ? '' : 's'} ago`}. WhatsApp watches new numbers closely, so keep to about ${THRESHOLDS.newNumber.dailyLimit} messages a day for the first two weeks.`);
  }

  const level = reasons.reduce((worst, r) => (rank[r.level] > rank[worst] ? r.level : worst), 'ok');
  const free = nextSlotAt({ sentAtDesc: lastHour.map((r) => r.sentAt.getTime()), cap, now });

  return {
    level,
    reasons,
    metrics: { sent24, failed24, failureRate, notOnWhatsapp24: notOnWhatsapp, invalidRate, sent7, optOuts7, optOutRate, disconnects7, daysSending },
    hourly: { cap, used: lastHour.length, resetsAt: free ? new Date(free).toISOString() : null },
  };
}

/**
 * Look at one sending account. Tells the owner (at most once a day per level) when it is at "warning" or "risk";
 * at "risk" it also pauses their running campaigns, unless WA_HEALTH_AUTOPAUSE is off.
 * Once the owner has been told about "risk", they are not paused again for a day: if they resume, that is their call.
 */
export async function checkUser(userId, { engine, now = Date.now() }) {
  const health = await evaluateHealth(userId, { now });
  if (health.level === 'ok') return { ...health, action: 'none' };

  const risk = health.level === 'risk';
  const type = risk ? 'whatsapp_health_risk' : 'whatsapp_health_warning';
  if (await Notification.exists({ userId, type, createdAt: { $gte: new Date(now - DAY) } })) return { ...health, action: 'none' };

  const worst = health.reasons.filter((r) => r.level === health.level);
  let paused = 0;
  if (risk && config.waHealthAutopause) {
    paused = await engine.pauseAllForUser(userId, `Paused to protect your WhatsApp number. ${worst[0].message}`);
  }
  const advice = risk
    ? paused
      ? ` ${paused} running campaign${paused === 1 ? ' was' : 's were'} paused. Fix the problem, then resume from the campaign page.`
      : ' Please fix this before sending more.'
    : '';
  await notify(userId, {
    type,
    level: risk ? 'error' : 'warning',
    title: risk ? 'Your WhatsApp number is at risk' : 'WhatsApp sending needs a look',
    message: worst.map((r) => r.message).join(' ') + advice,
    link: '/whatsapp',
    dedupeKey: type,
    email: risk,
  });
  return { ...health, action: paused ? 'paused' : 'notified' };
}

/** Every few minutes, check each account on this server that has a running campaign. */
export function startHealthMonitor({ engine, ownedUserIds }) {
  if (!config.waHealthCheckMinutes) return { stop() {}, run: async () => {} };
  let running = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      const owned = ownedUserIds();
      if (!owned.length) return;
      const users = await Campaign.distinct('userId', { status: 'running', userId: { $in: owned.map((id) => new mongoose.Types.ObjectId(String(id))) } });
      for (const userId of users) {
        await checkUser(userId, { engine }).catch((err) => log.warn({ err: err.message, userId: String(userId) }, 'health check failed'));
      }
    } catch (err) {
      log.error({ err: err.message }, 'health monitor pass failed');
    } finally {
      running = false;
    }
  };
  const timer = setInterval(run, config.waHealthCheckMinutes * 60_000);
  timer.unref();
  return { stop: () => clearInterval(timer), run };
}
