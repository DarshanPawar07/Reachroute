import { config } from '../config.js';
import { BillingEvent, Plan, Subscription, User } from '../models.js';
import { forgetLimits } from '../plans/limits.js';
import { notify } from '../utils/notify.js';
import { logger } from '../utils/logger.js';
import { emailPaymentFailed, emailPaymentReceived, emailPlanEnded, emailPlanEnding } from './emails.js';
import { createInvoice } from './invoice.js';
import { cancelSubscription, fetchSubscription, razorpayEnabled } from './razorpay.js';

const log = logger.child({ mod: 'billing' });
const DAY = 24 * 60 * 60 * 1000;
const LIVE = ['authenticated', 'active', 'pending', 'halted'];
const ENDED = ['cancelled', 'completed', 'expired'];
const fromUnix = (n) => (Number.isFinite(n) && n > 0 ? new Date(n * 1000) : null);
export const addPeriod = (from, interval) => new Date(from.getTime() + (interval === 'year' ? 366 : 31) * DAY);

/** Copy what Razorpay says about a subscription onto ours. `paid` = a payment for it was just confirmed. */
export function applyRemote(sub, remote, { paid = false } = {}) {
  const status = String(remote?.status || sub.status);
  sub.status = paid && (status === 'authenticated' || status === 'created') ? 'active' : status;
  if (Number.isFinite(remote?.paid_count)) sub.paidCount = remote.paid_count;
  sub.currentStart = fromUnix(remote?.current_start) || sub.currentStart;
  sub.currentEnd = fromUnix(remote?.current_end) || sub.currentEnd;
  if (sub.status === 'active' && !sub.currentEnd) sub.currentEnd = addPeriod(sub.currentStart || new Date(), sub.interval); // Razorpay may not say yet
  if (remote?.has_scheduled_changes && remote?.change_scheduled_at) sub.cancelAtCycleEnd = sub.cancelAtCycleEnd || false;
  return sub;
}

/** Put the account on the subscription's plan. Any older paid subscription of the same account is stopped (no refund). */
export async function grantPlan(sub) {
  if (!(await Plan.exists({ key: sub.planKey }))) {
    log.error({ planKey: sub.planKey, userId: String(sub.userId) }, 'paid for a plan that no longer exists');
    return false;
  }
  await User.updateOne({ _id: sub.userId }, { $set: { planKey: sub.planKey } });
  forgetLimits(sub.userId);
  const older = await Subscription.find({ userId: sub.userId, _id: { $ne: sub._id }, endedAt: null, status: { $in: LIVE } });
  for (const old of older) {
    try {
      await cancelSubscription(old.razorpaySubscriptionId, false);
    } catch (err) {
      log.warn({ err: err.message, id: old.razorpaySubscriptionId }, 'could not stop the older subscription');
    }
    old.status = 'cancelled';
    old.endedAt = new Date();
    await old.save();
  }
  return true;
}

/**
 * A payment for this subscription is confirmed (by the browser, a webhook or the sync): put the account on the plan,
 * issue the invoice and email it. Safe to run more than once for the same payment: the invoice and email happen once.
 */
export async function settlePayment(sub, { paymentId = '', amountPaise } = {}) {
  const granted = await grantPlan(sub);
  if (!granted || !(sub.paidCount > 0 || sub.status === 'active')) return null;
  const { invoice, created } = await createInvoice(sub, { paymentId: paymentId || sub.lastPaymentId, amountPaise: amountPaise || sub.amount });
  if (created) await emailPaymentReceived(sub.userId, { invoice, planName: invoice.planName });
  return invoice;
}

/** The subscription is over: take the account back to the default plan, unless an administrator already moved it elsewhere. */
export async function endSubscription(sub, why = 'ended') {
  if (!sub.endedAt) sub.endedAt = new Date();
  if (!ENDED.includes(sub.status)) sub.status = 'expired';
  await sub.save();
  const moved = await User.updateOne({ _id: sub.userId, planKey: sub.planKey }, { $set: { planKey: config.defaultPlanKey || null } });
  forgetLimits(sub.userId);
  if (moved.modifiedCount) {
    const plan = await Plan.findOne({ key: sub.planKey }).select('name').lean();
    await notify(sub.userId, {
      type: 'plan_ended',
      level: 'warning',
      title: `Your ${plan?.name || 'paid'} plan has ended`,
      message: why === 'payment' ? 'The last payment did not go through. Subscribe again to keep your limits.' : 'Subscribe again any time to get your limits back.',
      link: '/billing',
      dedupeKey: `plan_ended:${sub._id}`,
    });
    await emailPlanEnded(sub.userId, { planName: plan?.name || sub.planKey, payment: why === 'payment' });
  }
}

/** Accounts whose paid period is over go back to the default plan. Safe to run on every instance, as often as wanted. */
export async function runBillingExpiry(now = new Date()) {
  const subs = await Subscription.find({ endedAt: null, currentEnd: { $ne: null, $lt: now } }).limit(200);
  let ended = 0;
  for (const sub of subs) {
    const over = ENDED.includes(sub.status) || sub.cancelAtCycleEnd;
    const grace = config.billingGraceDays * DAY;
    if (over ? sub.currentEnd < now : sub.currentEnd.getTime() + grace < now.getTime()) {
      await endSubscription(sub, over ? 'ended' : 'payment');
      ended++;
    }
  }
  return ended;
}

/**
 * Ask Razorpay about subscriptions that need a second look, so billing stays right even when a webhook never arrives:
 *   - a subscription whose paid period is over or ends within a day (was it renewed, cancelled or did the payment fail?)
 *   - one started in the last 3 days that we never saw paid (the person paid, then closed the page)
 * Returns how many were updated.
 */
export async function syncSubscriptions(now = new Date()) {
  if (!razorpayEnabled()) return 0;
  const subs = await Subscription.find({
    endedAt: null,
    $or: [
      { status: { $in: LIVE }, currentEnd: { $lt: new Date(now.getTime() + DAY) } },
      { status: 'created', createdAt: { $gte: new Date(now.getTime() - 3 * DAY) } },
    ],
  })
    .sort({ updatedAt: 1 })
    .limit(50);
  let changed = 0;
  for (const sub of subs) {
    try {
      const remote = await fetchSubscription(sub.razorpaySubscriptionId);
      const before = `${sub.status}|${sub.paidCount}|${sub.currentEnd?.getTime()}`;
      const paid = Number(remote.paid_count) > 0;
      if (sub.status === 'created' && !paid) continue; // never paid: nothing to do
      applyRemote(sub, remote, { paid });
      if (remote.status === 'cancelled' || remote.status === 'completed') sub.cancelAtCycleEnd = true; // the paid period is honoured; expiry ends it
      if (`${sub.status}|${sub.paidCount}|${sub.currentEnd?.getTime()}` === before) continue;
      await sub.save();
      if (sub.status === 'active') await settlePayment(sub);
      changed++;
    } catch (err) {
      log.warn({ err: err.message, id: sub.razorpaySubscriptionId }, 'could not check a subscription with Razorpay');
    }
  }
  return changed;
}

/** Email a heads-up three days before a plan ends (cancelled, or a payment that is not going through). Once per period. */
export async function sendEndingReminders(now = new Date()) {
  const soon = new Date(now.getTime() + 3 * DAY);
  const subs = await Subscription.find({ endedAt: null, currentEnd: { $gt: now, $lte: soon }, $or: [{ cancelAtCycleEnd: true }, { status: { $in: ['pending', 'halted'] } }] }).limit(200);
  let sent = 0;
  for (const sub of subs) {
    if (sub.reminderFor && sub.reminderFor.getTime() === sub.currentEnd.getTime()) continue;
    sub.reminderFor = sub.currentEnd;
    await sub.save(); // marked first: a crash loses one email rather than sending many
    const plan = await Plan.findOne({ key: sub.planKey }).select('name').lean();
    await emailPlanEnding(sub.userId, { planName: plan?.name || sub.planKey, endsAt: sub.currentEnd, cancelled: sub.cancelAtCycleEnd });
    sent++;
  }
  return sent;
}

export function startBillingJob() {
  const run = async () => {
    try {
      await syncSubscriptions(); // first, so a renewal we were not told about is not mistaken for a lapse
      await sendEndingReminders();
      await runBillingExpiry();
    } catch (err) {
      log.error({ err: err.message }, 'billing check failed');
    }
  };
  const first = setTimeout(run, 60_000);
  const timer = setInterval(run, 30 * 60_000);
  first.unref?.();
  timer.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(timer);
  };
}

const PLAN_LINK = '/billing';

/** Handle one verified webhook event. Returns what was done, for tests and logs. */
export async function handleWebhookEvent(event, eventId) {
  if (eventId) {
    try {
      await BillingEvent.create({ _id: eventId, type: event?.event });
    } catch (err) {
      if (err.code === 11000) return 'duplicate';
      throw err;
    }
  }
  try {
    return await processEvent(event);
  } catch (err) {
    if (eventId) await BillingEvent.deleteOne({ _id: eventId }).catch(() => {}); // let Razorpay's retry run it again
    throw err;
  }
}

async function processEvent(event) {
  const remote = event?.payload?.subscription?.entity;
  if (!remote?.id) return 'ignored';
  const sub = await Subscription.findOne({ razorpaySubscriptionId: remote.id });
  if (!sub) return 'unknown subscription';
  const type = event.event;
  const plan = await Plan.findOne({ key: sub.planKey }).select('name').lean();
  const name = plan?.name || sub.planKey;

  switch (type) {
    case 'subscription.authenticated':
      applyRemote(sub, remote);
      await sub.save();
      return 'authenticated';
    case 'subscription.activated':
    case 'subscription.charged': {
      const wasActive = sub.status === 'active' && sub.paidCount > 0;
      const lastPayment = event.payload?.payment?.entity?.id;
      applyRemote(sub, remote, { paid: true });
      if (lastPayment) sub.lastPaymentId = lastPayment;
      sub.endedAt = null;
      await sub.save();
      const paidPaise = event.payload?.payment?.entity?.amount;
      await settlePayment(sub, { paymentId: lastPayment || '', amountPaise: Number.isFinite(paidPaise) && paidPaise > 0 ? paidPaise : undefined });
      await notify(sub.userId, {
        type: 'plan_paid',
        level: 'success',
        title: wasActive ? `${name} renewed` : `You are on the ${name} plan`,
        message: sub.currentEnd ? `Paid until ${sub.currentEnd.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric' })}.` : 'Thank you.',
        link: PLAN_LINK,
        dedupeKey: `plan_paid:${sub._id}:${sub.paidCount}`,
      });
      return type;
    }
    case 'subscription.pending':
      applyRemote(sub, remote);
      await sub.save();
      await notify(sub.userId, { type: 'plan_payment_failed', level: 'warning', title: 'Your payment did not go through', message: `Razorpay will try again. Keep the ${name} plan by making sure the card or UPI mandate has enough balance.`, link: PLAN_LINK, dedupeKey: `plan_pending:${sub._id}` });
      await emailPaymentFailed(sub.userId, { planName: name, halted: false });
      return type;
    case 'subscription.halted':
      applyRemote(sub, remote);
      await sub.save();
      await notify(sub.userId, { type: 'plan_payment_failed', level: 'error', title: 'Your subscription is on hold', message: `Payments for the ${name} plan failed several times. Subscribe again to keep your limits.`, link: PLAN_LINK, dedupeKey: `plan_halted:${sub._id}` });
      await emailPaymentFailed(sub.userId, { planName: name, halted: true });
      return type;
    case 'subscription.cancelled':
    case 'subscription.completed':
      applyRemote(sub, remote);
      sub.cancelAtCycleEnd = true; // the paid period is honoured; the expiry job ends it
      await sub.save();
      if (!sub.currentEnd || sub.currentEnd < new Date()) await endSubscription(sub);
      return type;
    default:
      return 'ignored';
  }
}
