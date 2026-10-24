import { isAutoReply, cleanReplyText, looksLikeOptOut } from './mailText.js';
import { EmailOptOut, EmailRecipient, EmailReply, SmtpSettings } from '../models.js';

/**
 * Store one received mail as a reply, if it is a reply from a person this account emailed in a campaign.
 * msg: { messageId, from: { address, name }, subject, text, date, headers }
 * Returns { stored: true, reply } or { stored: false, why: 'auto' | 'unknown' | 'self' | 'duplicate' }.
 * A short "unsubscribe / stop" reply also puts the address on the do-not-email list.
 */
export async function ingestMessage(userId, msg) {
  const address = String(msg.from?.address || '').trim().toLowerCase();
  if (!address || !msg.messageId) return { stored: false, why: 'unknown' };

  const own = await SmtpSettings.findOne({ userId }).select('fromEmail').lean();
  if (own?.fromEmail === address) return { stored: false, why: 'self' };
  if (isAutoReply({ from: address, subject: msg.subject, headers: msg.headers })) return { stored: false, why: 'auto' };

  const last = await EmailRecipient.findOne({ userId, email: address, status: 'sent' }).sort({ sentAt: -1 }).select('_id campaignId name variant feedback').lean();
  if (!last) return { stored: false, why: 'unknown' }; // not someone this account emailed: never kept

  const text = cleanReplyText(msg.text);
  const optOut = looksLikeOptOut(text);
  const res = await EmailReply.findOneAndUpdate(
    { userId, messageId: msg.messageId },
    {
      $setOnInsert: {
        userId,
        email: address,
        name: last.name || msg.from?.name || '',
        subject: String(msg.subject || '').slice(0, 300),
        text,
        messageId: msg.messageId,
        campaignId: last.campaignId,
        recipientId: last._id,
        variant: last.variant || null,
        optOut,
        receivedAt: msg.date instanceof Date && !Number.isNaN(msg.date.getTime()) ? msg.date : new Date(),
      },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true }
  );
  if (res.lastErrorObject?.updatedExisting) return { stored: false, why: 'duplicate' };

  if (optOut) {
    await EmailOptOut.updateOne({ userId, email: address }, { $setOnInsert: { userId, email: address, reason: 'unsubscribed', detail: 'replied asking to stop' } }, { upsert: true });
    if (!last.feedback) await EmailRecipient.updateOne({ _id: last._id }, { $set: { feedback: 'unsubscribed', feedbackAt: new Date() } });
  }
  return { stored: true, reply: res.value };
}

/** Delete replies received before `cutoff`. Called with the retention clean-up. */
export async function purgeExpiredEmailReplies(cutoff) {
  await EmailReply.deleteMany({ receivedAt: { $lt: cutoff } });
}

export { cleanReplyText, isAutoReply, looksLikeOptOut };
