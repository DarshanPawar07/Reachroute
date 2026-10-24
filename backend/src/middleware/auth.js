import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { User } from '../models.js';
import { fromReq, record } from '../audit/audit.js';

const ALGORITHM = 'HS256'; // pinned on both sign and verify, so a token can never choose its own algorithm
const OBJECT_ID = /^[0-9a-f]{24}$/i;

// Every login token carries the account's "token version" (`v`). Changing the password or choosing "sign out
// other devices" raises the version in the database, and tokens with an older number stop working at once.
// The version is remembered for a few seconds so a busy page does not hit the database on every request.
// On the instance that made the change the effect is immediate; on other instances it takes at most CACHE_MS.
const CACHE_MS = 15_000;
const MAX_CACHED = 5000;
const versions = new Map(); // userId -> { v, at }; v is null when the account no longer exists

/** Forget the remembered version of an account (call right after changing it). */
export const forgetUser = (userId) => versions.delete(String(userId));

async function currentVersion(userId) {
  const hit = versions.get(userId);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.v;
  const user = await User.findById(userId).select('tokenVersion').lean();
  const v = user ? user.tokenVersion || 0 : null;
  versions.set(userId, { v, at: Date.now() });
  while (versions.size > MAX_CACHED) versions.delete(versions.keys().next().value);
  return v;
}

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), v: user.tokenVersion || 0 }, config.jwtSecret, { algorithm: ALGORITHM, expiresIn: '7d' });
}

export async function requireAuth(req, res, next) {
  const match = /^Bearer (\S+)$/.exec(req.headers.authorization || '');
  if (!match) return res.status(401).json({ error: 'Please log in' });
  try {
    const payload = jwt.verify(match[1], config.jwtSecret, { algorithms: [ALGORITHM] });
    if (typeof payload.sub !== 'string' || !OBJECT_ID.test(payload.sub)) throw new Error('bad subject');
    // Tokens issued before versions existed have no `v` and count as version 0.
    if ((await currentVersion(payload.sub)) !== (payload.v || 0)) throw new Error('signed out');
    req.userId = payload.sub;
    next();
  } catch {
    res.status(401).json({ error: 'Your session has expired. Please log in again.' });
  }
}

/**
 * Only administrators. Always reads the account fresh (admin pages are few), so removing someone's admin role,
 * or suspending them, takes effect on their very next request. Use after requireAuth.
 */
export async function requireAdmin(req, res, next) {
  const user = await User.findById(req.userId).select('role suspendedAt email').lean();
  if (!user || user.role !== 'admin' || user.suspendedAt) {
    if (user) await record({ ...fromReq(req), actorEmail: user.email, action: 'admin.denied', detail: `${req.method} ${req.originalUrl.split('?')[0]}` });
    return res.status(403).json({ error: 'This area is for administrators only' });
  }
  req.adminEmail = user.email;
  next();
}
