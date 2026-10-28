import { config } from '../config.js';
import { User } from '../models.js';
import { logger } from '../utils/logger.js';
import { sendSystemEmail } from '../utils/systemMail.js';

const log = logger.child({ mod: 'billing-mail' });
const rupees = (paise) => `Rs ${(paise / 100).toLocaleString('en-IN', { minimumFractionDigits: paise % 100 ? 2 : 0 })}`;
const day = (d) => new Date(d).toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
const sign = `\n\nReachroute\n${config.legalContactEmail ? `Questions? Write to ${config.legalContactEmail}.` : ''}`.trimEnd();

async function send(userId, subject, body) {
  try {
    const user = await User.findById(userId).select('email').lean();
    if (!user) return;
    await sendSystemEmail({ to: user.email, subject, text: `${body}${sign}` });
  } catch (err) {
    log.warn({ err: err.message, subject }, 'could not send a billing email'); // an email problem must never undo a payment
  }
}

export const emailPaymentReceived = (userId, { invoice, planName }) =>
  send(userId, `Payment received: ${planName} plan`, `Thank you. We received ${rupees(invoice.totalPaise)} for the ${planName} plan (${invoice.interval === 'year' ? 'yearly' : 'monthly'}).\n\nInvoice ${invoice.number}${invoice.periodEnd ? `\nPaid until ${day(invoice.periodEnd)}` : ''}\n\nOpen your invoice: ${config.appUrl}/invoice/${invoice._id}\nManage your plan: ${config.appUrl}/billing`);

export const emailPaymentFailed = (userId, { planName, halted }) =>
  send(userId, halted ? `Your ${planName} subscription is on hold` : `Your ${planName} payment did not go through`, halted
    ? `Payments for your ${planName} plan failed several times, so the subscription is on hold. Subscribe again to keep your limits:\n${config.appUrl}/billing`
    : `We could not take the payment for your ${planName} plan. Razorpay will try again. Please make sure your card, UPI or bank mandate is ready.\n${config.appUrl}/billing`);

export const emailPlanEnding = (userId, { planName, endsAt, cancelled }) =>
  send(userId, `Your ${planName} plan ends on ${day(endsAt)}`, cancelled
    ? `You cancelled your ${planName} plan, so it ends on ${day(endsAt)} and your account then moves back to the free limits. Changed your mind? Subscribe again any time:\n${config.appUrl}/billing`
    : `The latest payment for your ${planName} plan has not gone through, and the plan ends on ${day(endsAt)} unless it does. Check your payment method:\n${config.appUrl}/billing`);

export const emailPlanEnded = (userId, { planName, payment }) =>
  send(userId, `Your ${planName} plan has ended`, `${payment ? 'The last payment did not go through, so your' : 'Your'} ${planName} plan has ended and your account is back on the free limits. Subscribe again to get your limits back:\n${config.appUrl}/billing`);
