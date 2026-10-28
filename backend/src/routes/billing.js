import { Router } from 'express';
import mongoose from 'mongoose';
import { isGstin } from '../billing/invoice.js';
import { fromReq, record } from '../audit/audit.js';
import { applyRemote, endSubscription, handleWebhookEvent, settlePayment } from '../billing/service.js';
import { cancelSubscription, createSubscription, ensureRazorpayPlan, fetchSubscription, razorpayEnabled, toPaise, verifyPaymentSignature, verifyWebhookSignature } from '../billing/razorpay.js';
import { config } from '../config.js';
import { Invoice, Plan, Subscription, User } from '../models.js';
import { platformLimits, onlyLimits } from '../plans/definitions.js';
import { resolveLimits } from '../plans/limits.js';
import { quotaSummary } from '../plans/quota.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';

const LIVE = ['authenticated', 'active', 'pending', 'halted'];
const INTERVALS = ['month', 'year'];

const publicPlan = (p) => ({
  key: p.key,
  name: p.name,
  tagline: p.tagline || '',
  priceMonthly: p.priceMonthly || 0,
  priceYearly: p.priceYearly || 0,
  limits: { ...platformLimits(), ...onlyLimits(p.limits) },
});

/** Public: the plans on sale, with live prices and limits (what an administrator set). */
export function publicPlansRouter() {
  const router = Router();
  router.get('/', async (_req, res) => {
    const plans = await Plan.find({ listed: { $ne: false } }).sort({ sortOrder: 1, key: 1 }).lean();
    res.set('Cache-Control', 'public, max-age=60').json({ plans: plans.map(publicPlan), paymentsEnabled: razorpayEnabled() });
  });
  return router;
}

const currentSub = (userId) => Subscription.findOne({ userId, endedAt: null, status: { $in: LIVE } }).sort({ createdAt: -1 });
const subView = (s) => s && { planKey: s.planKey, interval: s.interval, status: s.status, currentEnd: s.currentEnd, cancelAtCycleEnd: s.cancelAtCycleEnd, amount: s.amount / 100 };

async function status(userId) {
  const [plans, sub, resolved, usage, me] = await Promise.all([
    Plan.find({ listed: { $ne: false } }).sort({ sortOrder: 1, key: 1 }).lean(),
    currentSub(userId),
    resolveLimits(userId),
    quotaSummary(userId),
    User.findById(userId).select('billing').lean(),
  ]);
  return { profile: { name: me?.billing?.name || '', address: me?.billing?.address || '', state: me?.billing?.state || '', gstin: me?.billing?.gstin || '' }, gst: config.invoice.gstRate > 0, enabled: razorpayEnabled(), keyId: razorpayEnabled() ? config.razorpay.keyId : null, plans: plans.map(publicPlan), current: resolved.plan, subscription: subView(sub), usage };
}

export function billingRouter() {
  const router = Router();

  router.get('/', async (req, res) => res.json(await status(req.userId)));

  // Step 1: create the subscription at Razorpay; the browser then opens Razorpay's payment window with the returned id.
  router.post('/subscribe', async (req, res) => {
    if (!razorpayEnabled()) throw bad('Online payments are not switched on yet.', 503);
    const { planKey, interval } = req.body || {};
    if (!INTERVALS.includes(interval)) throw bad('Choose monthly or yearly billing.');
    const plan = await Plan.findOne({ key: String(planKey || '').toLowerCase(), listed: { $ne: false } }).lean();
    if (!plan) throw bad('That plan is not available.', 404);
    const rupees = interval === 'year' ? plan.priceYearly : plan.priceMonthly;
    if (!(rupees >= 1)) throw bad('That plan cannot be bought online.');
    const existing = await currentSub(req.userId);
    if (existing && existing.planKey === plan.key && existing.interval === interval && !existing.cancelAtCycleEnd) throw bad('You are already on this plan.', 409);

    const rp = await ensureRazorpayPlan(plan, interval, (next) => Plan.updateOne({ key: plan.key }, { $set: { razorpay: next } }));
    const remote = await createSubscription({ razorpayPlanId: rp.id, interval, notes: { userId: String(req.userId), planKey: plan.key, interval } });
    await Subscription.create({ userId: req.userId, planKey: plan.key, interval, amount: toPaise(rupees), razorpaySubscriptionId: remote.id, razorpayPlanId: rp.id, status: remote.status || 'created' });
    const user = await User.findById(req.userId).select('email').lean();
    res.status(201).json({ subscriptionId: remote.id, keyId: config.razorpay.keyId, name: 'Reachroute', description: `${plan.name} (${interval === 'year' ? 'yearly' : 'monthly'})`, email: user?.email });
  });

  // Step 2: the browser reports the payment. The signature proves it came from Razorpay's window, then we ask Razorpay for the details.
  router.post('/verify', async (req, res) => {
    const b = req.body || {};
    if (!verifyPaymentSignature({ paymentId: b.razorpay_payment_id, subscriptionId: b.razorpay_subscription_id, signature: b.razorpay_signature })) throw bad('The payment could not be confirmed. If money was taken, it will be matched automatically within a few minutes.', 400);
    const sub = await Subscription.findOne({ razorpaySubscriptionId: b.razorpay_subscription_id, userId: req.userId });
    if (!sub) throw bad('Subscription not found', 404);
    applyRemote(sub, await fetchSubscription(sub.razorpaySubscriptionId), { paid: true });
    sub.lastPaymentId = String(b.razorpay_payment_id);
    sub.endedAt = null;
    await sub.save();
    await settlePayment(sub, { paymentId: String(b.razorpay_payment_id) });
    await record({ ...fromReq(req), action: 'billing.subscribed', detail: `${sub.planKey} ${sub.interval}` });
    res.json(await status(req.userId));
  });

  // Details printed on invoices. They apply to invoices made from now on; old invoices never change.
  router.put('/profile', async (req, res) => {
    const b = req.body || {};
    const clip = (v, max, label) => {
      const s = String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
      if (s.length > max) throw bad(`${label} is too long (most ${max} characters)`);
      return s;
    };
    const gstin = clip(b.gstin, 15, 'The GSTIN').toUpperCase();
    if (gstin && !isGstin(gstin)) throw bad('That GSTIN does not look right. It has 15 letters and digits, like 27ABCDE1234F1Z5.');
    const billing = { name: clip(b.name, 120, 'The name'), address: clip(b.address, 300, 'The address'), state: clip(b.state, 60, 'The state'), gstin };
    await User.updateOne({ _id: req.userId }, { $set: { billing } });
    res.json({ profile: billing });
  });

  router.get('/invoices', async (req, res) => {
    const rows = await Invoice.find({ userId: req.userId }).sort({ issuedAt: -1 }).limit(100).select('number issuedAt planName interval totalPaise creditNotes').lean();
    res.json({ invoices: rows.map((i) => ({ id: i._id, number: i.number, issuedAt: i.issuedAt, planName: i.planName, interval: i.interval, total: i.totalPaise / 100, refunded: (i.creditNotes || []).reduce((t, c) => t + c.amountPaise, 0) / 100 })) });
  });

  router.get('/invoices/:id', async (req, res) => {
    if (!mongoose.isValidObjectId(req.params.id)) throw bad('Not found', 404);
    const i = await Invoice.findOne({ _id: req.params.id, userId: req.userId }).lean();
    if (!i) throw bad('Not found', 404);
    const rupee = (p) => p / 100;
    res.json({
      invoice: {
        id: i._id, number: i.number, issuedAt: i.issuedAt, title: i.seller?.gstin && i.gstRate > 0 ? 'Tax invoice' : 'Invoice',
        planName: i.planName, interval: i.interval, periodStart: i.periodStart, periodEnd: i.periodEnd, paymentId: i.paymentId, gstRate: i.gstRate,
        total: rupee(i.totalPaise), taxable: rupee(i.taxablePaise), cgst: rupee(i.cgstPaise), sgst: rupee(i.sgstPaise), igst: rupee(i.igstPaise),
        seller: i.seller, buyer: i.buyer,
        creditNotes: (i.creditNotes || []).map((c) => ({ number: c.number, amount: c.amountPaise / 100, reason: c.reason, issuedAt: c.issuedAt })),
      },
    });
  });

  router.post('/cancel', async (req, res) => {
    const sub = await currentSub(req.userId);
    if (!sub) throw bad('You have no paid subscription to cancel.', 404);
    const atEnd = sub.status === 'active' && sub.paidCount > 0;
    await cancelSubscription(sub.razorpaySubscriptionId, atEnd);
    if (atEnd) {
      sub.cancelAtCycleEnd = true;
      await sub.save();
    } else {
      sub.status = 'cancelled';
      await endSubscription(sub);
    }
    await record({ ...fromReq(req), action: 'billing.cancelled', detail: `${sub.planKey} ${atEnd ? 'at period end' : 'now'}` });
    res.json(await status(req.userId));
  });

  return router;
}

/** Public, signed by Razorpay. Needs the raw request body, so it is mounted before the JSON parser. */
export function billingWebhook() {
  return async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    if (!verifyWebhookSignature(raw, req.get('x-razorpay-signature'))) return res.status(400).json({ error: 'Bad signature' });
    let event;
    try {
      event = JSON.parse(raw.toString('utf8'));
    } catch {
      return res.status(400).json({ error: 'Not JSON' });
    }
    try {
      const result = await handleWebhookEvent(event, req.get('x-razorpay-event-id'));
      res.json({ ok: true, result });
    } catch (err) {
      logger.error({ err: err.message, event: event?.event }, 'billing webhook failed');
      res.status(500).json({ error: 'Try again' }); // Razorpay retries
    }
  };
}
