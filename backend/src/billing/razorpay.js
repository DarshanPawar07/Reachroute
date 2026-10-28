import crypto from 'node:crypto';
import { config } from '../config.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';

/**
 * Razorpay, through its plain HTTP API (no SDK). Payments are on only when RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET are set.
 * Test keys ("rzp_test_...") and live keys ("rzp_live_...") work the same way.
 */

const API = 'https://api.razorpay.com/v1';
let doFetch = (...args) => fetch(...args);
/** For tests: replace the network call. */
export const setFetch = (fn) => {
  doFetch = fn || ((...args) => fetch(...args));
};

export const razorpayEnabled = () => Boolean(config.razorpay.keyId && config.razorpay.keySecret);

async function call(method, path, body) {
  if (!razorpayEnabled()) throw bad('Online payments are not switched on yet.', 503);
  let res;
  try {
    res = await doFetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Basic ${Buffer.from(`${config.razorpay.keyId}:${config.razorpay.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err) {
    logger.error({ err: err.message, path }, 'Razorpay could not be reached');
    throw bad('The payment service could not be reached. Try again in a moment.', 503);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    logger.warn({ status: res.status, path, error: data?.error }, 'Razorpay refused a request');
    throw bad(`The payment service said: ${data?.error?.description || `error ${res.status}`}`, res.status >= 500 ? 503 : 400);
  }
  return data;
}

export const toPaise = (rupees) => Math.round(Number(rupees) * 100);

/** The Razorpay plan for this price and period; made when it does not exist yet or the price changed. `save(razorpay)` stores the new ids. */
export async function ensureRazorpayPlan(plan, interval, save) {
  const rupees = interval === 'year' ? plan.priceYearly : plan.priceMonthly;
  const amount = toPaise(rupees);
  if (!(amount >= 100)) throw bad('This plan has no price for that period.', 400);
  const have = plan.razorpay?.[interval];
  if (have?.id && have.amount === amount) return { id: have.id, amount };
  const made = await call('POST', '/plans', {
    period: interval === 'year' ? 'yearly' : 'monthly',
    interval: 1,
    item: { name: `${plan.name} (${interval === 'year' ? 'yearly' : 'monthly'})`, amount, currency: 'INR', description: `Reachroute ${plan.name}` },
    notes: { planKey: plan.key, interval },
  });
  const next = { month: plan.razorpay?.month, year: plan.razorpay?.year, [interval]: { id: made.id, amount } };
  await save(next);
  return { id: made.id, amount };
}

/** Start a subscription. Razorpay stops after total_count payments: 10 years either way. */
export const createSubscription = ({ razorpayPlanId, interval, notes }) =>
  call('POST', '/subscriptions', { plan_id: razorpayPlanId, total_count: interval === 'year' ? 10 : 120, customer_notify: 1, notes });

export const fetchSubscription = (id) => call('GET', `/subscriptions/${encodeURIComponent(id)}`);

/** atCycleEnd: keep the plan until the period that is already paid for runs out. */
export const cancelSubscription = (id, atCycleEnd) =>
  call('POST', `/subscriptions/${encodeURIComponent(id)}/cancel`, { cancel_at_cycle_end: atCycleEnd ? 1 : 0 });

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

/** The browser's proof that a payment was made: HMAC of "payment_id|subscription_id" with the key secret. */
export const verifyPaymentSignature = ({ paymentId, subscriptionId, signature, secret = config.razorpay.keySecret }) =>
  Boolean(secret && paymentId && subscriptionId && signature) && safeEqual(hmac(secret, `${paymentId}|${subscriptionId}`), signature);

/** Razorpay's proof that a webhook is from them: HMAC of the exact bytes received, with the webhook secret. */
export const verifyWebhookSignature = (rawBody, signature, secret = config.razorpay.webhookSecret) =>
  Boolean(secret && signature && rawBody) && safeEqual(hmac(secret, rawBody), signature);
