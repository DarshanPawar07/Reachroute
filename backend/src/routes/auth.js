import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { fromReq, record } from '../audit/audit.js';
import { config } from '../config.js';
import { forgetUser, requireAuth, signToken } from '../middleware/auth.js';
import { recordAcceptance } from '../legal/consent.js';
import { User } from '../models.js';
import { consumeToken, isVerified, issueToken, recentlyIssued } from '../utils/authTokens.js';
import { normalizeEmail } from '../utils/contacts.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { sendSystemEmail } from '../utils/systemMail.js';

const log = logger.child({ mod: 'auth' });

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 8; // after this many wrong passwords in a row the account is locked briefly
const LOCK_MS = 15 * 60_000;
const EMAIL_COOLDOWN_MS = 60_000; // one reset / verification email per minute per account

// Compared against when the email is unknown, so a login for a missing account takes as long as a real one
// and response time does not reveal which emails are registered.
const dummyHash = bcrypt.hash(randomUUID(), BCRYPT_COST);

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  // bcrypt only reads the first 72 bytes. Refuse longer ones instead of silently ignoring the rest.
  if (Buffer.byteLength(password, 'utf8') > 72) throw bad('Password is too long (the limit is 72 bytes)');
}

const present = (user) => ({ id: user._id, email: user.email, emailVerified: isVerified(user) });
const session = (user) => ({ token: signToken(user), user: present(user) });

/** Run something after the response was sent. A failure is logged, never shown to the person. */
const inBackground = (promise, what) => promise.catch((err) => log.warn({ err: err.message }, `could not ${what}`));

/** Email a one-time link: type 'verify' (confirm the address) or 'reset' (choose a new password). */
async function emailLink(user, type) {
  const token = await issueToken(user._id, type);
  const isReset = type === 'reset';
  const url = `${config.appUrl}/${isReset ? 'reset-password' : 'verify-email'}?token=${token}`;
  return sendSystemEmail({
    to: user.email,
    subject: isReset ? 'Reset your Bulk Messenger password' : 'Confirm your email address',
    text: isReset
      ? `Someone asked to reset the password for this account. To choose a new password, open:\n\n${url}\n\nThe link works once and expires in 1 hour.\nIf this was not you, ignore this email: your password stays the same.`
      : `Welcome to Bulk Messenger. Please confirm your email address:\n\n${url}\n\nThe link works once and expires in 24 hours.\nIf you did not create this account, ignore this email.`,
  });
}

/** `limiters` = { login, register, passwordReset, accountToken, resendVerification, changePassword } (all optional). */
export function authRouter({ login: loginLimiter, register: registerLimiter, passwordReset, accountToken, resendVerification, changePassword: changePasswordLimiter } = {}) {
  const router = Router();
  const use = (limiter) => (limiter ? [limiter] : []);

  router.post('/register', ...use(registerLimiter), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw bad('Enter a valid email address');
    checkPassword(req.body?.password);
    const accepted = req.body?.acceptTerms === true;
    if (config.requireTermsAcceptance && !accepted) throw bad('Please accept the Terms of Service and Privacy Policy to create an account');
    if (await User.exists({ email })) throw bad('That email is already registered', 409);

    const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    let user;
    try {
      user = await User.create({ email, passwordHash, emailVerified: false });
    } catch (err) {
      if (err.code === 11000) throw bad('That email is already registered', 409); // two sign-ups at once
      throw err;
    }
    if (accepted) {
      // If this fails the account still exists; it will be asked to accept before its first campaign.
      await recordAcceptance(user._id, { via: 'register', ip: req.ip, userAgent: req.get('user-agent') }).catch((err) => log.error({ err: err.message, userId: String(user._id) }, 'could not record acceptance'));
    }
    inBackground(emailLink(user, 'verify'), 'send the verification email');
    res.status(201).json(session(user));
  });

  router.post('/login', ...use(loginLimiter), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    const password = req.body?.password;
    const invalid = () => bad('Invalid email or password', 401);
    if (!email || typeof password !== 'string' || password.length > 1024) throw invalid();

    const user = await User.findOne({ email });
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw bad(`Too many failed attempts. Try again in ${mins} minute${mins === 1 ? '' : 's'}.`, 429);
    }

    const matches = await bcrypt.compare(password, user ? user.passwordHash : await dummyHash);
    if (!user || !matches) {
      if (user) {
        const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { returnDocument: 'after' });
        if (updated && updated.failedLogins >= MAX_FAILED_LOGINS) {
          await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MS), failedLogins: 0 } });
          await record({ ip: req.ip, requestId: req.id, actorId: user._id, actorEmail: user.email, action: 'login.locked', detail: `after ${MAX_FAILED_LOGINS} wrong passwords` });
        }
      }
      throw invalid();
    }

    // Said only after the password was right, so nobody can find out who is suspended by guessing emails.
    if (user.suspendedAt) {
      await record({ ip: req.ip, requestId: req.id, actorId: user._id, actorEmail: user.email, action: 'login.blocked', detail: 'account is suspended' });
      throw bad('This account has been suspended. Please contact support.', 403);
    }

    await User.updateOne({ _id: user._id }, { $set: { failedLogins: 0, lockedUntil: null, lastLoginAt: new Date() } });
    res.json(session(user));
  });

  // The logged-in person: used by the app to show the "confirm your email" banner.
  router.get('/me', requireAuth, async (req, res) => {
    const user = await User.findById(req.userId).select('email emailVerified role').lean();
    if (!user) throw bad('Please log in', 401);
    res.json({ user: { ...present(user), role: user.role || 'user' }, verificationRequired: config.requireEmailVerification });
  });

  // ---------------------------------------------------------------- signing out and changing the password

  // Sign out of every device. This device gets a fresh login token so it stays signed in.
  router.post('/logout-all', requireAuth, async (req, res) => {
    const user = await User.findByIdAndUpdate(req.userId, { $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
    if (!user) throw bad('Please log in', 401);
    forgetUser(user._id);
    await record({ ...fromReq(req), actorEmail: user.email, action: 'logout.all' });
    res.json(session(user));
  });

  // Needs the current password, so someone who finds a logged-in browser cannot lock the owner out.
  // Signs out every other device and gives this one a fresh token.
  router.post('/change-password', requireAuth, ...use(changePasswordLimiter), async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    checkPassword(newPassword);
    const user = await User.findById(req.userId);
    if (!user) throw bad('Please log in', 401);
    // 400, not 401: the app treats 401 as "your login expired" and would sign the person out.
    if (typeof currentPassword !== 'string' || currentPassword.length > 1024 || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw bad('Your current password is not right');
    }
    if (newPassword === currentPassword) throw bad('Choose a password that is different from the current one');

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_COST);
    const updated = await User.findByIdAndUpdate(user._id, { $set: { passwordHash }, $inc: { tokenVersion: 1 } }, { returnDocument: 'after' });
    forgetUser(user._id);
    await record({ ...fromReq(req), actorEmail: user.email, action: 'password.changed' });
    inBackground(
      sendSystemEmail({
        to: user.email,
        subject: 'Your Bulk Messenger password was changed',
        text: 'The password for this account was just changed, and every other device was signed out.\nIf this was not you, reset your password again right away.',
      }),
      'send the password-changed notice'
    );
    res.json(session(updated));
  });

  // ---------------------------------------------------------------- forgot / reset password

  // Always answers the same way, so nobody can use this form to find out which emails have an account.
  // The answer is sent first and the email afterwards, so the response time does not give it away either.
  router.post('/forgot-password', ...use(passwordReset), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw bad('Enter a valid email address');
    res.json({ ok: true, message: 'If an account exists for that email, a reset link is on its way. It works for 1 hour.' });

    inBackground(
      (async () => {
        const user = await User.findOne({ email }).select('email').lean();
        if (!user || (await recentlyIssued(user._id, 'reset', EMAIL_COOLDOWN_MS))) return;
        await emailLink(user, 'reset');
      })(),
      'send the reset email'
    );
  });

  router.post('/reset-password', ...use(accountToken), async (req, res) => {
    checkPassword(req.body?.password); // checked first, so a too-short password does not use up the link
    const token = await consumeToken(req.body?.token, 'reset');
    if (!token) throw bad('This reset link is invalid or has expired. Please ask for a new one.');

    const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    // Opening the emailed link proves they own the address, so the account counts as verified too.
    const user = await User.findByIdAndUpdate(
      token.userId,
      { $set: { passwordHash, failedLogins: 0, lockedUntil: null, emailVerified: true }, $inc: { tokenVersion: 1 } }, // $inc signs out every device
      { returnDocument: 'after' }
    );
    if (!user) throw bad('This reset link is invalid or has expired. Please ask for a new one.');
    forgetUser(user._id);
    await record({ ip: req.ip, requestId: req.id, actorId: user._id, actorEmail: user.email, action: 'password.reset', detail: 'through the emailed link' });

    inBackground(
      sendSystemEmail({
        to: user.email,
        subject: 'Your Bulk Messenger password was changed',
        text: 'The password for this account was just changed.\nIf this was you, there is nothing to do. If it was not, reset your password again right away.',
      }),
      'send the password-changed notice'
    );
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------- email verification

  // Works from the emailed link without being logged in (the link may open in another browser).
  router.post('/verify-email', ...use(accountToken), async (req, res) => {
    const token = await consumeToken(req.body?.token, 'verify');
    if (!token) throw bad('This link is invalid or has expired. If you already confirmed your email, just log in. Otherwise log in and ask for a new link.');
    await User.updateOne({ _id: token.userId }, { $set: { emailVerified: true, emailVerifiedAt: new Date() } });
    res.json({ ok: true });
  });

  router.post('/resend-verification', requireAuth, ...use(resendVerification), async (req, res) => {
    const user = await User.findById(req.userId).select('email emailVerified').lean();
    if (!user) throw bad('Please log in', 401);
    if (isVerified(user)) return res.json({ ok: true, alreadyVerified: true });
    if (await recentlyIssued(user._id, 'verify', EMAIL_COOLDOWN_MS)) throw bad('We just sent one. Please wait a minute before asking for another.', 429);

    let result;
    try {
      result = await emailLink(user, 'verify');
    } catch (err) {
      log.warn({ err: err.message }, 'could not send the verification email');
      throw bad('Could not send the email right now. Please try again later.', 502);
    }
    res.json({ ok: true, emailSent: result.sent });
  });

  return router;
}
