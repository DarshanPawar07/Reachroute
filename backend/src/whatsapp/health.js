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

// "Sent" only means WhatsApp's server accepted the message. These rules look at whether the contact's phone confirmed it (two ticks).
// Only messages we have a WhatsApp id for are counted, so campaigns from before delivery tracking never raise an alarm.
export const DELIVERY = {
  rate: { warning: 0.4, risk: 0.7, minSent: 15, graceMinutes: 15, windowHours: 6 }, // share of messages still unconfirmed after the grace time
  stall: { count: 6, graceMinutes: 3, windowHours: 3 }, // the latest N messages (each at least 3 minutes old) and not one confirmed
};

const pct = (x) => `${Math.round(x * 100)}%`;
const rank = { ok: 0, warning: 1, risk: 2 };
const levelFor = (value, t) => (value >= t.risk ? 'risk' : value >= t.warning ? 'warning' : null);

/**
 * Are the messages arriving? { tracked, delivered, undeliveredRate, stalled, anyDelivered7 }.
 * `stalled`: the latest few messages are all unconfirmed. `anyDelivered7`: a confirmation has been seen in the last 7 days, which tells
 * a real stall apart from receipts that never reach us at all (then we only warn, and never pause).
 */
export async function deliverySignals(userId, { now = Date.now() } = {}) {
  const uid = new mongoose.Types.ObjectId(String(userId));
  const base = { userId: uid, status: 'sent', waMessageId: { $type: 'string' } };
  const { rate, stall } = DELIVERY;
  const [agg, latest, seen] = await Promise.all([
    Recipient.aggregate([
      { $match: { ...base, sentAt: { $gte: new Date(now - rate.windowHours * HOUR), $lte: new Date(now - rate.graceMinutes * 60_000) } } },
      { $group: { _id: null, n: { $sum: 1 }, delivered: { $sum: { $cond: [{ $eq: [{ $type: '$deliveredAt' }, 'date'] }, 1, 0] } } } },
    ]),
    Recipient.find({ ...base, sentAt: { $gte: new Date(now - stall.windowHours * HOUR), $lte: new Date(now - stall.graceMinutes * 60_000) } })
      .sort({ sentAt: -1 })
      .limit(stall.count)
      .select('deliveredAt')
      .lean(),
    Recipient.exists({ ...base, deliveredAt: { $gte: new Date(now - 7 * DAY) } }),
  ]);
  const tracked = agg[0]?.n || 0;
  const delivered = agg[0]?.delivered || 0;
  return {
    tracked,
    delivered,
    undeliveredRate: tracked >= rate.minSent ? 1 - delivered / tracked : null,
    stalled: latest.length >= stall.count && latest.every((r) => !r.deliveredAt),
    anyDelivered7: Boolean(seen),
  };
}

const HOLD_ADVICE = 'Their phones may be offline, or WhatsApp may be holding the messages back, which often happens when a number messages many people who do not know it. Pause, wait a few hours, and send only to people who expect to hear from you.';

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

  const [byStatus, notOnWhatsapp, sent7, optOuts7, disconnects7, first, lastHour, delivery] = await Promise.all([
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
    deliverySignals(userId, { now }),
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

  if (delivery.stalled) {
    add('delivery_stall', delivery.anyDelivered7 ? 'risk' : 'warning',
      delivery.anyDelivered7
        ? `Your last ${DELIVERY.stall.count} messages were accepted by WhatsApp but none reached the other phone. ${HOLD_ADVICE}`
        : `None of your latest messages has been confirmed as delivered yet. If your phone shows two ticks on them, ignore this. Otherwise ${HOLD_ADVICE.charAt(0).toLowerCase()}${HOLD_ADVICE.slice(1)}`);
  } else if (delivery.undeliveredRate !== null) {
    const lvl = levelFor(delivery.undeliveredRate, DELIVERY.rate);
    add('delivery_low', lvl === 'risk' && !delivery.anyDelivered7 ? 'warning' : lvl,
      `${pct(delivery.undeliveredRate)} of the messages you sent in the last ${DELIVERY.rate.windowHours} hours have not reached the other phone (${delivery.tracked - delivery.delivered} of ${delivery.tracked}). ${HOLD_ADVICE}`);
  }

  const level = reasons.reduce((worst, r) => (rank[r.level] > rank[worst] ? r.level : worst), 'ok');
  const free = nextSlotAt({ sentAtDesc: lastHour.map((r) => r.sentAt.getTime()), cap, now });

  return {
    level,
    reasons,
    metrics: { deliveryTracked: delivery.tracked, delivered: delivery.delivered, undeliveredRate: delivery.undeliveredRate, sent24, failed24, failureRate, notOnWhatsapp24: notOnWhatsapp, invalidRate, sent7, optOuts7, optOutRate, disconnects7, daysSending },
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

/**
 * The quick check (every couple of minutes while a campaign runs): are the messages arriving at all? When the latest few have all been
 * accepted but none delivered, WhatsApp is most likely holding them back, so the campaign pauses before more are wasted.
 * The owner is told at most once every 6 hours; if they resume, that is their call.
 */
export async function checkDelivery(userId, { engine, now = Date.now() }) {
  const sig = await deliverySignals(userId, { now });
  if (!sig.stalled) return { ...sig, action: 'none' };
  const type = 'whatsapp_delivery_stall';
  if (await Notification.exists({ userId, type, createdAt: { $gte: new Date(now - 6 * HOUR) } })) return { ...sig, action: 'none' };

  const message = `Your last ${DELIVERY.stall.count} messages were accepted by WhatsApp but none reached the other phone. ${HOLD_ADVICE}`;
  const canPause = sig.anyDelivered7 && config.waHealthAutopause;
  const paused = canPause ? await engine.pauseAllForUser(userId, `Paused because messages are not being delivered. ${message}`) : 0;
  await notify(userId, {
    type,
    level: paused ? 'error' : 'warning',
    title: paused ? 'Campaign paused: messages are not being delivered' : 'Messages may not be getting delivered',
    message: paused ? `${message} ${paused} running campaign${paused === 1 ? ' was' : 's were'} paused. Resume from the campaign page when you are ready.` : message,
    link: '/whatsapp',
    dedupeKey: type,
    email: Boolean(paused),
  });
  return { ...sig, action: paused ? 'paused' : 'notified' };
}

/** Every few minutes, check each account on this server that has a running campaign. */
export function startHealthMonitor({ engine, ownedUserIds }) {
  const runningUsers = async () => {
    const owned = ownedUserIds();
    if (!owned.length) return [];
    return Campaign.distinct('userId', { status: 'running', userId: { $in: owned.map((id) => new mongoose.Types.ObjectId(String(id))) } });
  };
  const loop = (check, label) => {
    let busy = false;
    return async () => {
      if (busy) return;
      busy = true;
      try {
        for (const userId of await runningUsers()) {
          await check(userId, { engine }).catch((err) => log.warn({ err: err.message, userId: String(userId) }, `${label} failed`));
        }
      } catch (err) {
        log.error({ err: err.message }, `${label} pass failed`);
      } finally {
        busy = false;
      }
    };
  };
  const timers = [];
  const run = loop(checkUser, 'health check');
  const runDelivery = loop(checkDelivery, 'delivery check');
  if (config.waHealthCheckMinutes) timers.push(setInterval(run, config.waHealthCheckMinutes * 60_000));
  if (config.waDeliveryCheckMinutes) timers.push(setInterval(runDelivery, config.waDeliveryCheckMinutes * 60_000));
  timers.forEach((t) => t.unref());
  return { stop: () => timers.forEach(clearInterval), run, runDelivery };
}
