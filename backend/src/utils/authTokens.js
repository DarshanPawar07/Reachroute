import crypto from 'node:crypto';
import { config } from '../config.js';
import { AuthToken, User } from '../models.js';
import { bad } from './http.js';

/** How long each kind of link works. */
export const TOKEN_TTL_MS = { reset: 60 * 60_000, verify: 24 * 60 * 60_000 };

const hash = (raw) => crypto.createHash('sha256').update(raw).digest('hex');

/**
 * Create a one-time token for a user and return it. Only its hash is stored, so a database leak does not
 * hand out working links. A user has at most one live token of each type: a new one replaces the old one.
 */
export async function issueToken(userId, type) {
  const raw = crypto.randomBytes(32).toString('base64url');
  await AuthToken.deleteMany({ userId, type });
  await AuthToken.create({ userId, type, tokenHash: hash(raw), expiresAt: new Date(Date.now() + TOKEN_TTL_MS[type]) });
  return raw;
}

/** Use a token: returns it once (and deletes it), or null when it is unknown, expired or already used. */
export async function consumeToken(raw, type) {
  if (typeof raw !== 'string' || raw.length < 20 || raw.length > 200) return null;
  return AuthToken.findOneAndDelete({ tokenHash: hash(raw), type, expiresAt: { $gt: new Date() } }).lean();
}

/** True if a token of this type was created for the user in the last `ms` milliseconds (stops email spamming). */
export const recentlyIssued = (userId, type, ms) => AuthToken.exists({ userId, type, createdAt: { $gte: new Date(Date.now() - ms) } });

/** Accounts that predate verification have no flag and count as verified. Only an explicit false is "not verified". */
export const isVerified = (user) => user.emailVerified !== false;

/** Refuse (403) when verification is switched on and this account has not confirmed its email address yet. */
export async function assertVerified(userId) {
  if (!config.requireEmailVerification) return;
  const user = await User.findById(userId).select('emailVerified').lean();
  if (user && !isVerified(user)) {
    throw bad('Please confirm your email address first. We sent you a link; you can ask for a new one from the banner at the top of the app.', 403);
  }
}