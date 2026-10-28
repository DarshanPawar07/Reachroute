import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { fromReq, record } from '../audit/audit.js';
import { config } from '../config.js';
import { forgetUser, requireAuth, signToken } from '../middleware/auth.js';
import { recordAcceptance } from '../legal/consent.js';
import { User } from '../models.js';
import { consumeToken, isVerified, issueToken, recentlyIssued } from '../utils/authTokens.js';
import { CODE_MINUTES, issueSignupOtp, verifySignupOtp } from '../utils/signupOtp.js';
import { normalizeEmail } from '../utils/contacts.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { sendSystemEmail } from '../utils/systemMail.js';

const log = logger.child({ mod: 'auth' });

const BCRYPT_COST = 12;
const MAX_FAILED_LOGINS = 8; // after this many wrong passwords in a row the account is locked briefly
const LOCK_MS = 15 * 60_000;
const EMAIL_COOLDOWN_MS = 60_000; // one reset / verification email per minute per account

function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 8) throw bad('Password must be at least 8 characters');
  // bcrypt only reads the first 72 bytes. Refuse longer ones instead of silently ignoring the rest.
  if (Buffer.byteLength(password, 'utf8') > 72) throw bad('Password is too long (the limit is 72 bytes)');
}

/** An error the web app can recognise by its `code` and show in the right place. */
const coded = (message, status, code) => Object.assign(bad(message, status), { code });

const present = (user) => ({ id: user._id, email: user.email, emailVerified: isVerified(user) });
const session = (user) => ({ token: signToken(user), user: present(user) });

/** Run something after the response was sent. A failure is logged, never shown to the person. */
const inBackground = (promise, what) => promise.catch((err) => log.warn({ err: err.message }, `could not ${what}`));

/**
 * Email a one-time link: type 'verify' (confirm the address) or 'reset' (choose a new password).
 * The 'verify' email also carries a 6-digit code: people type it on the sign-up page, or click the link instead.
 */
async function emailLink(user, type) {
  const token = await issueToken(user._id, type);
  const isReset = type === 'reset';
  const url = `${config.appUrl}/${isReset ? 'reset-password' : 'verify-email'}?token=${token}`;
  if (isReset) {
    return sendSystemEmail({
      to: user.email,
      subject: 'Reset your Reachroute password',
      text: `Someone asked to reset the password for this account. To choose a new password, open:\n\n${url}\n\nThe link works once and expires in 1 hour.\nIf this was not you, ignore this email: your password stays the same.`,
    });
  }
  const code = await issueSignupOtp(user._id);
  return sendSystemEmail({
    to: user.email,
    subject: 'Confirm your email address',
    text:
      `Your Reachroute verification code is ${code}\n\nType it on the sign-up page. It works for ${CODE_MINUTES} minutes.\n\n` +
      `You can also confirm with one click instead (the link works once and expires in 24 hours):\n${url}\n\n` +
      'If you did not create this account, ignore this email.',
  });
}

const providerNames = (user) => (user.oauth || []).map((o) => (o.provider === 'github' ? 'GitHub' : 'Google'));

/** `limiters` = { login, register, passwordReset, accountToken, resendVerification, changePassword } (all optional). */
export function authRouter({ login: loginLimiter, register: registerLimiter, passwordReset, accountToken, resendVerification, changePassword: changePasswordLimiter, signupOtp } = {}) {
  const router = Router();
  const use = (limiter) => (limiter ? [limiter] : []);

  router.post('/register', ...use(registerLimiter), async (req, res) => {
    const email = normalizeEmail(req.body?.email);
    if (!email) throw coded('That does not look like an email address. Check it for typos (for example name@gmail.com).', 400, 'invalid_email');
    checkPassword(req.body?.password);
    const accepted = req.body?.acceptTerms === true;
    if (config.requireTermsAcceptance && !accepted) throw bad('Please accept the Terms of Service and Privacy Policy to create an account');
    if (await User.exists({ email })) throw coded('An account with this email already exists. Log in instead, or use "Forgot password" if you do not remember it.', 409, 'email_taken');

    const passwordHash = await bcrypt.hash(req.body.password, BCRYPT_COST);
    let user;
    try {
      user = await User.create({ email, passwordHash, emailVerified: false });
    } catch (err) {
      if (err.code === 11000) throw coded('An account with this email already exists. Log in instead.', 409, 'email_taken'); // two sign-ups at once
      throw err;
    }
    if (accepted) {
      // If this fails the account still exists; it will be asked to accept before its first campaign.
      await recordAcceptance(user._id, { via: 'register', ip: req.ip, userAgent: req.get('user-agent') }).catch((err) => log.error({ err: err.message, userId: String(user._id) }, 'could not record acceptance'));
    }
    inBackground(emailLink(user, 'verify'), 'send the verification email');
    res.status(201).json(session(user));
  });

  // Each way a login can fail gets its own message and `code`, so the person is told what to fix.
  // (This does let someone check whether an email has an account. The per-IP failed-login limit and the
  // account lock after repeated wrong passwords keep that from being used at scale.)
  router.post('/login', ...use(loginLimiter), async (req, res) => {
    const rawEmail = req.body?.email;
    const password = req.body?.password;
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) throw coded('Enter your email address.', 400, 'email_required');
    const email = normalizeEmail(rawEmail);
    if (!email) throw coded('That does not look like an email address. Check it for typos (for example name@gmail.com).', 400, 'invalid_email');
    if (typeof password !== 'string' || !password) throw coded('Enter your password.', 400, 'password_required');
    if (password.length > 1024) throw coded('Wrong password. Try again, or choose "Forgot password" to reset it.', 401, 'wrong_password');

    const user = await User.findOne({ email });
    if (!user) throw coded('No account found with this email. Check the spelling, or create an account.', 404, 'no_account');
    if (user.lockedUntil && user.lockedUntil > new Date()) {
      const mins = Math.ceil((user.lockedUntil.getTime() - Date.now()) / 60_000);
      throw coded(`Too many wrong passwords. This account is locked for ${mins} more minute${mins === 1 ? '' : 's'}. You can reset your password to unlock it now.`, 429, 'locked');
    }
    if (!user.passwordHash) {
      const via = providerNames(user).join(' or ') || 'a social account';
      throw coded(`This account was created with ${via} and has no password. Use the ${via} button, or choose "Forgot password" to create a password.`, 400, 'use_oauth');
    }

    if (!(await bcrypt.compare(password, user.passwordHash))) {
      const updated = await User.findOneAndUpdate({ _id: user._id }, { $inc: { failedLogins: 1 } }, { returnDocument: 'after' });
      if (updated && updated.failedLogins >= MAX_FAILED_LOGINS) {
        await User.updateOne({ _id: user._id }, { $set: { lockedUntil: new Date(Date.now() + LOCK_MS), failedLogins: 0 } });
        await record({ ip: req.ip, requestId: req.id, actorId: user._id, actorEmail: user.email, action: 'login.locked', detail: `after ${MAX_FAILED_LOGINS} wrong passwords` });
        throw coded(`Too many wrong passwords. This account is locked for ${Math.round(LOCK_MS / 60_000)} minutes. You can reset your password to unlock it now.`, 429, 'locked');
      }
      const left = MAX_FAILED_LOGINS - (updated?.failedLogins || 0);
      const warn = left <= 3 ? ` ${left} more wrong ${left === 1 ? 'try' : 'tries'} will lock the account for a while.` : '';
      throw coded(`Wrong password. Try again, or choose "Forgot password" to reset it.${warn}`, 401, 'wrong_password');
    }

    if (user.suspendedAt) {
      await record({ ip: req.ip, requestId: req.id, actorId: user._id, actorEmail: user.email, action: 'login.blocked', detail: 'account is suspended' });
      throw coded('This account has been suspended. Please contact support.', 403, 'suspended');
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
    if (!user.passwordHash) throw bad('This account signs in with Google or GitHub and has no password yet. Log out, then use "Forgot password" on the login page to create one.');
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
        subject: 'Your Reachroute password was changed',
        text: 'The password for this account was just changed, and every other device was signed out.\nIf this was not you, reset your password again right away.',
      }),
      'send the password-changed notice'
    );
    res.json(session(updated));
  });

  // ---------------------------------------------------------------- forgot / reset password

  // Tells the person when there is no account for the address (instead of pretending a link was sent).
  router.post('/forgot-password', ...use(passwordReset), async (req, res) => {
    const rawEmail = req.body?.email;
    if (typeof rawEmail !== 'string' || !rawEmail.trim()) throw coded('Enter your email address.', 400, 'email_required');
    const email = normalizeEmail(rawEmail);
    if (!email) throw coded('That does not look like an email address. Check it for typos (for example name@gmail.com).', 400, 'invalid_email');

    const user = await User.findOne({ email }).select('email').lean();
    if (!user) throw coded('No account found with this email. Check the spelling, or create an account.', 404, 'no_account');
    if (await recentlyIssued(user._id, 'reset', EMAIL_COOLDOWN_MS)) throw coded('We just sent a reset link. Check your inbox and spam folder, or wait a minute before asking again.', 429, 'cooldown');

    res.json({ ok: true, message: 'A reset link is on its way. It works for 1 hour.' });
    inBackground(emailLink(user, 'reset'), 'send the reset email');
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
        subject: 'Your Reachroute password was changed',
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

  // The 6-digit code from the sign-up email. The person is logged in (they just signed up or logged in), so no email is asked for.
  router.post('/verify-otp', requireAuth, ...use(signupOtp), async (req, res) => {
    const user = await User.findById(req.userId).select('email emailVerified').lean();
    if (!user) throw bad('Please log in', 401);
    if (isVerified(user)) return res.json({ ok: true, alreadyVerified: true, user: present(user) });
    await verifySignupOtp(user._id, req.body?.code);
    res.json({ ok: true, user: present({ ...user, emailVerified: true }) });
  });

  router.post('/resend-verification', requireAuth, ...use(resendVerification), async (req, res) => {
    const user = await User.findById(req.userId).select('email emailVerified').lean();
    if (!user) throw bad('Please log in', 401);
    if (isVerified(user)) return res.json({ ok: true, alreadyVerified: true });
    if (await recentlyIssued(user._id, 'verify', EMAIL_COOLDOWN_MS)) throw coded('We just sent a code. Check your inbox and spam folder, or wait a minute before asking for another.', 429, 'cooldown');

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
