import { config } from '../config.js';
import { financialYear } from '../billing/invoice.js';
import { Counter, Invoice, Subscription, User } from '../models.js';
import { bad } from '../utils/http.js';

/** What an administrator sees of payments: who pays, what was invoiced, and refund notes. Card details never reach us. */

const LIVE = ['authenticated', 'active', 'pending', 'halted'];
const STATUSES = new Set(['', 'live', 'created', 'authenticated', 'active', 'pending', 'halted', 'cancelled', 'completed', 'expired']);
const MAX_REASON = 300;
const escapeRegex = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const paging = ({ page, limit }) => {
  const size = Math.min(100, Math.max(1, Number(limit) || 25));
  return { size, pageNo: Math.max(1, Math.floor(Number(page)) || 1) };
};
const one = (name, v) => {
  if (v !== undefined && typeof v !== 'string') throw bad(`${name} can be given only once`);
  return String(v ?? '').trim();
};
const refundedPaise = (i) => (i.creditNotes || []).reduce((sum, c) => sum + (c.amountPaise || 0), 0);

/** Ids of accounts whose email contains `text` (at most 500, enough for an admin search). */
async function userIdsByEmail(text) {
  const rows = await User.find({ email: { $regex: escapeRegex(text.toLowerCase()) } }).select('_id').limit(500).lean();
  return rows.map((u) => u._id);
}

export async function billingSummary() {
  const [live, subs] = await Promise.all([
    Subscription.find({ status: { $in: ['active', 'authenticated'] }, endedAt: null }).select('interval amount cancelAtCycleEnd').lean(),
    Invoice.find({}).select('totalPaise creditNotes').lean(),
  ]);
  const monthly = live.filter((s) => !s.cancelAtCycleEnd).reduce((sum, s) => sum + (s.interval === 'year' ? s.amount / 12 : s.amount), 0);
  const collected = subs.reduce((sum, i) => sum + i.totalPaise, 0);
  const refunded = subs.reduce((sum, i) => sum + refundedPaise(i), 0);
  return {
    payingAccounts: live.length,
    renewingAccounts: live.filter((s) => !s.cancelAtCycleEnd).length,
    monthlyRecurring: Math.round(monthly) / 100, // rupees a month that will keep coming if nobody cancels
    invoices: subs.length,
    collected: collected / 100,
    refunded: refunded / 100,
  };
}

export async function listSubscriptions(query = {}) {
  const search = one('search', query.search);
  const status = one('status', query.status);
  const plan = one('plan', query.plan);
  if (search.length > 100) throw bad('That search is too long');
  if (!STATUSES.has(status)) throw bad('That status is not one of the subscription statuses');
  const { size, pageNo } = paging(query);
  const filter = {};
  if (status === 'live') filter.status = { $in: LIVE };
  else if (status) filter.status = status;
  if (plan) filter.planKey = plan;
  if (search) filter.userId = { $in: await userIdsByEmail(search) };

  const [total, rows] = await Promise.all([
    Subscription.countDocuments(filter).maxTimeMS(5000),
    Subscription.find(filter).sort({ createdAt: -1, _id: -1 }).skip((pageNo - 1) * size).limit(size).maxTimeMS(5000).lean(),
  ]);
  const users = await User.find({ _id: { $in: rows.map((r) => r.userId) } }).select('email').lean();
  const email = new Map(users.map((u) => [String(u._id), u.email]));
  return {
    subscriptions: rows.map((s) => ({
      id: s._id, userId: s.userId, email: email.get(String(s.userId)) || '(deleted account)', planKey: s.planKey, interval: s.interval, amount: s.amount / 100,
      status: s.status, paidCount: s.paidCount, currentEnd: s.currentEnd, cancelAtCycleEnd: s.cancelAtCycleEnd, createdAt: s.createdAt, razorpayId: s.razorpaySubscriptionId,
    })),
    total, page: pageNo, pages: Math.max(1, Math.ceil(total / size)),
  };
}

export async function listInvoices(query = {}) {
  const search = one('search', query.search);
  const plan = one('plan', query.plan);
  const refunded = one('refunded', query.refunded);
  if (search.length > 100) throw bad('That search is too long');
  if (!['', 'yes', 'no'].includes(refunded)) throw bad('Refunded must be yes or no');
  const { size, pageNo } = paging(query);
  const filter = {};
  if (plan) filter.planKey = plan;
  if (refunded === 'yes') filter['creditNotes.0'] = { $exists: true };
  if (refunded === 'no') filter['creditNotes.0'] = { $exists: false };
  if (search) {
    const re = { $regex: escapeRegex(search) };
    filter.$or = [{ number: re }, { 'buyer.email': { $regex: escapeRegex(search.toLowerCase()) } }, { paymentId: re }];
  }
  const [total, rows] = await Promise.all([
    Invoice.countDocuments(filter).maxTimeMS(5000),
    Invoice.find(filter).sort({ issuedAt: -1, _id: -1 }).skip((pageNo - 1) * size).limit(size).maxTimeMS(5000).lean(),
  ]);
  return { invoices: rows.map(invoiceRow), total, page: pageNo, pages: Math.max(1, Math.ceil(total / size)) };
}

function invoiceRow(i) {
  const refunded = refundedPaise(i);
  return {
    id: i._id, userId: i.userId, number: i.number, issuedAt: i.issuedAt, email: i.buyer?.email || '', planName: i.planName, interval: i.interval,
    paymentId: i.paymentId, total: i.totalPaise / 100, refunded: refunded / 100, refundable: (i.totalPaise - refunded) / 100,
    creditNotes: (i.creditNotes || []).map((c) => ({ id: c._id, number: c.number, amount: c.amountPaise / 100, reason: c.reason, issuedAt: c.issuedAt, byEmail: c.byEmail })),
  };
}

/**
 * Write a refund note against an invoice. `amount` is in rupees; it can be part of the payment, and the notes together
 * can never be more than what was paid. This only records the refund: send the money back from the Razorpay dashboard.
 */
export async function issueCreditNote(invoiceId, { amount, reason } = {}, adminEmail = '') {
  const rupees = Number(amount);
  if (!Number.isFinite(rupees) || rupees <= 0) throw bad('Enter the amount to refund, in rupees');
  const paise = Math.round(rupees * 100);
  if (Math.abs(rupees * 100 - paise) > 1e-6) throw bad('The amount can have at most two decimal places');
  if (typeof reason !== 'string' || !reason.trim()) throw bad('Give a reason for the refund');
  const text = reason.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (text.length > MAX_REASON) throw bad(`The reason is too long (most ${MAX_REASON} characters)`);

  const inv = await Invoice.findById(invoiceId).lean();
  if (!inv) throw bad('Invoice not found', 404);
  const left = inv.totalPaise - refundedPaise(inv);
  if (paise > left) throw bad(left > 0 ? `You can refund at most ₹${left / 100} more on this invoice` : 'This invoice has already been refunded in full');

  const fy = financialYear(new Date());
  const c = await Counter.findOneAndUpdate({ _id: `creditnote:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
  const note = { number: `${config.invoice.prefix}-CN/${fy}/${String(c.seq).padStart(5, '0')}`, amountPaise: paise, reason: text, issuedAt: new Date(), byEmail: adminEmail };
  // The amount check is repeated in the update, so two admins clicking at once cannot refund more than was paid.
  const updated = await Invoice.findOneAndUpdate(
    { _id: invoiceId, $expr: { $lte: [{ $add: [{ $sum: '$creditNotes.amountPaise' }, paise] }, '$totalPaise'] } },
    { $push: { creditNotes: note } },
    { returnDocument: 'after' }
  ).lean();
  if (!updated) throw bad('This invoice was refunded just now. Reload and check what is left.', 409);
  return { invoice: invoiceRow(updated), note, email: inv.buyer?.email || '', userId: inv.userId };
}
