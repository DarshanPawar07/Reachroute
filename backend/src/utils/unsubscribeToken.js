import crypto from 'node:crypto';
import { config } from '../config.js';

/**
 * Unsubscribe links must keep working for as long as the email exists in someone's inbox, even after the
 * campaign (and its recipient rows) have been deleted by the retention purge. So the token carries the
 * user id and the address itself, signed so nobody can forge one for another address.
 *
 *   v2.<base64url({u, e})>.<signature>        current format
 *   <recipientId>.<signature>                 legacy format from the first version (needs a recipient row)
 *
 * Changing UNSUBSCRIBE_SECRET (or JWT_SECRET when it is not set) breaks every link already sent. Don't rotate it casually.
 */
const sign = (data) => crypto.createHmac('sha256', config.unsubscribeSecret).update(data).digest('base64url');

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

const OBJECT_ID = /^[0-9a-f]{24}$/i;

export function signUnsubscribe({ userId, email }) {
  const payload = Buffer.from(JSON.stringify({ u: String(userId), e: String(email).toLowerCase() })).toString('base64url');
  return `v2.${payload}.${sign(`unsubscribe:v2:${payload}`)}`;
}

/** Returns { userId, email } (current format), { recipientId } (legacy format), or null if the token is not valid. */
export function verifyUnsubscribe(token) {
  const text = String(token || '');
  if (text.length > 600) return null;
  const parts = text.split('.');

  if (parts[0] === 'v2' && parts.length === 3) {
    const [, payload, sig] = parts;
    if (!safeEqual(sig, sign(`unsubscribe:v2:${payload}`))) return null;
    try {
      const { u, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
      if (typeof u !== 'string' || !OBJECT_ID.test(u) || typeof e !== 'string' || !e.includes('@')) return null;
      return { userId: u, email: e.toLowerCase() };
    } catch {
      return null;
    }
  }

  if (parts.length === 2 && OBJECT_ID.test(parts[0])) {
    return safeEqual(parts[1], sign(`unsubscribe:${parts[0]}`)) ? { recipientId: parts[0] } : null;
  }
  return null;
}
