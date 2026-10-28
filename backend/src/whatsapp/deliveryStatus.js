// Reading WhatsApp's "message status" updates. Kept free of imports so it can be tested on its own.

// WhatsApp's own numbers: 0 error, 1 pending, 2 reached WhatsApp's server (one tick), 3 reached the contact's phone (two ticks),
// 4 read (blue ticks), 5 played (voice message).
export const LEVEL = { DELIVERED: 3, READ: 4 };
const BY_NAME = { ERROR: 0, PENDING: 1, SERVER_ACK: 2, DELIVERY_ACK: 3, READ: 4, PLAYED: 5 };

const levelOf = (status) => {
  if (typeof status === 'number') return status;
  if (typeof status === 'string' && status in BY_NAME) return BY_NAME[status];
  return null;
};

/**
 * Turn the `messages.update` list from the WhatsApp connection into { id -> highest level reached }.
 * Only messages WE sent count (key.fromMe), and only "delivered" or better is interesting.
 */
export function readStatusUpdates(updates) {
  const out = new Map();
  for (const u of Array.isArray(updates) ? updates : []) {
    const id = u?.key?.id;
    if (!id || !u.key.fromMe) continue;
    const level = levelOf(u.update?.status);
    if (level === null || level < LEVEL.DELIVERED) continue;
    out.set(id, Math.max(out.get(id) || 0, level));
  }
  return out;
}
