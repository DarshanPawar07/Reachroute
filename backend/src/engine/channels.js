import { config } from '../config.js';
import { sendCampaignEmail, getSender } from '../email/mailer.js';
import { Campaign, EmailCampaign, EmailOptOut, EmailRecipient, EmailReply, OptOut, Recipient, Reply } from '../models.js';
import { purgeExpiredEmailReplies } from '../email/replies.js';
import { bad } from '../utils/http.js';
import { logger } from '../utils/logger.js';
import { parseContacts, parseEmailContacts } from '../utils/contacts.js';
import { readAb } from '../utils/ab.js';
import { renderEmail } from '../utils/emailTemplate.js';
import { renderMessage } from '../utils/template.js';
import { loadAttachment } from '../attachments/store.js';
import { engineLimits } from '../plans/limits.js';
import { signUnsubscribe } from '../utils/unsubscribeToken.js';
import { purgeExpiredReplies } from '../whatsapp/replies.js';
import { assertCanSend, handleRestriction, isBanSignal, noteBanSignal, restrictedReason, restrictionEvents } from '../whatsapp/restriction.js';
import * as wa from '../whatsapp/sessionManager.js';
import { createEngine } from './sendEngine.js';

const MISSING_FILE = 'An attached file was deleted or is damaged. Upload it again, start a new campaign with it, and cancel this one.';
const isMissingFile = (err) => err?.code === 'ATTACHMENT_MISSING';

const text = (v, label, max) => {
  const s = typeof v === 'string' ? v.trim() : '';
  if (!s) throw bad(`${label} is required`);
  if (s.length > max) throw bad(`${label} is too long (max ${max} characters)`);
  return s;
};

// ============================================================ WhatsApp

export const whatsappChannel = {
  name: 'whatsapp',
  Campaign,
  Recipient,
  Reply,
  contactField: 'phone',
  limits: { dailyCap: config.dailyCap, hourlyCap: config.waHourlyCap, minDelay: config.minDelaySeconds, maxDelay: config.maxDelaySeconds },
  // The caps of one account come from its plan (the numbers above are the server-wide defaults).
  limitsFor: (userId) => engineLimits('whatsapp', userId),
  uploadLimit: 'waMaxUpload',
  // Only the instance that holds a user's WhatsApp session can send for that user.
  ownedUserIds: () => wa.ownedUserIds(),
  // Runs with the retention clean-up: replies are kept as long as finished campaigns are.
  purgeExpired: purgeExpiredReplies,

  // The texts that can contain {{variables}}.
  templateTexts: (fields) => [fields.template],

  readFields(body) {
    return {
      name: text(body.name, 'Campaign name', 100),
      template: text(body.message, 'Message', 1000),
      appendOptOut: body.appendOptOut !== 'false' && body.appendOptOut !== false,
    };
  },
  parseFile: (buffer, filename, maxRows = config.maxContactsPerUpload) => parseContacts(buffer, filename, { defaultCountry: config.defaultCountry, maxRows }),
  async requireReady(userId) {
    const connected = (await wa.getStatus(userId)).status === 'connected';
    // A number WhatsApp refused cannot send until its time is up or a different number is linked.
    await assertCanSend(userId, connected ? await wa.connectedPhone(userId) : null);
    if (!connected) throw bad('Connect your WhatsApp account first.', 409);
  },
  async filterOptOuts(userId, contacts) {
    const out = new Set((await OptOut.find({ userId, phone: { $in: contacts.map((c) => c.phone) } }).select('phone').lean()).map((o) => o.phone));
    return { allowed: contacts.filter((c) => !out.has(c.phone)), skipped: out.size };
  },

  async deliver({ campaign, recipient }) {
    const { userId, phone } = recipient;
    if (await OptOut.exists({ userId, phone })) return { outcome: 'skipped', reason: 'opted out' };

    const state = wa.sessionState(userId);
    if (state === 'connecting') {
      // Reconnecting after a blip: wait instead of failing. After ~5 minutes of this, pause the campaign.
      return { outcome: 'defer', delayMs: 15_000, maxDefers: 20, exhausted: 'pause', reason: 'WhatsApp stayed disconnected. Reconnect and resume.' };
    }
    if (state !== 'connected') return { outcome: 'failed', pause: 'WhatsApp is not connected. Reconnect and resume.' };
    if (wa.ownPhone(userId) === phone) return { outcome: 'skipped', reason: 'your own number' };

    try {
      const ref = campaign.attachments?.[0];
      const media = ref ? await loadAttachment(userId, ref.attachmentId) : null;
      await wa.sendMessage(userId, phone, renderMessage(campaign.template, recipient.name, { appendOptOut: campaign.appendOptOut, fields: recipient.fields }), media);
      return { outcome: 'sent' };
    } catch (err) {
      if (isMissingFile(err)) return { outcome: 'failed', pause: MISSING_FILE };
      if (err.code === 'NOT_ON_WHATSAPP') return { outcome: 'skipped', reason: 'not on WhatsApp' };
      if (err.code === 'NOT_CONNECTED') return { outcome: 'defer', delayMs: 15_000, maxDefers: 20, exhausted: 'pause', reason: 'WhatsApp stayed disconnected. Reconnect and resume.' };
      if (isBanSignal(err) && noteBanSignal(userId)) {
        // WhatsApp keeps refusing this number: stop and keep this contact (and the rest) waiting instead of marking them failed.
        const ownNumber = wa.ownPhone(userId);
        restrictionEvents.emit('detected', { userId, phone: ownNumber, source: 'send', code: err?.output?.statusCode ?? err?.statusCode, reason: err.message });
        return { outcome: 'failed', pause: restrictedReason(ownNumber) };
      }
      return { outcome: 'failed', error: err.message };
    }
  },
};

// ============================================================ Email

export const emailChannel = {
  name: 'email',
  Campaign: EmailCampaign,
  Recipient: EmailRecipient,
  Reply: EmailReply,
  purgeExpired: purgeExpiredEmailReplies,
  contactField: 'email',
  limits: { dailyCap: config.emailDailyCap, minDelay: config.emailMinDelaySeconds, maxDelay: config.emailMaxDelaySeconds },
  limitsFor: (userId) => engineLimits('email', userId),
  uploadLimit: 'emailMaxUpload',
  // Any instance can send email.

  templateTexts: (fields) => [fields.subject, ...(fields.subjectB ? [fields.subjectB] : []), fields.body],

  readFields(body) {
    const subject = text(body.subject, 'Subject', 200);
    return {
      name: text(body.name, 'Campaign name', 100),
      subject,
      ...readAb(body, subject),
      body: text(body.body, 'Body', 20_000),
      bodyFormat: body.bodyFormat === 'html' ? 'html' : 'text',
    };
  },
  parseFile: (buffer, filename, maxRows = config.emailMaxContactsPerUpload) => parseEmailContacts(buffer, filename, { maxRows }),
  async requireReady(userId) {
    let sender;
    try {
      sender = await getSender(userId);
    } catch (err) {
      if (err.code === 'SENDER_NOT_VERIFIED') throw Object.assign(bad(err.userMessage, 403), { code: 'sender_not_verified' });
      // e.g. the saved password cannot be decrypted any more: say so, instead of a vague "Something went wrong"
      if (err.userMessage) throw Object.assign(bad(err.userMessage, 409), { code: String(err.code || 'settings_unusable').toLowerCase() });
      throw err;
    }
    if (!sender) throw bad('Add your email (SMTP) settings first.', 409);
  },
  async filterOptOuts(userId, contacts) {
    const out = new Set((await EmailOptOut.find({ userId, email: { $in: contacts.map((c) => c.email) } }).select('email').lean()).map((o) => o.email));
    return { allowed: contacts.filter((c) => !out.has(c.email)), skipped: out.size };
  },

  async deliver({ campaign, recipient }) {
    const { userId, email } = recipient;
    const suppressed = await EmailOptOut.findOne({ userId, email }).select('reason').lean();
    if (suppressed) return { outcome: 'skipped', reason: { bounced: 'address bounced before', complaint: 'reported an earlier email as spam' }[suppressed.reason] || 'unsubscribed' };

    try {
      const unsubscribeUrl = `${config.publicUrl}/unsubscribe/${signUnsubscribe({ userId, email })}`;
      const { subject, text: plain, html } = renderEmail(campaign, recipient, unsubscribeUrl);
      const attachments = [];
      for (const ref of campaign.attachments || []) {
        const file = await loadAttachment(userId, ref.attachmentId);
        attachments.push({ filename: file.name, content: file.buffer, contentType: file.mime });
      }
      await sendCampaignEmail(userId, { to: email, subject, text: plain, html, unsubscribeUrl, attachments });
      return { outcome: 'sent' };
    } catch (err) {
      if (isMissingFile(err)) return { outcome: 'failed', pause: MISSING_FILE };
      switch (err.kind) {
        case 'fatal':
          return {
            outcome: 'failed',
            pause: err.userMessage
              || (err.code === 'NO_SMTP'
                ? 'Email settings are missing. Add your SMTP details, then resume.'
                : `Could not connect or log in to your SMTP server (${err.code || err.responseCode}). Check your email settings, then resume.`),
          };
        case 'transient': // greylisting, mailbox full, server busy: try again in a few minutes
          return { outcome: 'defer', delayMs: 5 * 60_000, maxDefers: 3, exhausted: 'fail', reason: `Temporary error: ${String(err.response || err.message).slice(0, 200)}` };
        case 'bounce': // the mailbox does not exist: never email it again
          await EmailOptOut.updateOne({ userId, email }, { $setOnInsert: { userId, email, reason: 'bounced' } }, { upsert: true }).catch(() => {});
          return { outcome: 'failed', error: String(err.response || err.message).slice(0, 250) };
        default:
          return { outcome: 'failed', error: String(err.response || err.message).slice(0, 250) };
      }
    }
  },
};

export const whatsappEngine = createEngine(whatsappChannel);
export const emailEngine = createEngine(emailChannel);

// When WhatsApp refuses a number (found by the connection or by the sending code), pause the campaigns and tell the owner.
restrictionEvents.on('detected', (details) => {
  handleRestriction(details.userId, details, { engine: whatsappEngine }).catch((err) => logger.error({ err: err.message, userId: String(details.userId) }, 'could not handle the WhatsApp restriction'));
});
