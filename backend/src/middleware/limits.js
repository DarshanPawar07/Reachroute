import rateLimit, * as erl from 'express-rate-limit';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let makeStore = () => undefined; // default: in-memory (per instance)
let closeStore = async () => {};

/**
 * Call once at boot. With REDIS_URL set (and `ioredis` + `rate-limit-redis` installed) limits are counted in
 * Redis, so they hold across several instances. Without it each instance counts on its own, which is fine for one server.
 */
export async function initRateLimitStore() {
  if (!config.redisUrl) return;
  try {
    const [{ default: Redis }, { RedisStore }] = await Promise.all([import('ioredis'), import('rate-limit-redis')]);
    const client = new Redis(config.redisUrl, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
    client.on('error', (err) => logger.warn({ err: err.message }, 'rate limit Redis error'));
    makeStore = (name) => new RedisStore({ sendCommand: (...args) => client.call(...args), prefix: `rl:${name}:` });
    closeStore = () => client.quit().catch(() => {});
    logger.info('rate limits are shared through Redis');
  } catch (err) {
    logger.warn({ err: err.message }, 'REDIS_URL is set but ioredis / rate-limit-redis are not installed: using per-instance rate limits');
  }
}

export const closeRateLimitStore = () => closeStore();

const ipKey = (req) => (erl.ipKeyGenerator ? erl.ipKeyGenerator(req.ip) : req.ip);
const userKey = (req) => (req.userId ? `u:${req.userId}` : ipKey(req));

function limiter(name, { windowMs, limit, perUser = false, skipSuccessfulRequests = false, message }) {
  return rateLimit({
    windowMs,
    limit,
    keyGenerator: perUser ? userKey : ipKey,
    skipSuccessfulRequests,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    passOnStoreError: true, // if Redis is down, let requests through instead of failing them
    store: makeStore(name),
    message: { error: message || 'Too many requests. Please slow down and try again shortly.' },
  });
}

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/** Build after initRateLimitStore() so every limiter uses the right store. */
export function createLimiters() {
  return {
    // everything, per IP: blunts floods before they reach the database
    global: limiter('global', { windowMs: MIN, limit: 600 }),
    // everything behind login, per user
    api: limiter('api', { windowMs: MIN, limit: 300, perUser: true }),
    // only failed logins count, so normal use is never throttled
    login: limiter('login', { windowMs: 15 * MIN, limit: 10, skipSuccessfulRequests: true, message: 'Too many failed login attempts. Try again in 15 minutes.' }),
    register: limiter('register', { windowMs: HOUR, limit: 10, message: 'Too many sign-ups from this network. Try again later.' }),
    // mail apps can send many one-click unsubscribes from one provider IP
    unsubscribe: limiter('unsub', { windowMs: 15 * MIN, limit: 300 }),
    // bounce and complaint notices from email providers (one IP can send many)
    webhook: limiter('webhook', { windowMs: MIN, limit: 300 }),
    createCampaign: limiter('campaign', { windowMs: HOUR, limit: 20, perUser: true, message: 'You are creating campaigns too quickly. Try again later.' }),
    waConnect: limiter('waconnect', { windowMs: 10 * MIN, limit: 10, perUser: true, message: 'Too many connection attempts. Wait a few minutes.' }),
    smtpTest: limiter('smtptest', { windowMs: 10 * MIN, limit: 5, perUser: true, message: 'Too many test emails. Wait a few minutes.' }),
    // password reset and email verification (per IP, except resend which is per user)
    passwordReset: limiter('pwreset', { windowMs: HOUR, limit: 5, message: 'Too many password reset requests. Try again in an hour.' }),
    changePassword: limiter('changepw', { windowMs: HOUR, limit: 10, perUser: true, message: 'Too many password changes. Try again in an hour.' }),
    accountToken: limiter('acctoken', { windowMs: HOUR, limit: 30 }),
    resendVerification: limiter('resendverify', { windowMs: HOUR, limit: 5, perUser: true, message: 'Too many verification emails. Try again in an hour.' }),
    settingsWrite: limiter('settings', { windowMs: HOUR, limit: 30, perUser: true }),
    attachmentUpload: limiter('attachup', { windowMs: HOUR, limit: 60, perUser: true, message: 'Too many uploads. Try again later.' }),
    imapCheck: limiter('imapcheck', { windowMs: 10 * MIN, limit: 10, perUser: true, message: 'Too many checks. Replies are also read automatically every few minutes.' }),
    senderOtp: limiter('senderotp', { windowMs: HOUR, limit: 10, perUser: true, message: 'Too many verification codes requested. Try again in an hour.' }),
  };
}
