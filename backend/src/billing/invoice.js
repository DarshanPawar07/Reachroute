import { config } from '../config.js';
import { Counter, Invoice, Plan, User } from '../models.js';

/**
 * Invoices. Amounts are whole paise. Prices are GST-inclusive when GST_RATE is set:
 *   taxable = total * 100 / (100 + rate), tax = total - taxable.
 * Same state as the seller (or the buyer's state is unknown): half CGST and half SGST. A different state: IGST.
 * This is a sensible default, not tax advice: check the rate, the SAC code and the place-of-supply rules with your accountant.
 */

const GSTIN = /^\d{2}[A-Z]{5}\d{4}[A-Z][A-Z\d]Z[A-Z\d]$/;
export const isGstin = (v) => GSTIN.test(String(v || '').trim().toUpperCase());

/** { taxablePaise, cgstPaise, sgstPaise, igstPaise } for a payment of `totalPaise`. */
export function computeTax({ totalPaise, rate = 0, sellerState = '', buyerState = '' }) {
  if (!(rate > 0)) return { taxablePaise: totalPaise, cgstPaise: 0, sgstPaise: 0, igstPaise: 0 };
  const taxablePaise = Math.round((totalPaise * 100) / (100 + rate));
  const tax = totalPaise - taxablePaise;
  const norm = (s) => String(s || '').trim().toLowerCase();
  const inter = norm(buyerState) && norm(sellerState) && norm(buyerState) !== norm(sellerState);
  if (inter) return { taxablePaise, cgstPaise: 0, sgstPaise: 0, igstPaise: tax };
  const cgstPaise = Math.floor(tax / 2);
  return { taxablePaise, cgstPaise, sgstPaise: tax - cgstPaise, igstPaise: 0 };
}

/** "2026-27" for dates from April 2026 to March 2027 (India's financial year, in Indian time). */
export function financialYear(date = new Date()) {
  const ist = new Date(date.getTime() + 5.5 * 3600_000);
  const y = ist.getUTCFullYear();
  const start = ist.getUTCMonth() >= 3 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, '0')}`;
}

/**
 * The invoice for one payment of a subscription. Safe to call again for the same payment: it returns the existing invoice.
 * Returns { invoice, created }.
 */
export async function createInvoice(sub, { paymentId = '', amountPaise = sub.amount, now = new Date() } = {}) {
  const key = `${sub.razorpaySubscriptionId}:${sub.paidCount || 1}`;
  const have = await Invoice.findOne({ key }).lean();
  if (have) return { invoice: have, created: false };

  const [user, plan] = await Promise.all([User.findById(sub.userId).select('email billing').lean(), Plan.findOne({ key: sub.planKey }).select('name').lean()]);
  const inv = config.invoice;
  const buyer = { name: user?.billing?.name || '', email: user?.email || '', address: user?.billing?.address || '', state: user?.billing?.state || '', gstin: user?.billing?.gstin || '' };
  const tax = computeTax({ totalPaise: amountPaise, rate: inv.gstRate, sellerState: inv.sellerState, buyerState: buyer.state });
  const fy = financialYear(now);
  try {
    const c = await Counter.findOneAndUpdate({ _id: `invoice:${fy}` }, { $inc: { seq: 1 } }, { upsert: true, returnDocument: 'after' });
    const invoice = await Invoice.create({
      userId: sub.userId,
      key,
      number: `${inv.prefix}/${fy}/${String(c.seq).padStart(5, '0')}`,
      issuedAt: now,
      planKey: sub.planKey,
      planName: plan?.name || sub.planKey,
      interval: sub.interval,
      periodStart: sub.currentStart,
      periodEnd: sub.currentEnd,
      paymentId,
      gstRate: inv.gstRate,
      totalPaise: amountPaise,
      ...tax,
      seller: { name: inv.sellerName, address: inv.sellerAddress, state: inv.sellerState, gstin: inv.gstin, sac: inv.sac },
      buyer,
    });
    return { invoice: invoice.toObject(), created: true };
  } catch (err) {
    if (err.code === 11000) return { invoice: await Invoice.findOne({ key }).lean(), created: false }; // another instance made it first
    throw err;
  }
}
