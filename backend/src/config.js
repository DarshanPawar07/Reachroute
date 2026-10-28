import 'dotenv/config';
import crypto from 'node:crypto';
import os from 'node:os';

/** Read an integer env var; a bad value stops the server at boot instead of failing later. */
const int = (name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max} (got "${raw}")`);
  return n;
};
const bool = (name, fallback = false) => (process.env[name] === undefined ? fallback : process.env[name] === 'true');

const isProd = process.env.NODE_ENV === 'production';
const port = int('PORT', 4000, { min: 1, max: 65535 });
const publicUrl = (process.env.PUBLIC_URL || `http://localhost:${port}`).replace(/\/$/, '');

export const config = {
  env: isProd ? 'production' : 'development',
  isProd,
  port,
  // Unique per process. Used to claim work and own WhatsApp sessions when several instances run.
  instanceId: process.env.INSTANCE_ID || `${os.hostname()}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`,
  logLevel: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  mongoUri: process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/bulk_messenger',
  // Optional. When set (and ioredis + rate-limit-redis are installed) rate limits are shared across instances.
  redisUrl: process.env.REDIS_URL || '',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-secret',
  encryptionKey: process.env.ENCRYPTION_KEY || 'dev-only-encryption-key',
  // Signs unsubscribe links. Kept separate so rotating JWT_SECRET doesn't break links already sitting in inboxes.
  unsubscribeSecret: process.env.UNSUBSCRIBE_SECRET || process.env.JWT_SECRET || 'dev-only-secret',
  corsOrigins: (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',').map((s) => s.trim()).filter(Boolean),
  publicUrl,
  // Number of reverse proxies in front of the API (needed for correct client IPs behind a load balancer).
  trustProxy: int('TRUST_PROXY', 0, { min: 0, max: 10 }),

  // ---- send engine (shared by both channels) ----
  dispatchIntervalMs: int('DISPATCH_INTERVAL_MS', 2000, { min: 200 }),
  sendConcurrency: int('SEND_CONCURRENCY', 10, { min: 1, max: 200 }),
  sendTimeoutMs: int('SEND_TIMEOUT_MS', 90_000, { min: 5_000 }),
  claimTimeoutMs: int('CLAIM_TIMEOUT_MS', 10 * 60_000, { min: 60_000 }),
  maxConsecutiveFailures: int('MAX_CONSECUTIVE_FAILURES', 3, { min: 1 }),
  maxActiveCampaigns: int('MAX_ACTIVE_CAMPAIGNS', 3, { min: 1 }),
  retentionDays: int('RETENTION_DAYS', 90, { min: 0 }), // 0 = keep forever
  // How far ahead a campaign may be scheduled to start.
  maxScheduleDays: int('MAX_SCHEDULE_DAYS', 30, { min: 1, max: 365 }),

  // ---- monitoring and backups ----
  // Secret for GET /metrics (Prometheus format). Empty = the endpoint is switched off (404).
  metricsToken: process.env.METRICS_TOKEN || '',
  // Raise an alert when due messages have waited this many minutes without being sent. 0 = watchdog off.
  watchdogStuckMinutes: int('WATCHDOG_STUCK_MINUTES', 10, { min: 0, max: 1440 }),
  // Who is emailed when the watchdog finds a problem (needs the platform SMTP). Comma separated. Empty = log only.
  opsAlertEmails: (process.env.OPS_ALERT_EMAILS || '').split(',').map((s) => s.trim()).filter(Boolean),
  // Audit log entries older than this are deleted. 0 = keep forever.
  auditRetentionDays: int('AUDIT_RETENTION_DAYS', 365, { min: 0 }),
  // ---- attachments (files sent with a message) ----
  // Largest single file, per channel, in megabytes. A plan can set lower values for its accounts.
  waAttachmentMb: int('WA_ATTACHMENT_MB', 16, { min: 1, max: 100 }),
  emailAttachmentMb: int('EMAIL_ATTACHMENT_MB', 10, { min: 1, max: 25 }),
  // How much one account may keep stored in total, in megabytes (a plan can change it).
  attachmentStorageMb: int('ATTACHMENT_STORAGE_MB', 100, { min: 1, max: 100_000 }),
  // Files that no unfinished campaign needs and nobody used for this many days are deleted. 0 = keep until the owner deletes them.
  attachmentRetentionDays: int('ATTACHMENT_RETENTION_DAYS', 90, { min: 0 }),

  // ---- terms and privacy ----
  // New accounts must tick "I accept the Terms and Privacy Policy", and nobody starts a campaign until they accepted the current versions.
  requireTermsAcceptance: bool('REQUIRE_TERMS_ACCEPTANCE', process.env.NODE_ENV !== 'test'), // on by default; the test runner (NODE_ENV=test) starts with it off
  // Who runs the service, as written in the Terms and Privacy Policy, and where people can write to you about their data.
  legalName: process.env.LEGAL_OPERATOR_NAME || 'Reachroute',
  legalContactEmail: process.env.LEGAL_CONTACT_EMAIL || '',
  // Where `npm run backup` writes, and how many backups it keeps.
  backupDir: process.env.BACKUP_DIR || 'backups',
  backupKeep: int('BACKUP_KEEP', 7, { min: 1, max: 365 }),

  // ---- saved contact lists and alerts ----
  maxLists: int('MAX_LISTS_PER_USER', 20, { min: 1 }),
  maxTemplates: int('MAX_TEMPLATES_PER_USER', 50, { min: 1 }),
  maxListContacts: int('MAX_CONTACTS_PER_LIST', 5000, { min: 1 }),
  // Email the account owner when WhatsApp disconnects or a campaign pauses (uses their SMTP settings, or the platform SMTP).
  alertEmails: bool('ALERT_EMAILS', true),

  // ---- accounts ----
  // Where the web app lives. Links in password-reset and verification emails point here.
  appUrl: (process.env.APP_URL || (process.env.CORS_ORIGIN || 'http://localhost:5173').split(',')[0].trim()).replace(/\/$/, ''),
  // When true, accounts must confirm their email address before they can start campaigns.
  // Needs a platform SMTP (SMTP_HOST) so verification emails can actually be sent.
  requireEmailVerification: bool('REQUIRE_EMAIL_VERIFICATION', false),

  // ---- plans and billing ----
  // The plan every new account starts on (a plan key made in Admin > Plans). Empty = new accounts use the platform defaults.
  defaultPlanKey: (process.env.DEFAULT_PLAN_KEY ?? 'free').trim().toLowerCase(),
  // Razorpay recurring billing. Payments are switched on only when both the key id and the key secret are set.
  // The webhook secret is the one typed into Razorpay > Settings > Webhooks; the address to give it is PUBLIC_URL + /api/billing/webhook
  razorpay: {
    keyId: process.env.RAZORPAY_KEY_ID || '',
    keySecret: process.env.RAZORPAY_KEY_SECRET || '',
    webhookSecret: process.env.RAZORPAY_WEBHOOK_SECRET || '',
  },
  // The invoice a customer gets after each payment. With GST_RATE=0 (not registered for GST) it is a plain invoice without tax.
  // Prices are treated as GST-INCLUSIVE: with GST_RATE=18 a Rs 699 payment is shown as 592.37 + 106.63 GST. Ask your CA for the rate, the SAC code and the place-of-supply rules.
  invoice: {
    sellerName: process.env.INVOICE_SELLER_NAME || process.env.LEGAL_OPERATOR_NAME || 'Reachroute',
    sellerAddress: process.env.INVOICE_SELLER_ADDRESS || '',
    sellerState: process.env.INVOICE_SELLER_STATE || '',
    gstin: (process.env.INVOICE_GSTIN || '').trim().toUpperCase(),
    gstRate: Number(process.env.GST_RATE || 0),
    sac: process.env.INVOICE_SAC || '',
    prefix: (process.env.INVOICE_PREFIX || 'RR').toUpperCase(),
  },
  refundWindowDays: int('REFUND_WINDOW_DAYS', 7, { min: 0, max: 90 }),
  // Days a paid account keeps its plan after a renewal payment is overdue, before it goes back to the default plan.
  billingGraceDays: int('BILLING_GRACE_DAYS', 3, { min: 0, max: 30 }),

  // Sign in with Google / GitHub. A button only appears when both the id and the secret are set.
  // The address to register with each provider is PUBLIC_URL + /api/auth/oauth/<google|github>/callback
  oauth: {
    google: { clientId: process.env.GOOGLE_CLIENT_ID || '', clientSecret: process.env.GOOGLE_CLIENT_SECRET || '' },
    github: { clientId: process.env.GITHUB_CLIENT_ID || '', clientSecret: process.env.GITHUB_CLIENT_SECRET || '' },
  },

  // ---- WhatsApp ----
  maxContactsPerUpload: int('MAX_CONTACTS_PER_UPLOAD', 100, { min: 1 }),
  dailyCap: int('DAILY_CAP_PER_ACCOUNT', 100, { min: 1 }),
  minDelaySeconds: int('MIN_DELAY_SECONDS', 30, { min: 1 }),
  maxDelaySeconds: int('MAX_DELAY_SECONDS', 90, { min: 1 }),
  defaultCountry: process.env.DEFAULT_COUNTRY || 'IN',
  waMaxSessions: int('WA_MAX_SESSIONS_PER_INSTANCE', 200, { min: 1 }),
  waLeaseMs: int('WA_LEASE_MS', 60_000, { min: 15_000 }),
  // Most messages one account may send in any rolling hour. Spreads a day's messages out instead of sending them in bursts.
  waHourlyCap: int('WA_HOURLY_CAP_PER_ACCOUNT', 30, { min: 1 }),
  // Every this many minutes, check the health of each account that is sending. 0 = never.
  waHealthCheckMinutes: int('WA_HEALTH_CHECK_MINUTES', 15, { min: 0 }),
  // When an account's health is "risk", pause its running campaigns (once a day) to protect the number.
  waHealthAutopause: bool('WA_HEALTH_AUTOPAUSE', true),
  // Messages WhatsApp accepted but the contact's phone never confirmed (the "Waiting for this message" case). Checked every few minutes
  // while a campaign runs; when nothing is getting through, the campaign pauses. 0 = never check.
  waDeliveryCheckMinutes: int('WA_DELIVERY_CHECK_MINUTES', 2, { min: 0 }),
  // A new sending number starts slowly: for its first WA_WARMUP_DAYS days of sending, at most WA_WARMUP_DAILY_CAP messages a day
  // (or the plan's own limit, if lower). Cold messages from a fresh number to people who never heard from it are what WhatsApp holds back.
  // WA_WARMUP_DAYS=0 switches this off.
  waWarmupDays: int('WA_WARMUP_DAYS', 14, { min: 0, max: 90 }),
  waWarmupDailyCap: int('WA_WARMUP_DAILY_CAP', 40, { min: 1 }),
  // How long a number that WhatsApp refused (restricted or banned) is treated as out of use before it may try again.
  // Replies to email campaigns are read from the owner's mailbox (IMAP) this often; IMAP_REPLIES=false turns the reader off on this server.
  imapReplies: bool('IMAP_REPLIES', true),
  imapPollSeconds: int('IMAP_POLL_SECONDS', 300, { min: 60, max: 3600 }),
  waRestrictionHours: int('WA_RESTRICTION_HOURS', 24, { min: 1, max: 168 }),

  // ---- Email ----
  emailMaxContactsPerUpload: int('EMAIL_MAX_CONTACTS_PER_UPLOAD', 500, { min: 1 }),
  emailDailyCap: int('EMAIL_DAILY_CAP_PER_ACCOUNT', 500, { min: 1 }),
  emailMinDelaySeconds: int('EMAIL_MIN_DELAY_SECONDS', 2, { min: 1 }),
  emailMaxDelaySeconds: int('EMAIL_MAX_DELAY_SECONDS', 6, { min: 1 }),
  // Local testing only: allow SMTP servers on localhost (Mailpit / MailHog).
  allowPrivateSmtp: bool('ALLOW_PRIVATE_SMTP'),
  // Optional platform-wide SMTP (e.g. Amazon SES), used when a user has not saved their own settings.
  platformSmtp: process.env.SMTP_HOST
    ? {
        host: process.env.SMTP_HOST,
        port: int('SMTP_PORT', 587, { min: 1, max: 65535 }),
        secure: bool('SMTP_SECURE'),
        user: process.env.SMTP_USER || '',
        pass: process.env.SMTP_PASS || '',
        fromEmail: process.env.SMTP_FROM_EMAIL || process.env.SMTP_USER || '',
      }
    : null,
};

// ---- fail fast on settings that would cause confusing bugs later ----
if (config.minDelaySeconds > config.maxDelaySeconds) throw new Error('MIN_DELAY_SECONDS must be <= MAX_DELAY_SECONDS');
if (config.emailMinDelaySeconds > config.emailMaxDelaySeconds) throw new Error('EMAIL_MIN_DELAY_SECONDS must be <= EMAIL_MAX_DELAY_SECONDS');
try {
  new URL(publicUrl);
} catch {
  throw new Error('PUBLIC_URL must be a full URL such as https://api.example.com');
}

if (config.metricsToken && config.metricsToken.length < 16) throw new Error('METRICS_TOKEN must be at least 16 characters (or leave it empty to switch /metrics off)');

if (isProd) {
  if (config.jwtSecret.length < 32 || config.jwtSecret === 'dev-only-secret') throw new Error('Set JWT_SECRET to a random string of 32+ characters');
  if (config.encryptionKey.length < 32 || config.encryptionKey === 'dev-only-encryption-key') throw new Error('Set ENCRYPTION_KEY to a random string of 32+ characters');
  if (!publicUrl.startsWith('https://')) throw new Error('PUBLIC_URL must use https in production (unsubscribe links point to it)');
  if (config.corsOrigins.includes('*')) throw new Error('CORS_ORIGIN must list your frontend origin, not *');
}
