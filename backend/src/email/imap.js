import { config } from '../config.js';
import { ImapSettings } from '../models.js';
import { decrypt } from '../utils/crypto.js';
import { assertPublicHost } from '../utils/hostCheck.js';
import { logger } from '../utils/logger.js';
import { notify } from '../utils/notify.js';
import { describeImapError, flattenHeaders } from './mailText.js';
import { ingestBounce } from './bounces.js';
import { ingestMessage } from './replies.js';

export { describeImapError, flattenHeaders };

const log = logger.child({ mod: 'imap' });

const BATCH = 100; // messages read per visit; a bigger backlog is read on the next visit straight away
const MAX_MESSAGE_BYTES = 262_144; // the start of a message holds the reply; the rest is quoted mail and attachments
const LEASE_MS = 10 * 60_000; // how long one instance owns a mailbox visit before another may take it
const MAX_BACKOFF_MS = 6 * 60 * 60_000;

/** Hints for the settings form. Sending services like Brevo or SES have no mailbox to read. */
export const IMAP_PROVIDERS = [
  { name: 'Gmail', host: 'imap.gmail.com', port: 993, note: 'Turn on IMAP in Gmail settings (Forwarding and POP/IMAP). Use the same App Password as for sending.' },
  { name: 'Outlook / Microsoft 365', host: 'outlook.office365.com', port: 993, note: 'IMAP may need to be enabled for the mailbox by an administrator.' },
  { name: 'Yahoo', host: 'imap.mail.yahoo.com', port: 993, note: 'Use an App Password from your Yahoo account security settings.' },
  { name: 'Zoho Mail', host: 'imap.zoho.in', port: 993, note: 'Use imap.zoho.com if your account is on the .com data centre. IMAP must be enabled in Zoho settings.' },
];

// ------------------------------------------------------------------ the mailbox connection

/**
 * The only code that talks to a real IMAP server. A client has two calls:
 *   test()                                  logs in and opens the inbox; returns { uidValidity, uidNext }
 *   read({ uidValidity, afterUid, limit })  returns { uidValidity, uidNext, baseline, messages: [{ uid, source }] }
 * `baseline: true` means nothing was read, only the mailbox position was learned: mail that arrived before the
 * reader was switched on (or after the mailbox was rebuilt) is never read.
 * Tests replace the factory with an in-memory client.
 */
async function realClientFactory({ host, ip, port, secure, user, pass }) {
  let ImapFlow;
  try {
    ({ ImapFlow } = await import('imapflow'));
  } catch {
    throw Object.assign(new Error('imapflow is not installed'), { code: 'IMAP_MODULES_MISSING' });
  }
  const open = () =>
    new ImapFlow({
      host: ip || host, // connect to the address that was checked (see assertPublicHost), not to the name again
      servername: host, // ...but check the certificate against the name
      port,
      secure,
      auth: { user, pass },
      logger: false,
      socketTimeout: 60_000,
      greetingTimeout: 20_000,
      connectionTimeout: 20_000,
    });

  const withInbox = async (fn) => {
    const client = open();
    client.on('error', () => {}); // an error is also thrown from the call that was running; an unhandled event would crash the process
    await client.connect();
    try {
      const lock = await client.getMailboxLock('INBOX', { readOnly: true });
      try {
        return await fn(client, { uidValidity: Number(client.mailbox.uidValidity), uidNext: Number(client.mailbox.uidNext) });
      } finally {
        lock.release();
      }
    } finally {
      await client.logout().catch(() => client.close());
    }
  };

  return {
    test: () => withInbox(async (_c, box) => box),
    read: ({ uidValidity, afterUid, limit }) =>
      withInbox(async (client, box) => {
        if (afterUid == null || uidValidity !== box.uidValidity) return { ...box, baseline: true, messages: [] };
        if (box.uidNext - 1 <= afterUid) return { ...box, baseline: false, messages: [] };
        const messages = [];
        for await (const m of client.fetch(`${afterUid + 1}:*`, { uid: true, source: { maxLength: MAX_MESSAGE_BYTES } }, { uid: true })) {
          if (m.uid > afterUid && m.source) messages.push({ uid: m.uid, source: m.source });
          if (messages.length >= limit) break;
        }
        messages.sort((a, b) => a.uid - b.uid);
        return { ...box, baseline: false, messages: messages.slice(0, limit) };
      }),
  };
}

let clientFactory = realClientFactory;
/** For tests: pass a function that returns a client, or nothing to go back to the real one. */
export function setImapClientFactory(fn) {
  clientFactory = fn || realClientFactory;
}

async function connectionFor(settings) {
  const ip = await assertPublicHost(settings.host); // the owner chose this host, so it is checked every time
  return clientFactory({ host: settings.host, ip, port: settings.port, secure: settings.secure, user: settings.user, pass: decrypt(settings.passEncrypted) });
}

/** Log in and open the inbox, to prove the details work. Throws a plain-language error. */
export async function testImap(settings) {
  try {
    const client = await connectionFor(settings);
    await client.test();
  } catch (err) {
    throw Object.assign(new Error(describeImapError(err)), { status: err?.status || 400 });
  }
}

// ------------------------------------------------------------------ turning a raw message into a reply

async function parseMessage(source, fallbackId) {
  let simpleParser;
  try {
    ({ simpleParser } = await import('mailparser'));
  } catch {
    throw Object.assign(new Error('mailparser is not installed'), { code: 'IMAP_MODULES_MISSING' });
  }
  const m = await simpleParser(source, { skipImageLinks: true });
  const from = m.from?.value?.[0] || {};
  // The machine-readable part of a bounce notice ("message/delivery-status"), as text.
  const dsn = (m.attachments || [])
    .filter((a) => /^message\/(global-)?delivery-status$/i.test(a.contentType || '') && Buffer.isBuffer(a.content))
    .map((a) => a.content.toString('utf8', 0, 20_000))
    .join('\n\n');
  return {
    messageId: m.messageId || fallbackId,
    from: { address: from.address || '', name: from.name || '' },
    subject: m.subject || '',
    text: m.text || '',
    date: m.date || new Date(),
    headers: flattenHeaders(m.headers),
    dsn,
  };
}

let messageParser = parseMessage;
/** For tests: replace how raw mail is turned into { messageId, from, subject, text, date, headers }; nothing restores the real parser. */
export function setMessageParser(fn) {
  messageParser = fn || parseMessage;
}

// ------------------------------------------------------------------ one visit to one mailbox

/**
 * Read the new mail of one account and keep the replies. Never throws: a failure is stored on the settings
 * (with a longer wait before the next try) and the owner is told if it keeps failing.
 * Returns { stored, optOuts, error? }.
 */
export async function pollUser(settings, { parse = messageParser } = {}) {
  const interval = config.imapPollSeconds * 1000;
  const result = { stored: 0, optOuts: 0, bounces: 0 };
  try {
    const client = await connectionFor(settings);
    const read = await client.read({ uidValidity: settings.uidValidity, afterUid: settings.lastUid, limit: BATCH });

    let lastUid = read.baseline ? read.uidNext - 1 : settings.lastUid;
    for (const m of read.messages) {
      try {
        const msg = await parse(m.source, `${read.uidValidity}:${m.uid}`);
        // A "could not be delivered" notice is handled first: it is not a reply from a person.
        const bounce = await ingestBounce(settings.userId, msg);
        if (bounce.isBounce) {
          result.bounces += bounce.stopped;
        } else if (!settings.bouncesOnly) {
          const out = await ingestMessage(settings.userId, msg);
          if (out.stored) {
            result.stored += 1;
            if (out.reply.optOut) result.optOuts += 1;
          }
        }
      } catch (err) {
        if (err?.code === 'IMAP_MODULES_MISSING') throw err;
        log.warn({ err: err.message, userId: String(settings.userId), uid: m.uid }, 'skipped a message that could not be read'); // one bad message never blocks the rest
      }
      lastUid = m.uid;
    }

    const more = read.messages.length >= BATCH;
    await ImapSettings.updateOne(
      { _id: settings._id },
      { $set: { uidValidity: read.uidValidity, lastUid, lastCheckedAt: new Date(), lastError: '', errorCount: 0, leaseUntil: null, nextCheckAt: new Date(Date.now() + (more ? 5_000 : interval)) } }
    );

    if (result.bounces) {
      await notify(settings.userId, {
        type: 'email-bounces',
        level: 'warning',
        title: result.bounces === 1 ? '1 email address bounced' : `${result.bounces} email addresses bounced`,
        message: 'These addresses do not exist, so they will not be emailed again. Removing them from your lists keeps your sender reputation healthy.',
        link: '/email',
        dedupeKey: `email-bounces:${settings.userId}`,
      });
    }
    if (result.stored) {
      await notify(settings.userId, {
        type: 'email-replies',
        title: result.stored === 1 ? 'New reply to your email campaign' : `${result.stored} new replies to your email campaigns`,
        message: result.optOuts ? `${result.optOuts} asked to stop and will not be emailed again.` : 'Open Replies to read them.',
        link: '/email/replies',
        dedupeKey: `email-replies:${settings.userId}`,
      });
    }
  } catch (err) {
    const message = describeImapError(err);
    const errorCount = (settings.errorCount || 0) + 1;
    result.error = message;
    log.warn({ userId: String(settings.userId), errorCount, err: err?.message }, 'could not read the mailbox');
    await ImapSettings.updateOne(
      { _id: settings._id },
      { $set: { lastError: message, errorCount, lastCheckedAt: new Date(), leaseUntil: null, nextCheckAt: new Date(Date.now() + Math.min(interval * 2 ** Math.min(errorCount, 8), MAX_BACKOFF_MS)) } }
    );
    if (errorCount === 3) {
      await notify(settings.userId, {
        type: 'imap-error',
        level: 'warning',
        title: 'Replies to your emails cannot be read',
        message,
        link: '/email/settings',
        dedupeKey: `imap-error:${settings.userId}`,
      });
    }
  }
  return result;
}

/** Take the right to read one mailbox. Returns its settings, or null when it is off, missing, or already being read. */
function claim(filter) {
  const now = new Date();
  return ImapSettings.findOneAndUpdate(
    { enabled: true, ...filter, $or: [{ leaseUntil: null }, { leaseUntil: { $lte: now } }] },
    { $set: { leaseUntil: new Date(now.getTime() + LEASE_MS) } },
    { sort: { nextCheckAt: 1 }, returnDocument: 'after' }
  );
}

/** Check one account right now (the "Check now" button). Returns { busy: true } if a visit is already running. */
export async function checkNow(userId) {
  const settings = await claim({ userId });
  if (settings) return pollUser(settings);
  return (await ImapSettings.exists({ userId, enabled: true })) ? { busy: true } : null;
}

// ------------------------------------------------------------------ the background reader

/** Visits mailboxes that are due. Safe to run on several server instances: a visit is claimed atomically. */
export function startReplyPoller({ tickMs = 30_000 } = {}) {
  if (!config.imapReplies) {
    log.info('reading email replies is switched off (IMAP_REPLIES=false)');
    return { stop() {} };
  }
  let running = false;
  let stopped = false;

  async function tick() {
    if (running || stopped) return;
    running = true;
    try {
      for (let i = 0; i < 10 && !stopped; i++) {
        const settings = await claim({ nextCheckAt: { $lte: new Date() } });
        if (!settings) break;
        await pollUser(settings);
      }
    } catch (err) {
      log.error({ err: err.message }, 'reply reader failed');
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, tickMs);
  timer.unref();
  setTimeout(tick, 5_000).unref();
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    tick, // exposed for tests
  };
}
