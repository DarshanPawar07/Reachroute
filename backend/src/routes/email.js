import { Router } from 'express';
import { fromReq, record } from '../audit/audit.js';
import { config } from '../config.js';
import { getSender, invalidateSender } from '../email/mailer.js';
import { sendTestEmail } from '../email/testSend.js';
import { senderStatus, sendSenderCode, verifySenderCode } from '../email/senderVerification.js';
import { emailChannel, emailEngine } from '../engine/channels.js';
import { SmtpSettings, User } from '../models.js';
import { resolveLimits } from '../plans/limits.js';
import { normalizeEmail } from '../utils/contacts.js';
import { encrypt } from '../utils/crypto.js';
import { assertPublicHost } from '../utils/hostCheck.js';
import { bad } from '../utils/http.js';
import { describeSmtpError } from '../utils/smtpErrors.js';
import { campaignRouter } from './campaigns.js';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;

/** Strip control characters (blocks header injection) and cap the length. */
const clean = (v, max) => String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

// Common mail providers: what to enter for the SMTP host and port, and what kind of password they want.
const PROVIDERS = [
  { name: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true, note: 'Turn on 2-step verification, then create an App Password and use that as the SMTP password. About 500 emails a day.' },
  { name: 'Outlook / Microsoft 365', host: 'smtp.office365.com', port: 587, secure: false, note: 'SMTP sending may need to be enabled for the mailbox by an administrator.' },
  { name: 'Yahoo', host: 'smtp.mail.yahoo.com', port: 465, secure: true, note: 'Create an App Password in your Yahoo account security settings.' },
  { name: 'Zoho Mail', host: 'smtp.zoho.in', port: 465, secure: true, note: 'Use smtp.zoho.com instead if your account is on the .com data centre.' },
  { name: 'Brevo (Sendinblue)', host: 'smtp-relay.brevo.com', port: 587, secure: false, note: 'Use your Brevo SMTP login and SMTP key. The sender address must be verified in Brevo too.' },
  { name: 'Amazon SES', host: 'email-smtp.ap-south-1.amazonaws.com', port: 587, secure: false, note: 'Use your SES SMTP credentials. Change the region in the host to match yours. The sender must be verified in SES.' },
];

/** `limiters` = { createCampaign, smtpTest, settingsWrite, senderOtp, testSend } (all optional). */
export function emailRouter({ createCampaign, smtpTest, settingsWrite, senderOtp, testSend } = {}) {
  const router = Router();
  const use = (limiter) => (limiter ? [limiter] : []);

  // ------------------------------------------------------------------ SMTP settings

  router.get('/settings', async (req, res) => {
    const s = await SmtpSettings.findOne({ userId: req.userId }).lean();
    const { limits: own } = await resolveLimits(req.userId);
    res.json({
      settings: s
        ? {
            host: s.host,
            port: s.port,
            secure: s.secure,
            user: s.user,
            hasPassword: Boolean(s.passEncrypted), // the password itself is never sent back
            fromName: s.fromName,
            fromEmail: s.fromEmail,
            replyTo: s.replyTo,
          }
        : null,
      sender: await senderStatus(req.userId), // is the "from" address proven? is a code waiting?
      platformFallback: Boolean(config.platformSmtp),
      dailyCap: own.emailDailyCap,
      maxContactsPerUpload: own.emailMaxUpload,
    });
  });

  router.put('/settings', ...use(settingsWrite), async (req, res) => {
    const b = req.body || {};

    const host = clean(b.host, 253).toLowerCase();
    if (!HOSTNAME.test(host)) throw bad('Enter the SMTP host name only, for example smtp.gmail.com (no https:// and no spaces)');
    const port = Number(b.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('SMTP port must be a number from 1 to 65535');
    const fromEmail = normalizeEmail(b.fromEmail);
    if (!fromEmail) throw bad('Enter a valid "from" email address');
    const replyTo = b.replyTo ? normalizeEmail(b.replyTo) : '';
    if (b.replyTo && !replyTo) throw bad('Reply-to is not a valid email address');
    if (b.pass !== undefined && b.pass !== null && (typeof b.pass !== 'string' || b.pass.length > 500)) throw bad('SMTP password is invalid');

    const user = clean(b.user, 320);
    const existing = await SmtpSettings.findOne({ userId: req.userId }).select('passEncrypted').lean();
    let passEncrypted = existing?.passEncrypted || '';
    if (typeof b.pass === 'string' && b.pass.length > 0) passEncrypted = encrypt(b.pass);
    if (user && !passEncrypted) throw bad('Enter the SMTP password too');

    await assertPublicHost(host);

    await SmtpSettings.findOneAndUpdate(
      { userId: req.userId },
      {
        host,
        port,
        secure: b.secure === true || b.secure === 'true',
        user,
        passEncrypted,
        fromName: clean(b.fromName, 100).replace(/["<>]/g, ''),
        fromEmail,
        replyTo,
      },
      { upsert: true, setDefaultsOnInsert: true }
    );
    invalidateSender(req.userId);
    // A different "from" address is not proven yet: its owner enters a code first (see /sender).
    // Never the password itself, only whether it was changed.
    await record({ ...fromReq(req), action: 'smtp.saved', detail: `${host}:${port}, from ${fromEmail}, password ${typeof b.pass === 'string' && b.pass.length > 0 ? 'changed' : 'unchanged'}` });
    res.json({ ok: true, sender: await senderStatus(req.userId) });
  });

  // ------------------------------------------------------------------ proving the "from" address
  // Emails sent from the app need an address the owner can read mail at. We send a 6-digit code to it and they enter it.
  router.get('/providers', (_req, res) => res.json({ providers: PROVIDERS }));
  router.get('/sender', async (req, res) => res.json(await senderStatus(req.userId)));
  router.post('/sender/code', ...use(senderOtp), async (req, res) => {
    const result = await sendSenderCode(req.userId);
    res.json({ ...result, sender: await senderStatus(req.userId) });
  });
  router.post('/sender/verify', ...use(settingsWrite), async (req, res) => {
    const result = await verifySenderCode(req.userId, (req.body || {}).code);
    res.json({ ...result, sender: await senderStatus(req.userId) });
  });

  // Remove the saved login completely (also deletes the stored password).
  router.delete('/settings', ...use(settingsWrite), async (req, res) => {
    await SmtpSettings.deleteOne({ userId: req.userId });
    invalidateSender(req.userId);
    await record({ ...fromReq(req), action: 'smtp.removed' });
    res.json({ ok: true });
  });

  // Checks the login and sends a test message to the account's own email address.
  router.post('/settings/test', ...use(smtpTest), async (req, res) => {
    invalidateSender(req.userId);
    let sender;
    try {
      sender = await getSender(req.userId, { allowUnverified: true }); // testing the login comes before proving the address
    } catch (err) {
      throw bad(err.userMessage || `These settings cannot be used: ${err.message}`);
    }
    if (!sender) throw bad('Save your email settings first');
    const account = await User.findById(req.userId).select('email').lean();
    if (!account) throw bad('Account not found', 404);

    try {
      await sender.transport.verify();
      await sender.transport.sendMail({
        from: sender.from,
        replyTo: sender.replyTo,
        to: account.email,
        subject: 'Test email from Reachroute',
        text: 'Your SMTP settings work. You can now send email campaigns.',
      });
    } catch (err) {
      invalidateSender(req.userId);
      throw bad(`SMTP test failed: ${describeSmtpError(err)}`);
    }
    res.json({ ok: true, sentTo: account.email });
  });

  // ------------------------------------------------------------------ campaigns
  // Preview: the campaign as written, sent to the account's own address. Declared before the campaigns router.
  router.post('/campaigns/test', ...use(testSend), async (req, res) => {
    res.json({ ok: true, ...(await sendTestEmail(req.userId, req.body || {})) });
  });
  router.use('/campaigns', campaignRouter(emailChannel, emailEngine, { createLimiter: createCampaign }));

  return router;
}
