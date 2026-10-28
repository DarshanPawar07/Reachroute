import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { config } from '../config.js';
import { SignupOtp, User } from '../models.js';
import { AuthToken } from '../models.js';
import { bad } from './http.js';

/**
 * The code a new account types in to prove it owns the email address. It is emailed together with the one-click link
 * (see routes/auth.js), 6 digits, valid 10 minutes, 5 tries per code.
 */
export const CODE_MINUTES = 10;
export const MAX_TRIES = 5;

const hashCode = (userId, code) => createHmac('sha256', config.jwtSecret).update(`signup|${userId}|${code}`).digest('hex');
const coded = (message, status, code, extra = {}) => Object.assign(bad(message, status), { code, ...extra });

/** Make a new code for the account (replacing any earlier one) and return it. Only its hash is kept. */
export async function issueSignupOtp(userId, now = Date.now()) {
  const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
  await SignupOtp.findOneAndUpdate(
    { userId },
    { $set: { codeHash: hashCode(userId, code), attempts: 0, sentAt: new Date(now), expiresAt: new Date(now + CODE_MINUTES * 60_000) } },
    { upsert: true }
  );
  return code;
}

/** Check the typed code. On success the account's email counts as confirmed. Wrong, expired and over-tried codes each say so. */
export async function verifySignupOtp(userId, rawCode, now = Date.now()) {
  const typed = String(rawCode ?? '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) throw coded('Enter the 6-digit code from the email.', 400, 'code_format');

  // The try is counted BEFORE the code is compared, so many parallel guesses cannot beat the limit.
  const otp = await SignupOtp.findOneAndUpdate({ userId, attempts: { $lt: MAX_TRIES }, expiresAt: { $gt: new Date(now) } }, { $inc: { attempts: 1 } }, { returnDocument: 'after' }).lean();
  if (!otp) {
    const any = await SignupOtp.findOne({ userId }).lean();
    if (!any || any.expiresAt.getTime() <= now) throw coded('That code has expired, or none was sent. Ask for a new one.', 400, 'code_expired');
    throw coded('Too many wrong codes. Ask for a new one.', 429, 'code_locked');
  }

  const right = Buffer.from(otp.codeHash, 'hex');
  const given = Buffer.from(hashCode(userId, typed), 'hex');
  if (right.length !== given.length || !timingSafeEqual(right, given)) {
    const left = MAX_TRIES - otp.attempts;
    if (left <= 0) throw coded('Too many wrong codes. Ask for a new one.', 429, 'code_locked');
    throw coded(`That code is not right. ${left} ${left === 1 ? 'try' : 'tries'} left.`, 400, 'code_wrong', { triesLeft: left });
  }

  await User.updateOne({ _id: userId }, { $set: { emailVerified: true, emailVerifiedAt: new Date(now) } });
  await Promise.all([SignupOtp.deleteOne({ userId }), AuthToken.deleteMany({ userId, type: 'verify' })]);
  return { verified: true };
}
