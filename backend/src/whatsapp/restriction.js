import { EventEmitter } from 'node:events';
import { record } from '../audit/audit.js';
import { config } from '../config.js';
import { Campaign, WaRestriction } from '../models.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { notify } from '../utils/notify.js';

const log = logger.child({ mod: 'waRestriction' });
const HOUR = 60 * 60_000;

/**
 * WhatsApp has no official "your number is banned" message for the connection this app uses, so a ban is recognised
 * from what WhatsApp does: it closes the connection with a "forbidden" (403) answer, or it refuses to deliver messages
 * with the same answer. When that happens the number is treated as out of use for WA_RESTRICTION_HOURS, the running
 * campaigns pause, and the owner can link a different number and resume from the first message that was not sent.
 */

/** Emitted as 'detected' { userId, phone, source: 'connection' | 'send', code, reason }. channels.js acts on it. */
export const restrictionEvents = new EventEmitter();

export const RESTRICTED_PREFIX = 'WhatsApp number restricted.';
const RESTRICTED_PAUSE = /^WhatsApp number restricted\./;

/** The text a campaign shows while it is paused because of a restriction. */
export const restrictedReason = (phone) =>
  `${RESTRICTED_PREFIX} WhatsApp refused ${phone ? `+${phone}` : 'this number'}. This usually lifts after about ${config.waRestrictionHours} hours. ` +
  'You can wait, or link a different WhatsApp number and resume: the campaign continues from the first message that was not sent.';

/** Does this error from WhatsApp mean "this number is not allowed to send"? */
export function isBanSignal(err) {
  const code = err?.output?.statusCode ?? err?.statusCode ?? err?.data;
  if (code === 403 || code === '403') return true;
  return /\b(forbidden|banned)\b|temporarily (restricted|blocked|banned)/i.test(String(err?.message || ''));
}

// One refused message can have a reason of its own, so a restriction from messages needs two within a few minutes.
const SIGNAL_WINDOW_MS = 10 * 60_000;
const SIGNALS_NEEDED = 2;
const signals = new Map(); // userId -> times of recent refusals

/** Count a refusal. true once there have been enough of them close together. */
export function noteBanSignal(userId, now = Date.now()) {
  const key = String(userId);
  const recent = (signals.get(key) || []).filter((t) => now - t < SIGNAL_WINDOW_MS);
  recent.push(now);
  signals.set(key, recent);
  while (signals.size > 5000) signals.delete(signals.keys().next().value);
  return recent.length >= SIGNALS_NEEDED;
}
export const clearBanSignals = (userId) => signals.delete(String(userId));

const clip = (text, max) => String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

/** Write down the restriction. `created` is false when one was already active (nothing new to do). */
export async function recordRestriction(userId, { phone = '', source, code = '', reason = '', now = Date.now() }) {
  try {
    const doc = await WaRestriction.create({
      userId,
      phone: String(phone || ''),
      status: 'active',
      detectedAt: new Date(now),
      until: new Date(now + config.waRestrictionHours * HOUR),
      source,
      code: clip(code, 20),
      reason: clip(reason, 300),
    });
    return { doc: doc.toObject(), created: true };
  } catch (err) {
    if (err.code === 11000) return { doc: await WaRestriction.findOne({ userId, status: 'active' }).lean(), created: false };
    throw err;
  }
}

/** A restriction was detected: save it, pause everything the account is sending, tell the owner. Safe to repeat. */
export async function handleRestriction(userId, details, { engine }) {
  const { doc, created } = await recordRestriction(userId, details);
  if (!created) return { doc, paused: 0, created: false };
  clearBanSignals(userId);
  const reason = restrictedReason(doc.phone);
  const paused = await engine.pauseAllForUser(userId, reason);
  await notify(userId, {
    type: 'whatsapp_restricted',
    level: 'error',
    title: 'Your WhatsApp number looks restricted',
    message:
      `WhatsApp refused ${doc.phone ? `+${doc.phone}` : 'your number'}. This usually lifts after about ${config.waRestrictionHours} hours. ` +
      `${paused ? `${paused} running campaign${paused === 1 ? ' was' : 's were'} paused. ` : ''}` +
      'Link a different WhatsApp number to continue now: your campaign carries on from the first message that was not sent.',
    link: '/whatsapp',
    dedupeKey: 'whatsapp_restricted',
    email: true,
  });
  await record({ actorId: null, targetId: userId, action: 'whatsapp.restricted', detail: `${doc.source}${doc.code ? ` ${doc.code}` : ''}${doc.phone ? ` +${doc.phone}` : ''}` });
  log.warn({ userId: String(userId), source: doc.source, code: doc.code }, 'WhatsApp number restricted');
  return { doc, paused, created: true };
}

async function resolve(doc, by) {
  const res = await WaRestriction.updateOne({ _id: doc._id, status: 'active' }, { $set: { status: 'resolved', resolvedAt: new Date(), resolvedBy: by } });
  if (res.modifiedCount) await record({ actorId: doc.userId, action: 'whatsapp.restriction_resolved', detail: by });
}

/** Is `phone` (the number linked right now, or null) a different number from the one that was refused? */
const isNewNumber = (doc, phone) => Boolean(phone) && (doc.phone ? phone !== doc.phone : Boolean(doc.switchRequestedAt));

/**
 * Stops sending from a restricted number. Lets it through when the restriction has run out, or when a
 * different number is linked (and then closes the restriction). Error code: 'whatsapp_restricted', status 409.
 */
export async function assertCanSend(userId, phone, { now = Date.now() } = {}) {
  const doc = await WaRestriction.findOne({ userId, status: 'active' }).lean();
  if (!doc) return;
  if (now >= doc.until.getTime()) return resolve(doc, 'expired');
  if (isNewNumber(doc, phone)) return resolve(doc, 'switched');
  throw Object.assign(
    bad(
      `${doc.phone ? `+${doc.phone}` : 'Your WhatsApp number'} was refused by WhatsApp and is out of use until about ${doc.until.toISOString()}. ` +
        'Link a different WhatsApp number to continue now.',
      409
    ),
    { code: 'whatsapp_restricted' }
  );
}

/** The owner starts linking a different number. Returns the restriction, or throws 409 when there is none. */
export async function markSwitching(userId) {
  const doc = await WaRestriction.findOneAndUpdate({ userId, status: 'active' }, { $set: { switchRequestedAt: new Date() } }, { returnDocument: 'after' }).lean();
  if (!doc) throw bad('Your WhatsApp number is not restricted.', 409);
  await record({ actorId: userId, action: 'whatsapp.number_switch', detail: doc.phone ? `from +${doc.phone}` : '' });
  return doc;
}

/** Campaigns waiting because of a restriction, with how far each one got. */
export async function restrictedCampaigns(userId) {
  const list = await Campaign.find({ userId, status: 'paused', pauseReason: RESTRICTED_PAUSE }).sort({ createdAt: 1 }).lean();
  return list.map((c) => ({
    id: c._id,
    name: c.name,
    total: c.total,
    sent: c.sentCount,
    failed: c.failedCount,
    skipped: c.skippedCount,
    remaining: Math.max(0, c.total - c.sentCount - c.failedCount - c.skippedCount),
  }));
}

/**
 * What the app shows: whether the number is restricted, until when, what the owner can do now, and which campaigns wait.
 * `phone` is the number linked right now (null when nothing is linked).
 * next: 'none' | 'link_number' (nothing linked) | 'wait' (the same number is linked and the time is not up) | 'resume'.
 */
export async function getRestriction(userId, { phone = null, now = Date.now() } = {}) {
  const [doc, campaigns] = await Promise.all([WaRestriction.findOne({ userId, status: 'active' }).lean(), restrictedCampaigns(userId)]);
  if (!doc) return { restricted: false, state: 'none', campaigns, next: campaigns.length && phone ? 'resume' : 'none' };
  const expired = now >= doc.until.getTime();
  const ready = Boolean(phone) && (expired || isNewNumber(doc, phone));
  return {
    restricted: true,
    state: expired ? 'expired' : 'active',
    phone: doc.phone || null,
    since: doc.detectedAt,
    until: doc.until,
    msLeft: Math.max(0, doc.until.getTime() - now),
    source: doc.source,
    currentPhone: phone,
    campaigns,
    next: ready ? 'resume' : phone ? 'wait' : 'link_number',
  };
}

/** Resume every campaign that was paused by a restriction. The number must be allowed to send (see assertCanSend). */
export async function resumeRestricted(userId, { engine, phone }) {
  if (!phone) throw bad('Link a WhatsApp number first.', 409);
  await assertCanSend(userId, phone);
  const waiting = await restrictedCampaigns(userId);
  const resumed = [];
  const failed = [];
  for (const c of waiting) {
    try {
      await engine.resume(userId, c.id);
      resumed.push({ id: c.id, name: c.name, remaining: c.remaining });
    } catch (err) {
      failed.push({ id: c.id, name: c.name, error: err.message });
    }
  }
  return { resumed, failed };
}

/** Accounts whose number is out of use right now and who have not started linking another: do not reconnect them automatically. */
export async function restrictedUserIds(now = Date.now()) {
  return WaRestriction.distinct('userId', { status: 'active', until: { $gt: new Date(now) }, switchRequestedAt: null });
}
