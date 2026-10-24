import { Recipient, Reply } from '../models.js';

/**
 * Save a reply, linked to the latest campaign message sent to that number. Returns the stored reply, or null when it
 * was not stored: the sender is not someone this account messaged in a campaign (a personal chat), or it was already saved.
 */
export async function recordReply(userId, msg, { optOut = false } = {}) {
  const last = await Recipient.findOne({ userId, phone: msg.phone, status: 'sent' }).sort({ sentAt: -1 }).select('_id campaignId name').lean();
  if (!last) return null;
  const res = await Reply.findOneAndUpdate(
    { userId, messageId: msg.messageId },
    {
      $setOnInsert: {
        userId,
        phone: msg.phone,
        name: last.name || msg.pushName || '',
        text: msg.text,
        kind: msg.kind,
        messageId: msg.messageId,
        campaignId: last.campaignId,
        recipientId: last._id,
        optOut,
        receivedAt: msg.receivedAt,
      },
    },
    { upsert: true, returnDocument: 'after', includeResultMetadata: true }
  );
  return res.lastErrorObject?.updatedExisting ? null : res.value;
}

/** Delete replies received before `cutoff`. Called with the retention clean-up. */
export async function purgeExpiredReplies(cutoff) {
  await Reply.deleteMany({ receivedAt: { $lt: cutoff } });
}
