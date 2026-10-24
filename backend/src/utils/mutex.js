import { randomUUID } from 'node:crypto';
import { Lock } from '../models.js';
import { bad } from './http.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Cross-instance mutex backed by MongoDB (no Redis needed).
 * Used so two requests from the same user can't both pass a "daily limit" check at the same moment.
 * The TTL means a crashed holder can never block the key for more than ttlMs.
 */
export async function withLock(key, fn, { ttlMs = 30_000, waitMs = 8_000 } = {}) {
  const owner = randomUUID();
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      // Matches only if the lock is missing (upsert inserts) or expired. A live lock => duplicate key error.
      await Lock.findOneAndUpdate(
        { _id: key, expiresAt: { $lte: new Date() } },
        { $set: { owner, expiresAt: new Date(Date.now() + ttlMs) } },
        { upsert: true }
      );
      break;
    } catch (err) {
      if (err.code !== 11000) throw err;
      if (Date.now() >= deadline) throw bad('The server is busy with another request from you. Try again in a moment.', 503);
      await sleep(80 + Math.random() * 80);
    }
  }
  try {
    return await fn();
  } finally {
    await Lock.deleteOne({ _id: key, owner }).catch(() => {});
  }
}
