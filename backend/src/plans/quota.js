import { EmailRecipient, Recipient, User } from '../models.js';
import { bad } from '../utils/http.js';
import { resolveLimits } from './limits.js';

/**
 * The "in total" limits of a plan:
 *   - the lifetime limit (Free): messages sent for good, per channel, never refilled
 *   - the monthly limit (Pro, Premium): WhatsApp and email together, over the last 30 days
 * Messages that are queued (waiting or being sent) count already, so a campaign cannot be started that would run past the limit.
 * A limit of 0 means there is none.
 */

const MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const MODELS = { whatsapp: Recipient, email: EmailRecipient };
const LABEL = { whatsapp: 'WhatsApp messages', email: 'emails' };
const QUEUED = { $in: ['pending', 'sending'] };

/** Count what an account has used. `except` leaves one channel's campaign out (its own waiting messages). */
export async function usageOf(userId, limits) {
  const since = new Date(Date.now() - MONTH_MS);
  const user = await User.findById(userId).select('sentTotals').lean();
  const out = { lifetime: {}, month: { sent: 0, queued: 0 } };
  for (const channel of ['whatsapp', 'email']) {
    const M = MODELS[channel];
    const [sentEver, queued, sentMonth] = await Promise.all([
      limits.lifetime[channel] || user?.sentTotals?.[channel] ? M.countDocuments({ userId, status: 'sent' }) : 0,
      M.countDocuments({ userId, status: QUEUED }),
      limits.monthly ? M.countDocuments({ userId, status: 'sent', sentAt: { $gte: since } }) : 0,
    ]);
    out.lifetime[channel] = { sent: Math.max(user?.sentTotals?.[channel] || 0, sentEver), queued };
    out.month.sent += sentMonth;
    out.month.queued += queued;
  }
  return out;
}

const limitsOf = (l) => ({ lifetime: { whatsapp: l.waLifetimeCap || 0, email: l.emailLifetimeCap || 0 }, monthly: l.monthlyCap || 0 });

/**
 * How many more messages this account may queue on a channel, and which limit is the tight one.
 * { room: number (Infinity when nothing limits it), reason: 'lifetime' | 'monthly' | null, plan, ... }
 */
export async function quotaRoom(userId, channel) {
  const { plan, limits: all } = await resolveLimits(userId);
  const lim = limitsOf(all);
  if (!lim.lifetime[channel] && !lim.monthly) return { room: Infinity, reason: null, plan, cap: 0, used: 0 };
  const u = await usageOf(userId, lim);
  let room = Infinity;
  let reason = null;
  let cap = 0;
  let used = 0;
  if (lim.lifetime[channel]) {
    used = u.lifetime[channel].sent + u.lifetime[channel].queued;
    room = Math.max(0, lim.lifetime[channel] - used);
    reason = 'lifetime';
    cap = lim.lifetime[channel];
  }
  if (lim.monthly) {
    const monthUsed = u.month.sent + u.month.queued;
    const monthRoom = Math.max(0, lim.monthly - monthUsed);
    if (monthRoom < room) {
      room = monthRoom;
      reason = 'monthly';
      cap = lim.monthly;
      used = monthUsed;
    }
  }
  return { room, reason, plan, cap, used };
}

const fmt = (n) => Number(n).toLocaleString('en-IN');

/** Throws a clear message (HTTP 402, code "upgrade_required") when `adding` more messages would pass a total limit. */
export async function assertQuota(userId, channel, adding) {
  const q = await quotaRoom(userId, channel);
  if (adding <= q.room) return q;
  const what = LABEL[channel];
  const message =
    q.reason === 'lifetime'
      ? `The ${q.plan.name} plan includes ${fmt(q.cap)} ${what} in total, and ${fmt(q.used)} are already used or queued. ${q.room === 0 ? 'Choose a plan to keep sending.' : `This campaign needs ${fmt(adding)}, so only ${fmt(q.room)} more fit. Choose a plan to send more.`}`
      : `The ${q.plan.name} plan includes ${fmt(q.cap)} messages a month (WhatsApp and email together), and ${fmt(q.used)} are used or queued in the last 30 days. ${q.room === 0 ? 'Wait for it to free up, or move to a bigger plan.' : `This campaign needs ${fmt(adding)}, but only ${fmt(q.room)} more fit.`}`;
  throw Object.assign(bad(message, 402), { code: 'upgrade_required' });
}

/** Numbers for the screens: what each total limit is and how much is used. */
export async function quotaSummary(userId) {
  const { limits: all } = await resolveLimits(userId);
  const lim = limitsOf(all);
  const u = await usageOf(userId, lim);
  const one = (cap, used) => ({ cap, used, left: cap ? Math.max(0, cap - used) : null });
  return {
    lifetime: {
      whatsapp: one(lim.lifetime.whatsapp, u.lifetime.whatsapp.sent + u.lifetime.whatsapp.queued),
      email: one(lim.lifetime.email, u.lifetime.email.sent + u.lifetime.email.queued),
    },
    month: one(lim.monthly, u.month.sent + u.month.queued),
  };
}

/** Add to an account's permanent sent total (called once per message that was really sent). */
export const countSent = (userId, channel) => User.updateOne({ _id: userId }, { $inc: { [`sentTotals.${channel}`]: 1 } }).catch(() => {});
