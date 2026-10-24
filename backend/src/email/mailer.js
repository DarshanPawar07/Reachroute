import nodemailer from 'nodemailer';
import { config } from '../config.js';
import { SmtpSettings } from '../models.js';
import { decrypt } from '../utils/crypto.js';
import { assertPublicHost } from '../utils/hostCheck.js';
import { classifySmtpError } from '../utils/smtpErrors.js';

const MAX_CACHED = 500; // cap on open SMTP connections held by one instance
const CACHE_TTL_MS = 5 * 60_000; // so a settings change on another instance is picked up within minutes

/** userId -> { transport, from, replyTo, at }. */
const cache = new Map();

/** `host` may be an IP address that was already checked; `tlsServername` is then the real host name, used to verify the certificate. */
export function buildTransport({ host, port, secure, user, pass, tlsServername }) {
  return nodemailer.createTransport({
    host,
    port,
    secure,
    tls: tlsServername ? { servername: tlsServername } : undefined,
    auth: user ? { user, pass } : undefined,
    pool: true,
    maxConnections: 1,
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
  });
}

export function invalidateSender(userId) {
  const entry = cache.get(String(userId));
  if (entry) {
    entry.transport.close();
    cache.delete(String(userId));
  }
}

/** A problem with the user's saved settings (not with one recipient). userMessage is shown to the user. */
const settingsError = (code, userMessage) => Object.assign(new Error(userMessage), { kind: 'fatal', code, userMessage });

function readPassword(encrypted) {
  if (!encrypted) return '';
  try {
    return decrypt(encrypted);
  } catch {
    // ENCRYPTION_KEY changed or the value is damaged
    throw settingsError('BAD_SECRET', 'Your saved SMTP password can no longer be read. Open email settings, enter it again and save, then resume.');
  }
}

async function loadSettings(userId) {
  const s = await SmtpSettings.findOne({ userId });
  if (s) {
    return {
      smtp: { host: s.host, port: s.port, secure: s.secure, user: s.user, pass: readPassword(s.passEncrypted) },
      from: { name: s.fromName || '', address: s.fromEmail },
      replyTo: s.replyTo || undefined,
      own: true,
      verified: Boolean(s.verifiedEmail) && s.verifiedEmail === s.fromEmail, // the owner proved they can read mail at this address
    };
  }
  const p = config.platformSmtp;
  if (p) {
    return {
      smtp: { host: p.host, port: p.port, secure: p.secure, user: p.user, pass: p.pass },
      from: { name: '', address: p.fromEmail },
      replyTo: undefined,
      own: false,
      verified: true, // the platform's own address
    };
  }
  return null;
}

/** Refuses (code SENDER_NOT_VERIFIED) a user's own "from" address until they have proved they can read mail there. */
function checkVerified(sender, allowUnverified) {
  if (sender.own && !sender.verified && !allowUnverified) {
    throw settingsError('SENDER_NOT_VERIFIED', `Verify your sender email ${sender.from.address} first: ask for a code in your email settings and enter it. Then resume.`);
  }
  return sender;
}

/**
 * Returns { transport, from, replyTo } for a user, or null if no SMTP is configured.
 * Throws SENDER_NOT_VERIFIED when the user's own "from" address has not been verified yet, unless `allowUnverified`
 * (used for the settings test, and for alerts to the owner themselves).
 */
export async function getSender(userId, { allowUnverified = false } = {}) {
  const key = String(userId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    cache.delete(key); // re-insert so the Map stays ordered by recent use
    cache.set(key, hit);
    return checkVerified(hit, allowUnverified);
  }
  if (hit) invalidateSender(key);

  const settings = await loadSettings(userId);
  if (!settings) return null;
  // A user-supplied host is resolved and checked once, and we connect to that exact address (see assertPublicHost).
  const pinnedIp = settings.own ? await assertPublicHost(settings.smtp.host) : null;
  const smtp = pinnedIp ? { ...settings.smtp, host: pinnedIp, tlsServername: settings.smtp.host } : settings.smtp;

  const sender = { transport: buildTransport(smtp), from: settings.from, replyTo: settings.replyTo, at: Date.now(), own: settings.own, verified: settings.verified };
  cache.set(key, sender);
  while (cache.size > MAX_CACHED) invalidateSender(cache.keys().next().value); // evict least recently used
  return checkVerified(sender, allowUnverified);
}

/** Send one campaign email. Errors carry err.kind from classifySmtpError(). */
export async function sendCampaignEmail(userId, { to, subject, text, html, unsubscribeUrl, attachments }) {
  let sender;
  try {
    sender = await getSender(userId);
  } catch (err) {
    if (err.kind) throw err;
    // e.g. the saved SMTP host no longer resolves to a public server
    throw settingsError('BAD_SETTINGS', `Your email settings cannot be used right now (${err.message}). Check them, then resume.`);
  }
  if (!sender) throw Object.assign(new Error('Email settings are not configured'), { kind: 'fatal', code: 'NO_SMTP' });
  try {
    await sender.transport.sendMail({
      from: sender.from,
      replyTo: sender.replyTo,
      to,
      subject,
      text,
      html,
      ...(attachments?.length ? { attachments } : {}), // [{ filename, content, contentType }]
      headers: {
        // Lets mail apps show their own "Unsubscribe" button (RFC 8058 one-click).
        'List-Unsubscribe': `<${unsubscribeUrl}>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    });
  } catch (err) {
    err.kind = classifySmtpError(err);
    if (err.kind === 'fatal') invalidateSender(userId); // rebuild the connection next time
    throw err;
  }
}

export function closeAllSenders() {
  for (const key of [...cache.keys()]) invalidateSender(key);
}
