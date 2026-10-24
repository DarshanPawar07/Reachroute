import { createHash, randomBytes } from 'node:crypto';
import mongoose from 'mongoose';
import { config } from '../config.js';
import { EmailOptOut, EmailRecipient, User } from '../models.js';
import { normalizeEmail } from '../utils/contacts.js';
import { decrypt, encrypt } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { notify } from '../utils/notify.js';

const log = logger.child({ mod: 'feedback' });
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const RANK = { unsubscribed: 1, bounced: 2, complaint: 3 };

// ------------------------------------------------------------------ the webhook address

export const KEY_PATTERN = /^[A-Za-z0-9_-]{20,64}$/;
const hashKey = (key) => createHash('sha256').update(key).digest('hex');
export const webhookUrl = (key) => `${config.publicUrl}/hooks/email/${key}`;

/** Make a new secret for the account (the old one stops working). Returns the webhook address. */
export async function createWebhookKey(userId) {
  const key = randomBytes(24).toString('base64url');
  await User.updateOne({ _id: userId }, { $set: { webhookKeyHash: hashKey(key), webhookKeyEnc: encrypt(key) } });
  return webhookUrl(key);
}

export async function removeWebhookKey(userId) {
  await User.updateOne({ _id: userId }, { $unset: { webhookKeyHash: 1, webhookKeyEnc: 1 } });
}

/** The account's current webhook address, or null when it has none. */
export async function currentWebhookUrl(userId) {
  const user = await User.findById(userId).select('webhookKeyEnc').lean();
  if (!user?.webhookKeyEnc) return null;
  try {
    return webhookUrl(decrypt(user.webhookKeyEnc));
  } catch {
    return null; // encrypted with a key that was changed: make a new one
  }
}

/** Which account a secret belongs to (its id), or null. */
export async function userIdForKey(key) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key)) return null;
  const user = await User.findOne({ webhookKeyHash: hashKey(key) }).select('_id').lean();
  return user ? user._id : null;
}

// ------------------------------------------------------------------ recording what happened

/** Mark the latest campaign email sent to this address with what happened to it (never downgrading a spam complaint). */
export async function markRecipientFeedback(userId, email, kind) {
  const last = await EmailRecipient.findOne({ userId: oid(userId), email, status: 'sent' }).sort({ sentAt: -1 }).select('_id feedback').lean();
  if (!last) return false;
  if (last.feedback === 'complaint' && kind !== 'complaint') return false;
  await EmailRecipient.updateOne({ _id: last._id }, { $set: { feedback: kind, feedbackAt: new Date() } });
  return true;
}

/**
 * Apply bounce / complaint / unsubscribe events from a provider: stop emailing those addresses and mark the
 * messages they relate to. Safe to receive the same event twice. Returns how many addresses were newly stopped.
 */
export async function applyFeedback(userId, events) {
  const seen = new Map();
  for (const e of events) {
    const email = normalizeEmail(e.email);
    if (!email) continue;
    const have = seen.get(email);
    if (!have || RANK[e.kind] > RANK[have.kind]) seen.set(email, { email, kind: e.kind, detail: e.detail || '' });
  }
  const list = [...seen.values()];
  const result = { received: events.length, valid: list.length, newlyStopped: { bounced: 0, complaint: 0, unsubscribed: 0 } };
  if (!list.length) return result;

  const uid = oid(userId);
  const known = new Map((await EmailOptOut.find({ userId: uid, email: { $in: list.map((e) => e.email) } }).select('email reason').lean()).map((o) => [o.email, o.reason]));
  for (const e of list) if (!known.has(e.email)) result.newlyStopped[e.kind] += 1;

  const ops = list.map((e) => ({
    updateOne: {
      filter: { userId: uid, email: e.email },
      // a spam complaint replaces an earlier unsubscribe or bounce; nothing else changes an address that is already stopped
      update: e.kind === 'complaint'
        ? { $set: { reason: 'complaint', detail: e.detail }, $setOnInsert: { userId: uid, email: e.email } }
        : { $setOnInsert: { userId: uid, email: e.email, reason: e.kind, detail: e.detail } },
      upsert: true,
    },
  }));
  try {
    await EmailOptOut.bulkWrite(ops, { ordered: false });
  } catch (err) {
    // two notices for the same address at the same moment: the address is stopped either way
    const onlyDuplicates = err.writeErrors?.length && err.writeErrors.every((w) => (w.err?.code ?? w.code) === 11000);
    if (!onlyDuplicates) throw err;
  }

  for (let i = 0; i < list.length; i += 20) {
    await Promise.all(list.slice(i, i + 20).map((e) => markRecipientFeedback(uid, e.email, e.kind).catch((err) => log.warn({ err: err.message }, 'could not mark message'))));
  }

  if (result.newlyStopped.complaint) {
    const n = result.newlyStopped.complaint;
    await notify(userId, {
      type: 'email_complaint',
      level: 'warning',
      title: `${n} ${n === 1 ? 'person' : 'people'} marked your email as spam`,
      message: 'They will not be emailed again. Spam complaints damage your sender reputation: only email people who agreed to hear from you.',
      link: '/email',
      dedupeKey: 'email_complaint',
      email: true,
    });
  }
  return result;
}
