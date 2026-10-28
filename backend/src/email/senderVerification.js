import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { record } from '../audit/audit.js';
import { config } from '../config.js';
import { RateBucket, SenderOtp, SmtpSettings } from '../models.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { sendSystemEmail } from '../utils/systemMail.js';
import { invalidateSender } from './mailer.js';

const log = logger.child({ mod: 'senderVerify' });

/**
 * Before a person sends email "from" an address, they prove they can read mail there: we email a 6-digit code to that address
 * (through the platform's own mail server, never through the SMTP settings they typed, which they control) and they enter it.
 */
export const CODE_MINUTES = 10;
export const RESEND_SECONDS = 60;
export const MAX_TRIES = 5;
const HOUR = 60 * 60_000;
const MAX_CODES_PER_HOUR = 5; // per account, and separately per address (so nobody's inbox can be flooded)

const hashCode = (userId, email, code) => createHmac('sha256', config.jwtSecret).update(`${userId}|${email}|${code}`).digest('hex');

/** Count one event for `key`; false once it happened more than `max` times in the window. */
async function allow(key, max, windowMs, now) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await RateBucket.updateOne({ _id: key, resetAt: { $lte: new Date(now) } }, { $set: { count: 0, resetAt: new Date(now + windowMs) } });
      const bucket = await RateBucket.findOneAndUpdate(
        { _id: key },
        { $inc: { count: 1 }, $setOnInsert: { resetAt: new Date(now + windowMs) } },
        { upsert: true, returnDocument: 'after' }
      ).lean();
      return bucket.count <= max;
    } catch (err) {
      if (err.code !== 11000) throw err; // two first events at once: try again
    }
  }
  return false;
}

/** Where this account stands: which address is set, whether it is proven, and whether a code is waiting. */
export async function senderStatus(userId, { now = Date.now() } = {}) {
  const [s, otp] = await Promise.all([SmtpSettings.findOne({ userId }).select('fromEmail verifiedEmail verifiedAt').lean(), SenderOtp.findOne({ userId }).lean()]);
  if (!s) return { mode: config.platformSmtp ? 'platform' : 'none', email: null, verified: false, needsVerification: false, verifiedAt: null, code: null };
  const verified = Boolean(s.verifiedEmail) && s.verifiedEmail === s.fromEmail;
  const waiting = otp && otp.email === s.fromEmail && otp.expiresAt.getTime() > now ? otp : null;
  return {
    mode: 'own',
    email: s.fromEmail,
    verified,
    needsVerification: !verified,
    verifiedAt: verified ? s.verifiedAt : null,
    code: waiting
      ? { sentTo: waiting.email, expiresAt: waiting.expiresAt, resendAfterSeconds: Math.max(0, RESEND_SECONDS - Math.floor((now - waiting.sentAt.getTime()) / 1000)), triesLeft: Math.max(0, MAX_TRIES - waiting.attempts) }
      : null,
  };
}

/** Email a new code to the account's "from" address. */
export async function sendSenderCode(userId, { now = Date.now() } = {}) {
  const s = await SmtpSettings.findOne({ userId }).select('fromEmail verifiedEmail').lean();
  if (!s) throw bad('Save your email settings first.', 409);
  const email = s.fromEmail;
  if (s.verifiedEmail === email) return { alreadyVerified: true, email };
  if (!config.platformSmtp && config.isProd) throw bad('We cannot send verification codes right now. Please try again later.', 503);

  const last = await SenderOtp.findOne({ userId }).lean();
  if (last && last.email === email) {
    const wait = RESEND_SECONDS - Math.floor((now - last.sentAt.getTime()) / 1000);
    if (wait > 0) throw bad(`Wait ${wait} second${wait === 1 ? '' : 's'} before asking for another code.`, 429);
  }
  if (!(await allow(`otp:user:${userId}`, MAX_CODES_PER_HOUR, HOUR, now))) throw bad('Too many codes requested. Try again in an hour.', 429);
  if (!(await allow(`otp:addr:${email}`, MAX_CODES_PER_HOUR, HOUR, now))) throw bad('Too many codes were sent to that address recently. Try again later.', 429);

  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await SenderOtp.findOneAndUpdate(
    { userId },
    { $set: { email, codeHash: hashCode(userId, email, code), attempts: 0, sentAt: new Date(now), expiresAt: new Date(now + CODE_MINUTES * 60_000) } },
    { upsert: true }
  );
  let delivery;
  try {
    delivery = await sendSystemEmail({
      to: email,
      subject: `${code} is your Reachroute verification code`,
      text:
        `Your verification code is ${code}\n\nIt works for ${CODE_MINUTES} minutes. Enter it in Reachroute to use ${email} as a sender.\n` +
        'If you did not ask for this, ignore this email: nothing happens without the code.',
    });
  } catch (err) {
    await SenderOtp.deleteOne({ userId });
    log.warn({ err: err.message, userId: String(userId) }, 'could not email the sender code');
    throw bad('We could not send the code to that address. Check that it is correct and try again.', 503);
  }
  await record({ actorId: userId, action: 'smtp.otp_sent', detail: email });
  return { sent: true, emailSent: delivery?.sent !== false, email, expiresInMinutes: CODE_MINUTES, resendAfterSeconds: RESEND_SECONDS };
}

/** Check the code. On success the "from" address counts as proven and sending is allowed. */
export async function verifySenderCode(userId, code, { now = Date.now() } = {}) {
  const typed = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) throw bad('Enter the 6-digit code from the email.');

  // The try is counted BEFORE the code is compared, so many parallel guesses cannot beat the limit.
  const otp = await SenderOtp.findOneAndUpdate(
    { userId, attempts: { $lt: MAX_TRIES }, expiresAt: { $gt: new Date(now) } },
    { $inc: { attempts: 1 } },
    { returnDocument: 'after' }
  ).lean();
  if (!otp) {
    const any = await SenderOtp.findOne({ userId }).lean();
    if (!any || any.expiresAt.getTime() <= now) throw bad('That code has expired, or none was asked for. Ask for a new one.');
    throw bad('Too many wrong codes. Ask for a new one.', 429);
  }

  const s = await SmtpSettings.findOne({ userId }).select('fromEmail').lean();
  if (!s || s.fromEmail !== otp.email) {
    await SenderOtp.deleteOne({ userId });
    throw bad('Your "from" address changed after the code was sent. Ask for a new code.', 409);
  }

  const right = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hashCode(userId, otp.email, typed), 'hex');
  if (right.length !== given.length || !timingSafeEqual(right, given)) {
    const left = MAX_TRIES - otp.attempts;
    if (left <= 0) throw bad('Too many wrong codes. Ask for a new one.', 429);
    throw bad(`That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`);
  }

  await SmtpSettings.updateOne({ userId, fromEmail: otp.email }, { $set: { verifiedEmail: otp.email, verifiedAt: new Date(now) } });
  await SenderOtp.deleteOne({ userId });
  invalidateSender(userId);
  await record({ actorId: userId, action: 'smtp.sender_verified', detail: otp.email });
  return { verified: true, email: otp.email };
}
