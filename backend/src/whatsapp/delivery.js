import { Recipient } from '../models.js';
import { logger } from '../utils/logger.js';
import { LEVEL, readStatusUpdates } from './deliveryStatus.js';

const log = logger.child({ mod: 'waDelivery' });

// A receipt can arrive a moment before the database row has the message id, so a receipt nobody claims is tried again a few times.
const RETRY_AFTER_MS = [4_000, 15_000, 60_000];

/**
 * Save "delivered" and "read" for the messages in a batch of status updates.
 * Never throws: a failing receipt must not disturb the connection.
 */
export async function recordDelivery(userId, updates, { now = () => new Date(), retry = true } = {}) {
  let matched = 0;
  try {
    for (const [id, level] of readStatusUpdates(updates)) {
      const at = now();
      // $ifNull keeps the FIRST time we heard it. Plain timestamps: this must not look like a new change of the row.
      const set = { deliveredAt: { $ifNull: ['$deliveredAt', at] } };
      if (level >= LEVEL.READ) set.readAt = { $ifNull: ['$readAt', at] };
      const res = await Recipient.updateOne({ userId, waMessageId: id }, [{ $set: set }], { timestamps: false });
      if (res.matchedCount) matched += 1;
      else if (retry) later(userId, { key: { id, fromMe: true }, update: { status: level } }, 0, now);
    }
  } catch (err) {
    log.warn({ err: err.message, userId: String(userId) }, 'could not save delivery status');
  }
  return matched;
}

function later(userId, update, attempt, now) {
  if (attempt >= RETRY_AFTER_MS.length) return;
  const timer = setTimeout(async () => {
    try {
      const res = await Recipient.updateOne(
        { userId, waMessageId: update.key.id },
        [{ $set: { deliveredAt: { $ifNull: ['$deliveredAt', now()] }, ...(update.update.status >= LEVEL.READ ? { readAt: { $ifNull: ['$readAt', now()] } } : {}) } }],
        { timestamps: false }
      );
      if (!res.matchedCount) later(userId, update, attempt + 1, now);
    } catch {
      // a lost receipt only means "not confirmed yet"
    }
  }, RETRY_AFTER_MS[attempt]);
  timer.unref?.();
}
