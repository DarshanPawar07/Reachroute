import { Router } from 'express';
import { fromReq, record } from '../audit/audit.js';
import { checkNow, IMAP_PROVIDERS, testImap } from '../email/imap.js';
import { config } from '../config.js';
import { ImapSettings } from '../models.js';
import { encrypt } from '../utils/crypto.js';
import { bad } from '../utils/http.js';

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/i;
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const view = (s) =>
  s && {
    host: s.host,
    port: s.port,
    secure: s.secure,
    user: s.user,
    hasPassword: Boolean(s.passEncrypted), // the password is never sent back
    enabled: s.enabled,
    bouncesOnly: Boolean(s.bouncesOnly),
    lastCheckedAt: s.lastCheckedAt,
    lastError: s.lastError,
  };

/** Where replies are read from: the owner's own mailbox. `limiters` = { settingsWrite, imapCheck } (optional). Mounted at /api/email/imap. */
export function imapRouter({ settingsWrite, imapCheck } = {}) {
  const router = Router();
  const use = (l) => (l ? [l] : []);

  router.get('/', async (req, res) => {
    const s = await ImapSettings.findOne({ userId: req.userId }).lean();
    res.json({ settings: view(s), providers: IMAP_PROVIDERS, available: config.imapReplies, pollSeconds: config.imapPollSeconds });
  });

  // Saving proves the login first, so a wrong password is found now and not after a silent failure.
  router.put('/', ...use(settingsWrite), async (req, res) => {
    if (!config.imapReplies) throw bad('Reading replies is switched off on this server', 403);
    const b = req.body || {};
    const host = clean(b.host, 253).toLowerCase();
    if (!HOSTNAME.test(host)) throw bad('Enter the IMAP host name only, for example imap.gmail.com (no https:// and no spaces)');
    const port = Number(b.port ?? 993);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw bad('IMAP port must be a number from 1 to 65535');
    const user = clean(b.user, 320);
    if (!user) throw bad('Enter the mailbox user name (usually the full email address)');
    if (b.pass !== undefined && b.pass !== null && (typeof b.pass !== 'string' || b.pass.length > 500)) throw bad('IMAP password is invalid');

    const existing = await ImapSettings.findOne({ userId: req.userId }).select('passEncrypted').lean();
    const passEncrypted = typeof b.pass === 'string' && b.pass.length > 0 ? encrypt(b.pass) : existing?.passEncrypted || '';
    if (!passEncrypted) throw bad('Enter the mailbox password');
    const bouncesOnly = b.bouncesOnly === true || b.bouncesOnly === 'true';
    const secure = b.secure === undefined ? port === 993 : b.secure === true || b.secure === 'true';

    await testImap({ host, port, secure, user, passEncrypted });

    // New details mean a new starting point: only mail that arrives from now on is read.
    const saved = await ImapSettings.findOneAndUpdate(
      { userId: req.userId },
      { host, port, secure, user, passEncrypted, bouncesOnly, enabled: true, uidValidity: null, lastUid: null, nextCheckAt: new Date(), leaseUntil: null, lastError: '', errorCount: 0 },
      { upsert: true, returnDocument: 'after', setDefaultsOnInsert: true }
    );
    await record({ ...fromReq(req), action: 'imap.saved', detail: `${host}:${port}, user ${user}${bouncesOnly ? ', bounces only' : ''}, password ${typeof b.pass === 'string' && b.pass.length > 0 ? 'changed' : 'unchanged'}` });
    res.json({ ok: true, settings: view(saved) });
  });

  // Pause or resume reading without losing the details.
  router.post('/enabled', ...use(settingsWrite), async (req, res) => {
    const on = (req.body || {}).enabled === true;
    const s = await ImapSettings.findOneAndUpdate(
      { userId: req.userId },
      on ? { enabled: true, nextCheckAt: new Date(), lastError: '', errorCount: 0 } : { enabled: false },
      { returnDocument: 'after' }
    );
    if (!s) throw bad('Save your IMAP details first', 404);
    res.json({ ok: true, settings: view(s) });
  });

  // Look for new replies right now instead of waiting for the next visit.
  router.post('/check', ...use(imapCheck), async (req, res) => {
    const out = await checkNow(req.userId);
    if (!out) throw bad('Save your IMAP details first', 404);
    if (out.busy) return res.json({ ok: true, busy: true, stored: 0 });
    if (out.error) throw bad(out.error, 422); // the details are saved but the mailbox cannot be read: the owner can fix it
    res.json({ ok: true, stored: out.stored, optOuts: out.optOuts, bounces: out.bounces });
  });

  router.delete('/', ...use(settingsWrite), async (req, res) => {
    await ImapSettings.deleteOne({ userId: req.userId });
    await record({ ...fromReq(req), action: 'imap.removed' });
    res.json({ ok: true });
  });

  return router;
}
