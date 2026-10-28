import './env.js';
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';

// Plans, quotas and Razorpay billing against a THROW-AWAY MongoDB database (name must contain "test"). Razorpay itself is faked.
const URI = process.env.TEST_MONGO_URI;
if (URI && !/test/i.test(URI)) throw new Error('TEST_MONGO_URI must contain "test"');
const skip = URI ? false : 'set TEST_MONGO_URI to a throw-away database to run these tests';
process.env.SMTP_HOST = '';
process.env.ALERT_EMAILS = 'false';
process.env.RAZORPAY_KEY_ID = 'rzp_test_fake';
process.env.RAZORPAY_KEY_SECRET = 'fake_secret';
process.env.RAZORPAY_WEBHOOK_SECRET = 'fake_webhook_secret';

const mongoose = (await import('mongoose')).default;
const models = await import('../src/models.js');
const { buildApp } = await import('../src/app.js');
const { createLimiters } = await import('../src/middleware/limits.js');
const { setFetch } = await import('../src/billing/razorpay.js');
const { runBillingExpiry, syncSubscriptions } = await import('../src/billing/service.js');
const { forgetAllLimits } = await import('../src/plans/limits.js');
const { assertQuota, quotaRoom } = await import('../src/plans/quota.js');
const { ensureDefaultPlans } = await import('../src/plans/defaults.js');
const { User, Plan, Subscription, Recipient, Campaign, BillingEvent } = models;

const PASSWORD = 'correct horse battery';
const T = { skip, timeout: 30_000 };
const tag = `bil${Date.now().toString(36)}`;
const made = [];
const planKeys = [];
let server;
let base;
let counter = 0;
let rzpCalls = [];

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

before(async () => {
  if (!URI) return;
  await mongoose.connect(URI);
  await Promise.all(Object.values(models).filter((m) => typeof m?.init === 'function').map((m) => m.init()));
  server = http.createServer(buildApp({ ...createLimiters(), register: (_req, _res, next) => next() }));
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  // fake Razorpay
  setFetch(async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : {};
    rzpCalls.push({ url, method: init.method, body });
    const json = (o) => ({ ok: true, status: 200, json: async () => o });
    if (url.endsWith('/plans')) return json({ id: `plan_${Math.random().toString(36).slice(2, 8)}` });
    if (url.endsWith('/subscriptions')) return json({ id: `sub_${tag}_${rzpCalls.length}`, status: 'created' });
    if (url.includes('/cancel')) return json({ status: 'cancelled' });
    return json({ status: 'active', paid_count: 1, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 2_592_000 });
  });
});

after(async () => {
  if (!URI) return;
  setFetch(null);
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  const ids = made.map((u) => u.id);
  await Promise.all([
    User.deleteMany({ _id: { $in: ids } }),
    Plan.deleteMany({ key: { $in: planKeys } }),
    Subscription.deleteMany({ userId: { $in: ids } }),
    models.Invoice.deleteMany({ userId: { $in: ids } }),
    Recipient.deleteMany({ userId: { $in: ids } }),
    Campaign.deleteMany({ userId: { $in: ids } }),
    BillingEvent.deleteMany({ _id: new RegExp(`^${tag}`) }),
  ]);
  await mongoose.disconnect();
});

async function call(method, path, { token, json, raw, headers = {} } = {}) {
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  if (json !== undefined) h['Content-Type'] = 'application/json';
  const res = await fetch(base + path, { method, headers: h, body: raw ?? (json === undefined ? undefined : JSON.stringify(json)) });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const say = (r) => JSON.stringify(r.body);

async function newUser({ admin = false } = {}) {
  const email = `u${counter++}.${tag}@example.com`;
  const res = await call('POST', '/api/auth/register', { json: { email, password: PASSWORD } });
  assert.equal(res.status, 201, say(res));
  const user = { email, token: res.body.token, id: new mongoose.Types.ObjectId(res.body.user.id) };
  if (admin) await User.updateOne({ _id: user.id }, { $set: { role: 'admin' } });
  made.push(user);
  return user;
}
async function makePlan(suffix, extra = {}) {
  const key = `${tag}-${suffix}`;
  planKeys.push(key);
  await Plan.create({ key, name: `Plan ${suffix}`, priceMonthly: 100, priceYearly: 1000, ...extra });
  return key;
}
const webhook = (event, { id = `${tag}-ev${Math.random()}`, secret = 'fake_webhook_secret' } = {}) => {
  const raw = JSON.stringify(event);
  return call('POST', '/api/billing/webhook', { raw, headers: { 'content-type': 'application/json', 'x-razorpay-signature': hmac(secret, raw), 'x-razorpay-event-id': id } });
};

test('the starting plans are created once and never overwrite an admin edit', T, async () => {
  await ensureDefaultPlans();
  await Plan.updateOne({ key: 'pro' }, { $set: { priceMonthly: 777 } });
  assert.deepEqual(await ensureDefaultPlans(), []);
  assert.equal((await Plan.findOne({ key: 'pro' })).priceMonthly, 777);
  await Plan.updateOne({ key: 'pro' }, { $set: { priceMonthly: 699 } });
});

test('Free total limit: counts sent and queued, never refills', T, async () => {
  const key = await makePlan('free', { limits: { waLifetimeCap: 5, emailLifetimeCap: 2 } });
  const u = await newUser();
  await User.updateOne({ _id: u.id }, { $set: { planKey: key } });
  forgetAllLimits();
  const camp = await Campaign.create({ userId: u.id, name: 'c', template: 'hi', status: 'running', total: 4 });
  const rows = (status, n) => Array.from({ length: n }, (_, i) => ({ campaignId: camp._id, userId: u.id, phone: `91900000${status}${i}`, status }));
  await Recipient.insertMany([...rows('sent', 3), ...rows('pending', 1)]);
  assert.equal((await quotaRoom(u.id, 'whatsapp')).room, 1);
  await assert.rejects(assertQuota(u.id, 'whatsapp', 2), (e) => e.status === 402 && e.code === 'upgrade_required' && /5 WhatsApp messages in total/.test(e.message));
  await assertQuota(u.id, 'whatsapp', 1);
  // deleting the campaign does not give messages back: the permanent counter holds them
  await User.updateOne({ _id: u.id }, { $set: { 'sentTotals.whatsapp': 5 } });
  await Recipient.deleteMany({ userId: u.id });
  assert.equal((await quotaRoom(u.id, 'whatsapp')).room, 0);
  // email has its own total
  assert.equal((await quotaRoom(u.id, 'email')).room, 2);
});

test('monthly limit counts WhatsApp and email together', T, async () => {
  const key = await makePlan('pro', { limits: { monthlyCap: 4 } });
  const u = await newUser();
  await User.updateOne({ _id: u.id }, { $set: { planKey: key } });
  forgetAllLimits();
  const camp = await Campaign.create({ userId: u.id, name: 'c', template: 'hi', status: 'running', total: 2 });
  await Recipient.insertMany([1, 2].map((i) => ({ campaignId: camp._id, userId: u.id, phone: `9190000000${i}`, status: 'sent', sentAt: new Date() })));
  const ec = await models.EmailCampaign.create({ userId: u.id, name: 'e', subject: 's', body: 'b', status: 'running', total: 1 });
  await models.EmailRecipient.create({ campaignId: ec._id, userId: u.id, email: `a@${tag}.test`, status: 'sent', sentAt: new Date() });
  const q = await quotaRoom(u.id, 'email');
  assert.equal(q.room, 1);
  assert.equal(q.reason, 'monthly');
  await models.EmailRecipient.deleteMany({ userId: u.id });
  await models.EmailCampaign.deleteMany({ userId: u.id });
});

test('a new account starts on the default plan when DEFAULT_PLAN_KEY is set', T, async () => {
  const { config } = await import('../src/config.js');
  config.defaultPlanKey = 'free';
  try {
    const u = await newUser();
    assert.equal((await User.findById(u.id).lean()).planKey, 'free');
  } finally {
    config.defaultPlanKey = '';
  }
});

test('subscribe -> verify -> the account is on the plan; a bad signature is refused', T, async () => {
  const key = await makePlan('buy', { limits: { waDailyCap: 123 } });
  const u = await newUser();
  const s = await call('POST', '/api/billing/subscribe', { token: u.token, json: { planKey: key, interval: 'month' } });
  assert.equal(s.status, 201, say(s));
  assert.equal(s.body.keyId, 'rzp_test_fake');
  const plan = await Plan.findOne({ key }).lean();
  assert.equal(plan.razorpay.month.amount, 10000);
  const subId = s.body.subscriptionId;

  const bad = await call('POST', '/api/billing/verify', { token: u.token, json: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: subId, razorpay_signature: 'nope' } });
  assert.equal(bad.status, 400);
  assert.equal((await User.findById(u.id).lean()).planKey, null);

  const ok = await call('POST', '/api/billing/verify', { token: u.token, json: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: subId, razorpay_signature: hmac('fake_secret', `pay_1|${subId}`) } });
  assert.equal(ok.status, 200, say(ok));
  assert.equal(ok.body.current.key, key);
  assert.equal(ok.body.subscription.status, 'active');

  // someone else cannot verify this subscription
  const other = await newUser();
  const steal = await call('POST', '/api/billing/verify', { token: other.token, json: { razorpay_payment_id: 'pay_1', razorpay_subscription_id: subId, razorpay_signature: hmac('fake_secret', `pay_1|${subId}`) } });
  assert.equal(steal.status, 404);
});

test('webhook: bad signature refused, good one applied once, repeats ignored', T, async () => {
  const key = await makePlan('hook');
  const u = await newUser();
  const s = await call('POST', '/api/billing/subscribe', { token: u.token, json: { planKey: key, interval: 'year' } });
  const subId = s.body.subscriptionId;
  const event = { event: 'subscription.charged', payload: { subscription: { entity: { id: subId, status: 'active', paid_count: 1, current_start: Math.floor(Date.now() / 1000), current_end: Math.floor(Date.now() / 1000) + 86_400 } }, payment: { entity: { id: 'pay_9' } } } };
  assert.equal((await webhook(event, { secret: 'wrong' })).status, 400);
  const id = `${tag}-once`;
  const first = await webhook(event, { id });
  assert.equal(first.status, 200, say(first));
  assert.equal((await User.findById(u.id).lean()).planKey, key);
  assert.equal((await webhook(event, { id })).body.result, 'duplicate');
});

test('cancel keeps the plan until the paid period ends, then the expiry job moves the account back', T, async () => {
  const key = await makePlan('cancel');
  const u = await newUser();
  const s = await call('POST', '/api/billing/subscribe', { token: u.token, json: { planKey: key, interval: 'month' } });
  const subId = s.body.subscriptionId;
  await call('POST', '/api/billing/verify', { token: u.token, json: { razorpay_payment_id: 'pay_2', razorpay_subscription_id: subId, razorpay_signature: hmac('fake_secret', `pay_2|${subId}`) } });
  const c = await call('POST', '/api/billing/cancel', { token: u.token });
  assert.equal(c.status, 200, say(c));
  assert.equal(c.body.subscription.cancelAtCycleEnd, true);
  assert.equal((await User.findById(u.id).lean()).planKey, key);
  await runBillingExpiry(new Date());
  assert.equal((await User.findById(u.id).lean()).planKey, key); // still paid for
  await runBillingExpiry(new Date(Date.now() + 40 * 86_400_000));
  assert.equal((await User.findById(u.id).lean()).planKey, null);
});

test('the expiry job does not undo a plan an administrator chose', T, async () => {
  const key = await makePlan('admin1');
  const manual = await makePlan('admin2');
  const u = await newUser();
  await Subscription.create({ userId: u.id, planKey: key, interval: 'month', amount: 100, razorpaySubscriptionId: `sub_${tag}_x`, razorpayPlanId: 'p', status: 'cancelled', cancelAtCycleEnd: true, currentEnd: new Date(Date.now() - 1000) });
  await User.updateOne({ _id: u.id }, { $set: { planKey: manual } });
  await runBillingExpiry(new Date());
  assert.equal((await User.findById(u.id).lean()).planKey, manual);
});

test('admin can edit prices and limits live, and the public plans list shows them', T, async () => {
  const admin = await newUser({ admin: true });
  const key = await makePlan('live', { limits: { waDailyCap: 10 } });
  const r = await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: { priceMonthly: 799, priceYearly: 7990, limits: { waDailyCap: 250, monthlyCap: 6000 } } });
  assert.equal(r.status, 200, say(r));
  assert.equal(r.body.plan.priceMonthly, 799);
  const pub = await call('GET', '/api/plans');
  const row = pub.body.plans.find((p) => p.key === key);
  assert.equal(row.priceMonthly, 799);
  assert.equal(row.limits.waDailyCap, 250);
  assert.equal(row.limits.monthlyCap, 6000);
  const badPrice = await call('PUT', `/api/admin/plans/${key}`, { token: admin.token, json: { priceMonthly: -5 } });
  assert.equal(badPrice.status, 400);
});

test('sync: a renewal we were never told about keeps the account on its plan', T, async () => {
  const key = await makePlan('sync1');
  const u = await newUser();
  await User.updateOne({ _id: u.id }, { $set: { planKey: key } });
  const sub = await Subscription.create({ userId: u.id, planKey: key, interval: 'month', amount: 100, razorpaySubscriptionId: `sub_${tag}_sync1`, razorpayPlanId: 'p', status: 'active', paidCount: 1, currentEnd: new Date(Date.now() - 3600_000) });
  assert.ok((await syncSubscriptions()) >= 1); // the fake Razorpay says: active, one more month paid
  const after = await Subscription.findById(sub._id).lean();
  assert.ok(after.currentEnd > new Date(Date.now() + 20 * 86_400_000));
  await runBillingExpiry(new Date());
  assert.equal((await User.findById(u.id).lean()).planKey, key);
});

test('sync: a payment made but never confirmed by the browser still gives the plan', T, async () => {
  const key = await makePlan('sync2');
  const u = await newUser();
  await Subscription.create({ userId: u.id, planKey: key, interval: 'month', amount: 100, razorpaySubscriptionId: `sub_${tag}_sync2`, razorpayPlanId: 'p', status: 'created' });
  await syncSubscriptions();
  assert.equal((await User.findById(u.id).lean()).planKey, key);
});

const { outbox } = await import('../src/utils/systemMail.js');
const { Invoice, Counter } = models;
const { sendEndingReminders } = await import('../src/billing/service.js');

test('a payment gives one invoice and one email, even when told three times', T, async () => {
  const key = await makePlan('inv', { priceMonthly: 699 });
  const u = await newUser();
  await call('PUT', '/api/billing/profile', { token: u.token, json: { name: 'Asha Traders', address: 'Pune', state: 'Maharashtra', gstin: '27ABCDE1234F1Z5' } });
  const s = await call('POST', '/api/billing/subscribe', { token: u.token, json: { planKey: key, interval: 'month' } });
  const subId = s.body.subscriptionId;
  const proof = { razorpay_payment_id: 'pay_i1', razorpay_subscription_id: subId, razorpay_signature: hmac('fake_secret', `pay_i1|${subId}`) };
  await call('POST', '/api/billing/verify', { token: u.token, json: proof });
  await call('POST', '/api/billing/verify', { token: u.token, json: proof });
  await syncSubscriptions();
  assert.equal(await Invoice.countDocuments({ userId: u.id }), 1);
  const list = await call('GET', '/api/billing/invoices', { token: u.token });
  assert.equal(list.body.invoices.length, 1);
  const one = await call('GET', `/api/billing/invoices/${list.body.invoices[0].id}`, { token: u.token });
  assert.equal(one.status, 200, say(one));
  assert.match(one.body.invoice.number, /^RR\/\d{4}-\d{2}\/\d{5}$/);
  assert.equal(one.body.invoice.buyer.name, 'Asha Traders');
  assert.equal(one.body.invoice.total, 699);
  assert.equal(outbox.filter((m) => m.to === u.email && /Payment received/.test(m.subject)).length, 1);
  // someone else cannot open it
  const other = await newUser();
  assert.equal((await call('GET', `/api/billing/invoices/${list.body.invoices[0].id}`, { token: other.token })).status, 404);
  // numbers keep counting
  const n = (await Counter.findOne({ _id: /^invoice:/ }).sort({ seq: -1 }).lean())?.seq;
  assert.ok(n >= 1);
});

test('billing details are checked', T, async () => {
  const u = await newUser();
  assert.equal((await call('PUT', '/api/billing/profile', { token: u.token, json: { gstin: 'nonsense' } })).status, 400);
  const ok = await call('PUT', '/api/billing/profile', { token: u.token, json: { name: ' Me ', gstin: '' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.profile.name, 'Me');
});

test('the ending reminder is emailed once per period', T, async () => {
  const key = await makePlan('remind');
  const u = await newUser();
  await Subscription.create({ userId: u.id, planKey: key, interval: 'month', amount: 100, razorpaySubscriptionId: `sub_${tag}_rem`, razorpayPlanId: 'p', status: 'active', cancelAtCycleEnd: true, currentEnd: new Date(Date.now() + 2 * 86_400_000) });
  await sendEndingReminders();
  await sendEndingReminders();
  assert.equal(outbox.filter((m) => m.to === u.email && /ends on/.test(m.subject)).length, 1);
});

test('the refund policy page is public', T, async () => {
  const res = await fetch(`${base}/legal/refunds`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Refund and Cancellation Policy/);
});

test('the dashboard says whether the account has a contact list (for the getting-started checklist)', T, async () => {
  const u = await newUser();
  const before = await call('GET', '/api/dashboard', { token: u.token });
  assert.equal(before.body.hasList, false);
  await models.ContactList.create({ userId: u.id, name: 'L', kind: 'email' });
  const after = await call('GET', '/api/dashboard', { token: u.token });
  assert.equal(after.body.hasList, true);
  await models.ContactList.deleteMany({ userId: u.id });
});

test('admin billing: lists subscriptions and invoices, and refund notes cannot exceed what was paid', T, async () => {
  const admin = await newUser({ admin: true });
  const payer = await newUser();
  const other = await newUser();
  const sub = await Subscription.create({ userId: payer.id, planKey: 'pro', interval: 'month', amount: 69900, razorpaySubscriptionId: `${tag}_adm1`, razorpayPlanId: 'plan_x', status: 'active', paidCount: 1, currentEnd: new Date(Date.now() + 86_400_000) });
  await Subscription.create({ userId: other.id, planKey: 'premium', interval: 'year', amount: 1499000, razorpaySubscriptionId: `${tag}_adm2`, razorpayPlanId: 'plan_y', status: 'cancelled' });
  const inv = await models.Invoice.create({ userId: payer.id, key: `${tag}_adm1:1`, number: `T/${tag}/1`, planKey: 'pro', planName: 'Pro', interval: 'month', paymentId: 'pay_adm1', totalPaise: 69900, taxablePaise: 69900, buyer: { email: payer.email } });

  // only administrators
  assert.equal((await call('GET', '/api/admin/billing/subscriptions', { token: payer.token })).status, 403);
  assert.equal((await call('GET', '/api/admin/billing/summary')).status, 401);

  const subs = await call('GET', `/api/admin/billing/subscriptions?search=${encodeURIComponent(payer.email)}`, { token: admin.token });
  assert.equal(subs.status, 200, say(subs));
  assert.equal(subs.body.total, 1);
  assert.equal(subs.body.subscriptions[0].email, payer.email);
  assert.equal(subs.body.subscriptions[0].amount, 699);
  const live = await call('GET', `/api/admin/billing/subscriptions?status=live&search=${encodeURIComponent(other.email)}`, { token: admin.token });
  assert.equal(live.body.total, 0); // cancelled is not "live"
  assert.equal((await call('GET', '/api/admin/billing/subscriptions?status=bogus', { token: admin.token })).status, 400);

  const list = await call('GET', `/api/admin/billing/invoices?search=${encodeURIComponent(payer.email)}`, { token: admin.token });
  assert.equal(list.body.total, 1);
  assert.equal(list.body.invoices[0].refundable, 699);

  const refund = (body) => call('POST', `/api/admin/billing/invoices/${inv._id}/refund-note`, { token: admin.token, json: body });
  assert.equal((await refund({ amount: 0, reason: 'x' })).status, 400);
  assert.equal((await refund({ amount: 100 })).status, 400); // a reason is needed
  assert.equal((await refund({ amount: 700, reason: 'too much' })).status, 400);
  assert.equal((await call('POST', `/api/admin/billing/invoices/${inv._id}/refund-note`, { token: payer.token, json: { amount: 1, reason: 'me' } })).status, 403);

  const first = await refund({ amount: 200, reason: 'asked within 7 days' });
  assert.equal(first.status, 200, say(first));
  assert.match(first.body.note.number, /-CN\/\d{4}-\d{2}\/\d{5}$/);
  assert.equal(first.body.invoice.refundable, 499);
  assert.equal((await refund({ amount: 500, reason: 'again' })).status, 400); // only 499 left
  assert.equal((await refund({ amount: 499, reason: 'rest' })).status, 200);
  const full = await refund({ amount: 1, reason: 'nothing left' });
  assert.equal(full.status, 400);
  assert.match(full.body.error, /in full/);

  // the customer sees the notes on their invoice, and the list says how much came back
  const mine = await call('GET', `/api/billing/invoices/${inv._id}`, { token: payer.token });
  assert.equal(mine.body.invoice.creditNotes.length, 2);
  assert.equal((await call('GET', '/api/billing/invoices', { token: payer.token })).body.invoices[0].refunded, 699);

  const sum = await call('GET', '/api/admin/billing/summary', { token: admin.token });
  assert.equal(sum.status, 200);
  assert.ok(sum.body.payingAccounts >= 1 && sum.body.refunded >= 699);
  const audit = await call('GET', '/api/admin/audit?action=billing.refund_note', { token: admin.token });
  assert.ok(audit.body.entries.some((e) => e.target?.email === payer.email));
  await sub.deleteOne();
});
