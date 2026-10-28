import './env.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

const { verifyPaymentSignature, verifyWebhookSignature, toPaise } = await import('../src/billing/razorpay.js');
const { DEFAULT_PLANS } = await import('../src/plans/defaults.js');
const { readLimits } = await import('../src/plans/definitions.js');
const { applyRemote, addPeriod } = await import('../src/billing/service.js');

const hmac = (secret, data) => crypto.createHmac('sha256', secret).update(data).digest('hex');

test('payment signature: right one passes, wrong or missing fails', () => {
  const sig = hmac('sec', 'pay_1|sub_1');
  assert.equal(verifyPaymentSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: sig, secret: 'sec' }), true);
  assert.equal(verifyPaymentSignature({ paymentId: 'pay_2', subscriptionId: 'sub_1', signature: sig, secret: 'sec' }), false);
  assert.equal(verifyPaymentSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: 'abc', secret: 'sec' }), false);
  assert.equal(verifyPaymentSignature({ paymentId: 'pay_1', subscriptionId: 'sub_1', signature: sig, secret: '' }), false);
});

test('webhook signature is checked against the exact bytes', () => {
  const body = Buffer.from('{"event":"subscription.charged"}');
  const sig = hmac('whsec', body);
  assert.equal(verifyWebhookSignature(body, sig, 'whsec'), true);
  assert.equal(verifyWebhookSignature(Buffer.from('{"event":"subscription.charged" }'), sig, 'whsec'), false);
  assert.equal(verifyWebhookSignature(body, sig, ''), false);
});

test('rupees become paise without float errors', () => {
  assert.equal(toPaise(699), 69900);
  assert.equal(toPaise(14990), 1499000);
});

test('the starting plans pass the same checks as limits typed into the admin screen', () => {
  const keys = DEFAULT_PLANS.map((p) => p.key);
  assert.deepEqual(keys, ['free', 'pro', 'premium']);
  for (const p of DEFAULT_PLANS) assert.doesNotThrow(() => readLimits(p.limits), p.key);
  const [free, pro, premium] = DEFAULT_PLANS;
  assert.equal(free.limits.waLifetimeCap, 50);
  assert.equal(free.limits.emailLifetimeCap, 100);
  assert.equal(pro.priceMonthly, 699);
  assert.equal(pro.priceYearly, 6990);
  assert.equal(premium.priceMonthly, 1499);
  assert.equal(premium.priceYearly, 14990);
  assert.equal(pro.limits.monthlyCap, 5000);
  assert.equal(premium.limits.monthlyCap, 20000);
  assert.equal(pro.limits.waHourlyCap, 40);
  assert.equal(premium.limits.waDailyCap, 500);
});

test('applyRemote copies dates and counts, and a confirmed payment makes it active', () => {
  const sub = { status: 'created', interval: 'month', currentStart: null, currentEnd: null, paidCount: 0 };
  applyRemote(sub, { status: 'authenticated', paid_count: 1, current_start: 1_800_000_000, current_end: 1_802_592_000 }, { paid: true });
  assert.equal(sub.status, 'active');
  assert.equal(sub.paidCount, 1);
  assert.equal(sub.currentEnd.getTime(), 1_802_592_000_000);
  const bare = { status: 'created', interval: 'year', currentStart: null, currentEnd: null };
  applyRemote(bare, { status: 'active' });
  assert.ok(bare.currentEnd > new Date(Date.now() + 360 * 86_400_000));
  assert.ok(addPeriod(new Date(0), 'month').getTime() >= 30 * 86_400_000);
});

const { computeTax, financialYear, isGstin } = await import('../src/billing/invoice.js');

test('no GST rate: the whole payment is the invoice value', () => {
  assert.deepEqual(computeTax({ totalPaise: 69900, rate: 0 }), { taxablePaise: 69900, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
});

test('GST included in the price: same state splits into CGST and SGST, another state is IGST, and it always adds up', () => {
  const same = computeTax({ totalPaise: 69900, rate: 18, sellerState: 'Maharashtra', buyerState: 'maharashtra' });
  assert.equal(same.igstPaise, 0);
  assert.equal(same.taxablePaise + same.cgstPaise + same.sgstPaise, 69900);
  assert.equal(same.taxablePaise, 59237);
  const other = computeTax({ totalPaise: 69900, rate: 18, sellerState: 'Maharashtra', buyerState: 'Karnataka' });
  assert.equal(other.cgstPaise + other.sgstPaise, 0);
  assert.equal(other.taxablePaise + other.igstPaise, 69900);
  const unknown = computeTax({ totalPaise: 69900, rate: 18, sellerState: 'Maharashtra', buyerState: '' });
  assert.equal(unknown.igstPaise, 0); // buyer state unknown: treated as same state
});

test('financial year runs April to March, in Indian time', () => {
  assert.equal(financialYear(new Date('2026-10-27T10:00:00Z')), '2026-27');
  assert.equal(financialYear(new Date('2027-03-31T10:00:00Z')), '2026-27');
  assert.equal(financialYear(new Date('2027-03-31T19:00:00Z')), '2027-28'); // already 1 April in India
  assert.equal(financialYear(new Date('2026-04-01T00:00:00Z')), '2026-27');
});

test('GSTIN format', () => {
  assert.equal(isGstin('27ABCDE1234F1Z5'), true);
  assert.equal(isGstin('27abcde1234f1z5'), true);
  assert.equal(isGstin('1234'), false);
  assert.equal(isGstin(''), false);
});

test('the refund policy and the payment terms exist and are public', async () => {
  const { getDocument, PAGE_DOCS, DOC_NAMES, renderHtml } = await import('../src/legal/documents.js');
  assert.ok(PAGE_DOCS.includes('refunds'));
  assert.ok(!DOC_NAMES.includes('refunds'), 'nobody has to accept the refund policy');
  assert.match(renderHtml(getDocument('refunds')), /Refund and Cancellation Policy/);
  assert.ok(getDocument('terms').sections.some((s) => /Payments and subscriptions/.test(s.heading)));
});
